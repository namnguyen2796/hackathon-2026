import { loadGraph, downstreamOf } from "./graph.js";

const RAG_API_URL = process.env.RAG_API_URL ?? "http://localhost:8000/search";
const INDEX = "doc-hierarchy-index";

// Untested placeholders — calibrate against real data. One floor for the plain search: a passage
// that states the value and one that discusses the topic without stating it can score similarly,
// so this deliberately doesn't try to separate them.
const SEARCH_MIN_SCORE = 0.55;
const GRAPH_MIN_SCORE = 0.5; // for the independent relevance check on a graph candidate

type Hit = { docId: string; content: string; source: string; score: number };

function odataEscape(s: string): string {
  return s.replace(/'/g, "''");
}

async function search(query: string, top_k: number, filter?: string): Promise<Hit[]> {
  const res = await fetch(RAG_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ index: INDEX, query, top_k, filter }),
  });
  const { results } = (await res.json()) as { results: Hit[] };
  return results;
}

export type AskResult = {
  found: Hit[];                                 // plain search — may state the value or just discuss it
  viaGraph: (Hit & { downstreamOf: string })[]; // surfaced only via dependency, checked independently
};

export async function askDocuments(query: string): Promise<AskResult> {
  const raw = await search(query, 8);
  const found = raw.filter((h) => h.score >= SEARCH_MIN_SCORE);

  const graph = await loadGraph();
  const foundIds = new Set(found.map((h) => h.docId));
  const viaGraph: AskResult["viaGraph"] = [];
  // Every candidate already checked, whether it passed or not — the same doc is reachable from
  // several hits and re-querying it would give the same answer.
  const checked = new Set<string>();

  for (const hit of found) {
    const candidates = downstreamOf(graph, hit.docId)
      .filter((id) => !foundIds.has(id) && !checked.has(id));
    for (const docId of candidates) {
      checked.add(docId);
      const [best] = await search(query, 1, `docId eq '${odataEscape(docId)}'`);
      if (best && best.score >= GRAPH_MIN_SCORE) {
        viaGraph.push({ ...best, downstreamOf: hit.docId });
      }
    }
  }

  return { found, viaGraph };
}
