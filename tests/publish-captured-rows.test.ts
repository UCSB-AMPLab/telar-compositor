/**
 * The file set and the hashes a publish records take the rows the action
 * captured once, and read their own only when none was handed down.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getFileAtRef: vi.fn(async (_t: string, _o: string, _r: string, path: string) =>
      path === "_config.yml" ? { status: "ok" as const, content: 'title: "x"\n' } : { status: "absent" as const }),
  };
});

const { tableRows, tablesRead } = vi.hoisted(() => ({
  tableRows: { current: {} as Record<string, unknown[]> },
  tablesRead: [] as string[],
}));

function tableName(table: unknown): string {
  if (table === null || typeof table !== "object") return "unknown";
  const sym = Object.getOwnPropertySymbols(table).find((s) => s.description === "drizzle:Name");
  return sym ? String((table as Record<symbol, unknown>)[sym]) : "unknown";
}

vi.mock("~/lib/db.server", () => ({
  getDb: () => ({
    select: () => {
      const chain: Record<string, unknown> = {};
      let rows: unknown[] = [];
      chain.from = (table: unknown) => {
        tablesRead.push(tableName(table));
        rows = tableRows.current[tableName(table)] ?? [];
        return chain;
      };
      chain.innerJoin = () => chain;
      chain.where = () => Object.assign(Promise.resolve(rows), chain);
      chain.limit = () => Promise.resolve(rows);
      chain.orderBy = () => Promise.resolve(rows);
      return chain;
    },
  }),
}));

import { buildEntityHashes, buildPublishFileSet } from "~/lib/publish.server";
import { getDb } from "~/lib/db.server";

const menu = (label: string) => JSON.stringify([{ type: "page", label, slug: "about" }]);

beforeEach(() => {
  tablesRead.length = 0;
  tableRows.current = {
    stories: [],
    objects: [],
    project_pages: [{ slug: "in-d1", title: "In D1", body: "d1", frontmatter: "", frontmatter_source: null, order: 1 }],
    glossary_terms: [],
    project_config: [{ project_id: 1, title: "D1 site", navigation_json: menu("From D1") }],
    project_landing: [],
    steps: [],
    layers: [],
  };
});

const captured = {
  pages: [{ slug: "captured", title: "Captured", body: "c", frontmatter: "", frontmatter_source: null, order: 1 }],
  config: { project_id: 1, title: "Captured site", navigation_json: menu("Captured") } as never,
  landing: null,
};

function build(extra: Record<string, unknown>) {
  return buildPublishFileSet({
    token: "tok", owner: "o", repo: "r", ref: "sha", projectId: 1, env: { DB: {} } as never,
    configYml: 'title: "x"\n',
    ...extra,
  });
}

describe("the rows a publish captured", () => {
  it("are the ones the file set writes from, pages and navigation both", async () => {
    const files = await build(captured);
    const paths = files.map((f) => f.path);
    expect(paths).toContain("telar-content/texts/pages/captured.md");
    expect(paths).not.toContain("telar-content/texts/pages/in-d1.md");
    const nav = files.find((f) => f.path === "_data/navigation.yml");
    expect(nav?.content).toContain("Captured");
    expect(tablesRead).not.toContain("project_pages");
    expect(tablesRead).not.toContain("project_landing");
  });

  it("are the ones the recorded hashes are made from", async () => {
    const hashes = await buildEntityHashes(getDb({} as never), 1, captured);
    expect(Object.keys(hashes.pages)).toEqual(["captured"]);
    expect(tablesRead).not.toContain("project_pages");
    expect(tablesRead).not.toContain("project_config");
    expect(tablesRead).not.toContain("project_landing");
  });

  it("a settings row captured as absent writes no navigation, whatever D1 holds", async () => {
    const files = await build({ ...captured, config: null });
    expect(files.some((f) => f.path === "_data/navigation.yml")).toBe(false);
    expect(tablesRead).not.toContain("project_config");
  });

  it("an empty list of pages is a site with no pages, not a reason to read them", async () => {
    const files = await build({ ...captured, pages: [] });
    expect(files.some((f) => f.path.startsWith("telar-content/texts/pages/"))).toBe(false);
    expect(tablesRead).not.toContain("project_pages");
  });

  it("are read from D1 when none was handed down", async () => {
    const files = await build({});
    expect(files.map((f) => f.path)).toContain("telar-content/texts/pages/in-d1.md");
    expect(files.find((f) => f.path === "_data/navigation.yml")?.content).toContain("From D1");
    const hashes = await buildEntityHashes(getDb({} as never), 1);
    expect(Object.keys(hashes.pages)).toEqual(["in-d1"]);
  });
});
