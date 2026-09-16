import mammoth from "mammoth";

export type DocMetadata = {
  docId: string;
  owner: string;
  reviewer: string;
  dependsOn: string[];
  status: string;
  signoffDate: string;
};

// Every doc starts with a Field | Value table: Document ID, Title, Owner,
// Reviewer, Depends On, Signoff Date, Status.
export function parseMetadata(html: string): DocMetadata {
  const rows = [...html.matchAll(/<tr>(.*?)<\/tr>/gs)].map(m =>
    [...m[1].matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map(c => c[1].replace(/<[^>]+>/g, "").trim())
  );
  const map = Object.fromEntries(rows.map(([k, v]) => [k, v]));

  const required = ["Document ID", "Owner", "Reviewer", "Depends On", "Status"] as const;
  const missing = required.filter(f => map[f] === undefined);
  if (missing.length) {
    throw new Error(`Metadata table missing field(s): ${missing.join(", ")}`);
  }

  return {
    docId: map["Document ID"],
    owner: map["Owner"],
    reviewer: map["Reviewer"],
    dependsOn: map["Depends On"] === "—" ? [] : map["Depends On"].split(",").map(s => s.trim()),
    status: map["Status"],
    signoffDate: map["Signoff Date"] ?? "—",
  };
}

export async function readDocMetadata(filePath: string): Promise<DocMetadata> {
  const { value: html } = await mammoth.convertToHtml({ path: filePath });
  return parseMetadata(html);
}
