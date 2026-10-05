/**
 * The manifest's `yaml_list_add` operation: values added to a top-level list
 * in a YAML file, the text edited in place and never re-serialised, so every
 * comment, key order, blank line and line ending the file has survives.
 *
 * A port of the framework's command-line route (`add_exclude_entries` and
 * its helpers in `scripts/migrations/v180_sources.py`), without its comment
 * blocks: the manifest carries values without groups, so the result has the
 * same parsed value as that route's, not the same bytes. The shapes, from the
 * framework's `docs/migration-manifest.md`:
 *
 *   - an absent key is written as a block list at the end of the first
 *     document, before any `...` or `---` line that ends it, at the
 *     indentation of the other top-level keys;
 *   - a key present with no value (`exclude:`, which parses as null) keeps its
 *     line, and the values go under it as block items; a null written out
 *     (`exclude: ~`, `exclude: null`) is dropped from the line first;
 *   - a block list gets each missing value as a new line after its last item,
 *     at the items' own indentation and dash style;
 *   - a flow list gets them before its closing bracket, comma-separated;
 *   - a single value (a scalar) becomes the first item of a block list under
 *     the key line, which keeps its comment, and the values follow it; it is
 *     rewritten even when it already is every value, since Jekyll refuses an
 *     `exclude` that is not a list;
 *   - a mapping under the key throws, refused as "mapping", since only its
 *     author can say what list it stands for; an absent file, one that does
 *     not parse as a mapping, and any shape or result the edit does not make
 *     throw as "other".
 *
 * The key edited is the top-level one wherever Jekyll's reader finds it, as
 * the framework's route finds it: after a BOM or a `---` line, at
 * the indentation of a mapping indented as a whole, plain or quoted (a quoted
 * key counts once its escapes are decoded), with or without spaces before its
 * colon, which the key line keeps as written. A key nested under another is
 * not it. Only the first document is read and edited, as Jekyll reads only
 * that one; what follows it is kept byte for byte. Items under a key with none
 * go two spaces past the key's indentation.
 *
 * A value is present when the list holds the same string after YAML parsing,
 * with one trailing slash dropped from both sides and nothing else
 * normalised. The edit is accepted only when the result re-parses, the list
 * is what the key held (its items, or its single value) followed by exactly
 * the missing values, and every other key parses to what it did before;
 * otherwise the operation throws.
 *
 * @version v1.5.0-beta
 */

import type { YamlListAddOp } from "~/lib/manifest-schema.server";
import { load } from "js-yaml";
import { isYamlMapping, sameYamlValue, yamlMappingOf, type YamlMapping } from "~/lib/yaml.server";

/**
 * Why a `yaml_list_add` was refused: the key holds a mapping, which only its
 * author can turn into a list, or anything else (an absent or unparseable
 * file, a shape or a result the edit does not make).
 */
export type YamlListAddRefusal = "mapping" | "other";

/**
 * A `yaml_list_add` that could not be applied. It names the file, the key and
 * the values that were to be added, and why, which the upgrade reports to the
 * author.
 */
export class YamlListAddError extends Error {
  constructor(
    readonly kind: YamlListAddRefusal,
    readonly file: string,
    readonly key: string,
    readonly values: string[],
    reason: string,
  ) {
    super(`yaml_list_add could not add ${values.join(", ")} to ${key} in ${file}: ${reason}`);
    this.name = "YamlListAddError";
  }
}

/** A key the file does not have, told apart from one it holds as null. */
const ABSENT = Symbol("absent");

/** A line and its ending, where only CR, LF and CRLF end a line. */
const LINE = /[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g;

function splitKeepingEnds(text: string): string[] {
  return text.match(LINE) ?? [];
}

/** A line without its line ending. */
function withoutEnding(line: string): string {
  return line.replace(/(?:\r\n|\r|\n)$/, "");
}

function newlineOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** `lines` with a line ending on the last line, if it had none. */
function withFinalEnding(lines: string[], newline: string): string[] {
  const last = lines.length - 1;
  if (last >= 0 && !/[\r\n]$/.test(lines[last])) lines[last] += newline;
  return lines;
}

/** A single value: what YAML parses a scalar to, a timestamp included. */
function isYamlScalar(value: unknown): boolean {
  if (value === null || value === undefined || typeof value === "symbol") return false;
  return typeof value !== "object" || value instanceof Date;
}

/** The items a key holds: a list's own, a single value as one, or none. */
function itemsHeldBy(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return isYamlScalar(value) ? [value] : [];
}

/** The form two values are compared in: a string loses one trailing slash. */
function comparedForm(value: unknown): unknown {
  return typeof value === "string" && value.endsWith("/") ? value.slice(0, -1) : value;
}

/** The values not already in the list `current` holds, in the order given. */
function missingValues(current: unknown, values: string[]): string[] {
  const listed = itemsHeldBy(current);
  const present = new Set(listed.filter((v) => typeof v === "string").map(comparedForm));
  return values.filter((value) => !present.has(comparedForm(value)));
}

const BOM = "\uFEFF";

/** A line that starts or ends a document. */
const DOCUMENT_MARKER = /^(?:---|\.\.\.)(?:[ \t].*)?$/;

/** A line's text with the BOM the file's first line may carry dropped. */
function lineTextWithoutBom(lines: string[], index: number): string {
  const body = withoutEnding(lines[index]);
  return index === 0 && body.startsWith(BOM) ? body.slice(1) : body;
}

/**
 * `text` split where its first document ends, the only one Jekyll reads: at a
 * `...` line, or at a `---` line after content or after another `---`. The
 * second part is empty for a file of one document.
 */
function firstDocument(text: string): [string, string] {
  let started = false;
  let content = false;
  let offset = 0;
  const lines = splitKeepingEnds(text);
  for (let index = 0; index < lines.length; index++) {
    const body = lineTextWithoutBom(lines, index);
    const stripped = body.trim();
    if (DOCUMENT_MARKER.test(body)) {
      if (body.startsWith("...") || content || started) return [text.slice(0, offset), text.slice(offset)];
      started = true;
      const after = body.slice(3).trim();
      content = after !== "" && !after.startsWith("#");
    } else if (stripped && !stripped.startsWith("#") && !body.startsWith("%")) {
      content = true;
    }
    offset += lines[index].length;
  }
  return [text, ""];
}

/**
 * The indentation of the top-level keys: that of the first line holding
 * content, after a BOM, or null for text with none. Blank lines, comments,
 * directives and a `---` line hold none.
 */
function documentIndent(lines: string[]): string | null {
  for (let index = 0; index < lines.length; index++) {
    const body = lineTextWithoutBom(lines, index);
    const stripped = body.trim();
    if (!stripped || stripped.startsWith("#") || body.startsWith("%") || /^---(?:\s+#.*)?\s*$/.test(body)) continue;
    return body.slice(0, body.length - body.trimStart().length);
  }
  return null;
}

/**
 * A key that may be `key`: plain, or a quoted scalar, with spaces or tabs
 * before the colon. A quoted one is `key` only when it reads as that once its
 * escapes are decoded. A quote inside a quoted key, escaped or doubled,
 * decodes to a quote, so the pattern need not span one for a key without one.
 */
function keyPattern(key: string): RegExp {
  const plain = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(${plain}|"[^"]*"|'[^']*')[ \\t]*:`);
}

function readsAs(written: string, key: string): boolean {
  if (written === key) return true;
  if (!written.startsWith('"') && !written.startsWith("'")) return false;
  try {
    return load(written) === key;
  } catch {
    return false;
  }
}

/** The line that opens a key: see `keyLine`. */
interface KeyLine {
  index: number;
  head: string;
  indent: string;
  rest: string;
}

/**
 * The index of the last line that opens `key` at the top level, the line up
 * to and including its colon (any BOM, the indentation, the key and the
 * spaces before the colon, as written), the indentation, and the text after
 * the colon. The top level is the indentation of the first line holding
 * content; the last such line, because the last of two duplicate keys is the
 * one YAML keeps.
 */
function keyLine(lines: string[], key: string): KeyLine | null {
  const indent = documentIndent(lines);
  if (indent === null) return null;
  const opener = keyPattern(key);
  for (let index = lines.length - 1; index >= 0; index--) {
    const body = lineTextWithoutBom(lines, index);
    if (!body.startsWith(indent)) continue;
    const match = opener.exec(body.slice(indent.length));
    if (!match || !readsAs(match[1], key)) continue;
    const bom = withoutEnding(lines[index]).length > body.length ? BOM : "";
    return { index, head: bom + indent + match[0], indent, rest: body.slice(indent.length + match[0].length).trim() };
  }
  return null;
}

/**
 * Where to append to the block list opened at `start`, and the indentation
 * and dash its items use (two spaces past the key's indentation and "- " for
 * a list with no items). A
 * more indented line after an item continues it; comments and blank lines
 * after the last item stay after the values added.
 */
function blockInsertion(lines: string[], start: number, keyIndent: string): { at: number; prefix: string } {
  let at = start + 1;
  let indent: string | null = null;
  let dash = "- ";
  for (let index = start + 1; index < lines.length; index++) {
    const body = withoutEnding(lines[index]);
    const stripped = body.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    const lead = body.slice(0, body.length - body.trimStart().length);
    const item = /^- +/.exec(stripped);
    if (item && (indent === null || lead === indent)) {
      [indent, dash, at] = [lead, item[0], index + 1];
    } else if (indent !== null && lead.length > indent.length) {
      at = index + 1;
    } else {
      break;
    }
  }
  return { at, prefix: (indent ?? `${keyIndent}  `) + dash };
}

function intoBlock(text: string, line: KeyLine, missing: string[]): string {
  const lines = splitKeepingEnds(text);
  const newline = newlineOf(text);
  const { at, prefix } = blockInsertion(lines, line.index, line.indent);
  if (at === lines.length) withFinalEnding(lines, newline);
  lines.splice(at, 0, ...missing.map((value) => `${prefix}${value}${newline}`));
  return lines.join("");
}

/** Whether a comment starts at `index`: a `#` at a line's start or after whitespace. */
function isCommentStart(text: string, index: number): boolean {
  return text[index] === "#" && (index === 0 || /\s/.test(text[index - 1]));
}

/** Where a comment starts on one line, outside quotes, or -1. */
function commentStart(body: string): number {
  let quote: string | null = null;
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (`'"`.includes(char)) {
      quote = char;
    } else if (isCommentStart(body, index)) {
      return index;
    }
  }
  return -1;
}

/** The index of the line ending at or after `index`, or the text's length. */
function lineEndFrom(text: string, index: number): number {
  const found = text.slice(index).search(/[\r\n]/);
  return found < 0 ? text.length : index + found;
}

/** The index of the `]` closing the flow sequence opened at `opening`; comments are skipped. */
function closingBracket(text: string, opening: number): number | null {
  let depth = 0;
  let quote: string | null = null;
  for (let index = opening; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (`'"`.includes(char)) {
      quote = char;
    } else if (isCommentStart(text, index)) {
      index = lineEndFrom(text, index) - 1;
    } else if ("[{".includes(char)) {
      depth++;
    } else if ("]}".includes(char) && --depth === 0) {
      return char === "]" ? index : null;
    }
  }
  return null;
}

/** The start of the line holding `index`. */
function lineStartOf(text: string, index: number): number {
  return Math.max(text.lastIndexOf("\n", index - 1), text.lastIndexOf("\r", index - 1)) + 1;
}

/**
 * `text` with `missing` on a line of their own before a `]` that has its own
 * line, where the last item's line ends in a comment. The last item gains a
 * comma before its comment, if it has none; the new line takes that item's
 * indentation.
 */
function beforeOwnLineBracket(text: string, bracketLine: number, missing: string[]): string {
  const lines = splitKeepingEnds(text.slice(0, bracketLine));
  let index = lines.length - 1;
  while (index > 0 && /^\s*(?:#.*)?$/.test(withoutEnding(lines[index]))) index--;
  const body = withoutEnding(lines[index]);
  const cut = commentStart(body);
  const code = (cut < 0 ? body : body.slice(0, cut)).trimEnd();
  const opensList = code.endsWith("[");
  if (!opensList && !code.endsWith(",")) {
    lines[index] = `${code},${lines[index].slice(code.length)}`;
  }
  const lead = /^\s*/.exec(opensList ? text.slice(bracketLine) : body)![0] + (opensList ? "  " : "");
  return `${lines.join("")}${lead}${missing.join(", ")}${newlineOf(text)}${text.slice(bracketLine)}`;
}

/** `text` with `missing` inserted before the closing bracket of the flow sequence on line `start`. */
function intoFlow(text: string, start: number, missing: string[]): string | null {
  const offset = splitKeepingEnds(text).slice(0, start).join("").length;
  const opening = text.indexOf("[", offset);
  const closing = closingBracket(text, opening);
  if (closing === null) return null;
  const last = text.slice(0, closing).trimEnd().length;
  const lastLine = lineStartOf(text, last);
  if (commentStart(text.slice(lastLine, last)) >= 0) {
    const bracketLine = lineStartOf(text, closing);
    return text.slice(bracketLine, closing).trim() === "" && bracketLine > opening
      ? beforeOwnLineBracket(text, bracketLine, missing)
      : null;
  }
  const inner = text.slice(opening + 1, last).trim();
  const lead = !inner ? "" : inner.endsWith(",") ? " " : ", ";
  return text.slice(0, last) + lead + missing.join(", ") + text.slice(last);
}

/**
 * `text` with `key` added at its end as a block list of `missing`, after a
 * blank line, at the indentation of the other top-level keys, its items two
 * spaces past it.
 */
function withNewKey(text: string, key: string, missing: string[]): string {
  const newline = newlineOf(text);
  const lines = withFinalEnding(splitKeepingEnds(text), newline);
  const indent = documentIndent(lines) ?? "";
  if (lines.length > 0) lines.push(newline);
  return [...lines, `${indent}${key}:${newline}`, ...missing.map((value) => `${indent}  - ${value}${newline}`)].join("");
}

/**
 * Where a quoted scalar at the start of `rest` ends (the index after its
 * closing quote), or 0 for a plain scalar. A double-quoted scalar escapes with
 * a backslash, a single-quoted one by doubling the quote.
 */
function quotedEnd(rest: string): number {
  const quote = rest[0];
  if (quote !== '"' && quote !== "'") return 0;
  for (let index = 1; index < rest.length; index++) {
    const char = rest[index];
    if (quote === '"' && char === "\\") {
      index++;
    } else if (char === quote && quote === "'" && rest[index + 1] === "'") {
      index++;
    } else if (char === quote) {
      return index + 1;
    }
  }
  return rest.length;
}

/** The value written after a key's colon, and the comment that follows it, if any. */
function splitComment(rest: string): { value: string; comment: string } {
  const from = quotedEnd(rest);
  const match = /(^|\s)#/.exec(rest.slice(from));
  if (!match) return { value: rest, comment: "" };
  const at = from + match.index;
  return { value: rest.slice(0, at).trimEnd(), comment: rest.slice(at).trim() };
}

/**
 * How many lines after `start` continue it: ones indented past its key, and
 * blank or comment lines between them. Counting stops at the last such line
 * that is not a comment, so a comment after the value stays in the file.
 */
function continuationCount(lines: string[], start: number, keyIndent: string): number {
  let count = 0;
  for (let index = start + 1; index < lines.length; index++) {
    const body = withoutEnding(lines[index]);
    if (body.trim() === "") continue;
    if (body.length - body.trimStart().length <= keyIndent.length) break;
    if (!body.trim().startsWith("#")) count = index - start;
  }
  return count;
}

/**
 * `text` with the single value under the key on `line` rewritten as the first
 * item of a block list, the key line keeping its comment. A value written on
 * the key line alone keeps its text as the item. A value continued onto
 * further lines is written double-quoted, as JSON writes a string, in place of
 * those lines; one that is not a string is not rewritten.
 */
function scalarAsBlock(
  text: string,
  key: string,
  line: KeyLine,
  current: unknown,
): string | null {
  const lines = splitKeepingEnds(text);
  const ending = lines[line.index].slice(withoutEnding(lines[line.index]).length) || newlineOf(text);
  const { value, comment } = splitComment(line.rest);
  const alone = sameYamlValue(yamlMappingOf(`${key}: ${line.rest}`)?.[key], current);
  if (!alone && typeof current !== "string") return null;
  const item = alone ? value : JSON.stringify(current);
  const replaced = alone ? 1 : 1 + continuationCount(lines, line.index, line.indent);
  const keyText = comment ? `${line.head} ${comment}` : line.head;
  lines.splice(line.index, replaced, `${keyText}${ending}`, `${line.indent}  - ${item}${ending}`);
  return lines.join("");
}

/** The plain scalars YAML reads as null; an empty value is one too. */
const NULL_TOKENS: ReadonlySet<string> = new Set(["", "~", "null", "Null", "NULL"]);

/**
 * `text` with `missing` as a block list under a key that holds null: a bare
 * key keeps its line, and a written null (`~`, `null`) is dropped from it,
 * its comment kept. Any other null (a tagged one) is not rewritten.
 */
function nullAsBlock(
  text: string,
  line: KeyLine,
  missing: string[],
): string | null {
  const { value, comment } = splitComment(line.rest);
  if (!NULL_TOKENS.has(value)) return null;
  if (value === "") return intoBlock(text, line, missing);
  const lines = splitKeepingEnds(text);
  const ending = lines[line.index].slice(withoutEnding(lines[line.index]).length);
  lines[line.index] = `${comment ? `${line.head} ${comment}` : line.head}${ending}`;
  return intoBlock(lines.join(""), line, missing);
}

/** `text` with `missing` added to `key` in the shape it is written in, or null when the shape is not one the edit makes. */
function withListValues(text: string, key: string, current: unknown, missing: string[]): string | null {
  if (current === ABSENT) return withNewKey(text, key, missing);
  const line = keyLine(splitKeepingEnds(text), key);
  if (line === null) return null;
  if (isYamlScalar(current)) {
    const rewritten = scalarAsBlock(text, key, line, current);
    return rewritten === null ? null : intoBlock(rewritten, line, missing);
  }
  if (current === null) return nullAsBlock(text, line, missing);
  if (line.rest.startsWith("[")) return intoFlow(text, line.index, missing);
  if (!line.rest || line.rest.startsWith("#")) return intoBlock(text, line, missing);
  return null;
}

function withoutKey(mapping: YamlMapping, key: string): YamlMapping {
  return Object.fromEntries(Object.entries(mapping).filter(([k]) => k !== key));
}

/**
 * The check an edit passes before it is kept, as the framework's
 * `_only_exclude_grew` makes it, and stricter: the result parses to a mapping
 * whose `key` is a list of what the key held before (its items, or its single
 * value) followed by exactly `missing`, and every other key parses to what it
 * did before.
 */
function onlyListGrew(before: string, after: string, key: string, missing: string[]): boolean {
  const old = yamlMappingOf(before);
  const next = yamlMappingOf(after);
  if (old === null || next === null) return false;
  const list = next[key];
  if (!Array.isArray(list)) return false;
  return sameYamlValue(list, [...itemsHeldBy(old[key]), ...missing]) &&
    sameYamlValue(withoutKey(old, key), withoutKey(next, key));
}

/**
 * Applies one `yaml_list_add` to the virtual filesystem. A file whose list
 * already holds every value is left untouched; one the operation cannot edit throws a
 * YamlListAddError naming the values it had to add.
 */
export function applyYamlListAdd(files: Map<string, string>, op: YamlListAddOp): void {
  const whole = files.get(op.file);
  if (whole === undefined) throw new YamlListAddError("other", op.file, op.key, op.values, "the file is absent");
  // Jekyll reads only the first document; the rest is kept as written.
  const [text, after] = firstDocument(whole);
  const mapping = yamlMappingOf(text);
  if (mapping === null) {
    throw new YamlListAddError("other", op.file, op.key, op.values, "the file does not parse as a YAML mapping");
  }
  const current = Object.hasOwn(mapping, op.key) ? mapping[op.key] : ABSENT;
  const missing = missingValues(current, op.values);
  // A single value is rewritten as a list even when it already covers every
  // value: Jekyll refuses an `exclude` that is not a list.
  if (missing.length === 0 && !isYamlScalar(current)) return;
  const editable = current === ABSENT || current === null || Array.isArray(current) || isYamlScalar(current);
  const updated = editable ? withListValues(text, op.key, current, missing) : null;
  if (isYamlMapping(current)) {
    throw new YamlListAddError("mapping", op.file, op.key, missing, "the key holds a mapping, not a list");
  }
  if (updated === null || !onlyListGrew(text, updated, op.key, missing)) {
    throw new YamlListAddError("other", op.file, op.key, missing, "the key is not written in a shape the edit can extend");
  }
  files.set(op.file, updated + after);
}
