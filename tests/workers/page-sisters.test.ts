/**
 * The front matter capture the Pages loader sends, in the collaboration
 * object, against the real class, real D1 and the real migration chain.
 *
 * The blocks are the template's own front matter, `about.md`'s and
 * `acerca.md`'s, quoted verbatim from the framework
 * telar-content/texts/pages/.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, afterEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Y from "yjs";

import { signInternalMarker } from "../../workers/auth";
import {
  openSocket,
  seedProject,
  stubFor,
  type Fixture,
  type Socket,
} from "./helpers/collaboration-client";

const TEST_SECRET = "test-session-secret";

/** about.md's front matter, between its fences. */
const ABOUT = "\ntitle: About\n";
/** acerca.md's front matter, between its fences. */
const ACERCA = "\ntitle: Acerca de Telar\nlocalized_for: about.md\nlanguage: es\n";

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

async function post(fixture: Fixture, path: string, action: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const { sigHex, timestamp } = await signInternalMarker(fixture.projectId, TEST_SECRET, action);
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
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, json };
}

const snapshot = async (fixture: Fixture) => (await post(fixture, "/snapshot", "snapshot")).status;

interface SeedPage {
  slug: string;
  frontmatter: string | null;
  createdBy?: number;
}

/** Pages for the fixture, in order. A NULL block is a legacy page, whose source is its slug. */
async function seedPages(fixture: Fixture, pages: SeedPage[]): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < pages.length; i++) {
    const { slug, frontmatter, createdBy } = pages[i];
    const row = await env.DB.prepare(
      `INSERT INTO project_pages (project_id, title, slug, body, frontmatter, frontmatter_source, "order", order_key, created_by)
       VALUES (?, ?, ?, 'Body', ?, ?, ?, ?, ?) RETURNING id`,
    )
      .bind(fixture.projectId, slug, slug, frontmatter, frontmatter === null ? slug : null, i, `a${i}`, createdBy ?? fixture.userId)
      .first<{ id: number }>();
    ids.push(row!.id);
  }
  return ids;
}

function pageMapsOf(instance: unknown): Y.Map<unknown>[] {
  return (instance as { ydoc: Y.Doc }).ydoc.getArray<Y.Map<unknown>>("pages").toArray();
}

async function docPages(fixture: Fixture): Promise<Array<[string, unknown]>> {
  return runInDurableObject(stubFor(fixture.projectId), (instance) =>
    pageMapsOf(instance).map((m) => [m.get("slug") as string, m.get("frontmatter")] as [string, unknown]),
  );
}

async function d1Pages(fixture: Fixture): Promise<Record<string, string | null>> {
  const rows = await env.DB.prepare("SELECT slug, frontmatter FROM project_pages WHERE project_id = ? ORDER BY id")
    .bind(fixture.projectId)
    .all<{ slug: string; frontmatter: string | null }>();
  return Object.fromEntries(rows.results.map((r) => [r.slug, r.frontmatter]));
}

async function load(fixture: Fixture): Promise<Socket> {
  touched.add(stubFor(fixture.projectId));
  return openSocket(fixture, "0");
}

describe("the front matter capture", () => {
  it("stores a block on a page never captured and leaves a captured page alone", async () => {
    const fixture = await seedProject("sister-capture");
    const [aboutId, acercaId] = await seedPages(fixture, [
      { slug: "about", frontmatter: ABOUT },
      { slug: "acerca", frontmatter: null },
    ]);
    await load(fixture);

    const { status, json } = await post(fixture, "/ingest-sync", "ingest-sync", {
      pages: {
        captureFrontmatter: [
          { pageId: aboutId, frontmatter: "\ntitle: Replaced\n" },
          { pageId: acercaId, frontmatter: ACERCA },
          { pageId: "not-an-id", frontmatter: ACERCA },
        ],
      },
    });
    expect(status).toBe(200);
    const answer = json as { applied: Record<string, number>; skipped: Record<string, number[]>; refused: Record<string, number[]> };
    expect(answer.applied.pageCaptureFrontmatter).toBe(1);
    expect(answer.skipped.pageCaptureFrontmatter).toEqual([aboutId]);
    expect(answer.refused.pageCaptureFrontmatter).toEqual([2]);
    expect((json as { capturedPages: number[] }).capturedPages).toEqual([acercaId]);
    expect(await docPages(fixture)).toEqual([["about", ABOUT], ["acerca", ACERCA]]);
    expect(await d1Pages(fixture)).toEqual({ about: ABOUT, acerca: ACERCA });
  });

  it("keeps a legacy page's block through a rename, a delete, a snapshot and an undo", async () => {
    const fixture = await seedProject("sister-tel382");
    const [legacyId] = await seedPages(fixture, [{ slug: "acerca", frontmatter: null }]);
    await load(fixture);
    expect((await post(fixture, "/ingest-sync", "ingest-sync", {
      pages: { captureFrontmatter: [{ pageId: legacyId, frontmatter: ACERCA }] },
    })).status).toBe(200);

    const stub = stubFor(fixture.projectId);
    const origin = "undo-under-test";
    await runInDurableObject(stub, (instance) => {
      const ydoc = (instance as unknown as { ydoc: Y.Doc }).ydoc;
      const pages = ydoc.getArray<Y.Map<unknown>>("pages");
      pages.get(0).doc!.transact(() => { pages.get(0).set("slug", "acerca-de"); });
      const um = new Y.UndoManager(pages, { trackedOrigins: new Set([origin]) });
      (instance as unknown as { __um?: Y.UndoManager }).__um = um;
      ydoc.transact(() => { pages.delete(0, 1); }, origin);
    });
    expect(await snapshot(fixture)).toBe(200);
    expect(await d1Pages(fixture)).toEqual({});

    await runInDurableObject(stub, (instance) => {
      const um = (instance as unknown as { __um?: Y.UndoManager }).__um!;
      um.undo();
      um.destroy();
    });
    expect(await snapshot(fixture)).toBe(200);
    // The re-inserted row lost `frontmatter_source`, which only D1 held; the
    // block came back with the map, so the publish has no file to read.
    const row = await env.DB.prepare("SELECT slug, frontmatter, frontmatter_source FROM project_pages WHERE id = ?")
      .bind(legacyId)
      .first<{ slug: string; frontmatter: string | null; frontmatter_source: string | null }>();
    expect(row).toMatchObject({ slug: "acerca-de", frontmatter: ACERCA });
  });
});
