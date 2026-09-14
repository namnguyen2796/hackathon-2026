import { config } from "dotenv";
// Resolved against this file, not process.cwd(), so the server runs from any directory.
config({ path: new URL("../../.env", import.meta.url) });

import express from "express";
import { SearchClient, AzureKeyCredential } from "@azure/search-documents";
import { embed } from "./embed.js";

const endpoint = process.env.AZURE_SEARCH_ENDPOINT!;
const credential = new AzureKeyCredential(process.env.AZURE_SEARCH_KEY!);

const clients = new Map<string, SearchClient<Record<string, unknown>>>();
function getClient(index: string) {
  if (!clients.has(index)) {
    clients.set(index, new SearchClient(endpoint, index, credential));
  }
  return clients.get(index)!;
}

const app = express();
app.use(express.json());

app.post("/search", async (req, res) => {
  const { index, query, top_k = 5, filter } = req.body as {
    index?: string;
    query?: string;
    top_k?: number;
    filter?: string;
  };
  if (!index) return res.status(400).json({ error: "'index' is required" });
  if (!query) return res.status(400).json({ error: "'query' is required" });

  const vector = await embed(query);
  const results = await getClient(index).search("*", {
    vectorSearchOptions: {
      queries: [{ kind: "vector", vector, fields: ["embedding"], kNearestNeighborsCount: top_k }],
    },
    filter,
  });

  const hits: Record<string, unknown>[] = [];
  for await (const r of results.results) {
    // Drop the raw vector — it's 384 floats per hit and useless to the caller.
    const { embedding, ...rest } = r.document;
    hits.push({ ...rest, score: r.score });
  }
  res.json({ results: hits });
});

const port = Number(process.env.PORT ?? 8000);
app.listen(port, () => console.log(`RAG API listening on http://localhost:${port}`));
