import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";

// Redirect the signoff store before applyChange.js loads it, so the real log file is untouched.
const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "signoff-store-"));
process.env.MCP_CONFIG_LOGSPACE = storeDir;

const { applyChange } = await import("./applyChange.js");
const { readSignoffState, writeSignoffState } = await import("./signoffStore.js");

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const DRAFT = "draft-test";
const DOC_ID = "DOC-1";

async function createDocument(filePath: string, status: string, signoffDate = "2026-09-15"): Promise<void> {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<w:document xmlns:w="${W_NS}"><w:body>` +
      `<w:tbl><w:tr>` +
        `<w:tc><w:p><w:r><w:t>Status</w:t></w:r></w:p></w:tc>` +
        `<w:tc><w:p><w:r><w:t>${status}</w:t></w:r></w:p></w:tc>` +
      `</w:tr><w:tr>` +
        `<w:tc><w:p><w:r><w:t>Signoff Date</w:t></w:r></w:p></w:tc>` +
        `<w:tc><w:p><w:r><w:t>${signoffDate}</w:t></w:r></w:p></w:tc>` +
      `</w:tr></w:tbl>` +
      `<w:p><w:r><w:t>Original</w:t></w:r></w:p>` +
    `</w:body></w:document>`
  );
  fs.writeFileSync(filePath, await zip.generateAsync({ type: "nodebuffer" }));
}

async function readDocumentXml(filePath: string): Promise<string> {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  return zip.file("word/document.xml")!.async("string");
}

async function readMetadataTable(filePath: string): Promise<string> {
  return (await readDocumentXml(filePath)).match(/<w:tbl>.*?<\/w:tbl>/s)![0];
}

async function withDocument(status: string, body: (filePath: string) => Promise<void>): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "apply-change-"));
  try {
    const filePath = path.join(tempDir, "doc.docx");
    await createDocument(filePath, status);
    await body(filePath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

const edit = (filePath: string, oldText: string, newText: string) =>
  applyChange(filePath, oldText, newText, { author: "Owner", docId: DOC_ID, draftName: DRAFT });

test.after(() => fs.rmSync(storeDir, { recursive: true, force: true }));

test("reverts an approval matching the latest baseline to Draft", async () => {
  await withDocument("Approved (Baseline 2)", async filePath => {
    const result = await edit(filePath, "Original", "Proposal");
    const table = await readMetadataTable(filePath);

    assert.deepEqual(result, { statusChanged: true });
    assert.match(table, /<w:t xml:space="preserve">Draft<\/w:t>/);
    assert.match(table, /<w:t xml:space="preserve">TBD<\/w:t>/);
    // The metadata revert is a plain edit — only the paragraph proposal is tracked.
    assert.doesNotMatch(table, /<w:(ins|del)[ >]/);
  });
});

test("reverts an approval naming an older baseline too", async () => {
  await withDocument("Approved (Baseline 1)", async filePath => {
    const result = await edit(filePath, "Original", "Proposal");
    const table = await readMetadataTable(filePath);

    assert.deepEqual(result, { statusChanged: true });
    assert.doesNotMatch(table, /Approved \(Baseline 1\)/);
    assert.match(table, /<w:t xml:space="preserve">Draft<\/w:t>/);
  });
});

test("reverts a partially approved document", async () => {
  await withDocument("Partially Approved", async filePath => {
    const result = await edit(filePath, "Original", "Proposal");

    assert.deepEqual(result, { statusChanged: true });
    assert.match(await readMetadataTable(filePath), /<w:t xml:space="preserve">Draft<\/w:t>/);
  });
});

test("leaves an already-Draft document's metadata untouched", async () => {
  await withDocument("Draft", async filePath => {
    const result = await edit(filePath, "Original", "Proposal");
    const table = await readMetadataTable(filePath);

    assert.deepEqual(result, { statusChanged: false });
    assert.match(table, /<w:t>Draft<\/w:t>/);
    assert.match(table, /<w:t>2026-09-15<\/w:t>/);
  });
});

test("does not revert twice when revising a pending proposal", async () => {
  await withDocument("Approved (Baseline 2)", async filePath => {
    await edit(filePath, "Original", "Proposal");
    const result = await edit(filePath, "Original", "Revised proposal");
    const xml = await readDocumentXml(filePath);

    assert.deepEqual(result, { statusChanged: false });
    assert.equal((xml.match(/<w:t xml:space="preserve">Draft<\/w:t>/g) ?? []).length, 1);
    assert.equal((xml.match(/<w:t xml:space="preserve">TBD<\/w:t>/g) ?? []).length, 1);
    assert.match(xml, /Revised proposal/);
  });
});

test("clears the recorded signoff when it reverts an approval", async () => {
  await withDocument("Approved (Baseline 2)", async filePath => {
    writeSignoffState(DRAFT, DOC_ID, { owner: { name: "Owner", at: "2026-09-15T00:00:00.000Z" } });

    await edit(filePath, "Original", "Proposal");

    assert.deepEqual(readSignoffState(DRAFT, DOC_ID), {});
  });
});