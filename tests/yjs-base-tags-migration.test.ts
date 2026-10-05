/**
 * The schema-only step that adds `yjs_generation` and `yjs_seq` to
 * `projects` (migration 0052). Nothing reads or writes either column at
 * this step — this pins the three facts the loader arriving with the
 * second deploy depends on: the columns exist, both are nullable, and a
 * row written before this migration (or by any code that still ignores
 * them) reads back NULL on both rather than some other default.
 *
 * `tests/schema-is-current.test.ts` already checks every table's columns,
 * types and nullability against `schema.ts` in general; this suite is
 * narrower and reads on purpose, pinning the one migration step by name
 * so a future edit to either file that drops or renames a column here
 * fails right at this test rather than only in the general sweep.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { InferSelectModel } from "drizzle-orm";

import { createMemoryD1, type MemoryD1 } from "./helpers/d1-memory";
import { projects } from "~/db/schema";

let memory: MemoryD1;

beforeAll(() => {
  memory = createMemoryD1();
});

afterAll(() => {
  memory.close();
});

function projectsColumns(): Map<string, Record<string, unknown>> {
  const rows = memory.raw.prepare(`PRAGMA table_info("projects")`).all() as Array<
    Record<string, unknown>
  >;
  return new Map(rows.map((row) => [String(row.name), row]));
}

describe("0052 — projects.yjs_generation / yjs_seq", () => {
  it("adds both columns as nullable INTEGER", () => {
    const columns = projectsColumns();

    expect(columns.has("yjs_generation")).toBe(true);
    expect(columns.has("yjs_seq")).toBe(true);

    for (const name of ["yjs_generation", "yjs_seq"]) {
      const column = columns.get(name)!;
      expect(String(column.type).toUpperCase()).toBe("INTEGER");
      // notnull = 0 means SQLite will accept NULL for the column.
      expect(column.notnull).toBe(0);
    }
  });

  it("reads NULL on both columns for a row inserted without them", () => {
    memory.raw.exec(
      "INSERT INTO users (id, github_id, github_login, encrypted_access_token, " +
        "encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
        "VALUES (1, 1, 'u', 'e', 'e', '2099-01-01', '2099-01-01')",
    );
    memory.raw.exec(
      "INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) " +
        "VALUES (1, 1, 'o/a', 1)",
    );

    const row = memory.raw
      .prepare("SELECT yjs_generation, yjs_seq FROM projects WHERE id = 1")
      .get() as { yjs_generation: unknown; yjs_seq: unknown };

    expect(row.yjs_generation).toBeNull();
    expect(row.yjs_seq).toBeNull();
  });

  it("types both columns as nullable numbers in the Drizzle schema", () => {
    type ProjectRow = InferSelectModel<typeof projects>;

    // Typecheck-only: these assignments fail `npm run typecheck` if either
    // column stops being exactly `number | null` — narrowed to `number`
    // would reject the `null` arm, and widened to `unknown`/`string` would
    // reject the `number` arm.
    const generation: ProjectRow["yjs_generation"] = null;
    const seq: ProjectRow["yjs_seq"] = null;
    const generationAsNumber: ProjectRow["yjs_generation"] = 1;
    const seqAsNumber: ProjectRow["yjs_seq"] = 1;

    expect([generation, seq, generationAsNumber, seqAsNumber]).toEqual([null, null, 1, 1]);
  });
});
