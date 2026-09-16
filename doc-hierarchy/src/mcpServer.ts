import { config } from "dotenv";
// Local-run convenience only: mcp-manager injects these before any module code runs, and
// dotenv never overrides an already-set variable. quiet, because dotenv logs to stdout and
// stdout here is the MCP JSON-RPC stream.
config({ path: new URL("../../.env", import.meta.url), quiet: true });

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadGraph, downstreamOf } from "./graph.js";
import { detectChange } from "./detectChange.js";
import { resolveDocPath, getLatestBaselineDir, getCurrentDraftDir, draftFilePath, latestBaselineNumber } from "./baselines.js";
import { readDocMetadata } from "./metadata.js";
import { applyChange } from "./applyChange.js";
import { signoff, signoffStatus } from "./signoff.js";
import { approveBaseline } from "./approve.js";
import { logspaceRoot } from "./config.js";

const RAG_API_URL = process.env.RAG_API_URL ?? "http://localhost:8000/search";
const INDEX = "doc-hierarchy-index";

// Resolved per call, not at module load: an unset MCP_CONFIG_LOGSPACE must fail the one tool
// that needs it, not abort the whole server before any tool is reachable.
function notifyFile(): string {
  return path.join(logspaceRoot(), "doc-hierarchy-notifications.json");
}

type Notification = { timestamp: string; docId: string; notifierName: string; message: string };

/** Append one entry. Read and write are both sync with no await between them, so
 *  concurrent tool calls cannot interleave and lose each other's writes. */
function appendNotification(docId: string, notifierName: string, message: string): number {
  const file = notifyFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let entries: Notification[] = [];
  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!Array.isArray(parsed)) {
      throw new Error(`${file} is not a JSON array; move it aside and retry.`);
    }
    entries = parsed;
  }

  entries.push({ timestamp: new Date().toISOString(), docId, notifierName, message });
  fs.writeFileSync(file, JSON.stringify(entries, null, 2));
  return entries.length;
}

function odataEscape(s: string): string {
  return s.replace(/'/g, "''");
}

const server = new McpServer({ name: "doc-hierarchy", version: "1.0.0" });

server.registerTool(
  "list_documents",
  {
    description:
      "List every document in the current baseline's graph and whether it changed in a draft. " +
      "Defaults to the latest baseline and latest draft folders; call this first if you don't " +
      "know what exists.",
    inputSchema: { draftDir: z.string().optional() },
  },
  async ({ draftDir }) => {
    try {
      const baselineDir = getLatestBaselineDir();
      const resolvedDraftDir = draftDir ? resolveDocPath(draftDir) : getCurrentDraftDir();

      const lines = (await loadGraph()).map(({ docId }) => {
        // Documents are stored as <docId>.docx; a mismatch shows up as "missing".
        const b = path.join(baselineDir, `${docId}.docx`);
        const d = path.join(resolvedDraftDir, `${docId}.docx`);
        const state = !fs.existsSync(b) || !fs.existsSync(d)
          ? "missing"
          : fs.readFileSync(b).equals(fs.readFileSync(d)) ? "same   " : "CHANGED";
        return `  ${docId.padEnd(13)} ${state}`;
      });

      return { content: [{ type: "text" as const, text:
        `Current baseline: ${path.basename(baselineDir)}\nDraft: ${path.basename(resolvedDraftDir)}\n\n${lines.join("\n")}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: (e as Error).message }], isError: true };
    }
  }
);

server.registerTool(
  "detect_change",
  {
    description:
      "Diff a document's baseline copy against its draft copy. Give baselinePath/draftPath to " +
      "override; otherwise resolves docId against the latest baseline and latest draft folders.",
    inputSchema: {
      docId: z.string(),
      baselinePath: z.string().optional(),
      draftPath: z.string().optional(),
    },
  },
  async ({ docId, baselinePath, draftPath }) => {
    const resolvedBaselinePath = baselinePath
      ? resolveDocPath(baselinePath)
      : path.join(getLatestBaselineDir(), `${docId}.docx`);
    const resolvedDraftPath = draftPath
      ? resolveDocPath(draftPath)
      : path.join(getCurrentDraftDir(), `${docId}.docx`);
    const summary = await detectChange(resolvedBaselinePath, resolvedDraftPath);
    return { content: [{ type: "text" as const, text: summary ?? "No changes detected." }] };
  }
);

server.registerTool(
  "trace_impact",
  {
    description: "Given a changed document ID, return all documents downstream of it in the latest baseline.",
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
        filter: `docId eq '${odataEscape(docId)}'`,
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
      "doc-hierarchy-notifications.json in the configured logspace (stub — wire up email/Teams later).",
    inputSchema: { docId: z.string(), notifierName: z.string(), message: z.string() },
  },
  async ({ docId, notifierName, message }) => {
    try {
      const count = appendNotification(docId, notifierName, message);
      // stderr, not stdout — stdout carries the JSON-RPC stream.
      console.error(`NOTIFY ${docId} by ${notifierName}: ${message}`);
      return { content: [{ type: "text" as const, text: `Logged to ${notifyFile()} (${count} total).` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: (e as Error).message }], isError: true };
    }
  }
);

server.registerTool(
  "apply_change",
  {
    description:
      "Propose a tracked-change edit to a paragraph in the current draft, authored as the " +
      "document's owner. Reviewable natively in Word — doesn't touch accepted text until " +
      "someone reviews the revision.",
    inputSchema: { docId: z.string(), oldText: z.string(), newText: z.string() },
  },
  async ({ docId, oldText, newText }) => {
    try {
      const filePath = draftFilePath(docId);
      const { owner } = await readDocMetadata(filePath);
      const draftName = path.basename(getCurrentDraftDir());
      const { statusChanged } = await applyChange(filePath, oldText, newText, { author: owner, docId, draftName });
      const note = statusChanged ? " Its prior approval was cleared: Status is now Draft and Signoff Date TBD." : "";
      return { content: [{ type: "text" as const, text: `Proposed change to ${docId}, tracked as an edit by ${owner}.${note}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: (e as Error).message }], isError: true };
    }
  }
);

server.registerTool(
  "signoff",
  {
    description:
      "Record an approval for a document in the current draft, from the person named. The role " +
      "(owner or reviewer) is inferred by matching the name against the document's own metadata; " +
      "both roles must approve before it becomes Approved. Documents unchanged from the baseline " +
      "need no signoff. Requires all tracked changes to already be accepted or rejected in Word.",
    inputSchema: { docId: z.string(), name: z.string() },
  },
  async ({ docId, name }) => {
    try {
      const draftDir = getCurrentDraftDir();
      const baselineDir = getLatestBaselineDir();
      const result = await signoff({
        draftPath: draftFilePath(docId),
        baselinePath: path.join(baselineDir, `${docId}.docx`),
        docId,
        draftName: path.basename(draftDir),
        name,
        nextBaselineNumber: latestBaselineNumber() + 1,
      });
      const text = result.outcome === "unchanged"
        ? `${docId} is unchanged from ${path.basename(baselineDir)} — its existing approval (${result.status}) still stands, so no signoff is needed.`
        : result.bothApproved
          ? `Recorded ${result.role} approval for ${docId} by ${name}. Both approvals are now in — Status: ${result.status}.`
          : `Recorded ${result.role} approval for ${docId} by ${name}. Status: ${result.status}, awaiting the other role.`;
      return { content: [{ type: "text" as const, text }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: (e as Error).message }], isError: true };
    }
  }
);

server.registerTool(
  "signoff_status",
  {
    description: "Check which approvals (owner/reviewer) have been recorded for a document in the current draft.",
    inputSchema: { docId: z.string() },
  },
  async ({ docId }) => {
    try {
      const state = signoffStatus(path.basename(getCurrentDraftDir()), docId);
      const text = [
        `Owner: ${state.owner ? `approved by ${state.owner.name} at ${state.owner.at}` : "pending"}`,
        `Reviewer: ${state.reviewer ? `approved by ${state.reviewer.name} at ${state.reviewer.at}` : "pending"}`,
      ].join("\n");
      return { content: [{ type: "text" as const, text }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: (e as Error).message }], isError: true };
    }
  }
);

server.registerTool(
  "approve_baseline",
  {
    description:
      "Promote the draft in progress to the next baseline: draft-N is renamed to baseline-N and " +
      "draft-N+1 is opened as a copy of it. Requires a manifest.json listing documents that are " +
      "all present and Approved. Reindexes against the new baseline.",
    inputSchema: { name: z.string() },
  },
  async ({ name }) => {
    try {
      const result = await approveBaseline();
      // Audit trail only — nothing here verifies the caller is entitled to promote.
      console.error(`PROMOTED by ${name}: ${result.baselineName} (${result.docCount} docs)`);
      return { content: [{ type: "text" as const, text:
        `Promoted to ${result.baselineName} (${result.docCount} documents), reindexed, and opened ${result.draftName} as the next cycle.` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: (e as Error).message }], isError: true };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
