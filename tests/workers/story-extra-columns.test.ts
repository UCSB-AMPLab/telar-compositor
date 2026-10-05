/**
 * A story step's kept CSV cells (`extra_columns`) through every path that
 * creates or re-creates a step, against the real class, real D1 and the real
 * migration chain.
 *
 * The document is the one source for the value: a load and a reset set it
 * from D1, a load from a blob that predates the key seeds it without
 * overwriting one it holds, the snapshot writes it back on UPDATE and on both
 * INSERT branches, an undo restores it with the map, and an ingest that
 * replaces a story's steps sets it on each new map. Each case ends by reading
 * both the map and the D1 row.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

import { signInternalMarker } from "../../workers/auth";
import { storyColumnDetail } from "~/lib/story-columns";
import { hibernate } from "./helpers/hibernate";
import {
  MESSAGE_SYNC,
  drainAcceptanceFrames,
  openSocket,
  seedProject,
  stubFor,
  type Fixture,
  type Socket,
} from "./helpers/collaboration-client";

const TEST_SECRET = "test-session-secret";

const touched = new Set<DurableObjectStub>();

afterEach(async () => {
  for (const stub of touched) {
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
      for (const ws of state.getWebSockets()) {
        try { ws.close(1000, "test over"); } catch { /* already closed */ }
      }
    });
  }
  touched.clear();
});

const KEPT = JSON.stringify({ layer3_button: "Más", layer3_content: "tercera.md" });

/** A signed internal request, with its body read so the object can be evicted. */
async function post(
  fixture: Fixture,
  path: string,
  action: string,
  body?: unknown,
  detail?: string,
): Promise<number> {
  const { sigHex, timestamp } = await signInternalMarker(fixture.projectId, TEST_SECRET, action, undefined, detail);
  const response = await stubFor(fixture.projectId).fetch(
    new Request(`https://internal${path}`, {
      method: "POST",
      headers: {
        "X-Internal-Auth": sigHex,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Project": String(fixture.projectId),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  await response.text();
  return response.status;
}

const snapshot = (fixture: Fixture) => post(fixture, "/snapshot", "snapshot");

async function storyDbId(fixture: Fixture): Promise<number> {
  const row = await env.DB.prepare("SELECT id FROM stories WHERE project_id = ? AND story_id = 's1'")
    .bind(fixture.projectId)
    .first<{ id: number }>();
  return row!.id;
}

/** Steps for the fixture's story, one per blob, numbered in order. */
async function seedSteps(fixture: Fixture, blobs: Array<string | null>): Promise<number[]> {
  const storyId = await storyDbId(fixture);
  const ids: number[] = [];
  for (let i = 0; i < blobs.length; i++) {
    const row = await env.DB.prepare(
      `INSERT INTO steps (story_id, step_number, order_key, kind, object_id, question, extra_columns)
       VALUES (?, ?, ?, 'media', 'obj', ?, ?) RETURNING id`,
    )
      .bind(storyId, i + 1, `a${i}`, `Question ${i + 1}`, blobs[i])
      .first<{ id: number }>();
    ids.push(row!.id);
  }
  return ids;
}

async function d1Extras(fixture: Fixture): Promise<Array<string | null>> {
  const rows = await env.DB.prepare(
    "SELECT extra_columns FROM steps WHERE story_id = ? ORDER BY step_number, id",
  )
    .bind(await storyDbId(fixture))
    .all<{ extra_columns: string | null }>();
  return rows.results.map((r) => r.extra_columns);
}

/** The story's step maps in the object's own document. */
function stepMapsOf(instance: unknown): Y.Map<unknown>[] {
  const ydoc = (instance as unknown as { ydoc: Y.Doc }).ydoc;
  const story = ydoc.getArray<Y.Map<unknown>>("stories").toArray()
    .find((m) => m.get("story_id") === "s1");
  if (!story) throw new Error("no story s1 in the document");
  return (story.get("steps") as Y.Array<Y.Map<unknown>>).toArray();
}

async function docExtras(fixture: Fixture): Promise<unknown[]> {
  return runInDurableObject(stubFor(fixture.projectId), (instance) =>
    stepMapsOf(instance).map((m) => m.get("extra_columns")),
  );
}

async function load(fixture: Fixture, generation = "0"): Promise<Socket> {
  touched.add(stubFor(fixture.projectId));
  return openSocket(fixture, generation);
}

function sendUpdate(socket: Socket, state: Uint8Array, mutate: (doc: Y.Doc) => void): void {
  const client = new Y.Doc();
  Y.applyUpdate(client, state);
  const before = Y.encodeStateVector(client);
  client.transact(() => mutate(client));
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(client, before));
  socket.ws.send(encoding.toUint8Array(encoder));
}

describe("a step's kept columns in the document and in D1", () => {
  it("are set on a fresh load and written back unchanged", async () => {
    const fixture = await seedProject("step-extras-fresh");
    await seedSteps(fixture, [KEPT, null]);

    await load(fixture);
    expect(await docExtras(fixture)).toEqual([KEPT, ""]);

    expect(await snapshot(fixture)).toBe(200);
    expect(await d1Extras(fixture)).toEqual([KEPT, null]);
  });

  it("are seeded from D1 on a load from a blob that lacks the key", async () => {
    const fixture = await seedProject("step-extras-backfill");
    const [stepId] = await seedSteps(fixture, [KEPT]);
    await load(fixture);

    // Plant the legacy blob: the key gone from the map, and the snapshot's
    // write of that state restored in D1 by hand.
    const stub = stubFor(fixture.projectId);
    await runInDurableObject(stub, (instance) => {
      const map = stepMapsOf(instance)[0];
      map.doc!.transact(() => map.delete("extra_columns"));
    });
    expect(await snapshot(fixture)).toBe(200);
    await env.DB.prepare("UPDATE steps SET extra_columns = ? WHERE id = ?").bind(KEPT, stepId).run();
    await hibernate(stub);

    await load(fixture);
    expect(await docExtras(fixture)).toEqual([KEPT]);
    expect(await snapshot(fixture)).toBe(200);
    expect(await d1Extras(fixture)).toEqual([KEPT]);
  });

  it("are left as the blob holds them when that is an empty string", async () => {
    const fixture = await seedProject("step-extras-cleared");
    const [stepId] = await seedSteps(fixture, [KEPT]);
    await load(fixture);

    const stub = stubFor(fixture.projectId);
    await runInDurableObject(stub, (instance) => {
      const map = stepMapsOf(instance)[0];
      map.doc!.transact(() => map.set("extra_columns", ""));
    });
    expect(await snapshot(fixture)).toBe(200);
    // D1 still holding the value is the removal the snapshot has not written.
    await env.DB.prepare("UPDATE steps SET extra_columns = ? WHERE id = ?").bind(KEPT, stepId).run();
    await hibernate(stub);

    await load(fixture);
    expect(await docExtras(fixture)).toEqual([""]);
    expect(await snapshot(fixture)).toBe(200);
    expect(await d1Extras(fixture)).toEqual([null]);
  });

  it("are set from D1 by a reset", async () => {
    const fixture = await seedProject("step-extras-reset");
    await seedSteps(fixture, [KEPT, null]);
    await load(fixture);

    expect(await post(fixture, "/reset", "reset")).toBe(200);
    expect(await docExtras(fixture)).toEqual([KEPT, ""]);
    expect(await snapshot(fixture)).toBe(200);
    expect(await d1Extras(fixture)).toEqual([KEPT, null]);
  });

  it("follow an edit made in the document to D1", async () => {
    const fixture = await seedProject("step-extras-edit");
    await seedSteps(fixture, [KEPT]);
    const socket = await load(fixture);
    const state = await drainAcceptanceFrames(socket);

    const edited = JSON.stringify({ layer3_button: "Más", layer3_content: "otra.md" });
    sendUpdate(socket, state, (doc) => {
      const story = doc.getArray<Y.Map<unknown>>("stories").get(0);
      (story.get("steps") as Y.Array<Y.Map<unknown>>).get(0).set("extra_columns", edited);
    });
    await vi.waitFor(async () => {
      expect(await docExtras(fixture)).toEqual([edited]);
    }, { timeout: 5000 });

    expect(await snapshot(fixture)).toBe(200);
    expect(await d1Extras(fixture)).toEqual([edited]);
  });

  it("come back with a step deleted, snapshotted and then restored by undo", async () => {
    const fixture = await seedProject("step-extras-undo");
    const [firstId, secondId] = await seedSteps(fixture, [null, KEPT]);
    await load(fixture);
    const stub = stubFor(fixture.projectId);
    const origin = "undo-under-test";

    await runInDurableObject(stub, (instance) => {
      const ydoc = (instance as unknown as { ydoc: Y.Doc }).ydoc;
      const um = new Y.UndoManager(ydoc.getArray("stories"), { trackedOrigins: new Set([origin]) });
      (instance as unknown as { __um?: Y.UndoManager }).__um = um;
      ydoc.transact(() => {
        const story = ydoc.getArray<Y.Map<unknown>>("stories").get(0);
        (story.get("steps") as Y.Array<Y.Map<unknown>>).delete(1, 1);
      }, origin);
    });
    expect(await snapshot(fixture)).toBe(200);
    const gone = await env.DB.prepare("SELECT id FROM steps WHERE id = ?").bind(secondId).first();
    expect(gone).toBeNull();

    await runInDurableObject(stub, (instance) => {
      const um = (instance as unknown as { __um?: Y.UndoManager }).__um!;
      um.undo();
      um.destroy();
      delete (instance as unknown as { __um?: Y.UndoManager }).__um;
    });
    expect(await docExtras(fixture)).toEqual(["", KEPT]);
    expect(await snapshot(fixture)).toBe(200);

    // The stale-id branch re-inserts the row under its own id.
    const restored = await env.DB.prepare("SELECT extra_columns FROM steps WHERE id = ?")
      .bind(secondId)
      .first<{ extra_columns: string | null }>();
    expect(restored?.extra_columns).toBe(KEPT);
    expect(await d1Extras(fixture)).toEqual([null, KEPT]);
    expect(firstId).not.toBe(secondId);
  });

  it("are set by an ingest that replaces the story's steps", async () => {
    const fixture = await seedProject("step-extras-ingest");
    await seedSteps(fixture, [null]);
    await load(fixture);

    const status = await post(fixture, "/ingest-sync", "ingest-sync", {
      stories: {
        update: [],
        insert: [{
          storyId: "s1",
          title: fixture.storyTitle,
          steps: [
            { step_number: 1, kind: "media", object_id: "obj", question: "Uno", extra_columns: KEPT },
            { step_number: 2, kind: "media", object_id: "obj", question: "Dos" },
          ],
          layers: [],
        }],
      },
    });
    expect(status).toBe(200);
    expect(await docExtras(fixture)).toEqual([KEPT, ""]);

    expect(await snapshot(fixture)).toBe(200);
    // Rows are read by question, which is distinct per step.
    const rows = await env.DB.prepare("SELECT question, extra_columns FROM steps WHERE story_id = ?")
      .bind(await storyDbId(fixture))
      .all<{ question: string; extra_columns: string | null }>();
    expect(Object.fromEntries(rows.results.map((r) => [r.question, r.extra_columns])))
      .toEqual({ Uno: KEPT, Dos: null });
  });
});

describe("removing a refused column from a story", () => {
  const removeColumn = (fixture: Fixture, storyId: string, column: string, signedFor = column) =>
    post(
      fixture,
      `/remove-story-column?${new URLSearchParams({ story: storyId, column })}`,
      "remove-story-column",
      undefined,
      storyColumnDetail(storyId, signedFor),
    );

  it("clears it from every step of the story and has D1 agree before it answers", async () => {
    const fixture = await seedProject("step-extras-remove");
    await seedSteps(fixture, [
      JSON.stringify({ _metadata: "a", nota: "una" }),
      JSON.stringify({ _metadata: "b" }),
      null,
    ]);
    const socket = await load(fixture);
    const state = await drainAcceptanceFrames(socket);

    expect(await removeColumn(fixture, "s1", "_metadata")).toBe(200);
    // No snapshot of this test's own: the route's answer is the promise.
    // The step left with no column records "{}"; the one never recorded stays
    // null in D1 and "" in the document.
    expect(await d1Extras(fixture)).toEqual([JSON.stringify({ nota: "una" }), "{}", null]);
    expect(await docExtras(fixture)).toEqual([JSON.stringify({ nota: "una" }), "{}", ""]);

    // A peer receives the change as any other edit.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, state);
    await vi.waitFor(async () => {
      const frame = await socket.next();
      const decoder = decoding.createDecoder(frame);
      if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) throw new Error("not a sync frame");
      syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), peer, null);
      const steps = (peer.getArray<Y.Map<unknown>>("stories").get(0).get("steps") as Y.Array<Y.Map<unknown>>)
        .toArray().map((m) => m.get("extra_columns"));
      expect(steps).toEqual([JSON.stringify({ nota: "una" }), "{}", ""]);
    }, { timeout: 5000 });
  });

  it("refuses a request signed for another column", async () => {
    const fixture = await seedProject("step-extras-remove-signed");
    await seedSteps(fixture, [JSON.stringify({ _metadata: "a", nota: "una" })]);
    await load(fixture);

    expect(await removeColumn(fixture, "s1", "nota", "_metadata")).toBe(401);
    expect(await d1Extras(fixture)).toEqual([JSON.stringify({ _metadata: "a", nota: "una" })]);
  });
});
