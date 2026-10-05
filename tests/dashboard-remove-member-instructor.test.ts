/**
 * The `/dashboard` `remove-member` intent refuses to remove an instructor
 * row from a project that has a parent — a child site enrolled in a
 * course. Instructor membership on a child is tied to the course in both
 * directions (design §5, "Joining and leaving"): copied down at
 * redemption, dropped only when the site itself leaves the course. A
 * convenor removing it here by the back door would produce a state the
 * design declares impossible.
 *
 * The refusal is real behaviour against a real D1 database (via
 * `createMemoryD1`), not a mock — the point being verified is the actual
 * `parent_project_id` lookup, not just that a function was called.
 *
 * The same refusal is shared with `leave-project` in `_app.account.tsx`
 * (see `isMembershipExitRefused` in `membership.server.ts`, and
 * `tests/account-actions.test.ts` for that side's coverage, and
 * `tests/membership-instructor-exit.test.ts` for the helper's own unit
 * coverage).
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

// signInternalMarker lives in workers/auth — the dashboard imports it via
// the relative path ../workers/auth from app/routes.
vi.mock("../workers/auth", async (importActual) => {
  const actual = await importActual<typeof import("../workers/auth")>();
  return { ...actual };
});

import { action } from "~/routes/_app.dashboard";

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
      github_id: 5000 + nextUser,
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
  opts: { kind?: "site" | "course"; parentProjectId?: number } = {},
): Promise<number> {
  nextRepo += 1;
  const rows = await db
    .insert(projects)
    .values({
      user_id: ownerId,
      github_repo_full_name: `owner/p${nextRepo}`,
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

function post(userId: number, fields: Record<string, string>) {
  // The page-site gate (resolvePageProject) reads siteId; each test sets
  // sessionActiveProjectId to the project it means the session to resolve.
  const form = new URLSearchParams({ siteId: String(sessionActiveProjectId), ...fields });
  const env = {
    DB: asD1(memory),
    SESSION_SECRET: "secret",
    ENCRYPTION_KEY: "key",
    COLLABORATION: {
      idFromName: vi.fn(() => "do-id"),
      get: vi.fn(() => ({
        fetch: vi.fn(async () => new Response("OK", { status: 200 })),
      })),
    },
  };
  return action({
    request: new Request("https://compositor.telar.org/dashboard", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
    context: {
      get: () => ({ id: userId, encrypted_access_token: "enc" }),
      cloudflare: { env },
    },
    params: {},
  } as never);
}

beforeEach(async () => {
  memory = createMemoryD1();
  db = drizzle(asD1(memory), { schema });
  sessionActiveProjectId = undefined;
});

afterEach(() => {
  memory.close();
});

describe("remove-member refuses an instructor on a child project", () => {
  it("child convenor cannot remove an instructor row while the site is enrolled in a course", async () => {
    const courseOwner = await seedUser();
    const course = await seedProject(courseOwner, { kind: "course" });
    const childConvenor = await seedUser();
    const child = await seedProject(childConvenor, { parentProjectId: course });
    const instructor = await seedUser();
    await addMember(child, instructor, "instructor");
    sessionActiveProjectId = child;

    const result = (await post(childConvenor, {
      intent: "remove-member",
      userId: String(instructor),
    })) as { ok: boolean; intent: string; error?: string };

    expect(result).toEqual({
      ok: false,
      intent: "remove-member",
      error: "instructor_on_child",
    });

    // The row is untouched.
    const stillThere = await db
      .select()
      .from(project_members)
      .where(eq(project_members.user_id, instructor));
    expect(stillThere).toHaveLength(1);
    expect(stillThere[0].role).toBe("instructor");
  });

  it("collaborator rows on the same child are unaffected — only instructor is refused", async () => {
    const courseOwner = await seedUser();
    const course = await seedProject(courseOwner, { kind: "course" });
    const childConvenor = await seedUser();
    const child = await seedProject(childConvenor, { parentProjectId: course });
    const collaborator = await seedUser();
    await addMember(child, collaborator, "collaborator");
    sessionActiveProjectId = child;

    const result = (await post(childConvenor, {
      intent: "remove-member",
      userId: String(collaborator),
    })) as { ok: boolean; intent: string };

    expect(result).toEqual({ ok: true, intent: "remove-member" });
    const stillThere = await db
      .select()
      .from(project_members)
      .where(eq(project_members.user_id, collaborator));
    expect(stillThere).toHaveLength(0);
  });

  it("the course project's own convenor CAN remove an instructor row on the course itself (no parent)", async () => {
    const courseConvenor = await seedUser();
    const course = await seedProject(courseConvenor, { kind: "course" });
    const coInstructor = await seedUser();
    await addMember(course, coInstructor, "instructor");
    sessionActiveProjectId = course;

    const result = (await post(courseConvenor, {
      intent: "remove-member",
      userId: String(coInstructor),
    })) as { ok: boolean; intent: string };

    expect(result).toEqual({ ok: true, intent: "remove-member" });
    const stillThere = await db
      .select()
      .from(project_members)
      .where(eq(project_members.user_id, coInstructor));
    expect(stillThere).toHaveLength(0);
  });

  it("an ordinary site with no parent removes an instructor row normally (defensive — instructors should not occur here, but the rule is parent-keyed, not role-keyed alone)", async () => {
    const convenor = await seedUser();
    const site = await seedProject(convenor);
    const strayInstructor = await seedUser();
    await addMember(site, strayInstructor, "instructor");
    sessionActiveProjectId = site;

    const result = (await post(convenor, {
      intent: "remove-member",
      userId: String(strayInstructor),
    })) as { ok: boolean; intent: string };

    expect(result).toEqual({ ok: true, intent: "remove-member" });
  });
});
