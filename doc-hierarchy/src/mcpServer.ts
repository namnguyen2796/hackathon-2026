import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import { z } from "zod";
import { loadGraph, downstreamOf } from "./graph.js";
import { detectChange } from "./detectChange.js";
import { packageRoot } from "./currentBaseline.js";

const RAG_API_URL = process.env.RAG_API_URL ?? "http://localhost:8000/search";
const INDEX = "doc-hierarchy-index";
const DOCS_ROOT = path.join(packageRoot, "docs");

// The server's cwd is whatever launched it, and these paths come from a model,
// so resolve against the package and refuse anything that escapes docs/.
function resolveDocPath(input: string): string {
  const resolved = path.resolve(packageRoot, input);
  if (!resolved.startsWith(DOCS_ROOT + path.sep)) {
    throw new Error(`Path must be inside docs/, got: ${input}`);
  }
  return resolved;
}

const server = new McpServer({ name: "doc-hierarchy", version: "1.0.0" });

server.registerTool(
  "detect_change",
  {
    description:
      "Diff a document's baseline copy against its draft copy. Paths are relative to the " +
      "doc-hierarchy package and must be inside docs/, e.g. 'docs/baseline1/SYS-REQ-001.docx'.",
    inputSchema: { docId: z.string(), baselinePath: z.string(), draftPath: z.string() },
  },
  async ({ baselinePath, draftPath }) => {
    const summary = await detectChange(resolveDocPath(baselinePath), resolveDocPath(draftPath));
    return { content: [{ type: "text" as const, text: summary ?? "No changes detected." }] };
  }
);

server.registerTool(
  "trace_impact",
  {
    description: "Given a changed document ID, return all documents downstream of it.",
    inputSchema: { docId: z.string() },
  },
  async ({ docId }) => {
    const graph = await loadGraph();
    const affected = downstreamOf(graph, docId);
    const text = affected.length ? affected.join(", ") : "No downstream documents found.";
    return { content: [{ type: "text" as const, text }] };
  }
);

server.registerTool(
  "suggest_changes",
  {
    description: "Suggest what might need updating in a downstream doc given an upstream change summary.",
    inputSchema: { docId: z.string(), changeSummary: z.string() },
  },
  async ({ docId, changeSummary }) => {
    const res = await fetch(RAG_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        index: INDEX,
        query: changeSummary,
        top_k: 5,
        filter: `docId eq '${docId.replace(/'/g, "''")}'`,
      }),
    });
    const { results } = (await res.json()) as { results: { content: string; source: string }[] };
    const text = results.length
      ? `Related passages in ${docId} that may need review:\n\n` +
        results.map((r) => r.content).join("\n---\n")
      : `No related passages found in ${docId}.`;
    return { content: [{ type: "text" as const, text }] };
  }
);

server.registerTool(
  "notify_owner",
  {
    description: "Log a notification to a document's owner/reviewer (stub — wire up email/Teams later).",
    inputSchema: { docId: z.string(), message: z.string() },
  },
  async ({ docId, message }) => {
    // stderr, not stdout — stdout carries the JSON-RPC stream.
    console.error(`NOTIFY ${docId}: ${message}`);
    return { content: [{ type: "text" as const, text: "Logged (stub)." }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
