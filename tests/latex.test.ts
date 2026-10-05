/**
 * latex.ts against latex.py: `latex_spans` finds every formula-shaped span
 * with no detection gate, while `protect_latex` holds out nothing unless
 * `has_latex` finds a formula.
 *
 * @version v1.5.0-beta
 */
import { it, expect } from "vitest";
import { latexSpans, protectedSpans, protectLatex } from "~/components/ui/markdown-editor/latex";

it("finds a $…$ span without LaTeX characters, as latex_spans does", () => {
  expect(latexSpans("a $b$ c")).toEqual([{ from: 2, to: 5 }]);
});

it("protects nothing where has_latex finds no formula", () => {
  expect(protectedSpans("a $b$ c")).toEqual([]);
  expect(protectLatex("a $b$ c", "S").held).toEqual([]);
  expect(protectedSpans("a $b$ c $x_1$")).toEqual([{ from: 2, to: 5 }, { from: 8, to: 13 }]);
});
