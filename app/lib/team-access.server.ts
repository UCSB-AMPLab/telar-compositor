/**
 * The team-access reconciler: reads where each member of a project stands on
 * its repository, through the installation token, writes it to their row, and
 * sends the adds the App owes. It is the only place an add is sent; member
 * insertion owes one through gh_add_owed and nothing else. It also withdraws
 * the access of people whose membership has ended (repo_access_withdrawals),
 * and deletes invitations the App sent to people who are not members.
 *
 * @version v1.5.0-beta
 */
import { and, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import { project_members, projects, repo_access_withdrawals, users } from "~/db/schema";
import type { getDb } from "~/lib/db.server";
import { getInstallationToken } from "~/lib/github-app.server";
import { GitHubPermissionError } from "~/lib/github.server";
import { deriveRepoAccess } from "~/lib/repo-access";
import type { InvitationReading, RepoAccess } from "~/lib/repo-access";
import {
  GitHubUnprocessableError,
  accountLogin,
  addCollaborator,
  deleteInvitation,
  listRepoInvitations,
  memberPermission,
  removeCollaborator,
} from "~/lib/repo-access.server";
import type { RepoInvitation } from "~/lib/repo-access.server";

type Db = ReturnType<typeof getDb>;

export const TEAM_ACCESS_TTL_MS = 45_000;

/**
 * A run's own deadline, so that nothing of it is still at GitHub when a later
 * run may claim. A later run can claim from stamp + 45 s. This run starts no
 * member and no add after stamp + 22.5 s, and every GitHub call it makes is
 * aborted at stamp + 40 s, so its last call ends 5 s before the claim frees;
 * a member started at the last moment still has 17.5 s for its four calls.
 * Aborting drops our side of a request; a PUT GitHub already received may
 * still land, and the next run reads it as pending and records it as sent.
 */
export const TEAM_RUN_START_WINDOW_MS = TEAM_ACCESS_TTL_MS / 2;
const TEAM_RUN_CALL_MARGIN_MS = 5_000;

/** How long a convenor's add may be at GitHub: no longer than a run's own last call. */
export const CONVENOR_ADD_DEADLINE_MS = TEAM_ACCESS_TTL_MS - TEAM_RUN_CALL_MARGIN_MS;

/**
 * How long, from its recording, a withdrawal whose GitHub reading is empty
 * waits before it is settled. An add aborted at its deadline (a run's stamp +
 * 40 s, or a convenor's add CONVENOR_ADD_DEADLINE_MS after it is sent) may
 * still be processed by GitHub afterwards, and the withdrawal was recorded
 * while that add was in flight, so at most 40 s before the abort.
 * Five claim intervals (3.75 minutes) leave GitHub over three minutes to take
 * the request; a reading that finds access or an invitation acts at once. An
 * invitation that opens after the window is removed by sweepStrayInvitations.
 */
export const WITHDRAWAL_SETTLE_WINDOW_MS = 5 * TEAM_ACCESS_TTL_MS;

/**
 * Attempts at an add before the reconciler stops retrying it. The row stays
 * failed, with its last error, so the team page shows it; a convenor's retry
 * is what sends it again past the cap.
 */
export const ADD_ATTEMPT_CAP = 5;

/**
 * At most this many stray invitations are deleted in one run. A failed delete
 * does not count, so invitations whose delete keeps failing never hold back
 * the others; the start window bounds the run.
 */
export const STRAY_INVITATION_CAP = 5;

export interface TeamAccessProject {
  id: number;
  github_repo_full_name: string;
  installation_id: number;
}

interface TeamAccessRun {
  db: Db;
  projectId: number;
  token: string;
  owner: string;
  repo: string;
  invitations: RepoInvitation[];
  /** The App's bot login, lowercased: the inviter of every invitation the App sent. */
  appBot: string;
  /** Invitations this run's withdrawals deleted, which the sweep does not delete again. */
  withdrawnInvitations: Set<number>;
  nowIso: string;
  claimedAt: number;
  signal: AbortSignal;
}

interface TeamMemberRow {
  id: number;
  userId: number;
  githubId: number;
  login: string;
  role: "convenor" | "collaborator" | "instructor";
  owed: boolean;
  addState: "sending" | "sent" | "failed" | "revoked" | null;
  attempts: number;
  stored: StoredInvitation;
}

/** One caller per project within the interval wins; the stamp holds even when the run fails. */
async function claimTeamRefresh(db: Db, projectId: number, now: number): Promise<boolean> {
  const staleBefore = new Date(now - TEAM_ACCESS_TTL_MS).toISOString();
  const claimed = await db
    .update(projects)
    .set({ gh_team_checked_at: new Date(now).toISOString() })
    .where(
      and(
        eq(projects.id, projectId),
        or(isNull(projects.gh_team_checked_at), lt(projects.gh_team_checked_at, staleBefore)),
      ),
    )
    .returning({ id: projects.id });
  return claimed.length === 1;
}

/** A later run took the project's claim; this run stops without writing. */
class TeamRefreshOvertaken extends Error {}


function claimHeld(run: TeamAccessRun): SQL {
  return sql`(SELECT ${projects.gh_team_checked_at} FROM ${projects} WHERE ${projects.id} = ${run.projectId}) = ${run.nowIso}`;
}

/**
 * Every write of a run carries its claim: it lands only while the project's
 * gh_team_checked_at is still this run's stamp. A run outlasting the interval
 * can be overtaken by a later one, and its listing is then older than what
 * the later run reads and writes.
 */
async function writeTeamMember(
  run: TeamAccessRun,
  memberId: number,
  set: SQLiteUpdateSetSource<typeof project_members>,
  also?: SQL,
): Promise<void> {
  const written = await run.db
    .update(project_members)
    .set(set)
    .where(and(eq(project_members.id, memberId), claimHeld(run), also))
    .returning({ id: project_members.id });
  if (written.length === 0) throw new TeamRefreshOvertaken();
}

/** An open invitation outranks an expired one for the same login; logins compare without case, as GitHub's do. */
export function invitationOf(invitations: RepoInvitation[], login: string): { reading: InvitationReading; found: RepoInvitation | null } {
  const mine = invitations.filter((i) => i.inviteeLogin?.toLowerCase() === login.toLowerCase());
  const open = mine.find((i) => !i.expired);
  if (open) return { reading: "open", found: open };
  if (mine.length > 0) return { reading: "expired", found: mine[0] };
  return { reading: "none", found: null };
}

/** What a member's row recorded at the last reading. */
export interface StoredInvitation {
  access: RepoAccess | null;
  id: number | null;
  url: string | null;
}

/**
 * GitHub lists open invitations only, so an invitation that expired or was
 * declined drops out of the listing and the reading comes back as none. A
 * member recorded with an invitation, still without permission, is lapsed:
 * the remedy is a new invitation from a convenor, and the record keeps the
 * invitation's id and link.
 */
export function settleReading(
  access: RepoAccess,
  found: RepoInvitation | null,
  stored: StoredInvitation,
): { access: RepoAccess; id: number | null; url: string | null } {
  const hadInvitation = (stored.access === "pending" || stored.access === "lapsed") && stored.id !== null;
  if (access === "none" && hadInvitation) return { access: "lapsed", id: stored.id, url: stored.url };
  return { access, id: found?.id ?? null, url: found?.htmlUrl ?? null };
}

/**
 * A lapsed invitation is reissued by a convenor (delete, then add), not added
 * over. A row still marked sending belongs to a run that ended before writing
 * its add's answer, since no two runs overlap, and is retried like a failure.
 */
function owesAdd(member: TeamMemberRow, access: RepoAccess): boolean {
  if (!member.owed || access !== "none") return false;
  if (member.addState === null) return true;
  return (member.addState === "failed" || member.addState === "sending") && member.attempts < ADD_ATTEMPT_CAP;
}

export type AddOutcome = SQLiteUpdateSetSource<typeof project_members> & { gh_invitation_id?: number | null };

/**
 * Sends one add and returns what to record of it, as both the reconciler and
 * a convenor's add record it: the invitation GitHub opened, access on a 204,
 * or the failure with its message. The caller adds its own attempt count.
 */
export async function attemptAdd(token: string, owner: string, repo: string, login: string, signal?: AbortSignal): Promise<AddOutcome> {
  try {
    const added = await addCollaborator(token, owner, repo, login, signal);
    const reached =
      added.status === "invited"
        ? { gh_access: "pending" as const, gh_invitation_id: added.invitationId, gh_invitation_url: added.htmlUrl }
        : { gh_access: "access" as const, gh_invitation_id: null, gh_invitation_url: null };
    return { ...reached, gh_add_state: "sent", gh_add_error: null };
  } catch (err) {
    console.warn("[team-access] add failed for", login, err);
    const error = err instanceof Error ? err.message : String(err);
    return { gh_add_state: "failed", gh_add_error: error };
  }
}

/**
 * Marks the row sending, under the run's claim, before GitHub is called, so
 * that a membership ending while the add is in flight records a withdrawal for
 * it (recordWithdrawals). False when the row is gone or revoked: no add is sent.
 */
async function markAddSending(run: TeamAccessRun, memberId: number): Promise<boolean> {
  const marked = await run.db
    .update(project_members)
    .set({ gh_add_state: "sending" })
    .where(and(eq(project_members.id, memberId), claimHeld(run), notRevoked))
    .returning({ id: project_members.id });
  return marked.length > 0;
}

/**
 * A convenor may withdraw access while an add is in flight. The outcome then
 * lands only on a row not revoked meanwhile, and an invitation the add opened
 * for a revoked row is withdrawn at once, so the add never outlives the
 * withdrawal; a later run never adds a revoked row.
 */
async function sendAdd(run: TeamAccessRun, member: TeamMemberRow): Promise<void> {
  if (!(await markAddSending(run, member.id))) return;
  const outcome = await attemptAdd(run.token, run.owner, run.repo, member.login, run.signal);
  const attempt = {
    gh_add_attempts: sql`${project_members.gh_add_attempts} + 1`,
    gh_add_attempted_at: run.nowIso,
  };
  try {
    await writeTeamMember(run, member.id, { ...attempt, ...outcome }, notRevoked);
  } catch (err) {
    if (!(await withdrawIfRevoked(run.db, run, member.id, outcome))) throw err;
  }
}

/** A row a convenor withdrew: no add's outcome lands on it. */
export const notRevoked = or(isNull(project_members.gh_add_state), ne(project_members.gh_add_state, "revoked"));

/**
 * When the row was revoked while an add was in flight, deletes the invitation
 * that add opened and returns true; false when the row is not revoked.
 */
export async function withdrawIfRevoked(
  db: Db,
  gh: { token: string; owner: string; repo: string },
  memberId: number,
  outcome: AddOutcome,
): Promise<boolean> {
  const [row] = await db.select({ state: project_members.gh_add_state }).from(project_members).where(eq(project_members.id, memberId));
  if (row?.state !== "revoked") return false;
  if (outcome.gh_invitation_id) await deleteInvitation(gh.token, gh.owner, gh.repo, outcome.gh_invitation_id);
  return true;
}

/**
 * The account id is durable and the login is not: a login stored at sign-in
 * may since belong to someone else, so it is never what is read or added.
 * An account GitHub no longer has is recorded as unreachable.
 */
async function reconcileTeamMember(run: TeamAccessRun, member: TeamMemberRow): Promise<void> {
  const login = member.githubId > 0 ? await accountLogin(run.token, member.githubId, run.signal) : null;
  if (login === null) {
    const unreachable = owesAdd(member, "none") ? { gh_add_state: "failed" as const, gh_add_error: "GitHub account not found" } : {};
    const none = { gh_access: "none" as const, gh_invitation_id: null, gh_invitation_url: null };
    return writeTeamMember(run, member.id, { ...none, gh_access_checked_at: run.nowIso, ...unreachable });
  }
  // Only over the login this run loaded: a sign-in that stored a newer one since wins.
  if (login !== member.login) {
    await run.db.update(users).set({ github_login: login })
      .where(and(eq(users.id, member.userId), eq(users.github_login, member.login)));
  }
  const permission = await memberPermission(run.token, run.owner, run.repo, login, run.signal);
  const { reading, found } = invitationOf(run.invitations, login);
  const settledReading = settleReading(deriveRepoAccess(permission, reading), found, member.stored);
  const access = settledReading.access;
  // A failed or unanswered add GitHub took anyway (the response was lost) reads as reached.
  const unanswered = member.addState === "failed" || member.addState === "sending";
  const settled = unanswered && access !== "none" ? { gh_add_state: "sent" as const, gh_add_error: null } : {};
  await writeTeamMember(run, member.id, {
    gh_access: access,
    gh_invitation_id: settledReading.id,
    gh_invitation_url: settledReading.url,
    gh_access_checked_at: run.nowIso,
    ...settled,
  });
  if (owesAdd(member, access) && withinStartWindow(run)) await sendAdd(run, { ...member, login });
}

function withinStartWindow(run: TeamAccessRun): boolean {
  return Date.now() - run.claimedAt <= TEAM_RUN_START_WINDOW_MS;
}

interface PendingWithdrawal {
  id: number;
  projectId: number;
  userId: number;
  githubId: number | null;
  attempts: number;
  createdAt: string;
  rejoined: number;
}

/** Reads again whether the person joined the project: they may join while GitHub is being read. */
async function hasRejoined(run: TeamAccessRun, pending: PendingWithdrawal): Promise<boolean> {
  const rows = await run.db
    .select({ userId: project_members.user_id })
    .from(project_members)
    .where(and(eq(project_members.project_id, pending.projectId), eq(project_members.user_id, pending.userId)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Deletes a withdrawal, or records its failure, under the run's claim. Only a
 * failure that counts adds to the attempts: anything but a GitHub refusal is
 * retried without limit.
 */
async function settleWithdrawal(run: TeamAccessRun, id: number, failure: string | null, counts = true): Promise<void> {
  const mine = and(eq(repo_access_withdrawals.id, id), claimHeld(run));
  const settled = failure === null
    ? await run.db.delete(repo_access_withdrawals).where(mine).returning({ id: repo_access_withdrawals.id })
    : await run.db
      .update(repo_access_withdrawals)
      .set({ attempts: counts ? sql`${repo_access_withdrawals.attempts} + 1` : repo_access_withdrawals.attempts, last_error: failure })
      .where(mine)
      .returning({ id: repo_access_withdrawals.id });
  if (settled.length === 0) throw new TeamRefreshOvertaken();
}

/** Whether a failure is GitHub refusing the request, the only kind that counts toward the attempt cap. */
function isGitHubRefusal(err: unknown): boolean {
  return err instanceof GitHubPermissionError || err instanceof GitHubUnprocessableError;
}

/**
 * Removes the collaborator and deletes the open invitation for the login of a
 * GitHub account id, each skipped if the person has joined the project again
 * since the withdrawal was read. False when the reading found neither access
 * nor an open invitation for an account GitHub still has; true otherwise.
 */
async function withdrawGitHubAccess(run: TeamAccessRun, pending: PendingWithdrawal, githubId: number): Promise<boolean> {
  const login = await accountLogin(run.token, githubId, run.signal);
  if (login === null) return true;
  const permission = await memberPermission(run.token, run.owner, run.repo, login, run.signal);
  const { reading, found } = invitationOf(run.invitations, login);
  const hasAccess = deriveRepoAccess(permission, reading) === "access";
  if (hasAccess && !(await hasRejoined(run, pending))) await removeCollaborator(run.token, run.owner, run.repo, login, run.signal);
  if (reading === "open" && found && !(await hasRejoined(run, pending))) {
    await deleteInvitation(run.token, run.owner, run.repo, found.id, run.signal);
    run.withdrawnInvitations.add(found.id);
  }
  return hasAccess || reading === "open";
}

/**
 * Withdraws one person's access and invitation, read under the current login
 * of the account id recorded with the withdrawal. A person who joined the
 * project again keeps both, and a person with no account id has nothing to
 * withdraw. Only a GitHub refusal (GitHubPermissionError or
 * GitHubUnprocessableError) counts toward the attempt cap; a network failure,
 * an abort or a transient error says nothing about the next try and records
 * its message only. Past the cap the row stays, with its last error, and
 * GitHub is not called for it again. A reading with neither access nor an
 * invitation, younger than WITHDRAWAL_SETTLE_WINDOW_MS, leaves the row as it
 * is, uncounted, for a later run to read again.
 */
async function withdrawDeparted(run: TeamAccessRun, pending: PendingWithdrawal): Promise<void> {
  if (pending.rejoined || pending.githubId === null || pending.githubId <= 0) return settleWithdrawal(run, pending.id, null);
  if (pending.attempts >= ADD_ATTEMPT_CAP) return;
  let found: boolean;
  try {
    found = await withdrawGitHubAccess(run, pending, pending.githubId);
  } catch (err) {
    console.warn("[team-access] withdrawal failed", pending.id, err);
    return settleWithdrawal(run, pending.id, err instanceof Error ? err.message : String(err), isGitHubRefusal(err));
  }
  if (!found && run.claimedAt - Date.parse(pending.createdAt) < WITHDRAWAL_SETTLE_WINDOW_MS) return;
  return settleWithdrawal(run, pending.id, null);
}

async function drainWithdrawals(run: TeamAccessRun): Promise<void> {
  const pending = await run.db
    .select({
      id: repo_access_withdrawals.id,
      projectId: repo_access_withdrawals.project_id,
      userId: repo_access_withdrawals.user_id,
      githubId: repo_access_withdrawals.github_id,
      attempts: repo_access_withdrawals.attempts,
      createdAt: repo_access_withdrawals.created_at,
      // Qualified by hand: a one-table select renders its columns unqualified.
      rejoined: sql<number>`EXISTS (SELECT 1 FROM ${project_members} AS m WHERE m.project_id = ${repo_access_withdrawals}.project_id AND m.user_id = ${repo_access_withdrawals}.user_id)`,
    })
    .from(repo_access_withdrawals)
    .where(eq(repo_access_withdrawals.project_id, run.projectId))
    .orderBy(repo_access_withdrawals.id);
  // One withdrawal's failed write leaves the rest, and the member pass, to run.
  for (const withdrawal of pending) {
    if (!withinStartWindow(run)) throw new TeamRefreshOvertaken();
    try {
      await withdrawDeparted(run, withdrawal);
    } catch (err) {
      if (err instanceof TeamRefreshOvertaken) throw err;
      console.warn("[team-access] withdrawal write failed", withdrawal.id, err);
    }
  }
}

/** Throws TeamRefreshOvertaken unless the project's claim is still this run's stamp. */
async function assertClaimHeld(run: TeamAccessRun): Promise<void> {
  const held = await run.db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, run.projectId), eq(projects.gh_team_checked_at, run.nowIso)));
  if (held.length === 0) throw new TeamRefreshOvertaken();
}

/**
 * The GitHub account ids whose invitations the sweep keeps: every member of
 * the project, a deleted account's row included, and every person with a
 * withdrawal still pending, which drainWithdrawals settles. Read after the
 * invitation listing, so a person who joined since it was read is kept.
 */
async function keptAccountIds(run: TeamAccessRun, only?: number): Promise<Set<number>> {
  const members = await run.db
    .select({ githubId: users.github_id })
    .from(project_members)
    .innerJoin(users, eq(users.id, project_members.user_id))
    .where(and(eq(project_members.project_id, run.projectId), only === undefined ? undefined : eq(users.github_id, only)));
  const pending = await run.db
    .select({ githubId: repo_access_withdrawals.github_id })
    .from(repo_access_withdrawals)
    .where(and(eq(repo_access_withdrawals.project_id, run.projectId), only === undefined ? undefined : eq(repo_access_withdrawals.github_id, only)));
  const ids = [...members, ...pending].map((r) => r.githubId).filter((id): id is number => id !== null);
  return new Set(ids);
}

/** An open invitation the App sent to an account that is neither a member nor pending withdrawal. */
function isStray(run: TeamAccessRun, invitation: RepoInvitation, kept: Set<number>): boolean {
  if (invitation.expired || invitation.inviteeId === null || kept.has(invitation.inviteeId)) return false;
  if (run.withdrawnInvitations.has(invitation.id)) return false;
  return invitation.inviterLogin?.toLowerCase() === run.appBot;
}

/** Reads again whether the invitee became a member or has a withdrawal pending: they may join during the sweep. */
async function isKeptNow(run: TeamAccessRun, invitation: RepoInvitation): Promise<boolean> {
  return (await keptAccountIds(run, invitation.inviteeId ?? undefined)).size > 0;
}

/**
 * An add GitHub processes after its abort can open an invitation for a
 * person whose membership has since ended, with no withdrawal left to remove
 * it. Deletes such invitations, only those the App sent, so an invitation a
 * person sent by hand on GitHub is never touched. A failed delete is left for
 * a later run.
 */
async function sweepStrayInvitations(run: TeamAccessRun): Promise<void> {
  const kept = await keptAccountIds(run);
  let deleted = 0;
  for (const stray of run.invitations.filter((i) => isStray(run, i, kept))) {
    if (deleted >= STRAY_INVITATION_CAP || !withinStartWindow(run)) return;
    await assertClaimHeld(run);
    if (await isKeptNow(run, stray)) continue;
    if (await deletedStray(run, stray)) deleted++;
  }
}

/** Deletes one stray invitation; false when the delete failed, which a later run retries. */
async function deletedStray(run: TeamAccessRun, stray: RepoInvitation): Promise<boolean> {
  try {
    await deleteInvitation(run.token, run.owner, run.repo, stray.id, run.signal);
    return true;
  } catch (err) {
    console.warn("[team-access] stray invitation delete failed", stray.id, err);
    return false;
  }
}

/** Runs one stage of a run; false when a later run took the claim during it. */
async function untilOvertaken(stage: () => Promise<void>): Promise<boolean> {
  try {
    await stage();
    return true;
  } catch (err) {
    if (err instanceof TeamRefreshOvertaken) return false;
    throw err;
  }
}

async function runTeamRefresh(
  env: Pick<Env, "GITHUB_APP_ID" | "GITHUB_PRIVATE_KEY" | "GITHUB_APP_SLUG">,
  db: Db,
  project: TeamAccessProject,
  target: { owner: string; repo: string; nowIso: string; claimedAt: number; signal: AbortSignal },
): Promise<void> {
  const token = await getInstallationToken(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY, project.installation_id);
  const invitations = await listRepoInvitations(token, target.owner, target.repo, target.signal);
  const appBot = `${env.GITHUB_APP_SLUG}[bot]`.toLowerCase();
  const run: TeamAccessRun = { db, projectId: project.id, token, invitations, appBot, withdrawnInvitations: new Set(), ...target };
  if (!(await untilOvertaken(() => drainWithdrawals(run)))) return;
  const rows = await db
    .select({
      id: project_members.id,
      userId: project_members.user_id,
      githubId: users.github_id,
      login: users.github_login,
      role: project_members.role,
      owed: project_members.gh_add_owed,
      addState: project_members.gh_add_state,
      attempts: project_members.gh_add_attempts,
      storedAccess: project_members.gh_access,
      storedId: project_members.gh_invitation_id,
      storedUrl: project_members.gh_invitation_url,
    })
    .from(project_members)
    .innerJoin(users, eq(users.id, project_members.user_id))
    .where(and(eq(project_members.project_id, project.id), isNull(users.deleted_at)));
  const members: TeamMemberRow[] = rows.map(({ storedAccess, storedId, storedUrl, ...member }) => ({
    ...member,
    stored: { access: storedAccess, id: storedId, url: storedUrl },
  }));
  for (const member of members) {
    if (!withinStartWindow(run)) return;
    try {
      await reconcileTeamMember(run, member);
    } catch (err) {
      if (err instanceof TeamRefreshOvertaken) return;
      console.warn("[team-access] refresh failed for member", member.login, err);
    }
  }
  await untilOvertaken(() => sweepStrayInvitations(run));
}

/**
 * Refreshes every member's repository access for one project, if this caller
 * wins the project's claim. A failure to start (token, listing) leaves every
 * row as it was; a failure on one member leaves that member's row. Nothing is
 * thrown: the claim's stamp spaces out the next attempt.
 */
export async function refreshTeamAccess(
  env: Pick<Env, "GITHUB_APP_ID" | "GITHUB_PRIVATE_KEY" | "GITHUB_APP_SLUG">,
  db: Db,
  project: TeamAccessProject,
  now: number,
): Promise<void> {
  const [owner, repo] = project.github_repo_full_name.split("/");
  if (!owner || !repo) return;
  if (!(await claimTeamRefresh(db, project.id, now))) return;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), Math.max(0, now + TEAM_ACCESS_TTL_MS - TEAM_RUN_CALL_MARGIN_MS - Date.now()));
  try {
    const target = { owner, repo, nowIso: new Date(now).toISOString(), claimedAt: now, signal: deadline.signal };
    await runTeamRefresh(env, db, project, target);
  } catch (err) {
    console.warn("[team-access] refresh failed for project", project.id, err);
  } finally {
    clearTimeout(timer);
  }
}
