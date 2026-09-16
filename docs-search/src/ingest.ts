import { config } from "dotenv";
config({ path: new URL("../../.env", import.meta.url) });

import { readFileSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, extname, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "@huggingface/transformers";
import { SearchClient, AzureKeyCredential } from "@azure/search-documents";
import { extractText, getDocumentProxy } from "unpdf";

const INDEX_NAME = "docs-index";

// The document folder lives outside the repo; there is deliberately no repo-relative fallback.
const DOCS_DIR = process.env.MCP_CONFIG_WORKSPACE;
if (!DOCS_DIR) {
  throw new Error(
    'MCP_CONFIG_WORKSPACE is not set — add it to "docs-search"\'s "env" in ' +
    "mcp-manager/servers.json, or export it directly when running a script by hand."
  );
}

const client = new SearchClient(
  process.env.AZURE_SEARCH_ENDPOINT!,
  INDEX_NAME,
  new AzureKeyCredential(process.env.AZURE_SEARCH_KEY!)
);

const SUPPORTED = [".md", ".txt", ".pdf"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (SUPPORTED.includes(extname(full).toLowerCase())) out.push(full);
  }
  return out;
}

async function readDocText(file: string): Promise<string> {
  if (extname(file).toLowerCase() === ".pdf") {
    const buffer = await readFile(file);
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  }
  return readFileSync(file, "utf-8");
}

// Splits on paragraph breaks, but also hard-splits any single "paragraph" that's
// already bigger than maxChars — common with PDFs, whose extracted text often
// comes back as one long blob with no \n\n at all.
function chunkText(text: string, maxChars = 1200): string[] {
  const paras = text.split("\n\n");
  const chunks: string[] = [];
  let current = "";
  for (const p of paras) {
    if (p.length > maxChars) {
      if (current.trim()) chunks.push(current.trim());
      current = "";
      for (let i = 0; i < p.length; i += maxChars) {
        chunks.push(p.slice(i, i + maxChars).trim());
      }
      continue;
    }
    if (current.length + p.length < maxChars) {
      current += p + "\n\n";
    } else {
      if (current.trim()) chunks.push(current.trim());
      current = p + "\n\n";
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

const files = walk(DOCS_DIR);
const chunks: { id: string; content: string; source: string }[] = [];
for (const file of files) {
  const text = await readDocText(file);
  for (const chunk of chunkText(text)) {
    chunks.push({ id: randomUUID(), content: chunk, source: relative(DOCS_DIR, file) });
  }
}

console.log(`Embedding ${chunks.length} chunks...`);
// First run downloads the ~80MB model once and caches it locally.
const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");

const documents = [];
for (const chunk of chunks) {
  const output = await extractor(chunk.content, { pooling: "mean", normalize: true });
  documents.push({ ...chunk, embedding: Array.from(output.data as Float32Array) });
}

const result = await client.uploadDocuments(documents);
console.log(`Uploaded ${result.results.length} chunks to ${INDEX_NAME}.`);
