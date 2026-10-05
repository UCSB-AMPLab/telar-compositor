/**
 * `/ingest-sync`'s `pages.storeWrittenFrontmatter` arm against the real
 * collaboration object and D1, beside the two page arms that run ahead of it
 * in the same transaction: `pages.replaceContent`, then
 * `pages.captureFrontmatter`, then the store. The store is judged against the
 * block those two leave, and the stored block reaches D1 and every connected
 * editor.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, afterEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as decoding from "lib0/decoding";

import { signInternalMarker } from "../../workers/auth";
import { pageContentAsLoaded, pageRawHash } from "~/lib/page-canonical";
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

/** A block the publish cannot read as a mapping: an unclosed flow sequence. */
const UNREADABLE = "\ntitle: [About\n";
/** The block the publish writes in its place. */
const WRITTEN = '\ntitle: "About"\n';

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

async function storeWrittenIngest(fixture: Fixture, body: unknown) {
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

interface PageRow {
  id: number;
  slug: string;
  title: string | null;
  body: string | null;
  frontmatter: string | null;
}

async function setup(label: string, frontmatter: string | null) {
  const fixture = await seedProject(label);
  touched.add(stubFor(fixture.projectId));
  const row = await env.DB.prepare(
    `INSERT INTO project_pages (project_id, title, slug, body, frontmatter, frontmatter_source, "order", order_key)
     VALUES (?, 'About', 'about', 'Body', ?, ?, 0, 'a0') RETURNING id`,
  )
    .bind(fixture.projectId, frontmatter, frontmatter === null ? "about" : null)
    .first<{ id: number }>();
  return { fixture, pageId: row!.id };
}

async function storeWrittenRow(pageId: number): Promise<PageRow> {
  return (await env.DB.prepare("SELECT id, slug, title, body, frontmatter FROM project_pages WHERE id = ?")
    .bind(pageId)
    .first<PageRow>())!;
}

async function liveBlock(fixture: Fixture, pageId: number): Promise<unknown> {
  return runInDurableObject(stubFor(fixture.projectId), (instance) => {
    const ydoc = (instance as unknown as { ydoc: Y.Doc }).ydoc;
    return ydoc.getArray<Y.Map<unknown>>("pages").toArray().find((m) => m.get("_id") === pageId)?.get("frontmatter");
  });
}

const store = (pageId: number, expected = UNREADABLE) => ({ pageId, expected, frontmatter: WRITTEN });

/** An editor's copy of the document, kept up to date from the frames its socket receives. */
async function connectEditor(fixture: Fixture): Promise<{ socket: Socket; doc: Y.Doc }> {
  const socket = await openSocket(fixture, "0");
  const doc = new Y.Doc();
  Y.applyUpdate(doc, await drainAcceptanceFrames(socket));
  return { socket, doc };
}

/** Apply the socket's frames to `doc` until its page holds `block`; fails when none arrives. */
async function receiveBlock(editor: { socket: Socket; doc: Y.Doc }, pageId: number, block: string): Promise<void> {
  const editorBlock = () =>
    editor.doc.getArray<Y.Map<unknown>>("pages").toArray().find((m) => m.get("_id") === pageId)?.get("frontmatter");
  while (editorBlock() !== block) {
    const decoder = decoding.createDecoder(await editor.socket.next());
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) continue;
    const kind = decoding.readVarUint(decoder);
    if (kind !== syncProtocol.messageYjsSyncStep2 && kind !== syncProtocol.messageYjsUpdate) continue;
    Y.applyUpdate(editor.doc, decoding.readVarUint8Array(decoder));
  }
}

describe("pages.storeWrittenFrontmatter", () => {
  it("stores the written block over the block the publish read, in the map and in D1", async () => {
    const { fixture, pageId } = await setup("psw-store", UNREADABLE);
    const res = await storeWrittenIngest(fixture, { pages: { storeWrittenFrontmatter: [store(pageId)] } });
    expect(res.status).toBe(200);
    expect(res.body.storedPages).toEqual([pageId]);
    expect((await storeWrittenRow(pageId)).frontmatter).toBe(WRITTEN);
    expect(await liveBlock(fixture, pageId)).toBe(WRITTEN);
  });

  it("refuses an entry with a field beside its row id and its two blocks, and stores nothing of it", async () => {
    const { fixture, pageId } = await setup("psw-strict", UNREADABLE);
    const res = await storeWrittenIngest(fixture, { pages: { storeWrittenFrontmatter: [{ ...store(pageId), title: "Renamed" }] } });
    expect(res.status).toBe(200);
    expect(res.body.refused.pageStoreWrittenFrontmatter).toEqual([0]);
    expect(res.body.storedPages).toEqual([]);
    expect((await storeWrittenRow(pageId)).frontmatter).toBe(UNREADABLE);
  });

  it("skips a page whose block a replacement in the same request changed", async () => {
    const { fixture, pageId } = await setup("psw-replaced", UNREADABLE);
    const expected = await pageRawHash(pageContentAsLoaded(await storeWrittenRow(pageId)));
    const github = { title: "About", body: "Edited on GitHub.", frontmatter: "\ntitle: About\nlanguage: en\n" };
    const res = await storeWrittenIngest(fixture, {
      pages: { replaceContent: [{ pageId, expected, ...github }], storeWrittenFrontmatter: [store(pageId)] },
    });
    expect(res.status).toBe(200);
    expect(res.body.pageContent.applied).toEqual([pageId]);
    expect(res.body.storedPages).toEqual([]);
    expect((await storeWrittenRow(pageId)).frontmatter).toBe(github.frontmatter);
    expect(await liveBlock(fixture, pageId)).toBe(github.frontmatter);
  });

  it("judges the block a capture in the same request stored", async () => {
    const { fixture, pageId } = await setup("psw-captured", null);
    const res = await storeWrittenIngest(fixture, {
      pages: { captureFrontmatter: [{ pageId, frontmatter: UNREADABLE }], storeWrittenFrontmatter: [store(pageId)] },
    });
    expect(res.status).toBe(200);
    expect(res.body.capturedPages).toEqual([pageId]);
    expect(res.body.storedPages).toEqual([pageId]);
    expect((await storeWrittenRow(pageId)).frontmatter).toBe(WRITTEN);
  });

  it("stores the block under a title a replacement changed, leaving the title as the replacement set it", async () => {
    const { fixture, pageId } = await setup("psw-retitled", UNREADABLE);
    const expected = await pageRawHash(pageContentAsLoaded(await storeWrittenRow(pageId)));
    const res = await storeWrittenIngest(fixture, {
      pages: {
        replaceContent: [{ pageId, expected, title: "About us", body: "Body", frontmatter: UNREADABLE }],
        storeWrittenFrontmatter: [store(pageId)],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.storedPages).toEqual([pageId]);
    expect(await storeWrittenRow(pageId)).toMatchObject({ title: "About us", body: "Body", frontmatter: WRITTEN });
  });

  it("reaches two connected editors, after D1 holds it", async () => {
    const { fixture, pageId } = await setup("psw-tabs", UNREADABLE);
    const first = await connectEditor(fixture);
    const second = await connectEditor(fixture);
    const res = await storeWrittenIngest(fixture, { pages: { storeWrittenFrontmatter: [store(pageId)] } });
    expect(res.body.storedPages).toEqual([pageId]);
    await receiveBlock(first, pageId, WRITTEN);
    await receiveBlock(second, pageId, WRITTEN);
    expect((await storeWrittenRow(pageId)).frontmatter).toBe(WRITTEN);
  });
});
