import { config } from "dotenv";
// quiet, because ingest.ts imports this module, and ingest.ts is in turn imported by the
// running MCP server, where stdout is the JSON-RPC stream.
config({ path: new URL("../../.env", import.meta.url), quiet: true });

import { pathToFileURL } from "node:url";
import { SearchIndex } from "@azure/search-documents";
import { indexClient, PHYSICAL_INDEXES } from "./indexAlias.js";
import { DRAFT_INDEX } from "./indexNames.js";

export { DRAFT_INDEX };

/** One definition shared by both physical indexes behind the alias. */
export const HIERARCHY_INDEX_SCHEMA: Omit<SearchIndex, "name"> = {
  fields: [
    { name: "id", type: "Edm.String", key: true },
    { name: "docId", type: "Edm.String", filterable: true },
    { name: "content", type: "Edm.String", searchable: true },
    { name: "source", type: "Edm.String", filterable: true },
    { name: "owner", type: "Edm.String", filterable: true },
    { name: "reviewer", type: "Edm.String", filterable: true },
    { name: "dependsOn", type: "Collection(Edm.String)", filterable: true },
    {
      name: "embedding",
      type: "Collection(Edm.Single)",
      searchable: true,
      vectorSearchDimensions: 384, // matches all-MiniLM-L6-v2
      vectorSearchProfileName: "default-profile",
    },
  ],
  vectorSearch: {
    algorithms: [{ name: "default-hnsw", kind: "hnsw" }],
    profiles: [{ name: "default-profile", algorithmConfigurationName: "default-hnsw" }],
  },
};

/** Non-destructive: brings an index up to the current schema, leaving its documents alone. */
export async function ensureIndex(name: string): Promise<void> {
  await indexClient().createOrUpdateIndex({ ...HIERARCHY_INDEX_SCHEMA, name });
}

/** Destructive, and deliberately so — a staging index has to start genuinely empty, and
 *  dropping it each cycle absorbs any schema change for free. */
export async function recreateIndex(name: string): Promise<void> {
  try {
    await indexClient().deleteIndex(name);
  } catch {
    // Fine if it never existed.
  }
  await indexClient().createIndex({ ...HIERARCHY_INDEX_SCHEMA, name });
}

// Only when run directly (npm run doc-hierarchy:create-index).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const names = [...PHYSICAL_INDEXES, DRAFT_INDEX];
  for (const name of names) await ensureIndex(name);
  console.log(`${names.join(", ")} ready.`);
}
