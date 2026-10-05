/**
 * A loaded collaboration-DO fixture: D1 seeded through the repository's own
 * migration chain, a Y.Doc built from the field registry and applied to it,
 * and the sequence — load, plant, snapshot — that drives one round through
 * `ProjectCollaborationDO`.
 *
 * The registry is the source of the prose field lists: `proseFields` reads
 * `YDOC_FIELDS`, so an entity whose declared kind changes moves here too and
 * cannot be pinned to a stale list. `buildDoc` seeds every prose key with a
 * healthy `Y.Text`; a case that wants a different value plants it into the
 * live document after `loadProject`, which models the shape of the threat
 * this fixture is built for — a collaborator writing into an open document,
 * not a blob arriving already malformed.
 *
 * The database is the repository's own migration chain in memory, not a
 * statement recorder: a caller reading a claim about what D1 HOLDS after a
 * batch needs the row surviving the statement, not just the bind it saw.
 *
 * @version v1.5.0-beta
 */

import { vi } from "vitest";
import * as Y from "yjs";
import { ProjectCollaborationDO } from "../../workers/collaboration";
import { asD1, type MemoryD1 } from "./d1-memory";
import { YDOC_FIELDS, type EntityDecl } from "~/lib/field-registry";

export const PROJECT_ID = 1;
export const SECRET = "test-session-secret";

/** The seven prose-bearing entities: every registry entity but config. */
export type ProseEntity = Exclude<EntityDecl["entity"], "config">;

/** Where each entity's single Y.Map lives in a built document. */
export type DocMaps = Record<ProseEntity, Y.Map<unknown>>;

/** The prose fields one entity declares: Y.Doc key and the column it binds. */
export function proseFields(entity: EntityDecl["entity"]): Array<{ key: string; column: string }> {
  return YDOC_FIELDS[entity]
    .filter((f) => f.kind === "ytext" && f.column !== null)
    .map((f) => ({ key: f.key, column: f.column as string }));
}

/**
 * `project_pages.title` is NOT NULL (`app/db/schema.ts`), so it has no
 * null-starting-column case and no null bind can ever reach it. The INSERT
 * rule exists for exactly this column.
 */
export const NOT_NULL_COLUMNS = new Set(["pages.title"]);

/** The text each prose column is seeded with — distinct, so a swap shows. */
export function seededText(entity: string, key: string): string {
  return `${entity}.${key} as D1 holds it`;
}

function makeCtx() {
  return {
    getWebSockets: () => [] as unknown[],
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => { /* no-op */ },
      get: async (key: string) => (key === "docGeneration" ? 0 : undefined),
      put: async () => {},
      list: async () => new Map(),
      delete: async () => 0,
    },
    acceptWebSocket: vi.fn(),
  };
}

type Populate = "text" | "null";

/**
 * A project whose seven entity rows exist, each prose column either carrying
 * its seeded text or NULL.
 */
export function seedProject(memory: MemoryD1, populate: Populate): void {
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
    "VALUES (1, 1, 'u', 'e', 'e', '2099-01-01', '2099-01-01')",
  );
  memory.raw.exec(
    "INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (1, 1, 'o/a', 1)",
  );
  memory.raw.exec("INSERT INTO project_config (project_id) VALUES (1)");

  const value = (entity: string, key: string): string | null =>
    populate === "text" || NOT_NULL_COLUMNS.has(`${entity}.${key}`)
      ? seededText(entity, key)
      : null;

  const v = (entity: string) => (key: string) => value(entity, key);
  const s = v("stories");
  const st = v("steps");
  const l = v("layers");
  const o = v("objects");
  const g = v("glossary");
  const p = v("pages");
  const la = v("landing");

  memory.raw
    .prepare('INSERT INTO stories (id, project_id, story_id, title, subtitle, byline, "order", order_key) VALUES (1, ?, ?, ?, ?, ?, 0, ?)')
    .run(PROJECT_ID, "s1", s("title"), s("subtitle"), s("byline"), "a00001");
  memory.raw
    .prepare("INSERT INTO steps (id, story_id, step_number, order_key, kind, question, answer, alt_text) VALUES (1, 1, 1, ?, 'media', ?, ?, ?)")
    .run("a00001", st("question"), st("answer"), st("alt_text"));
  memory.raw
    .prepare("INSERT INTO layers (id, step_id, layer_number, order_key, title, button_label, content) VALUES (1, 1, 1, ?, ?, ?, ?)")
    .run("a00001", l("title"), l("button_label"), l("content"));
  memory.raw
    .prepare(
      "INSERT INTO objects (id, project_id, object_id, order_key, title, creator, description, period, year, object_type, subjects, source, credit, alt_text) " +
      "VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      PROJECT_ID, "o1", "a00001",
      o("title"), o("creator"), o("description"), o("period"), o("year"),
      o("object_type"), o("subjects"), o("source"), o("credit"), o("alt_text"),
    );
  memory.raw
    .prepare("INSERT INTO glossary_terms (id, project_id, term_id, order_key, title, definition) VALUES (1, ?, ?, ?, ?, ?)")
    .run(PROJECT_ID, "t1", "a00001", g("title"), g("definition"));
  memory.raw
    .prepare('INSERT INTO project_pages (id, project_id, slug, "order", order_key, title, body) VALUES (1, ?, ?, 0, ?, ?, ?)')
    .run(PROJECT_ID, "p1", "a00001", p("title"), p("body"));
  memory.raw
    .prepare(
      "INSERT INTO project_landing (project_id, stories_heading, stories_intro, objects_heading, objects_intro, welcome_body) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      PROJECT_ID, la("stories_heading"), la("stories_intro"),
      la("objects_heading"), la("objects_intro"), la("welcome_body"),
    );
}

/**
 * A project with no entity rows at all. Every Y.Map carries a null `_id`, so
 * each pipeline takes its INSERT branch. There is no populated/NULL axis
 * here: an INSERT has no starting column.
 */
export function seedEmptyProject(memory: MemoryD1): void {
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
    "VALUES (1, 1, 'u', 'e', 'e', '2099-01-01', '2099-01-01')",
  );
  memory.raw.exec(
    "INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (1, 1, 'o/a', 1)",
  );
  memory.raw.exec("INSERT INTO project_config (project_id) VALUES (1)");
}

/**
 * One entity of each kind, each carrying the `_id` of the seeded row (or none,
 * for the INSERT cases), and every prose key holding a healthy `Y.Text`.
 */
export function buildDoc(withIds: boolean): Uint8Array {
  const doc = new Y.Doc();
  const id = (n: number) => (withIds ? n : null);
  const prose = (entity: EntityDecl["entity"], map: Y.Map<unknown>) => {
    for (const { key } of proseFields(entity)) map.set(key, new Y.Text(`doc ${entity}.${key}`));
  };

  doc.transact(() => {
    const layer = new Y.Map<unknown>();
    layer.set("_id", id(1));
    layer.set("order_key", "a00001");
    prose("layers", layer);

    const layers = new Y.Array<unknown>();
    layers.push([layer]);

    const step = new Y.Map<unknown>();
    step.set("_id", id(1));
    step.set("order_key", "a00001");
    step.set("kind", "media");
    step.set("layers", layers);
    prose("steps", step);

    const steps = new Y.Array<unknown>();
    steps.push([step]);

    const story = new Y.Map<unknown>();
    story.set("_id", id(1));
    story.set("story_id", "s1");
    story.set("order_key", "a00001");
    story.set("steps", steps);
    prose("stories", story);
    doc.getArray<unknown>("stories").push([story]);

    const object = new Y.Map<unknown>();
    object.set("_id", id(1));
    object.set("object_id", "o1");
    object.set("order_key", "a00001");
    object.set("_validation_state", "valid");
    prose("objects", object);
    doc.getArray<unknown>("objects").push([object]);

    const term = new Y.Map<unknown>();
    term.set("_id", id(1));
    term.set("term_id", withIds ? "t1" : "");
    term.set("order_key", "a00001");
    prose("glossary", term);
    doc.getArray<unknown>("glossary").push([term]);

    const page = new Y.Map<unknown>();
    page.set("_id", id(1));
    page.set("slug", withIds ? "p1" : "p-new");
    page.set("order_key", "a00001");
    prose("pages", page);
    doc.getArray<unknown>("pages").push([page]);

    const landing = new Y.Map<unknown>();
    prose("landing", landing);
    doc.getMap<unknown>("config").set("landing", landing);
  });
  return Y.encodeStateAsUpdate(doc);
}

/** The one Y.Map of each kind in a loaded document. */
export function locate(doc: Y.Doc): DocMaps {
  const stories = doc.getArray<Y.Map<unknown>>("stories").get(0);
  const steps = (stories.get("steps") as Y.Array<Y.Map<unknown>>).get(0);
  const layers = (steps.get("layers") as Y.Array<Y.Map<unknown>>).get(0);
  return {
    stories,
    steps,
    layers,
    objects: doc.getArray<Y.Map<unknown>>("objects").get(0),
    glossary: doc.getArray<Y.Map<unknown>>("glossary").get(0),
    pages: doc.getArray<Y.Map<unknown>>("pages").get(0),
    landing: doc.getMap<unknown>("config").get("landing") as Y.Map<unknown>,
  };
}

/**
 * A loaded project: the blob applied, the post-load repairs run, and nothing
 * snapshotted yet.
 *
 * The plant goes into the LIVE document rather than into the blob, because a
 * load-path behaviour would otherwise eat it before the snapshot ever saw it:
 * `backfillBlobGaps` replaces a non-`Y.Text` at `object_type`, `subjects`,
 * `source` and `credit` with a fresh one built from D1. Planting after the load
 * is also the shape of the threat: a collaborator writes the value into an
 * open document. One case builds the plant into the blob instead of the live
 * document, which is what puts the value in front of the word baseline's walk.
 */
export async function loadProject(
  memory: MemoryD1,
  blob: Uint8Array,
): Promise<{ doInstance: ProjectCollaborationDO; maps: DocMaps }> {
  memory.raw.prepare("UPDATE projects SET yjs_state = ? WHERE id = ?").run(blob, PROJECT_ID);
  const doInstance = new ProjectCollaborationDO(
    makeCtx() as unknown as DurableObjectState,
    { DB: asD1(memory), SESSION_SECRET: SECRET, COLLABORATION: {} as unknown } as unknown as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = PROJECT_ID;
  await (doInstance as unknown as { ensureDocLoaded: () => Promise<void> }).ensureDocLoaded();
  return { doInstance, maps: locate((doInstance as unknown as { ydoc: Y.Doc }).ydoc) };
}

/**
 * Write `edit` into the open document under a null origin, which is what the
 * load-path repairs use: it attributes nothing, so no activity row and no
 * contribution credit is generated for the plant. Attribution reads the same
 * keys through the total render and is not part of what this helper does.
 */
export function plant(doInstance: ProjectCollaborationDO, maps: DocMaps, edit: (maps: DocMaps) => void): void {
  const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
  ydoc.transact(() => { edit(maps); }, null);
}

export function snapshot(doInstance: ProjectCollaborationDO): Promise<void> {
  return (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();
}

/** Load, plant, snapshot — the sequence a fixture case runs. */
export async function loadPlantSnapshot(
  memory: MemoryD1,
  blob: Uint8Array,
  edit: (maps: DocMaps) => void,
): Promise<ProjectCollaborationDO> {
  const { doInstance, maps } = await loadProject(memory, blob);
  plant(doInstance, maps, edit);
  await snapshot(doInstance);
  return doInstance;
}
