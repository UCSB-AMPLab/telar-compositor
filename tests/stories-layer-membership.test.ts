/**
 * Tests for the story-editor `save-layer`, `autosave-layer`,
 * `capture-position`, and `change-object` actions — IDOR guard.
 *
 * Covers the IDOR guard added by `requireProjectMember`: a signed-in user
 * who forges a `layerId` (layer intents) or `stepId` (step intents) for an
 * entity in a project they are NOT a member of must receive 403, and the
 * corresponding `db.update` must not run. Happy paths verify legitimate
 * same-project edits still succeed.
 *
 * Mocking strategy mirrors `tests/homepage-autosave-landing.test.ts`: stub
 * the entire dependency graph at module boundaries and invoke `action`
 * directly. The D1 layer is mocked as a chainable Drizzle builder so we
 * can assert on whether `update` ran.
 *
 * Two resolver chains exist:
 *   - layer-project (save-layer / autosave-layer):
 *     select → from(layers) → innerJoin(steps) → innerJoin(stories) → where → limit
 *   - step-project (capture-position / change-object):
 *     select → from(steps) → innerJoin(stories) → where → limit
 * The shared `selectMock` exposes a `.limit()` at BOTH the one-join and
 * two-join depths, both delegating to `entityProjectLimitMock`, so a test can
 * set the resolved projectId (or [] for not-found) for either intent family.
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

// db.select for the entity-project resolver joins. Two chain depths share one
// terminal mock:
//   layer: from → innerJoin(steps) → innerJoin(stories) → where → limit
//   step:  from → innerJoin(stories) → where → limit
// The first innerJoin returns an object exposing BOTH `innerJoin` (layer path)
// AND `where` (step path), each terminating in `entityProjectLimitMock`. Tests
// set its resolution to [{ projectId }] (happy path) or [] (unknown id).
const entityProjectLimitMock = vi.fn(async () => [{ projectId: 42 }]);
// Back-compat alias for existing layer assertions.
const layerProjectLimitMock = entityProjectLimitMock;

const whereWithLimit = () => ({ limit: entityProjectLimitMock });

const selectMock = vi.fn(() => ({
  from: vi.fn(() => ({
    innerJoin: vi.fn(() => ({
      // step-project path terminates here (one innerJoin)
      where: vi.fn(whereWithLimit),
      // layer-project path needs a second innerJoin
      innerJoin: vi.fn(() => ({
        where: vi.fn(whereWithLimit),
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

describe("stories action: save-layer / autosave-layer (IDOR guard)", () => {
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
    const err = (await result.catch((e: unknown) => e)) as Response;
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
    const err = (await result.catch((e: unknown) => e)) as Response;
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
    const err = (await result.catch((e: unknown) => e)) as Response;
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
    const err = (await result.catch((e: unknown) => e)) as Response;
    expect(err.status).toBe(404);

    // Lookup did run, but membership check and mutation must not have.
    expect(layerProjectLimitMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(requireProjectMember)).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// capture-position / change-object IDOR guard
// ---------------------------------------------------------------------------

describe("stories action: capture-position / change-object (IDOR guard)", () => {
  it("returns 403 on capture-position when user is not a member of the step's project", async () => {
    vi.mocked(requireProjectMember).mockRejectedValueOnce(
      new Response("Forbidden", { status: 403 }),
    );

    const result = action({
      request: buildRequest({
        intent: "capture-position",
        stepId: "55",
        x: "0.5",
        y: "0.5",
        zoom: "1",
        page: "1",
      }),
      context: buildContext(),
      params: { storyId: "test-story" },
    } as never);

    await expect(result).rejects.toBeInstanceOf(Response);
    const err = (await result.catch((e: unknown) => e)) as Response;
    expect(err.status).toBe(403);

    // Critical: the step mutation must not have run.
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns 403 on change-object when user is not a member of the step's project", async () => {
    vi.mocked(requireProjectMember).mockRejectedValueOnce(
      new Response("Forbidden", { status: 403 }),
    );

    const result = action({
      request: buildRequest({
        intent: "change-object",
        stepId: "55",
        objectId: "obj-hacked",
      }),
      context: buildContext(),
      params: { storyId: "test-story" },
    } as never);

    await expect(result).rejects.toBeInstanceOf(Response);
    const err = (await result.catch((e: unknown) => e)) as Response;
    expect(err.status).toBe(403);

    expect(updateMock).not.toHaveBeenCalled();
  });

  it("succeeds for capture-position when the user is a project member", async () => {
    vi.mocked(requireProjectMember).mockResolvedValueOnce(undefined);

    const result = (await action({
      request: buildRequest({
        intent: "capture-position",
        stepId: "55",
        x: "0.2",
        y: "0.8",
        zoom: "2.5",
        page: "3",
      }),
      context: buildContext(),
      params: { storyId: "test-story" },
    } as never)) as { ok: boolean; intent: string };

    expect(result.ok).toBe(true);
    expect(result.intent).toBe("capture-position");

    // Two updates expected: steps row + touchStory()'s stories row.
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(vi.mocked(requireProjectMember)).toHaveBeenCalledWith(dbMock, 42, 7);
  });

  it("succeeds for change-object when the user is a project member", async () => {
    vi.mocked(requireProjectMember).mockResolvedValueOnce(undefined);

    const result = (await action({
      request: buildRequest({
        intent: "change-object",
        stepId: "55",
        objectId: "obj-legit",
      }),
      context: buildContext(),
      params: { storyId: "test-story" },
    } as never)) as { ok: boolean; intent: string };

    expect(result.ok).toBe(true);
    expect(result.intent).toBe("change-object");

    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(vi.mocked(requireProjectMember)).toHaveBeenCalledWith(dbMock, 42, 7);
  });

  it("returns 400 on capture-position when stepId is missing (NaN)", async () => {
    const result = action({
      request: buildRequest({
        intent: "capture-position",
        // stepId omitted → Number(null) → 0 → fails Number.isFinite > 0 check
        x: "0.5",
        y: "0.5",
        zoom: "1",
        page: "1",
      }),
      context: buildContext(),
      params: { storyId: "test-story" },
    } as never);

    await expect(result).rejects.toBeInstanceOf(Response);
    const err = (await result.catch((e: unknown) => e)) as Response;
    expect(err.status).toBe(400);

    expect(entityProjectLimitMock).not.toHaveBeenCalled();
    expect(vi.mocked(requireProjectMember)).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns 404 on change-object when stepId does not match any step", async () => {
    entityProjectLimitMock.mockImplementationOnce(async () => []);

    const result = action({
      request: buildRequest({
        intent: "change-object",
        stepId: "999999",
        objectId: "obj",
      }),
      context: buildContext(),
      params: { storyId: "test-story" },
    } as never);

    await expect(result).rejects.toBeInstanceOf(Response);
    const err = (await result.catch((e: unknown) => e)) as Response;
    expect(err.status).toBe(404);

    expect(entityProjectLimitMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(requireProjectMember)).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });
});
