// Test-only. Builds a docx minimal enough for mammoth to open: content types, a package
// relationship pointing at the main part, and the part itself.
import fs from "node:fs";
import JSZip from "jszip";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const row = (label: string, value: string) =>
  `<w:tr><w:tc><w:p><w:r><w:t>${label}</w:t></w:r></w:p></w:tc>` +
  `<w:tc><w:p><w:r><w:t>${value}</w:t></w:r></w:p></w:tc></w:tr>`;

export async function createFixtureDocx(
  filePath: string,
  fields: Record<string, string>,
  body = `<w:p><w:r><w:t>Body</w:t></w:r></w:p>`
): Promise<void> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `</Types>`
  );
  zip.file(
    "_rels/.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`
  );
  zip.file(
    "word/document.xml",
    `<w:document xmlns:w="${W_NS}"><w:body><w:tbl>` +
      Object.entries(fields).map(([k, v]) => row(k, v)).join("") +
    `</w:tbl>${body}</w:body></w:document>`
  );
  fs.writeFileSync(filePath, await zip.generateAsync({ type: "nodebuffer" }));
}

export function metadataFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "Document ID": "DOC-1",
    Owner: "A. Chen",
    Reviewer: "M. Osei",
    "Depends On": "—",
    "Signoff Date": "TBD",
    Status: "Draft",
    ...overrides,
  };
}
