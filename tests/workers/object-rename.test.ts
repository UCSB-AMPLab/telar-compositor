/**
 * `/ingest-sync`'s `objects.rename` arm against the real
 * collaboration object and D1, as the rename record's completion reaches it:
 * the object, the step naming it and the layer text naming its file renamed in
 * the document and in D1, the receipt kept in the object's storage under the
 * operation id, a replay answered from it, and the arm refused beside another.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, afterEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Y from "yjs";

import { signInternalMarker } from "../../workers/auth";
import { seedProject, stubFor, type Fixture } from "./helpers/collaboration-client";

const TEST_SECRET = "test-session-secret";

const opened = new Set<DurableObjectStub>();

afterEach(async () => {
  for (const stub of opened) {
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
    });
  }
  opened.clear();
});

async function postRenameIngest(fixture: Fixture, body: unknown) {
  const { sigHex, timestamp } = await signInternalMarker(fixture.projectId, TEST_SECRET, "ingest-sync");
  const response = await stubFor(fixture.projectId).fetch(
    new Request("https://internal/ingest-sync", {
      method: "POST",
      headers: {
        "X-Internal-Auth": sigHex,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Project": String(fixture.projectId),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text.startsWith("{") ? JSON.parse(text) : text };
}

/** A project holding object `map` and one step showing it, whose layer names its file. */
async function mapProject(label: string): Promise<{ fixture: Fixture; objectId: number; stepId: number }> {
  const fixture = await seedProject(label);
  opened.add(stubFor(fixture.projectId));
  const object = await env.DB.prepare(
    "INSERT INTO objects (project_id, object_id, order_key, title) VALUES (?, 'map', 'a0', 'Map') RETURNING id",
  ).bind(fixture.projectId).first<{ id: number }>();
  const story = await env.DB.prepare("SELECT id FROM stories WHERE project_id = ?").bind(fixture.projectId).first<{ id: number }>();
  const step = await env.DB.prepare(
    "INSERT INTO steps (story_id, step_number, order_key, kind, object_id) VALUES (?, 1, 'a0', 'media', 'map') RETURNING id",
  ).bind(story!.id).first<{ id: number }>();
  await env.DB.prepare(
    "INSERT INTO layers (step_id, layer_number, order_key, title, content) VALUES (?, 1, 'a0', 'Layer', ?)",
  ).bind(step!.id, "See ![the map](map.jpg) here.").run();
  return { fixture, objectId: object!.id, stepId: step!.id };
}

function renameOf(docId: number) {
  return {
    from: "map",
    to: "city-map",
    docId,
    stepValues: ["map"],
    rules: { moved: [{ from: "map.jpg", to: "city-map.jpg" }], carouselShadowed: [], tiles: null, oldSiteId: "map" },
  };
}

async function receiptOf(fixture: Fixture, opId: number): Promise<unknown> {
  return runInDurableObject(stubFor(fixture.projectId), (_instance, state) => state.storage.get(`ingestReceipt:${opId}`));
}

async function liveObjectKeys(fixture: Fixture): Promise<unknown[]> {
  return runInDurableObject(stubFor(fixture.projectId), (instance) => {
    const ydoc = (instance as unknown as { ydoc: Y.Doc }).ydoc;
    return ydoc.getArray<Y.Map<unknown>>("objects").toArray().map((m) => m.get("object_id"));
  });
}

describe("objects.rename", () => {
  it("renames the object, the step and the layer text in the document and in D1, and receipts it", async () => {
    const { fixture, objectId, stepId } = await mapProject("rename-applies");
    const res = await postRenameIngest(fixture, { opId: 900001, objects: { rename: [renameOf(objectId)] } });

    expect(res.status).toBe(200);
    expect(res.body.renames).toMatchObject({ applied: ["city-map"], displaced: [] });
    const object = await env.DB.prepare("SELECT object_id FROM objects WHERE id = ?").bind(objectId).first();
    const step = await env.DB.prepare("SELECT object_id FROM steps WHERE id = ?").bind(stepId).first();
    const layer = await env.DB.prepare("SELECT content FROM layers WHERE step_id = ?").bind(stepId).first();
    expect(object).toEqual({ object_id: "city-map" });
    expect(step).toEqual({ object_id: "city-map" });
    expect(layer).toEqual({ content: "See ![the map](city-map.jpg) here." });
    expect(await receiptOf(fixture, 900001)).toMatchObject({ renamed: ["city-map"] });
  });

  it("answers a replay from its receipt and writes nothing", async () => {
    const { fixture, objectId } = await mapProject("rename-replay");
    await postRenameIngest(fixture, { opId: 900002, objects: { rename: [renameOf(objectId)] } });
    await runInDurableObject(stubFor(fixture.projectId), (instance) => {
      const ydoc = (instance as unknown as { ydoc: Y.Doc }).ydoc;
      const map = ydoc.getArray<Y.Map<unknown>>("objects").toArray().find((m) => m.get("_id") === objectId)!;
      ydoc.transact(() => map.set("object_id", "map"), null);
    });

    const replay = await postRenameIngest(fixture, { opId: 900002, objects: { rename: [renameOf(objectId)] } });

    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ alreadyApplied: true, receipted: { objectRename: ["city-map"] } });
    expect(await liveObjectKeys(fixture)).toEqual(["map"]);
  });

  it("is refused beside another arm, writing nothing", async () => {
    const { fixture, objectId } = await mapProject("rename-beside");
    const res = await postRenameIngest(fixture, {
      opId: 900003, objects: { rename: [renameOf(objectId)], remove: [{ objectId: "map", docId: objectId }] },
    });
    expect(res.status).toBe(400);
    const object = await env.DB.prepare("SELECT object_id FROM objects WHERE id = ?").bind(objectId).first();
    expect(object).toEqual({ object_id: "map" });
  });
});
