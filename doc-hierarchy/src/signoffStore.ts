import fs from "node:fs";
import path from "node:path";
import { logspaceRoot } from "./config.js";

export type Approval = { name: string; at: string };
export type DocSignoffState = { owner?: Approval; reviewer?: Approval };
type Store = Record<string, Record<string, DocSignoffState>>; // draftName -> docId -> state

function storePath(): string {
  return path.join(logspaceRoot(), "doc-hierarchy-signoffs.json");
}

function readStore(): Store {
  const file = storePath();
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON object; move it aside and retry.`);
  }
  return parsed as Store;
}

/** Read and write are both sync with no await between them, so concurrent tool calls
 *  cannot interleave and lose each other's writes. */
function writeStore(store: Store): void {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(store, null, 2));
}

export function readSignoffState(draftName: string, docId: string): DocSignoffState {
  return readStore()[draftName]?.[docId] ?? {};
}

export function writeSignoffState(draftName: string, docId: string, state: DocSignoffState): void {
  const store = readStore();
  store[draftName] ??= {};
  store[draftName][docId] = state;
  writeStore(store);
}

export function clearSignoffState(draftName: string, docId: string): void {
  const store = readStore();
  if (!store[draftName]?.[docId]) return;
  delete store[draftName][docId];
  writeStore(store);
}
