import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { packageRoot } from "./config.js";

// Outside the repo, so logs survive branch switches.
const LOG_DIR = process.env.MCP_MANAGER_LOG_DIR ?? path.resolve(packageRoot, "..", "..", "logs");
const LOG_FILE = path.join(LOG_DIR, "mcp-manager.log");

mkdirSync(LOG_DIR, { recursive: true });

const ringBuffers = new Map<string, string[]>();
const RING_SIZE = 200;

export function log(serverName: string, line: string): void {
  const entry = `[${new Date().toISOString()}] [${serverName}] ${line}`;

  const buf = ringBuffers.get(serverName) ?? [];
  buf.push(entry);
  if (buf.length > RING_SIZE) buf.shift();
  ringBuffers.set(serverName, buf);

  try {
    appendFileSync(LOG_FILE, entry + "\n");
  } catch {
    // Best-effort only — never let logging crash the manager.
  }
}

export function getRecentLogs(serverName: string, lines = 50): string[] {
  return (ringBuffers.get(serverName) ?? []).slice(-lines);
}
