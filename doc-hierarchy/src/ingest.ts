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
import { contentHash } from "./contentHash.js";
import { recreateIndex } from "./createIndex.js";
import { ALIAS, getLiveAndStagingIndexNames, swapAliasToStaging } from "./indexAlias.js";

// Mirrors HIERARCHY_INDEX_SCHEMA in createIndex.ts.
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

type ManifestEntry = { docId: string; dependsOn: string[]; contentHash: string };

// How many .docx files are parsed at once. Unbounded Promise.all over the whole corpus is
// what this is guarding against, not throughput.
const PARSE_BATCH_SIZE = 10;

const clients = new Map<string, SearchClient<HierarchyDoc>>();
function clientFor(indexName: string): SearchClient<HierarchyDoc> {
  let client = clients.get(indexName);
  if (!client) {
    client = new SearchClient<HierarchyDoc>(
      process.env.AZURE_SEARCH_ENDPOINT!, indexName,
      new AzureKeyCredential(process.env.AZURE_SEARCH_KEY!)
    );
    clients.set(indexName, client);
  }
  return client;
}

function odataEscape(s: string): string {
  return s.replace(/'/g, "''");
}

async function processInBatches<T>(
  items: T[], batchSize: number, fn: (item: T) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    await Promise.all(items.slice(i, i + batchSize).map(fn));
  }
}

let extractorPromise: Promise<FeatureExtractionPipeline> | undefined;
async function embed(text: string): Promise<number[]> {
  // Cache the promise, not the resolved pipeline — chunks embed concurrently and
  // would otherwise each kick off their own model load.
  extractorPromise ??= pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  const extractor = await extractorPromise;
  return Array.from((await extractor(text, { pooling: "mean", normalize: true })).data as Float32Array);
}

// Splits on paragraph breaks, and hard-splits any single paragraph already over the cap.
// Ported from docs-search's ingest.ts — the fixed-width split this replaces was only ever
// tolerable while documents were about one chunk each.
function chunk(text: string, maxChars = 1200): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of text.split("\n\n")) {
    if (paragraph.length > maxChars) {
      if (current.trim()) chunks.push(current.trim());
      current = "";
      for (let i = 0; i < paragraph.length; i += maxChars) {
        chunks.push(paragraph.slice(i, i + maxChars).trim());
      }
      continue;
    }
    if (current.length + paragraph.length < maxChars) {
      current += paragraph + "\n\n";
    } else {
      if (current.trim()) chunks.push(current.trim());
      current = paragraph + "\n\n";
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

async function parseFile(filePath: string): Promise<ParsedDoc> {
  const { value: html } = await mammoth.convertToHtml({ path: filePath });
  const { value: text } = await mammoth.extractRawText({ path: filePath });
  const meta = parseMetadata(html);
  return { filePath, text, ...meta };
}

function sourcePath(filePath: string): string {
  return path.relative(workspaceRoot(), filePath).split(path.sep).join("/");
}

/** Parsed in a stable order regardless of which file finishes first within a batch. */
async function parseBaseline(baselineDir: string): Promise<ParsedDoc[]> {
  const files = listDocxFiles(baselineDir);
  const parsed = new Array<ParsedDoc>(files.length);
  await processInBatches(files.map((file, i) => ({ file, i })), PARSE_BATCH_SIZE, async ({ file, i }) => {
    parsed[i] = await parseFile(path.join(baselineDir, file));
  });
  return parsed;
}

function buildManifest(parsed: ParsedDoc[]): ManifestEntry[] {
  return parsed.map(d => ({ docId: d.docId, dependsOn: d.dependsOn, contentHash: contentHash(d.text) }));
}

function writeManifest(baselineDir: string, manifest: ManifestEntry[]): void {
  fs.writeFileSync(path.join(baselineDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.error(`Wrote manifest.json (${manifest.length} docs) to ${baselineDir}`);
}

/**
 * Hashes the previous baseline recorded for each document. A missing manifest, or a manifest
 * predating contentHash, means every document is treated as changed — over-embedding once is
 * the safe direction to fail.
 */
function readPreviousHashes(baselineDir: string): Map<string, string> {
  const number = Number(path.basename(baselineDir).match(/-(\d+)$/)?.[1]);
  if (!Number.isFinite(number)) return new Map();
  const previous = path.join(workspaceRoot(), `baseline-${number - 1}`, "manifest.json");
  if (!fs.existsSync(previous)) return new Map();
  const entries = JSON.parse(fs.readFileSync(previous, "utf-8")) as { docId: string; contentHash?: string }[];
  return new Map(entries.filter(e => e.contentHash).map(e => [e.docId, e.contentHash!]));
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

async function uploadDoc(doc: ParsedDoc, indexName: string): Promise<void> {
  const chunks = chunk(doc.text);
  const documents = await Promise.all(chunks.map(async (c, i) => ({
    id: `${doc.docId}-${i}`,
    docId: doc.docId,
    content: c,
    source: sourcePath(doc.filePath),
    owner: doc.owner,
    reviewer: doc.reviewer,
    dependsOn: doc.dependsOn,
    embedding: await embed(c),
  })));
  await clientFor(indexName).uploadDocuments(documents);
  // stderr, not stdout — this runs inside the MCP server when approve_baseline reindexes.
  console.error(`Embedded ${documents.length} chunk(s) from ${doc.docId} into ${indexName}`);
}

/**
 * Reuse a document's already-embedded chunks rather than re-embedding them. The metadata
 * fields are refreshed from the current parse even so: `source` names the baseline folder,
 * which changes on every promotion even when the document's content doesn't.
 * False if the live index has nothing for this document, so the caller can embed it instead.
 */
async function copyExistingChunks(doc: ParsedDoc, live: string, staging: string): Promise<boolean> {
  const results = await clientFor(live).search("*", { filter: `docId eq '${odataEscape(doc.docId)}'` });
  const documents: HierarchyDoc[] = [];
  for await (const r of results.results) {
    documents.push({
      ...r.document,
      source: sourcePath(doc.filePath),
      owner: doc.owner,
      reviewer: doc.reviewer,
      dependsOn: doc.dependsOn,
    });
  }
  if (!documents.length) return false;
  await clientFor(staging).uploadDocuments(documents);
  console.error(`Copied ${documents.length} unchanged chunk(s) for ${doc.docId} from ${live}`);
  return true;
}

/**
 * Rebuild the staging index from whichever baseline folder is now the highest-numbered one,
 * then point the alias at it. Also called by approve_baseline, right after promotion.
 *
 * Documents whose content hash matches the previous baseline's manifest have their existing
 * chunks copied across instead of re-embedded. That means a copied document keeps whatever
 * chunking scheme it was originally embedded under — changing `chunk()` requires one
 * deliberate full re-embed (delete the previous baseline's manifest.json) to take effect.
 */
export async function reindexLatestBaseline(): Promise<void> {
  const baselineDir = getLatestBaselineDir();

  // Parse and validate every document before touching any index — a malformed doc found
  // partway through must not leave a half-populated staging index ready to be swapped in.
  const parsed = await parseBaseline(baselineDir);
  const manifest = buildManifest(parsed);
  assertNoCycle(manifest);

  const { live, staging } = await getLiveAndStagingIndexNames();
  await recreateIndex(staging);

  const previousHashes = readPreviousHashes(baselineDir);
  const hashes = new Map(manifest.map(m => [m.docId, m.contentHash]));

  let copied = 0;
  for (const doc of parsed) {
    const unchanged = previousHashes.get(doc.docId) === hashes.get(doc.docId);
    if (unchanged && await copyExistingChunks(doc, live, staging)) copied++;
    else await uploadDoc(doc, staging);
  }

  // Nothing has been served from staging until this line. The alias — and so every caller —
  // moves from the whole old baseline to the whole new one in one step.
  await swapAliasToStaging(staging);
  console.error(
    `Reindexed ${parsed.length} doc(s) into ${staging} ` +
    `(${copied} copied unchanged, ${parsed.length - copied} re-embedded). ${ALIAS} -> ${staging}.`
  );

  writeManifest(baselineDir, manifest);
}

/** Unconditional full embed of the latest baseline into one named physical index. Used by the
 *  one-time alias migration to seed the first live index, before any alias exists to read. */
export async function seedIndex(indexName: string): Promise<void> {
  const baselineDir = getLatestBaselineDir();
  const parsed = await parseBaseline(baselineDir);
  const manifest = buildManifest(parsed);
  assertNoCycle(manifest);

  await recreateIndex(indexName);
  for (const doc of parsed) await uploadDoc(doc, indexName);
  writeManifest(baselineDir, manifest);
}

// Only when run directly (npm run doc-hierarchy:ingest), not when approve.ts imports it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await reindexLatestBaseline();
}