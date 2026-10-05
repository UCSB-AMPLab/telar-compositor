/**
 * A page whose stored settings the publish cannot read
 * (`app/lib/page-written-frontmatter.server.ts`): the publish review warns
 * that its settings will be replaced with its title, the publish writes it
 * with its title alone, and once the commit lands the block written is stored
 * and the publish snapshot moved past it, so the page reads neither as
 * unreadable on the Pages screen nor as changed on the Publish screen.
 *
 * @version v1.5.0-beta
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  movePublishSnapshotPastWrittenFrontmatter,
  snapshotPastWrittenFrontmatter,
  snapshotSettledOnLoad,
  storeWrittenPageFrontmatter,
  writtenFrontmatterBlock,
  writtenFrontmatterEntries,
  type WrittenPage,
} from "~/lib/page-written-frontmatter.server";
import {
  buildPageContentHashes,
  computeChangeSummary,
  runPrePublishValidation,
  serializePageMarkdown,
  type PublishSnapshot,
} from "~/lib/publish.server";
import { readBlock } from "~/lib/one-language-pages";

/** An unclosed flow sequence: a syntax error. */
const SYNTAX = "\ntitle: [About\n";
/** A list root. */
const LIST = "\n- About\n- Acerca\n";
/** A standard tag on a value it cannot take. */
const BAD_INT = "\ntitle: About\ncount: !!int foo\n";
/** A mapping the framework cannot build (an unhashable language), which the publish writes whole. */
const UNHASHABLE = "\ntitle: About\nlanguage: [es]\n";
/** A mapping no edit can retitle without changing another key. */
const UNWRITABLE = "\n{title: Acerca, language: es}\n";
/** The block the publish writes for a page titled "About" in place of an unreadable one. */
const WRITTEN = '\ntitle: "About"\n';

beforeEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The review warning
// ---------------------------------------------------------------------------

describe("the publish review, for a page whose settings cannot be read", () => {
  const reviewOf = (pages: Array<{ slug: string; title: string; frontmatter?: string | null }>) =>
    runPrePublishValidation({
      headSha: "h", currentRepoHead: "h", stories: [], steps: [], objects: [], glossary: [], pages,
    });

  it("warns once per page, naming it, for a syntax error, a list root and a value its tag cannot take", () => {
    const result = reviewOf([
      { slug: "about", title: "About", frontmatter: SYNTAX },
      { slug: "list", title: "List", frontmatter: LIST },
      { slug: "count", title: "Count", frontmatter: BAD_INT },
    ]);
    expect(result.warnings).toEqual([
      { code: "page_frontmatter_replaced", message: "page_frontmatter_replaced", entityId: "about", params: { page: "About" } },
      { code: "page_frontmatter_replaced", message: "page_frontmatter_replaced", entityId: "list", params: { page: "List" } },
      { code: "page_frontmatter_replaced", message: "page_frontmatter_replaced", entityId: "count", params: { page: "Count" } },
    ]);
    expect(result.blockers).toEqual([]);
  });

  it("says nothing of an empty block, one never read, or one the publish writes whole", () => {
    const result = reviewOf([
      { slug: "empty", title: "Empty", frontmatter: "" },
      { slug: "unread", title: "Unread", frontmatter: null },
      { slug: "unhashable", title: "Unhashable", frontmatter: UNHASHABLE },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("gives an unwritable block its blocker and no warning", () => {
    const result = reviewOf([{ slug: "acerca", title: "Sobre", frontmatter: UNWRITABLE }]);
    expect(result.warnings).toEqual([]);
    expect(result.blockers.map((b) => b.code)).toEqual(["page_frontmatter_unwritable"]);
  });

  it("says nothing of a page the publish does not write", () => {
    const result = reviewOf([{ slug: "untitled", title: "", frontmatter: SYNTAX }]);
    expect(result.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The block written, and the entries sent
// ---------------------------------------------------------------------------

function writtenPage(id: number, frontmatter: string | null, title = "About", slug = "about"): WrittenPage {
  return { id, slug, title, body: "Body", frontmatter };
}

describe("the block a publish writes for a page it cannot read", () => {
  it("is the title alone, quoted, cut from the file as the import cuts it", async () => {
    expect(await writtenFrontmatterBlock('Café "x"', "Body", SYNTAX, "cafe")).toBe('\ntitle: "Café \\"x\\""\n');
    expect(await writtenFrontmatterBlock("About", "Body", SYNTAX, "about")).toBe(WRITTEN);
  });

  it("is sent only for a written page whose stored block it replaced", async () => {
    const entries = await writtenFrontmatterEntries([
      writtenPage(1, SYNTAX),
      writtenPage(2, "\ntitle: About\n", "Kept", "kept"),
      writtenPage(3, "", "Empty", "empty"),
      writtenPage(4, null, "Unread", "unread"),
      writtenPage(5, UNWRITABLE, "Sobre", "acerca"),
      writtenPage(6, SYNTAX, "", "untitled"),
    ]);
    expect(entries).toEqual([{ pageId: 1, expected: SYNTAX, frontmatter: WRITTEN }]);
  });
});

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

const pageHash = (page: WrittenPage): string => buildPageContentHashes([page])[page.slug!];

/** A snapshot recorded by a publish of `rows`, as the publish action records its page hashes. */
function publishedSnapshotOf(rows: WrittenPage[]): PublishSnapshot {
  const pages = buildPageContentHashes(rows);
  return {
    story_ids: [], object_ids: [], page_slugs: rows.map((r) => r.slug!), page_hashes: { ...pages },
    config_hash: "", landing_hash: "",
    entity_hashes: { version: 4, pages, stories: {}, objects: {}, glossary: {}, navigation: "", landing: "", settings: "", objectOrder: "" },
  };
}

const modifiedPages = (snapshot: PublishSnapshot, rows: WrittenPage[]) =>
  computeChangeSummary({
    entityHashes: { ...snapshot.entity_hashes!, pages: buildPageContentHashes(rows) },
    config: null,
    stories: [], objects: [], glossary: [], allStoryIds: [],
    pages: rows.map((r) => ({ slug: r.slug!, title: r.title })),
  } as never, snapshot).pages.modified.map((p) => p.slug);

const published = writtenPage(1, SYNTAX);
const stored = writtenPage(1, WRITTEN);

describe("the publish snapshot after the written block is stored", () => {
  it("reads the page as changed unless its entry moves (the defect)", () => {
    expect(modifiedPages(publishedSnapshotOf([published]), [stored])).toEqual(["about"]);
  });

  it("moves the entry, and its legacy copy, to the page's hash now", async () => {
    const moved = JSON.parse((await snapshotPastWrittenFrontmatter(JSON.stringify(publishedSnapshotOf([published])), buildPageContentHashes([stored])))!) as PublishSnapshot;
    expect(moved.entity_hashes!.pages.about).toBe(pageHash(stored));
    expect(moved.page_hashes!.about).toBe(pageHash(stored));
    expect(modifiedPages(moved, [stored])).toEqual([]);
  });

  it("leaves the entry of a page retitled, edited, or holding another block, which reads as changed", async () => {
    const snapshot = JSON.stringify(publishedSnapshotOf([published]));
    const retitled = { ...stored, title: "About us" };
    const edited = { ...stored, body: "Edited." };
    const other = writtenPage(1, "\ntitle: About\nlanguage: en\n");
    for (const now of [retitled, edited, other]) {
      expect(await snapshotPastWrittenFrontmatter(snapshot, buildPageContentHashes([now]))).toBeNull();
      expect(modifiedPages(publishedSnapshotOf([published]), [now])).toEqual(["about"]);
    }
  });

  it("leaves the entry of a page published with a readable block, which the store never replaces", async () => {
    const readable = writtenPage(1, "\ntitle: About\n");
    expect(await snapshotPastWrittenFrontmatter(JSON.stringify(publishedSnapshotOf([readable])), buildPageContentHashes([stored]))).toBeNull();
  });

  it("changes nothing without a snapshot, page hashes, or readable JSON", async () => {
    const hashes = buildPageContentHashes([stored]);
    expect(await snapshotPastWrittenFrontmatter(null, hashes)).toBeNull();
    expect(await snapshotPastWrittenFrontmatter("{not json", hashes)).toBeNull();
    expect(await snapshotPastWrittenFrontmatter(JSON.stringify({ ...publishedSnapshotOf([published]), entity_hashes: undefined }), hashes)).toBeNull();
  });
});

/**
 * A D1 stand-in answering the snapshot's read and its compare-and-set write.
 * `landing` is the snapshot a publish writes between each read and write, for
 * as many writes as it lists.
 */
function snapshotD1(snapshot: string | null, landing: string[] = []) {
  const state = { snapshot, updates: 0, attempts: 0 };
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            first: async () => (sql.includes("FROM projects") ? { publish_snapshot: state.snapshot } : null),
            run: async () => {
              state.attempts += 1;
              const [next, , expected] = args as [string, number, string];
              const lands = landing.shift();
              if (lands !== undefined) state.snapshot = lands;
              const guarded = sql.includes("AND publish_snapshot = ?");
              if (guarded && state.snapshot !== expected) return { meta: { changes: 0 } };
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

/** A D1 that fails every statement. */
const failingD1 = {
  prepare() {
    throw new Error("D1_ERROR: the database is unavailable");
  },
} as unknown as D1Database;

describe("moving the snapshot in D1", () => {
  const hashes = buildPageContentHashes([stored]);

  it("writes over the snapshot it read, and retries when a publish lands between", async () => {
    const before = JSON.stringify(publishedSnapshotOf([published]));
    const other = publishedSnapshotOf([published]);
    other.entity_hashes!.navigation = "[]";
    const d1 = snapshotD1(before, [JSON.stringify(other)]);
    const written = await movePublishSnapshotPastWrittenFrontmatter(d1.db, 5, hashes);
    expect(d1.state.attempts).toBe(2);
    expect(d1.state.snapshot).toBe(written);
    const kept = JSON.parse(written!) as PublishSnapshot;
    expect(kept.entity_hashes!.navigation).toBe("[]");
    expect(kept.entity_hashes!.pages.about).toBe(pageHash(stored));
  });

  it("gives up after three refused writes, answering none", async () => {
    const before = JSON.stringify(publishedSnapshotOf([published]));
    const landing = [1, 2, 3].map((n) => {
      const next = publishedSnapshotOf([published]);
      next.entity_hashes!.navigation = `[${n}]`;
      return JSON.stringify(next);
    });
    const d1 = snapshotD1(before, landing);
    expect(await movePublishSnapshotPastWrittenFrontmatter(d1.db, 5, hashes)).toBeNull();
    expect(d1.state.attempts).toBe(3);
    expect(d1.state.updates).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// After the publish lands
// ---------------------------------------------------------------------------

interface Delivery {
  pages: { storeWrittenFrontmatter: Array<{ pageId: number; expected: string; frontmatter: string }> };
}

function storeEnv(db: D1Database, answer: (delivery: Delivery) => Response | Promise<Response>) {
  const deliveries: Delivery[] = [];
  const env = {
    DB: db,
    SESSION_SECRET: "s",
    COLLABORATION: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          const delivery = JSON.parse(await request.text()) as Delivery;
          deliveries.push(delivery);
          return answer(delivery);
        },
      }),
    },
  } as unknown as Pick<Env, "COLLABORATION" | "SESSION_SECRET" | "DB">;
  return { env, deliveries };
}

const storing = (ids: number[]) => () => Response.json({ storedPages: ids });

describe("storing the written blocks once the publish has landed", () => {
  it("sends the block read and the block written, and moves the snapshot for the page stored", async () => {
    const d1 = snapshotD1(JSON.stringify(publishedSnapshotOf([published])));
    const { env, deliveries } = storeEnv(d1.db, storing([1]));
    await storeWrittenPageFrontmatter(env, 5, [published, writtenPage(2, "\ntitle: Kept\n", "Kept", "kept")]);
    expect(deliveries).toEqual([{ pages: { storeWrittenFrontmatter: [{ pageId: 1, expected: SYNTAX, frontmatter: WRITTEN }] } }]);
    expect(d1.state.updates).toBe(1);
    expect(modifiedPages(JSON.parse(d1.state.snapshot!) as PublishSnapshot, [stored])).toEqual([]);
  });

  it("sends nothing when no page's block was replaced", async () => {
    const d1 = snapshotD1(JSON.stringify(publishedSnapshotOf([writtenPage(2, "\ntitle: Kept\n", "Kept", "kept")])));
    const { env, deliveries } = storeEnv(d1.db, storing([]));
    await storeWrittenPageFrontmatter(env, 5, [writtenPage(2, "\ntitle: Kept\n", "Kept", "kept"), writtenPage(3, null, "Unread", "unread")]);
    expect(deliveries).toEqual([]);
  });

  it("moves only the entries of the pages the object stored", async () => {
    const second = writtenPage(2, SYNTAX, "About", "about-2");
    const before = publishedSnapshotOf([published, second]);
    const d1 = snapshotD1(JSON.stringify(before));
    const { env } = storeEnv(d1.db, storing([1]));
    await storeWrittenPageFrontmatter(env, 5, [published, second]);
    const after = JSON.parse(d1.state.snapshot!) as PublishSnapshot;
    expect(after.entity_hashes!.pages.about).toBe(pageHash(stored));
    expect(after.entity_hashes!.pages["about-2"]).toBe(before.entity_hashes!.pages["about-2"]);
  });

  it("leaves the snapshot when the object stored nothing, so an edited page reads as changed", async () => {
    const before = JSON.stringify(publishedSnapshotOf([published]));
    const d1 = snapshotD1(before);
    const { env } = storeEnv(d1.db, storing([]));
    await storeWrittenPageFrontmatter(env, 5, [published]);
    expect(d1.state.snapshot).toBe(before);
    expect(modifiedPages(publishedSnapshotOf([published]), [writtenPage(1, "\ntitle: About\nlanguage: en\n")])).toEqual(["about"]);
  });

  it("returns without throwing when the object refuses or cannot be reached", async () => {
    const before = JSON.stringify(publishedSnapshotOf([published]));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const answer of [() => new Response("snapshot_failed", { status: 503 }), () => { throw new Error("unreachable"); }]) {
      const d1 = snapshotD1(before);
      await expect(storeWrittenPageFrontmatter(storeEnv(d1.db, answer).env, 5, [published])).resolves.toBeUndefined();
      expect(d1.state.snapshot).toBe(before);
    }
    expect(errors).toHaveBeenCalledTimes(2);
  });

  it("recovers at the next Publish load when D1 fails after the object stored the block", async () => {
    const before = JSON.stringify(publishedSnapshotOf([published]));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(storeWrittenPageFrontmatter(storeEnv(failingD1, storing([1])).env, 5, [published])).resolves.toBeUndefined();

    // D1 now holds the stored block and the snapshot as the publish recorded it.
    const d1 = snapshotD1(before);
    const settled = await snapshotSettledOnLoad(d1.db, 5, before, buildPageContentHashes([stored]));
    expect(d1.state.updates).toBe(1);
    expect(settled).toBe(d1.state.snapshot);
    expect(modifiedPages(JSON.parse(settled!) as PublishSnapshot, [stored])).toEqual([]);
  });

  it("recovers at the next Publish load when every compare-and-set after the store was refused", async () => {
    const before = JSON.stringify(publishedSnapshotOf([published]));
    const landing = [1, 2, 3].map((n) => {
      const next = publishedSnapshotOf([published]);
      next.entity_hashes!.navigation = `[${n}]`;
      return JSON.stringify(next);
    });
    const raced = snapshotD1(before, landing);
    await storeWrittenPageFrontmatter(storeEnv(raced.db, storing([1])).env, 5, [published]);
    expect(raced.state.updates).toBe(0);

    const settled = await snapshotSettledOnLoad(raced.db, 5, raced.state.snapshot, buildPageContentHashes([stored]));
    expect(raced.state.updates).toBe(1);
    expect(modifiedPages(JSON.parse(settled!) as PublishSnapshot, [stored])).toEqual([]);
  });

  it("reads nothing from D1 at a load with nothing to move", async () => {
    const snapshot = JSON.stringify(publishedSnapshotOf([stored]));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await snapshotSettledOnLoad(failingD1, 5, snapshot, buildPageContentHashes([stored]))).toBe(snapshot);
    expect(errors).not.toHaveBeenCalled();
  });

  it("compares with the snapshot it read, moved, when the move in D1 fails", async () => {
    const before = JSON.stringify(publishedSnapshotOf([published]));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const settled = await snapshotSettledOnLoad(failingD1, 5, before, buildPageContentHashes([stored]));
    expect(errors).toHaveBeenCalledTimes(1);
    expect(modifiedPages(JSON.parse(settled!) as PublishSnapshot, [stored])).toEqual([]);
  });

  it("compares with the snapshot it read, moved, when another load has already moved D1's", async () => {
    const before = JSON.stringify(publishedSnapshotOf([published]));
    const movedElsewhere = await snapshotPastWrittenFrontmatter(before, buildPageContentHashes([stored]));
    const d1 = snapshotD1(movedElsewhere);
    const settled = await snapshotSettledOnLoad(d1.db, 5, before, buildPageContentHashes([stored]));
    expect(d1.state.updates).toBe(0);
    expect(modifiedPages(JSON.parse(settled!) as PublishSnapshot, [stored])).toEqual([]);
  });

  it("keeps the snapshot agreeing with the hashes it was read with when D1 holds a capture they do not", async () => {
    // The loader's re-read after a capture failed, so it holds the hashes and
    // the snapshot from before the capture, while D1's snapshot already holds
    // the capture's move of the legacy page.
    const legacy = writtenPage(2, null, "Acerca", "acerca");
    const captured = writtenPage(2, "\ntitle: Acerca\nlanguage: es\n", "Acerca", "acerca");
    const before = JSON.stringify(publishedSnapshotOf([published, legacy]));
    const inD1 = publishedSnapshotOf([published, legacy]);
    inD1.entity_hashes!.pages.acerca = pageHash(captured);
    inD1.page_hashes!.acerca = pageHash(captured);
    const d1 = snapshotD1(JSON.stringify(inD1));
    const hashesBeforeCapture = buildPageContentHashes([stored, legacy]);
    const settled = await snapshotSettledOnLoad(d1.db, 5, before, hashesBeforeCapture);
    expect(d1.state.updates).toBe(1);
    expect(modifiedPages(JSON.parse(settled!) as PublishSnapshot, [stored, legacy])).toEqual([]);
  });

  it("leaves a page retitled in the same window reading as changed, after the store and at the next load", async () => {
    const d1 = snapshotD1(JSON.stringify(publishedSnapshotOf([published])));
    await storeWrittenPageFrontmatter(storeEnv(d1.db, storing([1])).env, 5, [published]);
    const retitled = { ...stored, title: "About us" };
    expect(modifiedPages(JSON.parse(d1.state.snapshot!) as PublishSnapshot, [retitled])).toEqual(["about"]);
    const settled = await snapshotSettledOnLoad(d1.db, 5, d1.state.snapshot, buildPageContentHashes([retitled]));
    expect(modifiedPages(JSON.parse(settled!) as PublishSnapshot, [retitled])).toEqual(["about"]);
  });
});

describe("the stored block", () => {
  it("publishes the same file, groups as an ordinary page, and hashes as the moved entry", async () => {
    const d1 = snapshotD1(JSON.stringify(publishedSnapshotOf([published])));
    await storeWrittenPageFrontmatter(storeEnv(d1.db, storing([1])).env, 5, [published]);
    expect(await serializePageMarkdown("About", "Body", WRITTEN, "about"))
      .toBe(await serializePageMarkdown("About", "Body", SYNTAX, "about"));
    expect(readBlock(WRITTEN).kind).toBe("canonical");
    expect((JSON.parse(d1.state.snapshot!) as PublishSnapshot).entity_hashes!.pages.about).toBe(pageHash(stored));
  });
});
