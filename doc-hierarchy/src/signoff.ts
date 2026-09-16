import fs from "node:fs";
import path from "node:path";
import { readDocMetadata } from "./metadata.js";
import { readSignoffState, writeSignoffState, type DocSignoffState } from "./signoffStore.js";
import {
  findTableRow,
  hasPendingRevisions,
  loadDocxDocument,
  replaceCellText,
  saveDocxDocument,
} from "./docxRevisions.js";

export type SignoffRole = "owner" | "reviewer" | "owner and reviewer";

export type SignoffResult =
  | { outcome: "unchanged"; status: string }
  | { outcome: "recorded"; role: SignoffRole; bothApproved: boolean; status: string };

export type SignoffOptions = {
  draftPath: string;
  baselinePath: string;
  docId: string;
  draftName: string;
  name: string;
  nextBaselineNumber: number;
};

/**
 * Record one approval. The role isn't supplied — it's inferred by matching `name` against
 * the document's own declared Owner/Reviewer, so a name matching neither is rejected rather
 * than trusted. Both roles must approve before the document reaches Approved.
 */
export async function signoff(options: SignoffOptions): Promise<SignoffResult> {
  const { draftPath, baselinePath, docId, draftName, name, nextBaselineNumber } = options;

  // Signoff writes Status and Signoff Date into the file, so it may only ever touch the
  // current draft. Baselines stay frozen once promoted.
  const folder = path.basename(path.dirname(draftPath));
  if (folder !== draftName || !/^draft-\d+$/.test(folder)) {
    throw new Error(`Refusing to sign off ${docId}: ${draftPath} is not in the current draft (${draftName}).`);
  }

  // A draft copy identical to the baseline carries an approval that still stands; signing it
  // again would only downgrade it to Partially Approved.
  if (fs.existsSync(baselinePath) && fs.readFileSync(baselinePath).equals(fs.readFileSync(draftPath))) {
    return { outcome: "unchanged", status: (await readDocMetadata(draftPath)).status };
  }

  const { zip, doc, docXmlPath } = await loadDocxDocument(draftPath);

  if (hasPendingRevisions(doc)) {
    throw new Error(
      `${docId} still has unresolved tracked changes — accept or reject them in Word before signing off.`
    );
  }

  const meta = await readDocMetadata(draftPath);
  const isOwner = name === meta.owner;
  const isReviewer = name === meta.reviewer;
  if (!isOwner && !isReviewer) {
    throw new Error(
      `"${name}" doesn't match ${docId}'s declared Owner ("${meta.owner}") or Reviewer ("${meta.reviewer}").`
    );
  }

  const state: DocSignoffState = readSignoffState(draftName, docId);
  const now = new Date().toISOString();
  if (isOwner) state.owner = { name, at: now };
  if (isReviewer) state.reviewer = { name, at: now };

  const bothApproved = !!state.owner && !!state.reviewer;
  const status = bothApproved ? `Approved (Baseline ${nextBaselineNumber})` : "Partially Approved";

  const statusCell = findTableRow(doc, "Status");
  if (statusCell) replaceCellText(doc, statusCell, status);
  if (bothApproved) {
    const dateCell = findTableRow(doc, "Signoff Date");
    if (dateCell) replaceCellText(doc, dateCell, now.slice(0, 10));
  }

  // Persist the docx first: the store is the derived record, and re-running signoff
  // repairs it, whereas a store write with no matching docx edit reports a phantom approval.
  await saveDocxDocument(draftPath, zip, doc, docXmlPath);
  writeSignoffState(draftName, docId, state);

  const role: SignoffRole = isOwner && isReviewer ? "owner and reviewer" : isOwner ? "owner" : "reviewer";
  return { outcome: "recorded", role, bothApproved, status };
}

export function signoffStatus(draftName: string, docId: string): DocSignoffState {
  return readSignoffState(draftName, docId);
}
