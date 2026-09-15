import treeKill from "tree-kill";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ChildProcessTransport } from "./childProcessTransport.js";
import { resolveCwd } from "./config.js";
import { log, getRecentLogs } from "./logger.js";
import type { ManagedServerConfig, ManagedServerInfo, ServerStatus } from "./types.js";

function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    treeKill(pid, "SIGTERM", (err) => {
      // A missing/already-dead pid is not a failure worth surfacing.
      if (err) log("mcp-manager", `tree-kill on pid ${pid}: ${err.message}`);
      resolve();
    });
  });
}

interface ManagedServer {
  transport: ChildProcessTransport;
  client: Client;
}

const servers = new Map<string, ManagedServer>();
const statuses = new Map<string, ServerStatus>();
const restartCounts = new Map<string, number>();
const lastErrors = new Map<string, string>();
const startedAt = new Map<string, string>();

export async function startServer(name: string, config: ManagedServerConfig): Promise<void> {
  statuses.set(name, "starting");
  lastErrors.delete(name);

  const transport = new ChildProcessTransport(config.command, config.args, {
    cwd: resolveCwd(config.cwd),
    env: config.env,
  });
  transport.onStderr = (text) => {
    for (const line of text.split("\n")) if (line.trim()) log(name, line.trim());
  };
  transport.onerror = (err) => {
    lastErrors.set(name, err.message);
    log(name, `ERROR: ${err.message}`);
  };
  transport.onclose = () => {
    // A child that exits on its own lands here too, not just a deliberate stop.
    if (statuses.get(name) === "running") {
      statuses.set(name, "crashed");
      log(name, "process exited unexpectedly");
    }
  };

  // Without this, a child that spawns fine but dies before answering `initialize` leaves
  // client.connect() waiting on the SDK's 60s request timeout.
  let connected = false;
  const diedDuringHandshake = new Promise<never>((_, reject) => {
    transport.onExit = (code) => {
      if (!connected) reject(new Error(`exited (code ${code}) before completing MCP initialize`));
    };
  });

  const client = new Client({ name: `mcp-manager-proxy-${name}`, version: "1.0.0" });

  try {
    await Promise.race([client.connect(transport), diedDuringHandshake]);
    connected = true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    statuses.set(name, "crashed");
    lastErrors.set(name, message);
    log(name, `failed to start: ${message}`);
    if (transport.pid) await killTree(transport.pid);
    throw err;
  }

  servers.set(name, { transport, client });
  statuses.set(name, "running");
  startedAt.set(name, new Date().toISOString());
  log(name, `started (pid ${transport.pid})`);
}

export async function stopServer(name: string): Promise<void> {
  const server = servers.get(name);
  if (!server) return;

  const pid = server.transport.pid;
  try {
    await server.client.close();
  } catch (err) {
    log(name, `client.close() during stop: ${(err as Error).message}`);
  }

  // Kill the whole tree under this pid, not just the handle we spawned. The `node --import tsx`
  // spawn path normally has nothing underneath, but this is what prevents orphans if that
  // changes (a dependency that forks, or someone reverting to an `npm run` command).
  if (pid) await killTree(pid);

  servers.delete(name);
}

export async function restartServer(name: string, config: ManagedServerConfig): Promise<void> {
  statuses.set(name, "restarting");
  log(name, "restart requested");
  await stopServer(name);

  await new Promise((resolve) => setTimeout(resolve, config.restartDelayMs ?? 500));
  restartCounts.set(name, (restartCounts.get(name) ?? 0) + 1);

  try {
    await startServer(name, config);
  } catch {
    // startServer already recorded status and lastError; a failed restart shouldn't
    // propagate as a tool-call exception.
  }
}

export function getClient(name: string): Client | undefined {
  return servers.get(name)?.client;
}

export function getServerInfo(name: string): ManagedServerInfo {
  return {
    name,
    status: statuses.get(name) ?? "stopped",
    pid: servers.get(name)?.transport.pid,
    startedAt: startedAt.get(name),
    restartCount: restartCounts.get(name) ?? 0,
    lastError: lastErrors.get(name),
  };
}

export { getRecentLogs };
