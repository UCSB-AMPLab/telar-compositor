/**
 * python-html-tokens — a panel's HTML read as the framework's glossary pass
 * reads it (`_PanelHTML`, scripts/telar/glossary.py): by the tokenizer of
 * Python's `html.parser.HTMLParser` with `convert_charrefs` off, fed the
 * whole text and closed, after each `&` is replaced by a space. A character
 * reference never starts or ends a tag, and how the tokenizer reads a
 * malformed one (`&#`, `&#5a`) differs between Python versions and moves the
 * positions it reports; the blanking keeps the length, so every offset still
 * indexes the original text, and the same tags are read in every version.
 *
 * It gives two kinds of stretch, as `[start, end)` offsets:
 *
 *   - `anchors`, the content of each `<a>` element. A tag inside a comment,
 *     another tag's attribute or text-only content is not a tag, and one
 *     whose offsets `skip` holds is not one either. An element ends at its
 *     `</a>` or where the next `<a>` opens, `<a/>` opens one, and one never
 *     closed runs to the end of the text.
 *   - `rawTexts`, the content of each element the tokenizer reads as text
 *     only (`script`, `style`, `xmp`, `iframe`, `noembed`, `noframes`,
 *     `textarea`, `title`), to its closing tag or the end of the text.
 *
 * The tokenizer's rules, as `goahead` applies them once the text is closed:
 * `<` and a letter begins a start tag, which runs to the `>` its expression
 * finds, quoted values included, or, with none, swallows the rest of the
 * text; `</` and a letter an end tag, the same; `</>` is nothing and `</`
 * before anything else a bogus comment to the next `>`; `<!--` a comment to
 * `-->` or `--!>`, or at once to `>` or `->`; `<?` an instruction to the next
 * `>`; `<![CDATA[` to `]]>`; `<!doctype` and any other `<!` to the next `>`.
 * An unclosed comment, instruction or declaration swallows the rest of the
 * text. A start tag whose leftover text is not `>` or `/>` is text. An
 * `&#` whose digits are followed by a hexadecimal letter, such as `&#5a`,
 * swallows the rest of the text, as the closed parser reads it; any other
 * `&#` that begins no reference is text. After a text-only element's start
 * tag only its own end tag is read, and after `<plaintext>` nothing.
 *
 * Tag names are compared in lower case; the names compared are ASCII, where
 * `toLowerCase` and Python's `str.lower` agree. Offsets are UTF-16 code units
 * where Python's are code points.
 *
 * @version v1.5.0-beta
 */

import type { Region } from "~/lib/glossary-links";
import { pythonStrip } from "~/lib/python-whitespace";

/** `HTMLParser.CDATA_CONTENT_ELEMENTS` and `RCDATA_CONTENT_ELEMENTS`, in CPython 3.14. */
const RAWTEXT_ELEMENTS = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes"]);
const RCDATA_ELEMENTS = new Set(["textarea", "title"]);

// The tokenizer's own expressions (html/parser.py).
const STARTTAG_OPEN = /<[a-zA-Z]/y;
const ENDTAG_OPEN = /<\/[a-zA-Z]/y;
const INTERESTING = /</g;
const COMMENT_CLOSE = /--!?>/g;
const COMMENT_ABRUPT_CLOSE = /-?>/y;
const TAGFIND = /([a-zA-Z][^\t\n\r\f />]*)(?:[\t\n\r\f ]|\/(?!>))*/y;
const ATTRFIND =
  /((?<=['"\t\n\r\f /])[^\t\n\r\f />][^\t\n\r\f /=>]*)([\t\n\r\f ]*=[\t\n\r\f ]*('[^']*'|"[^"]*"|(?!['"])[^>\t\n\r\f ]*))?(?:[\t\n\r\f ]|\/(?!>))*/y;
const LOCATE_TAG_END =
  /[a-zA-Z][^\t\n\r\f />]*[\t\n\r\f /]*(?:(?<=['"\t\n\r\f /])[^\t\n\r\f />][^\t\n\r\f /=>]*(?:[\t\n\r\f ]*=[\t\n\r\f ]*(?:'[^']*'|"[^"]*"|(?!['"])[^>\t\n\r\f ]*))?[\t\n\r\f /]*)*>?/y;

/** What the tokenizer finds in a panel's HTML. */
export interface PanelHtmlReading {
  anchors: Region[];
  rawTexts: Region[];
}

/** Where a sticky `pattern` matching at `i` ends, or -1. */
function endAt(pattern: RegExp, text: string, i: number): number {
  pattern.lastIndex = i;
  return pattern.test(text) ? pattern.lastIndex : -1;
}

/** Where the first match of a global `pattern` at or after `i` starts and ends, or null. */
function firstMatchFrom(pattern: RegExp, text: string, i: number): [number, number] | null {
  pattern.lastIndex = i;
  const match = pattern.exec(text);
  return match ? [match.index, match.index + match[0].length] : null;
}

/** Past the `>` at or after `from`, or -1. */
function pastGt(text: string, from: number): number {
  const gt = text.indexOf(">", from);
  return gt === -1 ? -1 : gt + 1;
}

class PanelTokens {
  readonly anchors: Region[] = [];
  readonly rawTexts: Region[] = [];
  /** Where the open `<a>` element's content starts. */
  private content: number | null = null;
  /** The text-only element open, and where its content starts. */
  private rawText: { tag: string; start: number } | null = null;
  /** What ends the text-only content being read: its closing tag, or nothing, after `<plaintext>`. */
  private interesting: RegExp | null = INTERESTING;

  constructor(
    private readonly text: string,
    private readonly skip: (start: number, end: number) => boolean,
  ) {}

  read(): PanelHtmlReading {
    let i: number | null = 0;
    while (i !== null && i < this.text.length) i = this.step(i);
    const n = this.text.length;
    if (this.content !== null) this.anchors.push([this.content, n]);
    if (this.rawText !== null) this.rawTexts.push([this.rawText.start, n]);
    return { anchors: this.anchors, rawTexts: this.rawTexts };
  }

  /** Past the next markup at or after `i`; null when the rest is text. */
  private step(i: number): number | null {
    const found = this.interesting && firstMatchFrom(this.interesting, this.text, i);
    return found ? this.markup(found[0]) : null;
  }

  /** Past the markup at `i`; an unfinished construct runs to the end of the text. */
  private markup(i: number): number {
    const text = this.text;
    let k: number;
    if (endAt(STARTTAG_OPEN, text, i) !== -1) k = this.startTag(i);
    else if (text.startsWith("</", i)) k = this.endTag(i);
    else if (text.startsWith("<!--", i)) k = this.comment(i);
    else if (text.startsWith("<?", i)) k = pastGt(text, i + 2);
    else if (text.startsWith("<!", i)) k = this.declaration(i);
    else k = i + 1;
    return k < 0 ? text.length : k;
  }

  private comment(i: number): number {
    const close = firstMatchFrom(COMMENT_CLOSE, this.text, i + 4);
    return close ? close[1] : endAt(COMMENT_ABRUPT_CLOSE, this.text, i + 4);
  }

  private declaration(i: number): number {
    const text = this.text;
    if (text.startsWith("<![CDATA[", i)) {
      const close = text.indexOf("]]>", i + 9);
      return close === -1 ? -1 : close + 3;
    }
    if (text.slice(i, i + 9).toLowerCase() === "<!doctype") return pastGt(text, i + 9);
    return pastGt(text, i + 2);
  }

  /** `parse_starttag`: past the tag, or -1 when it is never closed. */
  private startTag(i: number): number {
    const text = this.text;
    const endpos = endAt(LOCATE_TAG_END, text, i + 1);
    if (text[endpos - 1] !== ">") return -1;
    TAGFIND.lastIndex = i + 1;
    const tag = TAGFIND.exec(text)![1].toLowerCase();
    let k = TAGFIND.lastIndex;
    while (k < endpos) {
      const next = endAt(ATTRFIND, text, k);
      if (next === -1) break;
      k = next;
    }
    const rest = pythonStrip(text.slice(k, endpos));
    if (rest === "/>") this.startEndTag(tag, i, endpos);
    else if (rest === ">") this.startTagRead(tag, i, endpos);
    return endpos;
  }

  /** `parse_endtag`: past the tag, or -1 when it is never closed. */
  private endTag(i: number): number {
    const text = this.text;
    if (text.indexOf(">", i + 2) < 0) return -1;
    if (endAt(ENDTAG_OPEN, text, i) === -1) return text[i + 2] === ">" ? i + 3 : pastGt(text, i + 2);
    const end = endAt(LOCATE_TAG_END, text, i + 2);
    if (text[end - 1] !== ">") return -1;
    TAGFIND.lastIndex = i + 2;
    this.endTagRead(TAGFIND.exec(text)![1].toLowerCase(), i);
    this.interesting = INTERESTING;
    return end;
  }

  private startTagRead(tag: string, start: number, end: number): void {
    if (RAWTEXT_ELEMENTS.has(tag) || RCDATA_ELEMENTS.has(tag)) {
      this.rawText = { tag, start: end };
      this.interesting = new RegExp(`</${tag}(?=[\\t\\n\\r\\f />])`, "gi");
    } else if (tag === "plaintext") {
      this.interesting = null;
    } else if (tag === "a") {
      this.openAnchor(start, end);
    }
  }

  private startEndTag(tag: string, start: number, end: number): void {
    if (tag === "a") this.openAnchor(start, end);
  }

  private openAnchor(start: number, end: number): void {
    if (this.skip(start, end)) return;
    if (this.content !== null) this.anchors.push([this.content, start]);
    this.content = end;
  }

  private endTagRead(tag: string, start: number): void {
    if (this.rawText !== null && tag === this.rawText.tag) {
      this.rawTexts.push([this.rawText.start, start]);
      this.rawText = null;
    } else if (tag === "a" && this.content !== null && !this.skip(start, start + 1)) {
      this.anchors.push([this.content, start]);
      this.content = null;
    }
  }
}

/**
 * The content of each `<a>` element and of each text-only element in `text`,
 * as `_PanelHTML` reads them, with each `&` read as a space; an `<a>` tag whose
 * offsets `skip` holds opens and closes nothing.
 */
export function panelHtmlReading(text: string, skip: (start: number, end: number) => boolean): PanelHtmlReading {
  return new PanelTokens(text.replaceAll("&", " "), skip).read();
}
