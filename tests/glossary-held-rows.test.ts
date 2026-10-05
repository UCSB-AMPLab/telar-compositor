/**
 * glossary.csv rows that publish no term: a term_id that, stripped
 * as CPython strips, is blank or opens `#`. The framework's link map and page
 * generator skip such a row, so the import makes no term of it, the sync adds
 * none, and a publish writes it back into the file where it was.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as Y from "yjs";
import * as schema from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => "applied"),
  newFreezeOperationId: vi.fn(() => "lease-1"),
}));
vi.mock("~/lib/github.server", () => ({
  getFileContent: vi.fn(),
  getFileAtRef: vi.fn(),
  getRepoTree: vi.fn(),
  getRepoHead: vi.fn(),
  getSubtreeOids: vi.fn(async () => ({ ok: true, at: () => ({ kind: "absent" }) })),
  graphqlGitHub: vi.fn(),
  githubHeaders: vi.fn(() => ({})),
  decodeGitHubContent: vi.fn((s: string) => s),
}));

import * as githubServer from "~/lib/github.server";
import { strictReadsFromFileContent } from "./helpers/strict-sheet-read";
import { applyFullSyncChanges, computeGlossarySyncDiff, resolveFullSyncPayload } from "~/lib/sync.server";
import type { FullSyncChanges } from "~/lib/sync.server";
import { GLOSSARY_CANONICAL_SCOPE, mapGlossaryCsv, parseTelarCsv } from "~/lib/import.server";
import { serializeGlossaryCsv } from "~/lib/publish.server";
import { isHeldTermId } from "~/lib/csv-records";
import { CsvCommentExtractionError } from "~/lib/csv-export.server";
import { ProjectCollaborationDO } from "../workers/collaboration";
import { PROJECT_ID, SECRET, seedProject } from "./helpers/collaboration-fixture";

type Term = Parameters<typeof serializeGlossaryCsv>[0][number];

const GLOSSARY_PATH = "telar-content/spreadsheets/glossary.csv";

/** `#ghost` first, a term, a nameless row, a term. */
const MIXED =
  "note,term_id,title,definition\n,#ghost,Ghost,def\n,telar,Telar,A loom\n,,Nameless,def2\n,warp,Warp,Threads\n";

/** A held id written with leading spaces, an id that only contains `#`, and a column only the held row fills. */
const SPACED =
  "title,term_id,definition,note\nTelar,telar,A loom,\nGhost,  #x,def,my note\nHash,x#,def,\n";

function imported(file: string): Term[] {
  return mapGlossaryCsv(parseTelarCsv(file, undefined, false, GLOSSARY_CANONICAL_SCOPE)) as Term[];
}

/** The published file's lines after the header and the bilingual row. A term's line carries the appended related_terms column; a held row's does not. */
function dataLines(published: string): string[] {
  return published.split("\n").slice(2, -1);
}

function serveRepo(files: Record<string, string>) {
  vi.mocked(githubServer.getFileContent).mockImplementation(
    async (_t: string, _o: string, _r: string, path: string) => files[path] ?? null,
  );
  vi.mocked(githubServer.getFileAtRef).mockImplementation(
    strictReadsFromFileContent(githubServer.getFileContent, async () => ({ status: "absent" })),
  );
  vi.mocked(githubServer.getRepoHead).mockResolvedValue("head-sha" as never);
  vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false } as never);
}

/** A D1 stand-in whose reads all come back empty. */
function emptyDb() {
  const chain = (): unknown => {
    const node = Promise.resolve([]) as unknown as Promise<unknown[]> & Record<string, unknown>;
    for (const m of ["from", "where", "limit", "orderBy", "set", "values", "returning", "innerJoin", "leftJoin"]) {
      node[m] = () => chain();
    }
    return node;
  };
  return { select: () => chain(), batch: async () => [] } as unknown as Parameters<typeof computeGlossarySyncDiff>[4];
}

let opened: MemoryD1[] = [];
afterEach(() => {
  for (const memory of opened) memory.close();
  opened = [];
});

/** The repository's glossary.csv holding `t1` and, unchanged, the three held terms of `heldProject`. */
const HELD_REPO = "title,term_id,definition\nT,t1,\nGhost,#ghost,\nNameless,,\nSpaced,  #x,\n";

/** A project whose D1 holds `t1` and three terms already in D1 whose ids publish none. */
function heldProject(): MemoryD1 {
  const memory = createMemoryD1();
  opened.push(memory);
  seedProject(memory, "text");
  const term = memory.raw.prepare(
    "INSERT INTO glossary_terms (id, project_id, term_id, order_key, title, definition) VALUES (?, ?, ?, ?, ?, '')",
  );
  term.run(2, PROJECT_ID, "#ghost", "a00002", "Ghost");
  term.run(3, PROJECT_ID, "", "a00003", "Nameless");
  term.run(4, PROJECT_ID, "  #x", "a00004", "Spaced");
  return memory;
}

function noChanges(): FullSyncChanges {
  return {
    objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
    stories: { accept: [], reject: [], insertNew: [] },
    config: { accept: [], reject: [] },
    glossary: { accept: [], reject: [], insertNew: [] },
    projectId: PROJECT_ID,
    baseSha: null,
  };
}

describe("isHeldTermId", () => {
  it("holds a blank id and an id opening # once stripped, and nothing else", () => {
    expect(isHeldTermId("")).toBe(true);
    expect(isHeldTermId("  ")).toBe(true);
    expect(isHeldTermId("#ghost")).toBe(true);
    expect(isHeldTermId("  #x")).toBe(true);
    expect(isHeldTermId("x#")).toBe(false);
    expect(isHeldTermId("telar")).toBe(false);
  });
});

describe("import", () => {
  it("makes no term of #ghost or of a blank id", () => {
    expect(imported(MIXED).map((t) => t.term_id)).toEqual(["telar", "warp"]);
  });

  it("holds `  #x` aside and makes a term of `x#`", () => {
    expect(imported(SPACED).map((t) => t.term_id)).toEqual(["telar", "x#"]);
  });
});

describe("sync", () => {
  it("does not add a held row as a term in the diff", async () => {
    serveRepo({ [GLOSSARY_PATH]: MIXED });
    const diff = await computeGlossarySyncDiff(1, "t", "o", "r", emptyDb(), undefined, "head-sha");
    expect(diff.added.map((t) => t.term_id)).toEqual(["telar", "warp"]);
  });

  it("lists a D1 term whose id publishes none as removed only when a held row carries it unchanged, three-way too", async () => {
    const file = HELD_REPO.replace("Spaced,  #x,", "Spaced,  #x,other");
    serveRepo({ [GLOSSARY_PATH]: file });
    const db = drizzle(asD1(heldProject()), { schema });
    for (const base of [undefined, file]) {
      const diff = await computeGlossarySyncDiff(PROJECT_ID, "t", "o", "r", db, base, "head-sha");
      expect(diff.removed.map((t) => t.dbId).sort()).toEqual([2, 3]);
    }
  });

  it("asks the document to remove only the held terms glossary.csv carries unchanged", async () => {
    serveRepo({ [GLOSSARY_PATH]: HELD_REPO });
    const memory = heldProject();
    const db = drizzle(asD1(memory), { schema });
    const removal = async () =>
      (await resolveFullSyncPayload(PROJECT_ID, noChanges(), "t", "o", "r", db, 1, "head-sha")).payload.glossary.removeHeld;
    expect(await removal()).toEqual([
      { dbId: 2, title: "Ghost", definition: "", kind: "" },
      { dbId: 3, title: "Nameless", definition: "", kind: "" },
      { dbId: 4, title: "Spaced", definition: "", kind: "" },
    ]);
    memory.raw.exec("UPDATE glossary_terms SET definition = 'new' WHERE id = 2");
    memory.raw.exec("UPDATE glossary_terms SET extra_columns = '{\"note\":\"n\"}' WHERE id = 4");
    expect((await removal())?.map((r) => r.dbId)).toEqual([3]);
    serveRepo({});
    expect(await removal()).toBeUndefined();
    memory.raw.exec("DELETE FROM glossary_terms WHERE id > 1");
    expect(await removal()).toBeUndefined();
  });

  it("does not insert a held row when the accept names it", async () => {
    serveRepo({ [GLOSSARY_PATH]: SPACED.replace("  #x", "#x") });
    const changes: FullSyncChanges = {
      objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
      stories: { accept: [], reject: [], insertNew: [] },
      config: { accept: [], reject: [] },
      glossary: { accept: [], reject: [], insertNew: ["#x", "telar"] },
      projectId: 1,
      baseSha: null,
    };
    const { payload } = await resolveFullSyncPayload(1, changes, "t", "o", "r", emptyDb(), 7);
    expect(payload.glossary.insert.map((t: { termId: string }) => t.termId)).toEqual(["telar"]);
  });
});

describe("publish", () => {
  it("writes held rows back where they were, as written", () => {
    expect(dataLines(serializeGlossaryCsv(imported(MIXED), MIXED))).toEqual([
      ",#ghost,Ghost,def",
      ",telar,Telar,A loom,",
      ",,Nameless,def2",
      ",warp,Warp,Threads,",
    ]);
  });

  it("keeps a column only a held row fills, and the spaces before #", () => {
    expect(dataLines(serializeGlossaryCsv(imported(SPACED), SPACED))).toEqual([
      "Telar,telar,A loom,,",
      "Ghost,  #x,def,my note",
      "Hash,x#,def,,",
    ]);
  });

  it("puts a held row after the nearest term above it that D1 still holds", () => {
    const terms = imported(MIXED).filter((t) => t.term_id !== "telar");
    expect(dataLines(serializeGlossaryCsv(terms, MIXED))).toEqual([",#ghost,Ghost,def", ",,Nameless,def2", ",warp,Warp,Threads,"]);
  });

  it("reads back with the same terms and the same held rows", () => {
    const published = serializeGlossaryCsv(imported(MIXED), MIXED);
    expect(imported(published)).toEqual(imported(MIXED));
    expect(serializeGlossaryCsv(imported(published), published)).toBe(published);
  });

  // A file whose bytes are not valid UTF-8 is written in the plain layout,
  // where `term_id` is first: a row written as the file has it would put
  // `hello` under term_id and publish it as a term.
  it("writes a held row under its own columns in the plain layout", () => {
    const file = "note,term_id,title,definition\nhello,,Nameless,d\n";
    const published = serializeGlossaryCsv([], file, true);
    expect(published.split("\n")[0]).toBe("term_id,title,definition,related_terms,note");
    expect(dataLines(published)).toEqual([",Nameless,d,,hello"]);
    expect(imported(published)).toEqual([]);
  });

  it("refuses a held row Papa refused rather than publish without it", () => {
    const file = 'title,term_id,definition\nOrdinary,a,one\nGhost,,"d"x\n';
    expect(() => serializeGlossaryCsv(imported(file), file)).toThrow(CsvCommentExtractionError);
  });

  // `#1` in the file's first column would read as a comment, so the file's
  // layout is refused and the plain one written.
  it("keeps a held row's custom cell in the plain layout", () => {
    const file = "title,term_id,definition,note\nOrdinary,a,one,\nGhost,,two,secret\n";
    const terms = imported(file).map((t) => ({ ...t, title: "#1" }));
    const published = serializeGlossaryCsv(terms, file);
    expect(published.split("\n")[0]).toBe("term_id,title,definition,related_terms,note");
    expect(dataLines(published)).toEqual(["a,#1,one,,", ",Ghost,two,,secret"]);
  });
});

/** The DO over `memory`, its document loaded, with a full sync that applies no change. */
async function openHost(memory: MemoryD1) {
  memory.raw.prepare("UPDATE projects SET head_sha = ? WHERE id = ?").run("b".repeat(40), PROJECT_ID);
  const ctx = {
    getWebSockets: () => [] as unknown[],
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => {},
      get: async (key: string) => (key === "docGeneration" ? 0 : undefined),
      put: async () => {},
      list: async () => new Map(),
      delete: async () => 0,
    },
    acceptWebSocket: vi.fn(),
  };
  const host = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    { DB: asD1(memory), SESSION_SECRET: SECRET, COLLABORATION: {} as unknown } as unknown as Env,
  );
  (host as unknown as { projectId: number }).projectId = PROJECT_ID;
  await (host as unknown as { ensureDocLoaded: () => Promise<void> }).ensureDocLoaded();
  const glossary = (host as unknown as { ydoc: Y.Doc }).ydoc.getArray<Y.Map<unknown>>("glossary");
  const stub = { fetch: async (req: Request) => host.fetch(req) };
  const env = { SESSION_SECRET: SECRET, COLLABORATION: { idFromName: (n: string) => n, get: () => stub } } as unknown as Env;
  const db = drizzle(asD1(memory), { schema });
  return {
    glossary,
    docIds: () => glossary.toArray().map((m) => m.get("term_id")),
    sync: async () => {
      const changes = { ...noChanges(), baseSha: "b".repeat(40), headSha: "c".repeat(40) };
      await applyFullSyncChanges(PROJECT_ID, changes, "t", "o", "r", db, 1, env);
      await (host as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();
    },
    /** D1's terms as the publish reads them (`buildPublishFileSet`). */
    publishedTerms: () =>
      memory.raw
        .prepare(
          "SELECT term_id, title, definition, related_terms, kind, extra_columns FROM glossary_terms " +
            "WHERE project_id = ? ORDER BY order_key, id",
        )
        .all(PROJECT_ID) as Term[],
  };
}

describe("terms already in D1 whose ids publish none", () => {
  it("are removed by a sync from the document and D1 when glossary.csv holds them unchanged", async () => {
    const memory = heldProject();
    const host = await openHost(memory);
    expect(host.docIds()).toEqual(["t1", "#ghost", "", "  #x"]);

    serveRepo({ [GLOSSARY_PATH]: HELD_REPO });
    await host.sync();

    expect(host.docIds()).toEqual(["t1"]);
    expect(memory.raw.prepare("SELECT term_id FROM glossary_terms ORDER BY id").all()).toEqual([{ term_id: "t1" }]);
  });

  it("keeps one edited in the Compositor, and the publish writes the edit once, in its row's place", async () => {
    const memory = heldProject();
    memory.raw.exec("UPDATE glossary_terms SET definition = 'new' WHERE id = 2");
    const host = await openHost(memory);

    serveRepo({ [GLOSSARY_PATH]: HELD_REPO });
    await host.sync();

    expect(host.docIds()).toEqual(["t1", "#ghost"]);
    expect(memory.raw.prepare("SELECT term_id, definition FROM glossary_terms WHERE id > 1 ORDER BY id").all()).toEqual([
      { term_id: "#ghost", definition: "new" },
    ]);
    const lines = dataLines(serializeGlossaryCsv(host.publishedTerms(), HELD_REPO));
    expect(lines.slice(1)).toEqual(["Ghost,#ghost,new,", "Nameless,,", "Spaced,  #x,"]);
    expect(lines[0]).toMatch(/,t1,/);
  });

  it("keeps one edited in the document since D1 last held it", async () => {
    const memory = heldProject();
    const host = await openHost(memory);
    (host.glossary.get(1).get("definition") as Y.Text).insert(0, "typed");

    serveRepo({ [GLOSSARY_PATH]: HELD_REPO });
    await host.sync();

    expect(host.docIds()).toEqual(["t1", "#ghost"]);
  });
});

describe("a publish after Keep my version, with held terms still in D1", () => {
  const legacy: Term[] = [
    { term_id: "#ghost", title: "Ghost", definition: "new", related_terms: null },
    { term_id: "", title: "Nameless", definition: "edited", related_terms: null },
    { term_id: "#lost", title: "Lost", definition: "only in D1", related_terms: null },
  ];

  it("writes each once, and the next publish writes the same file", () => {
    const terms = [...imported(MIXED), ...legacy];
    const first = serializeGlossaryCsv(terms, MIXED);
    expect(dataLines(first)).toEqual([
      ",#ghost,Ghost,new,",
      ",telar,Telar,A loom,",
      ",,Nameless,edited,",
      ",warp,Warp,Threads,",
      ",#lost,Lost,only in D1,",
    ]);
    const second = serializeGlossaryCsv(terms, first);
    expect(second).toBe(first);
    expect(serializeGlossaryCsv(terms, second)).toBe(first);
  });

  // The plain layout opens with term_id, so a row whose id opens `#` reads
  // back as a comment row.
  it("writes each once in the plain layout too", () => {
    const terms = [...imported(MIXED), ...legacy];
    const first = serializeGlossaryCsv(terms, MIXED, true);
    const second = serializeGlossaryCsv(terms, first, true);
    expect(serializeGlossaryCsv(terms, second, true)).toBe(second);
    for (const published of [first, second]) {
      expect(published.split("\n").filter((l) => l.includes("Ghost"))).toHaveLength(1);
      expect(published.split("\n").filter((l) => l.includes("Nameless"))).toHaveLength(1);
      expect(published.split("\n").filter((l) => l.includes("Lost"))).toHaveLength(1);
    }
  });
});

describe("a blank-id term whose title was edited after the import", () => {
  const FILE = "title,term_id,definition\nTelar,telar,A loom\nNameless,,first\n";

  it("keeps the repository's blank-id row beside the edited term, since nothing shows they are one entry", () => {
    const file = "title,term_id,definition,note\nTelar,telar,A loom,\nNew repository entry,,repository-only,keep me\n";
    const terms = [
      ...imported(file).filter((t) => t.term_id === "telar"),
      { term_id: "", title: "Old edited entry", definition: "local-only", related_terms: null },
    ];
    const first = serializeGlossaryCsv(terms, file);
    expect(dataLines(first).filter((l) => /entry/.test(l))).toEqual(["New repository entry,,repository-only,keep me", "Old edited entry,,local-only,,"]);
    expect(serializeGlossaryCsv(terms, first)).toBe(first);
  });

  it("leaves two blank-id rows and two edited terms as they were", () => {
    const file = "title,term_id,definition\nOne,,a\nTwo,,b\n";
    const terms = [
      { term_id: "", title: "One edited", definition: "a", related_terms: null },
      { term_id: "", title: "Two edited", definition: "b", related_terms: null },
    ];
    const published = serializeGlossaryCsv(terms, file);
    expect(published.split("\n").filter((l) => /One|Two/.test(l))).toHaveLength(4);
  });
});
