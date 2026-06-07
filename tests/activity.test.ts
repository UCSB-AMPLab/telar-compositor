/**
 * This file tests the activity-log service in `app/lib/activity.server.ts`:
 *
 *   - recordActivity inserts ONE row with the shape
 *     { project_id, actor_user_id, verb, entity_type, entity_id } (+ optional
 *     entity_label) — coarse, one row per save.
 *   - actor_user_id is whatever the caller hands it (the server-resolved
 *     userId); the service never reads a request field, so the spoofing gate
 *     lives at the call site. Here we assert it persists the value verbatim.
 *   - verb / entity_type are validated against fixed allow-sets before INSERT
 *     (repudiation gate) — an invalid value is a no-op.
 *   - Retention prune drops rows beyond the per-project cap in the same call
 *     via a project-scoped DELETE.
 *   - getRecentActivity returns the last 5 rows, project-scoped
 *     (WHERE project_id = ?), ordered created_at DESC, joined to users for the
 *     avatar, failing open to [] on query failure.
 *
 * Mocking strategy mirrors tests/membership.server.test.ts: chainable drizzle
 * spies (`insert().values()`, `run(sql)`, `select().from().leftJoin().where()
 * .orderBy().limit()`) so we assert on the SQL shape without spinning up
 * miniflare.
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// drizzle spies (mocked at module boundary below)
// ---------------------------------------------------------------------------

/** Calls to `db.insert(table).values(values)` queue here in order. */
const insertCalls: Array<{ table: unknown; values: unknown }> = [];

/** Calls to `db.run(sql)` queue here in order (the prune DELETE). */
const runCalls: Array<{ arg: unknown }> = [];

/** Captured shape of the single `db.select(...)` chain getRecentActivity builds. */
interface SelectCapture {
  columns: unknown;
  fromArg: unknown;
  leftJoinArgs: unknown[];
  whereArg: unknown;
  orderByArgs: unknown[];
  limitArg: number | undefined;
}
const selectCalls: SelectCapture[] = [];

/** Result the select chain resolves to (set per-test). */
let selectResult: unknown[] = [];
/** When true, the select chain throws to exercise the fail-open path. */
let selectThrows = false;
/** When true, insert throws to exercise recordActivity's fail-open path. */
let insertThrows = false;

function resetMocks() {
  insertCalls.length = 0;
  runCalls.length = 0;
  selectCalls.length = 0;
  selectResult = [];
  selectThrows = false;
  insertThrows = false;
}

vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => {
    return {
      insert: (table: unknown) => ({
        values: (values: unknown) => {
          insertCalls.push({ table, values });
          if (insertThrows) throw new Error("insert failed");
          return Promise.resolve(undefined);
        },
      }),
      run: (arg: unknown) => {
        runCalls.push({ arg });
        return Promise.resolve(undefined);
      },
      select: (columns?: unknown) => {
        const capture: SelectCapture = {
          columns,
          fromArg: undefined,
          leftJoinArgs: [],
          whereArg: undefined,
          orderByArgs: [],
          limitArg: undefined,
        };
        selectCalls.push(capture);
        const chain = {
          from: (table: unknown) => {
            capture.fromArg = table;
            return chain;
          },
          leftJoin: (...args: unknown[]) => {
            capture.leftJoinArgs = args;
            return chain;
          },
          where: (predicate: unknown) => {
            capture.whereArg = predicate;
            return chain;
          },
          orderBy: (...args: unknown[]) => {
            capture.orderByArgs = args;
            return chain;
          },
          limit: (n: number) => {
            capture.limitArg = n;
            if (selectThrows) return Promise.reject(new Error("query failed"));
            return Promise.resolve(selectResult);
          },
        };
        return chain;
      },
    };
  }),
}));

import { getDb } from "~/lib/db.server";
import {
  recordActivity,
  getRecentActivity,
  ACTIVITY_RETENTION_CAP,
} from "~/lib/activity.server";

beforeEach(() => {
  resetMocks();
});

// Cycle-safe visitor that collects string and number leaves from a drizzle
// SQL fragment (which carries circular column→table→columns refs).
function collectLeaves(v: unknown): { strings: string[]; numbers: number[] } {
  const strings: string[] = [];
  const numbers: number[] = [];
  const seen = new WeakSet<object>();
  const visit = (node: unknown): void => {
    if (node === null || node === undefined) return;
    if (typeof node === "string") {
      strings.push(node);
      return;
    }
    if (typeof node === "number") {
      numbers.push(node);
      return;
    }
    if (typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    for (const key of Object.keys(node as object)) {
      visit((node as Record<string, unknown>)[key]);
    }
  };
  visit(v);
  return { strings, numbers };
}

// ---------------------------------------------------------------------------
// recordActivity — INSERT row shape
// ---------------------------------------------------------------------------

describe("recordActivity", () => {
  it("inserts one row with project_id, actor_user_id, verb, entity_type, entity_id", async () => {
    const db = getDb({} as unknown as D1Database);
    await recordActivity(db, {
      projectId: 7,
      actorUserId: 42,
      verb: "edited",
      entityType: "story",
      entityId: "sondondo-valley",
      entityLabel: "Sondondo Valley",
    });

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].values).toEqual({
      project_id: 7,
      actor_user_id: 42,
      verb: "edited",
      entity_type: "story",
      entity_id: "sondondo-valley",
      entity_label: "Sondondo Valley",
    });
  });

  it("persists the server-resolved actor_user_id verbatim (no client-supplied value read)", async () => {
    const db = getDb({} as unknown as D1Database);
    await recordActivity(db, {
      projectId: 1,
      actorUserId: 99,
      verb: "added",
      entityType: "object",
      entityId: "obj-1",
    });

    expect(insertCalls).toHaveLength(1);
    expect((insertCalls[0].values as { actor_user_id: number }).actor_user_id).toBe(99);
  });

  it("defaults optional entity_id / entity_label / actor_user_id to null", async () => {
    const db = getDb({} as unknown as D1Database);
    await recordActivity(db, {
      projectId: 3,
      actorUserId: null,
      verb: "published",
      entityType: "site",
    });

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].values).toEqual({
      project_id: 3,
      actor_user_id: null,
      verb: "published",
      entity_type: "site",
      entity_id: null,
      entity_label: null,
    });
  });

  it("is a no-op for an invalid verb (repudiation gate — never inserts free text)", async () => {
    const db = getDb({} as unknown as D1Database);
    await recordActivity(db, {
      projectId: 7,
      actorUserId: 42,
      // @ts-expect-error — deliberately invalid verb to exercise the gate
      verb: "deleted-everything",
      entityType: "story",
      entityId: "x",
    });

    expect(insertCalls).toHaveLength(0);
    expect(runCalls).toHaveLength(0);
  });

  it("is a no-op for an invalid entity_type", async () => {
    const db = getDb({} as unknown as D1Database);
    await recordActivity(db, {
      projectId: 7,
      actorUserId: 42,
      verb: "edited",
      // @ts-expect-error — deliberately invalid entity_type to exercise the gate
      entityType: "secret",
      entityId: "x",
    });

    expect(insertCalls).toHaveLength(0);
  });

  it("prunes rows beyond the per-project retention cap in the same call", async () => {
    const db = getDb({} as unknown as D1Database);
    await recordActivity(db, {
      projectId: 7,
      actorUserId: 42,
      verb: "edited",
      entityType: "story",
      entityId: "x",
    });

    // One INSERT followed by one prune DELETE.
    expect(insertCalls).toHaveLength(1);
    expect(runCalls).toHaveLength(1);

    // The prune is project-scoped (references project_id and the project we
    // wrote to) and bounded by the retention cap.
    const { strings, numbers } = collectLeaves(runCalls[0].arg);
    expect(strings.some((s) => s.includes("project_id"))).toBe(true);
    expect(numbers).toContain(7);
    expect(numbers).toContain(ACTIVITY_RETENTION_CAP);
  });

  // Regression: the editor-edit path (DO snapshot loop) prunes inline
  // using the SAME cap as recordActivity. Both must resolve to one constant so
  // the retention cap can never drift between the two emit paths.
  it("shares ACTIVITY_RETENTION_CAP with the DO snapshot path (single source of truth)", async () => {
    const helpers = await import("../workers/collaboration-helpers");
    expect(helpers.ACTIVITY_RETENTION_CAP).toBe(ACTIVITY_RETENTION_CAP);
  });

  it("fails open (no throw) when the INSERT throws", async () => {
    insertThrows = true;
    const db = getDb({} as unknown as D1Database);
    await expect(
      recordActivity(db, {
        projectId: 7,
        actorUserId: 42,
        verb: "edited",
        entityType: "story",
        entityId: "x",
      }),
    ).resolves.toBeUndefined();

    // INSERT was attempted; the prune never ran because the throw short-circuited.
    expect(insertCalls).toHaveLength(1);
    expect(runCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getRecentActivity — last-5, project-scoped, DESC, joined to users
// ---------------------------------------------------------------------------

describe("getRecentActivity", () => {
  it("returns the last 5 rows, project-scoped (WHERE project_id = ?), created_at DESC, joined to users", async () => {
    selectResult = [
      {
        id: 3,
        verb: "edited",
        entity_type: "story",
        entity_id: "s3",
        entity_label: "Three",
        created_at: "2026-05-25T03:00:00Z",
        actor_user_id: 42,
        actor_github_id: 1001,
        actor_github_login: "alice",
        actor_github_name: "Alice",
      },
    ];

    const db = getDb({} as unknown as D1Database);
    const rows = await getRecentActivity(db, 7);

    expect(rows).toEqual(selectResult);
    expect(selectCalls).toHaveLength(1);

    const capture = selectCalls[0];
    // Default limit is 5.
    expect(capture.limitArg).toBe(5);
    // A left join to users was issued (avatar lookup).
    expect(capture.leftJoinArgs.length).toBeGreaterThan(0);
    // The WHERE predicate is bound to project_id AND the project we passed (7).
    const where = collectLeaves(capture.whereArg);
    expect(where.strings.some((s) => s.includes("project_id"))).toBe(true);
    expect(where.numbers).toContain(7);
    // ORDER BY references created_at (newest first).
    const order = collectLeaves(capture.orderByArgs);
    expect(order.strings.some((s) => s.includes("created_at"))).toBe(true);
  });

  it("honours a custom limit argument", async () => {
    selectResult = [];
    const db = getDb({} as unknown as D1Database);
    await getRecentActivity(db, 7, 20);
    expect(selectCalls[0].limitArg).toBe(20);
  });

  it("fails open to [] on query failure (no error banner)", async () => {
    selectThrows = true;
    const db = getDb({} as unknown as D1Database);
    const rows = await getRecentActivity(db, 7);
    expect(rows).toEqual([]);
  });
});
