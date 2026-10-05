/**
 * This file pins what an author reads about an answer's length, against the
 * real English catalogue: the publish check's message, and the count, its
 * rule and the line under the answer. Every other test mocks `t` to echo its
 * key, so nothing else would catch a catalogue that dropped an interpolation.
 * The Spanish of these keys is reviewed separately (awaiting-spanish.ts).
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, beforeAll } from "vitest";
import { createInstance, type i18n } from "i18next";

import { checkMessage } from "~/components/features/publish/ValidationChecks";
import enPublish from "~/i18n/locales/en/publish.json";
import enEditor from "~/i18n/locales/en/editor.json";
import esPublish from "~/i18n/locales/es/publish.json";
import esEditor from "~/i18n/locales/es/editor.json";
import { ANSWER_BUDGET, BREAK_LINES, LINE_CHARS, MAX_PARAGRAPHS, SMALL_TYPE_LINES } from "~/lib/answer-budget";

const RULE = { budget: ANSWER_BUDGET, max_paragraphs: MAX_PARAGRAPHS, line_chars: LINE_CHARS, break_lines: BREAK_LINES };

let en: i18n;
let es: i18n;

beforeAll(async () => {
  en = createInstance();
  await en.init({
    lng: "en",
    ns: ["publish", "editor"],
    defaultNS: "publish",
    resources: { en: { publish: enPublish, editor: enEditor } },
    interpolation: { escapeValue: false },
  });
  es = createInstance();
  await es.init({
    lng: "es",
    ns: ["publish", "editor"],
    defaultNS: "publish",
    resources: { es: { publish: esPublish, editor: esEditor } },
    interpolation: { escapeValue: false },
  });
});

describe("the publish check's message about length", () => {
  const sentenceIn = (lang: i18n, lines: number, paragraphs: number) =>
    checkMessage(lang.t.bind(lang) as (key: string, values?: Record<string, unknown>) => string, {
      code: "step_answer_over_limit",
      message: "step_answer_over_limit",
      params: {
        number: "3",
        story: "The Weavers",
        lines,
        count: paragraphs,
        budget: String(ANSWER_BUDGET),
        max_paragraphs: String(MAX_PARAGRAPHS),
        line_chars: String(LINE_CHARS),
        break_lines: String(BREAK_LINES),
      },
    });
  const sentence = (lines: number) => sentenceIn(en, lines, 2);

  it("says 1 paragraph for one and 6 paragraphs for six, in English and Spanish", () => {
    expect(sentenceIn(en, 19, 1)).toContain("This one has 1 paragraph and 19 lines, so");
    expect(sentenceIn(en, 16, 6)).toContain("This one has 6 paragraphs and 16 lines, so");
    expect(sentenceIn(es, 19, 1)).toContain("Esta tiene 1 párrafo ");
    expect(sentenceIn(es, 16, 6)).toContain("Esta tiene 6 párrafos ");
    expect(sentenceIn(es, 16, 6)).not.toContain("{{");
  });

  it("says the site will cut it, with its lines and the rule's figures", () => {
    expect(sentence(24)).toBe(
      'The answer for step 3 of "The Weavers" is too long for the story\'s card. An answer may have up to ' +
        "5 paragraphs and 18 lines, counting 53 characters to a line and 2 lines for each paragraph after the first. This one has 2 paragraphs and 24 lines, so the published site will cut it. " +
        "Shorten it, or move the detail into a layer panel, before publishing.",
    );
  });

  // There is no limit to set in Site settings, so the message sends nobody there.
  it("sends nobody to Site settings and leaves nothing uninterpolated", () => {
    expect(sentence(24)).not.toMatch(/Site settings/i);
    expect(sentence(24)).not.toContain("{{");
  });
});

describe("the editor's count and line under the answer", () => {
  it("counts the lines against the budget", () => {
    expect(en.t("editor:answer_budget_count", { lines: 12, budget: ANSWER_BUDGET })).toBe("12 of 18 lines");
  });

  it("states the rule the count follows", () => {
    expect(en.t("editor:answer_budget_rule", { ...RULE, small_type_lines: SMALL_TYPE_LINES })).toBe(
      "A line holds 53 characters, and each paragraph after the first counts 2 more lines. An answer fits on the story's card with up to 5 paragraphs and 18 lines. " +
        "Past 15 lines, the site sets it in smaller type.",
    );
  });

  it("says where the cut falls and what to do", () => {
    expect(en.t("editor:answer_over_hard_limit", RULE)).toBe(
      "Too long for the story's card: the published site will cut this answer. An answer may have up to 5 paragraphs and 18 lines, counting 53 characters to a line and 2 lines for each paragraph after the first. " +
        "Shorten it, or move the detail into a layer panel.",
    );
  });

  it("leaves nothing uninterpolated in Spanish", () => {
    expect(es.t("editor:answer_budget_count", { lines: 12, budget: ANSWER_BUDGET })).not.toContain("{{");
    expect(es.t("editor:answer_budget_rule", { ...RULE, small_type_lines: SMALL_TYPE_LINES })).not.toContain("{{");
    expect(es.t("editor:answer_over_hard_limit", RULE)).not.toContain("{{");
  });
});
