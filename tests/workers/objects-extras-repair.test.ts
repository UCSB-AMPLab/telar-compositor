/**
 * The objects extra-columns repair through the REAL load path, against the
 * real class, real D1 and real workerd.
 *
 * The unit tests beside it call the repair method directly, which proves what
 * the repair does but not that anything calls it: removing the call from
 * `documentRepairs` leaves every one of them green. This file drives a load —
 * an admitted socket, whose document is built from D1 — and then evicts and
 * reloads, so it also proves the repair survives a snapshot rather than being
 * re-applied to a blob that never changed.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, afterEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Y from "yjs";

import { hibernate } from "./helpers/hibernate";
import { openSocket, seedProject, stubFor, type Fixture } from "./helpers/collaboration-client";

const opened: DurableObjectStub[] = [];

afterEach(async () => {
  for (const stub of opened.splice(0)) {
    try {
      await hibernate(stub);
    } catch {
      /* the object may already be gone */
    }
  }
});

/** One object row, with whatever blob and field values the case needs. */
async function seedObject(
  fixture: Fixture,
  row: { object_id: string; object_type?: string | null; extra_columns?: string | null },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO objects (project_id, object_id, title, object_type, extra_columns, image_available)
     VALUES (?, ?, ?, ?, ?, 0)`,
  )
    .bind(
      fixture.projectId,
      row.object_id,
      `Title ${row.object_id}`,
      row.object_type ?? null,
      row.extra_columns ?? null,
    )
    .run();
}

/** Open a socket so the document loads, and hand back the object's Y.Map. */
async function loadAndRead(
  fixture: Fixture,
  objectId: string,
): Promise<{ objectType: string; extras: unknown }> {
  const stub = stubFor(fixture.projectId);
  opened.push(stub);
  await openSocket(fixture, "0");
  return runInDurableObject(stub, (instance) => {
    const ydoc = (instance as unknown as { ydoc: Y.Doc }).ydoc;
    const maps = ydoc.getArray<Y.Map<unknown>>("objects").toArray();
    const idOf = (m: Y.Map<unknown>) => {
      const v = m.get("object_id");
      return v instanceof Y.Text ? v.toString() : String(v ?? "");
    };
    if (maps.length === 0) throw new Error("no objects in the document");
    const map = maps.find((m) => idOf(m) === objectId);
    if (!map) throw new Error(`no object ${objectId}; have ${maps.map(idOf).join(",")}`);
    const held = map.get("object_type");
    return {
      objectType: held instanceof Y.Text ? held.toString() : String(held ?? ""),
      extras: map.get("extra_columns"),
    };
  });
}

describe("objects extra-columns repair on load", () => {
  it("repairs a stale blob when the document loads", async () => {
    const fixture = await seedProject("extras-repair");
    await seedObject(fixture, {
      object_id: "o1",
      object_type: null,
      extra_columns: JSON.stringify({ medium: "oil" }),
    });

    const { objectType, extras } = await loadAndRead(fixture, "o1");
    expect(objectType).toBe("oil");
    expect(extras).toBe("");
  });

  it("leaves a healthy document's blob exactly as it is", async () => {
    const fixture = await seedProject("extras-healthy");
    await seedObject(fixture, {
      object_id: "o1",
      object_type: "oil",
      extra_columns: JSON.stringify({ notes: "mine" }),
    });

    const { objectType, extras } = await loadAndRead(fixture, "o1");
    expect(objectType).toBe("oil");
    expect(JSON.parse(extras as string)).toEqual({ notes: "mine" });
  });

  it("lets the editor's value stand when the blob disagrees", async () => {
    const fixture = await seedProject("extras-conflict");
    await seedObject(fixture, {
      object_id: "o1",
      object_type: "tempera",
      extra_columns: JSON.stringify({ medium: "oil" }),
    });

    const { objectType, extras } = await loadAndRead(fixture, "o1");
    expect(objectType).toBe("tempera");
    expect(extras).toBe("");
  });

  // The repair has to reach D1 through the snapshot, or the next load repeats
  // it forever and publish keeps reading the stale row.
  it("survives an eviction and reload", async () => {
    const fixture = await seedProject("extras-persist");
    await seedObject(fixture, {
      object_id: "o1",
      object_type: null,
      extra_columns: JSON.stringify({ medium: "oil" }),
    });

    await loadAndRead(fixture, "o1");

    const stub = stubFor(fixture.projectId);
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as { flushSnapshotNow: () => Promise<boolean> })
        .flushSnapshotNow();
    });
    await hibernate(stub);

    const row = await env.DB.prepare(
      "SELECT object_type, extra_columns FROM objects WHERE project_id = ? AND object_id = 'o1'",
    )
      .bind(fixture.projectId)
      .first<{ object_type: string | null; extra_columns: string | null }>();
    expect(row?.object_type).toBe("oil");
    expect(row?.extra_columns ?? "").toBe("");

    const after = await loadAndRead(fixture, "o1");
    expect(after.objectType).toBe("oil");
  });

  // A blob whose modelled key holds a number would throw on a string method,
  // and this repair runs before the document is admitted — so the throw would
  // fail the load and every publish snapshot behind it.
  it("loads a document whose blob holds a non-string under a modelled key", async () => {
    const fixture = await seedProject("extras-nonstring");
    await seedObject(fixture, {
      object_id: "o1",
      object_type: null,
      extra_columns: '{"medium":42}',
    });

    const { objectType } = await loadAndRead(fixture, "o1");
    expect(objectType).toBe("42");
  });
});

describe("a blob key naming a non-text field", () => {
  // The repair must not write a CSV cell into a column the snapshot reads as a
  // flag: `malformedFlags` refuses the whole object's UPDATE on a string where
  // a boolean belongs, so every later edit to that object stops reaching D1.
  it("leaves the flag readable and the object still writable", async () => {
    const fixture = await seedProject("extras-bool");
    await env.DB.prepare(
      `INSERT INTO objects (project_id, object_id, title, featured, extra_columns, image_available)
       VALUES (?, 'o1', 'T', 1, ?, 0)`,
    )
      .bind(fixture.projectId, JSON.stringify({ destacado: "true" }))
      .run();

    const stub = stubFor(fixture.projectId);
    opened.push(stub);
    await openSocket(fixture, "0");

    const featured = await runInDurableObject(stub, (instance) => {
      const ydoc = (instance as unknown as { ydoc: Y.Doc }).ydoc;
      const map = ydoc.getArray<Y.Map<unknown>>("objects").toArray()[0];
      return map.get("featured");
    });
    // Still a boolean, not the string the blob held.
    expect(typeof featured).toBe("boolean");

    // And the snapshot still writes the object through.
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as { flushSnapshotNow: () => Promise<boolean> }).flushSnapshotNow();
    });
    const row = await env.DB.prepare(
      "SELECT featured, extra_columns FROM objects WHERE project_id = ? AND object_id = 'o1'",
    )
      .bind(fixture.projectId)
      .first<{ featured: number; extra_columns: string | null }>();
    expect(row?.featured).toBe(1);
    // Nothing was written into the flag, and the key is gone: the field holds a
    // value of its own, so the blob's copy has nothing left to say.
    expect(row?.extra_columns ?? "").toBe("");
  });
});
