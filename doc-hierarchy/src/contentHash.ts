import { createHash } from "node:crypto";

/** Over a document's raw extracted text, which includes its metadata table — so an owner or
 *  status change counts as a change, not just body edits. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
