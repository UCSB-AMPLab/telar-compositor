/**
 * A page's front matter (`frontmatter`) through every path that creates or
 * re-creates a page, against the real class, real D1 and the real migration
 * chain.
 *
 * The document is the one source for the value once loaded: a load and a
 * reset set it from D1, a load from a blob that predates the key seeds it
 * without overwriting one it holds, the snapshot writes it back on UPDATE and
 * on both INSERT branches, an undo restores it with the map, and an ingest
 * sets it on each new map. NULL (never captured) and "" (a file with none) are
 * different values and stay so. Each case ends by reading both the map and the
 * D1 row.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";

import { signInternalMarker } from "../../workers/auth";
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

const KEPT = "title: Acerca de\r\n# Spanish sister\r\nlocalized_for: about\r\nlanguage: es\r\n";

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

/**
 * Pages for the fixture, one per block, slugged p1, p2, … in order. A page
 * with a NULL block is a legacy page, whose source the migration set to its
 * slug.
 */
async function seedPages(fixture: Fixture, blocks: Array<string | null>): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const row = await env.DB.prepare(
      `INSERT INTO project_pages (project_id, title, slug, body, frontmatter, frontmatter_source, "order", order_key)
       VALUES (?, ?, ?, 'Body', ?, ?, ?, ?) RETURNING id`,
    )
      .bind(fixture.projectId, `Page ${i + 1}`, `p${i + 1}`, blocks[i], blocks[i] === null ? `p${i + 1}` : null, i, `a${i}`)
      .first<{ id: number }>();
    ids.push(row!.id);
  }
  return ids;
}

async function sourceOf(pageId: number): Promise<{ slug: string; frontmatter: string | null; frontmatter_source: string | null }> {
  const row = await env.DB.prepare("SELECT slug, frontmatter, frontmatter_source FROM project_pages WHERE id = ?")
    .bind(pageId)
    .first<{ slug: string; frontmatter: string | null; frontmatter_source: string | null }>();
  return row!;
}

async function d1Blocks(fixture: Fixture): Promise<Record<string, string | null>> {
  const rows = await env.DB.prepare("SELECT slug, frontmatter FROM project_pages WHERE project_id = ?")
    .bind(fixture.projectId)
    .all<{ slug: string; frontmatter: string | null }>();
  return Object.fromEntries(rows.results.map((r) => [r.slug, r.frontmatter]));
}

function pageMapsOf(instance: unknown): Y.Map<unknown>[] {
  const ydoc = (instance as unknown as { ydoc: Y.Doc }).ydoc;
  return ydoc.getArray<Y.Map<unknown>>("pages").toArray();
}

async function docBlocks(fixture: Fixture): Promise<Record<string, unknown>> {
  return runInDurableObject(stubFor(fixture.projectId), (instance) =>
    Object.fromEntries(pageMapsOf(instance).map((m) => [m.get("slug") as string, m.get("frontmatter")])),
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

describe("a page's front matter in the document and in D1", () => {
  it("is set on a fresh load and written back unchanged, NULL and \"\" kept apart", async () => {
    const fixture = await seedProject("page-fm-fresh");
    await seedPages(fixture, [KEPT, "", null]);

    await load(fixture);
    expect(await docBlocks(fixture)).toEqual({ p1: KEPT, p2: "", p3: null });

    expect(await snapshot(fixture)).toBe(200);
    expect(await d1Blocks(fixture)).toEqual({ p1: KEPT, p2: "", p3: null });
  });

  it("is seeded from D1 on a load from a blob that lacks the key, NULL included", async () => {
    const fixture = await seedProject("page-fm-backfill");
    await seedPages(fixture, [KEPT, null]);
    await load(fixture);

    const stub = stubFor(fixture.projectId);
    await runInDurableObject(stub, (instance) => {
      const maps = pageMapsOf(instance);
      maps[0].doc!.transact(() => { for (const m of maps) m.delete("frontmatter"); });
    });
    expect(await snapshot(fixture)).toBe(200);
    await hibernate(stub);

    await load(fixture);
    expect(await docBlocks(fixture)).toEqual({ p1: KEPT, p2: null });
    expect(await snapshot(fixture)).toBe(200);
    expect(await d1Blocks(fixture)).toEqual({ p1: KEPT, p2: null });
  });

  it("is left as the blob holds it when the key is present", async () => {
    const fixture = await seedProject("page-fm-held");
    const [pageId] = await seedPages(fixture, [KEPT]);
    await load(fixture);

    const stub = stubFor(fixture.projectId);
    await runInDurableObject(stub, (instance) => {
      const map = pageMapsOf(instance)[0];
      map.doc!.transact(() => map.set("frontmatter", "language: es"));
    });
    expect(await snapshot(fixture)).toBe(200);
    // D1 holding another value is a write the snapshot has not made yet.
    await env.DB.prepare("UPDATE project_pages SET frontmatter = ? WHERE id = ?").bind(KEPT, pageId).run();
    await hibernate(stub);

    await load(fixture);
    expect(await docBlocks(fixture)).toEqual({ p1: "language: es" });
    expect(await snapshot(fixture)).toBe(200);
    expect(await d1Blocks(fixture)).toEqual({ p1: "language: es" });
  });

  it("is set from D1 by a reset", async () => {
    const fixture = await seedProject("page-fm-reset");
    await seedPages(fixture, [KEPT, null]);
    await load(fixture);

    expect(await post(fixture, "/reset", "reset")).toBe(200);
    expect(await docBlocks(fixture)).toEqual({ p1: KEPT, p2: null });
    expect(await snapshot(fixture)).toBe(200);
    expect(await d1Blocks(fixture)).toEqual({ p1: KEPT, p2: null });
  });

  it("follows an edit made in the document to D1", async () => {
    const fixture = await seedProject("page-fm-edit");
    await seedPages(fixture, [KEPT]);
    const socket = await load(fixture);
    const state = await drainAcceptanceFrames(socket);

    const edited = "title: Acerca\nlanguage: es";
    sendUpdate(socket, state, (doc) => {
      doc.getArray<Y.Map<unknown>>("pages").get(0).set("frontmatter", edited);
    });
    await vi.waitFor(async () => {
      expect(await docBlocks(fixture)).toEqual({ p1: edited });
    }, { timeout: 5000 });

    expect(await snapshot(fixture)).toBe(200);
    expect(await d1Blocks(fixture)).toEqual({ p1: edited });
  });

  it("never clears a block D1 holds from a map that holds none", async () => {
    const fixture = await seedProject("page-fm-coalesce");
    const [pageId] = await seedPages(fixture, [null]);
    await load(fixture);
    // A capture written to D1 behind a document still holding NULL.
    await env.DB.prepare("UPDATE project_pages SET frontmatter = ? WHERE id = ?").bind(KEPT, pageId).run();

    expect(await snapshot(fixture)).toBe(200);
    expect(await d1Blocks(fixture)).toEqual({ p1: KEPT });
  });

  it("is stored as \"\" for a page created in the document", async () => {
    const fixture = await seedProject("page-fm-new");
    const socket = await load(fixture);
    const state = await drainAcceptanceFrames(socket);

    sendUpdate(socket, state, (doc) => {
      const m = new Y.Map<unknown>();
      m.set("_id", null);
      m.set("_temp_id", "tmp-new-page");
      m.set("created_by", fixture.userId);
      m.set("title", new Y.Text("New page"));
      m.set("slug", "new-page");
      m.set("body", new Y.Text(""));
      m.set("frontmatter", "");
      m.set("order_key", "a0");
      doc.getArray<Y.Map<unknown>>("pages").push([m]);
    });
    await vi.waitFor(async () => {
      expect(await docBlocks(fixture)).toEqual({ "new-page": "" });
    }, { timeout: 5000 });

    expect(await snapshot(fixture)).toBe(200);
    expect(await d1Blocks(fixture)).toEqual({ "new-page": "" });
  });

  it("comes back with a page deleted, snapshotted and then restored by undo", async () => {
    const fixture = await seedProject("page-fm-undo");
    const [, secondId] = await seedPages(fixture, [null, KEPT]);
    await load(fixture);
    const stub = stubFor(fixture.projectId);
    const origin = "undo-under-test";

    await runInDurableObject(stub, (instance) => {
      const ydoc = (instance as unknown as { ydoc: Y.Doc }).ydoc;
      const um = new Y.UndoManager(ydoc.getArray("pages"), { trackedOrigins: new Set([origin]) });
      (instance as unknown as { __um?: Y.UndoManager }).__um = um;
      ydoc.transact(() => { ydoc.getArray<Y.Map<unknown>>("pages").delete(1, 1); }, origin);
    });
    expect(await snapshot(fixture)).toBe(200);
    const gone = await env.DB.prepare("SELECT id FROM project_pages WHERE id = ?").bind(secondId).first();
    expect(gone).toBeNull();

    await runInDurableObject(stub, (instance) => {
      const um = (instance as unknown as { __um?: Y.UndoManager }).__um!;
      um.undo();
      um.destroy();
      delete (instance as unknown as { __um?: Y.UndoManager }).__um;
    });
    expect(await docBlocks(fixture)).toEqual({ p1: null, p2: KEPT });
    expect(await snapshot(fixture)).toBe(200);

    // The stale-id branch re-inserts the row under its own id.
    const restored = await env.DB.prepare("SELECT frontmatter FROM project_pages WHERE id = ?")
      .bind(secondId)
      .first<{ frontmatter: string | null }>();
    expect(restored?.frontmatter).toBe(KEPT);
    expect(await d1Blocks(fixture)).toEqual({ p1: null, p2: KEPT });
  });

  it("is set by an ingest that inserts pages, and NULL where the ingest carries none", async () => {
    const fixture = await seedProject("page-fm-ingest");
    await load(fixture);

    const status = await post(fixture, "/ingest-sync", "ingest-sync", {
      pages: {
        insert: [
          { slug: "acerca", title: "Acerca de", body: "Texto.", frontmatter: KEPT, created_by: fixture.userId },
          { slug: "plain", title: "Plain", body: "Body.", frontmatter: "", created_by: fixture.userId },
          { slug: "unread", title: "Unread", body: "Body.", created_by: fixture.userId },
        ],
      },
    });
    expect(status).toBe(200);
    expect(await docBlocks(fixture)).toEqual({ acerca: KEPT, plain: "", unread: null });

    expect(await snapshot(fixture)).toBe(200);
    expect(await d1Blocks(fixture)).toEqual({ acerca: KEPT, plain: "", unread: null });
  });

  it("keeps a renamed legacy page's source, so the publish reads the file it was imported as", async () => {
    const fixture = await seedProject("page-fm-rename");
    const [, legacyId] = await seedPages(fixture, [KEPT, null]);
    const socket = await load(fixture);
    const state = await drainAcceptanceFrames(socket);

    sendUpdate(socket, state, (doc) => {
      doc.getArray<Y.Map<unknown>>("pages").get(1).set("slug", "overview");
    });
    await vi.waitFor(async () => {
      expect(await docBlocks(fixture)).toEqual({ p1: KEPT, overview: null });
    }, { timeout: 5000 });

    expect(await snapshot(fixture)).toBe(200);
    expect(await sourceOf(legacyId)).toEqual({ slug: "overview", frontmatter: null, frontmatter_source: "p2" });
  });

  it("keeps the source of a legacy page the server re-keys over a slug collision", async () => {
    const fixture = await seedProject("page-fm-rekey");
    const [, legacyId] = await seedPages(fixture, [KEPT, null]);
    const socket = await load(fixture);
    const state = await drainAcceptanceFrames(socket);

    // The legacy page takes p1's slug in the document; p1's row owns it in
    // D1, so the snapshot re-keys the legacy page to a fresh slug.
    sendUpdate(socket, state, (doc) => {
      doc.getArray<Y.Map<unknown>>("pages").get(1).set("slug", "p1");
    });
    await vi.waitFor(async () => {
      expect(Object.keys(await docBlocks(fixture))).toEqual(["p1"]);
    }, { timeout: 5000 });

    expect(await snapshot(fixture)).toBe(200);
    const legacy = await sourceOf(legacyId);
    expect(legacy.slug).not.toBe("p1");
    expect(legacy.slug).not.toBe("p2");
    expect(legacy.frontmatter_source).toBe("p2");
  });

  it("is reset to \"\" through the server, which answers once D1 has it", async () => {
    const fixture = await seedProject("page-fm-reset-route");
    await seedPages(fixture, [KEPT, KEPT]);
    await load(fixture);

    const status = await post(
      fixture, "/reset-page-frontmatter?slug=p2", "reset-page-frontmatter", undefined, "p2",
    );
    expect(status).toBe(200);
    expect(await docBlocks(fixture)).toEqual({ p1: KEPT, p2: "" });
    expect(await d1Blocks(fixture)).toEqual({ p1: KEPT, p2: "" });
  });

  it("refuses a reset whose marker was signed for another page", async () => {
    const fixture = await seedProject("page-fm-reset-replay");
    await seedPages(fixture, [KEPT, KEPT]);
    await load(fixture);

    const status = await post(
      fixture, "/reset-page-frontmatter?slug=p2", "reset-page-frontmatter", undefined, "p1",
    );
    expect(status).toBe(401);
    expect(await docBlocks(fixture)).toEqual({ p1: KEPT, p2: KEPT });
  });
});
