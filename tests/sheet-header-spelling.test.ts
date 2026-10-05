/**
 * A heading the import reads as a fixed column and the framework does not
 * (`Step`, `Object_ID`, ` step `): the site reads such a column under that
 * exact text, so its values do not appear. Every publish writes the heading
 * the way both framework releases read it, and the import names it, from the
 * same walk over the file's header the publish layout makes.
 *
 * Which headings are named: those the framework's current release misreads. A
 * heading only the published tag misreads (`crédito`, a glossary's `Term_ID`)
 * is rewritten by the publish and not named.
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
    getSubtreeOids: vi.fn(async () => ({ ok: true, at: () => ({ kind: "absent" }) })),
  };
});
vi.mock("~/lib/sheets.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, discoverSheetTabs: vi.fn(), fetchSheetCsv: vi.fn() };
});

import * as columnMapping from "~/lib/column-mapping";
import * as csvExport from "~/lib/csv-export.server";
import * as publishServer from "~/lib/publish.server";
import {
  FRAMEWORK_GLOSSARY_RELEASES,
  GLOSSARY_CANONICAL_SCOPE,
  OBJECTS_CANONICAL_SCOPE,
  PROJECT_CANONICAL_SCOPE,
  STORY_CANONICAL_SCOPE,
  csvSheetFor,
  csvSheetForScope,
  importRepo,
  importedHeader,
  misreadHeadings,
  parseTelarCsv,
  readsAsColumn,
  type CsvSheetKind,
} from "~/lib/import.server";
import { commentRecordsOf, readCsvForComments } from "~/lib/csv-export.server";
import { fileSheetLayout } from "~/lib/sheet-csv-layout.server";
import type { SheetIssue } from "~/lib/sheet-warnings";
import { getFileAtRef, getFileContent } from "~/lib/github.server";
import { discoverSheetTabs, fetchSheetCsv } from "~/lib/sheets.server";
import { strictReadsFromFileContent } from "./helpers/strict-sheet-read";

type Spelling = Extract<SheetIssue, { code: "header_spelling" }>;

const SCOPE_OF: Record<CsvSheetKind, ReadonlySet<string>> = {
  objects: OBJECTS_CANONICAL_SCOPE,
  story: STORY_CANONICAL_SCOPE,
  project: PROJECT_CANONICAL_SCOPE,
  glossary: GLOSSARY_CANONICAL_SCOPE,
};

/** The one `header_spelling` a parse of `csv` as `kind` raises, or undefined. */
function spellingOf(kind: CsvSheetKind, csv: string): Spelling | undefined {
  const issues: SheetIssue[] = [];
  parseTelarCsv(csv, (i) => issues.push(i), kind === "project", SCOPE_OF[kind], { severalHoldValues: "keep-last" });
  const found = issues.filter((i): i is Spelling => i.code === "header_spelling");
  expect(found.length).toBeLessThanOrEqual(1);
  return found[0];
}

/**
 * The populated positions of `csv` whose fixed column the publish layout,
 * read under `releases`, writes under another header than the file's, in
 * sheet order. Each written column is matched to its position by the name the
 * import gives it, so a column the layout leaves out shifts nothing.
 */
function layoutRewrites(kind: CsvSheetKind, csv: string, releases = csvSheetFor(kind).releases): string[] {
  const sheet = { ...csvSheetFor(kind), releases };
  const reading = readCsvForComments(csv);
  const layout = fileSheetLayout(sheet, reading, commentRecordsOf(reading, true), []);
  const table = reading.rows.map((row) => row.cells);
  const header = importedHeader(table, sheet.canonicalScope, sheet.projectSheet);
  const cells = table[0];
  const positionOf = (name: string) =>
    name === "private" && header.protectionColumnIndex !== undefined
      ? header.protectionColumnIndex
      : header.finalNames.findIndex((n, i) => n === name && !header.droppedColumnIndexes.has(i));
  return layout!.columns
    .flatMap((column) => (column.source.kind === "fixed" ? [{ column, p: positionOf(column.source.name) }] : []))
    .filter(({ column, p }) => p >= 0 && header.holdsValues[p] && column.header !== cells[p].split("\u0000").join(""))
    .sort((a, b) => a.p - b.p)
    .map(({ p }) => cells[p]);
}

describe("the fixed column lists", () => {
  it("are one list each, re-exported where they were", () => {
    expect(csvExport.OBJECTS_CSV_COLUMNS).toBe(columnMapping.OBJECTS_CSV_COLUMNS);
    expect(publishServer.STORY_CSV_COLUMNS).toBe(columnMapping.STORY_CSV_COLUMNS);
    expect(publishServer.PROJECT_CSV_COLUMNS).toBe(columnMapping.PROJECT_CSV_COLUMNS);
    expect(publishServer.GLOSSARY_CSV_COLUMNS).toBe(columnMapping.GLOSSARY_CSV_COLUMNS);
  });

  it("are the sheets' fixed columns, found by the scope a parse reads under", () => {
    for (const kind of ["objects", "story", "project", "glossary"] as const) {
      expect(csvSheetForScope(SCOPE_OF[kind])).toEqual(csvSheetFor(kind));
    }
    expect(csvSheetFor("story").fixedColumns).toBe(columnMapping.STORY_CSV_COLUMNS);
    expect(csvSheetForScope(undefined)).toBeUndefined();
    expect(csvSheetForScope(new Set(["step"]))).toBeUndefined();
  });
});

describe("the glossary's head reader folds case after renaming", () => {
  const [tag, head] = FRAMEWORK_GLOSSARY_RELEASES;

  it("reads Term_ID as term_id at the head and not at the published tag", () => {
    expect(readsAsColumn(head, "Term_ID", "term_id")).toBe(true);
    expect(readsAsColumn(tag, "Term_ID", "term_id")).toBe(false);
  });

  it("so a glossary headed Term_ID is rewritten by the publish and not named", () => {
    const csv = "Term_ID,Title,definition\nloom,Loom,A frame\n";
    expect(spellingOf("glossary", csv)).toBeUndefined();
    expect(layoutRewrites("glossary", csv)).toEqual(["Term_ID", "Title"]);
  });
});

describe("header_spelling", () => {
  it("names every capitalised story heading with the name the publish writes, in sheet order", () => {
    expect(spellingOf("story", "Step,Object,X,Y,Zoom,Question,Answer\n1,loom,0.5,0.5,1,Q,A\n")).toEqual({
      code: "header_spelling",
      headers: ["Step", "Object", "X", "Y", "Zoom", "Question", "Answer"],
      names: ["step", "object", "x", "y", "zoom", "question", "answer"],
    });
  });

  it("names only the misspelt heading among correct ones", () => {
    expect(spellingOf("story", "step,object,Question\n1,loom,Q\n")).toMatchObject({
      headers: ["Question"],
      names: ["question"],
    });
  });

  it("names a heading as typed, its spaces kept", () => {
    expect(spellingOf("story", " step ,question\n1,Q\n")).toMatchObject({ headers: [" step "], names: ["step"] });
  });

  it("names Object_ID on objects.csv and not crédito, which the current release reads", () => {
    expect(spellingOf("objects", "Object_ID,título,crédito,medio_genero\nloom,Loom,Ana,Oil\n")).toMatchObject({
      headers: ["Object_ID"],
      names: ["object_id"],
    });
  });

  it("names a capitalised project.csv, whose stories the site otherwise cannot list", () => {
    expect(spellingOf("project", "Order,Story_ID,Title\n1,weavers,The Weavers\n")).toMatchObject({
      headers: ["Order", "Story_ID", "Title"],
      names: ["order", "story_id", "title"],
    });
  });

  it.each([
    ["Spanish and upper-case spellings both releases read", "story", "paso,PAGE,página\n1,2,3\n"],
    ["id_objeto", "objects", "id_objeto,title\nloom,Loom\n"],
    ["a custom column", "story", "step,Notes\n1,hi\n"],
    ["a blank heading", "story", "step,,question\n1,x,Q\n"],
    ["a column no row fills", "story", "Step,question\n,Q\n"],
    ["a collision loser", "story", "page,Página\n2,\n"],
    ["a project protection spelling", "project", "story_id,Private\nweavers,yes\n"],
    ["the template's own headings", "objects", "object_id,title,creator\nloom,Loom,Ana\n"],
    ["a repeated heading stored as title_1", "objects", "object_id,title,title\nloom,Loom,Second\n"],
    ["IIIF_Manifest, which the publish writes as source_url", "objects", "object_id,IIIF_Manifest\nloom,http://x\n"],
  ] as const)("names nothing for %s", (_, kind, csv) => {
    expect(spellingOf(kind, csv)).toBeUndefined();
  });

  it("marks a Google Sheets tab rather than leaving it out", () => {
    const issues: SheetIssue[] = [];
    parseTelarCsv("Step,question\n1,Q\n", (i) => issues.push(i), false, STORY_CANONICAL_SCOPE, {
      fromGoogleSheets: true,
    });
    expect(issues).toEqual([
      { code: "header_spelling", headers: ["Step"], names: ["step"], fromGoogleSheets: true },
    ]);
  });
});

describe("agreement with the publish layout", () => {
  const FIXTURES: Array<[CsvSheetKind, string]> = [
    ["story", "Step,Object,X,Y,Zoom,Question,Answer\n1,loom,0.5,0.5,1,Q,A\n"],
    ["story", " step ,question\n1,Q\n"],
    ["story", "paso,PAGE,página,Alt_Text\n1,2,3,alt\n"],
    ["story", "step,Notes,,question\n1,hi,x,Q\n"],
    ["story", "page,Página,Step\n2,,1\n"],
    ["objects", "Object_ID,título,crédito,medio_genero,Credit\nloom,Loom,Ana,Oil,\n"],
    ["objects", "object_id,Title,Creator,iiif_manifest\nloom,Loom,Ana,http://x\n"],
    ["project", "Order,Story_ID,Title,Private\n1,weavers,The Weavers,yes\n"],
    ["glossary", "Term_ID,Title,definition,Related_Terms\nloom,Loom,A frame,warp\n"],
  ];

  it.each(FIXTURES)("%s %j: names what the layout rewrites under the current release", (kind, csv) => {
    const named = spellingOf(kind, csv)?.headers ?? [];
    const head = csvSheetFor(kind).releases.slice(-1);
    expect(named).toEqual(layoutRewrites(kind, csv, head));
  });

  it.each(FIXTURES)("%s %j: names only what the publish rewrites", (kind, csv) => {
    const named = spellingOf(kind, csv)?.headers ?? [];
    const rewritten = layoutRewrites(kind, csv);
    expect(named.every((h) => rewritten.includes(h))).toBe(true);
  });

  it("reads positions as the layout does, through misreadHeadings", () => {
    const table = [["Step", "objeto"], ["1", "loom"]];
    expect(misreadHeadings(csvSheetFor("story"), importedHeader(table, STORY_CANONICAL_SCOPE), table[0])).toEqual({
      headers: ["Step"],
      names: ["step"],
    });
  });
});

describe("an import names misread headings", () => {
  const SHEETS = "telar-content/spreadsheets";
  const REPO_CONFIG = 'title: "Site"\ntelar:\n  version: "1.0.0"\n';
  const SHEETS_CONFIG =
    'title: "Site"\ntelar:\n  version: "1.0.0"\ngoogle_sheets:\n  enabled: true\n' +
    '  published_url: "https://docs.google.com/spreadsheets/d/e/2PACX-abc/pubhtml"\n';
  const OBJECTS = "Object_ID,Title\nloom,Loom\n";
  const PROJECT = "order,story_id,title\n1,weavers,The Weavers\n";
  const STORY = "Step,object,question\n1,loom,Q\n";

  let memory: MemoryD1;
  let files: Record<string, string>;
  let tabs: Record<string, string>;

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
    files = {};
    tabs = {};
    vi.mocked(getFileContent).mockImplementation(async (_t, _o, _r, path) => files[path] ?? null);
    vi.mocked(getFileAtRef).mockImplementation(
      strictReadsFromFileContent(vi.mocked(getFileContent), async () => ({ status: "absent" })) as never,
    );
    vi.mocked(discoverSheetTabs).mockImplementation(async () =>
      Object.keys(tabs).map((name, i) => ({ name, gid: String(i) })) as never,
    );
    vi.mocked(fetchSheetCsv).mockImplementation((async (_url: string, gid: string) =>
      Object.values(tabs)[Number(gid)]) as never);
  });

  afterEach(() => {
    memory.close();
  });

  it("in the repository's objects.csv and story CSV", async () => {
    files = {
      "_config.yml": REPO_CONFIG,
      [`${SHEETS}/objects.csv`]: OBJECTS,
      [`${SHEETS}/project.csv`]: PROJECT,
      [`${SHEETS}/weavers.csv`]: STORY,
    };
    const result = await importNow();
    const all = [...result.objects.warnings, ...result.stories.warnings];
    expect(all.filter((w) => w.code === "header_spelling")).toEqual([
      { code: "header_spelling", headers: ["Object_ID", "Title"], names: ["object_id", "title"], sheet: "objects.csv" },
      { code: "header_spelling", headers: ["Step"], names: ["step"], sheet: "weavers.csv" },
    ]);
  });

  it("in a Google Sheets tab, marked as one", async () => {
    files = { "_config.yml": SHEETS_CONFIG };
    tabs = { objects: OBJECTS, project: PROJECT, weavers: STORY };
    const result = await importNow();
    const all = [...result.objects.warnings, ...result.stories.warnings];
    expect(all.filter((w) => w.code === "header_spelling")).toEqual([
      { code: "header_spelling", headers: ["Object_ID", "Title"], names: ["object_id", "title"], fromGoogleSheets: true, sheet: "objects" },
      { code: "header_spelling", headers: ["Step"], names: ["step"], fromGoogleSheets: true, sheet: "weavers" },
    ]);
  });

  it("and nothing for the template's own headings", async () => {
    files = {
      "_config.yml": REPO_CONFIG,
      [`${SHEETS}/objects.csv`]: "object_id,title\nloom,Loom\n",
      [`${SHEETS}/project.csv`]: PROJECT,
      [`${SHEETS}/weavers.csv`]: "step,object,question\n1,loom,Q\n",
    };
    const result = await importNow();
    const all = [...result.objects.warnings, ...result.stories.warnings];
    expect(all.filter((w) => w.code === "header_spelling")).toEqual([]);
  });
});
