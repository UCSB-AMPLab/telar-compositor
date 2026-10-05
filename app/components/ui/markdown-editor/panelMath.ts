/**
 * Math preview loads KaTeX and its fonts only when a panel contains an expression.
 * Delimiters match Telar's default configuration; callers may supply site values.
 * Rendering never enables HTML commands or shared, mutable author macros.
 * @version v1.5.0-beta
 */
import { isEscaped } from "./escapes";
import type { SourceRange } from "./footnoteSyntax";
export interface MathDelimiter {
  left: string;
  right: string;
  display: boolean;
}
export const panelMathDelimiters: MathDelimiter[] = [
  { left: "$$", right: "$$", display: true },
  { left: "$", right: "$", display: false },
  { left: "\\(", right: "\\)", display: false },
  { left: "\\[", right: "\\]", display: true },
  ...[
    "align",
    "align*",
    "cases",
    "pmatrix",
    "bmatrix",
    "equation",
    "equation*",
  ].map((name) => ({
    left: `\\begin{${name}}`,
    right: `\\end{${name}}`,
    display: true,
  })),
];
export interface MathExpression extends SourceRange {
  source: string;
  display: boolean;
}
function insideAny(excluded: SourceRange[], at: number): boolean {
  return excluded.some((r) => at >= r.from && at < r.to);
}

/** The position of `d.right` closing an expression opened at `from`, outside braces. */
function closingAt(text: string, from: number, right: string): number {
  let depth = 0;
  for (let end = from; end < text.length; end++) {
    if (isEscaped(text, end)) continue;
    if (!depth && text.startsWith(right, end)) return end;
    if (text[end] === "{") depth++;
    if (text[end] === "}") depth--;
  }
  return -1;
}

/** The expression opened by `d` at `at`, or null when it never closes cleanly. */
function expressionAt(
  text: string,
  at: number,
  d: MathDelimiter,
  excluded: SourceRange[],
): MathExpression | null {
  const end = closingAt(text, at + d.left.length, d.right);
  const to = end + d.right.length;
  if (end === -1 || excluded.some((r) => at < r.to && to > r.from)) return null;
  const environment = d.left.startsWith("\\begin");
  const source = text.slice(environment ? at : at + d.left.length, environment ? to : end);
  return source.trim() ? { from: at, to, source, display: d.display } : null;
}

export function parseMath(
  text: string,
  excluded: SourceRange[],
  delimiters = panelMathDelimiters,
): MathExpression[] {
  const result: MathExpression[] = [];
  for (let at = 0; at < text.length; at++) {
    if (insideAny(excluded, at) || isEscaped(text, at)) continue;
    const d = delimiters.find((d) => d.left && d.right && text.startsWith(d.left, at));
    const expression = d && expressionAt(text, at, d, excluded);
    if (!expression) continue;
    result.push(expression);
    at = expression.to - 1;
  }
  return result;
}

let loading: Promise<typeof import("katex")> | undefined;
export function loadPanelMath() {
  return (loading ??= Promise.all([
    import("katex"),
    import("katex/dist/katex.min.css"),
  ])
    .then(async ([katex]) => {
      await import("katex/contrib/mhchem");
      return katex;
    })
    .catch((error) => {
      loading = undefined;
      throw error;
    }));
}

/** What else a typesetting run leaves alone, and whether it is still wanted once KaTeX has loaded. */
export interface PanelMathRun {
  /** Elements with these classes, and everything inside them, are not typeset. */
  ignoredClasses?: string[];
  /** Read once KaTeX has loaded: false, and nothing is typeset. */
  current?: () => boolean;
}

/** Render equations in already-sanitised widget or footnote HTML. */
export async function renderPanelMath(
  element: HTMLElement,
  delimiters = panelMathDelimiters,
  run: PanelMathRun = {},
) {
  if (!delimiters.some((d) => element.textContent?.includes(d.left))) return;
  await loadPanelMath();
  const { default: renderMath } = await import("katex/contrib/auto-render");
  if (!element.isConnected || run.current?.() === false) return;
  renderMath(element, {
    delimiters,
    throwOnError: false,
    trust: false,
    maxExpand: 1000,
    maxSize: 20,
    ignoredClasses: ["katex", ...(run.ignoredClasses ?? [])],
  });
}
