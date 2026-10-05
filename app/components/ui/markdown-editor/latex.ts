/**
 * latex — the formulas the framework holds out of Markdown's reach
 * (`has_latex`, `protect_latex` and `latex_spans`, scripts/telar/latex.py):
 * the same forms, found in the same order, with Python's idea of
 * whitespace. Inside a protected formula nothing is Markdown, so a
 * `[^label]` there is part of the formula and not a footnote. `latexSpans`
 * finds every span as `latex_spans` does; `protectedSpans` is what
 * `protect_latex` actually holds out, nothing unless `has_latex` finds a
 * formula. `escapeMaths` is how a formula is written back into the HTML.
 *
 * @version v1.5.0-beta
 */
/**
 * Python's `\s` over `str`: what `str.isspace()` accepts. JavaScript's `\s`
 * differs on four points — it takes U+FEFF and leaves out U+001C to U+001F
 * and U+0085 — so the framework's classes are spelt out here.
 */
const SPACE = "\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const NON_SPACE = `[^${SPACE}]`;

/** `$…$` with no space inside either dollar sign. */
const INLINE_MATH = new RegExp(`\\$(${NON_SPACE}[^$]*?${NON_SPACE}|${NON_SPACE})\\$`, "gu");

type Span = { from: number; to: number };
type Finder = (text: string, first?: boolean) => Span[];

/**
 * A finder for the spans that open with `opening` and run through the first of
 * each of `closes` in turn, at least `gap` characters in, as the lazy pattern
 * `opening[\s\S]*?close…` matches them: every span in a text, as `matchAll`
 * finds them, or with `first` only whether there is one (`_delimited`,
 * scripts/telar/latex.py).
 *
 * Each close is searched for once. With none after an opening there is none
 * after any later opening either, where the pattern would search the rest of
 * the text again from each one.
 */
function delimited(opening: string, closes: readonly string[], gap = 0): Finder {
  return (text, first = false) => {
    const found: Span[] = [];
    let pos = 0;
    for (;;) {
      const start = text.indexOf(opening, pos);
      if (start === -1) return found;
      let end = start + opening.length + gap;
      for (const close of closes) {
        end = text.indexOf(close, end);
        if (end === -1) return found;
        end += close.length;
      }
      found.push({ from: start, to: end });
      if (first) return found;
      pos = end;
    }
  };
}

/** A finder for the spans `pattern` matches. */
const matching =
  (pattern: RegExp): Finder =>
  (text) =>
    [...text.matchAll(pattern)].map((m) => ({ from: m.index, to: m.index + m[0].length }));

const DISPLAY_MATH = delimited("$$", ["$$"], 1);
/** The framework's protected forms, longest first, in the order it replaces them. */
const PROTECTED: readonly Finder[] = [
  DISPLAY_MATH,
  delimited("\\begin{", ["}", "\\end{", "}"]),
  delimited("\\[", ["\\]"]),
  delimited("\\(", ["\\)"]),
  delimited("\\ce{", ["}"]),
  matching(INLINE_MATH),
];
const UNCONDITIONAL = [/\\begin\{/u, /\\\(/u, /\\\[/u, /\\ce\{/u];

/** `has_latex`: a `$…$` counts only when it holds a backslash, `^`, `_` or `{`. */
export function hasLatex(text: string): boolean {
  if (DISPLAY_MATH(text, true).length || UNCONDITIONAL.some((pattern) => pattern.test(text))) return true;
  return [...text.matchAll(INLINE_MATH)].some((m) => /[\\^_{]/.test(m[1]));
}

export type Held = Array<[placeholder: string, original: string]>;

/**
 * Replace each formula with a placeholder that Markdown leaves alone. Each
 * placeholder is `stem`, a number and `END`; the caller chooses a stem that
 * does not occur in the text, so no author text can be taken for one.
 *
 * A later form can match text that already holds an earlier form's
 * placeholder (`$x $$y$$ z$`, `$\ce{H2O}$`). Each held value is the author's
 * text with those placeholders put back, as `protect_latex` keeps it, so one
 * restoring pass returns every formula and none is left inside another.
 */
export function protectLatex(text: string, stem: string): { text: string; held: Held } {
  const held: Held = [];
  if (!hasLatex(text)) return { text, held };
  const inner = new RegExp(`${stem}\\d+END`, "g");
  const byPlaceholder = new Map<string, string>();
  let protectedText = text;
  for (const find of PROTECTED) {
    let out = "";
    let pos = 0;
    for (const { from, to } of find(protectedText)) {
      const original = protectedText.slice(from, to).replace(inner, (p) => byPlaceholder.get(p) ?? p);
      const placeholder = `${stem}${held.length}END`;
      held.push([placeholder, original]);
      byPlaceholder.set(placeholder, original);
      out += protectedText.slice(pos, from) + placeholder;
      pos = to;
    }
    protectedText = out + protectedText.slice(pos);
  }
  return { text: protectedText, held };
}

/** Every formula's span in `text`, as `latex_spans` finds them. */
export function latexSpans(text: string): Span[] {
  return PROTECTED.flatMap((find) => find(text));
}

/** The spans `protect_latex` holds out: none when `has_latex` finds no formula. */
export function protectedSpans(text: string): Span[] {
  return hasLatex(text) ? latexSpans(text) : [];
}

/** `_BARE_AMPERSAND`, scripts/telar/latex.py: an `&` that opens no character reference; Python's `\d` is any decimal digit. */
const BARE_AMPERSAND = /&(?!#\p{Nd}+;|#[xX][0-9a-fA-F]+;|[A-Za-z][A-Za-z0-9]*;)/gu;

/**
 * A formula as the framework writes it back into HTML (`_escape_maths`): a
 * bare `&`, `<` and `>` as character references, and any reference the
 * formula already holds kept, so it is escaped once.
 */
export function escapeMaths(original: string): string {
  return original.replace(BARE_AMPERSAND, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
