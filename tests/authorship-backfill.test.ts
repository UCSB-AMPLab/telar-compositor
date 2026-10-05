/**
 * What the backfill would write, held to the two standards it claims.
 *
 * The template pass states a fact and runs everywhere. The authorship pass
 * rests entirely on the membership gate, so the tests that matter most here are
 * the ones proving it writes nothing when that gate is shut, and that no
 * statement it produces can reach a row somebody's authorship is already on.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";

import { planAuthorshipBackfill } from "~/lib/authorship-backfill.server";
import type { BackfillInput } from "~/lib/authorship-backfill.server";
import { renderRecoverySql } from "~/lib/authorship-recovery";

/** Staging project 18's unattributed rows, which are template content entire. */
function seededProject(soleMember: number | null): BackfillInput {
  return {
    projectId: 18,
    soleMember,
    stories: [{ id: 49, story_id: "plantilla_en_blanco", title: "reemplázame con tu título" }],
    steps: [
      { id: 105, object_id: "telar-placeholder", question: "pregunta", answer: "respuesta" },
      { id: 106, object_id: "telar-placeholder", question: "pregunta", answer: "respuesta" },
      { id: 107, object_id: "telar-placeholder", question: "pregunta", answer: "respuesta" },
    ],
    layers: [],
    objects: [{ id: 42, object_id: "telar-placeholder", title: "Telar placeholder" }],
    terms: [{ id: 21, term_id: "telar", definition: "Telar es un marco de computación mínima que entreteje imágenes IIIF, audio, video y textos en narrativas visuales por capas para humanidades digitales, exposiciones públicas, narrativa comunitaria y proyectos en el salón de clase. Aprende más en [Telar.org](https://telar.org)" }],
    pages: [],
  };
}

/** The same site after somebody has worked in it. */
function workedInProject(soleMember: number | null): BackfillInput {
  return {
    ...seededProject(soleMember),
    steps: [
      { id: 105, object_id: "telar-placeholder", question: "¿Qué vemos aquí?", answer: "Un retrato" },
      { id: 106, object_id: "telar-placeholder", question: "pregunta", answer: "respuesta" },
      { id: 107, object_id: "telar-placeholder", question: "pregunta", answer: "respuesta" },
    ],
    layers: [{ id: 7 }],
  };
}

describe("the template pass", () => {
  it("labels seeded rows on a project nobody can be credited on", async () => {
    const { outcome, statements } = await planAuthorshipBackfill(seededProject(null));

    expect(outcome.templateRows).toBe(6);
    expect(outcome.authoredRows).toBe(0);
    expect(statements).toHaveLength(6);
    expect(statements.every((s) => s.binds[0] === "telar_template")).toBe(true);
  });

  it("runs the same way whether or not one person owns the site", async () => {
    // Nobody authored a seeded row; how many people work there changes nothing.
    const shared = await planAuthorshipBackfill(seededProject(null));
    const solo = await planAuthorshipBackfill(seededProject(4));

    expect(solo.outcome.templateRows).toBe(shared.outcome.templateRows);
  });
});

describe("the authorship pass", () => {
  it("credits the sole member with the work they did in a seeded story", async () => {
    const { outcome } = await planAuthorshipBackfill(workedInProject(4));

    // The written-in step and the layer are theirs; the untouched step, story,
    // object and term are the template's.
    expect(outcome.authoredRows).toBe(2);
    expect(outcome.byKind.step).toEqual({ template: 2, authored: 1 });
    expect(outcome.byKind.layer).toEqual({ template: 0, authored: 1 });
  });

  it("writes nothing at all when more than one person has had access", async () => {
    const { outcome, statements } = await planAuthorshipBackfill(workedInProject(null));

    expect(outcome.authoredRows).toBe(0);
    expect(outcome.soleMemberProject).toBe(false);
    // Only the template labels survive — five of them, since the written-in
    // step and the layer now belong to nobody the plan can name.
    expect(statements).toHaveLength(5);
    expect(statements.every((s) => s.binds[0] === "telar_template")).toBe(true);
  });

  it("names the member in the binding, not in the SQL", async () => {
    const { statements } = await planAuthorshipBackfill(workedInProject(4));
    const authored = statements.filter((s) => s.sql.includes("SET created_by ="));

    expect(authored).toHaveLength(2);
    expect(authored.map((s) => s.binds[0])).toEqual([4, 4]);
  });
});

describe("what every statement guarantees", () => {
  it("cannot touch a row that already carries an attribution", async () => {
    const { statements } = await planAuthorshipBackfill(workedInProject(4));

    // The guard is the guarantee: it lives in the SQL, so no ordering mistake
    // and no second run can overwrite an author D1 already holds.
    expect(statements.every((s) =>
      s.sql.includes("created_by IS NULL AND created_by_actor IS NULL"))).toBe(true);
  });

  it("addresses exactly one row, by id", async () => {
    const { statements } = await planAuthorshipBackfill(workedInProject(4));

    expect(statements.every((s) => /WHERE id = \? AND /.test(s.sql))).toBe(true);
  });

  it("renders to SQL the recovery's renderer will accept", async () => {
    // The end-to-end render is what caught the planner and the renderer
    // disagreeing last time; a plan nobody has rendered is a plan that throws
    // on its first real run.
    const { statements } = await planAuthorshipBackfill(workedInProject(4));
    const sql = renderRecoverySql(statements);

    expect(sql).toContain("SET created_by_actor = 'telar_template'");
    expect(sql).toContain("SET created_by = 4");
    expect(sql.split("\n")).toHaveLength(statements.length);
  });

  it("plans nothing for a project with no unattributed rows", async () => {
    const { outcome, statements } = await planAuthorshipBackfill({
      projectId: 99, soleMember: 4,
      stories: [], steps: [], layers: [], objects: [], terms: [], pages: [],
    });

    expect(statements).toEqual([]);
    expect(outcome.templateRows).toBe(0);
    expect(outcome.authoredRows).toBe(0);
  });
});
