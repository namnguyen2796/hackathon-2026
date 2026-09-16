import { config } from "dotenv";
// Local-run convenience only: mcp-manager injects these before any module code runs, and
// dotenv never overrides an already-set variable. quiet, because dotenv logs to stdout and
// stdout here is the MCP JSON-RPC stream.
config({ path: new URL("../../.env", import.meta.url), quiet: true });

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const RAG_API_URL = process.env.RAG_API_URL ?? "http://localhost:8000/search";
const INDEX = "docs-index";

const server = new McpServer({ name: "docs-search", version: "1.0.0" });

server.registerTool(
  "search_docs",
  {
    description: "Search the local knowledge base (mirrored wiki/HR docs) for relevant passages.",
    inputSchema: { query: z.string() },
  },
  async ({ query }) => {
    const res = await fetch(RAG_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index: INDEX, query, top_k: 5 }),
    });
    const { results } = (await res.json()) as { results: { source: string; content: string }[] };
    const text = results.length
      ? results.map((r) => `Source: ${r.source}\n${r.content}`).join("\n\n---\n\n")
      : "No relevant documents found.";
    return { content: [{ type: "text" as const, text }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
