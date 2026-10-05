/**
 * What a config repair reads from the object's answer, and when it writes D1
 * itself.
 *
 * `applied` only when the object says it applied every entry sent and refused
 * none, `refused` only when it says it applied none; anything else is
 * `uncertain`. Every outcome but `applied` writes D1 directly and none resets. The wire request
 * itself is exercised against the real object in
 * `tests/workers/config-repair-through-document.test.ts`.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/internal-marker.server", () => ({
  makeInternalMarkerHeaders: vi.fn(async () => ({ "X-Internal-Auth": "sig" })),
}));

import { repairConfigThroughDocument, repairSiteConfig } from "~/lib/config-repair.server";

/** An object whose one answer the test sets, and the requests it was sent. */
function objectAnswering(answer: () => Promise<Response>) {
  const requests: Request[] = [];
  const env = {
    SESSION_SECRET: "s",
    COLLABORATION: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          requests.push(request);
          return answer();
        },
      }),
    },
  };
  return { env, requests };
}

/** A database recording the config writes the fallback makes. */
function recordingDb(fail = false) {
  const writes: Array<Record<string, unknown>> = [];
  const db = {
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(async () => {
          if (fail) throw new Error("D1 unavailable");
          writes.push(values);
        }),
      })),
    })),
  };
  return { db: db as never, writes };
}

const ingestAnswer = (applied: number, extra: Record<string, unknown> = {}) =>
  Response.json({
    applied: { config: applied },
    skipped: { config: [] },
    refused: { config: [] },
    diagnostics: [],
    ...extra,
  });

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("repairConfigThroughDocument", () => {
  it("sends the values as the config arm's entries", async () => {
    const { env, requests } = objectAnswering(async () => ingestAnswer(2));
    await repairConfigThroughDocument(env, 7, { url: "https://o.github.io", baseurl: "/r" });
    expect(new URL(requests[0].url).pathname).toBe("/ingest-sync");
    expect(await requests[0].json()).toEqual({
      config: [
        { key: "url", value: "https://o.github.io" },
        { key: "baseurl", value: "/r" },
      ],
    });
  });

  it.each([
    ["every entry applied", async () => ingestAnswer(2), "applied"],
    ["none applied and every entry refused", async () => ingestAnswer(0, { refused: { config: [0, 1] } }), "refused"],
    ["none applied, one refused and one skipped", async () =>
      ingestAnswer(0, { refused: { config: [0] }, skipped: { config: ["baseurl"] } }), "refused"],
    ["none applied and nothing said about why", async () => ingestAnswer(0), "uncertain"],
    ["fewer applied than sent", async () => ingestAnswer(1, { refused: { config: [1] } }), "uncertain"],
    ["all applied but diagnostics", async () => ingestAnswer(2, { diagnostics: [{ arm: "config" }] }), "uncertain"],
    ["a 200 whose JSON is null", async () => Response.json(null), "uncertain"],
    ["a 200 whose JSON is an array", async () => Response.json([]), "uncertain"],
    ["a 200 without the config counts", async () => Response.json({ applied: {} }), "uncertain"],
    ["a 200 whose body is not JSON", async () => new Response("ok", { status: 200 }), "uncertain"],
    ["a halt", async () => new Response("persistence_halted", { status: 503 }), "refused"],
    ["a failed snapshot", async () => new Response("snapshot_failed", { status: 503 }), "uncertain"],
    ["a blocked snapshot", async () => new Response("snapshot_blocked", { status: 503 }), "uncertain"],
    ["a 500", async () => new Response("boom", { status: 500 }), "uncertain"],
    ["a 400", async () => new Response("Invalid JSON body", { status: 400 }), "refused"],
    ["a fetch that throws", async () => { throw new Error("unreachable"); }, "uncertain"],
  ] as const)("reads %s as %s", async (_label, answer, expected) => {
    const { env } = objectAnswering(answer);
    expect(await repairConfigThroughDocument(env, 7, { url: "https://o.github.io", baseurl: "/r" })).toBe(expected);
  });

  it("sends nothing when there is nothing to repair", async () => {
    const { env, requests } = objectAnswering(async () => ingestAnswer(0));
    expect(await repairConfigThroughDocument(env, 7, {})).toBe("applied");
    expect(requests).toEqual([]);
  });
});

describe("repairSiteConfig", () => {
  it("writes nothing to D1 when the document applied the repair", async () => {
    const { env } = objectAnswering(async () => ingestAnswer(1));
    const { db, writes } = recordingDb();
    expect(await repairSiteConfig(db, env, 7, { google_sheets_enabled: false })).toBe("applied");
    expect(writes).toEqual([]);
  });

  it.each([
    ["refused", async () => new Response("persistence_halted", { status: 503 })],
    ["uncertain", async () => { throw new Error("unreachable"); }],
  ] as const)("writes D1 directly when the outcome is %s", async (expected, answer) => {
    const { env } = objectAnswering(answer);
    const { db, writes } = recordingDb();
    expect(await repairSiteConfig(db, env, 7, { google_sheets_enabled: false, url: "https://o.github.io" })).toBe(expected);
    expect(writes).toEqual([
      expect.objectContaining({ google_sheets_enabled: false, url: "https://o.github.io" }),
    ]);
  });

  it("writes D1 and does not throw when the answer is JSON null", async () => {
    const { env } = objectAnswering(async () => Response.json(null));
    const { db, writes } = recordingDb();
    await expect(repairSiteConfig(db, env, 7, { google_sheets_enabled: false })).resolves.toBe("uncertain");
    expect(writes).toHaveLength(1);
  });

  it("does not throw when the fallback D1 write fails", async () => {
    const { env } = objectAnswering(async () => { throw new Error("unreachable"); });
    const { db } = recordingDb(true);
    await expect(repairSiteConfig(db, env, 7, { google_sheets_enabled: false })).resolves.toBe("uncertain");
  });
});
