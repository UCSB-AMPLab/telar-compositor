/**
 * The `/_app` shell loader's `showCourseTab` computation, run against a
 * real D1 database (via `createMemoryD1`).
 *
 * The tab must be offered exactly when `/course`'s loader would
 * admit the caller, not merely when they sit on a course or a course's
 * child. `/course` resolves the course one hop up (`parent_project_id`)
 * and calls `requireCourseCodeManager`, which needs `course_access` plus a
 * `convenor` or `instructor` row on the resolved course — a `collaborator`
 * row on a child carries neither. This suite drives the loader the way
 * `tests/app-loader-instructor-counts.test.ts` does and asserts on
 * `showCourseTab` for each standing the tab must distinguish.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

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
      set: vi.fn(),
    })),
    commitSession: vi.fn(async () => "cookie"),
  })),
}));

vi.mock("~/lib/crypto.server", () => ({
  decrypt: vi.fn(async () => "token"),
}));

vi.mock("~/lib/github.server", () => ({
  getRepoHead: vi.fn(async () => "sha"),
  checkRepoAvailability: vi.fn(async () => ({
    availability: "available" as const,
    canonicalFullName: null,
  })),
}));

vi.mock("~/lib/sync.server", () => ({
  computeFullSyncDiff: vi.fn(async () => ({})),
  hasDivergentChanges: vi.fn(() => false),
}));

vi.mock("~/lib/upgrade.server", async (importActual) => {
  const actual = await importActual<typeof import("~/lib/upgrade.server")>();
  return { ...actual, fetchLatestRelease: vi.fn(async () => ({ tagName: "v0.0.0" })) };
});

import { loader } from "~/routes/_app";

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;

const HOUR = 60 * 60 * 1000;
const future = () => new Date(Date.now() + 48 * HOUR).toISOString();

let nextUser = 0;
async function seedUser(courseAccess: boolean): Promise<number> {
  nextUser += 1;
  const rows = await db
    .insert(users)
    .values({
      github_id: 8000 + nextUser,
      github_login: `courseuser${nextUser}`,
      encrypted_access_token: "enc",
      encrypted_refresh_token: "enc",
      access_token_expires_at: future(),
      refresh_token_expires_at: future(),
      course_access: courseAccess,
    })
    .returning({ id: users.id });
  return rows[0].id;
}

async function seedProject(
  ownerId: number,
  opts: { kind?: "site" | "course"; parentProjectId?: number } = {},
): Promise<number> {
  const rows = await db
    .insert(projects)
    .values({
      user_id: ownerId,
      github_repo_full_name: "owner/site",
      installation_id: 1,
      kind: opts.kind ?? "site",
      parent_project_id: opts.parentProjectId ?? null,
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

async function runLoader(userId: number) {
  const env = {
    DB: asD1(memory),
    SESSION_SECRET: "secret",
    ENCRYPTION_KEY: "key",
  };
  const userRow = (await db.select().from(users).where(eq(users.id, userId)))[0];
  return loader({
    request: new Request("https://compositor.telar.org/objects"),
    context: {
      get: () => userRow,
      cloudflare: { env },
    },
    params: {},
  } as never);
}

beforeEach(async () => {
  memory = createMemoryD1();
  db = drizzle(asD1(memory), { schema });
});

afterEach(() => {
  memory.close();
});

describe("_app loader — showCourseTab agrees with /course's admission", () => {
  it("the course's convenor sees the tab", async () => {
    const convenor = await seedUser(true);
    const course = await seedProject(convenor, { kind: "course" });
    sessionActiveProjectId = course;

    const data = (await runLoader(convenor)) as { showCourseTab: boolean };
    expect(data.showCourseTab).toBe(true);
  });

  it("an instructor on the course sees the tab", async () => {
    const convenor = await seedUser(true);
    const course = await seedProject(convenor, { kind: "course" });
    const instructor = await seedUser(true);
    await addMember(course, instructor, "instructor");
    sessionActiveProjectId = course;

    const data = (await runLoader(instructor)) as { showCourseTab: boolean };
    expect(data.showCourseTab).toBe(true);
  });

  it("a member of a child project with no standing on the course does NOT see the tab", async () => {
    const convenor = await seedUser(true);
    const course = await seedProject(convenor, { kind: "course" });
    const child = await seedProject(convenor, { parentProjectId: course });
    const student = await seedUser(true);
    await addMember(child, student, "collaborator");
    sessionActiveProjectId = child;

    const data = (await runLoader(student)) as { showCourseTab: boolean };
    expect(data.showCourseTab).toBe(false);
  });

  it("a user without course_access does not see the tab, even as convenor of the course", async () => {
    const convenor = await seedUser(false);
    const course = await seedProject(convenor, { kind: "course" });
    sessionActiveProjectId = course;

    const data = (await runLoader(convenor)) as { showCourseTab: boolean };
    expect(data.showCourseTab).toBe(false);
  });

  it("a plain site (no parent, not a course) never shows the tab", async () => {
    const convenor = await seedUser(true);
    const site = await seedProject(convenor);
    sessionActiveProjectId = site;

    const data = (await runLoader(convenor)) as { showCourseTab: boolean };
    expect(data.showCourseTab).toBe(false);
  });
});
