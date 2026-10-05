/**
 * This file is the server-side access control for project membership —
 * role lookup, project enumeration with stats, and presence-colour
 * assignment. Route loaders and actions call these helpers to enforce
 * who is allowed to see a project and what they are allowed to change
 * once they are in it.
 *
 * Three roles exist: a single `convenor` per project (the owner — full
 * read/write/delete), any number of `collaborator` members (read +
 * editorial write, but not destructive operations), and `instructor`
 * members, who carry a collaborator's permissions and a role label.
 * `requireOwner` and `requireProjectMember` are the gate helpers route
 * actions invoke at the top of a handler; anything they don't throw on
 * is allowed through.
 *
 * The presence-colour helpers solve a parallel concern: when several
 * editors are in the same project, each needs a stable, distinguishable
 * colour for cursors and avatars. Colours are assigned lazily from a
 * six-entry palette, prefer a user's consistent choice across their
 * other memberships, and fall back to first-unused for the project.
 *
 * @version v1.5.0-beta
 */

import { eq, and, inArray, isNull, isNotNull, ne, sql } from "drizzle-orm";
import { getDb } from "~/lib/db.server";
import { projects, project_members } from "~/db/schema";
import { isPublishingRole } from "~/lib/publishing-roles";

type Role = "convenor" | "collaborator" | "instructor";

type DbInstance = ReturnType<typeof getDb>;

/**
 * Get the user's role in a specific project.
 * Returns null if the user has no membership.
 */
export async function getUserRole(
  db: DbInstance,
  projectId: number,
  userId: number,
): Promise<Role | null> {
  const rows = await db
    .select({ role: project_members.role })
    .from(project_members)
    .where(
      and(
        eq(project_members.project_id, projectId),
        eq(project_members.user_id, userId),
      ),
    )
    .limit(1);
  return (rows[0]?.role as Role) ?? null;
}

/**
 * Get all projects the user has access to (owned + collaborated).
 * Returns project rows with the user's role in each.
 */
export async function getUserProjects(
  db: DbInstance,
  userId: number,
): Promise<Array<typeof projects.$inferSelect & { userRole: Role }>> {
  // Fetch all project memberships for this user
  const memberRows = await db
    .select({
      project_id: project_members.project_id,
      role: project_members.role,
    })
    .from(project_members)
    .where(eq(project_members.user_id, userId));

  if (memberRows.length === 0) return [];

  const projectIds = memberRows.map((r) => r.project_id);
  const projectRows = await db
    .select()
    .from(projects)
    .where(inArray(projects.id, projectIds));

  return projectRows.map((p) => {
    const membership = memberRows.find((m) => m.project_id === p.id);
    return { ...p, userRole: (membership?.role as Role) ?? "collaborator" };
  });
}

/**
 * True when a project must be left out of the caller's project listings.
 *
 * An instructor is copied into every site that joins their course, so a
 * term's worth of them would bury the instructor's own work in the header
 * switcher, the start page and the account card. Ruling 18 takes them out
 * of those lists; ruling 22 makes that a listing concern and nothing more —
 * the instructor keeps full access, `switch-project` still admits a child
 * by id, and `resolveActiveProject` still falls back to one.
 *
 * The pair is what suppresses, not either half. An `instructor` row on a
 * project with no parent is the course itself, or an unaffiliated site, and
 * both stay listed — a co-instructor whose only row on the course is an
 * instructor row would otherwise lose the course from their own switcher,
 * which is the surface ruling 18 keeps it on. A `convenor` or
 * `collaborator` row on a child stays listed too: that is the student's own
 * group site in their own switcher, and the TA who really collaborates on
 * one child.
 *
 * The same pair `isMembershipExitRefused` tests, for the same reason —
 * instructor membership on a child belongs to the course rather than to the
 * person.
 */
export function isSuppressedFromProjectLists(project: {
  userRole: Role;
  parent_project_id: number | null;
}): boolean {
  return project.userRole === "instructor" && project.parent_project_id != null;
}

/** The listable subset of a caller's projects. Never used to decide access. */
export function listableProjects<
  T extends { userRole: Role; parent_project_id: number | null },
>(projects: T[]): T[] {
  return projects.filter((p) => !isSuppressedFromProjectLists(p));
}

/**
 * Extends the loader without disturbing existing
 * `getUserProjects` callers (`resolveActiveProject`, `_app.dashboard.tsx`).
 *
 * Returns the same array as `getUserProjects` plus two derived fields:
 *
 *   - `last_edited_at`: ISO string (max `updated_at` across the project's
 *     entity tables — stories, objects, project_pages, project_config,
 *     project_themes, project_landing, glossary_terms — via UNION ALL).
 *     `null` when no entity rows exist for the project. Computed this way
 *     because `projects.updated_at` is NOT bumped on entity edits today
 *     (verified against current schema).
 *
 *   - `collaborator_count`: number of OTHER project members (excludes the
 *     calling `userId`). Single COUNT(*) GROUP BY query, JS-joined.
 *
 * Sort order: descending by `last_edited_at`, nulls last —
 * most-recently-edited first.
 */
export async function getUserProjectsWithStats(
  db: DbInstance,
  userId: number,
): Promise<
  Array<
    typeof projects.$inferSelect & {
      userRole: Role;
      last_edited_at: string | null;
      collaborator_count: number;
    }
  >
> {
  const base = await getUserProjects(db, userId);
  if (base.length === 0) return [];

  const projectIds = base.map((p) => p.id);

  // collaborator_count: count members per project, excluding the caller AND
  // excluding instructor rows — instructors are staff, not group size (design
  // §3: "a teacher joining five groups must not make all five look larger
  // than they are"). This count feeds the account danger zone's gating
  // (convenedProjects / soloConvenedCount): an uncorrected instructor row
  // would make a solo student's site look convened-with-collaborators,
  // blocking their own account deletion while remove-member/leave-project
  // refuse to remove the instructor (the exit is tied to the course).
  const counts = await db
    .select({
      project_id: project_members.project_id,
      count: sql<number>`COUNT(*)`,
    })
    .from(project_members)
    .where(
      and(
        inArray(project_members.project_id, projectIds),
        sql`${project_members.user_id} != ${userId}`,
        ne(project_members.role, "instructor"),
      ),
    )
    .groupBy(project_members.project_id);

  const countByProject = new Map<number, number>(
    counts.map((c: { project_id: number; count: number }) => [
      c.project_id,
      Number(c.count),
    ]),
  );

  // last_edited_at: UNION ALL across the six entity tables that carry
  // both `updated_at` and a `project_id` FK. Drizzle `sql` template tag
  // composed via `sql.join` so the project-id list interpolates safely
  // (Drizzle parameterises `inArray` placeholders).
  //
  // project_themes deliberately omitted — its row does not carry
  // `updated_at` (themes are static once imported).
  //
  // Cloudflare D1 caps compound SELECT terms at 5 (one UNION = 2 terms,
  // five UNION ALLs would make 6 terms and throw "too many terms in
  // compound SELECT" SQLITE_ERROR 7500). We split the six entity scans
  // into two halves, run them in parallel, and reduce in JS.
  //
  // For typical compositor accounts (≤20 projects)
  // the six full scans complete < 50ms.
  const inIds = sql`(${sql.join(
    projectIds.map((id) => sql`${id}`),
    sql`, `,
  )})`;

  const unionSqlA = sql`
    SELECT project_id, MAX(latest) AS last_edited_at FROM (
      SELECT project_id, updated_at AS latest FROM stories       WHERE project_id IN ${inIds}
      UNION ALL
      SELECT project_id, updated_at AS latest FROM objects       WHERE project_id IN ${inIds}
      UNION ALL
      SELECT project_id, updated_at AS latest FROM project_pages WHERE project_id IN ${inIds}
    )
    GROUP BY project_id
  `;

  const unionSqlB = sql`
    SELECT project_id, MAX(latest) AS last_edited_at FROM (
      SELECT project_id, updated_at AS latest FROM project_config  WHERE project_id IN ${inIds}
      UNION ALL
      SELECT project_id, updated_at AS latest FROM project_landing WHERE project_id IN ${inIds}
      UNION ALL
      SELECT project_id, updated_at AS latest FROM glossary_terms  WHERE project_id IN ${inIds}
    )
    GROUP BY project_id
  `;

  const [rowsA, rowsB] = await Promise.all([
    db.all(unionSqlA) as Promise<
      Array<{ project_id: number; last_edited_at: string | null }>
    >,
    db.all(unionSqlB) as Promise<
      Array<{ project_id: number; last_edited_at: string | null }>
    >,
  ]);
  // Merge: keep the max across both halves per project_id.
  const editedMap = new Map<number, string | null>();
  for (const row of [...rowsA, ...rowsB]) {
    const prev = editedMap.get(row.project_id);
    if (prev === undefined) {
      editedMap.set(row.project_id, row.last_edited_at);
    } else if (
      row.last_edited_at !== null &&
      (prev === null || row.last_edited_at.localeCompare(prev) > 0)
    ) {
      editedMap.set(row.project_id, row.last_edited_at);
    }
  }
  const editedRows = Array.from(editedMap, ([project_id, last_edited_at]) => ({
    project_id,
    last_edited_at,
  }));

  const editedByProject = new Map<number, string | null>(
    editedRows.map((r) => [r.project_id, r.last_edited_at]),
  );

  const enriched = base.map((p) => ({
    ...p,
    collaborator_count: countByProject.get(p.id) ?? 0,
    last_edited_at: editedByProject.get(p.id) ?? null,
  }));

  // Sort descending by last_edited_at; nulls last.
  enriched.sort((a, b) => {
    if (a.last_edited_at === null && b.last_edited_at === null) return 0;
    if (a.last_edited_at === null) return 1;
    if (b.last_edited_at === null) return -1;
    return b.last_edited_at.localeCompare(a.last_edited_at);
  });

  return enriched;
}

/**
 * Resolve the active project for a request using membership (not ownership).
 *
 * Looks up the session's activeProjectId, verifies the user has a membership,
 * and returns the project + role. Falls back to the user's first project if
 * the session ID is missing or invalid.
 *
 * Returns null if the user has no project memberships at all.
 */
export async function resolveActiveProject(
  db: DbInstance,
  userId: number,
  sessionActiveId: number | undefined,
): Promise<{ project: typeof projects.$inferSelect; userRole: Role } | null> {
  const allProjects = await getUserProjects(db, userId);
  if (allProjects.length === 0) return null;

  const active =
    allProjects.find((p) => p.id === Number(sessionActiveId)) ?? allProjects[0];
  return { project: active, userRole: active.userRole };
}

/**
 * Throw 403 if the user is not the owner of the given project.
 */
export async function requireOwner(
  db: DbInstance,
  projectId: number,
  userId: number,
): Promise<void> {
  const role = await getUserRole(db, projectId, userId);
  if (role !== "convenor") {
    throw new Response("Forbidden", { status: 403 });
  }
}

// isPublishingRole lives in ~/lib/publishing-roles (not server-only) so the
// client affordances for the same four actions can import the identical
// check; re-exported here so existing server-side imports of it from this
// module keep working.
export { isPublishingRole };

/**
 * Throw 403 unless the user holds a publishing role on the project — the
 * gate for publish, image upload, and upgrade.
 */
export async function requirePublishingRole(
  db: DbInstance,
  projectId: number,
  userId: number,
): Promise<void> {
  const role = await getUserRole(db, projectId, userId);
  if (!isPublishingRole(role)) {
    throw new Response("Forbidden", { status: 403 });
  }
}

/**
 * Throw 403 unless the caller may manage a code of `codeRole` on
 * `courseProjectId`.
 *
 * Course-management rights belong to all of a course's staff — issuing and
 * revoking class codes, removing a site — but the staff list is the
 * convenor's alone, and an instructor-role code is staff management by
 * another door. So a class code (`collaborator`) admits the convenor and
 * any instructor member; a staff code (`instructor`) admits the convenor
 * only. Both creation and revocation take the same gate.
 *
 * The project id reaches this helper from a form, so it is verified here
 * rather than trusted: a project that does not exist and a project that is
 * not a course are both refused with the same 403 as a caller with no
 * standing, which keeps the refusal from reporting whether an id is real.
 *
 * `requireOwner` is untouched — its other callers gate destructive
 * single-project operations, which this is not.
 */
export async function requireCourseCodeManager(
  db: DbInstance,
  courseProjectId: number,
  userId: number,
  codeRole: "collaborator" | "instructor",
): Promise<{ project: typeof projects.$inferSelect; role: Role }> {
  const forbidden = new Response("Forbidden", { status: 403 });

  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.id, courseProjectId))
    .limit(1);
  const project = rows[0];
  if (!project || project.kind !== "course") throw forbidden;

  const role = await getUserRole(db, courseProjectId, userId);
  const permitted =
    codeRole === "instructor"
      ? role === "convenor"
      : role === "convenor" || role === "instructor";
  if (!permitted || role === null) throw forbidden;

  return { project, role };
}

/**
 * True when `userId` has course staff standing on the course tied to
 * `project` — the same admission rule `requireCourseCodeManager` applies
 * for a `collaborator`-role code: the course is resolved one hop up (the
 * project itself when it is a course, otherwise its `parent_project_id`),
 * and the caller must hold a `convenor` or `instructor` row there. This
 * must stay in step with that function's rule — a course tab shown to
 * anyone `/course`'s loader would refuse is a link to a 403.
 *
 * Resolves to `false` without a query when `project` names no course (a
 * plain site, or a child with no parent) — callers get "no branch of
 * their own" for that case.
 */
export async function hasCourseStanding(
  db: DbInstance,
  project: { id: number; kind: string; parent_project_id: number | null },
  userId: number,
): Promise<boolean> {
  const courseProjectId =
    project.kind === "course" ? project.id : project.parent_project_id;
  if (courseProjectId == null) return false;

  const role = await getUserRole(db, courseProjectId, userId);
  return role === "convenor" || role === "instructor";
}

/**
 * True when a membership exit must be refused: `role` is `instructor` and
 * `projectId` names a project with a parent (a child site enrolled in a
 * course).
 *
 * Instructor membership on a child is tied to the course in both
 * directions (design §5, "Joining and leaving") — copied down at
 * redemption, dropped only when the site leaves the course. Removing it
 * any other way would produce a state the design declares impossible, so
 * this check is shared by every membership exit: `remove-member` (a
 * convenor removing someone else) and `leave-project` (self-service, from
 * /account). Convenor and collaborator rows are never refused, and neither
 * is an instructor row on a project with no parent — the course project
 * itself, or an ordinary unaffiliated site.
 */
export async function isMembershipExitRefused(
  db: DbInstance,
  projectId: number,
  role: Role | null | undefined,
): Promise<boolean> {
  if (role !== "instructor") return false;
  const rows = await db
    .select({ parent_project_id: projects.parent_project_id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return rows[0]?.parent_project_id != null;
}

/**
 * Throw 403 if the user has no membership in the given project.
 *
 * Any non-null role (convenor or collaborator) passes. Use this for actions
 * that any project member is allowed to perform — e.g. autosaving project
 * config copy that collaborators are permitted to edit.
 */
export async function requireProjectMember(
  db: DbInstance,
  projectId: number,
  userId: number,
): Promise<void> {
  const role = await getUserRole(db, projectId, userId);
  if (role === null) {
    throw new Response("Forbidden", { status: 403 });
  }
}

/**
 * Six-colour palette for presence indicators.
 * Colours are distinct enough to be distinguishable against cream and charcoal backgrounds.
 */
export const PRESENCE_PALETTE = [
  "#E47A6F",
  "#6B9FE4",
  "#6BD4A0",
  "#D4A06B",
  "#A06BD4",
  "#D46BA0",
];

/**
 * Write the user's chosen presence colour through to every project_members
 * row they have. Single batched UPDATE bounded by WHERE user_id = ?
 * (cross-user write is structurally impossible).
 *
 * Caller is responsible for validating `color` against PRESENCE_PALETTE
 * before invoking this helper — XSS defence. The helper does
 * NOT re-validate to keep a single source of truth at the action boundary.
 */
export async function setUserPresenceColor(
  db: DbInstance,
  userId: number,
  color: string,
): Promise<void> {
  await db
    .update(project_members)
    .set({ presence_color: color })
    .where(eq(project_members.user_id, userId));
}

/**
 * Assign a presence colour to a project member.
 *
 * Later extension: first prefers the user's existing chosen
 * presence colour from their other memberships when (a) all of those
 * memberships have the same colour and (b) that colour is in
 * PRESENCE_PALETTE. This ensures a user joining a new project keeps the
 * colour they set on /account.
 *
 * Falls back to the legacy behaviour: query all existing
 * presence_color values for the project, find the first palette colour not
 * already in use, and write it to the member's row. Falls back to
 * PRESENCE_PALETTE[0] if all 6 colours are taken.
 *
 * Returns the assigned hex string.
 */
export async function assignPresenceColor(
  db: DbInstance,
  projectId: number,
  userId: number,
): Promise<string> {
  // Prefer the user's existing chosen colour across other memberships when
  // consistent and in-palette. Excludes the target (projectId, userId) row
  // implicitly because we filter for non-null and dedupe — a NULL value on
  // the target row contributes nothing.
  const userOtherColors = await db
    .select({ presence_color: project_members.presence_color })
    .from(project_members)
    .where(
      and(
        eq(project_members.user_id, userId),
        isNotNull(project_members.presence_color),
      ),
    );

  const distinctChosen = Array.from(
    new Set(
      userOtherColors
        .map((r) => r.presence_color)
        .filter((c): c is string => !!c),
    ),
  );

  if (
    distinctChosen.length === 1 &&
    PRESENCE_PALETTE.includes(distinctChosen[0])
  ) {
    await db
      .update(project_members)
      .set({ presence_color: distinctChosen[0] })
      .where(
        and(
          eq(project_members.project_id, projectId),
          eq(project_members.user_id, userId),
        ),
      );
    return distinctChosen[0];
  }

  // Legacy path — first unused palette colour for this project.
  const existing = await db
    .select({ presence_color: project_members.presence_color })
    .from(project_members)
    .where(eq(project_members.project_id, projectId));

  const usedColors = new Set(
    existing.map((r) => r.presence_color).filter(Boolean),
  );

  // Pick the first unused palette colour, or fall back to the first
  const color =
    PRESENCE_PALETTE.find((c) => !usedColors.has(c)) ?? PRESENCE_PALETTE[0];

  await db
    .update(project_members)
    .set({ presence_color: color })
    .where(
      and(
        eq(project_members.project_id, projectId),
        eq(project_members.user_id, userId),
      ),
    );

  return color;
}

/**
 * Get the presence colour for a project member, lazily assigning one if needed.
 *
 * If the member already has a presence_color in D1, returns it immediately.
 * If not, calls assignPresenceColor to pick and persist one.
 */
export async function getPresenceColor(
  db: DbInstance,
  projectId: number,
  userId: number,
): Promise<string> {
  const rows = await db
    .select({ presence_color: project_members.presence_color })
    .from(project_members)
    .where(
      and(
        eq(project_members.project_id, projectId),
        eq(project_members.user_id, userId),
      ),
    )
    .limit(1);

  const existing = rows[0]?.presence_color;
  if (existing) return existing;

  return assignPresenceColor(db, projectId, userId);
}
