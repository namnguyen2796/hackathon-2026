import mammoth from "mammoth";
import { diffLines } from "diff";

export async function detectChange(baselinePath: string, draftPath: string): Promise<string | null> {
  const [{ value: oldText }, { value: newText }] = await Promise.all([
    mammoth.extractRawText({ path: baselinePath }),
    mammoth.extractRawText({ path: draftPath }),
  ]);
  if (oldText === newText) return null;

  return diffLines(oldText, newText)
    .filter((p) => p.added || p.removed)
    .map((p) => `${p.added ? "+ " : "- "}${p.value.trim()}`)
    .join("\n");
}
