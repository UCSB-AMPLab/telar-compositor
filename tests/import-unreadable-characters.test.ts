/**
 * The first import names each file whose bytes are not valid UTF-8.
 *
 * The framework reads every file the Compositor writes with strict UTF-8, so
 * such a file is already broken on the site. The import reads it as the text
 * a non-fatal decode gives, as before, and names it once in the warnings the
 * review step shows, `_config.yml` and `index.md` included although they are
 * read before that list is made.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getRepoHead: vi.fn(),
    getDefaultBranchHead: vi.fn(),
    getRepoTree: vi.fn(),
    getFileContent: vi.fn(),
    getFileAtRef: vi.fn(),
    getSubtreeOids: vi.fn(),
    listSubtreeEntries: vi.fn(),
  };
});

vi.mock("~/lib/sheets.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, discoverSheetTabs: vi.fn(), fetchSheetCsv: vi.fn() };
});

import { importRepo, scanRepoPages } from "~/lib/import.server";
import {
  getFileAtRef,
  getFileContent,
  getRepoHead,
  getDefaultBranchHead,
  getRepoTree,
  getSubtreeOids,
  listSubtreeEntries,
} from "~/lib/github.server";
import type { SheetWarning } from "~/lib/sheet-warnings";

const HEAD = "head-sha";
const SHEETS = "telar-content/spreadsheets";
const CONFIG = 'title: "Site"\ntelar:\n  version: "1.0.0"\n';
const SHEETS_CONFIG =
  'title: "Site"\ntelar:\n  version: "1.0.0"\ngoogle_sheets:\n  enabled: true\n' +
  '  published_url: "https://docs.google.com/spreadsheets/d/e/2PACX-TEST/pubhtml"\n';
const STORY_CSV = "step,object,x,y,zoom,question,answer,layer1_button,layer1_content\n1,bell,0.5,0.5,1,Q,A,More,panel.md\n";

/** A site that exercises every read the import makes. */
function siteFiles(): Record<string, string> {
  return {
    "_config.yml": CONFIG,
    "index.md": "---\ntitle: Home\n---\nWelcome.\n",
    "_data/themes/trama.yml": "name: Trama\n",
    [`${SHEETS}/objects.csv`]: "object_id,title\nbell,Bell\n",
    [`${SHEETS}/project.csv`]: "order,story_id,title\n1,story-one,First\n",
    [`${SHEETS}/story-one.csv`]: STORY_CSV,
    [`${SHEETS}/old-story.csv`]: "step,object\n1,bell\n",
    "telar-content/texts/stories/panel.md": "---\ntitle: Panel\n---\nPanel text.\n",
    [`${SHEETS}/glossary.csv`]: "term_id,title,definition\nloom,Loom,A frame.\n",
    "telar-content/texts/pages/about.md": "---\ntitle: About\n---\nAbout body.\n",
    ".compositor-ignored": "old-story\n",
  };
}

let memory: MemoryD1;
let files: Record<string, string>;
let failing: Set<string>;
let lossy: Set<string>;

function importNow() {
  return importRepo({
    token: "t",
    installationId: 1,
    repoFullName: "owner/repo",
    userId: 1,
    env: { DB: asD1(memory), ENCRYPTION_KEY: "a".repeat(64) } as unknown as Env,
  });
}


beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  memory = createMemoryD1();
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      "VALUES (1, 1, 'u', 'e', 'e', '2099-01-01', '2099-01-01')",
  );
  files = siteFiles();
  failing = new Set();
  lossy = new Set();

  vi.mocked(getRepoHead).mockResolvedValue(HEAD);
  vi.mocked(getDefaultBranchHead).mockResolvedValue({ name: "main", oid: HEAD });
  vi.mocked(getRepoTree).mockImplementation(async () => ({
    tree: Object.keys(files).map((path) => ({ path, mode: "100644", type: "blob", sha: `sha-${path}` })),
    truncated: false,
  }));
  vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path) => {
    if (failing.has(path)) return { status: "error" };
    if (!(path in files)) return { status: "absent" };
    return lossy.has(path) ? { status: "ok", content: files[path], lossy: true } : { status: "ok", content: files[path] };
  });
  // A loose read answers null for any failure, the same as for a missing file.
  vi.mocked(getFileContent).mockImplementation(async (_t, _o, _r, path) =>
    failing.has(path) || !(path in files) ? null : files[path],
  );
  vi.mocked(getSubtreeOids).mockResolvedValue({ ok: true, at: () => ({ kind: "tree", oid: "sheets-oid" }) });
  vi.mocked(listSubtreeEntries).mockImplementation(async () => {
    const names = Object.keys(files)
      .filter((path) => path.startsWith(`${SHEETS}/`))
      .map((path) => path.slice(SHEETS.length + 1));
    return { files: new Map(names.map((name) => [name, `sha-${name}`])), dirs: new Set<string>() };
  });
});

afterEach(() => {
  memory.close();
});

/** The unreadable-characters warnings the import answered. */
function unreadable(warnings: SheetWarning[]): SheetWarning[] {
  return warnings.filter((w) => w.code === "unreadable_characters");
}

const REPLACED = "\uFFFD";

describe("importRepo names each file read lossily", () => {
  it("objects.csv, and imports the object with U+FFFD as before", async () => {
    files[`${SHEETS}/objects.csv`] = `object_id,title\nbell,Bell${REPLACED}\n`;
    lossy.add(`${SHEETS}/objects.csv`);

    const result = await importNow();

    expect(unreadable(result.objects.warnings)).toEqual([
      { code: "unreadable_characters", file: "objects.csv", effect: "build_stops", repair: "publish" },
    ]);
    const row = memory.raw.prepare("SELECT title FROM objects WHERE object_id = 'bell'").get() as { title: string };
    expect(row.title).toBe(`Bell${REPLACED}`);
  });

  it.each([
    ["telar-content/texts/pages/about.md", "telar-content/texts/pages/about.md", "build_stops"],
    ["telar-content/texts/stories/panel.md", "telar-content/texts/stories/panel.md", "name_shown"],
    [`${SHEETS}/story-one.csv`, "story-one.csv", "left_out"],
    [`${SHEETS}/project.csv`, "project.csv", "build_stops"],
    [`${SHEETS}/glossary.csv`, "glossary.csv", "build_stops"],
    ["_config.yml", "_config.yml", "build_stops"],
    ["index.md", "index.md", "build_stops"],
  ])("%s", async (path, file, effect) => {
    lossy.add(path);

    const result = await importNow();

    expect(result.valid).toBe(true);
    expect(unreadable(result.objects.warnings)).toEqual([
      { code: "unreadable_characters", file, effect, repair: "publish" },
    ]);
  });

  it.each([
    ["_data/story-one.csv", "build_stops"],
    ["story-one.csv", "not_used"],
  ])("a story CSV found at the older path %s, which the next publish removes", async (path, effect) => {
    delete files[`${SHEETS}/story-one.csv`];
    files[path] = STORY_CSV;
    lossy.add(path);

    const result = await importNow();

    expect(unreadable(result.objects.warnings)).toEqual([
      { code: "unreadable_characters", file: path, effect, repair: "remove_old_copy" },
    ]);
  });

  it("a layer file named by two cells, once", async () => {
    files[`${SHEETS}/story-one.csv`] =
      "step,object,x,y,zoom,question,answer,layer1_button,layer1_content\n" +
      "1,bell,0.5,0.5,1,Q,A,More,panel.md\n2,bell,0.5,0.5,1,Q2,A2,More,panel.md\n";
    lossy.add("telar-content/texts/stories/panel.md");

    const result = await importNow();

    expect(unreadable(result.objects.warnings)).toHaveLength(1);
  });

  it("reads a layer file once however many cells and stories name it", async () => {
    files[`${SHEETS}/project.csv`] = "order,story_id,title\n1,story-one,First\n2,story-two,Second\n";
    files[`${SHEETS}/story-one.csv`] =
      "step,object,x,y,zoom,question,answer,layer1_button,layer1_content\n" +
      "1,bell,0.5,0.5,1,Q,A,More,panel.md\n2,bell,0.5,0.5,1,Q2,A2,More,panel.md\n";
    files[`${SHEETS}/story-two.csv`] = STORY_CSV;

    const result = await importNow();

    expect(result.valid).toBe(true);
    const reads = vi.mocked(getFileAtRef).mock.calls.filter((c) => c[3] === "telar-content/texts/stories/panel.md");
    expect(reads).toHaveLength(1);
    const layers = memory.raw.prepare("SELECT content FROM layers").all() as Array<{ content: string }>;
    expect(layers).toHaveLength(3);
    for (const layer of layers) expect(layer.content).toContain("Panel text.");
  });

  it("no file, when every file is clean and holds the valid encoding of U+FFFD", async () => {
    for (const path of Object.keys(files)) files[path] = `${files[path]}# ${REPLACED}\n`;

    const result = await importNow();

    expect(result.valid).toBe(true);
    expect(unreadable(result.objects.warnings)).toEqual([]);
  });
});

describe("scanRepoPages names a page read lossily only when given a list", () => {
  it("with the repair it is given", async () => {
    lossy.add("telar-content/texts/pages/about.md");
    const warnings: SheetWarning[] = [];

    const pages = await scanRepoPages("t", "owner", "repo", HEAD, { warnings, repair: "import_then_publish" });

    expect(pages.map((p) => p.slug)).toEqual(["about"]);
    expect(warnings).toEqual([
      {
        code: "unreadable_characters",
        file: "telar-content/texts/pages/about.md",
        effect: "build_stops",
        repair: "import_then_publish",
      },
    ]);
  });
});
