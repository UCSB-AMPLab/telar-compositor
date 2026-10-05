// @vitest-environment jsdom
/**
 * The step card's answer carries `step-answer--long` exactly when the site
 * sets the published answer in the smaller type: more than SMALL_TYPE_LINES
 * lines once cut, as the build's `answer_long` says.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import { AnswerRendering } from "~/components/features/editor/AnswerRendering";
import { SMALL_TYPE_LINES } from "~/lib/answer-budget";

const NO_GLOSSARY = { terms: new Map(), baseUrl: "" };

/** One paragraph of n lines: n words of 52 characters. */
const lines = (n: number) => Array.from({ length: n }, () => "x".repeat(52)).join(" ");

const classOf = (answer: string, className?: string) =>
  render(<AnswerRendering answer={answer} glossary={NO_GLOSSARY} className={className} />).container.firstElementChild!.className;

describe("the answer's smaller type", () => {
  it("is off at SMALL_TYPE_LINES lines and on past them", () => {
    expect(classOf(lines(SMALL_TYPE_LINES))).toBe("");
    expect(classOf(lines(SMALL_TYPE_LINES + 1))).toBe("step-answer--long");
  });

  it("joins the class the card gives the answer", () => {
    expect(classOf(lines(SMALL_TYPE_LINES + 1), "step-answer")).toBe("step-answer step-answer--long");
    expect(classOf("Short.", "step-answer")).toBe("step-answer");
  });

  it("follows the published answer, which a cut leaves in the smaller type", () => {
    expect(classOf(lines(40))).toBe("step-answer--long");
  });
});
