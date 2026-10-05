/**
 * The team page's actions: a convenor's add, reissue and withdrawal, and a
 * member accepting their own invitation. Each reads GitHub again before it
 * acts and refuses when that reading does not allow the action. The cases
 * run the real route action against the migration chain in memory, with
 * GitHub's client mocked.
 *
 * @version v1.5.0-beta
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";

import * as schema from "~/db/schema";
import { projects } from "~/db/schema";
import { GitHubPermissionError } from "~/lib/github.server";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;

vi.mock("~/lib/github-app.server", () => ({ getInstallationToken: vi.fn(async () => "iat") }));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "own-token") }));
vi.mock("~/lib/db.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/db.server")>()),
  getDb: () => db,
}));
vi.mock("~/lib/active-project.server", () => ({
  resolveActiveProjectFromRequest: async () => {
    const rows = await db.select().from(projects).where(eq(projects.id, 1));
    return { project: rows[0] };
  },
}));
vi.mock("~/lib/repo-access.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/repo-access.server")>()),
  memberPermission: vi.fn(),
  listRepoInvitations: vi.fn(),
  addCollaborator: vi.fn(),
  accountLogin: vi.fn(),
  deleteInvitation: vi.fn(),
  removeCollaborator: vi.fn(),
  acceptInvitation: vi.fn(),
}));

import {
  acceptInvitation,
  accountLogin,
  addCollaborator,
  deleteInvitation,
  listRepoInvitations,
  memberPermission,
  removeCollaborator,
} from "~/lib/repo-access.server";
import type { RepoInvitation } from "~/lib/repo-access.server";
import type { RepoPermission } from "~/lib/repo-access";
import { decrypt } from "~/lib/crypto.server";
import { recordWithdrawals } from "~/lib/repo-access-withdrawals.server";
import { CONVENOR_ADD_DEADLINE_MS, TEAM_ACCESS_TTL_MS, WITHDRAWAL_SETTLE_WINDOW_MS, refreshTeamAccess } from "~/lib/team-access.server";
import { action } from "~/routes/_app.team";
import { userContext } from "~/middleware/auth.server";
import type { AuthenticatedUser } from "~/middleware/auth.server";

let permissions: Record<string, RepoPermission>;
let invitations: RepoInvitation[];

const CONVENOR = 10;
const invite = (login: string, id: number, expired = false): RepoInvitation => ({
  id,
  inviteeLogin: login,
  inviteeId: null,
  inviterLogin: null,
  expired,
  htmlUrl: `https://github.com/owner/site/invitations/${id}`,
});

function seedActionMember(userId: number, login: string, role: string, extra: Record<string, unknown> = {}) {
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      `VALUES (${userId}, ${userId + 100}, '${login}', 'enc-${login}', 'e', '2099-01-01', '2099-01-01')`,
  );
  if (userId === CONVENOR) {
    memory.raw.exec(`INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (1, ${CONVENOR}, 'owner/site', 5)`);
  }
  memory.raw.exec(`INSERT INTO project_members (project_id, user_id, role) VALUES (1, ${userId}, '${role}')`);
  const sets = Object.entries(extra).map(([k, v]) => `${k} = ${v === null ? "NULL" : typeof v === "string" ? `'${v}'` : v}`);
  if (sets.length) memory.raw.exec(`UPDATE project_members SET ${sets.join(", ")} WHERE user_id = ${userId}`);
}

function actionRow(userId: number) {
  return memory.raw
    .prepare("SELECT gh_access, gh_invitation_id, gh_add_state, gh_add_attempts, gh_add_error, gh_add_owed FROM project_members WHERE user_id = ?")
    .get(userId) as Record<string, unknown>;
}

function postTeamAction(asUser: number, fields: Record<string, string | number>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, String(v));
  const login = (memory.raw.prepare("SELECT github_login FROM users WHERE id = ?").get(asUser) as { github_login: string }).github_login;
  const user = { id: asUser, encrypted_access_token: `enc-${login}` } as AuthenticatedUser;
  const context = { get: (key: unknown) => (key === userContext ? user : undefined), cloudflare: { env: { ENCRYPTION_KEY: "k" } } };
  return action({ request: new Request("http://localhost/team", { method: "POST", body }), context, params: {} } as never);
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  memory = createMemoryD1();
  db = drizzle(asD1(memory), { schema });
  seedActionMember(CONVENOR, "owner", "convenor");
  permissions = { owner: "admin" };
  invitations = [];
  vi.mocked(accountLogin).mockReset().mockImplementation(async (_t, id) => {
    const row = memory.raw.prepare("SELECT github_login FROM users WHERE github_id = ?").get(id) as { github_login: string } | undefined;
    return row?.github_login ?? null;
  });
  vi.mocked(memberPermission).mockReset().mockImplementation(async (_t, _o, _r, login) => permissions[login] ?? "none");
  vi.mocked(listRepoInvitations).mockReset().mockImplementation(async () => invitations);
  vi.mocked(addCollaborator).mockReset();
  vi.mocked(deleteInvitation).mockReset().mockResolvedValue(undefined);
  vi.mocked(removeCollaborator).mockReset().mockResolvedValue(undefined);
  vi.mocked(acceptInvitation).mockReset();
  vi.mocked(decrypt).mockClear();
});

afterEach(() => {
  memory.close();
  vi.restoreAllMocks();
});

describe("a convenor's add", () => {
  it.each([
    ["stopped at the cap", { gh_access: "none", gh_add_state: "failed", gh_add_attempts: 5, gh_add_error: "x" }],
    ["joined before the release", { gh_access: "none", gh_add_owed: 0 }],
  ])("sends the add now for a member %s, owes it, and counts from one", async (_label, extra) => {
    seedActionMember(11, "ana", "collaborator", extra);
    vi.mocked(addCollaborator).mockResolvedValueOnce({ status: "invited", invitationId: 90, htmlUrl: "u90" });
    await expect(postTeamAction(CONVENOR, { intent: "add", userId: 11 })).resolves.toEqual({ ok: true, userId: 11 });
    expect(addCollaborator).toHaveBeenCalledWith("iat", "owner", "site", "ana", expect.any(AbortSignal));
    expect(actionRow(11)).toMatchObject({ gh_access: "pending", gh_invitation_id: 90, gh_add_state: "sent", gh_add_attempts: 1, gh_add_error: null, gh_add_owed: 1 });
  });

  it("records a failed add as the reconciler does, so it is retried", async () => {
    seedActionMember(11, "ana", "collaborator", { gh_access: "none", gh_add_owed: 0 });
    vi.mocked(addCollaborator).mockRejectedValueOnce(new Error("GitHub API error adding a collaborator: 502"));
    await expect(postTeamAction(CONVENOR, { intent: "add", userId: 11 })).resolves.toMatchObject({ ok: false, error: "failed" });
    expect(actionRow(11)).toMatchObject({ gh_add_state: "failed", gh_add_attempts: 1, gh_add_error: "GitHub API error adding a collaborator: 502", gh_add_owed: 1 });
  });

  it("refuses when GitHub now shows an invitation, records it, and sends nothing", async () => {
    seedActionMember(11, "ana", "collaborator", { gh_access: "none", gh_add_state: "failed", gh_add_attempts: 5 });
    invitations = [invite("ana", 81)];
    await expect(postTeamAction(CONVENOR, { intent: "add", userId: 11 })).resolves.toEqual({ ok: false, userId: 11, error: "changed" });
    expect(addCollaborator).not.toHaveBeenCalled();
    expect(actionRow(11)).toMatchObject({ gh_access: "pending", gh_invitation_id: 81, gh_add_attempts: 5 });
  });
});

describe("a convenor's add against a membership that changes while it is sent", () => {
  const PROJECT = { id: 1, github_repo_full_name: "owner/site", installation_id: 5 };
  const ENV = { GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "k", GITHUB_APP_SLUG: "telar-compositor" };

  function withdrawalUsers() {
    return (memory.raw.prepare("SELECT user_id FROM repo_access_withdrawals ORDER BY id").all() as Array<{ user_id: number }>).map((r) => r.user_id);
  }

  it("marks the row sending before GitHub is called, and a removal mid-add records a withdrawal the next refresh acts on", async () => {
    seedActionMember(11, "ana", "collaborator", { gh_access: "none", gh_add_owed: 0 });
    let stateDuringAdd: unknown;
    vi.mocked(addCollaborator).mockImplementationOnce(async () => {
      stateDuringAdd = actionRow(11).gh_add_state;
      const ending = and(eq(schema.project_members.project_id, 1), eq(schema.project_members.user_id, 11));
      await db.batch([recordWithdrawals(db, ending), db.delete(schema.project_members).where(ending)]);
      return { status: "invited", invitationId: 93, htmlUrl: "u93" };
    });
    await postTeamAction(CONVENOR, { intent: "add", userId: 11 });
    expect(stateDuringAdd).toBe("sending");
    expect(withdrawalUsers()).toEqual([11]);
    invitations = [invite("ana", 93)];
    await refreshTeamAccess(ENV, db, PROJECT, Date.now() + TEAM_ACCESS_TTL_MS + 1);
    expect(deleteInvitation).toHaveBeenCalledWith("iat", "owner", "site", 93, expect.any(AbortSignal));
    expect(withdrawalUsers()).toEqual([]);
  });

  it("bounds the add at GitHub by the run's deadline, so the withdrawal's settle window outlasts it", async () => {
    seedActionMember(11, "ana", "collaborator", { gh_access: "none", gh_add_owed: 0 });
    let signal: AbortSignal | undefined;
    vi.mocked(addCollaborator).mockImplementationOnce(async (...args: unknown[]) => {
      signal = args[4] as AbortSignal | undefined;
      return { status: "invited", invitationId: 93, htmlUrl: "u93" };
    });
    await postTeamAction(CONVENOR, { intent: "add", userId: 11 });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(CONVENOR_ADD_DEADLINE_MS).toBeLessThan(WITHDRAWAL_SETTLE_WINDOW_MS);
  });

  it("sends nothing for a row revoked after it was read", async () => {
    seedActionMember(11, "ana", "collaborator", { gh_access: "none", gh_add_owed: 0 });
    vi.mocked(listRepoInvitations).mockImplementationOnce(async () => {
      memory.raw.exec("UPDATE project_members SET gh_add_state = 'revoked' WHERE user_id = 11");
      return [];
    });
    await expect(postTeamAction(CONVENOR, { intent: "add", userId: 11 })).resolves.toMatchObject({ ok: false });
    expect(addCollaborator).not.toHaveBeenCalled();
    expect(actionRow(11)).toMatchObject({ gh_add_state: "revoked", gh_add_attempts: 0 });
  });

  it("sends nothing for a row removed after it was read", async () => {
    seedActionMember(11, "ana", "collaborator", { gh_access: "none", gh_add_owed: 0 });
    vi.mocked(listRepoInvitations).mockImplementationOnce(async () => {
      memory.raw.exec("DELETE FROM project_members WHERE user_id = 11");
      return [];
    });
    await expect(postTeamAction(CONVENOR, { intent: "add", userId: 11 })).resolves.toMatchObject({ ok: false });
    expect(addCollaborator).not.toHaveBeenCalled();
  });
});

describe("a convenor's reissue", () => {
  it("deletes the lapsed invitation, then adds again", async () => {
    seedActionMember(11, "ana", "collaborator", { gh_access: "lapsed", gh_invitation_id: 82 });
    invitations = [invite("ana", 82, true)];
    vi.mocked(addCollaborator).mockResolvedValueOnce({ status: "invited", invitationId: 95, htmlUrl: "u95" });
    await expect(postTeamAction(CONVENOR, { intent: "reissue", userId: 11 })).resolves.toEqual({ ok: true, userId: 11 });
    expect(deleteInvitation).toHaveBeenCalledWith("iat", "owner", "site", 82);
    expect(vi.mocked(deleteInvitation).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(addCollaborator).mock.invocationCallOrder[0]);
    expect(actionRow(11)).toMatchObject({ gh_access: "pending", gh_invitation_id: 95, gh_add_state: "sent" });
  });

  it("leaves a row withdrawn meanwhile revoked, and deletes the invitation its own add opened", async () => {
    seedActionMember(11, "ana", "collaborator", { gh_access: "lapsed", gh_invitation_id: 82 });
    invitations = [invite("ana", 82, true)];
    vi.mocked(addCollaborator).mockImplementationOnce(async () => {
      memory.raw.exec("UPDATE project_members SET gh_access = 'none', gh_invitation_id = NULL, gh_add_state = 'revoked' WHERE user_id = 11");
      return { status: "invited", invitationId: 95, htmlUrl: "u95" };
    });
    await postTeamAction(CONVENOR, { intent: "reissue", userId: 11 });
    expect(actionRow(11)).toMatchObject({ gh_access: "none", gh_invitation_id: null, gh_add_state: "revoked" });
    expect(deleteInvitation).toHaveBeenLastCalledWith("iat", "owner", "site", 95);
  });

  it("refuses when the member accepted since the page loaded", async () => {
    seedActionMember(11, "ana", "collaborator", { gh_access: "lapsed", gh_invitation_id: 82 });
    permissions.ana = "write";
    await expect(postTeamAction(CONVENOR, { intent: "reissue", userId: 11 })).resolves.toMatchObject({ ok: false, error: "changed" });
    expect(deleteInvitation).not.toHaveBeenCalled();
    expect(addCollaborator).not.toHaveBeenCalled();
    expect(actionRow(11).gh_access).toBe("access");
  });
});

describe("a convenor's withdrawal", () => {
  it("removes a collaborator with access and records the row as revoked", async () => {
    seedActionMember(11, "ana", "collaborator", { gh_access: "access", gh_add_state: "sent" });
    permissions.ana = "write";
    await expect(postTeamAction(CONVENOR, { intent: "revoke", userId: 11 })).resolves.toEqual({ ok: true, userId: 11 });
    expect(removeCollaborator).toHaveBeenCalledWith("iat", "owner", "site", "ana");
    expect(actionRow(11)).toMatchObject({ gh_access: "none", gh_add_state: "revoked" });
  });

  it("deletes a pending invitation rather than removing a collaborator", async () => {
    seedActionMember(11, "ana", "collaborator", { gh_access: "pending", gh_invitation_id: 81 });
    invitations = [invite("ana", 81)];
    await postTeamAction(CONVENOR, { intent: "revoke", userId: 11 });
    expect(deleteInvitation).toHaveBeenCalledWith("iat", "owner", "site", 81);
    expect(removeCollaborator).not.toHaveBeenCalled();
    expect(actionRow(11)).toMatchObject({ gh_access: "none", gh_invitation_id: null, gh_add_state: "revoked" });
  });

  it("refuses when the member is no longer on the repository", async () => {
    seedActionMember(11, "ana", "collaborator", { gh_access: "access" });
    await expect(postTeamAction(CONVENOR, { intent: "revoke", userId: 11 })).resolves.toMatchObject({ ok: false, error: "changed" });
    expect(removeCollaborator).not.toHaveBeenCalled();
    expect(actionRow(11).gh_add_state).toBeNull();
  });

  it("refuses an instructor's row without asking GitHub", async () => {
    seedActionMember(11, "ines", "instructor", { gh_access: "access" });
    permissions.ines = "write";
    for (const intent of ["revoke", "add", "reissue"]) {
      await expect(postTeamAction(CONVENOR, { intent, userId: 11 })).resolves.toEqual({ ok: false, userId: 11, error: "instructor" });
    }
    expect(accountLogin).not.toHaveBeenCalled();
    expect(removeCollaborator).not.toHaveBeenCalled();
  });

  it("refuses the convenor's own row", async () => {
    await expect(postTeamAction(CONVENOR, { intent: "revoke", userId: CONVENOR })).resolves.toMatchObject({ ok: false, error: "owner" });
    expect(removeCollaborator).not.toHaveBeenCalled();
  });
});

describe("who may act", () => {
  it("refuses a collaborator acting on another member's row", async () => {
    seedActionMember(11, "ana", "collaborator", { gh_access: "access" });
    seedActionMember(12, "beto", "collaborator", { gh_access: "none", gh_add_owed: 0 });
    permissions.ana = "write";
    for (const intent of ["revoke", "add"]) {
      await expect(postTeamAction(12, { intent, userId: 11 })).rejects.toMatchObject({ status: 403 });
    }
    expect(removeCollaborator).not.toHaveBeenCalled();
    expect(addCollaborator).not.toHaveBeenCalled();
  });

  it("refuses someone outside the project, even for Accept", async () => {
    memory.raw.exec(
      "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
        "VALUES (30, 130, 'outsider', 'enc-outsider', 'e', '2099-01-01', '2099-01-01')",
    );
    await expect(postTeamAction(30, { intent: "accept" })).rejects.toMatchObject({ status: 403 });
    expect(accountLogin).not.toHaveBeenCalled();
  });

  it("accepts only the caller's own invitation, whatever user id is posted", async () => {
    seedActionMember(11, "ana", "collaborator", { gh_access: "pending" });
    seedActionMember(12, "beto", "collaborator", { gh_access: "pending" });
    invitations = [invite("ana", 81), invite("beto", 82)];
    vi.mocked(acceptInvitation).mockResolvedValue("accepted");
    await expect(postTeamAction(12, { intent: "accept", userId: 11 })).resolves.toEqual({ ok: true, userId: 12 });
    expect(acceptInvitation).toHaveBeenCalledWith("own-token", 82);
    expect(decrypt).toHaveBeenCalledWith("enc-beto", "k");
    expect(actionRow(11).gh_access).toBe("pending");
  });
});

describe("accepting in place", () => {
  it("accepts on the caller's own token and records access", async () => {
    seedActionMember(11, "ana", "collaborator", { gh_access: "pending", gh_invitation_id: 81 });
    invitations = [invite("ana", 81)];
    vi.mocked(acceptInvitation).mockResolvedValueOnce("accepted");
    await expect(postTeamAction(11, { intent: "accept" })).resolves.toEqual({ ok: true, userId: 11 });
    expect(acceptInvitation).toHaveBeenCalledWith("own-token", 81);
    expect(decrypt).toHaveBeenCalledWith("enc-ana", "k");
    expect(actionRow(11)).toMatchObject({ gh_access: "access", gh_invitation_id: null });
  });

  it.each([
    ["404", () => vi.mocked(acceptInvitation).mockResolvedValueOnce("gone")],
    ["409", () => vi.mocked(acceptInvitation).mockResolvedValueOnce("conflict")],
    ["451", () => vi.mocked(acceptInvitation).mockResolvedValueOnce("blocked")],
    ["403", () => vi.mocked(acceptInvitation).mockRejectedValueOnce(new GitHubPermissionError("GitHub API error accepting an invitation: 403", 403))],
    ["a token failure", () => vi.mocked(decrypt).mockRejectedValueOnce(new Error("bad key"))],
  ])("on %s hands back the invitation on GitHub and records nothing", async (_label, arrange) => {
    seedActionMember(11, "ana", "collaborator", { gh_access: "pending", gh_invitation_id: 81 });
    invitations = [invite("ana", 81)];
    arrange();
    await expect(postTeamAction(11, { intent: "accept" })).resolves.toEqual({
      ok: false,
      userId: 11,
      error: "accept_refused",
      fallbackUrl: "https://github.com/owner/site/invitations/81",
    });
    expect(actionRow(11).gh_access).toBe("pending");
  });

  it("hands back the stored link when the invitation cannot be read", async () => {
    seedActionMember(11, "ana", "collaborator", { gh_access: "pending", gh_invitation_url: "https://github.com/owner/site/invitations/81" });
    vi.mocked(listRepoInvitations).mockRejectedValueOnce(new Error("GitHub API error listing invitations: 502"));
    await expect(postTeamAction(11, { intent: "accept" })).resolves.toMatchObject({
      error: "accept_refused",
      fallbackUrl: "https://github.com/owner/site/invitations/81",
    });
    expect(acceptInvitation).not.toHaveBeenCalled();
  });

  it("refuses a lapsed invitation without trying to accept it", async () => {
    seedActionMember(11, "ana", "collaborator", { gh_access: "pending", gh_invitation_id: 81 });
    invitations = [invite("ana", 81, true)];
    await expect(postTeamAction(11, { intent: "accept" })).resolves.toEqual({ ok: false, userId: 11, error: "lapsed" });
    expect(acceptInvitation).not.toHaveBeenCalled();
    expect(actionRow(11).gh_access).toBe("lapsed");
  });

  it("answers lapsed when GitHub no longer lists the invitation and the member has no access", async () => {
    seedActionMember(11, "ana", "collaborator", { gh_access: "pending", gh_invitation_id: 81 });
    await expect(postTeamAction(11, { intent: "accept" })).resolves.toEqual({ ok: false, userId: 11, error: "lapsed" });
    expect(acceptInvitation).not.toHaveBeenCalled();
    expect(actionRow(11)).toMatchObject({ gh_access: "lapsed", gh_invitation_id: 81 });
  });

  it("answers changed when the member holds no invitation on record", async () => {
    seedActionMember(11, "ana", "collaborator", { gh_access: "none" });
    await expect(postTeamAction(11, { intent: "accept" })).resolves.toMatchObject({ ok: false, error: "changed" });
    expect(acceptInvitation).not.toHaveBeenCalled();
    expect(actionRow(11).gh_access).toBe("none");
  });

  it("lets a convenor send a new invitation for one that is gone, without deleting it", async () => {
    seedActionMember(11, "ana", "collaborator", { gh_access: "lapsed", gh_invitation_id: 81 });
    vi.mocked(addCollaborator).mockResolvedValueOnce({ status: "invited", invitationId: 90, htmlUrl: "u90" });
    await expect(postTeamAction(CONVENOR, { intent: "reissue", userId: 11 })).resolves.toEqual({ ok: true, userId: 11 });
    expect(deleteInvitation).not.toHaveBeenCalled();
    expect(actionRow(11)).toMatchObject({ gh_access: "pending", gh_invitation_id: 90 });
  });
});
