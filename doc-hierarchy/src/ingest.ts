import { config } from "dotenv";
// Resolved against this file, not process.cwd(), so the script runs from any directory.
config({ path: new URL("../../.env", import.meta.url) });

import fs from "node:fs";
import path from "node:path";
import mammoth from "mammoth";
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { SearchClient, AzureKeyCredential } from "@azure/search-documents";
import { getCurrentBaselineDir, packageRoot } from "./currentBaseline.js";

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

// Every doc starts with a Field | Value table: Document ID, Title, Owner,
// Reviewer, Depends On, Signoff Date, Status.
function parseMetadata(html: string) {
  const rows = [...html.matchAll(/<tr>(.*?)<\/tr>/gs)].map(m =>
    [...m[1].matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map(c => c[1].replace(/<[^>]+>/g, "").trim())
  );
  const map = Object.fromEntries(rows.map(([k, v]) => [k, v]));
  const required = ["Document ID", "Owner", "Reviewer", "Depends On"];
  const missing = required.filter((k) => map[k] === undefined);
  if (missing.length) throw new Error(`Metadata table missing: ${missing.join(", ")}`);
  return {
    docId: map["Document ID"],
    owner: map["Owner"],
    reviewer: map["Reviewer"],
    dependsOn: map["Depends On"] === "—" ? [] : map["Depends On"].split(",").map(s => s.trim()),
  };
}

function chunk(text: string, size = 1000): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

async function ingestFile(filePath: string) {
  const { value: html } = await mammoth.convertToHtml({ path: filePath });
  const { value: text } = await mammoth.extractRawText({ path: filePath });
  const meta = parseMetadata(html);

  // Deterministic per-doc IDs + delete-before-upload: re-ingesting the same
  // docId (a new baseline, a re-run) replaces its chunks cleanly instead of
  // accumulating duplicates or leaving orphaned chunks when content shrinks.
  const stale = await client.search("*", {
    filter: `docId eq '${meta.docId.replace(/'/g, "''")}'`,
    select: ["id"],
  });
  const staleIds: string[] = [];
  for await (const r of stale.results) staleIds.push(r.document.id);
  if (staleIds.length) await client.deleteDocuments("id", staleIds);

  const chunks = chunk(text);
  const documents = await Promise.all(chunks.map(async (c, i) => ({
    id: `${meta.docId}-${i}`,
    docId: meta.docId,
    content: c,
    source: path.relative(packageRoot, filePath).replaceAll("\\", "/"),
    owner: meta.owner,
    reviewer: meta.reviewer,
    dependsOn: meta.dependsOn,
    embedding: await embed(c),
  })));
  await client.uploadDocuments(documents);
  console.log(`Indexed ${documents.length} chunks from ${meta.docId}`);
}

const baselineDir = process.argv[2]
  ? path.resolve(packageRoot, process.argv[2])
  : getCurrentBaselineDir();
for (const f of fs.readdirSync(baselineDir).filter(f => f.endsWith(".docx"))) {
  await ingestFile(path.join(baselineDir, f));
}