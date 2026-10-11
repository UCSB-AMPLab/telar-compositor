/**
 * This file pins the dashboard membership-server extensions —
 * `getUserProjectsWithStats(db, userId)`, the helper that joins
 * project_members against the seven per-entity tables (UNION ALL on
 * `last_edited_at`) so the dashboard can show recency for every project
 * the signed-in user belongs to.
 *
 * Existing `getUserProjects` regression tests also live here.
 *
 * @version v1.5.4-beta
 */

import { describe, it, expect, vi } from "vitest";
import {
  getUserProjects,
  getUserProjectsWithStats,
  resolveActiveProject,
} from "~/lib/membership.server";

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

// ---------------------------------------------------------------------------
// resolveActiveProject — membership-scoped active-project resolution
//
// This is the resolution the /dashboard shared action endpoint (and the
// fourteen other adopters, via resolveActiveProjectFromRequest) now delegate
// to. The candidate set is always getUserProjects(userId), so a session's
// activeProjectId can only ever select one of the caller's OWN projects or
// fall back to their first one — it can never surface a project the caller
// has no membership in.
// ---------------------------------------------------------------------------

/**
 * Two-project user. getUserProjects issues two selects: first the membership
 * rows (project_id + role), then the project rows by id; the resolver then
 * reads the active site's own row. Mirror that order so the real function
 * runs unmodified.
 */
function buildTwoProjectDb(activeId: number): any {
  let callCount = 0;
  return {
    select: vi.fn(() => {
      callCount += 1;
      if (callCount === 1) {
        return {
          from: vi.fn(() => ({
            where: vi.fn().mockResolvedValue([
              { project_id: 1, role: "convenor" },
              { project_id: 2, role: "collaborator" },
            ]),
          })),
        };
      }
      const rows = [
        { id: 1, github_repo_full_name: "u/r1" },
        { id: 2, github_repo_full_name: "u/r2" },
      ];
      if (callCount === 2) {
        return {
          from: vi.fn(() => ({ where: vi.fn().mockResolvedValue(rows) })),
        };
      }
      // The active site's own row: where(id).limit(1).
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([rows[activeId - 1]]),
          })),
        })),
      };
    }),
  };
}

describe("resolveActiveProject", () => {
  it("returns the session's project + role when the id belongs to the user", async () => {
    const result = await resolveActiveProject(buildTwoProjectDb(2), 7, 2);
    expect(result?.project.id).toBe(2);
    expect(result?.userRole).toBe("collaborator");
  });

  it("falls back to the first project when the session id is stale (not a project the user belongs to)", async () => {
    const result = await resolveActiveProject(buildTwoProjectDb(1), 7, 999);
    expect(result?.project.id).toBe(1);
    expect(result?.userRole).toBe("convenor");
  });

  it("falls back to the first project when the session id is absent", async () => {
    const result = await resolveActiveProject(buildTwoProjectDb(1), 7, undefined);
    expect(result?.project.id).toBe(1);
    expect(result?.userRole).toBe("convenor");
  });

  it("never resolves a non-member id to another user's project — resolution stays within the caller's own projects", async () => {
    // 42 is a real project id elsewhere in the system but NOT one this user
    // belongs to. The membership-scoped candidate set means the only possible
    // outcomes are project 1 or 2; 42 can never be returned.
    const result = await resolveActiveProject(buildTwoProjectDb(1), 7, 42);
    expect([1, 2]).toContain(result?.project.id);
    expect(result?.project.id).not.toBe(42);
  });

  it("returns null when the user has no memberships at all", async () => {
    const db: any = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([]),
        })),
      })),
    };
    const result = await resolveActiveProject(db, 999, 5);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Column selection — the listing never asks D1 for the collaborative document
// ---------------------------------------------------------------------------

/** Records the column map each `select(...)` is given. */
function buildRecordingDb(): { db: any; selects: any[] } {
  const selects: any[] = [];
  const db: any = {
    select: vi.fn((fields?: any) => {
      selects.push(fields);
      const result =
        selects.length === 1 ? [{ project_id: 1, role: "convenor" }] : [{ id: 1 }];
      const chainable: any = {
        from: vi.fn(() => chainable),
        where: vi.fn(() => chainable),
        limit: vi.fn().mockResolvedValue(result),
        groupBy: vi.fn().mockResolvedValue([]),
      };
      chainable.then = (resolve: (v: any) => void) => resolve(result);
      return chainable;
    }),
    all: vi.fn().mockResolvedValue([]),
  };
  return { db, selects };
}

describe("project listing column selection", () => {
  it("getUserProjects names its columns and omits yjs_state and publish_snapshot", async () => {
    const { db, selects } = buildRecordingDb();
    await getUserProjects(db, 1);
    const projectSelect = selects[1];
    expect(projectSelect).toBeDefined();
    expect(Object.keys(projectSelect)).toContain("id");
    expect(Object.keys(projectSelect)).not.toContain("yjs_state");
    expect(Object.keys(projectSelect)).not.toContain("publish_snapshot");
  });

  it("getUserProjectsWithStats reads the project rows through the same narrow select", async () => {
    const { db, selects } = buildRecordingDb();
    await getUserProjectsWithStats(db, 1);
    expect(Object.keys(selects[1])).not.toContain("yjs_state");
    expect(Object.keys(selects[1])).not.toContain("publish_snapshot");
  });

  it("resolveActiveProject reads the active row without yjs_state and with publish_snapshot", async () => {
    const { db, selects } = buildRecordingDb();
    await resolveActiveProject(db, 1, 1);
    const activeSelect = selects[2];
    expect(Object.keys(activeSelect)).not.toContain("yjs_state");
    expect(Object.keys(activeSelect)).toContain("publish_snapshot");
  });
});
