/**
 * `/ingest-sync`'s page arms for a page deleted or renamed on GitHub
 * (`pages.remove`, `pages.rename`) and the menu entry a page taken from
 * GitHub carries on `pages.insert`, against the real
 * collaboration object and D1.
 *
 * A removal applies only while the page with that row id is at the entry's
 * slug and its raw hash is the one the author reviewed; a rename only while
 * the page is at `from` and no other page holds `to`. Each is reported applied
 * only once D1 shows it, and the menu entries naming the page change in the
 * same transaction.
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
import { settlePageSlugs, emptyPageSlugOutcome } from "../../workers/page-remove-rename";
import { seedProject, stubFor, type Fixture } from "./helpers/collaboration-client";

const TEST_SECRET = "test-session-secret";

/** about.md's front matter, between its fences. */
const ABOUT = "\ntitle: About\n";
/** acerca.md's front matter, between its fences. */
const ACERCA = "\ntitle: Acerca de Telar\nlocalized_for: about.md\nlanguage: es\n";

const HOME = { type: "builtin", key: "home", label: "Home", visible: true };
const OBJECTS = { type: "builtin", key: "collection", label: "Objects", visible: true };
const ABOUT_ENTRY = { type: "page", slug: "about", label: "About", visible: true };

const opened = new Set<DurableObjectStub>();

afterEach(async () => {
  for (const stub of opened) {
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
      for (const ws of state.getWebSockets()) {
        try { ws.close(1000, "test over"); } catch { /* already closed */ }
      }
    });
  }
  opened.clear();
});

async function ingestPageArms(fixture: Fixture, body: unknown) {
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

interface SlugArmPage { slug: string; title: string; body: string | null; frontmatter: string | null }

async function plantPageRow(fixture: Fixture, page: SlugArmPage, orderKey = "a0"): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO project_pages (project_id, title, slug, body, frontmatter, "order", order_key)
     VALUES (?, ?, ?, ?, ?, 0, ?) RETURNING id`,
  )
    .bind(fixture.projectId, page.title, page.slug, page.body, page.frontmatter, orderKey)
    .first<{ id: number }>();
  return row!.id;
}

async function plantMenu(fixture: Fixture, entries: unknown[]): Promise<void> {
  await env.DB.prepare("INSERT INTO project_config (project_id, title, navigation_json) VALUES (?, 'Site', ?)")
    .bind(fixture.projectId, JSON.stringify(entries))
    .run();
}

async function slugArmRow(pageId: number) {
  return env.DB.prepare("SELECT id, slug, title, body, frontmatter FROM project_pages WHERE id = ?")
    .bind(pageId)
    .first<{ id: number; slug: string; title: string | null; body: string | null; frontmatter: string | null }>();
}

async function reviewedHash(pageId: number): Promise<string> {
  return pageRawHash(pageContentAsLoaded((await slugArmRow(pageId))!));
}

/** The menu as D1 holds it after the flush, and as the document holds it. */
async function menuNow(fixture: Fixture): Promise<{ stored: unknown[]; live: unknown[] }> {
  const row = await env.DB.prepare("SELECT navigation_json FROM project_config WHERE project_id = ?")
    .bind(fixture.projectId)
    .first<{ navigation_json: string | null }>();
  const live = await runInDurableObject(stubFor(fixture.projectId), (instance) => {
    const ydoc = (instance as unknown as { ydoc: Y.Doc }).ydoc;
    return (ydoc.getMap("config").get("navigation") as Y.Array<unknown>).toArray();
  });
  return { stored: JSON.parse(row?.navigation_json ?? "[]"), live };
}

async function slugArmPages(fixture: Fixture): Promise<Array<{ id: unknown; slug: unknown; frontmatter: unknown }>> {
  return runInDurableObject(stubFor(fixture.projectId), (instance) => {
    const ydoc = (instance as unknown as { ydoc: Y.Doc }).ydoc;
    return ydoc.getArray<Y.Map<unknown>>("pages").toArray()
      .map((m) => ({ id: m.get("_id"), slug: m.get("slug"), frontmatter: m.get("frontmatter") }));
  });
}

/** Load the document, as a client's first edit would find it, through a snapshot. */
async function openSlugArmDoc(fixture: Fixture): Promise<void> {
  const { sigHex, timestamp } = await signInternalMarker(fixture.projectId, TEST_SECRET, "snapshot");
  const response = await stubFor(fixture.projectId).fetch(new Request("https://internal/snapshot", {
    method: "POST",
    headers: {
      "X-Internal-Auth": sigHex,
      "X-Internal-Timestamp": String(timestamp),
      "X-Internal-Project": String(fixture.projectId),
    },
  }));
  expect(response.status).toBe(200);
}

async function editLiveBody(fixture: Fixture, pageId: number): Promise<void> {
  await openSlugArmDoc(fixture);
  await runInDurableObject(stubFor(fixture.projectId), (instance) => {
    const ydoc = (instance as unknown as { ydoc: Y.Doc }).ydoc;
    const map = ydoc.getArray<Y.Map<unknown>>("pages").toArray().find((m) => m.get("_id") === pageId)!;
    ydoc.transact(() => (map.get("body") as Y.Text).insert(0, "Edited here. "));
  });
}

async function setLiveSlug(fixture: Fixture, pageId: number, slug: string): Promise<void> {
  await openSlugArmDoc(fixture);
  await runInDurableObject(stubFor(fixture.projectId), (instance) => {
    const ydoc = (instance as unknown as { ydoc: Y.Doc }).ydoc;
    const map = ydoc.getArray<Y.Map<unknown>>("pages").toArray().find((m) => m.get("_id") === pageId)!;
    ydoc.transact(() => map.set("slug", slug));
  });
}

/** A project with the template's about page and a menu naming it. */
async function aboutProject(label: string, menu: unknown[] = [HOME, ABOUT_ENTRY, OBJECTS]) {
  const fixture = await seedProject(label);
  opened.add(stubFor(fixture.projectId));
  await plantMenu(fixture, menu);
  const pageId = await plantPageRow(fixture, { slug: "about", title: "About", body: "Body", frontmatter: ABOUT });
  return { fixture, pageId, expected: await reviewedHash(pageId) };
}

const NO_SLUG_OUTCOME = { applied: [], alreadyApplied: [], changedSinceReview: [], failed: [] };

describe("pages.remove", () => {
  it("removes the page from the document and D1 with every menu entry naming it, and reports it applied", async () => {
    const { fixture, pageId, expected } = await aboutProject("prr-remove", [HOME, ABOUT_ENTRY, OBJECTS, { ...ABOUT_ENTRY, label: "About again" }]);
    const res = await ingestPageArms(fixture, { pages: { remove: [{ pageId, slug: "about", expected }] } });
    expect(res.status).toBe(200);
    expect(res.body.pageRemove).toEqual({ ...NO_SLUG_OUTCOME, applied: [pageId] });
    expect(await slugArmRow(pageId)).toBeNull();
    expect(await slugArmPages(fixture)).toEqual([]);
    expect(await menuNow(fixture)).toEqual({ stored: [HOME, OBJECTS], live: [HOME, OBJECTS] });
  });

  it("refuses a page edited after the check as changed since review, and keeps it and its menu entry", async () => {
    const { fixture, pageId, expected } = await aboutProject("prr-remove-edited");
    await editLiveBody(fixture, pageId);
    const res = await ingestPageArms(fixture, { pages: { remove: [{ pageId, slug: "about", expected }] } });
    expect(res.body.pageRemove).toEqual({ ...NO_SLUG_OUTCOME, changedSinceReview: [pageId] });
    expect((await slugArmPages(fixture)).map((p) => p.id)).toEqual([pageId]);
    expect((await menuNow(fixture)).live).toEqual([HOME, ABOUT_ENTRY, OBJECTS]);
  });

  it("refuses a page renamed here since the check as changed since review", async () => {
    const { fixture, pageId, expected } = await aboutProject("prr-remove-renamed");
    await setLiveSlug(fixture, pageId, "credits");
    const res = await ingestPageArms(fixture, { pages: { remove: [{ pageId, slug: "about", expected }] } });
    expect(res.body.pageRemove).toEqual({ ...NO_SLUG_OUTCOME, changedSinceReview: [pageId] });
    expect(await slugArmPages(fixture)).toEqual([{ id: pageId, slug: "credits", frontmatter: ABOUT }]);
  });

  it("refuses an id now at another slug while another page holds the entry's slug, and removes neither", async () => {
    const { fixture, pageId, expected } = await aboutProject("prr-remove-other");
    const otherId = await plantPageRow(fixture, { slug: "acerca", title: "Acerca de Telar", body: "Cuerpo", frontmatter: ACERCA }, "a1");
    const res = await ingestPageArms(fixture, { pages: { remove: [{ pageId: otherId, slug: "about", expected }] } });
    expect(res.body.pageRemove).toEqual({ ...NO_SLUG_OUTCOME, changedSinceReview: [otherId] });
    expect((await slugArmPages(fixture)).map((p) => p.slug)).toEqual(["about", "acerca"]);
    expect(await slugArmRow(pageId)).not.toBeNull();
  });

  it("answers a replay as already applied", async () => {
    const { fixture, pageId, expected } = await aboutProject("prr-remove-replay");
    const payload = { pages: { remove: [{ pageId, slug: "about", expected }] } };
    expect((await ingestPageArms(fixture, payload)).body.pageRemove.applied).toEqual([pageId]);
    const again = await ingestPageArms(fixture, payload);
    expect(again.body.pageRemove).toEqual({ ...NO_SLUG_OUTCOME, alreadyApplied: [pageId] });
  });

  it.each([
    ["no expected hash", { expected: undefined }],
    ["a slug in a subfolder", { slug: "sub/about" }],
    ["an empty slug", { slug: "" }],
    ["an id that is not a row id", { pageId: "about" }],
  ])("refuses an entry with %s, by position, and removes nothing", async (_label, broken) => {
    const { fixture, pageId, expected } = await aboutProject(`prr-remove-malformed-${String(_label).length}`);
    const res = await ingestPageArms(fixture, { pages: { remove: [{ pageId, slug: "about", expected, ...broken }] } });
    expect(res.status).toBe(200);
    expect(res.body.refused.pageRemove).toEqual([0]);
    expect(res.body.pageRemove).toEqual(NO_SLUG_OUTCOME);
    expect(await slugArmRow(pageId)).not.toBeNull();
  });
});

describe("pages.rename", () => {
  it("sets the slug in the document and D1, rewrites every menu entry naming the old slug, and reports it applied", async () => {
    const { fixture, pageId } = await aboutProject("prr-rename", [HOME, ABOUT_ENTRY, OBJECTS, { ...ABOUT_ENTRY, visible: false }]);
    const res = await ingestPageArms(fixture, { pages: { rename: [{ pageId, from: "about", to: "credits", frontmatter: "\ntitle: Credits\n" }] } });
    expect(res.status).toBe(200);
    expect(res.body.pageRename).toEqual({ ...NO_SLUG_OUTCOME, applied: [pageId] });
    expect(await slugArmRow(pageId)).toMatchObject({ slug: "credits", title: "About", body: "Body", frontmatter: ABOUT });
    const renamed = [HOME, { ...ABOUT_ENTRY, slug: "credits" }, OBJECTS, { ...ABOUT_ENTRY, slug: "credits", visible: false }];
    expect(await menuNow(fixture)).toEqual({ stored: renamed, live: renamed });
  });

  it("stores GitHub's block on a page whose block was never captured", async () => {
    const fixture = await seedProject("prr-rename-uncaptured");
    opened.add(stubFor(fixture.projectId));
    await plantMenu(fixture, [HOME]);
    const pageId = await plantPageRow(fixture, { slug: "acerca", title: "Acerca de Telar", body: "Cuerpo", frontmatter: null });
    const res = await ingestPageArms(fixture, { pages: { rename: [{ pageId, from: "acerca", to: "acerca-de", frontmatter: ACERCA }] } });
    expect(res.body.pageRename.applied).toEqual([pageId]);
    expect(await slugArmRow(pageId)).toMatchObject({ slug: "acerca-de", frontmatter: ACERCA });
  });

  it("refuses a rename onto a slug another page holds as failed, and changes neither page", async () => {
    const { fixture, pageId } = await aboutProject("prr-rename-taken");
    const otherId = await plantPageRow(fixture, { slug: "credits", title: "Credits", body: "Credits body", frontmatter: "" }, "a1");
    const res = await ingestPageArms(fixture, { pages: { rename: [{ pageId, from: "about", to: "credits", frontmatter: ABOUT }] } });
    expect(res.body.pageRename).toEqual({ ...NO_SLUG_OUTCOME, failed: [pageId] });
    expect((await slugArmRow(pageId))!.slug).toBe("about");
    expect((await slugArmRow(otherId))!.slug).toBe("credits");
    expect((await slugArmPages(fixture)).map((p) => p.slug)).toEqual(["about", "credits"]);
    expect((await menuNow(fixture)).live).toEqual([HOME, ABOUT_ENTRY, OBJECTS]);
  });

  it("refuses a rename onto a slug a page inserted by the same ingest takes", async () => {
    const { fixture, pageId } = await aboutProject("prr-rename-inserted");
    const res = await ingestPageArms(fixture, {
      pages: {
        insert: [{ slug: "credits", title: "Credits", body: "", created_by: null }],
        rename: [{ pageId, from: "about", to: "credits", frontmatter: ABOUT }],
      },
    });
    expect(res.body.pageRename).toEqual({ ...NO_SLUG_OUTCOME, failed: [pageId] });
    expect((await slugArmRow(pageId))!.slug).toBe("about");
  });

  it("refuses a page no longer at `from` as changed since review", async () => {
    const { fixture, pageId } = await aboutProject("prr-rename-moved");
    await setLiveSlug(fixture, pageId, "about-us");
    const res = await ingestPageArms(fixture, { pages: { rename: [{ pageId, from: "about", to: "credits", frontmatter: ABOUT }] } });
    expect(res.body.pageRename).toEqual({ ...NO_SLUG_OUTCOME, changedSinceReview: [pageId] });
    expect((await slugArmPages(fixture))[0].slug).toBe("about-us");
  });

  it("reports an id the document does not hold as failed", async () => {
    const { fixture, pageId } = await aboutProject("prr-rename-missing");
    const res = await ingestPageArms(fixture, { pages: { rename: [{ pageId: pageId + 1000, from: "about", to: "credits", frontmatter: ABOUT }] } });
    expect(res.body.pageRename).toEqual({ ...NO_SLUG_OUTCOME, failed: [pageId + 1000] });
  });

  it("answers a replay as already applied", async () => {
    const { fixture, pageId } = await aboutProject("prr-rename-replay");
    const payload = { pages: { rename: [{ pageId, from: "about", to: "credits", frontmatter: ABOUT }] } };
    expect((await ingestPageArms(fixture, payload)).body.pageRename.applied).toEqual([pageId]);
    const again = await ingestPageArms(fixture, payload);
    expect(again.body.pageRename).toEqual({ ...NO_SLUG_OUTCOME, alreadyApplied: [pageId] });
  });

  it.each([
    ["no block", { frontmatter: undefined }],
    ["a target in a subfolder", { to: "sub/credits" }],
    ["an empty source", { from: "" }],
  ])("refuses an entry with %s, by position, and renames nothing", async (_label, broken) => {
    const { fixture, pageId } = await aboutProject(`prr-rename-malformed-${String(_label).length}`);
    const res = await ingestPageArms(fixture, { pages: { rename: [{ pageId, from: "about", to: "credits", frontmatter: ABOUT, ...broken }] } });
    expect(res.body.refused.pageRename).toEqual([0]);
    expect((await slugArmRow(pageId))!.slug).toBe("about");
  });
});

describe("pages.insert's menu entry", () => {
  const CREDITS = { slug: "credits", title: "Credits", body: "", created_by: null };
  const CREDITS_ENTRY = { type: "page", slug: "credits", label: "Credits", visible: true };

  it("goes directly after the saved entry it names", async () => {
    const { fixture } = await aboutProject("prr-menu-after");
    const res = await ingestPageArms(fixture, {
      pages: { insert: [{ ...CREDITS, menu: { label: "Credits", after: { type: "page", slug: "about" } } }] },
    });
    expect(res.body.applied.pageInsert).toBe(1);
    const placed = [HOME, ABOUT_ENTRY, CREDITS_ENTRY, OBJECTS];
    expect(await menuNow(fixture)).toEqual({ stored: placed, live: placed });
  });

  it("goes after a built-in named by its key, not after the first built-in", async () => {
    const glossary = { type: "builtin", key: "glossary", label: "Glossary", visible: true };
    const { fixture } = await aboutProject("prr-menu-builtin", [HOME, ABOUT_ENTRY, OBJECTS, glossary]);
    await ingestPageArms(fixture, {
      pages: { insert: [{ ...CREDITS, menu: { label: "Credits", after: { type: "builtin", key: "collection" } } }] },
    });
    expect((await menuNow(fixture)).stored).toEqual([HOME, ABOUT_ENTRY, OBJECTS, CREDITS_ENTRY, glossary]);
  });

  it("goes after an external link named by its URL", async () => {
    const forum = { type: "external", url: "https://example.org/forum", label: "Forum", visible: true };
    const { fixture } = await aboutProject("prr-menu-external", [HOME, forum, ABOUT_ENTRY]);
    await ingestPageArms(fixture, {
      pages: { insert: [{ ...CREDITS, menu: { label: "Credits", after: { type: "external", url: "https://example.org/forum" } } }] },
    });
    expect((await menuNow(fixture)).stored).toEqual([HOME, forum, CREDITS_ENTRY, ABOUT_ENTRY]);
  });

  it.each([
    ["names an entry the saved menu does not hold", { type: "page", slug: "missing" }],
    ["names no entry", null],
  ])("goes at the end when it %s", async (_label, after) => {
    const { fixture } = await aboutProject(`prr-menu-end-${String(_label).length}`);
    await ingestPageArms(fixture, { pages: { insert: [{ ...CREDITS, menu: { label: "Credits", after } }] } });
    expect((await menuNow(fixture)).stored).toEqual([HOME, ABOUT_ENTRY, OBJECTS, CREDITS_ENTRY]);
  });

  it("adds none when the insert carries none", async () => {
    const { fixture } = await aboutProject("prr-menu-none");
    const res = await ingestPageArms(fixture, { pages: { insert: [CREDITS] } });
    expect(res.body.applied.pageInsert).toBe(1);
    expect((await menuNow(fixture)).stored).toEqual([HOME, ABOUT_ENTRY, OBJECTS]);
  });

  it("adds none when a saved entry already names the slug at apply time", async () => {
    const held = { type: "page", slug: "credits", label: "Our credits", visible: false };
    const { fixture } = await aboutProject("prr-menu-held", [HOME, held, ABOUT_ENTRY]);
    const res = await ingestPageArms(fixture, {
      pages: { insert: [{ ...CREDITS, menu: { label: "Credits", after: { type: "page", slug: "about" } } }] },
    });
    expect(res.body.applied.pageInsert).toBe(1);
    expect((await menuNow(fixture)).stored).toEqual([HOME, held, ABOUT_ENTRY]);
  });

  it("adds none for an insert skipped because the slug is taken", async () => {
    const { fixture } = await aboutProject("prr-menu-skipped", [HOME]);
    const res = await ingestPageArms(fixture, {
      pages: { insert: [{ slug: "about", title: "About", body: "", created_by: null, menu: { label: "About", after: null } }] },
    });
    expect(res.body.skipped.pageInsert).toEqual(["about"]);
    expect((await menuNow(fixture)).stored).toEqual([HOME]);
  });

  it.each([
    ["a label that is not text", { label: 7, after: null }],
    ["an anchor of no known type", { label: "Credits", after: { type: "story", slug: "about" } }],
    ["a page anchor with no slug", { label: "Credits", after: { type: "page" } }],
    ["a menu that is not an object", "Credits"],
  ])("refuses an insert whose menu entry has %s, by position", async (_label, menu) => {
    const { fixture } = await aboutProject(`prr-menu-malformed-${String(_label).length}`);
    const res = await ingestPageArms(fixture, { pages: { insert: [{ ...CREDITS, menu }] } });
    expect(res.body.refused.pageInsert).toEqual([0]);
    expect((await slugArmPages(fixture)).map((p) => p.slug)).toEqual(["about"]);
  });
});

describe("an all-or-nothing ingest", () => {
  it("is held back whole by a removal changed since review", async () => {
    const { fixture, pageId, expected } = await aboutProject("prr-whole-remove");
    await editLiveBody(fixture, pageId);
    const res = await ingestPageArms(fixture, {
      allOrNothing: true,
      pages: {
        remove: [{ pageId, slug: "about", expected }],
        insert: [{ slug: "credits", title: "Credits", body: "", created_by: null }],
      },
    });
    expect(res.body.heldBack).toBe(true);
    expect(res.body.pageRemove.changedSinceReview).toEqual([pageId]);
    expect((await slugArmPages(fixture)).map((p) => p.slug)).toEqual(["about"]);
  });

  it("is held back whole by a rename onto a taken slug", async () => {
    const { fixture, pageId } = await aboutProject("prr-whole-rename");
    await plantPageRow(fixture, { slug: "credits", title: "Credits", body: "", frontmatter: "" }, "a1");
    const res = await ingestPageArms(fixture, {
      allOrNothing: true,
      config: [{ key: "title", value: "Renamed site" }],
      pages: { rename: [{ pageId, from: "about", to: "credits", frontmatter: ABOUT }] },
    });
    expect(res.body.heldBack).toBe(true);
    expect(res.body.pageRename.failed).toEqual([pageId]);
    const title = await env.DB.prepare("SELECT title FROM project_config WHERE project_id = ?")
      .bind(fixture.projectId).first<{ title: string }>();
    expect(title!.title).toBe("Site");
  });

  it("is held back whole by a rename of a page no longer at `from`", async () => {
    const { fixture, pageId } = await aboutProject("prr-whole-moved");
    await setLiveSlug(fixture, pageId, "about-us");
    const res = await ingestPageArms(fixture, {
      allOrNothing: true,
      pages: {
        rename: [{ pageId, from: "about", to: "credits", frontmatter: ABOUT }],
        insert: [{ slug: "team", title: "Team", body: "", created_by: null }],
      },
    });
    expect(res.body.heldBack).toBe(true);
    expect((await slugArmPages(fixture)).map((p) => p.slug)).toEqual(["about-us"]);
  });
});

describe("an all-or-nothing ingest's page inserts", () => {
  const CREDITS = { slug: "credits", title: "Credits", body: "Credits body", frontmatter: "\ntitle: Credits\n", created_by: null };

  /** A page map the insert built and D1 has no row for yet, with the alarm that would write it cleared. */
  async function plantAwaitingPage(
    fixture: Fixture,
    page: { slug: string; title: string; body: string; frontmatter: string },
    createdBy: number | null = null,
  ) {
    await openSlugArmDoc(fixture);
    await runInDurableObject(stubFor(fixture.projectId), async (instance, state) => {
      const ydoc = (instance as unknown as { ydoc: Y.Doc }).ydoc;
      ydoc.transact(() => {
        const m = new Y.Map<unknown>();
        m.set("_id", null);
        m.set("order_key", "a5");
        m.set("slug", page.slug);
        m.set("title", new Y.Text(page.title));
        m.set("body", new Y.Text(page.body));
        m.set("frontmatter", page.frontmatter);
        m.set("created_by", createdBy);
        ydoc.getArray<Y.Map<unknown>>("pages").push([m]);
      });
      await state.storage.deleteAlarm();
    });
  }

  async function slugArmSiteTitle(fixture: Fixture): Promise<string | null> {
    const row = await env.DB.prepare("SELECT title FROM project_config WHERE project_id = ?")
      .bind(fixture.projectId).first<{ title: string | null }>();
    return row?.title ?? null;
  }

  it("is held back whole by an insert at a slug a page made since the check holds, and writes nothing", async () => {
    const { fixture } = await aboutProject("prr-whole-insert-taken");
    const madeHere = await plantPageRow(fixture, { slug: "credits", title: "My credits", body: "Mine", frontmatter: "" }, "a1");
    const res = await ingestPageArms(fixture, {
      allOrNothing: true,
      config: [{ key: "title", value: "Renamed site" }],
      pages: { insert: [CREDITS] },
    });
    expect(res.body.heldBack).toBe(true);
    expect(res.body.skipped.pageInsert).toEqual(["credits"]);
    expect(await slugArmSiteTitle(fixture)).toBe("Site");
    expect((await slugArmRow(madeHere))!.title).toBe("My credits");
  });

  it.each([
    ["title", { title: "My credits" }],
    ["body", { body: "Mine" }],
    ["block", { frontmatter: "" }],
  ])("is held back by an insert at a slug a page awaiting its row holds with another %s", async (label, other) => {
    const { fixture } = await aboutProject(`prr-whole-insert-other-${label}`);
    const own = { slug: CREDITS.slug, title: CREDITS.title, body: CREDITS.body, frontmatter: CREDITS.frontmatter };
    await plantAwaitingPage(fixture, { ...own, ...other });
    const res = await ingestPageArms(fixture, {
      allOrNothing: true,
      config: [{ key: "title", value: "Renamed site" }],
      pages: { insert: [CREDITS] },
    });
    expect(res.body.heldBack).toBe(true);
    expect(await slugArmSiteTitle(fixture)).toBe("Site");
  });

  it("is not held back by an identical retry of an insert awaiting its row, which is applied", async () => {
    const { fixture } = await aboutProject("prr-whole-insert-retry");
    await plantAwaitingPage(fixture, { slug: CREDITS.slug, title: CREDITS.title, body: CREDITS.body, frontmatter: CREDITS.frontmatter });
    const res = await ingestPageArms(fixture, {
      allOrNothing: true,
      config: [{ key: "title", value: "Renamed site" }],
      pages: { insert: [CREDITS] },
    });
    expect(res.body.heldBack).toBeUndefined();
    expect(res.body.applied.pageInsert).toBe(1);
    expect(await slugArmSiteTitle(fixture)).toBe("Renamed site");
  });

  it("is held back by an insert at a slug an author's pending page holds with the insert's own title, body and block", async () => {
    const { fixture } = await aboutProject("prr-whole-insert-author-attribution");
    const own = { slug: CREDITS.slug, title: CREDITS.title, body: CREDITS.body, frontmatter: CREDITS.frontmatter };
    await plantAwaitingPage(fixture, own, 42);
    const res = await ingestPageArms(fixture, {
      allOrNothing: true,
      config: [{ key: "title", value: "Renamed site" }],
      pages: { insert: [CREDITS] },
    });
    expect(res.body.heldBack).toBe(true);
    expect(res.body.skipped.pageInsert).toEqual(["credits"]);
    expect(await slugArmSiteTitle(fixture)).toBe("Site");
  });

  it("is not held back by a retry of an import's insert, which carries the importing author's attribution", async () => {
    const { fixture } = await aboutProject("prr-whole-insert-retry-attributed");
    const own = { slug: CREDITS.slug, title: CREDITS.title, body: CREDITS.body, frontmatter: CREDITS.frontmatter };
    await plantAwaitingPage(fixture, own, 42);
    const res = await ingestPageArms(fixture, {
      allOrNothing: true,
      config: [{ key: "title", value: "Renamed site" }],
      pages: { insert: [{ ...CREDITS, created_by: 42 }] },
    });
    expect(res.body.heldBack).toBeUndefined();
    expect(await slugArmSiteTitle(fixture)).toBe("Renamed site");
  });

  it("without all-or-nothing, skips an insert at a held slug and writes the rest", async () => {
    const { fixture } = await aboutProject("prr-insert-taken-partial");
    await plantPageRow(fixture, { slug: "credits", title: "My credits", body: "Mine", frontmatter: "" }, "a1");
    const res = await ingestPageArms(fixture, { config: [{ key: "title", value: "Renamed site" }], pages: { insert: [CREDITS] } });
    expect(res.body.heldBack).toBeUndefined();
    expect(res.body.skipped.pageInsert).toEqual(["credits"]);
    expect(await slugArmSiteTitle(fixture)).toBe("Renamed site");
  });
});

describe("menu placement across one ingest's inserts", () => {
  const HOME_ONLY = [HOME, OBJECTS];
  const alpha = { slug: "alpha", title: "Alpha", body: "", created_by: null, menu: { label: "Alpha", after: { type: "builtin", key: "home" } } };
  const beta = { slug: "beta", title: "Beta", body: "", created_by: null, menu: { label: "Beta", after: { type: "page", slug: "alpha" } } };
  const expected = [
    HOME,
    { type: "page", slug: "alpha", label: "Alpha", visible: true },
    OBJECTS,
    { type: "page", slug: "beta", label: "Beta", visible: true },
  ];

  it.each([
    ["alpha then beta", [alpha, beta]],
    ["beta then alpha", [beta, alpha]],
  ])("follows the saved menu as it stood before the ingest, inserting %s", async (label, inserts) => {
    const { fixture } = await aboutProject(`prr-menu-order-${label.replace(/ /g, "-")}`, HOME_ONLY);
    await ingestPageArms(fixture, { pages: { insert: inserts } });
    expect((await menuNow(fixture)).stored).toEqual(expected);
  });
});

describe("settlePageSlugs", () => {
  /** A D1 stand-in answering every row read with `row`. */
  function rowAnswering(row: { slug: string } | null): D1Database {
    return {
      prepare: () => ({ bind: () => ({ first: async () => row }) }),
    } as unknown as D1Database;
  }

  it("reports a removal failed while D1 still holds its row", async () => {
    const outcome = emptyPageSlugOutcome();
    await settlePageSlugs(rowAnswering({ slug: "about" }), 1, [{ pageId: 5, slug: null, outcome: "applied" }], outcome);
    expect(outcome).toEqual({ ...NO_SLUG_OUTCOME, failed: [5] });
  });

  it("reports a rename failed while D1 holds its row at another slug", async () => {
    const outcome = emptyPageSlugOutcome();
    await settlePageSlugs(rowAnswering({ slug: "about" }), 1, [{ pageId: 5, slug: "credits", outcome: "alreadyApplied" }], outcome);
    expect(outcome).toEqual({ ...NO_SLUG_OUTCOME, failed: [5] });
  });
});
