/**
 * Recovering authorship the D1 snapshot threw away, out of the Yjs document.
 *
 * `created_by` is written once at creation and never on edit, so roughly
 * three-quarters of the steps in the database name nobody. The CRDT kept what
 * the snapshot discarded: every item carries the client that created it, so a
 * `Y.Text` decomposes into runs owned by the editing session that inserted them,
 * and a map key carries the session that last wrote it. Authorship is recorded
 * per character whether or not application code asks for it.
 *
 * Sessions are not accounts, so nothing here is readable until they are paired.
 * The pairing comes from `created_by` itself: that key has both a value (the
 * user id) and an owning client (the session that wrote it), which yields
 * `client -> user`. Every other attribution in this file rests on that map.
 *
 * WHAT THIS CANNOT DO. Wall-clock time is not in the document — items carry
 * logical clocks, which give ordering and never duration. Content deleted before
 * the last garbage collection is gone. And anything created before
 * `0029_add_created_by.sql` whose sessions never wrote a `created_by` anywhere
 * stays unattributed, which is most pre-migration content.
 *
 * EVERY ATTRIBUTION CARRIES ITS BASIS, and callers must keep it. Two of the
 * three routes below are inference rather than record, and a recovered author
 * shown without saying how it was arrived at is a claim the document does not
 * support. Recovering authorship for somebody's coursework and then presenting a
 * guess as a fact is the failure this guards against.
 *
 * Yjs internals are used deliberately and are pinned to 13.6.30: `_map` for a
 * map's key items and `_start`/`right` for a text's item list. There is no
 * public API for per-item ownership, which is the whole substance of the method.
 * A Yjs upgrade must re-verify both.
 *
 * @version v1.5.0-beta
 */

import * as Y from "yjs";

import {
  CONTRIBUTOR_BASES,
  CONTRIBUTOR_ENTITY_KINDS,
} from "~/lib/authorship";
import type { ContributorEntityKind } from "~/lib/authorship";
import { entityMaps, readRowId, readYArray } from "~/lib/value-domains";

/**
 * How an attribution was arrived at. Ordered weakest last, and never dropped:
 * the view must be able to say which of these it is showing.
 */
export type RecoveryBasis =
  /**
   * The session wrote a `created_by` naming this user. A record, not a guess —
   * the document states the pairing.
   */
  | "stated"
  /**
   * INFERENCE. The session never wrote a `created_by`, but everything it touched
   * belongs to entities authored by exactly one user, so it is very likely that
   * person's second device or reloaded tab. Reconnection ran to several hundred
   * per student in the cohort this was built from, so these sessions are
   * numerous and cannot simply be dropped — but this is weaker than `stated` and
   * must be labelled wherever it is surfaced.
   */
  | "sole_editor";

/** One recovered attribution, and how it was reached. */
export interface Attribution {
  userId: number;
  basis: RecoveryBasis;
}

/** The result of pairing editing sessions to accounts. */
export interface SessionMap {
  /** client -> user, for sessions that can be resolved at all. */
  users: Map<number, Attribution>;
  /**
   * Sessions that wrote `created_by` values naming two different users.
   *
   * NOT a shared login. It is a reorder: `reorderInPlace` clones the moved map
   * and copies `created_by` intact, so one session can come to own the
   * `created_by` key of entities several people made. Resolving such a session
   * to either user would attribute one person's writing to another, so it
   * resolves to neither.
   */
  conflicted: Set<number>;
}

/** A Yjs item, as far as this file needs to read one. */
interface ItemLike {
  id: { client: number };
  deleted: boolean;
  content: { getContent(): unknown[] };
  right: ItemLike | null;
}

/** The key items of a Y.Map — Yjs internal, pinned to 13.6.30. */
function keyItems(map: Y.Map<unknown>): Map<string, ItemLike> {
  const internal = map as unknown as { _map?: Map<string, ItemLike> };
  return internal._map ?? new Map();
}

/**
 * The client that last wrote a map key, or null when the key is absent or its
 * item is deleted.
 */
export function keyOwner(map: Y.Map<unknown>, key: string): number | null {
  const item = keyItems(map).get(key);
  if (!item || item.deleted) return null;
  return item.id.client;
}

/**
 * Every client that owns any live part of a map: its keys, and the runs of any
 * `Y.Text` stored under them.
 *
 * This is the participation question at entity level — who wrote in this — and
 * it is deliberately broader than `created_by`, which answers only who made it.
 */
export function clientsTouching(map: Y.Map<unknown>): Set<number> {
  const clients = new Set<number>();
  for (const item of keyItems(map).values()) {
    if (!item.deleted) clients.add(item.id.client);
  }
  for (const value of map.values()) {
    if (value instanceof Y.Text) {
      for (const run of textRuns(value)) clients.add(run.client);
    }
  }
  return clients;
}

/** One run of text and the session that inserted it. */
export interface TextRun {
  client: number;
  text: string;
}

/**
 * Decompose a `Y.Text` into the runs its editing sessions inserted.
 *
 * Deleted items are skipped: they are not in the text a reader sees, and
 * garbage collection will have stripped most of them anyway.
 */
export function textRuns(text: Y.Text): TextRun[] {
  const runs: TextRun[] = [];
  let item = (text as unknown as { _start?: ItemLike | null })._start ?? null;
  while (item) {
    if (!item.deleted) {
      let content: string;
      try {
        content = item.content.getContent().join("");
      } catch {
        content = "";
      }
      if (content.length > 0) runs.push({ client: item.id.client, text: content });
    }
    item = item.right;
  }
  return runs;
}

/**
 * Pair editing sessions with accounts, from the `created_by` keys in the
 * document.
 *
 * `entityMaps` is every entity map in the document, in any order. The caller
 * supplies it because walking the document's shape is the DO's business, not
 * this file's.
 */
export function mapSessionsToUsers(entityMaps: Iterable<Y.Map<unknown>>): SessionMap {
  const stated = new Map<number, number>();
  const conflicted = new Set<number>();

  for (const map of entityMaps) {
    const client = keyOwner(map, "created_by");
    if (client === null) continue;
    const value = map.get("created_by");
    if (typeof value !== "number") continue;

    const held = stated.get(client);
    if (held === undefined) {
      stated.set(client, value);
      continue;
    }
    if (held !== value) conflicted.add(client);
  }

  const users = new Map<number, Attribution>();
  for (const [client, userId] of stated) {
    if (conflicted.has(client)) continue;
    users.set(client, { userId, basis: "stated" });
  }
  return { users, conflicted };
}

/**
 * Resolve the sessions that never wrote a `created_by`, where every entity they
 * touched belongs to one user.
 *
 * INFERENCE, and the weakest thing in this file. A session that only ever wrote
 * into one person's entities is very likely that person on a second device or a
 * reloaded tab; it could also be a collaborator who happened to edit only that
 * person's work. It resolves only when the evidence is unanimous, and it carries
 * `sole_editor` so nothing downstream can mistake it for the document's word.
 *
 * A session touching entities of two different authors is left unresolved rather
 * than assigned to whichever appears more often. A tie broken by frequency is
 * a coin toss wearing a number.
 */
export function resolveSecondarySessions(
  entityMaps: Iterable<Y.Map<unknown>>,
  sessions: SessionMap,
): SessionMap {
  const candidates = new Map<number, Set<number>>();

  for (const map of entityMaps) {
    const owner = keyOwner(map, "created_by");
    const ownerUser = owner === null ? undefined : sessions.users.get(owner)?.userId;
    if (ownerUser === undefined) continue;

    for (const client of clientsTouching(map)) {
      if (sessions.users.has(client) || sessions.conflicted.has(client)) continue;
      let seen = candidates.get(client);
      if (!seen) {
        seen = new Set<number>();
        candidates.set(client, seen);
      }
      seen.add(ownerUser);
    }
  }

  const users = new Map(sessions.users);
  for (const [client, seen] of candidates) {
    if (seen.size !== 1) continue;
    users.set(client, { userId: [...seen][0], basis: "sole_editor" });
  }
  return { users, conflicted: sessions.conflicted };
}

/**
 * Who made this entity, when the D1 row says nobody.
 *
 * Only ever consulted for a row whose `created_by` is null: an entity that
 * states its author needs no recovery, and overwriting a stated author with an
 * inferred one would be a loss dressed as a repair.
 *
 * The document's own `created_by` value wins when it has one — D1 can be null
 * while the document holds a user id, which is how two objects in the cohort
 * were recovered. Failing that, the entity is attributed to the session that
 * wrote its keys, if that session resolves and the keys agree.
 */
export function recoverEntityAuthor(
  map: Y.Map<unknown>,
  sessions: SessionMap,
): Attribution | null {
  const stated = map.get("created_by");
  if (typeof stated === "number") return { userId: stated, basis: "stated" };

  const owners = new Set<number>();
  for (const item of keyItems(map).values()) {
    if (!item.deleted) owners.add(item.id.client);
  }

  const users = new Set<number>();
  let basis: RecoveryBasis = "stated";
  for (const client of owners) {
    const attribution = sessions.users.get(client);
    if (!attribution) continue;
    users.add(attribution.userId);
    if (attribution.basis === "sole_editor") basis = "sole_editor";
  }

  // Unanimity or nothing. An entity whose keys were written by sessions
  // belonging to two people has no single maker, and naming one of them is
  // exactly the misattribution this whole exercise exists to avoid.
  if (users.size !== 1) return null;
  return { userId: [...users][0], basis };
}

/**
 * Everyone who wrote in this entity, with the weakest basis any of them rests on.
 *
 * The participation measure, recovered for content that predates the
 * `entity_contributors` table. Without it a contributions view knows only about
 * editing done after this shipped, and every project already in the database
 * reads as though nobody had worked on it.
 */
export function recoverEntityContributors(
  map: Y.Map<unknown>,
  sessions: SessionMap,
): Map<number, RecoveryBasis> {
  const contributors = new Map<number, RecoveryBasis>();
  for (const client of clientsTouching(map)) {
    const attribution = sessions.users.get(client);
    if (!attribution) continue;
    const held = contributors.get(attribution.userId);
    // `stated` beats `sole_editor`: if any of a person's sessions is pinned to
    // them by the document, their presence here is recorded rather than guessed.
    if (held === undefined || (held === "sole_editor" && attribution.basis === "stated")) {
      contributors.set(attribution.userId, attribution.basis);
    }
  }
  return contributors;
}

/* ------------------------------------------------------------------ *
 * Planning a recovery
 * ------------------------------------------------------------------ */

/** One statement the recovery would run, as SQL and its bindings. */
export interface RecoveryStatement {
  sql: string;
  binds: unknown[];
}

/** What planning a recovery over one project's document found. */
export interface RecoveryOutcome {
  projectId: number;
  /** Editing sessions paired to an account, by either route. */
  sessionsResolved: number;
  /**
   * Sessions that stated two different users and so resolve to neither. These
   * are reorders, not shared logins — `reorderInPlace` clones a moved map and
   * copies `created_by` intact. A number here is expected, not alarming.
   */
  sessionsConflicted: number;
  /** Entities that would be given a `created_by`. Stated attributions only. */
  authorsRecovered: number;
  contributorsStated: number;
  /** Contributors resting on sole-editor inference. Labelled in the row. */
  contributorsInferred: number;
}

/** The D1 table each entity kind lives in. */
const TABLE_BY_KIND: Record<ContributorEntityKind, string> = {
  story: "stories",
  step: "steps",
  layer: "layers",
  object: "objects",
  term: "glossary_terms",
  page: "project_pages",
};

/**
 * Every entity in a document that D1 has a row for, by kind, with that row's id.
 *
 * Entities with no `_id` are skipped: they exist only in the document, so there
 * is no row to write authorship onto. The next snapshot inserts them and a later
 * run picks them up.
 */
function entitiesByKind(
  doc: Y.Doc,
): Map<ContributorEntityKind, Array<{ map: Y.Map<unknown>; id: number }>> {
  const byKind = new Map<ContributorEntityKind, Array<{ map: Y.Map<unknown>; id: number }>>();
  const add = (kind: ContributorEntityKind, map: Y.Map<unknown>): void => {
    const read = readRowId(map.get("_id"));
    if (!read.ok || read.value === null) return;
    let entries = byKind.get(kind);
    if (!entries) {
      entries = [];
      byKind.set(kind, entries);
    }
    entries.push({ map, id: read.value });
  };

  for (const story of entityMaps(doc.getArray<unknown>("stories")).maps) {
    add(CONTRIBUTOR_ENTITY_KINDS.story, story);
    const steps = readYArray(story.get("steps"));
    if (!steps.ok || steps.value === null) continue;
    for (const step of entityMaps(steps.value).maps) {
      add(CONTRIBUTOR_ENTITY_KINDS.step, step);
      const layers = readYArray(step.get("layers"));
      if (!layers.ok || layers.value === null) continue;
      for (const layer of entityMaps(layers.value).maps) {
        add(CONTRIBUTOR_ENTITY_KINDS.layer, layer);
      }
    }
  }
  for (const [root, kind] of [
    ["objects", CONTRIBUTOR_ENTITY_KINDS.object],
    ["glossary", CONTRIBUTOR_ENTITY_KINDS.term],
    ["pages", CONTRIBUTOR_ENTITY_KINDS.page],
  ] as const) {
    for (const map of entityMaps(doc.getArray<unknown>(root)).maps) add(kind, map);
  }
  return byKind;
}

/**
 * Work out what a project's recovery would write, without writing anything.
 *
 * PURE, and that is the point. It returns SQL and bindings for an operator to
 * read before any of it runs, so a backfill over user data is something you can
 * inspect and diff rather than something you trigger and hope about.
 *
 * Two claims, held to two different standards.
 *
 * `created_by` — who MADE an entity — is only ever written from a STATED
 * attribution: one where the document pins the editing session to an account
 * because that session wrote a `created_by` naming it. An inference never
 * becomes a maker claim. Every such UPDATE carries `AND created_by IS NULL`, so
 * a real author already in D1 cannot be overwritten by anything here; the
 * guarantee is in the SQL rather than in a caller remembering.
 *
 * `entity_contributors` — who WROTE IN an entity — accepts both routes and
 * records which. Its UPSERT can never downgrade a live observation to a
 * recovery.
 *
 * Idempotent. Re-running writes the same rows: the created_by UPDATEs stop
 * matching once filled, and the contributor rows are UPSERTs.
 *
 * The document must have had its roots claimed (`getArray`/`getMap`) before it
 * arrives here, or every traversal silently returns nothing.
 */
export function planAuthorshipRecovery(
  doc: Y.Doc,
  projectId: number,
  recoveredAt: string,
): { outcome: RecoveryOutcome; statements: RecoveryStatement[] } {
  const byKind = entitiesByKind(doc);
  const everyMap = [...byKind.values()].flatMap((entries) => entries.map((e) => e.map));

  // Pair sessions to accounts, then resolve second devices and reloaded tabs
  // against what that first pass established. The order matters: the inference
  // has nothing to work from until the stated pairings exist.
  const sessions = resolveSecondarySessions(everyMap, mapSessionsToUsers(everyMap));

  const statements: RecoveryStatement[] = [];
  const outcome: RecoveryOutcome = {
    projectId,
    sessionsResolved: sessions.users.size,
    sessionsConflicted: sessions.conflicted.size,
    authorsRecovered: 0,
    contributorsStated: 0,
    contributorsInferred: 0,
  };

  for (const [kind, entries] of byKind) {
    const table = TABLE_BY_KIND[kind];
    for (const { map, id } of entries) {
      const author = recoverEntityAuthor(map, sessions);
      if (author && author.basis === "stated") {
        statements.push({
          sql: `UPDATE ${table} SET created_by = ? WHERE id = ? AND created_by IS NULL`,
          binds: [author.userId, id],
        });
        outcome.authorsRecovered += 1;
      }

      for (const [userId, basis] of recoverEntityContributors(map, sessions)) {
        if (basis === "stated") outcome.contributorsStated += 1;
        else outcome.contributorsInferred += 1;
        statements.push({
          sql:
            "INSERT INTO entity_contributors " +
            "(project_id, entity_kind, entity_id, user_id, first_edit_at, last_edit_at, basis) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT (project_id, entity_kind, entity_id, user_id) DO UPDATE SET " +
            // A live observation outranks a recovery and is never downgraded by
            // one: the Durable Object saw that edit arrive on an authenticated
            // socket, and this is reading a document after the fact.
            "basis = CASE WHEN entity_contributors.basis IS NULL " +
            "THEN NULL ELSE excluded.basis END",
          binds: [
            projectId,
            kind,
            id,
            userId,
            // The document carries logical clocks, which give ordering and never
            // duration, so there is no honest wall-clock answer to when a
            // recovered contribution happened. Stamping the moment of the
            // recovery would put today's date on work done months ago.
            null,
            null,
            basis === "stated"
              ? CONTRIBUTOR_BASES.recoveredStated
              : CONTRIBUTOR_BASES.recoveredInferred,
          ],
        });
      }
    }
  }

  // Marked last, so it is applied only after everything above it in the same
  // file has been. A run interrupted part way leaves the project unmarked and
  // the next pass picks it up — and re-running is harmless anyway.
  statements.push({
    sql: "UPDATE projects SET authorship_recovered_at = ? WHERE id = ?",
    binds: [recoveredAt, projectId],
  });

  return { outcome, statements };
}

/**
 * Render planned statements as SQL a `wrangler d1 execute --file` can apply.
 *
 * Bindings are inlined because `--file` takes SQL and not parameters, which is
 * the one genuinely risky thing this module does. Every value a plan produces is
 * a row id, a NULL, or one of a handful of fixed vocabulary strings this
 * codebase defines — never user text, never a title or a slug — but each is
 * checked against that expectation rather than trusted, and anything else
 * THROWS rather than being escaped and let through.
 *
 * Refusing is the right failure. A value that reaches here and is not one of
 * those things means the plan has changed shape, and quietly quoting it would
 * turn a bug in the planner into SQL written against somebody's database.
 */
export function renderRecoverySql(statements: RecoveryStatement[]): string {
  return statements
    .map(({ sql, binds }) => {
      let i = 0;
      const filled = sql.replace(/\?/g, () => inlineLiteral(binds[i++]));
      if (i !== binds.length) {
        throw new Error(`placeholder count ${i} does not match ${binds.length} bindings`);
      }
      return `${filled};`;
    })
    .join("\n");
}

/** One bound value as a SQL literal, or a throw. See `renderRecoverySql`. */
function inlineLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    // Integer row ids only. A float, a NaN or an Infinity is not something the
    // planner produces, so it means something upstream is wrong.
    if (!Number.isInteger(value)) throw new Error(`refusing to inline ${String(value)}`);
    return String(value);
  }
  if (typeof value === "string") {
    // Two shapes, both narrow enough that no escaping question arises: the fixed
    // vocabularies (entity kinds, recovery bases) as lowercase words, and the
    // ISO instant the done-marker carries. Neither can contain a quote.
    //
    // The timestamp arm exists because the first end-to-end render threw on it —
    // the planner produced a value the renderer had not been told about, which
    // is precisely the disagreement a whole-plan test is for and precisely what
    // would otherwise have failed on the first real run.
    const isVocabulary = /^[a-z_]+$/.test(value);
    const isIsoInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
    if (!isVocabulary && !isIsoInstant) {
      throw new Error(`refusing to inline an unexpected string: ${JSON.stringify(value)}`);
    }
    return `'${value}'`;
  }
  throw new Error(`refusing to inline a value of type ${typeof value}`);
}
