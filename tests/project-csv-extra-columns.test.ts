/**
 * project.csv custom columns survive import and publish.
 *
 * A column the Compositor has no field for is kept per story in
 * `stories.extra_columns`, in file order, and written back at its place in the
 * file with the author's values. The round trip runs the real import mapper
 * over the file, hands the rows to the publish assembly as D1 returns them,
 * and reads the project.csv it writes.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { existingFiles } = vi.hoisted(() => ({
  existingFiles: new Map<string, string>(),
}));

vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getFileAtRef: vi.fn(async (_t: string, _o: string, _r: string, path: string) =>
      existingFiles.has(path)
        ? { status: "ok" as const, content: existingFiles.get(path)! }
        : { status: "absent" as const },
    ),
    getFileContent: vi.fn(async () => null),
    // No story sheets in the repository yet.
    getSubtreeOids: vi.fn(async () => ({ ok: true, at: () => ({ kind: "absent" }) })),
  };
});

const { storyRowsInD1, storyUpdates } = vi.hoisted(() => ({
  storyRowsInD1: { current: [] as Array<Record<string, unknown>> },
  storyUpdates: [] as Array<Record<string, unknown>>,
}));

// The reads of the assembly, answered by table: stories as D1 holds them, a
// config row so `_config.yml` is judged, nothing else.
vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => ({
    select: () => {
      const chain: Record<string, unknown> = {};
      let table = "";
      chain.from = (t: Record<symbol, unknown>) => {
        table = String(t[Symbol.for("drizzle:Name")]);
        return chain;
      };
      chain.where = () =>
        Object.assign(Promise.resolve(table === "stories" ? storyRowsInD1.current : []), chain);
      chain.orderBy = function (this: unknown) { return this; };
      chain.innerJoin = () => chain;
      chain.limit = () => Promise.resolve([]);
      return chain;
    },
    // The capture writes one story's blob; the cases below hold one story to record.
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          storyUpdates.push(values);
          for (const row of storyRowsInD1.current) Object.assign(row, values);
        },
      }),
    }),
  })),
}));

import { projectCsvStoryRows } from "~/lib/import.server";
import { buildPublishFileSet, serializeProjectCsv } from "~/lib/publish.server";
import { captureKeptColumns } from "~/lib/kept-columns-capture.server";

const PROJECT_CSV_PATH = "telar-content/spreadsheets/project.csv";

/** The rows D1 holds after the import inserts `file`'s stories (column defaults filled in). */
function d1StoriesOf(file: string): Array<Record<string, unknown>> {
  return projectCsvStoryRows(file).map((s, i) => ({
    id: i + 1,
    draft: false,
    extra_columns: null,
    ...s,
    project_id: 1,
  }));
}

/** The project.csv a publish writes for the stories in `rows`, over `file` already in the repository. */
async function publishedProjectCsv(file: string, rows = d1StoriesOf(file)): Promise<string[]> {
  existingFiles.clear();
  existingFiles.set(PROJECT_CSV_PATH, file);
  storyRowsInD1.current = rows;
  const files = await buildPublishFileSet({
    token: "tok",
    owner: "owner",
    repo: "repo",
    ref: "sha",
    projectId: 1,
    env: { DB: {} } as never,
  });
  const out = files.find((f) => f.path === PROJECT_CSV_PATH);
  if (!out) throw new Error("no project.csv in the file set");
  return out.content.split("\n");
}

beforeEach(() => {
  existingFiles.clear();
  storyRowsInD1.current = [];
  storyUpdates.length = 0;
});

describe("project.csv custom columns, import to publish", () => {
  const FILE = [
    "order,story_id,curator,title,subtitle,byline,private",
    "1,loom,Ana María,Loom,,,",
    "2,shuttle,\"Díaz, Luis\",Shuttle,,,",
  ].join("\n") + "\n";

  it("import keeps the custom column in extra_columns, and no known column", () => {
    const rows = projectCsvStoryRows(FILE);
    expect(rows.map((r) => JSON.parse(r.extra_columns as string))).toEqual([
      { curator: "Ana María" },
      { curator: "Díaz, Luis" },
    ]);
  });

  it("publish writes the column at its place in the file with the values intact", async () => {
    const out = await publishedProjectCsv(FILE);
    expect(out[0]).toBe("order,story_id,curator,title,subtitle,byline,private,show_sections");
    expect(out[2]).toBe("1,loom,Ana María,Loom,,,,");
    expect(out[3]).toBe('2,shuttle,"Díaz, Luis",Shuttle,,,,');
  });

  it("publish appends the column when the repository has no project.csv yet", () => {
    const rows = d1StoriesOf(FILE);
    const out = serializeProjectCsv(
      rows.map((r) => ({
        story_id: r.story_id as string,
        title: (r.title as string) ?? null,
        subtitle: null,
        byline: null,
        order: r.order as number,
        private: false,
        draft: false,
        show_sections: false,
        extra_columns: r.extra_columns as string,
      })),
    ).split("\n");
    expect(out[0]).toBe("order,story_id,title,subtitle,byline,private,show_sections,curator");
    expect(out[2]).toBe("1,loom,Loom,,,,,Ana María");
  });

  it("a story made in the Compositor, with no custom cells, publishes the column blank", async () => {
    const rows = [
      ...d1StoriesOf(FILE),
      { id: 3, project_id: 1, draft: false, story_id: "bobbin", title: "Bobbin", order: 3, private: false, show_sections: false },
    ];
    const out = await publishedProjectCsv(FILE, rows);
    expect(out[0]).toBe("order,story_id,curator,title,subtitle,byline,private,show_sections");
    expect(out[4]).toBe("3,bobbin,,Bobbin,,,,");
  });

  it("a Spanish-headed file keeps its own column, and no Spanish header becomes a custom column", async () => {
    const spanish = [
      "orden,id_historia,titulo,subtitulo,firma,privada,mostrar_secciones,curador",
      "1,telar,Telar,,,,sí,Ana María",
    ].join("\n") + "\n";
    const rows = projectCsvStoryRows(spanish);
    expect(JSON.parse(rows[0].extra_columns as string)).toEqual({ curador: "Ana María" });
    expect(rows[0].show_sections).toBe(true);

    const out = await publishedProjectCsv(spanish);
    expect(out[0]).toBe("orden,id_historia,titulo,subtitulo,firma,privada,mostrar_secciones,curador");
    expect(out[2]).toBe("1,telar,Telar,,,,yes,Ana María");
  });

  it("a file with no custom column stores none", () => {
    const rows = projectCsvStoryRows("order,story_id,title\n1,loom,Loom\n");
    expect(rows[0].extra_columns).toBeUndefined();
  });
});

describe("a story imported before project.csv's custom columns were kept", () => {
  const REPO_FILE = "order,story_id,title,curator\n1,loom,Loom,Ana\n";
  // The mocked db is handed in through getDb, as the route does.
  async function capturedThenPublished(extraColumns: string | null, renamed?: { story_id: string; source_path: string }): Promise<string[]> {
    existingFiles.clear();
    existingFiles.set(PROJECT_CSV_PATH, REPO_FILE);
    storyRowsInD1.current = [
      { id: 1, project_id: 1, draft: false, story_id: "loom", title: "Loom", order: 1, private: false, show_sections: false, extra_columns: extraColumns, ...renamed },
    ];
    const { getDb } = await import("~/lib/db.server");
    await captureKeptColumns(getDb({} as never), { COLLABORATION: {}, SESSION_SECRET: "s" } as never, 1, { token: "t", owner: "o", repo: "r" }, "sha");
    const files = await buildPublishFileSet({
      token: "tok", owner: "owner", repo: "repo", ref: "sha", projectId: 1, env: { DB: {} } as never,
    });
    return files.find((f) => f.path === PROJECT_CSV_PATH)!.content.split("\n");
  }

  it("NULL extra_columns: the publish keeps the repository's custom column and its values, and D1 records them", async () => {
    const out = await capturedThenPublished(null);
    expect(out[0]).toBe("order,story_id,title,curator,subtitle,byline,private,show_sections");
    expect(out[2]).toBe("1,loom,Loom,Ana,,,,");
    expect(storyUpdates).toEqual([{ extra_columns: '{"curator":"Ana"}' }]);
  });

  it("a site whose sheet is proyecto.csv: the custom column is read from it and recorded", async () => {
    existingFiles.clear();
    existingFiles.set("telar-content/spreadsheets/proyecto.csv", "orden,id_historia,titulo,curador\n1,loom,Loom,Ana\n");
    storyRowsInD1.current = [
      { id: 1, project_id: 1, draft: false, story_id: "loom", title: "Loom", order: 1, private: false, show_sections: false, extra_columns: null },
    ];
    const { getDb } = await import("~/lib/db.server");
    await captureKeptColumns(getDb({} as never), { COLLABORATION: {}, SESSION_SECRET: "s" } as never, 1, { token: "t", owner: "o", repo: "r" }, "sha");
    expect(storyUpdates).toEqual([{ extra_columns: '{"curador":"Ana"}' }]);
  });

  it("a recorded blob is D1's: the repository's value is not read back", async () => {
    const out = await capturedThenPublished('{"curator":"Bea"}');
    expect(storyUpdates).toEqual([]);
    expect(out[2]).toBe("1,loom,Loom,Bea,,,,");
  });

  it("an empty recorded blob is D1's too: the column is not brought back from the repository", async () => {
    const out = await capturedThenPublished("{}");
    expect(storyUpdates).toEqual([]);
    expect(out[0]).toBe("order,story_id,title,subtitle,byline,private,show_sections");
  });

  it("a story renamed in the editor before its first publish takes the custom cells of the row it had (loom to weave)", async () => {
    const out = await capturedThenPublished(null, {
      story_id: "weave",
      source_path: "telar-content/spreadsheets/loom.csv",
    });
    expect(storyUpdates).toEqual([{ extra_columns: '{"curator":"Ana"}' }]);
    expect(out[0]).toBe("order,story_id,title,curator,subtitle,byline,private,show_sections");
    expect(out[2]).toBe("1,weave,Loom,Ana,,,,");
  });

  it.each(["_data/loom.csv", "loom.csv"])(
    "a renamed story whose CSV was imported from %s takes the custom cells of the row it had",
    async (source_path) => {
      const out = await capturedThenPublished(null, { story_id: "weave", source_path });
      expect(storyUpdates).toEqual([{ extra_columns: '{"curator":"Ana"}' }]);
      expect(out[2]).toBe("1,weave,Loom,Ana,,,,");
    },
  );

  it("a story takes the ID another story left, not the row of the ID it now holds", async () => {
    // Renamed to `loom` from `shuttle`: the repository's `loom` row is not its row.
    const out = await capturedThenPublished(null, {
      story_id: "loom",
      source_path: "telar-content/spreadsheets/shuttle.csv",
    });
    expect(storyUpdates).toEqual([]);
    expect(out[0]).toBe("order,story_id,title,subtitle,byline,private,show_sections");
  });
});
