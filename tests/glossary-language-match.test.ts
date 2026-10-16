/**
 * The manifest's `csv_language_match` carried past the repository: to a tab
 * written as the site's glossary, and to the Compositor's own glossary.
 *
 * The document path runs against a real collaboration object over the
 * repository's migrations in memory: the forced snapshot, the read of the
 * glossary from D1 and the write through `/ingest-sync` are the ones the
 * upgrade makes. The definition in the document is what is asserted,
 * including where the author edits it between the read and the write.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import OP_JSON from "./fixtures/csv-language-match-op.json";
import type { CsvLanguageMatchOp } from "~/lib/manifest-schema.server";
import type { LanguageMatchRun } from "~/lib/manifest-runner.server";
import {
  applyLanguageMatchesToText,
  glossaryDefinitionMatches,
  glossaryMatchReportLines,
  glossaryMatchesSettled,
  matchGlossaryDefinitionsInDocument,
  type GlossaryMatchEnv,
} from "~/lib/glossary-language-match.server";
import { getDb } from "~/lib/db.server";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";
import { PROJECT_ID, SECRET, seedEmptyProject } from "./helpers/collaboration-fixture";
import type { ProjectCollaborationDO } from "../workers/collaboration";

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

const OP = OP_JSON as CsvLanguageMatchOp;
const RELEASED = OP.cases[1];
const run = (lang: "en" | "es", changed = true, op: CsvLanguageMatchOp = OP): LanguageMatchRun => ({ op, lang, changed });

describe("the matches the chain's runs call for in the document", () => {
  it("carries the term, and each released text with the text in the run's language", () => {
    expect(glossaryDefinitionMatches([run("es")])).toEqual([
      { file: OP.file, termId: "telar", cases: OP.cases.map((c) => ({ equals: c.equals, value: c.values.es })) },
    ]);
  });

  it("carries a run that did not change the file, since the document is matched on its own text", () => {
    expect(glossaryDefinitionMatches([run("en", false)])).toHaveLength(1);
  });

  it("carries nothing for a run on another sheet or another column", () => {
    expect(glossaryDefinitionMatches([run("en", true, { ...OP, file: "telar-content/spreadsheets/objects.csv" })])).toEqual([]);
    expect(glossaryDefinitionMatches([run("en", true, { ...OP, column: "title" })])).toEqual([]);
  });

  it("leaves out a case with no text in the run's language", () => {
    const op = { ...OP, cases: [{ equals: "a", values: { en: "b" } }] };
    expect(glossaryDefinitionMatches([run("es", true, op)])).toEqual([]);
  });
});

describe("a tab written as the glossary", () => {
  const tab = (definition: string) => `term_id,title,definition\r\ntelar,Telar,"${definition.replace(/"/g, '""').replace(/\n/g, "\r\n")}"\r\n`;

  it("takes the run's paragraph where it holds a released text", () => {
    expect(applyLanguageMatchesToText(OP.file, tab(RELEASED.equals), [run("es")])).toEqual({ text: tab(RELEASED.values.es!), changed: true });
  });

  it("is left alone at another path, or where the author edited it", () => {
    expect(applyLanguageMatchesToText(`${OP.file}.bak`, tab(RELEASED.equals), [run("es")]).changed).toBe(false);
    expect(applyLanguageMatchesToText(OP.file, tab("Our own words."), [run("es")])).toEqual({ text: tab("Our own words."), changed: false });
  });
});

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

function makeCtx() {
  return {
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
}

/** A document holding the `telar` term and one other, D1 holding the same rows. */
function blobWith(definition: string): Uint8Array {
  const doc = new Y.Doc();
  doc.transact(() => {
    for (const [id, termId, text] of [[1, "telar", definition], [2, "loom", "A frame for weaving."]] as const) {
      const term = new Y.Map<unknown>();
      term.set("_id", id);
      term.set("term_id", termId);
      term.set("order_key", `a0000${id}`);
      term.set("title", new Y.Text(termId));
      term.set("definition", new Y.Text(text));
      doc.getArray<unknown>("glossary").push([term]);
    }
  });
  return Y.encodeStateAsUpdate(doc);
}

let memory: MemoryD1;
let doInstance: ProjectCollaborationDO;
let env: GlossaryMatchEnv;

async function openProject(definition: string): Promise<void> {
  memory = createMemoryD1();
  seedEmptyProject(memory);
  const insert = memory.raw.prepare(
    "INSERT INTO glossary_terms (id, project_id, term_id, order_key, title, definition) VALUES (?, ?, ?, ?, ?, ?)",
  );
  insert.run(1, PROJECT_ID, "telar", "a00001", "telar", definition);
  insert.run(2, PROJECT_ID, "loom", "a00002", "loom", "A frame for weaving.");
  memory.raw.prepare("UPDATE projects SET yjs_state = ? WHERE id = ?").run(blobWith(definition), PROJECT_ID);
  const { ProjectCollaborationDO } = await import("../workers/collaboration");
  doInstance = new ProjectCollaborationDO(
    makeCtx() as unknown as DurableObjectState,
    { DB: asD1(memory), SESSION_SECRET: SECRET, COLLABORATION: {} as unknown } as unknown as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = PROJECT_ID;
  await (doInstance as unknown as { ensureDocLoaded: () => Promise<void> }).ensureDocLoaded();
  env = {
    SESSION_SECRET: SECRET,
    COLLABORATION: { idFromName: () => "id", get: () => ({ fetch: (request: Request) => doInstance.fetch(request) }) },
  };
}

function termIn(termId: string): Y.Map<unknown> {
  const glossary = (doInstance as unknown as { ydoc: Y.Doc }).ydoc.getArray<Y.Map<unknown>>("glossary");
  return glossary.toArray().find((m) => m.get("term_id") === termId) as Y.Map<unknown>;
}

const definitionIn = (termId: string) => String(termIn(termId).get("definition"));
const d1Definition = (termId: string) =>
  (memory.raw.prepare("SELECT definition FROM glossary_terms WHERE term_id = ?").get(termId) as { definition: string }).definition;

/** An edit an author makes in the open document, not yet snapshotted to D1. */
function editDefinition(termId: string, text: string): void {
  const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
  ydoc.transact(() => {
    const field = termIn(termId).get("definition") as Y.Text;
    field.delete(0, field.length);
    field.insert(0, text);
  }, null);
}

const match = (lang: "en" | "es") => glossaryDefinitionMatches([run(lang)]);

describe("the Compositor's glossary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    memory.close();
  });

  for (const lang of ["en", "es"] as const) {
    it(`takes the ${lang} paragraph where the definition holds the released text, in the document and in D1`, async () => {
      await openProject(RELEASED.equals);
      const results = await matchGlossaryDefinitionsInDocument(getDb(asD1(memory)), env, PROJECT_ID, match(lang));
      expect(results.map((r) => r.outcome)).toEqual(["applied"]);
      expect(glossaryMatchesSettled(results)).toBe(true);
      expect(definitionIn("telar")).toBe(RELEASED.values[lang]);
      expect(d1Definition("telar")).toBe(RELEASED.values[lang]);
      expect(definitionIn("loom")).toBe("A frame for weaving.");
      expect(glossaryMatchReportLines(results)).toEqual([
        { kind: "glossary_language_matched", sheet: "glossary.csv", term: "telar", file: OP.file },
      ]);
    });
  }

  it("matches a definition the document holds with CRLF line breaks", async () => {
    await openProject(RELEASED.equals.replace(/\n/g, "\r\n"));
    const results = await matchGlossaryDefinitionsInDocument(getDb(asD1(memory)), env, PROJECT_ID, match("en"));
    expect(results.map((r) => r.outcome)).toEqual(["applied"]);
    expect(definitionIn("telar")).toBe(RELEASED.values.en!.replace(/\n/g, "\r\n"));
  });

  it("leaves alone a definition the author edited, with no line for it", async () => {
    await openProject(`${RELEASED.equals} Edited.`);
    const results = await matchGlossaryDefinitionsInDocument(getDb(asD1(memory)), env, PROJECT_ID, match("en"));
    expect(results.map((r) => r.outcome)).toEqual(["kept"]);
    expect(definitionIn("telar")).toBe(`${RELEASED.equals} Edited.`);
    expect(glossaryMatchReportLines(results)).toEqual([]);
  });

  it("reads the open document, so an edit not yet in D1 is left alone", async () => {
    await openProject(RELEASED.equals);
    editDefinition("telar", "Our own words.");
    const results = await matchGlossaryDefinitionsInDocument(getDb(asD1(memory)), env, PROJECT_ID, match("en"));
    expect(results.map((r) => r.outcome)).toEqual(["kept"]);
    expect(definitionIn("telar")).toBe("Our own words.");
  });

  it("keeps an edit made after the read and before the write, and reports it as edited", async () => {
    await openProject(RELEASED.equals);
    const direct = env.COLLABORATION.get("id");
    const editsFirst: GlossaryMatchEnv = {
      ...env,
      COLLABORATION: {
        idFromName: () => "id",
        get: () => ({
          fetch: (request: Request) => {
            if (new URL(request.url).pathname === "/ingest-sync") editDefinition("telar", "Our own words.");
            return direct.fetch(request);
          },
        }),
      },
    };
    const results = await matchGlossaryDefinitionsInDocument(getDb(asD1(memory)), editsFirst, PROJECT_ID, match("en"));
    expect(results.map((r) => r.outcome)).toEqual(["edited"]);
    expect(definitionIn("telar")).toBe("Our own words.");
    expect(d1Definition("telar")).toBe("Our own words.");
    expect(glossaryMatchReportLines(results)).toEqual([
      { kind: "glossary_language_edited", sheet: "glossary.csv", term: "telar", file: OP.file },
    ]);
  });

  it("reports a write the document refuses with a 503 as unconfirmed", async () => {
    await openProject(RELEASED.equals);
    const direct = env.COLLABORATION.get("id");
    const refuses: GlossaryMatchEnv = {
      ...env,
      COLLABORATION: {
        idFromName: () => "id",
        get: () => ({
          fetch: async (request: Request) =>
            new URL(request.url).pathname === "/ingest-sync" ? new Response("snapshot_failed", { status: 503 }) : direct.fetch(request),
        }),
      },
    };
    const results = await matchGlossaryDefinitionsInDocument(getDb(asD1(memory)), refuses, PROJECT_ID, match("en"));
    expect(results.map((r) => r.outcome)).toEqual(["unconfirmed"]);
    expect(glossaryMatchesSettled(results)).toBe(false);
  });

  it("reports a document it cannot reach as unconfirmed, and writes nothing", async () => {
    await openProject(RELEASED.equals);
    const unreachable: GlossaryMatchEnv = { ...env, COLLABORATION: { idFromName: () => "id", get: () => ({ fetch: async () => { throw new Error("down"); } }) } };
    const results = await matchGlossaryDefinitionsInDocument(getDb(asD1(memory)), unreachable, PROJECT_ID, match("en"));
    expect(glossaryMatchReportLines(results)).toEqual([
      { kind: "glossary_language_unconfirmed", sheet: "glossary.csv", term: "telar", file: OP.file },
    ]);
    expect(definitionIn("telar")).toBe(RELEASED.equals);
  });
});
