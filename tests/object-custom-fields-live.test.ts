/**
 * A whole `extra_columns` blob an older browser sends is folded into the
 * object's custom-field map as the message lands, and every connected browser
 * is sent the fold with the message.
 *
 * Through the socket handler, so the fold is shown to ride the message's own
 * path: written inside its group and released with what the guard stages.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";

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
import { applyCustomBlob, customFieldsOf } from "~/lib/object-custom-map";
import { checkD1Bind } from "./helpers/d1-memory";

const LIVE_PROJECT = 42;

function liveSocket(userId: number) {
  const attachment = { userId, projectId: LIVE_PROJECT, role: "collaborator", generation: 0, membershipCheckedAt: Date.now() };
  return { send: vi.fn(), close: vi.fn(), serializeAttachment: vi.fn(), deserializeAttachment: () => attachment };
}

/** The stored document: two objects, converted as a load leaves them. */
function liveBlob(): Uint8Array {
  const doc = new Y.Doc();
  doc.transact(() => {
    for (const [id, blob] of [[5, '{"material":"wood"}'], [6, '{"material":"wood"}']] as const) {
      const m = new Y.Map<unknown>();
      m.set("_id", id);
      m.set("object_id", `o${id}`);
      m.set("created_by", 1);
      m.set("title", new Y.Text(`Object ${id}`));
      m.set("extra_columns", blob);
      doc.getArray<Y.Map<unknown>>("objects").push([m]);
      applyCustomBlob(m, blob);
    }
  }, null);
  return Y.encodeStateAsUpdate(doc);
}

function liveDO(blob: Uint8Array) {
  const sockets: ReturnType<typeof liveSocket>[] = [];
  const ctx = {
    getWebSockets: () => sockets,
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => {},
      get: async (key: string) => (key === "docGeneration" ? 0 : undefined),
      put: async () => {},
      list: async () => new Map(),
      delete: async () => 0,
    },
    acceptWebSocket: vi.fn(),
  };
  const DB = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        checkD1Bind(sql, args);
        return {
          run: async () => ({ meta: { last_row_id: 1, changes: 1 }, success: true as const }),
          all: async () => ({ results: [], success: true as const }),
          first: async () =>
            /^SELECT yjs_state/.test(sql) ? { yjs_state: blob.buffer, yjs_generation: 0, yjs_seq: 0, yjs_write: 0 } : null,
        };
      },
    }),
    batch: async () => [],
  };
  const instance = new ProjectCollaborationDO(
    ctx as never,
    { DB, SESSION_SECRET: "test", COLLABORATION: {} } as never,
  );
  (instance as unknown as { projectId: number }).projectId = LIVE_PROJECT;
  (instance as unknown as { docGeneration: number }).docGeneration = 0;
  return { instance, sockets, server: () => (instance as unknown as { ydoc: Y.Doc }).ydoc };
}

/** One client edit as the sync update message its browser sends. */
function liveUpdate(client: Y.Doc, edit: () => void): Uint8Array {
  const before = Y.encodeStateVector(client);
  client.transact(edit);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(client, before));
  return encoding.toUint8Array(enc);
}

/** `start` with every message a socket was sent applied, in order. */
function liveReceived(start: Uint8Array, socket: ReturnType<typeof liveSocket>): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, start);
  for (const [msg] of socket.send.mock.calls as Array<[Uint8Array]>) {
    const decoder = decoding.createDecoder(msg);
    decoding.readVarUint(decoder);
    syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), doc, null);
  }
  return doc;
}

const liveObject = (doc: Y.Doc, id: number) =>
  doc.getArray<Y.Map<unknown>>("objects").toArray().find((m) => m.get("_id") === id)!;

describe("an older browser's whole blob over the socket", () => {
  it("is folded into the map as it lands, and the fold reaches the sender and the peers", async () => {
    const blob = liveBlob();
    const { instance, sockets, server } = liveDO(blob);
    const older = liveSocket(2);
    const current = liveSocket(3);
    sockets.push(older, current);
    const client = new Y.Doc();
    Y.applyUpdate(client, blob);
    const message = liveUpdate(client, () => {
      liveObject(client, 5).set("extra_columns", '{"material":"inlaid","technique":"carved"}');
    });

    await (instance as unknown as { webSocketMessage: (ws: unknown, m: Uint8Array) => Promise<void> }).webSocketMessage(older, message);

    expect(customFieldsOf(liveObject(server(), 5))!.get("material")!.toString()).toBe("inlaid");
    for (const socket of [older, current]) {
      const seen = new Y.Doc();
      Y.applyUpdate(seen, blob);
      if (socket === older) Y.applyUpdate(seen, Y.encodeStateAsUpdate(client));
      const after = liveReceived(Y.encodeStateAsUpdate(seen), socket);
      expect(customFieldsOf(liveObject(after, 5))!.get("material")!.toString()).toBe("inlaid");
      expect(customFieldsOf(liveObject(after, 6))!.get("technique")!.toString()).toBe("");
    }
  });
});
