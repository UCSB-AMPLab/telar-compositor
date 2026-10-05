/**
 * The team page's actions: a convenor adding a member to the repository,
 * reissuing a lapsed invitation or withdrawing access, and a member accepting
 * their own invitation. Each reads the member's state from GitHub through the
 * installation token before acting and refuses when what it reads does not
 * allow the action, recording that reading so the page shows it.
 *
 * @version v1.5.0-beta
 */
import { and, eq } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import { project_members, users } from "~/db/schema";
import type { getDb } from "~/lib/db.server";
import { decrypt } from "~/lib/crypto.server";
import { getInstallationToken } from "~/lib/github-app.server";
import { deriveRepoAccess } from "~/lib/repo-access";
import type { RepoAccess, TeamActionError, TeamActionResult, TeamRowAction } from "~/lib/repo-access";
import {
  acceptInvitation,
  accountLogin,
  deleteInvitation,
  listRepoInvitations,
  memberPermission,
  removeCollaborator,
} from "~/lib/repo-access.server";
import type { RepoInvitation } from "~/lib/repo-access.server";
import { CONVENOR_ADD_DEADLINE_MS, attemptAdd, invitationOf, notRevoked, settleReading, withdrawIfRevoked } from "~/lib/team-access.server";
import type { StoredInvitation } from "~/lib/team-access.server";

type Db = ReturnType<typeof getDb>;
type TeamEnv = Pick<Env, "GITHUB_APP_ID" | "GITHUB_PRIVATE_KEY" | "ENCRYPTION_KEY">;

export type ConvenorIntent = Exclude<TeamRowAction, "accept">;

export interface TeamActionProject {
  id: number;
  github_repo_full_name: string;
  installation_id: number;
}

interface TeamTarget {
  memberId: number;
  role: "convenor" | "collaborator" | "instructor";
  githubId: number;
  invitationUrl: string | null;
  stored: StoredInvitation;
}

interface LiveReading {
  login: string;
  access: RepoAccess;
  /** The open or expired invitation GitHub lists; null when it lists none. */
  invitation: RepoInvitation | null;
  /** The invitation's id and link as recorded, kept for a lapsed one GitHub no longer lists. */
  recorded: { id: number | null; url: string | null };
}

interface GitHubSide {
  token: string;
  owner: string;
  repo: string;
}

async function loadTarget(db: Db, projectId: number, userId: number): Promise<TeamTarget | null> {
  const [row] = await db
    .select({
      memberId: project_members.id,
      role: project_members.role,
      githubId: users.github_id,
      invitationUrl: project_members.gh_invitation_url,
      storedAccess: project_members.gh_access,
      storedId: project_members.gh_invitation_id,
    })
    .from(project_members)
    .innerJoin(users, eq(users.id, project_members.user_id))
    .where(and(eq(project_members.project_id, projectId), eq(project_members.user_id, userId)));
  if (!row) return null;
  const { storedAccess, storedId, ...target } = row;
  return { ...target, stored: { access: storedAccess, id: storedId, url: target.invitationUrl } };
}

async function gitHubSide(env: TeamEnv, project: TeamActionProject): Promise<GitHubSide> {
  const [owner, repo] = project.github_repo_full_name.split("/");
  const token = await getInstallationToken(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY, project.installation_id);
  return { token, owner, repo };
}

/** The reconciler's reading for one member, by account id; null when the account is gone. */
async function readTeamMemberLive(gh: GitHubSide, target: TeamTarget): Promise<LiveReading | null> {
  const githubId = target.githubId;
  const login = githubId > 0 ? await accountLogin(gh.token, githubId) : null;
  if (login === null) return null;
  const [permission, invitations] = await Promise.all([
    memberPermission(gh.token, gh.owner, gh.repo, login),
    listRepoInvitations(gh.token, gh.owner, gh.repo),
  ]);
  const { reading, found } = invitationOf(invitations, login);
  const settled = settleReading(deriveRepoAccess(permission, reading), found, target.stored);
  return { login, access: settled.access, invitation: found, recorded: { id: settled.id, url: settled.url } };
}

function updateTeamTarget(db: Db, memberId: number, set: SQLiteUpdateSetSource<typeof project_members>, also?: SQL) {
  return db.update(project_members).set(set).where(and(eq(project_members.id, memberId), also));
}

function readingSet(live: LiveReading) {
  return {
    gh_access: live.access,
    gh_invitation_id: live.recorded.id,
    gh_invitation_url: live.recorded.url,
    gh_access_checked_at: new Date().toISOString(),
  };
}

function convenorActionApplies(intent: ConvenorIntent, live: LiveReading): boolean {
  switch (intent) {
    case "add":
      return live.access === "none";
    case "reissue":
      return live.access === "lapsed";
    case "revoke":
      return live.access !== "none";
  }
}

/** A convenor's add or reissue: the App owes the member the add again, counted from one. */
async function sendConvenorAdd(db: Db, gh: GitHubSide, target: TeamTarget, live: LiveReading): Promise<boolean> {
  if (live.invitation) await deleteInvitation(gh.token, gh.owner, gh.repo, live.invitation.id);
  // Marked sending before GitHub is called, so a membership ending mid-add records its
  // withdrawal (which needs the add owed); a row left sending is retried by the reconciler
  // (owesAdd). Nothing is sent for a row that is gone or revoked.
  const marked = await updateTeamTarget(db, target.memberId, { gh_add_owed: true, gh_add_state: "sending" }, notRevoked)
    .returning({ id: project_members.id });
  if (marked.length === 0) return false;
  const outcome = await attemptAdd(gh.token, gh.owner, gh.repo, live.login, AbortSignal.timeout(CONVENOR_ADD_DEADLINE_MS));
  const attempt = { gh_add_owed: true, gh_add_attempts: 1, gh_add_attempted_at: new Date().toISOString() };
  const written = await updateTeamTarget(db, target.memberId, { ...readingSet(live), ...attempt, ...outcome }, notRevoked)
    .returning({ id: project_members.id });
  if (written.length === 0) await withdrawIfRevoked(db, gh, target.memberId, outcome);
  return written.length > 0 && outcome.gh_add_state === "sent";
}

async function withdrawAccess(db: Db, gh: GitHubSide, target: TeamTarget, live: LiveReading): Promise<void> {
  if (live.access === "access") await removeCollaborator(gh.token, gh.owner, gh.repo, live.login);
  else if (live.invitation) await deleteInvitation(gh.token, gh.owner, gh.repo, live.invitation.id);
  const none = { gh_access: "none" as const, gh_invitation_id: null, gh_invitation_url: null };
  await updateTeamTarget(db, target.memberId, {
    ...none,
    gh_access_checked_at: new Date().toISOString(),
    gh_add_state: "revoked",
    gh_add_error: null,
  });
}

async function actOnTeamMember(db: Db, gh: GitHubSide, intent: ConvenorIntent, target: TeamTarget): Promise<TeamActionError | null> {
  const live = await readTeamMemberLive(gh, target);
  if (live === null) return "changed";
  if (!convenorActionApplies(intent, live)) {
    await updateTeamTarget(db, target.memberId, readingSet(live));
    return "changed";
  }
  if (intent === "revoke") {
    await withdrawAccess(db, gh, target, live);
    return null;
  }
  return (await sendConvenorAdd(db, gh, target, live)) ? null : "failed";
}

/**
 * A convenor's action on another member's row. The caller has been checked
 * as the project's convenor. Instructors' access belongs to the course, and a
 * convenor's own access is not withdrawn from the page.
 */
export async function runConvenorTeamAction(
  env: TeamEnv,
  db: Db,
  project: TeamActionProject,
  intent: ConvenorIntent,
  userId: number,
): Promise<TeamActionResult> {
  const target = await loadTarget(db, project.id, userId);
  if (!target) return { ok: false, userId, error: "changed" };
  if (target.role === "instructor") return { ok: false, userId, error: "instructor" };
  if (intent === "revoke" && target.role === "convenor") return { ok: false, userId, error: "owner" };
  try {
    const error = await actOnTeamMember(db, await gitHubSide(env, project), intent, target);
    return error ? { ok: false, userId, error } : { ok: true, userId };
  } catch (err) {
    console.warn("[team-actions]", intent, "failed for user", userId, err);
    return { ok: false, userId, error: "failed" };
  }
}

/** Accepts the open invitation read, on the caller's own token; false when GitHub refused it. */
async function acceptOnOwnToken(env: TeamEnv, encryptedToken: string, invitationId: number): Promise<boolean> {
  try {
    const userToken = await decrypt(encryptedToken, env.ENCRYPTION_KEY);
    const result = await acceptInvitation(userToken, invitationId);
    return result === "accepted" || result === "unchanged";
  } catch (err) {
    console.warn("[team-actions] accept refused", err);
    return false;
  }
}

/**
 * The caller accepting their own invitation. The invitation is read through
 * the installation token, as every other reading on the page is: the
 * repository's listing names this repository's invitation directly, where the
 * caller's own listing spans every repository they are invited to. Only the
 * accept travels on the caller's token. Any refusal hands back the GitHub
 * invitation page as the fallback.
 */
export async function acceptOwnTeamInvitation(
  env: TeamEnv,
  db: Db,
  project: TeamActionProject,
  caller: { id: number; encrypted_access_token: string },
): Promise<TeamActionResult> {
  const userId = caller.id;
  const target = await loadTarget(db, project.id, userId);
  if (!target) return { ok: false, userId, error: "changed" };
  const refusedAccept = (url: string | null | undefined): TeamActionResult => ({
    ok: false,
    userId,
    error: "accept_refused",
    fallbackUrl: url ?? target.invitationUrl ?? `https://github.com/${project.github_repo_full_name}/invitations`,
  });
  let live: LiveReading | null;
  try {
    live = await readTeamMemberLive(await gitHubSide(env, project), target);
  } catch (err) {
    console.warn("[team-actions] reading the invitation failed", err);
    return refusedAccept(null);
  }
  if (live === null) return { ok: false, userId, error: "changed" };
  if (live.access === "lapsed") {
    await updateTeamTarget(db, target.memberId, readingSet(live));
    return { ok: false, userId, error: "lapsed" };
  }
  if (live.access !== "pending" || !live.invitation) {
    await updateTeamTarget(db, target.memberId, readingSet(live));
    return { ok: false, userId, error: "changed" };
  }
  if (!(await acceptOnOwnToken(env, caller.encrypted_access_token, live.invitation.id))) return refusedAccept(live.invitation.htmlUrl);
  const accepted = { gh_access: "access" as const, gh_invitation_id: null, gh_invitation_url: null };
  await updateTeamTarget(db, target.memberId, { ...accepted, gh_access_checked_at: new Date().toISOString() });
  return { ok: true, userId };
}
