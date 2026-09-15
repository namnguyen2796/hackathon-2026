import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getClient } from "./processManager.js";
import { log } from "./logger.js";

interface ProxiedTool {
  serverName: string;
  originalName: string;
  tool: Tool;
}

const proxiedTools = new Map<string, ProxiedTool>();

export async function refreshProxiedTools(serverNames: string[]): Promise<void> {
  for (const name of serverNames) {
    const client = getClient(name);
    if (!client) continue;

    try {
      const { tools } = await client.listTools();
      // Drop this server's previous entries first, so a tool removed from the child's source
      // doesn't linger in the proxy after a restart.
      for (const [key, proxied] of proxiedTools) {
        if (proxied.serverName === name) proxiedTools.delete(key);
      }
      for (const tool of tools) {
        // Namespaced so two children can each expose e.g. a "search" tool without colliding.
        const prefixedName = `${name}__${tool.name}`;
        proxiedTools.set(prefixedName, {
          serverName: name,
          originalName: tool.name,
          tool: { ...tool, name: prefixedName, description: `[${name}] ${tool.description ?? ""}` },
        });
      }
      log(name, `discovered ${tools.length} tool(s)`);
    } catch (err) {
      log(name, `failed to list tools: ${(err as Error).message}`);
    }
  }
}

export function getProxiedToolDefinitions(): Tool[] {
  return [...proxiedTools.values()].map((p) => p.tool);
}

export async function callProxiedTool(prefixedName: string, args: unknown) {
  const proxied = proxiedTools.get(prefixedName);
  if (!proxied) throw new Error(`Unknown tool: ${prefixedName}`);

  const client = getClient(proxied.serverName);
  if (!client) {
    throw new Error(`"${proxied.serverName}" is not running — use restart_mcp_server first.`);
  }

  return client.callTool({ name: proxied.originalName, arguments: args as Record<string, unknown> });
}
