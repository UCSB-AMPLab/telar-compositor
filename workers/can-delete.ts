/**
 * can-delete.ts — server-side enforcement of the `canDelete` rule for
 * collaborative Yjs operations.
 *
 * Mirrors the client-side gate at `app/hooks/use-structural-ops.ts:153-156`:
 *
 *     const canDelete = (yMap) =>
 *       role === "convenor" || yMap.get("created_by") === currentUserId;
 *
 * Approach (b) — post-apply observe + revert:
 *   - A second `afterTransaction` handler sits alongside the contribution
 *     tracker on the same Y.Doc.
 *   - Walks `tr.deleteSet`, identifies deleted Y.Maps embedded in protected
 *     Y.Arrays, and reverts deletes where `created_by !== userId` for
 *     non-convenor origins.
 *   - Re-entrancy guard prevents the revert transaction from re-triggering
 *     itself; cascade detection folds a deleted parent's children into the
 *     parent's single decision. There is no reorder carve-out: every list
 *     moves an entry by writing its `order_key` (app/lib/field-order.ts), so
 *     an honest reorder issues no delete for this rule to see.
 *
 * Course-item protection is a second, independent pass. An object Y.Map
 * carrying `course_project_id` may not be deleted by anyone — convenor and
 * instructor included — while the marker is set. It is marker-based and
 * role-independent, so it cannot live inside the collaborator own-content
 * path, which the convenor never reaches.
 *
 * Row identity is a third pass, and the only one that is unconditional:
 * identity is minted by the Durable Object alone, so no client-origin
 * transaction may change an identity key on a Y.Map that existed before that
 * transaction. Deleting is not the only way to destroy content — a slug
 * rewritten onto a neighbour's makes the DO's own pre-snapshot dedupe do the
 * destroying — so the delete passes are not sufficient on their own. See
 * `DO_OWNED_IDENTITY_KEYS_BY_ROOT` for the key table and its carve-outs, and
 * `readKeyBeforeTransaction` for why this one needs no `Y.snapshot` and so can
 * run on every transaction rather than the ones a conditional snapshot covers.
 *
 * Born identity is a fourth pass, for the one shape the third cannot reach: a
 * map created inside the transaction has no pre-transaction value to compare,
 * so a forgery inserted beside a victim carrying the victim's `_id` passes
 * every rule above and lets the DO's own dedupe do the destroying, with no
 * delete issued anywhere. `extractBornIdentityClaims` refuses that one claim
 * and the sweep removes the inserted map.
 *
 * Value domains are a fifth pass, and the one the other identity rules rest on.
 * Every server-side reconciliation key is read by RENDERING whatever the
 * document holds, so a `Y.Text`, a plain array, a plain object or a
 * subdocument standing at a key renders to a colleague's key and is that key
 * as far as reconciliation is concerned — and its contents can then be changed
 * without the entity map appearing in `tr.changed` at all, which is what put
 * this beyond the passes above. `extractIdentityDomainViolations` holds an
 * exact per-key allow-list of value shapes, tested positively: Yjs stores plain
 * JSON as a map value without wrapping it in an `AbstractType`, so any guard
 * phrased as "not one of these types" is the same defect in a new costume.
 * A born map carrying one is removed; a pre-existing map is restored to its
 * pre-transaction value; a map whose pre-transaction value is ALSO out of
 * domain stands, because there is no in-document value to restore it to. The
 * load reports it and the snapshot holds the row it would otherwise corrupt.
 *
 * That fifth rule reaches a second boundary the passes above cannot see.
 * Every pass here is scoped to client-origin transactions, and `/ingest-sync`
 * writes under a NULL origin — the runtime's own tag — while carrying values a
 * client supplied. `partitionOnIdentityDomain` applies the domain rule to an
 * ingest payload instead, before the transaction exists, so the exemption for
 * the runtime's writes cannot be inherited by client data travelling inside
 * one.
 *
 * The convenor-only config split is a sixth pass, and the only one that reads
 * a root type rather than an array member. Six `project_config` fields — the
 * site's address, its build content and its data source — are the convenor's
 * alone, and `snapshotConfig` writes almost the whole row out of the shared
 * document for any socket holder, so the route action's gate is defence in
 * depth and this is where the rule holds. It watches a key set rather than a
 * value, which means a guarded key holding a shared TYPE has a second mutation
 * surface the key itself never reports: `guardedConfigKeyFor` walks a changed
 * type's ancestry back to the config root so an edit to those contents is
 * caught at whatever depth it sits. See `extractConfigFieldMutations`,
 * including why the root's null `_item` makes the identity pass's opening
 * guard the wrong shape to copy.
 *
 * The mirror that rebuilds a reverted entity is default-deny about shared
 * types: it models `Y.Text`, `Y.Array` and `Y.Map` by exact class and drops
 * anything else, because a value it carried through by reference arrived at
 * the restore still integrated and threw — and the enforcement-failure halt
 * behind that throw stops persistence for the whole project. A value a client
 * can author must never reach that halt, which is why an unmodelled type costs
 * its own field and nothing more. See `mirroredKind` and `isSharedValue`.
 *
 * Pure module — extracted from collaboration.ts so the handler can be
 * unit-tested with a bare Y.Doc and synthetic WebSocket origins.
 *
 * @version v1.5.0-beta
 */

import * as Y from "yjs";

import { isConvenorOnlyConfigField } from "~/lib/config-fields";
import { isSharedValue } from "~/lib/value-domains";
import { renderedValue } from "./collaboration-helpers";
import { collectDisplacedRanges, type ClockRange } from "./displaced-edits";
import { markRefused } from "./refusal-marks";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Root Y.Arrays whose direct child Y.Maps carry `created_by`. */
export const PROTECTED_ROOT_NAMES: ReadonlySet<string> = new Set([
  "stories",
  "objects",
  "glossary",
  "pages",
]);

/** Nested Y.Arrays addressed via key on a parent Y.Map. */
export const PROTECTED_NESTED_KEYS: ReadonlySet<string> = new Set([
  "steps",
  "layers",
]);

/**
 * Y.Map key naming the course an object was preloaded from. Contract 1:
 * an integer when set, absent — never null-valued — on unmarked objects.
 * Only the preload ingest sets it; only the leave route clears it.
 */
export const COURSE_MARKER_KEY = "course_project_id";

/**
 * Y.Map key holding the D1 primary key. DO-owned on marked objects: the
 * sweep's branch selector and the DO's own dedupe both resolve identity
 * through it, so leaving it client-writable let an attacker choose which of
 * a pair survives. Only the Durable Object assigns it.
 */
export const ROW_ID_KEY = "_id";

/**
 * Y.Map key holding the object's slug. DO-owned on marked objects: it gates
 * the reorder exemption and is the key the DO's dedupe collapses objects on,
 * so a client able to rewrite it can aim the replacement sweep at content it
 * has no right to delete. Per design §6 the slug belongs to the course; the
 * group catalogues title, creator and credit.
 */
export const SLUG_KEY = "object_id";

/**
 * Y.Map key holding the address the object's image is served from. DO-owned on
 * marked objects, and the only one of these four that is not an identity
 * discriminator: nothing in the delete machinery reads it.
 *
 * It is guarded because a course item whose image a child site can repoint is
 * not a course item. Design §6 rules that the image belongs to the course —
 * change what it serves and every site follows — and the delete gates make the
 * row undeletable, but neither prevents a member socket rewriting this key in
 * place, no delete involved, after which that child shows something the course
 * never published while still presenting it as the course's object. The group
 * still catalogues title, creator and credit; that drift is the editing freedom
 * design §6 grants, and this is the line it stops at.
 */
export const SOURCE_URL_KEY = "source_url";

/**
 * Y.Map key holding the client-minted handle an entity keeps until the DO
 * assigns it a row id. Not DO-owned — the client mints it — but it is an
 * identity key, so its VALUE domain is governed here even where its content
 * is not.
 */
export const TEMP_ID_KEY = "_temp_id";

/**
 * Name of the root Y.Map holding the site's configuration. It is a root type,
 * not a member of any array, so none of the position-scoped rules above reach
 * it and `extractConfigFieldMutations` addresses it by name.
 */
export const CONFIG_ROOT_NAME = "config";

/**
 * Keys a client may write only while creating an entity, for a Y.Map sitting
 * directly in one of the protected ROOT arrays.
 *
 * The invariant is write-once, not DO-owned: no client-origin transaction may
 * change one of these keys on a Y.Map that existed before that transaction.
 * `extractIdentityMutations` enforces exactly that and nothing more — a map
 * born inside the transaction is free to carry any of them it likes, because
 * deciding whether a NEW map may claim an OLD one's identity is the
 * delete-and-replace question the reorder exemption owns, not this
 * one.
 *
 * Most of these keys are minted by the Durable Object, which is where the name
 * comes from, but two are not and the distinction is worth keeping straight.
 * `_temp_id` is minted by the client at construction; so is `created_by`, by
 * every factory in `use-structural-ops.ts` and by `makeObjectYMap`. What they
 * share with the DO-minted keys is not who writes them but that nothing may
 * write them twice.
 *
 * `created_by` is here, and it is the reason the pass runs on
 * ordinary sites rather than only on course collections. The own-content
 * delete rule reads it off the deleted map to decide whether a delete is a
 * self-delete, and nothing gated a write to it: any collaborator took any
 * entity in two ordinary transactions by claiming it and then deleting it.
 * Reverting the claim is what makes the delete rule mean anything. It applies
 * to all six kinds, which is why the nested table below carries it too — the
 * rule governs every entity, not only the roots.
 *
 * Scoping is by array position, not by key name, because the same key means
 * different things in different positions. Two carve-outs make that necessary
 * rather than tidy, and both were found by breaking shipped features:
 *
 * - `slug` on `pages`, `term_id` on `glossary` and `story_id` on `stories`
 *   are RENAME features (`app/routes/_app.pages.tsx`,
 *   `app/routes/_app.glossary.tsx` and the story editor's title card write
 *   them on a map located by lookup). Guarding any one disables renaming
 *   instance-wide, so none appears here.
 * - `object_id` is DO-owned on an `objects` map — the only writer is
 *   `makeObjectYMap`, at construction — but NOT on a step map, where
 *   `app/routes/_app.stories.$storyId.tsx` writes it on a pre-existing map
 *   every time a user picks media. Hence the separate nested table below.
 */
export const DO_OWNED_IDENTITY_KEYS_BY_ROOT: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["stories", new Set(["_id", "_temp_id", "created_by"])],
  ["objects", new Set(["_id", "_temp_id", "object_id", "created_by"])],
  ["glossary", new Set(["_id", "_temp_id", "created_by"])],
  ["pages", new Set(["_id", "_temp_id", "created_by", "_adopted"])],
]);

/**
 * The human key the DO's pre-snapshot `deduplicateYArray` collapses each root
 * on, mirroring the four calls in `snapshotToD1`. Two Y.Maps sharing one of
 * these values are one entity as far as that pass is concerned, so a
 * replacement carrying the victim's value is a claim on the victim's row.
 *
 * Only `findDurableReplacements` reads it, and only where D1 cannot settle the
 * collision itself — see the note there.
 */
export const DEDUPE_KEY_BY_ROOT: ReadonlyMap<string, string> = new Map([
  ["stories", "story_id"],
  ["objects", "object_id"],
  ["glossary", "term_id"],
  ["pages", "slug"],
]);

/**
 * The same table for Y.Maps in a nested protected array, keyed by the parent
 * Y.Map key. `object_id` is absent from `steps` on purpose — see above.
 */
export const DO_OWNED_IDENTITY_KEYS_BY_NESTED_KEY: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["steps", new Set(["_id", "_temp_id", "created_by"])],
  ["layers", new Set(["_id", "_temp_id", "created_by"])],
]);

/**
 * Keys whose VALUE DOMAIN is governed, for a Y.Map in one of the protected
 * root arrays. Derived from `DEDUPE_KEY_BY_ROOT` rather than restated, because
 * the set that matters here is exactly the set the DO's own reconciliation
 * reads — every reconciliation key is rendered through `renderedKey`, so any
 * value that renders to a colleague's key IS that key as far as reconciliation
 * is concerned, whatever type it is.
 *
 * This is a wider table than `DO_OWNED_IDENTITY_KEYS_BY_ROOT` on purpose, and
 * the two answer different questions. Ownership asks WHO may change the value:
 * `pages.slug` and `glossary.term_id` are shipped rename features, so the
 * answer there is "anyone", and they are absent from the owned table. The
 * domain asks WHAT a value may be, which renaming never needs to vary — a
 * rename writes a string, and a string is in domain. Constraining the domain
 * therefore leaves every rename untouched while closing the reconciliation key
 * to structure.
 */
export const IDENTITY_DOMAIN_KEYS_BY_ROOT: ReadonlyMap<string, ReadonlySet<string>> =
  new Map(
    [...DEDUPE_KEY_BY_ROOT].map(([root, humanKey]): [string, ReadonlySet<string>] => [
      root,
      new Set([ROW_ID_KEY, TEMP_ID_KEY, humanKey]),
    ]),
  );

/**
 * The same for a Y.Map in a nested protected array. The human key is absent
 * because a step and a layer have none: `object_id` on a step is a REFERENCE
 * to an object, written by the media picker on every pick, and constraining it
 * here would break that feature to guard a key no reconciliation pass reads as
 * identity.
 */
export const IDENTITY_DOMAIN_KEYS_BY_NESTED_KEY: ReadonlyMap<string, ReadonlySet<string>> =
  new Map([
    ["steps", new Set([ROW_ID_KEY, TEMP_ID_KEY])],
    ["layers", new Set([ROW_ID_KEY, TEMP_ID_KEY])],
  ]);

/**
 * True when `value` is a legal value for identity key `key`.
 *
 * Tested POSITIVELY, per key, and that is the whole point of the rule. A guard
 * written as "not one of these types" is the same defect in a new costume:
 * Yjs stores plain JSON as a map value without wrapping it in an
 * `AbstractType`, so a one-element array at `object_id` answers false to every
 * `instanceof` test and still renders to the victim's key. Only an allow-list
 * of shapes the pipeline can actually carry is safe.
 *
 * `_id` is D1's primary key, so it admits a positive safe integer, the `null`
 * that means "no row yet", or absence. `NaN` is `typeof "number"` and beats the
 * "prefer the persisted copy" tiebreak in `deduplicateYArray`, so it has to be
 * excluded by hand; `0` is `insertRow`'s refused-INSERT sentinel and is never a
 * real row id; fractions, negatives and values past `MAX_SAFE_INTEGER` are not
 * row ids either.
 *
 * Every other identity key is a handle or a human key: a non-empty string, or
 * absent. An empty string is excluded because `deduplicateYArray` treats it as
 * "not yet keyed" and skips it — a key that reconciliation refuses to read is
 * not a key — and no creation path writes one: all four mint through
 * `makeUniqueSlug`, which returns `"untitled"` rather than `""`.
 */
export function isIdentityValueInDomain(key: string, value: unknown): boolean {
  if (key === ROW_ID_KEY) {
    if (value === undefined || value === null) return true;
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  }
  if (value === undefined) return true;
  return typeof value === "string" && value.length > 0;
}

/**
 * Roots the ingest states an identity value for. Narrowed to the four so a
 * typo cannot silently ask for a key `DEDUPE_KEY_BY_ROOT` does not hold.
 */
export type IngestIdentityRoot = "stories" | "objects" | "glossary" | "pages";

/** One ingest arm split on the identity value domain. */
export interface IdentityDomainPartition<T> {
  accepted: T[];
  /** Positions in the arm as it arrived. See why it is positions, below. */
  refused: number[];
}

/**
 * The same split, with every accepted entry still carrying the position it
 * arrived at.
 *
 * A caller that judges its survivors against a second rule needs that position:
 * the accepted list has already had entries dropped from it, so an index into
 * it is not an index into the arm the caller was sent, and a refusal reported
 * at the wrong position names an entry that was applied.
 */
export interface IndexedIdentityDomainPartition<T> {
  accepted: Array<{ position: number; entry: T }>;
  /** Positions in the arm as it arrived. */
  refused: number[];
}

/**
 * Split one ingest arm into the entries whose identity value is in domain and
 * the positions of those that are not, BEFORE any of it reaches the document.
 *
 * The entry passes above judge CLIENT-ORIGIN transactions, and `/ingest-sync`
 * is not one: it mutates the Y.Doc under a null origin, the tag that marks the
 * runtime's own writes and exempts them from every delete and identity pass.
 * That exemption is about WHO is writing and says nothing about
 * WHAT is written, so a server-origin transaction carrying client-supplied
 * values inherits it while holding exactly the values those passes exist to
 * refuse. The payload, not the transaction, is where the trust boundary
 * actually falls — and it falls here for every producer, because a route is
 * not the only way into this endpoint.
 *
 * The rule is `isIdentityValueInDomain` itself, so the boundary and the entry
 * passes cannot drift apart. Absence is refused on top of it: a Y.Map may
 * legitimately be unkeyed while it waits for its row, but an arm whose whole
 * purpose is to state an identity has stated nothing, and `buildObjectYMap`
 * and its siblings would write the undefined through.
 *
 * A refusal is reported by POSITION, never by value. Rendering an untrusted
 * value to describe it — `String(value)` — is the operation the defect is made
 * of: it is how a one-element array becomes a colleague's key, and a report is
 * not a good enough reason to perform it. The position names the entry
 * exactly, and every caller already holds the array to resolve it against.
 *
 * Fails closed on a root with no human key: an identity value nothing can
 * judge is the condition being closed, so it is refused rather than passed.
 */
export function partitionOnIdentityDomain<T>(
  entries: readonly T[],
  root: IngestIdentityRoot,
  read: (entry: T) => unknown,
): IdentityDomainPartition<T> {
  const indexed = partitionOnIdentityDomainIndexed(entries, root, read);
  return {
    accepted: indexed.accepted.map((held) => held.entry),
    refused: indexed.refused,
  };
}

/**
 * The rule above, keeping each accepted entry's position.
 *
 * This is the one implementation of the split and `partitionOnIdentityDomain`
 * is a projection of it, so the two cannot state the domain differently. The
 * import routes read survivors directly and take the projection; the ingest
 * takes the positions, because it judges those survivors again.
 */
export function partitionOnIdentityDomainIndexed<T>(
  entries: readonly T[],
  root: IngestIdentityRoot,
  read: (entry: T) => unknown,
): IndexedIdentityDomainPartition<T> {
  const identityKey = DEDUPE_KEY_BY_ROOT.get(root);
  const accepted: Array<{ position: number; entry: T }> = [];
  const refused: number[] = [];
  entries.forEach((entry, index) => {
    const value = read(entry);
    const inDomain =
      identityKey !== undefined &&
      value !== undefined &&
      isIdentityValueInDomain(identityKey, value);
    if (inDomain) accepted.push({ position: index, entry });
    else refused.push(index);
  });
  return { accepted, refused };
}

/** Sliding-window violation policy. */
export const VIOLATION_THRESHOLD = 3;
export const VIOLATION_WINDOW_MS = 60_000;

/**
 * String origin tag for the revert transaction. The handler short-circuits
 * on string origins so its own revert never re-triggers itself, even if
 * `isReverting` were somehow falsy.
 */
export const REVERT_ORIGIN = "do-revert-unauthorised-delete";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserContext {
  userId: number;
  // Must accept every role the socket parse can attach (collaboration.ts
  // MemberRole): a role missing here resolves to a null actor, which the
  // canDelete handler reads as a DO-internal origin — exempt from enforcement.
  role: "convenor" | "collaborator" | "instructor";
}

export interface UnauthorisedDelete {
  /** The deleted Y.Map (still readable post-deletion via _map). */
  deletedMap: Y.Map<unknown>;
  /** The parent Y.Array the Y.Map was a member of. */
  parentArray: Y.Array<Y.Map<unknown>>;
  /**
   * Index (0-based) the Y.Map held before the transaction ran. Orders the
   * restores against each other; it is not where the clone goes, because the
   * array the clone is inserted into is the one the transaction left behind.
   */
  originalIndex: number;
  /**
   * Index (0-based) in the array as the transaction left it — the slot the
   * clone is inserted at, before the replacement sweep and the siblings
   * restored ahead of it are accounted for.
   */
  liveIndex: number;
  /**
   * A same-identity replacement inserted by the offending transaction, to be
   * removed before the original is restored. Set only by the course pass:
   * restoring the original beside a surviving replacement would leave two
   * rows with one `object_id`, and `objects.object_id` carries no UNIQUE
   * constraint to catch it in D1 or in objects.csv.
   */
  launderedClone?: Y.Map<unknown> | null;
}

/**
 * Dependencies the canDelete handler needs from the Durable Object. Injected
 * so the handler is testable without a live DO runtime.
 */
export interface CanDeleteDeps {
  /** The collaborative Y.Doc. */
  ydoc: Y.Doc;
  /** True while the DO is mid-snapshot; the handler skips during this window. */
  isSnapshotting: () => boolean;
  /** True while the handler is reverting; prevents recursion. Setter required. */
  isReverting: () => boolean;
  setReverting: (v: boolean) => void;
  /** All connected WebSockets — used to broadcast the post-revert sync step 2. */
  getSockets: () => Iterable<WebSocket>;
  /** Send the post-revert sync step 2 update to the supplied socket. */
  broadcastUpdate: (msg: Uint8Array) => void;
  /**
   * Close the offending socket. The Durable Object supplies it so the close can
   * be held behind the write that records what the document now holds: a close
   * issued from inside `afterTransaction` has already left the object by the
   * time any listener runs, and the output gate cannot hold what is already
   * sent. Unwired, the close is issued here as it stands, which is what the
   * handler's own harnesses observe.
   */
  closeSocket?: (ws: WebSocket, code: number, reason: string) => void;
  /**
   * Per-socket violation tracker. Returns true if the socket has crossed the
   * sliding-window threshold and should be closed.
   */
  recordViolation: (ws: WebSocket) => boolean;
  /** Logger for warning lines (defaults to console.warn). */
  warn?: (msg: string) => void;
  /**
   * Called when the revert could not be applied in full — a restore, a sweep
   * or a field write threw. The document then carries a deletion enforcement
   * failed to undo, so the next snapshot would write that deletion to D1. The
   * DO's answer is to treat the document as untrusted and refuse to persist it
   * until it has been reloaded from the last good blob, in the same spirit as
   * `/clear-course-markers` refusing rather than acting on an inference.
   *
   * It is for a throw nobody predicted, and only that. A value a client can
   * author must not reach it: the halt stops persistence for the whole
   * project, so anything reachable from a socket would make it an availability
   * attack rather than a safeguard. That is why an unmodelled shared type, an
   * embedded one inside a Y.Text, a nesting deeper than the mirror follows and
   * a shared type parked under a guarded key all degrade their own field and
   * come out through `revert-degraded` instead.
   *
   * Optional, and unwired it changes nothing: the handler still logs with a
   * distinct tag, records the violation and closes the offending socket, so a
   * failure is never silent and never repeatable on the same connection. It
   * exists so the refusal has a seam to be wired to rather than being invented
   * at the call site.
   */
  onEnforcementFailure?: (detail: { userId: number; failures: readonly string[] }) => void;
  /**
   * Called, synchronously, when this transaction was corrected. The message
   * handler reads it to drop the relay of an update once the corrected
   * document's broadcast has been ATTEMPTED — `broadcastUpdate` above sends
   * to every connected socket and swallows an individual failure, so this
   * fires whether or not every peer actually received it. What the relay
   * would add on top is redundant transmission of a packet that changes
   * nothing once applied after the correction, not a second application of
   * the refused state — so its loss costs nothing a peer that DID receive the
   * broadcast needs. F1 governs it — the call sits between an apply and a
   * relay with no await between them, so it may only set a flag.
   */
  noteRevert?: () => void;
  /**
   * Called, synchronously, with the clock ranges of a subtree this revert
   * displaced. Collected while the tombstones still carry their ids, which is
   * inside this handler and nowhere later.
   */
  noteDisplacement?: (ranges: ClockRange[]) => void;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * A caught value rendered for the log. Anything can be thrown, so this never
 * assumes an Error, and it never interpolates the value itself — a message
 * built from client-authored content is a log-injection surface.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return typeof error;
}

/**
 * Resolve a transaction origin to the acting user's context. Returns null
 * for non-WebSocket origins (DO-internal transactions: cold-start, ID
 * backfill, dedup, revert) and for malformed attachments.
 */
/**
 * Give every protected root that already exists its type.
 *
 * Both passes decide what they are looking at with `instanceof`, and a root
 * type does not carry one until something asks for it. An update encodes a
 * NESTED type's constructor but not a root's — there is nowhere in the format
 * to put it — so a root that arrives through `applyUpdate` sits in `share` as a
 * bare `AbstractType`. Neither `type instanceof Y.Array` nor
 * `type instanceof Y.Map` recognises one, so a client insert straight into a
 * root array passes unexamined: a born entity carrying a malformed member, or
 * one forging a live entity's row id, is admitted in silence.
 *
 * Today the roots are typed before any client message by side effects of the
 * load path — `backfillOrderKeysEverywhere` asks for all four by type, and
 * `backfillBlobGaps` and `buildFromD1Rows` each ask for the config root — and
 * `webSocketMessage` blocks until the document is loaded. That is why this has
 * never bitten. But it means the guards' root-level coverage rests on an
 * incidental effect of code written for another purpose, which nothing states
 * and no test protects: a refactor that stopped one of those helpers reaching
 * for a root by type would disable both guards there, and every test would
 * still pass, because tests reach their documents through typed accessors.
 *
 * So the precondition is stated here, next to the guards that need it.
 *
 * Only roots ALREADY PRESENT are upgraded. Asking for an absent one would
 * CREATE it, and a document that never built a config root must be answered
 * without one — the same reason the load's convenor-only config scan reads
 * `share` directly rather than through `getMap`.
 */
export function typeProtectedRoots(ydoc: Y.Doc): void {
  const share = (ydoc as unknown as { share: Map<string, unknown> }).share;
  for (const name of PROTECTED_ROOT_NAMES) {
    if (share.has(name)) ydoc.getArray(name);
  }
  if (share.has(CONFIG_ROOT_NAME)) ydoc.getMap(CONFIG_ROOT_NAME);
}

export function getUserContext(origin: unknown): UserContext | null {
  if (!origin || typeof origin !== "object") return null;
  try {
    const att = (origin as {
      deserializeAttachment?: () => { userId?: number; role?: string } | null;
    }).deserializeAttachment?.();
    if (!att || typeof att.userId !== "number") return null;
    if (att.role !== "convenor" && att.role !== "collaborator" && att.role !== "instructor") {
      return null;
    }
    return { userId: att.userId, role: att.role };
  } catch {
    return null;
  }
}

/**
 * Classify a parent Y.AbstractType as either a root shared type (with name)
 * or a nested type stored on a Y.Map under a key. Returns null when neither.
 */
export function classifyParentArray(
  parent: object,
  ydoc: Y.Doc,
): { kind: "root"; name: string } | { kind: "nested"; key: string } | null {
  const item = (parent as {
    _item?: { parentSub?: string | null; parent?: object | null };
  })._item;

  if (!item) {
    const share = (ydoc as unknown as { share?: Map<string, object> }).share;
    if (!share) return null;
    for (const [name, t] of share) {
      if (t === parent) return { kind: "root", name };
    }
    return null;
  }

  if (typeof item.parentSub === "string") {
    return { kind: "nested", key: item.parentSub };
  }

  return null;
}

/** True iff the immediate parent Y.Array is one we enforce canDelete on. */
export function isProtectedParentArray(parent: object, ydoc: Y.Doc): boolean {
  const cls = classifyParentArray(parent, ydoc);
  if (!cls) return false;
  if (cls.kind === "root") return PROTECTED_ROOT_NAMES.has(cls.name);
  return PROTECTED_NESTED_KEYS.has(cls.key);
}

/**
 * Identity key for a Y.Map used to match deletes against inserts inside the
 * same transaction (reorder detection). Prefers `_temp_id` (UUID), then
 * `_id` (D1 PK), then a synthetic fingerprint.
 */
export function identityKeyFor(yMap: Y.Map<unknown>): string {
  const tempId = yMap.get("_temp_id");
  if (typeof tempId === "string" && tempId.length > 0) return `t:${tempId}`;
  const id = yMap.get("_id");
  if (typeof id === "number") return `i:${id}`;
  const cb = yMap.get("created_by");
  return `c:${cb ?? "null"}:${yMap.size}`;
}

/**
 * Snapshot-aware variant of identityKeyFor — reads keys via
 * `typeMapGetSnapshot` so identity remains computable for Y.Maps whose
 * containing Item is tombstoned post-transaction. When snapshot is null,
 * falls back to the live-read variant.
 */
export function identityKeyForAtSnapshot(
  yMap: Y.Map<unknown>,
  snap: Y.Snapshot | null,
): string {
  if (!snap) return identityKeyFor(yMap);
  const tempId = readKeyAtSnapshot(yMap, "_temp_id", snap);
  if (typeof tempId === "string" && tempId.length > 0) return `t:${tempId}`;
  const id = readKeyAtSnapshot(yMap, "_id", snap);
  if (typeof id === "number") return `i:${id}`;
  const cb = readKeyAtSnapshot(yMap, "created_by", snap);
  return `c:${cb ?? "null"}:0`;
}

/**
 * Walk the linked list left of `deletedItem` and count preceding Y.Map struct
 * items in the same parent Y.Array, in the two frames the restore needs.
 *
 * A restore has to answer two different questions and they part company as
 * soon as one transaction removes more than one sibling. `liveIndex` counts
 * only what survived, which is the slot to insert at, because the array being
 * inserted into is the one the transaction left behind. `originalIndex` also
 * counts the siblings this transaction removed, which is what puts the
 * restores in their pre-transaction order — a sibling deleted alongside this
 * one is invisible to the live count, so every entity removed together
 * answered the same slot and each insert pushed the last one further along,
 * returning them reversed.
 *
 * A sibling deleted by an EARLIER transaction is counted by neither: it is
 * gone and nothing is bringing it back. `Y.isDeleted` against this
 * transaction's `deleteSet` is what separates the two, and it is safe to ask
 * here because yjs sorts and merges the delete set before it emits
 * `afterTransaction` — `isDeleted` binary-searches, so an unsorted set would
 * answer wrongly rather than throw.
 *
 * Both counts are best-effort. Only `liveIndex` is clamped, being the one used
 * as an index; `originalIndex` is read as a rank and never as a position.
 */
export function computeDeletePosition(
  parent: Y.Array<Y.Map<unknown>>,
  deletedItem: Y.Item,
  tr: Y.Transaction,
): { originalIndex: number; liveIndex: number } {
  let live = 0;
  let original = 0;
  let cur: Y.Item | null = (deletedItem as unknown as { left: Y.Item | null }).left;
  while (cur) {
    const c = cur.content as unknown as { type?: Y.AbstractType<unknown> };
    if (c.type instanceof Y.Map) {
      if (!cur.deleted) {
        live++;
        original++;
      } else if (Y.isDeleted(tr.deleteSet, cur.id)) {
        original++;
      }
    }
    cur = (cur as unknown as { left: Y.Item | null }).left;
  }
  return { originalIndex: original, liveIndex: Math.min(live, parent.length) };
}

/**
 * Elements of a Y.Array as they stood at `snap`. Wraps
 * `Y.typeListToArraySnapshot`, the list counterpart of `typeMapGetSnapshot`
 * (both are internal Yjs helpers re-exported from the package index).
 *
 * Live iteration is the wrong reader for a tombstoned entity: `Y.Array.length`
 * and `.get()` skip deleted items, and every element of a nested array under a
 * deleted parent is deleted, so a live read of a reverted story's `steps`
 * returns nothing at all. The snapshot read walks the item list and keeps what
 * was visible at `snap`, which is the pre-delete content the revert has to put
 * back.
 *
 * With `snap` null this is plain live iteration, which is what the still-live
 * caller wants.
 */
export function readArrayAtSnapshot(
  yArray: Y.Array<unknown>,
  snap: Y.Snapshot | null,
): unknown[] {
  if (!snap) return yArray.toArray();
  const fn = (Y as unknown as {
    typeListToArraySnapshot?: (a: Y.Array<unknown>, s: Y.Snapshot) => unknown[];
  }).typeListToArraySnapshot;
  // Fallback — should never run since yjs ^13.6.x exports it. A live read here
  // yields an empty array for a tombstoned parent, which is the old lossy
  // behaviour rather than a crash.
  if (typeof fn !== "function") return yArray.toArray();
  return fn(yArray, snap);
}

/**
 * Mirror nodes — the four shapes `toCloneable` produces for a Y type.
 *
 * Structure is carried by the node's CLASS, never by a key inside it. A Y.Map
 * value is arbitrary client-supplied JSON, so any in-band marker is a marker
 * the client can also send: while the mirror said "this was a Y.Array" by
 * setting `__yarray`, storing `{ __yarray: null }` on any map was enough to
 * make the rebuild call `.map` on null, abort the revert transaction and leave
 * every pass in this module disarmed for the next delete.
 *
 * Validating the payload would stop that particular crash and leave the format
 * ambiguous: a client could still author a value the mirror reads as structure,
 * and the next marker added would reopen the hole. These classes are private to
 * the module and the mirror never leaves the worker's memory — it is built and
 * consumed inside one function call — so a value that arrived over the wire
 * cannot be an instance of one, and a plain object wearing the same key
 * round-trips as the value it is. Membership tests are also the wrong
 * instrument here for a second reason: `in` walks the prototype chain, and
 * lib0's `readAny` rebuilds a decoded object by assignment, so a `__proto__`
 * entry in a client's JSON becomes that object's prototype and satisfies the
 * test with no own property at all.
 *
 * The property names match the shape the mirror has always had, so a dumped
 * mirror still reads the same way.
 *
 * Y.Text is mirrored as a delta rather than a string when a snapshot is in
 * play, because `toString()` on a tombstoned Y.Text returns "" — its content
 * was deleted along with its parent, and only `toDelta(snap)` reaches back
 * past that. The delta carries formatting attributes and embeds as well as
 * text, and `fromCloneable` replays it through `applyDelta`, so a reverted
 * body comes back with whatever marks it had. Telar writes no marks today
 * (nothing in the app calls `format` or `insertEmbed`; CodeMirror binds plain
 * text), so in practice the delta is a single unattributed insert — keeping
 * the attributes costs nothing and means the mirror is not silently lossy if
 * a formatted field ever arrives.
 */
class MirroredText {
  constructor(readonly __ytext: string) {}
}
class MirroredTextDelta {
  constructor(readonly __ytextDelta: unknown[]) {}
}
class MirroredArray {
  constructor(readonly __yarray: unknown[]) {}
}
class MirroredMap {
  constructor(readonly __ymap: Record<string, unknown>) {}
}

/**
 * A value the mirror declines to model, standing in for it until the rebuild
 * reports it. It carries only a class name, never the value.
 */
class UnsupportedValue {
  constructor(readonly __unsupported: string) {}
}

/**
 * Thrown by the rebuild for an `UnsupportedValue`, and by nothing else. The
 * handler treats it as a DEGRADED field — one value lost, logged by path —
 * and never as an enforcement failure, because it is reachable from a socket.
 */
export class UnsupportedMirrorValueError extends Error {
  constructor(readonly kind: string) {
    super(`${kind} is not a value this mirror can rebuild`);
    this.name = "UnsupportedMirrorValueError";
  }
}

/**
 * How deep the mirror will follow nested shared types. A Y.Map value may be
 * another Y.Map, so nesting depth is client-chosen and unbounded, and both
 * halves of the mirror recurse — a chain deep enough to exhaust the stack
 * would raise a RangeError where no per-value handler sees it, which the
 * handler reads as an enforcement failure and answers with the persistence
 * halt. Telar's deepest entity is a story's step's layer, three levels below
 * the root map, so the bound is an order of magnitude clear of real content
 * and anything past it costs the one field.
 */
const MAX_MIRROR_DEPTH = 32;

/**
 * The shared types the mirror models, by exact class rather than by
 * `instanceof`.
 *
 * Default-deny is the whole point. `Y.XmlText` extends `Y.Text` and
 * `Y.XmlHook` extends `Y.Map`, so an `instanceof` allow-list silently
 * remodels those two as the parents they inherit from; `Y.XmlElement`,
 * `Y.XmlFragment` and a subdocument match neither, and a shared type carried
 * through by reference lands still-integrated inside a detached clone, where
 * reintegration throws. Matching the exact constructor answers the whole space
 * at once — every Y type this module does not model, including any a future
 * yjs adds, lands in the unsupported branch rather than in a hole.
 */
function mirroredKind(val: unknown): "text" | "array" | "map" | null {
  if (val === null || typeof val !== "object") return null;
  const ctor = (val as { constructor?: unknown }).constructor;
  if (ctor === Y.Text) return "text";
  if (ctor === Y.Array) return "array";
  if (ctor === Y.Map) return "map";
  return null;
}

/** True for a shared type the mirror does not model. */
export function isUnmirroredSharedType(val: unknown): boolean {
  return mirroredKind(val) === null && isSharedValue(val);
}

/**
 * A shared type named for the log. The name comes from yjs's own class, never
 * from client-authored content, so it is safe to interpolate.
 */
function describeSharedType(val: unknown): string {
  if (val instanceof Y.Doc) return "Y.Doc (subdocument)";
  const name = (val as { constructor?: { name?: unknown } })?.constructor?.name;
  return typeof name === "string" && name.length > 0 ? `Y.${name.replace(/^Y/, "")}` : "shared type";
}

/**
 * A Y.Text delta with every embedded shared type removed.
 *
 * `insertEmbed` takes a Y type as readily as a plain object, so a delta read
 * off a client's Y.Text can carry an integrated `Y.XmlElement`. Replaying that
 * through `applyDelta` on a detached Y.Text reintegrates it and throws — the
 * same defect as a bare shared-type value, one level further in. Text and
 * plain-object embeds are untouched.
 */
function sanitiseDelta(
  delta: unknown[],
  failures: MirrorRebuildFailure[] | undefined,
  path: string,
): unknown[] {
  const out: unknown[] = [];
  for (const [i, op] of delta.entries()) {
    const insert = (op as { insert?: unknown })?.insert;
    if (isSharedValue(insert)) {
      failures?.push({
        path: `${path}[${i}]`,
        error: new UnsupportedMirrorValueError(`an embedded ${describeSharedType(insert)}`),
      });
      continue;
    }
    out.push(op);
  }
  return out;
}

/** One value inside a Y.Map or Y.Array, mirrored to plain data. */
function toCloneableValue(
  val: unknown,
  snap: Y.Snapshot | null,
  failures: MirrorRebuildFailure[] | undefined,
  path: string,
  depth: number,
): unknown {
  if (depth > MAX_MIRROR_DEPTH) {
    return new UnsupportedValue(`a value nested deeper than ${MAX_MIRROR_DEPTH} levels`);
  }
  const kind = mirroredKind(val);
  if (kind === null) {
    // Plain data — JSON, a Uint8Array — clones by value and is returned as it
    // is. A shared type this module does not model cannot be, so it becomes a
    // marker the rebuild reports and drops.
    return isUnmirroredSharedType(val) ? new UnsupportedValue(describeSharedType(val)) : val;
  }
  if (kind === "text") {
    const text = val as Y.Text;
    return snap
      ? new MirroredTextDelta(sanitiseDelta(text.toDelta(snap) as unknown[], failures, path))
      : new MirroredText(text.toString());
  }
  if (kind === "array") {
    const source = readArrayAtSnapshot(val as Y.Array<unknown>, snap);
    const items: unknown[] = [];
    for (const [i, el] of source.entries()) {
      const here = `${path}[${i}]`;
      if (!failures) { items.push(toCloneableValue(el, snap, failures, here, depth + 1)); continue; }
      try {
        items.push(toCloneableValue(el, snap, failures, here, depth + 1));
      } catch (error) {
        failures.push({ path: here, error });
      }
    }
    return new MirroredArray(items);
  }
  return new MirroredMap(toCloneable(val as Y.Map<unknown>, snap, failures, path, depth + 1));
}

/**
 * Recursively serialise a Y.Map (and any nested Y.Text / Y.Array / Y.Map
 * children) to a plain-object form that can be cloned back into a fresh
 * Y.Map tree via `fromCloneable`. Read-only.
 *
 * When `snap` is supplied, every read at every depth goes through the
 * snapshot, so the function works on tombstoned Y.Maps (parent Item already
 * deleted) and on their whole subtree. Recursing with `null` instead would
 * drop to live reads one level down, where a tombstoned child's keys, array
 * elements and text bodies all read as absent — which is what made a reverted
 * story come back as an empty shell.
 *
 * When `snap` is null, live reads via `.get()` are used (suitable for
 * still-live Y.Maps).
 *
 * This is only sound while the deleted content is still in the document. It is
 * called from `afterTransaction`, which yjs emits before `tryGcDeleteSet` runs
 * — pinned by tests/can-delete-revert-fidelity.test.ts, which is the canary if
 * a yjs upgrade reorders the two.
 *
 * `failures` gives the READ half the same containment the rebuild has. A
 * snapshot read or a `toDelta` on client-authored content can throw, and a
 * throw here escapes to the handler's outer catch, which reads it as an
 * enforcement failure and halts persistence for the project. Per key, it costs
 * that key instead. Without it the errors propagate, which is the contract a
 * direct caller gets.
 */
export function toCloneable(
  yMap: Y.Map<unknown>,
  snap: Y.Snapshot | null = null,
  failures?: MirrorRebuildFailure[],
  path = "",
  depth = 0,
): Record<string, unknown> {
  // Null prototype: Y.Map keys are client-chosen strings, and on a plain object
  // `out["__proto__"] = value` reassigns the prototype through an accessor
  // inherited from Object.prototype instead of recording the key — so the field
  // vanishes from the revert and the mirror ends up wearing client data as its
  // prototype. With no prototype there is no accessor and the key is an
  // ordinary own property.
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  // Walk _map keys directly so we see entries even when their containing
  // Item is tombstoned. Y.Map.keys() filters out deleted entries.
  const keys = snap
    ? Array.from((yMap as unknown as { _map: Map<string, unknown> })._map.keys())
    : Array.from(yMap.keys());
  for (const key of keys) {
    const here = path ? `${path}.${key}` : key;
    if (!failures) {
      const val = snap ? readKeyAtSnapshot(yMap, key, snap) : yMap.get(key);
      // Absent at the snapshot: either never set, or written after it. Neither
      // belongs in a mirror of the pre-transaction entity.
      if (val === undefined) continue;
      out[key] = toCloneableValue(val, snap, failures, here, depth);
      continue;
    }
    try {
      const val = snap ? readKeyAtSnapshot(yMap, key, snap) : yMap.get(key);
      if (val === undefined) continue;
      out[key] = toCloneableValue(val, snap, failures, here, depth);
    } catch (error) {
      failures.push({ path: here, error });
    }
  }
  return out;
}

/**
 * One value in the mirror that could not be rebuilt, named by its path inside
 * the entity so the log says which field was lost rather than only that one
 * was.
 */
export interface MirrorRebuildFailure {
  path: string;
  error: unknown;
}

/** Inverse of `toCloneableValue`, for one mirrored value. */
function fromCloneableValue(
  val: unknown,
  failures: MirrorRebuildFailure[] | undefined,
  path: string,
): unknown {
  // A value the mirror declined to model. Reported through the failure array
  // like any other unbuildable field, so the entity comes back one value short
  // rather than not at all.
  if (val instanceof UnsupportedValue) throw new UnsupportedMirrorValueError(val.__unsupported);
  if (val instanceof MirroredText) return new Y.Text(val.__ytext);
  if (val instanceof MirroredTextDelta) {
    const out = new Y.Text();
    // The Y.Text is not integrated yet, so applyDelta queues onto _pending and
    // replays when the containing map is inserted. An empty delta must not be
    // applied: applyDelta on empty content is a no-op that still costs a
    // pending closure.
    if (val.__ytextDelta.length > 0) out.applyDelta(val.__ytextDelta);
    return out;
  }
  if (val instanceof MirroredArray) {
    const arr = new Y.Array<unknown>();
    const items: unknown[] = [];
    for (const [i, el] of val.__yarray.entries()) {
      const here = `${path}[${i}]`;
      if (!failures) { items.push(fromCloneableValue(el, failures, here)); continue; }
      try {
        items.push(fromCloneableValue(el, failures, here));
      } catch (error) {
        failures.push({ path: here, error });
      }
    }
    arr.push(items);
    return arr;
  }
  if (val instanceof MirroredMap) return fromCloneable(val.__ymap, failures, path);
  return val;
}

/**
 * Inverse of `toCloneable` — build a fresh Y.Map tree from the mirror.
 *
 * Handles both Y.Text forms: the string one from the live path and the delta
 * one from the snapshot path.
 *
 * `failures` makes the rebuild non-abortable. With it supplied, a value that
 * cannot be rebuilt costs that ONE field and is reported through the array;
 * without it the error propagates, which is the contract a direct caller
 * (tests, future callers with their own handling) gets. The handler always
 * supplies it: a revert that dies on one value leaves the deletion applied and
 * the actor unmarked, which is a worse outcome than an entity coming back one
 * field short.
 */
export function fromCloneable(
  obj: Record<string, unknown>,
  failures?: MirrorRebuildFailure[],
  path = "",
): Y.Map<unknown> {
  const out = new Y.Map<unknown>();
  for (const key of Object.keys(obj)) {
    const here = path ? `${path}.${key}` : key;
    if (!failures) { out.set(key, fromCloneableValue(obj[key], failures, here)); continue; }
    try {
      out.set(key, fromCloneableValue(obj[key], failures, here));
    } catch (error) {
      failures.push({ path: here, error });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// extractUnauthorisedDeletes — pure analysis pass over a Y.Transaction
// ---------------------------------------------------------------------------

/**
 * Read a key from a Y.Map at a given snapshot. Wraps `Y.typeMapGetSnapshot`
 * (an internal Yjs helper exposed via the package's index re-exports). Used
 * to read `created_by` from a Y.Map AFTER its parent Item has been
 * tombstoned — direct `.get()` returns undefined for deleted entries, but
 * the snapshot read walks the _map linked list back to the pre-deletion
 * value.
 */
export function readKeyAtSnapshot(
  yMap: Y.Map<unknown>,
  key: string,
  snap: Y.Snapshot,
): unknown {
  const fn = (Y as unknown as {
    typeMapGetSnapshot?: (m: Y.Map<unknown>, k: string, s: Y.Snapshot) => unknown;
  }).typeMapGetSnapshot;
  if (typeof fn === "function") return fn(yMap, key, snap);
  // Fallback — should never run since yjs ^13.6.x exports typeMapGetSnapshot.
  // Walk the _map linked list manually if the helper is missing.
  const entry = (yMap as unknown as { _map?: Map<string, { left?: unknown; deleted: boolean; content: { getContent: () => unknown[] }; length: number }> })._map?.get(key);
  if (entry && !entry.deleted) return entry.content.getContent()[entry.length - 1];
  return undefined;
}

/**
 * A key's value as it stood immediately BEFORE `tr` began, read without a
 * `Y.Snapshot`.
 *
 * This is `Y.typeMapGetSnapshot`'s algorithm with the snapshot replaced by
 * data Yjs computes for every transaction anyway: `tr.beforeState` is the
 * state vector at the transaction's start, and `tr.deleteSet` is what this
 * transaction tombstoned. Walking the key's item list left past everything
 * whose clock post-dates `beforeState` lands on the item that was current
 * before the transaction; an item that is deleted now was alive then exactly
 * when THIS transaction deleted it.
 *
 * The distinction from `readKeyAtSnapshot` is cost, not answer: a snapshot
 * costs a full state-vector plus delete-set encode of the whole document and
 * has to be taken in `beforeTransaction`, before anyone knows whether it will
 * be needed. This costs a short pointer walk in `afterTransaction`, which is
 * what lets an identity rule run on EVERY client transaction instead of only
 * the ones a conditional snapshot happened to cover. The equivalence is
 * pinned by `tests/read-key-before-transaction.test.ts`.
 *
 * `{ absent: true }` and a value are distinct results: `_id: null` and no
 * `_id` at all mean different things to the snapshot pipeline, so a revert
 * has to be able to delete the key rather than write a null.
 */
export function readKeyBeforeTransaction(
  yMap: Y.Map<unknown>,
  key: string,
  tr: Y.Transaction,
): { absent: true } | { value: unknown } {
  type MapItem = {
    id: { client: number; clock: number };
    left: MapItem | null;
    deleted: boolean;
    length: number;
    content: { getContent: () => unknown[] };
  };
  let v = ((yMap as unknown as { _map: Map<string, MapItem> })._map.get(key) ?? null);
  while (v !== null && v.id.clock >= (tr.beforeState.get(v.id.client) ?? 0)) {
    v = v.left;
  }
  if (v === null) return { absent: true };
  const aliveBefore =
    !v.deleted || Y.isDeleted(tr.deleteSet, v.id as unknown as Y.ID);
  if (!aliveBefore) return { absent: true };
  return { value: v.content.getContent()[v.length - 1] };
}

/** One deleted Y.Map sitting directly in a protected Y.Array. */
interface DeletedProtectedMap {
  wrapped: Y.Map<unknown>;
  parentArray: Y.Array<Y.Map<unknown>>;
  struct: Y.Item;
}

/**
 * Walk `tr.deleteSet` and return every deleted Y.Map whose immediate parent
 * is a protected Y.Array, with cascade children folded into their ancestor's
 * decision (a deleted story's steps and layers are not separate deletes).
 *
 * Shared by both authorisation passes so they see exactly the same candidate
 * set; each applies its own rule to it.
 */
export function collectDeletedProtectedMaps(
  ydoc: Y.Doc,
  tr: Y.Transaction,
): DeletedProtectedMap[] {
  const found: DeletedProtectedMap[] = [];
  // Track ancestor-deleted Y.Maps so cascade children inherit the parent's
  // authorisation decision.
  const ancestorDeleted = new Set<object>();

  Y.iterateDeletedStructs(tr, tr.deleteSet, (struct: Y.GC | Y.Item) => {
    if (!(struct instanceof Y.Item)) return;
    const wrapped = (struct.content as unknown as { type?: object }).type;
    if (!wrapped || !(wrapped instanceof Y.Map)) return;

    const parent = struct.parent;
    if (!parent || typeof parent === "string") return;
    const parentType = parent as unknown as Y.AbstractType<unknown>;
    if (!(parentType instanceof Y.Array)) return;

    // Cascade short-circuit.
    let cur: object | null = parentType;
    let isCascade = false;
    while (cur) {
      if (ancestorDeleted.has(cur)) { isCascade = true; break; }
      const parentItem: { parent?: object | null } | undefined =
        (cur as { _item?: { parent?: object | null } })._item;
      cur = parentItem?.parent ?? null;
    }
    if (isCascade) {
      ancestorDeleted.add(wrapped);
      return;
    }
    ancestorDeleted.add(wrapped);

    if (!isProtectedParentArray(parentType, ydoc)) return;

    found.push({
      wrapped: wrapped as Y.Map<unknown>,
      parentArray: parentType as Y.Array<Y.Map<unknown>>,
      struct,
    });
  });

  return found;
}

/**
 * `_id` normalised so an absent key and an explicit null read alike. A
 * never-snapshotted object legitimately carries `_id: null`; a hand-rolled
 * replacement simply omits the key. Both mean "no D1 row yet".
 */
function normalisedRowId(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/**
 * Reorder detection used to live here, as `collectInsertedIdentities` /
 * `findCloneByIdentity` / `preservesIdentity`: a delete whose identity
 * reappeared as an insert in the same transaction was read as a move, not a
 * removal, and waved through all three passes below.
 *
 * It existed because reordering a list meant deleting the entry's Y.Map and
 * inserting a clone, so an honest drag and "delete a colleague's entity and
 * put a hollow one carrying their identity in its place" were the same
 * transaction on the wire. The passes could not refuse the second without
 * refusing the first.
 *
 * The exemption had to decide on `_temp_id` and `created_by`, and later
 * `object_id` and the course marker — every one of them client-writable. That
 * is the weakness: an attacker who copied those fields onto a hollow replacement was
 * exempted by the rule meant to stop them.
 *
 * Every list now moves an entry by writing its `order_key` (app/lib/
 * field-order.ts), a field write that removes nothing from any Y.Array. There
 * is no reorder left to mistake for a delete, so the passes classify a
 * delete-plus-reinsert as what it is, and this decides nothing any more.
 *
 * `identityKeyFor` and `identityKeyForAtSnapshot` above are what the deleted
 * helpers matched on. They are kept as the module's identity-key readers —
 * `identityKeyFor` has its own unit tests — but no pass consults them any
 * more, and nothing should reintroduce one that does: an identity a client
 * can write is not evidence about who may delete what.
 */

/**
 * True when `yMap`'s place in its parent array was created by this
 * transaction. A Y.Map's `_item` IS the array item holding it, and Yjs
 * cannot move a type — a "moved" item is always a fresh clone — so this
 * reads as "the transaction put this map here", covering replacements
 * whether or not they surfaced in `tr.changed` (a map born inside the
 * transaction never does, since its items post-date `tr.beforeState`).
 */
function isInsertedInTransaction(
  // A map or an array: both carry the `_item` this reads, and Yjs types
  // `AbstractType` by its EVENT type, so the common supertype does not admit
  // either of them.
  type: Y.Map<unknown> | Y.Array<unknown>,
  tr: Y.Transaction,
): boolean {
  const item = (type as unknown as {
    _item?: { id?: { client: number; clock: number } };
  })._item;
  if (!item?.id) return false; // a root type, which pre-dates the transaction
  return item.id.clock >= (tr.beforeState.get(item.id.client) ?? 0);
}

/**
 * True when the value at `index` was put there by this transaction.
 *
 * The Y.Map version above reads the map's own `_item`, which a plain value
 * does not have: JSON lives inside the array's item as content rather than as
 * a type with a parent. So the item is found by walking the array's chain and
 * counting the visible content ahead of it, which is what `index` addresses.
 *
 * One item can carry several values — Yjs packs consecutive JSON inserts —
 * and they were all written by the same transaction, so the whole item
 * answers for any index inside it.
 */
function isInsertedValueInTransaction(
  yArray: Y.Array<unknown>,
  index: number,
  tr: Y.Transaction,
): boolean {
  interface ItemLike {
    deleted: boolean;
    countable: boolean;
    length: number;
    id: { client: number; clock: number };
    right: ItemLike | null;
  }
  let node = (yArray as unknown as { _start?: ItemLike | null })._start ?? null;
  let offset = 0;
  while (node) {
    if (node.countable && !node.deleted) {
      if (index < offset + node.length) {
        return node.id.clock >= (tr.beforeState.get(node.id.client) ?? 0);
      }
      offset += node.length;
    }
    node = node.right;
  }
  return false;
}

/**
 * Live Y.Maps in `parentArray` that claim the deleted original's durable
 * identity — its `_id` (a persisted D1 row) or its `object_id` (the slug
 * every step reference, CSV row and published page resolves against).
 *
 * A replacement left standing beside the restored original is not merely
 * untidy: the DO's pre-snapshot `deduplicateYArray` finishes the
 * substitution for the attacker. It runs null-origin, exempt from every pass
 * here, collapses exact `_id` duplicates and keeps the FIRST occurrence, so
 * an insert at or before the victim's index has the DO delete the restored
 * original. Sweeping on durable keys closes that, because they are the keys
 * the DO's own dedupe collapses on.
 *
 * `_id` matches only when the original actually has one: null is the
 * never-snapshotted state, shared by every unsaved object in the array, so
 * matching on it would sweep up bystanders. `object_id` matches only on a
 * non-empty string, for the same reason.
 *
 * The sweep runs for EVERY reverted delete, marked or not. Scoping it to
 * course items left the same substitution open on ordinary content: plant a
 * hollow map carrying the victim's `_id` and key ahead of it, delete the
 * victim, let the revert restore it, and the DO's dedupe sees two maps claiming
 * one row and keeps the first. That has to be answered here rather than in the
 * dedupe, because the two are indistinguishable to D1 — it knows only that row
 * 10 exists. What separates them is PROVENANCE: the forgery was born inside the
 * offending transaction. That is known here and gone by snapshot time.
 *
 * How far the sweep reaches is what `marked` decides:
 *
 * - **Ordinary content** — provenance only. A same-key or same-`_id` neighbour
 *   that predates the transaction is real content with its own live D1 row, and
 *   `deduplicateYArray` deliberately RE-KEYS such a neighbour rather than
 *   deleting it, precisely because the collision is authorable by an honest
 *   rename. Removing it here would perform the destruction that rule exists to
 *   prevent, on nothing better than an inference about who is entitled to the
 *   key. Every replacement in the attack is inserted by the offending
 *   transaction, so the restriction costs the sweep nothing.
 * - **A marked course item, victim persisted (`_id` non-null)** — sweep
 *   competitors whenever they arrived. The marker is DO-owned and unforgeable
 *   from a socket (`extractProtectedFieldMutations`), and it says this object
 *   belongs to a course, so a twin claiming its row is not a rename collision
 *   between two members. A twin planted in an earlier transaction is not caught
 *   by a provenance rule, and dedupe then destroys the restored victim: exact
 *   `_id` collapse when the twin copied the row id, or keeper-by-slug
 *   first-occurrence when it carries a different non-null one, where the
 *   non-null-`_id` preference never engages because both are non-null. The pair
 *   collapses either way, so keeping the marked item is the outcome to choose.
 * - **A marked course item, victim unsaved (`_id` null)** — provenance only
 *   again, for the ordinary-content reason: with no row id there is nothing to
 *   tell a competitor from a bystander.
 *
 * The original is tombstoned and Y.Array iteration skips deleted items, so
 * it can never match itself.
 *
 * Two of the four keys are client-chosen, so they prove nothing about a Y.Map
 * that was already in the array and are matched ONLY against one this
 * transaction inserted, where "it claims the victim's handle and it did not
 * exist a moment ago" is exactly a replacement:
 *
 * - `_temp_id`, because a spoof that copies it while changing `object_id` and
 *   omitting `_id` matches neither durable key — and that spoof is a real one:
 *   the DO's dedupe keeps the first occurrence, so a replacement sitting at or
 *   before the restored victim's index has the DO finish the substitution.
 * - the root's own dedupe key (`story_id`, `slug`, `term_id`, `object_id`), and
 *   only where the victim has NO row id. With one, D1 already settles the
 *   collision — `deduplicateYArray` gives the key to the row D1 says owns it,
 *   wherever it sits — so there is nothing left for this to decide. Without
 *   one, D1 has no answer and the keeper falls back to array position, which
 *   the attacker chooses.
 */
function findDurableReplacements(
  deletedMap: Y.Map<unknown>,
  parentArray: Y.Array<Y.Map<unknown>>,
  snap: Y.Snapshot | null,
  tr: Y.Transaction,
  ydoc: Y.Doc,
  marked: boolean,
): Y.Map<unknown>[] {
  const rowId = normalisedRowId(readKey(deletedMap, "_id", snap));
  // The victim's side of every string comparison is required to be a real
  // non-empty string, so the match below asks only "does the candidate RENDER
  // to this key" and never "are these two equally invalid".
  const objectId = asSearchKey(readKey(deletedMap, "object_id", snap));
  const tempId = asSearchKey(readKey(deletedMap, "_temp_id", snap));

  const cls = classifyParentArray(parentArray, ydoc);
  const dedupeKey = cls?.kind === "root" ? DEDUPE_KEY_BY_ROOT.get(cls.name) ?? null : null;
  const dedupeValue =
    rowId === null && dedupeKey ? asSearchKey(readKey(deletedMap, dedupeKey, snap)) : null;

  if (rowId === null && objectId === null && tempId === null && dedupeValue === null) return [];

  // See the branches above: only a marked victim with a row id reaches past
  // the offending transaction.
  const inTransactionOnly = rowId === null || !marked;

  const found: Y.Map<unknown>[] = [];
  for (let i = 0; i < parentArray.length; i++) {
    const candidate = parentArray.get(i);
    if (!(candidate instanceof Y.Map)) continue;
    const bornHere = isInsertedInTransaction(candidate, tr);
    if (inTransactionOnly && !bornHere) continue;
    const matchesRow = rowId !== null && normalisedRowId(candidate.get("_id")) === rowId;
    const matchesSlug =
      objectId !== null && renderedKey(candidate.get("object_id")) === objectId;
    // The client-chosen keys, and only on a map born in this transaction.
    const matchesTempId =
      tempId !== null && bornHere && renderedKey(candidate.get("_temp_id")) === tempId;
    const matchesDedupeKey =
      dedupeValue !== null && bornHere && dedupeKey !== null &&
      renderedKey(candidate.get(dedupeKey)) === dedupeValue;
    if (matchesRow || matchesSlug || matchesTempId || matchesDedupeKey) {
      found.push(candidate as Y.Map<unknown>);
    }
  }
  return found;
}

/**
 * A human key as the server reads one, everywhere it reads one: the sweep
 * above, the DO's pre-snapshot `deduplicateYArray`, and every snapshot writer
 * that binds a key column. ONE function, because the sweep collects what the
 * dedupe will later collapse on — two renderings that disagree leave a
 * replacement standing beside the restored victim for the dedupe to finish
 * off, which is the substitution the sweep exists to stop.
 *
 * The comparisons in the sweep have to use this reading, not `===`: a
 * replacement carrying a `Y.Text`, an array or a subdocument at the key is a
 * different JavaScript value from the victim's string and would never match,
 * so it would not be collected into `removals`.
 *
 * The reading is TOTAL, and that is a requirement rather than a convenience —
 * see `renderedValue`, the server's one totality, which this is under the key
 * contract's name. What the key contract adds is the sentinel: a value nothing
 * can render reads as `""`, the same value a map that has not been keyed yet
 * carries and the one `deduplicateYArray` skips. Such an entry is not
 * deduplicated, not deleted, and cannot claim another entity's key.
 *
 * Rendering is the right reading for a SEARCH and for a key column, and not
 * for deciding identity: both sides of a comparison are text, so two values
 * that merely happen to be equally unrenderable are not thereby equal.
 * `asSearchKey` holds that line by requiring the victim's side to be a real
 * non-empty string, so the sentinel matches nothing.
 */
export function renderedKey(value: unknown): string {
  return renderedValue(value);
}

/**
 * The value to search for, or null when the victim carries no usable key. A
 * key the victim itself cannot state is not a key any replacement can claim.
 */
function asSearchKey(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Read a key from a Y.Map, through the snapshot when one was captured. */
function readKey(
  yMap: Y.Map<unknown>,
  key: string,
  snap: Y.Snapshot | null,
): unknown {
  return snap ? readKeyAtSnapshot(yMap, key, snap) : yMap.get(key);
}

/**
 * The course marker on a Y.Map, or null when unmarked. A non-integer value
 * is treated as unmarked: contract 1 makes the marker an integer or absent,
 * and a null left behind by an older document must not gate deletion.
 */
export function readCourseMarker(
  yMap: Y.Map<unknown>,
  snap: Y.Snapshot | null = null,
): number | null {
  const value = readKey(yMap, COURSE_MARKER_KEY, snap);
  return typeof value === "number" ? value : null;
}

/**
 * True when the document holds at least one marked object. Read live — the
 * `beforeTransaction` document is pre-mutation.
 *
 * Gates the convenor's per-transaction `Y.snapshot`. A true answer exits at
 * the first marked object; a false answer costs a full scan of the objects
 * array, and false is the answer for every site outside a course — so the
 * scan must stay a single key read per object and nothing more.
 *
 * The scan covers `objects` only, while the passes it gates walk every
 * protected array. That is sound while markers exist only on objects
 * (design §6): a marker on stories, glossary or pages would need this gate
 * widened to match, or a convenor could strip it unsnapshotted.
 *
 * Reads the root through `share` first: `getArray` CREATES an absent root,
 * and this runs inside `beforeTransaction`, where the document must not be
 * written to.
 */
export function docHasCourseItems(ydoc: Y.Doc): boolean {
  const share = (ydoc as unknown as { share?: Map<string, unknown> }).share;
  if (!share || !share.has("objects")) return false;
  const objectsArray = ydoc.getArray<Y.Map<unknown>>("objects");
  for (let i = 0; i < objectsArray.length; i++) {
    const candidate = objectsArray.get(i);
    if (candidate instanceof Y.Map && typeof candidate.get(COURSE_MARKER_KEY) === "number") {
      return true;
    }
  }
  return false;
}

/**
 * One client-socket write to a DO-owned key, with the value the revert must
 * put back. `previous` is the raw pre-transaction value; `undefined` means
 * the key was absent, and the revert deletes it rather than writing a null —
 * `_id: null` and no `_id` at all are different states downstream.
 */
export interface ProtectedFieldMutation {
  yMap: Y.Map<unknown>;
  key: string;
  previous: unknown;
}

/**
 * Protected-field pass — reverts any client write to a DO-owned key.
 *
 * Deletion gating is worthless without it: a client that clears the marker
 * in one transaction deletes an unmarked object in the next, and the next
 * snapshot writes the cleared marker to D1, disarming the two D1-direct
 * gates as well. Clients never legitimately touch the key — the preload
 * ingest sets it and the leave route clears it, both DO-internal — so any
 * socket-origin write is a violation, whatever the role and whichever
 * direction it moves the value.
 *
 * Two candidate sources, because Yjs reports them differently: a write to an
 * existing Y.Map appears in `tr.changed` under the key, while a Y.Map
 * created inside the transaction never appears there at all (its items post-
 * date `tr.beforeState`) and is only reachable by scanning the changed
 * arrays. Both reduce to the same test — pre-value versus post-value.
 *
 * Two scopes, deliberately different:
 *
 * - `COURSE_MARKER_KEY` on **every** Y.Map. Clients never legitimately touch
 *   it in either direction, so a forge is refused as firmly as a strip.
 * - `ROW_ID_KEY`, `SLUG_KEY` and `SOURCE_URL_KEY`, only on a Y.Map that
 *   carried the marker **at the snapshot**. The first two are how the
 *   replacement sweep's branch selector and the DO's own dedupe resolve
 *   identity, so on a course item they have to be immutable from clients or
 *   the discriminators can be steered — and an unguarded slug is worse than an
 *   unguarded `_id`, because the sweep *acts* on it: rename a course item onto
 *   another object's slug and its deletion aims the sweep at that object,
 *   which is a deletion primitive against content the actor could not
 *   otherwise touch. On ordinary content all three are untouched here, and a
 *   map that only became "marked" inside this transaction gets no protection
 *   from a marker that is itself being reverted here — you cannot buy immunity
 *   by inventing a course item.
 *
 * Three of those four are the identity set **for the course-item rule**:
 * exactly the fields the marker pass, the replacement sweep, the branch
 * selector and the DO's dedupe read to decide a course item's identity and
 * eligibility. Any future discriminator built on another client-writable field
 * has to join them. `SOURCE_URL_KEY` is there for a different reason and no
 * machinery reads it — see its own comment: a course item whose image a child
 * can repoint has stopped being a course item.
 *
 * `created_by` is NOT here, and its absence is not a gap. It is governed by
 * `extractIdentityMutations` instead, which reaches every map on every project
 * rather than only marked ones — the own-content delete rule it protects
 * governs all ordinary content. See `DO_OWNED_IDENTITY_KEYS_BY_ROOT`. At module scope the set is larger and not all of it is guarded:
 * `findDurableReplacements` reads `_temp_id`, but only to widen a sweep it
 * already runs, and only against a Y.Map born inside the offending
 * transaction — it can add a removal, never excuse a delete. And
 * `extractUnauthorisedDeletes` reads `created_by`, which was client-writable
 * and was the own-content rule's own exposure until `extractIdentityMutations`
 * began reverting it.
 *
 * @param beforeSnapshot  Y.Snapshot from `beforeTransaction`, or null. Null
 *                        is safe: it occurs only on the convenor path, and
 *                        only when `docHasCourseItems` was false — so no
 *                        marker existed to restore and the pre-value is
 *                        provably absent. A strip always has a snapshot,
 *                        since a marked object makes that gate true, and the
 *                        `_id` branch requires one by construction.
 */
export function extractProtectedFieldMutations(
  ydoc: Y.Doc,
  tr: Y.Transaction,
  beforeSnapshot: Y.Snapshot | null = null,
): ProtectedFieldMutation[] {
  const candidates = new Set<Y.Map<unknown>>();

  tr.changed.forEach((keys, type) => {
    if (type instanceof Y.Map) {
      if (
        keys.has(COURSE_MARKER_KEY)
        || keys.has(ROW_ID_KEY)
        || keys.has(SLUG_KEY)
        || keys.has(SOURCE_URL_KEY)
      ) {
        candidates.add(type as Y.Map<unknown>);
      }
      return;
    }
    if (type instanceof Y.Array) {
      // Y.Maps born in this transaction — a forged marker on a freshly
      // inserted object reaches the document no other way.
      if (!isProtectedParentArray(type, ydoc)) return;
      for (let i = 0; i < type.length; i++) {
        const child = type.get(i);
        if (child instanceof Y.Map && child.get(COURSE_MARKER_KEY) !== undefined) {
          candidates.add(child as Y.Map<unknown>);
        }
      }
    }
  });

  if (candidates.size === 0) return [];

  const mutations: ProtectedFieldMutation[] = [];
  for (const yMap of candidates) {
    // A Y.Map deleted in this same transaction is handled by the delete
    // passes, which rebuild it from the snapshot; writing to the tombstone
    // would only add an item under a dead parent.
    if ((yMap as unknown as { _item?: { deleted?: boolean } })._item?.deleted) continue;

    // ---- the course marker, on every map ----
    // No snapshot means the convenor path with `docHasCourseItems` false:
    // nothing in the document carried a marker, so the pre-value is absent.
    // Reading live here instead would compare the post-value with itself and
    // wave a forged marker through.
    const wasMarked = beforeSnapshot ? readCourseMarker(yMap, beforeSnapshot) : null;
    const isMarked = readCourseMarker(yMap, null);
    if (wasMarked !== isMarked) {
      // No carry-across case to allow for: nothing legitimately moves a marker
      // onto a Y.Map born inside a client transaction, now that a reorder
      // creates no such map.
      mutations.push({
        yMap,
        key: COURSE_MARKER_KEY,
        // With no snapshot the pre-value is provably absent (see above); a
        // live read here would hand back the forged value and re-apply it.
        previous: beforeSnapshot
          ? readKey(yMap, COURSE_MARKER_KEY, beforeSnapshot)
          : undefined,
      });
    }

    // ---- the identity keys, only where the marker was already set ----
    if (beforeSnapshot && wasMarked !== null) {
      // Raw comparison, not normalised: normalisedRowId maps every non-number
      // to null, so a null -> "100" write would be invisible here while
      // deduplicateYArray and insertObjectRow both read it as persisted.
      const previousRowId = readKey(yMap, ROW_ID_KEY, beforeSnapshot);
      if (previousRowId !== yMap.get(ROW_ID_KEY)) {
        mutations.push({ yMap, key: ROW_ID_KEY, previous: previousRowId });
      }
      const previousSlug = readKey(yMap, SLUG_KEY, beforeSnapshot);
      if (previousSlug !== yMap.get(SLUG_KEY)) {
        mutations.push({ yMap, key: SLUG_KEY, previous: previousSlug });
      }
      const previousSourceUrl = readKey(yMap, SOURCE_URL_KEY, beforeSnapshot);
      if (previousSourceUrl !== yMap.get(SOURCE_URL_KEY)) {
        mutations.push({ yMap, key: SOURCE_URL_KEY, previous: previousSourceUrl });
      }
    }
  }
  return mutations;
}

/**
 * The identity keys the DO owns for `yMap`, from where it sits, or null when
 * it sits outside every protected array (a `config` child, a nested Y.Map
 * inside an entity, a root type).
 *
 * A Y.Map's `_item` IS the array item holding it, so its parent is the array
 * — the same route `collectDeletedProtectedMaps` takes, and the reason a
 * `steps` map can be told apart from an `objects` map without reading a
 * single field off either.
 */
export function doOwnedIdentityKeysFor(
  yMap: Y.Map<unknown>,
  ydoc: Y.Doc,
): ReadonlySet<string> | null {
  const parent = (yMap as unknown as { _item?: { parent?: object | null } })._item?.parent;
  if (!parent || typeof parent === "string") return null;
  if (!(parent instanceof Y.Array)) return null;
  const cls = classifyParentArray(parent, ydoc);
  if (!cls) return null;
  return cls.kind === "root"
    ? DO_OWNED_IDENTITY_KEYS_BY_ROOT.get(cls.name) ?? null
    : DO_OWNED_IDENTITY_KEYS_BY_NESTED_KEY.get(cls.key) ?? null;
}

/**
 * Identity pass — reverts any client write to a DO-owned identity key on a
 * Y.Map that existed before the transaction.
 *
 * This is the general form of what `extractProtectedFieldMutations` did only
 * for course-marked objects. The narrow version left this open on every
 * ordinary site: rename your own object's `object_id` onto a victim's slug,
 * drag it above theirs, and the DO's own pre-snapshot `deduplicateYArray`
 * removes the victim's Y.Map and the orphan sweep deletes their D1 row — a
 * deletion primitive that issues no delete, so nothing reverts and no strike
 * is recorded.
 *
 * It is affordable as an always-on rule because `readKeyBeforeTransaction`
 * recovers the pre-value from `tr.beforeState` and `tr.deleteSet` rather than
 * from a `Y.Snapshot`. That is also why it holds on the convenor path, where
 * `beforeTransaction` deliberately skips the snapshot when the document holds
 * no course item — the right response to that gap is a reader that needs no
 * snapshot, not an unconditional snapshot on every convenor transaction.
 *
 * Two candidate sources are deliberately NOT used here:
 *
 * - Maps born inside the transaction. Their items post-date `tr.beforeState`,
 *   so the invariant does not reach them by construction. A born map claiming
 *   a DELETED map's identity is the delete-and-replace question the reorder
 *   exemption owns, answered by `findDurableReplacements`; one
 *   claiming a LIVE map's row id is answered by `extractBornIdentityClaims`.
 * - Maps this transaction deleted. The delete passes rebuild those from the
 *   snapshot; writing to the tombstone would add an item under a dead parent.
 */
export function extractIdentityMutations(
  ydoc: Y.Doc,
  tr: Y.Transaction,
): ProtectedFieldMutation[] {
  const mutations: ProtectedFieldMutation[] = [];
  tr.changed.forEach((keys, type) => {
    if (!(type instanceof Y.Map)) return;
    const yMap = type as Y.Map<unknown>;
    const item = (yMap as unknown as { _item?: { deleted?: boolean } })._item;
    if (!item || item.deleted) return;
    if (isInsertedInTransaction(yMap, tr)) return;
    const owned = doOwnedIdentityKeysFor(yMap, ydoc);
    if (!owned) return;
    for (const key of keys) {
      if (key === null || !owned.has(key)) continue;
      const before = readKeyBeforeTransaction(yMap, key, tr);
      const previous = "absent" in before ? undefined : before.value;
      const current = yMap.get(key);
      // An absent key reads back as undefined either way; a write that lands
      // on the value already there is not a change and must not cost a strike.
      if (previous === current) continue;
      mutations.push({ yMap, key, previous });
    }
  });
  return mutations;
}

/**
 * Config pass — reverts a non-convenor's write to one of the six fields that
 * decide where the site lives, how it is built and where its data comes from.
 *
 * The list is `CONVENOR_ONLY_CONFIG_FIELDS`, imported rather than restated:
 * the route action, the config page's field gates and this pass have to agree,
 * and three hand-maintained copies of one rule diverge on the first field
 * anyone moves across the line.
 *
 * The route half is defence in depth; this is the enforcement. `snapshotConfig`
 * writes 23 of the 24 `project_config` columns straight from this map for
 * whoever holds a socket, so the document — not the action — is what reaches
 * D1 and the published `_config.yml`. Two of the six,
 * `google_sheets_enabled` and `google_sheets_published_url`, have no control on
 * the form at all, so the document is their only write path and the action
 * never writes them for anybody.
 *
 * Keyed off `tr.changed` rather than off the post-values, so a DELETE counts as
 * a write: `snapshotConfig` coerces a missing key to a default
 * (`String(config.get("url") ?? "")`), and blanking the site's address destroys
 * it as thoroughly as repointing it.
 *
 * Two sources, because a shared type at one of the six is reached two ways. A
 * client that ASSIGNS one changes the root and appears under the key; a client
 * that edits the CONTENTS of one already standing there changes only that type,
 * which has its own entry in `tr.changed` and never touches the root. The
 * second is the one `snapshotConfig` cannot tell apart from an honest value, so
 * `guardedConfigKeyFor` resolves a changed type's ancestry back to the config
 * root and the pass reverts by the key it stands under. The two sources are
 * deduplicated by key inside the pass, so a transaction doing both costs one
 * write and one strike.
 *
 * The revert for the contents source is the KEY, not the contents. Restoring
 * the contents would need an inverse delta replayed onto a live integrated type
 * — the mirror builds detached clones and cannot write one back — and would
 * leave the illegitimate shared type standing at the key for the next
 * transaction to edit again. Since the six hold scalars and nothing legitimate
 * parks a shared type on them, the pre-transaction value of the key is that
 * same shared type, and the executor's shared-value branch clears the key.
 * `snapshotConfig` then coerces the absent key to its default: a blank address
 * is a broken build, which a convenor repairs, where the attacker's address is
 * a hijack nobody sees.
 *
 * Like the identity pass it needs no `Y.Snapshot`:
 * `readKeyBeforeTransaction` recovers the pre-value from `tr.beforeState` and
 * `tr.deleteSet`, so nothing here depends on whether `beforeTransaction`
 * happened to take one. That independence is what the identity pass buys reach
 * with; this pass gets only the cost saving from it, because the convenor path
 * — the one where the snapshot is skipped — is the path it returns empty on.
 *
 * The config root has a **null `_item`**: it belongs to no parent item, so the
 * `if (!item || item.deleted) return` guard the identity pass opens with would
 * skip this map on every transaction and the rule would silently do nothing.
 * The root's liveness is checked by name against `ydoc.share` instead. Reading
 * `share` rather than calling `getMap` also means a document that never built a
 * config root is answered without one being created here.
 */
export function extractConfigFieldMutations(
  ydoc: Y.Doc,
  tr: Y.Transaction,
  actor: UserContext,
): ProtectedFieldMutation[] {
  if (actor.role === "convenor") return [];
  const root = (ydoc as unknown as { share: Map<string, unknown> })
    .share.get(CONFIG_ROOT_NAME);
  if (!(root instanceof Y.Map)) return [];
  const configMap = root as Y.Map<unknown>;

  const mutations: ProtectedFieldMutation[] = [];
  // One mutation per key across both sources. A transaction that assigns a
  // shared type to a guarded key AND edits its contents appears in both, and
  // two entries for one (map, key) would write the pre-value twice and count
  // the strike twice. The assignment wins, because it carries the real
  // pre-transaction scalar while the contents source can only clear the key.
  const covered = new Set<string>();

  // ---- writes to the key itself, on the config root ----
  tr.changed.forEach((keys, type) => {
    if ((type as unknown) !== root) return;
    for (const key of keys) {
      if (key === null || !isConvenorOnlyConfigField(key)) continue;
      const before = readKeyBeforeTransaction(configMap, key, tr);
      const previous = "absent" in before ? undefined : before.value;
      const current = configMap.get(key);
      // An absent key reads back as undefined either way; a write that lands
      // on the value already there is not a change and must not cost a strike.
      if (previous === current) continue;
      covered.add(key);
      mutations.push({ yMap: configMap, key, previous });
    }
  });

  // ---- writes inside a shared type standing at the key ----
  tr.changed.forEach((_keys, type) => {
    if ((type as unknown) === root) return;
    const key = guardedConfigKeyFor(type, configMap);
    if (key === null || covered.has(key)) return;
    covered.add(key);
    // No pre-value/post-value comparison here, and none is possible: the key
    // still holds the same value OBJECT — only its contents moved — so the
    // test the branch above uses would discard every one of these. Presence in
    // `tr.changed` under a guarded key IS the change, and it is unconditionally
    // a violation because nothing legitimate parks a shared type on the six.
    const before = readKeyBeforeTransaction(configMap, key, tr);
    mutations.push({
      yMap: configMap,
      key,
      previous: "absent" in before ? undefined : before.value,
    });
  });

  return mutations;
}

/**
 * The convenor-only config key a changed shared type sits beneath, or null when
 * it sits anywhere else in the document.
 *
 * A value that is itself a shared type carries its own mutation surface: it is
 * a separate Yjs type with its own entry in `tr.changed`, and editing its
 * contents changes THAT type and never the config root. A pass that takes only
 * the root's entry therefore never runs on the edit, while `snapshotConfig`
 * stringifies whatever stands at the key straight into D1 and the published
 * `_config.yml`.
 *
 * The route back to the root is `_item.parent`, with `_item.parentSub` naming
 * the key at each map hop. It has to be walked as an ANCESTRY, not tested one
 * hop: a `Y.Map` at `url` holding a `Y.Text` puts the changed type two levels
 * below the root, where a single-hop test reads the intermediate map as
 * ungoverned ground and waves the edit through. Array hops carry a null
 * `parentSub` and name no key, which is why the answer is taken from the hop
 * that lands on the config root rather than from the changed type's own item.
 *
 * The config root itself answers null: its `_item` is null, so its own entry in
 * `tr.changed` falls to the key-write branch above and is never counted twice.
 *
 * `seen` is what makes the walk terminate on any input. Yjs cannot build a
 * cycle — integrating a type beneath itself throws — but this reads a
 * client-authored structure through raw internals, and a walk that failed to
 * terminate here would hang the Durable Object rather than fail one check.
 */
export function guardedConfigKeyFor(
  type: unknown,
  configRoot: Y.Map<unknown>,
): string | null {
  const seen = new Set<unknown>();
  let cur: unknown = type;
  while (cur !== null && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const item = (cur as {
      _item?: { parent?: unknown; parentSub?: string | null } | null;
    })._item;
    // A root shared type belongs to no parent item, so the walk ends here.
    if (!item) return null;
    if (item.parent === configRoot) {
      const sub = item.parentSub;
      return typeof sub === "string" && isConvenorOnlyConfigField(sub) ? sub : null;
    }
    cur = item.parent;
  }
  return null;
}

/** A Y.Map born in this transaction claiming a live neighbour's row id. */
export interface BornIdentityClaim {
  yMap: Y.Map<unknown>;
  parentArray: Y.Array<Y.Map<unknown>>;
  rowId: number;
}

/**
 * Born-identity pass — an insert that claims a row another Y.Map still holds.
 *
 * `extractIdentityMutations` cannot reach this shape by construction: a map
 * born inside the transaction has no pre-transaction value to compare against,
 * and the delete passes cannot reach it either, because the attack issues no
 * delete. A collaborator inserts an unmarked Y.Map ahead of the victim
 * carrying the victim's `_id`; nothing is reverted, and the DO's pre-snapshot
 * `deduplicateYArray` then collapses the exact-`_id` pair by keeping the first
 * — deleting the genuine map, course marker and all, and snapshotting the
 * forgery over its row.
 *
 * The rule is `_id` and nothing else, and the scope is the argument for its
 * safety:
 *
 * - `_id` is minted by the Durable Object, one live Y.Map per row. A born map
 *   carrying a row id that a map already in the array still holds afterwards
 *   has no honest author. Every legitimate insert that carries a row id — an
 *   undo of a delete, a restore from the orphan list, the clone half of a
 *   delete-and-reinsert — carries one whose original is GONE, either removed
 *   before this transaction or removed inside it. Hence "still live": the
 *   incumbent is read by live iteration, which skips what this transaction
 *   tombstoned, and the delete-and-replace shape stays with
 *   `findDurableReplacements`, where it belongs.
 * - The HUMAN key is deliberately out of scope. Two people naming an object
 *   from the same file collide honestly, and `deduplicateYArray` answers that
 *   by RE-KEYING the loser rather than deleting it — no destruction to
 *   prevent, and a rule reaching it would remove honest work on nothing better
 *   than arrival order.
 *
 * The incumbent's row id is read as it stood BEFORE the transaction, because
 * a client write to a live map's `_id` is reverted by the identity pass: the
 * value the document settles on is the pre-transaction one, and matching the
 * post-transaction one would let an attacker dodge this by rewriting the
 * victim's `_id` in the same breath.
 */
export function extractBornIdentityClaims(
  ydoc: Y.Doc,
  tr: Y.Transaction,
): BornIdentityClaim[] {
  const claims: BornIdentityClaim[] = [];
  tr.changed.forEach((_keys, type) => {
    if (!(type instanceof Y.Array)) return;
    if (!isProtectedParentArray(type, ydoc)) return;
    const parentArray = type as Y.Array<Y.Map<unknown>>;

    // Born maps first, and only their own `_id` — a client's ordinary insert
    // carries `_id: null`, so the usual answer is an empty list and the
    // pre-transaction reads below are never paid for.
    const born: Array<{ yMap: Y.Map<unknown>; rowId: number }> = [];
    const members: Y.Map<unknown>[] = [];
    for (let i = 0; i < parentArray.length; i++) {
      const child = parentArray.get(i);
      if (!(child instanceof Y.Map)) continue;
      if (!isInsertedInTransaction(child, tr)) { members.push(child as Y.Map<unknown>); continue; }
      const rowId = normalisedRowId(child.get(ROW_ID_KEY));
      if (rowId !== null) born.push({ yMap: child as Y.Map<unknown>, rowId });
    }
    if (born.length === 0) return;

    const incumbentRowIds = new Set<number>();
    for (const member of members) {
      const before = readKeyBeforeTransaction(member, ROW_ID_KEY, tr);
      const rowId = normalisedRowId("absent" in before ? undefined : before.value);
      if (rowId !== null) incumbentRowIds.add(rowId);
    }

    for (const { yMap, rowId } of born) {
      if (incumbentRowIds.has(rowId)) claims.push({ yMap, parentArray, rowId });
    }
  });
  return claims;
}

/** A born Y.Map removed because it carries an out-of-domain identity value. */
export interface IdentityDomainRemoval {
  yMap: Y.Map<unknown>;
  parentArray: Y.Array<Y.Map<unknown>>;
  /** The key whose value fell outside its domain. Reported, never repaired. */
  key: string;
}

/** What the domain pass found: born maps to remove, live maps to restore. */
export interface IdentityDomainViolations {
  removals: IdentityDomainRemoval[];
  mutations: ProtectedFieldMutation[];
}

/**
 * The Y.Map a changed shared type stands on, when it stands at a governed
 * identity key. Null for everything else.
 *
 * The ancestry walk exists because a value planted at a reconciliation key has
 * a second mutation surface the key itself never reports: editing the `Y.Text`
 * at `object_id` changes that `Y.Text` and never the entity map, so the entity
 * map does not appear in `tr.changed` at all. The same shape
 * `guardedConfigKeyFor` answers for the config root, answered here for an
 * array member.
 *
 * The walk stops at the first item that stands under a KEY: that is the
 * owning pair, and if the key is not governed there is nothing above it to
 * find.
 */
function owningIdentityDomainMap(
  type: unknown,
  ydoc: Y.Doc,
): Y.Map<unknown> | null {
  const seen = new Set<unknown>();
  let cur: unknown = type;
  while (cur !== null && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const item = (cur as {
      _item?: { parent?: unknown; parentSub?: string | null } | null;
    })._item;
    if (!item) return null; // a root shared type belongs to no parent item
    const parent = item.parent;
    if (typeof item.parentSub === "string") {
      if (!(parent instanceof Y.Map)) return null;
      const owner = parent as Y.Map<unknown>;
      return identityDomainKeysFor(owner, ydoc)?.has(item.parentSub) ? owner : null;
    }
    cur = parent;
  }
  return null;
}

/**
 * The identity keys whose value domain is governed for `yMap`, from where it
 * sits, or null when it sits outside every protected array.
 *
 * Position, not contents, exactly as `doOwnedIdentityKeysFor` — a `steps` map
 * and an `objects` map are told apart by their parent array and nothing else.
 */
export function identityDomainKeysFor(
  yMap: Y.Map<unknown>,
  ydoc: Y.Doc,
): ReadonlySet<string> | null {
  const parent = (yMap as unknown as { _item?: { parent?: object | null } })._item?.parent;
  if (!parent || typeof parent === "string") return null;
  if (!(parent instanceof Y.Array)) return null;
  const cls = classifyParentArray(parent, ydoc);
  if (!cls) return null;
  return cls.kind === "root"
    ? IDENTITY_DOMAIN_KEYS_BY_ROOT.get(cls.name) ?? null
    : IDENTITY_DOMAIN_KEYS_BY_NESTED_KEY.get(cls.key) ?? null;
}

/**
 * Value-domain pass — refuses a value that is not the KIND of thing its
 * identity key holds.
 *
 * Every server-side reconciliation key is read by rendering whatever the
 * document holds: `deduplicateYArray` takes its key as
 * `renderedKey(yArray.get(i).get(entityKey))`. A `Y.Text`, a plain array, a
 * plain object or a subdocument standing at that key therefore renders to a
 * colleague's key and is that key as far as reconciliation is concerned — and
 * once planted, its contents can be changed without the entity map ever
 * appearing in `tr.changed`, which is what put it beyond the passes above.
 * The measured consequence is a re-key: the victim's entity becomes
 * `<key>-2` and every reference to the old key — steps, navigation, glossary
 * refs, published CSVs — resolves to the attacker's entity instead.
 *
 * Two remedies, chosen by where the map came from and nothing else:
 *
 * - **Born in this transaction** — remove the map. It is brand new and nothing
 *   references it yet (references are established only after creation), so
 *   removal costs the document nothing and needs no replacement value minted.
 *   The executor's existing `removals` machinery performs it.
 * - **Pre-existing** — restore the pre-transaction value, the way every other
 *   field rule does. `readKeyBeforeTransaction` recovers it without a
 *   `Y.Snapshot`, so this holds on the convenor path too.
 *
 * The third case is deliberately NOT repaired here: a pre-existing map whose
 * pre-transaction value was ALSO out of domain, which is what a document
 * planted before this shipped looks like. Choosing a correct replacement needs
 * to know which D1 row owns the key, and a synchronous `afterTransaction`
 * guard cannot read D1. Minting, blanking or guessing one here would destroy
 * the reference it was reaching for, so the case belongs to load-time
 * normalisation in `ensureDocLoaded`, which has D1 in hand.
 *
 * Renaming is untouched by construction: the rule constrains the value's
 * DOMAIN and never its content, and a rename writes a string.
 */
export function extractIdentityDomainViolations(
  ydoc: Y.Doc,
  tr: Y.Transaction,
): IdentityDomainViolations {
  const removals: IdentityDomainRemoval[] = [];
  const mutations: ProtectedFieldMutation[] = [];

  // Three sources, deduplicated to one candidate SET before anything is
  // reported: a changed map, a map this transaction inserted, and the map a
  // changed shared type stands on. A transaction can present the same map
  // through all three, and two reports for one (map, key) would write the
  // pre-value twice and inflate the executor's counts.
  const candidates = new Set<Y.Map<unknown>>();
  tr.changed.forEach((_keys, type) => {
    if (type instanceof Y.Map) candidates.add(type as Y.Map<unknown>);
    if (type instanceof Y.Array && isProtectedParentArray(type, ydoc)) {
      for (let i = 0; i < type.length; i++) {
        const child = type.get(i);
        if (child instanceof Y.Map && isInsertedInTransaction(child as Y.Map<unknown>, tr)) {
          candidates.add(child as Y.Map<unknown>);
        }
      }
    }
    const owner = owningIdentityDomainMap(type, ydoc);
    if (owner) candidates.add(owner);
  });

  const processed = new Set<Y.Map<unknown>>();

  /** Judge one map. Returns true when it was removed, so no descent follows. */
  const consider = (yMap: Y.Map<unknown>): boolean => {
    if (processed.has(yMap)) return false;
    processed.add(yMap);
    const item = (yMap as unknown as {
      _item?: { deleted?: boolean; parent?: unknown };
    })._item;
    // A Y.Map this transaction deleted is the delete passes' business: they
    // rebuild it from the snapshot, and writing to the tombstone would only
    // add an item under a dead parent.
    if (!item || item.deleted) return false;
    const keys = identityDomainKeysFor(yMap, ydoc);
    if (!keys) return false;
    const born = isInsertedInTransaction(yMap, tr);
    for (const key of keys) {
      if (isIdentityValueInDomain(key, yMap.get(key))) continue;
      if (born) {
        // One removal for the map, not one per key — the map goes whole.
        removals.push({
          yMap,
          parentArray: item.parent as Y.Array<Y.Map<unknown>>,
          key,
        });
        return true;
      }
      const before = readKeyBeforeTransaction(yMap, key, tr);
      const previous = "absent" in before ? undefined : before.value;
      // Load-time normalisation owns the pre-planted case; see above.
      if (!isIdentityValueInDomain(key, previous)) continue;
      mutations.push({ yMap, key, previous });
    }
    return false;
  };

  /**
   * A nested array born inside a born parent has no entry in `tr.changed` —
   * its items post-date `tr.beforeState`, so Yjs never records it — and a
   * story created with a forged step inside it would otherwise arrive
   * unexamined. Descent stops at a map already removed: removing a child of a
   * map that is itself going would write into a tombstoned array.
   */
  const descend = (yMap: Y.Map<unknown>): void => {
    for (const nestedKey of PROTECTED_NESTED_KEYS) {
      const nested = yMap.get(nestedKey);
      if (!(nested instanceof Y.Array)) continue;
      // The container's age, not the owner's: an array created in this
      // transaction is invisible to `tr.changed` whether or not the map it was
      // attached to is also new, and a forged step inside one would otherwise
      // arrive unexamined.
      //
      // The skip for an older array is a COST guard and not a correctness one,
      // which is worth saying because no test can fail without it: `consider`
      // already declines a value that was out of domain before the
      // transaction, so descending into an existing array reaches the same
      // answer by more work — proportional to every step of every story a
      // transaction touches, on every transaction.
      if (!isInsertedInTransaction(nested, tr)) continue;
      for (let i = 0; i < nested.length; i++) {
        const child = nested.get(i);
        if (!(child instanceof Y.Map)) continue;
        candidates.add(child as Y.Map<unknown>);
      }
    }
  };

  // Iterated rather than recursed, for the reason given on the structural
  // pass's worklist: a client authors the nesting, and a stack overflow here
  // escapes before anything is reverted. A Set visits entries added during
  // iteration, so a born child added by `descend` is considered in turn, and
  // `processed` keeps that to once each.
  for (const candidate of candidates) {
    const removedWhole = consider(candidate);
    // A map going whole takes its children with it, so descending into one
    // would only schedule writes under a tombstone.
    if (!removedWhole) descend(candidate);
  }

  return { removals, mutations };
}

/* ------------------------------------------------------------------ *
 * Structural shape — the keys that must hold a container
 * ------------------------------------------------------------------ */

/**
 * The keys whose value has to be a particular shared type, and which one.
 *
 * These are the keys the server TRAVERSES. Yjs stores plain JSON verbatim, so
 * a collaborator can put `{}`, `[]`, `"x"` or `null` at any of them, and the
 * server's next line — `.get(i)`, `.toArray()` — is a `TypeError` thrown
 * inside whichever batch it was in. The reconciler no longer breaks on one
 * (workers/collaboration.ts reads every container against a domain), but it
 * cannot un-break the document: the value stays where it was written, and the
 * editor for that story or that site's navigation is unusable until somebody
 * clears it by hand.
 *
 * This is where it stops being written, and refusal is the whole remedy —
 * nothing here reconstructs, guesses, or reads D1. That distinction is what
 * separates it from the load-time repair removed on 28 August: an identity
 * plant left the server unable to say WHICH entity a value meant, and every
 * answer to that was a guess. There is no equivalent question here. `steps`
 * either holds a `Y.Array` or it does not, and what it held a moment ago is a
 * fact the transaction itself carries.
 */
export const STRUCTURAL_SHAPE_BY_KEY: ReadonlyMap<string, "array" | "map"> =
  new Map([
    ["steps", "array"],
    ["layers", "array"],
    ["navigation", "array"],
    ["landing", "map"],
  ]);

/**
 * Exactly a `Y.Array` or exactly a `Y.Map` — the constructor, not the
 * prototype chain.
 *
 * `instanceof` admits subclasses, and `Y.XmlHook extends Y.Map`, so an
 * `instanceof` test called an XmlHook a well-shaped `landing`. The mirror this
 * guard restores through admits only the exact constructors, so such a value
 * could be stored, then replaced with plain JSON, and the rebuild of the
 * "previous" value would fail — leaving the plant standing. Accepting a value
 * the restore path cannot reproduce is the same defect as accepting one the
 * reconciler cannot read, and the two tests have to agree on what a container
 * is.
 */
function matchesStructuralShape(value: unknown, shape: "array" | "map"): boolean {
  const ctor = (value as { constructor?: unknown } | null)?.constructor;
  return ctor === (shape === "array" ? Y.Array : Y.Map);
}

/** A structural key whose value this transaction put out of shape. */
export interface StructuralShapeViolation {
  yMap: Y.Map<unknown>;
  key: string;
  /** What the key held before the transaction; `undefined` when it held nothing. */
  previous: unknown;
}

export interface StructuralShapeViolations {
  restores: StructuralShapeViolation[];
  /**
   * Array positions holding something that is not a Y.Map, newly inserted.
   *
   * The POSITION, not the value. Keying these by the value collapsed equal
   * primitives — inserting `[null, null]` produced one entry and removed one
   * of them, leaving the other standing in a persisted array where every
   * consumer expects a Y.Map.
   */
  elements: Array<{ parentArray: Y.Array<Y.Map<unknown>>; index: number }>;
}

/**
 * The maps whose structural keys this pass governs.
 *
 * A key that is absent fires nothing, so the table can be applied to any map
 * in a governed position without scoping each key to its own entity type: an
 * object has no `steps`, so asking about one costs a `get` and answers
 * `undefined`. The config root is included by name because it is the only map
 * carrying `navigation` and `landing`, and it sits in no array.
 */
function governsStructuralKeys(yMap: Y.Map<unknown>, ydoc: Y.Doc): boolean {
  if (yMap === ydoc.getMap(CONFIG_ROOT_NAME)) return true;
  const item = (yMap as unknown as { _item?: { parent?: unknown } })._item;
  const parent = item?.parent;
  if (!parent || typeof parent !== "object") return false;
  if (isProtectedParentArray(parent, ydoc)) return true;
  // A step map sits in its story's `steps` array, which is not a root.
  const parentItem = (parent as { _item?: { parentSub?: string | null } })._item;
  const parentSub = parentItem?.parentSub;
  return typeof parentSub === "string" && PROTECTED_NESTED_KEYS.has(parentSub);
}

/**
 * Structural-shape pass — a client write that put a traversed key out of shape.
 *
 * Reports what to put back rather than putting it back: the caller holds the
 * snapshot, and the previous value of one of these keys is a shared type,
 * which cannot be written back as it stands. Yjs reintegrates rather than
 * copies, so setting the displaced `Y.Array` returns a `TypeError`, and the
 * generic field-revert answers that by CLEARING the key — which for `steps`
 * would delete the story's steps and finish the job the plant started. The
 * caller rebuilds it from the snapshot instead, on the same machinery a
 * deleted entity is restored with.
 *
 * A displaced type reads as empty the moment its key is overwritten — Yjs
 * counts the whole subtree as deleted — so the snapshot is not an optimisation
 * here. It is the only way back to the content, and without one the caller
 * reports and touches nothing.
 */
export function extractStructuralShapeViolations(
  ydoc: Y.Doc,
  tr: Y.Transaction,
): StructuralShapeViolations {
  const restores: StructuralShapeViolation[] = [];
  const elements: Array<{ parentArray: Y.Array<Y.Map<unknown>>; index: number }> = [];

  const candidates = new Set<Y.Map<unknown>>();
  tr.changed.forEach((_keys, type) => {
    if (type instanceof Y.Map) candidates.add(type as Y.Map<unknown>);
    if (type instanceof Y.Array) {
      // An element that is not a Y.Map passes every `instanceof Y.Array` guard
      // the server has and throws on the line after it. Only one this
      // transaction inserted is this pass's business — an inherited one is the
      // detector's, and removing it would be the load-time repair again.
      const nestedOf = (type as unknown as {
        _item?: { parentSub?: string | null };
      })._item?.parentSub;
      const governed =
        isProtectedParentArray(type, ydoc) ||
        (typeof nestedOf === "string" && PROTECTED_NESTED_KEYS.has(nestedOf));
      if (!governed) return;
      for (let i = 0; i < type.length; i++) {
        const member = type.get(i);
        if (!(member instanceof Y.Map)) {
          if (!isInsertedValueInTransaction(type, i, tr)) continue;
          elements.push({ parentArray: type as Y.Array<Y.Map<unknown>>, index: i });
          continue;
        }
        // A map born in this transaction has no entry in `tr.changed` of its
        // own — its items post-date `tr.beforeState`, so Yjs never records one
        // — and a story created with a wrong-shaped `steps` inside it would
        // otherwise arrive unexamined.
        const born = member as Y.Map<unknown>;
        if (isInsertedInTransaction(born, tr)) candidates.add(born);
      }
    }
  });

  /**
   * The nested arrays of a born map, for the same reason: a story created with
   * a step whose `layers` is wrong-shaped carries that step in an array that
   * post-dates the transaction's before-state.
   */
  const descended = new Set<Y.Map<unknown>>();
  const descend = (yMap: Y.Map<unknown>): void => {
    if (descended.has(yMap)) return;
    descended.add(yMap);
    for (const nestedKey of PROTECTED_NESTED_KEYS) {
      const nested = yMap.get(nestedKey);
      if (!(nested instanceof Y.Array)) continue;
      // The CONTAINER's age decides this, never the owner's. An array this
      // transaction created holds only items it created — Yjs refuses to
      // reintegrate an existing type — and they post-date `tr.beforeState`,
      // so neither the array nor its members appear in `tr.changed` and
      // nothing else will look at them. An array that already existed does
      // appear there when a member is inserted, so the top-level scan owns
      // it, and its older members are the detector's rather than this pass's.
      if (!isInsertedInTransaction(nested, tr)) continue;
      for (let i = 0; i < nested.length; i++) {
        const child = nested.get(i);
        if (!(child instanceof Y.Map)) {
          elements.push({ parentArray: nested as Y.Array<Y.Map<unknown>>, index: i });
          continue;
        }
        candidates.add(child as Y.Map<unknown>);
      }
    }
  };
  // The Set is the worklist, and it must stay the only one. A Set visits
  // entries added while it is being iterated, so adding a born child is
  // enough to have it descended in turn — and `descend` therefore does NOT
  // call itself. Recursion here would bound depth by the JS stack, and a
  // client can author the nesting: at around five hundred levels the
  // `RangeError` lands BEFORE the guarded revert block, so nothing is
  // reverted, nothing is reported, and the transaction stands. `descended`
  // is what makes the walk terminate.
  for (const candidate of candidates) descend(candidate);

  for (const yMap of candidates) {
    const item = (yMap as unknown as { _item?: { deleted?: boolean } })._item;
    // A map this transaction deleted belongs to the delete passes, which
    // rebuild it whole; writing into the tombstone would only add an item
    // under a dead parent. The config root has no `_item` and is never
    // deleted, so it is admitted rather than skipped.
    if (item?.deleted) continue;
    if (!governsStructuralKeys(yMap, ydoc)) continue;

    for (const [key, shape] of STRUCTURAL_SHAPE_BY_KEY) {
      const value = yMap.get(key);
      const before = readKeyBeforeTransaction(yMap, key, tr);
      const previous = "absent" in before ? undefined : before.value;
      // Whether this key HELD a container before the transaction is the
      // question everything below turns on, so it is asked once. A key that
      // held one may not lose it, and a key that did not is nobody's to
      // defend.
      const heldOne = matchesStructuralShape(previous, shape);

      // Three ways to take a container away, and all three end with content
      // no consumer can reach: overwrite it with a wrong-shaped value,
      // overwrite it with a DIFFERENT container, or delete the key. The
      // middle two are reported as reverted deletions, because the delete
      // pass restores into the container it still holds a reference to — the
      // detached one — so the log says the content came back while the
      // document holds the replacement.
      //
      // Deleting the key is the worst of the three: the reconciler reads an
      // absent key as "no steps" and schedules every step and layer row for
      // deletion in D1, so the loss outlives the document.
      if (value === undefined) {
        if (heldOne) restores.push({ yMap, key, previous });
        continue;
      }

      if (matchesStructuralShape(value, shape)) {
        // Well shaped is not the same as unchanged. Reference identity is the
        // test: `readKeyBeforeTransaction` returns the type instance, so an
        // untouched key answers with the very container `get` just returned,
        // and only a reassignment differs.
        //
        // `heldOne` is what keeps a REPAIR legal. A key carrying an inherited
        // plant — a `{}` written before any of this shipped — has no container
        // to defend, and a client putting a real array there is fixing the
        // document, not damaging it. Refusing that would fail to rebuild the
        // plant and halt the project's persistence, which is the one outcome
        // no client-authored value may cause.
        if (heldOne && previous !== value) {
          restores.push({ yMap, key, previous });
        }
        continue;
      }

      // A wrong-shaped write. An inherited plant is the detector's: refusing a
      // write that did not make it would let one client's transaction be
      // refused for another's value. `previous === undefined` is a key this
      // transaction added, and clearing it is the right revert.
      if (previous !== undefined && !heldOne) continue;
      restores.push({ yMap, key, previous });
    }
  }

  return { restores, elements };
}

/**
 * Course-item pass — deletes of marked Y.Maps, unauthorised for every role.
 *
 * Takes no actor: the rule is the marker, not who holds the socket. The
 * caller runs it for convenor, instructor and collaborator alike.
 *
 * @param ydoc            The Y.Doc the transaction ran against.
 * @param tr              The transaction (`afterTransaction` argument).
 * @param beforeSnapshot  Y.Snapshot captured at `beforeTransaction`; without
 *                        it the marker is unreadable on a tombstoned Y.Map
 *                        and nothing is classified.
 */
export function extractCourseItemDeletes(
  ydoc: Y.Doc,
  tr: Y.Transaction,
  beforeSnapshot: Y.Snapshot | null = null,
): UnauthorisedDelete[] {
  if (tr.deleteSet.clients.size === 0) return [];
  const candidates = collectDeletedProtectedMaps(ydoc, tr);
  if (candidates.length === 0) return [];

  const unauthorised: UnauthorisedDelete[] = [];

  for (const { wrapped, parentArray, struct } of candidates) {
    const marker = readCourseMarker(wrapped, beforeSnapshot);
    if (marker === null) continue;

    unauthorised.push({
      deletedMap: wrapped,
      parentArray,
      ...computeDeletePosition(parentArray, struct, tr),
      // The replacement, if any, is swept by `findDurableReplacements` in the
      // handler — the same route that catches one which changes or omits
      // `_temp_id`. Nothing here needs to single out a "clone" any more.
      launderedClone: null,
    });
  }

  return unauthorised;
}

/**
 * Own-content pass — the collaborator rule. Deletes of Y.Maps inside
 * protected Y.Arrays whose `created_by` is not the acting user, with reorder
 * and cascade short-circuits applied. The convenor is exempt by design; the
 * course rule that is not role-exempt lives in `extractCourseItemDeletes`.
 *
 * @param ydoc            The Y.Doc the transaction ran against.
 * @param tr              The transaction (`afterTransaction` argument).
 * @param actor           The acting user's context.
 * @param beforeSnapshot  Y.Snapshot captured at `beforeTransaction` so we can
 *                        read `created_by` from now-tombstoned Y.Maps. May
 *                        be null only when the doc was empty pre-transaction
 *                        (no protected items exist to delete).
 * @returns               List of unauthorised deletes (empty if all authorised).
 */
export function extractUnauthorisedDeletes(
  ydoc: Y.Doc,
  tr: Y.Transaction,
  actor: { userId: number; role: "convenor" | "collaborator" | "instructor" },
  beforeSnapshot: Y.Snapshot | null = null,
): UnauthorisedDelete[] {
  if (actor.role === "convenor") return [];
  if (tr.deleteSet.clients.size === 0) return [];

  const unauthorised: UnauthorisedDelete[] = [];

  for (const { wrapped, parentArray, struct } of collectDeletedProtectedMaps(ydoc, tr)) {
    const createdBy = readKey(wrapped, "created_by", beforeSnapshot);
    if (createdBy === actor.userId) continue; // legitimate self-delete

    unauthorised.push({
      deletedMap: wrapped,
      parentArray,
      ...computeDeletePosition(parentArray, struct, tr),
    });
  }

  return unauthorised;
}

/**
 * Every deletion the transaction may not keep, once each.
 *
 * Two independent passes refuse deletions: the course pass is marker-based
 * and runs for every role; the own-content pass is the collaborator rule and
 * returns empty for a convenor. A delete can trip both, so each deleted map
 * is listed once, or the revert would insert the item twice.
 */
function deletesToRestore(
  ydoc: Y.Doc,
  tr: Y.Transaction,
  actor: UserContext,
  snap: Y.Snapshot | null,
): UnauthorisedDelete[] {
  const unauthorised: UnauthorisedDelete[] = [];
  const seen = new Set<Y.Map<unknown>>();
  const add = (entries: readonly UnauthorisedDelete[]): void => {
    for (const entry of entries) {
      if (seen.has(entry.deletedMap)) continue;
      seen.add(entry.deletedMap);
      unauthorised.push(entry);
    }
  };
  add([...extractCourseItemDeletes(ydoc, tr, snap), ...extractUnauthorisedDeletes(ydoc, tr, actor, snap)]);
  return unauthorised;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * The mark for one refusal.
 *
 * Wrapped so the cast past yjs's invariant event parameter — the compiler does
 * not accept a `Y.Array<Y.Map<unknown>>` as an `AbstractType<unknown>` — is
 * written once rather than at every refusal site.
 */
function noteRefusedChange(
  tr: Y.Transaction,
  type: Y.Array<Y.Map<unknown>> | Y.Map<unknown>,
  key: string | null,
  ydoc: Y.Doc,
): void {
  markRefused(tr, type as unknown as Y.AbstractType<unknown>, key, ydoc);
}

/**
 * Hand the clock ranges of every subtree this revert displaces to whoever is
 * counting the edits still addressed to them.
 *
 * A restore that clears a key the transaction added displaces nothing — there
 * was no container there to take away — which is what the container test below
 * says.
 */
function recordDisplacedSubtrees(
  restores: ReadonlyArray<{ previous: unknown }>,
  note: (ranges: ClockRange[]) => void,
): void {
  for (const { previous } of restores) {
    if (!(previous instanceof Y.Array) && !(previous instanceof Y.Map)) continue;
    const ranges = collectDisplacedRanges(previous as unknown as Y.AbstractType<unknown>);
    if (ranges.length > 0) note(ranges);
  }
}

/**
 * Install the canDelete enforcement on a Y.Doc. Registers a `beforeTransaction`
 * listener (captures pre-transaction snapshot for reading tombstoned Y.Maps)
 * and an `afterTransaction` listener (walks deleteSet, classifies, reverts).
 *
 * The factory is the single integration point used by both production
 * (workers/collaboration.ts) and the unit tests in
 * tests/collaboration-can-delete.test.ts. Behaviour is fully driven by the
 * injected dependencies — no implicit coupling to the DO runtime.
 *
 * Returns the `afterTransaction` handler for legacy direct-attach use; the
 * `beforeTransaction` listener is also attached internally via deps.ydoc.
 */
export function makeCanDeleteHandler(deps: CanDeleteDeps): (tr: Y.Transaction) => void {
  const warn = deps.warn ?? ((msg) => console.warn(msg));
  // Resolved once, so the handler below carries no branch for an unwired seam.
  const noteRevert = deps.noteRevert ?? (() => { /* nothing listening */ });
  const noteDisplacement = deps.noteDisplacement ?? (() => { /* nothing listening */ });
  const closeOffender =
    deps.closeSocket ?? ((ws: WebSocket, code: number, reason: string) => ws.close(code, reason));

  // Pre-transaction snapshot — captured on each beforeTransaction (for
  // client-origin transactions; null for DO-internal). Cleared on
  // afterTransaction. Stored on the closure so the after handler can read
  // it without leaking into deps.
  let beforeSnapshot: Y.Snapshot | null = null;

  deps.ydoc.on("beforeTransaction", (tr: Y.Transaction) => {
    // Capture only for transactions we MIGHT need to validate. Skipping the
    // snapshot for known-skip transactions is a meaningful perf saving —
    // every cold-start, snapshot, ID-backfill transaction would otherwise
    // pay a full state-vector encode.
    if (deps.isReverting()) { beforeSnapshot = null; return; }
    if (deps.isSnapshotting()) { beforeSnapshot = null; return; }
    const origin = tr.origin;
    if (typeof origin === "string") { beforeSnapshot = null; return; }
    const actor = getUserContext(origin);
    if (!actor) { beforeSnapshot = null; return; }
    // Every role gets a snapshot, and the convenor's is no longer optional.
    //
    // It used to be skipped for a convenor on a document with no course items,
    // because on that document neither delete pass could use one: the course
    // pass needs a marker and the own-content pass returns nothing for a
    // convenor, so the encode was pure cost. The structural pass changed that
    // — it runs for every role, and its restore is a rebuild from the
    // snapshot, because a displaced shared type reads as empty the instant its
    // key is overwritten. Skipping the encode now would mean a convenor could
    // put `steps` out of shape on their own site and the guard would have
    // nothing to put back, which on a shared site is a colleague's work.
    //
    // The saving that justified the skip is gone with its premise, and the
    // cost is the one every collaborator transaction already pays.
    beforeSnapshot = Y.snapshot(deps.ydoc);
  });

  const afterHandler = (tr: Y.Transaction) => {
    if (deps.isReverting()) { beforeSnapshot = null; return; }
    if (deps.isSnapshotting()) { beforeSnapshot = null; return; }

    const origin = tr.origin;
    if (typeof origin === "string") { beforeSnapshot = null; return; }
    const actor = getUserContext(origin);
    if (!actor) { beforeSnapshot = null; return; }

    const snap = beforeSnapshot;
    beforeSnapshot = null; // consume

    // The deletions to put back, each once; see `deletesToRestore`.
    const unauthorised = deletesToRestore(deps.ydoc, tr, actor, snap);
    // Every restore is BUILT before anything is mutated. `toCloneable` reads a
    // tombstoned subtree and `fromCloneable` constructs detached Y types;
    // neither touches the document. Doing that work inside the mutating
    // transaction meant one unbuildable value could abort the revert after the
    // sweep had already removed the replacements — the deletion left standing,
    // the strike never recorded, enforcement disarmed for the next transaction.
    // Split in two, a build failure costs a field or an entity and nothing else.
    interface PreparedRestore {
      parentArray: Y.Array<Y.Map<unknown>>;
      originalIndex: number;
      liveIndex: number;
      clone: Y.Map<unknown>;
    }
    const prepared: PreparedRestore[] = [];
    const degraded: string[] = [];
    const failed: string[] = [];
    // Replacements to remove alongside the restores, mapped to the array they
    // sit in. Two sources: the course pass's own `_temp_id`-keyed match, and a
    // sweep by identity, which is what catches a replacement that changes or
    // omits `_temp_id`. A sweep is only ever justified as making room for a
    // restoration, so an entity whose restoration could not be built takes its
    // replacements with it: removing them would delete the last map carrying
    // that row id and hand the row to the orphan sweep.
    // Keyed by the member rather than by a Y.Map, because a member need not be
    // one: a plain value at an array position is removed by the same sweep,
    // and Yjs returns a stable reference for it, so `indexOf` finds it.
    const removals = new Map<unknown, Y.Array<Y.Map<unknown>>>();
    for (const entry of unauthorised) {
      const failures: MirrorRebuildFailure[] = [];
      let clone: Y.Map<unknown>;
      try {
        clone = fromCloneable(toCloneable(entry.deletedMap, snap, failures), failures);
      } catch (error) {
        failed.push(`rebuild of entity at index ${entry.originalIndex}: ${describeError(error)}`);
        continue;
      }
      for (const f of failures) degraded.push(`${f.path}: ${describeError(f.error)}`);
      prepared.push({
        parentArray: entry.parentArray,
        originalIndex: entry.originalIndex,
        liveIndex: entry.liveIndex,
        clone,
      });

      if (entry.launderedClone) removals.set(entry.launderedClone, entry.parentArray);
      const marked = readCourseMarker(entry.deletedMap, snap) !== null;
      for (const replacement of findDurableReplacements(
        entry.deletedMap, entry.parentArray, snap, tr, deps.ydoc, marked,
      )) {
        removals.set(replacement, entry.parentArray);
      }
    }

    // A born forgery is an inserted map, so removal is its whole remedy and
    // the existing sweep is the path that performs it. It is added
    // unconditionally rather than per restored entity: unlike a replacement,
    // it is not making room for anything — it is an unauthorised insert on its
    // own terms, and there is no delete anywhere in the transaction to tie it
    // to.
    const bornClaims = extractBornIdentityClaims(deps.ydoc, tr);
    for (const claim of bornClaims) removals.set(claim.yMap, claim.parentArray);

    // The value-domain pass, before the field passes below so its born-map
    // removals are already in `removals` when they filter against it. Its own
    // sources are deduplicated inside the pass; what it cannot know is what
    // the other passes are already doing, which is what the filters answer.
    const domainViolations = extractIdentityDomainViolations(deps.ydoc, tr);
    for (const removal of domainViolations.removals) {
      removals.set(removal.yMap, removal.parentArray);
    }

    // A replacement being removed must not also be handled as a field
    // mutation: the revert would write its keys and then remove the map
    // itself, writing into a tombstone and inflating the counts below.
    //
    // The identity pass runs first and wins on overlap. Both passes guard
    // `_id` and `object_id`, but on different terms — the course pass only on
    // a marked map and only when a snapshot was taken, the identity pass on
    // every map in a governed position and with no snapshot at all — and two
    // entries for one (map, key) would write the pre-value twice and count the
    // strike twice.
    // The structural pass. Its element removals join the sweep; its key
    // restores are built here, before the revert transaction opens, on the
    // same rule as the entity restores above — a value that cannot be rebuilt
    // must not abort a revert that has already removed something.
    const structural = extractStructuralShapeViolations(deps.ydoc, tr);
    // Positional, and kept out of `removals`: that map is keyed by the member,
    // which is right for a Y.Map (a stable reference, one per entity) and
    // wrong for a primitive. Two `null`s inserted at two positions are one key
    // and one removal, and the survivor stands in an array every consumer
    // walks as Y.Maps.
    const elementRemovals = structural.elements;

    interface PreparedStructural {
      yMap: Y.Map<unknown>;
      key: string;
      /** The rebuilt container, or null to clear a key that held nothing. */
      clone: Y.Array<unknown> | Y.Map<unknown> | null;
      /**
       * The container the write took out of the document, when there was one.
       * A client that has not applied the correction still addresses ITS items
       * rather than the clone's, which is what the telemetry counts.
       */
      previous: unknown;
    }
    const structuralRestores: PreparedStructural[] = [];
    for (const violation of structural.restores) {
      if (removals.has(violation.yMap)) continue;
      if (violation.previous === undefined) {
        // The key held nothing before, so refusing the write is deleting it.
        // No snapshot needed, which is why this arm still runs when there is
        // none.
        structuralRestores.push({
          yMap: violation.yMap, key: violation.key, clone: null, previous: undefined,
        });
        continue;
      }
      if (!snap) {
        // The previous value was a shared type and it reads as empty now, so
        // without a snapshot there is nothing to put back. Reverting anyway
        // would clear the key and finish what the plant started.
        failed.push(
          `${violation.key}: refused a wrong-shaped write but could not rebuild ` +
          "the previous value without a snapshot, so it was left standing",
        );
        continue;
      }
      const failures: MirrorRebuildFailure[] = [];
      try {
        const rebuilt = fromCloneableValue(
          toCloneableValue(violation.previous, snap, failures, violation.key, 0),
          failures,
          violation.key,
        );
        if (!(rebuilt instanceof Y.Array) && !(rebuilt instanceof Y.Map)) {
          failed.push(`${violation.key}: rebuilt value was not a container`);
          continue;
        }
        for (const f of failures) degraded.push(`${f.path}: ${describeError(f.error)}`);
        structuralRestores.push({
          yMap: violation.yMap,
          key: violation.key,
          clone: rebuilt,
          previous: violation.previous,
        });
      } catch (error) {
        failed.push(`${violation.key}: rebuild failed: ${describeError(error)}`);
      }
    }

    // Before the revert opens, while the displaced items still carry their ids:
    // yjs collects the delete set once this transaction's handlers return, and
    // the ordinary accessors already answer empty for a displaced type.
    recordDisplacedSubtrees(structuralRestores, noteDisplacement);

    const identityMutations = extractIdentityMutations(deps.ydoc, tr)
      .filter(({ yMap }) => !removals.has(yMap));
    const identityCovered = new Map<Y.Map<unknown>, Set<string>>();
    for (const { yMap, key } of identityMutations) {
      const keys = identityCovered.get(yMap) ?? new Set<string>();
      keys.add(key);
      identityCovered.set(yMap, keys);
    }
    // The config pass overlaps neither of the other two: it addresses the
    // config ROOT map, which the identity pass skips (a root sits in no
    // protected array, so `doOwnedIdentityKeysFor` returns null) and which the
    // sweep never removes (removals hold array children). Its six keys are
    // disjoint from the marker and identity keys as well, so no (map, key)
    // pair can be counted or written twice.
    // A domain restore writes the same key as an identity restore would, so it
    // yields to the identity pass on overlap for the same reason the course
    // pass does — one (map, key), one write, one strike.
    const domainMutations = domainViolations.mutations.filter(({ yMap, key }) =>
      !removals.has(yMap) && !identityCovered.get(yMap)?.has(key));
    const covered = new Map(identityCovered);
    for (const { yMap, key } of domainMutations) {
      const keys = new Set(covered.get(yMap) ?? []);
      keys.add(key);
      covered.set(yMap, keys);
    }
    const configMutations = extractConfigFieldMutations(deps.ydoc, tr, actor);
    const fieldMutations = [
      ...identityMutations,
      ...domainMutations,
      ...extractProtectedFieldMutations(deps.ydoc, tr, snap)
        .filter(({ yMap, key }) =>
          !removals.has(yMap) && !covered.get(yMap)?.has(key)),
      ...configMutations,
    ];
    if (
      unauthorised.length === 0 &&
      fieldMutations.length === 0 &&
      removals.size === 0 &&
      structuralRestores.length === 0 &&
      elementRemovals.length === 0 &&
      failed.length === 0
    ) return;

    // Apply the revert under the re-entrancy guard. Each step is contained on
    // its own: one entity that cannot be restored, one replacement that cannot
    // be removed or one field that cannot be written must not carry away the
    // rest of the revert with it. The outer catch is for anything yjs itself
    // raises, since an exception escaping here would propagate into the DO's
    // `applyUpdate` path and take the socket message with it.
    let restored = 0;
    deps.setReverting(true);
    try {
      deps.ydoc.transact(() => {
        // Replacements first: removing them before the restores leaves one map
        // per identity. Their positions are read BEFORE any removal and kept,
        // because `liveIndex` counts the replacements as live neighbours — an
        // entity restored without that correction lands one place further
        // along for every forgery the transaction planted ahead of it.
        const removedBefore = new Map<Y.Array<Y.Map<unknown>>, number[]>();
        const planned: Array<{ parentArray: Y.Array<Y.Map<unknown>>; index: number }> = [];
        // The maps this sweep is taking whole. A removal from an array inside
        // one of them is not a second removal: the container carries its
        // contents away, and the delete that follows addresses a tombstone and
        // throws. Index order cannot decide this — it is a rule about SHIFTS
        // within one array and says nothing about one array living inside
        // another.
        // Untyped because the sweep's own list is: only maps are ever added,
        // so membership alone answers the question and a second `instanceof`
        // would be a condition no test could fail.
        const removedMaps = new Set<unknown>();
        const insideRemovedMap = (type: unknown): boolean => {
          let node: unknown = type;
          while (node) {
            const parent = (node as { _item?: { parent?: unknown } })._item?.parent;
            // A root type has no `_item`, so the walk ends there.
            if (!parent) return false;
            if (removedMaps.has(parent)) return true;
            node = parent;
          }
          return false;
        };
        const located: Array<{ parentArray: Y.Array<Y.Map<unknown>>; index: number }> = [];
        for (const [replacement, parentArray] of removals) {
          try {
            const at = (parentArray.toArray() as unknown[]).indexOf(replacement);
            if (at < 0) continue;
            located.push({ parentArray, index: at });
            removedMaps.add(replacement);
          } catch (error) {
            failed.push(`locating a replacement: ${describeError(error)}`);
          }
        }
        // The structural pass's members arrive with their positions already
        // read, so they need no lookup — and must not have one, since equal
        // primitives are indistinguishable by value.
        for (const { parentArray, index } of elementRemovals) {
          located.push({ parentArray, index });
        }
        // One filter over both sources rather than a check at each: the rule is
        // about containment and does not care which pass asked. Dropping the
        // contained removal is what keeps the sweep off a tombstone, and the
        // alternative is the enforcement halt, whose own contract says no
        // client-authored value may reach it — it stops the project persisting
        // until a reset.
        for (const removal of located) {
          if (insideRemovedMap(removal.parentArray)) continue;
          planned.push(removal);
          const seenIndices = removedBefore.get(removal.parentArray) ?? [];
          seenIndices.push(removal.index);
          removedBefore.set(removal.parentArray, seenIndices);
        }
        // Descending, so an earlier removal cannot shift a later one's index.
        for (const { parentArray, index } of planned.sort((a, b) => b.index - a.index)) {
          try {
            parentArray.delete(index, 1);
            // A removal is a refusal, and the accumulator sees an array's
            // structural change under the null key, so that is what is marked.
            noteRefusedChange(tr, parentArray, null, deps.ydoc);
          } catch (error) {
            failed.push(`sweep of a replacement: ${describeError(error)}`);
          }
        }
        // Rightmost entity first, on the pre-transaction order, for the same
        // reason the sweep above runs descending: an insert shifts everything
        // to its right, so filling the later slots first leaves the earlier
        // ones where `liveIndex` said they were. Restoring left to right
        // instead would need each entity's slot corrected by the siblings
        // already put back ahead of it, and a sibling whose rebuild failed
        // would silently drop out of that correction.
        //
        // Ordering has to come from `originalIndex`: siblings removed together
        // share a `liveIndex`, so it cannot tell which of them came first.
        const sorted = [...prepared].sort((a, b) => b.originalIndex - a.originalIndex);
        for (const { parentArray, originalIndex, liveIndex, clone } of sorted) {
          try {
            const shift = (removedBefore.get(parentArray) ?? [])
              .filter((i) => i < liveIndex).length;
            const target = liveIndex - shift;
            const clamped = Math.max(0, Math.min(target, parentArray.length));
            parentArray.insert(clamped, [clone]);
            restored++;
            // Deleting somebody else's entity is a structural change to the
            // array that held it, and the restore is through that array alone.
            // Unmarked, the refused deletion would still earn the array's path,
            // its timestamp and its editing time.
            noteRefusedChange(tr, parentArray, null, deps.ydoc);
          } catch (error) {
            failed.push(`restore at index ${originalIndex}: ${describeError(error)}`);
          }
        }
        for (const { yMap, key, previous } of fieldMutations) {
          try {
            // A shared type cannot be written back: it is still integrated
            // where it was, and yjs reintegrates rather than copies, so the
            // write throws. A client can park one under a guarded key —
            // `course_project_id` holds an integer or nothing, so a Y type
            // there is neither the old marker nor the new one and the marker
            // comparison never fires on it — and then trip the write on the
            // next transaction. The key held no value the DO recognises, so
            // clearing it restores the state the guard exists to defend.
            if (previous === undefined || isSharedValue(previous)) {
              yMap.delete(key);
              if (previous !== undefined) {
                degraded.push(
                  `${key}: ${describeSharedType(previous)} could not be written back and the key was cleared`,
                );
              }
            } else {
              yMap.set(key, previous);
            }
            // Whichever arm ran, the key holds what it held before this
            // transaction, so there is nothing here to credit anyone with.
            noteRefusedChange(tr, yMap, key, deps.ydoc);
          } catch (error) {
            failed.push(`field write to ${key}: ${describeError(error)}`);
          }
        }
        for (const { yMap, key, clone } of structuralRestores) {
          try {
            if (clone === null) yMap.delete(key);
            else yMap.set(key, clone);
            noteRefusedChange(tr, yMap, key, deps.ydoc);
          } catch (error) {
            failed.push(`structural write to ${key}: ${describeError(error)}`);
          }
        }
      }, REVERT_ORIGIN);
    } catch (error) {
      failed.push(`revert transaction: ${describeError(error)}`);
    } finally {
      deps.setReverting(false);
    }

    // Broadcast post-revert state via writeSyncStep2. Encoding done here so
    // the handler is a single self-contained unit. It runs on the failure path
    // too: whatever the document now holds is what peers must converge on, and
    // a peer left on a stale view of a failed revert is a second divergence on
    // top of the first.
    try {
      deps.broadcastUpdate(encodeSyncStep2(deps.ydoc));
      // Only once the broadcast ATTEMPT has completed — `broadcastUpdate`
      // sends to every connected socket and swallows an individual failure,
      // so this says nothing about which peers actually received it, only
      // that none was skipped. The relay of the inbound packet is redundant
      // transmission beside that attempt, not a second application of the
      // refused state: applying the correction and then the original update
      // leaves a peer unchanged, so the relay costs transmission and
      // processing and buys nothing for a peer the broadcast reached. A
      // broadcast call that throws below is the case the relay would still
      // matter for, which is why `noteRevert` is only reached past it.
      // Synchronous, because the message handler reads it in the same
      // continuation.
      noteRevert();
    } catch (error) {
      failed.push(`post-revert broadcast: ${describeError(error)}`);
    }

    // Record violation + log + maybe close socket. This runs whatever happened
    // above: a revert that could not be applied is an enforcement failure, not
    // an accepted deletion, and letting it skip the counter would make failure
    // the cheapest way to delete a colleague's work.
    let closing = false;
    if (origin && typeof origin === "object") {
      closing = deps.recordViolation(origin as WebSocket);
    }
    const markerChanges = fieldMutations.filter((m) => m.key === COURSE_MARKER_KEY).length;
    const configChanges = configMutations.length;
    const domainChanges = domainMutations.length;
    const identityChanges =
      fieldMutations.length - markerChanges - configChanges - domainChanges;
    // A socket that produced a state enforcement could not repair does not get
    // to try again on the same connection. The transaction was already
    // unauthorised, so this costs no honest editor anything, and the client
    // reconnects onto the document the DO holds — the safest state available.
    const closeForFailure = failed.length > 0;
    warn(
      `[canDelete] reverted ${restored} unauthorised delete(s), ` +
      `${markerChanges} course-marker change(s) and ${identityChanges} identity-key change(s), ` +
      `and removed ${bornClaims.length} forged insert(s), ` +
      `and reverted ${configChanges} convenor-only config write(s), ` +
      `and reverted ${domainChanges} out-of-domain identity value(s) ` +
      `and removed ${domainViolations.removals.length} born map(s) carrying one, ` +
      `by user ${actor.userId}` +
      (closing ? " — closing socket (>=3 violations in 60s)" : ""),
    );
    if (degraded.length > 0) {
      warn(
        `[canDelete][revert-degraded] user ${actor.userId}: ${degraded.length} value(s) could ` +
        `not be rebuilt and are missing from the restored entities — ${degraded.join("; ")}`,
      );
    }
    if (closeForFailure) {
      warn(
        `[canDelete][revert-failed] user ${actor.userId}: the revert did not apply in full, so a ` +
        `deletion enforcement refused stands in the document — ${failed.join("; ")}`,
      );
      deps.onEnforcementFailure?.({ userId: actor.userId, failures: failed });
    }
    if ((closing || closeForFailure) && origin && typeof origin === "object") {
      try {
        closeOffender(
          origin as WebSocket,
          1008,
          closeForFailure
            ? "Delete enforcement could not be applied"
            : "Repeated unauthorised delete attempts",
        );
      } catch { /* already closed */ }
    }
  };

  return afterHandler;
}

// ---------------------------------------------------------------------------
// recordViolation — sliding-window per-socket counter
// ---------------------------------------------------------------------------

/**
 * Stateful violation counter helper. Returns a `record(ws)` function that
 * tracks recent timestamps per socket in a WeakMap (so closed sockets are
 * GC'd), and returns true when a socket crosses the threshold within the
 * window.
 */
export function makeViolationCounter(
  threshold: number = VIOLATION_THRESHOLD,
  windowMs: number = VIOLATION_WINDOW_MS,
  now: () => number = () => Date.now(),
): (ws: WebSocket) => boolean {
  const timestamps: WeakMap<WebSocket, number[]> = new WeakMap();
  return (ws: WebSocket) => {
    const t = now();
    const cutoff = t - windowMs;
    const list = timestamps.get(ws) ?? [];
    const recent = list.filter((x) => x >= cutoff);
    recent.push(t);
    timestamps.set(ws, recent);
    return recent.length >= threshold;
  };
}

// ---------------------------------------------------------------------------
// encodeSyncStep2 — y-protocols sync envelope for the post-revert broadcast.
// ---------------------------------------------------------------------------
//
// Inlined here (rather than imported from y-protocols) so the module has zero
// runtime dependency on lib0/y-protocols at the type level — the import is
// dynamic-friendly and the encoded shape matches workers/collaboration.ts's
// existing snapshot-broadcast pattern.

import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";

const messageSync = 0;

function encodeSyncStep2(ydoc: Y.Doc): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, messageSync);
  syncProtocol.writeSyncStep2(enc, ydoc);
  return encoding.toUint8Array(enc);
}
