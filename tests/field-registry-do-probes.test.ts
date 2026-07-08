/**
 * Field-registry coverage — Durable Object residence obligations.
 *
 * This file derives the collaboration DO's mechanical obligations from the
 * field registry's Y.Doc residence declarations (app/lib/field-registry.ts)
 * and probes them functionally, so a field added to the registry without
 * being wired into the DO fails here by name (entity.field). Families:
 *
 *   A. COLD BUILD  — buildFromD1Rows must carry every ydoc-declared field's
 *      D1 sentinel onto the Y.Doc under its declared key; coldLoad-excluded
 *      fields (objects.origin, objects.missing_from_repo) must NOT carry it.
 *   B. INSERT BINDS — snapshotToD1's fresh-insert path must bind every
 *      ydoc-declared field's Y value into its D1 column; insert-excluded
 *      fields bind their default; preserveFromD1 fields (objects.origin,
 *      glossary.related_terms) bind the surviving D1 row's value on the
 *      stale-_id re-INSERT path.
 *   C. UPDATE BINDS — the snapshot UPDATE SET list must include every
 *      ydoc-declared field without an update exclusion, and must NOT name
 *      update-excluded (stories.story_id, objects.origin,
 *      objects.missing_from_repo) or writeback-excluded
 *      (config.telar_version) columns.
 *   D. RESTORE — POST /restore-orphans must carry every steps/layers field
 *      the dashboard payload sends onto the restored Y.Maps.
 *   E. FACTORY KEY-SETS — the client Y.Map factories (makeObjectYMap,
 *      buildStepYMap) must set exactly the declared ydoc keys plus the
 *      enumerated infrastructure keys, in both directions.
 *
 * Harness mirrors snapshot-preserve-d1-columns.test.ts: the DO is exercised
 * directly with a stubbed ctx/env (vi.mock of "cloudflare:workers") and a
 * hand-rolled DB that records every prepare/bind and routes SELECTs by SQL
 * substring. Bind checks are positional: the recorded SQL's column list is
 * parsed and each column's bound argument compared against a per-field
 * sentinel, so a swapped pair of columns also fails.
 *
 * @version v1.4.1-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
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
import {
  FIELD_REGISTRY,
  getEntity,
  type EntityDecl,
  type FieldDecl,
  type YdocDecl,
} from "~/lib/field-registry";
import { makeObjectYMap } from "~/lib/object-ymap";
import { __test__ as structuralOpsTest } from "~/hooks/use-structural-ops";

const TEST_PROJECT_ID = 42;
const TEST_SECRET = "test-session-secret";

type EntityName = EntityDecl["entity"];

// ---------------------------------------------------------------------------
// Registry-derived plumbing
// ---------------------------------------------------------------------------

/** Fields with a real Y.Doc residence declaration (ydoc-excluded ones skipped). */
function declared(entityName: EntityName): Array<{ f: FieldDecl; y: YdocDecl }> {
  return getEntity(entityName).fields.flatMap((f) =>
    "excluded" in f.ydoc ? [] : [{ f, y: f.ydoc }],
  );
}

/** D1 table behind each registry entity (snapshot + cold-build targets). */
const TABLES: Record<EntityName, string> = {
  stories: "stories",
  steps: "steps",
  layers: "layers",
  objects: "objects",
  pages: "project_pages",
  glossary: "glossary_terms",
  config: "project_config",
  landing: "project_landing",
};

function textSentinel(entity: EntityName, fieldName: string): string {
  return `S_${entity}_${fieldName}`;
}

// Unique numeric sentinel per int/real field, assigned in registry order so
// values are deterministic and never collide across fields.
const NUMERIC_SENTINELS = new Map<string, number>();
{
  let next = 7001;
  for (const e of FIELD_REGISTRY) {
    for (const f of e.fields) {
      if (f.d1.type === "int") NUMERIC_SENTINELS.set(`${e.entity}.${f.name}`, next++);
      if (f.d1.type === "real") NUMERIC_SENTINELS.set(`${e.entity}.${f.name}`, next++ + 0.5);
    }
  }
}

/**
 * Positional columns: the snapshot deliberately binds the Y.Array index (not
 * the stored Y key) for these, as stated at their registry declaration sites
 * ("Authoritative value at snapshot time is the Y.Array index" /
 * "normalizes to array index + 1"). All docs under test hold ONE entity at
 * index 0, so the expected bound values are fixed.
 */
const POSITIONAL_BIND: Record<string, number> = {
  "stories.order": 0,
  "steps.step_number": 1,
  "layers.layer_number": 1,
  "pages.order": 0,
};

/** Defaults bound by insert-excluded columns (per the declaration's reason). */
const INSERT_EXCLUDED_DEFAULTS: Record<string, unknown> = {
  "objects.missing_from_repo": 0,
};

/** The Y value planted for a field before driving the DO. */
function makeYValue(entity: EntityName, f: FieldDecl, y: YdocDecl): unknown {
  const id = `${entity}.${f.name}`;
  if (id === "config.navigation_json") {
    // Y key "navigation" holds a Y.Array of plain nav items.
    const arr = new Y.Array<unknown>();
    arr.push([{ type: "page", slug: textSentinel(entity, f.name), label: "Nav", visible: true }]);
    return arr;
  }
  if (y.kind === "ytext") return new Y.Text(textSentinel(entity, f.name));
  switch (f.d1.type) {
    case "bool":
      return true;
    case "int":
    case "real":
      return NUMERIC_SENTINELS.get(id)!;
    default:
      return textSentinel(entity, f.name);
  }
}

/** The D1 column value planted for a field before a cold build. */
function d1Value(entity: EntityName, f: FieldDecl): unknown {
  const id = `${entity}.${f.name}`;
  if (id === "config.navigation_json") {
    return JSON.stringify([
      { type: "page", slug: textSentinel(entity, f.name), label: "Nav", visible: true },
    ]);
  }
  switch (f.d1.type) {
    case "bool":
      return 1;
    case "int":
    case "real":
      return NUMERIC_SENTINELS.get(id)!;
    default:
      return textSentinel(entity, f.name);
  }
}

/** Expected bound argument for a field in the snapshot INSERT/UPDATE. */
function expectedBind(
  entity: EntityName,
  f: FieldDecl,
): { mode: "eq"; value: unknown } | { mode: "contains"; value: string } {
  const id = `${entity}.${f.name}`;
  if (id === "config.navigation_json") {
    return { mode: "contains", value: textSentinel(entity, f.name) };
  }
  if (id in POSITIONAL_BIND) return { mode: "eq", value: POSITIONAL_BIND[id] };
  if (f.d1.type === "bool") return { mode: "eq", value: 1 }; // Y true -> 1
  if (f.d1.type === "int" || f.d1.type === "real") {
    return { mode: "eq", value: NUMERIC_SENTINELS.get(id)! };
  }
  return { mode: "eq", value: textSentinel(entity, f.name) };
}

// ---------------------------------------------------------------------------
// DO harness (mirrors snapshot-preserve-d1-columns.test.ts)
// ---------------------------------------------------------------------------

interface BindCall {
  sql: string;
  args: unknown[];
}

function makeFakeDB(rowProvider: (sql: string) => unknown[]) {
  const binds: BindCall[] = [];
  const stmt = (sql: string) => ({
    bind(...args: unknown[]) {
      binds.push({ sql, args });
      return {
        async run() {
          return { meta: { last_row_id: 100 } };
        },
        async all<T>() {
          return { results: rowProvider(sql) as T[] };
        },
        async first<T>() {
          return (rowProvider(sql)[0] ?? null) as T | null;
        },
      };
    },
  });
  const DB = {
    prepare: (sql: string) => stmt(sql),
    async batch() {
      return [];
    },
  };
  return { DB, binds };
}

function makeCtx() {
  return {
    getWebSockets: () => [] as unknown[],
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
    storage: { getAlarm: async () => null, setAlarm: async () => {} },
    acceptWebSocket: vi.fn(),
  };
}

function makeDO(rowProvider: (sql: string) => unknown[]) {
  const { DB, binds } = makeFakeDB(rowProvider);
  const env = { DB, SESSION_SECRET: TEST_SECRET, COLLABORATION: {} } as unknown;
  const doInstance = new ProjectCollaborationDO(
    makeCtx() as unknown as DurableObjectState,
    env as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = TEST_PROJECT_ID;
  (doInstance as unknown as { docLoaded: boolean }).docLoaded = true;
  return { doInstance, binds };
}

function ydocOf(doInstance: unknown): Y.Doc {
  return (doInstance as { ydoc: Y.Doc }).ydoc;
}

function snapshot(doInstance: unknown): Promise<void> {
  return (doInstance as { snapshotToD1: () => Promise<void> }).snapshotToD1();
}

function coldBuild(doInstance: unknown): Promise<void> {
  return (doInstance as { buildFromD1Rows: () => Promise<void> }).buildFromD1Rows();
}

beforeEach(() => {
  vi.clearAllMocks();
});

// SQL parsing — positional bind checks -------------------------------------

function parseInsertColumns(sql: string): string[] {
  const m = sql.match(/INSERT INTO \w+ \(([^)]+)\)/);
  if (!m) return [];
  return m[1].split(",").map((c) => c.trim().replace(/"/g, ""));
}

function parseUpdateSetColumns(sql: string): string[] {
  const m = sql.match(/UPDATE \w+ SET (.+?) WHERE /);
  if (!m) return [];
  return m[1].split(",").map((part) => part.split("=")[0].trim().replace(/"/g, ""));
}

// Y.Doc population from the registry ----------------------------------------

/** Build one flat-entity Y.Map (objects/glossary/pages) with every declared key. */
function buildFlatMap(entityName: EntityName, id: number | null): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("_id", id);
  // "pending" objects are skipped by the snapshot; mark valid so it persists.
  if (entityName === "objects") m.set("_validation_state", "valid");
  for (const { f, y } of declared(entityName)) m.set(y.key, makeYValue(entityName, f, y));
  return m;
}

/**
 * Populate a Y.Doc with one entity of every kind, each field carrying its
 * sentinel. `ids` selects INSERT (_id null) vs UPDATE (_id matching a fake
 * D1 row) per entity family.
 */
function populateDoc(
  ydoc: Y.Doc,
  ids: Partial<Record<"stories" | "steps" | "layers" | "objects" | "glossary" | "pages", number>>,
): void {
  ydoc.transact(() => {
    // config (+ nested landing map)
    const config = ydoc.getMap<unknown>("config");
    for (const { f, y } of declared("config")) config.set(y.key, makeYValue("config", f, y));
    const landing = new Y.Map<unknown>();
    for (const { f, y } of declared("landing")) landing.set(y.key, makeYValue("landing", f, y));
    config.set("landing", landing);

    // stories -> steps -> layers
    const storyMap = new Y.Map<unknown>();
    storyMap.set("_id", ids.stories ?? null);
    for (const { f, y } of declared("stories")) storyMap.set(y.key, makeYValue("stories", f, y));
    const stepMap = new Y.Map<unknown>();
    stepMap.set("_id", ids.steps ?? null);
    for (const { f, y } of declared("steps")) stepMap.set(y.key, makeYValue("steps", f, y));
    const layerMap = new Y.Map<unknown>();
    layerMap.set("_id", ids.layers ?? null);
    for (const { f, y } of declared("layers")) layerMap.set(y.key, makeYValue("layers", f, y));
    const layersArr = new Y.Array<Y.Map<unknown>>();
    layersArr.push([layerMap]);
    stepMap.set("layers", layersArr);
    const stepsArr = new Y.Array<Y.Map<unknown>>();
    stepsArr.push([stepMap]);
    storyMap.set("steps", stepsArr);
    ydoc.getArray<Y.Map<unknown>>("stories").push([storyMap]);

    // flat entities
    ydoc.getArray<Y.Map<unknown>>("objects").push([buildFlatMap("objects", ids.objects ?? null)]);
    ydoc
      .getArray<Y.Map<unknown>>("glossary")
      .push([buildFlatMap("glossary", ids.glossary ?? null)]);
    ydoc.getArray<Y.Map<unknown>>("pages").push([buildFlatMap("pages", ids.pages ?? null)]);
  }, null);
}

// ---------------------------------------------------------------------------
// Registry sanity — the harness must cover every entity the registry declares
// ---------------------------------------------------------------------------

describe("field-registry DO probes — harness coverage", () => {
  it("every registry entity has a DO table mapping (a new entity must be wired into this suite)", () => {
    expect(FIELD_REGISTRY.map((e) => e.entity).sort()).toEqual(Object.keys(TABLES).sort());
  });
});

// ---------------------------------------------------------------------------
// A. COLD BUILD — buildFromD1Rows carries every declared field into the Y.Doc
// ---------------------------------------------------------------------------

function buildD1Row(entityName: EntityName, extras: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = { ...extras };
  // Every column gets a sentinel — including coldLoad-excluded and
  // ydoc-excluded ones, so "must NOT carry" assertions have a live decoy.
  for (const f of getEntity(entityName).fields) row[f.d1.column] = d1Value(entityName, f);
  return row;
}

function makeColdBuildDO() {
  const rows = {
    config: buildD1Row("config", { id: 1, project_id: TEST_PROJECT_ID }),
    landing: buildD1Row("landing", { id: 1, project_id: TEST_PROJECT_ID }),
    stories: buildD1Row("stories", { id: 501, created_by: null }),
    steps: buildD1Row("steps", { id: 601, story_id: 501, created_by: null }),
    layers: buildD1Row("layers", { id: 701, step_id: 601, created_by: null }),
    objects: buildD1Row("objects", { id: 801, created_by: null }),
    glossary: buildD1Row("glossary", { id: 901, created_by: null }),
    pages: buildD1Row("pages", { id: 1001, created_by: null }),
  };
  return makeDO((sql) => {
    if (sql.includes("FROM project_config")) return [rows.config];
    if (sql.includes("FROM project_landing")) return [rows.landing];
    if (sql.includes("FROM stories")) return [rows.stories];
    if (sql.includes("FROM steps")) return [rows.steps];
    if (sql.includes("FROM layers")) return [rows.layers];
    if (sql.includes("FROM objects")) return [rows.objects];
    if (sql.includes("FROM glossary_terms")) return [rows.glossary];
    if (sql.includes("FROM project_pages")) return [rows.pages];
    return [];
  });
}

/** null when the Y value carries the field's D1 sentinel; a diagnostic otherwise. */
function coldCarryProblem(
  entity: EntityName,
  f: FieldDecl,
  y: YdocDecl,
  val: unknown,
): string | null {
  const id = `${entity}.${f.name}`;
  if (id === "config.navigation_json") {
    const json = val instanceof Y.Array ? JSON.stringify(val.toArray()) : JSON.stringify(val);
    return json.includes(textSentinel(entity, f.name))
      ? null
      : `${id}: Y "navigation" does not carry the D1 navigation_json sentinel (got ${json})`;
  }
  let carried: boolean;
  if (y.kind === "ytext") {
    carried = val instanceof Y.Text && val.toString() === textSentinel(entity, f.name);
  } else if (f.d1.type === "bool") {
    carried = val === true;
  } else if (f.d1.type === "int" || f.d1.type === "real") {
    carried = val === NUMERIC_SENTINELS.get(id);
  } else {
    carried = val === textSentinel(entity, f.name);
  }
  return carried ? null : `${id}: Y key "${y.key}" holds ${JSON.stringify(String(val))}, not the D1 sentinel`;
}

describe("A. cold build — buildFromD1Rows loads every declared field", () => {
  async function coldProblems(entityName: EntityName): Promise<string[]> {
    const { doInstance } = makeColdBuildDO();
    await coldBuild(doInstance);
    const ydoc = ydocOf(doInstance);
    const config = ydoc.getMap<unknown>("config");
    const containers: Record<EntityName, Y.Map<unknown>> = {
      config: config as Y.Map<unknown>,
      landing: config.get("landing") as Y.Map<unknown>,
      stories: ydoc.getArray<Y.Map<unknown>>("stories").get(0),
      steps: (ydoc.getArray<Y.Map<unknown>>("stories").get(0).get("steps") as Y.Array<Y.Map<unknown>>).get(0),
      layers: ((ydoc.getArray<Y.Map<unknown>>("stories").get(0).get("steps") as Y.Array<Y.Map<unknown>>)
        .get(0)
        .get("layers") as Y.Array<Y.Map<unknown>>).get(0),
      objects: ydoc.getArray<Y.Map<unknown>>("objects").get(0),
      glossary: ydoc.getArray<Y.Map<unknown>>("glossary").get(0),
      pages: ydoc.getArray<Y.Map<unknown>>("pages").get(0),
    };
    const container = containers[entityName];
    const problems: string[] = [];
    for (const { f, y } of declared(entityName)) {
      const val = container.get(y.key);
      const carryProblem = coldCarryProblem(entityName, f, y, val);
      if (y.coldLoad) {
        // coldLoad-excluded: the D1 sentinel must NOT appear under the Y key.
        if (carryProblem === null) {
          problems.push(
            `${entityName}.${f.name}: coldLoad-excluded, yet the cold build carried the D1 sentinel into Y`,
          );
        }
      } else if (carryProblem !== null) {
        problems.push(carryProblem);
      }
    }
    return problems;
  }

  for (const entityName of FIELD_REGISTRY.map((e) => e.entity)) {
    it(`${entityName}: every ydoc-declared field honors its coldLoad declaration`, async () => {
      expect(await coldProblems(entityName)).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// B. INSERT BINDS — the fresh-insert snapshot binds every declared field
// ---------------------------------------------------------------------------

function insertProblems(binds: BindCall[], entityName: EntityName): string[] {
  const table = TABLES[entityName];
  const problems: string[] = [];
  const insert = binds.find((b) => b.sql.includes(`INSERT INTO ${table} (`));
  if (!insert) return [`${entityName}: no INSERT INTO ${table} was issued`];
  const cols = parseInsertColumns(insert.sql);
  for (const { f, y } of declared(entityName)) {
    const id = `${entityName}.${f.name}`;
    const idx = cols.indexOf(f.d1.column);
    if (y.writeback) {
      // writeback-excluded: never written by the snapshot at all.
      if (idx >= 0) problems.push(`${id}: writeback-excluded column appears in the INSERT`);
      continue;
    }
    if (y.insert && "excluded" in y.insert) {
      // insert-excluded: the column binds its default, never the Y value.
      if (!(id in INSERT_EXCLUDED_DEFAULTS)) {
        problems.push(`${id}: insert-excluded but this suite has no default mapping for it`);
        continue;
      }
      if (idx < 0) {
        problems.push(`${id}: insert-excluded column missing from the INSERT (expected default bind)`);
        continue;
      }
      if (insert.args[idx] !== INSERT_EXCLUDED_DEFAULTS[id]) {
        problems.push(
          `${id}: insert-excluded column bound ${JSON.stringify(insert.args[idx])}, expected default ${JSON.stringify(INSERT_EXCLUDED_DEFAULTS[id])}`,
        );
      }
      continue;
    }
    // Note: preserveFromD1 inserts (objects.origin) still bind the Y copy on
    // the FRESH path — the factory sets origin at creation; the D1 preference
    // applies only to the stale-_id re-INSERT, probed separately below.
    if (idx < 0) {
      problems.push(`${id}: column "${f.d1.column}" missing from the INSERT column list`);
      continue;
    }
    const exp = expectedBind(entityName, f);
    const got = insert.args[idx];
    const ok = exp.mode === "contains" ? String(got).includes(exp.value) : got === exp.value;
    if (!ok) {
      problems.push(
        `${id}: INSERT bound ${JSON.stringify(got)}, expected ${JSON.stringify(exp.value)}`,
      );
    }
  }
  return problems;
}

describe("B. insert binds — snapshotToD1 fresh inserts bind every declared field", () => {
  async function freshInsertBinds(): Promise<BindCall[]> {
    const { doInstance, binds } = makeDO(() => []); // every SELECT empty -> INSERT paths
    populateDoc(ydocOf(doInstance), {}); // all _id null
    await snapshot(doInstance);
    return binds;
  }

  for (const entityName of FIELD_REGISTRY.map((e) => e.entity)) {
    it(`${entityName}: INSERT INTO ${TABLES[entityName]} binds every field per its insert declaration`, async () => {
      expect(insertProblems(await freshInsertBinds(), entityName)).toEqual([]);
    });
  }
});

// --- B (continued): preserveFromD1 on the stale-_id re-INSERT path ----------

interface PreserveObligation {
  entity: EntityName;
  fieldName: string;
  column: string;
  /** origin has a Y key (factory-set); related_terms is never in Y. */
  hasYKey: boolean;
}

const preserveObligations: PreserveObligation[] = [];
for (const e of FIELD_REGISTRY) {
  for (const f of e.fields) {
    if ("excluded" in f.ydoc) {
      if (f.ydoc.preserveFromD1) {
        preserveObligations.push({
          entity: e.entity,
          fieldName: f.name,
          column: f.d1.column,
          hasYKey: false,
        });
      }
    } else if (f.ydoc.insert && "preserveFromD1" in f.ydoc.insert) {
      preserveObligations.push({
        entity: e.entity,
        fieldName: f.name,
        column: f.d1.column,
        hasYKey: true,
      });
    }
  }
}

describe("B. insert binds — preserveFromD1 declarations on the stale-_id re-INSERT", () => {
  it("the registry declares the two known preserve obligations (guard against silent drift)", () => {
    expect(preserveObligations.map((o) => `${o.entity}.${o.fieldName}`).sort()).toEqual([
      "glossary.related_terms",
      "objects.origin",
    ]);
  });

  for (const ob of preserveObligations) {
    it(`${ob.entity}.${ob.fieldName}: stale-_id re-INSERT binds the surviving D1 row's value`, async () => {
      const table = TABLES[ob.entity];
      const preserved = `S_preserved_${ob.entity}_${ob.fieldName}`;
      const listingRe = new RegExp(`SELECT id, \\w+ FROM ${table} WHERE project_id`);
      const preserveRe = new RegExp(`SELECT ${ob.column} FROM ${table} WHERE id`);
      const { doInstance, binds } = makeDO((sql) => {
        if (listingRe.test(sql)) return []; // _id 77 is stale, no same-key adopt
        if (preserveRe.test(sql)) return [{ [ob.column]: preserved }];
        return [];
      });
      const ydoc = ydocOf(doInstance);
      ydoc.transact(() => {
        // buildFlatMap plants a decoy Y sentinel for fields that DO have a Y
        // key (objects.origin), so the probe proves D1 wins over the Y copy.
        ydoc
          .getArray<Y.Map<unknown>>(ob.entity)
          .push([buildFlatMap(ob.entity, 77)]);
      }, null);

      await snapshot(doInstance);

      const insert = binds.find((b) => b.sql.includes(`INSERT INTO ${table} (`));
      expect(insert, `no re-INSERT INTO ${table} captured`).toBeDefined();
      const cols = parseInsertColumns(insert!.sql);
      const idx = cols.indexOf(ob.column);
      expect(idx, `column "${ob.column}" missing from the re-INSERT`).toBeGreaterThanOrEqual(0);
      expect(insert!.args[idx]).toBe(preserved);
      if (ob.hasYKey) {
        expect(insert!.args[idx]).not.toBe(textSentinel(ob.entity, ob.fieldName));
      }
    });
  }
});

// ---------------------------------------------------------------------------
// C. UPDATE BINDS — the snapshot UPDATE honors update/writeback declarations
// ---------------------------------------------------------------------------

function updateProblems(binds: BindCall[], entityName: EntityName): string[] {
  const table = TABLES[entityName];
  const problems: string[] = [];
  const update = binds.find((b) => b.sql.includes(`UPDATE ${table} SET`));
  if (!update) return [`${entityName}: no UPDATE ${table} SET was issued`];
  const setCols = parseUpdateSetColumns(update.sql);
  for (const { f, y } of declared(entityName)) {
    const id = `${entityName}.${f.name}`;
    const inSet = setCols.includes(f.d1.column);
    if (y.update || y.writeback) {
      // update-excluded (preserved by omission) or writeback-excluded
      // (never written): the column must NOT appear in the SET list.
      if (inSet) {
        problems.push(
          `${id}: ${y.writeback ? "writeback" : "update"}-excluded column "${f.d1.column}" appears in the UPDATE SET list`,
        );
      }
      continue;
    }
    if (!inSet) {
      problems.push(`${id}: column "${f.d1.column}" missing from the UPDATE SET list`);
      continue;
    }
    const idx = setCols.indexOf(f.d1.column);
    const exp = expectedBind(entityName, f);
    const got = update.args[idx];
    const ok = exp.mode === "contains" ? String(got).includes(exp.value) : got === exp.value;
    if (!ok) {
      problems.push(
        `${id}: UPDATE bound ${JSON.stringify(got)}, expected ${JSON.stringify(exp.value)}`,
      );
    }
  }
  return problems;
}

describe("C. update binds — snapshotToD1 updates bind every declared field", () => {
  async function updateBinds(): Promise<BindCall[]> {
    // Every listing SELECT returns the matching id, so every entity takes the
    // UPDATE (not INSERT / re-INSERT) branch.
    const { doInstance, binds } = makeDO((sql) => {
      if (/SELECT id FROM project_config WHERE project_id/.test(sql)) return [{ id: 1 }];
      if (/SELECT id FROM project_landing WHERE project_id/.test(sql)) return [{ id: 1 }];
      if (/SELECT id FROM stories WHERE project_id/.test(sql)) return [{ id: 501 }];
      if (/SELECT id FROM steps WHERE story_id/.test(sql)) return [{ id: 601 }];
      if (/SELECT id FROM layers WHERE step_id/.test(sql)) return [{ id: 701 }];
      if (/SELECT id, object_id FROM objects WHERE project_id/.test(sql)) {
        return [{ id: 801, object_id: textSentinel("objects", "object_id") }];
      }
      if (/SELECT id, term_id FROM glossary_terms WHERE project_id/.test(sql)) {
        return [{ id: 901, term_id: textSentinel("glossary", "term_id") }];
      }
      if (/SELECT id, slug FROM project_pages WHERE project_id/.test(sql)) {
        return [{ id: 1001, slug: textSentinel("pages", "slug") }];
      }
      return [];
    });
    populateDoc(ydocOf(doInstance), {
      stories: 501,
      steps: 601,
      layers: 701,
      objects: 801,
      glossary: 901,
      pages: 1001,
    });
    await snapshot(doInstance);
    return binds;
  }

  for (const entityName of FIELD_REGISTRY.map((e) => e.entity)) {
    it(`${entityName}: UPDATE ${TABLES[entityName]} SET honors every field's update/writeback declaration`, async () => {
      expect(updateProblems(await updateBinds(), entityName)).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// D. RESTORE — POST /restore-orphans carries every steps/layers field
// ---------------------------------------------------------------------------

// The dashboard payload builder (_app.dashboard.tsx, restore-orphan-drafts
// action) sends one property per steps field, named identically to the
// registry's canonical field names, plus layers with step_index infra.
function makeRestoreDO() {
  const { DB } = makeFakeDB(() => []);
  const env = { DB, SESSION_SECRET: TEST_SECRET, COLLABORATION: {} } as unknown;
  const doInstance = new ProjectCollaborationDO(
    makeCtx() as unknown as DurableObjectState,
    env as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = TEST_PROJECT_ID;
  (doInstance as unknown as { ensureDocLoaded: () => Promise<void> }).ensureDocLoaded =
    async () => {
      (doInstance as unknown as { docLoaded: boolean }).docLoaded = true;
    };
  vi.spyOn(
    doInstance as unknown as { snapshotToD1: () => Promise<void> },
    "snapshotToD1",
  ).mockResolvedValue(undefined);
  return doInstance;
}

function restorePayloadValue(entity: EntityName, f: FieldDecl): unknown {
  const id = `${entity}.${f.name}`;
  if (f.d1.type === "int" || f.d1.type === "real") return NUMERIC_SENTINELS.get(id)!;
  return textSentinel(entity, f.name); // steps/layers carry no bool fields
}

async function driveRestore(): Promise<Y.Doc> {
  const doInstance = makeRestoreDO();
  const step: Record<string, unknown> = {};
  for (const { f } of declared("steps")) step[f.name] = restorePayloadValue("steps", f);
  const layer: Record<string, unknown> = { step_index: 0 };
  for (const { f } of declared("layers")) layer[f.name] = restorePayloadValue("layers", f);

  const { sigHex, timestamp } = await signInternalMarker(
    TEST_PROJECT_ID,
    TEST_SECRET,
    "restore-orphans",
  );
  const req = new Request("https://internal/restore-orphans", {
    method: "POST",
    headers: {
      "X-Internal-Auth": sigHex,
      "X-Internal-Timestamp": String(timestamp),
      "X-Internal-Project": String(TEST_PROJECT_ID),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ stories: [{ storyId: "orphan-story", steps: [step], layers: [layer] }] }),
  });
  const res = await doInstance.fetch(req);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { restored: number }).restored).toBe(1);
  return ydocOf(doInstance);
}

function restoreCarryProblems(
  entityName: "steps" | "layers",
  container: Y.Map<unknown>,
): string[] {
  const problems: string[] = [];
  for (const { f, y } of declared(entityName)) {
    const id = `${entityName}.${f.name}`;
    const val = container.get(y.key);
    let carried: boolean;
    if (y.kind === "ytext") {
      carried = val instanceof Y.Text && val.toString() === textSentinel(entityName, f.name);
    } else if (f.d1.type === "int" || f.d1.type === "real") {
      carried = val === NUMERIC_SENTINELS.get(id);
    } else {
      carried = val === textSentinel(entityName, f.name);
    }
    if (!carried) {
      problems.push(`${id}: restored Y key "${y.key}" holds ${JSON.stringify(String(val))}, not the payload sentinel`);
    }
  }
  return problems;
}

describe("D. restore — /restore-orphans carries every steps/layers field into the Y.Doc", () => {
  it("steps: every ydoc-declared field's payload sentinel lands on the restored step Y.Map", async () => {
    const ydoc = await driveRestore();
    const stepMap = (
      ydoc.getArray<Y.Map<unknown>>("stories").get(0).get("steps") as Y.Array<Y.Map<unknown>>
    ).get(0);
    expect(restoreCarryProblems("steps", stepMap)).toEqual([]);
  });

  it("layers: every ydoc-declared field's payload sentinel lands on the restored layer Y.Map", async () => {
    const ydoc = await driveRestore();
    const stepMap = (
      ydoc.getArray<Y.Map<unknown>>("stories").get(0).get("steps") as Y.Array<Y.Map<unknown>>
    ).get(0);
    const layerMap = (stepMap.get("layers") as Y.Array<Y.Map<unknown>>).get(0);
    expect(restoreCarryProblems("layers", layerMap)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// E. FACTORY KEY-SETS — client factories set exactly the declared keys + infra
// ---------------------------------------------------------------------------

// Infrastructure keys the factories legitimately set beyond the registry's
// content declarations (the registry scopes them out by design):
//   _id                — D1 row id sentinel (null until snapshot backfill)
//   _temp_id           — stable client handle before _id exists
//   created_by         — permission/attribution tracking
//   _validation_state  — objects only: "pending" IIIF rows are snapshot-skipped
//   layers             — steps only: the nested layers Y.Array container
const OBJECT_INFRA_KEYS = ["_id", "_temp_id", "created_by", "_validation_state"];
const STEP_INFRA_KEYS = ["_id", "_temp_id", "created_by", "layers"];

function attachedKeys(map: Y.Map<unknown>): string[] {
  const doc = new Y.Doc();
  doc.getArray<Y.Map<unknown>>("scratch").push([map]);
  return [...map.keys()].sort();
}

describe("E. factory key-sets — pinned to the registry in both directions", () => {
  it("makeObjectYMap keys === declared objects ydoc keys + enumerated infra keys", () => {
    const expected = [
      ...declared("objects").map(({ y }) => y.key),
      ...OBJECT_INFRA_KEYS,
    ].sort();
    const actual = attachedKeys(
      makeObjectYMap({ objectId: "obj-1", validationState: "valid", origin: "compositor" }),
    );
    expect(actual).toEqual(expected);
  });

  it("buildStepYMap keys === declared steps ydoc keys + enumerated infra keys", () => {
    const expected = [...declared("steps").map(({ y }) => y.key), ...STEP_INFRA_KEYS].sort();
    const actual = attachedKeys(structuralOpsTest.buildStepYMap(7, 1, "media"));
    expect(actual).toEqual(expected);
  });
});

// ===========================================================================
// /ingest-sync — the D2 pin. A stateful D1 fake (rows survive across INSERT /
// UPDATE / DELETE) lets us ingest an accepted value, run doSnapshot() AGAIN,
// and prove the accepted state persists — no revert, no orphan-delete, no
// resurrection. On the pre-fix tree the second snapshot reverted the accept.
// ===========================================================================

/** A stateful D1 fake: rows are stored per table and mutated by writes. */
function makeStatefulDB() {
  const rows: Record<string, Array<Record<string, unknown>>> = {
    project_config: [],
    project_landing: [],
    stories: [],
    steps: [],
    layers: [],
    objects: [],
    glossary_terms: [],
    project_pages: [],
    project_members: [],
    activity_log: [],
    projects: [{ id: TEST_PROJECT_ID }],
  };
  let nextId = 5000;

  function tableOf(sql: string): string {
    return sql.match(/(?:FROM|INTO|UPDATE)\s+(\w+)/)?.[1] ?? "";
  }

  function execSelect(sql: string, args: unknown[]): Record<string, unknown>[] {
    const list = rows[tableOf(sql)] ?? [];
    if (/WHERE id = \? AND project_id/.test(sql)) return list.filter((r) => r.id === args[0]);
    if (/WHERE project_id = \? AND user_id IN/.test(sql)) return [];
    if (/WHERE project_id = \?/.test(sql)) return list.filter((r) => r.project_id === args[0]);
    if (/WHERE story_id = \?/.test(sql)) return list.filter((r) => r.story_id === args[0]);
    if (/WHERE step_id = \?/.test(sql)) return list.filter((r) => r.step_id === args[0]);
    if (/WHERE id = \?/.test(sql)) return list.filter((r) => r.id === args[0]);
    return list;
  }

  function execWrite(sql: string, args: unknown[]): { meta: { last_row_id: number } } {
    let m: RegExpMatchArray | null;
    if ((m = sql.match(/^INSERT INTO (\w+) \(([^)]+)\)/))) {
      const table = m[1];
      const cols = m[2].split(",").map((c) => c.trim().replace(/"/g, ""));
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => (row[c] = args[i]));
      let id: number;
      if (cols[0] === "id") id = row.id as number;
      else {
        id = nextId++;
        row.id = id;
      }
      (rows[table] ??= []).push(row);
      return { meta: { last_row_id: id } };
    }
    if ((m = sql.match(/^UPDATE (\w+) SET ([\s\S]+?) WHERE ([\s\S]+)$/))) {
      const table = m[1];
      const setCols = m[2].split(",").map((p) => p.split("=")[0].trim().replace(/"/g, ""));
      const wherePart = m[3];
      const setVals = args.slice(0, setCols.length);
      const whereVals = args.slice(setCols.length);
      const list = rows[table] ?? [];
      const match = /project_id = \?/.test(wherePart)
        ? (r: Record<string, unknown>) => r.project_id === whereVals[0]
        : (r: Record<string, unknown>) => r.id === whereVals[0];
      for (const r of list) if (match(r)) setCols.forEach((c, i) => (r[c] = setVals[i]));
      return { meta: { last_row_id: 0 } };
    }
    if ((m = sql.match(/^DELETE FROM (\w+) WHERE ([\s\S]+)$/))) {
      const table = m[1];
      const wherePart = m[2];
      const match = /step_id = \?/.test(wherePart)
        ? (r: Record<string, unknown>) => r.step_id === args[0]
        : /story_id = \?/.test(wherePart)
          ? (r: Record<string, unknown>) => r.story_id === args[0]
          : (r: Record<string, unknown>) => r.id === args[0];
      rows[table] = (rows[table] ?? []).filter((r) => !match(r));
      return { meta: { last_row_id: 0 } };
    }
    return { meta: { last_row_id: 0 } };
  }

  const statefulStmt = (sql: string) => ({
    bind(...args: unknown[]) {
      return {
        async run() {
          return execWrite(sql, args);
        },
        async all<T>() {
          return { results: execSelect(sql, args) as T[] };
        },
        async first<T>() {
          return (execSelect(sql, args)[0] ?? null) as T | null;
        },
        __write: () => execWrite(sql, args),
      };
    },
  });

  const DB = {
    prepare: (sql: string) => statefulStmt(sql),
    async batch(statements: Array<{ __write: () => unknown }>) {
      for (const s of statements) s.__write();
      return statements.map(() => ({ success: true }));
    },
  };
  return { DB, rows };
}

function makeStatefulDO() {
  const { DB, rows } = makeStatefulDB();
  const env = { DB, SESSION_SECRET: TEST_SECRET, COLLABORATION: {} } as unknown;
  const doInstance = new ProjectCollaborationDO(
    makeCtx() as unknown as DurableObjectState,
    env as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = TEST_PROJECT_ID;
  (doInstance as unknown as { docLoaded: boolean }).docLoaded = true;
  return { doInstance, rows };
}

async function ingest(
  doInstance: ProjectCollaborationDO,
  payload: unknown,
): Promise<{ status: number; body: { applied: Record<string, number>; skipped: Record<string, string[]> } }> {
  const { sigHex, timestamp } = await signInternalMarker(TEST_PROJECT_ID, TEST_SECRET, "ingest-sync");
  const req = new Request("https://internal/ingest-sync", {
    method: "POST",
    headers: {
      "X-Internal-Auth": sigHex,
      "X-Internal-Timestamp": String(timestamp),
      "X-Internal-Project": String(TEST_PROJECT_ID),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const res = await doInstance.fetch(req);
  return { status: res.status, body: (await res.json()) as never };
}

const emptyIngest = () => ({
  config: [] as Array<{ key: string; value: unknown }>,
  stories: { update: [] as unknown[], insert: [] as unknown[] },
  objects: { update: [] as unknown[], insert: [] as unknown[], remove: [] as string[] },
  glossary: { update: [] as unknown[], insert: [] as unknown[] },
});

// Seed a story Y.Map (id, all declared story fields as sentinels, empty steps)
// plus its matching D1 row so an update finds it and the snapshot UPDATEs it.
function seedIngestStory(doInstance: ProjectCollaborationDO, rows: Record<string, Array<Record<string, unknown>>>, id: number) {
  const ydoc = ydocOf(doInstance);
  ydoc.transact(() => {
    const m = new Y.Map<unknown>();
    m.set("_id", id);
    for (const { f, y } of declared("stories")) m.set(y.key, makeYValue("stories", f, y));
    m.set("steps", new Y.Array<Y.Map<unknown>>());
    ydoc.getArray<Y.Map<unknown>>("stories").push([m]);
  }, null);
  rows.stories.push(buildD1Row("stories", { id, project_id: TEST_PROJECT_ID, created_by: null }));
}

function seedFlat(doInstance: ProjectCollaborationDO, rows: Record<string, Array<Record<string, unknown>>>, entity: "objects" | "glossary", id: number) {
  const ydoc = ydocOf(doInstance);
  ydoc.transact(() => {
    ydoc.getArray<Y.Map<unknown>>(entity).push([buildFlatMap(entity, id)]);
  }, null);
  const table = TABLES[entity];
  rows[table].push(buildD1Row(entity, { id, project_id: TEST_PROJECT_ID, created_by: null }));
}

function snapshotOf(doInstance: ProjectCollaborationDO): Promise<void> {
  return (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();
}

// ---------------------------------------------------------------------------
// Family 1 — headline D2 pin: ingest, then snapshot AGAIN, D1 retains.
// ---------------------------------------------------------------------------

describe("ingest headline (D2 pin) — accepted state survives a second snapshot", () => {
  it("config field: an ingested title survives", async () => {
    const { doInstance, rows } = makeStatefulDO();
    await ingest(doInstance, { ...emptyIngest(), config: [{ key: "title", value: "Ingested Title" }] });
    await snapshotOf(doInstance);
    expect(rows.project_config).toHaveLength(1);
    expect(rows.project_config[0].title).toBe("Ingested Title");
  });

  it("story update: an ingested title survives (no revert)", async () => {
    const { doInstance, rows } = makeStatefulDO();
    seedIngestStory(doInstance, rows, 501);
    const storyId = textSentinel("stories", "story_id");
    await ingest(doInstance, {
      ...emptyIngest(),
      stories: {
        update: [{ storyId, title: "New Title", subtitle: "sub", byline: "by", isPrivate: true, showSections: false }],
        insert: [],
      },
    });
    await snapshotOf(doInstance);
    expect(rows.stories).toHaveLength(1);
    expect(rows.stories[0].title).toBe("New Title");
    expect(rows.stories[0].private).toBe(1);
  });

  it("story insert: a new story + its layers survive the second snapshot", async () => {
    const { doInstance, rows } = makeStatefulDO();
    await ingest(doInstance, {
      ...emptyIngest(),
      stories: {
        update: [],
        insert: [{
          storyId: "brand-new",
          title: "Brand New",
          subtitle: "",
          byline: "",
          isPrivate: false,
          showSections: false,
          steps: [{ step_number: 1, kind: "media", object_id: "o1" }],
          layers: [{ step_index: 0, layer_number: 1, title: "L", content: "body" }],
        }],
      },
    });
    await snapshotOf(doInstance);
    expect(rows.stories).toHaveLength(1);
    expect(rows.stories[0].story_id).toBe("brand-new");
    expect(rows.stories[0].draft).toBe(0);
    expect(rows.layers).toHaveLength(1);
    expect(rows.layers[0].content).toBe("body");
  });

  it("object update: an ingested title survives", async () => {
    const { doInstance, rows } = makeStatefulDO();
    seedFlat(doInstance, rows, "objects", 801);
    const objectId = textSentinel("objects", "object_id");
    await ingest(doInstance, {
      ...emptyIngest(),
      objects: { update: [{ objectId, fields: { title: "New Obj", featured: true } }], insert: [], remove: [] },
    });
    await snapshotOf(doInstance);
    expect(rows.objects).toHaveLength(1);
    expect(rows.objects[0].title).toBe("New Obj");
    expect(rows.objects[0].featured).toBe(1);
  });

  it("object insert: a new object survives (not orphan-deleted)", async () => {
    const { doInstance, rows } = makeStatefulDO();
    await ingest(doInstance, {
      ...emptyIngest(),
      objects: { update: [], insert: [{ object_id: "new-obj", title: "N", image_available: true }], remove: [] },
    });
    await snapshotOf(doInstance);
    expect(rows.objects.map((r) => r.object_id)).toContain("new-obj");
  });

  it("object remove: a removed object stays removed (no resurrection)", async () => {
    const { doInstance, rows } = makeStatefulDO();
    seedFlat(doInstance, rows, "objects", 801);
    const objectId = textSentinel("objects", "object_id");
    await ingest(doInstance, {
      ...emptyIngest(),
      objects: { update: [], insert: [], remove: [objectId] },
    });
    await snapshotOf(doInstance);
    expect(rows.objects).toHaveLength(0);
  });

  it("glossary update: an ingested definition survives", async () => {
    const { doInstance, rows } = makeStatefulDO();
    seedFlat(doInstance, rows, "glossary", 901);
    const termId = textSentinel("glossary", "term_id");
    await ingest(doInstance, {
      ...emptyIngest(),
      glossary: { update: [{ termId, title: "T", definition: "New Def" }], insert: [] },
    });
    await snapshotOf(doInstance);
    expect(rows.glossary_terms).toHaveLength(1);
    expect(rows.glossary_terms[0].definition).toBe("New Def");
  });

  it("glossary insert: a new term keeps its repo term_id and survives", async () => {
    const { doInstance, rows } = makeStatefulDO();
    await ingest(doInstance, {
      ...emptyIngest(),
      glossary: { update: [], insert: [{ termId: "repo-term", title: "T", definition: "D" }] },
    });
    await snapshotOf(doInstance);
    expect(rows.glossary_terms.map((r) => r.term_id)).toContain("repo-term");
  });
});

// ---------------------------------------------------------------------------
// Family 2b — registry-generated: every sync field, ingested, binds its column.
// ---------------------------------------------------------------------------

function syncDeclared(entityName: EntityName): FieldDecl[] {
  return getEntity(entityName).fields.filter((f) => {
    if ("excluded" in f.ydoc) return false;
    return "diff" in f.sync && f.sync.role !== "key";
  });
}

function fieldKind(f: FieldDecl): "ytext" | "bool" | "int" | "plain" {
  if (!("excluded" in f.ydoc) && f.ydoc.kind === "ytext") return "ytext";
  if (f.d1.type === "bool") return "bool";
  if (f.d1.type === "int" || f.d1.type === "real") return "int";
  return "plain";
}

function ingestValue(f: FieldDecl): unknown {
  const k = fieldKind(f);
  return k === "bool" ? true : k === "int" ? 7 : `ing_${f.name}`;
}

function expectedColumn(f: FieldDecl): unknown {
  const k = fieldKind(f);
  return k === "bool" ? 1 : k === "int" ? 7 : `ing_${f.name}`;
}

describe("F. ingest binds — every sync field lands in its D1 column via the snapshot", () => {
  for (const f of syncDeclared("config")) {
    it(`config.${f.name}: ingest → snapshot binds project_config.${f.d1.column}`, async () => {
      const { doInstance, rows } = makeStatefulDO();
      await ingest(doInstance, { ...emptyIngest(), config: [{ key: f.name, value: ingestValue(f) }] });
      await snapshotOf(doInstance);
      expect(rows.project_config[0][f.d1.column]).toBe(expectedColumn(f));
    });
  }

  for (const f of syncDeclared("stories")) {
    const itemKey = "diff" in f.sync ? (f.sync.itemKey ?? f.name) : f.name;
    it(`stories.${f.name}: ingest update → snapshot binds stories.${f.d1.column}`, async () => {
      const { doInstance, rows } = makeStatefulDO();
      seedIngestStory(doInstance, rows, 501);
      const storyId = textSentinel("stories", "story_id");
      const upd: Record<string, unknown> = {
        storyId,
        title: "keep",
        subtitle: "keep",
        byline: "keep",
        isPrivate: false,
        showSections: false,
      };
      upd[itemKey] = ingestValue(f);
      await ingest(doInstance, { ...emptyIngest(), stories: { update: [upd], insert: [] } });
      await snapshotOf(doInstance);
      expect(rows.stories[0][f.d1.column]).toBe(expectedColumn(f));
    });
  }

  for (const f of syncDeclared("objects")) {
    it(`objects.${f.name}: ingest update → snapshot binds objects.${f.d1.column}`, async () => {
      const { doInstance, rows } = makeStatefulDO();
      seedFlat(doInstance, rows, "objects", 801);
      const objectId = textSentinel("objects", "object_id");
      await ingest(doInstance, {
        ...emptyIngest(),
        objects: { update: [{ objectId, fields: { [f.name]: ingestValue(f) } }], insert: [], remove: [] },
      });
      await snapshotOf(doInstance);
      expect(rows.objects[0][f.d1.column]).toBe(expectedColumn(f));
    });
  }

  for (const f of syncDeclared("glossary")) {
    it(`glossary.${f.name}: ingest update → snapshot binds glossary_terms.${f.d1.column}`, async () => {
      const { doInstance, rows } = makeStatefulDO();
      seedFlat(doInstance, rows, "glossary", 901);
      const termId = textSentinel("glossary", "term_id");
      const upd: Record<string, unknown> = { termId, title: "keep", definition: "keep" };
      upd[f.name] = ingestValue(f);
      await ingest(doInstance, { ...emptyIngest(), glossary: { update: [upd], insert: [] } });
      await snapshotOf(doInstance);
      expect(rows.glossary_terms[0][f.d1.column]).toBe(expectedColumn(f));
    });
  }
});

// ---------------------------------------------------------------------------
// Family 3 — idempotency: a double-ingest yields one row, no duplicates.
// ---------------------------------------------------------------------------

describe("G. ingest idempotency — a repeated payload does not duplicate", () => {
  it("story insert twice → one D1 story row", async () => {
    const { doInstance, rows } = makeStatefulDO();
    const payload = {
      ...emptyIngest(),
      stories: {
        update: [],
        insert: [{ storyId: "dup", title: "T", subtitle: "", byline: "", isPrivate: false, showSections: false, steps: [], layers: [] }],
      },
    };
    await ingest(doInstance, payload);
    await ingest(doInstance, payload);
    await snapshotOf(doInstance);
    expect(rows.stories.filter((r) => r.story_id === "dup")).toHaveLength(1);
    const ydoc = ydocOf(doInstance);
    const storyMaps = ydoc.getArray<Y.Map<unknown>>("stories").toArray().filter((m) => m.get("story_id") === "dup");
    expect(storyMaps).toHaveLength(1);
  });

  it("object + glossary insert twice → one D1 row each (skip-if-present)", async () => {
    const { doInstance, rows } = makeStatefulDO();
    const payload = {
      ...emptyIngest(),
      objects: { update: [], insert: [{ object_id: "dup-obj", title: "O", image_available: false }], remove: [] },
      glossary: { update: [], insert: [{ termId: "dup-term", title: "G", definition: "D" }] },
    };
    const first = await ingest(doInstance, payload);
    const second = await ingest(doInstance, payload);
    await snapshotOf(doInstance);
    expect(rows.objects.filter((r) => r.object_id === "dup-obj")).toHaveLength(1);
    expect(rows.glossary_terms.filter((r) => r.term_id === "dup-term")).toHaveLength(1);
    // First applies, second skips.
    expect(first.body.applied.objectInsert).toBe(1);
    expect(second.body.skipped.objectInsert).toContain("dup-obj");
    expect(second.body.skipped.glossaryInsert).toContain("dup-term");
  });
});

// ---------------------------------------------------------------------------
// Family 4 — L2 pin: a removed object stays removed after a FURTHER snapshot.
// ---------------------------------------------------------------------------

describe("H. L2 pin — removed object does not resurrect on a later snapshot", () => {
  it("remove → snapshot → snapshot: still absent", async () => {
    const { doInstance, rows } = makeStatefulDO();
    seedFlat(doInstance, rows, "objects", 801);
    const objectId = textSentinel("objects", "object_id");
    await ingest(doInstance, { ...emptyIngest(), objects: { update: [], insert: [], remove: [objectId] } });
    await snapshotOf(doInstance);
    await snapshotOf(doInstance);
    expect(rows.objects).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Family 5 — race: a stalled in-flight snapshot makes ingest wait, not skip.
// ---------------------------------------------------------------------------

describe("I. ingest snapshot-in-flight — waits, does not mutate mid-flush or skip", () => {
  it("ingest waits for a stalled snapshot to drain before mutating and snapshotting", async () => {
    const { doInstance, rows } = makeStatefulDO();

    // Hold a fake snapshot in flight: isSnapshotting = true, released after a tick.
    (doInstance as unknown as { isSnapshotting: boolean }).isSnapshotting = true;

    const snapshotSpy = vi.spyOn(
      doInstance as unknown as { snapshotToD1: () => Promise<void> },
      "snapshotToD1",
    );

    const ingestPromise = ingest(doInstance, {
      ...emptyIngest(),
      objects: { update: [], insert: [{ object_id: "raced", title: "R", image_available: false }], remove: [] },
    });

    // While the snapshot is "in flight", ingest must be parked on the drain-wait:
    // it has neither mutated the doc nor invoked its own snapshot yet.
    await new Promise((r) => setTimeout(r, 60));
    const ydoc = ydocOf(doInstance);
    expect(ydoc.getArray<Y.Map<unknown>>("objects").length).toBe(0);
    expect(snapshotSpy).not.toHaveBeenCalled();

    // Release the in-flight snapshot; ingest proceeds.
    (doInstance as unknown as { isSnapshotting: boolean }).isSnapshotting = false;
    const res = await ingestPromise;

    expect(res.status).toBe(200);
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
    expect(rows.objects.map((r) => r.object_id)).toContain("raced");
  });
});

// ---------------------------------------------------------------------------
// Hardening pins — cold-DO binding, retried-insert id carry, key allowlists.
// ---------------------------------------------------------------------------

/**
 * A DO woken by stub.fetch alone: no sockets, so the constructor restores
 * neither projectId nor the doc. The ingest must bind projectId from the
 * HMAC-verified marker header and cold-build the doc from D1 — previously it
 * mutated an unloaded doc and returned success while persisting nothing.
 */
function makeColdStatefulDO() {
  const { DB, rows } = makeStatefulDB();
  const env = { DB, SESSION_SECRET: TEST_SECRET, COLLABORATION: {} } as unknown;
  const doInstance = new ProjectCollaborationDO(
    makeCtx() as unknown as DurableObjectState,
    env as Env,
  );
  return { doInstance, rows };
}

describe("J. cold-DO ingest — projectId bound from the verified marker", () => {
  it("ingest on a socket-less DO cold-builds from D1 and persists", async () => {
    const { doInstance, rows } = makeColdStatefulDO();
    const res = await ingest(doInstance, {
      ...emptyIngest(),
      config: [{ key: "title", value: "Cold Ingest Title" }],
    });
    expect(res.status).toBe(200);
    expect((doInstance as unknown as { projectId: number | null }).projectId).toBe(TEST_PROJECT_ID);
    expect(rows.project_config).toHaveLength(1);
    expect(rows.project_config[0].title).toBe("Cold Ingest Title");
  });

  it("a marker for a different project than the bound one is refused", async () => {
    const { doInstance } = makeStatefulDO();
    (doInstance as unknown as { projectId: number }).projectId = TEST_PROJECT_ID + 1;
    const { sigHex, timestamp } = await signInternalMarker(TEST_PROJECT_ID, TEST_SECRET, "ingest-sync");
    const req = new Request("https://internal/ingest-sync", {
      method: "POST",
      headers: {
        "X-Internal-Auth": sigHex,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Project": String(TEST_PROJECT_ID),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(emptyIngest()),
    });
    const res = await doInstance.fetch(req);
    expect(res.status).toBe(409);
  });
});

describe("K. retried story insert — carried _id keeps the D1 row alive", () => {
  it("re-ingesting an already-snapshotted insert UPDATEs in place (same id, no gap)", async () => {
    const { doInstance, rows } = makeStatefulDO();
    const payload = {
      ...emptyIngest(),
      stories: {
        update: [],
        insert: [{
          storyId: "retry-me", title: "T", subtitle: "", byline: "",
          isPrivate: false, showSections: false,
          steps: [{ step_number: 1, kind: "media", object_id: "o1" }],
          layers: [],
        }],
      },
    };
    await ingest(doInstance, payload);
    expect(rows.stories).toHaveLength(1);
    const firstId = rows.stories[0].id;

    // Retry after a lost response: with _id carried onto the replacement
    // Y.Map, the snapshot takes the UPDATE branch — the row never leaves D1
    // and keeps its id (an _id = null replacement would INSERT against the
    // UNIQUE(project_id, story_id) index while the old row still exists,
    // get swallowed, and the batched orphan-delete would drop the story).
    await ingest(doInstance, payload);
    expect(rows.stories).toHaveLength(1);
    expect(rows.stories[0].id).toBe(firstId);
    expect(rows.stories[0].story_id).toBe("retry-me");

    // The doc holds exactly one map for the story, carrying the same id.
    const maps = ydocOf(doInstance)
      .getArray<Y.Map<unknown>>("stories")
      .toArray()
      .filter((m) => m.get("story_id") === "retry-me");
    expect(maps).toHaveLength(1);
    expect(maps[0].get("_id")).toBe(firstId);
  });
});

describe("L. ingest key allowlists — unlisted wire keys are never set", () => {
  it("an unknown config key is skipped, not written into the doc", async () => {
    const { doInstance } = makeStatefulDO();
    const res = await ingest(doInstance, {
      ...emptyIngest(),
      config: [
        { key: "navigation", value: "clobber" },
        { key: "theme", value: "trama" },
      ],
    });
    expect(res.body.skipped.config).toContain("navigation");
    expect(res.body.applied.config).toBe(1);
    const configMap = ydocOf(doInstance).getMap<unknown>("config");
    expect(configMap.get("navigation")).toBeUndefined();
    expect(configMap.get("theme")).toBe("trama");
  });

  it("an unlisted object field key is ignored", async () => {
    const { doInstance, rows } = makeStatefulDO();
    seedFlat(doInstance, rows, "objects", 801);
    const objectId = textSentinel("objects", "object_id");
    await ingest(doInstance, {
      ...emptyIngest(),
      objects: {
        update: [{ objectId, fields: { _id: 999999, title: "Kept" } }],
        insert: [],
        remove: [],
      },
    });
    const m = ydocOf(doInstance)
      .getArray<Y.Map<unknown>>("objects")
      .toArray()
      .find((mm) => mm.get("object_id") === objectId)!;
    expect(m.get("_id")).toBe(801);
  });
});
