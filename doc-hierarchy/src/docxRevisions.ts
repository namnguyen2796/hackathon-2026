import fs from "node:fs";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import xpath from "xpath";

export const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const select = xpath.useNamespaces({ w: W_NS });

export function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function parseFragment(xml: string): Node {
  return new DOMParser().parseFromString(xml, "text/xml").documentElement!;
}

function joinText(nodes: Node[]): string {
  return nodes.map(n => n.textContent ?? "").join("");
}

export function visibleText(paragraph: Node): string {
  return joinText(select(".//w:t", paragraph) as Node[]);
}

export function deletedText(paragraph: Node): string {
  return joinText(select(".//w:delText", paragraph) as Node[]);
}

export function isParagraphInsertion(paragraph: Node): boolean {
  return (select("./w:pPr/w:rPr/w:ins", paragraph) as Node[]).length > 0;
}

export function isParagraphDeletion(paragraph: Node): boolean {
  return (select("./w:pPr/w:rPr/w:del", paragraph) as Node[]).length > 0;
}

export function nextRevisionId(doc: Document): number {
  const ids = (select("//w:ins/@w:id | //w:del/@w:id", doc) as Attr[])
    .map(a => Number(a.value))
    .filter(n => Number.isFinite(n));
  return (ids.length ? Math.max(...ids) : 0) + 1;
}

/** True if the document still has tracked-change markup anywhere in it. */
export function hasPendingRevisions(doc: Document): boolean {
  return (select("//w:ins | //w:del", doc) as Node[]).length > 0;
}

/** Find a metadata-table row by its label cell (e.g. "Status"), returning its value cell. */
export function findTableRow(doc: Document, label: string): Node | undefined {
  for (const row of select("//w:tbl/w:tr", doc) as Node[]) {
    const cells = select("./w:tc", row) as Node[];
    if (cells.length < 2) continue;
    if (joinText(select(".//w:t", cells[0]) as Node[]).trim() === label) return cells[1];
  }
  return undefined;
}

export function cellText(cell: Node): string {
  return joinText(select(".//w:t", cell) as Node[]).trim();
}

/** Replace a metadata cell's text with a single fresh, untracked run. */
export function replaceCellText(doc: Document, cell: Node, newText: string): void {
  (select(".//w:r", cell) as Node[]).forEach(r => r.parentNode?.removeChild(r));
  const paragraph = (select(".//w:p", cell) as Node[])[0];
  const runNode = parseFragment(
    `<w:r xmlns:w="${W_NS}"><w:t xml:space="preserve">${xmlEscape(newText)}</w:t></w:r>`
  );
  paragraph.appendChild(doc.importNode(runNode, true));
}

export async function loadDocxDocument(filePath: string) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const docXmlPath = "word/document.xml";
  const xml = await zip.file(docXmlPath)!.async("string");
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  return { zip, doc, docXmlPath };
}

export async function saveDocxDocument(
  filePath: string,
  zip: JSZip,
  doc: Document,
  docXmlPath: string
): Promise<void> {
  zip.file(docXmlPath, new XMLSerializer().serializeToString(doc));
  fs.writeFileSync(filePath, await zip.generateAsync({ type: "nodebuffer" }));
}
