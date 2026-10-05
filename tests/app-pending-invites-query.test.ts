/**
 * The `/_app` loader's pending-invitations query.
 *
 * The sidebar's pending list is for single-use invitation links that are
 * still awaiting a redeemer. Two rows must never reach it. A consumed
 * invite whose redeemer later deleted their account has a null `used_by`
 * but a non-null `used_at`, so `used_at` is the predicate — keyed on
 * `used_by` the spent invite would reappear with a live cancel button.
 * And a reusable course code is not an invitation: it stands for a whole
 * term, and cancelling it beside a list of pending invites would revoke a
 * class's enrolment route by accident.
 *
 * The loader runs for real against a real database; only the GitHub-facing
 * modules and the session are mocked. The positive case is what makes the
 * negatives meaningful — the loader wraps its body in a try/catch, so a
 * suite that only asserted empties would pass on a thrown loader.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";

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

const PENDING_UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const CONSUMED_UUID = "11111111-2222-4333-8444-555555555555";
const REVOKED_UUID = "66666666-7777-4888-8999-aaaaaaaaaaaa";

let convenorId = 0;
let projectId = 0;

async function seed() {
  const userRows = await db
    .insert(users)
    .values({
      github_id: 4001,
      github_login: "convenor",
      encrypted_access_token: "enc",
      encrypted_refresh_token: "enc",
      access_token_expires_at: future(),
      refresh_token_expires_at: future(),
    })
    .returning({ id: users.id });
  convenorId = userRows[0].id;

  const projectRows = await db
    .insert(projects)
    .values({
      user_id: convenorId,
      github_repo_full_name: "owner/site",
      installation_id: 1,
    })
    .returning({ id: projects.id });
  projectId = projectRows[0].id;

  await db.insert(project_members).values({
    project_id: projectId,
    user_id: convenorId,
    role: "convenor",
    joined_at: new Date().toISOString(),
  });

  await db.insert(project_invites).values([
    {
      project_id: projectId,
      token: PENDING_UUID,
      conferred_role: "collaborator",
      expires_at: future(),
    },
    {
      // Consumed, then its redeemer's account was deleted: used_by is null.
      project_id: projectId,
      token: CONSUMED_UUID,
      conferred_role: "collaborator",
      expires_at: future(),
      used_at: new Date().toISOString(),
      used_by: null,
    },
    {
      project_id: projectId,
      token: REVOKED_UUID,
      conferred_role: "collaborator",
      expires_at: future(),
      revoked_at: new Date().toISOString(),
    },
    {
      project_id: projectId,
      token: "CLASSCODE7",
      conferred_role: "collaborator",
      expires_at: future(),
    },
    {
      project_id: projectId,
      token: "STAFFCODE9",
      conferred_role: "instructor",
      expires_at: future(),
    },
  ]);

  sessionActiveProjectId = projectId;
}

async function runLoader() {
  const env = {
    DB: asD1(memory),
    SESSION_SECRET: "secret",
    ENCRYPTION_KEY: "key",
  };
  return loader({
    request: new Request("https://compositor.telar.org/objects"),
    context: {
      get: () => ({ id: convenorId, encrypted_access_token: "enc" }),
      cloudflare: { env },
    },
    params: {},
  } as never);
}

beforeEach(async () => {
  memory = createMemoryD1();
  db = drizzle(asD1(memory), { schema });
  await seed();
});

afterEach(() => {
  memory.close();
});

describe("_app loader pending invitations", () => {
  it("lists the one unspent invitation link and nothing else", async () => {
    const data = await runLoader();

    const pending = data.sidebarPendingInvites ?? [];
    expect(pending).toHaveLength(1);

    const listed = await db.select().from(project_invites);
    const pendingRow = listed.find((r) => r.token === PENDING_UUID)!;
    expect(pending[0].id).toBe(pendingRow.id);
  });

  it("keeps codes, consumed links and revoked links out of the list", async () => {
    const data = await runLoader();

    const listedIds = (data.sidebarPendingInvites ?? []).map((i) => i.id);
    const rows = await db.select().from(project_invites);
    for (const token of [CONSUMED_UUID, REVOKED_UUID, "CLASSCODE7", "STAFFCODE9"]) {
      const row = rows.find((r) => r.token === token)!;
      expect(listedIds).not.toContain(row.id);
    }
  });
});
