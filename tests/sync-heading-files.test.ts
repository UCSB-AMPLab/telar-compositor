/**
 * A heading-only edit on GitHub (`object_id` to `Object_ID`) leaves D1 equal to
 * the repository's parse, so the full sync names the sheets whose misread
 * headings moved between the base and the head (`headingFiles`), and the status
 * refresh counts them as divergence. The parse is real; GitHub and D1 are faked.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/github.server", () => ({
  getFileContent: vi.fn(),
  getFileAtRef: vi.fn(),
  getRepoTree: vi.fn(),
  getRepoHead: vi.fn(),
  getSubtreeOids: vi.fn(async () => ({ ok: true, at: () => ({ kind: "absent" }) })),
  graphqlGitHub: vi.fn(),
  githubHeaders: vi.fn(() => ({})),
  decodeGitHubContent: vi.fn((s: string) => s),
}));

vi.mock("~/lib/sheets.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/sheets.server")>()),
  discoverSheetTabs: vi.fn(),
}));

vi.mock("~/lib/story-content.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/story-content.server")>();
  return {
    ...actual,
    checkStoryContent: vi.fn(async () => ({ conclusive: true, changes: [], suppressedEditorOnly: 0 })),
  };
});

import * as githubServer from "~/lib/github.server";
import { discoverSheetTabs } from "~/lib/sheets.server";
import { glossary_terms, objects, stories } from "~/db/schema";
import { computeFullSyncDiff, hasDivergentChanges } from "~/lib/sync.server";
import { hasDiffChanges } from "~/components/features/dashboard/sync-changes";

const SHEETS = "telar-content/spreadsheets";
const BASE = "base-sha";

const CLEAN: Record<string, string> = {
  [`${SHEETS}/objects.csv`]: "object_id,title\nobj-1,First\n",
  [`${SHEETS}/project.csv`]: "order,story_id,title\n1,story-one,First\n",
  [`${SHEETS}/glossary.csv`]: "term_id,title,definition\nterm-1,Term,Meaning\n",
  "_config.yml": 'title: "Site"\n',
};

let head: Record<string, string>;
let base: Record<string, string>;

/** A D1 that holds the rows each table is given, and nothing else. */
function dbHolding(held: Map<unknown, unknown[]>) {
  return {
    select: () => ({
      from: (table: unknown) => {
        const chain = (): unknown => {
          const node = Promise.resolve(held.get(table) ?? []) as unknown as Promise<unknown[]> & Record<string, unknown>;
          for (const m of ["where", "limit", "orderBy", "innerJoin", "leftJoin"]) node[m] = () => chain();
          return node;
        };
        return chain();
      },
    }),
  } as unknown as Parameters<typeof computeFullSyncDiff>[4];
}

/** D1 as the CLEAN files parse: one object, one story, one term. */
function cleanDb(objectTitle = "First") {
  return dbHolding(
    new Map<unknown, unknown[]>([
      [objects, [{ id: 1, project_id: 1, object_id: "obj-1", title: objectTitle }]],
      [stories, [{ id: 1, project_id: 1, story_id: "story-one", title: "First", order: 1 }]],
      [glossary_terms, [{ id: 1, project_id: 1, term_id: "term-1", title: "Term", definition: "Meaning" }]],
    ]),
  );
}

/** The diff against a D1 that already holds what the files say, so only headings can diverge. */
async function diffOf(objectTitle = "First") {
  return computeFullSyncDiff(1, "t", "o", "r", cleanDb(objectTitle), BASE, {});
}

beforeEach(() => {
  vi.clearAllMocks();
  head = { ...CLEAN };
  base = { ...CLEAN };
  vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
  vi.mocked(githubServer.getRepoHead).mockResolvedValue("new-head");
  vi.mocked(githubServer.getFileAtRef).mockImplementation(async (_t, _o, _r, path, ref) => {
    const files = ref === BASE ? base : head;
    return path in files ? { status: "ok", content: files[path] } : { status: "absent" };
  });
});

describe("headingFiles", () => {
  it("names objects.csv when only its object_id heading changed, and that diverges", async () => {
    head[`${SHEETS}/objects.csv`] = "Object_ID,title\nobj-1,First\n";
    const diff = await diffOf();
    expect(diff.headingFiles).toEqual(["objects.csv"]);
    expect(hasDivergentChanges(diff)).toBe(true);
  });

  it("names project.csv when only its story_id heading changed", async () => {
    head[`${SHEETS}/project.csv`] = "order,Story_ID,title\n1,story-one,First\n";
    const diff = await diffOf();
    expect(diff.headingFiles).toEqual(["project.csv"]);
    expect(hasDivergentChanges(diff)).toBe(true);
  });

  it("does not name glossary.csv for Term_ID, which the head release reads as term_id", async () => {
    head[`${SHEETS}/glossary.csv`] = "Term_ID,title,definition\nterm-1,Term,Meaning\n";
    const diff = await diffOf();
    expect(diff.headingFiles).toEqual([]);
    expect(hasDivergentChanges(diff)).toBe(false);
  });

  it("does not diverge when the base and the head both hold Object_ID", async () => {
    base[`${SHEETS}/objects.csv`] = "Object_ID,title\nobj-1,First\n";
    head[`${SHEETS}/objects.csv`] = "Object_ID,title\nobj-1,First\n";
    const diff = await diffOf();
    expect(diff.headingFiles).toEqual([]);
    expect(hasDivergentChanges(diff)).toBe(false);
  });

  it("does not diverge on a data-only change D1 already holds", async () => {
    head[`${SHEETS}/objects.csv`] = "object_id,title\nobj-1,Second\n";
    const diff = await diffOf("Second");
    expect(diff.objects.changedObjects).toEqual([]);
    expect(diff.headingFiles).toEqual([]);
    expect(hasDivergentChanges(diff)).toBe(false);
  });

  it("is not a change the dashboard's check offers", async () => {
    head[`${SHEETS}/objects.csv`] = "Object_ID,title\nobj-1,First\n";
    expect(hasDiffChanges(await diffOf())).toBe(false);
  });

  describe("with Google Sheets on", () => {
    const SHEETS_ON = 'title: "Site"\ngoogle_sheets:\n  enabled: true\n  published_url: "https://example.org/pub"\n';

    beforeEach(() => {
      head["_config.yml"] = SHEETS_ON;
      base["_config.yml"] = SHEETS_ON;
    });

    it("leaves objects.csv out when an objects tab supplies it", async () => {
      vi.mocked(discoverSheetTabs).mockResolvedValue([{ name: "objects", gid: "0" }]);
      head[`${SHEETS}/objects.csv`] = "Object_ID,title\nobj-1,First\n";
      const diff = await diffOf();
      expect(diff.headingFiles).toEqual([]);
      expect(hasDivergentChanges(diff)).toBe(false);
      expect(discoverSheetTabs).toHaveBeenCalledTimes(1);
    });

    it("leaves objetos.csv out when an objects tab supplies it", async () => {
      vi.mocked(discoverSheetTabs).mockResolvedValue([{ name: "objects", gid: "0" }]);
      delete head[`${SHEETS}/objects.csv`];
      delete base[`${SHEETS}/objects.csv`];
      base[`${SHEETS}/objetos.csv`] = "object_id,title\nobj-1,First\n";
      head[`${SHEETS}/objetos.csv`] = "Object_ID,title\nobj-1,First\n";
      const diff = await diffOf();
      expect(diff.headingFiles).toEqual([]);
      expect(hasDivergentChanges(diff)).toBe(false);
    });

    it("lists the tabs once when the check collects warnings", async () => {
      vi.mocked(discoverSheetTabs).mockResolvedValue([{ name: "objects", gid: "0" }]);
      head[`${SHEETS}/objects.csv`] = "Object_ID,title\nobj-1,First\n";
      const diff = await computeFullSyncDiff(1, "t", "o", "r", cleanDb(), BASE, { collectWarnings: true });
      expect(diff.headingFiles).toEqual([]);
      expect(discoverSheetTabs).toHaveBeenCalledTimes(1);
    });

    it("keeps the file when no tab supplies it", async () => {
      vi.mocked(discoverSheetTabs).mockResolvedValue([{ name: "project", gid: "0" }]);
      head[`${SHEETS}/objects.csv`] = "Object_ID,title\nobj-1,First\n";
      expect((await diffOf()).headingFiles).toEqual(["objects.csv"]);
    });

    it("keeps the file when the tabs cannot be listed", async () => {
      vi.mocked(discoverSheetTabs).mockRejectedValue(new Error("offline"));
      head[`${SHEETS}/objects.csv`] = "Object_ID,title\nobj-1,First\n";
      expect((await diffOf()).headingFiles).toEqual(["objects.csv"]);
    });
  });
});
