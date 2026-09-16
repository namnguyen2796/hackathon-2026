import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// src/ -> package root. Independent of whatever cwd the MCP client uses.
export const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const docsRoot = path.join(packageRoot, "docs");

function latestBaselineDir(): { dir: string; number: number } {
  const entries = fs.existsSync(docsRoot) ? fs.readdirSync(docsRoot, { withFileTypes: true }) : [];
  const matches = entries
    .filter(e => e.isDirectory())
    .map(e => ({ name: e.name, match: e.name.match(/^baseline-(\d+)$/) }))
    .filter((e): e is { name: string; match: RegExpMatchArray } => e.match !== null)
    .map(e => ({ name: e.name, number: Number(e.match[1]) }));

  if (matches.length === 0) {
    throw new Error(`No baseline-<N> folders found under ${docsRoot}`);
  }
  matches.sort((a, b) => b.number - a.number);
  return { dir: path.join(docsRoot, matches[0].name), number: matches[0].number };
}

/** Highest-numbered docs/baseline-<N> folder. There's no separate "promoted" pointer any
 * more — the highest index is authoritative. See the design note at the top of 004 for
 * what that trades away. */
export function getLatestBaselineDir(): string {
  return latestBaselineDir().dir;
}

/** The one number the whole docs/ layout is derived from. */
export function latestBaselineNumber(): number {
  return latestBaselineDir().number;
}

/**
 * The draft in progress. There is no independent draft numbering: the current draft is always
 * the next baseline, so it lives at docs/draft-<latest baseline + 1>.
 */
export function getCurrentDraftDir(): string {
  const next = latestBaselineNumber() + 1;
  const dir = path.join(docsRoot, `draft-${next}`);
  if (!fs.existsSync(dir)) {
    throw new Error(`Expected draft-${next} under ${docsRoot} — the draft for baseline-${next} — but it isn't there.`);
  }
  return dir;
}

/** Word leaves ~$-prefixed owner files next to open documents; they are not documents. */
export function listDocxFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter(f => f.endsWith(".docx") && !f.startsWith("~$"));
}

/** The only path apply_change and signoff are allowed to write to. Baselines stay frozen. */
export function draftFilePath(docId: string): string {
  return path.join(getCurrentDraftDir(), `${docId}.docx`);
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
