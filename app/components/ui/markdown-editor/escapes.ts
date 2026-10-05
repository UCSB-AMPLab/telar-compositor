/**
 * escapes — whether a character is escaped in Markdown source: preceded by
 * an odd number of backslashes. Python Markdown and KaTeX's delimiters both
 * read it this way, so footnote references and formulas share the rule.
 *
 * @version v1.5.0-beta
 */
export function isEscaped(text: string, at: number): boolean {
  let slashes = 0;
  for (let p = at - 1; p >= 0 && text[p] === "\\"; p--) slashes++;
  return slashes % 2 === 1;
}
