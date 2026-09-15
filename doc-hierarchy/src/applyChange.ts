import fs from "node:fs";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import xpath from "xpath";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const select = xpath.useNamespaces({ w: W_NS });
const APPROVED_BASELINE_STATUS = /^Approved \(Baseline (\d+)\)$/;

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function visibleText(paragraph: Node): string {
  return (select(".//w:t", paragraph) as Node[]).map(n => n.textContent ?? "").join("");
}

function deletedText(paragraph: Node): string {
  return (select(".//w:delText", paragraph) as Node[]).map(n => n.textContent ?? "").join("");
}

function isParagraphInsertion(paragraph: Node): boolean {
  return (select("./w:pPr/w:rPr/w:ins", paragraph) as Node[]).length > 0;
}

function isParagraphDeletion(paragraph: Node): boolean {
  return (select("./w:pPr/w:rPr/w:del", paragraph) as Node[]).length > 0;
}

function nextRevisionId(doc: Document): number {
  const ids = (select("//w:ins/@w:id | //w:del/@w:id", doc) as Attr[])
    .map(a => Number(a.value))
    .filter(n => Number.isFinite(n));
  return (ids.length ? Math.max(...ids) : 0) + 1;
}

function parseFragment(xml: string): Node {
  return new DOMParser().parseFromString(xml, "text/xml").documentElement!;
}

function replaceCellTextAsTrackedChange(
  doc: Document,
  cell: Node,
  newText: string,
  author: string,
  date: string
): void {
  const oldText = (select(".//w:t", cell) as Node[]).map(n => n.textContent ?? "").join("");
  (select(".//w:r", cell) as Node[]).forEach(r => r.parentNode?.removeChild(r));
  const paragraph = (select(".//w:p", cell) as Node[])[0];
  const delId = nextRevisionId(doc);
  const delNode = parseFragment(
    `<w:del xmlns:w="${W_NS}" w:id="${delId}" w:author="${xmlEscape(author)}" w:date="${date}">` +
    `<w:r><w:delText xml:space="preserve">${xmlEscape(oldText)}</w:delText></w:r></w:del>`
  );
  const insNode = parseFragment(
    `<w:ins xmlns:w="${W_NS}" w:id="${delId + 1}" w:author="${xmlEscape(author)}" w:date="${date}">` +
    `<w:r><w:t xml:space="preserve">${xmlEscape(newText)}</w:t></w:r></w:ins>`
  );
  paragraph.appendChild(doc.importNode(delNode, true));
  paragraph.appendChild(doc.importNode(insNode, true));
}

function updateStatusIfApproved(
  doc: Document,
  latestBaselineName: string,
  author: string,
  date: string
): boolean {
  const latestNumber = latestBaselineName.match(/-(\d+)$/)?.[1];
  if (!latestNumber) return false;

  const rows = select("//w:tbl/w:tr", doc) as Node[];
  for (const row of rows) {
    const cells = select("./w:tc", row) as Node[];
    if (cells.length < 2) continue;

    const label = (select(".//w:t", cells[0]) as Node[])
      .map(n => n.textContent ?? "")
      .join("")
      .trim();
    if (label !== "Status") continue;

    const value = (select(".//w:t", cells[1]) as Node[])
      .map(n => n.textContent ?? "")
      .join("")
      .trim();
    const match = value.match(APPROVED_BASELINE_STATUS);
    if (match && match[1] === latestNumber) {
      replaceCellTextAsTrackedChange(doc, cells[1], "Draft", author, date);
      for (const signoffRow of rows) {
        const signoffCells = select("./w:tc", signoffRow) as Node[];
        if (signoffCells.length < 2) continue;

        const signoffLabel = (select(".//w:t", signoffCells[0]) as Node[])
          .map(n => n.textContent ?? "")
          .join("")
          .trim();
        if (signoffLabel === "Signoff Date") {
          replaceCellTextAsTrackedChange(doc, signoffCells[1], "TBD", author, date);
          break;
        }
      }
      return true;
    }
    return false;
  }
  return false;
}

/**
 * Replace the paragraph whose current text is exactly `oldText` with `newText`,
 * as a native Word tracked change. If `oldText` matches a paragraph this function
 * already turned into a pending proposal (an unreviewed <w:ins> paragraph whose
 * preceding <w:del> holds `oldText`), the pending proposal's text is revised in
 * place instead of stacking a second tracked change.
 */
export async function applyChange(
  filePath: string,
  oldText: string,
  newText: string,
  author: string,
  latestBaselineName: string
): Promise<{ statusChanged: boolean }> {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const docXmlPath = "word/document.xml";
  const xml = await zip.file(docXmlPath)!.async("string");
  const doc = new DOMParser().parseFromString(xml, "text/xml");

  const paragraphs = select("//w:body/w:p", doc) as Node[];

  const freshMatches = paragraphs.filter(p =>
    !isParagraphInsertion(p) && !isParagraphDeletion(p) && visibleText(p) === oldText
  );

  const pendingMatches: { del: Node; ins: Node }[] = [];
  paragraphs.forEach((p, i) => {
    if (isParagraphDeletion(p) && deletedText(p) === oldText) {
      const next = paragraphs[i + 1];
      if (next && isParagraphInsertion(next)) pendingMatches.push({ del: p, ins: next });
    }
  });

  const total = freshMatches.length + pendingMatches.length;
  if (total === 0) {
    throw new Error(
      `No paragraph matching the given text was found in ${filePath}. It may already have a ` +
      `different proposal pending, or the text doesn't match exactly.`
    );
  }
  if (total > 1) {
    throw new Error(
      `The given text matches more than one paragraph in ${filePath} — use a longer, unique excerpt.`
    );
  }

  const date = new Date().toISOString();

  if (pendingMatches.length === 1) {
    const { ins } = pendingMatches[0];
    (select(".//w:r", ins) as Node[]).forEach(r => r.parentNode?.removeChild(r));
    const runNode = parseFragment(
      `<w:r xmlns:w="${W_NS}"><w:t xml:space="preserve">${xmlEscape(newText)}</w:t></w:r>`
    );
    ins.appendChild(doc.importNode(runNode, true));
  } else {
    const original = freshMatches[0];
    const delId = nextRevisionId(doc);

    const newPPr = parseFragment(
      `<w:pPr xmlns:w="${W_NS}"><w:rPr><w:del w:id="${delId}" w:author="${xmlEscape(author)}" w:date="${date}"/></w:rPr></w:pPr>`
    );
    const existingPPr = (select("./w:pPr", original) as Node[])[0];
    if (existingPPr) original.replaceChild(doc.importNode(newPPr, true), existingPPr);
    else original.insertBefore(doc.importNode(newPPr, true), original.firstChild);

    (select(".//w:r", original) as Node[]).forEach(r => {
      const text = (select(".//w:t", r) as Node[]).map(n => n.textContent ?? "").join("");
      const delRun = parseFragment(
        `<w:del xmlns:w="${W_NS}" w:id="${nextRevisionId(doc)}" w:author="${xmlEscape(author)}" w:date="${date}">` +
        `<w:r><w:delText xml:space="preserve">${xmlEscape(text)}</w:delText></w:r></w:del>`
      );
      r.parentNode?.replaceChild(doc.importNode(delRun, true), r);
    });

    const insId = nextRevisionId(doc);
    const insPara = parseFragment(
      `<w:p xmlns:w="${W_NS}">` +
      `<w:pPr><w:rPr><w:ins w:id="${insId}" w:author="${xmlEscape(author)}" w:date="${date}"/></w:rPr></w:pPr>` +
      `<w:ins w:id="${insId + 1}" w:author="${xmlEscape(author)}" w:date="${date}">` +
      `<w:r><w:t xml:space="preserve">${xmlEscape(newText)}</w:t></w:r></w:ins>` +
      `</w:p>`
    );
    original.parentNode!.insertBefore(doc.importNode(insPara, true), original.nextSibling);
  }

  const statusChanged = updateStatusIfApproved(doc, latestBaselineName, author, date);

  const updatedXml = new XMLSerializer().serializeToString(doc);
  zip.file(docXmlPath, updatedXml);
  fs.writeFileSync(filePath, await zip.generateAsync({ type: "nodebuffer" }));
  return { statusChanged };
}
