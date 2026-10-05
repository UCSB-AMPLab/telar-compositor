/**
 * Text that names an object's files, rewritten when a rename moves them.
 *
 * A rename cannot tell from text which object an author meant; it can tell
 * which file an address resolves to, so only the forms the framework resolves
 * to a moved file are rewritten:
 *
 * - a Markdown image whose address is exactly a moved file's name, which the
 *   framework always resolves under `telar-content/objects/` (block images
 *   and images inside a line alike, scripts/telar/images.py `process_images`
 *   and `_resolve_inline_images`);
 * - a carousel `image:` value that is exactly a moved file's name, unless
 *   `assets/images` holds a file the framework would take for that name first
 *   (`BARE_IMAGE_FOLDERS`, `locate_image`);
 * - an absolute tile address in either place beginning with the old tile
 *   prefix, `<site url><baseurl>/iiif/objects/<old site id>/`, rewritten by
 *   prefix.
 *
 * Every other form is left and counted, so the author can be told: a case
 * variant or folder form of a moved name, a raw HTML `<img>` naming one, and
 * a link to the old object page.
 *
 * The rules are plain data so a rename record can carry them to the document
 * half, which applies the same edits to a Y.Text at their offsets. Offsets
 * are UTF-16 code units, the unit both JavaScript strings and Y.Text count in.
 * Nothing here reaches the network or the database.
 *
 * @version v1.5.0-beta
 */

import { pythonStrip } from "~/lib/python-whitespace";

/** What a rename's text rewrites follow. */
export interface FileReferenceRules {
  /** Flat file names in telar-content/objects the rename moves, each with its new name. */
  moved: ReadonlyArray<{ from: string; to: string }>;
  /** Moved names a bare carousel value never reaches, because `assets/images` answers it first. */
  carouselShadowed: readonly string[];
  /** The old tile prefix and its replacement, both ending `/`; null with no site address. */
  tiles: { from: string; to: string } | null;
  /** The object's old site id, which names its old page `/objects/<id>/`. */
  oldSiteId: string;
}

/** Rules that rewrite nothing: a rename inside a collision leaves every reference as it is. */
export function noFileReferenceRules(oldSiteId: string): FileReferenceRules {
  return { moved: [], carouselShadowed: [], tiles: null, oldSiteId };
}

/** One replacement in a text, at an offset into the text as it stood before any of them. */
export interface TextEdit {
  offset: number;
  length: number;
  insert: string;
}

/** The edits that rewrite a text's references, in order, and how many references were left. */
export interface FileReferenceEdits {
  edits: TextEdit[];
  left: number;
}

/**
 * An inline Markdown image, as the framework matches it: the opening up to the
 * address, the address (no space, no `)`), and an optional quoted title.
 * Python's `\s` and JavaScript's differ only beyond ASCII, where an address
 * holds no such character.
 */
const MARKDOWN_IMAGE = /(!\[(?:[^[\]]|\[[^[\]]*\])*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g;

/**
 * A widget block, as the framework finds one (`:::type ... :::`, matched with
 * DOTALL and the type lowercased, scripts/telar/widgets.py
 * `process_widgets`).
 */
const WIDGET_BLOCK = /:::(\w+)\s*\n([\s\S]*?)\n:::/g;

/** What closes a widget block's body. */
const CLOSING_FENCE = "\n:::";

/** A raw HTML image's `src`, quoted either way. */
const HTML_IMAGE_SRC = /<img\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1/gi;

/** The name `rules` moves `name` to, or null when it moves no file of that exact name. */
function movedName(rules: FileReferenceRules, name: string): string | null {
  return rules.moved.find((entry) => entry.from === name)?.to ?? null;
}

/**
 * The new address for an image address or carousel value, or null when it is
 * not one the rename rewrites. `blocked` lists the moved names that do not
 * count as moved in this form.
 */
function rewrittenAddress(address: string, rules: FileReferenceRules, blocked: readonly string[]): string | null {
  if (rules.tiles && address.startsWith(rules.tiles.from)) {
    return rules.tiles.to + address.slice(rules.tiles.from.length);
  }
  return blocked.includes(address) ? null : movedName(rules, address);
}

/**
 * True for an address that names a moved file or the object's old folder in a
 * form the rename does not rewrite: another letter case, or a path whose last
 * segment is a moved name or which opens with the old site id's folder.
 */
function namesMovedFileOtherwise(address: string, rules: FileReferenceRules): boolean {
  const lower = address.toLowerCase();
  const last = lower.slice(lower.lastIndexOf("/") + 1);
  if (rules.moved.some((entry) => entry.from.toLowerCase() === last)) return true;
  return rules.oldSiteId !== "" && lower.startsWith(`${rules.oldSiteId.toLowerCase()}/`);
}

/** The edits for the Markdown images of one line starting at `lineStart`. */
function markdownImageEdits(line: string, lineStart: number, rules: FileReferenceRules, out: FileReferenceEdits): void {
  for (const match of line.matchAll(MARKDOWN_IMAGE)) {
    const address = match[2];
    const next = rewrittenAddress(address, rules, []);
    if (next !== null) {
      out.edits.push({ offset: lineStart + (match.index ?? 0) + match[1].length, length: address.length, insert: next });
    } else if (namesMovedFileOtherwise(address, rules)) {
      out.left += 1;
    }
  }
}

/**
 * The edits for the `image:` values of one carousel body starting at
 * `bodyStart`, read as `parse_key_value_block` reads them: each line stripped,
 * split at its first `:`, a line opening `#` passed over, key and value
 * stripped.
 */
function carouselEdits(body: string, bodyStart: number, rules: FileReferenceRules, out: FileReferenceEdits): void {
  let lineStart = 0;
  for (const line of body.split("\n")) {
    const colon = line.indexOf(":");
    const isImage = colon !== -1 && !pythonStrip(line).startsWith("#") && pythonStrip(line.slice(0, colon)) === "image";
    const value = isImage ? pythonStrip(line.slice(colon + 1)) : "";
    if (value !== "") {
      const next = rewrittenAddress(value, rules, rules.carouselShadowed);
      const at = bodyStart + lineStart + line.indexOf(value, colon + 1);
      if (next !== null) out.edits.push({ offset: at, length: value.length, insert: next });
      else if (!rules.carouselShadowed.includes(value) && namesMovedFileOtherwise(value, rules)) out.left += 1;
    }
    lineStart += line.length + 1;
  }
}

/** How many raw HTML images and old object-page links in `text` name what moved; none is rewritten. */
function otherReferences(text: string, rules: FileReferenceRules): number {
  let count = 0;
  for (const match of text.matchAll(HTML_IMAGE_SRC)) {
    const src = match[2];
    if ((rules.tiles && src.startsWith(rules.tiles.from)) || namesMovedFileOtherwise(src, rules)) count += 1;
  }
  if (rules.oldSiteId !== "") {
    const page = `/objects/${rules.oldSiteId}/`;
    for (let at = text.indexOf(page); at !== -1; at = text.indexOf(page, at + 1)) {
      if (!text.slice(0, at).endsWith("/iiif")) count += 1;
    }
  }
  return count;
}

/**
 * The edits that rewrite `text`'s references to moved files, ascending by
 * offset and never overlapping, and how many references it leaves. Carousel
 * bodies are read as carousels and not as Markdown, as the framework replaces
 * widget blocks before it resolves images.
 */
export function fileReferenceEdits(text: string, rules: FileReferenceRules): FileReferenceEdits {
  const out: FileReferenceEdits = { edits: [], left: otherReferences(text, rules) };
  const widgets: { start: number; end: number }[] = [];
  for (const match of text.matchAll(WIDGET_BLOCK)) {
    const start = match.index ?? 0;
    widgets.push({ start, end: start + match[0].length });
    const bodyStart = start + match[0].length - CLOSING_FENCE.length - match[2].length;
    if (match[1].toLowerCase() === "carousel") carouselEdits(match[2], bodyStart, rules, out);
  }

  let lineStart = 0;
  for (const line of text.split("\n")) {
    const insideWidget = widgets.some((w) => lineStart >= w.start && lineStart < w.end);
    if (!insideWidget) markdownImageEdits(line, lineStart, rules, out);
    lineStart += line.length + 1;
  }
  out.edits.sort((a, b) => a.offset - b.offset);
  return out;
}

/** `text` with `edits` applied; each edit's offset is into the original text. */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  let result = "";
  let kept = 0;
  for (const edit of edits) {
    result += text.slice(kept, edit.offset) + edit.insert;
    kept = edit.offset + edit.length;
  }
  return result + text.slice(kept);
}

/** `text` with its references to moved files rewritten. */
export function rewriteFileReferences(text: string, rules: FileReferenceRules): string {
  return applyTextEdits(text, fileReferenceEdits(text, rules).edits);
}

/** The path from the site root an object's file is kept at, with or without a leading `/`. */
const OBJECT_FILE_PATH = /^(\/?telar-content\/objects\/)([^/]+)$/;

/**
 * The renamed object's own thumbnail rewritten, or null to leave it: an old
 * tile address by prefix, or a moved file's path from the site root,
 * `telar-content/objects/<file>` with or without a leading `/`, as the object
 * grid renders a thumbnail through `relative_url`.
 */
export function rewriteThumbnail(value: string, rules: FileReferenceRules): string | null {
  if (rules.tiles && value.startsWith(rules.tiles.from)) return rules.tiles.to + value.slice(rules.tiles.from.length);
  const path = OBJECT_FILE_PATH.exec(value);
  const next = path ? movedName(rules, path[2]) : null;
  return path && next !== null ? path[1] + next : null;
}

/**
 * An imported audio object's `source_url` rewritten, or null to leave it: the
 * import stores the audio file's name there, so a value that is exactly a
 * moved file's name follows the file.
 */
export function rewriteAudioSource(value: string, rules: FileReferenceRules): string | null {
  return movedName(rules, value);
}
