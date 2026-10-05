/**
 * The Pages loader's front matter capture (`app/lib/page-capture.server.ts`):
 * each page never captured has its file read at the repository's head, the
 * way the publish's carry-forward reads it, and the blocks go to the
 * collaboration object; a captured page is not read, an absent file is `""`,
 * and a failed read captures nothing.
 *
 * The files are the template's `about.md` and `acerca.md` front matter.
 *
 * @version v1.5.0-beta
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { filesAtRef, readPaths, head } = vi.hoisted(() => ({
  filesAtRef: { current: {} as Record<string, { status: "ok"; content: string } | { status: "absent" } | { status: "error" }> },
  readPaths: [] as Array<{ path: string; ref: string; strict: boolean }>,
  head: { current: { name: "main", oid: "head-sha" } as { name: string; oid: string } | null },
}));

vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getFileAtRef: vi.fn(async (_t: string, _o: string, _r: string, path: string, ref: string, options?: { strict?: boolean }) => {
      readPaths.push({ path, ref, strict: options?.strict === true });
      return filesAtRef.current[path] ?? { status: "absent" as const };
    }),
    getDefaultBranchHead: vi.fn(async () => head.current),
  };
});

import { captureUncapturedPages, readUncapturedBlocks } from "~/lib/page-capture.server";
import { movePublishSnapshotPastCaptures, snapshotPastCaptures } from "~/lib/page-capture-snapshot.server";
import { buildPageContentHashes, computeChangeSummary, type PublishSnapshot } from "~/lib/publish.server";

const ACERCA_FILE =
  "---\ntitle: Acerca de Telar\nlocalized_for: about.md\nlanguage: es\n---\n\n# Acerca de Telar\n";
const ACERCA_BLOCK = "\ntitle: Acerca de Telar\nlocalized_for: about.md\nlanguage: es\n";
const PAGES = "telar-content/texts/pages";

const source = { token: "tok", owner: "o", repo: "r", ref: "head-sha" };

function page(id: number, slug: string, frontmatter: string | null, frontmatter_source: string | null = null) {
  return { id, slug, title: slug, frontmatter, frontmatter_source };
}

beforeEach(() => {
  filesAtRef.current = {};
  readPaths.length = 0;
  head.current = { name: "main", oid: "head-sha" };
});

describe("reading the blocks of pages never captured", () => {
  it("reads the file a renamed page was imported as, strictly, at the head", async () => {
    filesAtRef.current = { [`${PAGES}/acerca.md`]: { status: "ok", content: `﻿${ACERCA_FILE}` } };
    const { captures, failed } = await readUncapturedBlocks([page(7, "acerca-de", null, "acerca")], source);
    expect(captures).toEqual([{ pageId: 7, frontmatter: ACERCA_BLOCK }]);
    expect(failed).toBe(0);
    expect(readPaths[0]).toEqual({ path: `${PAGES}/acerca.md`, ref: "head-sha", strict: true });
  });

  it("captures an absent file as \"\", counts a failed read, and never reads a captured page", async () => {
    filesAtRef.current = { [`${PAGES}/broken.md`]: { status: "error" } };
    const { captures, failed } = await readUncapturedBlocks(
      [page(1, "about", "\ntitle: About\n"), page(2, "gone", null), page(3, "broken", null)],
      source,
    );
    expect(captures).toEqual([{ pageId: 2, frontmatter: "" }]);
    expect(failed).toBe(1);
    expect(readPaths.map((r) => r.path)).toEqual([`${PAGES}/gone.md`, `${PAGES}/broken.md`]);
  });
});

describe("capturing on load", () => {
  function envWith(answer: number) {
    const bodies: unknown[] = [];
    const env = {
      DB: fakeD1(null, []).db,
      SESSION_SECRET: "s",
      COLLABORATION: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async (request: Request) => {
            const body = JSON.parse(await request.text()) as { pages: { captureFrontmatter: Array<{ pageId: number }> } };
            bodies.push(body);
            const capturedPages = body.pages.captureFrontmatter.map((c) => c.pageId);
            return new Response(JSON.stringify({ capturedPages }), { status: answer });
          },
        }),
      },
    } as unknown as Pick<Env, "COLLABORATION" | "SESSION_SECRET" | "DB">;
    return { env, bodies };
  }

  it("sends the blocks read and returns the pages holding them", async () => {
    filesAtRef.current = { [`${PAGES}/acerca.md`]: { status: "ok", content: ACERCA_FILE } };
    const { env, bodies } = envWith(200);
    const pages = [page(1, "about", "\ntitle: About\n"), page(2, "acerca", null)];
    const result = await captureUncapturedPages(env, 5, pages, source);
    expect(bodies).toEqual([{ pages: { captureFrontmatter: [{ pageId: 2, frontmatter: ACERCA_BLOCK }] } }]);
    expect(result.map((p) => p.frontmatter)).toEqual(["\ntitle: About\n", ACERCA_BLOCK]);
  });

  it("leaves the pages as they were when the collaboration object refuses", async () => {
    filesAtRef.current = { [`${PAGES}/acerca.md`]: { status: "ok", content: ACERCA_FILE } };
    const { env } = envWith(503);
    const result = await captureUncapturedPages(env, 5, [page(2, "acerca", null)], source);
    expect(result[0].frontmatter).toBeNull();
  });

  it("does nothing when every page is captured", async () => {
    const { env, bodies } = envWith(200);
    await captureUncapturedPages(env, 5, [page(1, "about", "")], source);
    expect(bodies).toEqual([]);
    expect(readPaths).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The publish snapshot after a capture
// ---------------------------------------------------------------------------

interface Row {
  id: number;
  slug: string;
  title: string;
  body: string;
  frontmatter: string | null;
}

const legacy: Row = { id: 2, slug: "acerca", title: "Acerca de Telar", body: "# Acerca de Telar", frontmatter: null };
const captured: Row = { ...legacy, frontmatter: ACERCA_BLOCK };

const hashOf = (row: Row): string => buildPageContentHashes([row])[row.slug];

/** A snapshot recorded by a publish of `rows`, as the publish action records its page hashes. */
function snapshotOf(rows: Row[]): PublishSnapshot {
  const pages = buildPageContentHashes(rows);
  return {
    story_ids: [], object_ids: [], page_slugs: rows.map((r) => r.slug), page_hashes: pages,
    config_hash: "", landing_hash: "",
    entity_hashes: { version: 4, pages, stories: {}, objects: {}, glossary: {}, navigation: "", landing: "", settings: "", objectOrder: "" },
  };
}

/** A D1 stand-in answering the three statements the snapshot move makes. */
function fakeD1(snapshot: string | null, rows: Row[], landsBeforeFirstWrite?: string) {
  const state = { snapshot, updates: 0, pending: landsBeforeFirstWrite };
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            first: async () => (sql.includes("FROM projects") ? { publish_snapshot: state.snapshot } : null),
            all: async () => ({ results: rows.filter((r) => (args.slice(1) as number[]).includes(r.id)) }),
            run: async () => {
              const [next, , expected] = args as [string, number, string];
              if (state.pending !== undefined) {
                state.snapshot = state.pending;
                state.pending = undefined;
              }
              if (state.snapshot !== expected) return { meta: { changes: 0 } };
              state.snapshot = next;
              state.updates += 1;
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, state };
}

const pageSummary = (snapshot: PublishSnapshot, rows: Row[]) =>
  computeChangeSummary({
    entityHashes: { ...snapshot.entity_hashes!, pages: buildPageContentHashes(rows) },
    config: null,
    stories: [], objects: [], glossary: [], allStoryIds: [],
    pages: rows.map((r) => ({ slug: r.slug, title: r.title })),
  } as never, snapshot).pages;

describe("the publish snapshot after a capture", () => {
  it("reads a captured legacy page as changed unless its snapshot entry moves (the defect)", () => {
    expect(pageSummary(snapshotOf([legacy]), [captured]).modified.map((p) => p.slug)).toEqual(["acerca"]);
  });

  it("moves an entry that holds the pre-capture hash, so the page reads as unchanged", () => {
    const moved = JSON.parse(snapshotPastCaptures(JSON.stringify(snapshotOf([legacy])), [captured])!) as PublishSnapshot;
    expect(moved.entity_hashes!.pages.acerca).toBe(hashOf(captured));
    expect(moved.page_hashes!.acerca).toBe(hashOf(captured));
    expect(pageSummary(moved, [captured]).modified).toEqual([]);
  });

  it("leaves an entry for a page edited since the last publish, which still reads as changed", () => {
    const edited = { ...captured, body: "Edited since the last publish." };
    expect(snapshotPastCaptures(JSON.stringify(snapshotOf([legacy])), [edited])).toBeNull();
    expect(pageSummary(snapshotOf([legacy]), [edited]).modified.map((p) => p.slug)).toEqual(["acerca"]);
  });

  it("changes nothing for an absent file, a snapshot without page hashes, or no snapshot", () => {
    expect(snapshotPastCaptures(JSON.stringify(snapshotOf([legacy])), [{ ...legacy, frontmatter: "" }])).toBeNull();
    const bare = { ...snapshotOf([legacy]), entity_hashes: undefined };
    expect(snapshotPastCaptures(JSON.stringify(bare), [captured])).toBeNull();
    expect(snapshotPastCaptures(null, [captured])).toBeNull();
    expect(snapshotPastCaptures("{not json", [captured])).toBeNull();
  });

  it("writes the moved snapshot only over the one it read, and retries when a publish lands between", async () => {
    const before = JSON.stringify(snapshotOf([legacy]));
    const { db, state } = fakeD1(before, [captured]);
    await movePublishSnapshotPastCaptures(db, 5, [2]);
    expect(state.updates).toBe(1);
    expect((JSON.parse(state.snapshot!) as PublishSnapshot).entity_hashes!.pages.acerca).toBe(hashOf(captured));

    // A publish landing between the read and the write recorded the captured
    // page itself: the write is refused, the retry finds nothing to move, and
    // the publish's snapshot stands.
    const published = JSON.stringify(snapshotOf([captured]));
    const raced = fakeD1(before, [captured], published);
    await movePublishSnapshotPastCaptures(raced.db, 5, [2]);
    expect(raced.state.updates).toBe(0);
    expect(raced.state.snapshot).toBe(published);

    // One landing between that still holds the pre-capture hash is moved on the retry.
    const other = snapshotOf([legacy]);
    other.entity_hashes!.navigation = "[]";
    const retried = fakeD1(before, [captured], JSON.stringify(other));
    await movePublishSnapshotPastCaptures(retried.db, 5, [2]);
    const kept = JSON.parse(retried.state.snapshot!) as PublishSnapshot;
    expect(retried.state.updates).toBe(1);
    expect(kept.entity_hashes!.navigation).toBe("[]");
    expect(kept.entity_hashes!.pages.acerca).toBe(hashOf(captured));
  });

  function envAnswering(d1: ReturnType<typeof fakeD1>, capturedPages: number[]) {
    return {
      DB: d1.db,
      SESSION_SECRET: "s",
      COLLABORATION: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: async () => new Response(JSON.stringify({ capturedPages }), { status: 200 }) }),
      },
    } as unknown as Pick<Env, "COLLABORATION" | "SESSION_SECRET" | "DB">;
  }

  it("is run by the capture on load, for the pages the collaboration object stored", async () => {
    filesAtRef.current = { [`${PAGES}/acerca.md`]: { status: "ok", content: ACERCA_FILE } };
    const d1 = fakeD1(JSON.stringify(snapshotOf([legacy])), [captured]);
    await captureUncapturedPages(envAnswering(d1, [2]), 5, [page(2, "acerca", null)], source);
    expect(d1.state.updates).toBe(1);
  });

  it("leaves the entry of a page whose block another write stored first, which reads as changed", async () => {
    filesAtRef.current = { [`${PAGES}/acerca.md`]: { status: "ok", content: ACERCA_FILE } };
    // Between the loader's read and the capture, another transaction stored a
    // block of its own; the collaboration object skips the capture.
    const other: Row = { ...legacy, frontmatter: ACERCA_BLOCK.replace("language: es", "language: fr") };
    const before = JSON.stringify(snapshotOf([legacy]));
    const d1 = fakeD1(before, [other]);
    const result = await captureUncapturedPages(envAnswering(d1, []), 5, [page(2, "acerca", null)], source);
    expect(d1.state.updates).toBe(0);
    expect(d1.state.snapshot).toBe(before);
    expect(result[0].frontmatter).toBeNull();
    expect(pageSummary(snapshotOf([legacy]), [other]).modified.map((p) => p.slug)).toEqual(["acerca"]);
  });
});
