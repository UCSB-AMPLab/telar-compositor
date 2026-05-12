/**
 * This file pins the dashboard membership-server extensions —
 * `getUserProjectsWithStats(db, userId)`, the helper that joins
 * project_members against the seven per-entity tables (UNION ALL on
 * `last_edited_at`) so the dashboard can show recency for every project
 * the signed-in user belongs to.
 *
 * Existing `getUserProjects` regression tests also live here.
 *
 * @version v1.2.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { getUserProjects, getUserProjectsWithStats } from "~/lib/membership.server";

/**
 * Build a mock D1 db whose `select(...).from(...).where(...)` chain
 * returns a queue of pre-defined result arrays in the order tests
 * expect the helper to call them. `db.all(sql)` returns `unionResults`.
 * `db.select(...).groupBy(...)` is also supported via the same queue.
 */
function buildMockDb(opts: {
  selectQueue: any[][];
  unionResults: any[];
}) {
  let selectIdx = 0;
  const db: any = {
    select: vi.fn(() => {
      const result = opts.selectQueue[selectIdx] ?? [];
      selectIdx += 1;
      const chainable: any = {
        from: vi.fn(() => chainable),
        where: vi.fn(() => chainable),
        groupBy: vi.fn().mockResolvedValue(result),
      };
      // Allow direct await on the where(...) result for the simpler
      // getUserProjects path.
      chainable.then = (resolve: (v: any) => void) => resolve(result);
      return chainable;
    }),
    all: vi.fn().mockResolvedValue(opts.unionResults),
  };
  return db;
}

// ---------------------------------------------------------------------------
// Regression: existing getUserProjects signature unchanged
// ---------------------------------------------------------------------------

describe("getUserProjects (existing — regression guard)", () => {
  it("returns [] when the user has no memberships", async () => {
    const db: any = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([]),
        })),
      })),
    };

    const result = await getUserProjects(db, 999);
    expect(result).toEqual([]);
  });

  it("attaches userRole to each returned project row", async () => {
    let callCount = 0;
    const db: any = {
      select: vi.fn(() => {
        callCount += 1;
        if (callCount === 1) {
          return {
            from: vi.fn(() => ({
              where: vi
                .fn()
                .mockResolvedValue([
                  { project_id: 1, role: "convenor" },
                  { project_id: 2, role: "collaborator" },
                ]),
            })),
          };
        }
        return {
          from: vi.fn(() => ({
            where: vi
              .fn()
              .mockResolvedValue([
                { id: 1, github_repo_full_name: "u/r1" },
                { id: 2, github_repo_full_name: "u/r2" },
              ]),
          })),
        };
      }),
    };

    const result = await getUserProjects(db, 1);
    expect(result).toHaveLength(2);
    expect(result.find((p) => p.id === 1)?.userRole).toBe("convenor");
    expect(result.find((p) => p.id === 2)?.userRole).toBe("collaborator");
  });
});

// ---------------------------------------------------------------------------
// getUserProjectsWithStats — dashboard recency aggregation
// ---------------------------------------------------------------------------

describe("getUserProjectsWithStats", () => {
  it("returns [] when the user has no memberships", async () => {
    const db = buildMockDb({ selectQueue: [[]], unionResults: [] });
    const result = await getUserProjectsWithStats(db, 999);
    expect(result).toEqual([]);
  });

  it("returns each project with userRole + last_edited_at (string|null) + collaborator_count (number) and sorts most-recently-edited first", async () => {
    const db = buildMockDb({
      selectQueue: [
        // 1. getUserProjects: memberships
        [
          { project_id: 1, role: "convenor" },
          { project_id: 2, role: "collaborator" },
          { project_id: 3, role: "convenor" },
        ],
        // 2. getUserProjects: project rows
        [
          { id: 1, github_repo_full_name: "u/r1" },
          { id: 2, github_repo_full_name: "u/r2" },
          { id: 3, github_repo_full_name: "u/r3" },
        ],
        // 3. collaborator_count GROUP BY (excludes self) — 2 has 2 others, 1 has 0, 3 omitted (zero)
        [
          { project_id: 1, count: 0 },
          { project_id: 2, count: 2 },
        ],
      ],
      unionResults: [
        { project_id: 1, last_edited_at: "2026-04-01T00:00:00Z" },
        { project_id: 2, last_edited_at: "2026-05-01T00:00:00Z" },
        // project 3 has no edits → no row → null
      ],
    });

    const result = await getUserProjectsWithStats(db, 42);
    expect(result).toHaveLength(3);

    // Sort: project 2 (May) first, then project 1 (April), then project 3 (null last)
    expect(result.map((r) => r.id)).toEqual([2, 1, 3]);

    const p1 = result.find((r) => r.id === 1)!;
    const p2 = result.find((r) => r.id === 2)!;
    const p3 = result.find((r) => r.id === 3)!;

    expect(p1.userRole).toBe("convenor");
    expect(p2.userRole).toBe("collaborator");
    expect(p3.userRole).toBe("convenor");

    expect(p1.collaborator_count).toBe(0);
    expect(p2.collaborator_count).toBe(2);
    expect(p3.collaborator_count).toBe(0);

    expect(p1.last_edited_at).toBe("2026-04-01T00:00:00Z");
    expect(p2.last_edited_at).toBe("2026-05-01T00:00:00Z");
    expect(p3.last_edited_at).toBeNull();
  });

  it("issues exactly two db.all() calls — UNION split into two halves to stay under D1's 5-term compound SELECT limit", async () => {
    const db = buildMockDb({
      selectQueue: [
        [{ project_id: 1, role: "convenor" }],
        [{ id: 1, github_repo_full_name: "u/r" }],
        [],
      ],
      unionResults: [{ project_id: 1, last_edited_at: "2026-01-01" }],
    });
    await getUserProjectsWithStats(db, 1);
    expect(db.all).toHaveBeenCalledTimes(2);
  });
});
