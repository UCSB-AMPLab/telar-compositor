/**
 * Leaving a course's staff ends the standing it copied onto every child
 *.
 *
 * A course's staff are copied down: joining writes an `instructor` row on
 * every child site. The two single-row exits — a convenor removing a member
 * from the course's own list, and the person leaving from their account page
 * — each deleted one row, the course's, and left the copies. The person was
 * off the course's staff list and still held instructor standing, with live
 * sockets, on every group's work. `fanOutStaffDeparture` is the reverse of the
 * join and had no caller.
 *
 * This suite drives both route actions against the repository's own
 * migration chain in memory, so what it reads back is rows, and records every
 * Durable Object request, so the evictions are read back too. The subject is
 * the wiring: a test of the fan-out function was green throughout and could
 * not see that nothing called it.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";

import * as schema from "~/db/schema";
import { users, projects, project_members } from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;
/** The project the session names, for the dashboard action. */
let activeProjectId = 0;

vi.mock("~/lib/github.server", () => ({
  listUserInstallations: vi.fn(async () => []),
}));
vi.mock("~/lib/db.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/db.server")>();
  return { ...actual, getDb: () => db };
});
// resolvePageProject is reimplemented against resolveActiveProjectFromRequest
// rather than taken from `actual`: the real resolvePageProject's internal call
// to resolveActiveProjectFromRequest binds to the real module's own function,
// not to the override below, so spreading `actual.resolvePageProject` in
// would silently run the unmocked, session-cookie-reading path instead of
// this file's activeProjectId fixture. siteChangedAnswer has no such internal
// call, so the real one is kept.
vi.mock("~/lib/active-project.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/active-project.server")>();
  const resolveActiveProjectFromRequest = async (_req: Request, _env: unknown, userId: number) => {
    const rows = await db.select().from(projects).where(eq(projects.id, activeProjectId));
    const role = await roleOn(activeProjectId, userId);
    return rows[0] && role ? { project: rows[0], userRole: role } : null;
  };
  return {
    resolveActiveProjectFromRequest,
    siteChangedAnswer: actual.siteChangedAnswer,
    resolvePageProject: async (
      request: Request,
      env: unknown,
      userId: number,
      formData: FormData,
    ) => {
      const resolved = await resolveActiveProjectFromRequest(request, env, userId);
      if (!resolved) return { kind: "no_project" as const };
      if (formData.get("siteId") !== String(resolved.project.id)) {
        return {
          kind: "site_changed" as const,
          currentSiteName: resolved.project.github_repo_full_name,
        };
      }
      return { kind: "ok" as const, ...resolved };
    },
  };
});

import { action as accountAction } from "~/routes/_app.account";
import { action as dashboardAction } from "~/routes/_app.dashboard";
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

async function removeMember(convenorId: number, courseId: number, targetId: number) {
  activeProjectId = courseId;
  return dashboardAction({
    request: post("/dashboard", {
      intent: "remove-member",
      userId: String(targetId),
      siteId: String(courseId),
    }),
    context: makeContext(convenorId),
    params: {},
  } as unknown as Parameters<typeof dashboardAction>[0]);
}

async function leaveProject(userId: number, projectId: number) {
  return accountAction({
    request: post("/account", { intent: "leave-project", projectId: String(projectId) }),
    context: makeContext(userId),
    params: {},
  } as unknown as Parameters<typeof accountAction>[0]);
}

/**
 * A course with a convenor, a TA copied onto two group sites, a third group
 * site on which the TA ALSO collaborates in their own right, and a site
 * outside the course the TA convenes.
 */
async function seedCourse() {
  const convenor = await seedUser();
  const course = await seedProject(convenor, "course");
  const ta = await seedUser();
  await addMember(course, ta, "instructor");

  const groupOwner = await seedUser();
  const childA = await seedProject(groupOwner, "site", course);
  const childB = await seedProject(groupOwner, "site", course);
  const childOwnRow = await seedProject(groupOwner, "site", course);
  await addMember(childA, ta, "instructor");
  await addMember(childB, ta, "instructor");
  await addMember(childOwnRow, ta, "collaborator");

  const tasOwnSite = await seedProject(ta, "site", null);

  return { convenor, course, ta, childA, childB, childOwnRow, tasOwnSite };
}

beforeEach(() => {
  memory = createMemoryD1();
  db = drizzle(asD1(memory), { schema });
  nextUser = 0;
  nextRepo = 0;
  doCalls = [];
  duringDoCall = null;
});

describe("a convenor removes a member of the course's staff", () => {
  it("ends the instructor rows the course copied onto its children", async () => {
    const c = await seedCourse();

    const result = (await removeMember(c.convenor, c.course, c.ta)) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(await roleOn(c.course, c.ta)).toBeNull();
    expect(await roleOn(c.childA, c.ta)).toBeNull();
    expect(await roleOn(c.childB, c.ta)).toBeNull();
  });

  it("leaves the person's own memberships alone", async () => {
    // Role-qualified: a TA who collaborates on one group's site in their own
    // right keeps that row, and a site they convene is nobody's to touch.
    const c = await seedCourse();

    await removeMember(c.convenor, c.course, c.ta);

    expect(await roleOn(c.childOwnRow, c.ta)).toBe("collaborator");
    expect(await roleOn(c.tasOwnSite, c.ta)).toBe("convenor");
  });

  it("closes the person's sockets on each child a row left", async () => {
    const c = await seedCourse();

    await removeMember(c.convenor, c.course, c.ta);

    const evictions = doCalls.filter((call) => call.endsWith(`:${c.ta}`));
    expect(evictions).toEqual(
      expect.arrayContaining([
        `${c.childA}:/notify-deleted:${c.ta}`,
        `${c.childB}:/notify-deleted:${c.ta}`,
        `${c.course}:/notify-deleted:${c.ta}`,
      ]),
    );
    // Not on a child where the person kept a row of their own.
    expect(evictions.some((call) => call.startsWith(`${c.childOwnRow}:`))).toBe(false);
  });
});

describe("a member of the course's staff leaves from their account page", () => {
  it("takes the copies with the course row", async () => {
    const c = await seedCourse();

    const result = (await leaveProject(c.ta, c.course)) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(await roleOn(c.course, c.ta)).toBeNull();
    expect(await roleOn(c.childA, c.ta)).toBeNull();
    expect(await roleOn(c.childB, c.ta)).toBeNull();
    expect(await roleOn(c.childOwnRow, c.ta)).toBe("collaborator");
  });
});

describe("the course's own convenor leaves it", () => {
  it("takes the instructor copies the convenor's standing put on each child", async () => {
    // copyStaffToChild copies the course's convenor down as well as its
    // instructors, and a member may leave from the account page whatever
    // their role — so this exit reaches the same copies.
    const c = await seedCourse();
    await addMember(c.childA, c.convenor, "instructor");

    await leaveProject(c.convenor, c.course);

    expect(await roleOn(c.course, c.convenor)).toBeNull();
    expect(await roleOn(c.childA, c.convenor)).toBeNull();
    // The TA's standing is theirs, not the convenor's.
    expect(await roleOn(c.childA, c.ta)).toBe("instructor");
  });
});

describe("the two deletions are one", () => {
  it("gives a copy-down that lands during the evictions nothing to copy", async () => {
    // The course row is what authorises a copy: while it exists, a staff
    // join or a child enrolling writes the instructor row straight back. The
    // evictions are the longest await in the exit, so a copy-down is run
    // inside each of them. With the course row still standing at that point
    // it would restore a child row; gone in the same batch as the copies, it
    // leaves nothing to restore.
    const c = await seedCourse();
    const { fanOutStaffJoin } = await import("~/lib/course-membership.server");
    duringDoCall = async () => {
      await fanOutStaffJoin(db, { courseProjectId: c.course, userId: c.ta });
    };

    await removeMember(c.convenor, c.course, c.ta);

    expect(await roleOn(c.childA, c.ta)).toBeNull();
    expect(await roleOn(c.childB, c.ta)).toBeNull();
  });
});

describe("exits that are not a course's staff", () => {
  it("removing a collaborator from an ordinary site touches nothing else", async () => {
    const owner = await seedUser();
    const site = await seedProject(owner, "site", null);
    const other = await seedProject(owner, "site", null);
    const person = await seedUser();
    await addMember(site, person, "collaborator");
    await addMember(other, person, "collaborator");

    activeProjectId = site;
    await dashboardAction({
      request: post("/dashboard", {
        intent: "remove-member",
        userId: String(person),
        siteId: String(site),
      }),
      context: makeContext(owner),
      params: {},
    } as unknown as Parameters<typeof dashboardAction>[0]);

    expect(await roleOn(site, person)).toBeNull();
    expect(await roleOn(other, person)).toBe("collaborator");
    expect(doCalls).toEqual([`${site}:/notify-deleted:${person}`]);
  });
});
