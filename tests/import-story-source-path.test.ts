/**
 * The import records, on each story, the path of the CSV it read the story's
 * steps from (`stories.source_path`): the spreadsheets folder first,
 * then `_data/`, then the repository's root, and NULL when it found none. A
 * publish deletes an unreadable `_data` copy whatever that path, and a root
 * copy only where the path names it.
 *
 * The import's warning that the next publish removes an older copy
 * (`remove_old_copy`) must name exactly the copies that publish deletes: the
 * import reads, and so warns about, a root copy only when it is the story's
 * source, which is when the publish deletes it.
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

import { importRepo } from "~/lib/import.server";
import { olderStoryCopies } from "~/lib/publish.server";
import type { ConditionalDeletion } from "~/lib/commit.server";
import {
  getFileAtRef,
  getFileContent,
  getRepoHead,
  getDefaultBranchHead,
  getRepoTree,
  getSubtreeOids,
  listSubtreeEntries,
} from "~/lib/github.server";

const HEAD = "head-sha";
const SHEETS = "telar-content/spreadsheets";
const CONFIG = 'title: "Site"\ntelar:\n  version: "1.0.0"\n';
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

/** Each story's recorded path, by story id. */
function sourcePaths(): Record<string, string | null> {
  const rows = memory.raw.prepare("SELECT story_id, source_path FROM stories").all() as Array<{ story_id: string; source_path: string | null }>;
  return Object.fromEntries(rows.map((r) => [r.story_id, r.source_path]));
}

describe("importRepo records the path each story's steps were read from", () => {
  it("the spreadsheets folder, when the story's CSV is there, beside older copies", async () => {
    files["_data/story-one.csv"] = STORY_CSV;
    files["story-one.csv"] = STORY_CSV;
    await importNow();
    expect(sourcePaths()).toEqual({ "story-one": `${SHEETS}/story-one.csv` });
  });

  it("the _data copy, when there is no spreadsheets CSV, beside a root copy", async () => {
    delete files[`${SHEETS}/story-one.csv`];
    files["_data/story-one.csv"] = STORY_CSV;
    files["story-one.csv"] = STORY_CSV;
    await importNow();
    expect(sourcePaths()).toEqual({ "story-one": "_data/story-one.csv" });
  });

  it("the root copy, when it is the only one", async () => {
    delete files[`${SHEETS}/story-one.csv`];
    files["story-one.csv"] = STORY_CSV;
    await importNow();
    expect(sourcePaths()).toEqual({ "story-one": "story-one.csv" });
  });

  it("nothing, when the story has no CSV at any path", async () => {
    delete files[`${SHEETS}/story-one.csv`];
    await importNow();
    expect(sourcePaths()).toEqual({ "story-one": null });
  });
});

/**
 * The paths a commit deletes of `older`, as `commitFilesToRepo` selects them
 * (tests/publish-older-story-copies.test.ts runs the real selection): present,
 * none of `unlessPresent` present, and unreadable where asked.
 */
function selected(older: ConditionalDeletion[], present: ReadonlySet<string>, unreadable: ReadonlySet<string>): string[] {
  return older
    .filter((c) => present.has(c.path) && !c.unlessPresent.some((p) => present.has(p)))
    .filter((c) => !c.onlyIfUnreadable || unreadable.has(c.path))
    .map((c) => c.path);
}

describe("the import's warning and the next publish agree on which older copy is removed", () => {
  const DATA = "_data/story-one.csv";
  const ROOT = "story-one.csv";

  it.each([
    ["an unreadable _data copy alone", [DATA], [DATA]],
    ["an unreadable root copy alone", [ROOT], [ROOT]],
    ["an unreadable _data copy and an unreadable root copy", [DATA, ROOT], [DATA, ROOT]],
    ["a readable _data copy and an unreadable root copy", [DATA, ROOT], [ROOT]],
    ["an unreadable _data copy and a readable root copy", [DATA, ROOT], [DATA]],
  ])("with %s and no spreadsheets CSV", async (_label, copies, unreadableCopies) => {
    delete files[`${SHEETS}/story-one.csv`];
    for (const path of copies) files[path] = STORY_CSV;
    for (const path of unreadableCopies) lossy.add(path);

    const result = await importNow();
    const warned = result.objects.warnings
      .filter((w) => w.code === "unreadable_characters" && w.repair === "remove_old_copy")
      .map((w) => (w as { file: string }).file);

    const stories = memory.raw.prepare("SELECT story_id, source_path FROM stories").all() as Array<{ story_id: string; source_path: string | null }>;
    const written = [{ path: `${SHEETS}/story-one.csv`, content: "" }];
    const deleted = selected(olderStoryCopies(written, stories), new Set(copies), new Set(unreadableCopies));

    expect(deleted.sort()).toEqual([...warned].sort());
  });
});
