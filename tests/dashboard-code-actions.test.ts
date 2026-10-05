/**
 * The /dashboard endpoint's invite and join-code intents.
 *
 * Three rules meet here. A course admits people through its codes and
 * nothing else, so `generate-invite` and `send-invite` are refused on a
 * `kind = "course"` project — a collaborator row on the course would hand
 * a student a live editing socket on the master collection. Cancelling an
 * invite is a revocation, never a delete, because `joined_via_invite_id`
 * references the row and a revoked code stays standing as the enrolment
 * record of everyone it admitted. And code management is gated
 * course-aware rather than by `requireOwner`: any course staff member may
 * issue and revoke a class code, while instructor-role codes — staff
 * management by another door — are the convenor's alone.
 *
 * The target project of a code-management action comes from the form and
 * is verified against the database. The session's active project is
 * deliberately something else in one test, to pin that.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import * as schema from "~/db/schema";
import { users, projects, project_members, project_invites } from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

let sessionActiveProjectId: number | undefined;

vi.mock("~/middleware/auth.server", () => ({
  authMiddleware: vi.fn(),
  userContext: Symbol("userContext"),
}));

vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({
      get: vi.fn((key: string) => {
        // Managing a course's codes takes the course password (ruling 20);
        // these tests are about standing, so the session has answered it.
        if (key === "courseGateUnlocked") return true;
        return key === "activeProjectId" ? sessionActiveProjectId : undefined;
      }),
      set: vi.fn(),
    })),
    commitSession: vi.fn(async () => "cookie"),
  })),
}));

import { action } from "~/routes/_app.dashboard";
import { requireCourseCodeManager } from "~/lib/membership.server";

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;

const HOUR = 60 * 60 * 1000;
const future = () => new Date(Date.now() + 48 * HOUR).toISOString();
const TERM_END = new Date(Date.now() + 120 * 24 * HOUR).toISOString();

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
  kind: "site" | "course" = "site",
): Promise<number> {
  nextRepo += 1;
  const rows = await db
    .insert(projects)
    .values({
      user_id: ownerId,
      github_repo_full_name: `owner/p${nextRepo}`,
      installation_id: 1,
      kind,
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

async function invitesFor(projectId: number) {
  return db
    .select()
    .from(project_invites)
    .where(eq(project_invites.project_id, projectId));
}

function post(userId: number, fields: Record<string, string>) {
  // The page-site gate (resolvePageProject) reads siteId; the mocked session
  // names sessionActiveProjectId, so that is the id a non-exempt intent must
  // post to be admitted. create-code/revoke-code/cancel-invite are exempt and
  // ignore it; the other fields may still override it explicitly.
  const form = new URLSearchParams({ siteId: String(sessionActiveProjectId), ...fields });
  const env = { DB: asD1(memory), SESSION_SECRET: "secret", ENCRYPTION_KEY: "key" };
  return action({
    request: new Request("https://compositor.telar.org/dashboard", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
    context: {
      get: () => ({ id: userId, encrypted_access_token: "enc", course_access: true }),
      cloudflare: { env },
    },
    params: {},
  } as never);
}

/** Run an action expected to be refused by a server gate. */
async function expectForbidden(promise: Promise<unknown>) {
  await expect(promise).rejects.toSatisfy(
    (thrown: unknown) => thrown instanceof Response && thrown.status === 403,
  );
}

beforeEach(() => {
  memory = createMemoryD1();
  db = drizzle(asD1(memory), { schema });
  sessionActiveProjectId = undefined;
});

afterEach(() => {
  memory.close();
});

// ---------------------------------------------------------------------------
// Legacy invite actions on a course project
// ---------------------------------------------------------------------------

describe("legacy invite actions refuse course projects", () => {
  it("refuses generate-invite on a course and mints nothing", async () => {
    const instructor = await seedUser();
    const course = await seedProject(instructor, "course");
    sessionActiveProjectId = course;

    const result = await post(instructor, { intent: "generate-invite" });

    expect(result).toEqual({
      ok: false,
      intent: "generate-invite",
      error: "invite_refused_course",
    });
    expect(await invitesFor(course)).toHaveLength(0);
  });

  it("refuses send-invite on a course and adds nobody", async () => {
    const instructor = await seedUser();
    const course = await seedProject(instructor, "course");
    sessionActiveProjectId = course;

    const result = await post(instructor, {
      intent: "send-invite",
      username: "somebody",
    });

    expect(result).toEqual({
      ok: false,
      intent: "send-invite",
      error: "invite_refused_course",
    });
    const members = await db
      .select()
      .from(project_members)
      .where(eq(project_members.project_id, course));
    expect(members).toHaveLength(1);
  });

  it("still mints an ordinary site invite", async () => {
    const convenor = await seedUser();
    const site = await seedProject(convenor);
    sessionActiveProjectId = site;

    const result = (await post(convenor, { intent: "generate-invite" })) as {
      ok: boolean;
      inviteUrl: string;
    };

    expect(result.ok).toBe(true);
    const rows = await invitesFor(site);
    expect(rows).toHaveLength(1);
    expect(rows[0].conferred_role).toBe("collaborator");
    expect(result.inviteUrl).toContain(rows[0].token);
  });
});

// ---------------------------------------------------------------------------
// cancel-invite becomes revocation
// ---------------------------------------------------------------------------

describe("cancel-invite", () => {
  it("revokes the row instead of deleting it", async () => {
    const convenor = await seedUser();
    const site = await seedProject(convenor);
    sessionActiveProjectId = site;
    await post(convenor, { intent: "generate-invite" });
    const before = (await invitesFor(site))[0];

    const result = await post(convenor, {
      intent: "cancel-invite",
      inviteId: String(before.id),
    });

    expect(result).toEqual({ ok: true, intent: "cancel-invite" });
    const after = (await invitesFor(site))[0];
    expect(after).toBeDefined();
    expect(after.revoked_at).not.toBeNull();
    expect(after.token).toBe(before.token);
  });

  it("refuses a convenor who does not own the invite's own project", async () => {
    // requireOwner now checks the invite row's own project_id, not the
    // session's active project, so owning `mine` is not standing on `theirs`
    // — a stricter refusal than the prior session-scoped check, which let
    // this call through and relied on the update's own WHERE clause to leave
    // the foreign row untouched.
    const convenor = await seedUser();
    const mine = await seedProject(convenor);
    const otherOwner = await seedUser();
    const theirs = await seedProject(otherOwner);
    await db.insert(project_invites).values({
      project_id: theirs,
      token: "11111111-1111-4111-8111-111111111111",
      conferred_role: "collaborator",
      expires_at: future(),
    });
    const target = (await invitesFor(theirs))[0];
    sessionActiveProjectId = mine;

    await expectForbidden(
      post(convenor, { intent: "cancel-invite", inviteId: String(target.id) }),
    );

    expect((await invitesFor(theirs))[0].revoked_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// create-code — the course-aware gate
// ---------------------------------------------------------------------------

describe("create-code", () => {
  it("lets the course convenor mint a class code on the caller's terms", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, "course");

    const result = (await post(convenor, {
      intent: "create-code",
      projectId: String(course),
      role: "collaborator",
      expiresAt: TERM_END,
      label: "Autumn term",
    })) as { ok: boolean; code: string };

    expect(result.ok).toBe(true);
    const rows = await invitesFor(course);
    expect(rows).toHaveLength(1);
    expect(rows[0].token).toBe(result.code);
    expect(rows[0].conferred_role).toBe("collaborator");
    expect(rows[0].expires_at).toBe(TERM_END);
    expect(rows[0].label).toBe("Autumn term");
    expect(rows[0].created_by).toBe(convenor);
  });

  it("takes its target from the form, not the session", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, "course");
    const unrelated = await seedProject(convenor);
    sessionActiveProjectId = unrelated;

    await post(convenor, {
      intent: "create-code",
      projectId: String(course),
      role: "collaborator",
      expiresAt: TERM_END,
      label: "",
    });

    expect(await invitesFor(course)).toHaveLength(1);
    expect(await invitesFor(unrelated)).toHaveLength(0);
  });

  it("lets a course instructor mint a class code", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, "course");
    const ta = await seedUser();
    await addMember(course, ta, "instructor");

    const result = (await post(ta, {
      intent: "create-code",
      projectId: String(course),
      role: "collaborator",
      expiresAt: TERM_END,
      label: "",
    })) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect((await invitesFor(course))[0].conferred_role).toBe("collaborator");
  });

  it("refuses a course instructor an instructor-role code", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, "course");
    const ta = await seedUser();
    await addMember(course, ta, "instructor");

    await expectForbidden(
      post(ta, {
        intent: "create-code",
        projectId: String(course),
        role: "instructor",
        expiresAt: TERM_END,
        label: "",
      }),
    );
    expect(await invitesFor(course)).toHaveLength(0);
  });

  it("lets the convenor mint an instructor-role code", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, "course");

    const result = (await post(convenor, {
      intent: "create-code",
      projectId: String(course),
      role: "instructor",
      expiresAt: TERM_END,
      label: "TAs",
    })) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect((await invitesFor(course))[0].conferred_role).toBe("instructor");
  });

  it("refuses a non-member and a plain collaborator alike", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, "course");
    const stranger = await seedUser();
    const collaborator = await seedUser();
    await addMember(course, collaborator, "collaborator");

    const fields = {
      intent: "create-code",
      projectId: String(course),
      role: "collaborator",
      expiresAt: TERM_END,
      label: "",
    };
    await expectForbidden(post(stranger, fields));
    await expectForbidden(post(collaborator, fields));
    expect(await invitesFor(course)).toHaveLength(0);
  });

  it("refuses a project that is not a course", async () => {
    const convenor = await seedUser();
    const site = await seedProject(convenor);

    await expectForbidden(
      post(convenor, {
        intent: "create-code",
        projectId: String(site),
        role: "collaborator",
        expiresAt: TERM_END,
        label: "",
      }),
    );
    expect(await invitesFor(site)).toHaveLength(0);
  });

  it("reads an empty expiry as never expiring, and a bad one as an error", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, "course");

    // Blank is the "no expiry" answer, not a missing one.
    const never = (await post(convenor, {
      intent: "create-code",
      projectId: String(course),
      role: "collaborator",
      expiresAt: "",
      label: "",
    })) as { ok: boolean };
    expect(never.ok).toBe(true);
    const rows = await invitesFor(course);
    expect(rows).toHaveLength(1);
    expect(rows[0].expires_at).toBeNull();

    const unusable = await post(convenor, {
      intent: "create-code",
      projectId: String(course),
      role: "collaborator",
      expiresAt: "not-a-date",
      label: "",
    });
    expect(unusable).toEqual({
      ok: false,
      intent: "create-code",
      error: "invalid_expiry",
    });
    expect(await invitesFor(course)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// revoke-code
// ---------------------------------------------------------------------------

describe("revoke-code", () => {
  async function seedCourseWithCodes() {
    const convenor = await seedUser();
    const course = await seedProject(convenor, "course");
    const ta = await seedUser();
    await addMember(course, ta, "instructor");
    await post(convenor, {
      intent: "create-code",
      projectId: String(course),
      role: "collaborator",
      expiresAt: TERM_END,
      label: "class",
    });
    await post(convenor, {
      intent: "create-code",
      projectId: String(course),
      role: "instructor",
      expiresAt: TERM_END,
      label: "staff",
    });
    const rows = await invitesFor(course);
    return {
      convenor,
      course,
      ta,
      classCode: rows.find((r) => r.conferred_role === "collaborator")!,
      staffCode: rows.find((r) => r.conferred_role === "instructor")!,
    };
  }

  it("lets an instructor revoke a class code, marking rather than deleting", async () => {
    const { course, ta, classCode } = await seedCourseWithCodes();

    const result = await post(ta, {
      intent: "revoke-code",
      projectId: String(course),
      inviteId: String(classCode.id),
    });

    expect(result).toEqual({ ok: true, intent: "revoke-code" });
    const rows = await invitesFor(course);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === classCode.id)!.revoked_at).not.toBeNull();
  });

  it("refuses an instructor the staff code", async () => {
    const { course, ta, staffCode } = await seedCourseWithCodes();

    await expectForbidden(
      post(ta, {
        intent: "revoke-code",
        projectId: String(course),
        inviteId: String(staffCode.id),
      }),
    );
    const rows = await invitesFor(course);
    expect(rows.find((r) => r.id === staffCode.id)!.revoked_at).toBeNull();
  });

  it("lets the convenor revoke the staff code", async () => {
    const { convenor, course, staffCode } = await seedCourseWithCodes();

    const result = await post(convenor, {
      intent: "revoke-code",
      projectId: String(course),
      inviteId: String(staffCode.id),
    });

    expect(result).toEqual({ ok: true, intent: "revoke-code" });
    const rows = await invitesFor(course);
    expect(rows.find((r) => r.id === staffCode.id)!.revoked_at).not.toBeNull();
  });

  it("refuses a code that does not belong to the named course", async () => {
    const { convenor, course } = await seedCourseWithCodes();
    const otherConvenor = await seedUser();
    const otherCourse = await seedProject(otherConvenor, "course");
    await post(otherConvenor, {
      intent: "create-code",
      projectId: String(otherCourse),
      role: "collaborator",
      expiresAt: TERM_END,
      label: "",
    });
    const foreign = (await invitesFor(otherCourse))[0];

    const result = await post(convenor, {
      intent: "revoke-code",
      projectId: String(course),
      inviteId: String(foreign.id),
    });

    expect(result).toEqual({
      ok: false,
      intent: "revoke-code",
      error: "not_found",
    });
    expect((await invitesFor(otherCourse))[0].revoked_at).toBeNull();
  });

  it("refuses a stranger before it says whether the code exists", async () => {
    const { course, classCode } = await seedCourseWithCodes();
    const stranger = await seedUser();

    await expectForbidden(
      post(stranger, {
        intent: "revoke-code",
        projectId: String(course),
        inviteId: String(classCode.id),
      }),
    );
    await expectForbidden(
      post(stranger, {
        intent: "revoke-code",
        projectId: String(course),
        inviteId: "999999",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// The gate itself
// ---------------------------------------------------------------------------

describe("requireCourseCodeManager", () => {
  /** The refusal reduced to what a caller could actually observe. */
  async function refusal(promise: Promise<unknown>) {
    try {
      await promise;
      throw new Error("expected a refusal");
    } catch (thrown) {
      if (!(thrown instanceof Response)) throw thrown;
      return {
        status: thrown.status,
        statusText: thrown.statusText,
        body: await thrown.text(),
      };
    }
  }

  it("admits the convenor for either kind of code", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, "course");

    const classGate = await requireCourseCodeManager(db, course, convenor, "collaborator");
    const staffGate = await requireCourseCodeManager(db, course, convenor, "instructor");

    expect(classGate.role).toBe("convenor");
    expect(classGate.project.id).toBe(course);
    expect(staffGate.role).toBe("convenor");
  });

  it("admits an instructor for a class code only", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, "course");
    const ta = await seedUser();
    await addMember(course, ta, "instructor");

    const classGate = await requireCourseCodeManager(db, course, ta, "collaborator");
    expect(classGate.role).toBe("instructor");

    await expect(
      requireCourseCodeManager(db, course, ta, "instructor"),
    ).rejects.toSatisfy(
      (thrown: unknown) => thrown instanceof Response && thrown.status === 403,
    );
  });

  it("refuses a collaborator and a non-member", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, "course");
    const collaborator = await seedUser();
    await addMember(course, collaborator, "collaborator");
    const stranger = await seedUser();

    expect(
      (await refusal(requireCourseCodeManager(db, course, collaborator, "collaborator")))
        .status,
    ).toBe(403);
    expect(
      (await refusal(requireCourseCodeManager(db, course, stranger, "collaborator"))).status,
    ).toBe(403);
  });

  it("refuses a project that is not a course", async () => {
    const convenor = await seedUser();
    const site = await seedProject(convenor);

    expect(
      (await refusal(requireCourseCodeManager(db, site, convenor, "collaborator"))).status,
    ).toBe(403);
  });

  it("answers for a project that does not exist exactly as for one the caller may not touch", async () => {
    const convenor = await seedUser();
    const course = await seedProject(convenor, "course");
    const stranger = await seedUser();

    const unauthorised = await refusal(
      requireCourseCodeManager(db, course, stranger, "collaborator"),
    );
    const absent = await refusal(
      requireCourseCodeManager(db, course + 9999, stranger, "collaborator"),
    );

    // Byte-identical: the refusal must not report whether an id is real.
    expect(absent).toEqual(unauthorised);
  });
});
