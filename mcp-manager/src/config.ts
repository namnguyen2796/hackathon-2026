import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServersConfigFile } from "./types.js";

export const packageRoot = fileURLToPath(new URL("..", import.meta.url));

/** `--config <path>` (or `--config=<path>`), else MCP_MANAGER_CONFIG, else the bundled
 *  servers.json. A CLI arg is what an MCP client can set per-entry in its own mcp.json. */
function suppliedConfigPath(): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") return argv[i + 1];
    if (argv[i].startsWith("--config=")) return argv[i].slice("--config=".length);
  }
  return process.env.MCP_MANAGER_CONFIG;
}

const supplied = suppliedConfigPath();
export const CONFIG_PATH = supplied
  ? path.resolve(packageRoot, supplied)
  : path.join(packageRoot, "servers.json");
export const CONFIG_DIR = path.dirname(CONFIG_PATH);

export function loadServersConfig(): ServersConfigFile {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `${CONFIG_PATH} not found. It holds machine-specific paths, so it is not shipped — copy ` +
      "mcp-manager/servers.example.json and fill it in, then place it here or pass --config."
    );
  }
  const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as ServersConfigFile;
  if (!parsed.servers || Object.keys(parsed.servers).length === 0) {
    throw new Error(`No servers defined in ${CONFIG_PATH}`);
  }
  return parsed;
}

/** Relative to the config file's own directory — never process.cwd(), which is wherever
 *  the MCP client happened to launch mcp-manager from. */
export function resolveCwd(cwd: string | undefined): string {
  return path.resolve(CONFIG_DIR, cwd ?? ".");
}

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Expand `${VAR}` in a server's `env` against mcp-manager's own environment. servers.json
 *  names what each child needs; the machine-specific value stays in the client config. */
export function resolveEnv(
  name: string,
  env: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!env) return undefined;

  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    resolved[key] = value.replace(ENV_REF, (_, ref: string) => {
      const supplied = process.env[ref];
      if (supplied === undefined) {
        throw new Error(
          `"${name}" needs ${key}=\${${ref}}, but ${ref} is not set in mcp-manager's own ` +
          `environment — add it to the "env" block of mcp-manager's entry in your MCP client config.`
        );
      }
      return supplied;
    });
  }
  return resolved;
}
