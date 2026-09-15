import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { applyChange } from "./applyChange.js";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

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

test("tracks Draft and TBD proposals for approval metadata from the latest baseline", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "apply-change-"));
  const filePath = path.join(tempDir, "matching.docx");

  try {
    await createDocument(filePath, "Approved (Baseline 1)");
    const result = await applyChange(filePath, "Original", "Proposal", "Owner", "baseline-1");
    const xml = await readDocumentXml(filePath);

    assert.deepEqual(result, { statusChanged: true });
    assert.match(xml, /<w:del [^>]*w:author="Owner"[^>]*><w:r><w:delText xml:space="preserve">Approved \(Baseline 1\)<\/w:delText><\/w:r><\/w:del>/);
    assert.match(xml, /<w:ins [^>]*w:author="Owner"[^>]*><w:r><w:t xml:space="preserve">Draft<\/w:t><\/w:r><\/w:ins>/);
    assert.match(xml, /<w:del [^>]*w:author="Owner"[^>]*><w:r><w:delText xml:space="preserve">2026-09-15<\/w:delText><\/w:r><\/w:del>/);
    assert.match(xml, /<w:ins [^>]*w:author="Owner"[^>]*><w:r><w:t xml:space="preserve">TBD<\/w:t><\/w:r><\/w:ins>/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("leaves approval for an older baseline unchanged", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "apply-change-"));
  const filePath = path.join(tempDir, "stale.docx");

  try {
    await createDocument(filePath, "Approved (Baseline 1)");
    const result = await applyChange(filePath, "Original", "Proposal", "Owner", "baseline-2");
    const xml = await readDocumentXml(filePath);

    assert.deepEqual(result, { statusChanged: false });
    assert.match(xml, /<w:t>Approved \(Baseline 1\)<\/w:t>/);
    assert.match(xml, /<w:t>2026-09-15<\/w:t>/);
    assert.doesNotMatch(xml, /<w:t xml:space="preserve">(?:Draft|TBD)<\/w:t>/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("does not change Draft again when revising a pending proposal", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "apply-change-"));
  const filePath = path.join(tempDir, "idempotent.docx");

  try {
    await createDocument(filePath, "Approved (Baseline 1)");
    await applyChange(filePath, "Original", "Proposal", "Owner", "baseline-1");
    const result = await applyChange(filePath, "Original", "Revised proposal", "Owner", "baseline-1");
    const xml = await readDocumentXml(filePath);

    assert.deepEqual(result, { statusChanged: false });
    assert.match(xml, /<w:t xml:space="preserve">Draft<\/w:t>/);
    assert.match(xml, /<w:t xml:space="preserve">TBD<\/w:t>/);
    assert.equal((xml.match(/<w:delText xml:space="preserve">Approved \(Baseline 1\)<\/w:delText>/g) ?? []).length, 1);
    assert.equal((xml.match(/<w:delText xml:space="preserve">2026-09-15<\/w:delText>/g) ?? []).length, 1);
    assert.match(xml, /Revised proposal/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});