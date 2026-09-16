import { config } from "dotenv";
// Resolved against this file, not process.cwd(), so the script runs from any directory.
// quiet, because approve_baseline imports this module into the running MCP server, where
// stdout is the JSON-RPC stream and dotenv's banner would corrupt it.
config({ path: new URL("../../.env", import.meta.url), quiet: true });

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import mammoth from "mammoth";
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { SearchClient, AzureKeyCredential } from "@azure/search-documents";
import { getLatestBaselineDir, listDocxFiles } from "./baselines.js";
import { workspaceRoot } from "./config.js";
import { parseMetadata } from "./metadata.js";

// Mirrors the doc-hierarchy-index schema in createIndex.ts.
type HierarchyDoc = {
  id: string;
  docId: string;
  content: string;
  source: string;
  owner: string;
  reviewer: string;
  dependsOn: string[];
  embedding: number[];
};

type ParsedDoc = {
  filePath: string;
  text: string;
  docId: string;
  owner: string;
  reviewer: string;
  dependsOn: string[];
};

const client = new SearchClient<HierarchyDoc>(
  process.env.AZURE_SEARCH_ENDPOINT!, "doc-hierarchy-index",
  new AzureKeyCredential(process.env.AZURE_SEARCH_KEY!)
);

let extractorPromise: Promise<FeatureExtractionPipeline> | undefined;
async function embed(text: string): Promise<number[]> {
  // Cache the promise, not the resolved pipeline — chunks embed concurrently and
  // would otherwise each kick off their own model load.
  extractorPromise ??= pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  const extractor = await extractorPromise;
  return Array.from((await extractor(text, { pooling: "mean", normalize: true })).data as Float32Array);
}

function chunk(text: string, size = 1000): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

async function parseFile(filePath: string): Promise<ParsedDoc> {
  const { value: html } = await mammoth.convertToHtml({ path: filePath });
  const { value: text } = await mammoth.extractRawText({ path: filePath });
  const meta = parseMetadata(html);
  return { filePath, text, ...meta };
}

function assertNoCycle(manifest: { docId: string; dependsOn: string[] }[]) {
  const dependsOnById = new Map(manifest.map(m => [m.docId, m.dependsOn]));
  const state = new Map<string, "visiting" | "done">();

  function visit(id: string, chain: string[]) {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      throw new Error(`Dependency cycle: ${[...chain, id].join(" -> ")}`);
    }
    state.set(id, "visiting");
    for (const dep of dependsOnById.get(id) ?? []) visit(dep, [...chain, id]);
    state.set(id, "done");
  }

  for (const { docId } of manifest) visit(docId, []);
}

// The ids currently in the index. Captured before uploading so stale leftovers can be removed
// *after* the new baseline has landed, rather than emptying the index first.
async function indexedIds(): Promise<string[]> {
  try {
    const all = await client.search("*", { select: ["id"] });
    const ids: string[] = [];
    for await (const r of all.results) ids.push(r.document.id);
    return ids;
  } catch (err) {
    throw new Error(
      `Could not read doc-hierarchy-index — has createIndex.ts been run yet? (${(err as Error).message})`
    );
  }
}

async function uploadDoc(doc: ParsedDoc): Promise<string[]> {
  const chunks = chunk(doc.text);
  const documents = await Promise.all(chunks.map(async (c, i) => ({
    id: `${doc.docId}-${i}`,
    docId: doc.docId,
    content: c,
    source: path.relative(workspaceRoot(), doc.filePath).split(path.sep).join("/"),
    owner: doc.owner,
    reviewer: doc.reviewer,
    dependsOn: doc.dependsOn,
    embedding: await embed(c),
  })));
  await client.uploadDocuments(documents);
  // stderr, not stdout — this runs inside the MCP server when approve_baseline reindexes.
  console.error(`Indexed ${documents.length} chunks from ${doc.docId}`);
  return documents.map(d => d.id);
}

/** Drop every chunk currently indexed and repopulate from whichever baseline folder is
 *  now the highest-numbered one. Also called by approve_baseline, right after promotion. */
export async function reindexLatestBaseline(): Promise<void> {
  const baselineDir = getLatestBaselineDir();
  const files = listDocxFiles(baselineDir);

  // Parse and validate every document before touching the index — a malformed doc found
  // partway through must not leave the index wiped but only half-repopulated.
  const parsed = await Promise.all(files.map(f => parseFile(path.join(baselineDir, f))));
  const manifest = parsed.map(d => ({ docId: d.docId, dependsOn: d.dependsOn }));
  assertNoCycle(manifest);

  // Chunk ids are stable (`<docId>-<n>`), so uploads overwrite the previous baseline's chunks
  // in place. Only leftovers the new baseline doesn't cover are deleted, and only once every
  // upload has succeeded — the index is never empty mid-run.
  const previousIds = await indexedIds();
  const currentIds = new Set<string>();
  for (const doc of parsed) {
    for (const id of await uploadDoc(doc)) currentIds.add(id);
  }

  const stale = previousIds.filter(id => !currentIds.has(id));
  if (stale.length) await client.deleteDocuments("id", stale);
  console.error(`Removed ${stale.length} stale chunk(s) left over from the previous baseline.`);

  fs.writeFileSync(path.join(baselineDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.error(`Wrote manifest.json (${manifest.length} docs) to ${baselineDir}`);
}

// Only when run directly (npm run doc-hierarchy:ingest), not when approve.ts imports it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await reindexLatestBaseline();
}