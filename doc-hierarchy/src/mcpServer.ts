import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadGraph, downstreamOf } from "./graph.js";
import { detectChange } from "./detectChange.js";
import { packageRoot, getCurrentBaselineDir } from "./currentBaseline.js";

const RAG_API_URL = process.env.RAG_API_URL ?? "http://localhost:8000/search";
const INDEX = "doc-hierarchy-index";
const DOCS_ROOT = path.join(packageRoot, "docs");

// Deliberately outside the repo, so notifications survive branch switches and
// aren't caught by .gitignore rules on the project tree.
const NOTIFY_DIR = process.env.NOTIFY_LOG_DIR ?? path.join(packageRoot, "..", "..", "logs");
const NOTIFY_FILE = path.join(NOTIFY_DIR, "doc-hierarchy-notifications.json");

type Notification = { timestamp: string; docId: string; message: string };

/** Append one entry. Read and write are both sync with no await between them, so
 *  concurrent tool calls cannot interleave and lose each other's writes. */
function appendNotification(docId: string, message: string): number {
  fs.mkdirSync(NOTIFY_DIR, { recursive: true });

  let entries: Notification[] = [];
  if (fs.existsSync(NOTIFY_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(NOTIFY_FILE, "utf-8"));
    if (!Array.isArray(parsed)) {
      throw new Error(`${NOTIFY_FILE} is not a JSON array; move it aside and retry.`);
    }
    entries = parsed;
  }

  entries.push({ timestamp: new Date().toISOString(), docId, message });
  fs.writeFileSync(NOTIFY_FILE, JSON.stringify(entries, null, 2));
  return entries.length;
}

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
  "list_documents",
  {
    description:
      "List the documents in the set, which differ from the baseline, and the baseline/draft " +
      "file paths that detect_change needs. Call this first if you don't know what exists.",
    inputSchema: { draftDir: z.string().default("docs/draft2") },
  },
  async ({ draftDir }) => {
    try {
      const baselineDir = getCurrentBaselineDir();
      const draft = resolveDocPath(draftDir);
      const rel = (p: string) => path.relative(packageRoot, p).replaceAll("\\", "/");

      const lines = (await loadGraph()).map(({ docId }) => {
        // Documents are stored as <docId>.docx; a mismatch shows up as "missing".
        const b = path.join(baselineDir, `${docId}.docx`);
        const d = path.join(draft, `${docId}.docx`);
        const state = !fs.existsSync(b) || !fs.existsSync(d)
          ? "missing"
          : fs.readFileSync(b).equals(fs.readFileSync(d)) ? "same   " : "CHANGED";
        return `  ${docId.padEnd(13)} ${state}  baseline: ${rel(b)}  draft: ${rel(d)}`;
      });

      return { content: [{ type: "text" as const, text:
        `Current baseline: ${path.basename(baselineDir)}\n\n${lines.join("\n")}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: (e as Error).message }], isError: true };
    }
  }
);

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
    description:
      "Record a notification to a document's owner/reviewer. Appends to " +
      "logs/doc-hierarchy-notifications.json (stub — wire up email/Teams later).",
    inputSchema: { docId: z.string(), message: z.string() },
  },
  async ({ docId, message }) => {
    try {
      const count = appendNotification(docId, message);
      // stderr, not stdout — stdout carries the JSON-RPC stream.
      console.error(`NOTIFY ${docId}: ${message}`);
      return { content: [{ type: "text" as const, text: `Logged to ${NOTIFY_FILE} (${count} total).` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: (e as Error).message }], isError: true };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
