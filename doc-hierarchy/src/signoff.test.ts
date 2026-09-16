import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { createFixtureDocx, metadataFields } from "./docxFixture.js";

const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "signoff-store-"));
process.env.SIGNOFF_LOG_DIR = storeDir;

const { signoff, signoffStatus } = await import("./signoff.js");

const DRAFT = "draft-9";
const BASELINE = "baseline-2";
const DOC_ID = "DOC-1";

async function readDocumentXml(filePath: string): Promise<string> {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  return zip.file("word/document.xml")!.async("string");
}

async function withDocument(
  fields: { owner: string; reviewer: string; status?: string },
  body: (sign: (name: string) => ReturnType<typeof signoff>, draftPath: string, baselinePath: string) => Promise<void>,
  documentBody?: string
): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "signoff-"));
  try {
    const draftPath = path.join(tempDir, DRAFT, `${DOC_ID}.docx`);
    const baselinePath = path.join(tempDir, BASELINE, `${DOC_ID}.docx`);
    fs.mkdirSync(path.dirname(draftPath), { recursive: true });
    await createFixtureDocx(
      draftPath,
      metadataFields({
        "Document ID": DOC_ID,
        Owner: fields.owner,
        Reviewer: fields.reviewer,
        Status: fields.status ?? "Draft",
      }),
      documentBody
    );
    const sign = (name: string) => signoff({
      draftPath,
      baselinePath,
      docId: DOC_ID,
      draftName: DRAFT,
      name,
      nextBaselineNumber: 3,
    });
    await body(sign, draftPath, baselinePath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(path.join(storeDir, "doc-hierarchy-signoffs.json"), { force: true });
  }
}

test.after(() => fs.rmSync(storeDir, { recursive: true, force: true }));

test("infers the owner role and holds at Partially Approved until both roles sign", async () => {
  await withDocument({ owner: "A. Chen", reviewer: "M. Osei" }, async (sign, draftPath) => {
    const first = await sign("A. Chen");

    assert.equal(first.outcome, "recorded");
    assert.partialDeepStrictEqual(first, { role: "owner", bothApproved: false, status: "Partially Approved" });
    assert.match(await readDocumentXml(draftPath), /<w:t xml:space="preserve">Partially Approved<\/w:t>/);

    const second = await sign("M. Osei");
    const xml = await readDocumentXml(draftPath);

    assert.partialDeepStrictEqual(second, { role: "reviewer", bothApproved: true, status: "Approved (Baseline 3)" });
    assert.match(xml, /<w:t xml:space="preserve">Approved \(Baseline 3\)<\/w:t>/);
    assert.match(xml, /<w:t xml:space="preserve">\d{4}-\d{2}-\d{2}<\/w:t>/);
  });
});

test("records both roles at once when one person holds both", async () => {
  await withDocument({ owner: "A. Chen", reviewer: "A. Chen" }, async sign => {
    const result = await sign("A. Chen");

    assert.partialDeepStrictEqual(result, {
      role: "owner and reviewer",
      bothApproved: true,
      status: "Approved (Baseline 3)",
    });
  });
});

test("skips signoff for a draft byte-identical to the baseline", async () => {
  await withDocument({ owner: "A. Chen", reviewer: "M. Osei", status: "Approved (Baseline 1)" }, async (sign, draftPath, baselinePath) => {
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.copyFileSync(draftPath, baselinePath);

    const result = await sign("A. Chen");

    assert.deepEqual(result, { outcome: "unchanged", status: "Approved (Baseline 1)" });
    assert.deepEqual(signoffStatus(DRAFT, DOC_ID), {});
    assert.match(await readDocumentXml(draftPath), /<w:t>Approved \(Baseline 1\)<\/w:t>/);
  });
});

test("refuses to sign off a file outside the current draft folder", async () => {
  await withDocument({ owner: "A. Chen", reviewer: "M. Osei", status: "Approved (Baseline 1)" }, async (_sign, draftPath, baselinePath) => {
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.copyFileSync(draftPath, baselinePath);

    await assert.rejects(
      () => signoff({
        draftPath: baselinePath,
        baselinePath,
        docId: DOC_ID,
        draftName: BASELINE,
        name: "A. Chen",
        nextBaselineNumber: 3,
      }),
      /is not in the current draft/
    );
  });
});

test("rejects a name that matches neither declared role", async () => {
  await withDocument({ owner: "A. Chen", reviewer: "M. Osei" }, async (sign, draftPath) => {
    await assert.rejects(() => sign("R. Fontaine"), /doesn't match DOC-1's declared Owner/);
    assert.deepEqual(signoffStatus(DRAFT, DOC_ID), {});
    assert.match(await readDocumentXml(draftPath), /<w:t>Draft<\/w:t>/);
  });
});

test("refuses while tracked changes are still unresolved", async () => {
  const pending =
    `<w:p><w:ins w:id="1" w:author="A. Chen" w:date="2026-09-15T00:00:00Z">` +
    `<w:r><w:t>Added</w:t></w:r></w:ins></w:p>`;

  await withDocument(
    { owner: "A. Chen", reviewer: "M. Osei" },
    async sign => {
      await assert.rejects(() => sign("A. Chen"), /still has unresolved tracked changes/);
      assert.deepEqual(signoffStatus(DRAFT, DOC_ID), {});
    },
    pending
  );
});

test("reports recorded approvals through signoffStatus", async () => {
  await withDocument({ owner: "A. Chen", reviewer: "M. Osei" }, async sign => {
    await sign("M. Osei");
    const state = signoffStatus(DRAFT, DOC_ID);

    assert.equal(state.owner, undefined);
    assert.equal(state.reviewer?.name, "M. Osei");
  });
});
