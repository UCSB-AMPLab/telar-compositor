/**
 * Which stories a publish reads for kept columns D1 never recorded, and where
 * the cells it reads go.
 *
 * `planKeptColumnsCapture` runs against the real `github.server` module and a
 * stubbed `fetch` holding the publish commit's files, so each read is counted
 * at the network. `carryKeptCells` is the alignment on its own.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  StoriesUnreadableError,
  carryKeptCells,
  isUnrecorded,
  planKeptColumnsCapture,
} from "~/lib/kept-columns-capture.server";
import type { CaptureLayerRow, CaptureStepRow, CaptureStory } from "~/lib/kept-columns-capture.server";
import { renderStoryFiles } from "~/lib/publish.server";
import type { StoryStepRow } from "~/lib/publish.server";
import { canonicalForCompareFromD1, rawCanonicalFromD1 } from "~/lib/story-content.server";
import { __clearStoryBlobCacheForTest } from "~/lib/story-files.server";
import { storyRowsFromFiles } from "~/lib/story-file-rows.server";
import type { StoryFileRows } from "~/lib/story-file-rows.server";
import { mapStoryCsv } from "~/lib/import.server";
import { canonicalRaw, contentFromRows } from "~/lib/story-canonical";
import { SHEETS, TEXTS, addStoryCommit, emptyStoryRepo, storyRepoAnswer } from "./helpers/story-repo-fetch";
import type { StoryRepo } from "./helpers/story-repo-fetch";

const ACCESS = { token: "tok", owner: "owner", repo: "repo" };
const SHA = "publish-sha";

let repo: StoryRepo;

beforeEach(() => {
  __clearStoryBlobCacheForTest();
  repo = emptyStoryRepo();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const answer = await storyRepoAnswer(repo, input, init);
    if (!answer) throw new Error(`unexpected request: ${String(input)}`);
    return answer;
  }));
});

afterEach(() => vi.unstubAllGlobals());

/** A D1 media step as an import of `step,object,x,y,zoom,question,answer` rows stores it. */
function d1Step(id: number, rank: number, question: string, extra: string | null = null): CaptureStepRow {
  return {
    id, step_number: rank, order_key: `a${rank}`, kind: "media", object_id: "obj", x: 0.5, y: 0.5, zoom: 1,
    page: null, question, answer: `answer ${question}`, alt_text: null, clip_start: null, clip_end: null,
    loop: null, extra_columns: extra,
  };
}

function story(storyId: string, stepRows: CaptureStepRow[], layerRows: CaptureLayerRow[] = []) {
  const loadLayers = vi.fn(async () => layerRows);
  return { storyId, stepRows, loadLayers } satisfies CaptureStory;
}

/** A story CSV holding these steps, with a `note` column where a note is given. */
function csv(steps: Array<{ question: string; note?: string }>, withNote = true): string {
  const header = `step,object,x,y,zoom,question,answer${withNote ? ",note" : ""}`;
  const rows = steps.map((s, i) =>
    `${i + 1},obj,0.5,0.5,1,${s.question},answer ${s.question}${withNote ? `,${s.note ?? ""}` : ""}`);
  return [header, ...rows].join("\n") + "\n";
}

async function rendered(storyId: string, stepRows: StoryStepRow[]): Promise<string> {
  return (await renderStoryFiles(storyId, stepRows, [])).find((f) => f.path === `${SHEETS}/${storyId}.csv`)!.content;
}

describe("which stories are unrecorded", () => {
  it("is every step whose kept columns were never recorded: null or empty", () => {
    expect(isUnrecorded([d1Step(1, 1, "A"), d1Step(2, 2, "B", "")])).toBe(true);
  });

  it("is not a story whose last kept column was removed: \"{}\" is recorded", () => {
    expect(isUnrecorded([d1Step(1, 1, "A"), d1Step(2, 2, "B", "{}")])).toBe(false);
  });

  it("is not a story with a kept column on any step", () => {
    expect(isUnrecorded([d1Step(1, 1, "A"), d1Step(2, 2, "B", JSON.stringify({ note: "kept" }))])).toBe(false);
  });
});

describe("which stories are read", () => {
  it("reads nothing at all when every story has a kept column recorded", async () => {
    await addStoryCommit(repo, SHA, { [`${SHEETS}/s1.csv`]: csv([{ question: "A", note: "on GitHub" }]) });
    const s = story("s1", [d1Step(1, 1, "A", JSON.stringify({ note: "recorded" }))]);
    expect(await planKeptColumnsCapture(ACCESS, SHA, [s])).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not read a CSV whose blob is the one the publish would commit", async () => {
    const steps = [d1Step(1, 1, "A"), d1Step(2, 2, "B")];
    await addStoryCommit(repo, SHA, { [`${SHEETS}/s1.csv`]: await rendered("s1", steps) });
    expect(await planKeptColumnsCapture(ACCESS, SHA, [story("s1", steps)])).toEqual([]);
    expect(repo.contentReads).toEqual([]);
  });

  it("skips a story with no CSV at the publish commit", async () => {
    await addStoryCommit(repo, SHA, { [`${SHEETS}/other.csv`]: csv([{ question: "A", note: "x" }]) });
    expect(await planKeptColumnsCapture(ACCESS, SHA, [story("s1", [d1Step(1, 1, "A")])])).toEqual([]);
    expect(repo.contentReads).toEqual([]);
  });

  it("captures nothing from a file with no column outside the fixed set", async () => {
    await addStoryCommit(repo, SHA, { [`${SHEETS}/s1.csv`]: csv([{ question: "A" }, { question: "B" }], false) });
    const result = await planKeptColumnsCapture(ACCESS, SHA, [story("s1", [d1Step(1, 1, "A"), d1Step(2, 2, "B")])]);
    expect(result).toEqual([]);
    expect(repo.contentReads).toEqual([`${SHA}:${SHEETS}/s1.csv`]);
  });

  it("captures the file's cells, with the raw hash of the rows it aligned against", async () => {
    await addStoryCommit(repo, SHA, {
      [`${SHEETS}/s1.csv`]: csv([{ question: "A", note: "first" }, { question: "B" }]),
    });
    const steps = [d1Step(11, 1, "A"), d1Step(12, 2, "B")];
    const [capture] = await planKeptColumnsCapture(ACCESS, SHA, [story("s1", steps)]);
    const raw = await rawCanonicalFromD1(steps, []);
    expect(capture).toEqual({
      storyId: "s1",
      expected: raw.readable ? raw.hash : "unreadable",
      steps: [{ stepId: 11, extra_columns: JSON.stringify({ note: "first" }) }],
      inserts: [],
    });
  });

  it("reads layers only for a story whose CSV it reads", async () => {
    const steps = [d1Step(1, 1, "A")];
    await addStoryCommit(repo, SHA, { [`${SHEETS}/s1.csv`]: csv([{ question: "A", note: "x" }]) });
    const recorded = story("s2", [d1Step(2, 1, "B", JSON.stringify({ note: "y" }))]);
    await planKeptColumnsCapture(ACCESS, SHA, [story("s1", steps), recorded]);
    expect(recorded.loadLayers).not.toHaveBeenCalled();
  });
});

describe("a story that cannot be read", () => {
  it("refuses when the story files cannot be listed completely", async () => {
    await addStoryCommit(repo, SHA, { [`${SHEETS}/s1.csv`]: csv([{ question: "A", note: "x" }]) });
    repo.listings[repo.commits[SHA].sheets!].truncated = true;
    const err = await planKeptColumnsCapture(ACCESS, SHA, [story("s1", [d1Step(1, 1, "A")])]).catch((e) => e);
    expect(err).toBeInstanceOf(StoriesUnreadableError);
    expect(err.storyId).toBeNull();
  });

  it("refuses when a CSV has to be read and the texts subtree cannot be listed completely", async () => {
    await addStoryCommit(repo, SHA, {
      [`${SHEETS}/s1.csv`]: csv([{ question: "A", note: "x" }]),
      [`${TEXTS}/s1-panel.md`]: "Body\n",
    });
    repo.listings[repo.commits[SHA].texts!].truncated = true;
    const err = await planKeptColumnsCapture(ACCESS, SHA, [story("s1", [d1Step(1, 1, "A")])]).catch((e) => e);
    expect(err).toBeInstanceOf(StoriesUnreadableError);
    expect(err.storyId).toBe("s1");
  });

  it("does not list the texts subtree when no CSV has to be read", async () => {
    const steps = [d1Step(1, 1, "A")];
    await addStoryCommit(repo, SHA, {
      [`${SHEETS}/s1.csv`]: await rendered("s1", steps),
      [`${TEXTS}/s1-panel.md`]: "Body\n",
    });
    repo.listings[repo.commits[SHA].texts!].truncated = true;
    expect(await planKeptColumnsCapture(ACCESS, SHA, [story("s1", steps)])).toEqual([]);
    const texts = repo.commits[SHA].texts!;
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([url]) => String(url).includes(texts))).toBe(false);
  });

  it("refuses, naming the story, when its CSV cannot be read strictly", async () => {
    await addStoryCommit(repo, SHA, { [`${SHEETS}/s1.csv`]: csv([{ question: "A", note: "x" }]) });
    repo.failing.add(`${SHA}:${SHEETS}/s1.csv`);
    const err = await planKeptColumnsCapture(ACCESS, SHA, [story("s1", [d1Step(1, 1, "A")])]).catch((e) => e);
    expect(err).toBeInstanceOf(StoriesUnreadableError);
    expect(err.storyId).toBe("s1");
    expect(err.message).toContain("s1");
  });
});

/** File rows as `rowsFromContent` gives them: in order, ids their parse index. */
function fileSteps(steps: Array<{ question: string; note?: string }>): StoryStepRow[] {
  return steps.map((s, i) => ({
    ...d1Step(i, i + 1, s.question, s.note ? JSON.stringify({ note: s.note }) : null),
  }));
}

describe("where the cells go", () => {
  it("carries each identical step's cells to it, in D1's order rather than its stored numbers", async () => {
    // Stored numbers that lag the order: D1's order_key order is A, B, as the
    // file's is, while step_number says B, A.
    const d1 = [
      { ...d1Step(22, 1, "B"), order_key: "a2" },
      { ...d1Step(21, 2, "A"), order_key: "a1" },
    ];
    const file = fileSteps([{ question: "A", note: "for A" }, { question: "B", note: "for B" }]);
    expect((await carryKeptCells({ stepRows: d1, layerRows: [] }, { stepRows: file, layerRows: [], importedCells: [] })).steps).toEqual([
      { stepId: 21, extra_columns: JSON.stringify({ note: "for A" }) },
      { stepId: 22, extra_columns: JSON.stringify({ note: "for B" }) },
    ]);
  });

  it("carries a paired step's cells to the step edited in the Compositor", async () => {
    const d1 = [d1Step(1, 1, "A"), d1Step(2, 2, "B, edited here"), d1Step(3, 3, "C")];
    const file = fileSteps([{ question: "A" }, { question: "B", note: "for B" }, { question: "C" }]);
    expect((await carryKeptCells({ stepRows: d1, layerRows: [] }, { stepRows: file, layerRows: [], importedCells: [] })).steps)
      .toEqual([{ stepId: 2, extra_columns: JSON.stringify({ note: "for B" }) }]);
  });

  it("gives nothing to a step deleted in the Compositor or one new there", async () => {
    // The file's B was deleted here; D1's N is new.
    const d1 = [d1Step(1, 1, "A"), d1Step(3, 2, "C"), d1Step(4, 3, "N")];
    const file = fileSteps([
      { question: "A", note: "for A" }, { question: "B", note: "for B" }, { question: "C", note: "for C" },
    ]);
    expect((await carryKeptCells({ stepRows: d1, layerRows: [] }, { stepRows: file, layerRows: [], importedCells: [] })).steps).toEqual([
      { stepId: 1, extra_columns: JSON.stringify({ note: "for A" }) },
      { stepId: 3, extra_columns: JSON.stringify({ note: "for C" }) },
    ]);
  });

  it("carries the cells of a step moved in the Compositor to it", async () => {
    // The file's order is A, B, C; the author moved B before A here. A common
    // subsequence keeps two of the three, and the one moved out of it is
    // found by its content.
    const d1 = [
      { ...d1Step(2, 1, "B"), order_key: "a1" },
      { ...d1Step(1, 2, "A"), order_key: "a2" },
      { ...d1Step(3, 3, "C"), order_key: "a3" },
    ];
    const file = fileSteps([
      { question: "A", note: "for A" }, { question: "B", note: "for B" }, { question: "C", note: "for C" },
    ]);
    const carried = (await carryKeptCells({ stepRows: d1, layerRows: [] }, { stepRows: file, layerRows: [], importedCells: [] })).steps;
    expect([...carried].sort((a, b) => a.stepId - b.stepId)).toEqual([
      { stepId: 1, extra_columns: JSON.stringify({ note: "for A" }) },
      { stepId: 2, extra_columns: JSON.stringify({ note: "for B" }) },
      { stepId: 3, extra_columns: JSON.stringify({ note: "for C" }) },
    ]);
  });

  it("never lets an edited step take the cells of a step that was only moved", async () => {
    // File Z, A, X; here X was moved to the front, Z deleted and Y added.
    // X is X by its content wherever it stands, so Y cannot take X's cells.
    const d1 = [
      { ...d1Step(3, 1, "X"), order_key: "a1" },
      { ...d1Step(4, 2, "Y"), order_key: "a2" },
      { ...d1Step(2, 3, "A"), order_key: "a3" },
    ];
    const file = fileSteps([
      { question: "Z", note: "for Z" }, { question: "A", note: "for A" }, { question: "X", note: "for X" },
    ]);
    const carried = (await carryKeptCells({ stepRows: d1, layerRows: [] }, { stepRows: file, layerRows: [], importedCells: [] })).steps;
    const byStep = new Map(carried.map((c) => [c.stepId, c.extra_columns]));
    expect(byStep.get(3)).toBe(JSON.stringify({ note: "for X" }));
    expect(byStep.get(2)).toBe(JSON.stringify({ note: "for A" }));
    expect(byStep.get(4)).not.toBe(JSON.stringify({ note: "for X" }));
  });

  it("pairs an edited step only within its own stretch between identical steps", async () => {
    // B was deleted between A and C; N is new after C. They stand in
    // different stretches, so N takes nothing of B's.
    const d1 = [d1Step(1, 1, "A"), d1Step(3, 2, "C"), d1Step(4, 3, "N")];
    const file = fileSteps([
      { question: "A", note: "for A" }, { question: "B", note: "for B" }, { question: "C", note: "for C" },
    ]);
    const carried = (await carryKeptCells({ stepRows: d1, layerRows: [] }, { stepRows: file, layerRows: [], importedCells: [] })).steps;
    expect(carried.find((c) => c.stepId === 4)).toBeUndefined();
  });

  it("pairs duplicate steps in order", async () => {
    const d1 = [d1Step(1, 1, "Same"), d1Step(2, 2, "Same")];
    const file = fileSteps([{ question: "Same", note: "first" }, { question: "Same", note: "second" }]);
    expect((await carryKeptCells({ stepRows: d1, layerRows: [] }, { stepRows: file, layerRows: [], importedCells: [] })).steps).toEqual([
      { stepId: 1, extra_columns: JSON.stringify({ note: "first" }) },
      { stepId: 2, extra_columns: JSON.stringify({ note: "second" }) },
    ]);
  });

  it("aligns on the layers too", async () => {
    // D1's one step has the panel; in the file it is the second step that
    // has it. Without the layers the first file step would be the match.
    const d1 = [d1Step(1, 1, "Same")];
    const d1Layers: CaptureLayerRow[] = [
      { step_id: 1, layer_number: 1, order_key: "a0", title: "Panel", button_label: "More", content: "Body" },
    ];
    const file = fileSteps([{ question: "Same", note: "plain" }, { question: "Same", note: "with panel" }]);
    const fileLayers = [{ step_id: 1, layer_number: 1, title: "Panel", button_label: "More", content: "Body" }];
    expect((await carryKeptCells({ stepRows: d1, layerRows: d1Layers }, { stepRows: file, layerRows: fileLayers, importedCells: [] })).steps)
      .toEqual([{ stepId: 1, extra_columns: JSON.stringify({ note: "with panel" }) }]);
  });
});

// ---------------------------------------------------------------------------
// Rows the Compositor never had
// ---------------------------------------------------------------------------

/**
 * The template's story layout (`your-story.csv` in the test instance): its
 * two header rows, with a `notes` column an author added at the end. Its
 * bilingual row leaves the added column's cell empty, as a publish writes it.
 */
const TEMPLATE_HEADER =
  "step,object,x,y,zoom,page,question,answer,layer1_button,layer1_content,layer2_button,layer2_content,clip_start,clip_end,loop,notes\n" +
  "paso,objeto,x,y,zoom,pagina,pregunta,respuesta,boton1,contenido1,boton2,contenido2,inicio_clip,fin_clip,bucle,\n";

/** Template rows, verbatim but for the added `notes` cell. */
function templateRow(step: string, which: "image" | "necklace" | "americas", notes = ""): string {
  const rows = {
    image: `atlas-allegory,0.5,0.5,1,,What is this image?,"This 1761 engraving appears to celebrate the Spanish empire - but as we'll see, it actually challenges it. Scholar Natalie Cobo guides readers through telling details."`,
    necklace: "atlas-allegory,0.486,0.277,10,,Consider the necklace,The chain is made of ships - it was overseas invasions that expanded the early modern Spanish world.",
    americas: "atlas-allegory,0.504,0.415,2.9,,Look at the Americas a,The American landmass forms an ill-defined cloak covering the allegorical woman.",
  };
  return `${step},${rows[which]},,,,,,,,${notes}\n`;
}

/** A row an author added with nothing in it but cells of the given columns. */
const TEMPLATE_COLUMNS = ["object", "x", "y", "zoom", "page", "question", "answer", "layer1_button", "layer1_content",
  "layer2_button", "layer2_content", "clip_start", "clip_end", "loop", "notes"] as const;

function authorRow(step: string, cells: Partial<Record<(typeof TEMPLATE_COLUMNS)[number], string>> = {}): string {
  return `${step},${TEMPLATE_COLUMNS.map((c) => cells[c] ?? "").join(",")}\n`;
}

/** The file as the capture reads it: rows in the framework's order, their ids the parse index. */
async function fileRows(csvText: string, layerFiles: Record<string, string> = {}): Promise<StoryFileRows> {
  return storyRowsFromFiles("s1", csvText, layerFiles, layerFiles);
}

/**
 * The file's rows at `keep` as an import stored them in D1, with these ids,
 * in order: `extra_columns` as `recorded` says (null for an import from before
 * extra columns were recorded).
 */
function storedRows(
  file: { stepRows: StoryStepRow[] },
  keep: number[],
  ids: number[],
  recorded: "none" | "as-imported" = "none",
): CaptureStepRow[] {
  return keep.map((index, rank) => ({
    ...file.stepRows[index],
    id: ids[rank],
    step_number: rank + 1,
    order_key: `a${rank}`,
    extra_columns: recorded === "none" ? null : file.stepRows[index].extra_columns,
  }));
}

const NOTES = (text: string) => JSON.stringify({ notes: text });

describe("the import records what it read", () => {
  it("records \"{}\" on a step whose row has no kept cell", () => {
    const { steps } = mapStoryCsv([{ step: "1", object: "atlas-allegory", question: "Q", answer: "A" }], 1);
    expect(steps[0].extra_columns).toBe("{}");
  });

  it("makes a story imported now recorded, so a step its author deleted is not read back from the file", async () => {
    const csvText = TEMPLATE_HEADER + templateRow("1", "image") + authorRow("2", { notes: "Check the plate" }) + templateRow("3", "necklace");
    await addStoryCommit(repo, SHA, { [`${SHEETS}/s1.csv`]: csvText });
    const file = await fileRows(csvText);
    // Imported now, then the author deleted the custom-only step in the Compositor.
    const stepRows = storedRows(file, [0, 2], [11, 12], "as-imported");
    expect(isUnrecorded(stepRows)).toBe(false);
    expect(await planKeptColumnsCapture(ACCESS, SHA, [story("s1", stepRows)])).toEqual([]);
    expect(repo.contentReads).toEqual([]);
  });

  it("gives a story imported with the marker the canonical forms it has without it", async () => {
    const csvText = TEMPLATE_HEADER + templateRow("1", "image") + templateRow("2", "necklace");
    const file = await fileRows(csvText);
    const marked = storedRows(file, [0, 1], [11, 12], "as-imported");
    expect(marked.map((s) => s.extra_columns)).toEqual(["{}", "{}"]);
    const unmarked = marked.map((s) => ({ ...s, extra_columns: null }));
    const hash = async (rows: CaptureStepRow[]) => {
      const raw = await canonicalRaw(contentFromRows(rows, []));
      return raw.readable ? raw.hash : raw.reason;
    };
    expect(await hash(marked)).toBe(await hash(unmarked));
    expect(await canonicalForCompareFromD1("s1", marked, [])).toEqual(await canonicalForCompareFromD1("s1", unmarked, []));
  });
});

describe("a row whose only content is in a custom column", () => {
  it("is inserted after the step before it, and sent with no fills", async () => {
    const csvText = TEMPLATE_HEADER + templateRow("1", "image") + authorRow("2", { notes: "Check the plate" }) + templateRow("3", "necklace");
    await addStoryCommit(repo, SHA, { [`${SHEETS}/s1.csv`]: csvText });
    const stepRows = storedRows(await fileRows(csvText), [0, 2], [11, 12]);
    const [capture] = await planKeptColumnsCapture(ACCESS, SHA, [story("s1", stepRows)]);
    const raw = await rawCanonicalFromD1(stepRows, []);
    expect(capture).toEqual({
      storyId: "s1",
      expected: raw.readable ? raw.hash : "unreadable",
      steps: [],
      inserts: [{ afterStepId: 11, step: { extra_columns: NOTES("Check the plate") } }],
    });
  });

  it("is inserted first when it is first in the file, and two in a row keep their order", async () => {
    const csvText = TEMPLATE_HEADER + authorRow("1", { notes: "first" }) + authorRow("2", { notes: "second" }) +
      templateRow("3", "image") + authorRow("4", { notes: "third" }) + authorRow("5", { notes: "fourth" }) + templateRow("6", "necklace");
    const file = await fileRows(csvText);
    const { steps, inserts } = await carryKeptCells({ stepRows: storedRows(file, [2, 5], [11, 12]), layerRows: [] }, file);
    expect(steps).toEqual([]);
    expect(inserts).toEqual([
      { afterStepId: null, step: { extra_columns: NOTES("first") } },
      { afterStepId: null, step: { extra_columns: NOTES("second") } },
      { afterStepId: 11, step: { extra_columns: NOTES("third") } },
      { afterStepId: 11, step: { extra_columns: NOTES("fourth") } },
    ]);
  });

  it("is captured for a story with no steps in D1, every row of which is such a row", async () => {
    const csvText = TEMPLATE_HEADER + authorRow("1", { notes: "first" }) + authorRow("2", { notes: "second" });
    await addStoryCommit(repo, SHA, { [`${SHEETS}/s1.csv`]: csvText });
    const [capture] = await planKeptColumnsCapture(ACCESS, SHA, [story("s1", [])]);
    const raw = await rawCanonicalFromD1([], []);
    expect(capture).toEqual({
      storyId: "s1",
      expected: raw.readable ? raw.hash : "unreadable",
      steps: [],
      inserts: [
        { afterStepId: null, step: { extra_columns: NOTES("first") } },
        { afterStepId: null, step: { extra_columns: NOTES("second") } },
      ],
    });
  });

  it("carries the row's page, clip and coordinate cells with its kept cells", async () => {
    const csvText = TEMPLATE_HEADER + templateRow("1", "image") +
      authorRow("2", { notes: "a clip", page: "2", clip_start: "15", x: "0.25" }) + templateRow("3", "necklace");
    const file = await fileRows(csvText);
    const { inserts } = await carryKeptCells({ stepRows: storedRows(file, [0, 2], [11, 12]), layerRows: [] }, file);
    expect(inserts).toEqual([
      { afterStepId: 11, step: { page: "2", clip_start: "15", x: 0.25, extra_columns: NOTES("a clip") } },
    ]);
  });

  it("does not take the place of a step edited in the Compositor between two identical steps", async () => {
    const csvText = TEMPLATE_HEADER + templateRow("1", "image") + authorRow("2", { notes: "the author's row" }) +
      templateRow("3", "necklace", "for the necklace") + templateRow("4", "americas");
    const file = await fileRows(csvText);
    const d1 = storedRows(file, [0, 2, 3], [11, 12, 13]);
    d1[1] = { ...d1[1], question: "Consider the necklace, edited here" };
    const { steps, inserts } = await carryKeptCells({ stepRows: d1, layerRows: [] }, file);
    expect(steps).toEqual([{ stepId: 12, extra_columns: NOTES("for the necklace") }]);
    expect(inserts).toEqual([{ afterStepId: 11, step: { extra_columns: NOTES("the author's row") } }]);
  });

  it("is not a row with an object or a layer button, which the old import kept: missing from D1, it was deleted", async () => {
    const csvText = TEMPLATE_HEADER + templateRow("1", "image") + authorRow("2", { notes: "n", object: "atlas-allegory" }) +
      authorRow("3", { notes: "n", layer1_button: "Learn more" }) + templateRow("4", "necklace");
    const file = await fileRows(csvText);
    const { inserts } = await carryKeptCells({ stepRows: storedRows(file, [0, 3], [11, 12]), layerRows: [] }, file);
    expect(inserts).toEqual([]);
  });

  it("is not a row whose kept cells are all in columns the framework drops", async () => {
    const file = {
      stepRows: [
        { ...d1Step(0, 1, "A"), extra_columns: "{}" },
        { ...d1Step(1, 2, ""), object_id: null, answer: null, x: null, y: null, zoom: null, extra_columns: JSON.stringify({ "#nota": "para mí" }) },
      ],
      layerRows: [],
      importedCells: [{ object: "obj", question: "A" }, { "#nota": "para mí" }] as Record<string, string>[],
    };
    const { inserts } = await carryKeptCells({ stepRows: [d1Step(11, 1, "A")], layerRows: [] }, file);
    expect(inserts).toEqual([]);
  });
});

describe("which rows an import from before extra columns were recorded skipped, judged on the cells it tested", () => {
  /** D1's layer rows for the kept file rows, as that import stored them. */
  function storedLayers(file: StoryFileRows, keep: number[], ids: number[]): CaptureLayerRow[] {
    return keep.flatMap((index, rank) =>
      file.layerRows
        .filter((l) => l.step_id === file.stepRows[index].id)
        .map((l) => ({ ...l, step_id: ids[rank], order_key: `a${l.layer_number}` })));
  }

  it("is not a row whose layer file holds only an empty front matter block: the import kept it", async () => {
    const csvText = TEMPLATE_HEADER + templateRow("1", "image") +
      authorRow("2", { layer1_content: "empty-title.md", notes: "kept by the import" }) + templateRow("3", "necklace");
    // Mapped, the layer's title and body are both empty; the cell the import
    // tested held the file's text.
    const file = await fileRows(csvText, { "empty-title.md": '---\ntitle: ""\n---\n' });
    expect(file.layerRows.filter((l) => l.step_id === 1).every((l) => !l.title && !l.button_label && !l.content)).toBe(true);
    const ids = [11, 12, 13];
    const d1 = { stepRows: storedRows(file, [0, 1, 2], ids), layerRows: storedLayers(file, [0, 1, 2], ids) };
    const { steps, inserts } = await carryKeptCells(d1, file);
    expect(inserts).toEqual([]);
    expect(steps).toEqual([{ stepId: 12, extra_columns: NOTES("kept by the import") }]);
  });

  it("is a row whose layer cell names a file the import read as empty", async () => {
    const csvText = TEMPLATE_HEADER + templateRow("1", "image") + authorRow("2", { layer1_content: "blank.md", notes: "n" }) +
      templateRow("3", "necklace");
    const file = await fileRows(csvText, { "blank.md": "" });
    const { inserts } = await carryKeptCells({ stepRows: storedRows(file, [0, 2], [11, 12]), layerRows: [] }, file);
    expect(inserts).toEqual([{ afterStepId: 11, step: { extra_columns: NOTES("n") } }]);
  });

  it("is a row whose layer file holds only whitespace, which the import stripped", async () => {
    // The parse strips every cell; a layer file's text reaches the test unstripped.
    const csvText = TEMPLATE_HEADER + templateRow("1", "image") + authorRow("2", { layer1_content: "blank.md", notes: "n" }) +
      templateRow("3", "necklace");
    const file = await fileRows(csvText, { "blank.md": "\n  \n" });
    const { inserts } = await carryKeptCells({ stepRows: storedRows(file, [0, 2], [11, 12]), layerRows: [] }, file);
    expect(inserts).toEqual([{ afterStepId: 11, step: { extra_columns: NOTES("n") } }]);
  });

  it("is not a row whose layer file the import could not read by its exact name: it kept the name", async () => {
    const csvText = TEMPLATE_HEADER + templateRow("1", "image") + authorRow("2", { layer1_content: "Blank.md", notes: "n" }) +
      templateRow("3", "necklace");
    // The framework finds blank.md for Blank.md; the import fetched the exact name only.
    const file = await storyRowsFromFiles("s1", csvText, { "Blank.md": "" }, {});
    const { inserts } = await carryKeptCells({ stepRows: storedRows(file, [0, 2], [11, 12]), layerRows: [] }, file);
    expect(inserts).toEqual([]);
  });
});
