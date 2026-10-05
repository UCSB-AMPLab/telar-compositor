/**
 * An external object filled from its IIIF manifest by the collaboration
 * server (`/enrich-objects`), against the real class, real D1 and the real
 * migration chain, with the manifest host stubbed.
 *
 * The server is the one writer: it chooses the objects from its own document,
 * reads their manifests outside any gate, and fills only empty fields of an
 * object still naming the source it read, in one transaction. An author's
 * source change or typed title that arrives while the manifest is out is kept;
 * two requests read a manifest once; a halt, before or during the read, is
 * refused with nothing written; and the filled words are credited to nobody.
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
const SOURCE_A = "https://iiif.example/a/manifest";
const SOURCE_B = "https://iiif.example/b/manifest";

interface Internals {
  ydoc: Y.Doc;
  persistenceHalted: unknown;
  wordsByRow: Map<string, Map<string, Map<number, number>>>;
}

const opened: DurableObjectStub[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const stub of opened.splice(0)) {
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
      for (const ws of state.getWebSockets()) {
        try { ws.close(1000, "test over"); } catch { /* already closed */ }
      }
    });
  }
});

/** A v3 manifest for `url`, labelled and credited after it. */
function manifestFor(url: string): Record<string, unknown> {
  return {
    "@context": "http://iiif.io/api/presentation/3/context.json",
    id: url,
    type: "Manifest",
    label: { en: [`Title of ${url}`] },
    summary: { en: ["one two three"] },
    thumbnail: [{ id: `${url}/thumb.jpg`, type: "Image" }],
    items: [],
  };
}

/**
 * Stubs the manifest host. Each read waits on `release` when one is given,
 * so a test can act while the read is out; `reads` counts them.
 */
function stubManifests(opts: { release?: Promise<void>; fail?: boolean } = {}) {
  const reads: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    reads.push(url);
    if (opts.release) await opts.release;
    if (opts.fail) return new Response("gone", { status: 404 });
    return Response.json(manifestFor(url));
  });
  // Polled rather than signalled from inside the read: a promise the object
  // resolves would carry the test on in the object's I/O context.
  // Started only by a test that awaits it, so a test expecting no read leaves
  // no wait behind to reject.
  const readStarted = () => vi.waitFor(() => expect(reads.length).toBeGreaterThan(0), { timeout: 5000 });
  return { reads, readStarted };
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
}

async function seedObject(fixture: Fixture, sourceUrl: string, fields: { title?: string; thumbnail?: string } = {}): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO objects (project_id, object_id, title, source_url, thumbnail, order_key, image_available)
     VALUES (?, 'bell', ?, ?, ?, 'a0', 0) RETURNING id`,
  ).bind(fixture.projectId, fields.title ?? null, sourceUrl, fields.thumbnail ?? null).first<{ id: number }>();
  return row!.id;
}

async function enrich(fixture: Fixture, op = "enrich-objects"): Promise<{ status: number; body: string }> {
  const { sigHex, timestamp } = await signInternalMarker(fixture.projectId, TEST_SECRET, op);
  const response = await stubFor(fixture.projectId).fetch(
    new Request("https://internal/enrich-objects", {
      method: "POST",
      headers: {
        "X-Internal-Auth": sigHex,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Project": String(fixture.projectId),
      },
    }),
  );
  return { status: response.status, body: await response.text() };
}

async function load(fixture: Fixture): Promise<{ socket: Socket; state: Uint8Array }> {
  opened.push(stubFor(fixture.projectId));
  const socket = await openSocket(fixture, "0");
  return { socket, state: await drainAcceptanceFrames(socket) };
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

const firstObject = (doc: Y.Doc) => doc.getArray<Y.Map<unknown>>("objects").get(0);

async function objectInDocument(fixture: Fixture): Promise<Record<string, unknown>> {
  return runInDurableObject(stubFor(fixture.projectId), (instance) => {
    const entry = firstObject((instance as unknown as Internals).ydoc);
    const read = (key: string) => {
      const value = entry.get(key);
      return value instanceof Y.Text ? value.toString() : value;
    };
    return {
      title: read("title"), description: read("description"), source_url: read("source_url"),
      thumbnail: read("thumbnail"), image_available: read("image_available"),
    };
  });
}

async function serverState(fixture: Fixture): Promise<Uint8Array> {
  return runInDurableObject(stubFor(fixture.projectId), (instance) =>
    Y.encodeStateAsUpdate((instance as unknown as Internals).ydoc));
}

async function haltServer(fixture: Fixture): Promise<void> {
  await runInDurableObject(stubFor(fixture.projectId), (instance) => {
    (instance as unknown as Internals).persistenceHalted = {
      generation: 0,
      marker: { v: 1, reason: "fence_refused", at: Date.now() },
    };
  });
}

describe("an external object filled from its manifest by the server", () => {
  it("fills the empty fields, marks the image available, and reaches D1 through the snapshot", async () => {
    const fixture = await seedProject("enrich-fill");
    const id = await seedObject(fixture, SOURCE_A);
    await load(fixture);
    const { reads } = stubManifests();

    expect(await enrich(fixture)).toEqual({ status: 200, body: JSON.stringify({ filled: 1 }) });
    expect(reads).toEqual([SOURCE_A]);
    expect(await objectInDocument(fixture)).toMatchObject({
      title: `Title of ${SOURCE_A}`, description: "one two three", thumbnail: `${SOURCE_A}/thumb.jpg`, image_available: true,
    });

    const { sigHex, timestamp } = await signInternalMarker(fixture.projectId, TEST_SECRET, "snapshot");
    const snap = await stubFor(fixture.projectId).fetch(new Request("https://internal/snapshot", {
      method: "POST",
      headers: { "X-Internal-Auth": sigHex, "X-Internal-Timestamp": String(timestamp), "X-Internal-Project": String(fixture.projectId) },
    }));
    expect(snap.status).toBe(200);
    const row = await env.DB.prepare("SELECT title, thumbnail, image_available FROM objects WHERE id = ?").bind(id)
      .first<{ title: string; thumbnail: string; image_available: number }>();
    expect(row).toEqual({ title: `Title of ${SOURCE_A}`, thumbnail: `${SOURCE_A}/thumb.jpg`, image_available: 1 });
  });

  it("keeps a field the document holds, and reads nothing for an object whose thumbnail is set", async () => {
    const fixture = await seedProject("enrich-kept");
    await seedObject(fixture, SOURCE_A, { title: "Bell", thumbnail: "https://own/thumb.jpg" });
    await load(fixture);
    const { reads } = stubManifests();

    expect(await enrich(fixture)).toEqual({ status: 200, body: JSON.stringify({ filled: 0 }) });
    expect(reads).toEqual([]);
    expect(await objectInDocument(fixture)).toMatchObject({ title: "Bell", thumbnail: "https://own/thumb.jpg" });
  });

  it("writes nothing for a manifest that cannot be read", async () => {
    const fixture = await seedProject("enrich-failed");
    await seedObject(fixture, SOURCE_A);
    await load(fixture);
    stubManifests({ fail: true });

    expect(await enrich(fixture)).toEqual({ status: 200, body: JSON.stringify({ filled: 0 }) });
    const held = await objectInDocument(fixture);
    expect(held.thumbnail ?? "").toBe("");
    expect(held.image_available).not.toBe(true);
  });

  it("refuses a request without the marker for this operation", async () => {
    const fixture = await seedProject("enrich-unsigned");
    await seedObject(fixture, SOURCE_A);
    await load(fixture);
    const { reads } = stubManifests();

    expect((await enrich(fixture, "reset-page-frontmatter")).status).toBe(401);
    expect(reads).toEqual([]);
  });
});

describe("a fill racing an author", () => {
  it("writes nothing over an object whose source changed while its manifest was read", async () => {
    const fixture = await seedProject("enrich-source-race");
    await seedObject(fixture, SOURCE_A);
    const { socket, state } = await load(fixture);
    const release = gate();
    const { readStarted } = stubManifests({ release: release.promise });

    const answer = enrich(fixture);
    await readStarted();
    sendUpdate(socket, state, (doc) => firstObject(doc).set("source_url", SOURCE_B));
    await vi.waitFor(async () => expect((await objectInDocument(fixture)).source_url).toBe(SOURCE_B), { timeout: 5000 });
    release.open();

    expect(await answer).toEqual({ status: 200, body: JSON.stringify({ filled: 0 }) });
    const held = await objectInDocument(fixture);
    expect(held.title ?? "").toBe("");
    expect(held.thumbnail ?? "").toBe("");
  });

  it("keeps a title the author typed while the manifest was read", async () => {
    const fixture = await seedProject("enrich-typed-race");
    await seedObject(fixture, SOURCE_A);
    const { socket, state } = await load(fixture);
    const release = gate();
    const { readStarted } = stubManifests({ release: release.promise });

    const answer = enrich(fixture);
    await readStarted();
    sendUpdate(socket, state, (doc) => {
      const title = firstObject(doc).get("title");
      if (title instanceof Y.Text) title.insert(0, "Typed");
      else firstObject(doc).set("title", new Y.Text("Typed"));
    });
    await vi.waitFor(async () => expect((await objectInDocument(fixture)).title).toBe("Typed"), { timeout: 5000 });
    release.open();

    expect((await answer).status).toBe(200);
    expect(await objectInDocument(fixture)).toMatchObject({ title: "Typed", thumbnail: `${SOURCE_A}/thumb.jpg` });
  });

  it("reads a manifest once for two requests at once, and fills one copy", async () => {
    const fixture = await seedProject("enrich-twice");
    await seedObject(fixture, SOURCE_A);
    await load(fixture);
    const release = gate();
    const { reads, readStarted } = stubManifests({ release: release.promise });

    const first = enrich(fixture);
    await readStarted();
    const second = enrich(fixture);
    await new Promise((r) => setTimeout(r, 50));
    release.open();

    const answers = await Promise.all([first, second]);
    expect(answers.map((a) => a.status)).toEqual([200, 200]);
    expect(reads).toEqual([SOURCE_A]);
    expect((await objectInDocument(fixture)).title).toBe(`Title of ${SOURCE_A}`);
  });
});

describe("a fill under the halt", () => {
  it("is refused before any manifest is read", async () => {
    const fixture = await seedProject("enrich-halted");
    await seedObject(fixture, SOURCE_A);
    await load(fixture);
    const { reads } = stubManifests();
    await haltServer(fixture);

    expect(await enrich(fixture)).toEqual({ status: 503, body: "persistence_halted" });
    expect(reads).toEqual([]);
  });

  it("is refused, with nothing written, when the halt lands while the manifest is read", async () => {
    const fixture = await seedProject("enrich-halted-midway");
    await seedObject(fixture, SOURCE_A);
    await load(fixture);
    const release = gate();
    const { readStarted } = stubManifests({ release: release.promise });

    const answer = enrich(fixture);
    await readStarted();
    await haltServer(fixture);
    release.open();

    expect(await answer).toEqual({ status: 503, body: "persistence_halted" });
    expect((await objectInDocument(fixture)).thumbnail ?? "").toBe("");
  });
});

describe("the words a fill writes", () => {
  it("are credited to nobody, so an author who adds to the field is credited only with their own", async () => {
    const fixture = await seedProject("enrich-words");
    const id = await seedObject(fixture, SOURCE_A);
    const { socket } = await load(fixture);
    stubManifests();
    expect((await enrich(fixture)).status).toBe(200);

    sendUpdate(socket, await serverState(fixture), (doc) => {
      const description = firstObject(doc).get("description") as Y.Text;
      description.insert(description.length, " four");
    });
    await vi.waitFor(async () => expect((await objectInDocument(fixture)).description).toBe("one two three four"), { timeout: 5000 });

    const credited = await runInDurableObject(stubFor(fixture.projectId), (instance) =>
      (instance as unknown as Internals).wordsByRow.get("objects")?.get(String(id))?.get(fixture.userId));
    expect(credited).toBe(1);
  });
});
