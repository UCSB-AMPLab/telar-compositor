/**
 * Membership helpers for multi-user project access.
 *
 * These functions implement the server-side access control layer for
 * collaborator and owner roles within projects. They are called by route
 * loaders and actions to enforce role-based restrictions.
 */

import { eq, and, inArray, isNull } from "drizzle-orm";
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
 * Assign a presence colour to a project member.
 *
 * Queries all existing presence_color values for the project, finds the first
 * palette colour not already in use, and writes it to the member's row.
 * Falls back to PRESENCE_PALETTE[0] if all 6 colours are taken.
 * Returns the assigned hex string.
 */
export async function assignPresenceColor(
  db: DbInstance,
  projectId: number,
  userId: number,
): Promise<string> {
  // Get all colours already in use for this project
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
