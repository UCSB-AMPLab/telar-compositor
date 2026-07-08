/**
 * Shared fixtures for the registry-driven sync probes. Extracted from
 * field-registry-sync-probes.test.ts so both the base-diff probes and the
 * three-way probes can iterate the same registry-derived families and build
 * the same repo/D1 sentinel pairs without duplicating a single helper body.
 * Pure data builders and mock-DB factories only — no describe/it, no github
 * mock (each test file owns its own vi.mock).
 *
 * @version v1.4.1-beta
 */

import { vi } from "vitest";
import { getEntity, type FieldDecl } from "../app/lib/field-registry";
import type { ThreeWaySelections } from "../app/components/features/dashboard/SyncConfirmModal";

export type MockDb = ReturnType<typeof import("~/lib/db.server").getDb>;

// ---------------------------------------------------------------------------
// Mock DB factories — sequence-based / tracked (copied from the established
// pattern in tests/sync.server.test.ts; each awaited terminal consumes one
// queued response in order).
// ---------------------------------------------------------------------------

export function probeSequentialMockDb(responses: unknown[]): MockDb {
  let callIndex = 0;

  function makeResult() {
    const data = responses[callIndex] ?? [];
    callIndex++;
    return Promise.resolve(data);
  }

  const db: Record<string, unknown> = {};

  function terminal(fn?: () => unknown) {
    return Object.assign(
      {
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
          try {
            return Promise.resolve(fn ? fn() : makeResult()).then(resolve, reject);
          } catch (e) {
            return Promise.reject(e);
          }
        },
      },
      db,
    );
  }

  db.select = vi.fn(() => terminal());
  db.from = vi.fn(() => terminal());
  db.where = vi.fn(() => terminal());
  db.limit = vi.fn(() => terminal());
  db.orderBy = vi.fn(() => terminal());
  db.update = vi.fn(() => terminal());
  db.set = vi.fn(() => terminal());
  db.insert = vi.fn(() => terminal());
  db.values = vi.fn(() => terminal());
  db.delete = vi.fn(() => terminal());

  return db as unknown as MockDb;
}

export function createTrackedMockDb({
  responses = [] as unknown[],
  onInsert = (_table: unknown, _vals: unknown) => {},
  onUpdate = (_table: unknown, _set: unknown) => {},
}: {
  responses?: unknown[];
  onInsert?: (table: unknown, vals: unknown) => void;
  onUpdate?: (table: unknown, set: unknown) => void;
} = {}): MockDb {
  let callIndex = 0;
  let currentInsertTable: unknown = null;
  let currentUpdateTable: unknown = null;
  let pendingSet: unknown = null;

  function makeResult() {
    const data = responses[callIndex] ?? [];
    callIndex++;
    return Promise.resolve(data);
  }

  const db: Record<string, unknown> = {};

  function terminal(fn?: () => unknown) {
    return Object.assign(
      {
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
          try {
            return Promise.resolve(fn ? fn() : makeResult()).then(resolve, reject);
          } catch (e) {
            return Promise.reject(e);
          }
        },
      },
      db,
    );
  }

  db.select = vi.fn(() => terminal());
  db.from = vi.fn(() => terminal());
  db.where = vi.fn(() =>
    terminal(() => {
      if (pendingSet !== null) {
        onUpdate(currentUpdateTable, pendingSet);
        pendingSet = null;
      }
      return makeResult();
    }),
  );
  db.limit = vi.fn(() => terminal());
  db.orderBy = vi.fn(() => terminal());
  db.update = vi.fn((table: unknown) => {
    currentUpdateTable = table;
    return terminal();
  });
  db.set = vi.fn((vals: unknown) => {
    pendingSet = vals;
    return terminal();
  });
  db.insert = vi.fn((table: unknown) => {
    currentInsertTable = table;
    return terminal();
  });
  db.values = vi.fn((vals: unknown) => {
    onInsert(currentInsertTable, vals);
    return terminal();
  });
  db.delete = vi.fn(() => terminal());

  return db as unknown as MockDb;
}

// ---------------------------------------------------------------------------
// Registry-derived field families
// ---------------------------------------------------------------------------

export type ParticipatingSync = Extract<FieldDecl["sync"], { diff: unknown }>;

export function syncOf(f: FieldDecl): ParticipatingSync | null {
  return "diff" in f.sync ? f.sync : null;
}

/** Non-key fields of an entity participating in the given diff family. */
export function syncFamily(
  entity: Parameters<typeof getEntity>[0],
  diff: ParticipatingSync["diff"],
): FieldDecl[] {
  return getEntity(entity).fields.filter((f) => {
    const s = syncOf(f);
    return s !== null && s.diff === diff && s.role !== "key";
  });
}

export const objectSyncFields = syncFamily("objects", "objects");
export const storySyncFields = syncFamily("stories", "storyFields");
export const configSyncFields = syncFamily("config", "config");
export const glossarySyncFields = syncFamily("glossary", "glossary");

export const PROJECT_ID = 1;
export const TOKEN = "test-token";
export const OWNER = "test-owner";
export const REPO = "test-repo";

// ---------------------------------------------------------------------------
// Fixture builders — one sentinel pair per field; everything else identical
// on both sides so exactly one field differs per probe.
// ---------------------------------------------------------------------------

// --- objects ---------------------------------------------------------------

/** CSV header for an objects sync field: the registry's publish key (e.g.
 * `medium_genre` for object_type). extra_columns is structural
 * (json-spread-columns) — probed through a single custom column. */
export function objectCsvHeader(f: FieldDecl): string {
  if (f.name === "extra_columns") return "accession_number";
  if ("excluded" in f.publish) throw new Error(`${f.name}: sync field with no publish key`);
  return f.publish.key;
}

export function objectBaseCell(name: string): string {
  if (name === "featured") return ""; // yes-empty encoding: false
  if (name === "extra_columns") return "ACC-BASE";
  return `base-${name}`;
}

export function objectMutatedCell(name: string): string {
  if (name === "featured") return "yes"; // yes-empty encoding: true
  if (name === "extra_columns") return "ACC-MUT";
  return `repo-${name}`;
}

export function probeObjectsCsv(mutatedField?: string): string {
  const headers = ["object_id", ...objectSyncFields.map(objectCsvHeader)];
  const cells = [
    "obj-1",
    ...objectSyncFields.map((f) =>
      f.name === mutatedField ? objectMutatedCell(f.name) : objectBaseCell(f.name),
    ),
  ];
  return [headers.join(","), cells.join(",")].join("\n");
}

export function d1ObjectRow(): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: 1,
    project_id: PROJECT_ID,
    object_id: "obj-1",
    origin: "repo",
    missing_from_repo: false,
    image_available: true,
    updated_at: null,
  };
  for (const f of objectSyncFields) {
    if (f.name === "featured") row.featured = false;
    else if (f.name === "extra_columns")
      row.extra_columns = JSON.stringify({ accession_number: "ACC-BASE" });
    else row[f.name] = `base-${f.name}`;
  }
  return row;
}

/** Expected repo-side value as reported by the diff / written by apply. */
export function expectedObjectRepoValue(name: string): unknown {
  if (name === "featured") return true;
  if (name === "extra_columns") return JSON.stringify({ accession_number: "ACC-MUT" });
  return `repo-${name}`;
}

// --- stories ---------------------------------------------------------------

export function storyCsvHeader(f: FieldDecl): string {
  if ("excluded" in f.publish) throw new Error(`${f.name}: sync field with no publish key`);
  return f.publish.key;
}

export function storyBaseCell(name: string): string {
  if (name === "private" || name === "show_sections") return ""; // yes-empty: false
  return `base-${name}`;
}

export function storyMutatedCell(name: string): string {
  if (name === "private" || name === "show_sections") return "yes";
  return `repo-${name}`;
}

export function projectCsv(mutatedField?: string): string {
  const headers = ["order", "story_id", ...storySyncFields.map(storyCsvHeader)];
  const cells = [
    "1",
    "my-story",
    ...storySyncFields.map((f) =>
      f.name === mutatedField ? storyMutatedCell(f.name) : storyBaseCell(f.name),
    ),
  ];
  return [headers.join(","), cells.join(",")].join("\n");
}

export function d1StoryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: 1,
    project_id: PROJECT_ID,
    story_id: "my-story",
    order: 1,
    draft: false,
    updated_at: null,
  };
  for (const f of storySyncFields) {
    if (f.name === "private" || f.name === "show_sections") row[f.name] = false;
    else row[f.name] = `base-${f.name}`;
  }
  return { ...row, ...overrides };
}

// --- config ----------------------------------------------------------------

/**
 * The _config.yml key for a config sync field: the registry's declared
 * yamlKey (telar_language, telar_theme) or the canonical name. story_key is
 * emitted as the top-level legacy line here — a shape the reader explicitly
 * supports as a fallback (the nested protected.key precedence has its own
 * dedicated tests in sync.server.test.ts).
 */
export function configYamlKey(f: FieldDecl): string {
  const s = syncOf(f);
  return s?.yamlKey ?? f.name;
}

/**
 * The scalar TYPE of a config field's YAML value, derived from its declared
 * publish encoding so the fixtures below stay registry-driven: unquoted-bool
 * fields probe false -> true, unquoted-int fields 4 -> 7, everything else a
 * base-/repo- string pair.
 */
export function configValueKind(f: FieldDecl): "bool" | "int" | "string" {
  const pub = f.publish;
  if (!("excluded" in pub)) {
    if (pub.encoding === "unquoted-bool") return "bool";
    if (pub.encoding === "unquoted-int") return "int";
  }
  return "string";
}

export function configBaseValue(f: FieldDecl): string {
  const kind = configValueKind(f);
  if (kind === "bool") return "false";
  if (kind === "int") return "4";
  return `base-${f.name}`;
}

export function configMutatedValue(f: FieldDecl): string {
  const kind = configValueKind(f);
  if (kind === "bool") return "true";
  if (kind === "int") return "7";
  return `repo-${f.name}`;
}

/**
 * Emits the sync fields as a real _config.yml shape: top-level scalars as
 * top-level lines, dotted yamlKeys (story_interface.* / collection_interface.*)
 * grouped into their nested blocks — the shape the block-aware reader parses.
 */
export function configYml(mutatedField?: string): string {
  const topLevel: string[] = [];
  const blocks = new Map<string, string[]>();
  for (const f of configSyncFields) {
    const key = configYamlKey(f);
    const value = f.name === mutatedField ? configMutatedValue(f) : configBaseValue(f);
    const dot = key.indexOf(".");
    if (dot === -1) {
      topLevel.push(`${key}: ${value}`);
    } else {
      const block = key.slice(0, dot);
      const child = key.slice(dot + 1);
      const children = blocks.get(block) ?? [];
      children.push(`  ${child}: ${value}`);
      blocks.set(block, children);
    }
  }
  const blockLines = [...blocks.entries()].flatMap(([block, children]) => [
    `${block}:`,
    ...children,
  ]);
  return [...topLevel, ...blockLines].join("\n");
}

export function d1ConfigRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const row: Record<string, unknown> = { id: 1, project_id: PROJECT_ID };
  for (const f of configSyncFields) {
    const kind = configValueKind(f);
    if (kind === "bool") row[f.name] = false; // real D1 boolean
    else if (kind === "int") row[f.name] = 4; // real D1 number
    else row[f.name] = `base-${f.name}`;
  }
  return { ...row, ...overrides };
}

// --- glossary ----------------------------------------------------------------

export function glossaryCsv(mutatedField?: string): string {
  const headers = ["term_id", ...glossarySyncFields.map((f) => f.name)];
  const cells = [
    "enc",
    ...glossarySyncFields.map((f) =>
      f.name === mutatedField ? `repo-${f.name}` : `base-${f.name}`,
    ),
  ];
  return [headers.join(","), cells.join(",")].join("\n");
}

export function d1GlossaryRow(): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: 1,
    project_id: PROJECT_ID,
    term_id: "enc",
    updated_at: null,
  };
  for (const f of glossarySyncFields) row[f.name] = `base-${f.name}`;
  return row;
}

/** "related_terms" -> "RelatedTerms" (the GlossarySyncDiff changed-item key stem). */
export function pascalCase(name: string): string {
  return name
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

/**
 * An all-empty ThreeWaySelections (every conflict defaults to keep-mine /
 * keep-deleted). Shared by the modal-builder and apply-seam pins so neither
 * re-declares the shape (avoids duplicate helper bodies).
 */
export function emptyThreeWaySelections(): ThreeWaySelections {
  return {
    objectFieldChoices: {},
    objectRestore: {},
    objectDelete: {},
    storyChoices: {},
    storyRestore: {},
    configChoices: {},
    glossaryChangedChoices: {},
    glossaryRestore: {},
  };
}

// Shared by the resolve-payload probes and the action-side L-bug pins below.
export const emptyChanges = () => ({
  objects: {
    newObjectIds: [] as string[],
    changedObjectIds: [] as string[],
    fieldChoices: {} as Record<string, Record<string, "repo" | "d1">>,
    removedObjectIds: [] as string[],
    unregisteredObjectIds: [] as string[],
  },
  stories: { accept: [] as string[], reject: [] as string[], insertNew: [] as string[] },
  config: { accept: [] as string[], reject: [] as string[] },
  glossary: { accept: [] as string[], reject: [] as string[], insertNew: [] as string[] },
});
