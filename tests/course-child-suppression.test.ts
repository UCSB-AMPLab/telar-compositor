/**
 * This file pins ruling 18's suppression and ruling 22's limit on it, run
 * against a real D1 (via `createMemoryD1`) so the assertions are about the
 * rows the loaders actually return.
 *
 * An instructor is copied into every site that joins their course, so a
 * term of them buries the instructor's own work. Ruling 18 takes those
 * sites out of the header switcher, the start page's other-projects ribbon
 * and the account card. Ruling 22 stops there: they keep full access, and
 * the site the lists no longer name is still reached by `switch-project`
 * and by direct URL. That second half is the one a careless suppression
 * breaks, so it is asserted on every route the first half touches.
 *
 * The pair that suppresses is an instructor row on a child. Three rows the
 * pair does not describe are asserted to survive: the course project seen
 * by a co-instructor, a child a TA really collaborates on, and the group's
 * own site seen by the student who convenes it.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import * as schema from "~/db/schema";
import { users, projects, project_members } from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

let sessionActiveProjectId: number | undefined;

vi.mock("~/middleware/auth.server", () => ({
  authMiddleware: vi.fn(),
  userContext: Symbol("userContext"),
}));

vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({
      get: vi.fn((key: string) =>
        key === "activeProjectId" ? sessionActiveProjectId : undefined,
      ),
      set: vi.fn((_key: string, value: number) => {
        sessionActiveProjectId = value;
      }),
    })),
    commitSession: vi.fn(async () => "cookie"),
  })),
}));

vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "token") }));

vi.mock("~/lib/github.server", () => ({
  getRepoHead: vi.fn(async () => "sha"),
  checkRepoAvailability: vi.fn(async () => ({
    availability: "available" as const,
    canonicalFullName: null,
  })),
  listUserInstallations: vi.fn(async () => ({ installations: [] })),
  searchUsers: vi.fn(),
}));

vi.mock("~/lib/sync.server", () => ({
  checkRepairingLegacyIds: vi.fn(async (_env: unknown, _project: unknown, _user: unknown, run: () => Promise<unknown>) => run()),
  computeFullSyncDiff: vi.fn(async () => ({})),
  hasDivergentChanges: vi.fn(() => false),
  applyFullSync: vi.fn(),
}));

vi.mock("~/lib/upgrade.server", async (importActual) => {
  const actual = await importActual<typeof import("~/lib/upgrade.server")>();
  return { ...actual, fetchLatestRelease: vi.fn(async () => ({ tagName: "v0.0.0" })) };
});

vi.mock("~/lib/activity.server", () => ({ getRecentActivity: vi.fn(async () => []) }));

vi.mock("~/i18n/i18next.server", () => ({ getLocale: vi.fn(async () => "en") }));

import { loader as appLoader } from "~/routes/_app";
import { loader as startLoader } from "~/routes/_app.start";
import { loader as accountLoader } from "~/routes/_app.account";
import { action as dashboardAction } from "~/routes/_app.dashboard";
import { userContext } from "~/middleware/auth.server";

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;

const HOUR = 60 * 60 * 1000;
const future = () => new Date(Date.now() + 48 * HOUR).toISOString();

let nextUser = 0;
async function seedUser(): Promise<number> {
  nextUser += 1;
  const rows = await db
    .insert(users)
    .values({
      github_id: 9000 + nextUser,
      github_login: `user${nextUser}`,
      encrypted_access_token: "enc",
      encrypted_refresh_token: "enc",
      access_token_expires_at: future(),
      refresh_token_expires_at: future(),
    })
    .returning({ id: users.id });
  return rows[0].id;
}

async function seedProject(
  ownerId: number,
  opts: { name: string; kind?: "site" | "course"; parent?: number | null } = { name: "owner/site" },
): Promise<number> {
  const rows = await db
    .insert(projects)
    .values({
      user_id: ownerId,
      github_repo_full_name: opts.name,
      installation_id: 1,
      kind: opts.kind ?? "site",
      parent_project_id: opts.parent ?? null,
    })
    .returning({ id: projects.id });
  await db.insert(project_members).values({
    project_id: rows[0].id,
    user_id: ownerId,
    role: "convenor",
    joined_at: new Date().toISOString(),
  });
  return rows[0].id;
}

async function addMember(
  projectId: number,
  userId: number,
  role: "collaborator" | "instructor",
) {
  await db.insert(project_members).values({
    project_id: projectId,
    user_id: userId,
    role,
    joined_at: new Date().toISOString(),
  });
}

function makeArgs(userId: number, url: string, body?: URLSearchParams) {
  const env = {
    DB: asD1(memory),
    SESSION_SECRET: "secret",
    ENCRYPTION_KEY: "key",
    GITHUB_APP_SLUG: "app",
  };
  const request = body
    ? new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      })
    : new Request(url);
  return {
    request,
    context: {
      get: (key: unknown) =>
        key === userContext
          ? {
              id: userId,
              encrypted_access_token: "enc",
              github_id: 1,
              github_login: `user${userId}`,
              github_name: "Person",
              github_email: "p@example.com",
              last_seen_release: null,
              ui_locale: "en",
            }
          : undefined,
      cloudflare: { env },
    },
    params: {},
  } as never;
}

/**
 * One instructor, one course, and two children of it — the shape every
 * assertion below reads. The instructor convenes a site of their own so
 * the lists are never trivially empty.
 */
async function seedCourse() {
  const instructor = await seedUser();
  const ownSite = await seedProject(instructor, { name: "teacher/own-site" });
  const course = await seedProject(instructor, {
    name: "teacher/hist-101",
    kind: "course",
  });

  const studentA = await seedUser();
  const childA = await seedProject(studentA, {
    name: "student-a/group-a",
    parent: course,
  });
  await addMember(childA, instructor, "instructor");

  const studentB = await seedUser();
  const childB = await seedProject(studentB, {
    name: "student-b/group-b",
    parent: course,
  });
  await addMember(childB, instructor, "instructor");

  return { instructor, ownSite, course, studentA, childA, studentB, childB };
}

beforeEach(async () => {
  memory = createMemoryD1();
  db = drizzle(asD1(memory), { schema });
  sessionActiveProjectId = undefined;
});

afterEach(() => {
  memory.close();
});

// ---------------------------------------------------------------------------
// The header switcher
// ---------------------------------------------------------------------------

describe("_app loader — the header switcher", () => {
  it("leaves out every child an instructor holds only an instructor row on", async () => {
    const s = await seedCourse();
    sessionActiveProjectId = s.ownSite;

    const data = (await appLoader(makeArgs(s.instructor, "https://c.telar.org/objects"))) as {
      allProjects: Array<{ id: number }>;
    };
    const listed = data.allProjects.map((p) => p.id).sort();
    expect(listed).toEqual([s.ownSite, s.course].sort());
  });

  it("keeps the course itself for a co-instructor whose only row on it is an instructor row", async () => {
    const s = await seedCourse();
    const coInstructor = await seedUser();
    await addMember(s.course, coInstructor, "instructor");
    await addMember(s.childA, coInstructor, "instructor");
    sessionActiveProjectId = s.course;

    const data = (await appLoader(makeArgs(coInstructor, "https://c.telar.org/objects"))) as {
      allProjects: Array<{ id: number }>;
    };
    expect(data.allProjects.map((p) => p.id)).toEqual([s.course]);
  });

  it("keeps a child a TA really collaborates on", async () => {
    const s = await seedCourse();
    const ta = await seedUser();
    await addMember(s.childA, ta, "collaborator");
    await addMember(s.childB, ta, "instructor");
    sessionActiveProjectId = s.childA;

    const data = (await appLoader(makeArgs(ta, "https://c.telar.org/objects"))) as {
      allProjects: Array<{ id: number }>;
    };
    expect(data.allProjects.map((p) => p.id)).toEqual([s.childA]);
  });

  it("keeps the group's own site in the student's own switcher", async () => {
    const s = await seedCourse();
    sessionActiveProjectId = s.childA;

    const data = (await appLoader(makeArgs(s.studentA, "https://c.telar.org/objects"))) as {
      allProjects: Array<{ id: number }>;
    };
    expect(data.allProjects.map((p) => p.id)).toEqual([s.childA]);
  });
});

// ---------------------------------------------------------------------------
// The start page and the account card
// ---------------------------------------------------------------------------

describe("/start — the other-projects ribbon", () => {
  it("leaves out the instructor's children", async () => {
    const s = await seedCourse();
    sessionActiveProjectId = s.ownSite;

    const data = (await startLoader(makeArgs(s.instructor, "https://c.telar.org/start"))) as {
      otherProjects: Array<{ id: number }>;
    };
    expect(data.otherProjects.map((p) => p.id).sort()).toEqual([s.ownSite, s.course].sort());
  });

  it("keeps the group's own site for the student who convenes it", async () => {
    const s = await seedCourse();
    sessionActiveProjectId = s.childA;

    const data = (await startLoader(makeArgs(s.studentA, "https://c.telar.org/start"))) as {
      otherProjects: Array<{ id: number }>;
    };
    expect(data.otherProjects.map((p) => p.id)).toEqual([s.childA]);
  });
});

describe("/account — the connected-sites card", () => {
  it("leaves out the instructor's children", async () => {
    const s = await seedCourse();

    const data = (await accountLoader(makeArgs(s.instructor, "https://c.telar.org/account"))) as {
      projects: Array<{ id: number }>;
    };
    expect(data.projects.map((p) => p.id).sort()).toEqual([s.ownSite, s.course].sort());
  });

  it("leaves the account-deletion gate reading the full membership set", async () => {
    const s = await seedCourse();
    await addMember(s.ownSite, await seedUser(), "collaborator");

    const data = (await accountLoader(makeArgs(s.instructor, "https://c.telar.org/account"))) as {
      convenedProjects: Array<{ id: number }>;
      soloConvenedCount: number;
    };
    // Suppression is a listing concern; the danger zone still sees every
    // project this user convenes.
    expect(data.convenedProjects.map((p) => p.id)).toEqual([s.ownSite]);
    expect(data.soloConvenedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Ruling 22 — a suppressed site is still reachable
// ---------------------------------------------------------------------------

describe("a suppressed child keeps full access", () => {
  it("switch-project still admits it by id", async () => {
    const s = await seedCourse();
    sessionActiveProjectId = s.ownSite;

    const body = new URLSearchParams({
      intent: "switch-project",
      projectId: String(s.childA),
    });
    const response = (await dashboardAction(
      makeArgs(s.instructor, "https://c.telar.org/dashboard", body),
    )) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/objects");
    expect(sessionActiveProjectId).toBe(s.childA);
  });

  it("the shell opens on it by direct URL, with the instructor's role", async () => {
    const s = await seedCourse();
    sessionActiveProjectId = s.childA;

    const data = (await appLoader(
      makeArgs(s.instructor, "https://c.telar.org/objects"),
    )) as { activeProjectId: number | null; userRole: string | null; allProjects: Array<{ id: number }> };

    expect(data.activeProjectId).toBe(s.childA);
    expect(data.userRole).toBe("instructor");
    // Still absent from the switcher while being the project on screen.
    expect(data.allProjects.map((p) => p.id)).not.toContain(s.childA);
  });

  it("/start resolves it as the active project by direct URL", async () => {
    const s = await seedCourse();
    sessionActiveProjectId = s.childA;

    const data = (await startLoader(makeArgs(s.instructor, "https://c.telar.org/start"))) as {
      project: { id: number };
      userRole: string;
      otherProjects: Array<{ id: number }>;
    };

    expect(data.project.id).toBe(s.childA);
    expect(data.userRole).toBe("instructor");
    expect(data.otherProjects.map((p) => p.id)).not.toContain(s.childA);
  });

  it("falls back to a child when it is the only project the session has", async () => {
    // resolveActiveProject's stale-session fallback is left alone (ruling
    // 22): an instructor with no session and nothing but children still
    // lands somewhere rather than on an empty app.
    const instructor = await seedUser();
    const convenor = await seedUser();
    const course = await seedProject(convenor, { name: "t/hist", kind: "course" });
    const child = await seedProject(convenor, { name: "s/group", parent: course });
    await addMember(child, instructor, "instructor");
    sessionActiveProjectId = undefined;

    const data = (await appLoader(makeArgs(instructor, "https://c.telar.org/objects"))) as {
      activeProjectId: number | null;
      allProjects: Array<{ id: number }>;
    };

    expect(data.activeProjectId).toBe(child);
    expect(data.allProjects).toEqual([]);
  });
});
