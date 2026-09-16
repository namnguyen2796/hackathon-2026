import fs from "node:fs";
import path from "node:path";
import { workspaceRoot } from "./config.js";

function latestBaselineDir(): { dir: string; number: number } {
  const docsRoot = workspaceRoot();
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

/** Highest-numbered baseline-<N> folder in the workspace. There's no separate "promoted"
 * pointer any more — the highest index is authoritative. See the design note at the top of
 * 004 for what that trades away. */
export function getLatestBaselineDir(): string {
  return latestBaselineDir().dir;
}

/** The one number the whole workspace layout is derived from. */
export function latestBaselineNumber(): number {
  return latestBaselineDir().number;
}

/**
 * The draft in progress. There is no independent draft numbering: the current draft is always
 * the next baseline, so it lives at <workspace>/draft-<latest baseline + 1>.
 */
export function getCurrentDraftDir(): string {
  const docsRoot = workspaceRoot();
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
 * Resolve a caller-supplied path against the workspace root, and refuse anything that
 * resolves outside it. These paths come from whatever the calling model supplies via
 * an MCP tool call, not just from you.
 */
export function resolveDocPath(p: string): string {
  const resolvedDocsRoot = path.resolve(workspaceRoot());
  const resolved = path.isAbsolute(p) ? path.resolve(p) : path.resolve(resolvedDocsRoot, p);
  if (resolved !== resolvedDocsRoot && !resolved.startsWith(resolvedDocsRoot + path.sep)) {
    throw new Error(`Path escapes the workspace: ${p}`);
  }
  return resolved;
}
