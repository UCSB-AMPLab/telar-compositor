/**
 * The side effects a course redemption has, and the ones leaving reverses.
 *
 * `join-codes.server.ts` decides whether a code admits a site and writes the
 * parent link; this module is everything that must follow — the collection
 * preloaded, the staff copied down, the fan-out when staff themselves come and
 * go, and the leave sequence F2's routes call rather than reimplement.
 *
 * Idempotence is what this suite is for, and it is established by RUNNING the
 * repeat, not by asserting the shape of a statement. The database is real:
 * `tests/helpers/d1-memory.ts` replays the migration chain into an in-memory
 * SQLite and hands Drizzle a D1-shaped binding, so the `ON CONFLICT DO NOTHING`
 * that makes the copy-down re-runnable, the `WHERE role = 'instructor'` that
 * keeps a departure from orphaning a site, and the compare-and-set on the
 * parent link are exercised as SQL.
 *
 * Four repeats a classroom actually produces, each of which must be a no-op:
 * a convenor who submits the join form twice, a site already attached to this
 * course offered a second code of it, a TA already admitted under a different
 * code, and the course convenor — staff by definition — redeeming their own
 * course.
 *
 * The interleavings are established the same way, by running them. Every
 * sequence here spans an await, and `interleavedDb` lands a real concurrent
 * request at the seam — a leave between the copy-down and the transfer, a rival
 * course attaching while the markers clear, a removal overtaking a fan-out — so
 * a test fails when the write trusts the precondition it was called with rather
 * than the one that holds when it runs. A fixture that never establishes the
 * precondition would make such a test green whatever the code did, which is why
 * the fan-out cases put their TA on the course.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";

import * as schema from "~/db/schema";
import { users, projects, project_members, project_invites, objects } from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";
import {
  listCourseChildren,
  listCourseStaff,
  copyStaffToChild,
  applyRedemptionSideEffects,
  fanOutStaffJoin,
  fanOutStaffDeparture,
  detachChildFromCourse,
} from "~/lib/course-membership.server";
import type { CourseMembershipEnv } from "~/lib/course-membership.server";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;

const HOUR = 60 * 60 * 1000;
const future = () => new Date(Date.now() + 30 * 24 * HOUR).toISOString();

let nextUser = 0;
async function seedUser(): Promise<number> {
  nextUser += 1;
  const rows = await db
    .insert(users)
    .values({
      github_id: 1000 + nextUser,
      github_login: `user${nextUser}`,
      encrypted_access_token: "enc",
      encrypted_refresh_token: "enc",
      access_token_expires_at: future(),
      refresh_token_expires_at: future(),
    })
    .returning({ id: users.id });
  return rows[0].id;
}

let nextRepo = 0;
async function seedProject(
  ownerId: number,
  options: { kind?: "site" | "course"; parent?: number | null } = {},
): Promise<number> {
  nextRepo += 1;
  const rows = await db
    .insert(projects)
    .values({
      user_id: ownerId,
      github_repo_full_name: `owner/repo${nextRepo}`,
      installation_id: 1,
      kind: options.kind ?? "site",
      parent_project_id: options.parent ?? null,
    })
    .returning({ id: projects.id });
  const projectId = rows[0].id;
  await db.insert(project_members).values({
    project_id: projectId,
    user_id: ownerId,
    role: "convenor",
    joined_at: new Date().toISOString(),
  });
  return projectId;
}

async function addMember(
  projectId: number,
  userId: number,
  role: "convenor" | "collaborator" | "instructor",
  joinedViaInviteId: number | null = null,
): Promise<void> {
  await db.insert(project_members).values({
    project_id: projectId,
    user_id: userId,
    role,
    joined_at: new Date().toISOString(),
    joined_via_invite_id: joinedViaInviteId,
  });
}

async function seedInvite(projectId: number): Promise<number> {
  const rows = await db
    .insert(project_invites)
    .values({
      project_id: projectId,
      token: `TOKEN${projectId}${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      conferred_role: "collaborator",
      expires_at: null,
    })
    .returning({ id: project_invites.id });
  return rows[0].id;
}

let nextObject = 0;
async function seedObject(
  projectId: number,
  overrides: { source_url?: string | null; course_project_id?: number | null } = {},
): Promise<string> {
  nextObject += 1;
  const objectId = `obj-${nextObject}`;
  await db.insert(objects).values({
    project_id: projectId,
    object_id: objectId,
    title: `Object ${nextObject}`,
    source_url:
      overrides.source_url === undefined
        ? "https://iiif.example.org/manifest.json"
        : overrides.source_url,
    course_project_id: overrides.course_project_id ?? null,
  });
  return objectId;
}

async function memberRows(projectId: number) {
  return db.select().from(project_members).where(eq(project_members.project_id, projectId));
}

async function memberRow(projectId: number, userId: number) {
  const rows = await db
    .select()
    .from(project_members)
    .where(
      and(eq(project_members.project_id, projectId), eq(project_members.user_id, userId)),
    )
    .limit(1);
  return rows[0];
}

async function projectRow(id: number) {
  const rows = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  return rows[0];
}

async function removeMember(projectId: number, userId: number): Promise<void> {
  await db
    .delete(project_members)
    .where(
      and(eq(project_members.project_id, projectId), eq(project_members.user_id, userId)),
    );
}

// ---------------------------------------------------------------------------
// A seam to interleave a concurrent request into
// ---------------------------------------------------------------------------

/** The slice of the D1 statement surface the shim implements. */
interface RawStatement {
  bind(...params: unknown[]): RawStatement;
  all(): Promise<unknown>;
  run(): Promise<unknown>;
  first(column?: string): Promise<unknown>;
  raw(): Promise<unknown>;
}

/**
 * A second handle on the same database whose first statement matching
 * `pattern` runs `action` the moment it completes.
 *
 * The races this module has to survive are all one shape: a sequence awaits
 * something, and the enrolment or the standing it was called with changes
 * before its next statement runs. Driving the concurrent request from the seam
 * itself puts it exactly there, and leaves the SQL on both sides real. `action`
 * uses the plain `db`, so it is not interleaved into in turn.
 */
function interleavedDb(pattern: RegExp, action: () => Promise<void>) {
  const base = asD1(memory) as unknown as { prepare(sql: string): RawStatement };
  let armed = true;

  async function fire<T>(result: T, statementSql: string): Promise<T> {
    if (armed && pattern.test(statementSql)) {
      armed = false;
      await action();
    }
    return result;
  }

  function wrap(statement: RawStatement, statementSql: string): RawStatement {
    return {
      bind: (...params: unknown[]) => wrap(statement.bind(...params), statementSql),
      all: async () => fire(await statement.all(), statementSql),
      run: async () => fire(await statement.run(), statementSql),
      first: async (column?: string) => fire(await statement.first(column), statementSql),
      raw: async () => fire(await statement.raw(), statementSql),
    };
  }

  const binding = {
    prepare: (statementSql: string) => wrap(base.prepare(statementSql), statementSql),
  };
  return drizzle(binding as unknown as D1Database, { schema });
}

// ---------------------------------------------------------------------------
// A fake COLLABORATION binding
// ---------------------------------------------------------------------------

interface DoCall {
  /** The DO name the stub was addressed by — the project id, as a string. */
  stubName: string;
  path: string;
  /** `?userId=` where the route takes one. */
  userId: string | null;
  body: Record<string, unknown> | null;
}

/**
 * Records every DO request and answers per path. `fail` names paths that
 * should answer 503, so a test can drive a partial failure without mocking the
 * module under test, and `during` runs a concurrent request while one is in
 * flight — the Durable Object round trip is the longest await in the leave
 * sequence and the one another course can attach inside of.
 */
function fakeEnv(
  options: { fail?: string[]; during?: (path: string) => Promise<void> } = {},
): {
  env: CourseMembershipEnv;
  calls: DoCall[];
} {
  const calls: DoCall[] = [];
  const fail = new Set(options.fail ?? []);
  let lastName = "";
  const env: CourseMembershipEnv = {
    SESSION_SECRET: "test-secret",
    COLLABORATION: {
      idFromName: (name: string) => {
        lastName = name;
        return name;
      },
      get: (id: unknown) => ({
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          const raw = await req.text();
          calls.push({
            stubName: String(id ?? lastName),
            path: url.pathname,
            userId: url.searchParams.get("userId"),
            body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
          });
          if (options.during) await options.during(url.pathname);
          if (fail.has(url.pathname)) {
            return new Response("snapshot_blocked", { status: 503 });
          }
          if (url.pathname === "/clear-course-markers") {
            return Response.json({ cleared: 1 });
          }
          if (url.pathname === "/ingest-sync") {
            return Response.json({ applied: { objectInsert: 1 }, skipped: {} });
          }
          return new Response("OK", { status: 200 });
        },
      }),
    },
  };
  return { env, calls };
}

const callsTo = (calls: DoCall[], path: string) => calls.filter((c) => c.path === path);

beforeEach(() => {
  memory = createMemoryD1();
  db = drizzle(asD1(memory), { schema });
});

afterEach(() => {
  vi.restoreAllMocks();
  memory.close();
});

// ---------------------------------------------------------------------------
// Who the staff are, and who the children are
// ---------------------------------------------------------------------------

describe("listCourseStaff", () => {
  it("is the course convenor plus its instructor members, and nobody else", async () => {
    const convenor = await seedUser();
    const ta = await seedUser();
    const stray = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    await addMember(course, ta, "instructor");
    // Course membership is staff only, so a collaborator row here is an
    // anomaly rather than a standing — it is not staff and is not copied down.
    await addMember(course, stray, "collaborator");

    expect((await listCourseStaff(db, course)).sort()).toEqual([convenor, ta].sort());
  });
});

describe("listCourseChildren", () => {
  it("reads the parent link, which is the enrolment record", async () => {
    const owner = await seedUser();
    const course = await seedProject(owner, { kind: "course" });
    const childA = await seedProject(await seedUser(), { parent: course });
    const childB = await seedProject(await seedUser(), { parent: course });
    await seedProject(await seedUser());
    await seedProject(await seedUser(), { parent: await seedProject(owner, { kind: "course" }) });

    expect((await listCourseChildren(db, course)).sort()).toEqual([childA, childB].sort());
  });
});

// ---------------------------------------------------------------------------
// Staff copy-down
// ---------------------------------------------------------------------------

describe("copyStaffToChild", () => {
  it("gives every staff member an instructor row on the child", async () => {
    const convenor = await seedUser();
    const ta = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    await addMember(course, ta, "instructor");
    const child = await seedProject(await seedUser(), { parent: course });

    const result = await copyStaffToChild(db, {
      courseProjectId: course,
      childProjectId: child,
    });

    expect(result.added).toBe(2);
    expect((await memberRow(child, convenor)).role).toBe("instructor");
    expect((await memberRow(child, ta)).role).toBe("instructor");
  });

  it("is a no-op the second time — a retry writes no duplicate row", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    const child = await seedProject(await seedUser(), { parent: course });

    await copyStaffToChild(db, { courseProjectId: course, childProjectId: child });
    const again = await copyStaffToChild(db, {
      courseProjectId: course,
      childProjectId: child,
    });

    expect(again.added).toBe(0);
    expect(await memberRows(child)).toHaveLength(2);
  });

  it("leaves a staff member's own convenor row on the child alone", async () => {
    // A TA who convenes one of the group sites. Their standing there predates
    // and outranks their staff role; converting it would orphan the site.
    const courseConvenor = await seedUser();
    const ta = await seedUser();
    const course = await seedProject(courseConvenor, { kind: "course" });
    await addMember(course, ta, "instructor");
    const child = await seedProject(ta, { parent: course });

    const result = await copyStaffToChild(db, {
      courseProjectId: course,
      childProjectId: child,
    });

    expect(result.added).toBe(1);
    expect((await memberRow(child, ta)).role).toBe("convenor");
  });

  it("leaves a staff member's own collaborator row on the child alone", async () => {
    // Quietly upgrading it would erase a real membership: on that one child
    // they are an ordinary member, counted in its size and removable.
    const courseConvenor = await seedUser();
    const ta = await seedUser();
    const course = await seedProject(courseConvenor, { kind: "course" });
    await addMember(course, ta, "instructor");
    const child = await seedProject(await seedUser(), { parent: course });
    await addMember(child, ta, "collaborator");

    await copyStaffToChild(db, { courseProjectId: course, childProjectId: child });

    expect((await memberRow(child, ta)).role).toBe("collaborator");
  });

  it("does not copy a collaborator row down — course membership is staff only", async () => {
    // A collaborator row on a course is an anomaly rather than a standing, and
    // copying it would put a student in every group site.
    const convenor = await seedUser();
    const stray = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    await addMember(course, stray, "collaborator");
    const child = await seedProject(await seedUser(), { parent: course });

    const result = await copyStaffToChild(db, {
      courseProjectId: course,
      childProjectId: child,
    });

    expect(result.added).toBe(1);
    expect(await memberRow(child, stray)).toBeUndefined();
  });

  it("writes nothing onto a site that is not enrolled in the course", async () => {
    // The caller decided this was a child of the course some awaits ago. The
    // statement decides it again, so a site detached in the meantime — or one
    // that was never attached — gets no instructor rows.
    const convenor = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    const stranger = await seedProject(await seedUser());

    const result = await copyStaffToChild(db, {
      courseProjectId: course,
      childProjectId: stranger,
    });

    expect(result.added).toBe(0);
    expect(await memberRow(stranger, convenor)).toBeUndefined();
  });

  it("writes no admission record on a copied-down row", async () => {
    // The instructor is admitted by the course, not by a code on the child.
    // `joined_via_invite_id` names the code that let a member in; there is
    // none, and leaving clears the course's records from the child anyway.
    const convenor = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    const child = await seedProject(await seedUser(), { parent: course });

    await copyStaffToChild(db, { courseProjectId: course, childProjectId: child });

    expect((await memberRow(child, convenor)).joined_via_invite_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The whole redemption side effect
// ---------------------------------------------------------------------------

describe("applyRedemptionSideEffects", () => {
  it("preloads the collection and copies the staff down", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    await seedObject(course);
    const child = await seedProject(await seedUser(), { parent: course });
    const { env, calls } = fakeEnv();

    const result = await applyRedemptionSideEffects(db, env, {
      courseProjectId: course,
      childProjectId: child,
    });

    expect(result.staff.added).toBe(1);
    expect(result.preload.inserted).toBe(1);
    expect(callsTo(calls, "/ingest-sync")).toHaveLength(1);
    expect(callsTo(calls, "/ingest-sync")[0].stubName).toBe(String(child));
    expect((await memberRow(child, convenor)).role).toBe("instructor");
  });

  it("is a no-op the second time — the retry of a convenor who clicked twice", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    await seedObject(course);
    const child = await seedProject(await seedUser(), { parent: course });
    const { env } = fakeEnv();

    await applyRedemptionSideEffects(db, env, {
      courseProjectId: course,
      childProjectId: child,
    });
    const before = await memberRows(child);
    const again = await applyRedemptionSideEffects(db, env, {
      courseProjectId: course,
      childProjectId: child,
    });

    expect(again.staff.added).toBe(0);
    expect(await memberRows(child)).toHaveLength(before.length);
  });

  it("is a no-op for the course convenor redeeming into a site they already convene", async () => {
    // The convenor of the course is staff by definition, and here they also
    // convene the child. Neither role may move.
    const convenor = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    const child = await seedProject(convenor, { parent: course });
    const { env } = fakeEnv();

    const result = await applyRedemptionSideEffects(db, env, {
      courseProjectId: course,
      childProjectId: child,
    });

    expect(result.staff.added).toBe(0);
    expect(await memberRows(child)).toHaveLength(1);
    expect((await memberRow(child, convenor)).role).toBe("convenor");
  });

  it("leaves the membership complete when the preload fails, and a re-run finishes the job", async () => {
    // There is no transaction across D1 and the Durable Object, so the repair
    // for a partial failure is to run it again (design §5). What the failure
    // must not do is leave a half-written membership behind for the re-run to
    // trip over.
    const convenor = await seedUser();
    const ta = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    await addMember(course, ta, "instructor");
    await seedObject(course);
    const child = await seedProject(await seedUser(), { parent: course });

    const failing = fakeEnv({ fail: ["/ingest-sync"] });
    await expect(
      applyRedemptionSideEffects(db, failing.env, {
        courseProjectId: course,
        childProjectId: child,
      }),
    ).rejects.toThrow();

    // The staff copy is a single D1 statement: it either happened or it did
    // not, never half of it.
    const afterFailure = await memberRows(child);
    expect(afterFailure.filter((r) => r.role === "instructor")).toHaveLength(2);

    const working = fakeEnv();
    const repaired = await applyRedemptionSideEffects(db, working.env, {
      courseProjectId: course,
      childProjectId: child,
    });

    expect(repaired.staff.added).toBe(0);
    expect(repaired.preload.inserted).toBe(1);
    expect(await memberRows(child)).toHaveLength(afterFailure.length);
  });

  it("does not transfer the collection onto a child a leave detached mid-sequence", async () => {
    // The gap the copy-down and the transfer sit either side of. A leave
    // landing in it would otherwise be followed by the course's newly
    // protected objects arriving on a site that has just stopped being its own.
    const convenor = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    await seedObject(course);
    const child = await seedProject(await seedUser(), { parent: course });
    const { env, calls } = fakeEnv();

    const racing = interleavedDb(/INSERT INTO project_members/i, async () => {
      await detachChildFromCourse(db, env, {
        courseProjectId: course,
        childProjectId: child,
      });
    });

    const result = await applyRedemptionSideEffects(racing, env, {
      courseProjectId: course,
      childProjectId: child,
    });

    expect(result.enrolled).toBe(false);
    expect(callsTo(calls, "/ingest-sync")).toHaveLength(0);
    expect((await projectRow(child)).parent_project_id).toBeNull();
    // The leave took the copied-down rows with it, and nothing put them back.
    expect(await memberRow(child, convenor)).toBeUndefined();
  });

  it("writes nothing for a child that belongs to a different course", async () => {
    const convenorA = await seedUser();
    const courseA = await seedProject(convenorA, { kind: "course" });
    await seedObject(courseA);
    const courseB = await seedProject(await seedUser(), { kind: "course" });
    const child = await seedProject(await seedUser(), { parent: courseB });
    const { env, calls } = fakeEnv();

    const result = await applyRedemptionSideEffects(db, env, {
      courseProjectId: courseA,
      childProjectId: child,
    });

    expect(result.enrolled).toBe(false);
    expect(result.staff.added).toBe(0);
    expect(calls).toHaveLength(0);
    expect(await memberRow(child, convenorA)).toBeUndefined();
  });

  it("re-runs to the full end state after a failed transfer, with no duplicate row and no moved admission record", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    await seedObject(course);
    const childConvenor = await seedUser();
    const child = await seedProject(childConvenor, { parent: course });
    const courseCode = await seedInvite(course);
    await db
      .update(project_members)
      .set({ joined_via_invite_id: courseCode })
      .where(
        and(
          eq(project_members.project_id, child),
          eq(project_members.user_id, childConvenor),
        ),
      );

    const failing = fakeEnv({ fail: ["/ingest-sync"] });
    await expect(
      applyRedemptionSideEffects(db, failing.env, {
        courseProjectId: course,
        childProjectId: child,
      }),
    ).rejects.toThrow();
    const afterFailure = await memberRows(child);

    const repaired = await applyRedemptionSideEffects(db, fakeEnv().env, {
      courseProjectId: course,
      childProjectId: child,
    });

    expect(repaired.enrolled).toBe(true);
    expect(repaired.staff.added).toBe(0);
    expect(repaired.preload.inserted).toBe(1);
    expect(await memberRows(child)).toHaveLength(afterFailure.length);
    expect((await memberRow(child, childConvenor)).joined_via_invite_id).toBe(courseCode);
    expect((await projectRow(child)).parent_project_id).toBe(course);
  });

  it("refuses a project id that is not a positive integer rather than addressing a DO by it", async () => {
    const { env, calls } = fakeEnv();
    await expect(
      applyRedemptionSideEffects(db, env, {
        courseProjectId: 1,
        childProjectId: Number.NaN,
      }),
    ).rejects.toThrow(/project id/i);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The fan-out: staff joining
// ---------------------------------------------------------------------------

describe("fanOutStaffJoin", () => {
  it("inserts an instructor row into every existing child", async () => {
    const convenor = await seedUser();
    const ta = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    // The standing the fan-out follows from. Without it the assertions below
    // would hold whether or not the fan-out consulted it at all.
    await addMember(course, ta, "instructor");
    const childA = await seedProject(await seedUser(), { parent: course });
    const childB = await seedProject(await seedUser(), { parent: course });
    const unrelated = await seedProject(await seedUser());

    const result = await fanOutStaffJoin(db, { courseProjectId: course, userId: ta });

    expect(result.added).toBe(2);
    expect((await memberRow(childA, ta)).role).toBe("instructor");
    expect((await memberRow(childB, ta)).role).toBe("instructor");
    expect(await memberRow(unrelated, ta)).toBeUndefined();
  });

  it("writes nothing for a person who is not staff on the course", async () => {
    // Membership of the course is the whole entitlement. Someone who holds no
    // staff row on it is owed no row on its children, whatever asked for this.
    const convenor = await seedUser();
    const stranger = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    const child = await seedProject(await seedUser(), { parent: course });

    const result = await fanOutStaffJoin(db, { courseProjectId: course, userId: stranger });

    expect(result.added).toBe(0);
    expect(result.children).toEqual([child]);
    expect(await memberRow(child, stranger)).toBeUndefined();
  });

  it("does not hand back access a removal took away while it was in flight", async () => {
    // The fan-out was queued when the TA joined; the removal ran first. The
    // rows it would write are the ones the removal has just deleted.
    const convenor = await seedUser();
    const ta = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    const child = await seedProject(await seedUser(), { parent: course });
    await addMember(course, ta, "instructor");
    const { env } = fakeEnv();

    // The seam: after the children are read, before the rows are written.
    const racing = interleavedDb(/from "projects"/i, async () => {
      await removeMember(course, ta);
      await fanOutStaffDeparture(db, env, { courseProjectId: course, userId: ta });
    });

    const result = await fanOutStaffJoin(racing, { courseProjectId: course, userId: ta });

    expect(result.added).toBe(0);
    expect(await memberRow(child, ta)).toBeUndefined();
  });

  it("is a no-op on a re-run, and on a TA already staff under another code", async () => {
    const convenor = await seedUser();
    const ta = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    await addMember(course, ta, "instructor");
    const child = await seedProject(await seedUser(), { parent: course });

    await fanOutStaffJoin(db, { courseProjectId: course, userId: ta });
    const again = await fanOutStaffJoin(db, { courseProjectId: course, userId: ta });

    expect(again.added).toBe(0);
    expect(await memberRows(child)).toHaveLength(2);
  });

  it("skips a child the new staff member already holds a row on", async () => {
    const convenor = await seedUser();
    const ta = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    await addMember(course, ta, "instructor");
    const owned = await seedProject(ta, { parent: course });
    const other = await seedProject(await seedUser(), { parent: course });

    const result = await fanOutStaffJoin(db, { courseProjectId: course, userId: ta });

    expect(result.added).toBe(1);
    expect((await memberRow(owned, ta)).role).toBe("convenor");
    expect((await memberRow(other, ta)).role).toBe("instructor");
  });
});

// ---------------------------------------------------------------------------
// The fan-out: staff departing
// ---------------------------------------------------------------------------

describe("fanOutStaffDeparture", () => {
  it("drops only instructor rows, and only for the departing person", async () => {
    const convenor = await seedUser();
    const ta = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    // The TA is staff on the course, which is what put the rows on the children
    // in the first place; the departure is what removes that standing.
    await addMember(course, ta, "instructor");
    const childA = await seedProject(await seedUser(), { parent: course });
    const childB = await seedProject(await seedUser(), { parent: course });
    await fanOutStaffJoin(db, { courseProjectId: course, userId: ta });
    await fanOutStaffJoin(db, { courseProjectId: course, userId: convenor });
    const { env } = fakeEnv();

    await removeMember(course, ta);
    await fanOutStaffDeparture(db, env, { courseProjectId: course, userId: ta });

    expect(await memberRow(childA, ta)).toBeUndefined();
    expect(await memberRow(childB, ta)).toBeUndefined();
    expect((await memberRow(childA, convenor)).role).toBe("instructor");
  });

  it("leaves a convenor row alone — a user-keyed delete would orphan the site", async () => {
    const courseConvenor = await seedUser();
    const ta = await seedUser();
    const course = await seedProject(courseConvenor, { kind: "course" });
    // The TA is staff on the course, which is what put the rows on the children
    // in the first place; the departure is what removes that standing.
    await addMember(course, ta, "instructor");
    // The TA convenes one child and instructs on another, so the delete really
    // runs and has both rows in front of it.
    const owned = await seedProject(ta, { parent: course });
    const other = await seedProject(await seedUser(), { parent: course });
    await fanOutStaffJoin(db, { courseProjectId: course, userId: ta });
    const { env } = fakeEnv();

    await removeMember(course, ta);
    const result = await fanOutStaffDeparture(db, env, {
      courseProjectId: course,
      userId: ta,
    });

    expect((await memberRow(owned, ta)).role).toBe("convenor");
    expect(await memberRow(other, ta)).toBeUndefined();
    expect(result.removedFrom).toEqual([other]);
  });

  it("evicts once per child a row was actually dropped from, and not per member", async () => {
    const convenor = await seedUser();
    const ta = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    // The TA is staff on the course, which is what put the rows on the children
    // in the first place; the departure is what removes that standing.
    await addMember(course, ta, "instructor");
    const childA = await seedProject(await seedUser(), { parent: course });
    const childB = await seedProject(await seedUser(), { parent: course });
    // A third child the TA convenes: no instructor row is dropped there, so no
    // socket of theirs may be closed there either.
    const owned = await seedProject(ta, { parent: course });
    await fanOutStaffJoin(db, { courseProjectId: course, userId: ta });
    await fanOutStaffJoin(db, { courseProjectId: course, userId: convenor });
    const { env, calls } = fakeEnv();

    await removeMember(course, ta);
    const result = await fanOutStaffDeparture(db, env, {
      courseProjectId: course,
      userId: ta,
    });

    const evictions = callsTo(calls, "/notify-deleted");
    expect(evictions).toHaveLength(2);
    expect(evictions.map((c) => c.stubName).sort()).toEqual(
      [String(childA), String(childB)].sort(),
    );
    // Targeted at the departing person, never a broadcast: the group's
    // convenor and collaborators keep their sockets, and the broadcast form
    // tells every client the project was deleted.
    expect(evictions.every((c) => c.userId === String(ta))).toBe(true);
    expect(result.removedFrom.sort()).toEqual([childA, childB].sort());
    expect(calls.some((c) => c.stubName === String(owned))).toBe(false);
  });

  it("is a no-op on a re-run and evicts nothing the second time", async () => {
    const convenor = await seedUser();
    const ta = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    // The TA is staff on the course, which is what put the rows on the children
    // in the first place; the departure is what removes that standing.
    await addMember(course, ta, "instructor");
    await seedProject(await seedUser(), { parent: course });
    await fanOutStaffJoin(db, { courseProjectId: course, userId: ta });
    const { env, calls } = fakeEnv();

    await removeMember(course, ta);
    await fanOutStaffDeparture(db, env, { courseProjectId: course, userId: ta });
    const again = await fanOutStaffDeparture(db, env, {
      courseProjectId: course,
      userId: ta,
    });

    expect(again.removedFrom).toEqual([]);
    expect(callsTo(calls, "/notify-deleted")).toHaveLength(1);
  });

  it("reports an eviction that failed without undoing the D1 removal", async () => {
    const convenor = await seedUser();
    const ta = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    // The TA is staff on the course, which is what put the rows on the children
    // in the first place; the departure is what removes that standing.
    await addMember(course, ta, "instructor");
    const child = await seedProject(await seedUser(), { parent: course });
    await fanOutStaffJoin(db, { courseProjectId: course, userId: ta });
    const { env } = fakeEnv({ fail: ["/notify-deleted"] });

    const result = await fanOutStaffDeparture(db, env, {
      courseProjectId: course,
      userId: ta,
    });

    expect(result.failedEvictionProjects).toEqual([child]);
    expect(await memberRow(child, ta)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The leave sequence
// ---------------------------------------------------------------------------

describe("detachChildFromCourse", () => {
  it("clears markers, drops the instructor rows, clears the parent link and evicts", async () => {
    const convenor = await seedUser();
    const ta = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    await addMember(course, ta, "instructor");
    const childConvenor = await seedUser();
    const child = await seedProject(childConvenor, { parent: course });
    await copyStaffToChild(db, { courseProjectId: course, childProjectId: child });
    const { env, calls } = fakeEnv();

    const result = await detachChildFromCourse(db, env, {
      courseProjectId: course,
      childProjectId: child,
    });

    const clears = callsTo(calls, "/clear-course-markers");
    expect(clears).toHaveLength(1);
    expect(clears[0].stubName).toBe(String(child));
    expect(clears[0].body).toEqual({ courseProjectId: course });
    expect(result.detached).toBe(true);
    expect((await projectRow(child)).parent_project_id).toBeNull();
    expect(await memberRow(child, convenor)).toBeUndefined();
    expect(await memberRow(child, ta)).toBeUndefined();
    expect((await memberRow(child, childConvenor)).role).toBe("convenor");
    expect(result.instructorsDropped.sort()).toEqual([convenor, ta].sort());
  });

  it("clears the markers BEFORE the parent link, so a blocked flush leaves a site that can retry", async () => {
    // The reverse order strands the child: detached, with objects D1 still
    // marks as the course's, refused by every delete gate and with no course
    // left to leave.
    const convenor = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    const child = await seedProject(await seedUser(), { parent: course });
    await copyStaffToChild(db, { courseProjectId: course, childProjectId: child });
    const { env } = fakeEnv({ fail: ["/clear-course-markers"] });

    await expect(
      detachChildFromCourse(db, env, { courseProjectId: course, childProjectId: child }),
    ).rejects.toThrow(/503/);

    expect((await projectRow(child)).parent_project_id).toBe(course);
    expect((await memberRow(child, convenor)).role).toBe("instructor");
  });

  it("clears admission records the course issued and keeps the child's own", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    const childConvenor = await seedUser();
    const child = await seedProject(childConvenor, { parent: course });
    const collaborator = await seedUser();

    const courseCode = await seedInvite(course);
    const childInvite = await seedInvite(child);
    await db
      .update(project_members)
      .set({ joined_via_invite_id: courseCode })
      .where(
        and(
          eq(project_members.project_id, child),
          eq(project_members.user_id, childConvenor),
        ),
      );
    await addMember(child, collaborator, "collaborator", childInvite);
    const { env } = fakeEnv();

    const result = await detachChildFromCourse(db, env, {
      courseProjectId: course,
      childProjectId: child,
    });

    expect(result.admissionRecordsCleared).toBe(1);
    expect((await memberRow(child, childConvenor)).joined_via_invite_id).toBeNull();
    expect((await memberRow(child, collaborator)).joined_via_invite_id).toBe(childInvite);
  });

  it("evicts once for the child, targeted at each dropped instructor", async () => {
    const convenor = await seedUser();
    const ta = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    await addMember(course, ta, "instructor");
    const child = await seedProject(await seedUser(), { parent: course });
    await copyStaffToChild(db, { courseProjectId: course, childProjectId: child });
    const { env, calls } = fakeEnv();

    await detachChildFromCourse(db, env, {
      courseProjectId: course,
      childProjectId: child,
    });

    const evictions = callsTo(calls, "/notify-deleted");
    expect(evictions.every((c) => c.stubName === String(child))).toBe(true);
    expect(evictions.map((c) => c.userId).sort()).toEqual(
      [String(convenor), String(ta)].sort(),
    );
  });

  it("is safely re-runnable: the second pass detaches nothing and evicts nobody", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    const child = await seedProject(await seedUser(), { parent: course });
    await copyStaffToChild(db, { courseProjectId: course, childProjectId: child });
    const { env, calls } = fakeEnv();

    await detachChildFromCourse(db, env, { courseProjectId: course, childProjectId: child });
    const again = await detachChildFromCourse(db, env, {
      courseProjectId: course,
      childProjectId: child,
    });

    expect(again.detached).toBe(false);
    expect(again.instructorsDropped).toEqual([]);
    expect(callsTo(calls, "/notify-deleted")).toHaveLength(1);
    // The marker clear still runs on a retry: the route's guarantee is that D1
    // agrees with the document when it answers 200, and only running it earns
    // that on the pass whose flush failed the first time.
    expect(callsTo(calls, "/clear-course-markers")).toHaveLength(2);
  });

  it("does not delete the staff of a course that claimed the child while the markers cleared", async () => {
    // The retry of a leave whose earlier pass cleared the parent link. A null
    // parent is a completion rather than a refusal, so this pass proceeds —
    // but the marker clear is a Durable Object round trip, and by the time it
    // returns another course owns the child and every instructor row on it is
    // that course's staff.
    const convenorA = await seedUser();
    const courseA = await seedProject(convenorA, { kind: "course" });
    const convenorB = await seedUser();
    const taB = await seedUser();
    const courseB = await seedProject(convenorB, { kind: "course" });
    await addMember(courseB, taB, "instructor");
    const childConvenor = await seedUser();
    const child = await seedProject(childConvenor);
    const codeB = await seedInvite(courseB);

    const { env, calls } = fakeEnv({
      during: async (path) => {
        if (path !== "/clear-course-markers") return;
        await db
          .update(projects)
          .set({ parent_project_id: courseB })
          .where(eq(projects.id, child));
        await copyStaffToChild(db, { courseProjectId: courseB, childProjectId: child });
        await db
          .update(project_members)
          .set({ joined_via_invite_id: codeB })
          .where(
            and(
              eq(project_members.project_id, child),
              eq(project_members.user_id, childConvenor),
            ),
          );
      },
    });

    const result = await detachChildFromCourse(db, env, {
      courseProjectId: courseA,
      childProjectId: child,
    });

    expect(result.instructorsDropped).toEqual([]);
    expect(result.detached).toBe(false);
    expect((await memberRow(child, convenorB)).role).toBe("instructor");
    expect((await memberRow(child, taB)).role).toBe("instructor");
    expect((await memberRow(child, childConvenor)).joined_via_invite_id).toBe(codeB);
    expect((await projectRow(child)).parent_project_id).toBe(courseB);
    // Nothing left, so nobody is cut off from a site they still belong to.
    expect(callsTo(calls, "/notify-deleted")).toHaveLength(0);
  });

  it("still finishes an unattached child no other course has claimed", async () => {
    // The state the null parent tolerates: a pass that cleared the link and
    // stopped. The leftovers are still this course's to remove, and refusing
    // them outright would trade a race for a site stuck half out of a course.
    const convenor = await seedUser();
    const ta = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    await addMember(course, ta, "instructor");
    const childConvenor = await seedUser();
    const child = await seedProject(childConvenor, { parent: course });
    await copyStaffToChild(db, { courseProjectId: course, childProjectId: child });
    const courseCode = await seedInvite(course);
    await db
      .update(project_members)
      .set({ joined_via_invite_id: courseCode })
      .where(
        and(
          eq(project_members.project_id, child),
          eq(project_members.user_id, childConvenor),
        ),
      );
    await db
      .update(projects)
      .set({ parent_project_id: null })
      .where(eq(projects.id, child));
    const { env, calls } = fakeEnv();

    const result = await detachChildFromCourse(db, env, {
      courseProjectId: course,
      childProjectId: child,
    });

    expect(result.detached).toBe(false);
    expect(result.instructorsDropped.sort()).toEqual([convenor, ta].sort());
    expect(result.admissionRecordsCleared).toBe(1);
    expect(await memberRow(child, convenor)).toBeUndefined();
    expect(await memberRow(child, ta)).toBeUndefined();
    expect((await memberRow(child, childConvenor)).joined_via_invite_id).toBeNull();
    expect(callsTo(calls, "/notify-deleted")).toHaveLength(2);
  });

  it("refuses to detach a child that belongs to a different course", async () => {
    const ownerA = await seedUser();
    const ownerB = await seedUser();
    const courseA = await seedProject(ownerA, { kind: "course" });
    const courseB = await seedProject(ownerB, { kind: "course" });
    const child = await seedProject(await seedUser(), { parent: courseB });
    const { env, calls } = fakeEnv();

    const result = await detachChildFromCourse(db, env, {
      courseProjectId: courseA,
      childProjectId: child,
    });

    expect(result.detached).toBe(false);
    expect((await projectRow(child)).parent_project_id).toBe(courseB);
    expect(calls).toHaveLength(0);
  });
});
