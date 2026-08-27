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
 * Mocking strategy mirrors `tests/dashboard-orphan-authz.test.ts`.
 *
 * @version v1.4.5-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (hoisted above imports by vi.mock)
// ---------------------------------------------------------------------------

const deleted: unknown[] = [];

function makeDbMock() {
  return {
    // `.where()` is both awaitable (the cascade's story/step lookups) and
    // carries `.get()` (the single-row project lookup).
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() =>
          Object.assign(Promise.resolve([] as unknown[]), {
            get: vi.fn(async () => ({ id: PROJECT_ID })),
          }),
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

const dbMock = makeDbMock();

vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => dbMock),
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

const PROJECT_ID = 42;
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

function unlink(userId: number) {
  return action({
    request: buildRequest({
      intent: "unlink-project",
      project_id: String(PROJECT_ID),
    }),
    context: buildContext(userId),
    params: {},
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  deleted.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("onboarding action: unlink-project (convenor-only guard)", () => {
  it("refuses a collaborator with not_found and deletes nothing", async () => {
    vi.mocked(getUserRole).mockResolvedValue("collaborator");

    const result = await unlink(INTRUDER_ID);

    expect(result).toEqual(NOT_FOUND);
    expect(deleted).toEqual([]);
    expect(dbMock.batch).not.toHaveBeenCalled();
  });

  it("refuses a non-member with not_found and deletes nothing", async () => {
    vi.mocked(getUserRole).mockResolvedValue(null);

    const result = await unlink(INTRUDER_ID);

    expect(result).toEqual(NOT_FOUND);
    expect(deleted).toEqual([]);
    expect(dbMock.batch).not.toHaveBeenCalled();
  });

  it("gives a non-member the same refusal as a project that does not exist", async () => {
    // Existence is never revealed: both a foreign project and an absent one
    // resolve to no role, and both return the identical payload.
    vi.mocked(getUserRole).mockResolvedValue(null);
    const foreign = await unlink(INTRUDER_ID);
    vi.mocked(getUserRole).mockResolvedValue(null);
    const absent = await unlink(INTRUDER_ID);

    expect(foreign).toEqual(absent);
    expect(foreign).toEqual(NOT_FOUND);
  });

  it("checks the caller's role on the requested project", async () => {
    vi.mocked(getUserRole).mockResolvedValue("collaborator");

    await unlink(INTRUDER_ID);

    expect(vi.mocked(getUserRole)).toHaveBeenCalledWith(
      dbMock,
      PROJECT_ID,
      INTRUDER_ID,
    );
  });

  it("lets the convenor unlink: cascade runs and the project row is deleted", async () => {
    vi.mocked(getUserRole).mockResolvedValue("convenor");

    const result = await unlink(OWNER_ID);

    expect(result).toEqual({ ok: true, intent: "unlink-project" });
    expect(deleted).toContain(projects);
    expect(dbMock.batch).toHaveBeenCalled();
  });
});
