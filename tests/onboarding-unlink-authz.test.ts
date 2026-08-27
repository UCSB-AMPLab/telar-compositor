/**
 * Tests for the onboarding `unlink-project` action — convenor-only guard.
 *
 * `unlink-project` cascade-deletes an entire project and every dependent
 * row. It must be restricted to the project's convenor, the same predicate
 * `requireOwner` applies to the other destructive project actions
 * (`delete-project` in `_app.account.tsx`). A collaborator, a non-member,
 * and a caller naming a project id that does not exist must all receive
 * the identical `{ ok: false, intent: "unlink-project", error: "not_found" }`
 * refusal — the response deliberately does not distinguish "not yours" from
 * "does not exist", so it cannot be used to probe for project ids — and no
 * delete may be issued.
 *
 * The no-leak case builds two genuinely different worlds: one db where the
 * requested project row EXISTS (caller simply has no membership) and one
 * where it does not exist at all. Any reintroduced existence probe that
 * branches the response would make those two payloads diverge, and the
 * assertion is byte-identical equality.
 *
 * Mocking strategy mirrors `tests/dashboard-orphan-authz.test.ts`.
 *
 * @version v1.4.5-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (hoisted above imports by vi.mock)
// ---------------------------------------------------------------------------

type DbMock = ReturnType<typeof makeDbMock>;

/**
 * `existingRow` is what an existence probe on the requested project id
 * finds: a row for a project that exists, `undefined` for one that does
 * not. Seeding it per-test is what makes "foreign project" and "absent
 * project" distinguishable to any code that looks.
 */
function makeDbMock(existingRow: { id: number } | undefined) {
  const deleted: unknown[] = [];
  return {
    deleted,
    // `.where()` is both awaitable (the cascade's story/step lookups) and
    // carries `.get()` (the single-row project existence probe).
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() =>
          Object.assign(
            Promise.resolve(existingRow ? [existingRow] : ([] as unknown[])),
            { get: vi.fn(async () => existingRow) },
          ),
        ),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    })),
    delete: vi.fn((table: unknown) => {
      deleted.push(table);
      return { where: vi.fn(async () => undefined) };
    }),
    batch: vi.fn(async () => []),
  };
}

// The db the action sees for the call currently under test.
let currentDb: DbMock;

vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => currentDb),
}));

vi.mock("~/middleware/auth.server", () => ({
  authMiddleware: vi.fn(),
  userContext: Symbol("userContext"),
}));

vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => undefined), set: vi.fn() })),
    commitSession: vi.fn(async () => "cookie"),
  })),
}));

vi.mock("~/lib/crypto.server", () => ({
  decrypt: vi.fn(async () => "user-token"),
}));

vi.mock("~/lib/membership.server", () => ({
  getUserRole: vi.fn(async () => null),
  requireOwner: vi.fn(async () => undefined),
  requireProjectMember: vi.fn(async () => undefined),
}));

vi.mock("~/lib/collab-reset.server", () => ({
  resetCollabDocIfBlobExists: vi.fn(async () => undefined),
}));

// ---------------------------------------------------------------------------
// Imports under test (after mocks)
// ---------------------------------------------------------------------------

import { action } from "~/routes/onboarding";
import { getUserRole } from "~/lib/membership.server";
import { projects } from "~/db/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A project that exists in D1 and is owned by OWNER_ID. */
const EXISTING_PROJECT_ID = 42;
/** A project id with no row in D1 at all. */
const ABSENT_PROJECT_ID = 4242;

const OWNER_ID = 7;
const INTRUDER_ID = 99;

const NOT_FOUND = {
  ok: false,
  intent: "unlink-project",
  error: "not_found",
};

function buildRequest(formFields: Record<string, string>): Request {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(formFields)) {
    form.set(key, value);
  }
  return new Request("https://compositor.telar.org/onboarding", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

function buildContext(userId: number) {
  const env = {
    ENCRYPTION_KEY: "key",
    SESSION_SECRET: "sess-secret",
    DB: {},
  };
  return {
    get: vi.fn(() => ({ id: userId, encrypted_access_token: "enc-token" })),
    cloudflare: { env },
  } as unknown as Parameters<typeof action>[0]["context"];
}

/**
 * POST `unlink-project` as `userId` against `projectId`, in a db where the
 * project row exists or not according to `exists`.
 */
function unlink(
  userId: number,
  projectId: string | number,
  { exists }: { exists: boolean },
) {
  currentDb = makeDbMock(exists ? { id: Number(projectId) } : undefined);
  return action({
    request: buildRequest({
      intent: "unlink-project",
      project_id: String(projectId),
    }),
    context: buildContext(userId),
    params: {},
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  currentDb = makeDbMock(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("onboarding action: unlink-project (convenor-only guard)", () => {
  it("refuses a collaborator with not_found and deletes nothing", async () => {
    vi.mocked(getUserRole).mockResolvedValue("collaborator");

    const result = await unlink(INTRUDER_ID, EXISTING_PROJECT_ID, {
      exists: true,
    });

    expect(result).toEqual(NOT_FOUND);
    expect(currentDb.deleted).toEqual([]);
    expect(currentDb.batch).not.toHaveBeenCalled();
  });

  it("refuses a non-member with not_found and deletes nothing", async () => {
    vi.mocked(getUserRole).mockResolvedValue(null);

    const result = await unlink(INTRUDER_ID, EXISTING_PROJECT_ID, {
      exists: true,
    });

    expect(result).toEqual(NOT_FOUND);
    expect(currentDb.deleted).toEqual([]);
    expect(currentDb.batch).not.toHaveBeenCalled();
  });

  it("gives a non-member of an existing project the same refusal as a project that does not exist", async () => {
    // Two genuinely different worlds. In the first the project row IS in
    // the db and an existence probe would find it; the caller just has no
    // membership. In the second there is no row to find. Both must produce
    // the identical payload — if a future existence check branches the
    // response, these diverge and this test fails.
    vi.mocked(getUserRole).mockResolvedValue(null);
    const foreign = await unlink(INTRUDER_ID, EXISTING_PROJECT_ID, {
      exists: true,
    });
    const foreignDeleted = [...currentDb.deleted];

    vi.mocked(getUserRole).mockResolvedValue(null);
    const absent = await unlink(INTRUDER_ID, ABSENT_PROJECT_ID, {
      exists: false,
    });

    expect(foreign).toEqual(absent);
    expect(foreign).toEqual(NOT_FOUND);
    expect(foreignDeleted).toEqual([]);
    expect(currentDb.deleted).toEqual([]);
  });

  it("checks the caller's role on the requested project", async () => {
    vi.mocked(getUserRole).mockResolvedValue("collaborator");

    await unlink(INTRUDER_ID, EXISTING_PROJECT_ID, { exists: true });

    expect(vi.mocked(getUserRole)).toHaveBeenCalledWith(
      currentDb,
      EXISTING_PROJECT_ID,
      INTRUDER_ID,
    );
  });

  it("refuses a missing or non-numeric project_id before touching the db", async () => {
    for (const bad of ["", "abc", "0", "-1"]) {
      vi.mocked(getUserRole).mockResolvedValue("convenor");

      const result = await unlink(OWNER_ID, bad, { exists: false });

      expect(result).toEqual(NOT_FOUND);
      expect(vi.mocked(getUserRole)).not.toHaveBeenCalled();
      expect(currentDb.deleted).toEqual([]);
      expect(currentDb.batch).not.toHaveBeenCalled();
      vi.clearAllMocks();
    }
  });

  it("lets the convenor unlink: cascade runs and the project row is deleted", async () => {
    vi.mocked(getUserRole).mockResolvedValue("convenor");

    const result = await unlink(OWNER_ID, EXISTING_PROJECT_ID, {
      exists: true,
    });

    expect(result).toEqual({ ok: true, intent: "unlink-project" });
    expect(currentDb.deleted).toContain(projects);
    expect(currentDb.batch).toHaveBeenCalled();
  });
});
