/**
 * The publish repairs a glossary.csv whose bytes are not valid UTF-8 even when
 * D1 holds no terms.
 *
 * The framework stops the build on such a file, and the publish writes
 * glossary.csv only from D1's terms, so a project with none kept the broken
 * file. With no terms and a lossy read, the publish writes the header, the
 * bilingual row and GitHub's comment rows, which the framework builds with no
 * glossary pages. A clean file with no terms is left alone, and a failed read
 * there refuses nothing.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FileAtRef } from "~/lib/github.server";

const GLOSSARY = "telar-content/spreadsheets/glossary.csv";
const TERM = { term_id: "loom", title: "Loom", definition: "A frame", related_terms: null, extra_columns: null };

const state = vi.hoisted(() => ({
  terms: [] as unknown[],
  glossary: { status: "absent" } as FileAtRef,
}));

const { atRef } = vi.hoisted(() => ({
  atRef: vi.fn(async (_t: string, _o: string, _r: string, path: string): Promise<FileAtRef> => {
    if (path === "telar-content/spreadsheets/glossary.csv") return state.glossary;
    return { status: "absent" };
  }),
}));

vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getFileAtRef: atRef };
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
      chain.where = () => Object.assign(Promise.resolve(table === "glossary_terms" ? state.terms : []), chain);
      chain.orderBy = function (this: unknown) {
        return this;
      };
      chain.limit = () => Promise.resolve([]);
      return chain;
    },
  })),
}));

import { buildPublishFileSet } from "~/lib/publish.server";

const EXISTING = "# Glossary notes\nterm_id,title,definition,related_terms\nold,Old�,Gone,\n";

async function glossaryWritten(): Promise<string | undefined> {
  const files = await buildPublishFileSet({
    token: "tok",
    owner: "owner",
    repo: "repo",
    ref: "sha",
    projectId: 1,
    env: { DB: {} } as never,
    configYml: null,
  });
  return files.find((f) => f.path === GLOSSARY)?.content;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.terms = [];
  state.glossary = { status: "absent" };
});

describe("glossary.csv at a publish", () => {
  it("with no terms and a lossy file, writes the header, the bilingual row and the comment rows", async () => {
    state.glossary = { status: "ok", content: EXISTING, lossy: true };

    const written = await glossaryWritten();

    expect(written).toBeDefined();
    const lines = written!.split(/\r?\n/).filter((l) => l !== "");
    // The importer reads `# Glossary notes` as the header, so every record
    // below it is a row that publishes no term, held under that one column.
    expect(lines[0]).toBe("term_id,title,definition,related_terms,# Glossary notes");
    expect(lines[1]).toBe("id_término,titulo,definición,términos_relacionados,");
    expect(lines.slice(2)).toEqual(["# Glossary notes", ",,,,term_id", ",,,,old"]);
    expect(written).not.toContain("old,");
    expect(written).not.toContain("�");
  });

  it("with no terms and a clean file, writes nothing, as before", async () => {
    state.glossary = { status: "ok", content: EXISTING };

    expect(await glossaryWritten()).toBeUndefined();
  });

  it("with no terms and a failed read, writes nothing and refuses nothing", async () => {
    state.glossary = { status: "error" };

    expect(await glossaryWritten()).toBeUndefined();
  });

  it("with terms and a lossy file, writes the terms, as before", async () => {
    state.terms = [TERM];
    state.glossary = { status: "ok", content: EXISTING, lossy: true };

    const written = await glossaryWritten();

    expect(written).toContain("loom,Loom,A frame");
    expect(written).toContain("# Glossary notes");
  });
});
