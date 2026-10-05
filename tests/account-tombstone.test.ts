/**
 * A deleted account leaves a tombstone, and its credit stays.
 *
 * Ruled 23 September: a departed person's credit is part of each project's
 * history, under their name. So deleting an account keeps its `users` row,
 * cleared down to the name, and marks it deleted; every reference to the
 * person stays valid. These cases hold the deletion to that, and hold every
 * door a live account has to staying shut on the tombstone: signing in, an
 * old cookie, an invite by username, and any membership at all.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";

import * as schema from "~/db/schema";
import {
  users,
  projects,
  project_members,
  member_editing_time,
  entity_contributors,
  activity_log,
  project_invites,
  stories,
  steps,
} from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;
/** The project the session names, for the dashboard action. */
let activeProjectId = 0;

vi.mock("~/lib/crypto.server", () => ({ decrypt: async () => "user-token", encrypt: async () => "enc" }));
vi.mock("~/lib/github.server", () => ({
  listUserInstallations: vi.fn(async () => []),
}));
vi.mock("~/lib/db.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/db.server")>();
  return { ...actual, getDb: () => db };
});
vi.mock("~/lib/active-project.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/active-project.server")>();
  return {
    ...actual,
    resolveActiveProjectFromRequest: async (_req: Request, _env: unknown, userId: number) => {
      const rows = await db.select().from(projects).where(eq(projects.id, activeProjectId));
      const role = await roleOn(activeProjectId, userId);
      return rows[0] && role ? { project: rows[0], userRole: role } : null;
    },
  };
});

import { action as accountAction } from "~/routes/_app.account";
import { action as onboardingAction } from "~/routes/onboarding";
import { action as dashboardAction } from "~/routes/_app.dashboard";
import { authMiddleware } from "~/middleware/auth.server";
import { createSessionStorage } from "~/lib/session.server";
import { getContributionRecord } from "~/lib/contributions.server";
import { userContext } from "~/middleware/auth.server";
import { maybeRefreshToken } from "~/lib/auth.server";
import { action as localeAction } from "~/routes/api.locale";
import { action as releaseAckAction } from "~/routes/api.release-ack";
import { action as inviteAction } from "~/routes/_auth.invite.$token";
import { getRecentActivity } from "~/lib/activity.server";
import type { AuthenticatedUser } from "~/middleware/auth.server";

const future = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

let nextUser = 0;
async function seedUser(): Promise<number> {
  nextUser += 1;
  const rows = await db
    .insert(users)
    .values({
      github_id: 3000 + nextUser,
      github_login: `user${nextUser}`,
      encrypted_access_token: "enc",
      encrypted_refresh_token: "enc",
      access_token_expires_at: future(),
      refresh_token_expires_at: future(),
    })
    .returning({ id: users.id });
  return rows[0].id;
}

let nextRepo = 0;
async function seedProject(
  ownerId: number,
  kind: "site" | "course",
  parentProjectId: number | null = null,
): Promise<number> {
  nextRepo += 1;
  const rows = await db
    .insert(projects)
    .values({
      user_id: ownerId,
      github_repo_full_name: `owner/repo${nextRepo}`,
      installation_id: 1,
      kind,
      parent_project_id: parentProjectId,
    })
    .returning({ id: projects.id });
  await addMember(rows[0].id, ownerId, "convenor");
  return rows[0].id;
}

async function addMember(
  projectId: number,
  userId: number,
  role: "convenor" | "collaborator" | "instructor",
) {
  await db.insert(project_members).values({
    project_id: projectId,
    user_id: userId,
    role,
    joined_at: new Date().toISOString(),
  });
}

async function roleOn(projectId: number, userId: number): Promise<string | null> {
  const rows = await db
    .select({ role: project_members.role })
    .from(project_members)
    .where(and(eq(project_members.project_id, projectId), eq(project_members.user_id, userId)))
    .limit(1);
  return rows[0]?.role ?? null;
}

/** Every Durable Object request, as `project:path:userId`. */
let doCalls: string[] = [];
/** Runs inside each Durable Object request, to interleave a concurrent write. */
let duringDoCall: (() => Promise<void>) | null = null;
/** The child Durable Object refuses to clear course markers. */
let markerClearFails = false;

function makeContext(userId: number) {
  return {
    get: (key: unknown) => (key === userContext ? ({ id: userId } as AuthenticatedUser) : undefined),
    cloudflare: {
      env: {
        DB: asD1(memory),
        SESSION_SECRET: "test-secret",
        ENCRYPTION_KEY: "key",
        COLLABORATION: {
          idFromName: (name: string) => name,
          get: (id: unknown) => ({
            fetch: async (req: Request) => {
              const url = new URL(req.url);
              doCalls.push(`${String(id)}:${url.pathname}:${url.searchParams.get("userId")}`);
              if (duringDoCall) await duringDoCall();
              if (url.pathname === "/clear-course-markers") {
                return markerClearFails
                  ? new Response("flush_failed", { status: 503 })
                  : Response.json({ cleared: 0 });
              }
              return new Response("OK", { status: 200 });
            },
          }),
        },
      },
    },
  };
}

function post(path: string, fields: Record<string, string>) {
  return new Request(`http://localhost:5173${path}`, {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
}

function deleteProject(userId: number, projectId: number) {
  return accountAction({
    request: post("/account", { intent: "delete-project", projectId: String(projectId) }),
    context: makeContext(userId),
    params: {},
  } as unknown as Parameters<typeof accountAction>[0]);
}

async function deleteAccount(userId: number) {
  const user = (await db.select().from(users).where(eq(users.id, userId)))[0];
  return accountAction({
    request: post("/account", { intent: "delete-account", confirmation: user.github_login }),
    context: makeContext(userId),
    params: {},
  } as unknown as Parameters<typeof accountAction>[0]).catch((e: unknown) => e);
}

function unlinkProject(userId: number, projectId: number) {
  return onboardingAction({
    request: post("/onboarding", { intent: "unlink-project", project_id: String(projectId) }),
    context: makeContext(userId),
    params: {},
  } as unknown as Parameters<typeof onboardingAction>[0]);
}

async function seedStory(projectId: number): Promise<number> {
  const rows = await db.insert(stories).values({ project_id: projectId, story_id: "s1", title: "Story" }).returning({ id: stories.id });
  return rows[0].id;
}

/** The leaver, on a site owned by someone else, with credit there of every kind the record reads. */
async function seedLeaverWithCredit() {
  const owner = await seedUser();
  const site = await seedProject(owner, "site");
  const leaver = await seedUser();
  await addMember(site, leaver, "collaborator");
  const story = await seedStory(site);
  const [step] = await db
    .insert(steps)
    .values({ story_id: story, step_number: 1, created_by: leaver })
    .returning({ id: steps.id });
  await db.insert(entity_contributors).values({
    project_id: site,
    entity_kind: "step",
    entity_id: step.id,
    user_id: leaver,
    words_written: 40,
  });
  await db.insert(member_editing_time).values({ project_id: site, user_id: leaver, editing_seconds: 600, writing_seconds: 300 });
  await db.insert(activity_log).values({ project_id: site, actor_user_id: leaver, verb: "edited", entity_type: "step" });
  const githubId = (await db.select({ g: users.github_id }).from(users).where(eq(users.id, leaver)))[0].g;
  return { owner, site, leaver, step: step.id, githubId };
}

beforeEach(() => {
  memory = createMemoryD1();
  db = drizzle(asD1(memory), { schema });
  doCalls = [];
  duringDoCall = null;
  markerClearFails = false;
});

describe("deleting an account with credit on someone else's site", () => {
  it("succeeds, and keeps the row as a tombstone holding only the name", async () => {
    const s = await seedLeaverWithCredit();
    await deleteAccount(s.leaver);

    const [row] = await db.select().from(users).where(eq(users.id, s.leaver));
    expect(row.deleted_at).not.toBeNull();
    expect(row.github_id).toBe(-s.leaver);
    expect(row.github_email).toBeNull();
    expect(row.encrypted_access_token).toBe("");
    expect(row.encrypted_refresh_token).toBe("");
    expect(new Date(row.access_token_expires_at).getTime()).toBe(0);
    expect(row.course_access).toBe(false);
    expect(row.ui_locale).toBeNull();
    expect(await roleOn(s.site, s.leaver)).toBeNull();
  });

  it("keeps their credit and activity on the site, all still naming them", async () => {
    const s = await seedLeaverWithCredit();
    await deleteAccount(s.leaver);

    expect((await db.select({ c: steps.created_by }).from(steps).where(eq(steps.id, s.step)))[0].c).toBe(s.leaver);
    expect(await db.select().from(entity_contributors).where(eq(entity_contributors.user_id, s.leaver))).toHaveLength(1);
    expect(await db.select().from(member_editing_time).where(eq(member_editing_time.user_id, s.leaver))).toHaveLength(1);
    expect(await db.select().from(activity_log).where(eq(activity_log.actor_user_id, s.leaver))).toHaveLength(1);
  });

  it("shows them on the site's contribution record as a former member, with their credit", async () => {
    const s = await seedLeaverWithCredit();
    const [before] = await db.select().from(users).where(eq(users.id, s.leaver));
    await deleteAccount(s.leaver);

    const record = await getContributionRecord(db as never, s.site);
    const former = record.members.find((m) => m.userId === s.leaver);
    expect(former).toMatchObject({ former: true, role: "former", displayName: before.github_login, color: null });
    expect(former!.kinds.steps).toMatchObject({ added: 1, edited: 1, words: 40 });
    expect(former!.editingSeconds).toBe(600);
    expect(record.members.find((m) => m.userId === s.owner)?.former).toBe(false);
  });
});

describe("a record with more former members than one lookup binds", () => {
  it("lists every one of them", async () => {
    const owner = await seedUser();
    const site = await seedProject(owner, "site");
    const former: number[] = [];
    for (let i = 0; i < 95; i += 1) {
      const id = await seedUser();
      former.push(id);
      await db.insert(member_editing_time).values({ project_id: site, user_id: id, editing_seconds: 60, writing_seconds: 0 });
    }

    const record = await getContributionRecord(db as never, site);
    expect(record.members.filter((m) => m.former).map((m) => m.userId).sort((a, b) => a - b)).toEqual(former);
  });
});

describe("the tombstone is never an account again", () => {
  it("does not answer to its GitHub id, so the next sign-in makes a new account", async () => {
    const s = await seedLeaverWithCredit();
    await deleteAccount(s.leaver);
    expect(await db.select().from(users).where(eq(users.github_id, s.githubId))).toEqual([]);
  });

  it("cannot be made a member of anything, by any route", async () => {
    const s = await seedLeaverWithCredit();
    await deleteAccount(s.leaver);
    // Drizzle wraps the trigger's abort; what counts is that no row lands.
    await expect(addMember(s.site, s.leaver, "collaborator")).rejects.toThrow();
    expect(await roleOn(s.site, s.leaver)).toBeNull();
  });

  it("cannot take over an existing membership row either", async () => {
    const s = await seedLeaverWithCredit();
    const other = await seedUser();
    await addMember(s.site, other, "collaborator");
    await deleteAccount(s.leaver);
    await expect(
      db.update(project_members).set({ user_id: s.leaver }).where(and(eq(project_members.project_id, s.site), eq(project_members.user_id, other))),
    ).rejects.toThrow();
    expect(await roleOn(s.site, s.leaver)).toBeNull();
    expect(await roleOn(s.site, other)).toBe("collaborator");
  });

  it("signs out an old session cookie that names it", async () => {
    const s = await seedLeaverWithCredit();
    await deleteAccount(s.leaver);

    const storage = createSessionStorage("test-secret");
    const session = await storage.getSession();
    session.set("userId", s.leaver);
    session.set("createdAt", new Date().toISOString());
    const cookie = (await storage.commitSession(session)).split(";")[0];
    const env = { DB: asD1(memory), SESSION_SECRET: "test-secret", ENCRYPTION_KEY: "key" };

    let thrown: unknown;
    try {
      await authMiddleware(
        { request: new Request("http://localhost/dashboard", { headers: { Cookie: cookie } }), context: { cloudflare: { env }, set: vi.fn() } } as never,
        async () => new Response("reached"),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).headers.get("Location")).toBe("/signin");
    expect((thrown as Response).headers.get("Set-Cookie")).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
  });

  it("is passed over by an invite by username, which reaches the person's new account", async () => {
    const s = await seedLeaverWithCredit();
    const login = (await db.select().from(users).where(eq(users.id, s.leaver)))[0].github_login;
    await deleteAccount(s.leaver);
    const [again] = await db
      .insert(users)
      .values({
        github_id: s.githubId,
        github_login: login,
        encrypted_access_token: "enc",
        encrypted_refresh_token: "enc",
        access_token_expires_at: future(),
        refresh_token_expires_at: future(),
      })
      .returning({ id: users.id });

    activeProjectId = s.site;
    const res = await dashboardAction({
      request: post("/dashboard", { intent: "send-invite", username: login, siteId: String(s.site) }),
      context: makeContext(s.owner),
      params: {},
    } as unknown as Parameters<typeof dashboardAction>[0]);

    expect(res).toMatchObject({ ok: true, added: true });
    expect(await roleOn(s.site, again.id)).toBe("collaborator");
  });
});

/** A session cookie naming `userId`, as a browser left open would still send. */
async function cookieFor(userId: number): Promise<string> {
  const storage = createSessionStorage("test-secret");
  const session = await storage.getSession();
  session.set("userId", userId);
  session.set("createdAt", new Date().toISOString());
  return (await storage.commitSession(session)).split(";")[0];
}

function postWithCookie(path: string, fields: Record<string, string>, cookie: string) {
  return new Request(`http://localhost:5173${path}`, {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: { "content-type": "application/x-www-form-urlencoded", Cookie: cookie, Referer: "http://localhost:5173/dashboard" },
  });
}

describe("writes that name a tombstone leave it as it is", () => {
  it("a token refresh that returns after the deletion writes nothing and ends the session", async () => {
    const s = await seedLeaverWithCredit();
    // The account as the request read it, before the deletion: its token is
    // near expiry, so the refresh goes to GitHub.
    const [stale] = await db.select().from(users).where(eq(users.id, s.leaver));
    stale.access_token_expires_at = new Date(Date.now() + 60_000).toISOString();
    await deleteAccount(s.leaver);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ access_token: "a", refresh_token: "r", expires_in: 28800, refresh_token_expires_in: 15897600 }),
    );
    let thrown: unknown;
    let githubCalls = 0;
    try {
      await maybeRefreshToken(stale, { DB: asD1(memory), ENCRYPTION_KEY: "key", GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" } as never);
    } catch (e) {
      thrown = e;
    } finally {
      githubCalls = fetchSpy.mock.calls.length;
      fetchSpy.mockRestore();
    }

    expect(githubCalls).toBe(1);
    expect((thrown as Response).headers.get("Location")).toBe("/signin?reason=session_expired");
    const [row] = await db.select().from(users).where(eq(users.id, s.leaver));
    expect(row.encrypted_access_token).toBe("");
    expect(row.encrypted_refresh_token).toBe("");
    expect(new Date(row.refresh_token_expires_at).getTime()).toBe(0);
  });

  it("a language change from an old session is not stored on the tombstone", async () => {
    const s = await seedLeaverWithCredit();
    const cookie = await cookieFor(s.leaver);
    await deleteAccount(s.leaver);

    await localeAction({
      request: postWithCookie("/api/locale", { locale: "es" }, cookie),
      context: makeContext(s.leaver),
      params: {},
    } as never).catch((e: unknown) => e);

    expect((await db.select().from(users).where(eq(users.id, s.leaver)))[0].ui_locale).toBeNull();
  });

  it("a release-note acknowledgement from an old session is not stored on the tombstone", async () => {
    const s = await seedLeaverWithCredit();
    const cookie = await cookieFor(s.leaver);
    await deleteAccount(s.leaver);

    await releaseAckAction({
      request: postWithCookie("/api/release-ack", {}, cookie),
      context: makeContext(s.leaver),
      params: {},
    } as never);

    expect((await db.select().from(users).where(eq(users.id, s.leaver)))[0].last_seen_release).toBeNull();
  });

  it("an invite link opened from an old session signs the person out and joins nothing", async () => {
    const s = await seedLeaverWithCredit();
    const cookie = await cookieFor(s.leaver);
    await deleteAccount(s.leaver);

    let thrown: unknown;
    try {
      await inviteAction({
        request: postWithCookie("/invite/tok", {}, cookie),
        context: makeContext(s.leaver),
        params: { token: "tok" },
      } as never);
    } catch (e) {
      thrown = e;
    }

    expect((thrown as Response).headers.get("Location")).toBe(`/signin?returnTo=${encodeURIComponent("/invite/tok")}`);
    expect((thrown as Response).headers.get("Set-Cookie")).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
    expect(await roleOn(s.site, s.leaver)).toBeNull();
  });
});

describe("a deletion landing inside an invite-link acceptance", () => {
  it("releases the link it consumed, and signs the person out", async () => {
    const s = await seedLeaverWithCredit();
    const other = await seedProject(s.owner, "site");
    const token = crypto.randomUUID();
    await db.insert(project_invites).values({
      project_id: other,
      token,
      created_by: s.owner,
      expires_at: future(),
      conferred_role: "collaborator",
    });
    const cookie = await cookieFor(s.leaver);
    // The deletion lands between the consumption and the membership insert,
    // the one window the action's own check cannot close.
    memory.raw.exec(`
      CREATE TRIGGER test_delete_on_consume AFTER UPDATE OF used_at ON project_invites
      WHEN NEW.used_at IS NOT NULL
      BEGIN UPDATE users SET deleted_at = '2026-01-01' WHERE id = NEW.used_by; END;
    `);

    let thrown: unknown;
    try {
      await inviteAction({
        request: postWithCookie(`/invite/${token}`, {}, cookie),
        context: makeContext(s.leaver),
        params: { token },
      } as never);
    } catch (e) {
      thrown = e;
    }

    expect((thrown as Response).headers.get("Location")).toBe(`/signin?returnTo=${encodeURIComponent(`/invite/${token}`)}`);
    expect(await roleOn(other, s.leaver)).toBeNull();
    const [invite] = await db.select().from(project_invites).where(eq(project_invites.token, token));
    expect(invite).toMatchObject({ used_by: null, used_at: null });
  });
});

describe("the activity feed", () => {
  it("keeps a deleted account's name on its activity and gives no GitHub id for an avatar", async () => {
    const s = await seedLeaverWithCredit();
    const login = (await db.select().from(users).where(eq(users.id, s.leaver)))[0].github_login;
    await db.insert(activity_log).values({ project_id: s.site, actor_user_id: s.owner, verb: "edited", entity_type: "step" });
    await deleteAccount(s.leaver);

    const rows = await getRecentActivity(db as never, s.site, 10);
    const leaverRow = rows.find((r) => r.actor_user_id === s.leaver);
    const ownerRow = rows.find((r) => r.actor_user_id === s.owner);
    expect(leaverRow).toMatchObject({ actor_github_login: login, actor_github_id: null });
    const ownerGithubId = (await db.select({ g: users.github_id }).from(users).where(eq(users.id, s.owner)))[0].g;
    expect(ownerRow?.actor_github_id).toBe(ownerGithubId);
  });
});
