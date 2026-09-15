import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadServersConfig } from "./config.js";
import {
  startServer,
  restartServer,
  stopServer,
  getServerInfo,
  getRecentLogs,
} from "./processManager.js";
import { refreshProxiedTools, getProxiedToolDefinitions, callProxiedTool } from "./toolProxy.js";
import { log } from "./logger.js";

const MANAGEMENT_TOOLS: Tool[] = [
  {
    name: "list_mcp_servers",
    description:
      "List every dev MCP server mcp-manager supervises, with status (running/crashed/stopped), pid, start time and restart count.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "restart_mcp_server",
    description:
      "Kill and relaunch one managed dev server by name (e.g. 'docs-search', 'doc-hierarchy'). Use after code changes, or when a server hangs or crashes.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Server name as it appears in list_mcp_servers." },
      },
      required: ["name"],
    },
  },
  {
    name: "get_mcp_server_logs",
    description: "Return recent stderr output captured from a managed server (for debugging a crash).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Server name as it appears in list_mcp_servers." },
        lines: { type: "number", description: "Number of lines to return (default 50)." },
      },
      required: ["name"],
    },
  },
];

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

async function main(): Promise<void> {
  const { servers: serverConfigs } = loadServersConfig();
  const serverNames = Object.keys(serverConfigs);

  const server = new Server(
    { name: "mcp-manager", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...MANAGEMENT_TOOLS, ...getProxiedToolDefinitions()],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;

    switch (name) {
      case "list_mcp_servers":
        return text(JSON.stringify(serverNames.map(getServerInfo), null, 2));

      case "restart_mcp_server": {
        const { name: target } = z.object({ name: z.string() }).parse(args);
        const config = serverConfigs[target];
        if (!config) {
          return {
            ...text(`Unknown server "${target}". Known servers: ${serverNames.join(", ")}`),
            isError: true,
          };
        }
        await restartServer(target, config);
        await refreshProxiedTools([target]);
        return text(JSON.stringify(getServerInfo(target), null, 2));
      }

      case "get_mcp_server_logs": {
        const parsed = z.object({ name: z.string(), lines: z.number().optional() }).parse(args);
        return text(getRecentLogs(parsed.name, parsed.lines ?? 50).join("\n") || "(no logs yet)");
      }

      default:
        try {
          return await callProxiedTool(name, args);
        } catch (err) {
          return { ...text(`Error calling ${name}: ${(err as Error).message}`), isError: true };
        }
    }
  });

  // Boot every managed server before talking to the client, so the very first tools/list
  // response already includes the proxied tools.
  for (const serverName of serverNames) {
    try {
      await startServer(serverName, serverConfigs[serverName]);
    } catch {
      // startServer already logged it and marked the server crashed; one bad child must not
      // stop mcp-manager itself from coming up.
    }
  }
  await refreshProxiedTools(serverNames);

  await server.connect(new StdioServerTransport());

  // Nothing tears the children down for us. The SDK's StdioServerTransport only listens for
  // stdin 'data'/'error', so a client disconnect never fires server.onclose — and the
  // children's open pipes keep this event loop alive, leaking every process on client quit.
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("mcp-manager", "client disconnected, stopping managed servers");
    await Promise.all(serverNames.map(stopServer));
    process.exit(0);
  };

  process.stdin.on("end", () => void shutdown());
  process.stdin.on("close", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  log("mcp-manager", `connected to client, managing: ${serverNames.join(", ")}`);
}

main().catch((err) => {
  console.error("mcp-manager fatal error:", err);
  process.exit(1);
});
