/**
 * Deleting a course detaches its sites first.
 *
 * Every project delete ends with the `projects` row, and a child's parent link
 * then falls to null through the foreign key without the leave sequence ever
 * running: the staff kept instructor standing on every group site, and the
 * course markers stayed on the children's objects with no course left to clear
 * them. These cases delete a course through each route that can, against the
 * repository's own migration chain in memory, and read back the children's
 * rows and every Durable Object request.
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

/** A course with a TA, two group sites the TA was copied onto, and a site outside it. */
async function seedCourse() {
  const convenor = await seedUser();
  const course = await seedProject(convenor, "course");
  const ta = await seedUser();
  await addMember(course, ta, "instructor");

  const groupOwner = await seedUser();
  const childA = await seedProject(groupOwner, "site", course);
  const childB = await seedProject(groupOwner, "site", course);
  await addMember(childA, ta, "instructor");
  await addMember(childA, convenor, "instructor");
  await addMember(childB, ta, "instructor");
  await addMember(childB, convenor, "instructor");
  const outside = await seedProject(groupOwner, "site", null);
  return { convenor, course, ta, groupOwner, childA, childB, outside };
}

async function parentOf(projectId: number) {
  return (await db.select({ p: projects.parent_project_id }).from(projects).where(eq(projects.id, projectId)))[0]?.p;
}

async function instructorsOn(projectId: number) {
  const rows = await db
    .select({ userId: project_members.user_id })
    .from(project_members)
    .where(and(eq(project_members.project_id, projectId), eq(project_members.role, "instructor")));
  return rows.map((r) => r.userId).sort();
}

beforeEach(() => {
  memory = createMemoryD1();
  db = drizzle(asD1(memory), { schema });
  doCalls = [];
  duringDoCall = null;
  markerClearFails = false;
});

describe("deleting a course", () => {
  it("detaches every site, removes the staff copies, clears the markers and evicts the staff", async () => {
    const s = await seedCourse();
    const res = await deleteProject(s.convenor, s.course);

    expect(res).toMatchObject({ ok: true });
    expect(await db.select().from(projects).where(eq(projects.id, s.course))).toEqual([]);
    for (const child of [s.childA, s.childB]) {
      expect(await parentOf(child)).toBeNull();
      expect(await instructorsOn(child)).toEqual([]);
      expect(await roleOn(child, s.groupOwner)).toBe("convenor");
      expect(doCalls).toContain(`${child}:/clear-course-markers:null`);
      expect(doCalls).toContain(`${child}:/notify-deleted:${s.ta}`);
      expect(doCalls).toContain(`${child}:/notify-deleted:${s.convenor}`);
    }
  });

  it("succeeds for a course whose members have contribution records", async () => {
    // The cascade missed these tables, whose foreign keys refused the delete.
    const s = await seedCourse();
    await db.insert(member_editing_time).values({
      project_id: s.course,
      user_id: s.ta,
      editing_seconds: 60,
      writing_seconds: 30,
    });
    expect(await deleteProject(s.convenor, s.course)).toMatchObject({ ok: true });
    expect(await db.select().from(member_editing_time)).toEqual([]);
  });

  it("is refused, with the course whole, when a site's markers cannot be cleared", async () => {
    const s = await seedCourse();
    markerClearFails = true;
    const res = await deleteProject(s.convenor, s.course);

    expect(res).toMatchObject({ ok: false, error: "detach_failed" });
    expect((await db.select().from(projects).where(eq(projects.id, s.course))).length).toBe(1);
    expect(await roleOn(s.course, s.ta)).toBe("instructor");
    // The leave sequence fails first, so the site it stopped at is still enrolled.
    expect(await parentOf(s.childA)).toBe(s.course);
  });

  it("removes, and evicts, the staff copies on a site that joined after the sites were detached", async () => {
    const s = await seedCourse();
    const lateOwner = await seedUser();
    const late = await seedProject(lateOwner, "site", null);
    // Attach a site, with a staff copy, during the last marker clear, as a
    // redemption landing between the detach loop and the cascade would.
    let clears = 0;
    duringDoCall = async () => {
      if (!doCalls.at(-1)?.endsWith("/clear-course-markers:null")) return;
      clears += 1;
      if (clears !== 2) return;
      await db.update(projects).set({ parent_project_id: s.course }).where(eq(projects.id, late));
      await addMember(late, s.ta, "instructor");
    };

    expect(await deleteProject(s.convenor, s.course)).toMatchObject({ ok: true });
    expect(await instructorsOn(late)).toEqual([]);
    expect(await roleOn(late, lateOwner)).toBe("convenor");
    expect(doCalls).toContain(`${late}:/notify-deleted:${s.ta}`);
  });

  it("leaves a course untouched when one of its sites is deleted", async () => {
    const s = await seedCourse();
    expect(await deleteProject(s.groupOwner, s.childA)).toMatchObject({ ok: true });
    expect(await roleOn(s.course, s.ta)).toBe("instructor");
    expect(await parentOf(s.childB)).toBe(s.course);
    expect(await instructorsOn(s.childB)).toEqual([s.convenor, s.ta].sort());
    expect(doCalls.some((c) => c.endsWith("/clear-course-markers:null"))).toBe(false);
  });

  it("detaches the sites when the course goes with its convenor's account", async () => {
    // The account's guard admits projects whose only other members are staff.
    const s = await seedCourse();
    await deleteAccount(s.convenor);
    expect(await db.select().from(projects).where(eq(projects.id, s.course))).toEqual([]);
    for (const child of [s.childA, s.childB]) {
      expect(await parentOf(child)).toBeNull();
      expect(await instructorsOn(child)).toEqual([]);
      // The markers are the Durable Object's to clear; only the detach asks.
      expect(doCalls).toContain(`${child}:/clear-course-markers:null`);
    }
  });

  it("detaches the sites when a course is unlinked in the wizard", async () => {
    const s = await seedCourse();
    expect(await unlinkProject(s.convenor, s.course)).toMatchObject({ ok: true });
    for (const child of [s.childA, s.childB]) {
      expect(await parentOf(child)).toBeNull();
      expect(await instructorsOn(child)).toEqual([]);
      // The markers are the Durable Object's to clear; only the detach asks.
      expect(doCalls).toContain(`${child}:/clear-course-markers:null`);
    }
  });
});
