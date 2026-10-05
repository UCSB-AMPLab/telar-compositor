/**
 * The site's Markdown glossary files, read for the upgrade's answer list.
 * A site with no glossary.csv has its glossary pages from
 * `telar-content/texts/glossary/*.md` (`site_glossary_pages`,
 * scripts/telar/glossary_pages.py), and a glossary link in an answer counts as
 * its term's title from there.
 *
 * What the framework does (`_markdown_terms`, `_markdown_pages`), and so what
 * this does: the files directly in the folder named `*.md`, in file-name
 * order; a file whose front matter does not match `FRONTMATTER_PATTERN` or
 * holds no `term_id:\s*(\S+)` is not a term; of ids that share an address
 * (`first_at_each_address`) the first file keeps it; a term's title is the
 * front matter's `title`, else its id. A file starting with a byte-order mark
 * has no front matter, as the framework reads it.
 *
 * @version v1.5.0-beta
 */

import { readFrontmatterTitle } from "~/lib/import.server";
import { glossaryTermUrl } from "~/lib/glossary-links";
import { compilePythonPattern } from "~/lib/python-regex";
import type { TreeEntry } from "~/lib/github.server";
import { UpgradeFileUnreadableError } from "~/lib/upgrade-reads.server";

export const GLOSSARY_FILES_DIR = "telar-content/texts/glossary";

/** One Markdown glossary file as read at the head. */
export interface GlossaryFile {
  name: string;
  text: string;
}

const FRONT_MATTER = String.raw`^---\s*\n(.*?)\n---\s*\n(.*)$`;
const TERM_ID = String.raw`term_id:\s*(\S+)`;

/**
 * Python's string order, by code point: the framework sorts the file names so,
 * and the first file to claim an address keeps it. JavaScript's default sort
 * compares UTF-16 code units, which orders a name past U+FFFF differently.
 */
function byCodePoint(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** A regular file directly in the glossary folder named `*.md`. */
function isGlossaryFileEntry(entry: TreeEntry): boolean {
  const prefix = `${GLOSSARY_FILES_DIR}/`;
  if (entry.type !== "blob" || !entry.path.startsWith(prefix)) return false;
  const name = entry.path.slice(prefix.length);
  return name.endsWith(".md") && !name.includes("/");
}

/**
 * The glossary folder's `*.md` files at the head, in file-name order: listed
 * from the tree, or from a listing of the folder when the tree was answered
 * truncated. A listing or read that fails stops prepare, naming the path.
 */
export async function readGlossaryFiles(
  tree: readonly TreeEntry[],
  truncated: boolean,
  listDirectory: (dir: string) => Promise<TreeEntry[]>,
  readRaw: (path: string) => Promise<string | null>,
): Promise<GlossaryFile[]> {
  let source = tree;
  if (truncated) {
    try {
      source = await listDirectory(GLOSSARY_FILES_DIR);
    } catch {
      throw new UpgradeFileUnreadableError(GLOSSARY_FILES_DIR);
    }
  }
  const paths = source.filter(isGlossaryFileEntry).map((entry) => entry.path).sort(byCodePoint);
  const files: GlossaryFile[] = [];
  for (const path of paths) {
    const text = await readRaw(path);
    if (text !== null) files.push({ name: path.slice(GLOSSARY_FILES_DIR.length + 1), text });
  }
  return files;
}

/** The term id and title a file gives, or null when the framework reads no term from it. */
function termOf(text: string): { id: string; title: string } | null {
  const match = compilePythonPattern(FRONT_MATTER, "s").exec(text);
  if (!match) return null;
  const id = compilePythonPattern(TERM_ID, "").exec(match[1])?.[1];
  if (!id) return null;
  const title = readFrontmatterTitle(`---\n${match[1]}\n---\n`).title;
  return { id, title: title || id };
}

/** Term id to title for the files that become pages, in file order, the first file keeping an address. */
export function markdownGlossaryTerms(files: readonly GlossaryFile[]): Map<string, string> {
  const terms = new Map<string, string>();
  const held = new Set<string>();
  for (const file of files) {
    const term = termOf(file.text);
    if (!term) continue;
    const address = glossaryTermUrl(term.id, "");
    if (held.has(address)) continue;
    held.add(address);
    terms.set(term.id, term.title);
  }
  return terms;
}
