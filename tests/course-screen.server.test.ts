/**
 * The /course management screen's server half, run against a real D1 (via
 * `createMemoryD1`) so what is asserted is the rows the loader actually
 * returns rather than the shape of a statement.
 *
 * Four refusals and one reachability claim carry this screen.
 *
 * The refusals are the password (ruling 20 — running a course takes it),
 * an active project that is not a course, a caller with no standing on the
 * course, and a caller whose standing is only a collaborator row. All four
 * answer 403, and the password is asserted to be answered BEFORE standing
 * is looked up: a caller without it must not learn whether the session's
 * project is a course.
 *
 * The reachability claim is the screen's reason for existing. A
 * co-instructor's child sites are suppressed from every project list
 * (rulings 18 and 25), so the fixture puts the caller in exactly that
 * state — an `instructor` row on a child with a parent, which
 * `isSuppressedFromProjectLists` is asserted to suppress — and the loader
 * is then required to list that same child. A fixture that gave the
 * co-instructor a listable row would make the test pass whatever the
 * loader did, which is why the suppression is established rather than
 * assumed.
 *
 * What an instructor may see is asserted negatively as well as positively:
 * no staff list, and no instructor-role code token. The token IS the power
 * to admit staff, so withholding the revoke button would not be enough
 * (ruling 9).
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import * as schema from "~/db/schema";
import {
  users,
  projects,
  project_config,
  project_members,
  project_invites,
} from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

// ---------------------------------------------------------------------------
// Session + auth mocks
// ---------------------------------------------------------------------------

const session = vi.hoisted(() => ({
  activeProjectId: undefined as number | undefined,
}));

vi.mock("~/middleware/auth.server", () => ({
  authMiddleware: vi.fn(),
  userContext: Symbol("userContext"),
}));

vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({
      get: vi.fn((key: string) => {
        if (key === "activeProjectId") return session.activeProjectId;
        return undefined;
      }),
      set: vi.fn(),
    })),
    commitSession: vi.fn(async () => "cookie"),
  })),
}));

import { loader, action } from "~/routes/_app.course";
import { isSuppressedFromProjectLists } from "~/lib/membership.server";
import { listCourseChildren } from "~/lib/course-membership.server";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;
let doCalls: Array<{ path: string; body: Record<string, unknown> | null }>;

const HOUR = 60 * 60 * 1000;
const future = () => new Date(Date.now() + 30 * 24 * HOUR).toISOString();

let nextUser = 0;
async function seedUser(login?: string, courseAccess = true): Promise<number> {
  nextUser += 1;
  const rows = await db
    .insert(users)
    .values({
      github_id: 5000 + nextUser,
      github_login: login ?? `user${nextUser}`,
      github_name: null,
      encrypted_access_token: "enc",
      encrypted_refresh_token: "enc",
      access_token_expires_at: future(),
      refresh_token_expires_at: future(),
      course_access: courseAccess,
    })
    .returning({ id: users.id });
  return rows[0].id;
}

let nextRepo = 0;
async function seedProject(
  ownerId: number,
  options: { kind?: "site" | "course"; parent?: number | null; title?: string } = {},
): Promise<number> {
  nextRepo += 1;
  const rows = await db
    .insert(projects)
    .values({
      user_id: ownerId,
      github_repo_full_name: `owner/repo${nextRepo}`,
      installation_id: 1,
      kind: options.kind ?? "site",
      parent_project_id: options.parent ?? null,
    })
    .returning({ id: projects.id });
  const projectId = rows[0].id;
  await db.insert(project_members).values({
    project_id: projectId,
    user_id: ownerId,
    role: "convenor",
    joined_at: new Date().toISOString(),
  });
  if (options.title !== undefined) {
    await db.insert(project_config).values({ project_id: projectId, title: options.title });
  }
  return projectId;
}

async function addMember(
  projectId: number,
  userId: number,
  role: "convenor" | "collaborator" | "instructor",
): Promise<void> {
  await db.insert(project_members).values({
    project_id: projectId,
    user_id: userId,
    role,
    joined_at: new Date().toISOString(),
  });
}

async function seedCode(
  projectId: number,
  options: {
    role?: "collaborator" | "instructor";
    label?: string | null;
    expiresAt?: string | null;
    revoked?: boolean;
  } = {},
): Promise<{ id: number; token: string }> {
  const token = `CODE${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const rows = await db
    .insert(project_invites)
    .values({
      project_id: projectId,
      token,
      conferred_role: options.role ?? "collaborator",
      label: options.label ?? null,
      expires_at: options.expiresAt ?? null,
      revoked_at: options.revoked ? new Date().toISOString() : null,
    })
    .returning({ id: project_invites.id });
  return { id: rows[0].id, token };
}

/** The Cloudflare env the route sees, with a recording COLLABORATION stub. */
function makeEnv() {
  return {
    DB: asD1(memory),
    SESSION_SECRET: "test-secret",
    ENCRYPTION_KEY: "k",
    COLLABORATION: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          const raw = await req.text();
          doCalls.push({
            path: url.pathname,
            body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
          });
          if (url.pathname === "/clear-course-markers") {
            return Response.json({ cleared: 1 });
          }
          return new Response("OK", { status: 200 });
        },
      }),
    },
  };
}

function loaderArgs(userId: number, courseAccess = true) {
  return {
    request: new Request("https://compositor.telar.org/course"),
    context: {
      // The row the auth middleware loads, which now carries the access flag.
      get: vi.fn(() => ({ id: userId, encrypted_access_token: "enc", course_access: courseAccess })),
      cloudflare: { env: makeEnv() },
    },
    params: {},
  } as never;
}

function actionArgs(userId: number, fields: Record<string, string>, courseAccess = true) {
  const form = new URLSearchParams();
  // The page-site comparison reads the caller's own resolved active project,
  // which is the session's activeProjectId only when the caller actually has
  // standing there; a caller without it resolves to their own first project
  // instead (resolveActiveProject's fallback). Most callers below share the
  // session's course, so this default holds; a caller who does not must pass
  // its own resolved siteId through `fields`.
  form.set("siteId", String(session.activeProjectId));
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return {
    request: new Request("https://compositor.telar.org/course", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
    context: {
      get: vi.fn(() => ({ id: userId, encrypted_access_token: "enc", course_access: courseAccess })),
      cloudflare: { env: makeEnv() },
    },
    params: {},
  } as never;
}

type LoaderData = Awaited<ReturnType<typeof loader>>;

beforeEach(() => {
  memory = createMemoryD1();
  db = drizzle(asD1(memory), { schema });
  doCalls = [];
  session.activeProjectId = undefined;
  vi.clearAllMocks();
});

afterEach(() => {
  memory.close();
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe("the screen is refused to someone without course access", () => {
  it("answers 403 for a person the flag was never granted to", async () => {
    const convenor = await seedUser(undefined, false);
    const course = await seedProject(convenor, { kind: "course" });
    session.activeProjectId = course;

    await expect(loader(loaderArgs(convenor, false))).rejects.toMatchObject({ status: 403 });
  });

  it("refuses before standing is looked up", async () => {
    const convenor = await seedUser(undefined, false);
    const course = await seedProject(convenor, { kind: "course" });
    session.activeProjectId = course;

    const spy = vi.spyOn(
      await import("~/lib/membership.server"),
      "requireCourseCodeManager",
    );
    await expect(loader(loaderArgs(convenor, false))).rejects.toMatchObject({ status: 403 });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("refuses the remove-site action too", async () => {
    const convenor = await seedUser(undefined, false);
    const course = await seedProject(convenor, { kind: "course" });
    const child = await seedProject(await seedUser(), { parent: course });
    session.activeProjectId = course;

    await expect(
      action(actionArgs(convenor, { intent: "remove-site", projectId: String(child) }, false)),
    ).rejects.toMatchObject({ status: 403 });
    expect(doCalls).toEqual([]);
    expect(await listCourseChildren(db, course)).toEqual([child]);
  });
});

// ---------------------------------------------------------------------------
// Who may open it
// ---------------------------------------------------------------------------

describe("who the screen admits", () => {
  it("refuses a non-member", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    const outsider = await seedUser();
    // The outsider's own project is what a real session would hold; the
    // course id is planted so the refusal is about standing, not resolution.
    await seedProject(outsider);
    session.activeProjectId = course;

    await expect(loader(loaderArgs(outsider))).rejects.toMatchObject({ status: 403 });
  });

  it("refuses a collaborator row on the course", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    const student = await seedUser();
    await addMember(course, student, "collaborator");
    session.activeProjectId = course;

    await expect(loader(loaderArgs(student))).rejects.toMatchObject({ status: 403 });
  });

  it("refuses when the active project is an ordinary site", async () => {
    const convenor = await seedUser();
    const site = await seedProject(convenor, { kind: "site" });
    session.activeProjectId = site;

    await expect(loader(loaderArgs(convenor))).rejects.toMatchObject({ status: 403 });
  });

  it("runs the course when the active project is one of its children", async () => {
    // The screen's own click-through posts `switch-project`, so a convenor who
    // opens a site from it comes back with the CHILD active. Asking to run a
    // course on a project that is not one used to 403 — a one-way door out of
    // the only screen a course is run from.
    const convenor = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    const child = await seedProject(convenor, { kind: "site", parent: course });
    session.activeProjectId = child;

    const result = (await loader(loaderArgs(convenor))) as LoaderData;
    expect(result.role).toBe("convenor");
  });

  it("admits an instructor of the course through a child, on the course's standing", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    const ta = await seedUser();
    await addMember(course, ta, "instructor");
    const child = await seedProject(convenor, { kind: "site", parent: course });
    session.activeProjectId = child;

    expect(((await loader(loaderArgs(ta))) as LoaderData).role).toBe("instructor");
  });

  it("still refuses someone who holds a child but no standing on the course", async () => {
    // Walking up `parent_project_id` resolves WHICH course is being asked
    // about; it confers nothing. A student on a child is still a student.
    const convenor = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    const child = await seedProject(convenor, { kind: "site", parent: course });
    const student = await seedUser();
    await addMember(child, student, "collaborator");
    session.activeProjectId = child;

    await expect(loader(loaderArgs(student))).rejects.toMatchObject({ status: 403 });
  });

  it("admits the convenor and an instructor member alike", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    const ta = await seedUser();
    await addMember(course, ta, "instructor");
    session.activeProjectId = course;

    expect(((await loader(loaderArgs(convenor))) as LoaderData).role).toBe("convenor");
    expect(((await loader(loaderArgs(ta))) as LoaderData).role).toBe("instructor");
  });
});

// ---------------------------------------------------------------------------
// What a convenor sees
// ---------------------------------------------------------------------------

describe("a convenor sees the roster, the children and the codes", () => {
  it("lists every child with its members and every code", async () => {
    const convenor = await seedUser("prof");
    const course = await seedProject(convenor, { kind: "course", title: "History 101" });

    const groupConvenor = await seedUser("ana");
    const groupMember = await seedUser("carlos");
    const childA = await seedProject(groupConvenor, {
      parent: course,
      title: "Group A",
    });
    await addMember(childA, groupMember, "collaborator");
    await addMember(childA, convenor, "instructor");

    const childB = await seedProject(await seedUser("dora"), { parent: course });

    // A site belonging to no course, and a site belonging to ANOTHER
    // course: neither may appear.
    await seedProject(await seedUser());
    const otherCourse = await seedProject(await seedUser(), { kind: "course" });
    await seedProject(await seedUser(), { parent: otherCourse });

    const classCode = await seedCode(course, { label: "Section B" });
    const staffCode = await seedCode(course, { role: "instructor" });
    // A code on another course must not leak into this screen.
    await seedCode(otherCourse);

    session.activeProjectId = course;
    const data = (await loader(loaderArgs(convenor))) as LoaderData;

    expect(data.course.title).toBe("History 101");
    expect(data.children.map((c) => c.id).sort()).toEqual([childA, childB].sort());

    const a = data.children.find((c) => c.id === childA)!;
    expect(a.title).toBe("Group A");
    expect(
      a.members.map((m) => `${m.name}:${m.role}`).sort(),
    ).toEqual(["ana:convenor", "carlos:collaborator", "prof:instructor"]);

    expect(data.codes.map((c) => c.token).sort()).toEqual(
      [classCode.token, staffCode.token].sort(),
    );
    expect(data.codes.find((c) => c.token === classCode.token)).toMatchObject({
      label: "Section B",
      role: "collaborator",
      revokedAt: null,
    });
  });

  it("falls back to the repo name when a child has no configured title", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    const child = await seedProject(await seedUser(), { parent: course });
    session.activeProjectId = course;

    const data = (await loader(loaderArgs(convenor))) as LoaderData;
    expect(data.children[0].title).toBe(data.children[0].repo);
    expect(data.children[0].repo).toMatch(/^owner\/repo/);
  });

  it("carries a revoked code with its revocation, rather than dropping it", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    const dead = await seedCode(course, { revoked: true });
    session.activeProjectId = course;

    const data = (await loader(loaderArgs(convenor))) as LoaderData;
    const row = data.codes.find((c) => c.token === dead.token);
    expect(row).toBeDefined();
    expect(row!.revokedAt).not.toBeNull();
  });

  it("shows the staff list — the convenor and the instructor members, no one else", async () => {
    const convenor = await seedUser("prof");
    const course = await seedProject(convenor, { kind: "course" });
    const ta = await seedUser("ta");
    await addMember(course, ta, "instructor");
    // A collaborator row on a course project is an anomaly, not standing:
    // it must not appear as staff.
    const stray = await seedUser("stray");
    await addMember(course, stray, "collaborator");
    session.activeProjectId = course;

    const data = (await loader(loaderArgs(convenor))) as LoaderData;
    expect(data.staff).not.toBeNull();
    expect(data.staff!.map((s) => `${s.name}:${s.role}`).sort()).toEqual([
      "prof:convenor",
      "ta:instructor",
    ]);
  });

  it("returns no children and no codes on a course with neither", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    session.activeProjectId = course;

    const data = (await loader(loaderArgs(convenor))) as LoaderData;
    expect(data.children).toEqual([]);
    expect(data.codes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// What an instructor sees, and does not
// ---------------------------------------------------------------------------

describe("an instructor sees what ruling 9 allows and not more", () => {
  async function seedCoInstructorCourse() {
    const convenor = await seedUser("prof");
    const course = await seedProject(convenor, { kind: "course" });
    const ta = await seedUser("ta");
    await addMember(course, ta, "instructor");

    const child = await seedProject(await seedUser("ana"), { parent: course });
    await addMember(child, ta, "instructor");

    const classCode = await seedCode(course, { role: "collaborator" });
    const staffCode = await seedCode(course, { role: "instructor" });
    session.activeProjectId = course;
    return { convenor, course, ta, child, classCode, staffCode };
  }

  it("withholds the staff list", async () => {
    const { ta } = await seedCoInstructorCourse();
    const data = (await loader(loaderArgs(ta))) as LoaderData;
    expect(data.staff).toBeNull();
  });

  it("withholds the instructor-role code, token and all", async () => {
    const { ta, classCode, staffCode } = await seedCoInstructorCourse();
    const data = (await loader(loaderArgs(ta))) as LoaderData;

    expect(data.codes.map((c) => c.token)).toEqual([classCode.token]);
    expect(JSON.stringify(data)).not.toContain(staffCode.token);
  });

  it("still shows the class codes and the children", async () => {
    const { ta, child, classCode } = await seedCoInstructorCourse();
    const data = (await loader(loaderArgs(ta))) as LoaderData;

    expect(data.children.map((c) => c.id)).toEqual([child]);
    expect(data.codes.map((c) => c.token)).toEqual([classCode.token]);
  });
});

// ---------------------------------------------------------------------------
// Reachability — the screen's reason for existing
// ---------------------------------------------------------------------------

describe("a suppressed child is reachable from here", () => {
  it("lists a child the co-instructor's own project lists must hide", async () => {
    const convenor = await seedUser("prof");
    const course = await seedProject(convenor, { kind: "course" });
    const ta = await seedUser("ta");
    await addMember(course, ta, "instructor");

    const child = await seedProject(await seedUser("ana"), { parent: course });
    await addMember(child, ta, "instructor");
    session.activeProjectId = course;

    // The precondition, established rather than assumed: this is exactly
    // the pair ruling 25 suppresses, and the course itself is not.
    expect(
      isSuppressedFromProjectLists({ userRole: "instructor", parent_project_id: course }),
    ).toBe(true);
    expect(
      isSuppressedFromProjectLists({ userRole: "instructor", parent_project_id: null }),
    ).toBe(false);

    const data = (await loader(loaderArgs(ta))) as LoaderData;
    expect(data.children.map((c) => c.id)).toEqual([child]);
  });
});

// ---------------------------------------------------------------------------
// Removing a site
// ---------------------------------------------------------------------------

describe("remove-site", () => {
  it("detaches the child and clears its course markers", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    const child = await seedProject(await seedUser(), { parent: course });
    await addMember(child, convenor, "instructor");
    session.activeProjectId = course;

    const result = (await action(
      actionArgs(convenor, { intent: "remove-site", projectId: String(child) }),
    )) as { ok: boolean; detached: boolean };

    expect(result).toMatchObject({ ok: true, detached: true });
    expect(doCalls.map((c) => c.path)).toContain("/clear-course-markers");
    expect(await listCourseChildren(db, course)).toEqual([]);

    const rows = await db.select().from(project_members);
    expect(rows.some((r) => r.project_id === child && r.role === "instructor")).toBe(false);
  });

  it("is open to an instructor member, per ruling 9", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    const ta = await seedUser();
    await addMember(course, ta, "instructor");
    const child = await seedProject(await seedUser(), { parent: course });
    session.activeProjectId = course;

    const result = (await action(
      actionArgs(ta, { intent: "remove-site", projectId: String(child) }),
    )) as { ok: boolean; detached: boolean };
    expect(result.detached).toBe(true);
  });

  it("refuses a caller with no standing on the course", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    const child = await seedProject(await seedUser(), { parent: course });
    const outsider = await seedUser();
    // The outsider has no membership on `course`, so their own resolved
    // active project falls back to this one, not the session's course.
    const outsiderSite = await seedProject(outsider);
    session.activeProjectId = course;

    await expect(
      action(
        actionArgs(outsider, {
          intent: "remove-site",
          projectId: String(child),
          siteId: String(outsiderSite),
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(await listCourseChildren(db, course)).toEqual([child]);
  });

  it("leaves another course's child untouched", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    const rival = await seedProject(await seedUser(), { kind: "course" });
    const theirChild = await seedProject(await seedUser(), { parent: rival });
    session.activeProjectId = course;

    const result = (await action(
      actionArgs(convenor, { intent: "remove-site", projectId: String(theirChild) }),
    )) as { ok: boolean; detached: boolean };

    expect(result.detached).toBe(false);
    expect(doCalls).toEqual([]);
    expect(await listCourseChildren(db, rival)).toEqual([theirChild]);
  });

  it("refuses a project id that is not a positive integer, without a DO call", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    session.activeProjectId = course;

    for (const projectId of ["", "0", "-3", "1.5", "abc", "9e99999"]) {
      const result = (await action(
        actionArgs(convenor, { intent: "remove-site", projectId }),
      )) as { ok: boolean; error?: string };
      expect(result).toMatchObject({ ok: false, error: "missing_project_id" });
    }
    expect(doCalls).toEqual([]);
  });

  it("ignores an unrecognised intent without touching the course", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    const child = await seedProject(await seedUser(), { parent: course });
    session.activeProjectId = course;

    const result = (await action(
      actionArgs(convenor, { intent: "detach-everything", projectId: String(child) }),
    )) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(await listCourseChildren(db, course)).toEqual([child]);
  });
});

// ---------------------------------------------------------------------------
// The gate helper the screen leans on
// ---------------------------------------------------------------------------

describe("the standing check is the shared one", () => {
  it("is requireCourseCodeManager, asked about a class code", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    session.activeProjectId = course;

    const spy = vi.spyOn(
      await import("~/lib/membership.server"),
      "requireCourseCodeManager",
    );
    await loader(loaderArgs(convenor));
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      course,
      convenor,
      "collaborator",
    );
    spy.mockRestore();
  });
});
