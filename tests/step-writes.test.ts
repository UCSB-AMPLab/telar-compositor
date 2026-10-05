/**
 * The bound write paths: the page-choice transaction itself, the live
 * resolution that decides whether it may run at all, and the non-collaborative
 * actions — `set-page` and `capture-position` — that do the same job against D1.
 *
 * A page choice is made in a dialog and lands after it, and a viewport is read
 * from the viewer and written a moment later; between the two a peer can have
 * replaced the object, reordered the steps or deleted the step. Everything here
 * is about refusing to write in those cases while still writing in the ordinary
 * one, which against D1 means an UPDATE conditioned on the object and a 409 on
 * no rows.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import {
  choosePageInStep,
  isSidebarStep,
  resolveTargetStep,
  targetKeyFor,
} from "~/lib/step-writes";
import { serializeStory } from "~/lib/publish.server";
import { parseTelarCsv } from "~/lib/import.server";

function makeStep(fields: Record<string, unknown>): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  map.set("_id", null);
  map.set("_temp_id", null);
  map.set("step_number", 1);
  map.set("kind", "media");
  map.set("object_id", "");
  map.set("x", null);
  map.set("y", null);
  map.set("zoom", null);
  map.set("page", "");
  for (const [key, value] of Object.entries(fields)) map.set(key, value);
  return map;
}

function makeDoc(steps: Array<Record<string, unknown>>) {
  const doc = new Y.Doc();
  const array = doc.getArray<Y.Map<unknown>>("steps");
  doc.transact(() => {
    array.push(steps.map((s, i) => makeStep({ step_number: i + 1, ...s })));
  });
  return { doc, array };
}

describe("choosePageInStep", () => {
  it("writes the page and clears the framing in one transaction", () => {
    const { doc, array } = makeDoc([
      { _temp_id: "a", object_id: "obj", page: "1", x: 0.2, y: 0.3, zoom: 2 },
    ]);
    const updates: Uint8Array[] = [];
    doc.on("update", (u: Uint8Array) => updates.push(u));

    choosePageInStep(doc, array.get(0), 4);

    const step = array.get(0);
    expect(step.get("page")).toBe("4");
    expect(step.get("x")).toBeNull();
    expect(step.get("y")).toBeNull();
    expect(step.get("zoom")).toBeNull();
    expect(updates).toHaveLength(1);
  });

  it("stores the page as its canonical decimal string", () => {
    const { doc, array } = makeDoc([{ _temp_id: "a", object_id: "obj" }]);
    choosePageInStep(doc, array.get(0), 1);
    expect(array.get(0).get("page")).toBe("1");
  });
});

describe("resolveTargetStep", () => {
  it("resolves a temp-id key to its step when it is the active target", () => {
    const { array } = makeDoc([{ _temp_id: "a" }, { _temp_id: "b" }]);
    const resolved = resolveTargetStep(array, "tmp:b", 2, false, isSidebarStep);
    expect(resolved).toBe(array.get(1));
  });

  it("resolves a hydrated step carrying _id and no temp id", () => {
    const { array } = makeDoc([{ _id: 7 }]);
    const resolved = resolveTargetStep(array, "id:7", 1, false, isSidebarStep);
    expect(resolved).toBe(array.get(0));
  });

  it("resolves the first included step under step 0", () => {
    const { array } = makeDoc([{ _temp_id: "a" }, { _temp_id: "b" }]);
    expect(resolveTargetStep(array, "tmp:a", 0, true, isSidebarStep)).toBe(array.get(0));
    expect(resolveTargetStep(array, "tmp:b", 0, true, isSidebarStep)).toBeNull();
  });

  it("counts the array by the sidebar's own inclusion rule", () => {
    const { array } = makeDoc([
      { _temp_id: null, _id: 0, step_number: 0 },
      { _temp_id: "b" },
    ]);
    // The malformed leading entry is not a step the sidebar shows, so the
    // temp-id step is the active target at index 1.
    expect(resolveTargetStep(array, "tmp:b", 1, false, isSidebarStep)).toBe(array.get(1));
  });

  it("refuses a key whose step has been reordered out of the active slot", () => {
    const { doc, array } = makeDoc([{ _temp_id: "a" }, { _temp_id: "b" }]);
    doc.transact(() => {
      const moved = array.get(1);
      const clone = makeStep({
        _temp_id: moved.get("_temp_id"),
        step_number: moved.get("step_number"),
      });
      array.delete(1, 1);
      array.insert(0, [clone]);
    });
    expect(resolveTargetStep(array, "tmp:b", 2, false, isSidebarStep)).toBeNull();
  });

  it("refuses a key whose step has been deleted", () => {
    const { doc, array } = makeDoc([{ _temp_id: "a" }, { _temp_id: "b" }]);
    doc.transact(() => array.delete(1, 1));
    expect(resolveTargetStep(array, "tmp:b", 2, false, isSidebarStep)).toBeNull();
  });

  /**
   * A reorder writes `order_key` and moves nothing in the array. The editor's
   * active index counts display order, so the resolver must count it too: an
   * index into array positions names a different step entirely.
   */
  it("follows a reorder made only by rewriting order keys", () => {
    const { doc, array } = makeDoc([
      { _temp_id: "a", order_key: "a0" },
      { _temp_id: "b", order_key: "a1" },
    ]);
    // A peer drags b in front of a; nothing leaves the array.
    doc.transact(() => array.get(1).set("order_key", "Zz"));

    // The step now displayed second is a, so a session naming b is stale.
    expect(resolveTargetStep(array, "tmp:b", 2, false, isSidebarStep)).toBeNull();
    expect(resolveTargetStep(array, "tmp:a", 2, false, isSidebarStep)).toBe(array.get(0));
    expect(resolveTargetStep(array, "tmp:b", 1, false, isSidebarStep)).toBe(array.get(1));
  });

  it("takes the first displayed step under step 0 after such a reorder", () => {
    const { doc, array } = makeDoc([
      { _temp_id: "a", order_key: "a0" },
      { _temp_id: "b", order_key: "a1" },
    ]);
    doc.transact(() => array.get(1).set("order_key", "Zz"));
    expect(resolveTargetStep(array, "tmp:b", 0, true, isSidebarStep)).toBe(array.get(1));
    expect(resolveTargetStep(array, "tmp:a", 0, true, isSidebarStep)).toBeNull();
  });

  it("refuses an unknown key and a null array", () => {
    const { array } = makeDoc([{ _temp_id: "a" }]);
    expect(resolveTargetStep(array, "tmp:zzz", 1, false, isSidebarStep)).toBeNull();
    expect(resolveTargetStep(null, "tmp:a", 1, false, isSidebarStep)).toBeNull();
    expect(resolveTargetStep(array, null, 1, false, isSidebarStep)).toBeNull();
  });
});

describe("targetKeyFor", () => {
  it("names a temp id before a D1 id, so the backfill does not change the key", () => {
    expect(targetKeyFor({ id: 0, _tempId: "a" })).toBe("tmp:a");
    expect(targetKeyFor({ id: 9, _tempId: "a" })).toBe("tmp:a");
    expect(targetKeyFor({ id: 9, _tempId: null })).toBe("id:9");
    expect(targetKeyFor({ id: 0, _tempId: null })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// What a chosen page publishes
// ---------------------------------------------------------------------------

describe("a chosen page through the publish serializer", () => {
  const base = {
    step_number: 1,
    kind: "media" as const,
    object_id: "codex",
    question: "Q",
    answer: "A",
    alt_text: "",
    clip_start: "",
    clip_end: "",
    loop: "",
    layers: [],
  };

  /** Write a choice over a captured step and read back what D1 would store. */
  function afterChoosing(page: number) {
    const { doc, array } = makeDoc([
      { _temp_id: "a", object_id: "codex", page: "1", x: 0.2, y: 0.3, zoom: 2 },
    ]);
    choosePageInStep(doc, array.get(0), page);
    const written = array.get(0);
    return {
      ...base,
      x: written.get("x") as number | null,
      y: written.get("y") as number | null,
      zoom: written.get("zoom") as number | null,
      page: written.get("page") as string | null,
    };
  }

  it("publishes the serializer's defaults for the cleared framing", () => {
    const { csv } = serializeStory([afterChoosing(4)], "s-chosen");
    const row = parseTelarCsv(csv)[0];
    expect(row.x).toBe("0.5");
    expect(row.y).toBe("0.5");
    expect(row.zoom).toBe("1");
    expect(row.page).toBe("4");
  });

  it("publishes page 1 as an empty cell", () => {
    const { csv } = serializeStory([afterChoosing(1)], "s-chosen");
    expect(parseTelarCsv(csv)[0].page).toBe("");
  });

  it("publishes exactly what an uncaptured step on that page publishes", () => {
    const chosen = serializeStory([afterChoosing(4)], "s-chosen").csv;
    const uncaptured = serializeStory(
      [{ ...base, x: null, y: null, zoom: null, page: "4" }],
      "s-chosen"
    ).csv;
    expect(chosen).toBe(uncaptured);
  });
});

// ---------------------------------------------------------------------------
// The `set-page` action
// ---------------------------------------------------------------------------

let affectedRows = 1;

const updateWhereMock = vi.fn(async (_condition?: unknown) => ({
  meta: { changes: affectedRows },
}));
const updateSetMock = vi.fn((_values?: Record<string, unknown>) => ({
  where: updateWhereMock,
}));
const updateMock = vi.fn(() => ({ set: updateSetMock }));

const stepProjectLimitMock = vi.fn(async () => [{ projectId: 42 }]);
const whereWithLimit = () => ({ limit: stepProjectLimitMock });
const selectMock = vi.fn(() => ({
  from: vi.fn(() => ({
    innerJoin: vi.fn(() => ({
      where: vi.fn(whereWithLimit),
      innerJoin: vi.fn(() => ({ where: vi.fn(whereWithLimit) })),
    })),
  })),
}));

const dbMock = {
  select: selectMock,
  update: updateMock,
  insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
  delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
};

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn(() => dbMock) }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => undefined) })),
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

import { action } from "~/routes/_app.stories.$storyId";
import { requireProjectMember } from "~/lib/membership.server";

function buildRequest(fields: Record<string, string>): Request {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return new Request("https://compositor.telar.org/stories/test-story", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

function buildContext() {
  return {
    get: vi.fn(() => ({ id: 7, encrypted_access_token: "enc-token" })),
    cloudflare: { env: { ENCRYPTION_KEY: "key", SESSION_SECRET: "s", DB: {} } },
  } as unknown as Parameters<typeof action>[0]["context"];
}

/**
 * The columns and bound values of a Drizzle condition, in the order the SQL
 * names them. Reading the built condition is the only way to see that the
 * UPDATE is guarded, since the D1 driver itself is mocked out.
 */
function readPredicate(node: unknown): { columns: string[]; values: unknown[] } {
  const columns: string[] = [];
  const values: unknown[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    const rec = n as Record<string, unknown>;
    const kind = (n as { constructor?: { name?: string } }).constructor?.name ?? "";
    if (kind.startsWith("SQLite") && typeof rec.name === "string") columns.push(rec.name);
    if (kind === "Param") values.push(rec.value);
    const chunks = rec.queryChunks;
    if (Array.isArray(chunks)) chunks.forEach(walk);
  };
  walk(node);
  return { columns, values };
}

function callSetPage(fields: Record<string, string>) {
  return action({
    request: buildRequest({ intent: "set-page", ...fields }),
    context: buildContext(),
    params: { storyId: "test-story" },
  } as never);
}

describe("stories action: set-page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    affectedRows = 1;
    stepProjectLimitMock.mockImplementation(async () => [{ projectId: 42 }]);
    updateWhereMock.mockImplementation(async () => ({ meta: { changes: affectedRows } }));
  });

  it("refuses a user who is not a member of the step's project", async () => {
    vi.mocked(requireProjectMember).mockRejectedValueOnce(
      new Response("Forbidden", { status: 403 })
    );
    const result = callSetPage({ stepId: "5", page: "2", expectedObjectId: "obj" });
    await expect(result).rejects.toBeInstanceOf(Response);
    expect((await result.catch((e: unknown) => e) as Response).status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "2.5", "1e300", "not-a-number"])(
    "answers 400 for a page of %s",
    async (page) => {
      const result = callSetPage({ stepId: "5", page, expectedObjectId: "obj" });
      await expect(result).rejects.toBeInstanceOf(Response);
      expect((await result.catch((e: unknown) => e) as Response).status).toBe(400);
      expect(updateMock).not.toHaveBeenCalled();
    }
  );

  it("writes the page, clears the framing, stamps updated_at and touches the story", async () => {
    const result = (await callSetPage({
      stepId: "5",
      page: "4",
      expectedObjectId: "obj",
    })) as { ok: boolean; intent: string };

    expect(result).toEqual({ ok: true, intent: "set-page" });
    const written = (updateSetMock.mock.calls[0][0] ?? {}) as Record<string, unknown>;
    expect(written.page).toBe("4");
    expect(written.x).toBeNull();
    expect(written.y).toBeNull();
    expect(written.zoom).toBeNull();
    expect(written.updated_at).toBeTruthy();
    // Two updates: the step, then touchStory's row on stories.
    expect(updateMock).toHaveBeenCalledTimes(2);
  });

  it("conditions the UPDATE on the step id and the object the chooser was opened over", async () => {
    await callSetPage({ stepId: "5", page: "4", expectedObjectId: "obj" });
    const { columns, values } = readPredicate(updateWhereMock.mock.calls[0]?.[0]);
    expect(columns).toEqual(["id", "object_id"]);
    expect(values).toEqual([5, "obj"]);
  });

  it("answers 409 and touches nothing when no row matches", async () => {
    affectedRows = 0;
    const result = callSetPage({ stepId: "5", page: "4", expectedObjectId: "obj" });
    await expect(result).rejects.toBeInstanceOf(Response);
    expect((await result.catch((e: unknown) => e) as Response).status).toBe(409);
    // Only the conditional step UPDATE ran; the story was not touched.
    expect(updateMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The `capture-position` action, guarded the same way
// ---------------------------------------------------------------------------

function callCapture(fields: Record<string, string>) {
  return action({
    request: buildRequest({
      intent: "capture-position",
      x: "0.2",
      y: "0.8",
      zoom: "2.5",
      page: "3",
      ...fields,
    }),
    context: buildContext(),
    params: { storyId: "test-story" },
  } as never);
}

describe("stories action: capture-position", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    affectedRows = 1;
    stepProjectLimitMock.mockImplementation(async () => [{ projectId: 42 }]);
    updateWhereMock.mockImplementation(async () => ({ meta: { changes: affectedRows } }));
  });

  it("writes the viewport and touches the story for a member", async () => {
    const result = (await callCapture({ stepId: "5", expectedObjectId: "obj" })) as {
      ok: boolean;
      intent: string;
    };
    expect(result).toEqual({ ok: true, intent: "capture-position" });
    const written = (updateSetMock.mock.calls[0][0] ?? {}) as Record<string, unknown>;
    expect(written).toMatchObject({ x: 0.2, y: 0.8, zoom: 2.5, page: "3" });
    expect(updateMock).toHaveBeenCalledTimes(2);
  });

  it("conditions the UPDATE on the step id and the object the viewport was read from", async () => {
    await callCapture({ stepId: "5", expectedObjectId: "obj" });
    const { columns, values } = readPredicate(updateWhereMock.mock.calls[0]?.[0]);
    expect(columns).toEqual(["id", "object_id"]);
    expect(values).toEqual([5, "obj"]);
  });

  it("answers 409 and touches nothing when a peer has replaced the object", async () => {
    affectedRows = 0;
    const result = callCapture({ stepId: "5", expectedObjectId: "obj" });
    await expect(result).rejects.toBeInstanceOf(Response);
    expect((await result.catch((e: unknown) => e) as Response).status).toBe(409);
    expect(updateMock).toHaveBeenCalledTimes(1);
  });
});
