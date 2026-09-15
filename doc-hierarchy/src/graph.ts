import { readFile } from "node:fs/promises";
import path from "node:path";
import { getLatestBaselineDir } from "./baselines.js";

export type Edge = { docId: string; dependsOn: string[] };

export async function loadGraph(): Promise<Edge[]> {
  const file = path.join(getLatestBaselineDir(), "manifest.json");
  return JSON.parse(await readFile(file, "utf-8"));
}

export function downstreamOf(graph: Edge[], changedDocId: string): string[] {
  const affected = new Set<string>();
  const queue = [changedDocId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const doc of graph) {
      if (doc.dependsOn.includes(current) && !affected.has(doc.docId)) {
        affected.add(doc.docId);
        queue.push(doc.docId);
      }
    }
  }
  return [...affected];
}
