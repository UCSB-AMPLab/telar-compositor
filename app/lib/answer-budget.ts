/**
 * The length rule a step's answer is held to, so that it fits every side card
 * without scrolling: a port of the framework's
 * `scripts/telar/answer_budget.py`, checked against the shared fixture
 * `tests/fixtures/answer-budget.json` in the framework checkout.
 *
 * Input is the answer's HTML after widgets, media, tables, code blocks,
 * rules and footnotes are removed and headings, quotes and lists are made
 * paragraphs; maths is a placeholder with no whitespace in it, so it counts
 * its own characters as part of one word. A word is a maximal run of
 * characters that are not whitespace as Python reads it, over the text nodes
 * with references decoded, each `<p>`, `</p>` and `<br>` standing for a space.
 *
 * Lines are counted LINE_CHARS characters to a line. Each `<p>` and each
 * `<br>` starts a segment, whose characters are its words joined by single
 * spaces; a segment with characters counts ceil(characters / LINE_CHARS)
 * lines, and an empty one counts one line when a `<br>` ends it and none
 * otherwise. Each `<p>` after the first adds BREAK_LINES. An answer fits when
 * it has at most ANSWER_BUDGET lines and MAX_PARAGRAPHS paragraphs, and is set
 * in the smaller type when it has more than SMALL_TYPE_LINES lines.
 *
 * The cut keeps the longest run of words from the start that fits with the
 * ellipsis counted as one more character of the last kept word's segment, and
 * which lies within the first MAX_PARAGRAPHS paragraphs (words before the
 * first `<p>` are kept); it never ends inside an `<a>`, ends with the ellipsis
 * joined to the last word kept, and closes what is still open.
 *
 * @version v1.5.0-beta
 */

import { htmlUnescape } from "~/lib/html-unescape";
import { PYTHON_WHITESPACE } from "~/lib/python-whitespace";
import { firstAtLeast } from "~/lib/sorted-search";

/** The most lines an answer may count and still fit every side card. */
export const ANSWER_BUDGET = 18;

/** Characters to a line on the reference side card. */
export const LINE_CHARS = 53;

/** What the space between two paragraphs counts, in lines. */
export const BREAK_LINES = 2;

/** The most paragraphs an answer may have and still fit, however short. */
export const MAX_PARAGRAPHS = 5;

/** The most lines an answer may count and still be set in the normal type. */
export const SMALL_TYPE_LINES = 15;

export const ELLIPSIS = "…";

const TOKEN = /<!--.*?-->|<[A-Za-z/!?](?:[^<>"']|"[^"]*"|'[^']*')*>/gs;
const TAG_NAME = /^<\/?([A-Za-z][A-Za-z0-9-]*)/;
const UNIT = /&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);|[\s\S]/gu;
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);
const BREAKS = new Set(["p", "br"]);

/** One piece of an answer's HTML; `kind` is text, start, end, void or other. */
export type HtmlToken = { kind: "text" | "start" | "end" | "void" | "other"; raw: string; name: string };

export type Measure = { words: number; paragraphs: number; lines: number };

/** `text` as tokens, in order; joined, their `raw` is `text`. */
export function htmlTokens(text: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  let pos = 0;
  for (const match of text.matchAll(TOKEN)) {
    if (match.index > pos) tokens.push({ kind: "text", raw: text.slice(pos, match.index), name: "" });
    tokens.push(tagToken(match[0]));
    pos = match.index + match[0].length;
  }
  if (pos < text.length) tokens.push({ kind: "text", raw: text.slice(pos), name: "" });
  return tokens;
}

function tagToken(raw: string): HtmlToken {
  const named = TAG_NAME.exec(raw);
  if (!named) return { kind: "other", raw, name: "" };
  const name = named[1].toLowerCase();
  if (raw.startsWith("</")) return { kind: "end", raw, name };
  if (VOID.has(name) || raw.endsWith("/>")) return { kind: "void", raw, name };
  return { kind: "start", raw, name };
}

/** A word: where it ends, the lines the answer counts if cut there with the ellipsis, and the anchors open there. */
type Word = { token: number; end: number; lines: number; anchors: number[] };

/** Whether a decoded unit is whitespace, as Python's `str.isspace()` reads it. */
function isSpace(chars: string[]): boolean {
  return chars.length > 0 && chars.every((ch) => PYTHON_WHITESPACE.has(ch));
}

function segmentLines(characters: number, endedByBr: boolean): number {
  if (characters) return Math.ceil(characters / LINE_CHARS);
  return endedByBr ? 1 : 0;
}

/** An answer read once: where each word ends, the lines it counts there, and the anchors open there. */
class Reading {
  readonly tokens: HtmlToken[];
  readonly words: Word[] = [];
  paragraphs = 0;
  /** How many words come before the first paragraph past MAX_PARAGRAPHS; null when there is none. */
  wordsInParagraphLimit: number | null = null;
  lines = 0;
  private characters = 0;
  private readonly firstIn = new Map<number, number>();
  private readonly lastIn = new Map<number, number>();
  private readonly open: number[] = [];
  private nextAnchor = 0;
  private inWord = false;

  constructor(text: string) {
    this.tokens = htmlTokens(text);
    this.tokens.forEach((token, index) => {
      if (token.kind === "text") this.readText(index, token.raw);
      else this.readTag(token);
    });
    this.lines += segmentLines(this.characters, false);
  }

  private readTag(token: HtmlToken): void {
    if (BREAKS.has(token.name)) this.inWord = false;
    const startsParagraph = token.kind === "start" && token.name === "p";
    if (token.name === "br" || startsParagraph) {
      this.lines += segmentLines(this.characters, token.name === "br");
      this.characters = 0;
    }
    if (startsParagraph) {
      this.paragraphs += 1;
      if (this.paragraphs === MAX_PARAGRAPHS + 1) this.wordsInParagraphLimit = this.words.length;
      if (this.paragraphs > 1) this.lines += BREAK_LINES;
    }
    if (token.name === "a") this.readAnchor(token);
  }

  private readAnchor(token: HtmlToken): void {
    if (token.kind === "start") this.open.push(this.nextAnchor++);
    else if (token.kind === "end") this.open.pop();
  }

  private readText(index: number, raw: string): void {
    for (const unit of raw.matchAll(UNIT)) {
      const chars = [...htmlUnescape(unit[0])];
      if (isSpace(chars)) {
        this.inWord = false;
        continue;
      }
      if (!this.inWord) {
        this.inWord = true;
        if (this.characters) this.characters += 1;
        this.words.push({ token: index, end: 0, lines: 0, anchors: [] });
      }
      this.characters += chars.length;
      const number = this.words.length - 1;
      const withEllipsis = this.lines + segmentLines(this.characters + 1, false);
      this.words[number] = { token: index, end: unit.index + unit[0].length, lines: withEllipsis, anchors: [...this.open] };
      for (const anchor of this.open) {
        if (!this.firstIn.has(anchor)) this.firstIn.set(anchor, number);
        this.lastIn.set(anchor, number);
      }
    }
  }

  /** The index of the last word a cut keeps, or -1 for none. */
  lastWordToKeep(): number {
    let kept = firstAtLeast(this.words.map((word) => word.lines), ANSWER_BUDGET + 1) - 1;
    if (this.wordsInParagraphLimit !== null) kept = Math.min(kept, this.wordsInParagraphLimit - 1);
    while (kept >= 0) {
      const openLater = this.words[kept].anchors.filter((anchor) => this.lastIn.get(anchor)! > kept);
      if (openLater.length === 0) break;
      kept = Math.min(...openLater.map((anchor) => this.firstIn.get(anchor)!)) - 1;
    }
    return kept;
  }
}

/** The words, paragraphs and lines of answer HTML `text`. */
export function measureAnswer(text: string): Measure {
  return measureOf(new Reading(text));
}

function measureOf(reading: Reading): Measure {
  return { words: reading.words.length, paragraphs: reading.paragraphs, lines: reading.lines };
}

/** Whether a Measure is within ANSWER_BUDGET and MAX_PARAGRAPHS. */
export function withinBudget(measure: Measure): boolean {
  return measure.lines <= ANSWER_BUDGET && measure.paragraphs <= MAX_PARAGRAPHS;
}

/** Whether a Measure is over SMALL_TYPE_LINES, so set in the smaller type. */
export function smallType(measure: Measure): boolean {
  return measure.lines > SMALL_TYPE_LINES;
}

/** Whether answer HTML `text` is within the budget. */
export function fits(text: string): boolean {
  return withinBudget(measureAnswer(text));
}

/** The names of the elements `tokens` leave open, outermost first. */
function openElements(tokens: HtmlToken[]): string[] {
  const stack: string[] = [];
  for (const token of tokens) {
    if (token.kind === "start") stack.push(token.name);
    else if (token.kind === "end") {
      const at = stack.lastIndexOf(token.name);
      if (at >= 0) stack.length = at;
    }
  }
  return stack;
}

/** Answer HTML `text` cut to the budget; `text` itself when it fits. */
export function cutToBudget(text: string): string {
  const reading = new Reading(text);
  if (withinBudget(measureOf(reading))) return text;
  const kept = reading.lastWordToKeep();
  if (kept < 0) return ELLIPSIS;
  const word = reading.words[kept];
  const { tokens } = reading;
  const pieces = tokens.slice(0, word.token).map((token) => token.raw);
  pieces.push(tokens[word.token].raw.slice(0, word.end));
  let following = word.token + 1;
  if (word.end === tokens[word.token].raw.length) {
    while (following < tokens.length && tokens[following].kind === "end" && tokens[following].name !== "p") {
      pieces.push(tokens[following].raw);
      following += 1;
    }
  }
  const closers = openElements(tokens.slice(0, following))
    .reverse()
    .map((name) => `</${name}>`)
    .join("");
  return pieces.join("") + ELLIPSIS + closers;
}
