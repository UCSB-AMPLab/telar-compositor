/**
 * This file is the server-side access control for project membership —
 * role lookup, project enumeration with stats, and presence-colour
 * assignment. Route loaders and actions call these helpers to enforce
 * who is allowed to see a project and what they are allowed to change
 * once they are in it.
 *
 * Two roles exist: a single `convenor` per project (the owner — full
 * read/write/delete) and any number of `collaborator` members (read +
 * editorial write, but not destructive operations). `requireOwner` and
 * `requireProjectMember` are the gate helpers route actions invoke at
 * the top of a handler; anything they don't throw on is allowed
 * through.
 *
 * The presence-colour helpers solve a parallel concern: when several
 * editors are in the same project, each needs a stable, distinguishable
 * colour for cursors and avatars. Colours are assigned lazily from a
 * six-entry palette, prefer a user's consistent choice across their
 * other memberships, and fall back to first-unused for the project.
 *
 * @version v1.2.0-beta
 */

import { eq, and, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import { getDb } from "~/lib/db.server";
import { projects, project_members } from "~/db/schema";

type Role = "convenor" | "collaborator";

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

  // collaborator_count: count members per project, excluding the caller.
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
