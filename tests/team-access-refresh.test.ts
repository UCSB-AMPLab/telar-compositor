/**
 * The team-access reconciler: its claim, the state it writes per member from
 * the installation token's readings, and the adds it owes, against a real
 * migrated database and a mocked GitHub client.
 *
 * @version v1.5.0-beta
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import * as schema from "~/db/schema";
import { GitHubPermissionError, GitHubTransientError } from "~/lib/github.server";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

vi.mock("~/lib/github-app.server", () => ({ getInstallationToken: vi.fn(async () => "iat") }));
vi.mock("~/lib/repo-access.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/repo-access.server")>()),
  memberPermission: vi.fn(),
  listRepoInvitations: vi.fn(),
  addCollaborator: vi.fn(),
  accountLogin: vi.fn(),
  deleteInvitation: vi.fn(),
  removeCollaborator: vi.fn(),
}));

import {
  accountLogin,
  addCollaborator,
  deleteInvitation,
  listRepoInvitations,
  memberPermission,
  removeCollaborator,
} from "~/lib/repo-access.server";
import type { RepoInvitation } from "~/lib/repo-access.server";
import type { RepoPermission } from "~/lib/repo-access";
import { ADD_ATTEMPT_CAP, STRAY_INVITATION_CAP, TEAM_ACCESS_TTL_MS, TEAM_RUN_START_WINDOW_MS, WITHDRAWAL_SETTLE_WINDOW_MS, refreshTeamAccess } from "~/lib/team-access.server";
import { recordWithdrawals } from "~/lib/repo-access-withdrawals.server";
import { unlinkProjectCascade } from "~/lib/project-unlink.server";

const PROJECT = { id: 1, github_repo_full_name: "owner/site", installation_id: 5 };
const ENV = { GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "k", GITHUB_APP_SLUG: "telar-compositor" };
const NOW = Date.parse("2026-10-02T12:00:00Z");

let memory: MemoryD1;
let permissions: Record<string, RepoPermission | Error>;
let invitations: RepoInvitation[];
let currentLogins: Record<number, string | null | Error>;

function teamDb() {
  return drizzle(asD1(memory), { schema });
}

function seedTeamMember(userId: number, login: string, role: string, extra: Record<string, unknown> = {}) {
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      `VALUES (${userId}, ${userId + 100}, '${login}', 'e', 'e', '2099-01-01', '2099-01-01')`,
  );
  currentLogins[userId + 100] = login;
  if (userId === 10) {
    memory.raw.exec(`INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (1, 10, 'owner/site', 5)`);
  }
  memory.raw.exec(`INSERT INTO project_members (project_id, user_id, role) VALUES (1, ${userId}, '${role}')`);
  const sets = Object.entries(extra).map(([k, v]) => `${k} = ${v === null ? "NULL" : typeof v === "string" ? `'${v}'` : v}`);
  if (sets.length) memory.raw.exec(`UPDATE project_members SET ${sets.join(", ")} WHERE user_id = ${userId}`);
}

function teamRow(userId: number) {
  return memory.raw
    .prepare(
      "SELECT gh_access, gh_invitation_id, gh_invitation_url, gh_access_checked_at, gh_add_state, gh_add_attempts, gh_add_error, gh_add_attempted_at FROM project_members WHERE user_id = ?",
    )
    .get(userId) as Record<string, unknown>;
}

const openInvite = (login: string, id = 77): RepoInvitation => ({
  id,
  inviteeLogin: login,
  inviteeId: null,
  inviterLogin: null,
  expired: false,
  htmlUrl: `https://github.com/owner/site/invitations/${id}`,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  memory = createMemoryD1();
  currentLogins = {};
  seedTeamMember(10, "convenor", "convenor", { gh_add_owed: 0 });
  permissions = { convenor: "admin" };
  invitations = [];
  vi.mocked(listRepoInvitations).mockReset().mockImplementation(async () => invitations);
  vi.mocked(memberPermission).mockReset().mockImplementation(async (_t, _o, _r, login) => {
    const p = permissions[login] ?? "none";
    if (p instanceof Error) throw p;
    return p;
  });
  vi.mocked(addCollaborator).mockReset();
  vi.mocked(accountLogin).mockReset().mockImplementation(async (_t, id) => {
    const l = currentLogins[id];
    if (l instanceof Error) throw l;
    return l ?? null;
  });
});

function takeTeamClaim() {
  memory.raw.exec(`UPDATE projects SET gh_team_checked_at = '${new Date(NOW + TEAM_ACCESS_TTL_MS + 1).toISOString()}'`);
}

function storedLogin(userId: number) {
  return (memory.raw.prepare("SELECT github_login FROM users WHERE id = ?").get(userId) as { github_login: string }).github_login;
}

afterEach(() => {
  vi.useRealTimers();
  memory.close();
  vi.restoreAllMocks();
});

describe("refreshTeamAccess claim", () => {
  it("runs when it wins the claim and stamps gh_team_checked_at", async () => {
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(listRepoInvitations).toHaveBeenCalledTimes(1);
    const p = memory.raw.prepare("SELECT gh_team_checked_at FROM projects WHERE id = 1").get() as { gh_team_checked_at: string };
    expect(p.gh_team_checked_at).toBe(new Date(NOW).toISOString());
  });

  it("does nothing when another caller holds a fresh claim", async () => {
    const fresh = new Date(NOW - TEAM_ACCESS_TTL_MS + 1000).toISOString();
    memory.raw.exec(`UPDATE projects SET gh_team_checked_at = '${fresh}'`);
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(listRepoInvitations).not.toHaveBeenCalled();
    expect(memberPermission).not.toHaveBeenCalled();
    expect(teamRow(10).gh_access).toBeNull();
  });

  it("only one of two concurrent callers runs", async () => {
    await Promise.all([refreshTeamAccess(ENV, teamDb(), PROJECT, NOW), refreshTeamAccess(ENV, teamDb(), PROJECT, NOW)]);
    expect(listRepoInvitations).toHaveBeenCalledTimes(1);
  });

  it("runs again once the claim is older than the interval", async () => {
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW + TEAM_ACCESS_TTL_MS + 1);
    expect(listRepoInvitations).toHaveBeenCalledTimes(2);
  });
});

describe("refreshTeamAccess states", () => {
  it("writes each member's state from one listing and one permission read each", async () => {
    seedTeamMember(11, "ana", "collaborator", { gh_add_owed: 0 });
    seedTeamMember(12, "Beto", "collaborator", { gh_add_owed: 0 });
    seedTeamMember(13, "caro", "collaborator", { gh_add_owed: 0 });
    permissions.ana = "write";
    invitations = [openInvite("beto", 81), { ...openInvite("caro", 82), expired: true }];
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(listRepoInvitations).toHaveBeenCalledTimes(1);
    expect(memberPermission).toHaveBeenCalledTimes(4);
    const at = new Date(NOW).toISOString();
    expect(teamRow(10)).toMatchObject({ gh_access: "access", gh_invitation_id: null, gh_access_checked_at: at });
    expect(teamRow(11)).toMatchObject({ gh_access: "access", gh_invitation_id: null });
    expect(teamRow(12)).toMatchObject({ gh_access: "pending", gh_invitation_id: 81, gh_invitation_url: "https://github.com/owner/site/invitations/81" });
    expect(teamRow(13)).toMatchObject({ gh_access: "lapsed", gh_invitation_id: 82 });
    expect(addCollaborator).not.toHaveBeenCalled();
  });

  it("a pending invitation GitHub no longer lists, with no permission, is recorded as lapsed with its id and link kept", async () => {
    seedTeamMember(11, "ana", "collaborator", { gh_add_owed: 1, gh_add_state: "sent", gh_access: "pending", gh_invitation_id: 81, gh_invitation_url: "https://github.com/owner/site/invitations/81" });
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(teamRow(11)).toMatchObject({ gh_access: "lapsed", gh_invitation_id: 81, gh_invitation_url: "https://github.com/owner/site/invitations/81" });
    expect(addCollaborator).not.toHaveBeenCalled();
  });

  it("a lapsed record stays lapsed on the next read, and a member with no invitation on record reads none", async () => {
    seedTeamMember(11, "ana", "collaborator", { gh_add_owed: 0, gh_access: "lapsed", gh_invitation_id: 81, gh_invitation_url: "u81" });
    seedTeamMember(12, "beto", "collaborator", { gh_add_owed: 0, gh_access: "pending", gh_invitation_id: null });
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(teamRow(11)).toMatchObject({ gh_access: "lapsed", gh_invitation_id: 81 });
    expect(teamRow(12).gh_access).toBe("none");
  });

  it("a stored invitation does not outlive the member gaining access", async () => {
    seedTeamMember(11, "ana", "collaborator", { gh_add_owed: 0, gh_access: "pending", gh_invitation_id: 81 });
    permissions.ana = "write";
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(teamRow(11)).toMatchObject({ gh_access: "access", gh_invitation_id: null });
  });

  it("a member whose read fails keeps their stored state and the others are still written", async () => {
    seedTeamMember(11, "ana", "collaborator", { gh_access: "pending", gh_invitation_id: 5, gh_access_checked_at: "2026-10-01T00:00:00.000Z" });
    seedTeamMember(12, "beto", "collaborator", { gh_add_owed: 0 });
    permissions.ana = new GitHubTransientError("GitHub API error reading a permission: 502", 502);
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(teamRow(11)).toMatchObject({ gh_access: "pending", gh_invitation_id: 5, gh_access_checked_at: "2026-10-01T00:00:00.000Z" });
    expect(teamRow(12).gh_access).toBe("none");
    expect(addCollaborator).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it("a failed invitation listing writes nothing and does not throw", async () => {
    seedTeamMember(11, "ana", "collaborator");
    vi.mocked(listRepoInvitations).mockRejectedValueOnce(new GitHubTransientError("x", 503));
    await expect(refreshTeamAccess(ENV, teamDb(), PROJECT, NOW)).resolves.toBeUndefined();
    expect(teamRow(11).gh_access).toBeNull();
    expect(addCollaborator).not.toHaveBeenCalled();
  });
});

describe("refreshTeamAccess owed adds", () => {
  it("sends an owed add and records the 201's invitation", async () => {
    seedTeamMember(11, "ana", "collaborator");
    vi.mocked(addCollaborator).mockResolvedValueOnce({ status: "invited", invitationId: 90, htmlUrl: "https://github.com/owner/site/invitations/90" });
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(addCollaborator).toHaveBeenCalledWith("iat", "owner", "site", "ana", expect.any(AbortSignal));
    expect(teamRow(11)).toMatchObject({
      gh_access: "pending",
      gh_invitation_id: 90,
      gh_invitation_url: "https://github.com/owner/site/invitations/90",
      gh_add_state: "sent",
      gh_add_attempts: 1,
      gh_add_error: null,
      gh_add_attempted_at: new Date(NOW).toISOString(),
    });
  });

  it("records access on a 204", async () => {
    seedTeamMember(11, "ana", "collaborator");
    vi.mocked(addCollaborator).mockResolvedValueOnce({ status: "already" });
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(teamRow(11)).toMatchObject({ gh_access: "access", gh_invitation_id: null, gh_add_state: "sent" });
  });

  it("records a failed add and retries it on a later refresh", async () => {
    seedTeamMember(11, "ana", "collaborator");
    vi.mocked(addCollaborator).mockRejectedValueOnce(new GitHubTransientError("GitHub API error adding a collaborator: 502", 502));
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(teamRow(11)).toMatchObject({
      gh_access: "none",
      gh_add_state: "failed",
      gh_add_attempts: 1,
      gh_add_error: "GitHub API error adding a collaborator: 502",
      gh_add_attempted_at: new Date(NOW).toISOString(),
    });
    vi.mocked(addCollaborator).mockResolvedValueOnce({ status: "invited", invitationId: 91, htmlUrl: "u" });
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW + TEAM_ACCESS_TTL_MS + 1);
    expect(addCollaborator).toHaveBeenCalledTimes(2);
    expect(teamRow(11)).toMatchObject({ gh_add_state: "sent", gh_add_attempts: 2, gh_add_error: null, gh_invitation_id: 91 });
  });

  it("stops retrying at the cap and stays visible as failed", async () => {
    seedTeamMember(11, "ana", "collaborator", { gh_add_state: "failed", gh_add_attempts: ADD_ATTEMPT_CAP - 1, gh_add_error: "earlier" });
    vi.mocked(addCollaborator).mockRejectedValue(new Error("GitHub API error adding a collaborator: 403"));
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW + TEAM_ACCESS_TTL_MS + 1);
    expect(addCollaborator).toHaveBeenCalledTimes(1);
    expect(teamRow(11)).toMatchObject({ gh_access: "none", gh_add_state: "failed", gh_add_attempts: ADD_ATTEMPT_CAP, gh_add_error: "GitHub API error adding a collaborator: 403" });
  });

  it("never re-adds a revoked member", async () => {
    seedTeamMember(11, "ana", "collaborator", { gh_add_state: "revoked" });
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(addCollaborator).not.toHaveBeenCalled();
    expect(teamRow(11)).toMatchObject({ gh_access: "none", gh_add_state: "revoked" });
  });

  it("never adds a member who is owed nothing", async () => {
    seedTeamMember(11, "ana", "collaborator", { gh_add_owed: 0 });
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(addCollaborator).not.toHaveBeenCalled();
    expect(teamRow(11).gh_add_state).toBeNull();
  });

  it("does not re-add a member with an open invitation", async () => {
    seedTeamMember(11, "ana", "collaborator");
    invitations = [openInvite("ana")];
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(addCollaborator).not.toHaveBeenCalled();
    expect(teamRow(11)).toMatchObject({ gh_access: "pending", gh_add_state: null });
  });

  it("does not add over a lapsed invitation", async () => {
    seedTeamMember(11, "ana", "collaborator");
    invitations = [{ ...openInvite("ana"), expired: true }];
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(addCollaborator).not.toHaveBeenCalled();
    expect(teamRow(11).gh_access).toBe("lapsed");
  });

  it("does not add a member who already has access", async () => {
    seedTeamMember(11, "ana", "collaborator");
    permissions.ana = "maintain";
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(addCollaborator).not.toHaveBeenCalled();
    expect(teamRow(11).gh_access).toBe("access");
  });

  it("does not send a second add once one was sent", async () => {
    seedTeamMember(11, "ana", "collaborator", { gh_add_state: "sent", gh_add_attempts: 1 });
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(addCollaborator).not.toHaveBeenCalled();
  });

  it("adds an instructor row like any member who joins", async () => {
    seedTeamMember(11, "ines", "instructor");
    vi.mocked(addCollaborator).mockResolvedValueOnce({ status: "invited", invitationId: 96, htmlUrl: "u" });
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(addCollaborator).toHaveBeenCalledWith("iat", "owner", "site", "ines", expect.any(AbortSignal));
    expect(teamRow(11)).toMatchObject({ gh_access: "pending", gh_add_state: "sent", gh_invitation_id: 96 });
  });
});

describe("refreshTeamAccess resolves each member by account id", () => {
  it("reads and adds the account's current login, never the stored one, and stores the new login", async () => {
    seedTeamMember(11, "ana", "collaborator");
    currentLogins[111] = "ana-renamed";
    permissions.ana = "none";
    vi.mocked(addCollaborator).mockResolvedValueOnce({ status: "invited", invitationId: 90, htmlUrl: "u" });
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(accountLogin).toHaveBeenCalledWith("iat", 111, expect.any(AbortSignal));
    expect(vi.mocked(memberPermission).mock.calls.map((c) => c[3])).not.toContain("ana");
    expect(memberPermission).toHaveBeenCalledWith("iat", "owner", "site", "ana-renamed", expect.any(AbortSignal));
    expect(addCollaborator).toHaveBeenCalledWith("iat", "owner", "site", "ana-renamed", expect.any(AbortSignal));
    expect(vi.mocked(addCollaborator).mock.calls.map((c) => c[3])).not.toContain("ana");
    expect(storedLogin(11)).toBe("ana-renamed");
  });

  it("matches the invitation listing by the current login", async () => {
    seedTeamMember(11, "ana", "collaborator");
    currentLogins[111] = "ana-renamed";
    invitations = [openInvite("ana", 70), openInvite("ana-renamed", 71)];
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(teamRow(11)).toMatchObject({ gh_access: "pending", gh_invitation_id: 71 });
  });

  it("an account that is gone is recorded as not reachable, never read or added, and the run goes on", async () => {
    seedTeamMember(11, "ana", "collaborator");
    seedTeamMember(12, "beto", "collaborator", { gh_add_owed: 0 });
    currentLogins[111] = null;
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(vi.mocked(memberPermission).mock.calls.map((c) => c[3])).not.toContain("ana");
    expect(addCollaborator).not.toHaveBeenCalled();
    expect(teamRow(11)).toMatchObject({ gh_access: "none", gh_add_state: "failed", gh_add_attempts: 0, gh_add_error: "GitHub account not found" });
    expect(teamRow(12).gh_access).toBe("none");
  });

  it("a member without a GitHub account id is never added", async () => {
    seedTeamMember(11, "ana", "collaborator");
    memory.raw.exec("UPDATE users SET github_id = -11 WHERE id = 11");
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(vi.mocked(accountLogin).mock.calls.map((c) => c[1])).not.toContain(-11);
    expect(addCollaborator).not.toHaveBeenCalled();
    expect(teamRow(11).gh_access).toBe("none");
  });

  it("a failed account lookup keeps the stored state and adds nothing", async () => {
    seedTeamMember(11, "ana", "collaborator", { gh_access: "pending", gh_invitation_id: 5 });
    currentLogins[111] = new GitHubTransientError("GitHub API error reading an account: 502", 502);
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(addCollaborator).not.toHaveBeenCalled();
    expect(teamRow(11)).toMatchObject({ gh_access: "pending", gh_invitation_id: 5 });
  });
});

describe("refreshTeamAccess settles an add GitHub took", () => {
  it("a failed add that reads pending is recorded as sent and its error cleared", async () => {
    seedTeamMember(11, "ana", "collaborator", { gh_add_state: "failed", gh_add_attempts: 1, gh_add_error: "response lost" });
    invitations = [openInvite("ana", 72)];
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(addCollaborator).not.toHaveBeenCalled();
    expect(teamRow(11)).toMatchObject({ gh_access: "pending", gh_add_state: "sent", gh_add_error: null, gh_add_attempts: 1 });
  });

  it("a failed add that reads access or lapsed is recorded as sent", async () => {
    seedTeamMember(11, "ana", "collaborator", { gh_add_state: "failed", gh_add_attempts: 2, gh_add_error: "x" });
    seedTeamMember(12, "beto", "collaborator", { gh_add_state: "failed", gh_add_attempts: 2, gh_add_error: "x" });
    permissions.ana = "write";
    invitations = [{ ...openInvite("beto", 73), expired: true }];
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(teamRow(11)).toMatchObject({ gh_access: "access", gh_add_state: "sent", gh_add_error: null });
    expect(teamRow(12)).toMatchObject({ gh_access: "lapsed", gh_add_state: "sent", gh_add_error: null });
  });
});

describe("refreshTeamAccess against a withdrawal made while its add is in flight", () => {
  function revokeDuringAdd() {
    memory.raw.exec("UPDATE project_members SET gh_add_state = 'revoked' WHERE user_id = 11");
  }

  it("keeps the row revoked and withdraws the invitation the add opened", async () => {
    seedTeamMember(11, "ana", "collaborator");
    vi.mocked(deleteInvitation).mockReset().mockResolvedValue(undefined);
    vi.mocked(addCollaborator).mockImplementation(async () => {
      revokeDuringAdd();
      return { status: "invited", invitationId: 93, htmlUrl: "u" };
    });
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(teamRow(11)).toMatchObject({ gh_add_state: "revoked", gh_access: "none", gh_invitation_id: null });
    expect(deleteInvitation).toHaveBeenCalledWith("iat", "owner", "site", 93);
  });

  it("keeps the row revoked when the add failed, so it is never retried", async () => {
    seedTeamMember(11, "ana", "collaborator");
    seedTeamMember(12, "beto", "collaborator", { gh_add_owed: 0 });
    vi.mocked(deleteInvitation).mockReset();
    vi.mocked(addCollaborator).mockImplementation(async () => {
      revokeDuringAdd();
      throw new GitHubTransientError("GitHub API error adding a collaborator: 502", 502);
    });
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(teamRow(11)).toMatchObject({ gh_add_state: "revoked", gh_add_error: null, gh_add_attempts: 0 });
    expect(deleteInvitation).not.toHaveBeenCalled();
    expect(teamRow(12).gh_access).toBe("none");
  });
});

describe("refreshTeamAccess against a membership that ends while its add is in flight", () => {
  /** The removal's own batch, as endMembership runs it: the withdrawal, then the delete. */
  async function endAnaDuringAdd() {
    const db = teamDb();
    const ending = and(eq(schema.project_members.project_id, 1), eq(schema.project_members.user_id, 11));
    await db.batch([recordWithdrawals(db, ending), db.delete(schema.project_members).where(ending)]);
  }

  function inFlightWithdrawals() {
    return memory.raw.prepare("SELECT user_id FROM repo_access_withdrawals ORDER BY id").all() as Array<{ user_id: number }>;
  }

  beforeEach(() => {
    vi.mocked(deleteInvitation).mockReset().mockResolvedValue(undefined);
  });

  it("records a withdrawal, and the next refresh deletes the invitation the add opened", async () => {
    seedTeamMember(11, "ana", "collaborator");
    let stateDuringAdd: unknown;
    vi.mocked(addCollaborator).mockImplementationOnce(async () => {
      stateDuringAdd = teamRow(11).gh_add_state;
      await endAnaDuringAdd();
      return { status: "invited", invitationId: 93, htmlUrl: "u" };
    });
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(stateDuringAdd).toBe("sending");
    expect(inFlightWithdrawals()).toEqual([{ user_id: 11 }]);
    invitations = [openInvite("ana", 93)];
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW + TEAM_ACCESS_TTL_MS + 1);
    expect(deleteInvitation).toHaveBeenCalledWith("iat", "owner", "site", 93, expect.any(AbortSignal));
    expect(inFlightWithdrawals()).toEqual([]);
  });

  it("an unlink during the add records no withdrawal and deletes nothing", async () => {
    seedTeamMember(11, "ana", "collaborator");
    vi.mocked(addCollaborator).mockImplementationOnce(async () => {
      await unlinkProjectCascade(teamDb(), 1);
      return { status: "invited", invitationId: 93, htmlUrl: "u" };
    });
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(memory.raw.prepare("SELECT COUNT(*) AS n FROM projects").get()).toEqual({ n: 0 });
    expect(inFlightWithdrawals()).toEqual([]);
    expect(deleteInvitation).not.toHaveBeenCalled();
  });

  it("a row left sending by a run that ended is sent again, and read as sent once GitHub shows it", async () => {
    seedTeamMember(11, "ana", "collaborator", { gh_add_state: "sending" });
    seedTeamMember(12, "beto", "collaborator", { gh_add_state: "sending" });
    invitations = [openInvite("beto", 94)];
    vi.mocked(addCollaborator).mockResolvedValueOnce({ status: "invited", invitationId: 95, htmlUrl: "u" });
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(vi.mocked(addCollaborator).mock.calls.map((c) => c[3])).toEqual(["ana"]);
    expect(teamRow(11)).toMatchObject({ gh_add_state: "sent", gh_invitation_id: 95 });
    expect(teamRow(12)).toMatchObject({ gh_add_state: "sent", gh_access: "pending" });
  });
});

describe("refreshTeamAccess stops when its claim is overtaken", () => {
  it("a claim taken by a later run while this one reads leaves the row and the add to the later run", async () => {
    seedTeamMember(11, "ana", "collaborator");
    seedTeamMember(12, "beto", "collaborator");
    vi.mocked(memberPermission).mockImplementation(async (_t, _o, _r, login) => {
      if (login === "ana") takeTeamClaim();
      return login === "convenor" ? "admin" : "none";
    });
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(addCollaborator).not.toHaveBeenCalled();
    expect(teamRow(11)).toMatchObject({ gh_access: null, gh_add_state: null });
    expect(vi.mocked(memberPermission).mock.calls.map((c) => c[3])).not.toContain("beto");
    expect(teamRow(12).gh_access).toBeNull();
  });

  it("a claim taken while an add is in flight drops that run's outcome and stops it", async () => {
    seedTeamMember(11, "ana", "collaborator");
    seedTeamMember(12, "beto", "collaborator");
    vi.mocked(addCollaborator).mockImplementation(async () => {
      takeTeamClaim();
      return { status: "invited", invitationId: 93, htmlUrl: "u" };
    });
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(addCollaborator).toHaveBeenCalledTimes(1);
    expect(teamRow(11)).toMatchObject({ gh_access: "none", gh_add_state: "sending", gh_add_attempts: 0 });
    expect(teamRow(12).gh_access).toBeNull();
  });
});

describe("refreshTeamAccess keeps a run inside its claim", () => {
  it("starts no add once the start window has passed, though the state is written", async () => {
    seedTeamMember(11, "ana", "collaborator");
    vi.mocked(memberPermission).mockImplementation(async (_t, _o, _r, login) => {
      if (login === "ana") vi.setSystemTime(NOW + TEAM_RUN_START_WINDOW_MS + 1);
      return login === "convenor" ? "admin" : "none";
    });
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(addCollaborator).not.toHaveBeenCalled();
    expect(teamRow(11)).toMatchObject({ gh_access: "none", gh_add_state: null, gh_add_attempts: 0 });
  });

  it("starts no member once the start window has passed", async () => {
    seedTeamMember(11, "ana", "collaborator");
    vi.mocked(accountLogin).mockImplementation(async (_t, id) => {
      if (id === 110) vi.setSystemTime(NOW + TEAM_RUN_START_WINDOW_MS + 1);
      return currentLogins[id] as string;
    });
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(vi.mocked(accountLogin).mock.calls.map((c) => c[1])).not.toContain(111);
    expect(addCollaborator).not.toHaveBeenCalled();
    expect(teamRow(11).gh_access).toBeNull();
  });

  it("an add still in flight is abandoned before a later run can claim, so the two never overlap", async () => {
    seedTeamMember(11, "ana", "collaborator");
    let inFlight = 0;
    let most = 0;
    vi.mocked(addCollaborator).mockImplementation(async (_t, _o, _r, _u, signal) => {
      inFlight++;
      most = Math.max(most, inFlight);
      try {
        if (vi.mocked(addCollaborator).mock.calls.length > 1) return { status: "invited", invitationId: 95, htmlUrl: "u" };
        await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("GitHub call timed out"))));
        return { status: "already" };
      } finally {
        inFlight--;
      }
    });
    let firstSettled = false;
    const first = refreshTeamAccess(ENV, teamDb(), PROJECT, NOW).then(() => {
      firstSettled = true;
    });
    await vi.advanceTimersByTimeAsync(TEAM_ACCESS_TTL_MS + 1);
    expect(firstSettled).toBe(true);
    await refreshTeamAccess(ENV, teamDb(), PROJECT, Date.now());
    await first;
    expect(most).toBe(1);
    expect(addCollaborator).toHaveBeenCalledTimes(2);
    expect(teamRow(11)).toMatchObject({ gh_add_state: "sent", gh_add_attempts: 2, gh_invitation_id: 95 });
  });

  it("passes the run's deadline to every GitHub call", async () => {
    seedTeamMember(11, "ana", "collaborator");
    vi.mocked(addCollaborator).mockResolvedValueOnce({ status: "already" });
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    const signals = [
      vi.mocked(listRepoInvitations).mock.calls[0][3],
      ...vi.mocked(accountLogin).mock.calls.map((c) => c[2]),
      ...vi.mocked(memberPermission).mock.calls.map((c) => c[4]),
      vi.mocked(addCollaborator).mock.calls[0][4],
    ];
    expect(signals).toHaveLength(6);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe("refreshTeamAccess login update", () => {
  it("a newer login stored by a sign-in during the lookup is not overwritten", async () => {
    seedTeamMember(11, "ana", "collaborator", { gh_add_owed: 0 });
    vi.mocked(accountLogin).mockImplementation(async (_t, id) => {
      if (id === 111) {
        memory.raw.exec("UPDATE users SET github_login = 'ana-newest' WHERE id = 11");
        return "ana-renamed";
      }
      return currentLogins[id] as string;
    });
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(storedLogin(11)).toBe("ana-newest");
  });
});

describe("refreshTeamAccess drains the project's withdrawals", () => {
  /** A person whose membership ended, with the withdrawal its removal recorded. */
  function seedDepartedMember(userId: number, login: string, githubId: number | null = userId + 100) {
    memory.raw.exec(
      "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
        `VALUES (${userId}, ${githubId ?? -userId}, '${login}', 'e', 'e', '2099-01-01', '2099-01-01')`,
    );
    if (githubId !== null) currentLogins[githubId] = login;
    memory.raw.exec(
      `INSERT INTO repo_access_withdrawals (project_id, user_id, github_id, created_at) VALUES (1, ${userId}, ${githubId ?? "NULL"}, '2026-10-01T00:00:00Z')`,
    );
  }

  function withdrawalRows() {
    return memory.raw.prepare("SELECT user_id, attempts, last_error FROM repo_access_withdrawals ORDER BY id").all() as Array<{
      user_id: number;
      attempts: number;
      last_error: string | null;
    }>;
  }

  beforeEach(() => {
    vi.mocked(removeCollaborator).mockReset().mockResolvedValue(undefined);
    vi.mocked(deleteInvitation).mockReset().mockResolvedValue(undefined);
  });

  it("removes the access of a person who has it, under their current login, and deletes the row", async () => {
    seedDepartedMember(21, "dora");
    currentLogins[121] = "dora-renamed";
    permissions["dora-renamed"] = "write";
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(removeCollaborator).toHaveBeenCalledWith("iat", "owner", "site", "dora-renamed", expect.any(AbortSignal));
    expect(deleteInvitation).not.toHaveBeenCalled();
    expect(withdrawalRows()).toEqual([]);
  });

  it("deletes an open invitation and the row", async () => {
    seedDepartedMember(21, "dora");
    invitations = [openInvite("dora", 88)];
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(deleteInvitation).toHaveBeenCalledWith("iat", "owner", "site", 88, expect.any(AbortSignal));
    expect(removeCollaborator).not.toHaveBeenCalled();
    expect(withdrawalRows()).toEqual([]);
  });

  it("deletes the row of a person with neither access nor an invitation, or no account", async () => {
    seedDepartedMember(21, "dora");
    seedDepartedMember(22, "eloy");
    currentLogins[122] = null;
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(removeCollaborator).not.toHaveBeenCalled();
    expect(deleteInvitation).not.toHaveBeenCalled();
    expect(withdrawalRows()).toEqual([]);
  });

  it("leaves a young withdrawal with an empty reading in place, uncounted, and settles it once the invitation is listed", async () => {
    seedDepartedMember(21, "dora");
    memory.raw.exec(`UPDATE repo_access_withdrawals SET created_at = '${new Date(NOW - 1000).toISOString()}'`);
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(withdrawalRows()).toEqual([{ user_id: 21, attempts: 0, last_error: null }]);
    expect(deleteInvitation).not.toHaveBeenCalled();
    invitations = [openInvite("dora", 88)];
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW + TEAM_ACCESS_TTL_MS + 1);
    expect(deleteInvitation).toHaveBeenCalledWith("iat", "owner", "site", 88, expect.any(AbortSignal));
    expect(withdrawalRows()).toEqual([]);
  });

  it("settles a withdrawal with an empty reading once it is older than the settle window", async () => {
    seedDepartedMember(21, "dora");
    memory.raw.exec(`UPDATE repo_access_withdrawals SET created_at = '${new Date(NOW - WITHDRAWAL_SETTLE_WINDOW_MS).toISOString()}'`);
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(withdrawalRows()).toEqual([]);
  });

  it("keeps a failed withdrawal with its error and retries it on the next refresh", async () => {
    seedDepartedMember(21, "dora");
    permissions.dora = "write";
    vi.mocked(removeCollaborator).mockRejectedValueOnce(new GitHubTransientError("GitHub API error removing a collaborator: 502", 502));
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(withdrawalRows()).toEqual([{ user_id: 21, attempts: 0, last_error: "GitHub API error removing a collaborator: 502" }]);
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW + TEAM_ACCESS_TTL_MS + 1);
    expect(removeCollaborator).toHaveBeenCalledTimes(2);
    expect(withdrawalRows()).toEqual([]);
  });

  it("counts a refusal toward the attempt cap, and keeps its error", async () => {
    seedDepartedMember(21, "dora");
    permissions.dora = "write";
    vi.mocked(removeCollaborator).mockRejectedValueOnce(new GitHubPermissionError("refused: 403", 403));
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(withdrawalRows()).toEqual([{ user_id: 21, attempts: 1, last_error: "refused: 403" }]);
  });

  it("does not count a network failure toward the attempt cap, and keeps its error", async () => {
    seedDepartedMember(21, "dora");
    permissions.dora = "write";
    vi.mocked(removeCollaborator).mockRejectedValueOnce(new TypeError("fetch failed"));
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(withdrawalRows()).toEqual([{ user_id: 21, attempts: 0, last_error: "fetch failed" }]);
  });

  it("drops the withdrawal of a person who joined while GitHub was being read, without calling GitHub", async () => {
    seedDepartedMember(21, "dora");
    permissions.dora = "write";
    vi.mocked(memberPermission).mockImplementation(async (_t, _o, _r, login) => {
      memory.raw.exec("INSERT INTO project_members (project_id, user_id, role, gh_add_owed) VALUES (1, 21, 'collaborator', 0)");
      return permissions[login] as RepoPermission;
    });
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(removeCollaborator).not.toHaveBeenCalled();
    expect(deleteInvitation).not.toHaveBeenCalled();
    expect(withdrawalRows()).toEqual([]);
  });

  it("drops the withdrawal of a person who has rejoined, without touching their access", async () => {
    seedDepartedMember(21, "dora");
    memory.raw.exec("INSERT INTO project_members (project_id, user_id, role, gh_add_owed) VALUES (1, 21, 'collaborator', 0)");
    permissions.dora = "write";
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(removeCollaborator).not.toHaveBeenCalled();
    expect(withdrawalRows()).toEqual([]);
  });

  it("drains only the refreshed project's withdrawals", async () => {
    seedDepartedMember(21, "dora");
    memory.raw.exec(`INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (2, 10, 'owner/other', 5)`);
    memory.raw.exec(`UPDATE repo_access_withdrawals SET project_id = 2`);
    permissions.dora = "write";
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(removeCollaborator).not.toHaveBeenCalled();
    expect(withdrawalRows()).toHaveLength(1);
  });

  it("resolves the login from the GitHub id the withdrawal recorded, after the account became a tombstone", async () => {
    seedDepartedMember(21, "dora");
    memory.raw.exec("UPDATE users SET github_id = -21, deleted_at = '2026-10-01T00:00:00Z' WHERE id = 21");
    permissions.dora = "write";
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(accountLogin).toHaveBeenCalledWith("iat", 121, expect.any(AbortSignal));
    expect(removeCollaborator).toHaveBeenCalledWith("iat", "owner", "site", "dora", expect.any(AbortSignal));
    expect(withdrawalRows()).toEqual([]);
  });

  it("deletes the row of a person with no GitHub id, calling nothing", async () => {
    seedDepartedMember(21, "dora", null);
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(vi.mocked(accountLogin).mock.calls.map((c) => c[1])).toEqual([110]);
    expect(withdrawalRows()).toEqual([]);
  });

  it("stops calling GitHub for a withdrawal at the attempt cap and keeps it with its error", async () => {
    seedDepartedMember(21, "dora");
    memory.raw.exec(`UPDATE repo_access_withdrawals SET attempts = ${ADD_ATTEMPT_CAP}, last_error = 'refused'`);
    permissions.dora = "write";
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(vi.mocked(accountLogin).mock.calls.map((c) => c[1])).not.toContain(121);
    expect(removeCollaborator).not.toHaveBeenCalled();
    expect(withdrawalRows()).toEqual([{ user_id: 21, attempts: ADD_ATTEMPT_CAP, last_error: "refused" }]);
  });

  it("a withdrawal whose write fails leaves the next withdrawal and the member pass to run", async () => {
    seedDepartedMember(21, "dora");
    seedDepartedMember(22, "eloy");
    seedTeamMember(11, "ana", "collaborator", { gh_add_owed: 0 });
    memory.raw.exec(
      "CREATE TRIGGER refuse_withdrawal_delete BEFORE DELETE ON repo_access_withdrawals WHEN OLD.user_id = 21 BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(withdrawalRows().map((r) => r.user_id)).toEqual([21]);
    expect(teamRow(11).gh_access).toBe("none");
  });

  it("leaves the row to a later run that took the claim", async () => {
    seedDepartedMember(21, "dora");
    permissions.dora = "write";
    vi.mocked(removeCollaborator).mockImplementation(async () => takeTeamClaim());
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(withdrawalRows()).toEqual([{ user_id: 21, attempts: 0, last_error: null }]);
    expect(vi.mocked(memberPermission).mock.calls.map((c) => c[3])).not.toContain("convenor");
  });

  it("starts no withdrawal once the start window has passed", async () => {
    seedDepartedMember(21, "dora");
    vi.mocked(listRepoInvitations).mockImplementation(async () => {
      vi.setSystemTime(NOW + TEAM_RUN_START_WINDOW_MS + 1);
      return invitations;
    });
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(vi.mocked(accountLogin).mock.calls.map((c) => c[1])).not.toContain(121);
    expect(withdrawalRows()).toHaveLength(1);
  });
});

describe("refreshTeamAccess sweeps invitations the App sent to people who are not members", () => {
  const BOT = "telar-compositor[bot]";
  const botInvite = (githubId: number, login: string, id: number): RepoInvitation => ({
    ...openInvite(login, id),
    inviteeId: githubId,
    inviterLogin: BOT,
  });

  /** An account that is not a member of the project. */
  function seedFormerMember(userId: number, login: string) {
    memory.raw.exec(
      "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
        `VALUES (${userId}, ${userId + 100}, '${login}', 'e', 'e', '2099-01-01', '2099-01-01')`,
    );
    currentLogins[userId + 100] = login;
  }

  function deleteSignals() {
    return vi.mocked(deleteInvitation).mock.calls.map((c) => c[4]);
  }

  beforeEach(() => {
    vi.mocked(deleteInvitation).mockReset().mockResolvedValue(undefined);
    vi.mocked(removeCollaborator).mockReset().mockResolvedValue(undefined);
  });

  it("deletes an open invitation the App sent to a person who is not a member, matching the bot login without case", async () => {
    seedFormerMember(21, "dora");
    seedFormerMember(22, "eloy");
    invitations = [botInvite(121, "dora", 88), { ...botInvite(122, "eloy", 89), inviterLogin: "Telar-Compositor[bot]" }];
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(deleteInvitation).toHaveBeenCalledWith("iat", "owner", "site", 88, expect.any(AbortSignal));
    expect(vi.mocked(deleteInvitation).mock.calls.map((c) => c[3])).toEqual([88, 89]);
  });

  it("keeps an invitation a person sent by hand, and one with no invitee", async () => {
    seedFormerMember(21, "dora");
    invitations = [{ ...botInvite(121, "dora", 88), inviterLogin: "convenor" }, { ...botInvite(121, "dora", 89), inviteeId: null, inviteeLogin: null }];
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(deleteInvitation).not.toHaveBeenCalled();
  });

  it("keeps the invitation of a member, of a deleted account's member row, and of a member whose login changed", async () => {
    seedTeamMember(11, "ana", "collaborator", { gh_add_owed: 0 });
    seedTeamMember(12, "beto", "collaborator", { gh_add_owed: 0 });
    memory.raw.exec("UPDATE users SET deleted_at = '2026-10-01T00:00:00Z' WHERE id = 12");
    seedTeamMember(13, "caro", "collaborator", { gh_add_owed: 0 });
    currentLogins[113] = "caro-renamed";
    invitations = [botInvite(111, "ana", 81), botInvite(112, "beto", 82), botInvite(113, "caro-renamed", 83)];
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(deleteInvitation).not.toHaveBeenCalled();
  });

  it("keeps the invitation of a person who joined after the invitations were listed", async () => {
    seedFormerMember(21, "dora");
    invitations = [botInvite(121, "dora", 88)];
    vi.mocked(listRepoInvitations).mockImplementation(async () => {
      memory.raw.exec("INSERT INTO project_members (project_id, user_id, role, gh_add_owed) VALUES (1, 21, 'collaborator', 0)");
      return invitations;
    });
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(deleteInvitation).not.toHaveBeenCalled();
  });

  it("keeps an expired invitation", async () => {
    seedFormerMember(21, "dora");
    invitations = [{ ...botInvite(121, "dora", 88), expired: true }];
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(deleteInvitation).not.toHaveBeenCalled();
  });

  it("leaves the invitation of a person with a pending withdrawal to that withdrawal", async () => {
    seedFormerMember(21, "dora");
    memory.raw.exec(
      `INSERT INTO repo_access_withdrawals (project_id, user_id, github_id, created_at, attempts) VALUES (1, 21, 121, '2026-10-01T00:00:00Z', ${ADD_ATTEMPT_CAP})`,
    );
    invitations = [botInvite(121, "dora", 88)];
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(deleteInvitation).not.toHaveBeenCalled();
  });

  it("does not delete again an invitation this run's withdrawal deleted", async () => {
    seedFormerMember(21, "dora");
    memory.raw.exec(`INSERT INTO repo_access_withdrawals (project_id, user_id, github_id, created_at) VALUES (1, 21, 121, '2026-10-01T00:00:00Z')`);
    invitations = [botInvite(121, "dora", 88)];
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(deleteInvitation).toHaveBeenCalledTimes(1);
  });

  it("deletes nothing more once a later run takes the claim", async () => {
    seedFormerMember(21, "dora");
    seedFormerMember(22, "eloy");
    invitations = [botInvite(121, "dora", 88), botInvite(122, "eloy", 89)];
    vi.mocked(deleteInvitation).mockImplementationOnce(async () => takeTeamClaim());
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(vi.mocked(deleteInvitation).mock.calls.map((c) => c[3])).toEqual([88]);
  });

  it("deletes nothing once the start window has passed", async () => {
    seedFormerMember(21, "dora");
    invitations = [botInvite(121, "dora", 88)];
    vi.mocked(memberPermission).mockImplementation(async () => {
      vi.setSystemTime(NOW + TEAM_RUN_START_WINDOW_MS + 1);
      return "admin";
    });
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(deleteInvitation).not.toHaveBeenCalled();
  });

  it("starts no delete once the start window passes during the sweep", async () => {
    seedFormerMember(21, "dora");
    seedFormerMember(22, "eloy");
    invitations = [botInvite(121, "dora", 88), botInvite(122, "eloy", 89)];
    vi.mocked(deleteInvitation).mockImplementationOnce(async () => {
      vi.setSystemTime(NOW + TEAM_RUN_START_WINDOW_MS + 1);
    });
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(vi.mocked(deleteInvitation).mock.calls.map((c) => c[3])).toEqual([88]);
  });

  it("a failed delete leaves the rest of the sweep to run", async () => {
    seedFormerMember(21, "dora");
    seedFormerMember(22, "eloy");
    invitations = [botInvite(121, "dora", 88), botInvite(122, "eloy", 89)];
    vi.mocked(deleteInvitation).mockRejectedValueOnce(new GitHubTransientError("GitHub API error deleting an invitation: 502", 502));
    await expect(refreshTeamAccess(ENV, teamDb(), PROJECT, NOW)).resolves.toBeUndefined();
    expect(vi.mocked(deleteInvitation).mock.calls.map((c) => c[3])).toEqual([88, 89]);
    expect(console.warn).toHaveBeenCalledWith("[team-access] stray invitation delete failed", 88, expect.any(GitHubTransientError));
  });

  it(`deletes at most ${STRAY_INVITATION_CAP} invitations in one run`, async () => {
    invitations = [];
    for (let n = 0; n < STRAY_INVITATION_CAP + 2; n++) {
      seedFormerMember(30 + n, `p${n}`);
      invitations.push(botInvite(130 + n, `p${n}`, 200 + n));
    }
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(vi.mocked(deleteInvitation).mock.calls.map((c) => c[3])).toEqual([200, 201, 202, 203, 204]);
    expect(deleteSignals().every((signal) => signal instanceof AbortSignal)).toBe(true);
  });

  it("keeps the invitation of a person who joins while an earlier invitation is being deleted", async () => {
    seedFormerMember(21, "dora");
    seedFormerMember(22, "eloy");
    invitations = [botInvite(121, "dora", 88), botInvite(122, "eloy", 89)];
    vi.mocked(deleteInvitation).mockImplementationOnce(async () => {
      memory.raw.exec("INSERT INTO project_members (project_id, user_id, role, gh_add_owed) VALUES (1, 22, 'collaborator', 0)");
    });
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(vi.mocked(deleteInvitation).mock.calls.map((c) => c[3])).toEqual([88]);
  });

  it("does not count a failed delete toward the cap, so failing invitations never hold back the rest", async () => {
    invitations = [];
    for (let n = 0; n < STRAY_INVITATION_CAP + 2; n++) {
      seedFormerMember(30 + n, `p${n}`);
      invitations.push(botInvite(130 + n, `p${n}`, 200 + n));
    }
    const failing = new Set([200, 201, 202, 203, 204]);
    vi.mocked(deleteInvitation).mockImplementation(async (_t, _o, _r, id) => {
      if (failing.has(id)) throw new GitHubTransientError("GitHub API error deleting an invitation: 502", 502);
    });
    await refreshTeamAccess(ENV, teamDb(), PROJECT, NOW);
    expect(vi.mocked(deleteInvitation).mock.calls.map((c) => c[3])).toEqual([200, 201, 202, 203, 204, 205, 206]);
  });
});
