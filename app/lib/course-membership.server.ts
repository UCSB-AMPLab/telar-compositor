/**
 * The side effects a course redemption has, and the ones leaving reverses.
 *
 * `join-codes.server.ts` answers one question — is this code worth anything to
 * this caller, and does the site attach? It writes the parent link and the
 * admission record and stops there, deliberately: everything that FOLLOWS from
 * an attachment reaches two other projects' documents and two other projects'
 * membership tables, and putting cross-project writes behind the same function
 * that reads a token would make a code resolution a thing that can evict a
 * websocket. This module is that second half. The boundary is: join-codes owns
 * the token and the parent link; this owns the consequences.
 *
 * The consequences are three (design §5). A newly attached child receives the
 * course's collection (`course-preload.server.ts` does the transfer). The
 * course's teaching staff — its convenor plus its instructor-role members —
 * become `instructor` members of the child, so every instructor is in a group
 * site from its first minute. And staff joining or leaving the course afterwards
 * fans out to every existing child.
 *
 * All of it is re-runnable, because none of it can be a transaction. D1 gives
 * a loop over children no transaction, and the collection transfer is a call to
 * another Durable Object besides; a partial failure is therefore repaired by
 * running the sequence again, not reconciled by hand. That is also how a
 * redemption of a code for a course the site ALREADY belongs to is useful:
 * §5 makes it an `ok` that re-runs the side effects, which is the repair path a
 * student can reach without help. Every write here is consequently expressed so
 * the database settles it — `ON CONFLICT DO NOTHING` for a row that may exist,
 * a compare-and-set for the parent link — rather than a read followed by a
 * write that a concurrent caller can invalidate in between.
 *
 * That is also why no sequence here trusts the enrolment it was handed. A parent
 * link read before an await is a fact about the past: a leave can clear it and
 * another course can claim the child while the next step is in flight. So every
 * write states its own enrolment test and applies only while that test still
 * holds — a stale pass writes nothing rather than writing over whoever holds the
 * child now, and a pass whose precondition does still hold runs exactly as it
 * would have. The one step that cannot be stated that way is the collection
 * transfer, which is a call into another Durable Object: its enrolment is
 * re-read immediately before the call, which leaves the round trip itself
 * uncovered. A transfer that lands inside a concurrent leave is repaired by
 * running the leave again, which clears this course's markers whether or not the
 * child is still attached.
 *
 * The fan-out is role-qualified in both directions, which is the rule that keeps
 * it from destroying real memberships. Joining staff SKIP a child where the
 * person already holds a row: a TA who convenes or collaborates on a group site
 * keeps that row, and on that one child they are an ordinary member. Departing
 * staff delete only rows `WHERE role = 'instructor'`, because a user-keyed
 * delete would orphan every site they convene.
 *
 * Evictions exist because the Durable Object snapshots a member's role into the
 * socket attachment at connect time, so a membership row deleted in D1 leaves a
 * live socket editing on a cached attachment until it reconnects. Every bulk
 * removal here therefore ends by closing the affected sockets. It is the
 * per-user form of `/notify-deleted` — the broadcast form closes EVERY socket on
 * the project and tells each client the project was deleted, which is false
 * during a leave and would evict the group's own convenor. Evictions are
 * best-effort, as they are everywhere else in this codebase: D1 has already
 * settled the outcome, and a Durable Object outage must not flip it. They are
 * reported rather than thrown so a caller can log what did not close.
 *
 * @version v1.5.0-beta
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "~/lib/db.server";
import { projects, project_members, project_config, project_invites } from "~/db/schema";
import { makeInternalMarkerHeaders } from "~/lib/internal-marker.server";
import { preloadCourseObjects } from "~/lib/course-preload.server";
import { recordWithdrawals } from "~/lib/repo-access-withdrawals.server";
import type { CoursePreloadEnv, CoursePreloadResult } from "~/lib/course-preload.server";

type DbInstance = ReturnType<typeof getDb>;

/**
 * The Durable Object binding and signing secret. Structurally identical to the
 * preload's, and reused rather than restated so a caller that can preload can
 * always run the whole sequence.
 */
export type CourseMembershipEnv = CoursePreloadEnv;

/**
 * Roles on a course project that make a person teaching staff (design §5) —
 * the convenor and the instructor members, and nothing else.
 *
 * Declared once and interpolated raw, because the two statements that read it
 * must agree: `listCourseStaff` tells a caller who the staff are and
 * `copyStaffToChild` writes them down, and a set that differed between them
 * would produce a child whose instructor rows no roster query accounts for. The
 * values are literals in this file, never anything a caller supplied.
 */
const STAFF_ROLES = sql.raw("'convenor', 'instructor'");

/**
 * True while `childProjectId` is enrolled in `courseProjectId` — the condition
 * every consequence of a redemption is owed to, evaluated inside the statement
 * that acts on it rather than read beforehand and hoped for.
 */
function enrolledInCourse(courseProjectId: number, childProjectId: number) {
  return sql`EXISTS (
    SELECT 1 FROM projects
    WHERE id = ${childProjectId} AND parent_project_id = ${courseProjectId}
  )`;
}

/**
 * True while no OTHER course holds `childProjectId` — enrolled here, or
 * enrolled nowhere.
 *
 * The leave sequence's condition, and deliberately weaker than
 * `enrolledInCourse`: a pass that already cleared the parent link and failed
 * afterwards must still be able to finish, so an unattached child is one this
 * course may keep tidying. What it must not do is tidy a child that another
 * course has since taken, whose instructor rows are that course's staff.
 */
function notClaimedByAnotherCourse(courseProjectId: number, childProjectId: number) {
  return sql`EXISTS (
    SELECT 1 FROM projects
    WHERE id = ${childProjectId}
      AND (parent_project_id IS NULL OR parent_project_id = ${courseProjectId})
  )`;
}

// ---------------------------------------------------------------------------
// Argument domain
// ---------------------------------------------------------------------------

/**
 * Refuse an id that is not a positive safe integer.
 *
 * A project id reaches this module from a resolved invite row, a session, or a
 * form field, and it ends up in two places where an out-of-domain value is
 * worse than an error: a Durable Object NAME, where `String(NaN)` addresses a
 * real and arbitrary object, and a signed internal marker, which would then
 * authorise a write against it. So the value is judged as a number here and
 * only rendered afterwards — rendering is how the id reaches a URL, never how a
 * decision about it is made.
 *
 * This is not `isIdentityValueInDomain`'s job: that predicate rules on the
 * identity values an ingest carries (`object_id`, `_id`), including their
 * absent cases, and this module handles none.
 */
function assertProjectId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`course-membership: ${label} is not a valid project id`);
  }
  return value;
}

function assertUserId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("course-membership: userId is not a valid user id");
  }
  return value;
}

// ---------------------------------------------------------------------------
// Reading the course
// ---------------------------------------------------------------------------

/**
 * The course's teaching staff: its convenor plus its instructor members.
 *
 * A `collaborator` row on a course project is deliberately not staff. Course
 * membership is staff only (ruling 10), so such a row is an anomaly rather than
 * a standing, and copying it down would put a student in every group site.
 */
export async function listCourseStaff(
  db: DbInstance,
  courseProjectId: number,
): Promise<number[]> {
  assertProjectId(courseProjectId, "courseProjectId");
  const rows = await db
    .select({ user_id: project_members.user_id })
    .from(project_members)
    .where(
      and(
        eq(project_members.project_id, courseProjectId),
        sql`${project_members.role} IN (${STAFF_ROLES})`,
      ),
    );
  return rows.map((r) => r.user_id);
}

/**
 * The course's own name, for the lines that name it.
 *
 * Falls back to the repository it lives in, which is the only other name a
 * course is sure to have: `project_config.title` is written at import from the
 * repo's `_config.yml`, and an empty title there is legal.
 *
 * Shared rather than per-surface because every redemption surface reports the
 * course it joined, and two surfaces naming the same course differently is the
 * kind of difference nobody would think to look for.
 */
export async function courseDisplayName(
  db: DbInstance,
  courseProjectId: number,
): Promise<string> {
  const config = await db
    .select({ title: project_config.title })
    .from(project_config)
    .where(eq(project_config.project_id, courseProjectId))
    .limit(1);
  const title = (config[0]?.title ?? "").trim();
  if (title) return title;

  const project = await db
    .select({ repo: projects.github_repo_full_name })
    .from(projects)
    .where(eq(projects.id, courseProjectId))
    .limit(1);
  return project[0]?.repo ?? "";
}

/**
 * The course's children, read from `parent_project_id` — the column that IS the
 * enrolment record. Admission records and course-item markers reference the
 * course too, but they follow this column and never substitute for it.
 */
export async function listCourseChildren(
  db: DbInstance,
  courseProjectId: number,
): Promise<number[]> {
  assertProjectId(courseProjectId, "courseProjectId");
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.parent_project_id, courseProjectId));
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Staff copy-down
// ---------------------------------------------------------------------------

export interface StaffCopyDownResult {
  /** Instructor rows this call wrote. Zero on a repeat. */
  added: number;
}

/**
 * Give the course's staff an `instructor` row on one child.
 *
 * One statement, so the skip is the database's `project_members_unique` and not
 * a read this caller could lose a race against. `DO NOTHING` rather than an
 * upsert is the role qualification: a staff member who already holds a row on
 * this child holds it as convenor or collaborator, and that standing predates
 * and outranks their staff role — converting a convenor row would orphan the
 * site and upgrading a collaborator row would erase a real membership.
 *
 * `joined_via_invite_id` is left null. It names the code that admitted a
 * member, and no code admitted these rows: the course did, and leaving drops
 * them outright rather than reading their provenance.
 *
 * The enrolment is part of the statement, not a precondition the caller vouches
 * for. A copy-down is only ever owed to a child of this course, and the caller
 * that decided so may have decided it several awaits ago; a child detached in
 * the meantime gets no rows, and a caller re-running the sequence after a
 * partial failure still gets the rows it is owed.
 */
export async function copyStaffToChild(
  db: DbInstance,
  args: { courseProjectId: number; childProjectId: number },
): Promise<StaffCopyDownResult> {
  const courseProjectId = assertProjectId(args.courseProjectId, "courseProjectId");
  const childProjectId = assertProjectId(args.childProjectId, "childProjectId");
  const now = new Date().toISOString();

  // SQLite requires the SELECT feeding an upsert to carry a WHERE clause, or
  // its parser cannot tell `ON CONFLICT` from the `ON` of a join. This one has
  // a real WHERE, so no `WHERE true` filler is needed.
  const result = await db.run(sql`
    INSERT INTO project_members (project_id, user_id, role, invited_at, joined_at)
    SELECT ${childProjectId}, staff.user_id, 'instructor', ${now}, ${now}
    FROM project_members AS staff
    WHERE staff.project_id = ${courseProjectId}
      AND staff.role IN (${STAFF_ROLES})
      AND ${enrolledInCourse(courseProjectId, childProjectId)}
    ON CONFLICT (project_id, user_id) DO NOTHING
  `);

  return { added: result.meta.changes };
}

// ---------------------------------------------------------------------------
// The whole redemption side effect
// ---------------------------------------------------------------------------

export interface RedemptionSideEffects {
  staff: StaffCopyDownResult;
  preload: CoursePreloadResult;
  /**
   * False when the child did not belong to the course by the time the transfer
   * was due — a leave, or a redemption into another course, overtook this one.
   * Nothing was written and nothing failed; the site is simply somewhere else,
   * and the collection it now owes is that other course's.
   */
  enrolled: boolean;
}

/**
 * Everything a redemption must do once `redeemForSite` has attached the site.
 *
 * Staff first, collection second, and the order carries a reason: the copy-down
 * is a single D1 statement that either happened or did not, while the preload
 * is a call into another Durable Object and is the step that can fail. Running
 * the reliable one first means a failed preload leaves the child's membership
 * already correct and the retry with only the transfer left to do.
 *
 * A failed preload throws, so the caller can tell a convenor the join needs
 * retrying. It leaves the site attached and its staff in place, which is the
 * state §5 designs for: re-offering any redeemable code of the course returns
 * `ok` and re-runs this function, and both halves are no-ops where they already
 * ran.
 *
 * Ordering constraint the caller owns: at site creation this runs only after
 * the child's import has fully written D1. An ingest into a cold Durable Object
 * builds the document from whatever D1 holds at that instant, and the next
 * snapshot's orphan sweep would reconcile a half-imported site out of existence.
 *
 * The enrolment is not one of the caller's constraints. It is tested twice here
 * — once inside the copy-down statement, once immediately before the transfer —
 * because the two halves are separated by an await, and a leave landing in that
 * gap would otherwise see the course's newly protected objects installed on a
 * site that is no longer its own. The second test reports `enrolled: false`
 * rather than throwing: a site that left is not a failed join, and telling a
 * convenor to retry would send them at a sequence that must now decline.
 */
export async function applyRedemptionSideEffects(
  db: DbInstance,
  env: CourseMembershipEnv,
  args: { courseProjectId: number; childProjectId: number },
): Promise<RedemptionSideEffects> {
  const courseProjectId = assertProjectId(args.courseProjectId, "courseProjectId");
  const childProjectId = assertProjectId(args.childProjectId, "childProjectId");

  const staff = await copyStaffToChild(db, { courseProjectId, childProjectId });

  const stillEnrolled = await db.all<{ enrolled: number }>(
    sql`SELECT ${enrolledInCourse(courseProjectId, childProjectId)} AS enrolled`,
  );
  if (!stillEnrolled[0]?.enrolled) {
    return {
      staff,
      preload: { inserted: 0, skippedAlreadyOurs: [], skippedConflict: [], skippedRepoBound: [] },
      enrolled: false,
    };
  }

  const preload = await preloadCourseObjects(db, env, { courseProjectId, childProjectId });
  return { staff, preload, enrolled: true };
}

// ---------------------------------------------------------------------------
// The fan-out
// ---------------------------------------------------------------------------

export interface StaffJoinFanOutResult {
  /** The children considered, whether or not a row was written on each. */
  children: number[];
  /** Instructor rows this call wrote. Zero on a repeat. */
  added: number;
}

/**
 * A person became staff on the course: give them an `instructor` row on every
 * existing child.
 *
 * No eviction follows. Evictions exist to close sockets whose cached attachment
 * has gone stale, and this writes rows only where the person held none — so
 * there was no socket to go stale. The children they DO hold a row on are
 * skipped, and their role there is untouched.
 *
 * The staff standing is re-established by the statement rather than taken from
 * the caller, and that is what keeps this from being a way back in: a fan-out
 * queued behind a removal would otherwise hand back on twelve children the
 * access the removal had just taken away. Someone who is no longer staff gets
 * no rows, and someone who is gets them wherever they are missing, however
 * often this runs.
 */
export async function fanOutStaffJoin(
  db: DbInstance,
  args: { courseProjectId: number; userId: number },
): Promise<StaffJoinFanOutResult> {
  const courseProjectId = assertProjectId(args.courseProjectId, "courseProjectId");
  const userId = assertUserId(args.userId);
  const now = new Date().toISOString();

  const children = await listCourseChildren(db, courseProjectId);

  const result = await db.run(sql`
    INSERT INTO project_members (project_id, user_id, role, invited_at, joined_at)
    SELECT child.id, ${userId}, 'instructor', ${now}, ${now}
    FROM projects AS child
    WHERE child.parent_project_id = ${courseProjectId}
      AND EXISTS (
        SELECT 1 FROM project_members AS staff
        WHERE staff.project_id = ${courseProjectId}
          AND staff.user_id = ${userId}
          AND staff.role IN (${STAFF_ROLES})
      )
    ON CONFLICT (project_id, user_id) DO NOTHING
  `);

  return { children, added: result.meta.changes };
}

export interface StaffDepartureFanOutResult {
  /** Children an instructor row was actually deleted from. */
  removedFrom: number[];
  /** Children whose eviction call did not succeed. The rows are still gone. */
  failedEvictionProjects: number[];
}

/**
 * A person stopped being staff on the course: drop their `instructor` row from
 * every child, then close their sockets there.
 *
 * `WHERE role = 'instructor'` is the whole safety of this operation. The same
 * person may convene or collaborate on one of these children, and a user-keyed
 * delete would orphan that site.
 *
 * The children are read before the delete so the evictions can be aimed at the
 * ones a row actually left — one eviction per child, never one per member of
 * it, and none at all for a child where the person kept a row of their own.
 */
export async function fanOutStaffDeparture(
  db: DbInstance,
  env: CourseMembershipEnv,
  args: { courseProjectId: number; userId: number },
): Promise<StaffDepartureFanOutResult> {
  const courseProjectId = assertProjectId(args.courseProjectId, "courseProjectId");
  const userId = assertUserId(args.userId);

  const held = await db.all<{ project_id: number }>(sql`
    SELECT m.project_id AS project_id
    FROM project_members AS m
    JOIN projects AS p ON p.id = m.project_id
    WHERE p.parent_project_id = ${courseProjectId}
      AND m.user_id = ${userId}
      AND m.role = 'instructor'
  `);
  const removedFrom = held.map((r) => r.project_id);
  if (removedFrom.length === 0) {
    return { removedFrom: [], failedEvictionProjects: [] };
  }

  const copies = sql`${project_members.user_id} = ${userId}
    AND ${project_members.role} = 'instructor'
    AND ${project_members.project_id} IN (SELECT id FROM projects WHERE parent_project_id = ${courseProjectId})`;
  await db.batch([recordWithdrawals(db, copies), db.delete(project_members).where(copies)]);

  // D1 before the Durable Object, as every removal path in this codebase does:
  // a socket that reconnects mid-flight must fail the membership check rather
  // than find a row that is about to disappear.
  const failedEvictionProjects: number[] = [];
  for (const projectId of removedFrom) {
    if (!(await evictMember(env, projectId, userId))) failedEvictionProjects.push(projectId);
  }

  return { removedFrom, failedEvictionProjects };
}

/**
 * End one person's membership of one project, and — when that membership is
 * their standing on a course's staff — the copies of it on the course's
 * children in the same batch.
 *
 * The two single-row exits, a convenor removing a member and a member leaving
 * from their account page, each deleted one row. On a course that row is the
 * source of an `instructor` row on every child site, so deleting it alone left
 * the person off the course's staff list while still holding instructor
 * standing, with live sockets, on every group's work.
 *
 * One batch, because the course row is what authorises the copies: while it
 * exists, a concurrent staff join or a child enrolling copies the row straight
 * back, so deleting the children's rows first and the course's afterwards can
 * leave a child row behind. D1 runs a batch as one transaction, so either both
 * are gone or neither is and the exit can be retried. The evictions follow and
 * are aimed at the children a row actually left, read from the delete itself.
 *
 * Staff means both roles `copyStaffToChild` copies from — the course's
 * convenor as well as its instructors. The copies are always `instructor`
 * rows, and only those are deleted: a person who convenes or collaborates on
 * one of the children in their own right keeps that row.
 *
 * The caller evicts the person's sockets on `projectId` itself, as it did
 * before this existed.
 */
export async function endMembership(
  db: DbInstance,
  env: CourseMembershipEnv,
  args: { projectId: number; userId: number },
): Promise<StaffDepartureFanOutResult> {
  const projectId = assertProjectId(args.projectId, "projectId");
  const userId = assertUserId(args.userId);

  const member = await db
    .select({ role: project_members.role })
    .from(project_members)
    .where(and(eq(project_members.project_id, projectId), eq(project_members.user_id, userId)));
  const role = member[0]?.role;
  const project =
    role === "instructor" || role === "convenor"
      ? await db.select({ kind: projects.kind }).from(projects).where(eq(projects.id, projectId))
      : [];
  // Both lookups are by a unique key — (project, user) and the project id —
  // so neither needs a limit.
  const endsCourseStaff = project[0]?.kind === "course";

  const ownRow = and(eq(project_members.project_id, projectId), eq(project_members.user_id, userId));
  const endOwnRow = [recordWithdrawals(db, ownRow), db.delete(project_members).where(ownRow)] as const;
  if (!endsCourseStaff) {
    await db.batch(endOwnRow);
    return { removedFrom: [], failedEvictionProjects: [] };
  }

  const copiesOnChildren = and(
    eq(project_members.user_id, userId),
    eq(project_members.role, "instructor"),
    inArray(
      project_members.project_id,
      db.select({ id: projects.id }).from(projects).where(eq(projects.parent_project_id, projectId)),
    ),
  );
  const [, copies] = await db.batch([
    recordWithdrawals(db, copiesOnChildren),
    db.delete(project_members).where(copiesOnChildren).returning({ projectId: project_members.project_id }),
    ...endOwnRow,
  ]);

  const removedFrom = copies.map((row) => row.projectId);
  const failedEvictionProjects: number[] = [];
  for (const childId of removedFrom) {
    if (!(await evictMember(env, childId, userId))) failedEvictionProjects.push(childId);
  }
  return { removedFrom, failedEvictionProjects };
}

// ---------------------------------------------------------------------------
// The leave sequence
// ---------------------------------------------------------------------------

export interface DetachResult {
  /** Course markers removed from the child's document by this call. */
  markersCleared: number;
  /** Users whose instructor row this call deleted from the child. */
  instructorsDropped: number[];
  /** Member rows whose admission record named a code of THIS course. */
  admissionRecordsCleared: number;
  /** True when this call cleared the parent link; false when it was already clear. */
  detached: boolean;
  /** Dropped instructors whose eviction did not succeed. The rows are still gone. */
  failedEvictionUsers: number[];
}

/**
 * Take one child out of a course: the leave sequence of design §5, whole.
 *
 * The routes that reach it — a convenor leaving from settings, an instructor
 * removing a site, a course being deleted — belong to F2, which calls this
 * rather than restating a five-step order in three places.
 *
 * The order is not arrangeable. Markers first: clearing them is a Y.Doc
 * mutation with an immediate snapshot flush, and the route answers 200 only
 * when D1 agrees with the document. If it fails and the D1 half had already
 * run, the child would be detached while its objects still carried a marker
 * that every delete gate reads — undeletable objects with no course left to
 * leave them by. Failing first instead leaves the site enrolled, which is a
 * state a retry resolves. Then the instructor rows, the admission records the
 * course issued and the parent link, in one transaction: a staff copy-down
 * writes rows to a child for as long as it is enrolled, so with the delete and
 * the detachment apart, a copy-down landing between them would leave staff
 * rows on a child no longer anyone's to remove them from. The evictions come
 * last, once D1 has settled what a reconnecting socket will be told.
 *
 * Re-runnable in both directions. A child already detached still has its
 * markers cleared — the route's guarantee is earned by running it, and the pass
 * whose flush failed is exactly the pass that left D1 behind — while its
 * already-empty row sets clear nothing and evict nobody. A child belonging to a
 * DIFFERENT course is refused untouched: it is not this course's to detach, and
 * clearing this course's markers on it would be a cross-course write.
 *
 * That tolerance is why the instructor delete restates the condition instead of
 * inheriting it from the read above. Clearing the markers is a Durable Object
 * round trip, and a course can attach the child and copy its own staff down
 * while it is in flight; a retry that had only the earlier read to go on would
 * then delete the new course's instructor rows as though they were this
 * course's, since a copied-down row carries no mark of which course sent it.
 * Restated at the write, the same retry finds the child claimed and takes
 * nothing — while an unattached child, which is the state the tolerance exists
 * for, is still finished off. The rows are reported by the delete itself rather
 * than by a read before it, so what is evicted is what actually left. The other
 * two writes carry their own scope already: the admission clear can reach no
 * invite but this course's, and the parent link is a compare-and-set.
 *
 * Throws when the marker clear fails, leaving the child enrolled and the
 * sequence safe to retry.
 */
export async function detachChildFromCourse(
  db: DbInstance,
  env: CourseMembershipEnv,
  args: { courseProjectId: number; childProjectId: number },
): Promise<DetachResult> {
  const courseProjectId = assertProjectId(args.courseProjectId, "courseProjectId");
  const childProjectId = assertProjectId(args.childProjectId, "childProjectId");

  const childRows = await db
    .select({ parent: projects.parent_project_id })
    .from(projects)
    .where(eq(projects.id, childProjectId))
    .limit(1);
  const child = childRows[0];
  const parent = child?.parent ?? null;

  // A null parent is a completion, not a refusal: a previous pass may have
  // cleared the link and failed before finishing the rest.
  if (!child || (parent !== null && parent !== courseProjectId)) {
    return {
      markersCleared: 0,
      instructorsDropped: [],
      admissionRecordsCleared: 0,
      detached: false,
      failedEvictionUsers: [],
    };
  }

  const markersCleared = await clearCourseMarkers(env, { courseProjectId, childProjectId });

  // Only the records the course issued. A departed site frees the seat the
  // course gave it, but provenance from the child's OWN invites is not
  // collateral — the group's collaborators were admitted by the group. That
  // subquery is also the whole guard the admission clear needs: it can reach
  // no record but this course's, so a retry that finds the child taken by
  // another course still clears nothing of that course's, and the stale
  // provenance it does clear is stale whoever holds the child now. The parent
  // link is a compare-and-set, the mirror of the attachment: cleared only while
  // it still names this course, so a concurrent redemption into another course
  // cannot be undone by a leave that started before it.
  // The course's instructors leave the site with it, and so does their access.
  const courseStaff = and(
    eq(project_members.project_id, childProjectId),
    eq(project_members.role, "instructor"),
    notClaimedByAnotherCourse(courseProjectId, childProjectId),
  );
  const [, dropped, cleared, detachment] = await db.batch([
    recordWithdrawals(db, courseStaff),
    db.delete(project_members).where(courseStaff).returning({ userId: project_members.user_id }),
    db
      .update(project_members)
      .set({ joined_via_invite_id: null })
      .where(
        and(
          eq(project_members.project_id, childProjectId),
          inArray(
            project_members.joined_via_invite_id,
            db.select({ id: project_invites.id }).from(project_invites).where(eq(project_invites.project_id, courseProjectId)),
          ),
        ),
      ),
    db
      .update(projects)
      .set({ parent_project_id: null })
      .where(and(eq(projects.id, childProjectId), eq(projects.parent_project_id, courseProjectId))),
  ]);
  const instructorsDropped = dropped.map((r) => r.userId);

  const failedEvictionUsers: number[] = [];
  for (const userId of instructorsDropped) {
    if (!(await evictMember(env, childProjectId, userId))) failedEvictionUsers.push(userId);
  }

  return {
    markersCleared,
    instructorsDropped,
    admissionRecordsCleared: cleared.meta.changes,
    detached: detachment.meta.changes > 0,
    failedEvictionUsers,
  };
}

/**
 * Detach every site from `projectId`, ahead of deleting it.
 *
 * Deleting a project ends with its `projects` row, and a child's
 * `parent_project_id` then falls to null through the foreign key without the
 * leave sequence ever running: the staff's instructor rows would stay on every
 * group site, and the course markers would stay on the children's objects with
 * no course left to clear them. So each child is detached first, while it can
 * still be found through the course. Only a course has children; for a site
 * the list is empty and this is one read.
 *
 * Throws when a child's marker clear fails, as `detachChildFromCourse` does.
 * The children detached by then stay detached, the rest stay enrolled and the
 * course stays whole, so the delete is refused and a retry finishes it.
 */
export async function detachCourseChildren(
  db: DbInstance,
  env: CourseMembershipEnv,
  projectId: number,
): Promise<void> {
  for (const childProjectId of await listCourseChildren(db, projectId)) {
    await detachChildFromCourse(db, env, { courseProjectId: projectId, childProjectId });
  }
}

/**
 * Evict each person from a project they just lost their row on: the staff
 * copies a project delete reports (`deleteProjectCascade`), or every project a
 * deleted account belonged to. Best-effort, like every eviction; the ones that
 * failed are returned.
 */
export async function evictMembers(
  env: CourseMembershipEnv,
  copies: ReadonlyArray<{ projectId: number; userId: number }>,
): Promise<Array<{ projectId: number; userId: number }>> {
  const failed: Array<{ projectId: number; userId: number }> = [];
  for (const copy of copies) {
    if (!(await evictMember(env, copy.projectId, copy.userId))) failed.push(copy);
  }
  return failed;
}

// ---------------------------------------------------------------------------
// Durable Object calls
// ---------------------------------------------------------------------------

/**
 * Clear this course's marker from every object in the child's document.
 *
 * Its own Durable Object route rather than a D1 update: the marker lives on the
 * object Y.Maps and the snapshot rebuilds D1 from them, so a D1-only clear is
 * undone at the next snapshot. The route flushes before answering, which is why
 * the caller may treat D1 as consistent the moment it returns — and why a
 * non-200 must throw rather than be swallowed, unlike an eviction: the rest of
 * the leave sequence proceeds on that guarantee.
 */
async function clearCourseMarkers(
  env: CourseMembershipEnv,
  args: { courseProjectId: number; childProjectId: number },
): Promise<number> {
  const { courseProjectId, childProjectId } = args;
  const headers = await makeInternalMarkerHeaders(
    childProjectId,
    env.SESSION_SECRET,
    "clear-course-markers",
  );
  const stub = env.COLLABORATION.get(env.COLLABORATION.idFromName(String(childProjectId)));
  const res = await stub.fetch(
    new Request("https://internal/clear-course-markers", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ courseProjectId }),
    }),
  );
  if (!res.ok) {
    throw new Error(
      `course-membership: clearing markers for course ${courseProjectId} on child ` +
        `${childProjectId} failed: DO returned ${res.status}`,
    );
  }
  const body = (await res.json()) as { cleared?: number };
  return body.cleared ?? 0;
}

/**
 * Close every socket on a project that has just been deleted, with the
 * `project_deleted` notice that tells each editor why. Best-effort: D1 has
 * already settled the delete, and a socket that survives an outage fails its
 * next membership check.
 */
export async function notifyProjectDeleted(env: CourseMembershipEnv, projectId: number): Promise<boolean> {
  try {
    const headers = await makeInternalMarkerHeaders(projectId, env.SESSION_SECRET, "notify-deleted");
    const stub = env.COLLABORATION.get(env.COLLABORATION.idFromName(String(projectId)));
    const res = await stub.fetch(new Request("https://internal/notify-deleted", { method: "POST", headers }));
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Close one person's sockets on one project, because the row the Durable Object
 * cached their role from is gone.
 *
 * The `?userId=` form, never the broadcast: the broadcast closes every socket
 * on the project with `project_deleted`, which is what a convenor's delete
 * means and not what a leave means.
 *
 * Best-effort by design, as at every other removal site: D1 has settled the
 * outcome and a Durable Object outage must not flip it. A socket that survives
 * fails its next membership check anyway; the eviction only makes that
 * immediate. The failure is returned rather than logged here so the caller —
 * which knows whether this was one leave or a fan-out over twelve children —
 * decides what is worth reporting.
 */
async function evictMember(
  env: CourseMembershipEnv,
  projectId: number,
  userId: number,
): Promise<boolean> {
  try {
    const headers = await makeInternalMarkerHeaders(
      projectId,
      env.SESSION_SECRET,
      "notify-deleted",
      userId,
    );
    const stub = env.COLLABORATION.get(env.COLLABORATION.idFromName(String(projectId)));
    const res = await stub.fetch(
      new Request(`https://internal/notify-deleted?userId=${userId}`, {
        method: "POST",
        headers,
      }),
    );
    return res.ok;
  } catch {
    return false;
  }
}
