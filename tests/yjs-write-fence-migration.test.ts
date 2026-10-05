/**
 * The schema half of the write fence: `projects.yjs_write`, the two triggers on
 * `projects`, and the `yjs_write_guard` table and its trigger (migration 0053).
 *
 * `tests/schema-is-current.test.ts` already checks every table's columns,
 * types and nullability against `schema.ts` in general, and it knows nothing
 * about triggers, which no Drizzle schema declares. This suite is narrower and
 * reads on purpose, pinning the one migration step by name: the column's
 * default is what makes the fence inert on every row that predates it, and the
 * three triggers are what the fence is.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { InferSelectModel } from "drizzle-orm";

import { createMemoryD1, type MemoryD1 } from "./helpers/d1-memory";
import { projects, yjs_write_guard } from "~/db/schema";

let memory: MemoryD1;

beforeAll(() => {
  memory = createMemoryD1();
});

afterAll(() => {
  memory.close();
});

function columns(table: string): Map<string, Record<string, unknown>> {
  const rows = memory.raw.prepare(`PRAGMA table_info("${table}")`).all() as Array<
    Record<string, unknown>
  >;
  return new Map(rows.map((row) => [String(row.name), row]));
}

function triggerNames(): string[] {
  return (
    memory.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all() as Array<Record<string, unknown>>
  ).map((row) => String(row.name));
}

describe("0053 — projects.yjs_write and the write guard", () => {
  it("adds the revision as a NOT NULL INTEGER defaulting to 0", () => {
    const column = columns("projects").get("yjs_write");

    expect(column).toBeDefined();
    expect(String(column!.type).toUpperCase()).toBe("INTEGER");
    // notnull = 1: no row can carry a NULL revision, so the fence's condition
    // is always a comparison of numbers.
    expect(column!.notnull).toBe(1);
    expect(String(column!.dflt_value)).toBe("0");
  });

  it("reads 0 on a row inserted without it, which is what leaves the fence inert", () => {
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
      .prepare("SELECT yjs_write FROM projects WHERE id = 1")
      .get() as { yjs_write: unknown };

    expect(row.yjs_write).toBe(0);
  });

  it("creates the guard table with its two NOT NULL columns", () => {
    const guard = columns("yjs_write_guard");

    expect([...guard.keys()].sort()).toEqual(["expected", "project_id"]);
    for (const name of ["project_id", "expected"]) {
      expect(String(guard.get(name)!.type).toUpperCase()).toBe("INTEGER");
      expect(guard.get(name)!.notnull).toBe(1);
    }
  });

  it("creates the three triggers the fence is made of", () => {
    expect(triggerNames()).toEqual(
      expect.arrayContaining([
        "projects_yjs_fence",
        "projects_yjs_write_monotonic",
        "yjs_write_guard_assert",
      ]),
    );
  });

  it("types the revision as a number and declares the guard table in the schema", () => {
    type ProjectRow = InferSelectModel<typeof projects>;
    type GuardRow = InferSelectModel<typeof yjs_write_guard>;

    // Typecheck-only: these fail `npm run typecheck` if the revision stops
    // being exactly `number` — widened to `number | null` would accept the
    // null the column cannot hold.
    const revision: ProjectRow["yjs_write"] = 3;
    const guard: GuardRow = { project_id: 1, expected: 2 };

    expect([revision, guard.project_id, guard.expected]).toEqual([3, 1, 2]);
  });
});
