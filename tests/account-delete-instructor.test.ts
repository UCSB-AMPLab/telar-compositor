/**
 * The `/account` `delete-account` action's race-guard EXISTS check must
 * exclude instructor rows (design §3): "an uncorrected instructor row
 * would block a solo student from deleting their account while
 * remove-member refuses to remove the instructor."
 *
 * Run against a real D1 database (via `createMemoryD1`), with the real
 * `deleteProjectCascade` — the point being verified is that account
 * deletion actually succeeds end-to-end for this scenario, not that a
 * mock was called.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import * as schema from "~/db/schema";
import { users, projects, project_members } from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

vi.mock("~/middleware/auth.server", () => ({
  userContext: Symbol("userContext"),
}));

vi.mock("~/i18n/i18next.server", () => ({
  getLocale: vi.fn(async () => "en"),
}));

vi.mock("~/lib/crypto.server", () => ({
  decrypt: vi.fn(async () => "decrypted-token"),
}));

vi.mock("~/lib/github.server", () => ({
  listUserInstallations: vi.fn(async () => ({ installations: [] })),
}));

import { action } from "~/routes/_app.account";

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
      github_id: 8000 + nextUser,
      github_login: `user${nextUser}`,
      encrypted_access_token: "enc",
      encrypted_refresh_token: "enc",
      access_token_expires_at: future(),
      refresh_token_expires_at: future(),
    })
    .returning({ id: users.id });
  return rows[0].id;
}

async function seedProject(ownerId: number): Promise<number> {
  const rows = await db
    .insert(projects)
    .values({
      user_id: ownerId,
      github_repo_full_name: `owner/site-${ownerId}`,
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
  const form = new URLSearchParams(fields);
  const env = {
    DB: asD1(memory),
    SESSION_SECRET: "test-session-secret",
    ENCRYPTION_KEY: "test-encryption-key",
    GITHUB_APP_SLUG: "test-app",
  };
  return action({
    request: new Request("https://compositor.telar.org/account", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
    context: {
      get: () => ({
        id: userId,
        encrypted_access_token: "enc",
        created_at: null,
      }),
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

describe("delete-account: a solo student with an instructor row on their site", () => {
  it("can delete their account — the race-guard's EXISTS check excludes instructor rows", async () => {
    const student = await seedUser();
    const site = await seedProject(student);
    const instructor = await seedUser();
    await addMember(site, instructor, "instructor");

    const res = await post(student, { intent: "delete-account" });

    // Happy path redirects (a Response), not the { ok: false,
    // error: "convened_projects_exist" } race-guard refusal.
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(302);
    expect((res as Response).headers.get("Location")).toBe(
      "/signin?reason=account_deleted",
    );

    // The user row is actually gone.
    // The row stays as a tombstone that keeps the name on their work.
    const remaining = await db.select().from(users).where(eq(users.id, student));
    expect(remaining[0].deleted_at).not.toBeNull();
    expect(remaining[0].github_id).toBe(-student);
  });

  it("is still blocked when the site ALSO carries a real collaborator (the gate itself is not disabled)", async () => {
    const convenor = await seedUser();
    const site = await seedProject(convenor);
    await addMember(site, await seedUser(), "collaborator");
    await addMember(site, await seedUser(), "instructor");

    const res = (await post(convenor, { intent: "delete-account" })) as {
      ok: boolean;
      error: string;
    };

    expect(res.ok).toBe(false);
    expect(res.error).toBe("convened_projects_exist");

    // The user row survives — the gate actually held.
    const remaining = await db.select().from(users).where(eq(users.id, convenor));
    expect(remaining).toHaveLength(1);
  });
});
