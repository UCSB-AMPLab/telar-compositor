/**
 * This file reads the team page's roster from the database alone: each
 * member of a project with the repository-access state the reconciler last
 * wrote and when it wrote it, and each invite link still outstanding. It
 * never calls GitHub.
 *
 * @version v1.5.0-beta
 */
import { and, asc, eq, gt, isNull, or } from "drizzle-orm";
import { project_invites, project_members, users } from "~/db/schema";
import type { getDb } from "~/lib/db.server";
import { stageFor, teamRowState } from "~/lib/repo-access";
import type { TeamRowState } from "~/lib/repo-access";
import { ADD_ATTEMPT_CAP, TEAM_ACCESS_TTL_MS } from "~/lib/team-access.server";
import { isLegacyInviteToken } from "~/lib/join-codes.server";

export interface TeamRosterRow {
  userId: number;
  githubId: number;
  username: string;
  role: "convenor" | "collaborator" | "instructor";
  state: TeamRowState;
  /** The last failed add's message, for a convenor's tooltip. */
  error: string | null;
  checkedAt: string | null;
  /** Never read, or read by a run before the page's newest, so the row says when itself. */
  behind: boolean;
}

/** An invite link nobody has followed yet. It names no one until it is used. */
export interface TeamInvitedRow {
  state: TeamRowState;
  expiresAt: string | null;
}

export interface TeamRoster {
  rows: TeamRosterRow[];
  invited: TeamInvitedRow[];
  /** The latest time any row was read from GitHub, or null if none has been. */
  checkedAt: string | null;
}

/**
 * A lapsed reading exists only because the listing showed an expired
 * invitation, so it is real wherever it appears. What stays unconfirmed is
 * whether the listing always includes them, so a member read as none may
 * have a lapsed invitation too; the row says only that they are not added.
 */
const LISTING_CONFIRMED = true;

export async function loadTeamRoster(db: ReturnType<typeof getDb>, projectId: number): Promise<TeamRoster> {
  const members = await db
    .select({
      userId: project_members.user_id,
      githubId: users.github_id,
      username: users.github_login,
      role: project_members.role,
      access: project_members.gh_access,
      addState: project_members.gh_add_state,
      attempts: project_members.gh_add_attempts,
      error: project_members.gh_add_error,
      owed: project_members.gh_add_owed,
      checkedAt: project_members.gh_access_checked_at,
    })
    .from(project_members)
    .innerJoin(users, eq(users.id, project_members.user_id))
    .where(eq(project_members.project_id, projectId))
    .orderBy(asc(project_members.id));
  const times = members.map((m) => m.checkedAt).filter((c): c is string => c !== null);
  const newest = times.length > 0 ? times.sort().at(-1)! : null;
  const rows = members.map((m): TeamRosterRow => {
    const stage = stageFor("member", m.access, LISTING_CONFIRMED);
    const state = teamRowState({ ...m, stage }, ADD_ATTEMPT_CAP);
    return {
      userId: m.userId,
      githubId: m.githubId,
      username: m.username,
      role: m.role,
      state,
      error: m.error,
      checkedAt: m.checkedAt,
      behind: isBehindNewest(m.checkedAt, newest),
    };
  });
  return { rows, invited: await loadOutstandingInvites(db, projectId), checkedAt: newest };
}

/** A run stamps all its rows alike and runs are an interval apart; an action's stamp falls within one. */
function isBehindNewest(checkedAt: string | null, newest: string | null): boolean {
  if (checkedAt === null || newest === null) return true;
  return Date.parse(newest) - Date.parse(checkedAt) > TEAM_ACCESS_TTL_MS;
}

/**
 * The sidebar's pending invitations, less the ones past their expiry, which
 * nobody can follow: single-use links not used and not cancelled. A course
 * code is standing infrastructure and is not an invitation.
 */
async function loadOutstandingInvites(db: ReturnType<typeof getDb>, projectId: number): Promise<TeamInvitedRow[]> {
  const invites = await db
    .select({ token: project_invites.token, expiresAt: project_invites.expires_at })
    .from(project_invites)
    .where(
      and(
        eq(project_invites.project_id, projectId),
        isNull(project_invites.used_at),
        isNull(project_invites.revoked_at),
        or(isNull(project_invites.expires_at), gt(project_invites.expires_at, new Date().toISOString())),
      ),
    )
    .orderBy(asc(project_invites.id));
  const state = teamRowState(
    { role: "collaborator", stage: stageFor("invite", null, LISTING_CONFIRMED), addState: null, attempts: 0, owed: true },
    ADD_ATTEMPT_CAP,
  );
  return invites.filter((i) => isLegacyInviteToken(i.token)).map((i) => ({ state, expiresAt: i.expiresAt }));
}
