/**
 * The team page's loader and the state each row shows.
 *
 * The loader reads the database alone and tells each member apart by where
 * they stand: a pure function of the stage, the add state, the attempts and
 * whether an add was owed. The cases run the real loader against the
 * migration chain in memory, and the pure function directly for the
 * combinations a row cannot be seeded into.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import * as schema from "~/db/schema";
import { users, projects, project_members, project_invites } from "~/db/schema";
import { createMemoryD1, asD1 } from "./helpers/d1-memory";
import { teamRowState, teamRowActions, RepoAccessContradiction } from "~/lib/repo-access";
import { commitOnOwnToken } from "~/lib/publish-commit-token.server";
import { GitHubPermissionError } from "~/lib/github.server";
import { ADD_ATTEMPT_CAP, TEAM_ACCESS_TTL_MS } from "~/lib/team-access.server";

let db: ReturnType<typeof drizzle<typeof schema>>;
let env: { DB: unknown };
let activeProjectId = 0;
const githubCalls = vi.fn();

vi.stubGlobal("fetch", (...args: unknown[]) => {
  githubCalls(...args);
  throw new Error("the loader must not call GitHub");
});
vi.mock("~/lib/db.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/db.server")>();
  return { ...actual, getDb: () => db };
});
vi.mock("~/lib/active-project.server", () => ({
  resolveActiveProjectFromRequest: async () => {
    const rows = await db.select().from(projects).where(eq(projects.id, activeProjectId));
    return { project: rows[0] };
  },
}));

import { loader } from "~/routes/_app.team";
import { userContext } from "~/middleware/auth.server";
import type { AuthenticatedUser } from "~/middleware/auth.server";

let nextUser = 0;
async function seedMember(
  projectId: number,
  role: "convenor" | "collaborator" | "instructor",
  extra: Partial<typeof project_members.$inferInsert> = {},
) {
  nextUser += 1;
  const [u] = await db
    .insert(users)
    .values({
      github_id: 5000 + nextUser,
      github_login: `person${nextUser}`,
      encrypted_access_token: "enc",
      encrypted_refresh_token: "enc",
      access_token_expires_at: "2099-01-01T00:00:00Z",
      refresh_token_expires_at: "2099-01-01T00:00:00Z",
    })
    .returning({ id: users.id });
  await db
    .insert(project_members)
    .values({ project_id: projectId, user_id: u.id, role, joined_at: "2026-10-01T00:00:00Z", ...extra });
  return u.id;
}

function load(userId: number) {
  const context = {
    get: (key: unknown) => (key === userContext ? ({ id: userId } as AuthenticatedUser) : undefined),
    cloudflare: { env },
  };
  return loader({ request: new Request("http://localhost/team"), context, params: {} } as never);
}

let convenor = 0;
beforeEach(async () => {
  const memory = createMemoryD1();
  db = drizzle(asD1(memory), { schema });
  env = { DB: asD1(memory) };
  githubCalls.mockClear();
  const [u] = await db
    .insert(users)
    .values({
      github_id: 4000,
      github_login: "owner",
      encrypted_access_token: "enc",
      encrypted_refresh_token: "enc",
      access_token_expires_at: "2099-01-01T00:00:00Z",
      refresh_token_expires_at: "2099-01-01T00:00:00Z",
    })
    .returning({ id: users.id });
  convenor = u.id;
  const [p] = await db
    .insert(projects)
    .values({ user_id: u.id, github_repo_full_name: "owner/repo", installation_id: 1 })
    .returning({ id: projects.id });
  activeProjectId = p.id;
  await db.insert(project_members).values({ project_id: p.id, user_id: u.id, role: "convenor", joined_at: "2026-10-01T00:00:00Z" });
});

describe("the team page loader", () => {
  it("gives each member the state their stage and add history call for, without calling GitHub", async () => {
    const checked = "2026-10-02T10:00:00.000Z";
    await seedMember(activeProjectId, "collaborator", { gh_access: "access", gh_access_checked_at: "2026-10-02T09:00:00.000Z" });
    await seedMember(activeProjectId, "collaborator", { gh_access: "pending", gh_access_checked_at: checked });
    await seedMember(activeProjectId, "collaborator", { gh_access: "lapsed" });
    await seedMember(activeProjectId, "collaborator", { gh_access: "none" });
    await seedMember(activeProjectId, "collaborator", { gh_access: "none", gh_add_state: "failed", gh_add_attempts: 2, gh_add_error: "rate limited" });
    await seedMember(activeProjectId, "collaborator", { gh_access: "none", gh_add_state: "failed", gh_add_attempts: ADD_ATTEMPT_CAP });
    await seedMember(activeProjectId, "collaborator", { gh_access: "none", gh_add_state: "revoked" });
    await seedMember(activeProjectId, "collaborator", { gh_access: "none", gh_add_owed: false });
    await seedMember(activeProjectId, "instructor", { gh_access: "none" });
    const [other] = await db
      .insert(projects)
      .values({ user_id: convenor, github_repo_full_name: "owner/other", installation_id: 1 })
      .returning({ id: projects.id });
    await seedMember(other.id, "collaborator", { gh_access: "access", gh_access_checked_at: "2026-10-03T00:00:00.000Z" });
    const roster = await load(convenor);
    expect(roster.rows.map((r) => r.state)).toEqual([
      "waiting", // the convenor's own row, never read
      "access", "pending", "lapsed", "waiting", "retrying", "stopped", "withdrawn", "before", "unlisted",
    ]);
    expect(roster.rows[5]).toMatchObject({ role: "collaborator", error: "rate limited" });
    expect(roster.checkedAt).toBe(checked);
    expect(githubCalls).not.toHaveBeenCalled();
  });

  it("lists each outstanding invite link at the invited stage, and no used, cancelled, expired or course code", async () => {
    const base = { project_id: activeProjectId, created_by: convenor, conferred_role: "collaborator" };
    const later = new Date(Date.now() + 86_400_000).toISOString();
    await db.insert(project_invites).values([
      { ...base, token: crypto.randomUUID(), expires_at: later },
      { ...base, token: crypto.randomUUID(), expires_at: later, used_at: "2026-10-01T00:00:00Z" },
      { ...base, token: crypto.randomUUID(), expires_at: later, revoked_at: "2026-10-01T00:00:00Z" },
      { ...base, token: crypto.randomUUID(), expires_at: "2020-01-01T00:00:00Z" },
      { ...base, token: "CLASS-CODE", expires_at: null },
    ]);
    const roster = await load(convenor);
    expect(roster.invited).toEqual([{ state: "invited", expiresAt: later }]);
  });

  it("marks a row never read, or read a run before the newest, as behind the page's check time", async () => {
    const newest = "2026-10-02T10:00:00.000Z";
    const sameRun = new Date(Date.parse(newest) - 1000).toISOString();
    const earlier = new Date(Date.parse(newest) - TEAM_ACCESS_TTL_MS - 1).toISOString();
    await seedMember(activeProjectId, "collaborator", { gh_access: "access", gh_access_checked_at: newest });
    await seedMember(activeProjectId, "collaborator", { gh_access: "access", gh_access_checked_at: sameRun });
    await seedMember(activeProjectId, "collaborator", { gh_access: "pending", gh_access_checked_at: earlier });
    const roster = await load(convenor);
    expect(roster.rows.map((r) => [r.behind, r.checkedAt])).toEqual([
      [true, null],
      [false, newest],
      [false, sameRun],
      [true, earlier],
    ]);
  });

  it("has no check time before any row has been read", async () => {
    expect((await load(convenor)).checkedAt).toBeNull();
  });

  it("lets a collaborator open the page and refuses someone outside the project", async () => {
    const collaborator = await seedMember(activeProjectId, "collaborator");
    await expect(load(collaborator)).resolves.toMatchObject({ rows: expect.any(Array) });
    const [outsider] = await db
      .insert(users)
      .values({
        github_id: 9999,
        github_login: "outsider",
        encrypted_access_token: "enc",
        encrypted_refresh_token: "enc",
        access_token_expires_at: "2099-01-01T00:00:00Z",
        refresh_token_expires_at: "2099-01-01T00:00:00Z",
      })
      .returning({ id: users.id });
    await expect(load(outsider.id)).rejects.toMatchObject({ status: 403 });
  });
});

describe("teamRowState", () => {
  const base = { role: "collaborator", addState: null, attempts: 0, owed: true } as const;
  it("gives an invited-stage row its own state", () => {
    expect(teamRowState({ ...base, stage: { stage: "invited" } }, ADD_ATTEMPT_CAP)).toBe("invited");
  });
  it("still refuses a contradiction", () => {
    expect(() => teamRowState({ ...base, stage: { stage: "bogus" } as never }, ADD_ATTEMPT_CAP)).toThrow(RepoAccessContradiction);
  });
  it("keeps a failure that has reached the cap apart from one still being retried", () => {
    const stage = { stage: "member", remedy: "add" } as const;
    expect(teamRowState({ ...base, stage, addState: "failed", attempts: ADD_ATTEMPT_CAP - 1 }, ADD_ATTEMPT_CAP)).toBe("retrying");
    expect(teamRowState({ ...base, stage, addState: "failed", attempts: ADD_ATTEMPT_CAP }, ADD_ATTEMPT_CAP)).toBe("stopped");
  });
});

describe("a member whose own token a publish was refused", () => {
  it("still shows access and offers Revoke, and the next publish commits on the installation token", async () => {
    const userId = await seedMember(activeProjectId, "collaborator", { gh_access: "access", gh_access_checked_at: "2026-10-02T09:00:00.000Z" });
    const who = { projectId: activeProjectId, userId, userToken: "member", installToken: "install" };
    const refusedOnce = vi.fn(async (token: string) => {
      if (token === "member") throw new GitHubPermissionError("refused", 403);
      return token;
    });
    await expect(commitOnOwnToken(db as never, who, refusedOnce)).resolves.toBe("install");
    const row = (await load(convenor)).rows.find((r) => r.userId === userId)!;
    expect(row.state).toBe("access");
    expect(teamRowActions({ role: row.role, state: row.state }, { convenor: true, self: false })).toEqual(["revoke"]);
    const next = vi.fn(async (token: string) => token);
    await expect(commitOnOwnToken(db as never, who, next)).resolves.toBe("install");
  });
});
