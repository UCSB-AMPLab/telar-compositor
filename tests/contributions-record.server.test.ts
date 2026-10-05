/**
 * The record as it will be read, against a real database.
 *
 * The claims worth testing here are the ones a reader of the page would be
 * misled by if they were wrong, and every one of them is a property of the SQL
 * rather than of any pure function: that added and edited are different sets of
 * people, that a deleted step takes its counts with it, that a panel's words are
 * not also its step's, that nobody counted reads differently from wrote nothing,
 * and that no measure is ever sorted by value.
 *
 * The database is the migration chain replayed into memory, so migration 0051 is
 * exercised as SQL rather than trusted from `schema.ts`.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import * as schema from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";
import { getContributionRecord } from "~/lib/contributions.server";

const PROJECT = 1;
const ANA = 1;
const BEATRIZ = 2;

/** Drizzle bound to the real schema, so the record reads the tables it names. */
function bind(memory: MemoryD1) {
  return drizzle(asD1(memory), { schema });
}

let memory: MemoryD1;
let db: ReturnType<typeof bind>;

/** One project, two members, one story, and nothing else. */
function seed(): void {
  const run = (sql: string, ...binds: unknown[]) =>
    memory.raw.prepare(sql).run(...(binds as never[]));

  for (const [id, login, name] of [[ANA, "ana", "Ana"], [BEATRIZ, "bea", "Beatriz"]] as const) {
    run(
      "INSERT INTO users (id, github_id, github_login, github_name, encrypted_access_token, " +
      "encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      "VALUES (?, ?, ?, ?, 'x', 'x', 'x', 'x')",
      id, 1000 + id, login, name,
    );
  }
  run(
    "INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) " +
    "VALUES (?, ?, 'neogranadina/mujeres-y-trabajo', 1)",
    PROJECT, ANA,
  );
  for (const [user, role, colour] of [[ANA, "convenor", "#E47A6F"], [BEATRIZ, "collaborator", "#6B9FE4"]] as const) {
    run("INSERT INTO project_members (project_id, user_id, role, presence_color) VALUES (?, ?, ?, ?)",
      PROJECT, user, role, colour);
  }
  run("INSERT INTO stories (id, project_id, story_id, title) VALUES (1, ?, 'historia', 'Historia')", PROJECT);
}

/** A step, created by one person. */
function addStep(id: number, createdBy: number): void {
  memory.raw
    .prepare("INSERT INTO steps (id, story_id, step_number, created_by) VALUES (?, 1, ?, ?)")
    .run(id, id, createdBy);
}

/** A panel on a step, created by one person. */
function addPanel(id: number, stepId: number, createdBy: number): void {
  memory.raw
    .prepare("INSERT INTO layers (id, step_id, layer_number, created_by) VALUES (?, ?, 1, ?)")
    .run(id, stepId, createdBy);
}

/** One person having written in one entity, with or without a word count. */
function wroteIn(kind: string, entityId: number, userId: number, words: number | null): void {
  memory.raw
    .prepare(
      "INSERT INTO entity_contributors (project_id, entity_kind, entity_id, user_id, " +
      "first_edit_at, last_edit_at, words_written) VALUES (?, ?, ?, ?, '2026-09-01', '2026-09-02', ?)",
    )
    .run(PROJECT, kind, entityId, userId, words);
}

beforeEach(() => {
  memory = createMemoryD1();
  db = bind(memory);
  seed();
});

describe("added and edited are different questions", () => {
  it("credits the person who made a step and the person who wrote in it", async () => {
    addStep(1, ANA);
    wroteIn("step", 1, BEATRIZ, 40);

    const { members } = await getContributionRecord(db, PROJECT);
    const [ana, beatriz] = members;

    expect(ana.kinds.steps).toEqual({ added: 1, edited: 0, words: null });
    expect(beatriz.kinds.steps).toEqual({ added: 0, edited: 1, words: 40 });
  });

  it("reports the scaffolder and the writer as neither idle", async () => {
    // The cohort case the feature exists for: one student builds steps others
    // fill, another fills steps she did not build. Either measure alone reports
    // one of them as having contributed nothing.
    for (const id of [1, 2, 3]) addStep(id, ANA);
    for (const id of [1, 2, 3]) wroteIn("step", id, BEATRIZ, 120);

    const { members } = await getContributionRecord(db, PROJECT);

    expect(members[0].kinds.steps.added).toBe(3);
    expect(members[0].kinds.steps.edited).toBe(0);
    expect(members[1].kinds.steps.added).toBe(0);
    expect(members[1].kinds.steps.edited).toBe(3);
  });
});

describe("what the join excludes", () => {
  it("drops a contributor row whose entity has been deleted", async () => {
    // Nothing prunes entity_contributors when a step goes: the id is polymorphic
    // and carries no foreign key, so the join is the only thing keeping a
    // deleted step out of the count.
    addStep(1, ANA);
    wroteIn("step", 1, BEATRIZ, 40);
    wroteIn("step", 99, BEATRIZ, 500);

    const { members } = await getContributionRecord(db, PROJECT);

    expect(members[1].kinds.steps).toEqual({ added: 0, edited: 1, words: 40 });
  });

  it("counts a panel's words against the panel and not against its step", async () => {
    addStep(1, ANA);
    addPanel(9, 1, ANA);
    wroteIn("step", 1, ANA, 10);
    wroteIn("layer", 9, ANA, 200);

    const { members } = await getContributionRecord(db, PROJECT);

    expect(members[0].kinds.steps.words).toBe(10);
    expect(members[0].kinds.panels.words).toBe(200);
  });
});

describe("nobody counted against wrote nothing", () => {
  it("reports an uncounted row as uncounted, not as zero", async () => {
    addStep(1, ANA);
    wroteIn("step", 1, BEATRIZ, null);

    const { members, hasWordsAndTime } = await getContributionRecord(db, PROJECT);

    expect(members[1].kinds.steps.edited).toBe(1);
    expect(members[1].kinds.steps.words).toBeNull();
    expect(hasWordsAndTime).toBe(false);
  });

  it("reports a counted nought as a nought", async () => {
    addStep(1, ANA);
    wroteIn("step", 1, BEATRIZ, 0);

    const { members, hasWordsAndTime } = await getContributionRecord(db, PROJECT);

    expect(members[1].kinds.steps.words).toBe(0);
    expect(hasWordsAndTime).toBe(true);
  });

  it("sums the counted rows and ignores the uncounted ones", async () => {
    addStep(1, ANA);
    addStep(2, ANA);
    wroteIn("step", 1, BEATRIZ, 40);
    wroteIn("step", 2, BEATRIZ, null);

    const { members } = await getContributionRecord(db, PROJECT);

    expect(members[1].kinds.steps).toEqual({ added: 0, edited: 2, words: 40 });
  });
});

describe("time", () => {
  it("reads the two measures, writing inside editing", async () => {
    memory.raw
      .prepare(
        "INSERT INTO member_editing_time (project_id, user_id, editing_seconds, writing_seconds) " +
        "VALUES (?, ?, ?, ?)",
      )
      .run(PROJECT, ANA, 12180, 5760);

    const { members, hasWordsAndTime } = await getContributionRecord(db, PROJECT);

    expect(members[0].editingSeconds).toBe(12180);
    expect(members[0].writingSeconds).toBe(5760);
    expect(members[1].editingSeconds).toBe(0);
    expect(hasWordsAndTime).toBe(true);
  });
});

describe("the record is not a ranking", () => {
  it("returns members in alphabetical order whatever the numbers say", async () => {
    for (const id of [1, 2, 3, 4, 5]) addStep(id, BEATRIZ);

    const { members } = await getContributionRecord(db, PROJECT);

    expect(members.map((m) => m.displayName)).toEqual(["Ana", "Beatriz"]);
  });

  it("carries each person's presence colour, the one their cursor uses", async () => {
    const { members } = await getContributionRecord(db, PROJECT);

    expect(members.map((m) => m.color)).toEqual(["#E47A6F", "#6B9FE4"]);
  });
});

describe("a project nobody has touched", () => {
  it("reports zeros and no counted measures rather than failing", async () => {
    const { members, hasWordsAndTime } = await getContributionRecord(db, PROJECT);

    expect(members).toHaveLength(2);
    expect(members[0].kinds.glossary).toEqual({ added: 0, edited: 0, words: null });
    expect(hasWordsAndTime).toBe(false);
  });
});

/**
 * The panel's clock watches a figure the Durable Object holds, part of which
 * has not reached D1 yet. The loader hands that figure in, and it stands in
 * place of the stored one rather than beside it: the two overlap, and adding
 * them would count a person's last minute twice.
 */
describe("a figure passed in place of the stored one", () => {
  /** A db that fails the test if the time table is read at all. */
  function withoutTimeTable(): typeof db {
    return {
      all: async (query: unknown) => {
        if (JSON.stringify(query).includes("member_editing_time")) {
          throw new Error("member_editing_time was read while a figure was supplied");
        }
        return db.all(query as Parameters<typeof db.all>[0]);
      },
    } as unknown as typeof db;
  }

  function storeTime(userId: number, editing: number, writing: number): void {
    memory.raw
      .prepare(
        "INSERT INTO member_editing_time (project_id, user_id, editing_seconds, writing_seconds) " +
        "VALUES (?, ?, ?, ?)",
      )
      .run(PROJECT, userId, editing, writing);
  }

  it("does not read the time table when a figure is supplied", async () => {
    storeTime(ANA, 12180, 5760);

    const { members } = await getContributionRecord(withoutTimeTable(), PROJECT, [
      { userId: ANA, editingSeconds: 12240, writingSeconds: 5820 },
    ]);

    expect(members[0].editingSeconds).toBe(12240);
    expect(members[0].writingSeconds).toBe(5820);
  });

  it("leaves a person the figure omits at nothing, whatever D1 holds", async () => {
    storeTime(ANA, 12180, 5760);
    storeTime(BEATRIZ, 600, 60);

    const { members } = await getContributionRecord(db, PROJECT, [
      { userId: ANA, editingSeconds: 12240, writingSeconds: 5820 },
    ]);

    expect(members[1].editingSeconds).toBe(0);
    expect(members[1].writingSeconds).toBe(0);
  });

  it("counts the measures on the passed figure alone", async () => {
    const { hasWordsAndTime } = await getContributionRecord(db, PROJECT, [
      { userId: ANA, editingSeconds: 60, writingSeconds: 0 },
    ]);

    expect(hasWordsAndTime).toBe(true);
  });

  it("ignores a person who is not a member of the project", async () => {
    const { members } = await getContributionRecord(db, PROJECT, [
      { userId: 99, editingSeconds: 900, writingSeconds: 900 },
    ]);

    expect(members.map((m) => m.editingSeconds)).toEqual([0, 0]);
  });
});
