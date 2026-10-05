/**
 * The column picker on the first import. From a repository, the
 * choice is committed before the import runs again. From Google Sheets
 * nothing is committed and no tab is written: the import switches Sheets off,
 * so the choice is applied to the tabs it reads, and the first publish writes
 * the CSV.
 *
 * The repair runs for real; GitHub, the published Sheet and the commit are faked.
 *
 * @version v1.5.0-beta
 */

import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";

const site = vi.hoisted(() => ({ head: "head-sha", files: {} as Record<string, string>, tabs: {} as Record<string, string> }));

vi.mock("~/lib/github.server", async () => {
  const actual = await vi.importActual<typeof import("~/lib/github.server")>("~/lib/github.server");
  return {
    ...actual,
    getRepoHead: vi.fn(async () => site.head),
    getDefaultBranchHead: vi.fn(async () => ({ name: "main", oid: site.head })),
    getRepoTree: vi.fn(async () => ({ tree: [], truncated: false })),
    getFileAtRef: vi.fn(async (_t: string, _o: string, _r: string, path: string) =>
      site.files[path] === undefined ? { status: "absent" } : { status: "ok", content: site.files[path] },
    ),
    listDirectoryEntries: vi.fn(async (_t: string, _o: string, _r: string, _c: string, dir: string) =>
      Object.keys(site.files)
        .filter((path) => path.startsWith(`${dir}/`))
        .map((path) => ({ path, mode: "100644", type: "blob", sha: "x" })),
    ),
  };
});
vi.mock("~/lib/sheets.server", async () => {
  const actual = await vi.importActual<typeof import("~/lib/sheets.server")>("~/lib/sheets.server");
  return {
    ...actual,
    discoverSheetTabs: vi.fn(async () => Object.keys(site.tabs).map((name, i) => ({ name, gid: String(i) }))),
    fetchSheetCsv: vi.fn(async (_id: string, gid: string) => Object.values(site.tabs)[Number(gid)]),
  };
});
vi.mock("~/lib/commit.server", async () => {
  const actual = await vi.importActual<typeof import("~/lib/commit.server")>("~/lib/commit.server");
  return { ...actual, commitFilesToRepo: vi.fn(async () => ({ newHeadSha: "repaired-sha" })) };
});

import { CollidingColumnsRefusal, TabsChangedError, importRepo } from "~/lib/import.server";
import { commitFilesToRepo } from "~/lib/commit.server";
import { importChoicesResult, settleImportChoices } from "~/lib/sheet-choices.server";

const URL_OF_SHEET = "https://docs.google.com/spreadsheets/d/e/2PACX-TEST/pubhtml";
const OBJECTS = "telar-content/spreadsheets/objects.csv";
const COLLIDING = "object_id,title,medium,object_type\nobj-001,First,Oil,Painting\n";
const CONTEXT = { token: "user-token", repoFullName: "owner/repo", userId: 7, secret: "sess-secret" };

function chooseForm(challenge: string, file: string): FormData {
  const form = new FormData();
  form.set("sheet_challenge", challenge);
  form.set("sheet_choices", JSON.stringify([{ file, positions: [2, 3], keep: 3 }]));
  return form;
}

function sheetsRefusal(): CollidingColumnsRefusal {
  return Object.assign(new CollidingColumnsRefusal("objects", "medium_genre", ["medium", "object_type"]), { publishedSheetsUrl: URL_OF_SHEET });
}

beforeEach(() => {
  vi.clearAllMocks();
  site.head = "head-sha";
  site.files = {};
  site.tabs = {};
});

describe("a first import from Google Sheets", () => {
  it("offers the tab's group, and applies the choice to the tab it reads without a commit", async () => {
    site.tabs = { objects: COLLIDING, project: "story_id,title\nstory-one,One\n" };
    const asked = await importChoicesResult(sheetsRefusal(), CONTEXT);
    expect(asked?.validationError).toBe("needs_choices");
    expect(asked?.sheetChoices?.groups.map((g) => [g.file, g.positions])).toEqual([["objects", [2, 3]]]);

    const settled = await settleImportChoices(chooseForm(asked?.sheetChoices?.challenge ?? "", "objects"), CONTEXT);
    expect(settled.proceed).toBe(true);
    const readTab = settled.proceed ? settled.readTab : undefined;
    expect(await readTab?.("objects", COLLIDING)).toBe("object_id,title,object_type\nobj-001,First,Painting\n");
    expect(await readTab?.("project", site.tabs.project)).toBe(site.tabs.project);
    expect(commitFilesToRepo).not.toHaveBeenCalled();
  });

  const GLOSARIO = "term_id,title,definition,kind,tipo\nwarp,Warp,Threads,a,b\n";

  it("reads a glosario tab as the glossary where there is no glossary tab, so its kind and tipo columns are offered", async () => {
    site.tabs = { glosario: GLOSARIO };
    const asked = await importChoicesResult(sheetsRefusal(), CONTEXT);
    expect(asked?.validationError).toBe("needs_choices");
    expect(asked?.sheetChoices?.groups.map((g) => g.file)).toEqual(["glosario"]);
  });

  it("reads a glosario tab beside a glossary tab as a story, which has no tipo alias", async () => {
    site.tabs = { glossary: "term_id,title,definition\nwarp,Warp,Threads\n", glosario: GLOSARIO };
    const asked = await importChoicesResult(sheetsRefusal(), CONTEXT);
    expect(asked?.sheetChoices?.groups ?? []).toEqual([]);
  });

  it("refuses to apply the choice to a tab whose bytes changed since the author chose", async () => {
    site.tabs = { objects: COLLIDING };
    const asked = await importChoicesResult(sheetsRefusal(), CONTEXT);
    const settled = await settleImportChoices(chooseForm(asked?.sheetChoices?.challenge ?? "", "objects"), CONTEXT);
    const readTab = settled.proceed ? settled.readTab : undefined;
    const changed = `${COLLIDING}obj-002,Second,Ink,\n`;
    await expect(readTab?.("objects", changed)).rejects.toBeInstanceOf(TabsChangedError);
  });

  it("reads every tab through readTab, and a refusal names the published Sheet", async () => {
    const config = readFileSync("tests/fixtures/config.yml", "utf8").replace(
      'enabled: false\n  published_url: ""',
      `enabled: true\n  published_url: "${URL_OF_SHEET}"`,
    );
    site.files = { "_config.yml": config };
    site.tabs = { objects: COLLIDING };
    const readTab = vi.fn(async (_name: string, text: string) => text);
    const outcome = await importRepo({
      token: "user-token",
      installationId: 1,
      repoFullName: "owner/repo",
      userId: 7,
      env: { DB: {} } as unknown as Env,
      readTab,
    }).catch((err: unknown) => err);
    expect(readTab).toHaveBeenCalledWith("objects", COLLIDING);
    expect(outcome).toBeInstanceOf(CollidingColumnsRefusal);
    expect((outcome as CollidingColumnsRefusal).publishedSheetsUrl).toBe(URL_OF_SHEET);
  });

  it("refuses an import whose chosen tab is gone by the time it lists the tabs", async () => {
    const config = readFileSync("tests/fixtures/config.yml", "utf8").replace(
      'enabled: false\n  published_url: ""',
      `enabled: true\n  published_url: "${URL_OF_SHEET}"`,
    );
    site.files = { "_config.yml": config };
    site.tabs = { objects: COLLIDING, project: "story_id,title\n" };
    const asked = await importChoicesResult(sheetsRefusal(), CONTEXT);
    const settled = await settleImportChoices(chooseForm(asked?.sheetChoices?.challenge ?? "", "objects"), CONTEXT);
    if (!settled.proceed) throw new Error("the choice did not settle");
    // The objects tab is deleted after the choice was checked and before the import lists the tabs.
    site.tabs = { project: "story_id,title\n" };
    const outcome = await importRepo({
      token: "user-token",
      installationId: 1,
      repoFullName: "owner/repo",
      userId: 7,
      env: { DB: {} } as unknown as Env,
      readTab: settled.readTab,
      checkTabs: settled.checkTabs,
    }).catch((err: unknown) => err);
    expect(outcome).toBeInstanceOf(TabsChangedError);
    expect((outcome as TabsChangedError).tab).toBe("objects");
    expect((outcome as TabsChangedError).publishedSheetsUrl).toBe(URL_OF_SHEET);
  });

  it("lets a tab changed since the choice out of the Sheets branch, naming the published Sheet", async () => {
    const config = readFileSync("tests/fixtures/config.yml", "utf8").replace(
      'enabled: false\n  published_url: ""',
      `enabled: true\n  published_url: "${URL_OF_SHEET}"`,
    );
    site.files = { "_config.yml": config };
    site.tabs = { objects: COLLIDING };
    const outcome = await importRepo({
      token: "user-token",
      installationId: 1,
      repoFullName: "owner/repo",
      userId: 7,
      env: { DB: {} } as unknown as Env,
      readTab: async (name: string) => Promise.reject(new TabsChangedError(name)),
    }).catch((err: unknown) => err);
    expect(outcome).toBeInstanceOf(TabsChangedError);
    expect((outcome as TabsChangedError).publishedSheetsUrl).toBe(URL_OF_SHEET);
  });
});

describe("a first import from a repository", () => {
  it("commits the chosen column at the head it read before the import runs", async () => {
    site.files = { [OBJECTS]: COLLIDING };
    const asked = await importChoicesResult(new CollidingColumnsRefusal("objects.csv", "medium_genre", ["medium", "object_type"]), CONTEXT);
    expect(asked?.sheetChoices?.groups.map((g) => g.file)).toEqual([OBJECTS]);

    const settled = await settleImportChoices(chooseForm(asked?.sheetChoices?.challenge ?? "", OBJECTS), CONTEXT);
    expect(settled).toEqual({ proceed: true });
    const call = vi.mocked(commitFilesToRepo).mock.calls[0];
    expect(call[4]).toEqual([{ path: OBJECTS, content: "object_id,title,object_type\nobj-001,First,Painting\n", verbatim: true }]);
    expect(call[9]).toBe("head-sha");
  });

  it("keeps the refusal where the repair sees no group", async () => {
    site.files = {};
    const asked = await importChoicesResult(new CollidingColumnsRefusal("objects.csv", "medium_genre", ["medium", "object_type"]), CONTEXT);
    expect(asked).toBeNull();
  });

  it("runs the import as it is when nothing is posted", async () => {
    expect(await settleImportChoices(new FormData(), CONTEXT)).toEqual({ proceed: true });
  });
});
