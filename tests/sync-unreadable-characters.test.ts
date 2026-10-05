/**
 * The syncs name each file read at the head whose bytes are not valid UTF-8, and the full sync reports those files whether or not it collects
 * warnings (`unreadableFiles`), so the status refresh counts them as
 * divergence. A file lossy only at the base is not named: the base is the
 * state last reconciled, not what the author now has.
 *
 * The parse is real; GitHub and D1 are faked, and the story check stands in
 * for one that read nothing (its own reads are in sync-story-content.test.ts).
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/github.server", () => ({
  getFileContent: vi.fn(),
  getFileAtRef: vi.fn(),
  getRepoTree: vi.fn(),
  getRepoHead: vi.fn(),
  // The pages folder absent at every commit: no page file on either side.
  getSubtreeOids: vi.fn(async () => ({ ok: true, at: () => ({ kind: "absent" }) })),
  graphqlGitHub: vi.fn(),
  githubHeaders: vi.fn(() => ({})),
  decodeGitHubContent: vi.fn((s: string) => s),
}));

vi.mock("~/lib/story-content.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/story-content.server")>();
  return {
    ...actual,
    checkStoryContent: vi.fn(async () => ({ conclusive: true, changes: [], suppressedEditorOnly: 0 })),
  };
});

import * as githubServer from "~/lib/github.server";
import type { FileAtRef } from "~/lib/github.server";
import { computeSyncDiff, computeFullSyncDiff, hasDivergentChanges } from "~/lib/sync.server";
import type { SheetWarning } from "~/lib/sheet-warnings";

const SHEETS = "telar-content/spreadsheets";
const BASE = "base-sha";
const COLLECT = { collectWarnings: true };
const R = "�";

const CLEAN: Record<string, string> = {
  [`${SHEETS}/objects.csv`]: "object_id,title\nobj-001,First\n",
  [`${SHEETS}/project.csv`]: "order,story_id,title\n",
  [`${SHEETS}/glossary.csv`]: "term_id,title,definition\n",
  "_config.yml": 'title: "Site"\n',
};

let head: Record<string, string>;
let base: Record<string, string>;
let lossyAtHead: Set<string>;
let lossyAtBase: Set<string>;

function answer(files: Record<string, string>, lossy: Set<string>, path: string): FileAtRef {
  if (!(path in files)) return { status: "absent" };
  return lossy.has(path) ? { status: "ok", content: files[path], lossy: true } : { status: "ok", content: files[path] };
}

/** A D1 stand-in whose reads all come back empty. */
function emptyDb() {
  const chain = (): unknown => {
    const node = Promise.resolve([]) as unknown as Promise<unknown[]> & Record<string, unknown>;
    for (const m of ["from", "where", "limit", "orderBy", "innerJoin", "leftJoin"]) node[m] = () => chain();
    return node;
  };
  return { select: () => chain() } as unknown as Parameters<typeof computeSyncDiff>[4];
}

function unreadable(warnings: SheetWarning[] | undefined): SheetWarning[] {
  return (warnings ?? []).filter((w) => w.code === "unreadable_characters");
}

beforeEach(() => {
  vi.clearAllMocks();
  head = { ...CLEAN };
  base = { ...CLEAN };
  lossyAtHead = new Set();
  lossyAtBase = new Set();
  vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
  vi.mocked(githubServer.getRepoHead).mockResolvedValue("new-head");
  vi.mocked(githubServer.getFileAtRef).mockImplementation(async (_t, _o, _r, path, ref) =>
    ref === BASE ? answer(base, lossyAtBase, path) : answer(head, lossyAtHead, path),
  );
});

describe("the objects page's sync", () => {
  it("names objects.csv read lossily, with the diff the valid encoding of U+FFFD gives", async () => {
    head[`${SHEETS}/objects.csv`] = `object_id,title\nobj-001,First${R}\n`;
    const clean = await computeSyncDiff(1, "t", "o", "r", emptyDb());
    lossyAtHead.add(`${SHEETS}/objects.csv`);
    const lossy = await computeSyncDiff(1, "t", "o", "r", emptyDb());

    expect(unreadable(lossy.warnings)).toEqual([
      { code: "unreadable_characters", file: "objects.csv", effect: "build_stops", repair: "publish" },
    ]);
    expect(unreadable(clean.warnings)).toEqual([]);
    const { warnings: _w1, unreadableFiles: _u1, ...lossyRest } = lossy;
    const { warnings: _w2, unreadableFiles: _u2, ...cleanRest } = clean;
    expect(lossyRest).toEqual(cleanRest);
    expect(lossy.unreadableFiles).toEqual(["objects.csv"]);
    expect(clean.unreadableFiles).toEqual([]);
  });
});

describe("the full sync, collecting warnings", () => {
  it.each([
    [`${SHEETS}/objects.csv`, "objects.csv"],
    [`${SHEETS}/project.csv`, "project.csv"],
    [`${SHEETS}/glossary.csv`, "glossary.csv"],
    ["_config.yml", "_config.yml"],
  ])("names %s read lossily at the head, once", async (path, file) => {
    lossyAtHead.add(path);

    const diff = await computeFullSyncDiff(1, "t", "o", "r", emptyDb(), BASE, COLLECT);

    expect(unreadable(diff.warnings)).toEqual([
      { code: "unreadable_characters", file, effect: "build_stops", repair: "publish" },
    ]);
    expect(diff.unreadableFiles).toEqual([file]);
  });

  it.each([`${SHEETS}/objects.csv`, `${SHEETS}/project.csv`, `${SHEETS}/glossary.csv`, "_config.yml"])(
    "does not name %s lossy only at the base",
    async (path) => {
      lossyAtBase.add(path);

      const diff = await computeFullSyncDiff(1, "t", "o", "r", emptyDb(), BASE, COLLECT);

      expect(diff.classification).toBe("three-way");
      expect(unreadable(diff.warnings)).toEqual([]);
      expect(diff.unreadableFiles).toEqual([]);
    },
  );

  it("names a new story's step CSV read lossily", async () => {
    head[`${SHEETS}/project.csv`] = "order,story_id,title\n1,story-one,First\n";
    head[`${SHEETS}/story-one.csv`] = `step,object,question\n1,obj-001,Q${R}\n`;
    lossyAtHead.add(`${SHEETS}/story-one.csv`);

    const diff = await computeFullSyncDiff(1, "t", "o", "r", emptyDb(), null, COLLECT);

    expect(diff.stories.newStories.map((s) => s.story_id)).toEqual(["story-one"]);
    expect(unreadable(diff.warnings)).toEqual([
      { code: "unreadable_characters", file: "story-one.csv", effect: "left_out", repair: "publish" },
    ]);
  });

  it("names a layer file a new story's clean step CSV names, read lossily", async () => {
    head[`${SHEETS}/project.csv`] = "order,story_id,title\n1,story-one,First\n";
    head[`${SHEETS}/story-one.csv`] =
      "step,object,question,layer1_button,layer1_content\n1,obj-001,Q,More,panel.md\n2,obj-001,Q2,More,panel.md\n";
    head["telar-content/texts/stories/panel.md"] = `Panel ${R}\n`;
    lossyAtHead.add("telar-content/texts/stories/panel.md");

    const diff = await computeFullSyncDiff(1, "t", "o", "r", emptyDb(), null, COLLECT);

    expect(unreadable(diff.warnings)).toEqual([
      {
        code: "unreadable_characters",
        file: "telar-content/texts/stories/panel.md",
        effect: "name_shown",
        repair: "publish",
      },
    ]);
  });

  it("reads a layer file new stories name in several cells once", async () => {
    head[`${SHEETS}/project.csv`] = "order,story_id,title\n1,story-one,First\n2,story-two,Second\n";
    const csv = "step,object,question,layer1_button,layer1_content\n1,obj-001,Q,More,panel.md\n2,obj-001,Q2,More,panel.md\n";
    head[`${SHEETS}/story-one.csv`] = csv;
    head[`${SHEETS}/story-two.csv`] = csv;
    head["telar-content/texts/stories/panel.md"] = "Panel\n";

    await computeFullSyncDiff(1, "t", "o", "r", emptyDb(), null, COLLECT);

    const reads = vi.mocked(githubServer.getFileAtRef).mock.calls.filter((c) => c[3] === "telar-content/texts/stories/panel.md");
    expect(reads).toHaveLength(1);
  });

  it("names nothing for files holding the valid encoding of U+FFFD", async () => {
    for (const path of Object.keys(head)) head[path] = head[path] + `# ${R}\n`;

    const diff = await computeFullSyncDiff(1, "t", "o", "r", emptyDb(), BASE, COLLECT);

    expect(unreadable(diff.warnings)).toEqual([]);
    expect(diff.unreadableFiles).toEqual([]);
  });
});

describe("the full sync without warnings, as the status refresh runs it", () => {
  it.each([`${SHEETS}/objects.csv`, `${SHEETS}/project.csv`, `${SHEETS}/glossary.csv`, "_config.yml"])(
    "reports %s read lossily as unreadable, and the diff as divergent",
    async (path) => {
      head[path] = head[path] + `# ${R}\n`;
      base[path] = head[path];
      const clean = await computeFullSyncDiff(1, "t", "o", "r", emptyDb(), BASE);
      lossyAtHead.add(path);
      const lossy = await computeFullSyncDiff(1, "t", "o", "r", emptyDb(), BASE);

      expect(lossy.warnings).toBeUndefined();
      expect(lossy.unreadableFiles).toHaveLength(1);
      expect(hasDivergentChanges(lossy)).toBe(true);
      expect(clean.unreadableFiles).toEqual([]);
      expect(hasDivergentChanges(clean)).toBe(false);
    },
  );

  it("reads no new story's files", async () => {
    head[`${SHEETS}/project.csv`] = "order,story_id,title\n1,story-one,First\n";
    head[`${SHEETS}/story-one.csv`] = `step,object,question\n1,obj-001,Q${R}\n`;
    lossyAtHead.add(`${SHEETS}/story-one.csv`);

    const diff = await computeFullSyncDiff(1, "t", "o", "r", emptyDb(), null);

    expect(diff.unreadableFiles).toEqual([]);
    const paths = vi.mocked(githubServer.getFileAtRef).mock.calls.map((c) => String(c[3]));
    expect(paths).not.toContain(`${SHEETS}/story-one.csv`);
  });
});
