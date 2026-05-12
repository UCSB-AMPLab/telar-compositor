/**
 * This file tests the presence-colour helpers in `membership.server.ts`.
 *
 * Covers:
 *   - setUserPresenceColor: write-through to every project_members row for the
 *     user in a single UPDATE bounded by WHERE user_id = ? (defence-in-depth).
 *   - assignPresenceColor (preference-prefer extension): prefer the user's
 *     existing chosen colour from other memberships when consistent and in
 *     palette; fall through to the legacy per-project palette pick otherwise.
 *
 * Mocking strategy mirrors tests/api.locale.test.ts: chainable drizzle spies
 * (`select().from().where()` and `update().set().where()`) so we can assert on
 * the SQL shape without spinning up miniflare. The `where` predicate is
 * captured (the actual SQL fragment object) so we can identify which
 * predicates the helper passes — used by Test 2 ("WHERE bound to user_id").
 *
 * @version v1.2.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// drizzle spies (mocked at module boundary below)
// ---------------------------------------------------------------------------

/** Calls to `db.select(...)` queue here in order. */
const selectCalls: Array<{
  fromArg: unknown;
  whereArg: unknown;
  /** What the awaited `.where()` returned for this call. */
  result: unknown;
}> = [];

/** Calls to `db.update(...)` queue here in order. */
const updateCalls: Array<{
  table: unknown;
  setArg: unknown;
  whereArg: unknown;
}> = [];

/** Sequence of results to return from `.where()` on chained `.select()` calls. */
let selectResultsQueue: unknown[][] = [];

function resetMocks() {
  selectCalls.length = 0;
  updateCalls.length = 0;
  selectResultsQueue = [];
}

vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => {
    return {
      select: (_cols?: unknown) => {
        const call: (typeof selectCalls)[number] = {
          fromArg: undefined,
          whereArg: undefined,
          result: undefined,
        };
        selectCalls.push(call);
        return {
          from: (table: unknown) => {
            call.fromArg = table;
            return {
              where: (predicate: unknown) => {
                call.whereArg = predicate;
                const nextResult = selectResultsQueue.shift() ?? [];
                call.result = nextResult;
                // Drizzle returns a thenable; emulate that.
                return Promise.resolve(nextResult);
              },
            };
          },
        };
      },
      update: (table: unknown) => {
        const call: (typeof updateCalls)[number] = {
          table,
          setArg: undefined,
          whereArg: undefined,
        };
        updateCalls.push(call);
        return {
          set: (values: unknown) => {
            call.setArg = values;
            return {
              where: (predicate: unknown) => {
                call.whereArg = predicate;
                return Promise.resolve(undefined);
              },
            };
          },
        };
      },
    };
  }),
}));

import { getDb } from "~/lib/db.server";
import {
  PRESENCE_PALETTE,
  assignPresenceColor,
  setUserPresenceColor,
} from "~/lib/membership.server";

beforeEach(() => {
  resetMocks();
});

// ---------------------------------------------------------------------------
// setUserPresenceColor
// ---------------------------------------------------------------------------

describe("setUserPresenceColor", () => {
  it("writes the colour to every project_members row for the user in a single UPDATE", async () => {
    const db = getDb({} as unknown as D1Database);
    await setUserPresenceColor(db, 42, PRESENCE_PALETTE[2]);

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].setArg).toEqual({ presence_color: PRESENCE_PALETTE[2] });
    // No SELECTs — write-through is a single statement.
    expect(selectCalls).toHaveLength(0);
  });

  it("does not affect rows for other users (WHERE bound to user_id)", async () => {
    const db = getDb({} as unknown as D1Database);
    await setUserPresenceColor(db, 99, PRESENCE_PALETTE[0]);

    expect(updateCalls).toHaveLength(1);
    // The captured `where` predicate is a drizzle SQL chunk with circular
    // refs (column -> table -> columns -> ...). Walk it with a cycle-safe
    // visitor and collect the string-valued leaves. We then assert the
    // collected strings reference both the column name `user_id` AND the
    // userId we passed (99). Defence-in-depth: a regression that swapped to
    // `id` or hardcoded a projectId would surface here.
    const wherePredicate = updateCalls[0].whereArg;
    const stringLeaves: string[] = [];
    const numberLeaves: number[] = [];
    const seen = new WeakSet<object>();
    const visit = (v: unknown): void => {
      if (v === null || v === undefined) return;
      if (typeof v === "string") {
        stringLeaves.push(v);
        return;
      }
      if (typeof v === "number") {
        numberLeaves.push(v);
        return;
      }
      if (typeof v !== "object") return;
      if (seen.has(v as object)) return;
      seen.add(v as object);
      for (const key of Object.keys(v as object)) {
        visit((v as Record<string, unknown>)[key]);
      }
    };
    visit(wherePredicate);
    expect(stringLeaves).toContain("user_id");
    expect(numberLeaves).toContain(99);
  });
});

// ---------------------------------------------------------------------------
// assignPresenceColor (preference-prefer extension)
// ---------------------------------------------------------------------------

describe("assignPresenceColor (preference-prefer extension)", () => {
  it("prefers the user's existing chosen colour when consistent across memberships and in palette", async () => {
    // Queue: first SELECT returns the user's other-membership colours (all #A06BD4).
    selectResultsQueue = [
      [
        { presence_color: PRESENCE_PALETTE[4] },
        { presence_color: PRESENCE_PALETTE[4] },
      ],
    ];

    const db = getDb({} as unknown as D1Database);
    const result = await assignPresenceColor(db, /* projectId */ 7, /* userId */ 42);

    expect(result).toBe(PRESENCE_PALETTE[4]);
    // Only ONE select call (the user-colour preference query). The legacy
    // per-project palette pick query is short-circuited because we found a
    // consistent in-palette preference.
    expect(selectCalls).toHaveLength(1);
    // Single UPDATE that writes the preferred colour to (projectId=7,userId=42).
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].setArg).toEqual({ presence_color: PRESENCE_PALETTE[4] });
  });

  it("falls back to per-project palette pick when user has no prior chosen colour (legacy path)", async () => {
    selectResultsQueue = [
      // user-colour query: no other memberships have a colour
      [],
      // per-project palette-pick query: this project also has nothing yet
      [],
    ];

    const db = getDb({} as unknown as D1Database);
    const result = await assignPresenceColor(db, 1, 42);

    // First unused palette colour for the project = PRESENCE_PALETTE[0]
    expect(result).toBe(PRESENCE_PALETTE[0]);
    expect(selectCalls).toHaveLength(2);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].setArg).toEqual({ presence_color: PRESENCE_PALETTE[0] });
  });

  it("falls back to per-project palette pick when user's other memberships have inconsistent colours", async () => {
    selectResultsQueue = [
      // user-colour query: distinct colours present (legacy state)
      [
        { presence_color: PRESENCE_PALETTE[1] },
        { presence_color: PRESENCE_PALETTE[3] },
      ],
      // per-project palette-pick query: PRESENCE_PALETTE[0] taken by someone else
      [{ presence_color: PRESENCE_PALETTE[0] }],
    ];

    const db = getDb({} as unknown as D1Database);
    const result = await assignPresenceColor(db, 1, 42);

    // First unused palette colour after [0] is [1]
    expect(result).toBe(PRESENCE_PALETTE[1]);
    expect(selectCalls).toHaveLength(2);
  });

  it("falls back to palette when the user's chosen colour is not in PRESENCE_PALETTE (legacy hex)", async () => {
    selectResultsQueue = [
      // user-colour query: a legacy non-palette hex
      [{ presence_color: "#deadbe" }, { presence_color: "#deadbe" }],
      // per-project palette-pick query: empty
      [],
    ];

    const db = getDb({} as unknown as D1Database);
    const result = await assignPresenceColor(db, 1, 42);

    expect(result).toBe(PRESENCE_PALETTE[0]);
    expect(selectCalls).toHaveLength(2);
  });
});
