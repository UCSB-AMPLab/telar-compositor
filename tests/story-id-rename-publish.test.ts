/**
 * A publish after a story's ID is changed writes the story under the
 * new ID and deletes what it wrote under the old one, in the same commit: the
 * old step CSV, which the prior publish's snapshot names
 * (`computeStoryDeletions`), and the layer files that CSV names at the head
 * the publish is built on (`deletedStoryLayerFiles`). A story deleted outright
 * leaves the same files and takes the same path. A layer file the publish also
 * writes is kept; a CSV that cannot be read names nothing, since leftover
 * layer files are not read by the site.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

/** The listings at the ref: the CSVs `blobs` holds in the spreadsheets folder, the layer files `present` holds in the texts folder. */
const listingState = vi.hoisted(() => ({ unavailable: false, textsOnly: false, names: null as string[] | null, textDirs: [] as string[] }));
vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getSubtreeOids: vi.fn(async (_t: string, _o: string, _r: string, _refs: string[], dirs: string[]) =>
      listingState.unavailable && (!listingState.textsOnly || dirs.some((d) => d.endsWith("/stories")))
        ? { ok: false, reason: "malformed" }
        : { ok: true, at: (_ref: string, dir: string) => ({ kind: "tree", oid: dir.endsWith("/stories") ? "texts-oid" : "sheets-oid" }) }),
    listSubtreeEntries: vi.fn(async (_t: string, _o: string, _r: string, oid: string) => ({
      files: new Map((oid === "texts-oid" ? textNamesPresent() : listingState.names ?? sheetNamesInBlobs()).map((n) => [n, `blob-${n}`])),
      dirs: new Set(oid === "texts-oid" ? listingState.textDirs : []),
    })),
  };
});

import { commitFilesToRepo } from "~/lib/commit.server";
import { computeStoryDeletions, renderStoryFiles, type PublishSnapshot } from "~/lib/publish.server";
import { deletedStoryLayerFiles, renamedStorySheets, sheetsOfStoriesWritten } from "~/lib/story-left-files.server";

const SHEETS = "telar-content/spreadsheets";
const TEXTS = "telar-content/texts/stories";
const SOURCE = { token: "tok", owner: "o", repo: "r", ref: "head-sha" };

const OLD_CSV = [
  "step,object,x,y,zoom,question,answer,layer1_button,layer1_content,layer2_button,layer2_content",
  "1,bell,0.5,0.5,1,Q,A,More,blank_template-intro.md,,",
  "2,bell,0.5,0.5,1,Q2,A2,,blank_template-step2-layer1.md,Deeper,blank_template-deeper.md",
].join("\n") + "\n";

let blobs: Record<string, string | "fail">;

function sheetNamesInBlobs(): string[] {
  return Object.keys(blobs).filter((p) => p.startsWith(`${SHEETS}/`)).map((p) => p.slice(SHEETS.length + 1));
}
let present: Set<string>;

/** The layer files `OLD_CSV` names, held in the texts folder. */
const oldFiles = () => new Set([`${TEXTS}/blank_template-intro.md`, `${TEXTS}/blank_template-step2-layer1.md`, `${TEXTS}/blank_template-deeper.md`]);

function textNamesPresent(): string[] {
  return [...present].filter((p) => p.startsWith(`${TEXTS}/`)).map((p) => p.slice(TEXTS.length + 1));
}
let mutation: { variables: { input: { fileChanges: { deletions?: Array<{ path: string }> } } } } | null;

beforeEach(() => {
  mutation = null;
  blobs = {};
  present = new Set();
  listingState.unavailable = false;
  listingState.textsOnly = false;
  listingState.textDirs = [];
  listingState.names = null;
  globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
    const contents = /\/repos\/o\/r\/contents\/([^?]+)\?ref=head-sha$/.exec(String(url));
    if (contents) {
      const path = contents[1].split("/").map(decodeURIComponent).join("/");
      const blob = blobs[path];
      if (blob === "fail") return new Response("boom", { status: 502 });
      if (blob === undefined) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      const bytes = new TextEncoder().encode(blob);
      return new Response(
        JSON.stringify({ type: "file", encoding: "base64", content: Buffer.from(bytes).toString("base64"), size: bytes.length }),
        { status: 200 },
      );
    }
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, string> };
    if (body.query.includes("CheckPaths")) {
      const repository: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(body.variables)) {
        if (!/^p\d+$/.test(key)) continue;
        repository[key] = present.has(value.slice(value.indexOf(":") + 1)) ? { __typename: "Blob" } : null;
      }
      return new Response(JSON.stringify({ data: { repository } }), { status: 200 });
    }
    if (body.query.includes("CreateCommit")) {
      mutation = body as never;
      return new Response(
        JSON.stringify({ data: { createCommitOnBranch: { commit: { oid: "new", url: "u" } } } }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected query ${body.query}`);
  }) as unknown as typeof fetch;
});

const snapshotListing = (...ids: string[]) => ({ story_ids: ids, all_story_ids: ids }) as unknown as PublishSnapshot;

describe("a publish after a story's ID changes", () => {
  it("writes the renamed story's files and deletes the old CSV and its layer files", async () => {
    blobs = { [`${SHEETS}/blank_template.csv`]: OLD_CSV };
    present = new Set([
      `${SHEETS}/blank_template.csv`,
      `${TEXTS}/blank_template-intro.md`,
      `${TEXTS}/blank_template-step2-layer1.md`,
      `${TEXTS}/blank_template-deeper.md`,
      `${TEXTS}/unrelated.md`,
    ]);
    const written = await renderStoryFiles(
      "fluidity",
      [{ id: 1, step_number: 1, object_id: "bell" } as never],
      [{ step_id: 1, layer_number: 1, title: "Intro", button_label: "More", content: "Body" }],
    );
    const storyDeletions = computeStoryDeletions(["fluidity"], snapshotListing("blank_template"));
    const deletions = [...storyDeletions, ...(await deletedStoryLayerFiles(SOURCE, storyDeletions, written))];

    await commitFilesToRepo("tok", "o", "r", "main", written, "Publish site", undefined, deletions, undefined, "head-sha");

    expect(written.map((f) => f.path)).toEqual([`${SHEETS}/fluidity.csv`, `${TEXTS}/fluidity-intro.md`]);
    expect((mutation?.variables.input.fileChanges.deletions ?? []).map((d) => d.path).sort()).toEqual([
      `${SHEETS}/blank_template.csv`,
      `${TEXTS}/blank_template-deeper.md`,
      `${TEXTS}/blank_template-intro.md`,
      `${TEXTS}/blank_template-step2-layer1.md`,
    ]);
  });

  it("keeps a layer file the publish also writes", async () => {
    blobs = { [`${SHEETS}/blank_template.csv`]: OLD_CSV };
    present = oldFiles();
    const written = [{ path: `${TEXTS}/blank_template-intro.md`, content: "kept" }];
    expect(await deletedStoryLayerFiles(SOURCE, [`${SHEETS}/blank_template.csv`], written)).toEqual([
      `${TEXTS}/blank_template-step2-layer1.md`,
      `${TEXTS}/blank_template-deeper.md`,
    ]);
  });

  it("never names a path outside the story texts folder", async () => {
    blobs = {
      [`${SHEETS}/blank_template.csv`]: "step,object,layer1_content,layer2_content\n1,bell,../../../_config.yml.md,sub/./x.md\n",
    };
    expect(await deletedStoryLayerFiles(SOURCE, [`${SHEETS}/blank_template.csv`], [])).toEqual([]);
  });

  it("names nothing for a CSV that is absent or cannot be read", async () => {
    blobs = { [`${SHEETS}/failing.csv`]: "fail" };
    expect(await deletedStoryLayerFiles(SOURCE, [`${SHEETS}/gone.csv`, `${SHEETS}/failing.csv`], [])).toEqual([]);
  });

  it("keeps a layer file another story CSV in the repository still names", async () => {
    blobs = {
      [`${SHEETS}/blank_template.csv`]: "step,object,layer1_content,layer2_content\n1,bell,shared.md,blank_template-intro.md\n",
      [`${SHEETS}/orphan.csv`]: "step,object,layer1_content\n1,bell,Shared.md\n",
      // Not a story: never read for references, so a read that would fail is never made.
      [`${SHEETS}/project.csv`]: "fail",
    };
    present = new Set([`${TEXTS}/shared.md`, `${TEXTS}/blank_template-intro.md`]);
    expect(await deletedStoryLayerFiles(SOURCE, [`${SHEETS}/blank_template.csv`], [])).toEqual([
      `${TEXTS}/blank_template-intro.md`,
    ]);
  });

  it("does not read a CSV in a subfolder of the spreadsheets folder, which the framework does not read as a story", async () => {
    blobs = { [`${SHEETS}/blank_template.csv`]: OLD_CSV, [`${SHEETS}/archive/old.csv`]: "fail" };
    present = oldFiles();
    expect(await deletedStoryLayerFiles(SOURCE, [`${SHEETS}/blank_template.csv`], [])).toHaveLength(3);
  });

  it("keeps no layer file a subfolder CSV names", async () => {
    blobs = {
      [`${SHEETS}/blank_template.csv`]: OLD_CSV,
      [`${SHEETS}/archive/old.csv`]: "step,object,layer1_content\n1,bell,blank_template-intro.md\n",
    };
    present = oldFiles();
    expect(await deletedStoryLayerFiles(SOURCE, [`${SHEETS}/blank_template.csv`], [])).toHaveLength(3);
  });

  it("deletes no layer file when the other story CSVs cannot all be read", async () => {
    blobs = { [`${SHEETS}/blank_template.csv`]: OLD_CSV, [`${SHEETS}/orphan.csv`]: "fail" };
    expect(await deletedStoryLayerFiles(SOURCE, [`${SHEETS}/blank_template.csv`], [])).toEqual([]);
  });

  it("deletes no layer file when the spreadsheets folder cannot be listed", async () => {
    blobs = { [`${SHEETS}/blank_template.csv`]: OLD_CSV };
    listingState.unavailable = true;
    expect(await deletedStoryLayerFiles(SOURCE, [`${SHEETS}/blank_template.csv`], [])).toEqual([]);
  });

  it("does not read a CSV the publish writes, which names only files it writes", async () => {
    blobs = { [`${SHEETS}/blank_template.csv`]: OLD_CSV, [`${SHEETS}/fluidity.csv`]: "fail" };
    present = oldFiles();
    const written = [{ path: `${SHEETS}/fluidity.csv`, content: "step\n" }];
    expect(await deletedStoryLayerFiles(SOURCE, [`${SHEETS}/blank_template.csv`], written)).toHaveLength(3);
  });

  it("keeps a layer file the CSV the publish writes still names, as a preserved column", async () => {
    const shared = "step,object,layer1_button,layer1_content,layer3_button,layer3_content\n1,bell,A,shared.md,B,shared.md\n";
    const old = "step,object,layer1_button,layer1_content,layer2_button,layer2_content\n1,bell,A,old.md,B,shared.md\n";
    present = new Set([`${TEXTS}/old.md`, `${TEXTS}/shared.md`]);
    blobs = { [`${SHEETS}/story.csv`]: shared };
    const written = [{ path: `${SHEETS}/story.csv`, content: "step,object,layer3_button,layer3_content\n1,bell,B,shared.md\n" }];
    expect(await deletedStoryLayerFiles(SOURCE, [`${SHEETS}/story.csv`], written)).toEqual([]);
    blobs = { [`${SHEETS}/story.csv`]: old };
    expect(await deletedStoryLayerFiles(SOURCE, [`${SHEETS}/story.csv`], written)).toEqual([`${TEXTS}/old.md`]);
  });

  it("deletes the file held, whatever case the CSV spells its layer in", async () => {
    blobs = { [`${SHEETS}/story.csv`]: "step,object,layer1_content\n1,bell,INTRO.md\n" };
    present = new Set([`${TEXTS}/intro.md`]);
    expect(await deletedStoryLayerFiles(SOURCE, [`${SHEETS}/story.csv`], [])).toEqual([`${TEXTS}/intro.md`]);
  });

  it("deletes the old file when a layer is renamed only in case", async () => {
    blobs = { [`${SHEETS}/story.csv`]: "step,object,layer1_content\n1,bell,story-INTRO.md\n" };
    present = new Set([`${TEXTS}/story-INTRO.md`]);
    const written = [
      { path: `${SHEETS}/story.csv`, content: "step,object,layer1_content\n1,bell,story-intro.md\n" },
      { path: `${TEXTS}/story-intro.md`, content: "Body" },
    ];
    expect(await deletedStoryLayerFiles(SOURCE, [`${SHEETS}/story.csv`], written)).toEqual([`${TEXTS}/story-INTRO.md`]);
  });

  it("never deletes a file the publish's CSV resolves to, whatever case it spells it in", async () => {
    blobs = { [`${SHEETS}/story.csv`]: "step,object,layer1_content\n1,bell,old.md\n" };
    present = new Set([`${TEXTS}/old.md`]);
    const written = [{ path: `${SHEETS}/story.csv`, content: "step,object,layer1_content\n1,bell,OLD.md\n" }];
    expect(await deletedStoryLayerFiles(SOURCE, [`${SHEETS}/story.csv`], written)).toEqual([]);
  });

  it("deletes no layer file when the texts folder cannot be listed", async () => {
    blobs = { [`${SHEETS}/story.csv`]: "step,object,layer1_content\n1,bell,a.md\n" };
    present = new Set([`${TEXTS}/a.md`]);
    listingState.unavailable = true;
    listingState.textsOnly = true;
    expect(await deletedStoryLayerFiles(SOURCE, [`${SHEETS}/story.csv`], [])).toEqual([]);
  });

  it("deletes no file when a directory of the spelled name is in the framework's way", async () => {
    blobs = { [`${SHEETS}/story.csv`]: "step,object,layer1_content\n1,bell,INTRO.md\n" };
    present = new Set([`${TEXTS}/intro.md`]);
    listingState.textDirs = ["INTRO.md"];
    expect(await deletedStoryLayerFiles(SOURCE, [`${SHEETS}/story.csv`], [])).toEqual([]);
  });

  it("deletes the file of the spelled name when only a later lowercased path is a directory", async () => {
    blobs = { [`${SHEETS}/story.csv`]: "step,object,layer1_content\n1,bell,INTRO.md\n" };
    present = new Set([`${TEXTS}/INTRO.md`]);
    listingState.textDirs = ["intro.md"];
    expect(await deletedStoryLayerFiles(SOURCE, [`${SHEETS}/story.csv`], [])).toEqual([`${TEXTS}/INTRO.md`]);
  });

  it("deletes no file for a non-ASCII reference that only a lowercasing would match", async () => {
    blobs = { [`${SHEETS}/story.csv`]: "step,object,layer1_content\n1,bell,\uA7CE.md\n" };
    present = new Set([`${TEXTS}/\uA7CF.md`]);
    expect(await deletedStoryLayerFiles(SOURCE, [`${SHEETS}/story.csv`], [])).toEqual([]);
  });

  it("deletes the file the head holds when the publish writes a file the new spelling matches exactly", async () => {
    blobs = { [`${SHEETS}/story.csv`]: "step,object,layer1_content\n1,bell,Story-intro.md\n" };
    present = new Set([`${TEXTS}/story-intro.md`]);
    const written = [
      { path: `${SHEETS}/story.csv`, content: "step,object,layer1_content\n1,bell,other.md\n" },
      { path: `${TEXTS}/Story-intro.md`, content: "Body" },
      { path: `${TEXTS}/other.md`, content: "Body" },
    ];
    expect(await deletedStoryLayerFiles(SOURCE, [`${SHEETS}/story.csv`], written)).toEqual([`${TEXTS}/story-intro.md`]);
  });

  it("deletes nothing when a CSV that stays names a reference whose reading cannot be told", async () => {
    blobs = {
      [`${SHEETS}/story.csv`]: "step,object,layer1_content\n1,bell,old.md\n",
      [`${SHEETS}/other.csv`]: "step,object,layer1_content\n1,bell,\uA7CE.md\n",
    };
    present = new Set([`${TEXTS}/old.md`]);
    expect(await deletedStoryLayerFiles(SOURCE, [`${SHEETS}/story.csv`], [])).toEqual([]);
  });

  it("reads nothing when no story left", async () => {
    expect(await deletedStoryLayerFiles(SOURCE, [], [])).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("the CSV a renamed story was last written to, with no publish snapshot", () => {
  const story = (story_id: string, source_path: string | null) => ({ story_id, source_path });

  it("is named from the story's own record when no story writes that path", () => {
    expect(renamedStorySheets([story("fluidity", `${SHEETS}/blank_template.csv`), story("maps", null)])).toEqual([
      `${SHEETS}/blank_template.csv`,
    ]);
  });

  it("is not named when it is the story's own path, another story's, or outside the spreadsheets folder", () => {
    expect(renamedStorySheets([
      story("maps", `${SHEETS}/maps.csv`),
      story("fluidity", `${SHEETS}/river.csv`),
      story("river", null),
      story("delta", "_data/blank_template.csv"),
    ])).toEqual([]);
  });

  it("is deleted with its panel files by a publish that writes the story under its new ID", async () => {
    blobs = { [`${SHEETS}/blank_template.csv`]: OLD_CSV };
    present = new Set([`${SHEETS}/blank_template.csv`, `${TEXTS}/blank_template-intro.md`, `${TEXTS}/blank_template-deeper.md`]);
    const rows = [story("fluidity", `${SHEETS}/blank_template.csv`)];
    const left = [...computeStoryDeletions(["fluidity"], null), ...renamedStorySheets(rows)];
    const deletions = [...left, ...(await deletedStoryLayerFiles(SOURCE, left, []))];

    await commitFilesToRepo("tok", "o", "r", "main", [{ path: `${SHEETS}/fluidity.csv`, content: "step\n" }], "Publish site", undefined, deletions, undefined, "head-sha");

    expect((mutation?.variables.input.fileChanges.deletions ?? []).map((d) => d.path).sort()).toEqual([
      `${SHEETS}/blank_template.csv`,
      `${TEXTS}/blank_template-deeper.md`,
      `${TEXTS}/blank_template-intro.md`,
    ]);
  });
});

describe("a chain of renamed stories", () => {
  const A_CSV = `${SHEETS}/blank_template.csv`;
  const B_CSV = `${SHEETS}/fluidity.csv`;
  const B_OLD = "step,object,layer1_content\n1,bell,fluidity-intro.md\n";

  it("finds the layer files of the file another story overwrites, and deletes them", async () => {
    blobs = { [A_CSV]: OLD_CSV, [B_CSV]: B_OLD };
    present = new Set([
      A_CSV, B_CSV,
      `${TEXTS}/blank_template-intro.md`, `${TEXTS}/blank_template-step2-layer1.md`, `${TEXTS}/blank_template-deeper.md`,
      `${TEXTS}/fluidity-intro.md`,
    ]);
    // A: blank_template -> fluidity; B: fluidity -> river.
    const rows = [
      { story_id: "fluidity", source_path: A_CSV },
      { story_id: "river", source_path: B_CSV },
    ];
    const written = [
      { path: B_CSV, content: "step\n" },
      { path: `${SHEETS}/river.csv`, content: "step\n" },
    ];
    const left = [...renamedStorySheets(rows), ...sheetsOfStoriesWritten(rows, written)];
    expect(left).toEqual([A_CSV, B_CSV, `${SHEETS}/river.csv`]);
    const deletions = [...renamedStorySheets(rows), ...(await deletedStoryLayerFiles(SOURCE, left, written))];

    await commitFilesToRepo("tok", "o", "r", "main", written, "Publish site", undefined, deletions, undefined, "head-sha");

    expect((mutation?.variables.input.fileChanges.deletions ?? []).map((d) => d.path).sort()).toEqual([
      A_CSV,
      `${TEXTS}/blank_template-deeper.md`,
      `${TEXTS}/blank_template-intro.md`,
      `${TEXTS}/blank_template-step2-layer1.md`,
      `${TEXTS}/fluidity-intro.md`,
    ]);
  });
});

describe("a story's layer file its CSV named and the publish no longer writes", () => {
  const CSV_PATH = `${SHEETS}/fluidity.csv`;
  const OLD = "step,object,layer1_content,layer2_content\n1,bell,fluidity-intro.md,fluidity-deeper.md\n";
  const rows = [{ story_id: "fluidity" }];
  const step = [{ id: 1, step_number: 1, object_id: "bell" } as never];

  async function layerDeletionsOfRepublish(layerRows: Parameters<typeof renderStoryFiles>[2]): Promise<string[]> {
    const written = await renderStoryFiles("fluidity", step, layerRows);
    const left = sheetsOfStoriesWritten(rows, written);
    const deletions = await deletedStoryLayerFiles(SOURCE, left, written);
    await commitFilesToRepo("tok", "o", "r", "main", written, "Publish site", undefined, deletions, undefined, "head-sha");
    return (mutation?.variables.input.fileChanges.deletions ?? []).map((d) => d.path).sort();
  }

  const layer = (layer_number: number, title: string) => ({ step_id: 1, layer_number, title, button_label: "More", content: "Body" });

  it("deletes the file a retitled layer was written to", async () => {
    blobs = { [CSV_PATH]: OLD };
    present = new Set([CSV_PATH, `${TEXTS}/fluidity-intro.md`, `${TEXTS}/fluidity-deeper.md`]);
    expect(await layerDeletionsOfRepublish([layer(1, "Opening"), layer(2, "Deeper")])).toEqual([`${TEXTS}/fluidity-intro.md`]);
  });

  it("deletes the file of a layer that was removed", async () => {
    blobs = { [CSV_PATH]: OLD };
    present = new Set([CSV_PATH, `${TEXTS}/fluidity-intro.md`, `${TEXTS}/fluidity-deeper.md`]);
    expect(await layerDeletionsOfRepublish([layer(1, "Intro")])).toEqual([`${TEXTS}/fluidity-deeper.md`]);
  });

  it("keeps a file added by hand that no CSV names", async () => {
    blobs = { [CSV_PATH]: OLD };
    present = new Set([CSV_PATH, `${TEXTS}/fluidity-intro.md`, `${TEXTS}/fluidity-notes.md`]);
    expect(await layerDeletionsOfRepublish([layer(1, "Opening")])).toEqual([`${TEXTS}/fluidity-intro.md`]);
  });

  it("keeps a file another story's CSV names", async () => {
    blobs = { [CSV_PATH]: OLD, [`${SHEETS}/river.csv`]: "step,object,layer1_content\n1,bell,fluidity-deeper.md\n" };
    present = new Set([CSV_PATH, `${TEXTS}/fluidity-intro.md`, `${TEXTS}/fluidity-deeper.md`]);
    expect(await layerDeletionsOfRepublish([layer(1, "Intro")])).toEqual([]);
  });

  it("names the CSVs the publish writes for stories, and only those", () => {
    expect(sheetsOfStoriesWritten([{ story_id: "a" }, { story_id: "b" }], [{ path: `${SHEETS}/a.csv`, content: "" }])).toEqual([`${SHEETS}/a.csv`]);
  });
});
