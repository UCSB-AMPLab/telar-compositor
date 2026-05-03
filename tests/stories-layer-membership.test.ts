/**
 * Tests for the story-editor `save-layer` and `autosave-layer` actions —
 * Auth-bypass fix.
 *
 * Covers the IDOR guard added by `requireProjectMember`: a signed-in user
 * who forges a `layerId` for a layer in a project they are NOT a member of
 * must receive 403, and `db.update(layers)` must not run. Happy paths
 * verify legitimate same-project edits still succeed for both intents.
 *
 * Mocking strategy mirrors `tests/homepage-autosave-landing.test.ts`: stub
 * the entire dependency graph at module boundaries and invoke `action`
 * directly. The D1 layer is mocked as a chainable Drizzle builder so we
 * can assert on whether `update` ran. The layer-project resolver chain
 * (select → from → innerJoin → innerJoin → where → limit) is mocked
 * separately so tests can return `[{ projectId }]`, `[]`, or never call it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (hoisted above imports by vi.mock)
// ---------------------------------------------------------------------------

// db.update(layers).set(...).where(...) — captured for "no mutation on 403"
// and "called once on happy path" assertions.
const updateMock = vi.fn(() => ({
  set: vi.fn(() => ({
    where: vi.fn(async () => undefined),
  })),
}));

// db.select for the layer-project resolver join.
// The resolver chain is: db.select({...}).from(layers).innerJoin(steps, ...)
//   .innerJoin(stories, ...).where(eq(layers.id, layerId)).limit(1)
// We expose the terminal `.limit()` as a mock so tests can return
// [{ projectId }] (happy path) or [] (unknown layerId).
const layerProjectLimitMock = vi.fn(async () => [{ projectId: 42 }]);

const selectMock = vi.fn(() => ({
  from: vi.fn(() => ({
    innerJoin: vi.fn(() => ({
      innerJoin: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: layerProjectLimitMock,
        })),
      })),
    })),
  })),
}));

function makeDbMock() {
  return {
    select: selectMock,
    update: updateMock,
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
    delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
  };
}

const dbMock = makeDbMock();

vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => dbMock),
}));

vi.mock("~/middleware/auth.server", () => ({
  userContext: Symbol("userContext"),
}));

vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({
      get: vi.fn(() => undefined),
    })),
    commitSession: vi.fn(async () => "cookie"),
  })),
}));

vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: vi.fn(async () => ({
    project: { id: 42 },
    userRole: "collaborator",
  })),
  requireOwner: vi.fn(async () => undefined),
  requireProjectMember: vi.fn(async () => undefined),
}));

// ---------------------------------------------------------------------------
// Imports under test (after mocks)
// ---------------------------------------------------------------------------

import { action } from "~/routes/_app.stories.$storyId";
import { requireProjectMember } from "~/lib/membership.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRequest(formFields: Record<string, string>): Request {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(formFields)) {
    form.set(key, value);
  }
  return new Request("https://compositor.telar.org/stories/test-story", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

function buildContext(
  overrides: Partial<{ user: unknown; env: Record<string, unknown> }> = {},
) {
  const user = overrides.user ?? { id: 7, encrypted_access_token: "enc-token" };
  const env = {
    ENCRYPTION_KEY: "key",
    SESSION_SECRET: "sess-secret",
    DB: {},
    ...(overrides.env ?? {}),
  };
  return {
    get: vi.fn(() => user),
    cloudflare: { env },
  } as unknown as Parameters<typeof action>[0]["context"];
}

beforeEach(() => {
  vi.clearAllMocks();
  updateMock.mockClear();
  selectMock.mockClear();
  layerProjectLimitMock.mockClear();
  // Default: layer 99 belongs to project 42 (matches default membership).
  layerProjectLimitMock.mockImplementation(async () => [{ projectId: 42 }]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const AUTOSAVE_FIELDS = ["content", "title", "button_label"] as const;

describe("stories action: save-layer / autosave-layer (CR-02 — IDOR guard)", () => {
  it("returns 403 on autosave-layer when user is not a member of the layer's project", async () => {
    vi.mocked(requireProjectMember).mockRejectedValueOnce(
      new Response("Forbidden", { status: 403 }),
    );

    const result = action({
      request: buildRequest({
        intent: "autosave-layer",
        layerId: "99",
        field: "content",
        value: "hacked",
      }),
      context: buildContext(),
      params: { storyId: "test-story" },
    } as never);

    await expect(result).rejects.toBeInstanceOf(Response);
    const err = await result.catch((e: unknown) => e as Response);
    expect(err.status).toBe(403);

    // Critical: the layer mutation must not have run.
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns 403 on save-layer when user is not a member of the layer's project", async () => {
    vi.mocked(requireProjectMember).mockRejectedValueOnce(
      new Response("Forbidden", { status: 403 }),
    );

    const result = action({
      request: buildRequest({
        intent: "save-layer",
        layerId: "99",
        content: "hacked",
        buttonLabel: "ok",
      }),
      context: buildContext(),
      params: { storyId: "test-story" },
    } as never);

    await expect(result).rejects.toBeInstanceOf(Response);
    const err = await result.catch((e: unknown) => e as Response);
    expect(err.status).toBe(403);

    expect(updateMock).not.toHaveBeenCalled();
  });

  it.each(AUTOSAVE_FIELDS)(
    "succeeds for autosave-layer field %s when the user is a project member",
    async (field) => {
      vi.mocked(requireProjectMember).mockResolvedValueOnce(undefined);

      const result = (await action({
        request: buildRequest({
          intent: "autosave-layer",
          layerId: "99",
          field,
          value: `new ${field}`,
        }),
        context: buildContext(),
        params: { storyId: "test-story" },
      } as never)) as { ok: boolean; intent: string };

      expect(result.ok).toBe(true);
      expect(result.intent).toBe("autosave-layer");

      // Two updates expected: layers row + touchStory()'s stories row.
      expect(updateMock).toHaveBeenCalledTimes(2);

      // requireProjectMember was called with the resolved projectId (42) and
      // the signed-in user's id (7), in that order.
      expect(vi.mocked(requireProjectMember)).toHaveBeenCalledWith(
        dbMock,
        42,
        7,
      );
    },
  );

  it("succeeds for save-layer when the user is a project member", async () => {
    vi.mocked(requireProjectMember).mockResolvedValueOnce(undefined);

    const result = (await action({
      request: buildRequest({
        intent: "save-layer",
        layerId: "99",
        content: "fresh content",
        buttonLabel: "Click me",
      }),
      context: buildContext(),
      params: { storyId: "test-story" },
    } as never)) as { ok: boolean; intent: string };

    expect(result.ok).toBe(true);
    expect(result.intent).toBe("save-layer");

    // Two updates expected: layers row + touchStory()'s stories row.
    expect(updateMock).toHaveBeenCalledTimes(2);

    expect(vi.mocked(requireProjectMember)).toHaveBeenCalledWith(
      dbMock,
      42,
      7,
    );
  });

  it("returns 400 on autosave-layer when layerId is missing (NaN)", async () => {
    const result = action({
      request: buildRequest({
        intent: "autosave-layer",
        // layerId omitted — Number(null) → 0 → fails Number.isFinite > 0 check
        field: "content",
        value: "x",
      }),
      context: buildContext(),
      params: { storyId: "test-story" },
    } as never);

    await expect(result).rejects.toBeInstanceOf(Response);
    const err = await result.catch((e: unknown) => e as Response);
    expect(err.status).toBe(400);

    // The layer-project lookup must not have been invoked, and neither the
    // membership check nor the mutation should run.
    expect(layerProjectLimitMock).not.toHaveBeenCalled();
    expect(vi.mocked(requireProjectMember)).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns 404 on autosave-layer when layerId does not match any layer", async () => {
    layerProjectLimitMock.mockImplementationOnce(async () => []);

    const result = action({
      request: buildRequest({
        intent: "autosave-layer",
        layerId: "999999",
        field: "content",
        value: "x",
      }),
      context: buildContext(),
      params: { storyId: "test-story" },
    } as never);

    await expect(result).rejects.toBeInstanceOf(Response);
    const err = await result.catch((e: unknown) => e as Response);
    expect(err.status).toBe(404);

    // Lookup did run, but membership check and mutation must not have.
    expect(layerProjectLimitMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(requireProjectMember)).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });
});
