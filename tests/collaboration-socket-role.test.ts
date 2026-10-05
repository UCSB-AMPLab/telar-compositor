/**
 * The socket handshake's role parse. The attachment's role is what every
 * later gate reads — `can-delete`'s enforcement most of all, which treats an
 * unrecognised role as a DO-internal origin and exempts the socket from delete
 * enforcement altogether. The membership row's `role` is therefore parsed, not
 * cast: an unknown string is a 403, never an attachment.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { ProjectCollaborationDO, parseMemberRole } from "../workers/collaboration";
import { checkD1Bind } from "./helpers/d1-memory";

const TEST_SECRET = "test-session-secret";
const TEST_PROJECT_ID = 42;
const TEST_USER_ID = 7;

/** Marker the fake socket throws once the attachment is written, so the test
 *  stops at the assertion point instead of at the 101 Response the Node
 *  runtime will not construct. */
const ATTACHED = "__attachment-written__";

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function mintToken(userId: number): Promise<string> {
  const enc = new TextEncoder();
  const payload = base64urlEncode(
    enc.encode(JSON.stringify({ userId, createdAt: new Date().toISOString() })),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(TEST_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return `${payload}.${base64urlEncode(new Uint8Array(sig))}`;
}

/** The base row the load reads: an untagged blob no instance has claimed, which
 *  the loader tags and claims before it opens the document. A null row would be
 *  a missing project, which is a refusal rather than a load. */
const UNTAGGED_BASE = {
  yjs_state: Y.encodeStateAsUpdate(new Y.Doc()),
  yjs_generation: null,
  yjs_seq: null,
  yjs_write: 0,
};

/** D1 stub: the membership query answers with `role`; the projects row carries
 *  an untagged blob, so ensureDocLoaded tags it and opens a bare doc. */
function makeDb(role: string | null) {
  return {
    prepare(sql: string) {
      return {
        bind: (...args: unknown[]) => {
          checkD1Bind(sql, args);
          return {
            first: async () => {
              if (sql.includes("FROM project_members")) return role === null ? null : { role };
              if (/^SELECT yjs_state|^SELECT yjs_generation/.test(sql)) return UNTAGGED_BASE;
              return null;
            },
            all: async () => ({ results: [] }),
            run: async () => ({ meta: { last_row_id: 1, changes: 1 }, success: true as const }),
          };
        },
      };
    },
  };
}

function makeHarness(role: string | null) {
  const attachments: unknown[] = [];
  const ctx = {
    getWebSockets: () => [],
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
    // The upgrade reads the document generation before it accepts anything and
    // refuses with a 503 when storage cannot answer, so a store that only
    // knows about alarms would never reach the attachment this file is about.
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => {},
      get: async (key: string) => (key === "docGeneration" ? 0 : undefined),
      put: async () => {},
      // A load lists the log prefix before it tags an untagged blob.
      list: async () => new Map(),
      delete: async () => 0,
    },
    acceptWebSocket: vi.fn(),
  };
  const env = { DB: makeDb(role), SESSION_SECRET: TEST_SECRET, COLLABORATION: {} };

  const socket = {
    accept: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    serializeAttachment: (a: unknown) => {
      attachments.push(a);
      throw new Error(ATTACHED);
    },
    deserializeAttachment: () => null,
  };
  (globalThis as Record<string, unknown>).WebSocketPair = function () {
    return { 0: { ...socket }, 1: socket };
  };

  const doInstance = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    env as unknown as Env,
  );
  return { doInstance, attachments };
}

async function upgradeRequest(): Promise<Request> {
  const token = await mintToken(TEST_USER_ID);
  return new Request(`https://internal/ws/${TEST_PROJECT_ID}?token=${token}`, {
    headers: { Upgrade: "websocket" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseMemberRole", () => {
  it("accepts exactly the three membership roles", () => {
    expect(parseMemberRole("convenor")).toBe("convenor");
    expect(parseMemberRole("collaborator")).toBe("collaborator");
    expect(parseMemberRole("instructor")).toBe("instructor");
  });

  it("returns null for anything else rather than failing open", () => {
    for (const raw of ["garbage", "owner", "Convenor", "", "  instructor  "]) {
      expect(parseMemberRole(raw)).toBeNull();
    }
  });
});

describe("collaboration DO — socket attachment role", () => {
  it("refuses a member row whose role is not a recognised role", async () => {
    const { doInstance, attachments } = makeHarness("garbage");
    const res = await doInstance.fetch(await upgradeRequest());
    expect(res.status).toBe(403);
    expect(attachments).toEqual([]);
  });

  it.each(["convenor", "collaborator", "instructor"] as const)(
    "attaches a %s with the parsed role",
    async (role) => {
      const { doInstance, attachments } = makeHarness(role);
      await expect(doInstance.fetch(await upgradeRequest())).rejects.toThrow(ATTACHED);
      expect(attachments).toEqual([
        { userId: TEST_USER_ID, projectId: TEST_PROJECT_ID, role, generation: 0, membershipCheckedAt: expect.any(Number) },
      ]);
    },
  );

  it("still refuses a non-member", async () => {
    const { doInstance } = makeHarness(null);
    const res = await doInstance.fetch(await upgradeRequest());
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// The DO's own /ws/:projectId id parse (workers/auth.ts's
// parseCanonicalProjectId). Reached directly, bypassing workers/app.ts
// entirely, so this pins the object's own admission: it must accept the
// SAME single canonical spelling of a project id the worker route accepts,
// independent of whatever the worker route validated upstream. Each case
// names the mutation of the fix it would catch if the canonicalisation
// regressed.
// ---------------------------------------------------------------------------

describe("collaboration DO — project id validation on direct admission", () => {
  it.each([
    ["02", "a leading zero — the canonical form has no leading zero"],
    ["2abc", "trailing non-digit junk"],
    ["2.9", "a decimal point"],
    ["+2", "a leading sign"],
    ["%202", "a percent-encoded space before the digit"],
  ])("refuses /ws/%s (%s) with 400 before any auth or storage read", async (segment) => {
    const { doInstance, attachments } = makeHarness("convenor");
    const res = await doInstance.fetch(
      new Request(`https://internal/ws/${segment}`, { headers: { Upgrade: "websocket" } }),
    );
    expect(res.status).toBe(400);
    expect(attachments).toEqual([]);
  });

  it("still admits the canonical id", async () => {
    const { doInstance, attachments } = makeHarness("convenor");
    await expect(doInstance.fetch(await upgradeRequest())).rejects.toThrow(ATTACHED);
    expect(attachments).toEqual([
      { userId: TEST_USER_ID, projectId: TEST_PROJECT_ID, role: "convenor", generation: 0, membershipCheckedAt: expect.any(Number) },
    ]);
  });

  // Boundary and encoding cases beyond the shape mutations above. Each one
  // pins a DIFFERENT guard inside parseCanonicalProjectId/isProjectId, so
  // each names the specific check whose removal it would catch.
  it.each([
    [
      "9007199254740992",
      "one past Number.MAX_SAFE_INTEGER — the regex and the round-trip " +
        "(String(Number(segment)) === segment) both pass this value; only " +
        "isProjectId's Number.isSafeInteger check rejects it, so dropping " +
        "isProjectId from the parser would admit it",
    ],
    [
      "%32",
      "a percent-encoded digit (would decode to \"2\") — catches a parser " +
        "that decodeURIComponents the segment before validating it, since " +
        "the raw segment is never decoded here",
    ],
    [
      "٢",
      "a Unicode digit (Arabic-Indic two, U+0662) — the regex character " +
        "class [1-9][0-9]* is ASCII-only; catches a rewrite to a " +
        "Unicode-aware digit class such as \\p{Nd}",
    ],
    [
      "9".repeat(25),
      "a numeric string far past safe-integer range — the round-trip check and the safe-integer bound both reject it, so no test can discriminate the round trip alone; it guards a future widening of the digit pattern",
    ],
  ])("refuses /ws/%s (%s) with 400", async (segment) => {
    const { doInstance, attachments } = makeHarness("convenor");
    const res = await doInstance.fetch(
      new Request(`https://internal/ws/${segment}`, { headers: { Upgrade: "websocket" } }),
    );
    expect(res.status).toBe(400);
    expect(attachments).toEqual([]);
  });

  it("still admits the safe-integer boundary itself (Number.MAX_SAFE_INTEGER)", async () => {
    // Catches an off-by-one in isProjectId's bound (e.g. `>=` in place of
    // `Number.isSafeInteger`, or an accidental `< MAX_SAFE_INTEGER`) that
    // would reject a legitimate, large project id.
    const { doInstance, attachments } = makeHarness("convenor");
    const token = await mintToken(TEST_USER_ID);
    const res = doInstance.fetch(
      new Request(`https://internal/ws/9007199254740991?token=${token}`, {
        headers: { Upgrade: "websocket" },
      }),
    );
    await expect(res).rejects.toThrow(ATTACHED);
    expect(attachments).toEqual([
      { userId: TEST_USER_ID, projectId: 9007199254740991, role: "convenor", generation: 0, membershipCheckedAt: expect.any(Number) },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The DO's own path-shape check, reached directly (bypassing workers/app.ts's
// handleWsUpgrade entirely). The worker entry already refuses anything but
// exactly /ws/:projectId before it ever addresses a Durable Object, but the
// object must not depend on that upstream shape check: a request that
// reaches this handler directly with a different shape must still be
// refused with 400, not fall through to authentication and answer 401.
// ---------------------------------------------------------------------------

describe("collaboration DO — path shape validation on direct admission", () => {
  it("refuses /ws/2/extra (trailing segment) with 400, not 401", async () => {
    const { doInstance, attachments } = makeHarness("convenor");
    const res = await doInstance.fetch(
      new Request("https://internal/ws/2/extra", { headers: { Upgrade: "websocket" } }),
    );
    expect(res.status).toBe(400);
    expect(attachments).toEqual([]);
  });

  it("refuses /other/2 (wrong second segment) with 400, not 401", async () => {
    const { doInstance, attachments } = makeHarness("convenor");
    const res = await doInstance.fetch(
      new Request("https://internal/other/2", { headers: { Upgrade: "websocket" } }),
    );
    expect(res.status).toBe(400);
    expect(attachments).toEqual([]);
  });
});
