/**
 * This file tests the `_app.account.tsx` action — focused on the
 * `update-presence-color` intent that lets a user pick their own
 * collaboration cursor colour from the account preferences card.
 *
 * Asserts:
 *   - 401 when no userContext (anonymous).
 *   - 400 when intent is unknown.
 *   - Allow-list rejection happens BEFORE any D1 touch (XSS guard).
 *   - Happy path: setUserPresenceColor called exactly once with (user.id, color).
 *   - Response shape on success: { ok: true, intent: ..., color }.
 *
 * Mocking strategy mirrors tests/api.locale.test.ts: vi.mock("~/lib/db.server")
 * exposes a chainable drizzle spy (update().set().where()) so we can assert on
 * the update call shape without spinning up miniflare. We also mock the
 * membership helper module so the allow-list-before-D1 ordering is checked
 * by asserting `setUserPresenceColor` was never called on the rejection path.
 *
 * @version v1.2.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (must precede the action import)
// ---------------------------------------------------------------------------

const dbUpdateWhereSpy = vi.fn();
const dbUpdateSetSpy = vi.fn(() => ({ where: dbUpdateWhereSpy }));
const dbUpdateSpy = vi.fn(() => ({ set: dbUpdateSetSpy }));

vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => ({ update: dbUpdateSpy })),
}));

// Mock the membership module so we can: (a) export a stable PRESENCE_PALETTE
// the action imports, and (b) spy on setUserPresenceColor to verify ordering
// against the allow-list check.
//
// `vi.mock` is hoisted, so the factory cannot capture top-level variables.
// Instead we re-import the mocked module after the mock is registered and
// grab the spy + palette from it.
vi.mock("~/lib/membership.server", () => {
  const palette = [
    "#E47A6F",
    "#6B9FE4",
    "#6BD4A0",
    "#D4A06B",
    "#A06BD4",
    "#D46BA0",
  ];
  return {
    PRESENCE_PALETTE: palette,
    setUserPresenceColor: vi.fn().mockResolvedValue(undefined),
  };
});

import { action } from "~/routes/_app.account";
import { userContext } from "~/middleware/auth.server";
import type { AuthenticatedUser } from "~/middleware/auth.server";
import {
  PRESENCE_PALETTE as FAKE_PALETTE,
  setUserPresenceColor,
} from "~/lib/membership.server";

const setUserPresenceColorSpy = setUserPresenceColor as unknown as ReturnType<
  typeof vi.fn
>;

const REQUEST_URL = "http://localhost:5173/account";

/** Build a POST Request with a form body. */
function buildRequest(
  body: Record<string, string>,
  init: RequestInit = {},
): Request {
  return new Request(REQUEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(init.headers ?? {}),
    },
    body: new URLSearchParams(body).toString(),
    ...init,
  });
}

/** Build a context with optional user. */
function makeContext(opts: { user?: AuthenticatedUser | null } = {}) {
  const user = opts.user ?? null;
  const get = vi.fn((key: unknown) => {
    if (key === userContext) return user;
    return null;
  });
  return {
    get,
    cloudflare: { env: { DB: {} as unknown as D1Database } },
  };
}

function fakeUser(id: number = 42): AuthenticatedUser {
  return { id } as unknown as AuthenticatedUser;
}

/** Run the action and either return the value or capture a thrown Response. */
async function runAction(
  request: Request,
  context: ReturnType<typeof makeContext> = makeContext(),
): Promise<{ value?: unknown; thrown?: Response }> {
  try {
    const value = await action({
      request,
      params: {},
      context: context as never,
    } as never);
    return { value };
  } catch (thrown) {
    return { thrown: thrown as Response };
  }
}

beforeEach(() => {
  dbUpdateSpy.mockClear();
  dbUpdateSetSpy.mockClear();
  dbUpdateWhereSpy.mockClear();
  dbUpdateWhereSpy.mockResolvedValue(undefined);
  setUserPresenceColorSpy.mockClear();
  setUserPresenceColorSpy.mockResolvedValue(undefined);
});

describe("_app.account.tsx action — update-presence-color", () => {
  it("rejects when no userContext (anonymous) with 401", async () => {
    const req = buildRequest({
      intent: "update-presence-color",
      color: FAKE_PALETTE[0],
    });
    const ctx = makeContext({ user: null });
    const { thrown } = await runAction(req, ctx);
    expect(thrown).toBeInstanceOf(Response);
    expect(thrown?.status).toBe(401);
    // Defence-in-depth: no D1 touch on the anonymous path either.
    expect(setUserPresenceColorSpy).not.toHaveBeenCalled();
  });

  it("rejects a color not in PRESENCE_PALETTE without touching D1", async () => {
    const req = buildRequest({
      intent: "update-presence-color",
      // a devtools-bypass attempt: arbitrary hex not in the palette
      color: "red;background:url(x)",
    });
    const ctx = makeContext({ user: fakeUser(42) });
    const { value } = await runAction(req, ctx);
    expect(value).toEqual({
      ok: false,
      intent: "update-presence-color",
      error: "invalid_color",
    });
    // XSS guard: helper must NOT have been called.
    expect(setUserPresenceColorSpy).not.toHaveBeenCalled();
  });

  it("updates project_members.presence_color via setUserPresenceColor on the happy path", async () => {
    const req = buildRequest({
      intent: "update-presence-color",
      color: FAKE_PALETTE[3],
    });
    const ctx = makeContext({ user: fakeUser(42) });
    const { value } = await runAction(req, ctx);

    expect(setUserPresenceColorSpy).toHaveBeenCalledTimes(1);
    // Helper is called with (db, userId, color) — userId comes from the
    // server-side userContext, not from the form.
    const [, userIdArg, colorArg] =
      setUserPresenceColorSpy.mock.calls[0] ?? [];
    expect(userIdArg).toBe(42);
    expect(colorArg).toBe(FAKE_PALETTE[3]);
    expect(value).toEqual({
      ok: true,
      intent: "update-presence-color",
      color: FAKE_PALETTE[3],
    });
  });

  it("returns ok=true with the saved colour on happy path (every palette member)", async () => {
    for (const color of FAKE_PALETTE) {
      setUserPresenceColorSpy.mockClear();
      const req = buildRequest({ intent: "update-presence-color", color });
      const ctx = makeContext({ user: fakeUser(11) });
      const { value } = await runAction(req, ctx);
      expect(value).toEqual({
        ok: true,
        intent: "update-presence-color",
        color,
      });
      expect(setUserPresenceColorSpy).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects unknown intent without touching the presence helper", async () => {
    // The unknown-intent contract: instead of throwing a 400 Response, the
    // action returns an error object so the client can branch without
    // try/catch. Security property unchanged — setUserPresenceColor must
    // never run.
    //
    // NOTE: the placeholder intent here MUST NOT match any real switch case
    // in the action handler. `delete-account` is now a real intent, so this
    // test uses a clearly-fictional intent string instead.
    const req = buildRequest({
      intent: "fly-to-mars",
      projectId: "123",
    });
    const ctx = makeContext({ user: fakeUser(1) });
    const { value } = await runAction(req, ctx);
    expect(value).toMatchObject({
      ok: false,
      intent: "fly-to-mars",
      error: "unknown_intent",
    });
    expect(setUserPresenceColorSpy).not.toHaveBeenCalled();
  });

  it("allow-list check precedes the membership helper call (XSS ordering)", async () => {
    // Track invocation order: if the helper is called BEFORE we can verify
    // the color, the order array is wrong. We rig the spy to record on call.
    const order: string[] = [];
    setUserPresenceColorSpy.mockImplementation(async () => {
      order.push("helper");
    });
    // Submit an invalid colour — helper should NEVER be invoked at all.
    const reqInvalid = buildRequest({
      intent: "update-presence-color",
      color: "#deadbeef",
    });
    const ctxInvalid = makeContext({ user: fakeUser(1) });
    await runAction(reqInvalid, ctxInvalid);
    expect(order).toEqual([]);
    // Sanity: a valid colour DOES trigger the helper.
    const reqValid = buildRequest({
      intent: "update-presence-color",
      color: FAKE_PALETTE[0],
    });
    const ctxValid = makeContext({ user: fakeUser(1) });
    await runAction(reqValid, ctxValid);
    expect(order).toEqual(["helper"]);
  });
});
