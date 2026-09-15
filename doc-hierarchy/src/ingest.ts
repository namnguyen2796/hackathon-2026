import { config } from "dotenv";
// Resolved against this file, not process.cwd(), so the script runs from any directory.
config({ path: new URL("../../.env", import.meta.url) });

import fs from "node:fs";
import path from "node:path";
import mammoth from "mammoth";
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { SearchClient, AzureKeyCredential } from "@azure/search-documents";
import { getLatestBaselineDir, packageRoot } from "./baselines.js";
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

// Wipes every document currently in the index — not the Azure Search index resource itself,
// just its contents. Since the index only ever represents one baseline at a time, this is
// sufficient to guarantee no stale entry from a previous run (or a previous ID scheme) survives.
async function wipeIndex() {
  let ids: string[];
  try {
    const all = await client.search("*", { select: ["id"] });
    ids = [];
    for await (const r of all.results) ids.push(r.document.id);
  } catch (err) {
    throw new Error(
      `Could not read doc-hierarchy-index — has createIndex.ts been run yet? (${(err as Error).message})`
    );
  }
  if (ids.length) await client.deleteDocuments("id", ids);
  console.log(`Wiped ${ids.length} existing chunk(s) from the index before reindexing.`);
}

async function uploadDoc(doc: ParsedDoc) {
  const chunks = chunk(doc.text);
  const documents = await Promise.all(chunks.map(async (c, i) => ({
    id: `${doc.docId}-${i}`,
    docId: doc.docId,
    content: c,
    source: path.relative(packageRoot, doc.filePath).split(path.sep).join("/"),
    owner: doc.owner,
    reviewer: doc.reviewer,
    dependsOn: doc.dependsOn,
    embedding: await embed(c),
  })));
  await client.uploadDocuments(documents);
  console.log(`Indexed ${documents.length} chunks from ${doc.docId}`);
}

const baselineDir = getLatestBaselineDir();
const files = fs.readdirSync(baselineDir).filter(f => f.endsWith(".docx"));

// Parse and validate every document before touching the index — a malformed doc found
// partway through must not leave the index wiped but only half-repopulated.
const parsed = await Promise.all(files.map(f => parseFile(path.join(baselineDir, f))));
const manifest = parsed.map(d => ({ docId: d.docId, dependsOn: d.dependsOn }));
assertNoCycle(manifest);

await wipeIndex();
for (const doc of parsed) await uploadDoc(doc);

fs.writeFileSync(path.join(baselineDir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`Wrote manifest.json (${manifest.length} docs) to ${baselineDir}`);