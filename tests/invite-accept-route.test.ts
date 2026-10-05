/**
 * The `/invite/:token` loader and action, run against a real database.
 *
 * Two invariants carry the suite. `used_at` is the consumed flag —
 * `used_by` is `ON DELETE SET NULL`, so an invite keyed on it would reopen
 * when its redeemer deletes their account. And membership is checked before
 * the invite is consumed: a single-use invite must not be spent on someone
 * who already holds a seat.
 *
 * The route also has to survive `project_invites` holding a second
 * artefact: a course join code pasted into an invitation URL is refused as
 * `wrong_kind` rather than admitting its holder to the course project.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import * as schema from "~/db/schema";
import { users, projects, project_members, project_invites } from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

// The session is the only thing this route needs that a database cannot
// supply; everything else runs for real.
let sessionUserId: number | undefined;

vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({
      get: vi.fn((key: string) => (key === "userId" ? sessionUserId : undefined)),
      set: vi.fn(),
    })),
    commitSession: vi.fn(async () => "cookie"),
  })),
}));

import { loader, action } from "~/routes/_auth.invite.$token";
import { INVITE_REFUSAL_KEYS } from "~/lib/invite-refusal";

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;

const HOUR = 60 * 60 * 1000;
const future = () => new Date(Date.now() + 48 * HOUR).toISOString();
const past = () => new Date(Date.now() - HOUR).toISOString();

const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

let nextUser = 0;
async function seedUser(login?: string): Promise<number> {
  nextUser += 1;
  const rows = await db
    .insert(users)
    .values({
      github_id: 2000 + nextUser,
      github_login: login ?? `user${nextUser}`,
      encrypted_access_token: "enc",
      encrypted_refresh_token: "enc",
      access_token_expires_at: future(),
      refresh_token_expires_at: future(),
    })
    .returning({ id: users.id });
  return rows[0].id;
}

let nextRepo = 0;
async function seedProject(ownerId: number): Promise<number> {
  nextRepo += 1;
  const rows = await db
    .insert(projects)
    .values({
      user_id: ownerId,
      github_repo_full_name: `owner/site${nextRepo}`,
      installation_id: 1,
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

async function seedInvite(values: {
  projectId: number;
  token: string;
  conferredRole?: "collaborator" | "instructor";
  expiresAt?: string;
  usedAt?: string | null;
  usedBy?: number | null;
  revokedAt?: string | null;
}): Promise<number> {
  const rows = await db
    .insert(project_invites)
    .values({
      project_id: values.projectId,
      token: values.token,
      conferred_role: values.conferredRole ?? "collaborator",
      expires_at: values.expiresAt ?? future(),
      used_at: values.usedAt ?? null,
      used_by: values.usedBy ?? null,
      revoked_at: values.revokedAt ?? null,
      created_by: null,
    })
    .returning({ id: project_invites.id });
  return rows[0].id;
}

function args(token: string) {
  const env = { DB: asD1(memory), SESSION_SECRET: "secret" };
  return {
    request: new Request(`https://compositor.telar.org/invite/${token}`, {
      method: "POST",
    }),
    params: { token },
    context: { cloudflare: { env } },
  } as never;
}

/** Run the action, turning its thrown redirect into a plain result. */
async function runAction(token: string) {
  try {
    return { redirected: false as const, data: await action(args(token)) };
  } catch (thrown) {
    if (thrown instanceof Response) {
      return { redirected: true as const, response: thrown };
    }
    throw thrown;
  }
}

beforeEach(() => {
  memory = createMemoryD1();
  db = drizzle(asD1(memory), { schema });
  sessionUserId = undefined;
});

afterEach(() => {
  memory.close();
});

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

describe("invite loader", () => {
  it("reports not_found for an unknown token", async () => {
    const result = await loader(args(UUID));
    expect(result.state).toBe("not_found");
  });

  it("collapses expired onto the same message as not_found", async () => {
    const owner = await seedUser();
    const project = await seedProject(owner);
    await seedInvite({ projectId: project, token: UUID, expiresAt: past() });

    const result = await loader(args(UUID));
    expect(result.state).toBe("expired");
    expect(INVITE_REFUSAL_KEYS.expired).toBe(INVITE_REFUSAL_KEYS.not_found);
  });

  it("reports used for a consumed invite whose redeemer has been deleted", async () => {
    const owner = await seedUser();
    const project = await seedProject(owner);
    // used_by cleared by the account-deletion SET NULL; used_at endures.
    await seedInvite({
      projectId: project,
      token: UUID,
      usedAt: new Date().toISOString(),
      usedBy: null,
    });

    const result = await loader(args(UUID));
    expect(result.state).toBe("used");
    expect(INVITE_REFUSAL_KEYS.used).toBe("accept_used");
  });

  it("reports revoked for a cancelled invite", async () => {
    const owner = await seedUser();
    const project = await seedProject(owner);
    await seedInvite({
      projectId: project,
      token: UUID,
      revokedAt: new Date().toISOString(),
    });

    const result = await loader(args(UUID));
    expect(result.state).toBe("revoked");
    expect(INVITE_REFUSAL_KEYS.revoked).toBe("accept_revoked");
  });

  it("reports wrong_kind for a course join code opened as a link", async () => {
    const owner = await seedUser();
    const project = await seedProject(owner);
    await seedInvite({ projectId: project, token: "CLASSCODE7" });

    const result = await loader(args("CLASSCODE7"));
    expect(result.state).toBe("wrong_kind");
    expect(INVITE_REFUSAL_KEYS.wrong_kind).toBe("accept_wrong_kind");
  });

  it("offers sign-in to an anonymous holder of a live invite", async () => {
    const owner = await seedUser("teacher");
    const project = await seedProject(owner);
    await seedInvite({ projectId: project, token: UUID });

    const result = await loader(args(UUID));
    expect(result.state).toBe("not_signed_in");
    expect(result).toMatchObject({ ownerLogin: "teacher" });
  });

  it("reports already_member for a signed-in member", async () => {
    const owner = await seedUser();
    const project = await seedProject(owner);
    await seedInvite({ projectId: project, token: UUID });
    sessionUserId = owner;

    const result = await loader(args(UUID));
    expect(result.state).toBe("already_member");
  });

  it("is ready for a signed-in non-member", async () => {
    const owner = await seedUser();
    const project = await seedProject(owner);
    await seedInvite({ projectId: project, token: UUID });
    sessionUserId = await seedUser();

    const result = await loader(args(UUID));
    expect(result.state).toBe("ready");
  });
});

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

describe("invite action", () => {
  it("records the admission on the new member row and consumes the invite", async () => {
    const owner = await seedUser();
    const project = await seedProject(owner);
    const inviteId = await seedInvite({ projectId: project, token: UUID });
    const joiner = await seedUser();
    sessionUserId = joiner;

    const outcome = await runAction(UUID);
    expect(outcome.redirected).toBe(true);

    const rows = await db
      .select()
      .from(project_members)
      .where(eq(project_members.user_id, joiner));
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("collaborator");
    expect(rows[0].joined_via_invite_id).toBe(inviteId);

    const invite = (
      await db.select().from(project_invites).where(eq(project_invites.id, inviteId))
    )[0];
    expect(invite.used_by).toBe(joiner);
    expect(invite.used_at).not.toBeNull();
  });

  it("refuses an existing member without spending the invite", async () => {
    const owner = await seedUser();
    const project = await seedProject(owner);
    const inviteId = await seedInvite({ projectId: project, token: UUID });
    sessionUserId = owner;

    const outcome = await runAction(UUID);
    expect(outcome).toMatchObject({ redirected: false, data: { error: "already_member" } });

    const invite = (
      await db.select().from(project_invites).where(eq(project_invites.id, inviteId))
    )[0];
    expect(invite.used_at).toBeNull();
    expect(invite.used_by).toBeNull();
  });

  it("refuses an invite consumed by someone whose account has gone", async () => {
    const owner = await seedUser();
    const project = await seedProject(owner);
    await seedInvite({
      projectId: project,
      token: UUID,
      usedAt: new Date().toISOString(),
      usedBy: null,
    });
    sessionUserId = await seedUser();

    const outcome = await runAction(UUID);
    expect(outcome).toMatchObject({ redirected: false, data: { error: "consumed" } });
    const members = await db
      .select()
      .from(project_members)
      .where(eq(project_members.project_id, project));
    expect(members).toHaveLength(1);
  });

  it("refuses a revoked invite", async () => {
    const owner = await seedUser();
    const project = await seedProject(owner);
    await seedInvite({
      projectId: project,
      token: UUID,
      revokedAt: new Date().toISOString(),
    });
    sessionUserId = await seedUser();

    const outcome = await runAction(UUID);
    expect(outcome).toMatchObject({ redirected: false, data: { error: "revoked" } });
  });

  it("refuses a course join code, admitting nobody to the course", async () => {
    const owner = await seedUser();
    const course = await seedProject(owner);
    await seedInvite({ projectId: course, token: "CLASSCODE7" });
    const student = await seedUser();
    sessionUserId = student;

    const outcome = await runAction("CLASSCODE7");
    expect(outcome).toMatchObject({ redirected: false, data: { error: "wrong_kind" } });
    const rows = await db
      .select()
      .from(project_members)
      .where(eq(project_members.user_id, student));
    expect(rows).toHaveLength(0);
  });

  it("lets only the first of two joiners through", async () => {
    const owner = await seedUser();
    const project = await seedProject(owner);
    await seedInvite({ projectId: project, token: UUID });

    sessionUserId = await seedUser();
    expect((await runAction(UUID)).redirected).toBe(true);

    sessionUserId = await seedUser();
    const second = await runAction(UUID);
    expect(second).toMatchObject({ redirected: false, data: { error: "consumed" } });
  });
});
