import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// src/ -> package root. Independent of whatever cwd the MCP client uses.
export const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const docsRoot = path.join(packageRoot, "docs");

function latestNumberedDir(kind: "baseline" | "draft"): string {
  const pattern = new RegExp(`^${kind}-(\\d+)$`);
  const entries = fs.existsSync(docsRoot) ? fs.readdirSync(docsRoot, { withFileTypes: true }) : [];
  const matches = entries
    .filter(e => e.isDirectory())
    .map(e => ({ name: e.name, match: e.name.match(pattern) }))
    .filter((e): e is { name: string; match: RegExpMatchArray } => e.match !== null)
    .map(e => ({ name: e.name, index: Number(e.match[1]) }));

  if (matches.length === 0) {
    throw new Error(`No ${kind}-<N> folders found under ${docsRoot}`);
  }
  matches.sort((a, b) => b.index - a.index);
  return path.join(docsRoot, matches[0].name);
}

/** Highest-numbered docs/baseline-<N> folder. There's no separate "promoted" pointer any
 * more — the highest index is authoritative. See the design note at the top of 004 for
 * what that trades away. */
export function getLatestBaselineDir(): string {
  return latestNumberedDir("baseline");
}

/** Highest-numbered docs/draft-<N> folder — the default candidate to diff against. */
export function getLatestDraftDir(): string {
  return latestNumberedDir("draft");
}

/**
 * Resolve a caller-supplied path against the package root, and refuse anything that
 * resolves outside docs/. These paths come from whatever the calling model supplies via
 * an MCP tool call, not just from you.
 */
export function resolveDocPath(p: string): string {
  const resolved = path.isAbsolute(p) ? path.resolve(p) : path.resolve(packageRoot, p);
  const resolvedDocsRoot = path.resolve(docsRoot);
  if (resolved !== resolvedDocsRoot && !resolved.startsWith(resolvedDocsRoot + path.sep)) {
    throw new Error(`Path escapes docs/: ${p}`);
  }
  return resolved;
}
