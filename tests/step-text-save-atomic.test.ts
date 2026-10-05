/**
 * A step's text saved from a field in place (`save-step-field`) writes the
 * step and the story's timestamp together or not at all, and answers every
 * refusal as `{ ok: false }` data: an unknown column, a step that is not
 * there, an author who is not a member of its project, and a write that
 * fails. The D1 mock records a write only when it commits; the updates in a
 * `db.batch` commit together, and none of them does if any fails.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  touchFails: false,
  stepFound: true,
  member: true,
  written: [] as string[],
}));

vi.mock("~/lib/db.server", async () => {
  const schema = await vi.importActual<typeof import("~/db/schema")>("~/db/schema");
  const nameOf = (table: unknown) =>
    table === schema.steps ? "steps" : table === schema.stories ? "stories" : "other";

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
          where: () => ({ limit: async () => (state.stepFound ? [{ projectId: 42 }] : []) }),
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
  requireProjectMember: vi.fn(async () => {
    if (!state.member) throw new Response("Forbidden", { status: 403 });
  }),
  requireOwner: vi.fn(async () => undefined),
  resolveActiveProject: vi.fn(async () => null),
}));

import { action } from "~/routes/_app.stories.$storyId";

function call(fields: Record<string, string>) {
  return action({
    request: new Request("https://compositor.telar.org/stories/test-story", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ intent: "save-step-field", nonce: "n1", ...fields }).toString(),
    }),
    context: { get: () => ({ id: 7 }), cloudflare: { env: { DB: {} } } } as never,
    params: { storyId: "test-story" },
  } as never) as Promise<unknown>;
}

type Refusal = { data: { ok: false; reason: string; nonce: string }; init: ResponseInit | null };

beforeEach(() => {
  state.touchFails = false;
  state.stepFound = true;
  state.member = true;
  state.written = [];
});

describe("save-step-field", () => {
  it("writes the step and the story's timestamp, and answers ok with the nonce", async () => {
    const answer = await call({ stepId: "11", field: "answer", value: "After" });
    expect(answer).toEqual({ ok: true, intent: "save-step-field", nonce: "n1" });
    expect(state.written.sort()).toEqual(["steps", "stories"]);
  });

  it("writes nothing and answers ok: false when the story's timestamp cannot be written", async () => {
    state.touchFails = true;
    const answer = (await call({ stepId: "11", field: "answer", value: "After" })) as Refusal;
    expect(answer.data).toMatchObject({ ok: false, reason: "failed", nonce: "n1" });
    expect(answer.init?.status).toBe(500);
    expect(state.written).toEqual([]);
  });

  for (const [label, arrange, status, reason] of [
    ["a step that is not there", () => { state.stepFound = false; }, 404, "not-found"],
    ["an author who is not a member", () => { state.member = false; }, 403, "forbidden"],
  ] as const) {
    it(`answers ${label} as data, writing nothing`, async () => {
      arrange();
      const answer = (await call({ stepId: "11", field: "question", value: "Q" })) as Refusal;
      expect(answer.data).toMatchObject({ ok: false, reason, nonce: "n1" });
      expect(answer.init?.status).toBe(status);
      expect(state.written).toEqual([]);
    });
  }

  it("refuses a column that is not a step's text", async () => {
    const answer = (await call({ stepId: "11", field: "object_id", value: "x" })) as Refusal;
    expect(answer.data).toMatchObject({ ok: false, reason: "bad-request" });
    expect(answer.init?.status).toBe(400);
    expect(state.written).toEqual([]);
  });
});
