/**
 * The import reads the project, objects and glossary sheets from the file the
 * build reads: the English name, else `proyecto.csv`, `objetos.csv`
 * and `glosario.csv` where the English file is not there
 * (`find_csv_with_fallback`); from Google Sheets, the `proyecto`, `objetos` and
 * `glosario` tabs, which the framework's fetch writes under those names. None
 * of those files is a story.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getDefaultBranchHead: vi.fn(async () => ({ name: "main", oid: "head-sha" })),
    getRepoTree: vi.fn(async () => ({ tree: [], truncated: false })),
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
import { getFileAtRef, getSubtreeOids, listSubtreeEntries } from "~/lib/github.server";
import { discoverSheetTabs, fetchSheetCsv } from "~/lib/sheets.server";

const SHEETS = "telar-content/spreadsheets";
const REPO_CONFIG = 'title: "Site"\ntelar:\n  version: "1.0.0"\n';
const SHEETS_CONFIG =
  'title: "Site"\ntelar:\n  version: "1.0.0"\ngoogle_sheets:\n  enabled: true\n' +
  '  published_url: "https://docs.google.com/spreadsheets/d/e/2PACX-abc/pubhtml"\n';

const OBJETOS = "object_id,title\nmapa,Mapa\n";
const PROYECTO = "order,story_id,title\n1,historia,Historia\n";
const GLOSARIO = "term_id,title,definition\ntelar,Telar,Un marco.\n";
const STORY = "step,object,question,answer\n1,mapa,¿Qué?,Esto.\n";

let memory: MemoryD1;
let files: Record<string, string>;

function importNow() {
  return importRepo({
    token: "t",
    installationId: 1,
    repoFullName: "owner/repo",
    userId: 1,
    env: { DB: asD1(memory), ENCRYPTION_KEY: "a".repeat(64) } as unknown as Env,
  });
}

function column(sql: string): unknown[] {
  return (memory.raw.prepare(sql).all() as Array<Record<string, unknown>>).map((row) => Object.values(row)[0]);
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
  files = { "_config.yml": REPO_CONFIG };
  vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path) =>
    path in files ? { status: "ok", content: files[path] } : { status: "absent" },
  );
  vi.mocked(getSubtreeOids).mockResolvedValue({ ok: true, at: () => ({ kind: "tree", oid: "sheets-oid" }) } as never);
  vi.mocked(listSubtreeEntries).mockImplementation(async () => {
    const names = Object.keys(files)
      .filter((path) => path.startsWith(`${SHEETS}/`))
      .map((path) => path.slice(SHEETS.length + 1));
    return { files: new Map(names.map((name) => [name, `sha-${name}`])), dirs: new Set<string>() } as never;
  });
});

afterEach(() => {
  memory.close();
});

describe("an import from a repository whose sheets have Spanish names", () => {
  it("reads objetos.csv, proyecto.csv and glosario.csv, and lists none of them as a story", async () => {
    files[`${SHEETS}/objetos.csv`] = OBJETOS;
    files[`${SHEETS}/proyecto.csv`] = PROYECTO;
    files[`${SHEETS}/glosario.csv`] = GLOSARIO;
    files[`${SHEETS}/historia.csv`] = STORY;

    const result = await importNow();

    expect(result.valid).toBe(true);
    expect(column("SELECT object_id FROM objects")).toEqual(["mapa"]);
    expect(column("SELECT story_id FROM stories")).toEqual(["historia"]);
    expect(column("SELECT term_id FROM glossary_terms")).toEqual(["telar"]);
    expect(column("SELECT COUNT(*) FROM steps")).toEqual([1]);
    expect(result.orphanStoryIds).toEqual([]);
  });

  it("reads the English file where both are there, and leaves the Spanish one unread, a glosario.csv beside glossary.csv being a story the build converts", async () => {
    files[`${SHEETS}/objects.csv`] = "object_id,title\nmap,Map\n";
    files[`${SHEETS}/project.csv`] = "order,story_id,title\n1,story,Story\n";
    files[`${SHEETS}/glossary.csv`] = "term_id,title,definition\nloom,Loom,A frame.\n";
    files[`${SHEETS}/story.csv`] = "step,object,question,answer\n1,map,What?,This.\n";
    files[`${SHEETS}/objetos.csv`] = OBJETOS;
    files[`${SHEETS}/proyecto.csv`] = PROYECTO;
    files[`${SHEETS}/glosario.csv`] = GLOSARIO;

    const result = await importNow();

    expect(result.valid).toBe(true);
    expect(column("SELECT object_id FROM objects")).toEqual(["map"]);
    expect(column("SELECT story_id FROM stories")).toEqual(["story"]);
    expect(column("SELECT term_id FROM glossary_terms")).toEqual(["loom"]);
    const read = vi.mocked(getFileAtRef).mock.calls.map((call) => call[3]);
    for (const name of ["objetos.csv", "proyecto.csv", "glosario.csv"]) expect(read).not.toContain(`${SHEETS}/${name}`);
    // The build skips both names of the project and objects sheets, and reads
    // only the glossary it uses as the glossary; a glosario.csv beside it is
    // converted as a story.
    expect(result.orphanStoryIds).toEqual(["glosario"]);
  });
});

describe("an import from a Google Sheet whose tabs have Spanish names", () => {
  it("reads the objetos, proyecto and glosario tabs as the objects, project and glossary sheets", async () => {
    files["_config.yml"] = SHEETS_CONFIG;
    const tabs: Record<string, string> = { "1": OBJETOS, "2": PROYECTO, "3": GLOSARIO, "4": STORY };
    vi.mocked(discoverSheetTabs).mockResolvedValue([
      { name: "Objetos", gid: "1" },
      { name: "proyecto", gid: "2" },
      { name: "glosario", gid: "3" },
      { name: "historia", gid: "4" },
    ] as never);
    vi.mocked(fetchSheetCsv).mockImplementation(async (_id, gid) => tabs[gid]);

    const result = await importNow();

    expect(result.valid).toBe(true);
    expect(column("SELECT object_id FROM objects")).toEqual(["mapa"]);
    expect(column("SELECT story_id FROM stories")).toEqual(["historia"]);
    expect(column("SELECT term_id FROM glossary_terms")).toEqual(["telar"]);
    expect(column("SELECT COUNT(*) FROM steps")).toEqual([1]);
  });

  it("reads the English tab where both are there", async () => {
    files["_config.yml"] = SHEETS_CONFIG;
    const tabs: Record<string, string> = { "1": OBJETOS, "2": "object_id,title\nmap,Map\n" };
    vi.mocked(discoverSheetTabs).mockResolvedValue([
      { name: "objetos", gid: "1" },
      { name: "objects", gid: "2" },
    ] as never);
    vi.mocked(fetchSheetCsv).mockImplementation(async (_id, gid) => tabs[gid]);

    const result = await importNow();

    expect(result.valid).toBe(true);
    expect(column("SELECT object_id FROM objects")).toEqual(["map"]);
  });
});
