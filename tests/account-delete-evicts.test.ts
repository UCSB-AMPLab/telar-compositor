/**
 * Deleting an account closes the person's live sockets.
 *
 * The Durable Object caches each socket's role at connect time and never
 * re-reads membership per message, so a membership deleted underneath a live
 * socket goes on editing until something closes it. Account deletion deleted
 * every membership and closed nothing: a tab left open elsewhere kept editing
 * every project the account belonged to. These cases delete an account against
 * the migration chain in memory and read back every Durable Object request.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";

import * as schema from "~/db/schema";
import { users, projects, project_members, member_editing_time } from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;
/** The project the session names, for the dashboard action. */
let activeProjectId = 0;

vi.mock("~/lib/crypto.server", () => ({ decrypt: async () => "user-token", encrypt: async () => "enc" }));
vi.mock("~/lib/github.server", () => ({
  listUserInstallations: vi.fn(async () => []),
}));
vi.mock("~/lib/github-app.server", () => ({ getInstallationToken: vi.fn(async () => "iat") }));
vi.mock("~/lib/repo-access.server", () => ({
  accountLogin: vi.fn(async (_t: string, id: number) => `login-${id}`),
  listRepoInvitations: vi.fn(async () => []),
  memberPermission: vi.fn(async () => "write"),
  removeCollaborator: vi.fn(async () => undefined),
  deleteInvitation: vi.fn(async () => undefined),
  addCollaborator: vi.fn(),
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
import { removeCollaborator } from "~/lib/repo-access.server";
import { refreshTeamAccess } from "~/lib/team-access.server";
import { action as onboardingAction } from "~/routes/onboarding";
import { userContext } from "~/middleware/auth.server";
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
    gh_add_state: "sent",
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

beforeEach(() => {
  memory = createMemoryD1();
  db = drizzle(asD1(memory), { schema });
  doCalls = [];
  duringDoCall = null;
  markerClearFails = false;
});

describe("deleting an account", () => {
  it("closes the person's sockets on every project they belonged to, and every socket on their own", async () => {
    const leaver = await seedUser();
    const own = await seedProject(leaver, "site");
    const owner = await seedUser();
    const joinedA = await seedProject(owner, "site");
    const joinedB = await seedProject(owner, "site");
    await addMember(joinedA, leaver, "collaborator");
    await addMember(joinedB, leaver, "collaborator");

    await deleteAccount(leaver);

    expect((await db.select().from(users).where(eq(users.id, leaver)))[0].deleted_at).not.toBeNull();
    // Their own site is gone, so everyone on it is told.
    expect(doCalls).toContain(`${own}:/notify-deleted:null`);
    // On the others only they are closed.
    expect(doCalls).toContain(`${joinedA}:/notify-deleted:${leaver}`);
    expect(doCalls).toContain(`${joinedB}:/notify-deleted:${leaver}`);
    expect(doCalls).not.toContain(`${joinedA}:/notify-deleted:null`);
    expect(doCalls).not.toContain(`${own}:/notify-deleted:${leaver}`);
  });

  it("evicts from a membership added while the deletion ran, before its batch", async () => {
    const leaver = await seedUser();
    const owner = await seedUser();
    // The leaver's own course has a site attached, so detaching it asks that
    // site's object to clear its markers: a request before the batch, during
    // which a redemption lands and adds a membership the batch deletes.
    const course = await seedProject(leaver, "course");
    const child = await seedProject(owner, "site", course);
    const late = await seedProject(owner, "site");
    let added = false;
    duringDoCall = async () => {
      if (added) return;
      added = true;
      await addMember(late, leaver, "collaborator");
    };

    await deleteAccount(leaver);

    expect(doCalls[0]).toBe(`${child}:/clear-course-markers:null`);
    expect(await roleOn(late, leaver)).toBeNull();
    expect(doCalls).toContain(`${late}:/notify-deleted:${leaver}`);
  });

  it("records a withdrawal of repository access for every membership the deletion ends", async () => {
    const leaver = await seedUser();
    const owner = await seedUser();
    const joinedA = await seedProject(owner, "site");
    const joinedB = await seedProject(owner, "site");
    await addMember(joinedA, leaver, "collaborator");
    await addMember(joinedB, leaver, "collaborator");
    const githubId = (await db.select().from(users).where(eq(users.id, leaver)))[0].github_id;

    await deleteAccount(leaver);

    const recorded = memory.raw
      .prepare("SELECT project_id, user_id, github_id FROM repo_access_withdrawals ORDER BY project_id")
      .all() as Array<{ project_id: number; user_id: number; github_id: number }>;
    expect(recorded).toEqual([
      { project_id: joinedA, user_id: leaver, github_id: githubId },
      { project_id: joinedB, user_id: leaver, github_id: githubId },
    ]);
  });

  it("withdraws the deleted account's repository access through the reconciler, under the id it had", async () => {
    const leaver = await seedUser();
    const owner = await seedUser();
    const joined = await seedProject(owner, "site");
    await addMember(joined, leaver, "collaborator");
    const githubId = (await db.select().from(users).where(eq(users.id, leaver)))[0].github_id;
    await deleteAccount(leaver);

    const project = (await db.select().from(projects).where(eq(projects.id, joined)))[0];
    const env = { GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "k", GITHUB_APP_SLUG: "telar-compositor" };
    await refreshTeamAccess(env, db, project, Date.now());

    expect(removeCollaborator).toHaveBeenCalledWith("iat", "owner", `repo${nextRepo}`, `login-${githubId}`, expect.any(AbortSignal));
    expect(memory.raw.prepare("SELECT COUNT(*) AS n FROM repo_access_withdrawals").get()).toEqual({ n: 0 });
  });

  it("records no withdrawal for a membership from before the release", async () => {
    const leaver = await seedUser();
    const owner = await seedUser();
    const joined = await seedProject(owner, "site");
    await addMember(joined, leaver, "collaborator");
    memory.raw.exec(`UPDATE project_members SET gh_add_owed = 0 WHERE user_id = ${leaver}`);
    await deleteAccount(leaver);
    expect(memory.raw.prepare("SELECT COUNT(*) AS n FROM repo_access_withdrawals").get()).toEqual({ n: 0 });
  });

  it("completes even when the Durable Objects cannot be reached", async () => {
    const leaver = await seedUser();
    const owner = await seedUser();
    const joined = await seedProject(owner, "site");
    await addMember(joined, leaver, "collaborator");
    duringDoCall = async () => {
      throw new Error("unreachable");
    };

    await deleteAccount(leaver);

    expect((await db.select().from(users).where(eq(users.id, leaver)))[0].deleted_at).not.toBeNull();
    expect(await roleOn(joined, leaver)).toBeNull();
  });
});
