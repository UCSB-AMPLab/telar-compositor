/**
 * A page held in more than one language, and the choice a publish applies
 * (`app/lib/page-language-choice.server.ts`).
 *
 * The pages are the template's own `about.md` and `acerca.md`, as the import
 * parses them. The collaboration object is a fake that records what it is
 * sent and answers as `/ingest-sync` does; D1 is a fake of the one row the
 * page files record is merged into.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePageMarkdown } from "~/lib/import.server";
import { pageContentAsLoaded, pageRawHash } from "~/lib/page-canonical";
import {
  PageLanguageChoiceRefused,
  applyPageLanguageChoice,
  keptPageFiles,
  pageLanguageGroups,
  type LanguagePageRow,
} from "~/lib/page-language-choice.server";

const ABOUT = readFileSync(resolve(__dirname, "fixtures/pages/telar/about.md"), "utf8");
const ACERCA = readFileSync(resolve(__dirname, "fixtures/pages/telar/acerca.md"), "utf8");
const PAGES = "telar-content/texts/pages";

function row(id: number, slug: string, file: string, over: Partial<LanguagePageRow> = {}): LanguagePageRow {
  const parsed = parsePageMarkdown(file, slug);
  const frontmatter = parsed.frontmatter ?? "";
  return { id, slug, title: parsed.title ?? "", body: parsed.body ?? "", frontmatter, block: frontmatter, ...over };
}

const about = row(5, "about", ABOUT);
const acerca = row(6, "acerca", ACERCA);
const hashOf = (r: LanguagePageRow) => pageRawHash(pageContentAsLoaded(r));

interface Sent {
  pages: { remove?: unknown[]; replaceContent?: unknown[] };
  allOrNothing?: boolean;
}

let sent: Sent[];
let answer: (payload: Sent) => unknown;
let record: { json: string | null; writes: string[]; refuse: boolean };

function fakeDb() {
  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => ({ page_files_json: record.json }),
        run: async () => {
          if (!sql.startsWith("UPDATE") || record.refuse || args[2] !== record.json) return { meta: { changes: 0 } };
          record.json = args[0] as string;
          record.writes.push(args[0] as string);
          return { meta: { changes: 1 } };
        },
      }),
    }),
  };
}

function env() {
  return {
    SESSION_SECRET: "test-secret",
    DB: fakeDb(),
    COLLABORATION: {
      idFromName: (n: string) => n,
      get: () => ({
        fetch: async (req: Request) => {
          const payload = JSON.parse(await req.text()) as Sent;
          sent.push(payload);
          return new Response(JSON.stringify(answer(payload)), { status: 200 });
        },
      }),
    },
  } as never;
}

/** The answer of an ingest that applied every entry it was sent. */
const appliedAll = (payload: Sent) => ({
  pageContent: { applied: (payload.pages.replaceContent ?? []).map((e) => (e as { pageId: number }).pageId) },
  pageRemove: { applied: (payload.pages.remove ?? []).map((e) => (e as { pageId: number }).pageId) },
});

const recordJson = (files: Record<string, number | null>) => JSON.stringify({ commit: "base", files });

const apply = (kept: string[], rows: LanguagePageRow[] = [about, acerca], json: string | null = recordJson({ "about.md": 5 })) =>
  applyPageLanguageChoice(env(), 1, { rows, siteLanguage: "en", kept: new Set(kept), recordJson: json });

beforeEach(() => {
  sent = [];
  answer = appliedAll;
  record = { json: recordJson({ "about.md": 5 }), writes: [], refuse: false };
});

describe("the pages held in more than one language", () => {
  it("names the template's about page with its Spanish version, on either site language", () => {
    const expected = [{
      page: { pageId: 5, file: "about.md", title: "About" },
      others: [{ pageId: 6, file: "acerca.md", title: acerca.title }],
    }];
    expect(pageLanguageGroups([about, acerca], "en")).toEqual(expected);
    expect(pageLanguageGroups([about, acerca], "es")).toEqual(expected);
  });

  it("names none for a page of its own, a version whose page the site does not hold, or a block not read", () => {
    expect(pageLanguageGroups([about], "en")).toEqual([]);
    expect(pageLanguageGroups([acerca], "en")).toEqual([]);
    expect(pageLanguageGroups([about, { ...acerca, block: null }], "en")).toEqual([]);
  });

  it("reads the posted names as a list of plain page file names, and anything else as none", () => {
    expect([...keptPageFiles('["acerca.md","sub/x.md","x.txt",3]')]).toEqual(["acerca.md"]);
    expect([...keptPageFiles("not json")]).toEqual([]);
    expect([...keptPageFiles('{"about.md":1}')]).toEqual([]);
    expect([...keptPageFiles(null)]).toEqual([]);
  });
});

describe("applying the choice", () => {
  it("does nothing on a site that holds no such page", async () => {
    expect(await apply([], [about])).toEqual([]);
    expect(sent).toEqual([]);
    expect(record.writes).toEqual([]);
  });

  it("refuses a page with no version chosen, or two, before anything is written", async () => {
    for (const kept of [[], ["about.md", "acerca.md"], ["credits.md"]]) {
      await expect(apply(kept)).rejects.toMatchObject({ code: "unchosen" });
    }
    expect(sent).toEqual([]);
    expect(record.writes).toEqual([]);
  });

  it("keeping the page's own version removes the other by the hash of D1's row, all or nothing, and answers its file", async () => {
    expect(await apply(["about.md"])).toEqual([`${PAGES}/acerca.md`]);
    expect(sent).toEqual([{ pages: { remove: [{ pageId: 6, slug: "acerca", expected: await hashOf(acerca) }] }, allOrNothing: true }]);
  });

  it("keeping the other version gives the page its text without the language lines, and removes it", async () => {
    expect(await apply(["acerca.md"])).toEqual([`${PAGES}/acerca.md`]);
    const ownBlock = acerca.frontmatter!.replace("localized_for: about.md\nlanguage: es\n", "");
    expect(ownBlock).not.toContain("localized_for");
    expect(sent[0].pages.replaceContent).toEqual([
      { pageId: 5, expected: await hashOf(about), title: acerca.title, body: acerca.body, frontmatter: ownBlock },
    ]);
    expect(sent[0].pages.remove).toEqual([{ pageId: 6, slug: "acerca", expected: await hashOf(acerca) }]);
  });

  it("hashes a page never captured as D1 holds it, with no block, while reading the block the build reads", async () => {
    const uncaptured = { ...acerca, frontmatter: null };
    await apply(["about.md"], [about, uncaptured]);
    expect(sent[0].pages.remove).toEqual([{ pageId: 6, slug: "acerca", expected: await hashOf(uncaptured) }]);
  });

  it("enters the removed file in a stored record with no page before the ingest", async () => {
    answer = (payload) => {
      expect(JSON.parse(record.json!).files).toEqual({ "about.md": 5, "acerca.md": null });
      return appliedAll(payload);
    };
    await apply(["about.md"]);
    expect(record.writes).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("starts no record where there is none", async () => {
    record.json = null;
    expect(await apply(["about.md"], [about, acerca], null)).toEqual([`${PAGES}/acerca.md`]);
    expect(record.writes).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it("applies nothing when the record cannot be written", async () => {
    record.refuse = true;
    await expect(apply(["about.md"])).rejects.toBeInstanceOf(PageLanguageChoiceRefused);
    expect(sent).toEqual([]);
  });

  it("refuses when the collaboration object held the ingest back, or did not apply an entry", async () => {
    answer = () => ({ heldBack: true, pageRemove: { changedSinceReview: [6] } });
    await expect(apply(["about.md"])).rejects.toMatchObject({ code: "not_applied" });
    answer = () => ({ pageRemove: { applied: [6] }, pageContent: { failed: [5] } });
    await expect(apply(["acerca.md"])).rejects.toMatchObject({ code: "not_applied" });
    answer = () => ({ pageRemove: { alreadyApplied: [6] } });
    await expect(apply(["about.md"])).resolves.toEqual([`${PAGES}/acerca.md`]);
  });
});
