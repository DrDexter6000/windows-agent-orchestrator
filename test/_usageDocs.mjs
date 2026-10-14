// The usage manual is docs/usage.md (the page map) plus one page per task under docs/usage/.
// Checks written against the manual as a whole read it through here; checks on one page read that page.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const USAGE_MAP = "docs/usage.md";
export const USAGE_PAGES_DIR = "docs/usage";

/** File names of the pages under docs/usage/, sorted. */
export function usagePageFiles(root) {
  return readdirSync(join(root, USAGE_PAGES_DIR)).filter((name) => name.endsWith(".md")).sort();
}

/** The map followed by every page, joined with a blank line. */
export function readUsageDocs(root) {
  return [USAGE_MAP, ...usagePageFiles(root).map((name) => `${USAGE_PAGES_DIR}/${name}`)]
    .map((rel) => readFileSync(join(root, rel), "utf8"))
    .join("\n");
}
