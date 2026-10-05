/**
 * Raw HTML blocks as Python Markdown reads them, which is not how the
 * editor's CommonMark parser reads them.
 *
 * The framework converts a panel with `extra`, whose HTML block pass
 * (`markdown/htmlparser.py` and `extensions/md_in_html.py`) works on tags
 * alone. A block-level tag at the start of a line, indented by at most
 * three columns, opens a raw block that runs to its matching end tag,
 * however many blank lines lie between, and to the end of the text when
 * nothing closes it. CommonMark ends the same block at the first blank line.
 * A block-level tag carrying `markdown="1"` (or `block`, `span`, or no value)
 * is the exception: its tags are raw and the text between them is Markdown,
 * so footnotes work there; a plain block tag inside one is raw again, and a
 * `markdown="1"` tag inside a raw block is raw with it.
 *
 * `scanHtmlBlocks` returns the ranges that are not Markdown. Comments,
 * processing instructions and declarations are left to the syntax tree, as
 * are inline tags outside a raw block. Entities are treated as text. Tags are
 * read with the tolerant patterns of the library's HTML parser, less its
 * handling of stray quotes inside a tag.
 *
 * @version v1.5.0-beta
 */
import { PYTHON_WORD_CLASS_BODY } from "~/lib/python-word";
import { protectedSpans } from "./latex";

interface SourceRange {
  from: number;
  to: number;
}

export interface HtmlBlockRange extends SourceRange {
  /** The block has no end tag, so it runs to the end of the text. */
  unclosed?: true;
  /** A tag of a `markdown` container: raw itself, but the text around it is Markdown. */
  tag?: true;
  /**
   * The content of a `markdown="span"` container (or of one inside it): read
   * for inline Markdown only, so a reference in it works and a definition in
   * it is text. Not raw.
   */
  span?: true;
}

const BLOCK_LEVEL = new Set(
  (
    "address article aside blockquote details div dl fieldset figcaption figure footer form " +
    "h1 h2 h3 h4 h5 h6 header hgroup hr main menu nav ol p pre section table ul canvas colgroup " +
    "dd body dt group html iframe li legend math map noscript output object option progress " +
    "script style summary tbody td textarea tfoot th thead tr video center"
  ).split(" "),
);
const SPAN_TAGS = new Set(
  "address dd dt h1 h2 h3 h4 h5 h6 legend li p summary td th".split(" "),
);
const RAW_TAGS = new Set("canvas math option pre script style textarea".split(" "));
const EMPTY_TAGS = new Set(["hr"]);
const CDATA_TAGS = new Set(["script", "style"]);

type MarkdownState = "block" | "span" | "off";

const START_TAG = /<([a-zA-Z][^`\s/>]*)/y;
const ATTRIBUTE =
  /[\s/]*([^`\s/>][^\s/=>]*)(?:\s*=+\s*('[^']*'|"[^"]*"|(?!['"])[^`>\s]*))?/y;
const END_TAG = /<\/([a-zA-Z][^\s/>]*)[^>]*>/y;
/** The library's blank_line_re: two empty lines at the start of what follows. */
const BLANK_LINES = /^([ ]*\n){2}/;

interface StartTag {
  name: string;
  attributes: Map<string, string>;
  end: number;
  selfClosing: boolean;
}

function readStartTag(source: string, at: number): StartTag | null {
  START_TAG.lastIndex = at;
  const head = START_TAG.exec(source);
  if (!head) return null;
  const attributes = new Map<string, string>();
  let pos = at + head[0].length;
  for (;;) {
    ATTRIBUTE.lastIndex = pos;
    const attribute = ATTRIBUTE.exec(source);
    if (!attribute) break;
    let value = attribute[2] ?? attribute[1];
    if (attribute[2] !== undefined && /^(['"]).*\1$/s.test(value)) value = value.slice(1, -1);
    attributes.set(attribute[1].toLowerCase(), value);
    pos += attribute[0].length;
  }
  const rest = /^\s*(\/?)>/.exec(source.slice(pos));
  if (!rest) return null;
  return {
    name: head[1].toLowerCase(),
    attributes,
    end: pos + rest[0].length,
    selfClosing: rest[1] === "/",
  };
}

/**
 * The offset where the line holding `at` starts. `lastIndexOf` with a negative
 * start still tests index 0, so a text that begins with a newline needs the
 * guard: at 0 the answer is 0.
 */
export function lineStart(text: string, at: number): number {
  return at <= 0 ? 0 : text.lastIndexOf("\n", at - 1) + 1;
}

/** Whether the tag at `at` starts a line, after at most three columns of blank. */
function startsLine(source: string, at: number): boolean {
  const lineFrom = lineStart(source, at);
  let column = 0;
  for (const ch of source.slice(lineFrom, at)) {
    if (ch !== " " && ch !== "\t" && !/\s/.test(ch)) return false;
    column = ch === "\t" ? column + 4 - (column % 4) : column + 1;
  }
  return column <= 3;
}

interface Container {
  tag: string;
  state: MarkdownState;
  from: number;
  /** Where a span container's content starts. */
  contentFrom?: number;
  /** Where a plain block tag inside a container starts, since it is raw. */
  rawFrom: number | null;
  started: boolean;
}

/** The `markdown` attribute's value once a parent that is raw or span-only has overridden it. */
function markdownValue(
  attributes: Map<string, string>,
  parent: MarkdownState | null,
): string {
  let value = attributes.get("markdown") ?? "0";
  if (value === "markdown") value = "1";
  return parent === "off" || (parent === "span" && value !== "0") ? parent : value;
}

/** A tag that takes blocks but not span-only content, and is not raw or empty. */
function isPlainBlock(tag: string): boolean {
  return !SPAN_TAGS.has(tag) && !RAW_TAGS.has(tag) && !EMPTY_TAGS.has(tag);
}

function markdownState(
  tag: string,
  attributes: Map<string, string>,
  parent: MarkdownState | null,
): MarkdownState {
  const value = markdownValue(attributes, parent);
  const span = SPAN_TAGS.has(tag);
  const block = isPlainBlock(tag);
  const acceptsBlocks = block || span;
  if (value === "1") return block ? "block" : span ? "span" : "off";
  if (value === "block" && acceptsBlocks) return "block";
  if (value === "span" && acceptsBlocks) return "span";
  return "off";
}

interface RawBlock {
  from: number;
  stack: string[];
}

/** The fenced code block pattern of the library's `fenced_code`, which runs before the HTML pass. */
const FENCED_BLOCK = new RegExp(
  "^(~{3,}|`{3,})[ ]*(?:\\{[^\\n]*\\}|(?:\\.?[" +
    PYTHON_WORD_CLASS_BODY +
    "#.+-]*[ ]*)?(?:hl_lines=([\"'])[\\s\\S]*?\\2[ ]*)?)\\n[\\s\\S]*?(?<=\\n)\\1[ ]*$",
  "gmu",
);

/**
 * `source` with every span the HTML pass never sees blanked to whitespace of
 * the same length: formulas, which `protect_latex` replaces before conversion,
 * and fenced code, which is stashed first.
 */
function visibleToHtmlPass(source: string): string {
  const blankOut = (text: string, from: number, to: number) =>
    text.slice(0, from) + text.slice(from, to).replace(/[^\n]/g, " ") + text.slice(to);
  let out = source;
  for (const span of protectedSpans(source)) out = blankOut(out, span.from, span.to);
  for (const m of source.matchAll(FENCED_BLOCK)) out = blankOut(out, m.index, m.index + m[0].length);
  return out;
}

/**
 * The ranges of `text` Python Markdown holds as raw HTML rather than reads as
 * Markdown. A conversion is stripped before it is read, so a first tag
 * indented four columns still starts a line.
 */
export function scanHtmlBlocks(text: string): HtmlBlockRange[] {
  const lead = text.length - text.trimStart().length;
  return scanTrimmed(visibleToHtmlPass(text).slice(lead)).map((r) => ({
    ...r,
    from: r.from + lead,
    to: r.to + lead,
  }));
}

/** The offset after a `<?...?>`, `<![CDATA[...]]>` or `<!...>` opened at `lt`; 2 or less when it never closes. */
function declarationClose(source: string, lt: number): number {
  if (source.startsWith("<?", lt)) return source.indexOf("?>", lt + 2) + 2;
  if (source.startsWith("<![CDATA[", lt)) return source.indexOf("]]>", lt + 9) + 3;
  return source.indexOf(">", lt + 2) + 1;
}

/**
 * One pass over the tags of a trimmed text, in the order the library's HTML
 * parser meets them. `raw` is the raw block being read, `containers` the open
 * `markdown` containers and plain blocks inside them, and `inTail` whether the
 * text after a closed block still belongs to it (no blank lines yet).
 */
class HtmlBlockScan {
  private readonly ranges: HtmlBlockRange[] = [];
  private readonly containers: Container[] = [];
  private raw: RawBlock | null = null;
  private inTail = false;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  run(): HtmlBlockRange[] {
    const { source } = this;
    let last = 0;
    for (let lt = source.indexOf("<"); lt !== -1; lt = source.indexOf("<", last)) {
      if (lt > last) this.text(last, lt);
      last = this.token(lt);
    }
    this.finish();
    return this.ranges.sort((a, b) => a.from - b.from || b.to - a.to);
  }

  private top(): Container {
    return this.containers[this.containers.length - 1];
  }

  private moreFollows(end: number): boolean {
    return !BLANK_LINES.test(this.source.slice(end));
  }

  /** The library hands a container the tag or markup as data, so the container's content has started. */
  private interrupt(): void {
    if (!this.raw && this.containers.length) this.top().started = false;
  }

  /** Text since the last tag is data: it ends a tail and starts a container's content. */
  private text(last: number, lt: number): void {
    if (this.inTail && this.source.slice(last, lt).includes("\n")) this.inTail = false;
    this.interrupt();
  }

  /** Reads the token at `lt` and returns where the next search starts. */
  private token(lt: number): number {
    const { source } = this;
    if (source.startsWith("</", lt)) return this.endTagToken(lt);
    if (source.startsWith("<!--", lt)) return this.commentToken(lt);
    if (source.startsWith("<?", lt) || source.startsWith("<!", lt)) return this.declarationToken(lt);
    return this.startTagToken(lt);
  }

  private endTagToken(lt: number): number {
    END_TAG.lastIndex = lt;
    const m = END_TAG.exec(this.source);
    if (!m) {
      this.interrupt();
      return lt + 1;
    }
    const end = lt + m[0].length;
    this.endTag(m[1].toLowerCase(), lt, end);
    return end;
  }

  private commentToken(lt: number): number {
    const close = /--!?>/g;
    close.lastIndex = lt + 4;
    const m = close.exec(this.source);
    if (!m) {
      this.interrupt();
      return lt + 1;
    }
    const end = m.index + m[0].length;
    this.markup(lt, end, true);
    return end;
  }

  private declarationToken(lt: number): number {
    const { source } = this;
    const gated = startsLine(source, lt) || this.inTail || this.containers.length > 0;
    const close = declarationClose(source, lt);
    if (gated && close > 2) {
      this.markup(lt, close, !/^<![^dD\[]/.test(source.slice(lt, lt + 3)));
      return close;
    }
    this.interrupt();
    return lt + 2;
  }

  private startTagToken(lt: number): number {
    const tag = readStartTag(this.source, lt);
    if (!tag) {
      this.interrupt();
      return lt + 1;
    }
    this.startTag(tag, lt, startsLine(this.source, lt));
    return this.raw && CDATA_TAGS.has(tag.name) && !tag.selfClosing ? this.cdataEnd(tag) : tag.end;
  }

  /** Where the raw text of a `script` or `style` ends: at its end tag, or the end of the text. */
  private cdataEnd(tag: StartTag): number {
    const close = new RegExp(`</${tag.name}(?![^\\s/>])`, "i").exec(this.source.slice(tag.end));
    return close ? tag.end + close.index : this.source.length;
  }

  private closeContainers(name: string, at: number, end: number): void {
    let closed = false;
    while (this.containers.length && !closed) {
      const c = this.containers.pop()!;
      closed = c.tag === name;
      if (c.rawFrom !== null) this.ranges.push({ from: c.rawFrom, to: closed ? end : at });
      if (c.contentFrom !== undefined) this.ranges.push({ from: c.contentFrom, to: at, span: true });
    }
    if (this.containers.length === 0 && this.moreFollows(end)) this.inTail = true;
  }

  private emptyTag(from: number, end: number, block: boolean): void {
    this.interrupt();
    if (this.raw || this.inTail || !block || !startsLine(this.source, from)) return;
    this.ranges.push({ from, to: end });
    if (!this.containers.length && this.moreFollows(end)) this.inTail = true;
  }

  /** A comment, processing instruction or declaration: its text is skipped, and at a line start it is a block. */
  private markup(from: number, end: number, block: boolean): void {
    if (!this.raw) this.emptyTag(from, end, block);
  }

  private endTag(name: string, from: number, end: number): void {
    if (this.raw) this.endRawTag(this.raw, name, end);
    else if (BLOCK_LEVEL.has(name) && this.containers.some((c) => c.tag === name)) {
      this.endContainerTag(name, from, end);
    } else this.interrupt();
  }

  /** An end tag inside a raw block closes it once the tag it names is the outermost one open. */
  private endRawTag(raw: RawBlock, name: string, end: number): void {
    if (!raw.stack.includes(name)) return;
    while (raw.stack.length && raw.stack.pop() !== name);
    if (raw.stack.length) return;
    this.ranges.push({ from: raw.from, to: end });
    this.raw = null;
    if (this.moreFollows(end)) this.inTail = true;
  }

  private endContainerTag(name: string, from: number, end: number): void {
    const nearest = this.containers[this.containers.map((c) => c.tag).lastIndexOf(name)];
    if (nearest.rawFrom === null) this.ranges.push({ from, to: end, tag: true });
    this.closeContainers(name, from, end);
  }

  private startTag(tag: StartTag, from: number, atLineStart: boolean): void {
    const block = BLOCK_LEVEL.has(tag.name);
    if (tag.selfClosing || EMPTY_TAGS.has(tag.name)) {
      if (tag.selfClosing || atLineStart || this.inTail) this.emptyTag(from, tag.end, block);
      else this.interrupt();
    } else if (block && this.opensAt(atLineStart)) this.openTag(tag, from);
    else if (this.raw) this.raw.stack.push(tag.name);
    else this.interrupt();
  }

  /** Whether a block-level start tag opens a block here: at a line start, in a tail, or in a container's content. */
  private opensAt(atLineStart: boolean): boolean {
    return atLineStart || this.inTail || (this.containers.length > 0 && this.top().started);
  }

  /** A block-level start tag that begins a raw block or a container. */
  private openTag(tag: StartTag, from: number): void {
    const state = markdownState(
      tag.name,
      tag.attributes,
      this.containers.length ? this.top().state : null,
    );
    if (this.raw || (state === "off" && this.containers.length === 0)) {
      this.raw ??= { from, stack: [] };
      this.raw.stack.push(tag.name);
      return;
    }
    if (this.containers.some((c) => c.tag === "p")) this.closeContainers("p", from, from);
    this.containers.push({
      tag: tag.name,
      state,
      from,
      rawFrom: state === "off" ? from : null,
      contentFrom: state === "span" ? tag.end : undefined,
      started: true,
    });
    if (state !== "off") this.ranges.push({ from, to: tag.end, tag: true });
  }

  /**
   * The build appends the end tags a panel leaves open (`_close_html_blocks`
   * in markdown.py), so an unclosed container keeps its Markdown and only a
   * plain block inside one stays raw to the end.
   */
  private finish(): void {
    const to = this.source.length;
    if (this.raw) this.ranges.push({ from: this.raw.from, to, unclosed: true });
    for (const c of this.containers) {
      if (c.rawFrom !== null) this.ranges.push({ from: c.rawFrom, to, unclosed: true });
      if (c.contentFrom !== undefined) {
        this.ranges.push({ from: c.contentFrom, to, span: true, unclosed: true });
      }
    }
  }
}

function scanTrimmed(source: string): HtmlBlockRange[] {
  return new HtmlBlockScan(source).run();
}
