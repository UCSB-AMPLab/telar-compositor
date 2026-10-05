/**
 * `/ingest-sync`'s `pages.replaceContent` arm, against the
 * real collaboration object and D1.
 *
 * Each entry replaces a page's title, body and front matter with GitHub's
 * version, but only while the live page is still the one the author
 * reviewed: the raw hash of its live map (`pageRawHash` of its title, body
 * and `frontmatter`) must equal the entry's `expected`. The title and body
 * are replaced in place, the block is set in the map, and the slug is never
 * touched. A page is reported applied only once D1 shows it.
 *
 * The blocks are the template's own, `about.md`'s and `acerca.md`'s, quoted
 * verbatim from the framework's telar-content/texts/pages/.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, afterEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Y from "yjs";

import { signInternalMarker } from "../../workers/auth";
import { pageContentAsLoaded, pageRawHash } from "~/lib/page-canonical";
import { seedProject, stubFor, type Fixture } from "./helpers/collaboration-client";

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

async function post(fixture: Fixture, path: string, action: string, body?: unknown) {
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
  return { status: response.status, body: text.startsWith("{") ? JSON.parse(text) : text };
}

interface PageRow {
  id: number;
  slug: string;
  title: string | null;
  body: string | null;
  frontmatter: string | null;
}

async function seedPage(fixture: Fixture, page: { slug: string; title: string; body: string | null; frontmatter: string | null }): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO project_pages (project_id, title, slug, body, frontmatter, frontmatter_source, "order", order_key)
     VALUES (?, ?, ?, ?, ?, ?, 0, 'a0') RETURNING id`,
  )
    .bind(fixture.projectId, page.title, page.slug, page.body, page.frontmatter, page.frontmatter === null ? page.slug : null)
    .first<{ id: number }>();
  return row!.id;
}

async function pageRow(pageId: number): Promise<PageRow> {
  return (await env.DB.prepare("SELECT id, slug, title, body, frontmatter FROM project_pages WHERE id = ?")
    .bind(pageId)
    .first<PageRow>())!;
}

/** The hash the check records for a page: its D1 row, as the map loads it. */
async function expectedHash(pageId: number): Promise<string> {
  return pageRawHash(pageContentAsLoaded(await pageRow(pageId)));
}

async function livePage(fixture: Fixture, pageId: number) {
  return runInDurableObject(stubFor(fixture.projectId), (instance) => {
    const ydoc = (instance as unknown as { ydoc: Y.Doc }).ydoc;
    const map = ydoc.getArray<Y.Map<unknown>>("pages").toArray().find((m) => m.get("_id") === pageId)!;
    return {
      slug: map.get("slug"),
      title: String(map.get("title")),
      body: String(map.get("body")),
      frontmatter: map.get("frontmatter"),
      titleIsText: map.get("title") instanceof Y.Text,
    };
  });
}

const GITHUB = { title: "About Telar", body: "Edited on GitHub.", frontmatter: "\ntitle: About Telar\nlanguage: en\n" };

function replace(entries: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return { pages: { replaceContent: entries, ...extra } };
}

async function setup(
  label: string,
  page: { slug: string; title: string; body: string | null; frontmatter: string | null } = { slug: "about", title: "About", body: "Body", frontmatter: ABOUT },
) {
  const fixture = await seedProject(label);
  touched.add(stubFor(fixture.projectId));
  const pageId = await seedPage(fixture, page);
  return { fixture, pageId, expected: await expectedHash(pageId) };
}

describe("pages.replaceContent", () => {
  it("replaces the title, body and front matter in the map and in D1, and reports the page applied", async () => {
    const { fixture, pageId, expected } = await setup("prc-apply");
    const res = await post(fixture, "/ingest-sync", "ingest-sync", replace([{ pageId, expected, ...GITHUB }]));
    expect(res.status).toBe(200);
    expect(res.body.pageContent).toEqual({ applied: [pageId], alreadyApplied: [], changedSinceReview: [], failed: [] });
    expect(await pageRow(pageId)).toMatchObject({ slug: "about", ...GITHUB });
    expect(await livePage(fixture, pageId)).toMatchObject({ slug: "about", ...GITHUB, titleIsText: true });
  });

  it("never touches the slug, whatever the entry carries", async () => {
    const { fixture, pageId, expected } = await setup("prc-slug");
    const res = await post(fixture, "/ingest-sync", "ingest-sync", replace([{ pageId, expected, ...GITHUB, slug: "renamed" }]));
    expect(res.body.pageContent.applied).toEqual([pageId]);
    expect((await pageRow(pageId)).slug).toBe("about");
    expect((await livePage(fixture, pageId)).slug).toBe("about");
  });

  it("refuses a page edited after the check, unsnapshotted edits included, and applies nothing of it", async () => {
    const { fixture, pageId, expected } = await setup("prc-stale");
    await post(fixture, "/snapshot", "snapshot");
    await runInDurableObject(stubFor(fixture.projectId), (instance) => {
      const ydoc = (instance as unknown as { ydoc: Y.Doc }).ydoc;
      const map = ydoc.getArray<Y.Map<unknown>>("pages").toArray().find((m) => m.get("_id") === pageId)!;
      ydoc.transact(() => (map.get("body") as Y.Text).insert(4, ", edited live"));
    });
    const res = await post(fixture, "/ingest-sync", "ingest-sync", replace([{ pageId, expected, ...GITHUB }]));
    expect(res.status).toBe(200);
    expect(res.body.pageContent).toEqual({ applied: [], alreadyApplied: [], changedSinceReview: [pageId], failed: [] });
    expect(await livePage(fixture, pageId)).toMatchObject({ title: "About", body: "Body, edited live", frontmatter: ABOUT });
  });

  it("treats a replay of an applied entry as a no-op", async () => {
    const { fixture, pageId, expected } = await setup("prc-replay");
    const payload = replace([{ pageId, expected, ...GITHUB }]);
    expect((await post(fixture, "/ingest-sync", "ingest-sync", payload)).body.pageContent.applied).toEqual([pageId]);
    const again = await post(fixture, "/ingest-sync", "ingest-sync", payload);
    expect(again.body.pageContent).toEqual({ applied: [], alreadyApplied: [pageId], changedSinceReview: [], failed: [] });
  });

  it("reports a page the document does not hold as failed", async () => {
    const { fixture, pageId, expected } = await setup("prc-missing");
    const res = await post(fixture, "/ingest-sync", "ingest-sync", replace([{ pageId: pageId + 1000, expected, ...GITHUB }]));
    expect(res.body.pageContent).toEqual({ applied: [], alreadyApplied: [], changedSinceReview: [], failed: [pageId + 1000] });
    expect(await pageRow(pageId)).toMatchObject({ title: "About", body: "Body", frontmatter: ABOUT });
  });

  it.each([
    ["no expected hash", { expected: undefined }],
    ["a body that is not text", { body: 7 }],
    ["a null block", { frontmatter: null }],
    ["an id that is not a row id", { pageId: "about" }],
  ])("refuses an entry with %s, by position, and applies nothing of it", async (_label, broken) => {
    const { fixture, pageId, expected } = await setup(`prc-malformed-${String(_label).length}`);
    const res = await post(fixture, "/ingest-sync", "ingest-sync", replace([{ pageId, expected, ...GITHUB, ...broken }]));
    expect(res.status).toBe(200);
    expect(res.body.refused.pageReplaceContent).toEqual([0]);
    expect(res.body.pageContent).toEqual({ applied: [], alreadyApplied: [], changedSinceReview: [], failed: [] });
    expect(await pageRow(pageId)).toMatchObject({ title: "About", body: "Body", frontmatter: ABOUT });
  });

  it("takes a page whose block was never captured from its null block to GitHub's, with the null hashed apart from \"\"", async () => {
    const { fixture, pageId, expected } = await setup("prc-uncaptured", { slug: "acerca", title: "Acerca de Telar", body: "Cuerpo", frontmatter: null });
    expect(expected).not.toBe(await pageRawHash({ title: "Acerca de Telar", body: "Cuerpo", frontmatter: "" }));
    const res = await post(fixture, "/ingest-sync", "ingest-sync", replace([{ pageId, expected, title: "Acerca", body: "Editado en GitHub.", frontmatter: ACERCA }]));
    expect(res.body.pageContent.applied).toEqual([pageId]);
    expect(await pageRow(pageId)).toMatchObject({ title: "Acerca", body: "Editado en GitHub.", frontmatter: ACERCA });
  });

  it("wins over a front matter capture for the same page in the same load", async () => {
    const { fixture, pageId, expected } = await setup("prc-capture", { slug: "acerca", title: "Acerca de Telar", body: "Cuerpo", frontmatter: null });
    const incoming = { title: "Acerca", body: "Editado en GitHub.", frontmatter: "\ntitle: Acerca\nlanguage: es\n" };
    const res = await post(fixture, "/ingest-sync", "ingest-sync", replace(
      [{ pageId, expected, ...incoming }],
      { captureFrontmatter: [{ pageId, frontmatter: ACERCA }] },
    ));
    expect(res.status).toBe(200);
    expect(res.body.pageContent.applied).toEqual([pageId]);
    expect(res.body.skipped.pageCaptureFrontmatter).toEqual([pageId]);
    expect(res.body.capturedPages).toEqual([]);
    expect(await pageRow(pageId)).toMatchObject(incoming);
    expect((await livePage(fixture, pageId)).frontmatter).toBe(incoming.frontmatter);
  });

  it("reads a D1 row with no body as the map loads it, so an untouched page is not refused", async () => {
    const { fixture, pageId, expected } = await setup("prc-nullbody", { slug: "about", title: "About", body: null, frontmatter: ABOUT });
    const res = await post(fixture, "/ingest-sync", "ingest-sync", replace([{ pageId, expected, ...GITHUB }]));
    expect(res.body.pageContent.applied).toEqual([pageId]);
  });
});
