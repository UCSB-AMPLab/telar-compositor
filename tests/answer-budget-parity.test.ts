/**
 * The Compositor's answer budget against the framework's shared fixture,
 * `tests/fixtures/answer-budget.json` in the framework checkout, read live:
 * the five constants, and for every case the words, paragraphs, lines, cut
 * and whether the published answer is set in the smaller type.
 *
 * @version v1.5.0-beta
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import {
  ANSWER_BUDGET,
  BREAK_LINES,
  LINE_CHARS,
  MAX_PARAGRAPHS,
  SMALL_TYPE_LINES,
  cutToBudget,
  fits,
  measureAnswer,
  smallType,
} from "~/lib/answer-budget";
import { FRAMEWORK_SCRIPTS_DIR, describeWithRequiredFramework, frameworkCheckoutPresent } from "./helpers/framework-checkout";

type Case = {
  name: string;
  html: string;
  words: number;
  paragraphs: number;
  lines: number;
  cut: string;
  small_type: boolean;
};
type Fixture = {
  budget: number;
  line_chars: number;
  break_lines: number;
  max_paragraphs: number;
  small_type_lines: number;
  cases: Case[];
};

const FIXTURE = join(FRAMEWORK_SCRIPTS_DIR, "..", "tests", "fixtures", "answer-budget.json");

describeWithRequiredFramework("answer-budget against the framework's shared fixture", () => {
  const fixture = (frameworkCheckoutPresent ? JSON.parse(readFileSync(FIXTURE, "utf8")) : { cases: [] }) as Fixture;

  it("states the framework's five constants", () => {
    expect(ANSWER_BUDGET).toBe(fixture.budget);
    expect(LINE_CHARS).toBe(fixture.line_chars);
    expect(BREAK_LINES).toBe(fixture.break_lines);
    expect(MAX_PARAGRAPHS).toBe(fixture.max_paragraphs);
    expect(SMALL_TYPE_LINES).toBe(fixture.small_type_lines);
  });

  it("reads the fixture's cases", () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  for (const c of readFixtureCases()) {
    it(`${c.name}: measure, fit, cut and type`, () => {
      expect(measureAnswer(c.html)).toEqual({ words: c.words, paragraphs: c.paragraphs, lines: c.lines });
      expect(fits(c.html)).toBe(c.lines <= fixture.budget && c.paragraphs <= fixture.max_paragraphs);
      expect(cutToBudget(c.html)).toBe(c.cut);
      expect(smallType(measureAnswer(c.cut))).toBe(c.small_type);
    });
  }

  it("cutting a cut answer changes nothing", () => {
    for (const c of fixture.cases) expect(cutToBudget(c.cut)).toBe(c.cut);
  });

  it("holds an answer to five paragraphs however short they are", () => {
    const paragraphs = (n: number) => Array.from({ length: n }, (_, i) => `<p>w${i + 1}</p>`).join("\n");
    expect(fits(paragraphs(5))).toBe(true);
    expect(fits(paragraphs(6))).toBe(false);
    expect(cutToBudget(paragraphs(7))).toBe(`${paragraphs(4)}\n<p>w5…</p>`);
  });

  it("reads a long answer in one pass", () => {
    const long = `<p>${"word ".repeat(200_000)}</p>`;
    const started = Date.now();
    expect(measureAnswer(long).words).toBe(200_000);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

function readFixtureCases(): Case[] {
  try {
    return (JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture).cases;
  } catch {
    return [];
  }
}
