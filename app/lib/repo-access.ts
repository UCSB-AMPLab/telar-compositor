/**
 * This file decides where a member stands on the way to the repository, and
 * which token a commit travels on. It reads no database and calls no GitHub:
 * the two answers GitHub gives about one person go in, a state comes out.
 *
 * @version v1.5.0-beta
 */

/** What `GET /repos/{r}/invitations` says about one person. */
export type InvitationReading = "none" | "open" | "expired";

export type RepoAccess = "access" | "pending" | "lapsed" | "none";

/** The caller's own recorded repository state, as the status poll carries it. */
export interface OwnRepoAccess {
  stage: RepoAccess;
  invitationUrl: string | null;
}

export type Stage =
  | { stage: "invited" }
  | { stage: "member"; remedy: "add" | "reissue" }
  | { stage: "pending" }
  | { stage: "access" };

export type CommitToken = "member" | "installation";

/** A combination of GitHub answers that cannot both be true. */
export class RepoAccessContradiction extends Error {
  constructor(detail: string) {
    super(`Repository access readings contradict each other: ${detail}`);
    this.name = "RepoAccessContradiction";
  }
}

/**
 * The member's permission on the repository, as `GET
 * /repos/{owner}/{repo}/collaborators/{username}/permission` reports it. The
 * REST reference gives the legacy `permission` field as admin, write, read or
 * none, "where the maintain role is mapped to write and the triage role is
 * mapped to read", and `role_name` as the assigned role, custom roles
 * included. Callers pass `permission`; maintain and triage are accepted for
 * a caller that passes `role_name`. The report counts organization and team
 * access, which a user token does not carry beyond the user's own rights.
 */
export type RepoPermission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

function canPush(permission: RepoPermission): boolean {
  switch (permission) {
    case "admin":
    case "maintain":
    case "write":
      return true;
    case "triage":
    case "read":
    case "none":
      return false;
  }
  throw new RepoAccessContradiction(`unrecognised permission ${String(permission)}`);
}

/**
 * The permission and the invitation list answer one question from two
 * endpoints. Access means the member can push: read or triage is not access
 * and the installation token commits instead. An open or expired invitation
 * beside push rights cannot both be current: GitHub answers 204 to an add for
 * a collaborator and drops the invitation on accept. The switches have no
 * default arm, and a value outside the types throws after them, so a new
 * answer fails here rather than rendering as "not yet".
 */
export function deriveRepoAccess(permission: RepoPermission, invitation: InvitationReading): RepoAccess {
  switch (canPush(permission)) {
    case true:
      switch (invitation) {
        case "none":
          return "access";
        case "open":
        case "expired":
          throw new RepoAccessContradiction(`push access with an ${invitation} invitation`);
      }
      break;
    case false:
      switch (invitation) {
        case "none":
          return "none";
        case "open":
          return "pending";
        case "expired":
          return "lapsed";
      }
      break;
  }
  throw new RepoAccessContradiction(`unrecognised invitation ${String(invitation)}`);
}

/**
 * Where the person stands on the path invited, member, pending, access.
 * `access` is null until it has been read. A convenor's view reads the
 * repository-side listing, which is not yet known to include expired
 * invitations, so until `listingConfirmed` lapsed and none read as one "not
 * yet" with one remedy; the member's own listing is confirmed to.
 */
export function stageFor(
  membership: "invite" | "member",
  access: RepoAccess | null,
  listingConfirmed: boolean,
): Stage {
  switch (membership) {
    case "invite":
      if (access !== null) throw new RepoAccessContradiction(`invite without a membership has access ${access}`);
      return { stage: "invited" };
    case "member":
      switch (access) {
        case "access":
          return { stage: "access" };
        case "pending":
          return { stage: "pending" };
        case "lapsed":
          return { stage: "member", remedy: listingConfirmed ? "reissue" : "add" };
        case "none":
        case null:
          return { stage: "member", remedy: "add" };
      }
      throw new RepoAccessContradiction(`unrecognised access ${String(access)}`);
  }
  throw new RepoAccessContradiction(`unrecognised membership ${String(membership)}`);
}

/** The member's own token only for access; every other stage commits as the installation. */
export function chooseCommitToken(stage: Stage["stage"]): CommitToken {
  switch (stage) {
    case "access":
      return "member";
    case "invited":
    case "member":
    case "pending":
      return "installation";
  }
}

/** What a team-page row says about one member. */
export type TeamRowState =
  | "invited"
  | "access"
  | "pending"
  | "lapsed"
  | "waiting"
  | "retrying"
  | "stopped"
  | "withdrawn"
  | "before"
  | "unlisted";

export interface TeamRowFacts {
  role: "convenor" | "collaborator" | "instructor";
  stage: Stage;
  addState: "sending" | "sent" | "failed" | "revoked" | null;
  attempts: number;
  owed: boolean;
}

/**
 * The line a row shows. A member who is not on the repository is told apart
 * by why: not yet tried, failing and retried, failing and stopped at the cap,
 * withdrawn by a convenor, or never owed an add because they joined first.
 * Instructors are not added until the course exit exists, so their row says
 * only that they are not on the repository. An outstanding invite link is a
 * row at the invited stage. No default arm.
 */
export function teamRowState(row: TeamRowFacts, attemptCap: number): TeamRowState {
  switch (row.stage.stage) {
    case "invited":
      return "invited";
    case "access":
      return "access";
    case "pending":
      return "pending";
    case "member":
      return memberRowState(row, row.stage.remedy, attemptCap);
  }
  throw new RepoAccessContradiction(`unrecognised stage ${String((row.stage as { stage: unknown }).stage)}`);
}

function memberRowState(row: TeamRowFacts, remedy: "add" | "reissue", attemptCap: number): TeamRowState {
  if (remedy === "reissue") return "lapsed";
  if (row.role === "instructor") return "unlisted";
  if (row.addState === "revoked") return "withdrawn";
  if (!row.owed) return "before";
  if (row.addState === "failed") return row.attempts < attemptCap ? "retrying" : "stopped";
  return "waiting";
}

/** What a team-page row can do: a convenor's add, reissue or withdrawal, or the member's own accept. */
export type TeamRowAction = "add" | "reissue" | "revoke" | "accept";

/** Why a team-page action was refused; `accept_refused` carries the GitHub invitation page. */
export type TeamActionError = "changed" | "instructor" | "owner" | "failed" | "lapsed" | "accept_refused";
export type TeamActionResult =
  | { ok: true; userId: number }
  | { ok: false; userId: number; error: TeamActionError; fallbackUrl?: string };

const CONVENOR_ROW_ACTIONS: Record<TeamRowState, TeamRowAction[]> = {
  invited: [],
  access: ["revoke"],
  pending: ["revoke"],
  lapsed: ["reissue", "revoke"],
  waiting: ["add"],
  retrying: ["add"],
  stopped: ["add"],
  withdrawn: ["add"],
  before: ["add"],
  unlisted: [],
};

/**
 * The controls a row offers its viewer. An instructor's row offers none:
 * their access comes and goes with the course. A convenor adds anyone not on
 * the repository, reissues a lapsed invitation and withdraws anyone else's
 * access but a convenor's; the member themselves accepts a pending
 * invitation, and has no control over a lapsed one, which only a reissue
 * renews. Server actions re-check every one of these against GitHub.
 */
export function teamRowActions(
  row: { role: TeamRowFacts["role"]; state: TeamRowState },
  viewer: { convenor: boolean; self: boolean },
): TeamRowAction[] {
  if (row.role === "instructor") return [];
  const own: TeamRowAction[] = viewer.self && row.state === "pending" ? ["accept"] : [];
  if (!viewer.convenor) return own;
  const offered = CONVENOR_ROW_ACTIONS[row.state].filter((a) => a !== "revoke" || row.role !== "convenor");
  return [...own, ...offered];
}
