/**
 * Pins the per-project scoping of object "used in N steps" counts.
 *
 * Regression: the objects loader counted step-references with a global
 * `GROUP BY object_id` across EVERY project, so a seeded object_id shared by
 * many projects (e.g. `telar-placeholder`) showed an inflated cross-project
 * total. The count must be scoped to the active project by joining steps to
 * their parent story and filtering on `stories.project_id`.
 */

import { describe, it, expect, vi } from "vitest";
import { objectStepCountQuery, getObjectStepCounts } from "~/lib/objects.server";

describe("objectStepCountQuery — per-project scoping", () => {
  it("joins steps to stories and filters on the active project_id", () => {
    const db = drizzleStub();
    const { sql, params } = objectStepCountQuery(db, 42).toSQL();
    // Scoped through the parent story, not a global GROUP BY.
    expect(sql).toContain("inner join");
    expect(sql).toContain("stories");
    expect(sql).toContain("project_id");
    expect(params).toContain(42);
  });
});

describe("getObjectStepCounts — row mapping", () => {
  it("maps object_id -> count and skips null object_id rows", async () => {
    const rows = [
      { object_id: "telar-placeholder", count: 3 },
      { object_id: null, count: 9 },
      { object_id: "burro", count: 1 },
    ];
    const db = stubReturning(rows);
    const counts = await getObjectStepCounts(db, 42);
    expect(counts).toEqual({ "telar-placeholder": 3, burro: 1 });
    expect(counts).not.toHaveProperty("null");
  });
});

/** A drizzle/d1 instance with no live binding — enough to build queries + toSQL(). */
function drizzleStub() {
  // Lazy import to keep the helper colocated with the test.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { drizzle } = require("drizzle-orm/d1");
  return drizzle({} as never);
}

/** A db whose query chain resolves to `rows` (for the mapping test). */
function stubReturning(rows: Array<{ object_id: string | null; count: number }>) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "from", "innerJoin", "where"]) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.groupBy = vi.fn().mockResolvedValue(rows);
  return chain as never;
}
