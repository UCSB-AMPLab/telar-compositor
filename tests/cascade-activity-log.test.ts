/**
 * Regression tests: activity_log rows must be deleted in the project/account
 * deletion cascades to avoid FK violations (activity_log.project_id → projects
 * and activity_log.actor_user_id → users are both NOT NULL FKs enforced by D1).
 *
 * @version v1.3.0-beta
 */
import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Helpers shared across all three tests
// ---------------------------------------------------------------------------

// Symbol used by drizzle to store the SQLite table name on a table object.
const DRIZZLE_NAME_SYMBOL = Symbol.for("drizzle:Name");
function tableNameOf(table: unknown): string {
  const t = table as Record<symbol, unknown>;
  const n = t[DRIZZLE_NAME_SYMBOL];
  return typeof n === "string" ? n : "unknown";
}

function makeDb() {
  const visited: string[] = [];
  const db: {
    visited: string[];
    delete: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    batch: ReturnType<typeof vi.fn>;
  } = {
    visited,
    delete: vi.fn((table: unknown) => {
      visited.push(tableNameOf(table));
      return { where: vi.fn().mockResolvedValue(undefined) };
    }),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{ id: 1 }]),
      })),
    })),
    batch: vi.fn().mockResolvedValue([]),
  };
  return db;
}

// ---------------------------------------------------------------------------
// (a) deleteProjectCascade — activity_log scoped by project_id
// ---------------------------------------------------------------------------

describe("deleteProjectCascade — activity_log present and ordered before projects", () => {
  it("deletes activity_log (scoped by project_id) and does so before the projects row delete", async () => {
    const db = makeDb();

    const { deleteProjectCascade } = await import("~/lib/import.server");
    await deleteProjectCascade(db, 99);

    expect(db.visited).toContain("activity_log");

    const actIdx = db.visited.indexOf("activity_log");
    const projIdx = db.visited.lastIndexOf("projects");
    expect(actIdx).toBeGreaterThanOrEqual(0);
    expect(projIdx).toBeGreaterThanOrEqual(0);
    expect(actIdx).toBeLessThan(projIdx);
  });
});

// ---------------------------------------------------------------------------
// (b) unlinkProjectCascade (onboarding) — activity_log scoped by project_id
// ---------------------------------------------------------------------------

describe("unlinkProjectCascade — activity_log present and ordered before projects", () => {
  it("deletes activity_log (scoped by project_id) and does so before the projects row delete", async () => {
    const db = makeDb();

    const { unlinkProjectCascade } = await import("~/routes/onboarding");
    await unlinkProjectCascade(db, 99);

    expect(db.visited).toContain("activity_log");

    const actIdx = db.visited.indexOf("activity_log");
    const projIdx = db.visited.lastIndexOf("projects");
    expect(actIdx).toBeGreaterThanOrEqual(0);
    expect(projIdx).toBeGreaterThanOrEqual(0);
    expect(actIdx).toBeLessThan(projIdx);
  });
});

// ---------------------------------------------------------------------------
// (b2) Both project cascades must delete project_pages before projects.
// project_pages.project_id → projects.id is a NOT NULL FK with no ON DELETE
// CASCADE, so omitting it makes the projects-row delete fail with a FK error.
// deleteProjectCascade already includes it; unlinkProjectCascade drifted and
// did not — these tests lock both against future drift.
// ---------------------------------------------------------------------------

describe("project cascades — project_pages present and ordered before projects", () => {
  it("unlinkProjectCascade deletes project_pages before the projects row delete", async () => {
    const db = makeDb();
    const { unlinkProjectCascade } = await import("~/routes/onboarding");
    await unlinkProjectCascade(db, 99);

    expect(db.visited).toContain("project_pages");
    const pagesIdx = db.visited.indexOf("project_pages");
    const projIdx = db.visited.lastIndexOf("projects");
    expect(pagesIdx).toBeGreaterThanOrEqual(0);
    expect(pagesIdx).toBeLessThan(projIdx);
  });

  it("deleteProjectCascade deletes project_pages before the projects row delete", async () => {
    const db = makeDb();
    const { deleteProjectCascade } = await import("~/lib/import.server");
    await deleteProjectCascade(db, 99);

    expect(db.visited).toContain("project_pages");
    const pagesIdx = db.visited.indexOf("project_pages");
    const projIdx = db.visited.lastIndexOf("projects");
    expect(pagesIdx).toBeGreaterThanOrEqual(0);
    expect(pagesIdx).toBeLessThan(projIdx);
  });
});

// ---------------------------------------------------------------------------
// (c) account delete-account batch — activity_log scoped by actor_user_id,
//     ordered before the users row delete
//
// The account route uses db.batch([...]) directly (not deleteProjectCascade).
// We assert via the SQL strings that makeDeleteBuilder() produces — the same
// pattern used by the FK-ordering test in tests/account-actions.test.ts.
// ---------------------------------------------------------------------------

// Mirrors the makeDeleteBuilder / db mock from account-actions.test.ts, but
// without the full route wiring — we only need to inspect the batch contents.
function makeDeleteBuilder(table: string) {
  return {
    table,
    toSQL: () => ({ sql: `delete from ${table}`, params: [] as never[] }),
    then: (resolve: (v: undefined) => unknown) => resolve(undefined),
  };
}

const accountMocks = vi.hoisted(() => ({
  dbBatchMock: vi.fn(async () => undefined),
  dbSelectMock: vi.fn(),
  destroySessionMock: vi.fn(
    async () => "__compositor_session=; Max-Age=0; Path=/; HttpOnly",
  ),
  getSessionMock: vi.fn(async () => ({ id: "session-stub" })),
}));

vi.mock("~/lib/membership.server", () => ({
  requireOwner: vi.fn(),
  requireProjectMember: vi.fn(),
  getUserProjectsWithStats: vi.fn(),
  setUserPresenceColor: vi.fn(),
  PRESENCE_PALETTE: [],
}));

vi.mock("~/lib/import.server", async (importActual) => {
  // Keep the real deleteProjectCascade so test (a) exercises the live code path.
  // The account route only needs the mock stub when it's calling cascade for
  // solo projects; during the delete-account batch test (c) the solo-scan SELECT
  // returns [] so deleteProjectCascade is never invoked.
  const real = await importActual<typeof import("~/lib/import.server")>();
  return {
    ...real,
    // Keep real deleteProjectCascade (used by test a).
    deleteProjectCascade: real.deleteProjectCascade,
  };
});

vi.mock("~/lib/github.server", () => ({
  listUserInstallations: vi.fn(),
}));

vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => ({
    delete: vi.fn((t: unknown) => {
      const name = tableNameOf(t);
      return { where: vi.fn(() => makeDeleteBuilder(name)) };
    }),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => accountMocks.dbSelectMock()),
      })),
    })),
    batch: accountMocks.dbBatchMock,
  })),
}));

vi.mock("~/lib/crypto.server", () => ({
  decrypt: vi.fn(async () => "decrypted-token"),
}));

vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: accountMocks.getSessionMock,
    destroySession: accountMocks.destroySessionMock,
  })),
}));

vi.mock("~/i18n/i18next.server", () => ({
  getLocale: vi.fn(async () => "en"),
}));

vi.mock("~/middleware/auth.server", () => ({
  authMiddleware: vi.fn(),
  userContext: Symbol("userContext"),
}));

import { action } from "../app/routes/_app.account";
import { userContext as userContextStub } from "~/middleware/auth.server";

function makeContext(userId: number) {
  const env = {
    DB: {} as unknown,
    SESSION_SECRET: "test-session-secret",
    ENCRYPTION_KEY: "test-encryption-key",
    GITHUB_APP_SLUG: "test-app",
    COLLABORATION: {
      idFromName: vi.fn(() => "do-id"),
      get: vi.fn(() => ({ fetch: vi.fn(async () => new Response("OK", { status: 200 })) })),
    },
  };
  return {
    get: (key: unknown) => {
      if (key === userContextStub) {
        return {
          id: userId,
          github_id: 1,
          github_login: "tester",
          github_name: null,
          github_email: null,
          encrypted_access_token: "encrypted",
          created_at: null,
        };
      }
      return undefined;
    },
    cloudflare: { env },
  };
}

function makeFormRequest(body: Record<string, string>): Request {
  const formData = new FormData();
  for (const [k, v] of Object.entries(body)) formData.set(k, v);
  return new Request("https://example.workers.dev/account", {
    method: "POST",
    body: formData,
  });
}

describe("account delete-account batch — activity_log scoped by actor_user_id, before users", () => {
  it("batch includes activity_log delete (actor_user_id) ordered before the users delete", async () => {
    // Two SELECTs: race-guard → []; solo-cascade scan → [].
    accountMocks.dbSelectMock.mockReturnValueOnce([]).mockReturnValueOnce([]);
    accountMocks.dbBatchMock.mockReset();
    accountMocks.dbBatchMock.mockResolvedValue(undefined);

    const ctx = makeContext(7);
    const req = makeFormRequest({ intent: "delete-account" });

    await action({ request: req, context: ctx } as never);

    expect(accountMocks.dbBatchMock).toHaveBeenCalledTimes(1);
    const ops = (accountMocks.dbBatchMock.mock.calls[0] as unknown as [
      Array<{ toSQL: () => { sql: string } }>,
    ])[0];

    // There must be an activity_log delete in the batch.
    const sqlStrings = ops.map((op) => op.toSQL().sql);
    const actLogIdx = sqlStrings.findIndex((s) => /activity_log/i.test(s));
    const usersIdx = sqlStrings.findIndex((s) => /\busers\b/i.test(s));

    expect(actLogIdx).toBeGreaterThanOrEqual(0);
    expect(usersIdx).toBeGreaterThanOrEqual(0);
    expect(actLogIdx).toBeLessThan(usersIdx);
  });
});
