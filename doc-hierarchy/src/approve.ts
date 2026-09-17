import fs from "node:fs";
import path from "node:path";
import {
  getCurrentDraftDir,
  latestBaselineNumber,
  listDocxFiles,
} from "./baselines.js";
import { workspaceRoot } from "./config.js";
import { readDocMetadata } from "./metadata.js";

const APPROVED = /^Approved \(Baseline \d+\)$/;

type ManifestEntry = { docId: string; dependsOn: string[] };

export type PromotionResult = { baselineName: string; draftName: string; docCount: number };

function readDraftManifest(draftDir: string): ManifestEntry[] {
  const manifestPath = path.join(draftDir, "manifest.json");
  const draftName = path.basename(draftDir);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Cannot promote — ${draftName} has no manifest.json, so there's nothing defining what it should contain.`);
  }
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(e => typeof e?.docId !== "string")) {
    throw new Error(`Cannot promote — ${draftName}/manifest.json is not a non-empty list of { docId, dependsOn } entries.`);
  }
  return parsed;
}

/**
 * A draft is promotable only if its manifest lists documents, every one of them is on disk,
 * and every document present is already Approved. Returns the .docx files to promote — which
 * may include documents added since the manifest was written; the reindex regenerates it.
 */
export async function assertPromotable(draftDir: string): Promise<string[]> {
  const draftName = path.basename(draftDir);
  const manifest = readDraftManifest(draftDir);
  const files = listDocxFiles(draftDir);
  const present = new Set(files.map(f => path.basename(f, ".docx")));

  const missing = manifest.map(m => m.docId).filter(id => !present.has(id));
  if (missing.length) {
    throw new Error(`Cannot promote — ${draftName} is missing document(s) its manifest lists: ${missing.join(", ")}`);
  }

  const notApproved: string[] = [];
  for (const f of files) {
    const meta = await readDocMetadata(path.join(draftDir, f));
    if (!APPROVED.test(meta.status)) notApproved.push(`${meta.docId} (${meta.status})`);
  }
  if (notApproved.length) {
    throw new Error(`Cannot promote — not yet fully approved: ${notApproved.join(", ")}`);
  }

  return files;
}

/**
 * Promote the draft in progress — <workspace>/draft-<latest baseline + 1> — by renaming it to
 * the baseline it was always destined to become, then open the next draft. Renaming rather than
 * copying means a promoted draft stops existing as a draft. No Status rewriting: an untouched
 * document keeps its existing Approved (Baseline N), and documents signed off this cycle
 * already carry this cycle's number.
 */
export async function approveBaseline(): Promise<PromotionResult> {
  const baselineNumber = latestBaselineNumber() + 1;
  const draftDir = getCurrentDraftDir(); // <workspace>/draft-<baselineNumber>
  const files = await assertPromotable(draftDir);

  const docsRoot = workspaceRoot();
  const baselineName = `baseline-${baselineNumber}`;
  const baselineDir = path.join(docsRoot, baselineName);
  fs.renameSync(draftDir, baselineDir);

  // Opened before the reindex: if indexing fails, the workspace tree is still coherent (a
  // baseline plus a live draft) and recovers with a plain `npm run doc-hierarchy:ingest`.
  const draftName = `draft-${baselineNumber + 1}`;
  const newDraftDir = path.join(docsRoot, draftName);
  fs.mkdirSync(newDraftDir, { recursive: true });
  for (const f of fs.readdirSync(baselineDir)) {
    fs.copyFileSync(path.join(baselineDir, f), path.join(newDraftDir, f));
  }

  // Imported lazily: ingest.ts builds a SearchClient and loads the embedding model at module
  // scope, which the MCP server shouldn't pay for just to register this tool.
  const { reindexLatestBaseline } = await import("./ingest.js");
  await reindexLatestBaseline(); // resolves to baselineDir — it's now the highest-numbered

  const manifest = "manifest.json";
  fs.copyFileSync(path.join(baselineDir, manifest), path.join(newDraftDir, manifest));

  // After the reindex, not before: the draft index is seeded by copying from whichever index
  // the alias points at, and that only holds this baseline once the swap has happened.
  const { seedDraftIndexFromBaseline } = await import("./draftIndex.js");
  await seedDraftIndexFromBaseline(files.map(f => path.basename(f, ".docx")));

  return { baselineName, draftName, docCount: files.length };
}
