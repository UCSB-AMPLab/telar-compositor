/**
 * A page's front matter as its file holds it, and the one edit the Compositor
 * makes to it: the title.
 *
 * The block is kept as text, not as parsed data, because the framework reads
 * keys the Compositor does not model (`localized_for`, `language`,
 * `title_key`, whatever it adds later), and the author's comments, key order
 * and line endings are part of the file. `splitFrontmatterBlock` and
 * `fenceFrontmatter` are the one definition of where the block starts and
 * ends, used by the import that stores it and by the publish that writes it,
 * so a block read back from a file this module wrote is the block it wrote.
 *
 * @version v1.5.0-beta
 */

import { escapeYamlString } from "~/lib/knap-filters.server";
import { reducePageFiles } from "~/lib/one-language-pages";
import { parseYamlFailsafe, sameYamlValue, yamlMappingOf, isYamlMapping, type YamlMapping } from "~/lib/yaml.server";

/**
 * A leading `---` block and the body after it.
 *
 * The block is everything between the two `---` markers: whatever follows the
 * opening marker on its line, that line's newline, the lines inside, and the
 * newline before the closing marker. So it is never empty when a file has
 * fences — adjacent fences (`---\n---\n`) hold `"\n"` — and its own newlines
 * say which line ending the fences were written with. The closing marker is a
 * line of its own, trailing spaces allowed, and the match is lazy, so a block
 * never contains such a line.
 *
 * A byte-order mark before the opening fence is not recognised here; the
 * repository reads drop it before a file reaches this pattern, so a rewritten
 * page is written without one.
 */
export const FRONTMATTER_BLOCK = /^---([ \t]*\r?\n(?:[\s\S]*?\r?\n)?)---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

/** The block between a file's fence markers and the body after them, or null when it has none. */
export function splitFrontmatterBlock(content: string): { block: string; body: string } | null {
  const match = content.match(FRONTMATTER_BLOCK);
  return match ? { block: match[1], body: match[2] ?? "" } : null;
}

/**
 * The front matter a page stores: the block exactly as the file has it, or
 * `""` for a file with none. NULL, a page never captured, is not produced
 * here.
 */
export function capturedFrontmatter(content: string): string {
  return splitFrontmatterBlock(content)?.block ?? "";
}

/** The line ending of the block's last line, which is the newline before its closing fence. */
export function frontmatterLineEnding(block: string): "\r\n" | "\n" {
  return block.endsWith("\r\n") ? "\r\n" : "\n";
}

/**
 * The block between its fence markers, the closing fence's own newline
 * included. Trailing spaces after the closing marker are not kept.
 */
export function fenceFrontmatter(block: string): string {
  return `---${block}---${frontmatterLineEnding(block)}`;
}

/**
 * Page files, by path, reduced to one file per page for a site in
 * `siteLanguage` (`reducePageFiles`): each file whose text the reduction
 * changed, with its new text and the path of the file it is taken from, and
 * each file it removes.
 */
export function reducedPageFileChanges(
  contents: ReadonlyMap<string, string>,
  siteLanguage: unknown,
): { writes: Array<{ path: string; content: string; from: string }>; deletions: string[] } {
  const files = [...contents].map(([path, content]) => {
    const split = splitFrontmatterBlock(content);
    return { path, name: path.split("/").pop()!, frontmatter: split?.block ?? "", body: split ? split.body : content };
  });
  const { kept, removed } = reducePageFiles(files, siteLanguage);
  const writes = kept
    .filter((page) => page.source !== page.file)
    .map((page) => ({ path: page.file.path, content: fenceFrontmatter(page.frontmatter) + page.body, from: page.source.path }));
  return { writes, deletions: removed.map((file) => file.path) };
}

// ---------------------------------------------------------------------------
// Writing the title into a kept block
// ---------------------------------------------------------------------------

/**
 * A top-level `title` key: at column 0, bare or quoted, with the colon
 * followed by a space, a tab or the end of the line, as YAML requires.
 * An indented `title:` belongs to a nested mapping and is not matched.
 */
const TITLE_KEY = /^((?:title|"title"|'title')[ \t]*:)(?=[ \t]|$)([ \t]*)(.*)$/;

type Mapping = YamlMapping;
type Line = { text: string; eol: string };

/** What a kept block becomes when a page is written with `title`. */
export type FrontmatterWrite =
  /** The block to write between the fences. */
  | { kind: "block"; block: string }
  /** The block does not parse to a mapping: the page is written with its title alone. */
  | { kind: "title-alone" }
  /** No edit passes its check: the page cannot be written without changing another key. */
  | { kind: "unwritable" };

/** The block's title as the file spells it, under the failsafe schema, if it has one. */
function spelledTitle(block: string): unknown {
  try {
    const doc = parseYamlFailsafe(block);
    return isYamlMapping(doc) ? doc.title : undefined;
  } catch {
    return undefined;
  }
}

/** The mapping's keys other than `title`, in order. */
function otherKeys(mapping: Mapping): string[] {
  return Object.keys(mapping).filter((k) => k !== "title");
}

/**
 * The check every rewritten block passes before it is written: parsed with the
 * same schema as the original, it is a mapping whose title is the new one and
 * whose other keys are the original's, in the same order, with equal values.
 * Anything thrown on the way is a failed check.
 */
function keepsEveryOtherKey(edited: string, original: Mapping, title: string): boolean {
  try {
    const reparsed = yamlMappingOf(edited);
    if (reparsed === null || reparsed.title !== title) return false;
    const keys = otherKeys(original);
    const reparsedKeys = otherKeys(reparsed);
    const seen = new Map<object, Set<object>>();
    return reparsedKeys.length === keys.length &&
      keys.every((k, i) => reparsedKeys[i] === k && sameYamlValue(reparsed[k], original[k], seen));
  } catch {
    return false;
  }
}

/**
 * Where the value on a title line ends and a trailing comment begins.
 *
 * A `#` after whitespace starts a comment in a plain scalar but can sit inside
 * a quoted one, so each candidate is tried against the parser: the first
 * prefix that parses to the same title as the whole line is the value.
 */
function valueLength(value: string): number {
  const whole = spelledTitle(`title: ${value}`);
  for (let i = value.indexOf("#"); i > 0; i = value.indexOf("#", i + 1)) {
    if (!/[ \t]/.test(value[i - 1])) continue;
    const prefix = value.slice(0, i).trimEnd();
    if (spelledTitle(`title: ${prefix}`) === whole) return prefix.length;
  }
  return value.trimEnd().length;
}

/** A block's lines, each with its own line ending (the last may have none). */
function linesOf(block: string): Line[] {
  return block.split(/(?<=\n)/).map((line) => {
    const eol = line.match(/\r?\n$/)?.[0] ?? "";
    return { text: line.slice(0, line.length - eol.length), eol };
  });
}

const joinLines = (lines: Line[]): string => lines.map((line) => line.text + line.eol).join("");

/** The index of the one top-level title line, or -1 when there is none or more than one. */
function titleLineIndex(lines: Line[]): number {
  const matches = lines.flatMap((line, i) => (TITLE_KEY.test(line.text) ? [i] : []));
  return matches.length === 1 ? matches[0] : -1;
}

/** True for a line that belongs to the entry above it: indented, or blank. */
const continuesEntry = (line: Line): boolean => line.text.trim() === "" || /^[ \t]/.test(line.text);

/**
 * The end (exclusive) of the entry starting at `start`: its key line and every
 * following line that does not start at column 0, less the blank lines at its
 * end, which sit between entries rather than inside this one.
 */
function entryEnd(lines: Line[], start: number): number {
  let end = start + 1;
  while (end < lines.length && continuesEntry(lines[end])) end += 1;
  while (end > start + 1 && lines[end - 1].text.trim() === "") end -= 1;
  return end;
}

/**
 * Edit (a): only the value of a one-line top-level title replaced. Everything
 * else on the line — the key's spelling, the space after the colon, a
 * trailing comment, the line ending — is kept. Null when the title is not one
 * line.
 */
function replaceTitleLine(block: string, title: string): string | null {
  const lines = linesOf(block);
  const index = titleLineIndex(lines);
  if (index === -1) return null;
  const [, key, gap, value] = lines[index].text.match(TITLE_KEY)!;
  if (/^[|>#]/.test(value) || entryEnd(lines, index) !== index + 1) return null;
  const tail = value.slice(valueLength(value));
  lines[index].text = `${key}${gap || " "}${escapeYamlString(title)}${tail}`;
  return joinLines(lines);
}

/**
 * Edit (b): the title's whole entry — its key line and the lines under it —
 * replaced by one `title:` line in the same place, ending as the entry's last
 * line ended. Every byte outside the entry is kept. Null when there is not
 * exactly one top-level title line.
 */
function replaceTitleEntry(block: string, title: string): string | null {
  const lines = linesOf(block);
  const index = titleLineIndex(lines);
  if (index === -1) return null;
  const end = entryEnd(lines, index);
  const line = { text: `title: ${escapeYamlString(title)}`, eol: lines[end - 1].eol };
  return joinLines([...lines.slice(0, index), line, ...lines.slice(end)]);
}

/**
 * A title line put after the opening fence's own line, which is the block's
 * first line and holds nothing but the fence's trailing whitespace.
 */
function prependTitle(block: string, title: string): string {
  const cut = block.indexOf("\n") + 1;
  return `${block.slice(0, cut)}title: ${escapeYamlString(title)}${frontmatterLineEnding(block)}${block.slice(cut)}`;
}

/** The edits to try, in order, for a block that does or does not hold a title. */
function candidateEdits(block: string, title: string, hasTitle: boolean): Array<string | null> {
  if (!hasTitle) return [prependTitle(block, title)];
  return [replaceTitleLine(block, title), replaceTitleEntry(block, title)];
}

/**
 * What a page's kept block becomes when the page is written with `title`.
 *
 *   - A title the block already holds leaves it byte for byte. A block
 *     holding no title already reads as `untitled` (the slug, as the import
 *     reads it), so that title leaves it too.
 *   - A block that does not parse to a mapping gives `title-alone`: the
 *     framework cannot read it either.
 *   - A block with no top-level title has a title line put first.
 *   - Otherwise (a) the one-line title's value is replaced, and failing that
 *     (b) the title's whole entry is replaced by one line.
 *   - Each edit must re-parse to the new title with every other key, and
 *     their order, unchanged. When none does, the answer is `unwritable`, and
 *     the page is not written.
 */
export function writePageFrontmatter(block: string, title: string, untitled?: string): FrontmatterWrite {
  const mapping = yamlMappingOf(block);
  if (mapping === null) return { kind: "title-alone" };
  const hasTitle = Object.hasOwn(mapping, "title");
  const current = hasTitle ? mapping.title : untitled;
  if (current === title || (hasTitle && spelledTitle(block) === title)) return { kind: "block", block };
  const edited = candidateEdits(block, title, hasTitle)
    .find((edit) => edit !== null && keepsEveryOtherKey(edit, mapping, title));
  return edited ? { kind: "block", block: edited } : { kind: "unwritable" };
}
