import { config } from "dotenv";
config({ path: new URL("../../.env", import.meta.url) });

import { SearchIndexClient, AzureKeyCredential, SearchIndex } from "@azure/search-documents";

const client = new SearchIndexClient(
  process.env.AZURE_SEARCH_ENDPOINT!,
  new AzureKeyCredential(process.env.AZURE_SEARCH_KEY!)
);

const index: SearchIndex = {
  name: "docs-index",
  fields: [
    { name: "id", type: "Edm.String", key: true },
    { name: "content", type: "Edm.String", searchable: true },
    { name: "source", type: "Edm.String", filterable: true },
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

await client.createOrUpdateIndex(index);
console.log("docs-index ready.");
