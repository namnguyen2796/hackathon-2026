import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertPromotable } from "./approve.js";
import { createFixtureDocx, metadataFields } from "./docxFixture.js";

type Doc = { docId: string; status: string };

async function withDraft(
  docs: Doc[],
  manifest: { docId: string; dependsOn: string[] }[] | null,
  body: (draftDir: string) => Promise<void>
): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "approve-"));
  const draftDir = path.join(tempDir, "draft-3");
  try {
    fs.mkdirSync(draftDir, { recursive: true });
    for (const d of docs) {
      await createFixtureDocx(
        path.join(draftDir, `${d.docId}.docx`),
        metadataFields({ "Document ID": d.docId, Status: d.status })
      );
    }
    if (manifest) {
      fs.writeFileSync(path.join(draftDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    }
    await body(draftDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

const entry = (docId: string) => ({ docId, dependsOn: [] });

test("promotes a draft whose manifest is fully present and approved", async () => {
  const docs = [
    { docId: "SYS-REQ-001", status: "Approved (Baseline 3)" },
    { docId: "SUB-SIG-010", status: "Approved (Baseline 1)" },
  ];

  await withDraft(docs, docs.map(d => entry(d.docId)), async draftDir => {
    assert.deepEqual((await assertPromotable(draftDir)).sort(), ["SUB-SIG-010.docx", "SYS-REQ-001.docx"]);
  });
});

test("refuses a draft with no manifest.json", async () => {
  await withDraft([{ docId: "SYS-REQ-001", status: "Approved (Baseline 3)" }], null, async draftDir => {
    await assert.rejects(() => assertPromotable(draftDir), /draft-3 has no manifest\.json/);
  });
});

test("refuses a draft whose manifest is empty", async () => {
  await withDraft([{ docId: "SYS-REQ-001", status: "Approved (Baseline 3)" }], [], async draftDir => {
    await assert.rejects(() => assertPromotable(draftDir), /not a non-empty list/);
  });
});

test("refuses a draft missing a document its manifest lists", async () => {
  const docs = [{ docId: "SYS-REQ-001", status: "Approved (Baseline 3)" }];

  await withDraft(docs, [entry("SYS-REQ-001"), entry("SUB-SIG-010")], async draftDir => {
    await assert.rejects(() => assertPromotable(draftDir), /missing document\(s\) its manifest lists: SUB-SIG-010/);
  });
});

test("refuses a draft with a document that isn't approved", async () => {
  const docs = [
    { docId: "SYS-REQ-001", status: "Approved (Baseline 3)" },
    { docId: "SUB-SIG-010", status: "Partially Approved" },
  ];

  await withDraft(docs, docs.map(d => entry(d.docId)), async draftDir => {
    await assert.rejects(
      () => assertPromotable(draftDir),
      /not yet fully approved: SUB-SIG-010 \(Partially Approved\)/
    );
  });
});

test("promotes documents added since the manifest was written", async () => {
  const docs = [
    { docId: "SYS-REQ-001", status: "Approved (Baseline 3)" },
    { docId: "NEW-DOC-900", status: "Approved (Baseline 3)" },
  ];

  await withDraft(docs, [entry("SYS-REQ-001")], async draftDir => {
    assert.deepEqual((await assertPromotable(draftDir)).sort(), ["NEW-DOC-900.docx", "SYS-REQ-001.docx"]);
  });
});
