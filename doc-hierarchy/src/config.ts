function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Scripts read it from the "doc-hierarchy" entry in servers.json ` +
      "(found via MCP_MANAGER_CONFIG, ../servers.json, or mcp-manager/servers.json) — check " +
      `it defines ${name} there, or export it directly when running a script or test by hand.`
    );
  }
  return value;
}

/** The folder that directly contains baseline-<N>/draft-<N>. Lives outside the repo; there is
 *  deliberately no repo-relative fallback. Read per call so tests can redirect it. */
export function workspaceRoot(): string {
  return required("MCP_CONFIG_WORKSPACE");
}

/** Where operational records (signoffs, notifications) live. Same rules as workspaceRoot. */
export function logspaceRoot(): string {
  return required("MCP_CONFIG_LOGSPACE");
}
