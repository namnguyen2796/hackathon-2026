import { loadGraph, downstreamOf } from "./graph.js";

const RAG_API_URL = process.env.RAG_API_URL ?? "http://localhost:8000/search";
const INDEX = "doc-hierarchy-index";

// Untested placeholders — calibrate against real data. One floor for the plain search: a passage
// that states the value and one that discusses the topic without stating it can score similarly,
// so this deliberately doesn't try to separate them.
const SEARCH_MIN_SCORE = 0.55;
const GRAPH_MIN_SCORE = 0.5; // for the independent relevance check on a graph candidate

// The graph candidates are now checked in one filtered query rather than one query each, so k
// has to cover every candidate's chunks at once instead of just asking each for its best one.
// A document all of whose chunks rank below other candidates' can now be missed — that is the
// trade for collapsing N round trips into one.
const CHUNKS_PER_GRAPH_CANDIDATE = 5;

// search.in's value list is a single string literal, so a separator that cannot occur inside
// a docId is needed. Space and comma are the defaults and both are plausible in an id.
const ID_SEPARATOR = "|";

type Hit = { docId: string; content: string; source: string; score: number };

/**
 * search.in takes ONE delimited string literal plus the delimiter — not a list of separate
 * literals. Only that single literal's own quotes need escaping, by doubling.
 * See https://learn.microsoft.com/azure/search/search-query-odata-search-in-function
 */
function searchInFilter(field: string, values: string[]): string {
  const unusable = values.filter(v => v.includes(ID_SEPARATOR));
  if (unusable.length) {
    throw new Error(
      `Document id(s) contain "${ID_SEPARATOR}", the separator used to batch graph lookups: ${unusable.join(", ")}`
    );
  }
  const list = values.join(ID_SEPARATOR).replace(/'/g, "''");
  return `search.in(${field}, '${list}', '${ID_SEPARATOR}')`;
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
  // Every candidate recorded once, attributed to the first hit that reached it — the same doc
  // is reachable from several hits and would give the same answer each time.
  const seen = new Set<string>();
  const candidates: { docId: string; downstreamOf: string }[] = [];

  for (const hit of found) {
    for (const docId of downstreamOf(graph, hit.docId)) {
      if (foundIds.has(docId) || seen.has(docId)) continue;
      seen.add(docId);
      candidates.push({ docId, downstreamOf: hit.docId });
    }
  }
  if (candidates.length === 0) return { found, viaGraph: [] };

  const hits = await search(
    query,
    candidates.length * CHUNKS_PER_GRAPH_CANDIDATE,
    searchInFilter("docId", candidates.map((c) => c.docId))
  );

  // Best-scoring chunk per document, standing in for the old per-document top-1 query.
  const best = new Map<string, Hit>();
  for (const hit of hits) {
    const current = best.get(hit.docId);
    if (!current || hit.score > current.score) best.set(hit.docId, hit);
  }

  // Rebuilt from `candidates`, not from the result order, so output order stays graph order.
  const viaGraph = candidates.flatMap(({ docId, downstreamOf: upstream }) => {
    const hit = best.get(docId);
    return hit && hit.score >= GRAPH_MIN_SCORE ? [{ ...hit, downstreamOf: upstream }] : [];
  });

  return { found, viaGraph };
}
