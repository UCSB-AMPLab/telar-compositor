/**
 * A publish writes the project, objects and glossary sheets under their
 * English names, carrying the comment rows of the Spanish file it
 * read, and deletes the Spanish file in the same commit where it is there. A
 * Spanish file left beside the English one would be a stale fallback.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { atRef, files } = vi.hoisted(() => {
  const files: Record<string, string> = {};
  return {
    files,
    atRef: vi.fn(async (_t: string, _o: string, _r: string, path: string) =>
      path in files ? { status: "ok" as const, content: files[path] } : { status: "absent" as const },
    ),
  };
});

vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getFileAtRef: atRef, getFileContent: vi.fn(async () => null) };
});

const GLOSSARY_TERM = { term_id: "telar", title: "Telar", definition: "Un marco", related_terms: null, extra_columns: null };

// The glossary term, so a glossary sheet is written; every other read is empty.
vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => ({
    select: () => {
      const chain: Record<string, unknown> = {};
      let table = "";
      chain.from = (t: Record<symbol, unknown>) => {
        table = String(t[Symbol.for("drizzle:Name")]);
        return chain;
      };
      chain.where = () => Object.assign(Promise.resolve(table === "glossary_terms" ? [GLOSSARY_TERM] : []), chain);
      chain.orderBy = function (this: unknown) { return this; };
      chain.limit = () => Promise.resolve([]);
      return chain;
    },
  })),
}));

import { buildPublishFileSet } from "~/lib/publish.server";
import { readObjectsSheetAt } from "~/lib/pending-object-ops.server";
import { spanishSheetCounterparts } from "~/lib/site-sheets.server";

const SHEETS = "telar-content/spreadsheets";

function build(objectsSheet?: { path: string; existingCsv: string | undefined }, glossaryReadFrom?: { path?: string }) {
  return buildPublishFileSet({
    token: "tok",
    owner: "owner",
    repo: "repo",
    ref: "sha",
    projectId: 1,
    env: { DB: {} } as never,
    configYml: null,
    config: null,
    pages: [],
    landing: null,
    ...(objectsSheet ? { objectsSheet } : {}),
    ...(glossaryReadFrom ? { glossaryReadFrom } : {}),
  });
}

const sheetPaths = (written: Array<{ path: string }>) =>
  written.map((f) => f.path).filter((path) => path.startsWith(`${SHEETS}/`)).sort();

beforeEach(() => {
  vi.clearAllMocks();
  for (const path of Object.keys(files)) delete files[path];
});

describe("a publish of a site whose sheets have Spanish names", () => {
  it("writes project.csv, objects.csv and glossary.csv, carrying the comment rows of the Spanish files", async () => {
    files[`${SHEETS}/proyecto.csv`] = "order,story_id,title\n# nota del proyecto\n";
    files[`${SHEETS}/objetos.csv`] = "object_id,title\n# nota de objetos\n";
    files[`${SHEETS}/glosario.csv`] = "term_id,title,definition\n# nota del glosario\n";

    const readFrom: { path?: string } = {};
    const written = await build(undefined, readFrom);

    expect(sheetPaths(written)).toEqual([`${SHEETS}/glossary.csv`, `${SHEETS}/objects.csv`, `${SHEETS}/project.csv`]);
    const content = (name: string) => written.find((f) => f.path === `${SHEETS}/${name}`)?.content;
    expect(content("project.csv")).toContain("# nota del proyecto");
    expect(content("objects.csv")).toContain("# nota de objetos");
    expect(content("glossary.csv")).toContain("# nota del glosario");
    expect(spanishSheetCounterparts(written, readFrom.path)).toEqual([
      `${SHEETS}/proyecto.csv`,
      `${SHEETS}/objetos.csv`,
      `${SHEETS}/glosario.csv`,
    ]);
  });

  it("writes the English files where both are there", async () => {
    for (const name of ["project", "proyecto", "objects", "objetos", "glossary", "glosario"]) {
      files[`${SHEETS}/${name}.csv`] = "a,b\n";
    }

    expect(sheetPaths(await build())).toEqual([`${SHEETS}/glossary.csv`, `${SHEETS}/objects.csv`, `${SHEETS}/project.csv`]);
  });

  it("writes the English files for a site with neither", async () => {
    expect(sheetPaths(await build())).toEqual([`${SHEETS}/glossary.csv`, `${SHEETS}/objects.csv`, `${SHEETS}/project.csv`]);
  });

  it("names no Spanish file to delete where it writes no sheet of that role", () => {
    const glosario = `${SHEETS}/glosario.csv`;
    expect(spanishSheetCounterparts([{ path: `${SHEETS}/glossary.csv` }, { path: "_config.yml" }], glosario)).toEqual([glosario]);
    expect(spanishSheetCounterparts([{ path: "_config.yml" }], glosario)).toEqual([]);
  });

  it("keeps a glosario.csv beside a glossary.csv, which the build converts as a story", async () => {
    files[`${SHEETS}/glossary.csv`] = "term_id,title,definition\n# nota\n";
    files[`${SHEETS}/glosario.csv`] = "term_id,title,definition\n";
    files[`${SHEETS}/proyecto.csv`] = "order,story_id,title\n";
    const readFrom: { path?: string } = {};
    const written = await build(undefined, readFrom);

    expect(readFrom.path).toBe(`${SHEETS}/glossary.csv`);
    expect(spanishSheetCounterparts(written, readFrom.path)).toEqual([`${SHEETS}/proyecto.csv`, `${SHEETS}/objetos.csv`]);
  });

  it("deletes glosario.csv when the glossary was read from it alone", async () => {
    files[`${SHEETS}/glosario.csv`] = "term_id,title,definition\n# nota\n";
    const readFrom: { path?: string } = {};
    const written = await build(undefined, readFrom);

    expect(readFrom.path).toBe(`${SHEETS}/glosario.csv`);
    expect(spanishSheetCounterparts(written, readFrom.path)).toContain(`${SHEETS}/glosario.csv`);
  });

  it("writes the objects sheet the publish action read from objetos.csv under the English name", async () => {
    files[`${SHEETS}/objetos.csv`] = "object_id,title\n# nota de objetos\n";

    const read = await readObjectsSheetAt("tok", "owner", "repo", "sha");
    expect(read.path).toBe(`${SHEETS}/objetos.csv`);
    const existingCsv = read.file.status === "ok" ? read.file.content : undefined;

    const written = await build({ path: read.path, existingCsv });
    expect(written.find((f) => f.path === `${SHEETS}/objects.csv`)?.content).toContain("# nota de objetos");
    expect(sheetPaths(written)).not.toContain(`${SHEETS}/objetos.csv`);
  });
});
