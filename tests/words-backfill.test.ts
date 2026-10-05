/**
 * What the word backfill would write, and — more to the point — what it refuses
 * to write.
 *
 * It credits words present to whoever is the only person who ever wrote in the
 * entity holding them. That claim is sound exactly as far as the sole-contributor
 * condition holds, so the tests that matter are the ones proving it stops there:
 * nothing for an entity two people wrote in, and nothing over a count the Durable
 * Object has already observed.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";

import { planWordsBackfill } from "~/lib/words-backfill.server";
import type { EntityWords } from "~/lib/words-backfill.server";

const ANA = 4;
const BEATRIZ = 9;

function step(entityId: number, contributors: number[], ...values: (string | null)[]): EntityWords {
  return { kind: "step", entityId, values, contributors };
}

describe("an entity only one person wrote in", () => {
  it("credits every word in it to them", () => {
    const { outcome, statements } = planWordsBackfill({
      projectId: 18,
      entities: [step(11, [ANA], "¿Qué vemos aquí?", "Un retrato de la Virgen")],
    });

    expect(outcome.soleContributor).toBe(1);
    expect(outcome.words).toBe(8);
    expect(statements[0].binds).toEqual([8, 18, "step", 11, ANA]);
  });

  it("adds up every prose column, and treats a null one as empty", () => {
    const { outcome } = planWordsBackfill({
      projectId: 18,
      entities: [step(11, [ANA], "una dos", null, "tres")],
    });

    expect(outcome.words).toBe(3);
  });

  it("credits nothing for an entity holding no text", () => {
    const { outcome, statements } = planWordsBackfill({
      projectId: 18,
      entities: [step(11, [ANA], "", null)],
    });

    // Still a statement, and still a measurement: this person wrote in the step
    // and the step holds no words. That is a counted nought, not an unknown.
    expect(statements).toHaveLength(1);
    expect(outcome.words).toBe(0);
    expect(statements[0].binds[0]).toBe(0);
  });
});

describe("an entity two people wrote in", () => {
  it("writes nothing at all", () => {
    // The text carries no record of who typed which sentence, so any split
    // would be invented. Uncounted is the honest answer and the record already
    // renders it.
    const { outcome, statements } = planWordsBackfill({
      projectId: 18,
      entities: [step(11, [ANA, BEATRIZ], "una dos tres cuatro cinco")],
    });

    expect(statements).toEqual([]);
    expect(outcome.shared).toBe(1);
    expect(outcome.soleContributor).toBe(0);
    expect(outcome.words).toBe(0);
  });

  it("does not stop it crediting the entities beside it", () => {
    const { outcome } = planWordsBackfill({
      projectId: 18,
      entities: [
        step(11, [ANA, BEATRIZ], "una dos tres"),
        step(12, [BEATRIZ], "cuatro cinco"),
      ],
    });

    expect(outcome.shared).toBe(1);
    expect(outcome.soleContributor).toBe(1);
    expect(outcome.words).toBe(2);
  });
});

describe("an entity the template seeded", () => {
  it("writes nothing, even though only one person wrote in it", () => {
    // Measured on staging: 313 of 371 words this would otherwise have credited
    // were the shipped glossary definition and the shipped About page, given
    // to somebody who wrote none of it.
    const { outcome, statements } = planWordsBackfill({
      projectId: 18,
      entities: [{
        kind: "page",
        entityId: 11,
        values: ["Acerca", "doscientas cincuenta palabras de plantilla"],
        contributors: [ANA],
        templateSeeded: true,
      }],
    });

    expect(statements).toEqual([]);
    expect(outcome.templateSeeded).toBe(1);
    expect(outcome.soleContributor).toBe(0);
    expect(outcome.words).toBe(0);
  });
});

describe("what every statement guarantees", () => {
  it("cannot overwrite a count the Durable Object observed", () => {
    // An observed count measures words ADDED; this measures words PRESENT.
    // Where both exist the observation wins, and the guard is in the SQL so no
    // ordering mistake and no second run can reverse that.
    const { statements } = planWordsBackfill({
      projectId: 18,
      entities: [step(11, [ANA], "una dos")],
    });

    expect(statements[0].sql).toContain("words_written IS NULL");
  });

  it("addresses one contributor row, by its whole key", () => {
    const { statements } = planWordsBackfill({
      projectId: 18,
      entities: [step(11, [ANA], "una")],
    });

    expect(statements[0].sql).toContain(
      "WHERE project_id = ? AND entity_kind = ? AND entity_id = ? AND user_id = ?",
    );
  });

  it("plans nothing for a project with no entities", () => {
    const { outcome, statements } = planWordsBackfill({ projectId: 99, entities: [] });

    expect(statements).toEqual([]);
    expect(outcome).toEqual({
      soleContributor: 0, shared: 0, templateSeeded: 0, words: 0, byKind: {},
    });
  });
});

describe("the per-kind account", () => {
  it("reports credited, shared and words for each kind separately", () => {
    const { outcome } = planWordsBackfill({
      projectId: 18,
      entities: [
        step(11, [ANA], "una dos tres"),
        step(12, [ANA, BEATRIZ], "cuatro"),
        { kind: "layer", entityId: 91, values: ["cinco seis"], contributors: [BEATRIZ] },
      ],
    });

    expect(outcome.byKind.step).toEqual({ credited: 1, shared: 1, templateSeeded: 0, words: 3 });
    expect(outcome.byKind.layer).toEqual({ credited: 1, shared: 0, templateSeeded: 0, words: 2 });
  });
});
