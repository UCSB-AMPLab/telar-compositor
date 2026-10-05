/**
 * Instructor-awareness in `membership.server.ts`, run against a real D1
 * database (via `createMemoryD1`) rather than a mock — the point being
 * verified is the actual SQL and its numbers, not just that a code path
 * was reached.
 *
 * Covers two things design §3 names:
 *
 *   - `isMembershipExitRefused`: the shared rule behind the membership-exit
 *     refusal that `remove-member` (_app.dashboard.tsx) and `leave-project`
 *     (_app.account.tsx) both take — an instructor row on a project WITH a
 *     parent is refused; every other combination (convenor/collaborator of
 *     any project, or an instructor row on a project with no parent) is
 *     not.
 *
 *   - `getUserProjectsWithStats`'s `collaborator_count`: instructor rows
 *     are staff, not group size, so they must not count toward it. This is
 *     the number that feeds the account danger zone's gating
 *     (convenedProjects / soloConvenedCount) — an uncorrected count would
 *     make a solo student's site look convened-with-collaborators and
 *     block their own account deletion.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import * as schema from "~/db/schema";
import { users, projects, project_members } from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";
import {
  isMembershipExitRefused,
  getUserProjectsWithStats,
} from "~/lib/membership.server";

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
      github_id: 6000 + nextUser,
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

beforeEach(() => {
  memory = createMemoryD1();
  db = drizzle(asD1(memory), { schema });
});

afterEach(() => {
  memory.close();
});

// ---------------------------------------------------------------------------
// isMembershipExitRefused
// ---------------------------------------------------------------------------

describe("isMembershipExitRefused", () => {
  it("refuses an instructor row on a project WITH a parent", async () => {
    const courseOwner = await seedUser();
    const course = await seedProject(courseOwner, { kind: "course" });
    const child = await seedProject(await seedUser(), { parentProjectId: course });

    const refused = await isMembershipExitRefused(db, child, "instructor");
    expect(refused).toBe(true);
  });

  it("does not refuse an instructor row on a project with NO parent (the course project itself)", async () => {
    const courseOwner = await seedUser();
    const course = await seedProject(courseOwner, { kind: "course" });

    const refused = await isMembershipExitRefused(db, course, "instructor");
    expect(refused).toBe(false);
  });

  it("does not refuse an instructor row on an ordinary unaffiliated site", async () => {
    const owner = await seedUser();
    const site = await seedProject(owner);

    const refused = await isMembershipExitRefused(db, site, "instructor");
    expect(refused).toBe(false);
  });

  it("never refuses a collaborator, regardless of parent", async () => {
    const courseOwner = await seedUser();
    const course = await seedProject(courseOwner, { kind: "course" });
    const child = await seedProject(await seedUser(), { parentProjectId: course });

    expect(await isMembershipExitRefused(db, child, "collaborator")).toBe(false);
  });

  it("never refuses a convenor, regardless of parent", async () => {
    const courseOwner = await seedUser();
    const course = await seedProject(courseOwner, { kind: "course" });
    const child = await seedProject(await seedUser(), { parentProjectId: course });

    expect(await isMembershipExitRefused(db, child, "convenor")).toBe(false);
  });

  it("returns false for null/undefined role without querying the database for a project that doesn't exist", async () => {
    await expect(isMembershipExitRefused(db, 999999, null)).resolves.toBe(false);
    await expect(isMembershipExitRefused(db, 999999, undefined)).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getUserProjectsWithStats — collaborator_count excludes instructor rows
// ---------------------------------------------------------------------------

describe("getUserProjectsWithStats collaborator_count excludes instructor rows", () => {
  it("a solo student's site with only a convenor + an instructor row reports collaborator_count = 0", async () => {
    const student = await seedUser();
    const site = await seedProject(student);
    const instructor = await seedUser();
    await addMember(site, instructor, "instructor");

    const [row] = await getUserProjectsWithStats(db, student);
    expect(row.collaborator_count).toBe(0);
  });

  it("a project with a convenor + one collaborator + one instructor reports collaborator_count = 1 (not 2)", async () => {
    const convenor = await seedUser();
    const site = await seedProject(convenor);
    const collaborator = await seedUser();
    const instructor = await seedUser();
    await addMember(site, collaborator, "collaborator");
    await addMember(site, instructor, "instructor");

    const [row] = await getUserProjectsWithStats(db, convenor);
    expect(row.collaborator_count).toBe(1);
  });

  it("a project with only the convenor and no other members reports collaborator_count = 0", async () => {
    const convenor = await seedUser();
    const site = await seedProject(convenor);

    const [row] = await getUserProjectsWithStats(db, convenor);
    expect(row.id).toBe(site);
    expect(row.collaborator_count).toBe(0);
  });
});
