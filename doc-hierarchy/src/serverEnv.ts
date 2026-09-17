import fs from "node:fs";
import { fileURLToPath } from "node:url";

const SERVER_NAME = "doc-hierarchy";
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Same order mcp-manager uses, then the location this repo's servers.json actually lives in. */
function configCandidates(): string[] {
  return [
    process.env.MCP_MANAGER_CONFIG,
    fileURLToPath(new URL("../../../servers.json", import.meta.url)),
    fileURLToPath(new URL("../../mcp-manager/servers.json", import.meta.url)),
  ].filter((p): p is string => Boolean(p));
}

/** Unresolvable `${VAR}` yields undefined rather than a literal "${VAR}" path on disk. */
function expand(value: string): string | undefined {
  let resolved = true;
  const out = value.replace(ENV_REF, (_, ref: string) => {
    const supplied = process.env[ref];
    if (supplied === undefined) resolved = false;
    return supplied ?? "";
  });
  return resolved ? out : undefined;
}

/**
 * Copy this server's `env` block out of servers.json into process.env, without overriding
 * anything already set. Deliberately called only from script entry points: when mcp-manager
 * launches the MCP server it injects these itself, and library code — including tests — must
 * keep failing loudly on a missing workspace rather than quietly finding the real one.
 */
export function applyServerEnvDefaults(): void {
  for (const candidate of configCandidates()) {
    if (!fs.existsSync(candidate)) continue;

    let env: Record<string, string> | undefined;
    try {
      env = JSON.parse(fs.readFileSync(candidate, "utf-8"))?.servers?.[SERVER_NAME]?.env;
    } catch {
      continue; // A malformed config shouldn't stop the script; the missing-var error is clearer.
    }
    if (!env) continue;

    for (const [key, value] of Object.entries(env)) {
      if (process.env[key] !== undefined || typeof value !== "string") continue;
      const resolved = expand(value);
      if (resolved) process.env[key] = resolved;
    }
    return;
  }
}
