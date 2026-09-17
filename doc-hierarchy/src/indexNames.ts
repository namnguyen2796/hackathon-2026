/** Index and alias names. Deliberately dependency-free: the MCP server and ask.ts reference
 *  these without pulling in the Azure SDK, which only the ingest/indexing path needs. */

/** What every query path targets for baseline content — an alias, not a physical index. */
export const ALIAS = "doc-hierarchy-index";

/** The blue/green pair the alias alternates between. */
export const PHYSICAL_INDEXES = ["doc-hierarchy-index-blue", "doc-hierarchy-index-green"] as const;

/** Work in progress, kept apart from the baseline so the two can't collide on docId. */
export const DRAFT_INDEX = "doc-hierarchy-draft-index";

export type DocScope = "baseline" | "draft";

export function indexFor(scope: DocScope | undefined): string {
  return scope === "draft" ? DRAFT_INDEX : ALIAS;
}
