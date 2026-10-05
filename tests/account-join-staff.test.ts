/**
 * The account page's join-as-staff field, through the route action.
 *
 * `redeemAsStaff` and `fanOutStaffJoin` were both complete, both tested, and
 * both unreachable: nothing in `app/` called either, so a convenor could mint
 * an instructor-role code and no co-instructor could redeem one. Unit tests of
 * the two functions could not see that, and could not have — each was green
 * about a function nobody ran.
 *
 * So this suite drives the ACTION. Its subject is the wiring: that the intent
 * exists, that it reaches the redemption, and that the fan-out follows, which
 * is the half no test of the server functions can assert. The database is the
 * repository's own migration chain in memory, so the membership rows are read
 * back as rows rather than as claims about calls.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";

import * as schema from "~/db/schema";
import { users, projects, project_members, project_invites, project_config } from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

vi.mock("~/lib/github.server", () => ({
  listUserInstallations: vi.fn(async () => []),
}));

import { action } from "~/routes/_app.account";
import { userContext } from "~/middleware/auth.server";
import type { AuthenticatedUser } from "~/middleware/auth.server";

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;

const STAFF_CODE = "STAFFCODE9";
const future = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

vi.mock("~/lib/db.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/db.server")>();
  return { ...actual, getDb: () => db };
});

let nextUser = 0;
async function seedUser(): Promise<number> {
  nextUser += 1;
  const rows = await db
    .insert(users)
    .values({
      github_id: 2000 + nextUser,
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
  const projectId = rows[0].id;
  await db.insert(project_members).values({
    project_id: projectId,
    user_id: ownerId,
    role: "convenor",
    joined_at: new Date().toISOString(),
  });
  return projectId;
}

async function roleOn(projectId: number, userId: number): Promise<string | null> {
  const rows = await db
    .select({ role: project_members.role })
    .from(project_members)
    .where(
      and(eq(project_members.project_id, projectId), eq(project_members.user_id, userId)),
    )
    .limit(1);
  return rows[0]?.role ?? null;
}

/** The action's arguments, with `user` in context and `code` in the form. */
function callAction(userId: number, code: string) {
  const body = new URLSearchParams({ intent: "join-course-staff", code });
  const request = new Request("http://localhost:5173/account", {
    method: "POST",
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const context = {
    get: (key: unknown) =>
      key === userContext ? ({ id: userId } as AuthenticatedUser) : undefined,
    cloudflare: { env: { DB: asD1(memory) } },
  };
  return action({
    request,
    context,
    params: {},
  } as unknown as Parameters<typeof action>[0]);
}

beforeEach(() => {
  memory = createMemoryD1();
  db = drizzle(asD1(memory), { schema });
  nextUser = 0;
  nextRepo = 0;
});

describe("the account action admits staff with an instructor-role code", () => {
  it("writes the instructor row the code confers, and names the course", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, "course");
    await db.insert(project_config).values({ project_id: course, title: "Historia del Nuevo Reino" });
    await db.insert(project_invites).values({
      project_id: course,
      token: STAFF_CODE,
      conferred_role: "instructor",
      expires_at: future(),
    });
    const ta = await seedUser();

    const result = (await callAction(ta, STAFF_CODE)) as {
      ok: boolean;
      outcome: { state: string; courseName?: string; alreadyStaff?: boolean };
    };

    expect(result.ok).toBe(true);
    expect(result.outcome.state).toBe("ok");
    expect(result.outcome.courseName).toBe("Historia del Nuevo Reino");
    expect(result.outcome.alreadyStaff).toBe(false);
    expect(await roleOn(course, ta)).toBe("instructor");
  });

  it("fans the new staff row out to the children the course already has", async () => {
    // The half no test of `redeemAsStaff` can reach: a TA admitted in week
    // three is in every group's site, not only the ones created after them.
    const convenor = await seedUser();
    const course = await seedProject(convenor, "course");
    const groupOwner = await seedUser();
    const childA = await seedProject(groupOwner, "site", course);
    const childB = await seedProject(groupOwner, "site", course);
    const unrelated = await seedProject(groupOwner, "site", null);
    await db.insert(project_invites).values({
      project_id: course,
      token: STAFF_CODE,
      conferred_role: "instructor",
      expires_at: future(),
    });
    const ta = await seedUser();

    await callAction(ta, STAFF_CODE);

    expect(await roleOn(childA, ta)).toBe("instructor");
    expect(await roleOn(childB, ta)).toBe("instructor");
    // A site outside the course is nobody's to hand over.
    expect(await roleOn(unrelated, ta)).toBeNull();
  });

  it("reports a repeat as already staff, and writes nothing a second time", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, "course");
    await db.insert(project_invites).values({
      project_id: course,
      token: STAFF_CODE,
      conferred_role: "instructor",
      expires_at: future(),
    });
    const ta = await seedUser();

    await callAction(ta, STAFF_CODE);
    const second = (await callAction(ta, STAFF_CODE)) as {
      outcome: { state: string; alreadyStaff?: boolean };
    };

    expect(second.outcome.state).toBe("ok");
    expect(second.outcome.alreadyStaff).toBe(true);
    const rows = await db
      .select({ id: project_members.id })
      .from(project_members)
      .where(
        and(eq(project_members.project_id, course), eq(project_members.user_id, ta)),
      );
    expect(rows).toHaveLength(1);
  });

  it("refuses a class code on this surface, by the state the copy is keyed on", async () => {
    // A `site` code entered here is the mistake the two kinds of code make
    // possible, and `code_error_wrong_kind_staff` is the sentence that tells
    // the person which field to use instead. The state is what selects it.
    const convenor = await seedUser();
    const course = await seedProject(convenor, "course");
    await db.insert(project_invites).values({
      project_id: course,
      token: "CLASSCODE7",
      conferred_role: "collaborator",
      expires_at: future(),
    });
    const student = await seedUser();

    const result = (await callAction(student, "CLASSCODE7")) as {
      ok: boolean;
      outcome: { state: string };
    };

    expect(result.ok).toBe(false);
    expect(result.outcome.state).toBe("wrong_kind");
    expect(await roleOn(course, student)).toBeNull();
  });

  it("reports a code that does not exist without admitting anyone", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, "course");
    const nobody = await seedUser();

    const result = (await callAction(nobody, "NOSUCHCOD3")) as {
      ok: boolean;
      outcome: { state: string };
    };

    expect(result.ok).toBe(false);
    expect(result.outcome.state).toBe("not_found");
    expect(await roleOn(course, nobody)).toBeNull();
  });
});
