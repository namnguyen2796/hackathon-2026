import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolved against this file, not process.cwd(), so scripts run from any directory.
export const packageRoot = fileURLToPath(new URL("..", import.meta.url));

export function getCurrentBaselineDir(): string {
  const name = fs.readFileSync(path.join(packageRoot, "current-baseline.txt"), "utf-8").trim();
  return path.join(packageRoot, "docs", name);
}