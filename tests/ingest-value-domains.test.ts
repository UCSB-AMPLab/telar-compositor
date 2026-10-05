/**
 * The wire domain of every value `/ingest-sync` applies.
 *
 * `isIdentityValueInDomain` states the domain for the identity keys
 * at this boundary. Every other value the arms consume holds the same
 * standing — the endpoint is reachable by anything holding the internal
 * marker, and the transaction it mutates under is null-origin, which exempts
 * a write from every entry pass — so each field gets the domain its PRODUCER
 * emits, stated per key rather than as a coarse JSON-type rule.
 *
 * These tests run the real Durable Object against a real SQLite database built
 * from the migration chain, and the real snapshot: a value is accepted only if
 * it round-trips to its D1 column, and a refused one has to leave the document
 * exactly as it stood. The config round trip goes one step further and runs the
 * publish serialiser, because the question a refused `story_key` raises is what
 * `_config.yml` carries afterwards.
 *
 * A refusal names the arm, the position, the field path and the TYPE that stood
 * there. Every planted value here carries a sentinel string, and every refusal
 * assertion checks that the sentinel appears nowhere in the response — a report
 * that rendered the value would be the very operation this boundary exists to
 * prevent.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";

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

import { ProjectCollaborationDO } from "../workers/collaboration";
import { signInternalMarker } from "../workers/auth";
import { ORDER_KEY } from "~/lib/field-order";
import {
  buildConfigManagedBlocks,
  buildConfigManagedFields,
  healConfigYaml,
} from "~/lib/publish.server";
import { parseYaml } from "~/lib/yaml.server";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";
import { markLoaded } from "./helpers/claimed-document";
import { applyCustomBlob } from "~/lib/object-custom-map";
import { withDocumentSeen } from "./helpers/object-update-seen";

const PROJECT_ID = 42;
const TEST_SECRET = "sess-secret";
const ACTOR = 7;

/**
 * The string every planted value carries. A refusal that renders its value puts
 * this in the response, so one assertion catches the whole class.
 */
const SENTINEL = "tel113-planted-sentinel";
const plantedObject = () => ({ [SENTINEL]: SENTINEL });
const plantedArray = () => [SENTINEL];
/** A number no column of this payload takes, and not a small integer. */
const PLANTED_NUMBER = 424242.5;

/**
 * Every string a serialiser could turn a planted leaf value into: a string
 * plant renders as itself, a number as its exact decimal digits, and an
 * object or array both as `String()`'s "[object Object]" and as its JSON. A
 * boolean or `null` plant carries nothing distinguishing, so it renders as
 * nothing to assert against.
 */
function renderingsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "number") return [String(value)];
  if (value !== null && typeof value === "object") {
    return ["[object Object]", JSON.stringify(value)];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let memory: MemoryD1;
let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

/** Every argument logged to `console.error`/`console.warn` this test, flattened to text. */
function capturedLogText(): string {
  return [...errorSpy.mock.calls, ...warnSpy.mock.calls]
    .map((args) => args.map((a: unknown) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
    .join("\n");
}

function makeCtx() {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    getWebSockets: () => [] as unknown[],
    blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      const run = chain.then(() => fn());
      chain = run.catch(() => {});
      return run;
    },
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => {},
      // The loader and the snapshot read the generation from storage, and a
      // load lists the log prefix before it tags an untagged blob.
      get: async (key: string) => (key === "docGeneration" ? 0 : undefined),
      put: async () => {},
      list: async () => new Map(),
      delete: async () => 0,
    },
    acceptWebSocket: vi.fn(),
  };
}

function makeDo() {
  const doInstance = new ProjectCollaborationDO(
    makeCtx() as unknown as DurableObjectState,
    { DB: asD1(memory), SESSION_SECRET: TEST_SECRET, COLLABORATION: {} } as unknown as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = PROJECT_ID;
  markLoaded(doInstance);
  const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
  seedDocument(ydoc);
  return { doInstance, ydoc };
}

/**
 * A project holding one story, one object and one glossary term, in the
 * document and in D1 alike, each already carrying the row id and order key a
 * live project's entities carry — so a snapshot taken during a refused ingest
 * has nothing of its own to backfill and the document really is unchanged.
 */
function seedDocument(ydoc: Y.Doc): void {
  ydoc.transact(() => {
    const config = ydoc.getMap<unknown>("config");
    config.set("title", new Y.Text("Sitio"));
    config.set("lang", "en");
    config.set("story_key", "clave-real");
    config.set("featured_count", 4);

    const story = new Y.Map<unknown>();
    story.set("_id", 501);
    story.set("story_id", "apertura");
    story.set("title", new Y.Text("Apertura"));
    story.set("subtitle", new Y.Text("Subtítulo original"));
    story.set("byline", new Y.Text("Autora original"));
    story.set("private", false);
    story.set("draft", false);
    story.set("show_sections", false);
    story.set("steps", new Y.Array<Y.Map<unknown>>());
    story.set(ORDER_KEY, "a0");
    ydoc.getArray<Y.Map<unknown>>("stories").push([story]);

    const object = new Y.Map<unknown>();
    object.set("_id", 801);
    object.set("object_id", "campana");
    object.set("title", new Y.Text("Campana"));
    object.set("creator", new Y.Text("Anónimo"));
    object.set("description", new Y.Text(""));
    object.set("alt_text", new Y.Text("Una campana"));
    object.set("period", new Y.Text(""));
    object.set("year", new Y.Text(""));
    object.set("object_type", new Y.Text(""));
    object.set("subjects", new Y.Text(""));
    object.set("source", new Y.Text(""));
    object.set("credit", new Y.Text(""));
    object.set("source_url", "https://example.org/campana");
    object.set("thumbnail", "");
    object.set("dimensions", "");
    object.set("extra_columns", "");
    object.set("featured", false);
    object.set("image_available", true);
    object.set("created_by", ACTOR);
    object.set(ORDER_KEY, "a0");
    ydoc.getArray<Y.Map<unknown>>("objects").push([object]);
    // Its custom-field map, as the load leaves every object.
    applyCustomBlob(object, "");

    const term = new Y.Map<unknown>();
    term.set("_id", 901);
    term.set("term_id", "encomienda");
    term.set("title", new Y.Text("Encomienda"));
    term.set("definition", new Y.Text("Definición original"));
    term.set("created_by", null);
    term.set(ORDER_KEY, "a0");
    ydoc.getArray<Y.Map<unknown>>("glossary").push([term]);
  }, null);
}

function seedD1(): void {
  memory.raw
    .prepare(
      "INSERT INTO users (id, github_id, github_login, encrypted_access_token, " +
      "encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      "VALUES (?, ?, ?, 'e', 'e', '2099-01-01', '2099-01-01')",
    )
    .run(ACTOR, ACTOR, `u${ACTOR}`);
  // The revision a completed load claims, and the one `markLoaded` plants on
  // the instance: every write below is conditioned on it, so the row and the
  // instance have to agree about which revision this document was opened at.
  memory.raw.exec(
    "INSERT INTO projects (id, user_id, github_repo_full_name, installation_id, yjs_write) " +
    "VALUES (42, 7, 'o/a', 1, 1)",
  );
  memory.raw
    .prepare(
      "INSERT INTO project_config (project_id, title, lang, story_key, featured_count) " +
      "VALUES (?, ?, ?, ?, ?)",
    )
    .run(PROJECT_ID, "Sitio", "en", "clave-real", 4);
  memory.raw
    .prepare("INSERT INTO stories (id, project_id, story_id, title) VALUES (?, ?, ?, ?)")
    .run(501, PROJECT_ID, "apertura", "Apertura");
  memory.raw
    .prepare(
      "INSERT INTO objects (id, project_id, object_id, title, created_by) VALUES (?, ?, ?, ?, ?)",
    )
    .run(801, PROJECT_ID, "campana", "Campana", ACTOR);
  memory.raw
    .prepare("INSERT INTO glossary_terms (id, project_id, term_id, title) VALUES (?, ?, ?, ?)")
    .run(901, PROJECT_ID, "encomienda", "Encomienda");
}

interface IngestReport {
  applied: Record<string, number>;
  skipped: Record<string, string[]>;
  failed: Record<string, string[]>;
  refused: Record<string, number[]>;
  diagnostics: Array<{ arm: string; position: number | null; field: string; found: string }>;
}

async function postIngest(
  doInstance: ProjectCollaborationDO,
  body: unknown,
): Promise<{ status: number; report: IngestReport; raw: string }> {
  const { sigHex, timestamp } = await signInternalMarker(PROJECT_ID, TEST_SECRET, "ingest-sync");
  const res = await doInstance.fetch(
    new Request("https://internal/ingest-sync", {
      method: "POST",
      headers: {
        "X-Internal-Auth": sigHex,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Project": String(PROJECT_ID),
        "Content-Type": "application/json",
      },
      // Object updates carry the value a check read, the document's own: the
      // cases here are about the values written, not about edits since.
      body: JSON.stringify(withDocumentSeen((doInstance as unknown as { ydoc: Y.Doc }).ydoc, body)),
    }),
  );
  const raw = await res.text();
  return { status: res.status, report: JSON.parse(raw) as IngestReport, raw };
}

/** Every value the document holds, as plain JSON — a `Y.Text` as its string. */
function projection(ydoc: Y.Doc): string {
  return JSON.stringify({
    config: ydoc.getMap<unknown>("config").toJSON(),
    stories: ydoc.getArray<Y.Map<unknown>>("stories").toJSON(),
    objects: ydoc.getArray<Y.Map<unknown>>("objects").toJSON(),
    glossary: ydoc.getArray<Y.Map<unknown>>("glossary").toJSON(),
    pages: ydoc.getArray<Y.Map<unknown>>("pages").toJSON(),
  });
}

function configRow(): Record<string, unknown> {
  return memory.raw
    .prepare("SELECT * FROM project_config WHERE project_id = ?")
    .get(PROJECT_ID) as Record<string, unknown>;
}

function objectRow(objectId: string): Record<string, unknown> {
  return memory.raw
    .prepare("SELECT * FROM objects WHERE project_id = ? AND object_id = ?")
    .get(PROJECT_ID, objectId) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  memory = createMemoryD1();
  seedD1();
});

afterEach(() => {
  memory.close();
});

// ---------------------------------------------------------------------------
// The table, row by row
// ---------------------------------------------------------------------------

/**
 * One field of the domain table: a value its producers emit, and one they do
 * not. `assertAccepted` reads the document AFTER the accepted value's own
 * ingest and states what that value's own row or column holds — the
 * per-field state a counter alone cannot state.
 */
interface DomainCase {
  name: string;
  /** The key into `applied` and `refused` that the entry is counted under. */
  arm: string;
  /** The field path the diagnostic names. */
  field: string;
  /** `typeNameOf` the planted value. */
  found: string;
  /** The position the refusal is reported at, `null` for a top-level field. */
  position?: number | null;
  stated: unknown;
  planted: unknown;
  /** A top-level field refuses itself, not the payload around it. */
  refusesEntry?: false;
  /**
   * Every rendering of the planted leaf value itself (not the payload it
   * sits in) — what a refusal must keep out of the response body and out of
   * every line the boundary logs, not just the shared `SENTINEL` string.
   */
  plantedRenderings: string[];
  assertAccepted: (env: { ydoc: Y.Doc }) => void;
}

const storyUpdate = (extra: Record<string, unknown>) => ({
  stories: { update: [{ storyId: "apertura", ...extra }] },
});
const storyInsert = (extra: Record<string, unknown>) => ({
  stories: { insert: [{ storyId: "nueva", title: "Nueva", ...extra }] },
});
const objectUpdate = (fields: Record<string, unknown>) => ({
  objects: { update: [{ objectId: "campana", fields }] },
});
const objectInsert = (extra: Record<string, unknown>) => ({
  objects: { insert: [{ object_id: "nuevo", ...extra }] },
});
const glossaryUpdate = (extra: Record<string, unknown>) => ({
  glossary: { update: [{ termId: "encomienda", ...extra }] },
});
const glossaryInsert = (extra: Record<string, unknown>) => ({
  glossary: { insert: [{ termId: "mita", title: "Mita", definition: "d", ...extra }] },
});
const pageInsert = (extra: Record<string, unknown>) => ({
  pages: { insert: [{ slug: "acerca", title: "Acerca", body: "b", created_by: ACTOR, ...extra }] },
});
const configEntry = (key: string, value: unknown) => ({ config: [{ key, value }] });

// ---------------------------------------------------------------------------
// State readers — one entity's Y.Map, by its human key
// ---------------------------------------------------------------------------

function storyByKey(ydoc: Y.Doc, storyId: string): Y.Map<unknown> {
  return ydoc.getArray<Y.Map<unknown>>("stories").toArray()
    .find((m) => m.get("story_id") === storyId)!;
}
function objectByKey(ydoc: Y.Doc, objectId: string): Y.Map<unknown> {
  return ydoc.getArray<Y.Map<unknown>>("objects").toArray()
    .find((m) => m.get("object_id") === objectId)!;
}
function glossaryByKey(ydoc: Y.Doc, termId: string): Y.Map<unknown> {
  return ydoc.getArray<Y.Map<unknown>>("glossary").toArray()
    .find((m) => m.get("term_id") === termId)!;
}
function pageBySlug(ydoc: Y.Doc, slug: string): Y.Map<unknown> {
  return ydoc.getArray<Y.Map<unknown>>("pages").toArray()
    .find((m) => m.get("slug") === slug)!;
}
/** The first step of the "nueva" story insert every step-field case builds. */
function firstStep(ydoc: Y.Doc): Y.Map<unknown> {
  const steps = storyByKey(ydoc, "nueva").get("steps") as Y.Array<Y.Map<unknown>>;
  return steps.get(0);
}
/** A layer of that first step, by its position in the step's own layers array. */
function layerAt(ydoc: Y.Doc, layerIndex: number): Y.Map<unknown> {
  const layers = firstStep(ydoc).get("layers") as Y.Array<Y.Map<unknown>>;
  return layers.get(layerIndex);
}

// ---------------------------------------------------------------------------
// Case factories — one per field shape, so the table below states only what
// differs between fields: the key, the accepted value, and the plant.
// ---------------------------------------------------------------------------

function configTextCase(key: string, accepted: string, planted: unknown, found: string): DomainCase {
  return {
    name: `config.${key}, a Y.Text key`,
    arm: "config", field: "value", found,
    stated: configEntry(key, accepted),
    planted: configEntry(key, planted),
    plantedRenderings: renderingsOf(planted),
    assertAccepted: ({ ydoc }) => {
      expect(String(ydoc.getMap<unknown>("config").get(key))).toBe(accepted);
    },
  };
}
function configStringCase(key: string, accepted: string, planted: unknown, found: string): DomainCase {
  return {
    name: `config.${key}, a plain string key`,
    arm: "config", field: "value", found,
    stated: configEntry(key, accepted),
    planted: configEntry(key, planted),
    plantedRenderings: renderingsOf(planted),
    assertAccepted: ({ ydoc }) => {
      expect(ydoc.getMap<unknown>("config").get(key)).toBe(accepted);
    },
  };
}
function configFlagCase(key: string): DomainCase {
  return {
    name: `config.${key}, a flag key`,
    arm: "config", field: "value", found: "string",
    stated: configEntry(key, true),
    planted: configEntry(key, SENTINEL),
    plantedRenderings: renderingsOf(SENTINEL),
    assertAccepted: ({ ydoc }) => {
      expect(ydoc.getMap<unknown>("config").get(key)).toBe(true);
    },
  };
}

function storyUpdateTextCase(
  field: "title" | "byline", accepted: string, planted: unknown, found: string,
): DomainCase {
  return {
    name: `stories.update ${field}`,
    arm: "storyUpdate", field, found,
    stated: storyUpdate({ [field]: accepted }),
    planted: storyUpdate({ [field]: planted }),
    plantedRenderings: renderingsOf(planted),
    assertAccepted: ({ ydoc }) => {
      expect(String(storyByKey(ydoc, "apertura").get(field))).toBe(accepted);
    },
  };
}
function storyUpdateBoolCase(
  field: "isPrivate" | "showSections", column: "private" | "show_sections",
  accepted: boolean, planted: unknown, found: string,
): DomainCase {
  return {
    name: `stories.update ${field}`,
    arm: "storyUpdate", field, found,
    stated: storyUpdate({ [field]: accepted }),
    planted: storyUpdate({ [field]: planted }),
    plantedRenderings: renderingsOf(planted),
    assertAccepted: ({ ydoc }) => {
      expect(storyByKey(ydoc, "apertura").get(column)).toBe(accepted);
    },
  };
}

function storyInsertScalarTextCase(
  field: "title" | "subtitle" | "byline", accepted: string, planted: unknown, found: string,
): DomainCase {
  return {
    name: `stories.insert ${field}`,
    arm: "storyInsert", field, found,
    stated: storyInsert({ [field]: accepted }),
    planted: storyInsert({ [field]: planted }),
    plantedRenderings: renderingsOf(planted),
    assertAccepted: ({ ydoc }) => {
      expect(String(storyByKey(ydoc, "nueva").get(field))).toBe(accepted);
    },
  };
}
function storyInsertScalarBoolCase(
  field: "isPrivate" | "showSections", column: "private" | "show_sections",
  accepted: boolean, planted: unknown, found: string,
): DomainCase {
  return {
    name: `stories.insert ${field}`,
    arm: "storyInsert", field, found,
    stated: storyInsert({ [field]: accepted }),
    planted: storyInsert({ [field]: planted }),
    plantedRenderings: renderingsOf(planted),
    assertAccepted: ({ ydoc }) => {
      expect(storyByKey(ydoc, "nueva").get(column)).toBe(accepted);
    },
  };
}

function storyInsertStepTextCase(
  field: string, accepted: string, planted: unknown, found: string, isYText: boolean,
): DomainCase {
  return {
    name: `stories.insert a step's ${field}`,
    arm: "storyInsert", field: `steps[0].${field}`, found,
    stated: storyInsert({ steps: [{ [field]: accepted }], layers: [] }),
    planted: storyInsert({ steps: [{ [field]: planted }], layers: [] }),
    plantedRenderings: renderingsOf(planted),
    assertAccepted: ({ ydoc }) => {
      const value = firstStep(ydoc).get(field);
      expect(isYText ? String(value) : value).toBe(accepted);
    },
  };
}
function storyInsertStepCoordinateCase(
  field: "x" | "y" | "zoom", accepted: number | null, planted: unknown, found: string,
): DomainCase {
  return {
    name: `stories.insert a step's ${field === "x" ? "coordinate" : field}`,
    arm: "storyInsert", field: `steps[0].${field}`, found,
    stated: storyInsert({ steps: [{ [field]: accepted }], layers: [] }),
    planted: storyInsert({ steps: [{ [field]: planted }], layers: [] }),
    plantedRenderings: renderingsOf(planted),
    assertAccepted: ({ ydoc }) => {
      expect(firstStep(ydoc).get(field)).toBe(accepted);
    },
  };
}
function storyInsertLayerTextCase(
  field: "title" | "content", accepted: string, planted: unknown, found: string,
): DomainCase {
  return {
    name: `stories.insert a layer's ${field}`,
    arm: "storyInsert", field: `layers[0].${field}`, found,
    stated: storyInsert({
      steps: [{ step_number: 1 }],
      layers: [{ step_index: 0, layer_number: 1, [field]: accepted }],
    }),
    planted: storyInsert({
      steps: [{ step_number: 1 }],
      layers: [{ step_index: 0, layer_number: 1, [field]: planted }],
    }),
    plantedRenderings: renderingsOf(planted),
    assertAccepted: ({ ydoc }) => {
      expect(String(layerAt(ydoc, 0).get(field))).toBe(accepted);
    },
  };
}

function objectUpdateFieldCase(
  field: string, accepted: string, planted: unknown, found: string, isYText: boolean,
): DomainCase {
  return {
    name: `objects.update ${field}`,
    arm: "objectUpdate", field: `fields.${field}`, found,
    stated: objectUpdate({ [field]: accepted }),
    planted: objectUpdate({ [field]: planted }),
    plantedRenderings: renderingsOf(planted),
    assertAccepted: ({ ydoc }) => {
      const value = objectByKey(ydoc, "campana").get(field);
      expect(isYText ? String(value) : value).toBe(accepted);
    },
  };
}
function objectInsertFieldCase(
  field: string, accepted: string, planted: unknown, found: string, isYText: boolean,
): DomainCase {
  return {
    name: `objects.insert ${field}`,
    arm: "objectInsert", field, found,
    stated: objectInsert({ [field]: accepted }),
    planted: objectInsert({ [field]: planted }),
    plantedRenderings: renderingsOf(planted),
    assertAccepted: ({ ydoc }) => {
      const value = objectByKey(ydoc, "nuevo").get(field);
      expect(isYText ? String(value) : value).toBe(accepted);
    },
  };
}

const CASES: DomainCase[] = [
  // --- config, Y.Text keys -------------------------------------------------
  configTextCase("title", "Sitio nuevo", plantedArray(), "plain-array"),
  configTextCase("description", "Descripción nueva", plantedArray(), "plain-array"),
  configTextCase("author", "Autora nueva", PLANTED_NUMBER, "number"),
  configTextCase("email", "correo@nuevo.test", plantedObject(), "plain-object"),

  // --- config, plain string keys -------------------------------------------
  configStringCase("lang", "es", true, "boolean"),
  configStringCase("baseurl", "/nueva", PLANTED_NUMBER, "number"),
  configStringCase("url", "https://nuevo.test", plantedObject(), "plain-object"),
  configStringCase("theme", "trama-nueva", plantedArray(), "plain-array"),
  configStringCase("logo", "/logo-nuevo.png", null, "null"),

  // --- config, flag keys ----------------------------------------------------
  configFlagCase("collection_mode"),
  configFlagCase("skip_stories"),
  configFlagCase("include_demo_content"),
  configFlagCase("show_on_homepage"),
  configFlagCase("show_story_steps"),
  configFlagCase("show_object_credits"),
  configFlagCase("browse_and_search"),
  configFlagCase("show_link_on_homepage"),
  configFlagCase("show_sample_on_homepage"),

  // --- config, the count key -------------------------------------------------
  {
    name: "config.featured_count, the count key",
    arm: "config", field: "value", found: "string",
    stated: configEntry("featured_count", 3),
    planted: configEntry("featured_count", "3"),
    plantedRenderings: renderingsOf("3"),
    assertAccepted: ({ ydoc }) => {
      expect(ydoc.getMap<unknown>("config").get("featured_count")).toBe(3);
      expect(configRow().featured_count).toBe(3);
    },
  },
  {
    name: "config.featured_count past the safe integers",
    arm: "config", field: "value", found: "number",
    stated: configEntry("featured_count", -3),
    planted: configEntry("featured_count", 9007199254740992),
    plantedRenderings: renderingsOf(9007199254740992),
    assertAccepted: ({ ydoc }) => {
      expect(ydoc.getMap<unknown>("config").get("featured_count")).toBe(-3);
    },
  },
  {
    name: "config.featured_count as a fraction",
    arm: "config", field: "value", found: "number",
    stated: configEntry("featured_count", 12),
    planted: configEntry("featured_count", 1.5),
    plantedRenderings: renderingsOf(1.5),
    assertAccepted: ({ ydoc }) => {
      expect(ydoc.getMap<unknown>("config").get("featured_count")).toBe(12);
    },
  },

  // --- stories.update -------------------------------------------------------
  storyUpdateTextCase("title", "Apertura nueva", plantedArray(), "plain-array"),
  {
    name: "stories.update subtitle, where null is not a clear",
    arm: "storyUpdate", field: "subtitle", found: "null",
    stated: storyUpdate({ subtitle: "" }),
    planted: storyUpdate({ subtitle: null }),
    plantedRenderings: renderingsOf(null),
    assertAccepted: ({ ydoc }) => {
      expect(String(storyByKey(ydoc, "apertura").get("subtitle"))).toBe("");
    },
  },
  storyUpdateTextCase("byline", "Autora nueva", plantedObject(), "plain-object"),
  storyUpdateBoolCase("isPrivate", "private", true, SENTINEL, "string"),
  storyUpdateBoolCase("showSections", "show_sections", true, PLANTED_NUMBER, "number"),

  // --- stories.insert, its own scalars ---------------------------------------
  storyInsertScalarTextCase("title", "Forjada", plantedArray(), "plain-array"),
  storyInsertScalarTextCase("subtitle", "Sub", plantedArray(), "plain-array"),
  storyInsertScalarTextCase("byline", "Autora", plantedObject(), "plain-object"),
  storyInsertScalarBoolCase("isPrivate", "private", true, SENTINEL, "string"),
  storyInsertScalarBoolCase("showSections", "show_sections", true, PLANTED_NUMBER, "number"),

  // --- stories.insert, the steps and layers containers -----------------------
  {
    name: "stories.insert steps, the container",
    arm: "storyInsert", field: "steps", found: "plain-object",
    stated: storyInsert({ steps: [], layers: [] }),
    planted: storyInsert({ steps: plantedObject(), layers: [] }),
    plantedRenderings: renderingsOf(plantedObject()),
    assertAccepted: ({ ydoc }) => {
      const steps = storyByKey(ydoc, "nueva").get("steps") as Y.Array<unknown>;
      expect(steps.length).toBe(0);
    },
  },
  {
    name: "stories.insert layers, an element of the container",
    arm: "storyInsert", field: "layers[0]", found: "null",
    stated: storyInsert({ steps: [{ step_number: 1 }], layers: [] }),
    planted: storyInsert({ steps: [{ step_number: 1 }], layers: [null] }),
    plantedRenderings: renderingsOf(null),
    assertAccepted: ({ ydoc }) => {
      const steps = storyByKey(ydoc, "nueva").get("steps") as Y.Array<Y.Map<unknown>>;
      expect(steps.length).toBe(1);
      expect((steps.get(0).get("layers") as Y.Array<unknown>).length).toBe(0);
    },
  },

  // --- stories.insert, a step's fields -----------------------------------------
  storyInsertStepTextCase("question", "¿Qué?", plantedArray(), "plain-array", true),
  storyInsertStepTextCase("kind", "quote", plantedObject(), "plain-object", false),
  storyInsertStepTextCase("object_id", "campana", PLANTED_NUMBER, "number", false),
  storyInsertStepTextCase("page", "trama", plantedArray(), "plain-array", false),
  storyInsertStepTextCase("answer", "Respuesta", null, "null", true),
  storyInsertStepTextCase("alt_text", "Alt del paso", true, "boolean", true),
  storyInsertStepTextCase("clip_start", "00:01", plantedObject(), "plain-object", false),
  storyInsertStepTextCase("clip_end", "00:02", PLANTED_NUMBER, "number", false),
  storyInsertStepTextCase("loop", "true", plantedArray(), "plain-array", false),
  storyInsertStepCoordinateCase("x", 1.5, SENTINEL, "string"),
  storyInsertStepCoordinateCase("y", null, SENTINEL, "string"),
  storyInsertStepCoordinateCase("zoom", 2, plantedArray(), "plain-array"),
  {
    name: "stories.insert a step's position",
    arm: "storyInsert", field: "steps[0].step_number", found: "number",
    stated: storyInsert({ steps: [{ step_number: 2 }], layers: [] }),
    planted: storyInsert({ steps: [{ step_number: 1.5 }], layers: [] }),
    plantedRenderings: renderingsOf(1.5),
    assertAccepted: ({ ydoc }) => {
      expect(firstStep(ydoc).get("step_number")).toBe(2);
    },
  },

  // --- stories.insert, a layer's fields ----------------------------------------
  {
    name: "stories.insert a layer's label, nested and named by path",
    arm: "storyInsert", field: "layers[1].button_label", found: "plain-array",
    stated: storyInsert({
      steps: [{ step_number: 1 }],
      layers: [
        { step_index: 0, layer_number: 1, title: "Uno" },
        { step_index: 0, layer_number: 2, button_label: "Ver" },
      ],
    }),
    planted: storyInsert({
      steps: [{ step_number: 1 }],
      layers: [
        { step_index: 0, layer_number: 1, title: "Uno" },
        { step_index: 0, layer_number: 2, button_label: plantedArray() },
      ],
    }),
    plantedRenderings: renderingsOf(plantedArray()),
    assertAccepted: ({ ydoc }) => {
      expect(String(layerAt(ydoc, 1).get("button_label"))).toBe("Ver");
    },
  },
  {
    name: "stories.insert a layer's own index",
    arm: "storyInsert", field: "layers[0].step_index", found: "string",
    stated: storyInsert({
      steps: [{ step_number: 1 }],
      layers: [{ step_index: 0, layer_number: 1 }],
    }),
    planted: storyInsert({
      steps: [{ step_number: 1 }],
      layers: [{ step_index: SENTINEL, layer_number: 1 }],
    }),
    plantedRenderings: renderingsOf(SENTINEL),
    assertAccepted: ({ ydoc }) => {
      expect(layerAt(ydoc, 0).get("layer_number")).toBe(1);
    },
  },
  {
    name: "stories.insert a layer's own number",
    arm: "storyInsert", field: "layers[0].layer_number", found: "string",
    stated: storyInsert({
      steps: [{ step_number: 1 }],
      layers: [{ step_index: 0, layer_number: 3 }],
    }),
    planted: storyInsert({
      steps: [{ step_number: 1 }],
      layers: [{ step_index: 0, layer_number: SENTINEL }],
    }),
    plantedRenderings: renderingsOf(SENTINEL),
    assertAccepted: ({ ydoc }) => {
      expect(layerAt(ydoc, 0).get("layer_number")).toBe(3);
    },
  },
  storyInsertLayerTextCase("title", "Título capa", plantedArray(), "plain-array"),
  storyInsertLayerTextCase("content", "Cuerpo capa", plantedObject(), "plain-object"),

  // --- objects.update ---------------------------------------------------------
  objectUpdateFieldCase("title", "Campana nueva", plantedArray(), "plain-array", true),
  objectUpdateFieldCase("creator", "Creadora nueva", plantedArray(), "plain-array", true),
  objectUpdateFieldCase("description", "Descripción nueva", plantedObject(), "plain-object", true),
  objectUpdateFieldCase("alt_text", "Alt nueva", plantedArray(), "plain-array", true),
  objectUpdateFieldCase("period", "Colonia", PLANTED_NUMBER, "number", true),
  objectUpdateFieldCase("year", "1600", plantedObject(), "plain-object", true),
  objectUpdateFieldCase("object_type", "escultura", plantedArray(), "plain-array", true),
  objectUpdateFieldCase("subjects", "fe, arte", PLANTED_NUMBER, "number", true),
  objectUpdateFieldCase("source", "Archivo X", plantedObject(), "plain-object", true),
  objectUpdateFieldCase("credit", "Crédito X", plantedArray(), "plain-array", true),
  objectUpdateFieldCase("source_url", "https://example.org/nueva", plantedArray(), "plain-array", false),
  objectUpdateFieldCase("thumbnail", "https://example.org/thumb.jpg", plantedObject(), "plain-object", false),
  objectUpdateFieldCase("dimensions", "10x10", PLANTED_NUMBER, "number", false),
  objectUpdateFieldCase("extra_columns", "col=val", plantedArray(), "plain-array", false),
  {
    name: "objects.update featured",
    arm: "objectUpdate", field: "fields.featured", found: "string",
    stated: objectUpdate({ featured: true }),
    planted: objectUpdate({ featured: SENTINEL }),
    plantedRenderings: renderingsOf(SENTINEL),
    assertAccepted: ({ ydoc }) => {
      expect(objectByKey(ydoc, "campana").get("featured")).toBe(true);
    },
  },
  {
    name: "objects.update the fields map itself",
    arm: "objectUpdate", field: "fields", found: "plain-array",
    stated: objectUpdate({ creator: "Anónima" }),
    planted: { objects: { update: [{ objectId: "campana", fields: plantedArray() }] } },
    plantedRenderings: renderingsOf(plantedArray()),
    assertAccepted: ({ ydoc }) => {
      expect(String(objectByKey(ydoc, "campana").get("creator"))).toBe("Anónima");
    },
  },

  // --- objects.insert -----------------------------------------------------------
  objectInsertFieldCase("title", "Nuevo", plantedObject(), "plain-object", true),
  objectInsertFieldCase("creator", "Creador nuevo", plantedArray(), "plain-array", true),
  objectInsertFieldCase("description", "Descripción", PLANTED_NUMBER, "number", true),
  objectInsertFieldCase("alt_text", "Alt", plantedObject(), "plain-object", true),
  objectInsertFieldCase("period", "Independencia", plantedArray(), "plain-array", true),
  objectInsertFieldCase("year", "1810", plantedObject(), "plain-object", true),
  objectInsertFieldCase("object_type", "pintura", PLANTED_NUMBER, "number", true),
  objectInsertFieldCase("subjects", "historia", plantedArray(), "plain-array", true),
  objectInsertFieldCase("source", "Archivo Y", plantedObject(), "plain-object", true),
  objectInsertFieldCase("credit", "Crédito Y", PLANTED_NUMBER, "number", true),
  objectInsertFieldCase("source_url", "https://example.org/n", plantedArray(), "plain-array", false),
  objectInsertFieldCase("thumbnail", "https://example.org/t.jpg", plantedObject(), "plain-object", false),
  objectInsertFieldCase("dimensions", "5x5", PLANTED_NUMBER, "number", false),
  objectInsertFieldCase("extra_columns", "k=v", plantedArray(), "plain-array", false),
  {
    name: "objects.insert featured",
    arm: "objectInsert", field: "featured", found: "string",
    stated: objectInsert({ title: "Nuevo", featured: true }),
    planted: objectInsert({ title: "Nuevo", featured: SENTINEL }),
    plantedRenderings: renderingsOf(SENTINEL),
    assertAccepted: ({ ydoc }) => {
      expect(objectByKey(ydoc, "nuevo").get("featured")).toBe(true);
    },
  },
  {
    name: "objects.insert created_by",
    arm: "objectInsert", field: "created_by", found: "string",
    stated: objectInsert({ title: "Nuevo", created_by: ACTOR }),
    planted: objectInsert({ title: "Nuevo", created_by: "7" }),
    plantedRenderings: renderingsOf("7"),
    assertAccepted: ({ ydoc }) => {
      expect(objectByKey(ydoc, "nuevo").get("created_by")).toBe(ACTOR);
    },
  },
  {
    name: "objects.insert image_available",
    arm: "objectInsert", field: "image_available", found: "string",
    stated: objectInsert({ title: "Nuevo", image_available: true }),
    planted: objectInsert({ title: "Nuevo", image_available: SENTINEL }),
    plantedRenderings: renderingsOf(SENTINEL),
    assertAccepted: ({ ydoc }) => {
      expect(objectByKey(ydoc, "nuevo").get("image_available")).toBe(true);
    },
  },

  // --- glossary -------------------------------------------------------------------
  {
    name: "glossary.update title",
    arm: "glossaryUpdate", field: "title", found: "plain-object",
    stated: glossaryUpdate({ title: "Encomienda nueva" }),
    planted: glossaryUpdate({ title: plantedObject() }),
    plantedRenderings: renderingsOf(plantedObject()),
    assertAccepted: ({ ydoc }) => {
      expect(String(glossaryByKey(ydoc, "encomienda").get("title"))).toBe("Encomienda nueva");
    },
  },
  {
    name: "glossary.update definition",
    arm: "glossaryUpdate", field: "definition", found: "plain-array",
    stated: glossaryUpdate({ definition: "Definición nueva" }),
    planted: glossaryUpdate({ definition: plantedArray() }),
    plantedRenderings: renderingsOf(plantedArray()),
    assertAccepted: ({ ydoc }) => {
      expect(String(glossaryByKey(ydoc, "encomienda").get("definition"))).toBe("Definición nueva");
    },
  },
  {
    name: "glossary.insert title, which the arm requires",
    arm: "glossaryInsert", field: "title", found: "plain-array",
    stated: glossaryInsert({}),
    planted: glossaryInsert({ title: plantedArray() }),
    plantedRenderings: renderingsOf(plantedArray()),
    assertAccepted: ({ ydoc }) => {
      expect(String(glossaryByKey(ydoc, "mita").get("title"))).toBe("Mita");
    },
  },
  {
    name: "glossary.insert definition, which the arm requires",
    arm: "glossaryInsert", field: "definition", found: "plain-object",
    stated: glossaryInsert({}),
    planted: glossaryInsert({ definition: plantedObject() }),
    plantedRenderings: renderingsOf(plantedObject()),
    assertAccepted: ({ ydoc }) => {
      expect(String(glossaryByKey(ydoc, "mita").get("definition"))).toBe("d");
    },
  },

  // --- pages ----------------------------------------------------------------------
  {
    name: "pages.insert title",
    arm: "pageInsert", field: "title", found: "plain-array",
    stated: pageInsert({}),
    planted: pageInsert({ title: plantedArray() }),
    plantedRenderings: renderingsOf(plantedArray()),
    assertAccepted: ({ ydoc }) => {
      expect(String(pageBySlug(ydoc, "acerca").get("title"))).toBe("Acerca");
    },
  },
  {
    name: "pages.insert body",
    arm: "pageInsert", field: "body", found: "plain-object",
    stated: pageInsert({}),
    planted: pageInsert({ body: plantedObject() }),
    plantedRenderings: renderingsOf(plantedObject()),
    assertAccepted: ({ ydoc }) => {
      expect(String(pageBySlug(ydoc, "acerca").get("body"))).toBe("b");
    },
  },
  {
    name: "pages.insert created_by",
    arm: "pageInsert", field: "created_by", found: "string",
    stated: pageInsert({}),
    planted: pageInsert({ created_by: "7" }),
    plantedRenderings: renderingsOf("7"),
    assertAccepted: ({ ydoc }) => {
      expect(pageBySlug(ydoc, "acerca").get("created_by")).toBe(ACTOR);
    },
  },
];

describe("every row of the domain table, accepted and refused", () => {
  for (const testCase of CASES) {
    it(`${testCase.name}: applies the value its producers emit`, async () => {
      const { doInstance, ydoc } = makeDo();

      const { status, report } = await postIngest(doInstance, testCase.stated);

      expect(status).toBe(200);
      expect(report.applied[testCase.arm], testCase.name).toBe(1);
      expect(report.refused[testCase.arm] ?? [], testCase.name).toEqual([]);
      expect(report.diagnostics).toEqual([]);
      testCase.assertAccepted({ ydoc });
    });

    it(`${testCase.name}: refuses the value they do not, whole and by position`, async () => {
      const { doInstance, ydoc } = makeDo();
      const before = projection(ydoc);

      const { status, report, raw } = await postIngest(doInstance, testCase.planted);

      expect(status).toBe(200);
      expect(report.applied[testCase.arm], testCase.name).toBe(0);
      expect(report.refused[testCase.arm], testCase.name).toEqual([0]);
      expect(report.diagnostics, testCase.name).toEqual([
        { arm: testCase.arm, position: 0, field: testCase.field, found: testCase.found },
      ]);
      expect(projection(ydoc), testCase.name).toBe(before);
      expect(raw, testCase.name).not.toContain(SENTINEL);
      const logs = capturedLogText();
      for (const rendering of testCase.plantedRenderings) {
        expect(raw, `${testCase.name}: "${rendering}" in the response body`).not.toContain(rendering);
        expect(logs, `${testCase.name}: "${rendering}" in a logged line`).not.toContain(rendering);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Absence, and the writes it skips
// ---------------------------------------------------------------------------

describe("an absent optional field takes the default the document already applies", () => {
  it("leaves a story's existing subtitle where the update omits it", async () => {
    const { doInstance, ydoc } = makeDo();
    const subtitle = ydoc.getArray<Y.Map<unknown>>("stories").get(0).get("subtitle") as Y.Text;
    const replace = vi.spyOn(
      doInstance as unknown as { replaceYText: (...a: unknown[]) => void }, "replaceYText",
    );

    const { report } = await postIngest(doInstance, storyUpdate({ title: "Apertura nueva" }));

    expect(report.applied.storyUpdate).toBe(1);
    // The omitted fields reach no write at all: the only replacement made is
    // the one the payload states.
    expect(replace.mock.calls.map((call) => call[1])).toEqual(["title"]);
    // The same Y.Text, never replaced and never emptied: an absent field is a
    // field the caller says nothing about.
    expect(ydoc.getArray<Y.Map<unknown>>("stories").get(0).get("subtitle")).toBe(subtitle);
    expect(subtitle.toString()).toBe("Subtítulo original");
    expect(String(ydoc.getArray<Y.Map<unknown>>("stories").get(0).get("title"))).toBe("Apertura nueva");
  });

  it("stores false for a story insert that states neither flag", async () => {
    const { doInstance, ydoc } = makeDo();

    const { report } = await postIngest(doInstance, {
      stories: { insert: [{ storyId: "nueva", title: "Nueva", steps: [], layers: [] }] },
    });

    expect(report.applied.storyInsert).toBe(1);
    const story = ydoc.getArray<Y.Map<unknown>>("stories").toArray()
      .find((m) => m.get("story_id") === "nueva")!;
    expect(story.get("private")).toBe(false);
    expect(story.get("show_sections")).toBe(false);
  });

  it("applies an object insert that omits alt_text, and the column takes its default", async () => {
    const { doInstance, ydoc } = makeDo();

    const { report } = await postIngest(doInstance, {
      objects: { insert: [{ object_id: "sin-alt", title: "Sin alt", image_available: true }] },
    });

    expect(report.applied.objectInsert).toBe(1);
    const object = ydoc.getArray<Y.Map<unknown>>("objects").toArray()
      .find((m) => m.get("object_id") === "sin-alt")!;
    expect(String(object.get("alt_text"))).toBe("");
    expect(objectRow("sin-alt").alt_text).toBe("");
  });

  it("clears an object's alt_text on the null its producer emits", async () => {
    const { doInstance, ydoc } = makeDo();

    const { report } = await postIngest(doInstance, objectUpdate({ alt_text: null }));

    expect(report.applied.objectUpdate).toBe(1);
    const object = ydoc.getArray<Y.Map<unknown>>("objects").get(0);
    expect(String(object.get("alt_text"))).toBe("");
    expect(objectRow("campana").alt_text).toBe("");
  });

  it("applies a title stated beside a featured flag", async () => {
    const { doInstance } = makeDo();

    const { report } = await postIngest(
      doInstance, objectUpdate({ title: "Campana nueva", featured: true }),
    );

    expect(report.applied.objectUpdate).toBe(1);
    expect(objectRow("campana").title).toBe("Campana nueva");
    expect(objectRow("campana").featured).toBe(1);
  });

  it("keeps an unknown key on an object update ignored, and applies its sibling", async () => {
    const { doInstance, ydoc } = makeDo();

    const { report } = await postIngest(doInstance, {
      objects: { update: [{ objectId: "campana", fields: { _id: 999999, title: "Kept" } }] },
    });

    expect(report.applied.objectUpdate).toBe(1);
    expect(report.refused.objectUpdate).toEqual([]);
    const object = ydoc.getArray<Y.Map<unknown>>("objects").get(0);
    expect(object.get("_id")).toBe(801);
    expect(String(object.get("title"))).toBe("Kept");
  });

  it("applies an object update naming the D1 row it means", async () => {
    const { doInstance, ydoc } = makeDo();

    const { report } = await postIngest(doInstance, {
      objects: { update: [{ objectId: "campana", docId: 801, fields: { title: "Campana nueva" } }] },
    });

    expect(report.applied.objectUpdate).toBe(1);
    expect(report.refused.objectUpdate).toEqual([]);
    expect(String(objectByKey(ydoc, "campana").get("title"))).toBe("Campana nueva");
  });

  it("still accepts an objects.remove entry", async () => {
    const { doInstance, ydoc } = makeDo();

    const { report } = await postIngest(doInstance, { objects: { remove: ["campana"] } });

    expect(report.applied.objectRemove).toBe(1);
    expect(ydoc.getArray<Y.Map<unknown>>("objects").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Shape before identity
// ---------------------------------------------------------------------------

describe("the structural check runs before anything reads the entry", () => {
  it("refuses a null entry on stories.update by position, without throwing", async () => {
    const { doInstance, ydoc } = makeDo();
    const before = projection(ydoc);

    const { status, report } = await postIngest(doInstance, { stories: { update: [null] } });

    expect(status).toBe(200);
    expect(report.refused.storyUpdate).toEqual([0]);
    expect(report.diagnostics).toEqual([
      { arm: "storyUpdate", position: 0, field: "entry", found: "null" },
    ]);
    expect(projection(ydoc)).toBe(before);
  });

  it("leaves the story of the same key untouched when the insert's steps are not an array", async () => {
    const { doInstance, ydoc } = makeDo();
    const before = projection(ydoc);

    const { report } = await postIngest(doInstance, {
      stories: {
        insert: [{
          storyId: "apertura", title: "Forjada", subtitle: "", byline: "",
          isPrivate: false, showSections: false, steps: plantedObject(), layers: [],
        }],
      },
    });

    expect(report.refused.storyInsert).toEqual([0]);
    expect(report.applied.storyInsert).toBe(0);
    expect(projection(ydoc)).toBe(before);
  });

  it("leaves the story of the same key untouched when a layer is null", async () => {
    const { doInstance, ydoc } = makeDo();
    const before = projection(ydoc);

    const { report } = await postIngest(doInstance, {
      stories: {
        insert: [{
          storyId: "apertura", title: "Forjada", subtitle: "", byline: "",
          isPrivate: false, showSections: false, steps: [], layers: [null],
        }],
      },
    });

    expect(report.refused.storyInsert).toEqual([0]);
    expect(projection(ydoc)).toBe(before);
  });

  it("reports the container diagnostic, not silence, when identity is ALSO out of domain", async () => {
    const { doInstance, ydoc } = makeDo();
    const before = projection(ydoc);

    const { report } = await postIngest(doInstance, {
      stories: {
        insert: [{ storyId: "", title: "Sin id", steps: plantedObject(), layers: [] }],
      },
    });

    expect(report.refused.storyInsert).toEqual([0]);
    expect(report.diagnostics).toEqual([
      { arm: "storyInsert", position: 0, field: "steps", found: "plain-object" },
    ]);
    expect(projection(ydoc)).toBe(before);
  });

  it.each([
    ["a fraction", 801.5, "number"],
    ["zero", 0, "number"],
    ["a string", "801", "string"],
    ["null", null, "null"],
  ])("refuses an object update whose docId is %s", async (_name, docId, found) => {
    const { doInstance, ydoc } = makeDo();
    const before = projection(ydoc);

    const { report } = await postIngest(doInstance, {
      objects: { update: [{ objectId: "campana", docId, fields: { title: "Campana nueva" } }] },
    });

    expect(report.applied.objectUpdate).toBe(0);
    expect(report.refused.objectUpdate).toEqual([0]);
    expect(report.diagnostics).toEqual([
      { arm: "objectUpdate", position: 0, field: "docId", found },
    ]);
    expect(projection(ydoc)).toBe(before);
  });

  it("reports the fields container diagnostic when objects.update's identity is ALSO out of domain", async () => {
    const { doInstance, ydoc } = makeDo();
    const before = projection(ydoc);

    const { report } = await postIngest(doInstance, {
      objects: { update: [{ objectId: "", fields: plantedArray() }] },
    });

    expect(report.refused.objectUpdate).toEqual([0]);
    expect(report.diagnostics).toEqual([
      { arm: "objectUpdate", position: 0, field: "fields", found: "plain-array" },
    ]);
    expect(projection(ydoc)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

describe("a refusal names the position the entry arrived at", () => {
  it("carries original positions through both partitions", async () => {
    const { doInstance, ydoc } = makeDo();

    const { report, raw } = await postIngest(doInstance, {
      objects: {
        insert: [
          // 0: an identity value out of domain.
          { object_id: plantedArray(), title: "Uno" },
          // 1: a legal identity, a value out of domain.
          { object_id: "dos", title: plantedObject() },
          // 2: both in domain.
          { object_id: "tres", title: "Tres", image_available: true },
        ],
      },
    });

    expect(report.refused.objectInsert).toEqual([0, 1]);
    expect(report.applied.objectInsert).toBe(1);
    expect(report.diagnostics).toEqual([
      { arm: "objectInsert", position: 1, field: "title", found: "plain-object" },
    ]);
    expect(raw).not.toContain(SENTINEL);
    const keys = ydoc.getArray<Y.Map<unknown>>("objects").toArray().map((m) => m.get("object_id"));
    expect(keys).toEqual(["campana", "tres"]);
  });

  it("refuses only the advisory field for a telarVersion out of domain", async () => {
    const { doInstance, ydoc } = makeDo();

    const { report, raw } = await postIngest(doInstance, {
      telarVersion: plantedArray(),
      config: [{ key: "lang", value: "es" }],
    });

    expect(report.diagnostics).toEqual([
      { arm: "top", position: null, field: "telarVersion", found: "plain-array" },
    ]);
    expect(report.refused.config).toEqual([]);
    expect(report.applied.config).toBe(1);
    expect(ydoc.getMap<unknown>("config").get("telar_version")).toBeUndefined();
    expect(ydoc.getMap<unknown>("config").get("lang")).toBe("es");
    expect(raw).not.toContain(SENTINEL);
  });

  it("applies a telarVersion string to the document's advisory copy", async () => {
    const { doInstance, ydoc } = makeDo();

    const { report } = await postIngest(doInstance, {
      telarVersion: "v1.6.2",
      config: [{ key: "lang", value: "es" }],
    });

    expect(report.diagnostics).toEqual([]);
    expect(report.applied.config).toBe(1);
    expect(ydoc.getMap<unknown>("config").get("telar_version")).toBe("v1.6.2");
    expect(ydoc.getMap<unknown>("config").get("lang")).toBe("es");
  });
});

// ---------------------------------------------------------------------------
// The config arm's own key rule
// ---------------------------------------------------------------------------

describe("a config entry must be a plain object before its key is read", () => {
  it("refuses a bare string entry by position, instead of reading it as the key", async () => {
    const { doInstance, ydoc } = makeDo();
    const before = projection(ydoc);

    const { report } = await postIngest(doInstance, { config: ["navigation"] });

    expect(report.skipped.config).toEqual([]);
    expect(report.refused.config).toEqual([0]);
    expect(report.diagnostics).toEqual([
      { arm: "config", position: 0, field: "entry", found: "string" },
    ]);
    expect(ydoc.getMap<unknown>("config").get("navigation")).toBeUndefined();
    expect(projection(ydoc)).toBe(before);
  });

  it("refuses an array entry by position, the same way", async () => {
    const { doInstance, ydoc } = makeDo();
    const before = projection(ydoc);

    const { report } = await postIngest(doInstance, { config: [["lang", "es"]] });

    expect(report.refused.config).toEqual([0]);
    expect(report.diagnostics).toEqual([
      { arm: "config", position: 0, field: "entry", found: "plain-array" },
    ]);
    expect(projection(ydoc)).toBe(before);
  });
});

describe("an unlisted config key is named back only when naming it is safe", () => {
  it("names a plain identifier in skipped.config", async () => {
    const { doInstance, ydoc } = makeDo();

    const { report } = await postIngest(doInstance, {
      config: [{ key: "navigation", value: "clobber" }, { key: "theme", value: "trama" }],
    });

    expect(report.skipped.config).toEqual(["navigation"]);
    expect(report.refused.config).toEqual([]);
    expect(report.applied.config).toBe(1);
    expect(ydoc.getMap<unknown>("config").get("navigation")).toBeUndefined();
    expect(ydoc.getMap<unknown>("config").get("theme")).toBe("trama");
  });

  it("counts a key that is not a plain identifier by position instead", async () => {
    const { doInstance } = makeDo();

    const { report, raw } = await postIngest(doInstance, {
      config: [{ key: `<img src=x onerror="${SENTINEL}">`, value: "x" }],
    });

    expect(report.skipped.config).toEqual([]);
    expect(report.refused.config).toEqual([0]);
    expect(report.diagnostics).toEqual([
      { arm: "config", position: 0, field: "key", found: "string" },
    ]);
    expect(raw).not.toContain(SENTINEL);
  });

  it("counts a key that is not a string by position", async () => {
    const { doInstance } = makeDo();

    const { report, raw } = await postIngest(doInstance, {
      config: [{ key: plantedArray(), value: "x" }],
    });

    expect(report.refused.config).toEqual([0]);
    expect(report.diagnostics).toEqual([
      { arm: "config", position: 0, field: "key", found: "plain-array" },
    ]);
    expect(raw).not.toContain(SENTINEL);
  });
});

// ---------------------------------------------------------------------------
// Step and layer indexes take the plain integer domain
// ---------------------------------------------------------------------------

describe("a step or layer position is an integer, not restricted to the safe range", () => {
  it("accepts a step_number past the safe integers", async () => {
    const { doInstance, ydoc } = makeDo();

    const { report } = await postIngest(doInstance, storyInsert({
      steps: [{ step_number: 9007199254740992 }], layers: [],
    }));

    expect(report.applied.storyInsert).toBe(1);
    expect(report.refused.storyInsert ?? []).toEqual([]);
    expect(report.diagnostics).toEqual([]);
    expect(firstStep(ydoc).get("step_number")).toBe(9007199254740992);
  });

  it("accepts a layer's layer_number past the safe integers", async () => {
    const { doInstance, ydoc } = makeDo();

    const { report } = await postIngest(doInstance, storyInsert({
      steps: [{ step_number: 1 }],
      layers: [{ step_index: 0, layer_number: 9007199254740992 }],
    }));

    expect(report.applied.storyInsert).toBe(1);
    expect(report.refused.storyInsert ?? []).toEqual([]);
    expect(report.diagnostics).toEqual([]);
    expect(layerAt(ydoc, 0).get("layer_number")).toBe(9007199254740992);
  });

  it("accepts a layer's step_index past the safe integers", async () => {
    const { doInstance, ydoc } = makeDo();

    const { report } = await postIngest(doInstance, storyInsert({
      steps: [{ step_number: 1 }],
      layers: [{ step_index: 9007199254740992, layer_number: 1 }],
    }));

    expect(report.applied.storyInsert).toBe(1);
    expect(report.refused.storyInsert ?? []).toEqual([]);
    expect(report.diagnostics).toEqual([]);
    // No step sits at this position, so the write drops the layer rather than
    // attaching it — the domain check has already accepted the value itself.
    expect((firstStep(ydoc).get("layers") as Y.Array<unknown>).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The config round trip, through the snapshot and the publish serialiser
// ---------------------------------------------------------------------------

describe("a refused config value reaches neither the column nor _config.yml", () => {
  it("keeps D1's story_key and publishes it", async () => {
    const { doInstance, ydoc } = makeDo();

    const { report, raw } = await postIngest(doInstance, {
      config: [{ key: "story_key", value: { [SENTINEL]: SENTINEL } }],
    });

    expect(report.refused.config).toEqual([0]);
    expect(report.applied.config).toBe(0);
    expect(raw).not.toContain(SENTINEL);
    expect(ydoc.getMap<unknown>("config").get("story_key")).toBe("clave-real");
    expect(configRow().story_key).toBe("clave-real");

    const row = configRow() as unknown as Parameters<typeof buildConfigManagedFields>[0];
    const yaml = healConfigYaml(
      ["title: \"Sitio\"", "story_key: \"clave-vieja\"", ""].join("\n"),
      buildConfigManagedFields(row),
      buildConfigManagedBlocks(row),
    );
    expect((parseYaml(yaml) as Record<string, unknown>).story_key).toBe("clave-real");
    expect(yaml).not.toContain(SENTINEL);
  });

  it("binds an accepted featured_count to its column", async () => {
    const { doInstance } = makeDo();

    const { report } = await postIngest(doInstance, { config: [{ key: "featured_count", value: 3 }] });

    expect(report.applied.config).toBe(1);
    expect(configRow().featured_count).toBe(3);
  });

  it("binds an accepted story_key to its column", async () => {
    const { doInstance, ydoc } = makeDo();

    const { report } = await postIngest(
      doInstance, { config: [{ key: "story_key", value: "clave-nueva" }] },
    );

    expect(report.applied.config).toBe(1);
    expect(ydoc.getMap<unknown>("config").get("story_key")).toBe("clave-nueva");
    expect(configRow().story_key).toBe("clave-nueva");
  });
});

// ---------------------------------------------------------------------------
// The write's own precondition
// ---------------------------------------------------------------------------

describe("replaceYText checks before it deletes", () => {
  it("leaves the old text intact when it is called with a value that is not a string", () => {
    const { doInstance, ydoc } = makeDo();
    const story = ydoc.getArray<Y.Map<unknown>>("stories").get(0);
    const replace = (doInstance as unknown as {
      replaceYText: (map: Y.Map<unknown>, key: string, value: unknown) => void;
    }).replaceYText.bind(doInstance);

    expect(() => replace(story, "subtitle", null)).toThrow(TypeError);

    // Replacing in place is a delete followed by an insert; the precondition is
    // what keeps a throw from leaving the key holding an emptied Y.Text.
    expect(String(story.get("subtitle"))).toBe("Subtítulo original");
  });
});
