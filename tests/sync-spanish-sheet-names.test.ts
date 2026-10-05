/**
 * The sync reads the project, objects and glossary sheets from the file the
 * build reads: the English name, else `proyecto.csv`, `objetos.csv`
 * and `glosario.csv` where the English file is not there, at the head and at
 * the three-way base alike.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/github.server", () => ({
  getFileContent: vi.fn(),
  getFileAtRef: vi.fn(),
  getRepoTree: vi.fn(),
  getRepoHead: vi.fn(),
  graphqlGitHub: vi.fn(),
  githubHeaders: vi.fn(() => ({})),
  decodeGitHubContent: vi.fn((s: string) => s),
  commitExists: vi.fn(async () => "exists"),
}));

vi.mock("~/lib/story-content.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/story-content.server")>();
  return {
    ...actual,
    checkStoryContent: vi.fn(async () => ({ conclusive: true, changes: [], suppressedEditorOnly: 0 })),
  };
});

import * as githubServer from "~/lib/github.server";
import { computeFullSyncDiff } from "~/lib/sync.server";

const SHEETS = "telar-content/spreadsheets";

/** The repository at each ref: a file's text by path. */
let atRefs: Record<string, Record<string, string>>;

/** A D1 stand-in whose reads all come back empty. */
function emptyDb() {
  const chain = (): unknown => {
    const node = Promise.resolve([]) as unknown as Promise<unknown[]> & Record<string, unknown>;
    for (const m of ["from", "where", "limit", "orderBy", "innerJoin", "leftJoin"]) node[m] = () => chain();
    return node;
  };
  return { select: () => chain() } as unknown as Parameters<typeof computeFullSyncDiff>[4];
}

function readsAt(ref: string): string[] {
  return vi.mocked(githubServer.getFileAtRef).mock.calls.filter((call) => call[4] === ref).map((call) => call[3]);
}

beforeEach(() => {
  vi.clearAllMocks();
  atRefs = { head: {}, base: {} };
  vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
  vi.mocked(githubServer.getRepoHead).mockResolvedValue("head");
  vi.mocked(githubServer.getFileAtRef).mockImplementation(async (_t, _o, _r, path, ref) => {
    const files = atRefs[ref] ?? {};
    return path in files ? { status: "ok", content: files[path] } : { status: "absent" };
  });
});

describe("a sync of a site whose sheets have Spanish names", () => {
  it("reads objetos.csv, proyecto.csv and glosario.csv at the head", async () => {
    atRefs.head = {
      [`${SHEETS}/objetos.csv`]: "object_id,title\nmapa,Mapa\n",
      [`${SHEETS}/proyecto.csv`]: "order,story_id,title\n1,historia,Historia\n",
      [`${SHEETS}/glosario.csv`]: "term_id,title,definition\ntelar,Telar,Un marco.\n",
    };

    const diff = await computeFullSyncDiff(1, "t", "o", "r", emptyDb(), null);

    expect(diff.objects.newObjects.map((o) => o.object_id)).toEqual(["mapa"]);
    expect(diff.stories.newStories.map((s) => s.story_id)).toEqual(["historia"]);
    expect(diff.glossary.added.map((t) => t.term_id)).toEqual(["telar"]);
  });

  it("names the objects sheet the diff was read from", async () => {
    atRefs.head = { [`${SHEETS}/objetos.csv`]: "object_id,title\nmapa,Mapa\n" };
    expect((await computeFullSyncDiff(1, "t", "o", "r", emptyDb(), null)).objects.objectsSheet).toBe("objetos.csv");

    atRefs.head = { [`${SHEETS}/objects.csv`]: "object_id,title\nmap,Map\n" };
    expect((await computeFullSyncDiff(1, "t", "o", "r", emptyDb(), null)).objects.objectsSheet).toBe("objects.csv");
  });

  it("reads the English file where both are there, and never the Spanish one", async () => {
    atRefs.head = {
      [`${SHEETS}/objects.csv`]: "object_id,title\nmap,Map\n",
      [`${SHEETS}/objetos.csv`]: "object_id,title\nmapa,Mapa\n",
      [`${SHEETS}/project.csv`]: "order,story_id,title\n1,story,Story\n",
      [`${SHEETS}/proyecto.csv`]: "order,story_id,title\n1,historia,Historia\n",
    };

    const diff = await computeFullSyncDiff(1, "t", "o", "r", emptyDb(), null);

    expect(diff.objects.newObjects.map((o) => o.object_id)).toEqual(["map"]);
    expect(diff.stories.newStories.map((s) => s.story_id)).toEqual(["story"]);
    expect(readsAt("head")).not.toContain(`${SHEETS}/objetos.csv`);
    expect(readsAt("head")).not.toContain(`${SHEETS}/proyecto.csv`);
  });

  it("compares against the Spanish files at the base, so an unchanged sheet offers nothing", async () => {
    const files = {
      [`${SHEETS}/objetos.csv`]: "object_id,title\nmapa,Mapa\n",
      [`${SHEETS}/proyecto.csv`]: "order,story_id,title\n1,historia,Historia\n",
      [`${SHEETS}/glosario.csv`]: "term_id,title,definition\ntelar,Telar,Un marco.\n",
    };
    atRefs.head = files;
    atRefs.base = files;

    const diff = await computeFullSyncDiff(1, "t", "o", "r", emptyDb(), "base");

    expect(diff.classification).toBe("three-way");
    expect(readsAt("base")).toEqual(expect.arrayContaining(Object.keys(files)));
    // At the base and the head alike, so D1 having none of them reads as the
    // editor's deletions, not as rows new on GitHub.
    expect(diff.objects.newObjects).toEqual([]);
    expect(diff.stories.newStories).toEqual([]);
    expect(diff.glossary.added).toEqual([]);
  });

  it("names the Spanish file in the warnings of a sheet it read", async () => {
    atRefs.head = {
      [`${SHEETS}/proyecto.csv`]: "story_id,\ns,Lost\n",
      [`${SHEETS}/objetos.csv`]: "object_id,title,\nmapa,Mapa,Lost\n",
      [`${SHEETS}/glosario.csv`]: "term_id,title,definition,\ntelar,Telar,Un marco.,Lost\n",
    };

    const diff = await computeFullSyncDiff(1, "t", "o", "r", emptyDb(), null, { collectWarnings: true });

    const blank = (diff.warnings ?? []).filter((w) => w.code === "blank_header");
    expect(blank.map((w) => (w as { sheet?: string }).sheet).sort()).toEqual(["glosario.csv", "objetos.csv", "proyecto.csv"]);
  });

  it("names the English file where it is the one read", async () => {
    atRefs.head = { [`${SHEETS}/project.csv`]: "story_id,\ns,Lost\n" };

    const diff = await computeFullSyncDiff(1, "t", "o", "r", emptyDb(), null, { collectWarnings: true });

    expect((diff.warnings ?? []).filter((w) => w.code === "blank_header").map((w) => (w as { sheet?: string }).sheet)).toEqual(["project.csv"]);
  });
});
