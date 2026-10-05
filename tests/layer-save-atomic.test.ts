/**
 * A layer save writes the layer and the story's timestamp together or not at
 * all, so its answer never contradicts what was written: when the story's
 * timestamp cannot be written, the save answers `{ ok: false }` and the layer
 * is unchanged, never a changed layer reported as a failed save.
 *
 * The D1 mock records a write only when it commits. An update awaited on its
 * own commits at once; the updates in a `db.batch` commit together, and none
 * of them does if any fails. A write to `stories` fails while `touchFails` is
 * set, wherever it is issued.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  touchFails: false,
  written: [] as string[],
}));

vi.mock("~/lib/db.server", async () => {
  const schema = await vi.importActual<typeof import("~/db/schema")>("~/db/schema");
  const nameOf = (table: unknown) =>
    table === schema.layers ? "layers" : table === schema.stories ? "stories" : "other";

  /** An update that commits when awaited on its own, or as part of a batch. */
  function query(table: unknown) {
    const name = nameOf(table);
    const commit = () => {
      if (name === "stories" && state.touchFails) throw new Error("D1 unavailable");
    };
    return {
      name,
      commit,
      then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
        try {
          commit();
          state.written.push(name);
          resolve({ meta: { changes: 1 } });
        } catch (error) {
          reject(error);
        }
      },
    };
  }

  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({ where: () => ({ limit: async () => [{ projectId: 42 }] }) }),
        }),
      }),
    }),
    update: (table: unknown) => ({ set: () => ({ where: () => query(table) }) }),
    batch: async (queries: Array<ReturnType<typeof query>>) => {
      for (const q of queries) q.commit();
      for (const q of queries) state.written.push(q.name);
      return queries.map(() => ({ meta: { changes: 1 } }));
    },
  };
  return { getDb: () => db };
});

vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: () => ({ getSession: async () => ({ get: () => undefined }) }),
}));
vi.mock("~/lib/membership.server", () => ({
  requireProjectMember: vi.fn(async () => undefined),
  requireOwner: vi.fn(async () => undefined),
  resolveActiveProject: vi.fn(async () => null),
}));

import { action } from "~/routes/_app.stories.$storyId";

function request(fields: Record<string, string>): Request {
  return new Request("https://compositor.telar.org/stories/test-story", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

const context = {
  get: () => ({ id: 7, encrypted_access_token: "enc" }),
  cloudflare: { env: { DB: {} } },
} as never;

type Answer = { ok: boolean } | { data: { ok: boolean; reason?: string }; init: ResponseInit | null };

function okOf(answer: Answer): boolean {
  return "data" in answer ? answer.data.ok : answer.ok;
}

const SAVES: Array<Record<string, string>> = [
  { intent: "autosave-layer", layerId: "99", field: "content", value: "new text" },
  { intent: "save-layer", layerId: "99", content: "new text", buttonLabel: "Open" },
];

beforeEach(() => {
  state.touchFails = false;
  state.written = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe.each(SAVES)("$intent", (fields) => {
  it("writes the layer and the story's timestamp when both can be written", async () => {
    const answer = (await action({
      request: request(fields),
      context,
      params: { storyId: "test-story" },
    } as never)) as Answer;

    expect(okOf(answer)).toBe(true);
    expect(state.written.sort()).toEqual(["layers", "stories"]);
  });

  it("writes nothing and answers ok: false when the story's timestamp cannot be written", async () => {
    state.touchFails = true;
    const answer = (await action({
      request: request(fields),
      context,
      params: { storyId: "test-story" },
    } as never)) as Answer;

    expect(okOf(answer)).toBe(false);
    expect((answer as { init: ResponseInit | null }).init?.status).toBe(500);
    expect(state.written).toEqual([]);
  });
});

