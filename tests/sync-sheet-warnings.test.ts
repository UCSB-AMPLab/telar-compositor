/**
 * A sync reports what it finds wrong in the repository's current sheets: a cut-off row, a dropped duplicate column, a reserved column, a
 * truncated tree, and whatever the story-file check reads at HEAD. Nothing
 * read at the base is reported, since the base is the state the Compositor
 * last reconciled with rather than what the author now has on GitHub.
 *
 * Every path is driven through the real parse, with only GitHub and D1 faked.
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
}));

// The story-file check reads subtrees this stand-in does not serve; its own
// reads are covered in sync-story-content.test.ts. Here it stands in for a
// check that read the step files of the stories D1 holds, and found
// `checkWarnings` in them.
const checkWarnings: unknown[] = [];
vi.mock("~/lib/story-content.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/story-content.server")>();
  return {
    ...actual,
    checkStoryContent: vi.fn(async (input: { warnings?: unknown[] }) => {
      input.warnings?.push(...checkWarnings);
      return { conclusive: true, changes: [], suppressedEditorOnly: 0 };
    }),
  };
});

const CHECKED_STORY_WARNING = { code: "ragged_row", row: { label: "1" }, sheet: "checked.csv" };

// The published sheet's tabs, listed only when Google Sheets is on and a
// warning names a sheet.
vi.mock("~/lib/sheets.server", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  discoverSheetTabs: vi.fn(async () => [{ name: "objects" }]),
}));

import * as githubServer from "~/lib/github.server";
import { strictReadsFromFileContent } from "./helpers/strict-sheet-read";
import { computeSyncDiff, computeFullSyncDiff } from "~/lib/sync.server";

const SHEETS = "telar-content/spreadsheets";

/** What the dashboard's check passes; the status refresh passes nothing. */
const COLLECT = { collectWarnings: true };

// A cut-off row (three values under two columns past the id), a dropped
// duplicate column (`object_type` empty beside `medium`), and a column Telar
// reserves.
const OBJECTS_MALFORMED =
  "object_id,title,medium,object_type,_metadata\n" +
  "obj-001,First,Oil,,x\n" +
  "obj-002,Second,Ink,,y,surplus\n";
const OBJECTS_CLEAN = "object_id,title\nobj-001,First\n";
const PROJECT_MALFORMED = "order,story_id,title\n1,story-one,First,surplus\n";
const GLOSSARY_MALFORMED = "term_id,title,definition,_metadata\nloom,Loom,A frame.,x,surplus\n";

function serveRepo(files: Record<string, string>) {
  vi.mocked(githubServer.getFileContent).mockImplementation(
    async (_t: string, _o: string, _r: string, path: string) => files[path] ?? null,
  );
}

function serveBase(files: Record<string, string>) {
  vi.mocked(githubServer.getFileAtRef).mockImplementation(
    strictReadsFromFileContent(githubServer.getFileContent, async (_t: string, _o: string, _r: string, path: string) =>
      path in files ? { status: "ok", content: files[path] } : { status: "absent" },
      (ref) => ref === "base-sha",
    ),
  );
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
  vi.mocked(githubServer.getRepoHead).mockResolvedValue("new-head");
  serveBase({});
  checkWarnings.length = 0;
  checkWarnings.push(CHECKED_STORY_WARNING);
});

const OBJECTS_WARNINGS = [
  {
    code: "column_collision_only_filled",
    name: "medium_genre",
    headers: ["medium", "object_type"],
    kept: "medium",
    column: 3,
    sheet: "objects.csv",
  },
  { code: "ragged_row", row: { label: "obj-002" }, sheet: "objects.csv" },
  { code: "reserved_column", columns: ["_metadata"], sheet: "objects.csv" },
];

describe("the objects page's sync", () => {
  it("returns the objects sheet's warnings on the diff", async () => {
    serveRepo({ [`${SHEETS}/objects.csv`]: OBJECTS_MALFORMED });
    const diff = await computeSyncDiff(1, "t", "o", "r", emptyDb());
    expect(diff.warnings).toEqual(OBJECTS_WARNINGS);
  });

  it("returns a truncated tree as a warning", async () => {
    serveRepo({ [`${SHEETS}/objects.csv`]: OBJECTS_CLEAN });
    vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: true });
    const diff = await computeSyncDiff(1, "t", "o", "r", emptyDb());
    expect(diff.warnings).toEqual([{ code: "tree_truncated" }]);
  });

  it("returns no warnings for a clean sheet", async () => {
    serveRepo({ [`${SHEETS}/objects.csv`]: OBJECTS_CLEAN });
    const diff = await computeSyncDiff(1, "t", "o", "r", emptyDb());
    expect(diff.warnings).toEqual([]);
  });
});

describe("the full sync's diff", () => {
  it("returns the warnings of every sheet it reads at HEAD, the story files included", async () => {
    serveRepo({
      [`${SHEETS}/objects.csv`]: OBJECTS_MALFORMED,
      [`${SHEETS}/project.csv`]: PROJECT_MALFORMED,
      [`${SHEETS}/glossary.csv`]: GLOSSARY_MALFORMED,
    });
    const diff = await computeFullSyncDiff(1, "t", "o", "r", emptyDb(), null, COLLECT);
    expect(diff.warnings).toEqual([
      ...OBJECTS_WARNINGS,
      { code: "ragged_row", row: { label: "1" }, sheet: "project.csv" },
      CHECKED_STORY_WARNING,
      { code: "ragged_row", row: { label: "loom" }, sheet: "glossary.csv" },
      { code: "reserved_column", columns: ["_metadata"], sheet: "glossary.csv" },
    ]);
  });

  it("returns none of the base's warnings", async () => {
    serveRepo({ [`${SHEETS}/objects.csv`]: OBJECTS_CLEAN });
    serveBase({
      [`${SHEETS}/objects.csv`]: OBJECTS_MALFORMED,
      [`${SHEETS}/project.csv`]: PROJECT_MALFORMED,
      [`${SHEETS}/glossary.csv`]: GLOSSARY_MALFORMED,
    });
    const diff = await computeFullSyncDiff(1, "t", "o", "r", emptyDb(), "base-sha", COLLECT);
    expect(diff.classification).toBe("three-way");
    expect(diff.warnings).toEqual([CHECKED_STORY_WARNING]);
  });

  // A story new on GitHub is not one the story check compares, since D1 does
  // not hold it; its step file is read at HEAD for its warnings, so the author
  // sees them before choosing to bring it in.
  it("returns a new story's step-file warnings", async () => {
    checkWarnings.length = 0;
    serveRepo({
      [`${SHEETS}/objects.csv`]: OBJECTS_CLEAN,
      [`${SHEETS}/project.csv`]: "order,story_id,title\n1,story-one,First\n",
      [`${SHEETS}/story-one.csv`]: "step,object,x,question\n1,obj-001,abc,Q\n2,obj-001,0.5,Q,surplus\n",
    });
    const diff = await computeFullSyncDiff(1, "t", "o", "r", emptyDb(), null, COLLECT);
    expect(diff.stories.newStories.map((s) => s.story_id)).toEqual(["story-one"]);
    expect(diff.warnings).toEqual([
      { code: "ragged_row", row: { label: "2" }, sheet: "story-one.csv" },
      { code: "coordinate_invalid", step: 1, column: "x", value: "abc", sheet: "story-one.csv" },
    ]);
  });

  // `question` beside `pregunta` has values in one only, and warns; `answer`
  // beside `respuesta` has values in both, and refuses the sheet after it. The
  // refusal is the apply's to raise, but what the read said first is kept.
  it("keeps what a new story's read raised before its sheet was refused, and still answers", async () => {
    checkWarnings.length = 0;
    serveRepo({
      [`${SHEETS}/objects.csv`]: OBJECTS_CLEAN,
      [`${SHEETS}/project.csv`]: "order,story_id,title\n1,story-one,First\n",
      [`${SHEETS}/story-one.csv`]: "step,object,question,pregunta,answer,respuesta\n1,obj-001,What?,,Yes,Sí\n",
    });
    const diff = await computeFullSyncDiff(1, "t", "o", "r", emptyDb(), null, COLLECT);
    expect(diff.stories.newStories.map((s) => s.story_id)).toEqual(["story-one"]);
    expect(diff.warnings).toEqual([
      {
        code: "column_collision_only_filled",
        name: "question",
        headers: ["question", "pregunta"],
        kept: "question",
        column: 3,
        sheet: "story-one.csv",
      },
    ]);
  });

  /** The paths `getFileAtRef` was asked for, in order. */
  const readPaths = () => vi.mocked(githubServer.getFileAtRef).mock.calls.map((c) => String(c[3]));

  it("reads a new story's step file and the layer files it names, after the glossary", async () => {
    checkWarnings.length = 0;
    serveRepo({
      [`${SHEETS}/objects.csv`]: OBJECTS_CLEAN,
      [`${SHEETS}/project.csv`]: "order,story_id,title\n1,story-one,First\n",
      [`${SHEETS}/story-one.csv`]: "step,object,question,layer1_content\n1,obj-001,Q,panel.md,surplus\n",
      "telar-content/texts/stories/panel.md": "A panel.",
    });
    const diff = await computeFullSyncDiff(1, "t", "o", "r", emptyDb(), null, COLLECT);
    expect(diff.warnings).toEqual([{ code: "ragged_row", row: { label: "1" }, sheet: "story-one.csv" }]);
    const paths = readPaths();
    const glossary = paths.indexOf(`${SHEETS}/glossary.csv`);
    const story = paths.indexOf(`${SHEETS}/story-one.csv`);
    expect(glossary).toBeGreaterThanOrEqual(0);
    expect(story).toBeGreaterThan(glossary);
    // Every other read of the check came first; the layer file after its step file.
    expect(paths.slice(story)).toEqual([`${SHEETS}/story-one.csv`, "telar-content/texts/stories/panel.md"]);
  });

  it("reads at most four new stories' step files at a time, and reports them in project order", async () => {
    checkWarnings.length = 0;
    const ids = ["s1", "s2", "s3", "s4", "s5", "s6", "s7"];
    const files: Record<string, string> = {
      [`${SHEETS}/objects.csv`]: OBJECTS_CLEAN,
      [`${SHEETS}/project.csv`]: "order,story_id,title\n" + ids.map((id, i) => `${i + 1},${id},T${i}`).join("\n") + "\n",
    };
    for (const id of ids) files[`${SHEETS}/${id}.csv`] = "step,object,question\n1,obj-001,Q,surplus\n";
    serveRepo(files);
    const serve = vi.mocked(githubServer.getFileAtRef).getMockImplementation()!;
    let inFlight = 0;
    let most = 0;
    vi.mocked(githubServer.getFileAtRef).mockImplementation(async (...args: Parameters<typeof githubServer.getFileAtRef>) => {
      if (!/\/s\d\.csv$/.test(String(args[3]))) return serve(...args);
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return serve(...args);
    });
    const diff = await computeFullSyncDiff(1, "t", "o", "r", emptyDb(), null, COLLECT);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(4);
    expect((diff.warnings ?? []).map((w) => ("sheet" in w ? w.sheet : ""))).toEqual(ids.map((id) => `${id}.csv`));
  });

  // The status refresh computes this diff every 45 seconds while the heads
  // differ; it shows no warnings, so it reads nothing for them.
  it("collects nothing and reads no new story's step file without the option", async () => {
    serveRepo({
      [`${SHEETS}/objects.csv`]: OBJECTS_MALFORMED,
      [`${SHEETS}/project.csv`]: "order,story_id,title\n1,story-one,First\n",
      [`${SHEETS}/story-one.csv`]: "step,object,question\n1,obj-001,Q,surplus\n",
      [`${SHEETS}/glossary.csv`]: GLOSSARY_MALFORMED,
    });
    const diff = await computeFullSyncDiff(1, "t", "o", "r", emptyDb(), null);
    expect(diff.stories.newStories.map((s) => s.story_id)).toEqual(["story-one"]);
    expect(diff.warnings).toBeUndefined();
    expect(diff.objects.warnings).toBeUndefined();
    expect(readPaths()).not.toContain(`${SHEETS}/story-one.csv`);
    const { checkStoryContent } = await import("~/lib/story-content.server");
    expect(vi.mocked(checkStoryContent).mock.calls[0][0].warnings).toBeUndefined();
  });
});

describe("headings the site misreads", () => {
  it("are named in the objects sheet on the objects page's sync", async () => {
    serveRepo({ [`${SHEETS}/objects.csv`]: "Object_ID,title\nobj-001,First\n" });
    const diff = await computeSyncDiff(1, "t", "o", "r", emptyDb());
    expect(diff.warnings).toEqual([
      { code: "header_spelling", headers: ["Object_ID"], names: ["object_id"], sheet: "objects.csv" },
    ]);
  });

  it("are named in project.csv and a new story's step file on the full sync", async () => {
    checkWarnings.length = 0;
    serveRepo({
      [`${SHEETS}/objects.csv`]: OBJECTS_CLEAN,
      [`${SHEETS}/project.csv`]: "Order,story_id,title\n1,story-one,First\n",
      [`${SHEETS}/story-one.csv`]: "Step,object,question\n1,obj-001,Q\n",
    });
    const diff = await computeFullSyncDiff(1, "t", "o", "r", emptyDb(), null, COLLECT);
    expect(diff.warnings).toEqual([
      { code: "header_spelling", headers: ["Order"], names: ["order"], sheet: "project.csv" },
      { code: "header_spelling", headers: ["Step"], names: ["step"], sheet: "story-one.csv" },
    ]);
  });

  it("are not named for a sheet the build takes from a Google Sheets tab", async () => {
    checkWarnings.length = 0;
    serveRepo({
      "_config.yml": 'google_sheets:\n  enabled: true\n  published_url: "https://docs.google.com/spreadsheets/d/e/X/pubhtml"\n',
      [`${SHEETS}/objects.csv`]: "Object_ID,title\nobj-001,First\n",
      [`${SHEETS}/project.csv`]: "order,story_id,title\n1,story-one,First\n",
      [`${SHEETS}/story-one.csv`]: "Step,object,question\n1,obj-001,Q\n",
    });
    const diff = await computeFullSyncDiff(1, "t", "o", "r", emptyDb(), null, COLLECT);
    expect(diff.warnings).toEqual([
      { code: "header_spelling", headers: ["Step"], names: ["step"], sheet: "story-one.csv" },
    ]);
  });
});

describe("computeFullSyncDiff with the head to read at", () => {
  const PINNED = "a".repeat(40);

  it("reads every file at the given head, never resolves one, and reports it", async () => {
    serveRepo({ [`${SHEETS}/objects.csv`]: OBJECTS_CLEAN });
    const diff = await computeFullSyncDiff(1, "t", "o", "r", emptyDb(), null, { headRef: PINNED });
    expect(githubServer.getRepoHead).not.toHaveBeenCalled();
    expect(diff.headSha).toBe(PINNED);
    const refs = vi.mocked(githubServer.getFileAtRef).mock.calls.map((c) => c[4]);
    expect(refs.length).toBeGreaterThan(0);
    expect(new Set(refs)).toEqual(new Set([PINNED]));
  });

  it("resolves the head once without it", async () => {
    serveRepo({ [`${SHEETS}/objects.csv`]: OBJECTS_CLEAN });
    const diff = await computeFullSyncDiff(1, "t", "o", "r", emptyDb(), null);
    expect(githubServer.getRepoHead).toHaveBeenCalledOnce();
    expect(diff.headSha).toBe("new-head");
  });
});
