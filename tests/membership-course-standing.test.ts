/**
 * `hasCourseStanding` directly — the same admission rule
 * `requireCourseCodeManager` applies for a `collaborator`-role code: the
 * course is resolved one hop up (the project itself when it is a course,
 * otherwise its `parent_project_id`), and the caller must hold a `convenor`
 * or `instructor` row there. `tests/app-loader-course-tab.test.ts` covers
 * this through the `_app` loader's `showCourseTab`; this suite isolates the
 * helper itself, including that the no-course case returns without a query.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import * as schema from "~/db/schema";
import { users, projects, project_members } from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";
import * as membership from "~/lib/membership.server";

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;

const HOUR = 60 * 60 * 1000;
const future = () => new Date(Date.now() + 30 * 24 * HOUR).toISOString();

let nextUser = 0;
async function seedUser(): Promise<number> {
  nextUser += 1;
  const rows = await db
    .insert(users)
    .values({
      github_id: 9000 + nextUser,
      github_login: `standinguser${nextUser}`,
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
  options: { kind?: "site" | "course"; parent?: number | null } = {},
): Promise<{ id: number; kind: string; parent_project_id: number | null }> {
  nextRepo += 1;
  const rows = await db
    .insert(projects)
    .values({
      user_id: ownerId,
      github_repo_full_name: `owner/standing${nextRepo}`,
      installation_id: 1,
      kind: options.kind ?? "site",
      parent_project_id: options.parent ?? null,
    })
    .returning({
      id: projects.id,
      kind: projects.kind,
      parent_project_id: projects.parent_project_id,
    });
  await db.insert(project_members).values({
    project_id: rows[0].id,
    user_id: ownerId,
    role: "convenor",
    joined_at: new Date().toISOString(),
  });
  return rows[0];
}

async function addMember(
  projectId: number,
  userId: number,
  role: "collaborator" | "instructor",
): Promise<void> {
  await db.insert(project_members).values({
    project_id: projectId,
    user_id: userId,
    role,
    joined_at: new Date().toISOString(),
  });
}

beforeEach(async () => {
  memory = createMemoryD1();
  db = drizzle(asD1(memory), { schema });
});

afterEach(() => {
  memory.close();
});

describe("hasCourseStanding", () => {
  it("the course's convenor has standing", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });

    const result = await membership.hasCourseStanding(db, course, convenor);
    expect(result).toBe(true);
  });

  it("an instructor row on the parent gives standing when checked against a child project", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    const child = await seedProject(convenor, { parent: course.id });
    const instructor = await seedUser();
    await addMember(course.id, instructor, "instructor");

    const result = await membership.hasCourseStanding(db, child, instructor);
    expect(result).toBe(true);
  });

  it("a collaborator on a child with no role on the course has no standing", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, { kind: "course" });
    const child = await seedProject(convenor, { parent: course.id });
    const student = await seedUser();
    await addMember(child.id, student, "collaborator");

    const result = await membership.hasCourseStanding(db, child, student);
    expect(result).toBe(false);
  });

  it("a plain site resolves to no course, false, with no query issued", async () => {
    const owner = await seedUser();
    const site = await seedProject(owner);
    const spy = vi.spyOn(membership, "getUserRole");

    const result = await membership.hasCourseStanding(db, site, owner);

    expect(result).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
