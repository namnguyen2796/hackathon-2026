import path from "node:path";
import { getCurrentDraftDir, getLatestBaselineDir } from "./baselines.js";
import { getLiveAndStagingIndexNames } from "./indexAlias.js";
import { DRAFT_INDEX, recreateIndex } from "./createIndex.js";
import { contentHash } from "./contentHash.js";
import {
  clientFor, odataEscape, parseDocsIn, parseFile, readManifestHashes, sourcePath, uploadDoc,
  type HierarchyDoc,
} from "./ingest.js";

async function chunkIdsFor(indexName: string, docId: string): Promise<string[]> {
  const results = await clientFor(indexName).search("*", {
    filter: `docId eq '${odataEscape(docId)}'`,
    select: ["id"],
  });
  const ids: string[] = [];
  for await (const r of results.results) ids.push(r.document.id);
  return ids;
}

/**
 * Re-embed one document into the draft index, right after a successful apply_change. Chunk ids
 * are stable (`<docId>-<n>`), so the upload overwrites in place and only chunks the shorter new
 * version no longer covers are deleted — the document is never absent from the index mid-update.
 */
export async function updateDraftIndexForDoc(docId: string, filePath: string): Promise<void> {
  const doc = await parseFile(filePath);
  const previousIds = await chunkIdsFor(DRAFT_INDEX, docId);
  const currentIds = new Set(await uploadDoc(doc, DRAFT_INDEX));

  const stale = previousIds.filter(id => !currentIds.has(id));
  if (stale.length) await clientFor(DRAFT_INDEX).deleteDocuments("id", stale);
}

/**
 * Copy one document's already-embedded chunks from a baseline index into the draft index,
 * retagging `source` to the draft's own path. False if the source index held nothing for it,
 * so the caller can fall back to embedding.
 */
async function copyIntoDraft(docId: string, from: string, draftDir: string): Promise<boolean> {
  const results = await clientFor(from).search("*", { filter: `docId eq '${odataEscape(docId)}'` });
  const documents: HierarchyDoc[] = [];
  for await (const r of results.results) {
    documents.push({ ...r.document, source: sourcePath(path.join(draftDir, `${docId}.docx`)) });
  }
  if (!documents.length) return false;
  await clientFor(DRAFT_INDEX).uploadDocuments(documents);
  return true;
}

/**
 * Seed the draft index from the baseline's live index, once a new draft has been opened. The
 * draft starts as a byte-identical copy of that baseline, so nothing needs re-embedding — only
 * `source` differs, since it names the folder rather than the content.
 *
 * Must run after the baseline reindex: it reads whichever index the alias now points at, and
 * that only holds the new baseline's chunks once the swap has happened.
 */
export async function seedDraftIndexFromBaseline(docIds: string[]): Promise<void> {
  const { live } = await getLiveAndStagingIndexNames();
  const draftDir = getCurrentDraftDir();

  await recreateIndex(DRAFT_INDEX);
  for (const docId of docIds) await copyIntoDraft(docId, live, draftDir);

  console.error(`Seeded ${DRAFT_INDEX} from ${live} for ${docIds.length} doc(s).`);
}

/**
 * Rebuild the whole draft index from the current draft folder. Nothing else does this: seeding
 * only runs at promotion and updateDraftIndexForDoc only covers one edited document, so this is
 * what bootstraps the index after create-index and what repairs it if it drifts.
 *
 * Documents still identical to the current baseline are copied from the baseline's live index
 * rather than re-embedded, on the same reasoning as the baseline reindex.
 */
export async function reindexCurrentDraft(): Promise<void> {
  const draftDir = getCurrentDraftDir();
  const baselineDir = getLatestBaselineDir();
  const docs = await parseDocsIn(draftDir);

  const baselineHashes = readManifestHashes(path.join(baselineDir, "manifest.json"));
  const { live } = await getLiveAndStagingIndexNames();

  await recreateIndex(DRAFT_INDEX);

  let copied = 0;
  for (const doc of docs) {
    const unchanged = baselineHashes.get(doc.docId) === contentHash(doc.text);
    if (unchanged && await copyIntoDraft(doc.docId, live, draftDir)) copied++;
    else await uploadDoc(doc, DRAFT_INDEX);
  }

  console.error(
    `Reindexed ${docs.length} doc(s) from ${path.basename(draftDir)} into ${DRAFT_INDEX} ` +
    `(${copied} unchanged from ${path.basename(baselineDir)}, ${docs.length - copied} embedded).`
  );
}

export { DRAFT_INDEX };
