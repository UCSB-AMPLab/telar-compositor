/**
 * The publish recomputes which sheets it corrects headings in from the texts
 * it reads at the publish head, so the headline "Correct column headings" is
 * kept only for a publish that does correct some. This also pins that such a
 * publish, with D1 unchanged, writes the fixed column names.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const OBJECTS_PATH = "telar-content/spreadsheets/objects.csv";

const { read } = vi.hoisted(() => ({ read: { objects: "", project: "" } }));

vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getSubtreeOids: vi.fn(async () => ({ ok: true, at: () => ({ kind: "absent" }) })),
    getFileAtRef: vi.fn(async (_t: string, _o: string, _r: string, path: string) =>
      path === "telar-content/spreadsheets/objects.csv"
        ? { status: "ok", content: read.objects }
        : path === "telar-content/spreadsheets/project.csv"
          ? { status: "ok", content: read.project }
          : { status: "absent" },
    ),
  };
});

vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => ({
    select: () => {
      const chain: Record<string, unknown> = {};
      let table = "";
      chain.from = (t: Record<symbol, unknown>) => {
        table = String(t[Symbol.for("drizzle:Name")]);
        return chain;
      };
      const rows = () => {
        if (table === "objects") return [{ object_id: "o1", title: "One", project_id: 1 }];
        if (table === "stories") return [{ id: 1, story_id: "weavers", title: "The Weavers", order: 1, project_id: 1, draft: false }];
        return [];
      };
      chain.where = () => Object.assign(Promise.resolve(rows()), chain);
      chain.orderBy = () => Promise.resolve(rows());
      chain.limit = () => Promise.resolve([]);
      return chain;
    },
  })),
}));

import { buildPublishFileSet } from "~/lib/publish.server";
import { misreadHeadingsIn, csvSheetFor } from "~/lib/import.server";

function build(headingsCorrected: string[]) {
  return buildPublishFileSet({
    token: "t", owner: "o", repo: "r", ref: "sha", projectId: 1, env: { DB: {} } as never,
    configYml: null, config: null, headingsCorrected,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  read.project = "";
});

describe("misreadHeadingsIn", () => {
  it("lists the headings the publish rewrites", () => {
    expect(misreadHeadingsIn("Object_ID,título,crédito,medio_genero\nloom,Loom,Ana,Oil\n", csvSheetFor("objects"))).toEqual([
      { header: "Object_ID", name: "object_id" },
    ]);
  });

  it("lists none for a file already in the written spelling", () => {
    expect(misreadHeadingsIn("object_id,título,crédito,medio_genero\nloom,Loom,Ana,Oil\n", csvSheetFor("objects"))).toEqual([]);
  });
});

describe("the files a publish corrects headings in", () => {
  it("names the sheet whose headings it read misspelled, and writes the fixed names", async () => {
    read.objects = "Object_ID,título,crédito,medio_genero\nloom,Loom,Ana,Oil\n";
    const corrected: string[] = [];
    const files = await build(corrected);

    expect(corrected).toEqual([OBJECTS_PATH]);
    expect(files.find((f) => f.path === OBJECTS_PATH)?.content.split("\n")[0]).toMatch(/^object_id,/);
  });

  it("writes order and story_id on project.csv from a capitalised file", async () => {
    read.objects = "";
    read.project = "Order,Story_ID,Title\n1,weavers,The Weavers\n";
    const corrected: string[] = [];
    const files = await build(corrected);

    expect(corrected).toContain("telar-content/spreadsheets/project.csv");
    expect(files.find((f) => f.path === "telar-content/spreadsheets/project.csv")?.content.split("\n")[0]).toMatch(/^order,story_id,title/);
  });

  it("names none when the sheets are in the written spelling", async () => {
    read.objects = "object_id,título,crédito,medio_genero\nloom,Loom,Ana,Oil\n";
    const corrected: string[] = [];
    await build(corrected);

    expect(corrected).toEqual([]);
  });
});
