/**
 * The Durable Object types its roots before it opens the document.
 *
 * `typeProtectedRoots` has its own tests, including the negative case that
 * shows what an untyped root costs. This file pins the POSTCONDITION: however
 * it is achieved, a loaded document has its roots typed before anything reads
 * it.
 *
 * Deliberately not a test that the DO calls the helper, because it cannot be
 * one. Removing the call still leaves this passing — the load path's other
 * helpers reach for the roots by type on their way past, which is the
 * incidental typing that has been holding this up all along. What the test
 * catches is the thing that was actually unprotected: a refactor that stops
 * the roots being typed AT ALL, by whichever line was doing it.
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

import { ProjectCollaborationDO } from "../workers/collaboration";
import { signInternalMarker } from "../workers/auth";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

const PROJECT_ID = 1;
const SECRET = "test-session-secret";

function makeCtx() {
  return {
    getWebSockets: () => [] as unknown[],
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => { /* no-op */ },
      get: async (key: string) => (key === "docGeneration" ? 0 : undefined),
      put: async () => {},
      list: async () => new Map(),
      delete: async () => 0,
    },
    acceptWebSocket: vi.fn(),
  };
}

/** A stored blob with one story, written the way a live document would be. */
function storedBlob(): Uint8Array {
  const doc = new Y.Doc();
  const stories = doc.getArray<unknown>("stories");
  doc.transact(() => {
    const story = new Y.Map<unknown>();
    const steps = new Y.Array<unknown>();
    const step = new Y.Map<unknown>();
    step.set("_id", 11);
    steps.push([step]);
    story.set("_id", 7);
    story.set("story_id", "a");
    story.set("steps", steps);
    stories.push([story]);
  });
  return Y.encodeStateAsUpdate(doc);
}

function seedProject(memory: MemoryD1): void {
  memory.raw.exec("INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) VALUES (1, 1, 'u', 'e', 'e', '2099-01-01', '2099-01-01')");
  memory.raw.exec("INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (1, 1, 'o/a', 1)");
  memory.raw.exec("INSERT INTO project_config (project_id) VALUES (1)");
  memory.raw
    .prepare('INSERT INTO stories (project_id, story_id, title, "order", order_key) VALUES (?, ?, ?, ?, ?)')
    .run(PROJECT_ID, "a", "A", 0, "a000011");
  memory.raw
    .prepare("UPDATE projects SET yjs_state = ? WHERE id = ?")
    .run(storedBlob(), PROJECT_ID);
}

async function snapshotRequest(): Promise<Request> {
  const { sigHex, timestamp } = await signInternalMarker(PROJECT_ID, SECRET, "snapshot");
  return new Request("https://internal/snapshot", {
    method: "POST",
    headers: {
      "X-Internal-Auth": sigHex,
      "X-Internal-Timestamp": String(timestamp),
      "X-Internal-Project": String(PROJECT_ID),
    },
  });
}

describe("ensureDocLoaded on a warm restart", () => {
  let memory: MemoryD1;

  beforeEach(() => {
    memory = createMemoryD1();
    seedProject(memory);
  });

  it("leaves every protected root carrying its type", async () => {
    const doInstance = new ProjectCollaborationDO(
      makeCtx() as unknown as DurableObjectState,
      { DB: asD1(memory), SESSION_SECRET: SECRET, COLLABORATION: {} as unknown } as unknown as Env,
    );

    await doInstance.fetch(await snapshotRequest());

    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    const share = (ydoc as unknown as { share: Map<string, unknown> }).share;
    // Only roots the blob carried are present; each present one must be typed,
    // because `instanceof` is how both guards recognise a root at all.
    expect(share.has("stories")).toBe(true);
    expect((share.get("stories") as object).constructor.name).toBe("YArray");
    for (const name of ["objects", "glossary", "pages"]) {
      if (share.has(name)) {
        expect((share.get(name) as object).constructor.name).toBe("YArray");
      }
    }
    if (share.has("config")) {
      expect((share.get("config") as object).constructor.name).toBe("YMap");
    }
  });
});
