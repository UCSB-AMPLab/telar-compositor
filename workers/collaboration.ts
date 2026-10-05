/**
 * This file is the Durable Object class behind real-time Yjs
 * collaboration — one DO instance per project, with periodic D1
 * snapshots so a server restart doesn't lose anyone's work.
 *
 * Each project's edit session lives inside a single
 * `ProjectCollaborationDO` instance. The DO hosts the Yjs document
 * in memory, relays sync messages between connected editors, and
 * snapshots both ways: a binary blob into `projects.yjs_state` for
 * fast warm restart, and row-level data into the entity tables
 * (stories, steps, layers, objects, config, glossary, pages) so
 * the publish pipeline can keep reading from D1 unchanged.
 *
 * Authentication runs at the WebSocket handshake: the browser
 * sends its session cookie value as `?token=`, the DO resolves it
 * to a user id, and project membership is checked in D1 before the
 * socket is accepted. A bespoke session-control protocol on top
 * of the y-websocket message channel lets the server push a
 * "project deleted" or "you've been removed" disconnect to every
 * client when a convenor takes a destructive action.
 *
 * Cold start: when no `yjs_state` blob exists for the project,
 * the DO builds the Y.Doc from D1 rows on first connection and
 * writes it as the initial blob before it opens.
 *
 * Durability: the document's durable state is that blob plus a
 * generation-scoped update log in the object's own storage. Every
 * accepted inbound message is written as one group — the raw
 * payload and every non-socket transaction it provoked — before
 * anything it caused reaches a peer, and every transaction the
 * object itself opens is a record of its own. A wake loads the
 * blob and replays the log above it, so an eviction between an
 * edit and the next snapshot asks nothing of any client. A log
 * that grows past its thresholds is folded by the alarm into a
 * storage base at the document's sequence and retired below it,
 * so the tail a load replays stays bounded whatever D1 is doing.
 *
 * @version v1.5.0-beta
 */

import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { DurableObject } from "cloudflare:workers";
import { firstAwarenessClientId, ownAwarenessEntries, parseAwarenessClientId } from "./awareness-ownership";
import { replyCloseCode } from "./socket-close";
import {
  EMPTY_LEASE_STATE,
  applyLeaseControl,
  leaseControlText,
  leaseFrame,
  parseLeaseControl,
  type LeaseState,
} from "./freeze-lease";
import type { EditsByPath } from "./collaboration-helpers";
import { mergeEditingTime, peekTimeCredits, proseFieldNames, seedTimeLedger, settleTimeCredits, settleWords } from "./contribution-metrics";
import { countWords } from "~/lib/contributions";
import { PARKED_KEY_GLOB, PARKED_KEY_PREFIX, PLACEHOLDER_KEY_GLOB, PLACEHOLDER_KEY_PREFIX } from "~/lib/parking-key";
import { promoteModelledExtras, MODELLED_OBJECT_EXTRA_ALIASES } from "~/lib/extra-columns.server";
import { OBJECT_FIELD_YDOC_KIND } from "~/lib/column-mapping";
import type { PromotedExtras } from "~/lib/extra-columns.server";
import type { MemberEditingTime, TimeCredit, TimeLedger, WordBaseline, WordCredit, WordsByRow } from "./contribution-metrics";
import { makeAfterTransactionHandler, buildContributionUpdate, buildActivityRows, ACTIVITY_RETENTION_CAP, yTextToString, renderedNumber, renderedValue, resolveActivityEntity, proseContributorsFromPaths, proseInsertBind, proseUpdateBind, rowEditsFromPaths } from "./collaboration-helpers";
import {
  parseSessionCookie,
  getUserIdFromToken as getUserIdFromTokenShared,
  verifyInternalMarker,
  isProjectId,
  parseCanonicalProjectId,
} from "./auth";
import {
  IDENTITY_DOMAIN_KEYS_BY_NESTED_KEY,
  IDENTITY_DOMAIN_KEYS_BY_ROOT,
  describeError,
  getUserContext,
  isIdentityValueInDomain,
  makeCanDeleteHandler,
  makeViolationCounter,
  renderedKey,
  typeProtectedRoots,
} from "./can-delete";
import {
  checkTelarVersion,
  partitionConfigArm,
  partitionIngestArm,
  statedFlag,
  statedText,
} from "./ingest-domains";
import type { IngestArmPartition, IngestDiagnostic } from "./ingest-domains";
import { applyObjectOrder, sheetPlacement, type IngestObjectOrder } from "./object-order";
import { fieldsUnchangedSinceReview } from "./object-seen-fields";
import { claimCandidates, enrichmentCandidates, fillFromManifests, readManifests, releaseCandidates, type ReadManifest } from "./object-enrichment";
import { carryMissingOrigin, ingestHeldBack, objectArmsHeldBack, pageInsertsHeldBack } from "./ingest-held-back";
import { objectInsertValues, objectInsertYValue } from "./object-insert-values";
import { applyCustomBlob, changesCustomBlob, customFieldBases, customFieldsBlob, settleCustomFields } from "~/lib/object-custom-map";
import type { SheetEntry } from "~/lib/field-order";
import { applyFrontmatterCaptures, type IngestPageCapture } from "./page-capture";
import { applyWrittenFrontmatterStores, type IngestPageStoreWritten } from "./page-store-written";
import {
  applyPageReplacements,
  emptyPageContentOutcome,
  planPageReplacements,
  settlePageContent,
  type IngestPageReplaceContent,
  type PageContentCandidate,
  type PageReplacement,
} from "./page-replace-content";
import {
  applyPageSlugChanges,
  emptyPageSlugOutcome,
  planPageSlugChanges,
  settlePageSlugs,
  type IngestPageRemove,
  type IngestPageRename,
  type PageSlugCandidate,
  type PageSlugPlans,
} from "./page-remove-rename";
import { placeInsertedPageMenuEntry, savedMenuItems, type IngestPageMenuEntry } from "./page-menu-entries";
import { createDisplacementLog } from "./displaced-edits";
import type { DisplacementLog } from "./displaced-edits";
import {
  ExactBaseError,
  FenceRefusedError,
  LogCorruptionError,
  MAX_RECORD_BYTES,
  MAX_SEQ,
  PersistenceHaltedError,
  baseKey,
  deleteKeys,
  encodeBase,
  encodeHalt,
  encodeRecord,
  haltKey,
  highestSeq,
  logKey,
  logPrefix,
  parseCanonicalGeneration,
  parseKey,
  readBase,
  readBaseHeader,
  readHalt,
  replayLog,
  writeGroup,
} from "./doc-log";
import type {
  ExactBaseReason,
  FencePhase,
  HaltMarker,
  HaltReason,
  LogStorage,
  StoredBase,
} from "./doc-log";
import { CONTRIBUTOR_ENTITY_KINDS, preservedActor } from "~/lib/authorship";
import type { ContributorEntityKind } from "~/lib/authorship";
import { makeUniqueTermId } from "~/lib/glossary-slug";
import {
  applyObjectRename,
  emptyObjectRenameOutcome,
  partitionObjectRenameArm,
  renameTravelsAlone,
  settledRenames,
  unreceiptedRenames,
  type IngestObjectRename,
  type ObjectRenameOutcome,
} from "./object-rename";
import { isHeldTermId } from "~/lib/csv-records";
import { resetPageFrontmatter } from "~/lib/page-frontmatter-reset";
import { dropStrandedMarkers, markerAllowed, markerCourse } from "./course-marker-invariant";
import { removeObjectColumn, removeStoryColumns, storyColumnDetail, tableColumnDetail, withoutColumns } from "~/lib/story-columns";
import { CONVENOR_ONLY_CONFIG_FIELDS } from "~/lib/config-fields";
import { HIDDEN_PRESENCE_LIMIT_MS, sweepOutdatedPresence } from "~/lib/presence-expiry";
import {
  ORDER_KEY,
  backfillOrderKeys,
  nextOrderKeyAfterLast,
  orderedEntries,
  orderedMaps,
} from "~/lib/field-order";
import { generateDistinctKeyBetween } from "~/lib/order-key";
import type { Read } from "~/lib/value-domains";
import { canonicalRaw, contentFromRows, contentInOrder } from "~/lib/story-canonical";
import type {
  CanonicalLayer, CanonicalStep, ContentLayerFields, ContentLayerRow, ContentStepFields, ContentStepRow,
} from "~/lib/story-canonical";
import { alignByContent } from "./content-alignment";
import { placeCapturedSteps } from "./captured-steps";
import {
  coordinateBind,
  entityMaps,
  flagBind,
  isSharedValue,
  orderKeyBind,
  proseString,
  readConfigString,
  readConfigYText,
  readFlag,
  readHumanKey,
  readProse,
  readRowId,
  readYArray,
  readYMap,
  rowIdBind,
  typeNameOf,
} from "~/lib/value-domains";

// y-websocket message type constants (must match client)
const messageSync = 0;
const messageAwareness = 1;

// Bespoke session-control protocol for server-initiated
// disconnects (project deleted by convenor; collaborator left from another
// tab). Wire format = varuint(2) + uint8(subtype). Server→client only —
// the existing webSocketMessage handler still silently ignores unknown
// msgTypes, so no client→server path exists.
//
// Note: y-protocols today only uses 0/1 at the
// top level, so 2 is safe; re-evaluate if the project ever bumps to a
// y-protocols major that adds new top-level types.
const messageSessionControl = 2;
const subProjectDeleted = 0x01;
const subRemovedFromProject = 0x02;
// Sent to a socket whose document predates the last `/reset`. The client's only
// correct response is to discard that document and build a fresh one; nothing
// it still holds may reach the rebuilt server document.
const subStateReset = 0x03;
// Sent on every accepted upgrade, carrying the generation the client is now
// synced at. Wire format for these two = varuint(2) + uint8(subtype) +
// varuint(generation).
const subDocGeneration = 0x04;
// The freeze leases standing on this project, and the operations that ended
// recently, as `varString(json)` after the subtype byte — see
// `./freeze-lease`. Sent on every admission and to every socket whenever a
// lease changes; the only source a client reads a freeze from.
const subFreeze = 0x05;

/** Durable Object storage key for the freeze leases (`LeaseState`). */
const FREEZE_LEASE_KEY = "freezeLeases";

/**
 * The connection parameter carrying the client's awareness client id. The id
 * is declared rather than read off the socket's first awareness update,
 * because y-websocket re-broadcasts every awareness change it observes, other
 * clients' included, so a first update is not reliably the sender's own. Kept
 * in step with `use-collaboration.tsx`.
 */
const AWARENESS_CLIENT_PARAM = "aw";

/**
 * Durable Object storage key for the document generation — the count of resets
 * this project's document has been through. It lives in DO storage rather than
 * D1 because the guard that reads it has to answer at socket-upgrade time,
 * before the document is loaded, and because it must survive hibernation: a
 * generation that reset to 0 on eviction would readmit exactly the documents
 * `/reset` exists to shut out.
 */
const DOC_GENERATION_KEY = "docGeneration";

/**
 * What a client presents as `?gen=` for a document it has just built and has
 * not yet synced — a first connection, a new tab, or the replacement document
 * built in answer to a reset. It belongs to no generation and holds nothing
 * that could predate one.
 *
 * The claim exists because absence cannot carry it. A socket that presents no
 * generation at all is either a client from before this fence or one declining
 * to answer, and neither can show that what it holds postdates the last reset;
 * admitting them was the hole this closes. Kept in step with
 * `use-collaboration.tsx`, which writes it onto the connection.
 */
const FRESH_DOCUMENT_GENERATION = "new";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The membership roles a socket can attach with. */
export type MemberRole = "convenor" | "collaborator" | "instructor";

const MEMBER_ROLES: ReadonlySet<string> = new Set<MemberRole>([
  "convenor",
  "collaborator",
  "instructor",
]);

/**
 * Parse a `project_members.role` value from D1. Returns null for anything the
 * gates do not know: an unrecognised role must refuse the socket, because
 * can-delete reads an unknown role as a DO-internal origin and would exempt the
 * connection from delete enforcement entirely.
 */
export function parseMemberRole(raw: string | null | undefined): MemberRole | null {
  return typeof raw === "string" && MEMBER_ROLES.has(raw) ? (raw as MemberRole) : null;
}

interface SocketAttachment {
  userId: number;
  projectId: number;
  role: MemberRole;
  /**
   * The document generation this socket was admitted under. A hibernated
   * socket survives an eviction, so the close `/reset` issues is not a fence:
   * this field is, and it is what every path that touches the document
   * compares before letting the socket write. It is a number because there is
   * no honest generation to stamp when storage cannot answer — such an upgrade
   * is refused instead of admitted with an unknown one.
   */
  generation: number;
  /** The one awareness client id this socket may set; see `claimAwarenessClientId`. */
  awarenessClientId?: number;
  /**
   * Set when the id this socket declared belongs to another user's live
   * socket, or when a newer socket of the same user took its id over. Nothing
   * this socket sends to awareness is applied after that, and it is never
   * bound to another id.
   */
  awarenessRefused?: true;
  /**
   * The entry the awareness holds for this socket's own client id, encoded
   * after the socket's last update was applied. The in-memory awareness is
   * empty after a wake and this is what rebuilds it; see `restoreAwareness`.
   * Never set on a refused socket, and absent when the entry was removed or
   * too large to keep.
   */
  awarenessUpdate?: Uint8Array;
  /** When the kept entry was last updated, from the awareness's own metadata. */
  awarenessUpdatedAt?: number;
  /**
   * When this socket's membership was last read and found, set at admission
   * and by `socketStillMember`: the start of that read, not its end. A socket
   * admitted before the field existed has none and is checked at once.
   */
  membershipCheckedAt?: number;
  /**
   * Set when the socket was told it was removed from the project, or that the
   * project was deleted, just before it is closed. A message whose membership
   * check was already in flight is dropped on reading it; see `removeSocket`.
   */
  removed?: true;
}

/**
 * The largest awareness update a socket's attachment keeps. The platform caps
 * an attachment at 16,384 bytes serialised, and the rest of the attachment is
 * a few numbers, so half the cap leaves room for all of it. A larger update is
 * not kept, and that client's entry reappears after a wake when it renews.
 */
const MAX_STORED_AWARENESS_BYTES = 8192;

/**
 * An `Awareness` for `doc` that holds no timer.
 *
 * The y-protocols constructor starts a repeating interval, cleared only by
 * `destroy()`, and a Durable Object with a pending timer cannot hibernate. The
 * interval renews the object's own entry, which no client reads, and removes
 * stale remote entries, which only the snapshot a new socket is sent can
 * observe; `sweepOutdatedPresence` does that at the point it is observed.
 * `_checkInterval` is the library's private field; y-protocols is pinned, and
 * the workers eviction tests time out if the timer survives.
 */
function createAwareness(doc: Y.Doc): awarenessProtocol.Awareness {
  const awareness = new awarenessProtocol.Awareness(doc);
  clearInterval((awareness as unknown as { _checkInterval: ReturnType<typeof setInterval> })._checkInterval);
  return awareness;
}

/**
 * The entry `awareness` holds for `clientId`, encoded, and when it was last
 * updated; null when it holds none or holds a removal. Encoded from the
 * awareness rather than taken from the update a socket sent, because the
 * awareness ignores an update whose clock is behind the one it holds.
 */
function heldAwarenessEntry(
  awareness: awarenessProtocol.Awareness,
  clientId: number,
): { update: Uint8Array; updatedAt: number } | null {
  const meta = awareness.meta.get(clientId);
  if (meta === undefined || awareness.states.get(clientId) == null) return null;
  return {
    update: awarenessProtocol.encodeAwarenessUpdate(awareness, [clientId]),
    updatedAt: meta.lastUpdated,
  };
}

/**
 * The entry `attachment` keeps, when there is one to restore at `now`: the
 * socket's id was not refused or taken over, the bytes and their time are
 * both present, and the time is inside the longest presence limit. The
 * bytes are not decoded here, so an entry whose own limit is shorter is
 * removed by the sweep `restoreAwareness` runs once every entry is applied.
 */
function keptAwarenessEntry(
  attachment: SocketAttachment,
  now: number,
): { clientId: number; update: Uint8Array; updatedAt: number } | null {
  const { awarenessClientId: clientId, awarenessUpdate: update, awarenessUpdatedAt: updatedAt } = attachment;
  if (attachment.awarenessRefused || clientId === undefined) return null;
  if (!(update instanceof Uint8Array) || typeof updatedAt !== "number") return null;
  if (HIDDEN_PRESENCE_LIMIT_MS <= now - updatedAt) return null;
  return { clientId, update, updatedAt };
}

/** The close a socket gets when the document it was admitted to is gone. */
const STALE_GENERATION_CLOSE = { code: 1012, reason: "State reset" } as const;

/** The close a socket gets when the generation itself cannot be read. */
const UNKNOWN_GENERATION_CLOSE = { code: 1013, reason: "Try again later" } as const;

/**
 * Whether `attachment` was admitted under `generation`.
 *
 * A missing attachment and a missing `generation` are both stale: the field is
 * written at admission, so a socket without one was admitted by a build that
 * could not fence it and cannot be told apart from a pre-reset socket.
 */
function attachedToGeneration(
  attachment: SocketAttachment | null,
  generation: number,
): boolean {
  return typeof attachment?.generation === "number" && attachment.generation === generation;
}

/**
 * The close a socket gets when the document it is attached to cannot be
 * served: the base could not be proved exact, or the row this instance wrote
 * to is not the row it claimed. The client reconnects on its own schedule and
 * meets the same refusal until a `/reset` lands, so no reset frame goes with
 * it — the client keeps what it holds.
 */
const DOCUMENT_UNAVAILABLE_CLOSE = { code: 1013, reason: "Try again later" } as const;

/**
 * The close a socket gets for an update larger than the codec's record
 * ceiling. 1009 is the protocol's own code for a message too large, and it is
 * the honest answer: the update was never applied, so the client still holds
 * it and nothing it sent reached any peer.
 */
const OVERSIZED_UPDATE_CLOSE = { code: 1009, reason: "Message too big" } as const;

/**
 * Whether a transaction's origin is one of this object's sockets.
 *
 * A socket-origin update is never written to the log: the raw payload the
 * message handler logs stands for it. Yjs emits `update` for the integrated
 * portion of a transaction alone, so a payload held pending for its missing
 * dependencies would never reach a listener, while the raw bytes replay into
 * the same pending state the relay gave the peers.
 *
 * The test is the attachment accessor a hibernatable socket carries, which is
 * what `Y.applyUpdate` is handed as its origin on the message path.
 */
function isSocketOrigin(origin: unknown): boolean {
  if (origin === null || typeof origin !== "object") return false;
  const socket = origin as { deserializeAttachment?: unknown };
  return typeof socket.deserializeAttachment === "function";
}

/**
 * The highest revision `projects.yjs_write` can hold. A load claims only when
 * one complete snapshot still fits above it — the claim, the blob and the
 * guard, three moves — so no instance is opened that cannot complete one.
 * Nine quadrillion at two moves per snapshot is beyond any lifetime this
 * product has; there is no in-band recovery, and a value that reached the
 * ceiling would need a wider identity by migration, never a reset to zero,
 * because a reused revision re-enables a stale write.
 */
const MAX_WRITE_REVISION = Number.MAX_SAFE_INTEGER;

/** Moves a snapshot makes: the claim's, the blob's, and the guard's. */
const SNAPSHOT_REVISION_MOVES = 3;

/**
 * Reads a load makes before it refuses. The bound gives bounded refusal under
 * contention, not guaranteed admission: a client that meets it reconnects.
 */
const LOAD_READ_LIMIT = 3;

/**
 * Durable Object storage key for the maintenance floor — the lowest generation
 * maintenance has not yet proved clean.
 *
 * One integer is the whole work list. What a sweep must delete is derivable
 * from storage and the current generation, so nothing is appended at a switch
 * and nothing can be lost between the switch and a put; an absent or malformed
 * value reads as 0, and a re-sweep of a clean generation deletes nothing.
 */
const MAINTENANCE_FLOOR_KEY = "maintenanceFloor";

/** Keys one maintenance slice may delete, counting every key whatever its kind. */
const MAINTENANCE_DELETE_BUDGET = 1024;

/** Listings one maintenance slice may issue, so a sweep of empty generations is bounded too. */
const MAINTENANCE_LIST_BUDGET = 8;

/** Keys one maintenance listing asks for: the backend's own `delete` batch limit. */
const MAINTENANCE_LIST_PAGE = 128;

/** How far ahead maintenance arms its alarm when it has work left. */
const MAINTENANCE_DELAY_MS = 5_000;

/** The periodic snapshot's interval, and the retry interval after a rejected slice. */
const SNAPSHOT_ALARM_MS = 30_000;

/**
 * Durable Object storage key for the project this object belongs to.
 *
 * The in-memory id and this binding are two facts, not one. Memory is bound
 * from a socket attachment or a signed marker, none of which a socketless alarm
 * has; the key is what lets such an alarm know whose row to read. A binding
 * whose put failed is unmade, and the work that depends on it waits.
 */
const PROJECT_ID_KEY = "projectId";

/** Records above the exact base at which the log is folded into a storage base. */
const COMPACTION_RECORD_THRESHOLD = 2_000;

/** Payload bytes above the exact base at which the log is folded. */
const COMPACTION_BYTE_THRESHOLD = 8 * 1024 * 1024;

/**
 * Entries of the accounting list at which its size is stated, once per load.
 *
 * The list grows only while both the snapshot and the compaction are failing,
 * which is a condition to be seen rather than a quota to be enforced: the byte
 * count has to describe the whole tail above the base, so an entry may be
 * dropped only by a base that moved past it.
 */
const ACCOUNTING_LINE_AT = 100_000;

/** Encoded blob size above which a snapshot states the size, once per load. */
const SNAPSHOT_SIZE_WARNING = 1_048_576;

// ---------------------------------------------------------------------------
// The diagnostic read
// ---------------------------------------------------------------------------

/**
 * The two staging-only control flags, and the ring of alarm records.
 *
 * Outside the codec's prefixes, so maintenance never sweeps them and
 * `replaceDocument` never clears them: a reset keeps whatever posture an
 * exercise set.
 */
const DIAG_RECORD_KEY = "diag:record";
const DIAG_HOLD_KEY = "diag:hold";
const DIAG_ALARMS_KEY = "diag:alarms";

/** Alarm records kept, newest last, in memory and at `diag:alarms`. */
const DIAG_RING = 8;

/**
 * Values per page in the read's own classifying listings, and the reverse
 * scan's page budget either side of staging.
 *
 * The widths are the read's whole storage budget: a production read issues nine
 * calls and touches at most 72 values, so a page of 32 and one reverse page are
 * what keep that figure true.
 */
const DIAG_PAGE = 32;
const DIAG_REVERSE_PAGES = 1;
const DIAG_REVERSE_PAGES_STAGING = 8;

/** The counting listings' page width and page budget, staging only. */
const DIAG_COUNT_PAGE = 128;
const DIAG_COUNT_PAGES = 32;

/** How long the finalisation waits on the scheduling attempts it counted. */
const DIAG_SETTLE_MS = 1_000;

/** The storage operations the probe is offered, when one is installed. */
const PROBED_OPERATIONS: ReadonlySet<string> = new Set([
  "get", "put", "delete", "list", "getAlarm", "setAlarm", "deleteAlarm",
]);

/**
 * A population of physical keys, classified.
 *
 * One schema for every count in the diagnostic, because the retirement and the
 * maintenance sweep spend their budgets on physical keys — records, parts and
 * malformed keys alike — while the codec's own reads find record headers only.
 * A namespace holding no records or no parts reports them as zero rather than
 * omitting them. `capped` says the page budget ran out with the range still
 * open, which makes every figure a lower bound.
 */
export interface Count {
  keys: number;
  records: number;
  parts: number;
  malformed: number;
  capped: boolean;
}

/** The state one alarm phase found before it changed anything. */
export interface PhaseEntry {
  generation: number | null;
  floor: number | null;
  eligible: unknown;
  debt: { records: number; bytes: number } | null;
}

/** What an uncertain D1 write was settled as. */
export type WriteOutcome =
  | "not_attempted"
  | "landed"
  | "adopted"
  | "not_landed"
  | "refused"
  | "unresolved";

/** Why a reacquisition could not settle a write, which is never a refusal. */
export type UnresolvedCause = "unavailable" | "generation_malformed";

export interface BlobRecord {
  outcome: WriteOutcome;
  seq: number | null;
  cause?: UnresolvedCause;
}

export type BatchNotAttempted =
  | "no_statements"
  | "blob_not_landed"
  | "header_failed"
  | "snapshot_skipped";

export interface BatchRecord {
  outcome: WriteOutcome;
  reason: BatchNotAttempted | null;
  cause?: UnresolvedCause;
}

/** What one retirement spent, whichever branch spent it. */
export interface RetirementRecord {
  lists: number;
  deleteCalls: number;
  deleted: number;
  firstDeleted: string | null;
  lastDeleted: string | null;
  outcome: unknown;
}

/**
 * What the alarm's scheduling half did, and what it left armed.
 *
 * The last three belong to the settlement, which only a recording invocation
 * takes: with recording off the record carries the finaliser and the count of
 * calls alone, so production pays neither the wait nor the `getAlarm` and the
 * record does not report an observation nobody made.
 */
export interface SchedulingRecord {
  finaliser: "interval" | "maintenance" | "none" | "skipped";
  scheduleSnapshotCalls: number;
  unsettledScheduling?: number;
  pendingAlarmAt?: number | null;
  pendingAlarmUnread?: boolean;
}

/** Why the snapshot half did not run. */
export type SnapshotSkip = "no_sockets" | "unloaded" | "halted" | "in_progress";

export interface SnapshotRecord {
  ran: boolean;
  skipped: SnapshotSkip | null;
  entry: PhaseEntry | null;
  encodedSeq: number | null;
  blob: BlobRecord;
  header: "retired" | "failed" | "not_attempted";
  retirement: LogRetirement | null;
  batch: BatchRecord;
}

/** What one alarm invocation that reached its finalisation did. */
export interface AlarmRecord {
  recordId: string;
  startedAt: number;
  endedAt: number;
  generation: number | null;
  firstAlarmInInstance: boolean;
  retryCount: number | null;
  isRetry: boolean | null;
  sockets: number;
  recording: boolean;
  kind: "ran" | "halted" | "held" | "failed";
  failure: string | null;
  preflight: {
    halted: boolean;
    held: boolean;
    identity: IdentityState;
    cleanup: CleanupDerivation;
    debt: boolean;
  } | null;
  maintenance: {
    entry: PhaseEntry;
    floor: number;
    pending: boolean;
    rejected: boolean;
    lists: number;
    deleted: number;
  } | null;
  retirement: {
    branch: "none" | "cleanup" | "compaction";
    entry: PhaseEntry | null;
    lists: number;
    deleteCalls: number;
    deleted: number;
    firstDeleted: string | null;
    lastDeleted: string | null;
    outcome: unknown;
  } | null;
  snapshot: SnapshotRecord | null;
  scheduling: SchedulingRecord;
  diagnosticLists: number;
}

/**
 * The record under construction, written into by each phase as it passes.
 *
 * Separate from `AlarmRecord` because a draft carries what the finalisation
 * still has to fold in — the entries the phases captured, the branch the turn
 * took — while the record carries the finished answer.
 */
interface AlarmDraft {
  recordId: string;
  startedAt: number;
  retryCount: number | null;
  isRetry: boolean | null;
  sockets: number;
  firstAlarmInInstance: boolean;
  recording: boolean;
  generation: number | null;
  kind: AlarmRecord["kind"];
  failure: string | null;
  preflight: AlarmRecord["preflight"];
  maintenanceEntry: PhaseEntry | null;
  retirementBranch: "none" | "cleanup" | "compaction";
  retirementEntry: PhaseEntry | null;
  snapshot: SnapshotRecord | null;
  scheduling: SchedulingRecord;
}

/** What one invocation ran, shared by reference across the gate's callback. */
interface AlarmRun {
  generation: number;
  slice: MaintenanceSlice;
  turn: CompactionTurn;
  failure: unknown;
}

/** The staging-only posture the controls hold. */
interface Controls {
  recording: boolean;
  held: boolean;
}

/** The metadata the platform hands an alarm, absent under the test helper. */
interface AlarmInfo {
  retryCount?: number;
  isRetry?: boolean;
}

/** The read's options, once the environment has admitted them. */
interface DiagnosticOptions {
  validate: boolean;
  count: number | null;
  reversePages: number;
}

/**
 * A test seam standing between the object and its storage, given every probed
 * operation with the phase the object had set, and the thunk that performs it.
 *
 * Returning `invoke()` passes the operation through; delaying or rejecting
 * around it is what lets a test hold a real `setAlarm` open past a bound.
 */
export type StorageProbe = (
  operation: string,
  phase: string,
  args: readonly unknown[],
  invoke: () => unknown,
) => unknown;

/** An empty population, for a namespace nothing was listed under. */
function emptyCount(): Count {
  return { keys: 0, records: 0, parts: 0, malformed: 0, capped: false };
}

/**
 * The listings left to spend, shared by every range one request counts.
 *
 * Held in an object rather than returned, so that a traversal which stops early
 * hands the rest of the budget to the next one and a request's whole cost is
 * the figure the budget started at.
 */
interface CountBudget {
  pages: number;
}

function countBudget(): CountBudget {
  return { pages: DIAG_COUNT_PAGES };
}

/** Add one physical key to a population, classified by the codec. */
function countKeyInto(count: Count, key: string): void {
  count.keys += 1;
  const parsed = parseKey(key);
  if (parsed === null) {
    count.malformed += 1;
    return;
  }
  if (parsed.part !== undefined) {
    count.parts += 1;
    return;
  }
  count.records += 1;
}

/**
 * The first log record header in a page of keys, or null when it holds none.
 *
 * A page listed forward gives the lowest and one listed in reverse the highest,
 * from the same walk: orphan parts and foreign keys sort beside a header and
 * are stepped over.
 */
function firstHeaderSeqIn(keys: readonly string[]): number | null {
  for (const key of keys) {
    const parsed = parseKey(key);
    if (parsed === null || parsed.kind !== "log" || parsed.part !== undefined) continue;
    if (parsed.seq !== undefined) return parsed.seq;
  }
  return null;
}

/**
 * The stored project id as the answer can carry it.
 *
 * A key that stands empty is `null`; anything else is reported as read, so an
 * operator sees the value that disagrees rather than a normalised absence. A
 * value the storage layer holds and JSON cannot carry is reported as its text,
 * because a refusal to serialise would cost the whole answer. Such a value is
 * recognised from what serialising it does: `JSON.stringify` throws on some
 * (a bigint) and flattens others to `null` without throwing (a non-finite
 * number, boxed or not; an invalid date), so both outcomes are read, and only
 * a stored `null` may answer with `null` of its own.
 */
function observedProjectId(stored: unknown): unknown {
  if (stored === undefined) return null;
  let json: string | undefined;
  try {
    json = JSON.stringify(stored);
  } catch {
    return String(stored);
  }
  if (json === "null" && stored !== null) return String(stored);
  return stored;
}

/** A socket's attachment, or null when it does not deserialise. */
function readAttachment(ws: WebSocket): SocketAttachment | null {
  try {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (attachment === null || typeof attachment !== "object") return null;
    return attachment;
  } catch {
    return null;
  }
}

/**
 * What one failure inside the gated collection answers.
 *
 * Never a partial answer: a read the collection needs and could not take is a
 * refusal, so an operator is never handed a picture with a hole in it they
 * cannot see.
 */
function diagnosticRefusal(err: unknown): Response {
  const malformed = err instanceof ExactBaseError && err.reason === "generation_malformed";
  return new Response(malformed ? "generation_malformed" : "storage_unavailable", {
    status: 503,
  });
}

/** One control, as the query names it and the signature binds it. */
interface ControlRequest {
  intent: "record" | "hold";
  on: boolean;
  key: string;
  text: string;
}

/**
 * The one control a query names, or null for none, both, or a value outside
 * the pair. The text is what the signature covers.
 */
function readControlRequest(url: URL): ControlRequest | null {
  const record = url.searchParams.get("record");
  const hold = url.searchParams.get("hold");
  if ((record === null) === (hold === null)) return null;
  const intent = record === null ? "hold" : "record";
  const raw = record === null ? hold : record;
  if (raw !== "0" && raw !== "1") return null;
  return {
    intent,
    on: raw === "1",
    key: intent === "hold" ? DIAG_HOLD_KEY : DIAG_RECORD_KEY,
    text: `${intent}=${raw}`,
  };
}

/** One retirement's counts and its branch's own outcome, in one record. */
function retirementRecordOf(
  retirement: LogRetirement | null,
  outcome: unknown,
): RetirementRecord {
  if (retirement === null) {
    return { lists: 0, deleteCalls: 0, deleted: 0, firstDeleted: null, lastDeleted: null, outcome };
  }
  const { lists, deleteCalls, deleted, firstDeleted, lastDeleted } = retirement;
  return { lists, deleteCalls, deleted, firstDeleted, lastDeleted, outcome };
}

/**
 * What a re-acquisition that threw established.
 *
 * A `FenceRefusedError` is the one conclusion: the row was proved another
 * lineage's, and the instance has halted on it. Everything else establishes
 * nothing at all — D1 or storage refused the read, or the stored generation
 * does not parse — and is `unresolved` with the reason, because an outcome that
 * could not be observed must never be reported as a fence lost.
 */
function describeReacquisition(err: unknown): BlobRecord {
  if (err instanceof FenceRefusedError) return { outcome: "refused", seq: null };
  const malformed = err instanceof ExactBaseError && err.reason === "generation_malformed";
  return {
    outcome: "unresolved",
    seq: null,
    cause: malformed ? "generation_malformed" : "unavailable",
  };
}

/**
 * The build this object is running, or null when the binding is absent.
 *
 * Pure, and tolerant of a configuration without `version_metadata`: a
 * deployment that has not declared the binding still has to answer the read.
 */
export function describeBuild(
  env: Partial<Env>,
): { id: string; tag: string; timestamp: string } | null {
  const metadata = env.CF_VERSION_METADATA;
  if (!metadata || typeof metadata !== "object") return null;
  const { id, tag, timestamp } = metadata;
  if (typeof id !== "string" || typeof tag !== "string" || typeof timestamp !== "string") {
    return null;
  }
  return { id, tag, timestamp };
}

/** A generation or a revision: a safe non-negative integer, never coerced. */
function isSafeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** A base sequence: a safe integer the log's key width can carry. */
function isBaseSeq(value: unknown): value is number {
  return isSafeCount(value) && value <= MAX_SEQ;
}

/**
 * The stored blob as a `Uint8Array` over exactly its bytes, whatever the
 * binding hands back. A value of no shape this understands reads as absent,
 * which under tags is the anomaly a reset recovers.
 */
function normaliseBlob(value: unknown): Uint8Array | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return new Uint8Array(value);
  return null;
}

/**
 * Whether this refusal has already been logged by the one place that owns it —
 * the loader for a base it cannot prove exact, the fence for a row it cannot
 * reconcile. Every other catch keeps its own logging for everything else.
 */
function isNamedPersistenceRefusal(err: unknown): boolean {
  return (
    err instanceof ExactBaseError ||
    err instanceof FenceRefusedError ||
    err instanceof PersistenceHaltedError
  );
}

/** The body every route gives for a halt, and the only one that names it. */
const HALTED_BODY = "persistence_halted";

/**
 * What one inbound message has asked the object to send and to close, held
 * until the write that records what the document now holds has been issued.
 *
 * The guard broadcasts the corrected state and closes the offending socket from
 * inside `afterTransaction`, which runs before any listener: a message already
 * sent cannot be held by the output gate, and a marker written afterwards would
 * be recording a state peers had already been given.
 */
interface StagedEffects {
  sends: Array<{ ws: WebSocket; msg: Uint8Array }>;
  closes: Array<{ ws: WebSocket; code: number; reason: string }>;
}

/** Whether a conditioned statement matched the one row it was aimed at. */
function landedOneRow(result: { meta?: { changes?: number } } | null | undefined): boolean {
  return result?.meta?.changes === 1;
}

/**
 * What a reset did, on the terms the phase table settles.
 *
 * `stale`, `halted` and `halt-unreadable` answer the caller's own preconditions
 * before anything past the generation is read, and the first two carry no error:
 * they are what the object was asked about, not a failure of it. `read` is a
 * refusal that leaves D1, the document and the sockets exactly as they were.
 * `stage` and a `failed` short of the switch spend nothing durable, and dispose
 * the document the build replaced. `generation` covers both the read that could
 * not name a generation and the put that could not advance one, which is
 * uncertain rather than unchanged. A `failed` past the switch leaves the staged
 * base as the new generation's exact base, which the next load serves. `ok` is a
 * landed replacement, whatever its finalisation did.
 */
type ResetOutcome =
  | { kind: "ok" }
  | { kind: "generation"; err: unknown }
  | { kind: "read"; err: unknown }
  | { kind: "stage"; err: unknown; detail: string }
  | { kind: "stale"; generation: number }
  | { kind: "halted" }
  | { kind: "halt-unreadable"; err: unknown }
  | { kind: "failed"; err: unknown };

/**
 * How far a reset has got, as the one thing every catch consults.
 *
 * `replacing` is set immediately before `replaceDocument` is called, because
 * that helper destroys the served document before it constructs the next, so a
 * throw inside it already needs disposal. `landed` is set the moment the
 * replacement is acknowledged or adopted, before installation begins, because
 * from there the D1 row holds the new base whatever happens next and no exit
 * may describe it as anything else.
 */
type ResetPhase = "before-replace" | "replacing" | "replaced" | "switched" | "landed";

/**
 * Which finalisation operation a landed replacement is in.
 *
 * Only read past a landed write, where it names the operation the line reports.
 * Installation is the first of them, which is why it is also the initial value:
 * a failure before any step is entered is a failure of the installation.
 */
type ResetStep = "installation" | "attribution" | "retirement" | "scheduling" | "announcement";

/** The phase, shared by reference so the route's outer catch reads what the steps set. */
interface ResetProgress {
  at: ResetPhase;
  step: ResetStep;
}

/**
 * What one maintenance slice may still spend, decremented in place as it goes.
 *
 * Both bounds are per run and both are needed: the deletion budget bounds a
 * generation full of records, and the listing budget bounds a sweep that finds
 * nothing to delete at all.
 */
interface MaintenanceBudget {
  deletes: number;
  lists: number;
}

/**
 * What a maintenance slice leaves behind.
 *
 * `floor` is the lowest generation not yet known clean, as it stands after the
 * slice; `pending` says the slice could not prove it finished what it started,
 * which is work remaining whatever the floor says; `rejected` says storage
 * refused it, which is a reason to wait rather than to come straight back.
 */
interface MaintenanceSlice {
  floor: number;
  pending: boolean;
  rejected: boolean;
  /**
   * The listings this slice issued and the keys its deletions acknowledged,
   * mutated in place where the calls happen so a slice that was refused still
   * carries what it reached.
   */
  lists: number;
  deleted: number;
}

/**
 * How far one bounded log retirement got.
 *
 * `complete` is the only outcome that proves the eligible range drained, and it
 * is earned by a short or empty page, never by a budget that happened to be
 * enough; `exhausted` says a budget ran out before completion was proved, so
 * work may remain; `rejected` says the first listing or deletion failure
 * stopped the invocation. Both non-complete outcomes require continuation, and
 * whose continuation it is belongs to the caller.
 */
type LogRetirementOutcome = "complete" | "exhausted" | "rejected";

/**
 * What one bounded log retirement leaves behind: its outcome, and the sum of
 * the deletion counts storage acknowledged.
 */
interface LogRetirement {
  outcome: LogRetirementOutcome;
  deleted: number;
  /**
   * What the sweep spent and where it reached, mutated in place inside
   * `sweepLogBelow` so a rejection carries the work it had already done.
   * `deleteCalls` counts deletions ATTEMPTED, which a failed one is; `deleted`
   * stays the keys whose deletion resolved.
   */
  lists: number;
  deleteCalls: number;
  firstDeleted: string | null;
  lastDeleted: string | null;
}

/**
 * The thresholds a compaction is owed at, and the size a document may be folded
 * up to.
 *
 * Per instance so one test seam can lower all three together, and never a
 * mutation of the codec's own ceiling: `MAX_RECORD_BYTES` is what the codec will
 * encode, and this is what the policy will ask it to.
 */
interface CompactionPolicy {
  records: number;
  bytes: number;
  ceiling: number;
  /**
   * Bytes per part of the base this policy writes. Undefined is the codec's
   * own limit, which is what production uses; a test lowers it so that a base
   * spans more than one batch and the rollback of a LATER batch is reachable.
   */
  partLimit?: number;
}

/**
 * What the derivation of cleanup from storage and the row concluded.
 *
 * `floor` is a sequence proved safe to retire below with an eligible key
 * standing at or under it, or `null` when nothing is owed; `rejected` says a
 * read the derivation needs is refused, in which case it concludes nothing and
 * the scheduler waits the full interval.
 */
interface CleanupDerivation {
  floor: number | null;
  rejected: boolean;
}

/**
 * Whether an alarm can name its project, and why not when it cannot.
 *
 * The two failures are different work. `named` false with `rejected` false is
 * an instance with nothing to bind and nothing stored: it runs the maintenance
 * storage alone answers for and waits for a binding path to give it an id.
 * `rejected` is a put that failed over an id the instance holds: the binding is
 * unmade, everything that depends on it waits, and the scheduler treats the
 * turn as refused so the retry comes at the full interval.
 */
interface IdentityState {
  named: boolean;
  rejected: boolean;
}

/**
 * What one alarm may act on, decided by the preflight inside the gate.
 *
 * Both derivations are taken before the maintenance slice, which touches
 * neither the current generation's log nor a base a header stands over, so what
 * the plan says still holds when the turn acts on it.
 */
interface AlarmPlan {
  generation: number;
  cleanup: CleanupDerivation;
  debt: boolean;
  /**
   * Whether a halt stands, resident or durable. A halted alarm acts on nothing
   * and schedules nothing, and the plan says so rather than answering with an
   * absence the record could not describe.
   */
  halted: boolean;
  /**
   * Whether the staging hold stands. The preflight splits on it after the halt
   * checks and before the identity, so a held alarm derives nothing, lists
   * nothing and leaves prepared debt exactly where the fixture put it.
   */
  held: boolean;
  identity: IdentityState;
}

/**
 * The plan an alarm that may not act runs: a generation to name it by, nothing
 * derived, nothing listed, nothing owed.
 *
 * The flags are reported as observed rather than as causes: the halt is checked
 * first, so a held flag beside a halt says what the object's posture was, not
 * what stopped the invocation.
 */
function stoppedPlan(generation: number, halted: boolean, held: boolean): AlarmPlan {
  return {
    generation,
    cleanup: { floor: null, rejected: false },
    debt: false,
    halted,
    held,
    identity: { named: false, rejected: false },
  };
}

/**
 * What the alarm's cleanup-or-compaction turn leaves behind: whether work
 * remains for the next alarm to find, and whether storage or D1 refused it.
 */
interface CompactionTurn {
  owed: boolean;
  rejected: boolean;
  /**
   * What the turn spent, carried through `runOneRetirement` rather than
   * rebuilt: only the branch that ran knows its own counts and outcome.
   */
  record?: RetirementRecord;
}

/**
 * Whether an unmoved row is a predecessor of the write that expected it, rather
 * than another lineage's.
 *
 * Two shapes qualify. A **tagged** row carries both tags in domain with the
 * generation at or below the expected one, which is the predecessor a snapshot
 * retried against its own last base meets. An **untagged** row carries both
 * tags NULL, whatever its blob, which is what a bare claim over a storage-base
 * recovery leaves behind. A mixed pair, a tag outside its domain and a
 * generation above the expected one are refused, with no coercing comparison.
 */
function isPredecessorRow(
  row: Record<string, unknown>,
  storageGeneration: number,
  expected: number,
): boolean {
  if (storageGeneration !== expected) return false;
  const generation = row.yjs_generation ?? null;
  const seq = row.yjs_seq ?? null;
  if (generation === null && seq === null) return true;
  return isSafeCount(generation) && isBaseSeq(seq) && generation <= expected;
}

/**
 * The preconditions a reset request states, as the object re-derives them from
 * its own query string.
 *
 * `binding` is the canonical string the marker signs, so a request whose
 * parameters differ from the ones the caller signed for recomputes to a
 * different message and is refused. Absent parameters bind nothing, which is
 * the signature an unguarded reset carries.
 */
interface ResetGuards {
  expectedGeneration: number | null;
  requireNotHalted: boolean;
  binding: string | undefined;
}

/**
 * Read `/reset`'s two optional preconditions, or `null` for a query no reset
 * can be run from.
 *
 * The four cases are exhaustive, and none of them falls back to an unguarded
 * reset: with neither parameter the route takes no precondition and binds
 * nothing;
 * with a generation alone it binds `"<G>"`; with both it binds `"<G>|nh"`; a
 * flag on its own, an empty value, a malformed generation or a flag that is not
 * exactly `1` is out of domain.
 */
function readResetGuards(url: URL): ResetGuards | null {
  const rawGeneration = url.searchParams.get("expectedGeneration");
  const rawFlag = url.searchParams.get("requireNotHalted");
  if (rawGeneration === null) {
    return rawFlag === null
      ? { expectedGeneration: null, requireNotHalted: false, binding: undefined }
      : null;
  }
  const expectedGeneration = parseCanonicalGeneration(rawGeneration);
  if (expectedGeneration === null) return null;
  if (rawFlag === null) {
    return { expectedGeneration, requireNotHalted: false, binding: `${expectedGeneration}` };
  }
  if (rawFlag !== "1") return null;
  return { expectedGeneration, requireNotHalted: true, binding: `${expectedGeneration}|nh` };
}

/** The base row a load reads, with its revision validated and its tags raw. */
interface BaseRow {
  blob: Uint8Array | null;
  generation: unknown;
  seq: unknown;
  revision: number;
}

/**
 * Whether `ws` is still open and was not removed, read after an await: a
 * removal or a close does not cancel a handler already waiting on it.
 */
function socketStillOpen(ws: WebSocket): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  const attachment = readAttachment(ws);
  return attachment !== null && !attachment.removed;
}

/** How long a socket's membership read stands before its next message rereads it. */
const MEMBERSHIP_RECHECK_MS = 60_000;

/**
 * How long a socket keeps sending while its membership cannot be read. Past
 * this since the last read that succeeded, it is closed to reconnect, and
 * admission reads the same row.
 */
const MEMBERSHIP_GRACE_MS = 10 * 60_000;

/** The close a socket gets when its membership could not be read for too long. */
const MEMBERSHIP_UNVERIFIED_CLOSE = { code: 1013, reason: "Try again later" } as const;

/**
 * Tell `ws` it was removed from the project, or that the project was deleted,
 * and close it. The attachment is marked first, so a message already waiting
 * on a membership read that then finds the row is still dropped.
 */
function removeSocket(ws: WebSocket, subtype: number, reason: string): void {
  const attachment = readAttachment(ws);
  if (attachment !== null) {
    try { ws.serializeAttachment({ ...attachment, removed: true }); } catch { /* socket may have disconnected */ }
  }
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, messageSessionControl);
  encoding.writeUint8(enc, subtype);
  try { ws.send(encoding.toUint8Array(enc)); } catch { /* socket may have disconnected */ }
  closeSocket(ws, { code: 1000, reason });
}

/** Close `ws`, tolerating a peer that is already gone. */
function closeSocket(ws: WebSocket, close: { code: number; reason: string }): void {
  try {
    ws.close(close.code, close.reason);
  } catch {
    // Already closed.
  }
}

/**
 * Describe a thrown value for a log line, tolerating a value whose own
 * conversion to a string throws (an object with no prototype has no
 * `toString`).
 */
function describeThrown(value: unknown): string {
  try {
    return value instanceof Error ? value.message : String(value);
  } catch {
    return "an unprintable value";
  }
}

// Row shapes returned by raw D1 queries
interface StoryRow {
  id: number;
  story_id: string;
  title: string | null;
  subtitle: string | null;
  byline: string | null;
  order: number;
  order_key: string | null;
  private: number;
  draft: number;
  show_sections: number;
  created_by: number | null;
}

interface StepRow {
  id: number;
  story_id: number;
  step_number: number;
  kind: string;
  object_id: string | null;
  x: number | null;
  y: number | null;
  zoom: number | null;
  page: string | null;
  question: string | null;
  answer: string | null;
  alt_text: string | null;
  clip_start: string | null;
  clip_end: string | null;
  loop: string | null;
  /** JSON object of the story CSV cells in columns the Compositor does not map; NULL when none. */
  extra_columns: string | null;
  order_key: string | null;
  created_by: number | null;
}

/**
 * The `source_path` a story row holds once it is renamed away from its D1
 * `story_id`, as SQL over that row: a path in the spreadsheets folder is kept;
 * any other, or none, becomes the old ID's file unless another story of the
 * project records that file, which is then that story's (a story made at an ID
 * another left, and renamed before a publish, never owned the file there).
 */
const PREVIOUS_STORY_FILE_SQL =
  "CASE WHEN substr(source_path, 1, 27) = 'telar-content/spreadsheets/' THEN source_path " +
  "WHEN NOT EXISTS (SELECT 1 FROM stories AS o WHERE o.project_id = stories.project_id " +
  "AND o.source_path = 'telar-content/spreadsheets/' || stories.story_id || '.csv') " +
  "THEN 'telar-content/spreadsheets/' || story_id || '.csv' ELSE source_path END";

/**
 * The bind for a step's `extra_columns`: the map's JSON string, or NULL where
 * it holds none. The map carries `""` for none, as an object's does, and D1
 * holds NULL for the same state, which is what the import writes.
 */
function stepExtraColumnsBind(stepMap: Y.Map<unknown>): string | null {
  const value = renderedValue(stepMap.get("extra_columns"));
  return value === "" ? null : value;
}

/** The map value for a step's `extra_columns` read from D1 or a payload: `""` for none. */
function stepExtraColumnsValue(raw: string | null | undefined): string {
  return raw ?? "";
}

/** A step Y.Map as an ingest builds one, `_id` null, with no layers or key yet. */
function stepMapWithoutLayers(step: IngestStep): Y.Map<unknown> {
  const stepMap = new Y.Map<unknown>();
  stepMap.set("_id", null);
  stepMap.set("step_number", step.step_number ?? 0);
  writeStepScalars(stepMap, step);
  stepMap.set("question", new Y.Text(step.question ?? ""));
  stepMap.set("answer", new Y.Text(step.answer ?? ""));
  stepMap.set("alt_text", new Y.Text(step.alt_text ?? ""));
  return stepMap;
}

/** A layer Y.Map as an ingest builds one, `_id` null, with no key yet. */
function layerMapWithoutKey(layer: IngestLayer): Y.Map<unknown> {
  const layerMap = new Y.Map<unknown>();
  layerMap.set("_id", null);
  layerMap.set("layer_number", layer.layer_number);
  layerMap.set("title", new Y.Text(layer.title ?? ""));
  layerMap.set("button_label", new Y.Text(layer.button_label ?? ""));
  layerMap.set("content", new Y.Text(layer.content ?? ""));
  return layerMap;
}

/** The step's plain fields, as the ingest writes them. */
function writeStepScalars(stepMap: Y.Map<unknown>, step: IngestStep): void {
  stepMap.set("kind", step.kind ?? "media");
  stepMap.set("object_id", step.object_id ?? "");
  stepMap.set("x", step.x ?? null);
  stepMap.set("y", step.y ?? null);
  stepMap.set("zoom", step.zoom ?? null);
  stepMap.set("page", step.page ?? "");
  stepMap.set("clip_start", step.clip_start ?? "");
  stepMap.set("clip_end", step.clip_end ?? "");
  stepMap.set("loop", step.loop ?? "");
  stepMap.set("extra_columns", stepExtraColumnsValue(step.extra_columns));
}

const STEP_TEXT_FIELDS = ["question", "answer", "alt_text"] as const;
const LAYER_TEXT_FIELDS = ["title", "button_label", "content"] as const;

/** An existing step's fields set from the payload, its prose replaced in place. */
function writeStepFields(
  stepMap: Y.Map<unknown>,
  step: IngestStep,
  replaceText: (map: Y.Map<unknown>, key: string, value: string) => void,
): void {
  writeStepScalars(stepMap, step);
  for (const field of STEP_TEXT_FIELDS) replaceText(stepMap, field, step[field] ?? "");
}

/** A new step with its layers, keyed in sequence (`rekeyLayers` runs again once it is placed). */
function newStepMap(step: IngestStep, layers: readonly IngestLayer[]): Y.Map<unknown> {
  const stepMap = stepMapWithoutLayers(step);
  const layersArray = new Y.Array<Y.Map<unknown>>();
  const maps = layers.map((layer) => layerMapWithoutKey(layer));
  rekeyLayers(maps);
  layersArray.push(maps);
  stepMap.set("layers", layersArray);
  return stepMap;
}

function newLayerMap(layer: IngestLayer): Y.Map<unknown> {
  return layerMapWithoutKey(layer);
}

/** Layers given `order_key`s minted in their sequence and their rank for a number. */
function rekeyLayers(layers: readonly Y.Map<unknown>[]): void {
  let previous: string | null = null;
  layers.forEach((layer, rank) => {
    previous = generateDistinctKeyBetween(previous, null);
    layer.set(ORDER_KEY, previous);
    layer.set("layer_number", rank + 1);
  });
}

/** Remove these maps from the array, wherever they sit in it. */
function removeMaps(array: Y.Array<Y.Map<unknown>>, maps: readonly Y.Map<unknown>[]): void {
  const doomed = new Set(maps);
  const members = array.toArray();
  for (let i = members.length - 1; i >= 0; i--) {
    if (doomed.has(members[i])) array.delete(i, 1);
  }
}

/** The payload's layers grouped by the step they belong to, in the order given. */
function layersByStep(entry: IngestReplaceContent): IngestLayer[][] {
  const out: IngestLayer[][] = entry.steps.map(() => []);
  for (const layer of entry.layers) out[layer.step_index]?.push(layer);
  for (const list of out) list.sort((a, b) => a.layer_number - b.layer_number);
  return out;
}

/** A payload step's fields as the canonical form reads them. */
function incomingStepFields(step: IngestStep): ContentStepFields {
  return {
    kind: step.kind ?? "media",
    object_id: step.object_id,
    x: step.x ?? null,
    y: step.y ?? null,
    zoom: step.zoom ?? null,
    page: step.page,
    question: step.question,
    answer: step.answer,
    alt_text: step.alt_text,
    clip_start: step.clip_start,
    clip_end: step.clip_end,
    loop: step.loop,
    extra_columns: step.extra_columns,
  };
}

/** A map's plain text field: a string, or "" when absent; undefined when it holds anything else. */
function plainText(value: unknown): string | undefined {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : undefined;
}

/**
 * A glossary entry's kind as a bind: the string the map holds, `""` included
 * (no kind, which everything downstream reads as NULL does), or null where
 * the map holds none or anything but a string (the UPDATE then leaves D1's
 * value).
 */
function kindBind(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * The kind a new row binds: the map's string, `""` included (an author's blank
 * stands), else the surviving D1 row's, else NULL.
 */
function kindForInsert(value: unknown, preserved: string | null): string | null {
  return kindBind(value) ?? preserved;
}

/** A coordinate: a number or null; undefined when it holds anything else. */
function coordinate(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "number" ? value : undefined;
}

/** A prose field: its text, "" when absent; undefined when unreadable. */
function proseText(value: unknown): string | undefined {
  if (value === undefined) return "";
  const read = readProse(value);
  return read.ok ? read.value : undefined;
}

/** A layer map's fields, or null when one cannot be read. */
function liveLayerFields(layer: Y.Map<unknown>): ContentLayerFields | null {
  const fields = {
    title: proseText(layer.get("title")),
    button_label: proseText(layer.get("button_label")),
    content: proseText(layer.get("content")),
  };
  return Object.values(fields).includes(undefined) ? null : (fields as ContentLayerFields);
}

/** A step map's fields, or null when one cannot be read. */
function liveStepFields(step: Y.Map<unknown>): ContentStepFields | null {
  const fields = {
    kind: plainText(step.get("kind")) || "media",
    object_id: plainText(step.get("object_id")),
    x: coordinate(step.get("x")),
    y: coordinate(step.get("y")),
    zoom: coordinate(step.get("zoom")),
    page: plainText(step.get("page")),
    question: proseText(step.get("question")),
    answer: proseText(step.get("answer")),
    alt_text: proseText(step.get("alt_text")),
    clip_start: plainText(step.get("clip_start")),
    clip_end: plainText(step.get("clip_end")),
    loop: plainText(step.get("loop")),
    extra_columns: plainText(step.get("extra_columns")),
  };
  return Object.values(fields).includes(undefined) ? null : (fields as ContentStepFields);
}

/**
 * A live story's steps and layers as canonicaliser input, in `order_key`
 * order (`orderedEntries`); `contentInOrder` gives each its rank. Null when
 * the story's steps, a step's layers, or any field cannot be read.
 */
function liveStoryContent(story: Y.Map<unknown>): {
  stepsArray: Y.Array<Y.Map<unknown>>;
  maps: Y.Map<unknown>[];
  content: Array<ContentStepFields & { layers: ContentLayerFields[] }>;
} | null {
  const stepsArray = story.get("steps");
  if (!(stepsArray instanceof Y.Array)) return null;
  const steps = orderedEntries(stepsArray);
  if (steps.skipped.length > 0) return null;
  const content: Array<ContentStepFields & { layers: ContentLayerFields[] }> = [];
  for (const step of steps.maps) {
    const fields = liveStepFields(step);
    const layersValue = step.get("layers");
    const layers = layersValue === undefined ? { maps: [], skipped: [] } : orderedEntries(layersValue);
    if (!fields || layers.skipped.length > 0 || (layersValue !== undefined && !(layersValue instanceof Y.Array))) return null;
    const layerFields = layers.maps.map(liveLayerFields);
    if (layerFields.includes(null)) return null;
    content.push({ ...fields, layers: layerFields as ContentLayerFields[] });
  }
  return { stepsArray: stepsArray as Y.Array<Y.Map<unknown>>, maps: steps.maps, content };
}

/**
 * Seeds `extra_columns` on every step map that lacks the key, from D1's value
 * by the step's row id. A key already present, `""` included, is left: `""`
 * is a removal the snapshot may not have written yet. Runs inside the caller's
 * transaction.
 */
function seedStepExtraColumns(
  storiesArray: Y.Array<Y.Map<unknown>>,
  d1ExtrasById: ReadonlyMap<number, string>,
): void {
  for (const story of entityMaps(storiesArray).maps) {
    for (const step of entityMaps(story.get("steps")).maps) {
      if (step.get("extra_columns") !== undefined) continue;
      const idRead = readRowId(step.get("_id"));
      step.set("extra_columns", stepExtraColumnsValue(idRead.ok ? d1ExtrasById.get(idRead.value) : undefined));
    }
  }
}

interface LayerRow {
  id: number;
  step_id: number;
  layer_number: number;
  title: string | null;
  button_label: string | null;
  content: string | null;
  order_key: string | null;
  created_by: number | null;
}

interface ObjectRow {
  id: number;
  object_id: string;
  title: string | null;
  creator: string | null;
  description: string | null;
  alt_text: string | null;
  source_url: string | null;
  period: string | null;
  year: string | null;
  object_type: string | null;
  subjects: string | null;
  source: string | null;
  credit: string | null;
  thumbnail: string | null;
  dimensions: string | null;
  extra_columns: string | null;
  featured: number;
  image_available: number;
  order_key: string | null;
  created_by: number | null;
  course_project_id: number | null;
}

interface GlossaryRow {
  id: number;
  term_id: string;
  title: string | null;
  definition: string | null;
  kind: string | null;
  order_key: string | null;
  created_by: number | null;
}

interface PageRow {
  id: number;
  title: string | null;
  slug: string;
  body: string | null;
  /** The page file's front-matter block as the file has it; NULL when never captured. */
  frontmatter: string | null;
  order: number;
  order_key: string | null;
  created_by: number | null;
}

/**
 * The bind for a page's `frontmatter`: the map's string, `""` included, since
 * `""` is a file with no front matter and NULL is one never read. Anything
 * else binds NULL, which the UPDATE reads as "leave D1's value".
 */
function pageFrontmatterBind(pageMap: Y.Map<unknown>): string | null {
  const value = pageMap.get("frontmatter");
  return typeof value === "string" ? value : null;
}

/**
 * What one `SELECT id, <human key> FROM <table> WHERE project_id = ?` yields,
 * indexed for its two consumers: orphan detection walks `ids`, while the
 * dedupe keeper and the stale-`_id` adopt branch ask `keyToId` which row owns
 * a given human key. `everyKey` is the same with the empty key too, which
 * `keyToId` leaves out as no key at all: objects(project_id, object_id) covers
 * it, so a row holding `""` blocks another from taking it, and the snapshot's
 * writes under a UNIQUE index ask `everyKey`. Read once per table per
 * snapshot.
 */
interface EntityKeyIndex {
  ids: ReadonlySet<number>;
  keyToId: ReadonlyMap<string, number>;
  everyKey: ReadonlyMap<string, number>;
}

/**
 * What one entity INSERT did in D1.
 *
 * `failure` separates the two ways a wrapper comes back without a usable id,
 * because their remedies are opposites. `"insert"` means D1 holds no row, so
 * the entity must be issued again; `"backfill"` means the row IS committed at
 * `id` and only the document's knowledge of it was lost, so issuing it again
 * writes a SECOND row wherever no UNIQUE human key refuses one — a glossary
 * term under a held id, which migration 0072 leaves out of its index, and
 * steps and layers, which carry no human key at all — and is refused as a
 * collision everywhere else. A caller that cannot tell the two apart cannot
 * pick a safe remedy.
 */
interface InsertOutcome {
  id: number;
  backfilled: boolean;
  failure?: "insert" | "backfill";
  /**
   * The human key the row still has to take, when it was inserted under a
   * parking key because another row held this one (`ParkTest`).
   */
  pendingKey?: string;
}

/**
 * A new row whose human key another row holds, under a UNIQUE index the
 * INSERT would trip, and which this snapshot frees: `holds` names such a key,
 * and the row is inserted under `placeholder()` and takes its own key in the
 * snapshot batch, after the orphan deletions and the renames that free it. A
 * standalone INSERT runs before that batch, and one refused there would keep
 * the holder from the orphan sweep, so a key freed by a deletion would never
 * be taken.
 */
interface ParkTest {
  holds: (key: string) => boolean;
  placeholder: () => string;
}

/**
 * A flat table's UNIQUE (project_id, key) index as the snapshot writes under
 * it. `indexed` answers whether the index covers a key; `parkSql` is the SQL a
 * renamed row is parked at, and `placeholder` the key a new row is inserted
 * under while another row holds its own. Neither can equal a key another row
 * holds: the glossary's are held ids, which its index leaves out, and the
 * objects', whose index covers every id, carry 64 random bits or a UUID.
 */
interface UniqueKey {
  indexed: (key: string) => boolean;
  parkSql: string;
  placeholder: () => string;
  // Set where an UPDATE stating the empty key leaves the row's own: such a
  // row is not renamed, and keeps its key through the batch.
  blankKeepsKey?: boolean;
  // Set where a new entity whose key is held by a row no document entry
  // claims takes that row over rather than replacing it.
  adoptsUnclaimedHolder?: boolean;
}

/**
 * The key an UPDATE stating `key` writes to row `id`, as `snapshotFlatEntity`
 * records it: none where the row keeps its own (`UniqueKey.blankKeepsKey`).
 */
function keyWritten(unique: UniqueKey | undefined, id: number, key: string): Array<{ id: number; key: string }> {
  return key === "" && unique?.blankKeepsKey ? [] : [{ id, key }];
}

/** A flat pipeline's INSERT wrapper, as `snapshotFlatEntity` calls it. */
type FlatInsert = (
  m: Y.Map<unknown>,
  index: number,
  explicitId?: number,
  preserved?: Record<string, unknown>,
  park?: ParkTest,
) => Promise<InsertOutcome>;

const GLOSSARY_UNIQUE_KEY: UniqueKey = {
  indexed: inGlossaryIndex,
  parkSql: "'#~park-' || id",
  placeholder: () => `#~new-${crypto.randomUUID()}`,
};

const OBJECTS_UNIQUE_KEY: UniqueKey = {
  indexed: () => true,
  parkSql: `'${PARKED_KEY_PREFIX}' || lower(hex(randomblob(8)))`,
  placeholder: () => `${PLACEHOLDER_KEY_PREFIX}${crypto.randomUUID()}`,
};

/**
 * A page's slug names its file, so a new page at a slug an unclaimed row
 * holds is that row again: either the page's own row, which an instance
 * evicted between its INSERT and its blob write has lost the `_id` of, or a
 * deleted page's, whose file the new page is written to.
 */
/**
 * The slug a page the document leaves unkeyed is written: the one it has,
 * unless that is a parking or placeholder key (`PAGES_UNIQUE_KEY`), which a
 * row keeps only while a snapshot is in flight. Such a row takes the empty
 * slug the document states, where no other page holds it; where one does, it
 * stays parked, and publish reads it as having no slug (`isParkingKey`). One
 * bind, the empty slug, as `uniqueKeySet` keeps one per column.
 */
const UNPARKED_BLANK_SLUG_SQL =
  `CASE WHEN slug GLOB '${PLACEHOLDER_KEY_GLOB}' OR slug GLOB '${PARKED_KEY_GLOB}' THEN ` +
  "(SELECT CASE WHEN COUNT(held.id) > 0 THEN project_pages.slug ELSE wanted.k END " +
  "FROM (SELECT ? AS k) AS wanted LEFT JOIN project_pages AS held ON held.project_id = project_pages.project_id " +
  "AND held.slug = wanted.k AND held.id <> project_pages.id) ELSE slug END";

/**
 * Set on a map that took over a row, with its `_id`, and cleared once a batch
 * carrying `pushAdopted` has landed. The `_id` reaches the stored blob before
 * that batch runs, so a refused batch leaves a map the ordinary UPDATE would
 * write without the adopting columns; this tells the retry to write them.
 */
const ADOPTED_MARK = "_adopted";

const PAGES_UNIQUE_KEY: UniqueKey = {
  ...OBJECTS_UNIQUE_KEY,
  blankKeepsKey: true,
  adoptsUnclaimedHolder: true,
};

/**
 * Whether glossary_terms' UNIQUE index covers `termId`: every id but a held
 * one (`isHeldTermId`). Migration 0072's predicate trims the same whitespace
 * set CPython's `str.strip()` does, so the two agree on every id.
 */
function inGlossaryIndex(termId: string): boolean {
  return !isHeldTermId(termId);
}

/**
 * The key an INSERT binds for `key`, and the `pendingKey` its outcome
 * carries: `key` itself, or, where `park` finds another row holding it, a
 * placeholder and `key` as the one still to take.
 */
function parkedBind(key: string, park: ParkTest | undefined): { bind: string; pending: { pendingKey?: string } } {
  if (!park?.holds(key)) return { bind: key, pending: {} };
  return { bind: park.placeholder(), pending: { pendingKey: key } };
}

/**
 * The renamed rows whose new key stays held through the batch: by a row that
 * is neither deleted nor moving, or by another such row. They are not parked,
 * so their UPDATE leaves them at the key they have (`uniqueKeySet`) and no
 * parking key is left in D1; the next snapshot writes the rename once the
 * holder has moved.
 */
function blockedRenames(
  renamed: ReadonlyArray<{ id: number; key: string }>,
  keyToId: ReadonlyMap<string, number>,
  orphans: ReadonlySet<number>,
  indexed: (key: string) => boolean,
): Set<number> {
  const renamedIds = new Set(renamed.map((w) => w.id));
  const blocked = new Set<number>();
  const staysHeld = (w: { id: number; key: string }): boolean => {
    const holder = keyToId.get(w.key);
    if (holder === undefined || holder === w.id || orphans.has(holder)) return false;
    return !renamedIds.has(holder) || blocked.has(holder);
  };
  let grew = true;
  while (grew) {
    const next = renamed.filter((w) => !blocked.has(w.id) && indexed(w.key) && staysHeld(w));
    for (const w of next) blocked.add(w.id);
    grew = next.length > 0;
  }
  return blocked;
}

/** `key`, or the unkeyed `""` where `mayRepeat` lets several entities share it. */
function sharedAsUnkeyed(key: string, mayRepeat: ((key: string) => boolean) | undefined): string {
  return mayRepeat?.(key) ? "" : key;
}

/**
 * One entity a snapshot could not put in D1, in the shape the routes report.
 * `key` is the entity's human key where it has one (story_id, object_id,
 * term_id, slug) and a parent-and-rank description where it does not (steps,
 * layers) — it identifies the row for the operator reading the log, and for
 * `recordInsertReceipts`, which matches receipts against it by table and key.
 */
interface SnapshotInsertFailure {
  table: string;
  key: string;
  kind: "insert" | "backfill";
}

/**
 * DO storage key prefix for the `/ingest-sync` operation receipts: one key per
 * operation id, holding the object_ids it has settled. Storage rather than the
 * document, because a receipt has to answer for an operation whose objects the
 * document no longer holds; one key per operation, because an operation's
 * object list has no bound a single value could hold.
 */
const INGEST_RECEIPT_PREFIX = "ingestReceipt:";
/**
 * How many receipts are held before the ones whose operations are finished are
 * looked for. A threshold for a D1 read, not a cap: nothing is dropped for
 * being old or for being one too many.
 */
const INGEST_RECEIPT_PRUNE_AT = 200;

/**
 * What one operation has settled: the objects it inserted, those it removed,
 * and the new keys of those it renamed (`objects.rename`).
 */
interface IngestReceipt {
  inserted: string[];
  removed: string[];
  renamed: string[];
}

/** What one `objects.rename` delivery did, for its answer. */
interface ObjectRenameDelivery {
  state: "attempted" | "alreadyApplied" | "fenceBlocked";
  outcome: ObjectRenameOutcome;
  receipted: string[];
  flushed: boolean;
  failure: unknown;
}

/** The objects a delivery named that its operation had already settled. */
interface ReceiptedEntries {
  objectInsert: string[];
  objectRemove: string[];
}

/** An operation id as the ingest accepts one: the positive integer of a D1 row id. */
function isIngestOpId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** The top-level arms an ingest carrying an operation id may not also carry. */
const ARMS_BESIDE_NO_OPERATION = ["config", "telarVersion", "stories", "steps", "glossary", "pages"] as const;

/**
 * An `/ingest-sync` request's body and its operation id, or the 400 that
 * refuses it: a body that is not JSON, a payload that is not an object, or an
 * `opId` that is malformed or sent beside an arm it does not cover.
 */
async function readIngestBody(
  request: Request,
): Promise<{ payload: SyncIngestPayload; opId: number | undefined } | Response> {
  let payload: SyncIngestPayload;
  try {
    payload = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  if (!payload || typeof payload !== "object") {
    return new Response("Missing payload", { status: 400 });
  }
  const opId = ingestOpIdOf(payload as unknown as Record<string, unknown>);
  if (opId === null) return new Response("Invalid opId", { status: 400 });
  if (!captureTravelsAlone(payload as unknown as Record<string, unknown>)) {
    return new Response("steps.captureKeptColumns travels alone", { status: 400 });
  }
  if (!renameTravelsAlone(payload as unknown as Record<string, unknown>)) {
    return new Response("objects.rename travels alone, with its opId", { status: 400 });
  }
  return { payload, opId };
}

/**
 * Log the entries an ingest refused for an out-of-domain value, by arm and
 * position, and the field each refusal names with the type that stood there.
 * Both are the boundary's own words — a field path from the domain table and
 * `typeNameOf`'s answer — so the lines describe the plant without carrying it.
 */
function logIngestRefusals(
  projectId: number | null,
  refused: Record<string, readonly number[]>,
  diagnostics: readonly IngestDiagnostic[],
): void {
  const refusedTotal = Object.values(refused).reduce((n, list) => n + list.length, 0);
  if (refusedTotal > 0) {
    console.error(
      `[ingest-sync] project ${projectId}: refused ${refusedTotal} payload ` +
        `entr${refusedTotal === 1 ? "y" : "ies"} for an out-of-domain value ` +
        `(by arm and position): ${JSON.stringify(refused)}`,
    );
  }
  if (diagnostics.length > 0) {
    console.error(
      `[ingest-sync] project ${projectId}: out-of-domain fields ` +
        `(arm, position, field, type): ${JSON.stringify(diagnostics)}`,
    );
  }
}

/** The top-level fields an ingest may carry beside `steps`: none. */
const ARMS_BESIDE_CAPTURE = ["opId", "config", "telarVersion", "stories", "objects", "glossary", "pages"] as const;

/**
 * Whether a payload carrying `steps` carries nothing else. A capture is
 * checked against the live story before the transaction, so an arm applied in
 * the same transaction ahead of it (`stories.replaceContent` rewriting the
 * steps, above all) would leave that check describing a story that is gone,
 * and the capture would put cells on steps whose content changed. Its one
 * producer, the publish, sends it alone.
 */
function captureTravelsAlone(payload: Record<string, unknown>): boolean {
  if (payload.steps === undefined) return true;
  return ARMS_BESIDE_CAPTURE.every((arm) => payload[arm] === undefined);
}

/** The `steps.captureKeptColumns` arm split on its domains (`partitionIngestArm`). */
function partitionKeptColumnsArm(
  payload: SyncIngestPayload,
  diagnostics: IngestDiagnostic[],
): IngestArmPartition<IngestCaptureKeptColumns> {
  return partitionIngestArm(payload.steps?.captureKeptColumns, "stepCaptureKeptColumns", (e) => e.storyId, diagnostics);
}

/**
 * Which of two maps claiming one human key keeps it, by position.
 *
 * D1 decides where it can, since the one party no client can write to is the
 * row that owns the key. Failing that, the map that already carries a row id
 * wins over one that carries none, and otherwise the incumbent, the first
 * occurrence.
 */
function keeperOfTwo(
  candidate: number,
  incumbent: number,
  sides: { idAt: (at: number) => number | null; d1Id: number | undefined },
): number {
  const isD1Row = (at: number): boolean => sides.d1Id !== undefined && sides.idAt(at) === sides.d1Id;
  if (isD1Row(candidate) !== isD1Row(incumbent)) return isD1Row(candidate) ? candidate : incumbent;
  return sides.idAt(incumbent) === null && sides.idAt(candidate) !== null ? candidate : incumbent;
}

/** The `objects.order` and `objects.sheet` arms split on their domains (`partitionIngestArm`). */
function partitionObjectPlacementArms(
  payload: SyncIngestPayload,
  diagnostics: IngestDiagnostic[],
): { objectOrder: IngestArmPartition<IngestObjectOrder>; objectSheet: IngestArmPartition<SheetEntry> } {
  const objects = payload.objects ?? { order: undefined, sheet: undefined };
  return {
    objectOrder: partitionIngestArm(objects.order, "objectOrder", (e) => e.objectId, diagnostics),
    objectSheet: partitionIngestArm(objects.sheet, "objectSheet", (e) => e.objectId, diagnostics),
  };
}

/** The `pages.captureFrontmatter` arm split on its domains (`partitionIngestArm`). */
function partitionPageCaptureArm(
  payload: SyncIngestPayload,
  diagnostics: IngestDiagnostic[],
): IngestArmPartition<IngestPageCapture> {
  return partitionIngestArm(payload.pages?.captureFrontmatter, "pageCaptureFrontmatter", (c) => c.pageId, diagnostics);
}

/** The `pages.replaceContent` arm split on its domains (`partitionIngestArm`). */
function partitionPageReplaceArm(
  payload: SyncIngestPayload,
  diagnostics: IngestDiagnostic[],
): IngestArmPartition<IngestPageReplaceContent> {
  return partitionIngestArm(payload.pages?.replaceContent, "pageReplaceContent", (e) => e.pageId, diagnostics);
}

/** The `pages.remove` and `pages.rename` arms split on their domains (`partitionIngestArm`). */
function partitionPageSlugArms(
  payload: SyncIngestPayload,
  diagnostics: IngestDiagnostic[],
): { remove: IngestArmPartition<IngestPageRemove>; rename: IngestArmPartition<IngestPageRename> } {
  return {
    remove: partitionIngestArm(payload.pages?.remove, "pageRemove", (e) => e.pageId, diagnostics),
    rename: partitionIngestArm(payload.pages?.rename, "pageRename", (e) => e.pageId, diagnostics),
  };
}

/** The `pages.storeWrittenFrontmatter` arm split on its domains (`partitionIngestArm`). */
function partitionPageStoreArm(
  payload: SyncIngestPayload,
  diagnostics: IngestDiagnostic[],
): IngestArmPartition<IngestPageStoreWritten> {
  return partitionIngestArm(payload.pages?.storeWrittenFrontmatter, "pageStoreWrittenFrontmatter", (e) => e.pageId, diagnostics);
}

/**
 * The planned captures written to their step maps. Only a step that records
 * none is filled: the capture brings in what was never read, and never
 * replaces what an author or an accept recorded. Each insert is a section step
 * built as an ingest builds a new one (`newStepMap`), placed after the step it
 * names (`placeCapturedSteps`). Runs inside the caller's transaction.
 */
function applyKeptColumnsCaptures(plans: readonly KeptColumnsPlan[]): void {
  for (const plan of plans) {
    for (const fill of plan.fills) {
      if (keptColumnsNeverRecorded(fill.map.get("extra_columns"))) fill.map.set("extra_columns", fill.extra_columns);
    }
    placeCapturedSteps(plan.stepsArray, plan.order, plan.inserts);
  }
}

/**
 * A capture's fills and inserts resolved against the story's live steps, in
 * their live order; null when a fill or an insert names a step the story
 * does not hold.
 */
function keptColumnsPlan(
  entry: IngestCaptureKeptColumns,
  stepsArray: Y.Array<Y.Map<unknown>>,
  order: Y.Map<unknown>[],
): KeptColumnsPlan | null {
  const byId = new Map(order.map((map) => [map.get("_id"), map]));
  const fills = entry.steps.map((step) => ({ map: byId.get(step.stepId), ...step }));
  const inserts = (entry.inserts ?? []).map(({ afterStepId, step }) => ({
    after: afterStepId === null ? null : byId.get(afterStepId),
    map: capturedStepMap(step),
    extra_columns: step.extra_columns,
  }));
  if (fills.some((fill) => fill.map === undefined) || inserts.some((insert) => insert.after === undefined)) return null;
  return {
    storyId: entry.storyId,
    fills: fills as KeptColumnsPlan["fills"],
    stepsArray,
    order,
    inserts: inserts as KeptColumnsPlan["inserts"],
  };
}

/** A captured row as a new section step: no object, prose or layers. */
function capturedStepMap(step: IngestCapturedStep): Y.Map<unknown> {
  return newStepMap({ ...step, kind: "section" }, []);
}

/**
 * A payload's operation id: undefined when it names none, null when the one it
 * names cannot be taken. An operation is settled object by object, so it may
 * carry only object inserts and removals, or an object rename alone
 * (`renameTravelsAlone`): an arm with no per-object receipt could be neither
 * skipped on a replay nor safely applied twice.
 */
function ingestOpIdOf(payload: Record<string, unknown>): number | undefined | null {
  if (payload.opId === undefined) return undefined;
  if (!isIngestOpId(payload.opId)) return null;
  const objects = payload.objects as { update?: unknown } | null | undefined;
  const other = ARMS_BESIDE_NO_OPERATION.some((arm) => payload[arm] !== undefined);
  return other || objects?.update !== undefined ? null : payload.opId;
}

/**
 * The identity of one `objects.remove` entry, for the arm's identity rule: the
 * string itself, or the `objectId` of an entry that also carries a positive
 * integer `docId`. Anything else answers undefined, which the rule refuses by
 * position.
 */
function removeEntryIdentity(entry: unknown): unknown {
  if (typeof entry === "string") return entry;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
  const { objectId, docId } = entry as { objectId?: unknown; docId?: unknown };
  return isIngestOpId(docId) ? objectId : undefined;
}

/** A term's prose field as a string, or null when the document holds neither a `Y.Text` nor a string there. */
function termText(m: Y.Map<unknown>, field: string): string | null {
  const value = m.get(field);
  if (value instanceof Y.Text) return value.toString();
  return typeof value === "string" ? value : null;
}

/**
 * Remove each glossary term `arm.removeHeld` names by D1 id whose id publishes
 * none (`isHeldTermId`) and whose title, definition and kind are still the
 * values the sync compared with glossary.csv's held row, from the last index
 * down; the snapshot's orphan sweep then deletes its row. A term edited since
 * that comparison is kept: the file holds no copy of the edit.
 */
function removeHeldTerms(
  glossaryArray: Y.Array<Y.Map<unknown>>,
  arm: { removeHeld?: unknown } | undefined,
): void {
  if (!Array.isArray(arm?.removeHeld)) return;
  const compared = new Map<number, { title: unknown; definition: unknown; kind: unknown }>();
  for (const entry of arm.removeHeld as unknown[]) {
    if (entry && typeof entry === "object" && typeof (entry as { dbId?: unknown }).dbId === "number") {
      const e = entry as { dbId: number; title: unknown; definition: unknown; kind: unknown };
      compared.set(e.dbId, e);
    }
  }
  for (let i = glossaryArray.length - 1; i >= 0; i--) {
    const m = glossaryArray.get(i);
    if (!(m instanceof Y.Map)) continue;
    const termId = m.get("term_id");
    const values = compared.get(m.get("_id") as number);
    if (typeof termId !== "string" || !isHeldTermId(termId) || values === undefined) continue;
    const kind = m.get("kind") ?? "";
    if (termText(m, "title") === values.title && termText(m, "definition") === values.definition && kind === values.kind) {
      glossaryArray.delete(i, 1);
    }
  }
}

/** The D1 table behind each `/ingest-sync` insert bucket, for receipt lookups. */
const RECEIPT_TABLES = {
  objectInsert: "objects",
  glossaryInsert: "glossary_terms",
  pageInsert: "project_pages",
} as const;

/**
 * The row id of each page a `pages.insert` arm inserted, by slug, read off the
 * insert receipts once the snapshot has backfilled `_id`: a page whose INSERT
 * did not land, and one the arm skipped as already held, is not named.
 */
function insertedPageIds(
  receipts: ReadonlyArray<{ bucket: string; key: string; map: Y.Map<unknown> }>,
): Record<string, number> {
  const ids: Record<string, number> = {};
  for (const { bucket, key, map } of receipts) {
    const id = map.get("_id");
    if (bucket === "pageInsert" && typeof id === "number" && id > 0) ids[key] = id;
  }
  return ids;
}

interface ConfigRow {
  title: string | null;
  lang: string | null;
  description: string | null;
  author: string | null;
  email: string | null;
  logo: string | null;
  baseurl: string | null;
  url: string | null;
  telar_version: string | null;
  theme: string | null;
  include_demo_content: number | null;
  google_sheets_enabled: number | null;
  google_sheets_published_url: string | null;
  show_on_homepage: number | null;
  show_story_steps: number | null;
  show_object_credits: number | null;
  browse_and_search: number | null;
  show_link_on_homepage: number | null;
  show_sample_on_homepage: number | null;
  collection_mode: number | null;
  skip_stories: number | null;
  featured_count: number | null;
  story_key: string | null;
  navigation_json: string | null;
}

interface LandingRow {
  stories_heading: string | null;
  stories_intro: string | null;
  objects_heading: string | null;
  objects_intro: string | null;
  welcome_body: string | null;
}

// ---------------------------------------------------------------------------
// Ingest wire shapes (shared by /restore-orphans and /ingest-sync)
// ---------------------------------------------------------------------------
//
// The route action owns all CSV/YAML parsing and sends fully resolved, typed
// values; the DO stays parser-free. Step and layer shapes are shared verbatim
// between the two endpoints.

interface IngestStep {
  step_number?: number;
  kind?: string;
  object_id?: string;
  x?: number | null;
  y?: number | null;
  zoom?: number | null;
  page?: string;
  question?: string;
  answer?: string;
  alt_text?: string;
  clip_start?: string;
  clip_end?: string;
  loop?: string;
  /** The step's kept story CSV cells as a JSON object string; absent or "" when none. */
  extra_columns?: string;
}

interface IngestLayer {
  step_index: number;
  layer_number: number;
  title?: string;
  button_label?: string;
  content?: string;
}

/**
 * A story's steps and layers as GitHub holds them, to replace the live
 * story's, and the raw canonical hash of the Compositor's version the author
 * reviewed (`rawCanonicalFromD1` at check time).
 */
interface IngestReplaceContent {
  storyId: string;
  steps: IngestStep[];
  layers: IngestLayer[];
  expected: string;
}

/**
 * A story's kept columns as a publish read them from its CSV, per step by D1
 * row id, and the raw canonical hash of the story the reading was aligned
 * against (`rawCanonicalFromD1` of the rows the publish read after its forced
 * snapshot). Each blob is a JSON object of the step's cells, as the import
 * records one.
 */
interface IngestCaptureKeptColumns {
  storyId: string;
  expected: string;
  steps: Array<{ stepId: number; extra_columns: string }>;
  /** Rows the Compositor never had, each after the step `afterStepId` names, or first when null. */
  inserts?: Array<{ afterStepId: number | null; step: IngestCapturedStep }>;
}

/** A captured row's fields, as the story reader mapped them. */
type IngestCapturedStep = Pick<IngestStep, "page" | "x" | "y" | "zoom" | "clip_start" | "clip_end" | "loop"> & {
  extra_columns: string;
};

/** What each `steps.captureKeptColumns` entry met, by story id. */
interface KeptColumnsOutcome {
  /** Every step of the entry holds kept columns in D1: those the entry filled, and those already recorded. */
  captured: string[];
  /** The live story differs from the one the capture was aligned against; nothing of it written. */
  changed: string[];
  /** No such story, a step the story does not hold, or maps that cannot be read; nothing of it written. */
  missing: string[];
  /** Filled in the document, and D1 does not show it after the flush. */
  failed: string[];
}

/** One capture checked against the live story, with the steps to fill and the maps to insert. */
interface KeptColumnsPlan {
  storyId: string;
  fills: Array<{ map: Y.Map<unknown>; stepId: number; extra_columns: string }>;
  stepsArray: Y.Array<Y.Map<unknown>>;
  /** The story's steps in the live order its `expected` hash was checked on. */
  order: Y.Map<unknown>[];
  inserts: Array<{ after: Y.Map<unknown> | null; map: Y.Map<unknown>; extra_columns: string }>;
}

/**
 * Whether a step map's `extra_columns` was never recorded: absent or `""`.
 * `"{}"` is recorded, with no column left, which is what removing a step's
 * last kept column writes (`~/lib/story-columns`), so a capture never brings
 * back a column the author removed.
 */
function keptColumnsNeverRecorded(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/** What each `stories.replaceContent` entry met, by story id. */
interface ContentOutcome {
  applied: string[];
  /** The live story already holds this content: a replay, a no-op. */
  alreadyApplied: string[];
  /** The live story is no longer the one reviewed; nothing of it applied. */
  changedSinceReview: string[];
  /** No such story in the document, or one whose maps or the payload could not be read. */
  failed: string[];
}

/**
 * A story the document holds the incoming content for, applied by this
 * delivery or already there, reported as `outcome` only once D1 shows it
 * (`settleContent`).
 */
interface ContentCandidate {
  storyId: string;
  /** The incoming content's raw canonical hash. */
  incomingHash: string;
  outcome: "applied" | "alreadyApplied";
}

/** One accepted replacement, planned before the transaction that applies it. */
interface ContentReplacement {
  entry: IngestReplaceContent;
  incomingHash: string;
  story: Y.Map<unknown>;
  stepsArray: Y.Array<Y.Map<unknown>>;
  liveSteps: Y.Map<unknown>[];
  liveCanon: CanonicalStep[];
  incomingCanon: CanonicalStep[];
  /** The payload's layers, grouped by step and in their order. */
  incomingLayers: IngestLayer[][];
}

/**
 * Object insert row — mirrors the objects Y.Map shape buildFromD1Rows builds.
 *
 * Exported so every producer of an ingest payload compiles against the shape
 * the DO actually reads; a producer and this reader cannot drift apart.
 */
export interface IngestObjectInsert {
  object_id: string;
  title?: string | null;
  featured?: boolean;
  creator?: string | null;
  description?: string | null;
  source_url?: string | null;
  period?: string | null;
  year?: string | null;
  object_type?: string | null;
  subjects?: string | null;
  source?: string | null;
  credit?: string | null;
  thumbnail?: string | null;
  alt_text?: string | null;
  dimensions?: string | null;
  extra_columns?: string | null;
  image_available?: boolean;
  /** Attribution carried from the producer's row; null when nobody is named. */
  created_by: number | null;
  /**
   * Provenance, and narrower than the column: "compositor" (a course preload)
   * and "repo" (a row sync takes from GitHub) are the values the Y path
   * carries. It travels with the insert because the row's D1 INSERT may fail
   * at the flush and land at a later snapshot, which reads the origin from the
   * document; a write after the ingest would find no row to patch. Any other
   * value is dropped by buildObjectYMap, and the INSERT defaults it to "iiif".
   */
  origin?: "compositor" | "repo";
  /**
   * The course project an object was preloaded from. OMITTED — never null —
   * on an object the site made itself: absence is the unmarked state.
   */
  course_project_id?: number;
}

/**
 * Page insert row — mirrors the pages Y.Map shape buildFromD1Rows builds.
 *
 * Exported so every producer of an ingest payload compiles against the shape
 * the DO actually reads; a producer and this reader cannot drift apart.
 *
 * There is no `order`: a page's place is its `order_key`, minted here at the
 * end of the array, and the `"order"` column is the dense rank the snapshot
 * derives from that. There is no `_id` either — the row does not exist yet, and
 * the snapshot's INSERT is what mints it. Both omissions are what keep this the
 * ONLY path by which a `project_pages` row is created for a live project; see
 * the `pages.insert` arm below.
 */
export interface IngestPageInsert {
  slug: string;
  title?: string | null;
  body?: string | null;
  /** The file's front-matter block as the scan read it; absent or null when not read. */
  frontmatter?: string | null;
  /** Attribution carried from the producer; null when nobody is named. */
  created_by: number | null;
  /** The menu entry GitHub's menu gives a page taken from GitHub; see `placeInsertedPageMenuEntry`. */
  menu?: IngestPageMenuEntry;
}

/**
 * An object removal that names the D1 row it means as well as its key. The
 * ingest removes the Y.Map only when both match, so an object deleted and
 * re-created under the same `object_id` — a new row, a new id — is left alone.
 *
 * Exported so every producer of an ingest payload compiles against the shape
 * the DO actually reads.
 */
export interface IngestObjectRemove {
  objectId: string;
  docId: number;
}

/** Object update field keys the DO recognises (subset of objects.csv columns). */
type IngestObjectField =
  | "title" | "creator" | "description" | "period" | "year" | "object_type"
  | "dimensions" | "subjects" | "source" | "credit" | "featured" | "alt_text"
  | "source_url" | "thumbnail" | "extra_columns" | "image_available";

interface SyncIngestPayload {
  /**
   * The operation this ingest applies, when it has one. An id already in the
   * receipts is answered `alreadyApplied` and applies nothing.
   */
  opId?: number;
  /**
   * A sync apply's: apply everything or nothing (`ingestHeldBack`). A field
   * changed since the check, a row re-created since, content changed since,
   * or a page removal or rename that cannot apply holds the whole ingest
   * back, and it is answered `heldBack` with what held it, having written
   * nothing.
   */
  allOrNothing?: boolean;
  /** Managed config fields, keyed by D1 column name (identical to the Y keys). */
  config: Array<{ key: string; value: string | boolean | number }>;
  /** Present only on an "ahead" version heal — keeps the Y config aligned with
   *  the D1 heal (snapshotConfig deliberately omits telar_version). */
  telarVersion?: string;
  /**
   * A field a producer may omit is optional here, and an omitted one takes the
   * default this class applies at the write: on an update that is the value the
   * document already holds, and on an insert the column's own unset value.
   */
  stories: {
    update: Array<{
      storyId: string; title?: string; subtitle?: string; byline?: string;
      isPrivate?: boolean; showSections?: boolean;
    }>;
    insert: Array<{
      storyId: string; title?: string; subtitle?: string; byline?: string;
      isPrivate?: boolean; showSections?: boolean;
      steps?: IngestStep[]; layers?: IngestLayer[];
    }>;
  };
  /** Kept columns a publish read from a story's CSV, for steps that never recorded any. */
  steps?: {
    captureKeptColumns?: IngestCaptureKeptColumns[];
  };
  objects: {
    /**
     * A `docId` applies the update only to the Y.Map holding it beside the key.
     * `renameTo` is GitHub's spelling of the key, which strips to the same id
     * (see `refusedRename` in ingest-domains.ts), and becomes the object's key.
     */
    update: Array<{
      objectId: string; docId?: number;
      fields?: Partial<Record<IngestObjectField, string | boolean | null>>;
      renameTo?: string;
      /** Each field's value as the sync check read it; see `fieldsUnchangedSinceReview`. */
      seen?: Partial<Record<IngestObjectField, string | boolean | null>>;
    }>;
    insert: IngestObjectInsert[];
    /** A bare `object_id` removes the first Y.Map holding it. */
    remove: Array<string | IngestObjectRemove>;
    /** GitHub's order of the rows the sync paired, each by key and D1 id (`applyObjectOrder`). */
    order?: IngestObjectOrder[];
    /** GitHub's objects.csv in order, which places the inserts (`sheetPlacement`). */
    sheet?: SheetEntry[];
    /** An object's ID change; travels alone with its record's id (`ingestObjectRename`). */
    rename?: IngestObjectRename[];
  };
  glossary: {
    update: Array<{ termId: string; title?: string; definition?: string; kind?: string }>;
    insert: Array<{ termId: string; title: string; definition: string; kind?: string }>;
    /** Terms whose id publishes none (`isHeldTermId`) to remove, by D1 id, while they hold these values; the snapshot deletes each row. */
    removeHeld?: Array<{ dbId: number; title: string; definition: string; kind: string }>;
  };
  /**
   * A page's slug enters or changes only through an arm of this ingest:
   * `insert` brings a new slug in, `rename` changes one and `remove` frees
   * one, each inside the gate below. `project_pages(project_id, slug)` is
   * UNIQUE, and the snapshot re-key that resolves a slug collision seeds its
   * minted key from a read taken many statements before the batch that
   * carries the resulting UPDATE. Any writer of the table outside this DO can
   * take the minted slug inside that window; the UPDATE then aborts and D1
   * discards the whole batch, while the re-keyed document survives in the
   * standalone blob write that precedes it, so every retry re-issues the same
   * colliding UPDATE. Through the document, the mint's `takenKeys` (document
   * keys UNION D1 keys) already covers the slug, and the gate means no page
   * write can interleave with a snapshot at all. `rename` refuses a slug
   * another page holds rather than leave the collision to the re-key. The
   * other arms write a page's content and block and leave its slug as it is.
   */
  pages?: {
    insert?: IngestPageInsert[];
    /** Pages deleted on GitHub; see `planPageSlugChanges`. */
    remove?: IngestPageRemove[];
    /** Pages renamed on GitHub; see `planPageSlugChanges`. */
    rename?: IngestPageRename[];
    /** Blocks read from the files of pages never captured; see `applyFrontmatterCaptures`. */
    captureFrontmatter?: IngestPageCapture[];
    /** GitHub's version of accepted pages; see `planPageReplacements`. */
    replaceContent?: IngestPageReplaceContent[];
    /** Blocks a landed publish wrote for pages it read as unreadable; see `applyWrittenFrontmatterStores`. */
    storeWrittenFrontmatter?: IngestPageStoreWritten[];
  };
}

// The ingest's config allow-lists live in ingest-domains.ts beside the value
// domain each key carries. Object fields split the same way as config keys —
// Y.Text for character-level merge, plain scalars for the rest — and both
// mirror buildFromD1Rows so an ingested value round-trips through the snapshot.
const OBJECT_YTEXT_FIELDS: ReadonlySet<string> = new Set([
  "title", "creator", "description", "alt_text", "period", "year",
  "object_type", "subjects", "source", "credit",
]);
const OBJECT_BOOL_FIELDS: ReadonlySet<string> = new Set(["featured", "image_available"]);
// Plain-string object fields the ingest may set; anything not in one of the
// three object sets is ignored (e.g. "_id", "object_id", or an unknown key).
const OBJECT_PLAIN_FIELDS: ReadonlySet<string> = new Set([
  "source_url", "thumbnail", "dimensions", "extra_columns",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// yTextToString lives in collaboration-helpers.ts (shared with the activity
// resolver) and is imported above.

/**
 * Flush budget for /clear-course-markers, whose answer is a promise that D1 is
 * consistent. Three attempts of a half-second drain each: generous against the
 * sub-second alarm snapshot this exists to wait out, and bounded so a wedged
 * one ends in a 503 the caller retries rather than a DO that spins.
 */
const CLEAR_MARKERS_FLUSH_ATTEMPTS = 3;
/**
 * How many times `/editing-time` will take its pair of figures before giving
 * up. A snapshot runs every thirty seconds and settles in one synchronous
 * step, so two consecutive reads racing it is already unlikely and three is
 * beyond what the beat allows; a fourth attempt would be a loop waiting for a
 * condition that is not coming.
 */
const EDITING_TIME_READ_ATTEMPTS = 3;
const SNAPSHOT_DRAIN_POLL_MS = 25;
const SNAPSHOT_DRAIN_MAX_POLLS = 20;

/** The name of the Y.Doc root the site configuration lives on. */
const CONFIG_ROOT = "config";

/**
 * One `project_config` column: where its value comes from in the document,
 * what it takes when the document does not hold the key, and whether an absent
 * key is a value the snapshot cannot read.
 *
 * The column list and the bind list are built from this one table so the
 * UPDATE and the INSERT cannot drift: a column dropped from the SET list drops
 * its bind in the same step, and position is what pairs the two.
 */
interface ConfigColumn {
  /** The `project_config` column. */
  column: string;
  /** The config-root key it reads. */
  key: string;
  /** The document value, read against this column's domain. */
  read: (value: unknown) => Read<unknown>;
  /** What the column takes when the document does not hold the key. */
  unset: unknown;
  /**
   * Whether an absent key is treated as unreadable on the UPDATE branch.
   *
   * True for the six convenor-only keys and nothing else. A collaborator may
   * edit every other config field, so a deleted `title` means "clear" and an
   * absent flag means its declared default; the six have no legitimate author
   * for an absence, because the guard's revert for an edit inside a planted
   * shared value deletes the whole key, no UI removes them, and collaborators
   * are refused.
   */
  holdOnMissing: boolean;
}

/** A column whose value is a `Y.Text` the config page's editor binds to. */
function proseColumn(key: string): ConfigColumn {
  return {
    column: key,
    key,
    read: (value) => {
      const read = readConfigYText(value);
      return read.ok ? { ok: true, value: read.value.toString() } : read;
    },
    unset: "",
    holdOnMissing: false,
  };
}

/** A column a collaborator may write and whose render cannot fail. */
function renderedColumn(key: string, whenAbsent: string): ConfigColumn {
  return {
    column: key,
    key,
    read: (value) => ({ ok: true, value: renderedValue(value, whenAbsent) }),
    unset: whenAbsent,
    holdOnMissing: false,
  };
}

/** A boolean column, and the value it takes when the document is silent. */
function flagColumn(key: string, whenUnset: boolean, holdOnMissing = false): ConfigColumn {
  return {
    column: key,
    key,
    read: (value) => {
      const read = readFlag(value);
      return read.ok ? { ok: true, value: read.value ? 1 : 0 } : read;
    },
    unset: whenUnset ? 1 : 0,
    holdOnMissing,
  };
}

/** One of the four convenor-only text columns, which hold a plain string. */
function convenorTextColumn(key: string): ConfigColumn {
  return { column: key, key, read: readConfigString, unset: "", holdOnMissing: true };
}

/**
 * Every column `snapshotConfig` writes, in the order the statement lists them.
 *
 * `CONFIG_PLAIN_KEYS` in ingest-domains.ts is the ingest's list and is
 * deliberately shorter: the two Google Sheets keys are written here, and the
 * ingest takes only `google_sheets_enabled: false`, from a config repair.
 */
const CONFIG_COLUMNS: readonly ConfigColumn[] = [
  proseColumn("title"),
  proseColumn("description"),
  proseColumn("author"),
  proseColumn("email"),
  renderedColumn("lang", "en"),
  convenorTextColumn("baseurl"),
  convenorTextColumn("url"),
  renderedColumn("theme", ""),
  renderedColumn("logo", ""),
  flagColumn("include_demo_content", false, true),
  flagColumn("google_sheets_enabled", false, true),
  convenorTextColumn("google_sheets_published_url"),
  flagColumn("show_on_homepage", true),
  flagColumn("show_story_steps", true),
  flagColumn("show_object_credits", true),
  flagColumn("browse_and_search", true),
  flagColumn("show_link_on_homepage", true),
  flagColumn("show_sample_on_homepage", false),
  flagColumn("collection_mode", false),
  flagColumn("skip_stories", false),
  {
    column: "featured_count",
    key: "featured_count",
    read: (value) => ({ ok: true, value: renderedNumber(value, 4) }),
    unset: 4,
    holdOnMissing: false,
  },
  convenorTextColumn("story_key"),
  {
    column: "navigation_json",
    key: "navigation",
    read: (value) => {
      const read = readYArray(value);
      return read.ok
        ? { ok: true, value: JSON.stringify(read.value.toArray()) }
        : read;
    },
    unset: JSON.stringify([]),
    holdOnMissing: false,
  },
];

/**
 * The `objects.course_project_id` value to bind from an object Y.Map.
 *
 * The key is absent on an unmarked object and on one whose marker the leave
 * sequence has just cleared; both bind NULL. A value that is not a positive
 * integer also binds NULL rather than reaching the foreign key, so a malformed
 * Y value cannot fail the whole snapshot batch.
 */
function courseMarkerBind(objMap: Y.Map<unknown>): number | null {
  const raw = objMap.get("course_project_id");
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : null;
}

/**
 * Whether a socket claiming `claimed` may join a document at `generation`.
 *
 * Three claims are honest, and each names a document that cannot predate the
 * last reset: the current generation (a reconnection, including one carrying
 * edits queued through an offline spell), the fresh-document claim (a first
 * connection, a new tab, or a client that has just rebuilt), and — while the
 * document has never been reset — nothing at all.
 *
 * That last case is what keeps the fence off the projects it has no business
 * on. At generation 0 there is no pre-reset document in existence, so a silent
 * claim can only be a client built before this protocol; refusing it would lock
 * editors out to protect against a document that cannot exist. Once a reset has
 * happened, silence stops being admissible: it is the one claim a stale
 * document and a fresh one can both make, and the sync exchange would merge the
 * stale one back before anything could tell them apart.
 *
 * A generation storage could not read is handled by the caller, not here: it
 * stands the whole guard down rather than reporting a number nothing read.
 */
export function mayRejoinGeneration(claimed: string | null, generation: number): boolean {
  if (claimed === String(generation)) return true;
  if (claimed === FRESH_DOCUMENT_GENERATION) return true;
  return claimed === null && generation === 0;
}

/**
 * The Yjs update carried by a sync UPDATE packet, or null for anything else.
 *
 * A decoder of its own, over the same bytes: the one `readSyncMessage` is given
 * is consumed by the apply, and this read must not disturb it. Total, because
 * it runs on client-authored bytes for a measurement — a packet it cannot parse
 * is one the measurement skips, and `readSyncMessage` keeps its own containment
 * for the apply.
 */
function syncUpdateBytes(data: Uint8Array): Uint8Array | null {
  try {
    const decoder = decoding.createDecoder(data);
    if (decoding.readVarUint(decoder) !== messageSync) return null;
    if (decoding.readVarUint(decoder) !== syncProtocol.messageYjsUpdate) return null;
    return decoding.readVarUint8Array(decoder);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Durable Object class
// ---------------------------------------------------------------------------

export class ProjectCollaborationDO extends DurableObject<Env> {
  private ydoc: Y.Doc;
  private awareness: awarenessProtocol.Awareness;
  private projectId: number | null = null;
  private docLoaded = false;
  private userFieldSets: Map<number, Set<string>> = new Map();
  // When each person last edited, stamped by the handler that saw the edit
  // rather than by the snapshot that writes it. Same lifetime as the field
  // sets above: empty on a fresh instance, which reads as "no edits seen
  // here" and leaves the stored stamp alone.
  private lastEditAt: Map<number, string> = new Map();
  // The same edits keyed by field path, carrying the actor as well as the
  // stamp — which is what lets a ROW's `updated_at` mean the row and its
  // `last_edited_by` name a person. Same lifetime and same caveat as above.
  private editsByPath: EditsByPath = new Map();
  // The two measures that exist only while the document is live: how long each
  // person has been working, and how many words they have added to each row.
  // `wordBaseline` is what each prose field held when this instance last saw it,
  // seeded from the document at load — without it the first edit to a field has
  // nothing to be measured against. Same lifetime and same additive discipline
  // as everything above: drained into deltas by the snapshot, never assigned.
  private timeLedger: TimeLedger = new Map();
  private wordsByRow: WordsByRow = new Map();
  private wordBaseline: WordBaseline = new Map();
  // The `id|source` pairs an /enrich-objects request is reading the manifest
  // of, so a request arriving meanwhile does not read the same one again.
  private manifestsInFlight = new Set<string>();
  // Whether this instance has read the stored stamps that tell it if the next
  // change continues the last instance's stretch of work or begins a new one.
  private timeSeeded = false;
  // Bumped wherever the time ledger gives up its seconds. A reader that takes
  // the stored figure and the pending one either side of an await needs to know
  // whether a snapshot moved seconds from the second to the first in the gap:
  // the two are the same seconds, and a read that spans the move counts them
  // twice or loses them.
  private settleEpoch = 0;
  private newSessions: Set<number> = new Set();
  // Per-user set of `collection:id` entity keys already emitted to activity_log
  // this DO lifetime. userFieldSets accumulates across snapshots and is never
  // cleared, so without this tracker every 30s snapshot would re-INSERT a row
  // for every entity ever touched. We emit one coarse activity row per
  // (user, entity) the first time it appears, then record it here so later
  // snapshots skip it. Resets on cold start (a returning editor emits afresh).
  private activityEmitted: Map<number, Set<string>> = new Map();
  private isSnapshotting = false;
  // Every entity the LAST completed `doSnapshot` could not put in D1. A
  // snapshot must not abort mid-flush, so a refused INSERT is swallowed and the
  // remaining entities are still written; this is the channel that carries the
  // refusal out afterwards, so `/snapshot` can refuse rather than answer 200
  // for a flush that lost a row. Cleared at the top of every `doSnapshot`, so
  // it never describes an earlier pass, and only read after a flush that
  // returned true.
  private snapshotInsertFailures: SnapshotInsertFailure[] = [];
  // The id each object INSERT returned, against the Y.Map it was written for,
  // recorded before the `_id` backfill: a backfill that throws leaves the map
  // with no id over a row D1 has committed, and `/ingest-sync` settles its
  // receipts by identity, which the INSERT's own answer is the one source of.
  // Replaced before each ingest's flush, so it describes that flush alone.
  private objectInsertIds: WeakMap<Y.Map<unknown>, number> = new WeakMap();
  // The one halt state, and the instance's memory of a durable marker at
  // `halt:<generation>`. Its reasons are the states this object reached and
  // must not persist from: a revert enforcement could not complete, a write
  // fence it could not reconcile, a base or record it could not apply, a log it
  // could not read, a marker it could not parse. Under it every write to the
  // log is suppressed, every inbound mutation is dropped, every socket is
  // closed, admission and the mutating routes are refused, and `/reset` is the
  // one recovery. The refusal outlives this instance because the marker is
  // durable: a load reads it before it claims anything. The generation is
  // carried beside the marker because a reset advances the generation before
  // its rebuild, and the old halt has to be retained until the replacement
  // lands.
  private persistenceHalted: { generation: number; marker: HaltMarker } | null = null;
  /**
   * A snapshot dropped course markers the peers have not been sent yet. Set
   * by the drop and cleared only by a snapshot that broadcasts, so a failed
   * attempt does not lose the change it made to the document.
   */
  private markerBroadcastOwed = false;

  /** Maps whose `ADOPTED_MARK` the batch of this snapshot, once it lands, clears. */
  private adoptionMarks: Array<Y.Map<unknown>> = [];
  // Whether the message being processed right now has failed. Set before any
  // marker put is attempted, so a put that throws still leaves the message
  // failed; read by the drain, which discards what the message staged, and by
  // the accumulator, which credits nothing once it is set.
  private messageFailed = false;
  // The log group of the message being processed right now, and the mark of a
  // message scope: null outside one. `origin` is the socket the message
  // arrived on; `captured` holds, in emission order, every non-socket
  // transaction the apply provoked. The scope is synchronous and is closed
  // before the handler's first await, so a transaction issued while the
  // activity flush is pending is a standalone record rather than this
  // message's.
  private messageGroup: { origin: unknown; captured: Uint8Array[] } | null = null;
  // Whether the message being processed right now reached `Y.applyUpdate`. Set
  // before the apply is attempted, so an observer that throws after the structs
  // were integrated still counts as having touched the document; a message
  // refused before the apply changed nothing and abandons nothing.
  private documentTouched = false;
  // What this message has asked to send and to close. Initialised immediately
  // before the synchronous processing and cleared on every exit, so nothing one
  // message staged can be issued by the next.
  private stagedEffects: StagedEffects = { sends: [], closes: [] };
  // Whether the document is in a phase whose transactions are not the log's:
  // the base, the replay and a rebuild are the document being restored rather
  // than changed. True from construction and from every `replaceDocument`, and
  // cleared at exactly three points — a stored base once its generation is
  // bound, a cold build once its initial write has landed, and a reset once its
  // replacement has.
  private logSuppressed = true;
  // Cached copy of DOC_GENERATION_KEY. null means "not read from storage yet";
  // 0 means "never reset".
  private docGeneration: number | null = null;
  // The sequence the loaded base was tagged with, seeded on load and captured
  // beside the encoding at every blob write. Null until a claim lands.
  private docSeq: number | null = null;
  // The revision this instance claimed or last wrote. Every write binds it and
  // moves it, and it advances only on an acknowledged result — never re-read
  // to make a write succeed. Null until a claim lands, and null again whenever
  // the document is disposed.
  private docWrite: number | null = null;
  // Re-entrancy guard for the unauthorised-delete revert handler. The
  // revert itself fires afterTransaction; we must not recurse into the
  // canDelete check on our own revert transaction.
  private isReverting = false;
  // Per-socket sliding-window violation tracker. Initialised in the
  // constructor so the WeakMap state is owned by the factory and the DO
  // exposes a stable function reference to the canDelete handler.
  private recordViolation: (ws: WebSocket) => boolean = () => false;
  // Whether the guard corrected the message being processed right now. Set by
  // the guard's `noteRevert` inside the apply, read by the relay a few lines
  // later, and cleared on every exit of the message handler — a flag left
  // standing would suppress the relay of the NEXT client's update.
  private revertedThisMessage = false;
  /** The membership read in flight per socket; see `socketStillMember`. */
  private membershipChecks = new Map<WebSocket, Promise<boolean>>();
  // Subtrees the guard has taken out of the document recently, and the only
  // thing that can recognise an inbound edit still addressed to one. Bounded
  // and self-expiring: see workers/displaced-edits.ts.
  private displacements: DisplacementLog = createDisplacementLog();
  // The project id this instance has proved is at `projectId` in its own
  // storage. Null while the binding is unmade — never bound, or bound by a put
  // that failed — and the work that needs a row without a socket waits on it.
  private identityBound: number | null = null;
  // The sequence of the exact base this instance opened on, and the floor the
  // logical replay tail is measured above. Initialised before the replay and
  // the repairs on every opening path, moved by a landed blob write and by a
  // landed compaction, and cleared with the document.
  private baseSeq: number | null = null;
  // The payload bytes of each record above `baseSeq`, in sequence order, and
  // their sum. A pair per record rather than one total, because a base that
  // moves to `s` has to drop exactly the records at or below `s` and keep those
  // above it — a snapshot encodes at a sequence a later record already stands
  // above.
  private logBytes: Array<{ seq: number; bytes: number }> = [];
  private logBytesSinceBase = 0;
  // The thresholds and the ceiling this instance compacts by. Assigned only by
  // a test seam; the codec's own ceiling is never mutated.
  private compactionPolicy: CompactionPolicy = {
    records: COMPACTION_RECORD_THRESHOLD,
    bytes: COMPACTION_BYTE_THRESHOLD,
    ceiling: MAX_RECORD_BYTES,
  };
  // The three lines that are stated once per load: an encoded state above the
  // policy ceiling, an accounting list past its stated size, and a snapshot
  // blob above the size warning. Each latches the LINE alone — the attempt it
  // describes recurs — and all three are cleared with the document.
  private compactionRefused = false;
  private accountingStated = false;
  private sizeWarned = false;
  // Whether this instance has said that it woke with no identity to restore.
  // One line per instance: an alarm that cannot name its project cannot read
  // its row, and repeating that at every wake says nothing new.
  private identityUnknownStated = false;
  // What the retirement inside the last landed blob write concluded, read and
  // cleared by the alarm that ran the snapshot half. Null when no blob write
  // has landed since.
  private snapshotRetirement: LogRetirement | null = null;
  // What one bounded log retirement may spend. The maintenance constants unless
  // a test lowers them, which is the only way a retirement can be made to run
  // out of budget without planting a thousand records to exhaust it.
  private retirementBudget: Partial<MaintenanceBudget> = {};
  // This instance's identity in the diagnostic's answer, and the deployment it
  // is running under. The nonce is what tells a reader that a later request met
  // a DIFFERENT instance: an eviction and a replacement both change it, and
  // nothing else does. The environment is cached at construction because every
  // control decision reads it and a test seam overwrites it in place.
  private readonly nonce = crypto.randomUUID();
  private environment: string;
  // The build binding, kept so a test can withhold it without rebuilding `env`.
  private readonly build: { id: string; tag: string; timestamp: string } | null;
  // The staging controls, read once per instance through `controls()`. The
  // pending promise is shared by concurrent callers and CLEARED on rejection,
  // so a consumer that meets a refused read does not hand the next one a
  // poisoned result; the cache is published only after a control's put has
  // resolved.
  private controlsCache: Controls | null = null;
  private controlsPending: Promise<Controls> | null = null;
  // The phase whose storage the probe is seeing, saved and restored in
  // `finally` by every path that sets it, so a diagnostic scan taken inside a
  // phase gives the enclosing tag back when it ends.
  private phase = "none";
  // The test seam the storage accessor proxies through. Null in production, and
  // the accessor then hands back the platform's own handle untouched.
  private storageProbe: StorageProbe | null = null;
  // Every alarm that reached its finalisation on this instance, newest last,
  // and the counter that gives each its id.
  private alarmRing: AlarmRecord[] = [];
  private lastAlarm: AlarmRecord | null = null;
  private alarmCounter = 0;
  // The listings the recording itself issued during the invocation in flight,
  // apart from every phase's own.
  private diagnosticLists = 0;
  // Whether a rejected ring put has been stated on this instance. One line per
  // load: a ring that cannot be written says nothing new at every alarm.
  private ringPutStated = false;
  // What the snapshot half of the alarm in flight concluded, set at the
  // boundaries that know — inside `writeFencedBase` and `runFencedBatch` —
  // and read by the finalisation. Reset at the top of every alarm.
  private snapshotBlob: BlobRecord = { outcome: "not_attempted", seq: null };
  private snapshotBatch: BatchRecord = { outcome: "not_attempted", reason: "snapshot_skipped" };
  private snapshotHeader: "retired" | "failed" | "not_attempted" = "not_attempted";
  private snapshotEncodedSeq: number | null = null;
  // The scheduling attempts made during the invocation in flight: how many
  // `scheduleSnapshot` calls it made, and the chain each returned, so the
  // finalisation can observe the alarm they armed rather than guess at it.
  private scheduleSnapshotCalls = 0;
  private scheduleSnapshotChains: Promise<void>[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ydoc = new Y.Doc();
    this.awareness = createAwareness(this.ydoc);
    this.environment = env.ENVIRONMENT;
    this.build = describeBuild(env);

    this.recordViolation = makeViolationCounter();
    this.attachDocHandlers();

    // Restore in-memory state after hibernation wake.
    // If sockets are present, the DO was evicted and is now waking up —
    // we need the Y.Doc ready immediately via blockConcurrencyWhile.
    const sockets = this.ctx.getWebSockets();
    if (sockets.length > 0) {
      // Recover projectId from the first attachment
      const firstAttachment = sockets[0].deserializeAttachment() as SocketAttachment | null;
      if (firstAttachment) {
        this.projectId = firstAttachment.projectId;
      }
      // Block until the doc is loaded so webSocketMessage never races ahead.
      //
      // The catch is INSIDE the callback. An exception escaping a
      // blockConcurrencyWhile callback makes Cloudflare terminate and discard
      // the Durable Object, so a transient D1 read here would evict every
      // hibernated editor. Swallowed, `docLoaded` stays false: `snapshotToD1`
      // no-ops while it is false, so nothing can overwrite D1 from a half-built
      // doc, and the next `ensureDocLoaded` (any control route, or the next
      // socket upgrade) retries the load.
      this.ctx.blockConcurrencyWhile(async () => {
        try {
          // The durable binding, first of everything under this gate: the id
          // came from an attachment a live socket carries, which is as verified
          // as the admission that wrote it, and an alarm on a later instance
          // with no socket has nothing else to learn it from.
          await this.bindIdentity();
          // Before the load, and inside this callback for the reason the load
          // is: Cloudflare holds every other delivered event until the
          // callback returns, so no message and no upgrade can reach the
          // document between the fence and the load. A socket admitted before
          // a reset is closed here rather than allowed to sync its pre-reset
          // document into the rebuilt one, and the object never opens with a
          // known-stale socket attached.
          if (!(await this.closeSocketsFromOtherGenerations())) return;
          await this.ensureDocLoaded();
          this.restoreAwareness();
        } catch (err) {
          // The loader owns the line for a refusal it already named, the halt
          // included, so this catch adds nothing for either.
          if (!isNamedPersistenceRefusal(err)) {
            console.error("[collaboration] hibernation-wake doc load failed", err);
          }
          // A document that cannot be loaded does not keep its editors
          // attached: held open, a hibernated editor goes on sending edits into
          // an instance that drops them. Closed, it reconnects on its own
          // schedule and meets the upgrade's refusal instead.
          this.closeAllSockets(
            DOCUMENT_UNAVAILABLE_CLOSE.code,
            DOCUMENT_UNAVAILABLE_CLOSE.reason,
          );
        }
      });
    }
  }

  // -------------------------------------------------------------------------
  // Storage access, and the staging controls
  // -------------------------------------------------------------------------

  /**
   * The storage handle every access in this file goes through.
   *
   * With no probe installed it is the platform's own object, so production pays
   * nothing for the seam. With one installed it is a proxy that passes every
   * operation through with the receiver preserved and offers the probed ones to
   * the seam first, tagged with the phase the object has set — which is what
   * lets a test count a phase's listings and deletions, and delay or reject the
   * alarm methods a scheduling attempt makes.
   *
   * The target is a parameter so a transaction's own handle can be wrapped the
   * same way: the atomic replacement stays the platform's, and the probe sees
   * the batches inside it without standing between them.
   */
  private storage(): DurableObjectStorage;
  private storage(target: DurableObjectTransaction): DurableObjectTransaction;
  private storage(
    target?: DurableObjectStorage | DurableObjectTransaction,
  ): DurableObjectStorage | DurableObjectTransaction {
    const actual = target ?? this.ctx.storage;
    const probe = this.storageProbe;
    if (probe === null) return actual;
    return new Proxy(actual, {
      get: (object, property, receiver) => {
        const value = Reflect.get(object, property, receiver);
        if (typeof value !== "function") return value;
        const bound = (value as (...args: unknown[]) => unknown).bind(object);
        if (!PROBED_OPERATIONS.has(String(property))) return bound;
        return (...args: unknown[]) =>
          probe(String(property), this.phase, args, () => bound(...args));
      },
    });
  }

  /**
   * The storage the diagnostic reads through: every underlying `get` and `list`
   * carries `noCache: true`.
   *
   * A read taken for an operator must describe what storage holds rather than
   * what the runtime last cached, and the codec's own reads pass no options of
   * their own — so the option is added here, around whatever handle the
   * accessor gave, and travels into the codec's batched part gets with it.
   */
  private uncachedStorage(): LogStorage {
    const storage = this.storage();
    return {
      get: ((keys: string & string[]) =>
        storage.get(keys, { noCache: true })) as LogStorage["get"],
      list: (options) => storage.list({ ...options, noCache: true }),
      put: (entries) => storage.put(entries),
      delete: (keys) => storage.delete(keys),
    };
  }

  /**
   * Run `work` with the probe's phase tag set, and give the enclosing tag back
   * however it ends.
   */
  private async underPhase<T>(phase: string, work: () => Promise<T>): Promise<T> {
    const enclosing = this.phase;
    this.phase = phase;
    try {
      return await work();
    } finally {
      this.phase = enclosing;
    }
  }

  /**
   * The staging controls, read once for the life of the instance.
   *
   * Awaited by every consumer — the read, the control route, the alarm's
   * preflight and the last-disconnect drain — through one in-flight promise, so
   * concurrent callers share a single storage read. A successful result is
   * retained; a rejection clears the pending promise so the next consumer
   * retries rather than inheriting a poisoned read.
   */
  private async controls(): Promise<Controls> {
    if (this.controlsCache !== null) return this.controlsCache;
    if (this.controlsPending === null) {
      this.controlsPending = this.readControls().then(
        (flags) => {
          this.controlsCache = flags;
          this.controlsPending = null;
          return flags;
        },
        (err) => {
          this.controlsPending = null;
          throw err;
        },
      );
    }
    return await this.controlsPending;
  }

  /**
   * The two flags as storage holds them, normalised off outside staging.
   *
   * The read is issued whatever the environment, so the cost is the same one
   * storage read per instance everywhere and the production budget is a figure
   * that does not move; what changes outside staging is that nothing storage
   * holds can turn either flag on.
   */
  private async readControls(): Promise<Controls> {
    const values = await this.storage().get<unknown>(
      [DIAG_RECORD_KEY, DIAG_HOLD_KEY],
      { noCache: true },
    );
    if (this.environment !== "staging") return { recording: false, held: false };
    return {
      recording: values.get(DIAG_RECORD_KEY) === true,
      held: values.get(DIAG_HOLD_KEY) === true,
    };
  }

  /**
   * Bind the two afterTransaction handlers to the current Y.Doc. Both close
   * over the doc they were built against, so every path that replaces
   * `this.ydoc` — the constructor and `/reset` — has to call this or the new
   * document runs unenforced and untracked for the rest of the DO's life.
   */
  private attachDocHandlers(): void {
    // Server-side canDelete enforcement, FIRST of the two handlers, and the
    // order is a constraint rather than a preference. Both are called in
    // registration order on the same synchronous emitter, and the guard's
    // revert is a transaction of its own whose mutations land immediately. So
    // the accumulator below runs against the CORRECTED document: it reads
    // entity ids from the live types, and a refused `_id` that came in bundled
    // with a legitimate edit therefore resolves to the row that exists rather
    // than to the planted one. It is also what lets the guard's refusal marks
    // be there to be honoured — the accumulator walks the original
    // transaction's change set, which still names every key the guard put
    // back, and credits nobody for a marked one.
    //
    // F1 holds across the pair: nothing here awaits, and the guard's
    // `noteRevert` only sets a flag the message handler reads in the same
    // continuation.
    this.ydoc.on("afterTransaction", makeCanDeleteHandler({
      ydoc: this.ydoc,
      isSnapshotting: () => this.isSnapshotting,
      isReverting: () => this.isReverting,
      setReverting: (v) => { this.isReverting = v; },
      getSockets: () => this.ctx.getWebSockets(),
      // The correction is QUEUED, one entry per connected socket, and the
      // message handler's drain is what sends it: a message that leaves the
      // object from inside `afterTransaction` is past the output gate before
      // the write that would justify it, and a halt cannot take it back. The
      // attempt is complete once this loop returns, which is what `noteRevert`
      // reads; it says nothing about who received anything, and a recipient
      // that has gone is skipped at the drain, one socket at a time.
      broadcastUpdate: (msg) => {
        for (const client of this.ctx.getWebSockets()) {
          this.stagedEffects.sends.push({ ws: client, msg });
        }
      },
      closeSocket: (ws, code, reason) => {
        this.stagedEffects.closes.push({ ws, code, reason });
      },
      recordViolation: (ws) => this.recordViolation(ws),
      onEnforcementFailure: ({ userId, failures }) => {
        this.haltOnEnforcementFailure(userId, failures);
      },
      noteRevert: () => { this.revertedThisMessage = true; },
      noteDisplacement: (ranges) => { this.displacements.record(ranges); },
    }));

    // Field-path accumulator, SECOND. Uses the WebSocket reference in tr.origin
    // (set by the apply) to recover the userId via socket attachment.
    // Independent of the guard in what it reads — the guard walks tr.deleteSet,
    // this walks tr.changed — and dependent on it only for the marks named
    // above.
    //
    // The gate at its entry is what the ORDER above makes necessary: the guard
    // runs first and its failure callback enters the halt, which abandons every
    // pending credit; crediting this same transaction afterwards would put back
    // exactly what was abandoned. A failed message and a halted instance both
    // earn nobody anything.
    const accumulate = makeAfterTransactionHandler(
      this.ydoc,
      this.userFieldSets,
      (origin: unknown) => getUserContext(origin)?.userId ?? null,
      this.lastEditAt,
      undefined,
      this.editsByPath,
      { ledger: this.timeLedger, words: this.wordsByRow, baseline: this.wordBaseline },
    );
    this.ydoc.on("afterTransaction", (tr: Y.Transaction) => {
      if (this.messageFailed || this.persistenceHalted !== null) return;
      accumulate(tr);
    });

    // The custom-field fold, FOURTH. An object's `extra_columns` written whole
    // (a browser on the previous bundle, a sync ingest) is folded into its map
    // in the same turn, so an edit made after it comes after the fold in
    // document order and is not overwritten by it, and a column it adds has an
    // empty entry on every object before anyone can type into it. Not while
    // the document is restored (`logSuppressed`): the log replays a message's
    // payload and then the fold it caused as separate records, and folding the
    // payload again would write its text a second time.
    this.ydoc.on("afterTransaction", (tr: Y.Transaction) => {
      if (this.logSuppressed || this.messageFailed || this.persistenceHalted !== null) return;
      if (changesCustomBlob(tr, this.ydoc.getArray("objects"))) this.foldOnArrival();
    });

    // The log's writer, THIRD, and after both of the above by construction:
    // Yjs emits `update` once a transaction's cleanup has run, so the bytes a
    // listener sees carry whatever the guard corrected inside that transaction,
    // and a transaction the guard opened of its own is emitted after it. During
    // a message every non-socket transaction is buffered into the message's
    // group; outside one, each is a record of its own.
    this.ydoc.on("update", (update: Uint8Array, origin: unknown) => {
      this.recordUpdate(update, origin);
    });
  }

  /**
   * Route one integrated transaction to the log.
   *
   * Inside a message scope EVERY non-socket transaction belongs to the
   * message's group, in the order Yjs emitted it: the guard's revert under
   * `REVERT_ORIGIN`, Yjs's own formatting cleanup after a remote formatted-text
   * change, and the `cleanup` transaction a snapshot read opens, whose own
   * cleanup Yjs defers — so when the guard reads text under a snapshot to
   * decide, that transaction is emitted after the revert has landed and its
   * update carries the revert's structs. Which of the emitted updates are
   * redundant with each other is not decidable here, and applying one twice on
   * replay is a no-op, so every one of them is kept rather than filtered. A
   * socket-origin transaction is not recorded, because the raw payload the
   * handler logs stands for it.
   *
   * Outside a scope every non-socket transaction is a record of its own. A
   * socket-origin one cannot occur — the fences admit sockets only through the
   * message handler — and if one did it is not logged, and one line says so.
   */
  private recordUpdate(update: Uint8Array, origin: unknown): void {
    const group = this.messageGroup;
    if (group !== null) {
      if (!isSocketOrigin(origin)) group.captured.push(update);
      return;
    }
    if (isSocketOrigin(origin)) {
      console.error(
        `[persistence][unlogged] project ${this.projectId}: a socket-origin transaction ` +
        `reached the document outside a message and is not in the log`,
      );
      return;
    }
    this.writeRecordNow(update);
  }

  /**
   * Write one DO-origin or null-origin transaction as its own record, and arm
   * the alarm behind it.
   *
   * One record per transaction, with no promise about how many durable commits
   * the runtime makes of them: a put can resolve through the cache before it is
   * durable, and writes coalesce across awaits. What the platform guarantees is
   * that nothing leaves the object before the writes it initiated are durable,
   * and that is what this relies on.
   *
   * A suppressed phase writes nothing — the base, every replay, a cold build
   * before its initial write lands and a reset's rebuild before its replacement
   * does are the document being restored rather than changed — and a halted
   * document writes nothing at all. A generation is always known while
   * suppression is off; the branch that says so writes nothing rather than
   * guessing one.
   *
   * A record that cannot be encoded or issued is `group_discarded`: the
   * document holds a change the log cannot hold. The halt is LATCHED and this
   * returns, because a throw cannot roll back a mutation Yjs has already
   * integrated and some callers' catches would swallow it and continue; every
   * caller checks the latch through `refusePastHalt` before it persists
   * anything further.
   */
  private writeRecordNow(update: Uint8Array): void {
    if (this.logSuppressed || this.persistenceHalted !== null) return;
    const generation = this.docGeneration;
    if (generation === null) {
      console.error(
        `[persistence][unlogged] project ${this.projectId}: a transaction reached an ` +
        `unsuppressed document with no generation and is not in the log`,
      );
      return;
    }
    const held = this.docSeq;
    try {
      if (!isBaseSeq(held) || held >= MAX_SEQ) {
        throw new RangeError(`sequence ${String(held)} has no room for another record`);
      }
      const seq = held + 1;
      // Un-awaited, as the message path's group is: the output gate holds every
      // message initiated while the write is pending, and a failed write resets
      // the object and discards what was gated behind it. The rejection is
      // taken so it is not reported as unhandled.
      void writeGroup(
        this.storage() as unknown as LogStorage,
        encodeRecord(logKey(generation, seq), update),
      ).catch(() => { /* the platform's own failure path */ });
      this.docSeq = seq;
      this.noteRecordWritten(seq, update.length);
    } catch (err) {
      this.enterHalt("group_discarded", generation, describeThrown(err));
      return;
    }
    // Every standalone record arms the alarm, so a record written with no
    // socket attached still reaches the maintenance and the compaction the
    // alarm runs. Inside its own `try` for the same reason the halt is latched
    // rather than thrown: this listener runs inside a transaction's cleanup,
    // and an exception escaping it would propagate through a mutation that has
    // already landed. The record is written either way.
    try {
      this.scheduleSnapshot();
    } catch (err) {
      console.error(
        `[persistence] project ${this.projectId}: a record was written and the alarm ` +
        `could not be armed for it — ${describeThrown(err)}`,
      );
    }
  }

  /** Open the log group one inbound message writes. */
  private openMessageGroup(origin: unknown): void {
    this.messageGroup = { origin, captured: [] };
  }

  /**
   * Write everything one accepted message caused as one put group, before the
   * drain lets any of it reach a peer.
   *
   * The raw payload takes the first sequence and each captured update the next,
   * in the order Yjs emitted them. Every record is encoded BEFORE any batch is
   * issued, so a record the codec refuses cannot leave part of a group behind;
   * a revert the guard generated is not bounded by the inbound ceiling and is
   * checked here. The group is then issued un-awaited: the runtime coalesces
   * the puts into one atomic commit, and its output gate holds the drain's
   * sends, the response and the relay until the group is durable.
   *
   * A failure to encode or to issue is `group_discarded`: the document holds an
   * applied update the log cannot hold, so `docSeq` does not advance and the
   * message takes the failed path through the drain. A synchronous throw from a
   * LATER batch of a multi-batch group is the same case, with the halt marker's
   * own put still succeeding after it.
   */
  private commitMessageGroup(generation: number, payload: Uint8Array): void {
    const captured = this.messageGroup?.captured ?? [];
    const count = captured.length + 1;
    const held = this.docSeq;
    try {
      if (!isBaseSeq(held) || held + count > MAX_SEQ) {
        throw new RangeError(`sequence ${String(held)} has no room for ${count} records`);
      }
      const group: Record<string, unknown> = {};
      const written: Array<{ seq: number; bytes: number }> = [];
      let seq = held;
      for (const bytes of [payload, ...captured]) {
        seq += 1;
        Object.assign(group, encodeRecord(logKey(generation, seq), bytes));
        written.push({ seq, bytes: bytes.length });
      }
      void writeGroup(this.storage() as unknown as LogStorage, group)
        .catch(() => { /* the platform's own failure path */ });
      this.docSeq = seq;
      // After the issue, never beside the encoding: a group the codec refused
      // is not in the log, and the tail the accounting describes is the log's.
      for (const record of written) this.noteRecordWritten(record.seq, record.bytes);
    } catch (err) {
      this.enterHalt("group_discarded", generation, describeThrown(err));
    }
  }

  /**
   * Count one record of the logical replay tail above the exact base.
   *
   * The payload's own length, not the storage the record occupies: what the
   * accounting bounds is the replay a load would have to run, and orphan parts,
   * malformed keys and the codec's own headers are outside it.
   *
   * The list is stated once when it passes its size, and never trimmed for it:
   * a base that has not moved still stands under every entry, and dropping one
   * would leave the byte count describing a tail that is not the log's.
   */
  private noteRecordWritten(seq: number, bytes: number): void {
    this.logBytes.push({ seq, bytes });
    this.logBytesSinceBase += bytes;
    if (this.logBytes.length < ACCOUNTING_LINE_AT || this.accountingStated) return;
    this.accountingStated = true;
    console.error(
      `[persistence][accounting] project ${this.projectId}: ${this.logBytes.length} records ` +
      `stand above the exact base at sequence ${String(this.baseSeq)}; neither a snapshot nor ` +
      `a compaction has moved it`,
    );
  }

  /**
   * Move the exact base to `seq` and drop what the base at `seq` subsumes.
   *
   * Entries at or below the new base are folded into it; those above it are the
   * tail a load would still replay and are kept, which is why the list is pairs
   * rather than a total — a record written after a snapshot's encoding stands
   * above the sequence that snapshot carried.
   */
  private trimAccounting(seq: number): void {
    this.baseSeq = seq;
    const above = this.logBytes.filter((record) => record.seq > seq);
    this.logBytes = above;
    this.logBytesSinceBase = above.reduce((sum, record) => sum + record.bytes, 0);
  }

  /**
   * Whether the log above the exact base has passed either threshold.
   *
   * Only an open document can carry debt: the count is measured from a base
   * this instance selected, and an unloaded instance has selected none. The
   * record count is `docSeq − baseSeq`, an upper bound under the writers'
   * contiguous-sequence invariant and exact while it holds.
   */
  /** Set the exact base's sequence and empty the tail measured above it. */
  private openAccounting(seq: number): void {
    this.baseSeq = seq;
    this.logBytes = [];
    this.logBytesSinceBase = 0;
  }

  private thresholdDebt(): boolean {
    if (!this.docLoaded || this.persistenceHalted !== null) return false;
    const base = this.baseSeq;
    const seq = this.docSeq;
    if (!isBaseSeq(base) || !isBaseSeq(seq)) return false;
    return seq - base >= this.compactionPolicy.records
      || this.logBytesSinceBase >= this.compactionPolicy.bytes;
  }

  /**
   * Refuse an inbound update the log could not hold, before it is applied.
   *
   * An update above the codec's ceiling cannot be logged, and an update that
   * cannot be logged must not be applied. Nothing about the document changes,
   * so this is not a halt and writes no marker; the socket is told with the
   * protocol's own code for a message too large, and the next message from
   * another socket is accepted as usual.
   */
  private refuseOversizedUpdate(ws: WebSocket, length: number): void {
    this.messageFailed = true;
    console.error(
      `[persistence][refused] project ${this.projectId}: a sync update of ${length} bytes ` +
      `is above the ${MAX_RECORD_BYTES}-byte record ceiling and was not applied`,
    );
    closeSocket(ws, OVERSIZED_UPDATE_CLOSE);
  }

  /**
   * Stop before any further persistence when the log's writer latched a halt.
   *
   * The property this keeps: a document mutation whose record could not be
   * written is never followed by a blob write or an entity batch that persists
   * it. The INSERT that preceded a failed `_id` backfill has already landed,
   * and the next load's replay of the earlier records plus the resident halt is
   * what the reset recovers from.
   */
  private refusePastHalt(): void {
    const halt = this.persistenceHalted;
    if (halt === null) return;
    throw new PersistenceHaltedError(this.projectId, halt.generation, halt.marker);
  }

  /**
   * Halt on a revert enforcement could not complete, under the generation this
   * instance serves.
   *
   * A guard failure only ever reaches here from a socket-origin transaction,
   * and the message fence has already compared that socket against a cached
   * generation, so the document is open and its generation known. The other
   * branch states that rather than halting a generation this instance never
   * validated: it fails the message and abandons what it had accrued, which is
   * what a halt would have done in memory, and writes no marker.
   */
  private haltOnEnforcementFailure(userId: number, failures: readonly string[]): void {
    const detail =
      `delete enforcement could not be applied for user ${userId}, so the document holds ` +
      `a refused deletion — ${failures.join("; ")}`;
    const generation = this.docGeneration;
    if (generation === null) {
      this.messageFailed = true;
      this.abandonAttribution();
      console.error(
        `[persistence][halted] project ${this.projectId}: no generation is known, so no ` +
        `marker was written — ${detail}`,
      );
      return;
    }
    this.enterHalt("enforcement_failed", generation, detail);
  }

  /**
   * The document generation this DO is serving, or null when storage could not
   * answer. Read through once per instance and cached, so the socket handshake
   * pays at most one storage read per cold start.
   *
   * A storage failure is reported as null rather than as 0, and every caller
   * stands down on null: the upgrade is refused with a 503, the wake path
   * closes its sockets without loading, a message applies nothing, and
   * `/reset` refuses to run. An unknown generation reported as 0 would refuse
   * the very editors it is meant to protect — a client synced at generation 1
   * would be told to discard a perfectly good document, losing whatever it had
   * queued offline — and would let `/reset` renumber a generation-3 document
   * back to 1, readmitting two generations of stale documents. Standing down
   * is a refusal the client retries, never a guess: no reset frame is sent for
   * a generation the object does not know.
   */
  private async getDocGeneration(): Promise<number | null> {
    if (this.docGeneration !== null) return this.docGeneration;
    try {
      const stored = await this.storage().get<unknown>(DOC_GENERATION_KEY);
      // An ABSENT KEY is 0 — never reset. Every other value that is not a safe
      // non-negative integer, a stored `null` included, is a value nothing here
      // wrote: `null` is not absence, and coercing either to 0 would readmit
      // every generation of stale document at once, so it is reported as
      // unanswerable and repaired by hand.
      if (stored === undefined) this.docGeneration = 0;
      else if (isSafeCount(stored)) this.docGeneration = stored;
      else {
        console.error(
          `[reset] project ${this.projectId}: generation is not a generation; the document ` +
          `is unavailable until it is repaired by hand`,
        );
        return null;
      }
    } catch (err) {
      console.error(
        `[reset] project ${this.projectId}: generation read failed; the document is ` +
        `unavailable until it can be read`,
        err,
      );
      return null;
    }
    return this.docGeneration;
  }

  /**
   * Close every attached socket that was not admitted under the generation
   * this instance is waking into, and report whether the document may be
   * loaded at all.
   *
   * The generation read is retried once: a single transient storage failure
   * on a wake would otherwise cost every hibernated editor its session. When
   * it still cannot be read there is nothing to compare an attachment
   * against, so every socket is closed with the try-again code and the
   * document is left unloaded for the next `ensureDocLoaded` to build.
   */
  private async closeSocketsFromOtherGenerations(): Promise<boolean> {
    const generation = (await this.getDocGeneration()) ?? (await this.getDocGeneration());
    if (generation === null) {
      for (const ws of this.ctx.getWebSockets()) closeSocket(ws, UNKNOWN_GENERATION_CLOSE);
      return false;
    }
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as SocketAttachment | null;
      if (!attachedToGeneration(attachment, generation)) {
        closeSocket(ws, STALE_GENERATION_CLOSE);
      }
    }
    return true;
  }

  /**
   * Whether `ws` may act on the document this instance holds right now.
   *
   * Synchronous by construction, and it reads the cached generation rather
   * than storage: the answer has to be the one that still holds at the apply,
   * and an await between the check and the apply would let a resident `/reset`
   * rebuild the document underneath it. A socket that fails the check is
   * closed and told nothing about the document — the reset frame belongs to
   * the paths that know the generation, and a socket refused for an unreadable
   * one is asked to come back rather than to discard what it holds.
   */
  private socketMayReachDocument(ws: WebSocket): number | null {
    const generation = this.docGeneration;
    if (generation === null) {
      closeSocket(ws, UNKNOWN_GENERATION_CLOSE);
      return null;
    }
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (!attachedToGeneration(attachment, generation)) {
      closeSocket(ws, STALE_GENERATION_CLOSE);
      return null;
    }
    return generation;
  }

  /**
   * The 101 that answers a client holding a document from before a reset: the
   * session-control reset frame, so the client discards what it holds, then a
   * close. A temporary socket carries it because there is no other channel to
   * a client that has not been admitted.
   */
  private refuseStaleGeneration(projectId: number, documentGeneration: number, claimed: string | null): Response {
    const [staleClient, staleServer] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(staleServer);
    const staleEncoder = encoding.createEncoder();
    encoding.writeVarUint(staleEncoder, messageSessionControl);
    encoding.writeUint8(staleEncoder, subStateReset);
    encoding.writeVarUint(staleEncoder, documentGeneration);
    try { staleServer.send(encoding.toUint8Array(staleEncoder)); } catch { /* already gone */ }
    closeSocket(staleServer, STALE_GENERATION_CLOSE);
    console.warn(
      `[reset] project ${projectId}: refused a socket holding generation ` +
      `${claimed ?? "(none)"}; the document is at ${documentGeneration}`,
    );
    return new Response(null, { status: 101, webSocket: staleClient });
  }

  // -------------------------------------------------------------------------
  // Awareness ownership
  // -------------------------------------------------------------------------

  /**
   * Bind `id` to the socket whose attachment is `attachment`, and say whether
   * it was bound. The caller serialises the attachment.
   *
   * An id another live socket holds is taken over when both belong to the
   * same user: y-websocket reconnects with the client id it already had, and
   * the socket it left can still be registered when the new one arrives. The
   * older socket loses the id and is refused from then on, so neither a late
   * message nor its close can touch what its successor set — without the
   * refusal, its next update would bind the id straight back through the
   * first-entry fallback. Held by a different user, the bind is refused, and nothing this
   * socket sends to awareness is applied from then on — Yjs draws client ids
   * at random from 32 bits, so two users do not arrive at one by accident.
   */
  private claimAwarenessClientId(ws: WebSocket, attachment: SocketAttachment, id: number): boolean {
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      const held = other.deserializeAttachment() as SocketAttachment | null;
      if (held?.awarenessClientId !== id) continue;
      if (held.userId !== attachment.userId) {
        attachment.awarenessRefused = true;
        console.warn(
          `[awareness] project ${attachment.projectId}: user ${attachment.userId} declared ` +
          `an awareness client id held by user ${held.userId}; its awareness is dropped`,
        );
        return false;
      }
      delete held.awarenessClientId;
      delete held.awarenessUpdate;
      delete held.awarenessUpdatedAt;
      held.awarenessRefused = true;
      other.serializeAttachment(held);
    }
    attachment.awarenessClientId = id;
    return true;
  }

  /**
   * The part of `update` this socket may apply, re-encoded, or null for none.
   *
   * A socket that declared no id at admission binds the id its first update
   * names, under the same rule as a declared one, so a page loaded before
   * the declaration existed keeps its presence.
   */
  private ownAwarenessUpdate(ws: WebSocket, update: Uint8Array): Uint8Array | null {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (!attachment || attachment.awarenessRefused) return null;
    if (attachment.awarenessClientId === undefined) {
      const first = firstAwarenessClientId(update);
      if (first === null) return null;
      const bound = this.claimAwarenessClientId(ws, attachment, first);
      ws.serializeAttachment(attachment);
      if (!bound) return null;
    }
    return ownAwarenessEntries(update, attachment.awarenessClientId!);
  }

  /**
   * Keep the entry the awareness now holds for `ws`'s own client id in the
   * socket's attachment, with the time it was last updated, so a wake can
   * rebuild it at its real age; see `restoreAwareness`. Called after the
   * socket's update was applied, so what is kept is what the awareness
   * accepted. The whole attachment is written back, every other field as it
   * was read. A removed entry, or one too large to keep, drops whatever was
   * kept before it, so a wake never restores an entry the object no longer
   * holds as it was.
   */
  private keepAwarenessUpdate(ws: WebSocket): void {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (!attachment || attachment.awarenessRefused || attachment.awarenessClientId === undefined) return;
    const held = heldAwarenessEntry(this.awareness, attachment.awarenessClientId);
    if (held === null || held.update.byteLength > MAX_STORED_AWARENESS_BYTES) {
      delete attachment.awarenessUpdate;
      delete attachment.awarenessUpdatedAt;
    } else {
      attachment.awarenessUpdate = held.update;
      attachment.awarenessUpdatedAt = held.updatedAt;
    }
    ws.serializeAttachment(attachment);
  }

  /**
   * Rebuild the awareness from the updates the open sockets' attachments keep,
   * so the entries it held before a hibernation are there after it and a
   * socket admitted after the wake is sent them.
   *
   * The caller runs it after the wake's fence and load, so the generation is
   * known and every socket of another one has been closed. A socket whose
   * close is what woke the object is not listed here; `webSocketClose`
   * restores its entry itself before removing it. The sweep afterwards
   * removes what `keptAwarenessEntry` kept past the entry's own limit.
   */
  private restoreAwareness(): void {
    for (const ws of this.ctx.getWebSockets()) {
      this.restoreSocketAwareness(ws, ws.deserializeAttachment() as SocketAttachment | null);
    }
    sweepOutdatedPresence(this.awareness, Date.now());
  }

  /**
   * Apply the entry `attachment` keeps, when the socket was admitted under
   * the generation this instance serves, the entry is still inside the
   * longest presence limit (see `keptAwarenessEntry`), and the awareness holds no
   * entry for the id yet. The generation is checked here rather than trusted
   * to the caller, so no path restores an entry from a document that is gone.
   *
   * The restored entry carries the time it was kept, not the time of the
   * wake: an entry whose client stopped renewing ages out at the connect-time
   * sweep as it would have without the hibernation, and a wake never makes it
   * fresh again. An update that does not apply costs only that socket's
   * entry, which it renews on its own.
   */
  private restoreSocketAwareness(ws: WebSocket, attachment: SocketAttachment | null): void {
    const generation = this.docGeneration;
    if (generation === null || !attachedToGeneration(attachment, generation)) return;
    const kept = keptAwarenessEntry(attachment!, Date.now());
    // An entry the awareness already holds is at least as new as the one kept.
    if (kept === null || this.awareness.meta.has(kept.clientId)) return;
    try {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, kept.update, ws);
      const meta = this.awareness.meta.get(kept.clientId);
      if (meta !== undefined) meta.lastUpdated = kept.updatedAt;
    } catch (err) {
      console.warn(
        `[awareness] project ${this.projectId}: a kept awareness update did not apply on wake`,
        err,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Freeze leases
  // -------------------------------------------------------------------------

  /** The stored lease state; throws when storage cannot answer. */
  private async readLeaseState(): Promise<LeaseState> {
    return (await this.storage().get<LeaseState>(FREEZE_LEASE_KEY)) ?? EMPTY_LEASE_STATE;
  }

  /**
   * The stored lease state, or none when storage cannot answer. For the
   * admission frame only: an editor is not refused because the freeze could
   * not be read, and the next change reaches it in full.
   */
  private async readLeaseStateOrEmpty(): Promise<LeaseState> {
    try {
      return await this.readLeaseState();
    } catch (err) {
      console.error(`[freeze] project ${this.projectId}: the leases could not be read`, err);
      return EMPTY_LEASE_STATE;
    }
  }

  private freezeFrameBytes(state: LeaseState): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSessionControl);
    encoding.writeUint8(encoder, subFreeze);
    encoding.writeVarString(encoder, JSON.stringify(leaseFrame(state, Date.now())));
    return encoding.toUint8Array(encoder);
  }

  /**
   * The handler for a POST route whose whole handling lives in one method, or
   * null for any other request:
   *
   *   - /freeze starts, renews or ends a freeze lease (handleFreeze);
   *   - /remove-story-column removes a kept column from a story's steps
   *     (handleRemoveStoryColumn);
   *   - /remove-table-column removes a custom column from every object or
   *     glossary term (handleRemoveTableColumn);
   *   - /reset-page-frontmatter keeps only a page's title
   *     (handleResetPageFrontmatter);
   *   - /enrich-objects fills external objects from their manifests
   *     (handleEnrichObjects).
   */
  private postHandlerFor(url: URL, request: Request): (() => Promise<Response>) | null {
    if (request.method !== "POST") return null;
    if (url.pathname.endsWith("/freeze")) return () => this.handleFreeze(request, url);
    if (url.pathname.endsWith("/remove-story-column")) {
      return () => this.handleRemoveStoryColumn(request, url);
    }
    if (url.pathname.endsWith("/remove-table-column")) {
      return () => this.handleRemoveTableColumn(request, url);
    }
    if (url.pathname.endsWith("/reset-page-frontmatter")) {
      return () => this.handleResetPageFrontmatter(request, url);
    }
    if (url.pathname.endsWith("/enrich-objects")) return () => this.handleEnrichObjects(request);
    return null;
  }

  /**
   * POST /enrich-objects — fill each external object whose thumbnail is empty
   * from its IIIF manifest, and answer how many objects were written.
   *
   * The request names nothing: the objects are chosen from this document, so
   * a caller cannot point the read at a URL of its own. The manifests are read
   * between two gates, never inside one, since a gate held across the network
   * would stall every socket. The second gate loads the document again and
   * checks the halt again, because a reset can land while the reads are out;
   * the fill then checks each object's source in the same transaction as it
   * writes (`fillFromManifests`). The change reaches D1 through the log and the
   * next snapshot, as any edit does.
   */
  private async handleEnrichObjects(request: Request): Promise<Response> {
    const markerError = await verifyInternalMarker(request, this.env.SESSION_SECRET, "enrich-objects");
    if (markerError) return markerError;
    const bindError = await this.bindProjectIdFromMarker(request);
    if (bindError) return bindError;

    const scan = await this.underLoadedGate("enrich-objects", () => enrichmentCandidates(this.ydoc));
    if (scan.halted) return this.answerHalted();
    const claimed = claimCandidates(scan.value ?? [], this.manifestsInFlight);
    try {
      const manifests = await readManifests(claimed);
      const fill = await this.underLoadedGate("enrich-objects", () => this.fillAndRebaseline(manifests));
      if (fill.halted || this.persistenceHalted !== null) return this.answerHalted();
      const filled = fill.value ?? 0;
      if (filled > 0) this.broadcastDocument();
      return Response.json({ filled });
    } finally {
      releaseCandidates(claimed, this.manifestsInFlight);
    }
  }

  /**
   * Fills the objects from their manifests, and sets the word baseline of each
   * prose field filled to what it now holds: the fill credits nobody, and the
   * next person to edit the field is credited only with the words they add.
   */
  private fillAndRebaseline(manifests: readonly ReadManifest[]): number {
    const filled = fillFromManifests(this.ydoc, manifests);
    for (const { id, entry, fields } of filled) {
      for (const field of fields) {
        this.wordBaseline.set(`objects:${renderedValue(id)}:${field}`, countWords(yTextToString(entry.get(field))));
      }
    }
    return filled.length;
  }

  /**
   * Runs `run` under the gate, on the loaded document, unless persistence is
   * halted. A load or a run that throws answers no value, and is caught inside
   * the gate because a throw escaping it discards the object.
   */
  private async underLoadedGate<T>(label: string, run: () => T): Promise<{ halted: boolean; value: T | null }> {
    const outcome: { halted: boolean; value: T | null } = { halted: false, value: null };
    await this.ctx.blockConcurrencyWhile(async () => {
      try {
        await this.ensureDocLoaded();
        if (this.persistenceHalted !== null) {
          outcome.halted = true;
          return;
        }
        outcome.value = run();
      } catch (err) {
        if (!isNamedPersistenceRefusal(err)) console.error(`[${label}] project ${this.projectId}: threw`, err);
      }
    });
    return outcome;
  }

  /**
   * POST /remove-story-column?story=<story_id>&column=<header> — remove one
   * kept column from `extra_columns` on every step of a story, then flush a
   * snapshot BEFORE answering.
   *
   * The publish page's control calls this through its action, which then
   * reads D1 for the checks. The removal is a document change rather than a D1
   * write, because the snapshot rebuilds D1 from the document; and it is made
   * here rather than by the page's own client, because an ordinary client
   * update is never acknowledged, so the page could not know when the
   * snapshot would include it. A 200 means D1 agrees with the document.
   *
   * The story and column are bound into the marker's signature (as its
   * detail), so the request cannot be replayed against another column.
   */
  private async handleRemoveStoryColumn(request: Request, url: URL): Promise<Response> {
    const target = await this.authorisedStoryColumn(request, url);
    if (target instanceof Response) return target;

    await this.drainSnapshot();
    const outcome = await this.removeStoryColumnAndFlush(target.storyId, target.column);
    if (outcome.halted || this.persistenceHalted !== null) return this.answerHalted();
    // The change is in the document either way, so the peers are told.
    this.broadcastDocument();
    if (!outcome.flushed) return new Response("snapshot_blocked", { status: 503 });
    return Response.json({ removed: outcome.removed });
  }

  /**
   * The story and column a /remove-story-column request names, once its
   * marker is verified against them and the project is bound; otherwise the
   * refusal to answer with.
   */
  private async authorisedStoryColumn(
    request: Request,
    url: URL,
  ): Promise<{ storyId: string; column: string } | Response> {
    const storyId = url.searchParams.get("story") ?? "";
    const column = url.searchParams.get("column") ?? "";
    if (storyId === "" || column === "") return new Response("Invalid story column", { status: 400 });
    const markerError = await verifyInternalMarker(
      request,
      this.env.SESSION_SECRET,
      "remove-story-column",
      undefined,
      30,
      storyColumnDetail(storyId, column),
    );
    if (markerError) return markerError;
    const bindError = await this.bindProjectIdFromMarker(request);
    return bindError ?? { storyId, column };
  }

  /**
   * POST /remove-table-column?table=objects|glossary&column=<header> — remove
   * one custom column from every row of the table, then answer once D1 agrees.
   *
   * Objects hold the column in the document, so it is removed there and a
   * snapshot is flushed before the answer, as /remove-story-column does.
   * Glossary terms never carry it in the document: the snapshot's UPDATE omits
   * it and a re-INSERT copies it from the surviving D1 row, so D1 is the one
   * place it lives and is written here, under the same gate a snapshot runs in.
   * The table and column are bound into the marker's signature.
   */
  private async handleRemoveTableColumn(request: Request, url: URL): Promise<Response> {
    const table = url.searchParams.get("table") ?? "";
    const column = url.searchParams.get("column") ?? "";
    if ((table !== "objects" && table !== "glossary") || column === "") {
      return new Response("Invalid table column", { status: 400 });
    }
    const markerError = await verifyInternalMarker(
      request, this.env.SESSION_SECRET, "remove-table-column", undefined, 30, tableColumnDetail(table, column),
    );
    if (markerError) return markerError;
    const bindError = await this.bindProjectIdFromMarker(request);
    if (bindError) return bindError;

    await this.drainSnapshot();
    const outcome = { removed: 0, flushed: false, halted: false };
    await this.ctx.blockConcurrencyWhile(async () => {
      try {
        await this.ensureDocLoaded();
        if (this.persistenceHalted !== null) {
          outcome.halted = true;
          return;
        }
        if (table === "objects") {
          outcome.removed = removeObjectColumn(this.ydoc, column);
          outcome.flushed = await this.flushSnapshotNow();
        } else {
          outcome.removed = await this.removeGlossaryColumn(column);
          outcome.flushed = true;
        }
      } catch (err) {
        if (!isNamedPersistenceRefusal(err)) {
          console.error(`[remove-table-column] project ${this.projectId}: removal threw`, err);
        }
      }
    });
    if (outcome.halted || this.persistenceHalted !== null) return this.answerHalted();
    if (table === "objects") this.broadcastDocument();
    if (!outcome.flushed) return new Response("snapshot_blocked", { status: 503 });
    return Response.json({ removed: outcome.removed });
  }

  /** Takes `column` out of every glossary term's `extra_columns` in D1; returns the terms changed. */
  private async removeGlossaryColumn(column: string): Promise<number> {
    const rows = await this.env.DB
      .prepare("SELECT id, extra_columns FROM glossary_terms WHERE project_id = ? AND extra_columns IS NOT NULL")
      .bind(this.projectId)
      .all<{ id: number; extra_columns: string }>();
    const writes = rows.results.flatMap((row) => {
      const next = withoutColumns(row.extra_columns, [column]);
      return next === null
        ? []
        : [this.env.DB.prepare("UPDATE glossary_terms SET extra_columns = ? WHERE id = ?").bind(next, row.id)];
    });
    if (writes.length > 0) await this.env.DB.batch(writes);
    return writes.length;
  }

  /**
   * POST /reset-page-frontmatter?slug=<slug> — set the page's `frontmatter` to
   * `""`, which publishes it with its title alone, then flush a snapshot
   * BEFORE answering.
   *
   * The publish page's control calls this through its action, which then
   * reads D1 for the checks. The reset is a document change rather than a D1
   * write, because the snapshot rebuilds D1 from the document; and it is made
   * here rather than by the page's own client, because an ordinary client
   * update is never acknowledged, so the page could not know when the
   * snapshot would include it. A 200 means D1 agrees with the document.
   *
   * The slug is bound into the marker's signature (as its detail), so the
   * request cannot be replayed against another page.
   */
  private async handleResetPageFrontmatter(request: Request, url: URL): Promise<Response> {
    const slug = await this.authorisedPageSlug(request, url);
    if (slug instanceof Response) return slug;

    await this.drainSnapshot();
    const outcome = await this.resetPageFrontmatterAndFlush(slug);
    if (outcome.halted || this.persistenceHalted !== null) return this.answerHalted();
    // The change is in the document either way, so the peers are told.
    this.broadcastDocument();
    if (!outcome.flushed) return new Response("snapshot_blocked", { status: 503 });
    return Response.json({ reset: outcome.reset });
  }

  /**
   * The slug a /reset-page-frontmatter request names, once its marker is
   * verified against it and the project is bound; otherwise the refusal to
   * answer with.
   */
  private async authorisedPageSlug(request: Request, url: URL): Promise<string | Response> {
    const slug = url.searchParams.get("slug") ?? "";
    if (slug === "") return new Response("Invalid page slug", { status: 400 });
    const markerError = await verifyInternalMarker(
      request,
      this.env.SESSION_SECRET,
      "reset-page-frontmatter",
      undefined,
      30,
      slug,
    );
    if (markerError) return markerError;
    const bindError = await this.bindProjectIdFromMarker(request);
    return bindError ?? slug;
  }
  /**
   * The reset and its flush, under the gate. A thrown flush lands in the same
   * unflushed answer a blocked one does, and is caught inside the gate because
   * a throw escaping it discards the object with the change in it.
   */
  private async resetPageFrontmatterAndFlush(
    slug: string,
  ): Promise<{ reset: number; flushed: boolean; halted: boolean }> {
    const outcome = { reset: 0, flushed: false, halted: false };
    await this.ctx.blockConcurrencyWhile(async () => {
      try {
        await this.ensureDocLoaded();
        if (this.persistenceHalted !== null) {
          outcome.halted = true;
          return;
        }
        outcome.reset = resetPageFrontmatter(this.ydoc, slug);
        outcome.flushed = await this.flushSnapshotNow();
      } catch (err) {
        if (!isNamedPersistenceRefusal(err)) {
          console.error(`[reset-page-frontmatter] project ${this.projectId}: flush threw`, err);
        }
      }
    });
    return outcome;
  }

  /**
   * Wait, bounded, for an in-flight snapshot to finish. Outside the gate, for
   * the reason /clear-course-markers gives: inside it the snapshot's own D1
   * responses are blocked, so the flag could never be seen to clear.
   */
  private async drainSnapshot(): Promise<void> {
    for (let i = 0; this.isSnapshotting && i < SNAPSHOT_DRAIN_MAX_POLLS; i++) {
      await new Promise((r) => setTimeout(r, SNAPSHOT_DRAIN_POLL_MS));
    }
  }

  /**
   * The removal and its flush, under the gate. A thrown flush lands in the
   * same unflushed answer a blocked one does, and is caught inside the gate
   * because a throw escaping it discards the object with the change in it.
   */
  private async removeStoryColumnAndFlush(
    storyId: string,
    column: string,
  ): Promise<{ removed: number; flushed: boolean; halted: boolean }> {
    const outcome = { removed: 0, flushed: false, halted: false };
    await this.ctx.blockConcurrencyWhile(async () => {
      try {
        await this.ensureDocLoaded();
        if (this.persistenceHalted !== null) {
          outcome.halted = true;
          return;
        }
        outcome.removed = removeStoryColumns(this.ydoc, storyId, [column]);
        outcome.flushed = await this.flushSnapshotNow();
      } catch (err) {
        if (!isNamedPersistenceRefusal(err)) {
          console.error(`[remove-story-column] project ${this.projectId}: flush threw`, err);
        }
      }
    });
    return outcome;
  }

  /** Send every peer the whole document; Yjs merges what they already hold. */
  private broadcastDocument(): void {
    const updateEncoder = encoding.createEncoder();
    encoding.writeVarUint(updateEncoder, messageSync);
    syncProtocol.writeSyncStep2(updateEncoder, this.ydoc);
    const updateMsg = encoding.toUint8Array(updateEncoder);
    for (const client of this.ctx.getWebSockets()) {
      try {
        client.send(updateMsg);
      } catch {
        // Client may have disconnected; ignore.
      }
    }
  }

  /**
   * POST /freeze?control=<text>&userId=<id> — apply one lease control and
   * tell every socket the result.
   *
   * The control text and the user are both bound into the signature, so the
   * action that signed them is the only party that can name either. 409 for
   * a control the table refuses: a begin while another lease is live, which
   * the caller answers by not starting its operation, or a renewal or end of a
   * lease that has run out or that another user holds. 503 when storage cannot
   * answer, which the caller treats as no answer and carries on, since a lease
   * that is never ended expires.
   *
   * The read and the write run inside one gate, so two controls arriving
   * together cannot each apply to the state before the other.
   */
  private async handleFreeze(request: Request, url: URL): Promise<Response> {
    const control = parseLeaseControl(url.searchParams.get("control"));
    const userParam = url.searchParams.get("userId");
    const userId = userParam !== null && /^[1-9][0-9]*$/.test(userParam) ? Number(userParam) : null;
    if (control === null || userId === null) return new Response("bad_control", { status: 400 });
    const markerError = await verifyInternalMarker(
      request,
      this.env.SESSION_SECRET,
      "freeze",
      userId,
      30,
      leaseControlText(control),
    );
    if (markerError) return markerError;

    let next: LeaseState | null = null;
    let failure: unknown;
    await this.ctx.blockConcurrencyWhile(async () => {
      try {
        next = applyLeaseControl(await this.readLeaseState(), control, userId, Date.now());
        if (next !== null) await this.storage().put(FREEZE_LEASE_KEY, next);
      } catch (err) {
        failure = err;
      }
    });
    if (failure !== undefined) {
      console.error(`[freeze] project ${this.projectId}: ${leaseControlText(control)} was not applied`, failure);
      return new Response("freeze_unavailable", { status: 503 });
    }
    if (next === null) return new Response("freeze_refused", { status: 409 });

    const frame = this.freezeFrameBytes(next);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(frame); } catch { /* socket may have disconnected */ }
    }
    return new Response("OK", { status: 200 });
  }

  // -------------------------------------------------------------------------
  // fetch — WebSocket upgrade entry point
  // -------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // HTTP POST /snapshot — forced snapshot before the publish pipeline runs.
    // Called by the publish route action immediately before committing to GitHub.
    // Returns 200 OK only once D1 has actually been flushed; every other outcome
    // is a refusal the publish action fails closed on.
    if (url.pathname.endsWith("/snapshot") && request.method === "POST") {
      // Same signed-marker check as /reset — direct reaches that bypass the
      // worker entry lack the marker and are rejected with 401.
      const markerError = await verifyInternalMarker(request, this.env.SESSION_SECRET, "snapshot");
      if (markerError) return markerError;

      // The instance only ever learns its project id from a live socket
      // attachment, so an evicted one has none — and a null id is a fact about
      // this DO, not about D1. `doSnapshot` writes the `yjs_state` blob
      // standalone and BEFORE its row batch, so a batch that fails leaves the
      // blob ahead of the rows the publish pipeline reads, and evicting the
      // instance does not settle that. Skipping the flush on the null id
      // answered 200 over exactly that divergence, and publish then committed
      // rows the blob had already superseded. Bound from the signed marker,
      // the flush below reloads the document from the blob and reconciles the
      // rows; a flush that cannot run refuses rather than reporting success.
      const bindError = await this.bindProjectIdFromMarker(request);
      if (bindError) return bindError;

      return await this.runForcedSnapshot();
    }

    // POST /freeze and POST /remove-story-column, each handled whole by a
    // method of its own. See postHandlerFor.
    const handler = this.postHandlerFor(url, request);
    if (handler) return await handler();

    // POST /reset — rebuild the document from D1. See handleReset for the
    // preconditions and what it recovers from.
    if (url.pathname.endsWith("/reset") && request.method === "POST") {
      return await this.handleReset(request, url);
    }

    // POST /notify-deleted — broadcast a session-
    // control message to connected clients then close their sockets.
    //
    // No `?userId=` param  → subtype 0x01 (project_deleted) to ALL sockets
    //                        (convenor delete-project: every collaborator
    //                        currently editing must be evicted).
    // With `?userId=N`     → subtype 0x02 (removed_from_project) to ONLY
    //                        the sockets whose attachment.userId === N
    //                        (collaborator-left-from-another-tab variant;
    //                        future "remove collaborator" flows reuse this).
    //
    // Order constraint: the route action MUST run the D1 cascade
    // BEFORE invoking this endpoint so any reconnect attempt fails fast
    // against the missing project_members row (graceful no-op end state).
    if (url.pathname.endsWith("/notify-deleted") && request.method === "POST") {
      const targetUserId = url.searchParams.get("userId");
      const markerError = await verifyInternalMarker(
        request,
        this.env.SESSION_SECRET,
        "notify-deleted",
        targetUserId,
      );
      if (markerError) return markerError;

      const subtype = targetUserId ? subRemovedFromProject : subProjectDeleted;
      const closeReason = targetUserId ? "removed_from_project" : "project_deleted";

      for (const ws of this.ctx.getWebSockets()) {
        const att = ws.deserializeAttachment() as SocketAttachment | null;
        if (targetUserId && att?.userId !== Number(targetUserId)) continue;
        removeSocket(ws, subtype, closeReason);
      }
      return new Response("OK", { status: 200 });
    }

    // GET /active-ws-count — live socket count for the
    // convenor's pre-flight modal. Authoritative answer (D1's
    // awareness_state may lag); informational, NOT a gate (the convenor
    // can confirm regardless of count or fetch failure).
    if (url.pathname.endsWith("/active-ws-count") && request.method === "GET") {
      // Count distinct OTHER users with live sockets, excluding the
      // requester. The warning text ("N collaborators are editing right
      // now") is about people the convenor will disconnect — they
      // themselves aren't disconnecting themselves, and a single user
      // with several tabs is still one collaborator.
      const exceptUserIdParam = url.searchParams.get("exceptUserId");
      const markerError = await verifyInternalMarker(
        request,
        this.env.SESSION_SECRET,
        "active-ws-count",
        exceptUserIdParam,
      );
      if (markerError) return markerError;
      const exceptUserId =
        exceptUserIdParam !== null ? Number(exceptUserIdParam) : NaN;
      const otherUserIds = new Set<number>();
      for (const ws of this.ctx.getWebSockets()) {
        const att = ws.deserializeAttachment() as SocketAttachment | null;
        if (!att?.userId) continue;
        if (Number.isFinite(exceptUserId) && att.userId === exceptUserId) continue;
        otherUserIds.add(att.userId);
      }
      return Response.json({ count: otherUserIds.size });
    }

    // The operator's read-only surface — the halt state and the diagnostic —
    // resolved as one decision. Nothing in the app calls either; each handler
    // is bound by an operation signature of its own, so a marker minted for one
    // route cannot reach another.
    const operator = this.operatorRoute(request, url);
    if (operator !== null) return await operator();

    // GET /editing-time — the figure behind the clocks on the contribution
    // record: what D1 holds plus what this instance has booked and not yet
    // written. The whole route body is `readEditingTime` below, where the
    // reason both reads have to happen here is set out.
    if (url.pathname.endsWith("/editing-time") && request.method === "GET") {
      return this.readEditingTime(request);
    }

    // POST /restore-orphans — route Restore-as-drafts
    // through the Y.doc instead of writing D1 directly. The original
    // design wrote rows to D1, but the next snapshotToD1 reconciliation
    // (line ~1289) treated them as orphan-from-Y.doc and deleted them.
    // Routing through the Y.doc means the existing INSERT path in
    // snapshotToD1 picks the new entries up correctly. HMAC-marker gated
    // identically to /snapshot and /reset.
    //
    // Body: { stories: Array<{ storyId, steps[], layers[] }> }
    //   step:  { step_number, kind, object_id, x, y, zoom, page,
    //            question, answer, alt_text, clip_start, clip_end, loop }
    //   layer: { step_index, layer_number, title, button_label, content }
    // Title defaults to storyId; subtitle/byline default to empty
    // (per-story CSVs do not carry these fields). draft is always true
    // on restore. Order is computed as max(existing order) + 1 + i so
    // restored entries push onto the end of the array deterministically.
    if (url.pathname.endsWith("/restore-orphans") && request.method === "POST") {
      const markerError = await verifyInternalMarker(request, this.env.SESSION_SECRET, "restore-orphans");
      if (markerError) return markerError;
      const bindError = await this.bindProjectIdFromMarker(request);
      if (bindError) return bindError;

      let payload: {
        stories: Array<{
          storyId: string;
          steps: IngestStep[];
          layers: IngestLayer[];
        }>;
      };
      try {
        payload = await request.json();
      } catch {
        return new Response("Invalid JSON body", { status: 400 });
      }
      if (!payload || !Array.isArray(payload.stories)) {
        return new Response("Missing stories array", { status: 400 });
      }

      // Empty array: nothing to do — return early without firing
      // snapshotToD1 (no-op should not pay the snapshot cost).
      if (payload.stories.length === 0) {
        return Response.json({ restored: 0 });
      }

      // Drain any in-flight alarm snapshot BEFORE entering the gate. This must
      // sit OUTSIDE blockConcurrencyWhile: the gate blocks delivery of every
      // event not initiated inside its callback — including the in-flight
      // snapshot's own D1 responses — so a drain inside the gate would spin
      // until the runtime resets the DO. Out here the snapshot's awaits still
      // complete. No new snapshot can start between the loop observing false
      // and the gate closing: snapshot starters (alarm, last-disconnect,
      // forced) set isSnapshotting synchronously on delivery, and the
      // check-to-gate transition below has no await for them to interleave in.
      while (this.isSnapshotting) await new Promise((r) => setTimeout(r, 25));

      // Load the Y.doc and mutate inside blockConcurrencyWhile so the
      // snapshot writeback and broadcast happen atomically w.r.t. other
      // operations on this DO (internal-marker consistency).
      // The callback is wrapped whole so it always resolves. A throw escaping
      // it discards the DO along with the story Y.Maps this route has just
      // built, and the caller cannot tell that apart from a stub it never
      // reached.
      let restored = 0;
      let failure: unknown;
      let flushed = false;
      let refused = false;
      await this.ctx.blockConcurrencyWhile(async () => {
        try {
          await this.ensureDocLoaded();
          // Inside the gate, after the load and before the first mutation: a
          // halted document must not be changed, because nothing would carry
          // the change out.
          if (this.persistenceHalted !== null) {
            refused = true;
            return;
          }

          const storiesArray = this.ydoc.getArray<Y.Map<unknown>>("stories");
          // Which story_ids D1 already holds. A restore is only ever asked for
          // a story D1 has lost, but the document and D1 can disagree — an
          // instance evicted between a committed INSERT and the blob write
          // comes back from a blob that predates the row — and restoring such a
          // story as a new one aims a doomed INSERT, then the orphan sweep, at
          // the live row. Adopting its id makes the restore an UPDATE, and
          // makes a repeated restore idempotent rather than destructive.
          const d1Stories = await this.fetchEntityKeys("stories", "story_id");

          this.ydoc.transact(() => {
            for (const story of payload.stories) {
              // Restore defaults: title = storyId (the per-story CSV has no title
              // column; user can rename in /stories), subtitle/byline empty (not
              // in the per-story CSV), draft = true (a restored orphan is a draft).
              this.buildStoryYMap(storiesArray, {
                storyId: story.storyId,
                title: story.storyId,
                subtitle: "",
                byline: "",
                // Read fresh each time: buildStoryYMap pushes onto the array, so
                // the previous restore is already the story to sort after.
                orderKey: nextOrderKeyAfterLast(storiesArray),
                isPrivate: false,
                draft: true,
                showSections: false,
                steps: story.steps ?? [],
                layers: story.layers ?? [],
                adoptId: d1Stories.keyToId.get(story.storyId) ?? null,
              });
              restored += 1;
            }
          });

          // Persist immediately so the dashboard loader's post-action
          // revalidation sees the new D1 rows on its next orphan scan.
          //
          // `flushSnapshotNow`, not `snapshotToD1`: a halted project's
          // snapshot returns silently, and this route's whole purpose is to
          // put rows back into D1 — reporting `restored: N` off a snapshot
          // that did not run tells the dashboard the orphans are recovered
          // while its next scan still finds them.
          flushed = await this.flushSnapshotNow();
        } catch (err) {
          failure = err;
        }
      });
      // A halt met at the gate, and a halt this request's own flush entered:
      // one answer names the state, and every caller already fails closed on
      // any non-200.
      if (refused || this.persistenceHalted !== null) return this.answerHalted();
      if (failure !== undefined) {
        // 503, not 500: the drafts are in the document, only D1 lags, and the
        // dedupe keeper makes a repeated restore safe — so a retry is the
        // right move rather than a hard stop.
        if (!isNamedPersistenceRefusal(failure)) {
          console.error(`[restore-orphans] project ${this.projectId}: snapshot failed`, failure);
        }
        return new Response("snapshot_failed", { status: 503 });
      }
      if (!flushed) {
        console.error(
          `[restore-orphans] project ${this.projectId}: snapshot blocked, D1 not flushed`,
        );
        return new Response("snapshot_blocked", { status: 503 });
      }

      // Broadcast the full state to connected /stories editors so they
      // see the new draft(s) appear in real time (mirrors the ID-backfill
      // broadcast at ~line 1578).
      const updateEncoder = encoding.createEncoder();
      encoding.writeVarUint(updateEncoder, messageSync);
      syncProtocol.writeSyncStep2(updateEncoder, this.ydoc);
      const updateMsg = encoding.toUint8Array(updateEncoder);
      for (const client of this.ctx.getWebSockets()) {
        try {
          client.send(updateMsg);
        } catch {
          // Client may have disconnected; ignore.
        }
      }

      return Response.json({ restored });
    }

    // POST /ingest-sync — apply an accepted full-sync diff THROUGH the Y.Doc.
    // The action resolves every repo value (CSV/YAML parse, type coercion) and
    // sends fully typed values; the DO mutates the doc, snapshots to D1 in the
    // same call, and broadcasts the new state to connected editors. Routing the
    // writes through the doc means the snapshot pipeline itself persists them,
    // so the next reconciliation cannot revert them. Marker-gated identically
    // to /snapshot, /reset, and /restore-orphans.
    //
    // All mutations run in ONE ydoc.transact inside blockConcurrencyWhile, with
    // an in-flight-snapshot drain first (same reason as /restore-orphans). Y
    // types match buildFromD1Rows exactly: Y.Text fields are replaced in place
    // (delete + insert) so bound editors update live; scalars/booleans/number
    // are plain sets. Updates skip a missing entity, inserts skip a present one
    // (idempotent retry), and both counts land in the JSON response.
    //
    // The gate is also what makes this the only safe way to create a
    // `project_pages` row for a live project: the snapshot's slug re-key mints
    // its key from a read taken well before the batch that carries it, so a
    // writer reaching that UNIQUE-indexed table from outside the gate can take
    // the minted slug and abort the batch permanently. `pages.insert` exists so
    // page import has a way in that cannot interleave.
    if (url.pathname.endsWith("/ingest-sync") && request.method === "POST") {
      const markerError = await verifyInternalMarker(request, this.env.SESSION_SECRET, "ingest-sync");
      if (markerError) return markerError;
      const bindError = await this.bindProjectIdFromMarker(request);
      if (bindError) return bindError;

      const body = await this.readIngestBodyOrRename(request);
      if (body instanceof Response) return body;
      const { payload, opId } = body;
      // Value domains are judged HERE — on the payload, before the gate and
      // before the transaction that would carry the values in. See
      // `partitionOnIdentityDomain` for why the null-origin transaction below
      // cannot be the place, and `partitionIngestArm` for the order the three
      // rules run in. Every arm from here on reads a vetted list.
      //
      // The update and remove arms are vetted too, though they only look their
      // key up: `indexByKey` compares with `===`, so an out-of-domain key finds
      // nothing and the arm would report it as `skipped` — the caller's
      // "absent from the document", which is a claim about the project that no
      // honest comparison established.
      //
      // A refused field is named by type, never by value: see `IngestDiagnostic`.
      const diagnostics: IngestDiagnostic[] = [];
      const configArm = partitionConfigArm(payload.config, diagnostics);
      checkTelarVersion(payload.telarVersion, diagnostics);
      const storyUpdates = partitionIngestArm(
        payload.stories?.update, "storyUpdate", (u) => u.storyId, diagnostics,
      );
      const storyInserts = partitionIngestArm(
        payload.stories?.insert, "storyInsert", (i) => i.storyId, diagnostics,
      );
      const storyContent = partitionIngestArm(
        (payload.stories as { replaceContent?: IngestReplaceContent[] } | undefined)?.replaceContent,
        "storyReplaceContent", (e) => e.storyId, diagnostics,
      );
      const keptColumnsCaptures = partitionKeptColumnsArm(payload, diagnostics);
      const keptColumns: KeptColumnsOutcome = { captured: [], changed: [], missing: [], failed: [] };
      let keptColumnsPlans: KeptColumnsPlan[] = [];
      const content: ContentOutcome = { applied: [], alreadyApplied: [], changedSinceReview: [], failed: [] };
      const contentCandidates: ContentCandidate[] = [];
      // A story whose entry the boundary refused keeps its row fields as well:
      // the one choice covered both. By the id the entry states, where it
      // states one as a string; an entry refused for its id names no story an
      // accepted update could share.
      const contentRefusedIds = storyContent.refused.flatMap((position) => {
        const raw = (payload.stories as { replaceContent?: unknown[] } | undefined)?.replaceContent?.[position];
        const storyId = raw !== null && typeof raw === "object" ? (raw as { storyId?: unknown }).storyId : undefined;
        return typeof storyId === "string" ? [storyId] : [];
      });
      const objectUpdates = partitionIngestArm(
        payload.objects?.update, "objectUpdate", (u) => u.objectId, diagnostics,
      );
      const objectInserts = partitionIngestArm(
        payload.objects?.insert, "objectInsert", (i) => i.object_id, diagnostics,
      );
      const objectRemoves = partitionIngestArm(
        payload.objects?.remove, "objectRemove", removeEntryIdentity, diagnostics,
      );
      const { objectOrder, objectSheet } = partitionObjectPlacementArms(payload, diagnostics);
      const glossaryUpdates = partitionIngestArm(
        payload.glossary?.update, "glossaryUpdate", (u) => u.termId, diagnostics,
      );
      const glossaryInserts = partitionIngestArm(
        payload.glossary?.insert, "glossaryInsert", (i) => i.termId, diagnostics,
      );
      const pageInserts = partitionIngestArm(
        payload.pages?.insert, "pageInsert", (i) => i.slug, diagnostics,
      );
      const pageCaptures = partitionPageCaptureArm(payload, diagnostics);
      const pageReplaceContent = partitionPageReplaceArm(payload, diagnostics);
      const pageStores = partitionPageStoreArm(payload, diagnostics);
      const pageContent = emptyPageContentOutcome();
      const pageContentCandidates: PageContentCandidate[] = [];
      let pageReplacements: PageReplacement[] = [];
      const pageSlugArms = partitionPageSlugArms(payload, diagnostics);
      const pageRemove = emptyPageSlugOutcome();
      const pageRename = emptyPageSlugOutcome();
      const pageSlugCandidates = { remove: [] as PageSlugCandidate[], rename: [] as PageSlugCandidate[] };
      let pageSlugPlans: PageSlugPlans = { removals: [], renames: [] };

      const applied = {
        config: 0, storyUpdate: 0, storyInsert: 0, objectUpdate: 0,
        objectInsert: 0, objectRemove: 0, objectOrder: 0, glossaryUpdate: 0, glossaryInsert: 0,
        pageInsert: 0, pageCaptureFrontmatter: 0,
      };
      const skipped = {
        config: configArm.skipped,
        storyUpdate: [] as string[], objectUpdate: [] as string[],
        objectInsert: [] as string[], objectRemove: [] as string[], objectOrder: [] as string[],
        glossaryUpdate: [] as string[], glossaryInsert: [] as string[],
        pageInsert: [] as string[], pageCaptureFrontmatter: [] as number[],
      };
      // The row ids whose front matter this call stored, which the Pages
      // loader moves the publish snapshot for; a skipped capture is not one.
      const capturedPages: number[] = [];
      // The row ids holding the block a landed publish wrote, which the
      // publish moves its snapshot for; a page holding another block is not one.
      const storedPages: number[] = [];
      // Inserts the document accepted but D1 refused. Distinct from `skipped`,
      // which means "already there": the caller reports a skip as
      // already-present and must not report a refusal the same way. Filled
      // from the snapshot's own receipts, below.
      const failed = {
        objectInsert: [] as string[],
        glossaryInsert: [] as string[],
        pageInsert: [] as string[],
      };
      // Entries the boundary refused for stating a value out of the domain its
      // producers emit — its shape, its identity, or one of its fields. A third
      // outcome, and not either of the two above: `skipped` means the entity is
      // already in the project, `failed` means the document took it and D1
      // would not — both describe something that exists somewhere. A refused
      // entry exists nowhere, was never applied to anything, and no retry of
      // the same payload will change that, so reporting it as either would send
      // the caller after a remedy that does not apply. Positions in the arm as
      // it arrived, never the values: see `partitionOnIdentityDomain`. The
      // arrays keep that shape because the page and object import routes index
      // their own inserts by these positions.
      const refused = {
        config: configArm.refused,
        storyUpdate: storyUpdates.refused,
        storyInsert: storyInserts.refused,
        storyReplaceContent: storyContent.refused,
        stepCaptureKeptColumns: keptColumnsCaptures.refused,
        objectUpdate: objectUpdates.refused,
        objectInsert: objectInserts.refused,
        objectRemove: objectRemoves.refused,
        objectOrder: objectOrder.refused,
        objectSheet: objectSheet.refused,
        glossaryUpdate: glossaryUpdates.refused,
        glossaryInsert: glossaryInserts.refused,
        pageInsert: pageInserts.refused,
        pageCaptureFrontmatter: pageCaptures.refused,
        pageReplaceContent: pageReplaceContent.refused,
        pageStoreWrittenFrontmatter: pageStores.refused,
        pageRemove: pageSlugArms.remove.refused,
        pageRename: pageSlugArms.rename.refused,
      };
      // Object inserts an all-or-nothing ingest was held back for, their row
      // over D1's row size (`objectArmsHeldBack`). Named by object_id.
      const oversized = { objectInsert: [] as string[] };
      // Object inserts carrying the marker of a course this site is not
      // attached to. Named by object_id, which passed the identity rule.
      const courseRefused = { objectInsert: [] as string[] };
      // What each object removal met, by object_id: removed; already gone;
      // held under the key by an object with another D1 id; or a course item,
      // which the ingest never removes. The last three are all `skipped` above.
      const removals = {
        applied: [] as string[],
        absent: [] as string[],
        superseded: [] as string[],
        course: [] as string[],
      };
      // Why each skipped object update was skipped, by object_id: no object
      // holds its key, or one holds it under another D1 id than the update
      // names — an object re-created since the author reviewed the change. Both
      // are in `skipped`; the second is also answered as `superseded`.
      const updateMisses = { absent: [] as string[], superseded: [] as string[] };
      // An order entry is superseded on the same terms: the row the sync
      // paired no longer holds the key, and another row does.
      const superseded = { objectUpdate: updateMisses.superseded, objectOrder: [] as string[] };
      // Object updates with a field left because the document's value is not
      // the one the sync check read (`seen`): edited here since the review.
      const changedSinceReview = { objectUpdate: [] as string[] };
      logIngestRefusals(this.projectId, refused, diagnostics);
      // Each entity this call pushed onto the document, held by reference so
      // the receipt check can read the `_id` the INSERT backfilled onto it.
      const receipts: Array<{
        bucket: keyof typeof failed;
        key: string;
        map: Y.Map<unknown>;
      }> = [];
      // Whether an entity the document already holds still needs its outcome
      // reported. A held map with no id is a registration D1 lost, so it takes
      // a receipt like a fresh insert; a key repeated INSIDE one payload is
      // instead a duplicate of the arm that just ran, which already has one and
      // must not be counted twice.
      const needsReceipt = (m: Y.Map<unknown>): boolean =>
        this.awaitingItsRow(m) && !receipts.some((r) => r.map === m);

      // Drain any in-flight alarm snapshot BEFORE entering the gate — see the
      // same wait (and the gate-semantics constraint it documents) in
      // /restore-orphans. Draining out here lets the in-flight snapshot's D1
      // responses deliver; inside the gate they would be blocked and the loop
      // could never observe the flag clearing.
      while (this.isSnapshotting) await new Promise((r) => setTimeout(r, 25));

      // The callback is wrapped whole so it always resolves. A throw escaping
      // it discards the DO along with the diff this route has just applied to
      // the document, and the caller cannot tell that apart from a stub it
      // never reached.
      let failure: unknown;
      let flushed = false;
      let fenceBlocked = false;
      let alreadyApplied = false;
      let heldBack = false;
      const receipted: ReceiptedEntries = { objectInsert: [], objectRemove: [] };
      // What this delivery attempted and a receipt may settle: the object
      // inserts the document already held, beside the ones in `receipts`, and
      // every removal it applied to the document.
      const heldInserts: Array<{ key: string; map: Y.Map<unknown> }> = [];
      const attemptedRemoves: Array<string | IngestObjectRemove> = [];
      await this.ctx.blockConcurrencyWhile(async () => {
        try {
          // Inside the gate, so two deliveries of one operation cannot both
          // pass the check. Objects the operation already settled are dropped
          // from the arms; a delivery with nothing left is answered as done.
          if (await this.dropSettledEntries(opId, objectInserts, objectRemoves, refused, receipted)) {
            alreadyApplied = true;
            return;
          }
          await this.ensureDocLoaded();
          // Inside the gate, after the load and before the first mutation: a
          // diff applied to a halted document would be accepted and dropped.
          if (this.persistenceHalted !== null) {
            fenceBlocked = true;
            return;
          }

          const configMap = this.ydoc.getMap<unknown>("config");
          const storiesArray = this.ydoc.getArray<Y.Map<unknown>>("stories");
          const objectsArray = this.ydoc.getArray<Y.Map<unknown>>("objects");
          const glossaryArray = this.ydoc.getArray<Y.Map<unknown>>("glossary");
          const pagesArray = this.ydoc.getArray<Y.Map<unknown>>("pages");

          // A course marker is taken only for the course this site is attached
          // to now, read inside this section: a preload that lands after the
          // site has left its course is refused rather than written.
          const parentCourse = await this.parentForMarkedInserts(objectInserts.accepted);
          // Checked against the live story inside the gate and before the
          // transaction: the hash is async, the transaction is not. A story
          // whose content is not applied keeps its row fields too, since the
          // author's choice covered both (design §3).
          const replacements = await this.planContentReplacements(
            storiesArray, storyContent.accepted, content, contentCandidates,
          );
          const contentHeld = new Set([...contentRefusedIds, ...content.changedSinceReview, ...content.failed]);
          // Checked the same way, for the same reason: the hash is async.
          keptColumnsPlans = await this.planKeptColumnsCaptures(storiesArray, keptColumnsCaptures.accepted, keptColumns);
          pageReplacements = await planPageReplacements(
            pagesArray, pageReplaceContent.accepted, pageContent, pageContentCandidates,
          );
          // Checked the same way: a removal's hash is async too.
          pageSlugPlans = await planPageSlugChanges(
            pagesArray,
            {
              remove: pageSlugArms.remove.accepted,
              rename: pageSlugArms.rename.accepted,
              inserted: new Set(pageInserts.accepted.map((ins) => ins.slug)),
            },
            { remove: pageRemove, rename: pageRename },
            pageSlugCandidates,
          );
          // Before the first write, in every domain: an all-or-nothing ingest
          // that cannot take everything takes nothing, an entry the boundary
          // refused above included.
          if (payload.allOrNothing === true) {
            const held = objectArmsHeldBack(objectsArray, {
              update: objectUpdates.accepted, order: objectOrder.accepted, remove: objectRemoves.accepted,
              insert: objectInserts.accepted,
            });
            const contentHeld = {
              story: [...content.changedSinceReview, ...content.failed],
              page: [
                ...pageContent.changedSinceReview, ...pageContent.failed,
                ...pageRemove.changedSinceReview, ...pageRemove.failed,
                ...pageRename.changedSinceReview, ...pageRename.failed,
              ],
              pageInsert: pageInsertsHeldBack(pagesArray, pageInserts.accepted),
            };
            if (ingestHeldBack(held, contentHeld, refused)) {
              changedSinceReview.objectUpdate.push(...held.changedSinceReview);
              skipped.objectUpdate.push(...held.supersededUpdates);
              updateMisses.superseded.push(...held.supersededUpdates);
              superseded.objectOrder.push(...held.supersededOrder);
              removals.superseded.push(...held.supersededRemoves);
              skipped.objectInsert.push(...held.presentInserts);
              oversized.objectInsert.push(...held.oversizedInserts);
              skipped.pageInsert.push(...contentHeld.pageInsert);
              heldBack = true;
              return;
            }
          }

          this.ydoc.transact(() => {
            // --- config fields (allowlisted — unknown keys are refused) ---
            // Two lists because they are two writes: a character-merged
            // replacement for the keys a bound editor holds, a scalar set for
            // the rest. Which list a key is on is settled by the allow-list it
            // appears in, so neither loop has to ask.
            for (const { key, value } of configArm.text) {
              this.replaceYText(configMap, key, value);
            }
            for (const { key, value } of configArm.plain) {
              configMap.set(key, value);
            }
            applied.config = configArm.text.length + configArm.plain.length;
            // telar_version rides here so the doc agrees with the D1 heal the
            // action performs directly (snapshotConfig omits the column).
            if (typeof payload.telarVersion === "string") {
              configMap.set("telar_version", payload.telarVersion);
            }

            // --- story updates ---
            for (const upd of storyUpdates.accepted) {
              const m = contentHeld.has(upd.storyId) ? null : this.findByKey(storiesArray, "story_id", upd.storyId);
              if (!m) { skipped.storyUpdate.push(upd.storyId); continue; }
              this.replaceStatedYText(m, "title", upd.title);
              this.replaceStatedYText(m, "subtitle", upd.subtitle);
              this.replaceStatedYText(m, "byline", upd.byline);
              this.setStatedValue(m, "private", upd.isPrivate);
              this.setStatedValue(m, "show_sections", upd.showSections);
              // order is deliberately untouched — sync excludes it and D1 order
              // comes from the Y.Array index at snapshot time.
              applied.storyUpdate += 1;
            }

            // --- story content (checked and planned above) ---
            for (const plan of replacements) {
              this.applyContentReplacement(plan);
              contentCandidates.push({ storyId: plan.entry.storyId, incomingHash: plan.incomingHash, outcome: "applied" });
            }

            // --- step kept columns (checked and planned above) ---
            applyKeptColumnsCaptures(keptColumnsPlans);

            // --- story inserts (dedup-before-insert, draft=false) ---
            for (const ins of storyInserts.accepted) {
              this.buildStoryYMap(storiesArray, {
                storyId: ins.storyId,
                title: statedText(ins.title),
                subtitle: statedText(ins.subtitle),
                byline: statedText(ins.byline),
                orderKey: nextOrderKeyAfterLast(storiesArray),
                isPrivate: statedFlag(ins.isPrivate),
                // Presence in project.csv is the not-a-draft encoding.
                draft: false,
                showSections: statedFlag(ins.showSections),
                steps: ins.steps ?? [],
                layers: ins.layers ?? [],
                carryExistingId: true,
              });
              applied.storyInsert += 1;
            }

            // --- object updates (see updatedObject) ---
            for (const upd of objectUpdates.accepted) {
              const { map: m, missed } = this.updatedObject(objectsArray, upd);
              if (!m) {
                skipped.objectUpdate.push(upd.objectId);
                updateMisses[missed].push(upd.objectId);
                continue;
              }
              const reviewed = fieldsUnchangedSinceReview(m, upd, (o) => this.objectCustomBlob(o));
              if (reviewed.changed) changedSinceReview.objectUpdate.push(upd.objectId);
              this.applyObjectUpdate(m, { ...upd, fields: reviewed.fields });
              applied.objectUpdate += 1;
            }

            // --- object order: before the inserts, which are placed among the rows it orders ---
            applied.objectOrder = applyObjectOrder(
              objectsArray, objectOrder.accepted, { skipped: skipped.objectOrder, superseded: superseded.objectOrder },
            );

            // --- object inserts (skip-if-present; placed by GitHub's sheet) ---
            const placement = sheetPlacement(objectsArray, objectSheet.accepted);
            for (const ins of objectInserts.accepted) {
              if (!markerAllowed(markerCourse(ins.course_project_id), parentCourse)) {
                courseRefused.objectInsert.push(ins.object_id);
                continue;
              }
              const held = this.findByKey(objectsArray, "object_id", ins.object_id);
              if (held) {
                if (!needsReceipt(held)) {
                  skipped.objectInsert.push(ins.object_id);
                  heldInserts.push({ key: ins.object_id, map: held });
                  continue;
                }
                carryMissingOrigin(held, ins);
                receipts.push({ bucket: "objectInsert", key: ins.object_id, map: held });
                applied.objectInsert += 1;
                continue;
              }
              const objectMap = this.buildObjectYMap(ins, placement.keyFor(ins.object_id));
              objectsArray.push([objectMap]);
              placement.placed(ins.object_id, objectMap);
              receipts.push({ bucket: "objectInsert", key: ins.object_id, map: objectMap });
              applied.objectInsert += 1;
            }

            // --- object removes (see removeIngestedObject) ---
            for (const entry of objectRemoves.accepted) {
              attemptedRemoves.push(entry);
              const outcome = this.removeIngestedObject(objectsArray, entry);
              removals[outcome.kind].push(outcome.objectId);
              if (outcome.kind === "applied") applied.objectRemove += 1;
              else skipped.objectRemove.push(outcome.objectId);
            }

            // --- glossary updates ---
            for (const upd of glossaryUpdates.accepted) {
              const m = this.findByKey(glossaryArray, "term_id", upd.termId);
              if (!m) { skipped.glossaryUpdate.push(upd.termId); continue; }
              this.replaceStatedYText(m, "title", upd.title);
              this.replaceStatedYText(m, "definition", upd.definition);
              this.setStatedValue(m, "kind", upd.kind);
              applied.glossaryUpdate += 1;
            }

            removeHeldTerms(glossaryArray, payload.glossary);

            // --- glossary inserts (skip-if-present) ---
            for (const ins of glossaryInserts.accepted) {
              const heldTerm = this.findByKey(glossaryArray, "term_id", ins.termId);
              if (heldTerm) {
                if (!needsReceipt(heldTerm)) {
                  skipped.glossaryInsert.push(ins.termId);
                  continue;
                }
                receipts.push({ bucket: "glossaryInsert", key: ins.termId, map: heldTerm });
                applied.glossaryInsert += 1;
                continue;
              }
              const termMap = new Y.Map<unknown>();
              termMap.set("_id", null);
              // insertGlossaryRow keeps an existing term_id verbatim, so the
              // repo id survives the snapshot INSERT.
              termMap.set("term_id", ins.termId);
              termMap.set("title", new Y.Text(ins.title ?? ""));
              termMap.set("definition", new Y.Text(ins.definition ?? ""));
              termMap.set("kind", ins.kind ?? "");
              termMap.set(ORDER_KEY, nextOrderKeyAfterLast(glossaryArray));
              termMap.set("created_by", null);
              glossaryArray.push([termMap]);
              receipts.push({ bucket: "glossaryInsert", key: ins.termId, map: termMap });
              applied.glossaryInsert += 1;
            }

            // --- page inserts (skip-if-present) ---
            // The document decides presence, not D1: `ensureDocLoaded` above
            // has already built the doc from the blob or, on a cold DO, from
            // the very rows a D1 read would return, so the two agree here — and
            // consulting D1 instead would reintroduce the read-then-write gap
            // this arm exists to close. A slug the doc already holds WITH an id
            // is skipped and named, which is what makes a retry after a failed
            // snapshot idempotent; one still holding a null `_id` is a page D1
            // never got, so it takes a receipt instead — see `awaitingItsRow`.
            // The menu each insert's entry is placed against: as it stood
            // before any insert of this ingest added to it.
            const savedMenu = savedMenuItems(configMap.get("navigation"));
            for (const ins of pageInserts.accepted) {
              // The slug is used as it arrived. Rendering it — `String(slug)` —
              // would decide presence from a value the document never holds,
              // which is what let a structural slug pass a skip check and land
              // raw in the Y.Map; the boundary has already established that
              // this one is a non-empty string.
              const slug = ins.slug;
              const heldPage = this.findByKey(pagesArray, "slug", slug);
              if (heldPage) {
                if (!needsReceipt(heldPage)) {
                  skipped.pageInsert.push(slug);
                  continue;
                }
                receipts.push({ bucket: "pageInsert", key: slug, map: heldPage });
                placeInsertedPageMenuEntry(configMap.get("navigation"), savedMenu, slug, ins.menu);
                applied.pageInsert += 1;
                continue;
              }
              const pageMap = this.buildPageYMap(ins, nextOrderKeyAfterLast(pagesArray));
              pagesArray.push([pageMap]);
              receipts.push({ bucket: "pageInsert", key: slug, map: pageMap });
              placeInsertedPageMenuEntry(configMap.get("navigation"), savedMenu, slug, ins.menu);
              applied.pageInsert += 1;
            }

            // --- page removals and renames (checked and planned above) ---
            // After the inserts, whose slugs a rename was checked against, and
            // with the menu entries naming each page.
            applyPageSlugChanges(pagesArray, configMap.get("navigation"), pageSlugPlans, pageSlugCandidates);

            // --- page content (checked and planned above) ---
            // Ahead of the captures: a capture writes only onto a block still
            // null, so a page this arm sets keeps GitHub's block and its
            // capture is skipped, not reported as stored.
            applyPageReplacements(pageReplacements, (m, k, v) => this.replaceYText(m, k, v), pageContentCandidates);

            // --- page front matter captures (only onto a block never read) ---
            const captured = applyFrontmatterCaptures(pagesArray, pageCaptures.accepted);
            applied.pageCaptureFrontmatter = captured.applied.length;
            capturedPages.push(...captured.applied);
            skipped.pageCaptureFrontmatter.push(...captured.skipped);

            // --- blocks a landed publish wrote (only over the block it read) ---
            // After the replacements and the captures, so `expected` is judged
            // against the block they leave.
            storedPages.push(...applyWrittenFrontmatterStores(pagesArray, pageStores.accepted));
          });

          // Persist through the snapshot pipeline — still inside the block so no
          // alarm can race between the mutation and the write.
          //
          // `flushSnapshotNow`, not `snapshotToD1`: the latter returns SILENTLY
          // when persistence is halted or the lock is held, and this route's
          // 200 is the caller's only signal that the diff reached D1. Reading
          // that silence as persistence is how a page import into a halted
          // project reported success and broadcast a page that was not in D1 —
          // which the reset required to clear the halt then discarded. Same
          // refusal /snapshot and /clear-course-markers already give.
          this.objectInsertIds = new WeakMap();
          flushed = await this.flushSnapshotNow();
          if (flushed) this.recordInsertReceipts(receipts, applied, failed);
        } catch (err) {
          failure = err;
        }
        // The ingest credits nobody: every prose field now holds what the sync
        // wrote, and the next author is credited only with their rise. After
        // the flush, which gives an inserted row the `_id` the baseline is
        // keyed by, and whether or not it succeeded.
        this.seedWordBaseline();
        // Whether the flush succeeded or not: an object's receipt is earned
        // from what D1 holds, since a flush can fail after some rows persisted
        // and succeed around a row D1 refused. Still inside the gate, so no
        // other delivery of this operation reads the receipt between.
        const unsettled = await this.settlePersistedEntries(
          opId, receipts, heldInserts, attemptedRemoves, removals.course,
        );
        failure ??= unsettled;
        // Story and page content likewise, from D1 after the flush attempt.
        await this.settleContent(contentCandidates, content);
        await settlePageContent(this.env.DB, this.projectId, pageContentCandidates, pageContent);
        await settlePageSlugs(this.env.DB, this.projectId, pageSlugCandidates.remove, pageRemove);
        await settlePageSlugs(this.env.DB, this.projectId, pageSlugCandidates.rename, pageRename);
        await this.settleKeptColumns(keptColumnsPlans, keptColumns);
      });
      if (alreadyApplied) {
        return Response.json({
          alreadyApplied: true, applied, skipped, superseded, failed, refused, courseRefused, removals, receipted,
          diagnostics, content, pageContent, pageRemove, pageRename, changedSinceReview,
        });
      }
      if (heldBack) {
        return Response.json({
          heldBack: true, applied, skipped, superseded, failed, refused, oversized, courseRefused, removals, receipted,
          diagnostics, content, pageContent, pageRemove, pageRename, changedSinceReview,
        });
      }
      if (fenceBlocked || this.persistenceHalted !== null) return this.answerHalted();
      if (failure !== undefined) {
        // 503, not 500: the diff is in the document and this route is already
        // documented as idempotent on retry (updates skip a missing entity,
        // inserts skip a present one), so the caller should try again.
        if (!isNamedPersistenceRefusal(failure)) {
          console.error(`[ingest-sync] project ${this.projectId}: snapshot failed`, failure);
        }
        return new Response("snapshot_failed", { status: 503 });
      }
      if (!flushed) {
        // The diff is in the document but D1 has none of it, so neither the
        // report nor the broadcast below has earned the right to run. A halted
        // project's recovery is the reset, which rebuilds from D1 and discards
        // this diff — the caller re-posts it afterwards, and the route's
        // documented idempotence makes that safe.
        console.error(
          `[ingest-sync] project ${this.projectId}: snapshot blocked, D1 not flushed`,
        );
        return new Response("snapshot_blocked", { status: 503 });
      }

      // Broadcast the full state to connected editors (verbatim /restore-orphans
      // tail) so they see the accepted changes live.
      const updateEncoder = encoding.createEncoder();
      encoding.writeVarUint(updateEncoder, messageSync);
      syncProtocol.writeSyncStep2(updateEncoder, this.ydoc);
      const updateMsg = encoding.toUint8Array(updateEncoder);
      for (const client of this.ctx.getWebSockets()) {
        try {
          client.send(updateMsg);
        } catch {
          // Client may have disconnected; ignore.
        }
      }

      return Response.json({
        applied, skipped, superseded, failed, refused, courseRefused, removals, receipted, diagnostics, content,
        keptColumns, capturedPages, storedPages, pageContent, pageRemove, pageRename, changedSinceReview,
        insertedPages: insertedPageIds(receipts),
      });
    }

    // POST /clear-course-markers — remove the course marker from every object
    // Y.Map carrying the given course id, then flush a snapshot BEFORE
    // returning.
    //
    // Its own route rather than an object-update field: /ingest-sync filters
    // object fields by allowlist, and the marker is deliberately not on that
    // list — nothing arriving from a repo may set or clear it.
    //
    // Clearing is a Y.Doc mutation, not a D1 UPDATE: the snapshot rebuilds D1
    // from the doc, so a D1-only clear would be undone at the next snapshot and
    // the delete gate would keep refusing deletes on objects that are ordinary
    // site objects again. The immediate flush is what lets the caller treat D1
    // as consistent the moment this answers — a course deletion runs its
    // cascade next, and the ordinary snapshot cycle would be far too late.
    if (url.pathname.endsWith("/clear-course-markers") && request.method === "POST") {
      const markerError = await verifyInternalMarker(
        request,
        this.env.SESSION_SECRET,
        "clear-course-markers",
      );
      if (markerError) return markerError;
      const bindError = await this.bindProjectIdFromMarker(request);
      if (bindError) return bindError;

      let body: { courseProjectId?: unknown };
      try {
        body = await request.json();
      } catch {
        return new Response("Invalid JSON body", { status: 400 });
      }
      const courseProjectId = Number(body?.courseProjectId);
      if (!Number.isInteger(courseProjectId) || courseProjectId <= 0) {
        return new Response("Invalid courseProjectId", { status: 400 });
      }

      // The document is mutated once; the flush may take several tries. An
      // alarm snapshot that holds the lock makes snapshotToD1 a silent no-op,
      // and answering 200 on an unflushed document would hand the caller a
      // false guarantee — the leave and course-deletion sequences proceed on
      // this answer. So: drain, flush, and if the flush did not run, drain and
      // try again; refuse rather than lie.
      //
      // The flush is NOT skipped when nothing was cleared this time round. A
      // retry after a refusal finds the document already clean and would count
      // zero — while D1 still holds the markers the first attempt failed to
      // write away. Always flushing is what keeps "200 means D1 agrees with the
      // document" true on every path, retries included.
      let cleared = 0;
      let mutated = false;
      let flushed = false;
      let refused = false;
      // Whether the last attempt failed with a refusal that has already logged
      // its own line. The terminal line below is suppressed for those exactly as
      // it is for the flag, so a halt costs one line per attempt and no more.
      let named = false;
      for (let attempt = 0; attempt < CLEAR_MARKERS_FLUSH_ATTEMPTS && !flushed && !refused; attempt++) {
        // Drain outside the gate, for the same reason /ingest-sync and
        // /restore-orphans do: inside it the in-flight snapshot's own D1
        // responses are blocked, so the loop could never observe the flag
        // clearing. Bounded, so a wedged snapshot ends in a refusal the caller
        // can retry rather than a DO spinning until the runtime resets it.
        for (let i = 0; this.isSnapshotting && i < SNAPSHOT_DRAIN_MAX_POLLS; i++) {
          await new Promise((r) => setTimeout(r, SNAPSHOT_DRAIN_POLL_MS));
        }

        // A thrown flush lands in the same refusal a blocked one does — the
        // caller's guarantee is "200 means D1 agrees with the document", and
        // neither outcome earns it. The catch is INSIDE the gate because a
        // throw escaping it discards the DO, taking the cleared markers with
        // it and answering the caller with a rejection rather than the 503 it
        // knows how to retry.
        await this.ctx.blockConcurrencyWhile(async () => {
          named = false;
          try {
            await this.ensureDocLoaded();
            // Inside the gate, after the load and before the first mutation.
            if (this.persistenceHalted !== null) {
              refused = true;
              return;
            }
            if (!mutated) {
              const objectsArray = this.ydoc.getArray<Y.Map<unknown>>("objects");
              this.ydoc.transact(() => {
                for (let i = 0; i < objectsArray.length; i++) {
                  const m = objectsArray.get(i);
                  if (courseMarkerBind(m) !== courseProjectId) continue;
                  // delete, not set-null: absence is the unmarked state (contract 1).
                  m.delete("course_project_id");
                  cleared += 1;
                }
                // Null origin: leaving a course is the course's act, not any
                // editor's, so it earns nobody a contribution.
              }, null);
              mutated = true;
            }
            flushed = await this.flushSnapshotNow();
          } catch (err) {
            named = isNamedPersistenceRefusal(err);
            if (!named) {
              console.error(
                `[clear-course-markers] project ${this.projectId}: flush attempt ${attempt + 1} threw`,
                err,
              );
            }
            flushed = false;
          }
        });
      }

      if (refused || this.persistenceHalted !== null) return this.answerHalted();
      if (!flushed) {
        // The markers are gone from the document but D1 still carries them.
        // A retry re-runs the flush against the same (already clean) document.
        if (!named) {
          console.error(
            `[clear-course-markers] project ${this.projectId}: snapshot blocked, D1 not flushed`,
          );
        }
        return new Response("snapshot_blocked", { status: 503 });
      }

      // Broadcast so live editors drop the course-item badge and regain the
      // delete affordance without a reconnect (verbatim /ingest-sync tail).
      const updateEncoder = encoding.createEncoder();
      encoding.writeVarUint(updateEncoder, messageSync);
      syncProtocol.writeSyncStep2(updateEncoder, this.ydoc);
      const updateMsg = encoding.toUint8Array(updateEncoder);
      for (const client of this.ctx.getWebSockets()) {
        try {
          client.send(updateMsg);
        } catch {
          // Client may have disconnected; ignore.
        }
      }

      return Response.json({ cleared });
    }

    // Only accept WebSocket upgrades for all other paths
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    // Require exactly /ws/:projectId — three segments, the first empty (a
    // leading slash), the second literally "ws". The worker entry only ever
    // forwards upgrades matching this shape (see handleWsUpgrade in
    // workers/app.ts), but the object must not depend on that: a request
    // reaching this handler directly with an extra segment or a different
    // first segment is a shape mismatch, not an authentication question, so
    // it is refused before projectId is even parsed.
    const segments = url.pathname.split("/");
    if (segments.length !== 3 || segments[0] !== "" || segments[1] !== "ws") {
      return new Response("Invalid path", { status: 400 });
    }

    // Extract projectId from /ws/:projectId. Only the canonical decimal form
    // is accepted — see parseCanonicalProjectId in ./auth for why: a lenient
    // parse here could bind this DO to a project the worker-entry route (or
    // idFromName itself) would read differently from the same URL.
    const projectId = parseCanonicalProjectId(segments[2]);
    if (projectId === null) {
      return new Response("Invalid project ID", { status: 400 });
    }

    // Authenticate via session cookie or query-string token fallback.
    // The browser sends the httpOnly __compositor_session cookie on WebSocket
    // upgrade requests automatically. Query-string ?token= is kept as a fallback.
    const cookieToken = parseSessionCookie(request.headers.get("Cookie"));
    const token = cookieToken ?? url.searchParams.get("token");
    if (!token) {
      return new Response("Missing auth token", { status: 401 });
    }

    const userId = await this.getUserIdFromToken(token);
    if (!userId) {
      return new Response("Invalid or expired session", { status: 401 });
    }

    // Verify project membership (parameterised query). The read's start is
    // what the attachment records; the messages reread it once a minute.
    const membershipReadAt = Date.now();
    const memberRow = await this.readMembershipRow(projectId, userId);

    if (!memberRow) {
      return new Response("Not a project member", { status: 403 });
    }

    const role = parseMemberRole(memberRow.role);
    if (!role) {
      return new Response("Unrecognised project role", { status: 403 });
    }

    // Store projectId (idempotent — same value for all connections to this DO instance)
    if (!this.projectId) {
      this.projectId = projectId;
    }
    // The durable binding behind it, from the authenticated, membership-checked
    // URL this admission has already verified. Awaited so an alarm that wakes
    // after this socket has gone can name the project; a put that fails leaves
    // the binding unmade and the next binding path or preflight retries it,
    // which is not a reason to refuse an editor.
    await this.bindIdentity();

    // Generation guard. `?gen=` is the generation the client's Y.Doc was last
    // synced at, echoed back from the handshake below, or the fresh-document
    // claim for one it has just built. A client whose generation is behind is
    // holding a document from before a reset, and the sync exchange would merge
    // that document into the rebuilt one. So it is refused before any sync
    // message is exchanged: told to discard what it holds, and closed.
    //
    // Ordinary reconnection is untouched. A dropped connection does not change
    // the generation, so the reconnecting client presents the current one and
    // takes the normal path below — including the offline edits it queued while
    // away, which still merge exactly as they did.
    //
    // A generation storage cannot answer refuses the upgrade outright. The
    // attachment carries the generation the socket was admitted under, and
    // there is none to carry here: admitting the socket anyway would put a
    // connection on the document that no later fence could place. 503, so the
    // provider's own reconnect schedule brings the client back.
    const documentGeneration = await this.getDocGeneration();
    if (documentGeneration === null) {
      return new Response("Document generation unavailable", { status: 503 });
    }
    const claimedGeneration = url.searchParams.get("gen");
    if (!mayRejoinGeneration(claimedGeneration, documentGeneration)) {
      return this.refuseStaleGeneration(projectId, documentGeneration, claimedGeneration);
    }

    // A halted document must not take on another editor. Checked before the
    // gate so a halted instance pays for no load, and again after it, because a
    // load or a snapshot running inside the gate can enter the halt. 503 with
    // the halt named: the client's provider reconnects generically on any close
    // and has no handling for a close code, so the reason is carried where a
    // surface can read it.
    if (this.persistenceHalted !== null) return this.answerHalted();

    // Serialise cold-start initialisation to prevent race conditions.
    //
    // The catch is INSIDE the callback: a throw escaping it discards the DO,
    // which drops every editor already connected to this project because one
    // new arrival met a bad D1 read. Refuse this one upgrade instead — 503, so
    // the client's reconnect loop tries again — and leave everyone else alone.
    let loadFailure: unknown;
    await this.ctx.blockConcurrencyWhile(async () => {
      try {
        await this.ensureDocLoaded();
      } catch (err) {
        loadFailure = err;
      }
    });
    if (loadFailure !== undefined) {
      // The loader owns the line for a refusal it named.
      if (!isNamedPersistenceRefusal(loadFailure)) {
        console.error(`[collaboration] project ${projectId}: cold-start load failed`, loadFailure);
      }
      if (this.persistenceHalted !== null) return this.answerHalted();
      return new Response("Document unavailable", { status: 503 });
    }
    if (this.persistenceHalted !== null) return this.answerHalted();

    // The guard above ran before the gate, and a resident `/reset` can advance
    // the generation inside it. Revalidate against the cache the reset writes,
    // so the socket is stamped with a generation it was actually checked
    // against and never with a newer one it was not.
    if (this.docGeneration !== documentGeneration) {
      if (this.docGeneration === null) {
        return new Response("Document generation unavailable", { status: 503 });
      }
      return this.refuseStaleGeneration(projectId, this.docGeneration, claimedGeneration);
    }

    // Read before the socket is accepted, so nothing awaits between accepting
    // it and the frames below, which have to reach it in this order.
    const freezeFrame = this.freezeFrameBytes(await this.readLeaseStateOrEmpty());

    // Upgrade the WebSocket connection using the hibernation API
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);

    const attachment: SocketAttachment = {
      userId,
      projectId,
      role,
      generation: documentGeneration,
      membershipCheckedAt: membershipReadAt,
    };
    const declaredClientId = parseAwarenessClientId(url.searchParams.get(AWARENESS_CLIENT_PARAM));
    if (declaredClientId !== null) this.claimAwarenessClientId(server, attachment, declaredClientId);
    server.serializeAttachment(attachment);

    // After acceptWebSocket -- record new session for deferred D1 write
    this.newSessions.add(userId);

    // Tell the client which generation the document it is about to receive
    // belongs to, before any of that document reaches it. The client echoes it
    // back as `?gen=` on every later connection, which is what lets the guard
    // above tell a reconnecting editor from one holding a pre-reset document.
    // It is the same number the attachment carries, so what the client claims
    // on its next connection and what its socket may write are one fact.
    const genEncoder = encoding.createEncoder();
    encoding.writeVarUint(genEncoder, messageSessionControl);
    encoding.writeUint8(genEncoder, subDocGeneration);
    encoding.writeVarUint(genEncoder, documentGeneration);
    server.send(encoding.toUint8Array(genEncoder));

    // The freeze as it stands, so a client joining mid-publish is frozen from
    // its first frame and one that missed an operation's end learns of it.
    server.send(freezeFrame);

    // Send sync step 1 using y-protocols framing so the WebsocketProvider
    // can parse it correctly (message type prefix byte + sync protocol data).
    const syncEncoder = encoding.createEncoder();
    encoding.writeVarUint(syncEncoder, messageSync);
    syncProtocol.writeSyncStep1(syncEncoder, this.ydoc);
    server.send(encoding.toUint8Array(syncEncoder));

    // Send sync step 2 (the full state) so the client is immediately up to date
    const stateEncoder = encoding.createEncoder();
    encoding.writeVarUint(stateEncoder, messageSync);
    syncProtocol.writeSyncStep2(stateEncoder, this.ydoc);
    server.send(encoding.toUint8Array(stateEncoder));

    // Send current awareness state of all connected clients, less the entries
    // of clients that stopped renewing without closing.
    sweepOutdatedPresence(this.awareness, Date.now());
    const awarenessStates = this.awareness.getStates();
    if (awarenessStates.size > 0) {
      const awarenessEncoder = encoding.createEncoder();
      encoding.writeVarUint(awarenessEncoder, messageAwareness);
      encoding.writeVarUint8Array(
        awarenessEncoder,
        awarenessProtocol.encodeAwarenessUpdate(
          this.awareness,
          Array.from(awarenessStates.keys()),
        ),
      );
      server.send(encoding.toUint8Array(awarenessEncoder));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // -------------------------------------------------------------------------
  // Ingest helpers (shared by /restore-orphans and /ingest-sync)
  // -------------------------------------------------------------------------

  /**
   * Bind this.projectId from the HMAC-verified X-Internal-Project header when
   * the DO woke with no live sockets (the constructor only restores projectId
   * from socket attachments). Without this, ensureDocLoaded and snapshotToD1
   * both early-return on the null projectId and an ingest would mutate an
   * UNLOADED doc, report success, and persist nothing — while polluting the
   * in-memory doc with entries the next blob load would merge on top of.
   * Must be called AFTER verifyInternalMarker (the header is signed).
   * Returns an error Response on a malformed or mismatched header, else null.
   *
   * Memory is assigned first and the durable binding awaited after it, so a
   * route reaching an object with no identity leaves one behind for the alarms
   * that follow it.
   */
  private async bindProjectIdFromMarker(request: Request): Promise<Response | null> {
    const markerProjectId = Number(request.headers.get("X-Internal-Project"));
    if (!Number.isInteger(markerProjectId) || markerProjectId <= 0) {
      return new Response("Invalid project marker", { status: 400 });
    }
    if (this.projectId === null) {
      this.projectId = markerProjectId;
    } else if (this.projectId !== markerProjectId) {
      // idFromName(projectId) makes this unreachable in practice; refuse
      // rather than write one project's data under another's id.
      return new Response("Project marker mismatch", { status: 409 });
    }
    await this.bindIdentity();
    return null;
  }

  /**
   * Record at one storage key which project this object is, and answer whether
   * the binding stands.
   *
   * The value is the id memory already holds, which every caller has verified —
   * a socket attachment, an authenticated admission, or a signed marker — so
   * this establishes nothing of its own and refuses anything outside the
   * domain. A put is issued only while this instance has no proof the key
   * already carries this id, so re-binding the same value costs nothing, and a
   * put that fails leaves the binding unmade rather than claimed: the next
   * binding path and the next alarm's preflight both try again, and the work
   * that needs a row without a socket waits until one of them lands.
   */
  private async bindIdentity(): Promise<boolean> {
    const id = this.projectId;
    if (!isProjectId(id)) return false;
    if (this.identityBound === id) return true;
    try {
      await this.storage().put(PROJECT_ID_KEY, id);
    } catch (err) {
      console.error(
        `[persistence][identity] project ${id}: the durable binding was not written`,
        err,
      );
      return false;
    }
    this.identityBound = id;
    return true;
  }

  /**
   * Make the identity available to an alarm, and answer whether it is.
   *
   * Three states, in the order they are cheapest to settle: a binding this
   * instance has already made needs nothing; an id in memory with the binding
   * unmade is a failed put to try again, and memory being non-null never skips
   * it; and no id at all is what a socketless wake holds, which is the one case
   * that pays for a read. A stored value outside the domain is damage and reads
   * as absent — an instance that cannot name its project runs the maintenance
   * storage alone answers for, and says so once.
   *
   * A retry that fails again is REJECTED rather than merely unnamed: the id is
   * known and the durable binding is what storage refused, so the turn is a
   * refused one and the next alarm comes at the full interval.
   */
  private async restoreIdentity(): Promise<IdentityState> {
    if (this.identityBound !== null) return { named: true, rejected: false };
    if (this.projectId !== null) {
      const bound = await this.bindIdentity();
      return { named: bound, rejected: !bound };
    }
    const stored = await this.storage().get<unknown>(PROJECT_ID_KEY);
    if (isProjectId(stored)) {
      this.projectId = stored;
      this.identityBound = stored;
      return { named: true, rejected: false };
    }
    if (!this.identityUnknownStated) {
      this.identityUnknownStated = true;
      console.error(
        `[persistence][identity] an alarm woke with no project to name ` +
        `(the stored binding is ${stored === undefined ? "absent" : "malformed"}); ` +
        `maintenance runs and the row is not consulted`,
      );
    }
    return { named: false, rejected: false };
  }

  /**
   * POST /reset — destroy the in-memory Y.Doc, rebuild it from the D1 entity
   * rows, replace the row's base with it in one conditioned write, and close
   * all connected sockets so clients reconnect with clean state. It is the one
   * recovery from a refused write fence and from a durable halt.
   *
   * Authorisation is the application's: the convenor check is `requireOwner` in
   * the route that sends this request. What this route establishes is that the
   * request came from the application at all — a signed internal marker, so the
   * object cannot be reached directly from outside.
   */
  private async handleReset(request: Request, url: URL): Promise<Response> {
    // The preconditions are read before the signature, because the binding
    // they produce is what the signature is checked against: a query no
    // guard can be derived from has no message to verify, and the one thing
    // it must never become is an unguarded reset.
    const guards = readResetGuards(url);
    if (guards === null) return new Response("bad_reset_precondition", { status: 400 });
    // The marker the sending route mints travels in the X-Internal-Auth /
    // X-Internal-Timestamp / X-Internal-Project headers; a reach that carries
    // none is refused with 401. The binding travels in the marker's optional
    // field, so adding, removing or changing a precondition without re-signing
    // recomputes to a different message and is refused.
    const markerError = await verifyInternalMarker(
      request,
      this.env.SESSION_SECRET,
      "reset",
      guards.binding,
    );
    if (markerError) return markerError;
    // The instance only ever learns its project id from a live socket
    // attachment, so an evicted one has none — and an evicted one is exactly
    // what a project whose persistence has halted is likely to be by the time
    // its convenor asks for the reset. Every step below needs that id, so it is
    // bound from the signed marker before any of them runs.
    const bindError = await this.bindProjectIdFromMarker(request);
    if (bindError) return bindError;

    return await this.runReset(guards);
  }

  /**
   * Replace a Y.Text value in place (delete + insert) so bound editors merge
   * the new value live and instance identity is preserved. Defensive: when the
   * key is absent or not a Y.Text (an older blob predating the field), set a
   * fresh Y.Text — matching the buildFromD1Rows type for these keys.
   */
  /**
   * Move each insert the snapshot could not land from `applied` into `failed`.
   *
   * `applied` is counted while the document is mutated, which makes it a claim
   * about the DOCUMENT. What the caller is told is a claim about D1, and the
   * two part company at `insertRow`: a refused INSERT is swallowed as
   * `{id: 0}` and the snapshot carries on — deliberately, since a snapshot
   * must not abort mid-flush — so `applied.pageInsert: 1` could come back with
   * no `project_pages` row behind it. The defect is the reporting, not the
   * swallow.
   *
   * So the truth is established from D1's own answer, after the flush: a
   * successful INSERT backfills its `last_row_id` onto the Y.Map, and a
   * refused one leaves `_id` exactly as `buildPageYMap` and its siblings set
   * it — null. Reading the receipt costs nothing and needs no second D1 read.
   *
   * One null does not mean a refusal, though: a row D1 committed whose `_id`
   * backfill threw carries the same null. The snapshot's ledger settles that
   * case, and only that case — see the check below.
   *
   * Only the three arms that push a Y.Map with a null `_id` are checked.
   * Story inserts carry an existing id (`carryExistingId` / `adoptId`), which
   * routes the snapshot onto its UPDATE branch, so `_id` there says nothing
   * about whether a row was written.
   */
  private recordInsertReceipts(
    receipts: Array<{ bucket: "objectInsert" | "glossaryInsert" | "pageInsert"; key: string; map: Y.Map<unknown> }>,
    applied: { objectInsert: number; glossaryInsert: number; pageInsert: number },
    failed: { objectInsert: string[]; glossaryInsert: string[]; pageInsert: string[] },
  ): void {
    for (const { bucket, key, map } of receipts) {
      const id = map.get("_id");
      if (typeof id === "number" && id > 0) continue;
      // A committed row whose `_id` backfill threw leaves exactly the null a
      // refusal leaves, and the caller's remedy for a refusal is to register
      // the object again — which UNIQUE (project_id, object_id) refuses
      // against the row already committed, so the object would be reported
      // failed on every retry. The snapshot's own ledger is the only thing
      // that can tell the two apart.
      if (
        this.snapshotInsertFailures.some(
          (f) => f.kind === "backfill" && f.table === RECEIPT_TABLES[bucket] && f.key === key,
        )
      ) {
        continue;
      }
      failed[bucket].push(key);
      applied[bucket] -= 1;
      console.warn(
        `[ingest-sync] project ${this.projectId}: ${bucket} "${key}" was applied to the ` +
        "document but its INSERT did not land in D1",
      );
    }
  }

  /**
   * Replace the text at `key` with `value`.
   *
   * The precondition is checked BEFORE anything is deleted. Replacing in place
   * is a delete followed by an insert, so a non-string reaching the insert
   * leaves the key holding an emptied `Y.Text` and throws inside the
   * transaction: earlier writes stand, the old text is gone, and the route
   * answers 503. The boundary means no caller can arrive with one; the check is
   * what makes that a guarantee about this method rather than about its
   * callers, and its message names the key and the type and never the value.
   */
  private replaceYText(map: Y.Map<unknown>, key: string, value: string): void {
    if (typeof value !== "string") {
      throw new TypeError(`replaceYText: ${key} holds a ${typeNameOf(value)}, not a string`);
    }
    const cur = map.get(key);
    if (cur instanceof Y.Text) {
      cur.delete(0, cur.length);
      if (value.length > 0) cur.insert(0, value);
    } else {
      map.set(key, new Y.Text(value));
    }
  }

  /**
   * Replace the text at `key` only where the payload states one.
   *
   * An absent optional field is not an empty value: the field's meaning is that
   * the caller says nothing about it, and the document's own text is what the
   * project holds. Writing "" for it would clear a title on every partial
   * update.
   */
  private replaceStatedYText(map: Y.Map<unknown>, key: string, value: string | undefined): void {
    if (value === undefined) return;
    this.replaceYText(map, key, value);
  }

  /** Set the scalar at `key` only where the payload states one. */
  private setStatedValue(map: Y.Map<unknown>, key: string, value: unknown): void {
    if (value === undefined) return;
    map.set(key, value);
  }

  /**
   * Whether an entity the document already holds is still waiting for the D1
   * row that would give it an id.
   *
   * The ingest's insert arms answer "already there" from the document, which is
   * evidence about D1 only once the entity carries the `_id` a landed INSERT
   * backfills. A held map with a null `_id` is a registration whose INSERT did
   * not land: reporting it as present would let a retry answer success for a
   * row that still does not exist, and — since the re-registration takes no
   * receipt — would leave a second failure with nothing to be reported through.
   */
  private awaitingItsRow(map: Y.Map<unknown>): boolean {
    const id = map.get("_id");
    return !(typeof id === "number" && id > 0);
  }

  /**
   * Index of the first Y.Map in `array` whose `key` equals `value`; -1 if none.
   *
   * A position holding plain JSON is not a Y.Map and has no `.get`, so it is
   * passed over rather than searched — the same reading the caller already
   * takes of an entry whose key does not match. The comparison itself is
   * `===` against a string, which no document value can make throw.
   */
  private indexByKey(array: Y.Array<Y.Map<unknown>>, key: string, value: string): number {
    for (let i = 0; i < array.length; i++) {
      const member = array.get(i);
      if (member instanceof Y.Map && member.get(key) === value) return i;
    }
    return -1;
  }

  /** Index of the first Y.Map in `array` holding `value` at `key` and `id` at `_id`, or -1. */
  private indexByKeyAndId(
    array: Y.Array<Y.Map<unknown>>,
    key: string,
    value: string,
    id: number,
  ): number {
    for (let i = 0; i < array.length; i++) {
      const member = array.get(i);
      if (member instanceof Y.Map && member.get(key) === value && member.get("_id") === id) return i;
    }
    return -1;
  }

  /**
   * One accepted `objects.update` entry written onto its Y.Map: each listed
   * field by its representation, unlisted field keys ignored (never set from
   * the wire), and the key respelled where the entry carries `renameTo`.
   */
  private applyObjectUpdate(
    m: Y.Map<unknown>,
    upd: { fields?: Partial<Record<IngestObjectField, string | boolean | null>>; renameTo?: string },
  ): void {
    for (const [field, value] of Object.entries(upd.fields ?? {})) {
      if (OBJECT_YTEXT_FIELDS.has(field)) {
        this.replaceYText(m, field, String(value ?? ""));
      } else if (OBJECT_BOOL_FIELDS.has(field)) {
        m.set(field, Boolean(value));
      } else if (OBJECT_PLAIN_FIELDS.has(field)) {
        // `extra_columns` included: the arrival fold (`attachDocHandlers`)
        // writes it into the custom-field map column by column.
        m.set(field, String(value ?? ""));
      }
    }
    if (upd.renameTo !== undefined) m.set("object_id", upd.renameTo);
  }

  /**
   * The Y.Map one `objects.update` entry applies to, or why there is none. An
   * entry naming a D1 id applies only to the Y.Map holding both that key and
   * that id; one holding the key under another id is an object re-created
   * since the author reviewed the change, and is left alone (`superseded`).
   * Without a `docId`, the first Y.Map holding the key. No Y.Map holding the
   * key at all is `absent`.
   */
  private updatedObject(
    objectsArray: Y.Array<Y.Map<unknown>>,
    entry: { objectId: string; docId?: number },
  ): { map: Y.Map<unknown>; missed?: undefined } | { map: null; missed: "absent" | "superseded" } {
    const idx = entry.docId === undefined
      ? this.indexByKey(objectsArray, "object_id", entry.objectId)
      : this.indexByKeyAndId(objectsArray, "object_id", entry.objectId, entry.docId);
    if (idx >= 0) return { map: objectsArray.get(idx) };
    const held = this.indexByKey(objectsArray, "object_id", entry.objectId) >= 0;
    return { map: null, missed: held ? "superseded" : "absent" };
  }

  /**
   * Apply one `objects.remove` entry to the document, and say what it met.
   *
   * An entry naming a D1 id removes only the Y.Map holding both that key and
   * that id; one holding the key under another id is an object re-created
   * since, and is left alone. A course item is never removable through the
   * ingest: it belongs to the course, and until the group's first publish it
   * is absent from objects.csv, so a routine full sync would otherwise offer
   * to delete every preloaded object at once.
   */
  private removeIngestedObject(
    objectsArray: Y.Array<Y.Map<unknown>>,
    entry: string | IngestObjectRemove,
  ): { kind: "applied" | "absent" | "superseded" | "course"; objectId: string } {
    const objectId = removeEntryIdentity(entry) as string;
    const idx = typeof entry === "string"
      ? this.indexByKey(objectsArray, "object_id", objectId)
      : this.indexByKeyAndId(objectsArray, "object_id", objectId, entry.docId);
    if (idx < 0) {
      const held = this.indexByKey(objectsArray, "object_id", objectId) >= 0;
      return { kind: held ? "superseded" : "absent", objectId };
    }
    if (courseMarkerBind(objectsArray.get(idx)) !== null) return { kind: "course", objectId };
    objectsArray.delete(idx, 1);
    return { kind: "applied", objectId };
  }

  /**
   * Drop from the object arms every entry operation `opId` has already
   * settled, naming each in `receipted`. True when the delivery is settled
   * whole: a receipt exists, nothing is left to apply, and no entry was
   * refused — a refused entry is never settled, and answering its operation as
   * done would let the caller forget an object D1 never held.
   */
  private async dropSettledEntries(
    opId: number | undefined,
    inserts: { accepted: IngestObjectInsert[] },
    removes: { accepted: Array<string | IngestObjectRemove> },
    refused: { objectInsert: number[]; objectRemove: number[] },
    receipted: ReceiptedEntries,
  ): Promise<boolean> {
    if (opId === undefined) return false;
    const receipt = await this.readIngestReceipt(opId);
    if (receipt === null) return false;
    const settledInsert = new Set(receipt.inserted);
    const settledRemove = new Set(receipt.removed);
    receipted.objectInsert = inserts.accepted.map((i) => i.object_id).filter((id) => settledInsert.has(id));
    receipted.objectRemove = removes.accepted
      .map((e) => removeEntryIdentity(e) as string)
      .filter((id) => settledRemove.has(id));
    inserts.accepted = inserts.accepted.filter((i) => !settledInsert.has(i.object_id));
    removes.accepted = removes.accepted.filter((e) => !settledRemove.has(removeEntryIdentity(e) as string));
    const nothingLeft = inserts.accepted.length === 0 && removes.accepted.length === 0;
    return nothingLeft && refused.objectInsert.length === 0 && refused.objectRemove.length === 0;
  }

  /** Operation `opId`'s receipt, or null when it has none. */
  private async readIngestReceipt(opId: number): Promise<IngestReceipt | null> {
    const stored = await this.storage().get<unknown>(`${INGEST_RECEIPT_PREFIX}${opId}`);
    if (typeof stored !== "object" || stored === null) return null;
    const { inserted, removed, renamed } = stored as Partial<IngestReceipt>;
    return {
      inserted: Array.isArray(inserted) ? inserted : [],
      removed: Array.isArray(removed) ? removed : [],
      renamed: Array.isArray(renamed) ? renamed : [],
    };
  }

  /**
   * Receipt, for operation `opId`, exactly the objects of this delivery that D1
   * holds as intended, and fail the delivery for any it does not.
   *
   * Completeness: every object insert and every docId removal this delivery
   * attempted ends in exactly one of three states, and none reaches a 200
   * unaccounted for.
   *   - Receipted, when D1 verifies it by an identity this DO produced: an
   *     insert whose row is there under its object_id with the id its Y.Map
   *     carries or, failing that, the id this flush's INSERT returned for that
   *     map (a backfill can throw over a committed row); a removal whose D1 id
   *     is gone. The key alone is never identity: `objects` has no unique
   *     index on (project_id, object_id), and a failed flush can leave a
   *     same-key row that is not this delivery's.
   *   - Reported refused, by the ingest's own `refused` or `courseRefused`,
   *     which never reach this function; and a removal of a course item, which
   *     is answered as such and stays.
   *   - Neither, and the delivery fails with the retryable 503, so the caller
   *     keeps its record and a later delivery tries it again. A map carrying a
   *     stale id whose reinsert D1 keeps refusing therefore fails completion,
   *     where it can be seen, rather than being answered as done.
   * A bare-key removal names no D1 id: it is never receipted and is answered
   * as today.
   *
   * Neither the flush's answer nor the ingest's classification is evidence: a
   * flush can fail after rows persisted, and a Y.Map restored after its row was
   * deleted still carries that row's id.
   *
   * Answers the error when D1 cannot be read or the receipt cannot be written,
   * and the request fails. That is the one residual window: an object that
   * persisted in this delivery goes unreceipted, and if it is deleted before
   * the retry, the retry brings it back. A failed read cannot tell which
   * objects landed, so nothing is receipted rather than a guess.
   */
  /**
   * Each candidate story reported as its outcome only when D1 holds the
   * incoming content, and as failed otherwise.
   *
   * Complete for this reason. The accept advances head_sha only when every
   * story it sent is reported applied or already applied, so those two
   * reports are the only ones that must never be wrong, and each is made
   * here and nowhere else. It is made from D1, read after the flush attempt
   * whatever that attempt returned: the flush answers true around rows its
   * INSERTs could not write (`snapshotInsertFailures`), and a replay finds the
   * content in the live document whether or not it ever reached D1, so
   * neither the flush's answer nor the document is evidence. The read is the
   * story's rows by its project and story id, steps and layers in `order_key`
   * order through `contentFromRows`, the form the check hashes D1 with, so a
   * D1 story equal to the incoming content has the incoming content's hash
   * and any missing, extra or different step or layer changes it. A story id
   * with other than one row, rows the canonical form cannot read, or a read
   * that fails, is failed. Runs inside the gate, so no delivery writes the
   * document or D1 between the flush and the read.
   */
  private async settleContent(candidates: readonly ContentCandidate[], content: ContentOutcome): Promise<void> {
    for (const candidate of candidates) {
      let persisted = false;
      try {
        persisted = (await this.persistedContentHash(candidate.storyId)) === candidate.incomingHash;
      } catch (err) {
        console.error(`[ingest-sync] project ${this.projectId}: story "${candidate.storyId}" content not read back`, err);
      }
      (persisted ? content[candidate.outcome] : content.failed).push(candidate.storyId);
    }
  }

  /** The raw canonical hash of a story's content as D1 holds it, or null when it cannot be told. */
  private async persistedContentHash(storyId: string): Promise<string | null> {
    const stories = await this.env.DB
      .prepare("SELECT id FROM stories WHERE project_id = ? AND story_id = ?")
      .bind(this.projectId, storyId)
      .all<{ id: number }>();
    if (stories.results.length !== 1) return null;
    const id = stories.results[0].id;
    const [steps, layers] = await Promise.all([
      this.env.DB.prepare("SELECT * FROM steps WHERE story_id = ?").bind(id).all<ContentStepRow>(),
      this.env.DB
        .prepare("SELECT * FROM layers WHERE step_id IN (SELECT id FROM steps WHERE story_id = ?)")
        .bind(id)
        .all<ContentLayerRow>(),
    ]);
    const raw = await canonicalRaw(contentFromRows(steps.results, layers.results));
    return raw.readable ? raw.hash : null;
  }

  private async settlePersistedEntries(
    opId: number | undefined,
    receipts: Array<{ bucket: string; key: string; map: Y.Map<unknown> }>,
    heldInserts: Array<{ key: string; map: Y.Map<unknown> }>,
    removes: Array<string | IngestObjectRemove>,
    courseRemovals: string[],
  ): Promise<unknown> {
    if (opId === undefined) return undefined;
    const inserts = [...receipts.filter((r) => r.bucket === "objectInsert"), ...heldInserts];
    const docRemoves = removes.filter(
      (e): e is IngestObjectRemove => typeof e !== "string" && !courseRemovals.includes(e.objectId),
    );
    if (inserts.length === 0 && docRemoves.length === 0) return undefined;
    try {
      const rows = await this.readPersistedObjects();
      const keyById = new Map(rows.map((row) => [row.id, row.object_id]));
      const persisted = (c: { key: string; map: Y.Map<unknown> }) =>
        keyById.get(c.map.get("_id") as number) === c.key ||
        keyById.get(this.objectInsertIds.get(c.map) as number) === c.key;
      const inserted = inserts.filter(persisted).map((c) => c.key);
      const removed = docRemoves.filter((e) => !keyById.has(e.docId)).map((e) => e.objectId);
      await this.recordIngestReceipt(opId, { inserted, removed, renamed: [] });
      const unsettled = inserts.length + docRemoves.length - inserted.length - removed.length;
      if (unsettled === 0) return undefined;
      return new Error(`${unsettled} object(s) of operation ${opId} not in D1 as intended`);
    } catch (err) {
      console.error(`[ingest-sync] project ${this.projectId}: operation ${opId} not receipted`, err);
      return err;
    }
  }

  /**
   * An `/ingest-sync` request's body and operation id, or the answer that
   * ends it: the 400 `readIngestBody` refuses with, or, for a body carrying
   * `objects.rename`, that arm's own answer (`ingestObjectRename`).
   */
  private async readIngestBodyOrRename(
    request: Request,
  ): Promise<{ payload: SyncIngestPayload; opId: number | undefined } | Response> {
    const body = await readIngestBody(request);
    if (body instanceof Response) return body;
    const rename = body.payload.objects?.rename;
    if (rename === undefined || body.opId === undefined) return body;
    return this.ingestObjectRename(rename, body.opId);
  }

  /**
   * `/ingest-sync` carrying `objects.rename`, which travels alone with its
   * record's operation id (see `workers/object-rename.ts`).
   *
   * Inside the gate: entries the operation's receipt already names are
   * answered from it; the rest are applied in one transaction under the
   * runtime's null origin, against the D1 keys read just before it; then the
   * flush, and the receipt earned from D1 read after the flush attempt,
   * whatever it returned. An entry the document holds renamed that D1 does not
   * show under its row id fails the delivery with the retryable 503.
   */
  private async ingestObjectRename(raw: unknown, opId: number): Promise<Response> {
    const { accepted, refused } = partitionObjectRenameArm(raw);
    if (refused.length > 0) {
      console.error(`[ingest-sync] project ${this.projectId}: refused rename entries at ${JSON.stringify(refused)}`);
    }
    while (this.isSnapshotting) await new Promise((r) => setTimeout(r, 25));
    const delivery: ObjectRenameDelivery = {
      state: "attempted", outcome: emptyObjectRenameOutcome(), receipted: [], flushed: false, failure: undefined,
    };
    await this.ctx.blockConcurrencyWhile(async () => {
      try {
        await this.runObjectRename(accepted, opId, refused.length > 0, delivery);
      } catch (err) {
        delivery.failure = err;
      }
    });
    return this.answerObjectRename(delivery, refused);
  }

  /** The gated body of `ingestObjectRename`; fills `delivery`. */
  private async runObjectRename(
    entries: IngestObjectRename[],
    opId: number,
    anyRefused: boolean,
    delivery: ObjectRenameDelivery,
  ): Promise<void> {
    const receipt = await this.readIngestReceipt(opId);
    const { remaining, receipted } = unreceiptedRenames(entries, receipt?.renamed ?? []);
    delivery.receipted = receipted;
    if (receipted.length > 0 && remaining.length === 0 && !anyRefused) {
      delivery.state = "alreadyApplied";
      return;
    }
    await this.ensureDocLoaded();
    if (this.persistenceHalted !== null) {
      delivery.state = "fenceBlocked";
      return;
    }
    const d1Keys = new Set((await this.readPersistedObjects()).map((row) => row.object_id));
    try {
      this.ydoc.transact(() => {
        for (const entry of remaining) applyObjectRename(this.ydoc, entry, d1Keys, delivery.outcome);
      });
      delivery.flushed = await this.flushSnapshotNow();
    } catch (err) {
      delivery.failure = err;
    }
    // Whether the flush succeeded or not: a flush can fail after rows
    // persisted, so the receipt is earned from what D1 holds.
    const unsettled = await this.settleObjectRenames(opId, remaining, delivery.outcome);
    delivery.failure ??= unsettled;
  }

  /** Receipt the renames D1 shows; the error that fails the delivery when any it does not. */
  private async settleObjectRenames(
    opId: number,
    entries: IngestObjectRename[],
    outcome: ObjectRenameOutcome,
  ): Promise<unknown> {
    try {
      const { renamed, unsettled } = settledRenames(entries, outcome, await this.readPersistedObjects());
      await this.recordIngestReceipt(opId, { inserted: [], removed: [], renamed });
      if (unsettled === 0) return undefined;
      return new Error(`${unsettled} rename(s) of operation ${opId} not in D1 as intended`);
    } catch (err) {
      console.error(`[ingest-sync] project ${this.projectId}: rename operation ${opId} not receipted`, err);
      return err;
    }
  }

  private answerObjectRename(delivery: ObjectRenameDelivery, refused: number[]): Response {
    const body = {
      renames: delivery.outcome,
      refused: { objectRename: refused },
      receipted: { objectRename: delivery.receipted },
    };
    if (delivery.state === "alreadyApplied") return Response.json({ alreadyApplied: true, ...body });
    if (delivery.state === "fenceBlocked" || this.persistenceHalted !== null) return this.answerHalted();
    if (delivery.failure !== undefined) {
      if (!isNamedPersistenceRefusal(delivery.failure)) {
        console.error(`[ingest-sync] project ${this.projectId}: rename failed`, delivery.failure);
      }
      return new Response("snapshot_failed", { status: 503 });
    }
    if (!delivery.flushed) return new Response("snapshot_blocked", { status: 503 });
    this.broadcastDocument();
    return Response.json(body);
  }

  /** The project's object rows as D1 holds them: id and object_id. */
  private async readPersistedObjects(): Promise<Array<{ id: number; object_id: string }>> {
    const rows = await this.env.DB
      .prepare("SELECT id, object_id FROM objects WHERE project_id = ?")
      .bind(this.projectId)
      .all<{ id: number; object_id: string }>();
    return rows.results;
  }

  /** Add the objects `settled` names to operation `opId`'s receipt, then prune. */
  private async recordIngestReceipt(
    opId: number,
    settled: IngestReceipt,
  ): Promise<void> {
    if (settled.inserted.length === 0 && settled.removed.length === 0 && settled.renamed.length === 0) return;
    const held = (await this.readIngestReceipt(opId)) ?? { inserted: [], removed: [], renamed: [] };
    await this.storage().put(`${INGEST_RECEIPT_PREFIX}${opId}`, {
      inserted: [...new Set([...held.inserted, ...settled.inserted])],
      removed: [...new Set([...held.removed, ...settled.removed])],
      renamed: [...new Set([...held.renamed, ...settled.renamed])],
    });
    await this.pruneIngestReceipts();
  }

  /**
   * Forget the receipts of operations that are finished, once more than
   * `INGEST_RECEIPT_PRUNE_AT` are held.
   *
   * A receipt is needed exactly while its operation's `pending_object_ops` row
   * exists, and this is complete for that reason. A receipt is consulted only
   * by an ingest carrying its operation id. Every such ingest is sent by a
   * holder of a lease that excludes every other objects operation on the
   * project, after reading the row as present, and the row is deleted only
   * after that ingest has answered, by that same holder. Row ids are never
   * reused. So once a row is gone no ingest carrying its id is still to come,
   * except from a holder whose lease ran out mid-operation, which nothing here
   * can rule out. A read that fails prunes nothing.
   */
  private async pruneIngestReceipts(): Promise<void> {
    const held = await this.storage().list<unknown>({ prefix: INGEST_RECEIPT_PREFIX });
    if (held.size <= INGEST_RECEIPT_PRUNE_AT) return;
    let live: Set<number>;
    try {
      const rows = await this.env.DB
        .prepare("SELECT id FROM pending_object_ops WHERE project_id = ?")
        .bind(this.projectId)
        .all<{ id: number }>();
      live = new Set(rows.results.map((row) => row.id));
    } catch (err) {
      console.error(`[ingest-sync] project ${this.projectId}: receipts not pruned`, err);
      return;
    }
    const finished = [...held.keys()].filter(
      (key) => !live.has(Number(key.slice(INGEST_RECEIPT_PREFIX.length))),
    );
    // Storage deletes at most 128 keys a call.
    for (let at = 0; at < finished.length; at += 128) {
      await this.storage().delete(finished.slice(at, at + 128));
    }
  }

  /** The first Y.Map in `array` whose `key` equals `value`, or null. */
  private findByKey(
    array: Y.Array<Y.Map<unknown>>,
    key: string,
    value: string,
  ): Y.Map<unknown> | null {
    const idx = this.indexByKey(array, key, value);
    return idx < 0 ? null : array.get(idx);
  }

  /**
   * Build one object Y.Map (_id = null) from `objectInsertValues`, mirroring
   * the buildFromD1Rows object shape — Y.Text for the editable text fields,
   * plain strings for the import passthroughs, booleans for
   * featured/image_available.
   *
   * Two keys are set only when the payload asks for them, because their absence
   * is meaningful: origin is carried only for "compositor" and "repo" (anything
   * else is left to the snapshot INSERT's "iiif" default), and an absent
   * course_project_id is what "the site made this object" means.
   */
  private buildObjectYMap(p: IngestObjectInsert, orderKey: string): Y.Map<unknown> {
    const m = new Y.Map<unknown>();
    m.set("_id", null);
    m.set(ORDER_KEY, orderKey);
    for (const [field, value] of objectInsertValues(p)) m.set(field, objectInsertYValue(field, value));
    applyCustomBlob(m, p.extra_columns ?? "");
    return m;
  }

  /**
   * Build one page Y.Map (_id = null) mirroring the buildFromD1Rows page shape —
   * Y.Text for title and body so a bound editor merges live, a plain string
   * slug, and the caller's order_key.
   *
   * `_id` is null because the row does not exist yet: the snapshot's INSERT
   * mints it and backfills it here. That is the point of the arm — the page
   * reaches D1 through the snapshot pipeline and nowhere else.
   */
  private buildPageYMap(p: IngestPageInsert, orderKey: string): Y.Map<unknown> {
    const m = new Y.Map<unknown>();
    m.set("_id", null);
    m.set(ORDER_KEY, orderKey);
    m.set("slug", p.slug);
    m.set("title", new Y.Text(p.title ?? ""));
    m.set("body", new Y.Text(p.body ?? ""));
    m.set("frontmatter", p.frontmatter ?? null);
    m.set("created_by", p.created_by ?? null);
    return m;
  }

  /**
   * Each `stories.replaceContent` entry checked against the live story and,
   * where it may apply, planned. Otherwise:
   * - the live story's raw canonical hash equals the incoming content's: the
   *   content is already there, so a replay of an applied entry is a no-op,
   *   a candidate for `alreadyApplied` that `settleContent` reports only once
   *   D1 shows it;
   * - it differs from `expected`, the Compositor's version the author
   *   reviewed: refused whole as changed since review. This catches an edit
   *   made after the check and one not yet snapshotted when it ran, since the
   *   hash is of the live maps;
   * - no such story, or maps or a payload the canonical form cannot read:
   *   failed.
   * The live hash takes the steps and layers in `order_key` order with ranks
   * for their numbers (`liveStoryContent`), as `rawCanonicalFromD1` does on
   * D1's rows, so an untouched story hashes the same on both sides.
   */
  private async planContentReplacements(
    storiesArray: Y.Array<Y.Map<unknown>>,
    entries: readonly IngestReplaceContent[],
    outcome: ContentOutcome,
    candidates: ContentCandidate[],
  ): Promise<ContentReplacement[]> {
    const plans: ContentReplacement[] = [];
    for (const entry of entries) {
      const story = this.findByKey(storiesArray, "story_id", entry.storyId);
      const live = story ? liveStoryContent(story) : null;
      const incomingLayers = layersByStep(entry);
      const [liveCanon, incomingCanon] = await Promise.all([
        live ? canonicalRaw(contentInOrder(live.content)) : null,
        canonicalRaw(contentInOrder(entry.steps.map((step, i) => ({ ...incomingStepFields(step), layers: incomingLayers[i] })))),
      ]);
      if (!story || !live || !liveCanon?.readable || !incomingCanon.readable) {
        outcome.failed.push(entry.storyId);
        continue;
      }
      if (liveCanon.hash === incomingCanon.hash) {
        candidates.push({ storyId: entry.storyId, incomingHash: incomingCanon.hash, outcome: "alreadyApplied" });
        continue;
      }
      if (liveCanon.hash !== entry.expected) {
        outcome.changedSinceReview.push(entry.storyId);
        continue;
      }
      plans.push({
        entry, incomingHash: incomingCanon.hash, story, stepsArray: live.stepsArray, liveSteps: live.maps,
        liveCanon: liveCanon.steps, incomingCanon: incomingCanon.steps, incomingLayers,
      });
    }
    return plans;
  }

  /**
   * Each `steps.captureKeptColumns` entry checked against the live story and,
   * where it may apply, planned. The live story's raw canonical hash, taken as
   * `planContentReplacements` takes it, must equal `expected`: the publish
   * computed that from D1's rows after its forced snapshot, so an edit that
   * landed since is caught here and the story is `changed`. A story the
   * document does not hold, maps the canonical form cannot read, or a step id
   * the story does not hold is `missing`. Either way nothing of the entry is
   * written. So is an insert naming a step the story does not hold.
   */
  private async planKeptColumnsCaptures(
    storiesArray: Y.Array<Y.Map<unknown>>,
    entries: readonly IngestCaptureKeptColumns[],
    outcome: KeptColumnsOutcome,
  ): Promise<KeptColumnsPlan[]> {
    const plans: KeptColumnsPlan[] = [];
    for (const entry of entries) {
      const story = this.findByKey(storiesArray, "story_id", entry.storyId);
      const live = story ? liveStoryContent(story) : null;
      const liveCanon = live ? await canonicalRaw(contentInOrder(live.content)) : null;
      if (!live || !liveCanon?.readable) {
        outcome.missing.push(entry.storyId);
        continue;
      }
      if (liveCanon.hash !== entry.expected) {
        outcome.changed.push(entry.storyId);
        continue;
      }
      const plan = keptColumnsPlan(entry, live.stepsArray, live.maps);
      if (plan === null) {
        outcome.missing.push(entry.storyId);
        continue;
      }
      plans.push(plan);
    }
    return plans;
  }

  /**
   * Each planned capture reported as captured only when D1, read after the
   * flush attempt, holds kept columns on every step it names: the value this
   * delivery wrote, or the one the step already recorded, which the fill left
   * alone. Otherwise, or when D1 cannot be read, failed. The flush's own answer
   * is not evidence, as `settleContent` states. Runs inside the gate.
   */
  private async settleKeptColumns(plans: readonly KeptColumnsPlan[], outcome: KeptColumnsOutcome): Promise<void> {
    for (const plan of plans) {
      let persisted = false;
      try {
        const rows = await Promise.all(plan.fills.map((fill) => this.storedKeptColumns(fill.stepId)));
        persisted = plan.fills.every((fill, i) => {
          const stored = rows[i];
          if (stored === null || keptColumnsNeverRecorded(stored)) return false;
          return stored === renderedValue(fill.map.get("extra_columns"));
        }) && await this.insertsPersisted(plan);
      } catch (err) {
        console.error(`[ingest-sync] project ${this.projectId}: story "${plan.storyId}" kept columns not read back`, err);
      }
      (persisted ? outcome.captured : outcome.failed).push(plan.storyId);
    }
  }

  /** A step row's `extra_columns` in D1, or null when it holds none or there is no such row. */
  private async storedKeptColumns(stepId: number): Promise<string | null> {
    const row = await this.env.DB.prepare("SELECT extra_columns FROM steps WHERE id = ?")
      .bind(stepId)
      .first<{ extra_columns: string | null }>();
    return row?.extra_columns ?? null;
  }

  /**
   * Whether every insert of the plan is in D1: the snapshot gave its map an
   * `_id`, and the row with that id holds the insert's kept cells.
   */
  private async insertsPersisted(plan: KeptColumnsPlan): Promise<boolean> {
    for (const insert of plan.inserts) {
      const id = readRowId(insert.map.get("_id"));
      if (!id.ok) return false;
      if ((await this.storedKeptColumns(id.value)) !== insert.extra_columns) return false;
    }
    return true;
  }

  /**
   * Replace a story's steps and layers with the planned incoming content,
   * aligned by content (`alignByContent`): a step the same on both sides
   * keeps its map, and so its D1 id and authorship; a step paired between two
   * such is updated in place; the rest are inserted or removed. Each updated
   * step's layers are aligned the same way. Then every step's and layer's
   * `order_key` is minted in the accepted sequence, each after the one before,
   * as `buildStoryYMap` mints an ingested story's, with its number
   * set to its rank, so the order reviewed is the order stored.
   *
   * Runs inside the caller's transaction.
   */
  private applyContentReplacement(plan: ContentReplacement): void {
    const { entry, stepsArray, liveSteps, liveCanon, incomingCanon, incomingLayers } = plan;
    const stepContent = (step: CanonicalStep) => JSON.stringify(step);
    const { sequence, removed } = alignByContent(liveCanon.map(stepContent), incomingCanon.map(stepContent));
    const accepted: Y.Map<unknown>[] = [];
    for (const aligned of sequence) {
      const step = entry.steps[aligned.incoming];
      if (aligned.kind === "keep") {
        accepted.push(liveSteps[aligned.existing]);
      } else if (aligned.kind === "update") {
        const map = liveSteps[aligned.existing];
        writeStepFields(map, step, (m, k, v) => this.replaceYText(m, k, v));
        this.replaceLayers(map, liveCanon[aligned.existing].layers, incomingCanon[aligned.incoming].layers, incomingLayers[aligned.incoming]);
        accepted.push(map);
      } else {
        const map = newStepMap(step, incomingLayers[aligned.incoming]);
        stepsArray.push([map]);
        accepted.push(map);
      }
    }
    removeMaps(stepsArray, removed.map((i) => liveSteps[i]));
    let previous: string | null = null;
    accepted.forEach((map, rank) => {
      previous = generateDistinctKeyBetween(previous, null);
      map.set(ORDER_KEY, previous);
      map.set("step_number", rank + 1);
      rekeyLayers(orderedEntries(map.get("layers")).maps);
    });
  }

  /** One step's layers replaced as `applyContentReplacement` replaces steps. */
  private replaceLayers(
    stepMap: Y.Map<unknown>,
    liveCanon: readonly CanonicalLayer[],
    incomingCanon: readonly CanonicalLayer[],
    incoming: readonly IngestLayer[],
  ): void {
    let layersArray = stepMap.get("layers");
    if (!(layersArray instanceof Y.Array)) {
      layersArray = new Y.Array<Y.Map<unknown>>();
      stepMap.set("layers", layersArray);
    }
    const array = layersArray as Y.Array<Y.Map<unknown>>;
    const liveLayers = orderedEntries(array).maps;
    // A layer's content without its number: the number is its rank, which an
    // inserted layer shifts for every layer after it.
    const layerContent = ({ layer_number: _rank, ...fields }: CanonicalLayer) => JSON.stringify(fields);
    const { sequence, removed } = alignByContent(liveCanon.map(layerContent), incomingCanon.map(layerContent));
    const accepted: Y.Map<unknown>[] = [];
    for (const aligned of sequence) {
      if (aligned.kind === "keep") {
        accepted.push(liveLayers[aligned.existing]);
      } else if (aligned.kind === "update") {
        const map = liveLayers[aligned.existing];
        for (const field of LAYER_TEXT_FIELDS) this.replaceYText(map, field, incoming[aligned.incoming][field] ?? "");
        accepted.push(map);
      } else {
        const map = newLayerMap(incoming[aligned.incoming]);
        array.push([map]);
        accepted.push(map);
      }
    }
    removeMaps(array, removed.map((i) => liveLayers[i]));
    rekeyLayers(accepted);
  }

  /**
   * Construct one story Y.Map (with nested steps and layers) and push it onto
   * the stories Y.Array, first removing any pre-existing entry with the same
   * story_id. Shared by /restore-orphans and /ingest-sync — they differ only in
   * the scalar defaults passed via `spec`. Must be called inside a
   * ydoc.transact; mutates the array in place.
   *
   * The same-story_id dedup runs first so a stale entry with an invalid _id
   * (pointing at a deleted D1 row) cannot win the snapshot's deduplicate pass
   * and strand the fresh _id = null Y.Map. Y.Text is used for the text fields to
   * match buildFromD1Rows, so bound editors merge live.
   */
  private buildStoryYMap(
    storiesArray: Y.Array<Y.Map<unknown>>,
    spec: {
      storyId: string;
      title: string;
      subtitle: string;
      byline: string;
      /** Where the story sorts — a fractional index, not a position. */
      orderKey: string;
      isPrivate: boolean;
      draft: boolean;
      showSections: boolean;
      steps: IngestStep[];
      layers: IngestLayer[];
      /**
       * Carry a replaced same-story_id entry's numeric _id onto the fresh map
       * (sync ingest). With _id = null the snapshot would INSERT while the old
       * row still exists — stories(project_id, story_id) is UNIQUE, so the
       * INSERT is rejected-and-swallowed and the batched orphan-DELETE then
       * removes the old row: the story vanishes from D1 until a later snapshot
       * re-inserts it. Carrying the id routes the snapshot onto its UPDATE
       * branch instead (row preserved, steps/layers replaced). Restore-orphans
       * must NOT carry: there the old _id points at a known-deleted D1 row.
       */
      carryExistingId?: boolean;
      /**
       * The id of the live D1 row that already owns this story_id, read from
       * D1 rather than from a Y.Map. Restore-orphans uses it: a story the
       * document has lost but D1 still holds is not a new row, and building it
       * with _id = null aims the same UNIQUE-refusal-then-orphan-DELETE at it
       * that `carryExistingId` exists to prevent. Takes precedence over the
       * carried id, D1 being the party that actually knows.
       */
      adoptId?: number | null;
    },
  ): void {
    // Walk in reverse so deletions don't shift indices we still need.
    let carriedId: number | null = null;
    for (let i = storiesArray.length - 1; i >= 0; i--) {
      const existing = storiesArray.get(i);
      if (!(existing instanceof Y.Map)) continue;
      if (existing.get("story_id") === spec.storyId) {
        if (spec.carryExistingId) {
          const existingId = existing.get("_id");
          if (typeof existingId === "number") carriedId = existingId;
        }
        storiesArray.delete(i, 1);
      }
    }

    const storyMap = new Y.Map<unknown>();
    storyMap.set("_id", spec.adoptId ?? carriedId);
    storyMap.set("story_id", spec.storyId);
    storyMap.set("title", new Y.Text(spec.title));
    storyMap.set("subtitle", new Y.Text(spec.subtitle));
    storyMap.set("byline", new Y.Text(spec.byline));
    storyMap.set(ORDER_KEY, spec.orderKey);
    storyMap.set("private", spec.isPrivate);
    storyMap.set("draft", spec.draft);
    storyMap.set("show_sections", spec.showSections);

    // Pre-allocate one layer Y.Array per step (indexed by the step's position)
    // so layers thread onto their parent without a second pass.
    const stepsArray = new Y.Array<Y.Map<unknown>>();
    const stepLayerArrays: Array<Y.Array<Y.Map<unknown>>> = [];
    let lastStepKey: string | null = null;
    const lastLayerKeyByStep: Array<string | null> = [];
    for (const step of spec.steps) {
      const stepMap = stepMapWithoutLayers(step);
      // stepsArray is not in a document yet, and Yjs reads a detached array as
      // empty, so the keys already given out cannot be read back from it. The
      // last key is carried here, and one per step for its layers below.
      lastStepKey = generateDistinctKeyBetween(lastStepKey, null);
      stepMap.set(ORDER_KEY, lastStepKey);
      const layersArr = new Y.Array<Y.Map<unknown>>();
      stepLayerArrays.push(layersArr);
      lastLayerKeyByStep.push(null);
      stepMap.set("layers", layersArr);
      stepsArray.push([stepMap]);
    }

    for (const layer of spec.layers) {
      const targetArr = stepLayerArrays[layer.step_index];
      if (!targetArr) continue; // out-of-range step_index — skip silently
      const layerMap = layerMapWithoutKey(layer);
      const nextLayerKey = generateDistinctKeyBetween(lastLayerKeyByStep[layer.step_index], null);
      lastLayerKeyByStep[layer.step_index] = nextLayerKey;
      layerMap.set(ORDER_KEY, nextLayerKey);
      targetArr.push([layerMap]);
    }

    storyMap.set("steps", stepsArray);
    storiesArray.push([storyMap]);
  }

  // -------------------------------------------------------------------------
  // WebSocket lifecycle handlers (hibernation API)
  // -------------------------------------------------------------------------

  /**
   * Forward an inbound sync packet to every other socket, unchanged.
   *
   * Synchronous by contract (F1): it runs in the same continuation as the apply
   * that precedes it, and a send that throws is a client that has gone.
   */
  private relaySync(from: WebSocket, data: Uint8Array): void {
    for (const client of this.ctx.getWebSockets()) {
      if (client !== from) {
        try {
          client.send(data);
        } catch {
          // Client may have disconnected
        }
      }
    }
  }

  /**
   * Report an inbound update addressed to a container the guard displaced.
   *
   * The measure is partial and says so in `displaced-edits.ts`; it carries no
   * user id and no values, only counts and the age of the displacement. Sync
   * step 2 is not instrumented: it carries a whole state rather than an edit.
   */
  private countDisplacedEdits(data: Uint8Array): void {
    if (this.displacements.size() === 0) return;
    const update = syncUpdateBytes(data);
    if (update === null) return;
    const hit = this.displacements.inspect(update);
    if (hit === null) return;
    console.warn(
      `[structural][orphaned-edit] project ${this.projectId}: ${hit.structs} struct(s), ` +
      `${hit.deletions} deletion range(s) addressed a container displaced ${hit.ageMs}ms ago`,
    );
  }

  /** The membership row admission and the recheck read. */
  private readMembershipRow(projectId: number, userId: number): Promise<{ role: string } | null> {
    return this.env.DB
      .prepare("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?")
      .bind(projectId, userId)
      .first<{ role: string }>();
  }

  /**
   * Whether `ws` may still act for its user. Membership is read at admission
   * and cached in the attachment; a removal reaches an open socket only as
   * `/notify-deleted`, which a caller can fail to send. So a message on a
   * socket last checked `MEMBERSHIP_RECHECK_MS` ago or more rereads the row
   * before it is processed, and a socket whose row is gone is removed.
   *
   * One read per socket at a time: a message arriving while one is in flight
   * waits for the same answer, and the waiters resume in the order they
   * arrived. A read that fails lets the message through until
   * `MEMBERSHIP_GRACE_MS` has passed since the last read that succeeded.
   */
  private socketStillMember(ws: WebSocket): Promise<boolean> | boolean {
    const inFlight = this.membershipChecks.get(ws);
    if (inFlight !== undefined) return inFlight;
    const attachment = readAttachment(ws);
    // A malformed attachment is the fences' to close, as before.
    if (attachment === null) return true;
    if (attachment.removed) return false;
    const startedAt = Date.now();
    const checkedAt = attachment.membershipCheckedAt;
    if (typeof checkedAt === "number" && startedAt - checkedAt < MEMBERSHIP_RECHECK_MS) return true;
    const check: Promise<boolean> = this.recheckMembership(ws, attachment, startedAt).finally(() => {
      if (this.membershipChecks.get(ws) === check) this.membershipChecks.delete(ws);
    });
    this.membershipChecks.set(ws, check);
    return check;
  }

  private async recheckMembership(ws: WebSocket, held: SocketAttachment, startedAt: number): Promise<boolean> {
    let row: { role: string } | null;
    try {
      row = await this.readMembershipRow(held.projectId, held.userId);
    } catch (err) {
      if (!socketStillOpen(ws)) return false;
      // An attachment from before the field existed has no last success; it
      // is given one now, still due, so its grace runs from here.
      const lastSuccess = held.membershipCheckedAt ?? startedAt - MEMBERSHIP_RECHECK_MS;
      if (startedAt - lastSuccess >= MEMBERSHIP_GRACE_MS) {
        closeSocket(ws, MEMBERSHIP_UNVERIFIED_CLOSE);
        return false;
      }
      console.warn(`[membership] project ${this.projectId}: the membership read failed`, err);
      if (held.membershipCheckedAt === undefined) this.mergeAttachment(ws, { membershipCheckedAt: lastSuccess });
      return true;
    }
    // Read again after the await: an eviction, a close or an awareness
    // takeover may have happened during it, and only the membership fields
    // are this check's.
    if (!socketStillOpen(ws)) return false;
    // An unknown role is refused as admission refuses it: can-delete would
    // read it as the internal origin.
    const role = row === null ? null : parseMemberRole(row.role);
    if (role === null) {
      removeSocket(ws, subRemovedFromProject, "removed_from_project");
      return false;
    }
    this.mergeAttachment(ws, { role, membershipCheckedAt: startedAt });
    return true;
  }

  /** Merge `fields` into the socket's current attachment. */
  private mergeAttachment(ws: WebSocket, fields: Partial<SocketAttachment>): void {
    const current = readAttachment(ws);
    if (current === null) return;
    try { ws.serializeAttachment({ ...current, ...fields }); } catch { /* socket may have disconnected */ }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Membership first, ahead of the flag below and every fence after it: the
    // read may await D1, and the flag is the object's, so an await after its
    // reset would let another socket's reverted message suppress this relay.
    if (!(await this.socketStillMember(ws))) return;

    // Reset here, at the handler's own entry, and cleared by the `finally`
    // below on every exit of this method — the loader, the outer decode, the
    // telemetry read and the awareness branch included, not only the sync
    // apply and relay. A flag left standing after any of those would suppress
    // the relay of the NEXT message this DO processes, whatever kind it is.
    this.revertedThisMessage = false;
    try {
      // First fence, before the load below: a socket whose attachment names
      // another generation holds a document other than the one this instance
      // serves, and applying its message would merge a pre-reset document into
      // the rebuilt one. Closed, told nothing, and — because the check comes
      // first — a socket already known stale cannot make this instance pay for
      // a load it will not use.
      if (this.socketMayReachDocument(ws) === null) return;

      // The halt, before the load below: a halted document persists nothing, so
      // a socket that still sends is closed and its message applied to nothing.
      if (this.persistenceHalted !== null) {
        closeSocket(ws, DOCUMENT_UNAVAILABLE_CLOSE);
        return;
      }

      // The load a message arriving on an unloaded instance pays for, and the
      // drop when it cannot be loaded. See `loadForMessage`.
      if (!(await this.loadForMessage())) return;

      // Normalise to Uint8Array
      const data: Uint8Array =
        typeof message === "string"
          ? new TextEncoder().encode(message)
          : new Uint8Array(message as ArrayBuffer);

      // Parse the y-protocols message type (first varuint byte)
      const decoder = decoding.createDecoder(data);
      const msgType = decoding.readVarUint(decoder);

      if (msgType === messageSync) {
        await this.handleSyncMessage(ws, data, decoder);
      } else if (msgType === messageAwareness) {
        // Second fence, synchronous and immediately before the apply, for the
        // same reason the sync branch carries one: the load above may await,
        // and a resident `/reset` can advance the generation and rebuild the
        // document while it does.
        if (this.socketMayReachDocument(ws) === null) return;

        // The halt again, for the same reason the sync branch checks it twice: a
        // halt raised during the awaited load must reach a handler already past
        // the first check, so that nothing is applied and nothing is relayed on
        // behalf of an instance that can persist neither. The branch touches no
        // staged queue: awareness causes no document transaction.
        if (this.persistenceHalted !== null) {
          closeSocket(ws, DOCUMENT_UNAVAILABLE_CLOSE);
          return;
        }

        // Awareness protocol message. Only the entry naming this socket's own
        // client id is applied, and what was applied is what is relayed — see
        // `./awareness-ownership` for why the rest is dropped rather than
        // refused.
        const own = this.ownAwarenessUpdate(ws, decoding.readVarUint8Array(decoder));
        if (own === null) return;
        awarenessProtocol.applyAwarenessUpdate(this.awareness, own, ws);
        this.keepAwarenessUpdate(ws);

        const relayEncoder = encoding.createEncoder();
        encoding.writeVarUint(relayEncoder, messageAwareness);
        encoding.writeVarUint8Array(relayEncoder, own);
        const relay = encoding.toUint8Array(relayEncoder);
        // The sender included. y-websocket drops a socket that has heard
        // nothing for 30 seconds and counts on its own 15-second renewal coming
        // back, so an editor alone in a project would otherwise reconnect every
        // 30 seconds. A renewal comes back at a clock the client already holds,
        // which y-protocols ignores; the removal y-websocket sends on
        // disconnecting would not be ignored, but the client has closed the
        // socket by the time it arrives (tests/awareness-echo.test.ts).
        for (const client of this.ctx.getWebSockets()) {
          try {
            client.send(relay);
          } catch {
            // Client may have disconnected
          }
        }
      }
      // Unknown message types are silently ignored
    } finally {
      // On every exit of this method — the return above, the sync branch, the
      // awareness branch, or an exception from any of them — so a flag this
      // message set can never be read by the next one, and nothing it staged
      // can be issued by the next one either.
      this.revertedThisMessage = false;
      this.stagedEffects = { sends: [], closes: [] };
    }
  }

  /**
   * Decode and apply one inbound sync message, and report its type.
   *
   * The handler decodes the type itself rather than leaving it to the protocol
   * helper, because that helper catches apply and observer exceptions internally
   * and returns normally: a message whose apply threw would be relayed as
   * accepted. What comes out of the `try` here is a protocol error or an
   * observer that threw after the structs were integrated, and a partial
   * mutation cannot be excluded from either — so the message fails and the halt
   * is entered. The document is not disposed: its sockets and ledgers are live,
   * and the reset is the recovery.
   */
  private applyInboundSync(
    ws: WebSocket,
    generation: number,
    decoder: decoding.Decoder,
    responseEncoder: encoding.Encoder,
  ): { type: number; bytes: Uint8Array | null } {
    let syncMessageType = -1;
    let applied: Uint8Array | null = null;
    try {
      syncMessageType = decoding.readVarUint(decoder);
      if (syncMessageType === syncProtocol.messageYjsSyncStep1) {
        syncProtocol.readSyncStep1(decoder, responseEncoder, this.ydoc);
      } else if (
        syncMessageType === syncProtocol.messageYjsSyncStep2 ||
        syncMessageType === syncProtocol.messageYjsUpdate
      ) {
        const payload = decoding.readVarUint8Array(decoder);
        // The ceiling comes FIRST. An update above the codec's record ceiling
        // cannot be logged, and an update that cannot be logged must not be
        // applied, so the refusal precedes the apply for both subtypes.
        if (payload.length > MAX_RECORD_BYTES) {
          this.refuseOversizedUpdate(ws, payload.length);
        } else {
          this.documentTouched = true;
          Y.applyUpdate(this.ydoc, payload, ws);
          applied = payload;
        }
      } else {
        throw new Error(`unknown sync message type ${syncMessageType}`);
      }
    } catch (err) {
      this.messageFailed = true;
      this.enterHalt("apply_failed", generation, String(err));
    }
    return { type: syncMessageType, bytes: applied };
  }

  /**
   * Issue what this message staged, or discard it, and say whether the message
   * may go on.
   *
   * A failed message reaches no peer: the staged sends are dropped, and the
   * attribution is abandoned a second time — the first was inside `enterHalt`,
   * before the accumulator had run, and this one is after every observer has
   * returned, so nothing an observer added afterwards survives the message. The
   * abandonment is keyed to a message that touched the document, so a message
   * refused before the apply leaves the attribution of earlier messages
   * standing. The
   * staged closes are issued either way, after the halt's own closes, so the
   * offending socket is closed whatever the outcome; a close that throws does
   * not keep the next socket open, and a recipient that has gone does not skip
   * the next.
   */
  private drainStagedEffects(): boolean {
    const { sends, closes } = this.stagedEffects;
    if (this.messageFailed) {
      if (this.documentTouched) this.abandonAttribution();
    } else {
      for (const { ws, msg } of sends) {
        try { ws.send(msg); } catch { /* client may have disconnected */ }
      }
    }
    for (const { ws, code, reason } of closes) {
      closeSocket(ws, { code, reason });
    }
    return !this.messageFailed;
  }

  /**
   * Apply one inbound sync message and settle everything it caused.
   *
   * Its own method because the section from the second fence to the flush is
   * one continuation with one rule over it: nothing in it awaits until the
   * drain has decided what the message may release (F1).
   */
  private async handleSyncMessage(
    ws: WebSocket,
    data: Uint8Array,
    decoder: decoding.Decoder,
  ): Promise<void> {
    // Counted BEFORE the apply. A displacement this very packet causes is
    // recorded during the apply itself, and the write that causes one carries
    // the displaced container's item as its own origin — so counting
    // afterwards would report every plant as an edit orphaned by itself.
    this.countDisplacedEdits(data);

    // Second fence, synchronous and immediately before the apply. The
    // first fence answers for the generation at the message's arrival; the
    // load above may await, and a resident `/reset` can advance the
    // generation and rebuild the document while it does — closing a socket
    // does not cancel a handler already running on it. This is what
    // establishes the generation at the point of application. From here
    // through the apply, enforcement and the relay nothing awaits (F1), so
    // no generation can move under them.
    const generation = this.socketMayReachDocument(ws);
    if (generation === null) return;

    // The halt again, for the same reason the generation is checked twice:
    // the load above may await, and a snapshot or a route running in that
    // gap can halt this instance. A handler already past the first check is
    // caught here.
    if (this.persistenceHalted !== null) {
      closeSocket(ws, DOCUMENT_UNAVAILABLE_CLOSE);
      return;
    }

    // From here to the drain nothing awaits (F1), and everything the guard
    // asks for is held rather than sent. The revert flag is the object's, and
    // messages resumed together from one membership read can each clear it
    // before another applies, so it is cleared here as well, where only this
    // message's apply can set it before the relay reads it.
    this.revertedThisMessage = false;
    this.messageFailed = false;
    this.documentTouched = false;
    this.stagedEffects = { sends: [], closes: [] };

    // The apply is explicit, and its own `try` is what makes a failure
    // visible: y-protocols catches apply and observer exceptions internally
    // and returns normally, so a throw anywhere inside the apply, the guard
    // or the accumulator would otherwise leave this handler believing the
    // message succeeded and relaying it.
    const responseEncoder = encoding.createEncoder();
    encoding.writeVarUint(responseEncoder, messageSync);

    try {
      // The message scope: opened before the apply, closed by the `finally`
      // below, and the whole of it synchronous. It ends BEFORE the activity
      // flush is awaited, so a snapshot's or an ingest's transaction in the gap
      // that await opens is a standalone record rather than this message's.
      this.openMessageGroup(ws);
      const applied = this.applyInboundSync(ws, generation, decoder, responseEncoder);

      // The group, before the drain and before anything the message caused can
      // reach a peer. A step 1 applies nothing and writes nothing; a message
      // that failed writes nothing and advances nothing, and its halt marker is
      // what is written.
      if (!this.messageFailed && applied.bytes !== null) {
        this.commitMessageGroup(generation, applied.bytes);
      }

      // The drain: what the guard staged goes out only once the group that
      // records it has been issued, and a failed message stops here — no
      // response, no relay, no alarm, no activity rows.
      if (!this.drainStagedEffects()) return;

      // If the apply produced a response (a sync step 2 reply to a step 1),
      // send it back to the requesting client.
      if (encoding.length(responseEncoder) > 1) {
        ws.send(encoding.toUint8Array(responseEncoder));
      }

      // Relay sync messages to all other clients — every subtype, except an
      // UPDATE the guard has just reverted. The guard has already broadcast
      // the corrected full state, so relaying the refused packet on top of it
      // leaves a peer exactly where the correction put them and costs a
      // transmission to get there. A step 1 keeps its relay and its step 2
      // reply, and a step 2 keeps its relay even when it triggered a revert:
      // it carries a peer's whole state, not one refused write.
      //
      // F1: nothing is awaited between the apply above and the relay here.
      if (!(this.revertedThisMessage && applied.type === syncProtocol.messageYjsUpdate)) {
        this.relaySync(ws, data);
      }

      // Schedule the 30-second alarm if not already set
      this.scheduleSnapshot();
    } finally {
      this.messageGroup = null;
    }

    // Emit activity rows NOW, while this instance is warm and the edit's
    // actor is attributable. The snapshot alarm above is only a backstop —
    // hibernation usually evicts this instance before it fires, so the
    // snapshot would otherwise run cold with an empty userFieldSets and lose
    // the edit. Best-effort and non-throwing (see flushActivityRows).
    await this.flushActivityRows();
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    // Remove the disconnected client's awareness state and broadcast removal
    //
    // A close that wakes the object is delivered for a socket the wake no
    // longer lists, so its entry is restored here from the attachment first.
    // The removal then needs the awareness to hold metadata for the id:
    // encoding a removal for an id it has never seen throws. An entry the
    // attachment could not keep is dropped by peers on their own timeout. A
    // socket whose id a reconnect took over has none to remove. 0 is an id
    // like any other: Yjs draws them from the whole unsigned 32-bit range.
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    this.restoreSocketAwareness(ws, attachment);
    const closingId = attachment?.awarenessClientId;
    if (closingId !== undefined && this.awareness.meta.has(closingId)) {
      awarenessProtocol.removeAwarenessStates(
        this.awareness,
        [closingId],
        "client disconnected",
      );
      // Broadcast awareness removal to remaining clients
      const removalEncoder = encoding.createEncoder();
      encoding.writeVarUint(removalEncoder, messageAwareness);
      encoding.writeVarUint8Array(
        removalEncoder,
        awarenessProtocol.encodeAwarenessUpdate(
          this.awareness,
          [closingId],
        ),
      );
      const removalMsg = encoding.toUint8Array(removalEncoder);
      for (const client of this.ctx.getWebSockets()) {
        if (client !== ws) {
          try {
            client.send(removalMsg);
          } catch {
            // Client may have disconnected
          }
        }
      }
    }

    // Answered with a code that may be sent: y-websocket closes with no status,
    // which arrives as 1005, and workerd throws on sending that back — the
    // handshake would then be left open on the peer's side.
    try {
      ws.close(replyCloseCode(code));
    } catch {
      // The peer is already gone.
    }

    // On last-client disconnect, snapshot immediately. Best-effort: a thrown
    // D1 failure here must not surface as an unhandled rejection that could
    // crash the DO. Retry happens on the next connect/forced/publish
    // snapshot, or via the alarm doSnapshot reschedules on a batch failure
    // (note: the periodic alarm does not re-fire once all clients have
    // disconnected).
    //
    // The closing socket is still listed by getWebSockets() while its own
    // close handler runs, so the test is that no other socket is open. Two
    // sockets closing together each see the other listed in a closing state.
    if (!this.hasOtherOpenSocket(ws)) {
      // Gated for the same reason as the alarm below. No other open socket now
      // is not the same for the snapshot's duration: a reconnect landing
      // mid-D1 would be delivered into the enforcement blind spot.
      //
      // The catch sits INSIDE the callback: a callback that throws terminates
      // and resets the Durable Object, which is exactly what this best-effort
      // snapshot must not cause.
      await this.ctx.blockConcurrencyWhile(async () => {
        // Inside the gate, because nothing may be awaited ahead of it: the
        // staging hold suppresses this drain as it suppresses the alarm's
        // phases, since a disconnect that snapshotted would retire the very
        // log an exercise has prepared.
        if (await this.drainSuppressed()) return;
        try {
          await this.snapshotToD1();
        } catch (err) {
          // The loader and the fence each own their own line; this one adds
          // nothing for either.
          if (!isNamedPersistenceRefusal(err)) {
            console.error("[snapshot] last-disconnect snapshot failed", err);
          }
        }
      });
    }
  }

  /** Whether any socket other than `closing` is open. */
  private hasOtherOpenSocket(closing: WebSocket): boolean {
    return this.ctx
      .getWebSockets()
      .some((other) => other !== closing && other.readyState === WebSocket.OPEN);
  }

  /**
   * Whether the last-disconnect drain must not run.
   *
   * A flags read that rejects suppresses the drain on staging, for the reason
   * it fails the alarm there: an unreadable hold must never be the thing that
   * lets a snapshot consume held fixture debt. Off staging the flags are
   * normalised off, so an unreadable read decides nothing and the drain runs.
   */
  private async drainSuppressed(): Promise<boolean> {
    try {
      return (await this.controls()).held;
    } catch {
      return this.environment === "staging";
    }
  }

  // -------------------------------------------------------------------------
  // Alarm — 30-second periodic snapshot
  // -------------------------------------------------------------------------

  /**
   * The alarm's two halves, under one gate: the maintenance slice, which runs
   * whatever the socket count, and the periodic snapshot, which does not.
   *
   * The gate is the alarm's own and wraps both, because Cloudflare's gate does
   * not nest and the snapshot half needs one: `snapshotToD1` sets
   * `isSnapshotting` across a series of D1 awaits, and every enforcement pass in
   * can-delete.ts skips a transaction taken under that flag. Ungated, the input
   * gate stays open across those awaits and a socket-origin delete is applied
   * unenforced — no revert, no strike — on a predictable 30-second cadence. The
   * gate blocks DELIVERY instead, which is the only place the window can be
   * closed. Every helper called from inside it is ungated, and the reset keeps
   * its own event-level gate.
   *
   * Both halves catch inside the callback: an exception escaping it terminates
   * and resets the DO, dropping every socket. The snapshot's failure is
   * rethrown outside so the runtime retries the alarm; maintenance's is logged
   * by the slice and never keeps the snapshot half from running.
   */
  async alarm(alarmInfo?: AlarmInfo): Promise<void> {
    const draft = this.beginAlarm(alarmInfo);
    const run: AlarmRun = {
      // A sentinel rather than a nullable binding: an assignment made inside
      // the callback is invisible to the flow analysis, which would read a
      // `null` initialiser as the binding's type for everything after the gate.
      generation: -1,
      slice: { floor: 0, pending: false, rejected: false, lists: 0, deleted: 0 },
      turn: { owed: false, rejected: false },
      failure: undefined,
    };
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.runAlarmPhases(draft, run);
      await this.finaliseAlarm(draft, run);
    });
    if (run.failure !== undefined) throw run.failure;
  }

  /**
   * The invocation's own record, opened before anything is read.
   *
   * `alarmInfo` is the runtime's and is absent under the workers test helper,
   * which calls `alarm()` with no argument. Absent metadata is recorded as
   * `null` rather than defaulted to zero: a retry that says nothing about
   * itself must not read as a first attempt.
   */
  private beginAlarm(alarmInfo: AlarmInfo | undefined): AlarmDraft {
    this.alarmCounter += 1;
    this.snapshotRetirement = null;
    this.snapshotBlob = { outcome: "not_attempted", seq: null };
    this.snapshotBatch = { outcome: "not_attempted", reason: "snapshot_skipped" };
    this.snapshotHeader = "not_attempted";
    this.snapshotEncodedSeq = null;
    this.scheduleSnapshotCalls = 0;
    this.scheduleSnapshotChains = [];
    this.diagnosticLists = 0;
    return {
      recordId: `${this.nonce}:${this.alarmCounter}`,
      startedAt: Date.now(),
      retryCount: typeof alarmInfo?.retryCount === "number" ? alarmInfo.retryCount : null,
      isRetry: typeof alarmInfo?.isRetry === "boolean" ? alarmInfo.isRetry : null,
      sockets: this.ctx.getWebSockets().length,
      firstAlarmInInstance: this.alarmCounter === 1,
      recording: false,
      generation: null,
      kind: "ran",
      failure: null,
      preflight: null,
      maintenanceEntry: null,
      retirementBranch: "none",
      retirementEntry: null,
      snapshot: null,
      scheduling: { finaliser: "none", scheduleSnapshotCalls: 0 },
    };
  }

  /**
   * The three phases, each preceded by its own entry capture, with a failure
   * kept rather than thrown so the finalisation still runs.
   */
  private async runAlarmPhases(draft: AlarmDraft, run: AlarmRun): Promise<void> {
    const controls = await this.alarmControls(draft, run);
    if (controls === null) return;
    draft.recording = controls.recording;
    this.emitAlarmEntry(draft);
    let plan: AlarmPlan;
    try {
      plan = await this.alarmPreflight(controls);
      draft.generation = plan.generation;
      draft.preflight = {
        halted: plan.halted,
        held: plan.held,
        identity: plan.identity,
        cleanup: plan.cleanup,
        debt: plan.debt,
      };
      if (plan.halted) {
        draft.kind = "halted";
        return;
      }
      if (plan.held) {
        draft.kind = "held";
        return;
      }
      run.generation = plan.generation;
      // Each phase runs under its own tag, so a probe can tell the slice's
      // listings from the retirement's and both from the entry scans.
      run.slice = await this.underPhase(
        "maintenance",
        () => this.runMaintenanceSlice(plan.generation, draft),
      );
      run.turn = await this.underPhase(
        "retirement",
        () => this.runOneRetirement(plan, draft),
      );
    } catch (err) {
      this.failAlarm(draft, run, err);
      return;
    }
    await this.runAlarmSnapshot(draft, run);
  }

  /**
   * The flags this invocation runs under, or `null` when it must not run.
   *
   * A read storage refused is not a posture the alarm may guess at: on staging
   * it fails the invocation before any measured work, so a hold storage could
   * not answer for can never let an alarm consume held fixture debt, and the
   * runtime's retry is left to reach a readable flag. Off staging the flags are
   * normalised off whatever storage holds, so an unreadable one decides nothing
   * and the alarm runs its phases.
   */
  private async alarmControls(draft: AlarmDraft, run: AlarmRun): Promise<Controls | null> {
    try {
      return await this.controls();
    } catch (err) {
      if (this.environment !== "staging") return { recording: false, held: false };
      // The invocation fails rather than proceeding: the runtime's retry is
      // what reaches a readable flag, and a guess at the posture is what must
      // never let an alarm consume held fixture debt.
      run.failure = err;
      draft.kind = "failed";
      draft.failure = "controls_unreadable";
      console.error(
        `[diagnostic] project ${this.projectId}: the control flags could not be read, ` +
        `so this alarm ran no phase`,
        err,
      );
      return null;
    }
  }

  /** Record the invocation's failure, and keep it to rethrow after the gate. */
  private failAlarm(draft: AlarmDraft, run: AlarmRun, err: unknown): void {
    run.failure = err;
    draft.kind = "failed";
    draft.failure = describeThrown(err);
  }

  /**
   * The snapshot half, with the reason it did not run named rather than
   * inferred from the silence `snapshotToD1` answers with.
   */
  private async runAlarmSnapshot(draft: AlarmDraft, run: AlarmRun): Promise<void> {
    const skipped = this.snapshotSkip();
    if (skipped !== null) {
      draft.snapshot = this.snapshotRecordFor(false, skipped, null);
      return;
    }
    let entry: PhaseEntry | null = null;
    try {
      entry = await this.underPhase("snapshot", () => this.captureSnapshotEntry(draft));
      await this.underPhase("snapshot", () => this.snapshotToD1());
    } catch (err) {
      this.failAlarm(draft, run, err);
    }
    draft.snapshot = this.snapshotRecordFor(true, null, entry);
  }

  /**
   * Why the snapshot half would return silently, in the order `snapshotToD1`
   * itself checks. Restated here rather than reported from inside it, because
   * an alarm that skipped must say which of the four states it was in.
   */
  private snapshotSkip(): SnapshotSkip | null {
    if (this.ctx.getWebSockets().length === 0) return "no_sockets";
    if (this.persistenceHalted !== null) return "halted";
    if (!this.projectId || !this.docLoaded) return "unloaded";
    if (this.isSnapshotting) return "in_progress";
    return null;
  }

  /** The snapshot half's record, assembled from what its own boundaries set. */
  private snapshotRecordFor(
    ran: boolean,
    skipped: SnapshotSkip | null,
    entry: PhaseEntry | null,
  ): SnapshotRecord {
    return {
      ran,
      skipped,
      entry,
      encodedSeq: this.snapshotEncodedSeq,
      blob: this.snapshotBlob,
      header: this.snapshotHeader,
      retirement: this.snapshotRetirement,
      batch: this.snapshotBatch,
    };
  }

  /**
   * Spend this turn's one retirement-sized budget: the cleanup a previous pass
   * left owed, or else a compaction the thresholds ask for.
   *
   * One of the two, never both, so an alarm spends at most three such budgets —
   * the maintenance slice, this, and the retirement inside the snapshot half's
   * own landed write. Cleanup goes first because it is work already begun and
   * needs no document; a compaction that waits a turn for it costs one interval.
   *
   * Both branches settle their own failures: a refusal is recorded for the
   * scheduler and returns, so the snapshot half still runs this turn.
   */
  private async runOneRetirement(
    plan: AlarmPlan,
    draft: AlarmDraft | null,
  ): Promise<CompactionTurn> {
    if (plan.cleanup.floor !== null) {
      await this.captureRetirementEntry(draft, "cleanup", plan.generation, plan.cleanup.floor);
      const turn = await this.continueCleanup(plan.generation, plan.cleanup.floor);
      return { ...turn, rejected: turn.rejected || plan.cleanup.rejected };
    }
    if (!plan.debt) return { owed: false, rejected: plan.cleanup.rejected };
    await this.captureRetirementEntry(draft, "compaction", plan.generation, this.docSeq);
    const turn = await this.compactIntoStorage(plan.generation);
    return { ...turn, rejected: turn.rejected || plan.cleanup.rejected };
  }

  /**
   * Finish a retirement a previous pass left owed, inside one budget.
   *
   * The floor came from the storage base or the row, so an exact base at or
   * above it is durably in place and everything at or below it is redundant —
   * which is `retireLogBelow`'s whole contract. What one budget cannot drain is
   * found again by the next alarm's derivation, from what storage and the row
   * say rather than from anything recorded here.
   */
  private async continueCleanup(generation: number, floor: number): Promise<CompactionTurn> {
    const retirement = await this.retireLogBelow(generation, floor);
    return {
      owed: retirement.outcome !== "complete",
      rejected: retirement.outcome === "rejected",
      record: retirementRecordOf(retirement, retirement.outcome),
    };
  }

  /**
   * Fold the log into a storage base at the document's current sequence, and
   * retire what the base subsumes.
   *
   * The encoding comes first and the size check after it: a document is
   * measured by what it encodes to, so the allocation is what the check is
   * about. Above the policy ceiling nothing is written at all — the document
   * goes on collaborating from its base and its log, one line names the size,
   * and the attempt recurs at every alarm while the debt stands, so a document
   * that shrinks is compacted.
   *
   * The base is written inside one explicit storage transaction. `writeGroup`
   * issues its batches in sequence with no rollback of its own, so a throw from
   * a later batch over an existing base would leave a header naming parts that
   * do not match it; inside a transaction every batch commits or none
   * does, and the previous base is wholly replaced or wholly intact. Parts of a
   * previous base numbered past the new header's count are ignored by readers
   * and become maintenance's once the header is retired.
   *
   * The accounting moves immediately after the transaction lands and before the
   * retirement, so a retirement that fails cannot leave the counters describing
   * a base that has moved.
   */
  private async compactIntoStorage(generation: number): Promise<CompactionTurn> {
    const bytes = Y.encodeStateAsUpdate(this.ydoc);
    const seq = this.docSeq;
    if (!isBaseSeq(seq)) return { owed: false, rejected: false };
    if (bytes.length > this.compactionPolicy.ceiling) {
      this.refuseOversizedBase(generation, bytes.length);
      return {
        owed: false,
        rejected: false,
        record: retirementRecordOf(null, {
          refused: "oversized",
          bytes: bytes.length,
          ceiling: this.compactionPolicy.ceiling,
        }),
      };
    }
    const folded = seq - (this.baseSeq ?? seq);
    try {
      await this.storage().transaction(async (txn) => {
        // The transaction's own handle, wrapped by the same accessor: the
        // atomic replacement is the platform's, and the probe has to see the
        // batches it issues without standing between them and the transaction.
        await writeGroup(
          this.storage(txn) as unknown as LogStorage,
          encodeBase(generation, seq, bytes, { partLimit: this.compactionPolicy.partLimit }),
        );
      });
    } catch (err) {
      console.error(
        `[persistence][compaction] project ${this.projectId}: generation ${generation} was ` +
        `not compacted at sequence ${seq}; nothing was changed`,
        err,
      );
      return {
        owed: false,
        rejected: true,
        record: retirementRecordOf(null, { refused: "write_failed" }),
      };
    }
    this.trimAccounting(seq);
    const retirement = await this.retireLogBelow(generation, seq);
    console.log(
      `[persistence][compacted] project ${this.projectId}: generation ${generation} folded ` +
      `${folded} records into a base of ${bytes.length} bytes at sequence ${seq}; ` +
      `the retirement was ${retirement.outcome}`,
    );
    return {
      owed: retirement.outcome !== "complete",
      rejected: retirement.outcome === "rejected",
      record: retirementRecordOf(retirement, {
        folded,
        seq,
        bytes: bytes.length,
        retirement: retirement.outcome,
      }),
    };
  }

  /**
   * State the size of a snapshot blob past the warning threshold, once per load.
   *
   * The number an operator needs before D1's own cap refuses the row: a project
   * approaching it is one whose next publish fails closed, and the pill's
   * popover shows the same figure to the person who can act on it.
   */
  private warnOnBlobSize(size: number): void {
    if (size <= SNAPSHOT_SIZE_WARNING || this.sizeWarned) return;
    this.sizeWarned = true;
    console.warn(
      `[snapshot][size] project ${this.projectId}: the saved state is ${size} bytes, above ` +
      `the ${SNAPSHOT_SIZE_WARNING}-byte mark`,
    );
  }

  /**
   * State that a document encodes to more than the policy will fold, once per
   * load.
   *
   * The latch is on the LINE alone. The attempt itself runs at every alarm the
   * debt stands through, because what a document encodes to is not monotonic: a
   * deletion brings it back under the ceiling and the next attempt compacts it.
   */
  private refuseOversizedBase(generation: number, size: number): void {
    if (this.compactionRefused) return;
    this.compactionRefused = true;
    console.error(
      `[persistence][compaction] project ${this.projectId}: generation ${generation} encodes ` +
      `to ${size} bytes, above the ${this.compactionPolicy.ceiling}-byte ceiling; the log is ` +
      `not folded and the document is served from its base and its log`,
    );
  }

  /**
   * Whether this alarm may act at all, and under which generation.
   *
   * Read inside the gate, so the decision is authoritative, and side-effect-free
   * on the halt: `readHalt` through `haltStandsFor` neither installs a halt nor
   * closes a socket, which the loader's own marker read does. Under a halt,
   * resident or durable, the alarm issues nothing and schedules nothing —
   * recovery is a reset request from outside the object, and an alarm that kept
   * firing would only repeat the refusal; the reset that clears the halt
   * schedules again. A socketless wake holds no generation of its own, which is
   * why storage answers for it.
   */
  private async alarmPreflight(controls: Controls): Promise<AlarmPlan> {
    const resident = this.persistenceHalted;
    // A resident halt carries the generation it was entered for, so a halted
    // plan names one without a storage read a halted alarm has no reason to
    // issue.
    if (resident !== null) return stoppedPlan(resident.generation, true, controls.held);
    const generation = this.docGeneration ?? await this.readGenerationFromStorage();
    if (await this.haltStandsFor(generation)) {
      return stoppedPlan(generation, true, controls.held);
    }
    // The hold splits here: after the halt checks, which say whether the alarm
    // may act at all, and BEFORE the identity, the derivation and the listing,
    // so a held alarm reads nothing a fixture's prepared state could be spent
    // on and leaves the ranges exactly as the preparation left them.
    if (controls.held) return stoppedPlan(generation, false, true);
    // The identity next, because the derivation below reads a row an instance
    // that cannot name its project has no way to address, and because a
    // compaction writes a base for a project whose durable binding must already
    // stand: an instance that folded its log and then woke unable to name
    // itself could not finish the retirement the fold left owed. So neither the
    // row-derived cleanup nor the compaction runs until the binding is made,
    // and a binding storage refused is a refused turn.
    const identity = await this.restoreIdentity();
    const cleanup = identity.named
      ? await this.deriveCleanup(generation)
      : { floor: null, rejected: identity.rejected };
    return {
      generation,
      cleanup,
      debt: identity.named && this.thresholdDebt(),
      halted: false,
      held: false,
      identity,
    };
  }

  /**
   * What cleanup this alarm owes, with a refusal reported rather than thrown.
   *
   * Kept apart from the generation and the halt above it: those two are what
   * makes the alarm's action legitimate, and their failure keeps its existing
   * path out of the gate and into the runtime's retry. A derivation that cannot
   * be taken means only that this turn does no cleanup and waits the full
   * interval — the compaction of a loaded document is not conditioned on it,
   * since a D1 outage is exactly when compaction earns its keep.
   */
  private async deriveCleanup(generation: number): Promise<CleanupDerivation> {
    try {
      return await this.cleanupOwed(generation);
    } catch (err) {
      console.error(
        `[persistence][cleanup] project ${this.projectId}: generation ${generation}'s ` +
        `cleanup floor could not be derived`,
        err,
      );
      return { floor: null, rejected: true };
    }
  }

  /**
   * The sequence this generation may safely be retired below, and whether any
   * key still stands at or under it.
   *
   * Nothing is recorded between alarms, so nothing can be lost: what is owed is
   * derived from what storage and the row say right now. The storage base's
   * header is asked first and is a SAFE floor rather than the winner of the
   * authority rule — a newer row can coexist with an older header after a failed
   * deletion, and cleaning through the older sequence is conservative. Without a
   * header the row answers, and only when it is a base: tagged at this
   * generation, both tags in domain, and a blob present, which is exactly what
   * the loader requires of it. Then one bounded listing says whether the range
   * holds anything at all — orphan parts and malformed keys included, since they
   * sort inside it and the retirement owns them.
   */
  private async cleanupOwed(generation: number): Promise<CleanupDerivation> {
    const header = await this.storageFloor(generation);
    const derived = header === null ? await this.rowFloor(generation) : { floor: header, rejected: false };
    if (derived.floor === null) return derived;
    return {
      floor: (await this.eligibleRangeHolds(generation, derived.floor)) ? derived.floor : null,
      rejected: derived.rejected,
    };
  }

  /**
   * The storage base's sequence, read as a header alone.
   *
   * A malformed header is one line and no storage floor for this decision: the
   * load is where corruption halts a document, and an alarm that halted on a
   * header it never has to read would refuse a document the loader may still be
   * able to open. The row is consulted instead.
   */
  private async storageFloor(generation: number): Promise<number | null> {
    try {
      const header = await readBaseHeader(this.storage() as unknown as LogStorage, generation);
      return header === null ? null : header.seq;
    } catch (err) {
      if (!(err instanceof LogCorruptionError)) throw err;
      console.error(
        `[persistence][cleanup] project ${this.projectId}: generation ${generation}'s base ` +
        `header is malformed and names no floor; the row is consulted instead`,
        err,
      );
      return null;
    }
  }

  /**
   * The row's sequence, when the row is a base for this generation.
   *
   * One metadata query, allocating no blob: the presence of the bytes is what
   * decides, never the bytes. A row that is missing, out of domain, tagged at
   * another generation, or tagged with a NULL blob is no authority and names no
   * floor, exactly as the loader refuses it. A read that REJECTS is cleanup
   * unknown: nothing is concluded, the outcome is rejected, and compaction is
   * untouched.
   */
  private async rowFloor(generation: number): Promise<CleanupDerivation> {
    let row: Record<string, unknown> | null;
    try {
      row = await this.env.DB
        .prepare(
          "SELECT yjs_generation, yjs_seq, yjs_state IS NOT NULL AS has_blob " +
          "FROM projects WHERE id = ?",
        )
        .bind(this.projectId)
        .first<Record<string, unknown>>();
    } catch (err) {
      console.error(
        `[persistence][cleanup-unknown] project ${this.projectId}: the row could not be read, ` +
        `so generation ${generation}'s cleanup is not derived this turn`,
        err,
      );
      return { floor: null, rejected: true };
    }
    const seq = row?.yjs_seq;
    if (!row || row.yjs_generation !== generation || !isBaseSeq(seq) || !row.has_blob) {
      console.error(
        `[persistence][cleanup] project ${this.projectId}: the row is no base for generation ` +
        `${generation} and names no floor`,
      );
      return { floor: null, rejected: false };
    }
    return { floor: seq, rejected: false };
  }

  /**
   * Whether any key stands at or below `floor` under this generation's log
   * prefix.
   *
   * One listing for one key, bounded exactly as the retirement's own is: the
   * codec's keys are fixed-width, so a record's header and its parts both sort
   * below the successor sequence, and at `MAX_SEQ` the prefix alone bounds the
   * range rather than the domain being widened for one listing.
   */
  private async eligibleRangeHolds(generation: number, floor: number): Promise<boolean> {
    const page = await (this.storage() as unknown as LogStorage).list<unknown>({
      prefix: logPrefix(generation),
      end: floor < MAX_SEQ ? logKey(generation, floor + 1) : undefined,
      limit: 1,
    });
    return page.size > 0;
  }

  /**
   * Arm the next alarm from what this one found.
   *
   * The halt is rechecked first: a snapshot half that entered one deleted the
   * alarm, and this must not re-arm it. Then any rejected outcome waits the
   * full interval rather than retrying immediately, because what rejected it is
   * storage or D1 — the maintenance slice, a cleanup, a compaction's write and
   * the retirement inside the snapshot half's landed write are one precedence
   * between them. Sockets come next as stated policy: an object with editors on
   * it keeps its snapshot cadence whatever work is pending. Otherwise work left
   * over — an unswept generation below the current one, anything the slice could
   * not prove finished, a cleanup still owed, or threshold debt standing on an
   * open document — brings the next run forward, and an object with neither
   * sockets nor work stops the cycle; the next connect, load, record or reset
   * arms it again.
   */
  private async scheduleAfterAlarm(
    slice: MaintenanceSlice,
    turn: CompactionTurn,
    generation: number,
  ): Promise<SchedulingRecord["finaliser"]> {
    if (this.persistenceHalted !== null) return "none";
    if (this.alarmRefused(slice, turn) || this.ctx.getWebSockets().length > 0) {
      await this.storage().setAlarm(Date.now() + SNAPSHOT_ALARM_MS);
      return "interval";
    }
    if (this.workRemains(slice, turn, generation)) {
      await this.storage().setAlarm(Date.now() + MAINTENANCE_DELAY_MS);
      return "maintenance";
    }
    return "none";
  }

  /** Whether storage or D1 refused any half of the alarm that just ran. */
  private alarmRefused(slice: MaintenanceSlice, turn: CompactionTurn): boolean {
    return slice.rejected || turn.rejected || this.snapshotRetirement?.outcome === "rejected";
  }

  /**
   * Whether anything is left for the next alarm to pick up: a generation below
   * the current one, a slice that could not prove itself finished, a cleanup
   * still owed by either retirement, or threshold debt on an open document.
   */
  private workRemains(
    slice: MaintenanceSlice,
    turn: CompactionTurn,
    generation: number,
  ): boolean {
    if (slice.floor < generation || slice.pending) return true;
    if (turn.owed || this.snapshotRetirement?.outcome === "exhausted") return true;
    return this.thresholdDebt();
  }

  /**
   * Delete one old generation's keys, and the current generation's orphan base
   * parts, inside a fixed budget.
   *
   * There is no work list. What has to go is derivable from storage and the
   * current generation — every key under a generation below it, and at it the
   * base parts no header stands over — so nothing is appended at a switch and
   * nothing can be lost between the switch and a put. Generations above the
   * current one are never touched: a reset's staged base sits there, and this
   * runs inside the same gate the reset does, so it never observes that state
   * in the first place.
   *
   * One OLD generation per run, so a project with many of them is swept over
   * many runs rather than in one long slice that would delay the snapshot half.
   */
  private async runMaintenanceSlice(
    current: number,
    draft: AlarmDraft | null,
  ): Promise<MaintenanceSlice> {
    const budget: MaintenanceBudget = {
      deletes: MAINTENANCE_DELETE_BUDGET,
      lists: MAINTENANCE_LIST_BUDGET,
    };
    // Mutated in place from here on, so a rejection anywhere below carries the
    // floor it reached and the listings and deletions it had already spent.
    const slice: MaintenanceSlice = {
      floor: 0, pending: false, rejected: false, lists: 0, deleted: 0,
    };
    try {
      slice.floor = Math.min(await this.readMaintenanceFloor(), current);
      await this.captureMaintenanceEntry(draft, current, slice.floor);
      const old = slice.floor < current;
      const swept = old ? await this.sweepGeneration(slice.floor, budget, slice) : true;
      const orphans = swept ? await this.sweepOrphanParts(current, budget, slice) : false;
      if (swept && old) {
        // The slice's last fallible operation, so a rejection anywhere above it
        // leaves the floor exactly where it stood.
        await this.advanceMaintenanceFloor(slice.floor + 1);
        slice.floor += 1;
      }
      slice.pending = !swept || !orphans;
      return slice;
    } catch (err) {
      console.error(`[maintenance] project ${this.projectId}: the sweep was refused`, err);
      slice.pending = true;
      slice.rejected = true;
      return slice;
    }
  }

  /**
   * Delete everything one superseded generation holds, in the order that leaves
   * nothing reachable behind it: the log, then the base's parts, then the
   * header and the halt marker.
   *
   * Answers whether the generation was proved empty inside the budget, which is
   * the condition the floor advances on.
   */
  private async sweepGeneration(
    generation: number,
    budget: MaintenanceBudget,
    slice: MaintenanceSlice,
  ): Promise<boolean> {
    if (!(await this.sweepPrefix(logPrefix(generation), budget, slice))) return false;
    if (!(await this.sweepPrefix(`${baseKey(generation)}:`, budget, slice))) return false;
    if (budget.deletes <= 0) return false;
    const removed = await deleteKeys(
      this.storage() as unknown as LogStorage,
      [baseKey(generation), haltKey(generation)],
    );
    budget.deletes -= removed;
    slice.deleted += removed;
    return true;
  }

  /**
   * Delete the current generation's base parts, and only while no header stands
   * over them.
   *
   * A header at the current generation names a live base, and its parts are
   * never touched; parts with no header are what a retired header and a smaller
   * successful retry leave, and no reader can reach them. Deferring is the safe
   * direction: an orphan costs storage, a part deleted from under a header costs
   * the document.
   */
  private async sweepOrphanParts(
    generation: number,
    budget: MaintenanceBudget,
    slice: MaintenanceSlice,
  ): Promise<boolean> {
    if (budget.deletes <= 0 || budget.lists <= 0) return false;
    if ((await this.storage().get<unknown>(baseKey(generation))) !== undefined) return true;
    return await this.sweepPrefix(`${baseKey(generation)}:`, budget, slice);
  }

  /**
   * Delete every key under `prefix`, a page at a time, and answer whether the
   * prefix was proved empty inside the budget.
   *
   * A page is asked for at the backend's own `delete` limit, so one listing
   * makes at most one batch, and a page shorter than the limit is the end of
   * the prefix.
   */
  private async sweepPrefix(
    prefix: string,
    budget: MaintenanceBudget,
    slice: MaintenanceSlice,
  ): Promise<boolean> {
    const storage = this.storage() as unknown as LogStorage;
    for (;;) {
      if (budget.deletes <= 0 || budget.lists <= 0) return false;
      const limit = Math.min(MAINTENANCE_LIST_PAGE, budget.deletes);
      budget.lists -= 1;
      slice.lists += 1;
      const keys = [...(await storage.list<unknown>({ prefix, limit })).keys()];
      if (keys.length > 0) {
        const removed = await deleteKeys(storage, keys);
        budget.deletes -= removed;
        slice.deleted += removed;
      }
      if (keys.length < limit) return true;
    }
  }

  /**
   * The lowest generation maintenance has not proved clean.
   *
   * Absent or malformed reads as 0, because a re-sweep of a clean generation
   * deletes nothing: the floor spares work, and never stands in for the record
   * of what storage holds.
   */
  private async readMaintenanceFloor(): Promise<number> {
    const stored = await this.storage().get<unknown>(MAINTENANCE_FLOOR_KEY);
    return isSafeCount(stored) ? stored : 0;
  }

  /** Record every generation below `floor` as clean, in one put. */
  private async advanceMaintenanceFloor(floor: number): Promise<void> {
    await this.storage().put(MAINTENANCE_FLOOR_KEY, floor);
  }

  /**
   * Arm the alarm for a maintenance run, and never postpone one.
   *
   * An alarm pending at or before the maintenance delay is left exactly where it
   * stands: it runs the maintenance half too, and moving it out would delay the
   * snapshot it was armed for. One pending later than the delay is brought
   * forward to it, which costs that alarm nothing — it runs both halves either
   * way.
   */
  private async scheduleMaintenance(): Promise<void> {
    const at = Date.now() + MAINTENANCE_DELAY_MS;
    const pending = await this.storage().getAlarm();
    if (pending === null || pending > at) await this.storage().setAlarm(at);
  }

  /**
   * Arm maintenance from what a load can see, once per load, so a switch whose
   * scheduling an eviction took is recovered.
   *
   * Neither read may fail the load: the document is open and serving, and an
   * unarmed sweep costs storage rather than correctness.
   */
  private async scheduleMaintenanceIfOwed(): Promise<void> {
    const generation = this.docGeneration;
    if (generation === null) return;
    try {
      // The debt first, because it answers from what the replay already
      // counted and costs no read: a load that opened over a long tail arms the
      // alarm that folds it whether or not a socket is ever attached.
      if (!this.thresholdDebt() && !(await this.maintenanceOwed(generation))) return;
      await this.scheduleMaintenance();
    } catch (err) {
      console.error(
        `[maintenance] project ${this.projectId}: the sweep could not be scheduled`,
        err,
      );
    }
  }

  /**
   * Whether storage holds a generation below the current one, or a base part at
   * it that no header stands over.
   *
   * The floor is asked first, because it answers without a listing.
   */
  private async maintenanceOwed(generation: number): Promise<boolean> {
    if ((await this.readMaintenanceFloor()) < generation) return true;
    const parts = await (this.storage() as unknown as LogStorage).list<unknown>({
      prefix: `${baseKey(generation)}:`,
      limit: 1,
    });
    if (parts.size === 0) return false;
    return (await this.storage().get<unknown>(baseKey(generation))) === undefined;
  }

  // -------------------------------------------------------------------------
  // Public API — called by publish pipeline
  // -------------------------------------------------------------------------

  async forceSnapshot(): Promise<void> {
    // Gated like the alarm and /snapshot: no client transaction may be
    // delivered while `isSnapshotting` is held. The failure is carried out of
    // the callback and rethrown, so the caller still sees a failed snapshot
    // without a throwing callback resetting the DO.
    let failure: unknown;
    await this.ctx.blockConcurrencyWhile(async () => {
      try {
        await this.snapshotToD1();
      } catch (err) {
        failure = err;
      }
    });
    if (failure !== undefined) throw failure;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Load the document for a message that arrived on an unloaded instance, and
   * report whether the message may be acted on.
   *
   * Every other entry point reaches the document through `ensureDocLoaded`
   * inside `blockConcurrencyWhile`; this one is reachable with `docLoaded`
   * false, because the hibernation-wake load in the constructor swallows a
   * failed D1 read on purpose (a throw there would discard the DO and evict
   * every editor). Applied to an empty document, a sync message makes the DO
   * answer sync step 1 from nothing and relay an update computed against
   * nothing, while canDelete enforcement sees no entities to protect. So load
   * first — gated, like every other loader — and if the document still cannot
   * be loaded, drop the message rather than act on an empty one. The gate is
   * paid only on that cold path; the warm keystroke path skips it entirely.
   *
   * A load the loader itself refused has already said so, once, and the
   * dropped-message line would be the second: both are suppressed here and
   * nowhere else, so a halt costs exactly one line per attempt.
   */
  private async loadForMessage(): Promise<boolean> {
    if (this.docLoaded) return true;
    let named = false;
    await this.ctx.blockConcurrencyWhile(async () => {
      try {
        await this.ensureDocLoaded();
      } catch (err) {
        named = isNamedPersistenceRefusal(err);
        if (!named) console.error("[collaboration] message-time doc load failed", err);
        // The editor is reconnected rather than left sending edits into an
        // instance that drops them.
        this.closeAllSockets(
          DOCUMENT_UNAVAILABLE_CLOSE.code,
          DOCUMENT_UNAVAILABLE_CLOSE.reason,
        );
      }
    });
    if (this.docLoaded) return true;
    if (!named) {
      console.error(
        `[collaboration] project ${this.projectId}: message dropped, document not loaded`,
      );
    }
    return false;
  }

  /**
   * Schedule a snapshot alarm 30 seconds from now, unless one is already
   * pending, and answer with the whole chain from `getAlarm` through
   * `setAlarm`.
   *
   * The chain is returned rather than dropped so that the alarm's finalisation
   * can wait on the arms this invocation made before it reads what stands
   * pending; a caller that ignores the value loses nothing, and a rejection
   * handler attached here keeps an unobserved rejection from surfacing
   * elsewhere.
   */
  private scheduleSnapshot(): Promise<void> {
    this.scheduleSnapshotCalls += 1;
    // The read is issued synchronously, so a binding that throws on it throws
    // from here rather than out of the returned chain.
    const pending = this.storage().getAlarm();
    // The handler is attached at the call, and the handled chain — `getAlarm`
    // through `setAlarm` — is what is handed back: the finalisation has to be
    // able to wait on the nested arm, and every other caller ignores the value,
    // so an unobserved rejection must not surface elsewhere in the isolate.
    const settled = this.armSnapshotAlarm(pending)
      .catch(() => { /* the platform's own failure path */ });
    this.scheduleSnapshotChains.push(settled);
    return settled;
  }

  /** Arm the alarm the read found none pending for. */
  private async armSnapshotAlarm(pending: Promise<number | null>): Promise<void> {
    if ((await pending) !== null) return;
    await this.storage().setAlarm(Date.now() + 30_000);
  }

  /**
   * Ensure the Y.Doc is loaded from a base this instance can prove exact, and
   * that it holds the row's revision. Must be called inside
   * blockConcurrencyWhile() to prevent race conditions on cold start.
   *
   * The one owner of the `[exact-base]` line. Every other catch that meets an
   * `ExactBaseError` recognises the class and adds nothing, so a refusal is one
   * line per attempt in `wrangler tail`, whichever entry point paid for it.
   */
  private async ensureDocLoaded(): Promise<void> {
    if (this.docLoaded) return;
    if (!this.projectId) return;

    try {
      await this.loadExactBase();
    } catch (err) {
      if (err instanceof ExactBaseError) {
        console.error(`[exact-base] project ${this.projectId}: ${err.reason}`);
      }
      throw err;
    }
    // After the document is open, and only for a load that opened it: the sweep
    // an eviction left unscheduled is recovered from what storage still holds.
    await this.scheduleMaintenanceIfOwed();
  }

  /**
   * Read the row, prove this invocation still owns the object, claim the row,
   * and open the document — repeating from the top when another writer moved
   * the row between the read and the claim.
   *
   * The order is the ownership rule: the platform validates ownership on every
   * storage access, so the generation read between the row read and the claim
   * is what makes the claim the act of an invocation that owned the object a
   * moment before. It is repeated on every attempt, not paid once.
   */
  private async loadExactBase(): Promise<void> {
    let contention: ExactBaseReason = "claim_contended";
    for (let read = 0; read < LOAD_READ_LIMIT; read++) {
      const row = await this.readBaseRow();
      const generation = await this.readGenerationFromStorage();
      await this.readHaltMarker(generation);
      const storageBase = await this.readStorageBase(generation);
      const contended = await this.openFromBaseRow(row, generation, storageBase);
      if (contended === null) return;
      contention = contended;
    }
    throw new ExactBaseError(this.projectId, contention);
  }

  /**
   * Stop the load at a durable halt, before anything is claimed, applied or
   * repaired.
   *
   * The marker is the answer of a generation that halted, and an eviction does
   * not forget it: the state is taken from storage, the editors are told to come
   * back, and the load throws. A marker present but unreadable is `bad_halt` and
   * is left exactly as it stands — the reason and time of the original halt are
   * not this path's to overwrite. One line per attempt, here and nowhere else.
   */
  private async readHaltMarker(generation: number): Promise<void> {
    let marker: HaltMarker | null;
    try {
      marker = await readHalt(this.storage() as unknown as LogStorage, generation);
    } catch (err) {
      if (!(err instanceof LogCorruptionError)) {
        throw new ExactBaseError(this.projectId, "generation_unreadable", { cause: err });
      }
      marker = { v: 1, reason: "bad_halt", at: 0 };
    }
    if (marker === null) return;

    this.persistenceHalted = { generation, marker };
    this.abandonAttribution();
    console.error(
      `[persistence][halted-load] project ${this.projectId}: generation ${generation} is ` +
      `halted (${marker.reason}); the document is not loaded until a reset replaces it`,
    );
    this.closeAllSockets(DOCUMENT_UNAVAILABLE_CLOSE.code, DOCUMENT_UNAVAILABLE_CLOSE.reason);
    throw new PersistenceHaltedError(this.projectId, generation, marker);
  }

  /**
   * The storage base for this generation, or `null` when it holds none.
   *
   * A base the codec cannot read is corruption of an accepted record, which
   * halts: for a storage base the log it subsumed may already be gone, so
   * "absent" is not an honest reading of damage. A storage access that REJECTS
   * is the other thing entirely — a refusal deterministic from nothing, which a
   * marker would make permanent.
   */
  private async readStorageBase(generation: number): Promise<StoredBase | null> {
    try {
      return await readBase(this.storage() as unknown as LogStorage, generation);
    } catch (err) {
      if (err instanceof LogCorruptionError) throw this.haltedLoad("log_corrupt", generation);
      throw new ExactBaseError(this.projectId, "generation_unreadable", { cause: err });
    }
  }

  /**
   * Take one read of the row through the rules, and report the contention that
   * sends the loader back for another read — or `null` once the document is
   * open.
   *
   * Exactly one statement is written per read: the bare claim, the tag, or the
   * initial blob. A refusal writes none.
   */
  private async openFromBaseRow(
    row: BaseRow,
    generation: number,
    storageBase: StoredBase | null,
  ): Promise<ExactBaseReason | null> {
    // Both NULL is untagged; both in domain is tagged; anything else is a pair
    // no writer here can produce, and applying a blob under it would open a
    // document whose base cannot be attributed.
    const untagged = row.generation === null && row.seq === null;
    const tagged = isSafeCount(row.generation) && isBaseSeq(row.seq);
    if (!untagged && !tagged) throw new ExactBaseError(this.projectId, "bad_tags");

    if (storageBase !== null) {
      return await this.openStorageBase(row, generation, tagged, storageBase);
    }
    return tagged
      ? await this.openTaggedBase(row, generation)
      : await this.openUntaggedRow(row, generation);
  }

  /**
   * Which of two bases exact for the current generation the document opens on.
   *
   * A D1 row competes only when it is tagged at the current generation with a
   * blob: a row with NULL tags is not a base whatever its blob holds, and a row
   * tagged at another generation belongs to another lineage. Between two that
   * do compete the higher sequence wins, and a tie goes to the D1 row, which is
   * the one a snapshot rewrites with newer content at the same sequence.
   *
   * Two bases at the same generation and sequence are representations of the
   * same logged state — bare claims and guarded entity batches never change
   * blob content, and the sequence is captured beside the encoding — so a tie
   * costs nothing whichever way it is taken.
   */
  private chooseBase(
    row: BaseRow,
    generation: number,
    tagged: boolean,
    base: StoredBase,
  ): "row" | "storage" {
    if (!tagged || row.blob === null || row.generation !== generation) return "storage";
    return (row.seq as number) >= base.seq ? "row" : "storage";
  }

  /**
   * Open on whichever of the storage base and the D1 row is the newer base for
   * this generation, and claim the row for its revision alone.
   *
   * The codec has validated that the storage base's header names this
   * generation, so the D1 blob's own tags say nothing about which document this
   * is and the row is not required to agree with them: the staged reset leaves
   * the row at the previous generation until its replacement lands, and a
   * compaction writes a base the next D1 write retires. The row is still
   * claimed, because every load that opens claims — and an untagged row is
   * claimed with its NULL tags RETAINED, never tagged: a tag here would confer
   * current-base authority on bytes that are not the base's, and the tie above
   * would then serve them over the staged base. The first fenced snapshot is
   * what tags, with the blob it describes.
   *
   * When the row wins, the stale header is retired here, after the claim has
   * landed and before any application, so no mutated document is ever resident
   * with a failed cleanup behind it. The base's parts are maintenance's.
   */
  private async openStorageBase(
    row: BaseRow,
    generation: number,
    tagged: boolean,
    base: StoredBase,
  ): Promise<ExactBaseReason | null> {
    const winner = this.chooseBase(row, generation, tagged, base);
    if (!(await this.claimRow(row.revision))) return "claim_contended";
    if (winner === "row") {
      try {
        await this.retireBaseHeader(generation);
      } catch (err) {
        throw new ExactBaseError(this.projectId, "generation_unreadable", { cause: err });
      }
      this.docSeq = row.seq as number;
      this.docWrite = row.revision + 1;
      await this.openStoredSequence(row.blob as Uint8Array, generation);
      return null;
    }
    this.docSeq = base.seq;
    this.docWrite = row.revision + 1;
    await this.openStoredSequence(base.bytes, generation);
    return null;
  }

  /** Claim a row whose base is already tagged, and open the document on it. */
  private async openTaggedBase(
    row: BaseRow,
    generation: number,
  ): Promise<ExactBaseReason | null> {
    // A NULL blob under tags is an anomaly, never a cold build: the tags say a
    // base was written and the bytes are gone. The reset recovers it.
    if (row.blob === null) throw new ExactBaseError(this.projectId, "blob_missing_tagged");
    // Lower or higher alike: a base tagged with another generation belongs to
    // another lineage, and the reset recovers it whichever way it points.
    if (row.generation !== generation) {
      throw new ExactBaseError(this.projectId, "base_generation_mismatch");
    }
    if (!(await this.claimRow(row.revision))) return "claim_contended";
    this.docSeq = row.seq as number;
    this.docWrite = row.revision + 1;
    await this.openStoredSequence(row.blob, generation);
    return null;
  }

  /**
   * Take a row no instance has tagged: either an untagged blob, which is tagged
   * on the bytes read, or no blob at all, which is built from the entity rows.
   *
   * Neither may happen while the current generation holds a log: a tail whose
   * base this document is not would be replayed onto a lineage that never
   * carried it.
   */
  private async openUntaggedRow(
    row: BaseRow,
    generation: number,
  ): Promise<ExactBaseReason | null> {
    // The tail read is a storage access like every other phase of the load, and
    // a rejection is the loader's marker-less refusal: an obsolete invocation
    // must not turn its lost ownership into a halt, and a transient storage
    // failure must not become a permanent one.
    let tail: number | null;
    try {
      tail = await highestSeq(this.storage() as unknown as LogStorage, generation);
    } catch (err) {
      throw new ExactBaseError(this.projectId, "generation_unreadable", { cause: err });
    }
    if (tail !== null) {
      throw new ExactBaseError(
        this.projectId,
        row.blob === null ? "tail_without_base" : "untagged_under_log",
      );
    }

    if (row.blob === null) return await this.openColdBuild(row.revision, generation);

    if (!(await this.tagUntaggedBlob(row.blob, row.revision, generation))) {
      return "tag_contended";
    }
    this.docSeq = 0;
    this.docWrite = row.revision + 1;
    await this.openStoredSequence(row.blob, generation);
    return null;
  }

  /**
   * Read the four columns a base is identified by, with the revision validated
   * and the tags left raw for the caller to classify.
   *
   * A missing row is a refusal, not a cold build: the project does not exist,
   * and a document opened for it is one no write can ever claim.
   */
  private async readBaseRow(): Promise<BaseRow> {
    const row = await this.env.DB
      .prepare("SELECT yjs_state, yjs_generation, yjs_seq, yjs_write FROM projects WHERE id = ?")
      .bind(this.projectId)
      .first<Record<string, unknown>>();

    if (!row) throw new ExactBaseError(this.projectId, "missing_project");

    const revision = row.yjs_write;
    // The column's INTEGER affinity admits a non-integer number and text; the
    // triggers order whatever compares, and this is what refuses the rest.
    if (!isSafeCount(revision)) throw new ExactBaseError(this.projectId, "bad_revision");
    // Claim only with room for one complete snapshot above the claim, so no
    // instance is ever opened that cannot complete one.
    if (revision > MAX_WRITE_REVISION - SNAPSHOT_REVISION_MOVES) {
      throw new ExactBaseError(this.projectId, "revision_exhausted");
    }

    return {
      blob: normaliseBlob(row.yjs_state),
      generation: row.yjs_generation ?? null,
      seq: row.yjs_seq ?? null,
      revision,
    };
  }

  /**
   * The generation as storage holds it right now, bypassing the cache and the
   * accessor's logging.
   *
   * Every call is also an ownership validation: the platform answers a storage
   * access from an invocation it has replaced with an exception, which is what
   * makes this read the fence a D1 statement cannot be.
   */
  private async readGenerationFromStorage(
    storage: LogStorage = this.storage() as unknown as LogStorage,
  ): Promise<number> {
    let stored: unknown;
    try {
      stored = await storage.get<unknown>(DOC_GENERATION_KEY);
    } catch (err) {
      throw new ExactBaseError(this.projectId, "generation_unreadable", { cause: err });
    }
    // Only an absent key is 0. A stored `null` is a value nothing here writes,
    // and it is refused with every other value outside the domain.
    if (stored === undefined) return 0;
    if (!isSafeCount(stored)) throw new ExactBaseError(this.projectId, "generation_malformed");
    return stored;
  }

  /**
   * Claim a row whose blob is already tagged, by moving its revision alone.
   *
   * Landing this is what makes the instance the row's owner: from here every
   * write carrying an earlier revision fails, standalone or batched. Zero rows
   * means the row moved between the read and the claim.
   */
  private async claimRow(revision: number): Promise<boolean> {
    const result = await this.env.DB
      .prepare("UPDATE projects SET yjs_write = ? WHERE id = ? AND yjs_write = ?")
      .bind(revision + 1, this.projectId, revision)
      .run();
    return landedOneRow(result);
  }

  /**
   * Tag an untagged blob with the current generation, and claim the row in the
   * same statement.
   *
   * Conditioned on the bytes read as well as the revision: the fence trigger is
   * inert on a row no instance has claimed, so a writer that predates it can
   * replace the bytes without moving the revision, and the comparison keeps the
   * tag off bytes this instance did not read. `updated_at` is untouched —
   * tagging is not a content change.
   */
  private async tagUntaggedBlob(
    blob: Uint8Array,
    revision: number,
    generation: number,
  ): Promise<boolean> {
    const result = await this.env.DB
      .prepare(
        "UPDATE projects SET yjs_generation = ?, yjs_seq = 0, yjs_write = ? WHERE id = ? " +
        "AND yjs_generation IS NULL AND yjs_seq IS NULL AND yjs_state = ? AND yjs_write = ?",
      )
      .bind(generation, revision + 1, this.projectId, blob, revision)
      .run();
    return landedOneRow(result);
  }

  /**
   * Write a freshly built document as the row's first blob, and claim the row
   * in the same statement.
   *
   * `buildFromD1Rows` mints fresh struct ids, so a tail logged against another
   * document could never be applied to this one: a document without a blob gets
   * one before it accepts an edit. `updated_at` is untouched — a first blob
   * records what the rows already said.
   */
  private async writeInitialBlob(
    blob: Uint8Array,
    generation: number,
    revision: number,
  ): Promise<boolean> {
    const result = await this.env.DB
      .prepare(
        "UPDATE projects SET yjs_state = ?, yjs_generation = ?, yjs_seq = 0, yjs_write = ? " +
        "WHERE id = ? AND yjs_state IS NULL AND yjs_generation IS NULL AND yjs_seq IS NULL " +
        "AND yjs_write = ?",
      )
      .bind(blob, generation, revision + 1, this.projectId, revision)
      .run();
    return landedOneRow(result);
  }

  /**
   * Apply a claimed base, replay the log above it, and open the document on
   * what the two make — the base under suppression, the repairs above it not.
   *
   * The order is the phase rule. The base and the replay are the document being
   * restored, so nothing they do is the log's to record; the generation is bound
   * before suppression lifts, so a logger has one to write under; and the
   * repairs run unsuppressed and BEFORE admission, because they are real changes
   * that must survive a second eviction.
   */
  private async openStoredSequence(blob: Uint8Array, generation: number): Promise<void> {
    // Before the replay and before the repairs: the tail is measured above the
    // base this instance selected, and a repair's record written with no floor
    // set would be counted against a base that is not the document's.
    this.openAccounting(this.docSeq ?? 0);
    this.applyBase(blob, generation);
    await this.replayTail(generation);
    this.docGeneration = generation;
    this.logSuppressed = false;
    try {
      // Old blobs were serialized before object_type/subjects/source/credit (and
      // config.collection_mode) round-tripped through the snapshot, so their
      // Y.Maps lack those keys. getYText() returns null for a missing key, so
      // the editor's edits to those fields go nowhere (telar-compositor#23), and
      // the snapshot would otherwise clobber D1 with empty/default values. Seed
      // the missing keys from D1 here so existing projects self-heal on load.
      await this.backfillBlobGaps();
      await this.runPostLoadRepairs();
      // The repairs are unsuppressed transactions, so each is a record; one the
      // log could not hold latched a halt rather than throwing, and this is
      // where that latch is read — inside the try, so the disposal catch below
      // handles it and the phase order stands.
      this.refusePastHalt();
    } catch (err) {
      this.replaceDocument();
      throw err;
    }
    this.docLoaded = true;
  }

  /**
   * Apply a base, or one replayed record, under the halt rule for what cannot
   * be applied.
   *
   * The codec validates storage representation, not Yjs syntax: bytes it hands
   * back whole can still fail `Y.applyUpdate`, and an observer can throw after
   * the structs were integrated, which leaves a partial mutation that cannot be
   * excluded. Both are the document reaching a state it must not persist from,
   * so both dispose it and halt.
   */
  private applyBase(bytes: Uint8Array, generation: number): void {
    try {
      Y.applyUpdate(this.ydoc, bytes);
    } catch (err) {
      this.replaceDocument();
      throw this.haltedLoad("apply_failed", generation, err);
    }
  }

  /**
   * Replay every record above the sequence the base was tagged with, in order,
   * one page at a time.
   *
   * With no origin: an origin-less transaction reaches neither the guard's
   * identity check nor the accumulator, which is correct only because the log
   * carries the reverts enforcement issued together with the updates it accepted
   * — so a replay reconstructs what was applied AND corrected, and has neither
   * to enforce nor to credit again.
   *
   * A record the codec cannot read is corruption of an accepted record and
   * halts; a storage access that rejects is a refusal with no marker, because it
   * is transient and a marker would make it permanent.
   */
  private async replayTail(generation: number): Promise<void> {
    const records = replayLog(
      this.storage() as unknown as LogStorage,
      generation,
      this.docSeq ?? 0,
    );
    for (;;) {
      let next: IteratorResult<{ seq: number; bytes: Uint8Array }>;
      try {
        next = await records.next();
      } catch (err) {
        if (err instanceof LogCorruptionError) {
          this.replaceDocument();
          throw this.haltedLoad("log_corrupt", generation, err);
        }
        this.replaceDocument();
        throw new ExactBaseError(this.projectId, "generation_unreadable", { cause: err });
      }
      if (next.done === true) return;
      this.applyBase(next.value.bytes, generation);
      this.docSeq = next.value.seq;
      // The assembled bytes this replay applied, which is the payload a later
      // replay would apply again: the tail the accounting bounds is the one a
      // load has to run, not the storage it occupies.
      this.noteRecordWritten(next.value.seq, next.value.bytes.length);
    }
  }

  /**
   * Build a document from the entity rows, write it as the initial blob, and
   * open on it — in that order, so nothing is served that D1 does not hold.
   *
   * Every failure after the build disposes the document: `buildFromD1Rows`
   * appends into `this.ydoc`, so a second attempt on an instance that kept a
   * half-built one would persist every entity twice.
   */
  private async openColdBuild(
    revision: number,
    generation: number,
  ): Promise<ExactBaseReason | null> {
    let blob: Uint8Array;
    let landed: boolean;
    // A cold build's base is the initial blob at sequence 0, and the floor is
    // set before the build and the repairs run above it.
    this.openAccounting(0);
    try {
      await this.buildFromD1Rows();
      await this.runPostLoadRepairs();
      blob = Y.encodeStateAsUpdate(this.ydoc);
      landed = await this.writeInitialBlob(blob, generation, revision);
    } catch (err) {
      this.replaceDocument();
      throw err;
    }
    if (!landed) {
      // Another invocation wrote the row first; the re-read takes whatever it
      // left through the rules from the top and builds nothing.
      this.replaceDocument();
      return "initial_write_contended";
    }
    this.docSeq = 0;
    this.docWrite = revision + 1;
    // Bound and unsuppressed only once the initial write has landed: until then
    // there is no base for anything logged to extend.
    this.docGeneration = generation;
    this.logSuppressed = false;
    this.docLoaded = true;
    return null;
  }

  /**
   * The repairs every opened document runs, on the base path and the cold one
   * alike, before `docLoaded` opens it to anyone.
   */
  private async runPostLoadRepairs(): Promise<void> {
    this.documentRepairs();
    // After every step that can restore a marker (the blob, the log, the D1
    // backfill) and before anyone is admitted.
    this.dropStrandedCourseMarkers(await this.readParentProjectId());
    await this.settleGlossaryTermIds();

    // Before the first edit can arrive: the word baseline has to describe the
    // document as it stands, and the clock has to know whether the last
    // instance left somebody mid-stretch.
    this.seedWordBaseline();
    await this.seedEditingTime();
  }

  /**
   * Re-key every glossary term that shares a term_id with another, before
   * anyone is admitted. Two clients that each create a term at once each mint
   * its id against the terms they can see, so both can take `untitled-term`;
   * `glossary_terms(project_id, term_id)` is UNIQUE outside held ids (migration
   * 0072), so the pair must not reach D1 as one key, and a document loaded
   * holding one is settled here rather than at its next snapshot.
   *
   * The keeper is `deduplicateYArray`'s: the term D1 holds the key under (the
   * lowest id, where D1 holds it on several rows), then a saved term over an
   * unsaved one, then the earlier array position. Each other term gets
   * `makeUniqueTermId` against every key the document and D1 hold. Links
   * written as `[[untitled-term]]` keep pointing at the kept term: which term
   * a link meant is not answerable once two terms carried the id.
   *
   * A snapshot is armed when anything moved, since a cold build's repairs land
   * in the initial blob and write no record that would arm one.
   */
  private async settleGlossaryTermIds(): Promise<void> {
    // A load does not wait on D1 to decide a keeper: when the read fails the
    // repair is left to the next snapshot, which reads D1 before it writes.
    let d1Glossary: EntityKeyIndex;
    try {
      d1Glossary = await this.fetchEntityKeys("glossary_terms", "term_id");
    } catch {
      return;
    }
    if (this.deduplicateYArray("glossary", "term_id", d1Glossary.keyToId, isHeldTermId)) {
      void this.scheduleSnapshot();
    }
  }

  /**
   * The half of the repairs that acts on the document alone, apart from the
   * attribution seeding above it.
   *
   * The reset runs these and not the seeding: its replacement is built under
   * suppression and encoded before anything is spent, and the ledgers it will
   * be credited against are abandoned and reseeded only once the replacement
   * has landed.
   */
  private documentRepairs(): void {
    // Before anything else reads the document: a root that arrived through
    // `applyUpdate` has no type until it is asked for one, and both guards
    // recognise a root by `instanceof`. See `typeProtectedRoots`.
    typeProtectedRoots(this.ydoc);

    // A document assembled from a blob written before an entity carried its own
    // place has no order_key at all, and one built from D1 may carry whatever
    // the migration or an older worker left. Repair before the first reader
    // sees it.
    this.backfillOrderKeysEverywhere();

    // A blob imported before the header mapping modelled every spelling of a
    // field holds that field's value in the objects' extra_columns instead,
    // and publish writes it as a column beside the field's own. The repair
    // belongs here rather than in a D1 migration because this blob IS the
    // objects' extra_columns: a migration's write would be overwritten by the
    // next snapshot out of the document.
    // Wrapped, and deliberately not fatal. This repair runs before the
    // document is admitted, so a throw here fails the load and every publish
    // snapshot behind it — a stricter outcome than the stale column it exists
    // to fix. A document that cannot be repaired is still a document the
    // author must be able to open and publish; the export guard keeps its
    // column out of the file either way.
    //
    // The repair contains one object's failure itself and reports it, so what
    // reaches this catch is whatever yjs raises around the whole pass — the
    // array, the transaction — which no object's value bounds. That is the
    // whole project's repair and is reported as such.
    try {
      // Before the promotion, which writes through the map this creates.
      settleCustomFields(this.ydoc);
      this.promoteModelledObjectExtras();
    } catch (err) {
      this.reportExtrasRepairSkipped([describeError(err)], null);
    }

    this.reportConvenorOnlyConfigPlants();
    this.reportIdentityDomainPlants();
  }

  /**
   * Dispose the document and everything bound to it, leaving nothing a retry
   * could build into twice.
   *
   * `destroy()` is what releases the Awareness: y-protocols subscribes to the
   * document's `destroy` event. The next Awareness starts empty, and nothing
   * restores the open sockets' entries into it: a reset closes every one of
   * them, and after a failed load the entries return as their clients renew.
   * `/reset` calls this too, and the halt is cleared outside it, by the landed
   * replacement alone — a failed load must not clear a halt.
   */
  private replaceDocument(): void {
    this.ydoc.destroy();
    this.ydoc = new Y.Doc();
    this.docLoaded = false;
    this.docSeq = null;
    this.docWrite = null;
    // The accounting describes a tail above a base this document had, so it goes
    // with the document; the three lines a load may state are cleared with it,
    // so the next document says whatever it has to say for itself.
    this.baseSeq = null;
    this.logBytes = [];
    this.logBytesSinceBase = 0;
    this.compactionRefused = false;
    this.accountingStated = false;
    this.sizeWarned = false;
    // A document nothing has opened is in a restoring phase again: whatever is
    // built into it next is a base, not a change.
    this.logSuppressed = true;
    this.awareness = createAwareness(this.ydoc);
    this.attachDocHandlers(); // before the new doc takes any transaction
  }

  /** Close every attached socket, each in its own try. */
  private closeAllSockets(code: number, reason: string): void {
    for (const ws of this.ctx.getWebSockets()) closeSocket(ws, { code, reason });
  }

  /**
   * Enter the terminal refusal, once.
   *
   * The row this instance claimed is not the row it is writing to, so it can
   * neither persist what it holds nor honestly accept more. Persistence is
   * refused, every socket is closed with the try-again code and no reset frame,
   * and admission and mutation are refused until a `/reset` on this instance
   * lands its write. Nothing inside the object can ask for that reset.
   */
  private enterFenceRefused(
    phase: FencePhase,
    generation: number,
    detail: string,
  ): FenceRefusedError {
    // Reached only past re-acquisition's storage validation, which is what makes
    // a marker safe here: an invocation the platform has replaced fails that
    // validation and never arrives, so an obsolete instance cannot write down a
    // halt for a document that has passed to a replacement. The generation is
    // the one the refused write expected, never the cache.
    this.enterHalt("fence_refused", generation, `${phase} — ${detail}`);
    return new FenceRefusedError(this.projectId, phase, detail);
  }

  /**
   * Halt this generation's persistence, once, and hand back the error a load
   * throws for it.
   *
   * The document is disposed by the caller where it was mutated; this records
   * the halt.
   */
  private haltedLoad(reason: HaltReason, generation: number, cause?: unknown): PersistenceHaltedError {
    this.enterHalt(reason, generation, cause === undefined ? undefined : String(cause));
    const marker = this.persistenceHalted?.marker ?? { v: 1 as const, reason, at: Date.now() };
    return new PersistenceHaltedError(this.projectId, generation, marker);
  }

  /**
   * Enter the halt for one generation, durably, and never throw doing it.
   *
   * The order is the guarantee. The resident state and the message latch come
   * FIRST, so that whatever the put, a close or the alarm does, this instance is
   * halted in memory and the message in flight is failed; then one attempt at
   * the marker, inside its own `try`, because a resident halt with no durable
   * marker is refused until eviction and the next load, finding none, evaluates
   * the document again — which is the right outcome for an object whose storage
   * is failing; then the line; then the closes, issued AFTER the put so the
   * output gate holds them behind it; then the alarm.
   *
   * First halt wins, per generation. A marker already in storage is never
   * overwritten, so the reason and time of the original halt survive; a halt
   * under a DIFFERENT generation — the rebuilt document of a reset raising one
   * while the old halt is still resident — is a halt of its own.
   */
  private enterHalt(reason: HaltReason, generation: number, detail?: string): void {
    if (this.persistenceHalted?.generation === generation) return;

    // One clock reading for both representations: the resident `at` and the
    // marker's are the same value, so `/persistence-state` answers the same time
    // for a halt whether it reads the state or the storage behind it.
    const at = Date.now();
    const marker: HaltMarker = { v: 1, reason, at };
    this.persistenceHalted = { generation, marker };
    this.messageFailed = true;
    this.abandonAttribution();

    // Separate from the thrown value itself, since the sentinel for "no
    // failure" is `undefined` and the put can throw exactly that.
    let markerPutFailed = false;
    let markerFailure: unknown;
    try {
      // Un-awaited: the output gate holds every message initiated while the
      // write is pending, and a write that fails resets the object and discards
      // what was gated behind it. The rejection is the platform's to act on, and
      // is taken here only so it is not reported as unhandled.
      void writeGroup(
        this.storage() as unknown as LogStorage,
        encodeHalt(generation, reason, at),
      ).catch(() => { /* the platform's own failure path */ });
    } catch (err) {
      markerPutFailed = true;
      markerFailure = err;
    }

    // One line per halt, whatever the put did: a failed put is a clause of this
    // line rather than a line of its own. The conversion runs through
    // `describeThrown` so a value that cannot be printed does not itself throw.
    console.error(
      `[persistence][halted] project ${this.projectId}: generation ${generation} halted ` +
      `(${reason})${detail === undefined ? "" : ` — ${detail}`}. Persistence is refused ` +
      `until a reset rebuilds the document from D1.` +
      (markerPutFailed
        ? ` The marker could not be written: ${describeThrown(markerFailure)}.`
        : ""),
    );

    for (const ws of this.ctx.getWebSockets()) {
      closeSocket(ws, DOCUMENT_UNAVAILABLE_CLOSE);
    }

    try {
      void this.storage().deleteAlarm()?.catch(() => { /* nothing left to cancel */ });
    } catch {
      // A binding that throws synchronously is a throw like any other, and the
      // halt is already recorded.
    }
  }

  /**
   * Whether a halt stands for `generation`, read without a side effect.
   *
   * The resident state answers first, because an instance that is halted is
   * halted whatever storage says. Otherwise the durable marker is read through
   * the codec alone: `readHaltMarker` is the loader's, and on a marker it
   * installs the halt, abandons attribution, closes every socket and throws,
   * none of which a precondition may do. A marker present but unreadable counts
   * as a halt; a storage rejection is the caller's to hear about, and is thrown.
   */
  private async haltStandsFor(generation: number): Promise<boolean> {
    if (this.persistenceHalted !== null) return true;
    try {
      return (await readHalt(this.storage() as unknown as LogStorage, generation)) !== null;
    } catch (err) {
      if (err instanceof LogCorruptionError) return true;
      throw err;
    }
  }

  /**
   * Bind the route, then answer it. The signature is the route's own, so a
   * marker minted for another operation cannot reach this one.
   */
  private async answerPersistenceState(request: Request): Promise<Response> {
    const markerError = await verifyInternalMarker(
      request,
      this.env.SESSION_SECRET,
      "persistence-state",
    );
    if (markerError) return markerError;
    const bindError = await this.bindProjectIdFromMarker(request);
    if (bindError) return bindError;
    return await this.persistenceState();
  }

  /** The one answer a halt gives, on every route that refuses under it. */
  private answerHalted(): Response {
    return new Response(HALTED_BODY, { status: 503 });
  }

  /**
   * Report whether persistence is halted, and for which generation, without
   * touching anything.
   *
   * It reads and nothing else: no load, no claim, no repair, no flush, no
   * settlement, no reset, no write, no marker repair, no socket, no alarm. An
   * open document answers from the state it holds; an unloaded one answers from
   * storage, the generation first and then the marker for it. A marker present
   * but unreadable is reported as the halt it is, through this read rather than
   * through `enterHalt`, so the damaged value stands.
   *
   * `halted: false` says there is no durable halt for the current generation. It
   * does not say the document can load: everything else a load proves is the
   * loader's, and this route proves none of it.
   */
  private async persistenceState(): Promise<Response> {
    const resident = this.persistenceHalted;
    if (this.docLoaded && this.docGeneration !== null) {
      return Response.json(
        resident === null
          ? { halted: false, generation: this.docGeneration }
          : {
            halted: true,
            reason: resident.marker.reason,
            at: resident.marker.at,
            generation: this.docGeneration,
          },
      );
    }

    let generation: number;
    try {
      generation = await this.readGenerationFromStorage();
    } catch (err) {
      const malformed = err instanceof ExactBaseError && err.reason === "generation_malformed";
      return new Response(malformed ? "generation_malformed" : "storage_unavailable", {
        status: 503,
      });
    }

    try {
      const marker = await readHalt(this.storage() as unknown as LogStorage, generation);
      return Response.json(
        marker === null
          ? { halted: false, generation }
          : { halted: true, reason: marker.reason, at: marker.at, generation },
      );
    } catch (err) {
      if (err instanceof LogCorruptionError) {
        // A damaged marker carries no time of its own, and none is invented.
        return Response.json({ halted: true, reason: "bad_halt", generation });
      }
      return new Response("storage_unavailable", { status: 503 });
    }
  }

  /**
   * Give up every credit this instance has accrued and not yet written.
   *
   * The accumulator mutates its ledgers incrementally, an exception can leave
   * any of them partly applied, and a halted document's snapshot never runs — so
   * what is held here would either be written from a document nobody trusts or
   * carried into a rebuild that has no relation to it. The reset's contract,
   * under which updates since the last successful snapshot are abandoned,
   * extends to the attribution of the same span.
   *
   * Cleared IN PLACE: the observers captured these maps at construction, and a
   * fresh map would leave them writing into the old one. `activityEmitted` is
   * kept, because it is dedup history and the reservations the eager flush
   * takes, and clearing it would re-emit rows; `displacements` is bounded
   * telemetry rather than attribution. The baselines are invalidated so the
   * repairs reseed them: without the flag, `seedEditingTime` returns early and
   * the next change after a reset is credited a whole minute against a null
   * stamp.
   */
  private abandonAttribution(): void {
    this.userFieldSets.clear();
    this.lastEditAt.clear();
    this.editsByPath.clear();
    this.wordsByRow.clear();
    this.timeLedger.clear();
    this.newSessions.clear();
    this.wordBaseline.clear();
    this.timeSeeded = false;
    // Monotonic, and moved here as well as at a settlement: a reader whose await
    // spans the abandonment takes both figures again, and a settlement built
    // before it never subtracts seconds from an entry that does not hold them.
    this.settleEpoch++;
  }

  /**
   * Log the one `[exact-base]` line for a refusal raised outside
   * `ensureDocLoaded`, and hand the error back to be thrown.
   *
   * `ensureDocLoaded` owns that line for every refusal a load raises, and every
   * catch downstream treats the class as already logged. The snapshot's own
   * fresh generation read, its domain check and its headroom check run with no
   * loader above them, so without this owner they would reach `/snapshot`'s 500
   * having logged nothing at all. One line per failed attempt, from here.
   */
  private ownExactBaseLine(err: unknown): unknown {
    if (err instanceof ExactBaseError) {
      console.error(`[exact-base] project ${this.projectId}: ${err.reason}`);
    }
    return err;
  }

  /**
   * Decide what an uncertain write did, from the row and from ownership.
   *
   * Observe first, then prove ownership, then decide, and never observe again
   * after the proof. The re-read comes first because a storage validation taken
   * before it proves nothing about it: a replacement between the two would let
   * the read observe the replacement's claim, which sits at exactly the
   * revision a landed write of this instance's own would leave, with the same
   * tags. Ownership at the validation is enough, because ownership is lost once
   * and never regained: an instance that owned the object after its read owned
   * it throughout the span the read describes, and while it remains the owner
   * no write but its own can move a row it has claimed. So the observed
   * revision says exactly which of its own writes landed.
   */
  private async reacquireRow(
    phase: FencePhase,
    held: number,
    expectedGeneration: number,
    expectedSeq: number,
  ): Promise<"unchanged" | "adopted"> {
    const row = await this.env.DB
      .prepare("SELECT yjs_generation, yjs_seq, yjs_write FROM projects WHERE id = ?")
      .bind(this.projectId)
      .first<Record<string, unknown>>();

    let generation: number;
    try {
      generation = await this.readGenerationFromStorage();
    } catch (err) {
      throw this.ownExactBaseLine(err);
    }

    if (!row) throw this.enterFenceRefused(phase, expectedGeneration, "the project row is gone");
    const revision = row.yjs_write;
    if (!isSafeCount(revision)) {
      throw this.enterFenceRefused(
        phase,
        expectedGeneration,
        "the row carries no readable revision",
      );
    }
    // Nothing landed — but only if the row is still this instance's document.
    // A revision that has not moved says nothing on its own: storage has to
    // prove the object is still this instance's, and the row's tags have to be
    // a shape one of this instance's own predecessors leaves. A row above the
    // expected generation, a mixed or malformed tag pair, or a storage
    // generation other than the expected one belongs to another lineage, and
    // treating that as a retryable failure would leave the instance serving
    // editors whose edits can never reach it.
    //
    // The replacement is the one phase whose unmoved row is EXPECTED to carry
    // another generation: `/reset` advances the generation in storage before it
    // writes, so a replacement that did not land leaves the old generation on
    // the row at `p` and expects the new one only at `p + 1`.
    if (revision === held) {
      if (phase !== "replacement" && !isPredecessorRow(row, generation, expectedGeneration)) {
        throw this.enterFenceRefused(
          phase,
          expectedGeneration,
          `the row is at revision ${held} under generation ` +
          `${String(row.yjs_generation)}, and this instance serves generation ${expectedGeneration}`,
        );
      }
      return "unchanged";
    }
    // The write landed and its acknowledgement was lost. The tags name this
    // write, and the generation is still the one this instance serves.
    if (
      revision === held + 1 &&
      generation === expectedGeneration &&
      row.yjs_generation === expectedGeneration &&
      row.yjs_seq === expectedSeq
    ) {
      return "adopted";
    }
    throw this.enterFenceRefused(
      phase,
      expectedGeneration,
      `the row is at revision ${String(revision)} under generation ` +
      `${String(row.yjs_generation)}, and this instance holds ${held}`,
    );
  }

  /**
   * Write the blob and its tags, conditioned on the revision this instance
   * holds, and move that revision.
   *
   * One row means the write landed. Zero rows means the row moved, which only a
   * replacement can have done, and the caller re-acquires rather than guessing.
   */
  private async writeBaseRow(
    blob: Uint8Array,
    generation: number,
    seq: number,
    held: number,
    now: string,
  ): Promise<boolean> {
    const result = await this.env.DB
      .prepare(
        "UPDATE projects SET yjs_state = ?, yjs_generation = ?, yjs_seq = ?, yjs_write = ?, " +
        "updated_at = ? WHERE id = ? AND yjs_write = ?",
      )
      .bind(blob, generation, seq, held + 1, now, this.projectId, held)
      .run();
    return landedOneRow(result);
  }

  /**
   * Run the entity batch with the revision asserted inside its own transaction.
   *
   * The guard insert aborts unless the row holds exactly the claimed revision —
   * a missing project row aborts too — and an aborting statement aborts the
   * whole batch, so no UPDATE or DELETE from a superseded invocation can
   * regress a row a replacement has since written. The advance moves the
   * revision atomically with the entity statements it protects, and the delete
   * leaves the guard table empty outside the transaction.
   */
  private async guardedBatch(
    statements: D1PreparedStatement[],
    held: number,
  ): Promise<void> {
    await this.env.DB.batch([
      this.env.DB
        .prepare("INSERT INTO yjs_write_guard (project_id, expected) VALUES (?, ?)")
        .bind(this.projectId, held),
      this.env.DB
        .prepare("UPDATE projects SET yjs_write = ? WHERE id = ?")
        .bind(held + 1, this.projectId),
      ...statements,
      this.env.DB
        .prepare("DELETE FROM yjs_write_guard WHERE project_id = ?")
        .bind(this.projectId),
    ]);
  }

  /**
   * Write the blob conditioned on the revision this instance holds, and settle
   * what an uncertain outcome means.
   *
   * A landed write moves the revision. A zero-row result or a thrown statement
   * is re-acquired: the row at the revision held says nothing landed and the
   * write is retried later; the row one above it, under the tags this write
   * bound, says it landed and its acknowledgement was lost, and the batch
   * follows it exactly as it would have. Anything else is a row this instance
   * does not own.
   *
   * A landed write — acknowledged or adopted, and nothing else — retires the
   * storage base's header before this returns, so the row is never the older of
   * two bases the next load can choose between. An eviction between the write
   * and the deletion is covered by the authority rule: the row's sequence is at
   * least the base's, so the row wins and the loader retires the header itself.
   * The base's parts are maintenance's.
   *
   * The log's records at or below the written sequence go next, in the order
   * §4.3 fixes: the header first and awaited, so no base is ever left pointing
   * at a tail shortened beneath it. Both precede the entity batch, which is
   * safe because every backfill precedes the encoding and nothing after it
   * mutates the document.
   */
  private async writeFencedBase(
    blob: Uint8Array,
    generation: number,
    seq: number,
    held: number,
    now: string,
  ): Promise<void> {
    let landed: boolean;
    let failure: unknown;
    try {
      landed = await this.writeBaseRow(blob, generation, seq, held, now);
    } catch (err) {
      landed = false;
      failure = err;
    }
    if (landed) {
      this.snapshotBlob = { outcome: "landed", seq };
    } else {
      // The reason stands before the settlement is attempted, because a
      // reacquisition that refuses or cannot be taken throws through it: an
      // encoding and a blob attempt that reached no row is why the batch did
      // not run, whichever of the three ends settled it. Only an adoption goes
      // on to the batch, which names its own reason there.
      this.snapshotBatch = { outcome: "not_attempted", reason: "blob_not_landed" };
      if (!(await this.settleBlobWrite(held, generation, seq))) {
        // Nothing landed. The blob is retried on the next snapshot, with the
        // entity INSERTs before it left as the disclosed residual they already
        // are.
        throw failure ?? new Error("blob write matched no row and the row had not moved");
      }
    }
    this.docWrite = held + 1;
    // Before the fallible cleanup and before the batch, whatever either does:
    // the row holds a base at `seq` from here on, and a counter describing an
    // older base would compact a document that has just been folded. A record
    // above `seq` — one the log took while the blob write was pending — is
    // kept.
    this.trimAccounting(seq);
    await this.retireHeaderForSnapshot(generation);
    // Best-effort, and only after the header: what the row's own sequence
    // covers is redundant, and records left behind are excluded by the next
    // load's replay rather than misread by it, so a refusal here is a line in
    // the log and the next landed write's work.
    this.snapshotRetirement = await this.retireLogBelow(generation, seq);
  }

  /**
   * Settle a blob write that matched no row, and answer whether it landed.
   *
   * The re-acquisition's three ends are three different facts and are recorded
   * apart: the row unchanged is a write that did not land and will be retried;
   * a refusal established is a fence lost, which halts; and a re-acquisition
   * that could not be taken at all establishes nothing, so it is `unresolved`
   * with the reason storage or D1 gave and never a refusal invented from it.
   */
  private async settleBlobWrite(
    held: number,
    generation: number,
    seq: number,
  ): Promise<boolean> {
    try {
      if ((await this.reacquireRow("blob", held, generation, seq)) === "unchanged") {
        this.snapshotBlob = { outcome: "not_landed", seq: null };
        return false;
      }
      this.snapshotBlob = { outcome: "adopted", seq };
      return true;
    } catch (err) {
      this.snapshotBlob = describeReacquisition(err);
      throw err;
    }
  }

  /**
   * Retire the storage base's header, recording which side of it the snapshot
   * stopped on.
   *
   * A header that could not be retired stops the snapshot before the batch even
   * though the blob landed: the row is the newer base and a header still
   * standing over an older one is exactly the state the retirement exists to
   * remove, so the batch waits for a pass that can complete it.
   */
  private async retireHeaderForSnapshot(generation: number): Promise<void> {
    try {
      await this.retireBaseHeader(generation);
      this.snapshotHeader = "retired";
    } catch (err) {
      this.snapshotHeader = "failed";
      this.snapshotBatch = { outcome: "not_attempted", reason: "header_failed" };
      throw err;
    }
  }

  /**
   * Make a generation's storage base unreachable, in one awaited deletion of
   * its header alone.
   *
   * The header is what names the parts, so a reader that finds none reads no
   * base at all; the parts left behind are orphans maintenance sweeps under an
   * absent header. Deleting them here would need a second confirmed write with
   * a window between the two in which the header names parts that are gone.
   */
  private async retireBaseHeader(generation: number): Promise<void> {
    await this.storage().delete([baseKey(generation)]);
  }

  /**
   * Delete a generation's log records at or below `seq`, in bounded awaited
   * pages, and answer how far it got.
   *
   * The caller's contract is one thing: an exact base at or above `seq` — the
   * D1 row a landed fenced write left, or a storage base a compaction wrote —
   * is durably in place, and the same gate is held throughout. Everything at or
   * below `seq` is then redundant, because a load applies that base and replays
   * only what stands above its sequence.
   *
   * The `log:<g>:` namespace is this object's own, so every key under it below
   * the bound is disposable, a malformed one included: the codec skips such a
   * key on read, and the sweep is what removes it. The bound is exact because
   * the codec's keys are fixed-width — a record's header `log:g:<n>` and its
   * parts `log:g:<n>:<part>` both sort below `log:g:<s+1>` for every `n ≤ s`.
   * At `MAX_SEQ` there is no successor inside the codec's domain, and the
   * domain is not widened for one listing: the prefix alone bounds it, and
   * every key under the prefix is at or below `MAX_SEQ` by construction.
   *
   * Traversal is ascending and each page's deletion is awaited, which is what
   * keeps a partially retired record from reading as corrupt: parts can remain
   * without the header that named them, and those orphans a reader ignores,
   * but a header that still stands has every part it names. The first failure
   * stops the invocation for the same reason — a further page would delete
   * keys past one whose fate is unknown.
   *
   * The budget is the maintenance slice's, spent per invocation rather than
   * shared with it: an alarm that runs both spends two of them under one gate.
   * The guarantee is on operation counts, not on elapsed time. A page is held
   * only as its keys and the cursor, never as its values.
   *
   * Nothing above `seq`, nothing under another generation, no base key and no
   * halt key is listed or deleted.
   */
  private async retireLogBelow(generation: number, seq: number): Promise<LogRetirement> {
    const progress: LogRetirement = {
      outcome: "rejected",
      deleted: 0,
      lists: 0,
      deleteCalls: 0,
      firstDeleted: null,
      lastDeleted: null,
    };
    try {
      await this.sweepLogBelow(generation, seq, progress);
    } catch (err) {
      console.error(
        `[persistence][retirement] project ${this.projectId}: ` +
        `generation ${generation} at or below sequence ${seq} was not retired`,
        err,
      );
      // The counts the sweep reached are kept: what a rejection has to carry is
      // how far it got, not a fresh zero.
      progress.outcome = "rejected";
      return progress;
    }
    return progress;
  }

  /**
   * Page the eligible range ascending, deleting each page, until a short page
   * proves the range drained or a budget runs out.
   *
   * Writes into `progress` as it goes, so the count survives the failure the
   * caller reports: a rejection carries the keys already deleted.
   */
  private async sweepLogBelow(
    generation: number,
    seq: number,
    progress: LogRetirement,
  ): Promise<void> {
    const storage = this.storage() as unknown as LogStorage;
    const prefix = logPrefix(generation);
    const end = seq < MAX_SEQ ? logKey(generation, seq + 1) : undefined;
    const budget: MaintenanceBudget = {
      deletes: this.retirementBudget.deletes ?? MAINTENANCE_DELETE_BUDGET,
      lists: this.retirementBudget.lists ?? MAINTENANCE_LIST_BUDGET,
    };
    let startAfter: string | undefined;
    for (;;) {
      if (budget.deletes <= 0 || budget.lists <= 0) {
        progress.outcome = "exhausted";
        return;
      }
      const limit = Math.min(MAINTENANCE_LIST_PAGE, budget.deletes);
      budget.lists -= 1;
      progress.lists += 1;
      const keys = [...(await storage.list<unknown>({ prefix, startAfter, end, limit })).keys()];
      if (keys.length > 0) {
        startAfter = keys[keys.length - 1];
        // Recorded before the deletion is awaited, so a rejection carries the
        // range the sweep had reached rather than the range it had settled.
        progress.deleteCalls += 1;
        if (progress.firstDeleted === null) progress.firstDeleted = keys[0];
        progress.lastDeleted = keys[keys.length - 1];
        const removed = await deleteKeys(storage, keys);
        budget.deletes -= removed;
        progress.deleted += removed;
      }
      // A page shorter than what was asked for is the end of the eligible
      // range; a full one proves nothing about the key after it.
      if (keys.length < limit) {
        progress.outcome = "complete";
        return;
      }
    }
  }

  /**
   * Run the entity batch under the guard, and settle what an uncertain outcome
   * means.
   *
   * Every batch error takes the same path, the guard's own abort included:
   * after a lost acknowledgement, a guard abort is exactly how an already-landed
   * batch presents on the retry, so the marker is a reason to log and never a
   * decision. A batch that did not land is rescheduled and rethrown, with the
   * ledgers still owed.
   */
  private async runFencedBatch(
    statements: D1PreparedStatement[],
    held: number,
    generation: number,
    seq: number,
  ): Promise<void> {
    try {
      await this.guardedBatch(statements, held);
      this.snapshotBatch = { outcome: "landed", reason: null };
    } catch (err) {
      if (!(await this.settleBatch(held, generation, seq))) {
        this.scheduleSnapshot();
        throw err;
      }
    }
    this.docWrite = held + 1;
  }

  /**
   * Settle a batch whose outcome the throw left uncertain, and answer whether
   * it landed. The same three ends as the blob's, recorded at this boundary.
   */
  private async settleBatch(
    held: number,
    generation: number,
    seq: number,
  ): Promise<boolean> {
    try {
      if ((await this.reacquireRow("batch", held, generation, seq)) === "unchanged") {
        this.snapshotBatch = { outcome: "not_landed", reason: null };
        return false;
      }
      this.snapshotBatch = { outcome: "adopted", reason: null };
      return true;
    } catch (err) {
      const settled = describeReacquisition(err);
      this.snapshotBatch = {
        outcome: settled.outcome,
        reason: null,
        ...(settled.cause === undefined ? {} : { cause: settled.cause }),
      };
      throw err;
    }
  }

  /**
   * Flush the document to D1 and answer whether it is current.
   *
   * 200 is the publish action's only signal that D1 holds what the document
   * holds, so every other outcome is a refusal it fails closed on. The failure
   * is carried out of the gate rather than thrown through it: an exception
   * escaping a `blockConcurrencyWhile` callback discards the DO, the response is
   * never sent, and the publish action reads the resulting rejection as "no DO
   * alive" and ships stale D1.
   */
  private async runForcedSnapshot(): Promise<Response> {
    // Drain an in-flight snapshot BEFORE the gate, for the same reason
    // /clear-course-markers, /restore-orphans and /ingest-sync do: inside
    // the gate the running snapshot's own D1 responses are blocked, so the
    // loop could never observe the flag clearing. Bounded, so a wedged
    // snapshot ends in a refusal the caller can act on rather than a DO
    // spinning until the runtime resets it.
    for (let i = 0; this.isSnapshotting && i < SNAPSHOT_DRAIN_MAX_POLLS; i++) {
      await new Promise((r) => setTimeout(r, SNAPSHOT_DRAIN_POLL_MS));
    }

    // The catch sits INSIDE the callback, and the failure is carried out
    // rather than thrown through. An exception escaping a
    // blockConcurrencyWhile callback makes Cloudflare terminate and
    // discard the DO: the response is never sent, the sockets drop, and
    // the publish action reads the resulting fetch rejection as "no DO
    // alive" and ships stale D1. A callback that always resolves is what
    // makes the 500 below reachable at all.
    //
    // 500 rather than 503: the publish action must stop and tell the
    // author, not retry behind their back.
    let failure: unknown;
    let flushed = false;
    let refused = false;
    await this.ctx.blockConcurrencyWhile(async () => {
      try {
        await this.ensureDocLoaded();
        // Inside the gate, after the load and before anything is written.
        if (this.persistenceHalted !== null) {
          refused = true;
          return;
        }
        flushed = await this.flushSnapshotNow();
      } catch (err) {
        failure = err;
      }
    });
    // A halt met at the gate, and a halt this request's own flush entered: both
    // answer with the state's own name, in place of the code a snapshot failure
    // would take. A snapshot that failed for any other reason keeps that code.
    if (refused || this.persistenceHalted !== null) return this.answerHalted();
    if (failure !== undefined) {
      // The loader and the halt each own their own line; this one adds nothing
      // for either.
      if (!isNamedPersistenceRefusal(failure)) {
        console.error("[snapshot] forced snapshot failed", failure);
      }
      return new Response("snapshot_failed", { status: 500 });
    }
    if (!flushed) {
      // `snapshotToD1` returns silently when the lock is still held, the
      // document never loaded, or enforcement or a plant the runtime could
      // not repair has halted persistence — and silence is not a flush.
      // This 200 is the publish action's only signal
      // that D1 is current, so answering it on a snapshot that did not run
      // ships stale rows under a success banner. 503 rather than 500:
      // nothing failed, and a retry is the right move — the same refusal
      // /clear-course-markers gives, and the one a halted project must keep
      // getting so the halt reads as the halt it is.
      console.error(
        `[snapshot] project ${this.projectId}: snapshot skipped, D1 not flushed`,
      );
      return new Response("snapshot_blocked", { status: 503 });
    }
    // The flush ran and wrote everything it could — and lost at least one
    // entity on the way. A snapshot cannot abort mid-flush, so the loss
    // arrives here rather than as a throw, and answering 200 on it is the
    // publish action being told D1 is authoritative when D1 has no row for
    // that entity: the site ships without it, under a success banner.
    //
    // Its own code, not `snapshot_failed`. Nothing about the snapshot broke,
    // and the author is told a specific entity is missing rather than that
    // their edits are unsaved. 500 for the same reason `snapshot_failed`
    // takes 500: a refused INSERT rarely clears on its own, so the publish
    // action must stop and tell the author rather than retry behind them.
    const unlanded = this.snapshotInsertFailures.filter((f) => f.kind === "insert");
    if (unlanded.length > 0) {
      console.error(
        `[snapshot] project ${this.projectId}: ${unlanded.length} entity INSERT(s) did not ` +
        `land — ${unlanded.map((f) => `${f.table} "${f.key}"`).join(", ")}`,
      );
      return new Response("snapshot_incomplete", { status: 500 });
    }
    return new Response("OK", { status: 200 });
  }

  /**
   * Replace the row's base and the in-memory document with one built from the
   * D1 entity rows, in one conditioned write and under the ownership rules.
   *
   * The order is the fence. The generation and the row's revision are read
   * first; the replacement is built and staged as the next generation's storage
   * base; ownership is then validated by the storage put that advances the
   * generation, which an invocation the platform has already replaced cannot
   * complete; and the replacement binds the revision that was read. No read
   * sits between the put and the write, so a reset cannot pick up a
   * replacement's revision and destroy its base.
   *
   * What each side of the switch costs: a failure before it spends nothing —
   * the generation, the row and the old base stand, and the editors reconnect
   * to them. A failure after it leaves the new generation with an exact base
   * the next load serves, so no second reset is needed to make the project
   * loadable again.
   *
   * Failures are carried out of the gate rather than thrown through it: a
   * throwing callback discards the DO, which takes the very sockets this route
   * needs to close with it.
   */
  private async runReset(
    guards: ResetGuards = { expectedGeneration: null, requireNotHalted: false, binding: undefined },
  ): Promise<Response> {
    // A local of this call, shared by reference with every step below, so the
    // last-resort catch knows what an escaping exception has to undo.
    const progress: ResetProgress = { at: "before-replace", step: "installation" };
    // The callback always resolves: an exception escaping a
    // `blockConcurrencyWhile` callback discards the DO, which takes the very
    // sockets this route needs to close with it.
    const outcome: ResetOutcome = await this.ctx.blockConcurrencyWhile(async () => {
      try {
        return await this.replaceBaseAtomically(guards, progress);
      } catch (err) {
        return this.settleEscapedReset(err, progress);
      }
    });

    return this.answerReset(outcome);
  }

  /**
   * Settle an exception no step of the reset caught, from the phase it reached.
   *
   * The last resort, and the reason no exit can leave `docLoaded` true on a
   * document the reset abandoned: before anything was replaced there is nothing
   * to dispose; from the replacement on and short of a landed write the
   * document goes and the sockets are told to come back; and past a landed
   * write the row holds the replacement, so the route answers ok whatever
   * finalisation did.
   */
  private settleEscapedReset(err: unknown, progress: ResetProgress): ResetOutcome {
    if (progress.at === "before-replace") return { kind: "failed", err };
    if (progress.at === "landed") {
      this.abandonFinalisation(err, progress);
      return { kind: "ok" };
    }
    return { kind: "failed", err: this.abandonReset(err) };
  }

  /** The status and the one line each reset outcome owes. */
  private answerReset(outcome: ResetOutcome): Response {
    if (outcome.kind === "ok") return new Response("OK", { status: 200 });
    // A precondition the caller stated and the object did not meet. Nothing was
    // read past the generation, nothing was written, and no socket was touched,
    // so this is neither a failure of the object nor a line in its log: the
    // caller is being told which of the two it asked about stands.
    if (outcome.kind === "stale") {
      return new Response(`reset_stale:${outcome.generation}`, { status: 409 });
    }
    if (outcome.kind === "halted") {
      return new Response("reset_halted", { status: 409 });
    }
    if (outcome.kind === "halt-unreadable") {
      console.error(
        `[reset] project ${this.projectId}: the halt marker could not be read`,
        outcome.err,
      );
    } else if (outcome.kind === "stage") {
      console.error(`[reset] project ${this.projectId}: ${outcome.detail}`, outcome.err);
    } else if (outcome.kind === "generation") {
      console.error(
        `[reset] project ${this.projectId}: generation could not be advanced`,
        outcome.err,
      );
    } else if (outcome.kind === "read") {
      console.error(`[reset] project ${this.projectId}: the row could not be read`, outcome.err);
    } else if (!isNamedPersistenceRefusal(outcome.err)) {
      // The loader and the fence each own their own line; this one adds
      // nothing for either.
      console.error(`[reset] project ${this.projectId}: reset failed`, outcome.err);
    }
    // 503, not 500: nothing here is permanently broken, so the caller's move is
    // to try again. A retry is a second reset rather than a repeat of the first
    // — each one that reaches the put spends a generation — which is why the
    // caller's expected generation has to be a freshly read one.
    return new Response("reset_failed", { status: 503 });
  }

  /**
   * The reset's own steps, in the order that makes it a fence: read the
   * generation and the row, rebuild and repair the document, stage it as the
   * next generation's base, switch the generation, and replace the row.
   *
   * The switch is the ownership validation and the atomic act alike: everything
   * before it leaves D1, the generation and the old base exactly as they were,
   * and from it on the generation is spent. A failure before it still disposes
   * the rebuilt document and closes the sockets, because the build replaced the
   * document this instance was serving; what survives is the durable state, and
   * the editors reconnect to it.
   *
   * The caller's preconditions are compared here, immediately after the
   * generation read and inside the gate, because that is the one point at which
   * two confirmations of the same halt can be told apart: the object serialises
   * resets, so the first advances the generation and the second reads the
   * generation it does not expect.
   */
  private async replaceBaseAtomically(
    guards: ResetGuards,
    progress: ResetProgress,
  ): Promise<ResetOutcome> {
    let generation: number;
    try {
      generation = await this.readGenerationFromStorage();
    } catch (err) {
      return { kind: "generation", err };
    }
    if (guards.expectedGeneration !== null && guards.expectedGeneration !== generation) {
      return { kind: "stale", generation };
    }
    if (guards.requireNotHalted) {
      let halted: boolean;
      try {
        halted = await this.haltStandsFor(generation);
      } catch (err) {
        return { kind: "halt-unreadable", err };
      }
      if (halted) return { kind: "halted" };
    }
    if (!Number.isSafeInteger(generation + 1)) {
      return { kind: "generation", err: new ExactBaseError(this.projectId, "generation_exhausted") };
    }

    let base: BaseRow;
    try {
      base = await this.readBaseRow();
    } catch (err) {
      return { kind: "read", err };
    }

    return await this.rebuildAndReplace(generation + 1, base.revision, progress);
  }

  /**
   * Rebuild the document from the entity rows, stage it as the next
   * generation's base, switch the generation, and replace the row's base with
   * it in one write conditioned on the revision read before the switch.
   *
   * Everything up to the switch is undone by abandoning: the sockets close, the
   * editors reconnect to the old base, and the generation, the row and the old
   * base stand untouched. The switch itself is the atomic act, and a rejected
   * put is uncertain rather than unchanged — the promise's rejection does not
   * prove the value did not land — so it is settled as switched-unresolved and
   * the cached generation is dropped, leaving the next read to say which of the
   * two exact bases storage names.
   */
  private async rebuildAndReplace(
    generation: number,
    revision: number,
    progress: ResetProgress,
  ): Promise<ResetOutcome> {
    let blob: Uint8Array;
    try {
      // Set before the call, because `replaceDocument` destroys the served
      // document before it constructs the next: a throw inside it already needs
      // disposal.
      progress.at = "replacing";
      this.replaceDocument();
      await this.buildFromD1Rows();
      // The document repairs alone. The ledgers the seeding would describe are
      // abandoned and reseeded by the landed replacement, against the document
      // the row then holds.
      this.documentRepairs();
      // D1 can hold a marker for a course the site has left, when a clear's
      // flush failed; the replacement is built without it.
      this.dropStrandedCourseMarkers(await this.readParentProjectId());
      blob = Y.encodeStateAsUpdate(this.ydoc);
    } catch (err) {
      return { kind: "failed", err: this.abandonReset(err) };
    }

    try {
      await this.stageBase(generation, blob);
    } catch (err) {
      return {
        kind: "stage",
        err: this.abandonReset(err),
        detail: blob.length > MAX_RECORD_BYTES
          ? `the replacement of ${blob.length} bytes is above the ` +
            `${MAX_RECORD_BYTES}-byte record ceiling and cannot be staged`
          : "the staged base could not be written",
      };
    }
    progress.at = "replaced";

    try {
      await this.storage().put(DOC_GENERATION_KEY, generation);
    } catch (err) {
      // The value may have landed all the same, so the cached generation is
      // dropped rather than guessed at: the next read takes it from storage.
      this.docGeneration = null;
      return { kind: "generation", err: this.abandonReset(err) };
    }
    this.docGeneration = generation;
    progress.at = "switched";

    return await this.landReplacement(generation, revision, blob, progress);
  }

  /**
   * Write the replacement as the next generation's storage base, awaited, in
   * one group of parts and a header.
   *
   * Awaited because this is a route rather than the message path: the base has
   * to be durable before the switch names it. Until the generation moves,
   * `base:<generation>` is unreachable — no loader lists it and no reader asks
   * for it — so a partial group left by a failed issue costs nothing, and a
   * smaller successful retry's surplus parts are ignored by the reader and
   * swept by maintenance.
   */
  private async stageBase(generation: number, blob: Uint8Array): Promise<void> {
    await writeGroup(
      this.storage() as unknown as LogStorage,
      encodeBase(generation, 0, blob),
    );
  }

  /**
   * Write the replacement into the row under the revision read before the
   * switch, and settle what an uncertain outcome means.
   *
   * Three ways short of an acknowledgement: the row unmoved says nothing landed,
   * and the staged base is what the next load serves for the new generation, so
   * the failure is retryable without a second reset; the row moved under this
   * write's own tags says it landed and its acknowledgement was lost, and it is
   * adopted; anything else is a row this instance does not own, which is the
   * fence refusal, with the staged base left where it stands.
   */
  private async landReplacement(
    generation: number,
    revision: number,
    blob: Uint8Array,
    progress: ResetProgress,
  ): Promise<ResetOutcome> {
    let landed: boolean;
    let writeFailure: unknown;
    try {
      landed = await this.writeBaseRow(blob, generation, 0, revision, new Date().toISOString());
    } catch (err) {
      landed = false;
      writeFailure = err;
    }
    if (!landed) {
      try {
        if (await this.reacquireRow("replacement", revision, generation, 0) === "unchanged") {
          return {
            kind: "failed",
            err: this.abandonReset(
              writeFailure ?? new Error("the replacement matched no row and the row had not moved"),
            ),
          };
        }
      } catch (err) {
        return { kind: "failed", err: this.abandonReset(err) };
      }
    }
    // Set on acknowledgement or adoption and before installation begins: from
    // here the row holds the replacement, and no exit may say otherwise.
    progress.at = "landed";
    try {
      await this.installReplacement(generation, revision, progress);
    } catch (err) {
      this.abandonFinalisation(err, progress);
    }
    return { kind: "ok" };
  }

  /**
   * Open this instance on the replacement the row now holds.
   *
   * The order is what a landed replacement owes. The document is installed;
   * the ledgers, which belong to a document this reset has discarded, are
   * abandoned and reseeded against the replacement; the staged header is
   * retired so the row is the generation's only base, its parts left to
   * maintenance;
   * maintenance is armed for the generation just superseded; and only then are
   * the editors told to come back.
   *
   * Each operation names itself in `progress.step` before it begins, so the one
   * line a failure past the landed write owes can say which of the five it was.
   */
  private async installReplacement(
    generation: number,
    revision: number,
    progress: ResetProgress,
  ): Promise<void> {
    progress.step = "installation";
    this.docSeq = 0;
    this.openAccounting(0);
    this.docWrite = revision + 1;
    // Cleared only by a landed replacement, never earlier: this is the one write
    // that proves the instance owns the row again, and the rebuild reads D1,
    // which never received a refused deletion. Any generation the replacement
    // supersedes goes with it — a reset that switched without landing leaves a
    // halt under a generation already advanced past, and the retry that lands is
    // what clears it. A halt the REBUILD raised belongs to this generation and
    // stays, since nothing has replaced the document it names.
    if (this.persistenceHalted !== null && this.persistenceHalted.generation < generation) {
      this.persistenceHalted = null;
      this.messageFailed = false;
    }
    // The replacement is the document, and it opens directly: the reset does not
    // go through the loader, so this is the third and last place suppression is
    // cleared.
    this.logSuppressed = false;
    this.docLoaded = true;

    // Cleared in place, so the observers bound at construction keep writing into
    // the maps this reads; `timeSeeded` is left false by the abandonment, so the
    // seed below takes its one stamp read whatever state this reset arrived in.
    progress.step = "attribution";
    this.abandonAttribution();
    this.seedWordBaseline();
    await this.seedEditingTime();

    progress.step = "retirement";
    await this.retireBaseHeader(generation);
    progress.step = "scheduling";
    await this.scheduleMaintenance();

    // The object's own record of a landed replacement, kept independently of
    // what the caller does with the 200: an operator reading these logs must be
    // able to place the rebuild without the application's line beside it.
    console.log(
      `[reset] project ${this.projectId}: rebuilt at generation ${generation}, ` +
      `revision ${revision + 1}`,
    );
    progress.step = "announcement";
    this.announceReset();
  }

  /**
   * Report a failure past a landed replacement, and dispose what this instance
   * holds.
   *
   * The row is at the new generation and nothing describes it otherwise: the
   * replacement is durable, the next load serves it, and the state after a
   * landed replacement is never dependent on finalisation. One line, naming the
   * project, the landed status and which of the five finalisation operations
   * failed, because that is all an operator has to place it by.
   */
  private abandonFinalisation(err: unknown, progress: ResetProgress): void {
    console.error(
      `[reset] project ${this.projectId}: the replacement landed and its ` +
      `${progress.step} failed`,
      err,
    );
    this.abandonReset(err);
  }

  /**
   * Tell every connected client to discard its document, then close the socket.
   *
   * The close alone does not achieve that — y-websocket reconnects on any close
   * code and carries the same Y.Doc back in. The generation guard on the upgrade
   * path is what makes the refusal binding; this message only saves the client a
   * bounced reconnect, and reaches the clients that are connected right now. One
   * that is offline through the reset meets the guard instead.
   */
  private announceReset(): void {
    const resetEncoder = encoding.createEncoder();
    encoding.writeVarUint(resetEncoder, messageSessionControl);
    encoding.writeUint8(resetEncoder, subStateReset);
    encoding.writeVarUint(resetEncoder, this.docGeneration ?? 0);
    const resetMsg = encoding.toUint8Array(resetEncoder);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(resetMsg); } catch { /* client may have disconnected */ }
      try { ws.close(1012, "State reset"); } catch { /* already closed */ }
    }
  }

  /**
   * Give up what this instance holds, on the same terms at every phase: the
   * document goes and the sockets are told to come back.
   *
   * Disposal is independent of how far the reset got, because the build has
   * already replaced the served document by the time any of this is reachable.
   * What the editors come back to is whatever the durable state names — the old
   * base, the staged base, or the row a landed replacement holds.
   */
  private abandonReset(err: unknown): unknown {
    this.replaceDocument();
    // The stamps this attempt read describe a document no instance serves after
    // this, and the next seeding must read them again: seeding is idempotent,
    // and one that skipped the read would credit the next change a whole minute
    // against a null stamp.
    this.timeSeeded = false;
    this.closeAllSockets(DOCUMENT_UNAVAILABLE_CLOSE.code, DOCUMENT_UNAVAILABLE_CLOSE.reason);
    return err;
  }

  /**
   * Report a config column the snapshot held, and say what it did about it.
   *
   * `reportMalformed` is the wrong line here and its second sentence is the
   * reason: it says rows are left in place and the table's orphan sweep is
   * suspended, which is false for a singleton row nothing sweeps. What
   * actually happens is that the column is left out of the UPDATE, so D1 keeps
   * what it holds — and on the INSERT branch, where there is no row to keep
   * anything, that the column binds the value an untouched project writes.
   *
   * The type name is computed without converting the value, on the same terms
   * as every other detection line: a plant can be shaped so that rendering it
   * throws, and a log line that did so inside a snapshot would refuse the
   * batch it was meant to explain.
   */
  private reportConfigHold(key: string, found: string, rowExists: boolean): void {
    console.error(
      `[shape][detected] project ${this.projectId}: arm=value-domain root=config — ` +
      `a value the snapshot cannot read stands at config.${key} (a ${found}); ` +
      (rowExists
        ? "the column keeps what D1 holds and nothing is repaired"
        : "the column binds its unset value and nothing is repaired"),
    );
  }

  /**
   * Log any shared value standing at one of the six convenor-only config keys.
   *
   * A plant is any live shared type or subdocument, by `isSharedValue` rather
   * than by `instanceof Y.AbstractType`, so a subdocument counts. The name is
   * `typeNameOf`'s, which answers `shared-type` for every shared value outside
   * the three the mirror models. The value is client-authored and is never
   * rendered: a value can be shaped so that rendering it throws, and inside a
   * load that refuses the document to every editor of the project.
   *
   * Nothing here repairs a plant. A repair has to choose a replacement, the
   * only authority for one is D1, and that read can fail inside a load; the
   * detection reads no value, consults no authority, cannot fail and cannot
   * defer, so a planted document is admitted on exactly the terms every other
   * document is. What keeps the plant out of D1 is the snapshot, which leaves
   * a column it cannot read out of the UPDATE, so D1 keeps what it holds. A
   * convenor replaces the plant with a scalar `set` on the config page.
   *
   * The rule those six carry is enforced on ASSIGNMENT: a client that sets
   * `url` changes the config root, and the guard reads `tr.changed` for the
   * root. A value that is itself a shared type is a separate type with its own
   * entry — editing the `Y.Text` at `url` changes that `Y.Text` and never the
   * root, so no guard runs. The entry guards refuse every new one and cannot
   * reach one a blob restores, which is what this scan is for.
   *
   * Cost on an ordinary load is six map reads and no D1 round trip. `share` is
   * read directly rather than through `getMap` so a document that never built
   * a config root is answered without one being created.
   */
  private reportConvenorOnlyConfigPlants(): void {
    const root = (this.ydoc as unknown as { share: Map<string, unknown> })
      .share.get(CONFIG_ROOT);
    if (!(root instanceof Y.Map)) return;
    const config = root as Y.Map<unknown>;

    const planted: string[] = [];
    for (const key of CONVENOR_ONLY_CONFIG_FIELDS) {
      const value = config.get(key);
      if (!isSharedValue(value)) continue;
      planted.push(`config.${key} (a ${typeNameOf(value)})`);
    }
    if (planted.length === 0) return;

    // One line, loud, with its own tag for `wrangler tail`. Arm, root, keys
    // and type names only: the value is the one thing this must never render.
    console.error(
      `[config][detected] project ${this.projectId}: arm=value-domain root=config — ` +
      `${planted.length} shared value(s) stand at ${planted.join(", ")}. The document ` +
      "loads unchanged, the values are not rendered, and the snapshot writes no " +
      "column that holds one.",
    );
  }

  /**
   * Log any value standing at an identity key that is not the KIND of thing
   * that key holds.
   *
   * The guard half of this rule lives in `extractIdentityDomainViolations` and
   * at the `/ingest-sync` boundary in `partitionOnIdentityDomain`; both refuse
   * new values, and neither can reach a value a blob restores.
   *
   * Removing one here is what this deliberately does not do. A removal has to
   * choose a replacement, and every available replacement is a guess: only D1
   * can say which row owns a key, that read can fail, and the fallbacks — mint
   * a key, blank the row id, resolve it from the value's own rendering — each
   * either invent a reference the entity never had or read identity out of
   * attacker input. `pages.slug` and `glossary.term_id` are rename features, so
   * a collaborator can put a victim's valid string on a planted map while the
   * authority is unavailable, and a recovery that resolved the row from that
   * string would hand over the victim's row. A removal also has to run before
   * the document opens, which puts arbitrary work on untrusted values in front
   * of every load: a value whose rendering throws refuses the document to
   * everyone, permanently. Detection has none of those properties — it reads no
   * value, consults no authority, cannot fail and cannot defer — so a planted
   * document is admitted on exactly the terms every other document is, and
   * there is no window in which edits are accepted but not persisted.
   *
   * What that leaves is a plant standing in an open document, which is a known
   * state rather than a hidden one. The entry guards refuse every NEW one; the
   * snapshot settles an out-of-domain `_id` through its own adopt-or-reinsert
   * branch, which matches on the human key; and `deduplicateYArray` reconciles
   * a rendered human key against D1, which re-keys the loser — except where the
   * planted map also carries the victim's row id, where the exact-`_id` rule
   * collapses the pair and the legitimate map is the one that can lose. That
   * last outcome is the accepted cost of detecting rather than guessing, and
   * the log below is what makes it answerable.
   *
   * The rendered form of an out-of-domain value is attacker input and is never
   * an input to identity — not to a repair, and not to a report either.
   * `String(["9"])` is "9", so a report that named the value would be reading
   * a row id out of it, which is the same operation the defect is made of; and
   * a value can be shaped so that rendering it throws, which inside a load
   * would refuse the document to every editor of the project. So the report is
   * by POSITION, on the same terms as `partitionOnIdentityDomain`'s refusals:
   * the position names the entry exactly, and the document resolves it.
   */
  /**
   * The boolean fields of an entity that are out of domain, if any.
   *
   * A caller finding one writes NOTHING for that entity — not the INSERT, not
   * the UPDATE — and protects its row from the sweep.
   *
   * Binding the column's default instead would be an exposure, not a
   * conservative reading: `private` and `draft` withhold a story when they are
   * 1, so resolving a value the server cannot read to 0 publishes work its
   * author kept back, and it does so on the strength of a value a collaborator
   * wrote. There is no default that is safe in both directions, which is what
   * says the decision does not belong to a default at all. The entity is
   * unreadable, so it is left as it stands and the plant is reported.
   */
  private malformedFlags(
    yMap: Y.Map<unknown>,
    keys: readonly string[],
  ): { key: string; found: string } | null {
    for (const key of keys) {
      const read = readFlag(yMap.get(key));
      if (!read.ok && read.reason === "wrong_type") return { key, found: read.found };
    }
    return null;
  }

  /**
   * Report a value whose SHAPE the reconciler refused, and say what it did
   * about it.
   *
   * The sibling of `reportIdentityDomainPlants`, on the same terms and for the
   * same reason: the position names the entry exactly and the document
   * resolves it, while the value itself is attacker input and is never
   * rendered. `found` is a type name computed without converting the value —
   * a plant can be shaped so that rendering it throws, and a log line that did
   * so inside a snapshot would refuse the batch it was meant to explain.
   *
   * The second sentence is the one an operator needs: a malformed container
   * suspends its table's orphan sweep, so rows that really are orphaned stay
   * in D1 until the document is cleaned up. That is the intended trade and it
   * should not look like a silent success.
   */
  private reportMalformed(root: string, at: string, found?: string): void {
    console.error(
      `[shape][detected] project ${this.projectId}: arm=value-domain root=${root} — ` +
      `a value the reconciler cannot read stands at ${at}` +
      (found ? ` (a ${found})` : "") +
      ". Its rows in D1 are left in place and this table's orphan sweep is " +
      "suspended for this snapshot; nothing is deleted and nothing is repaired.",
    );
  }

  private reportIdentityDomainPlants(): void {
    const share = (this.ydoc as unknown as { share: Map<string, unknown> }).share;
    const positions: string[] = [];
    const roots = new Set<string>();

    const collect = (
      yMap: Y.Map<unknown>,
      domainKeys: ReadonlySet<string>,
      root: string,
      at: string,
    ): void => {
      for (const key of domainKeys) {
        if (isIdentityValueInDomain(key, yMap.get(key))) continue;
        positions.push(`${at}.${key}`);
        roots.add(root);
      }
    };

    const nestedDomainKeys = (nestedKey: "steps" | "layers"): ReadonlySet<string> =>
      IDENTITY_DOMAIN_KEYS_BY_NESTED_KEY.get(nestedKey) ?? new Set<string>();

    for (const [root, domainKeys] of IDENTITY_DOMAIN_KEYS_BY_ROOT) {
      const array = share.get(root);
      if (!(array instanceof Y.Array)) continue;
      for (let i = 0; i < array.length; i++) {
        const member = array.get(i);
        if (!(member instanceof Y.Map)) continue;
        const yMap = member as Y.Map<unknown>;
        collect(yMap, domainKeys, root, `${root}[${i}]`);
        // Steps and layers hang off their story and nowhere else, so the walk
        // reaches them through the parent rather than by root name.
        if (root !== "stories") continue;
        const steps = yMap.get("steps");
        if (!(steps instanceof Y.Array)) continue;
        for (let si = 0; si < steps.length; si++) {
          const step = steps.get(si);
          if (!(step instanceof Y.Map)) continue;
          const stepMap = step as Y.Map<unknown>;
          const stepAt = `${root}[${i}].steps[${si}]`;
          collect(stepMap, nestedDomainKeys("steps"), root, stepAt);
          const layers = stepMap.get("layers");
          if (!(layers instanceof Y.Array)) continue;
          for (let li = 0; li < layers.length; li++) {
            const layer = layers.get(li);
            if (!(layer instanceof Y.Map)) continue;
            collect(
              layer as Y.Map<unknown>,
              nestedDomainKeys("layers"),
              root,
              `${stepAt}.layers[${li}]`,
            );
          }
        }
      }
    }

    if (positions.length === 0) return;

    // One line, loud, with its own tag for `wrangler tail`. Arm, roots and
    // positions only: the value is the one thing this must never render.
    console.error(
      `[identity][detected] project ${this.projectId}: arm=identity-domain ` +
      `roots=${[...roots].join(",")} — ${positions.length} out-of-domain identity ` +
      `value(s) stand at ${positions.join(", ")}. The document loads unchanged and ` +
      "the values are not rendered.",
    );
  }

  /**
   * Give every entry of every collaborative list a canonical, distinct
   * `order_key`, preserving the order the document currently presents.
   *
   * An entry's place is its order_key; the Y.Array position is not consulted by
   * any reader. Documents in the wild predate that: theirs is implied by array
   * position, and whatever integer rank they carry (`order`, `step_number`,
   * `layer_number`) may be absent, duplicated or all zero. `backfillOrderKeys`
   * takes the order from the document itself — which for a key-less list IS the
   * array order — so a project self-heals into exactly the lists its editors
   * were already looking at.
   *
   * Nested lists are walked through their parents rather than by name, because
   * a step's layers hang off that step and nowhere else. The walk is over the
   * raw arrays: repairing a parent's keys does not move its children, and the
   * children's repair does not depend on the parent's order.
   *
   * Null origin, so the repair is attributed to no user, and silent on a
   * healthy document: it writes nothing, which is what keeps a document that
   * has been reordered since conversion from being dragged back into array
   * order. Same shape and the same reason as `backfillBlobGaps` above.
   */
  private backfillOrderKeysEverywhere(): void {
    const storiesArray = this.ydoc.getArray<Y.Map<unknown>>("stories");
    const objectsArray = this.ydoc.getArray<Y.Map<unknown>>("objects");
    const glossaryArray = this.ydoc.getArray<Y.Map<unknown>>("glossary");
    const pagesArray = this.ydoc.getArray<Y.Map<unknown>>("pages");

    this.ydoc.transact(() => {
      backfillOrderKeys(storiesArray);
      backfillOrderKeys(objectsArray);
      backfillOrderKeys(glossaryArray);
      backfillOrderKeys(pagesArray);

      for (const storyMap of entityMaps(storiesArray).maps) {
        const stepsArray = storyMap.get("steps");
        if (!(stepsArray instanceof Y.Array)) continue;
        backfillOrderKeys(stepsArray as Y.Array<Y.Map<unknown>>);
        for (const stepMap of entityMaps(stepsArray).maps) {
          const layersArray = stepMap.get("layers");
          if (!(layersArray instanceof Y.Array)) continue;
          backfillOrderKeys(layersArray as Y.Array<Y.Map<unknown>>);
        }
      }
    }, null);
  }

  /**
   * Move a modelled objects field out of `extra_columns` and into its own key.
   *
   * Silent on a healthy document: `promoteModelledExtras` reports no change
   * when a blob holds only the author's own columns, and nothing is written —
   * no transaction content, so no update is emitted and no snapshot is dirtied
   * by merely opening a project. One transaction under a null origin, like the
   * order-key backfill beside it, so the repair is attributed to nobody and
   * earns no contribution credit.
   *
   * Where the field is empty the blob's value fills it; where the field
   * already holds something, the field wins — see `promoteModelledExtras` for
   * why that direction is the safe one.
   */
  /**
   * One objects Y.Map value as the string a CSV cell would have held.
   *
   * The map mixes Y.Text (the collaboratively edited fields) with plain
   * strings (the passthrough ones), and a key a document predates is simply
   * absent. Anything else is treated as empty rather than coerced: only a
   * value that could have come from a cell may be compared with one.
   *
   * `proseString` and not `toString`, on the same terms as every other prose
   * render: `instanceof Y.Text` admits `Y.XmlText`, whose render throws on an
   * embed that converts to no primitive, and this runs inside the load.
   */
  private static readObjectFieldAsString(value: unknown): string {
    if (value instanceof Y.Text) return proseString(value);
    if (typeof value === "string") return value;
    // A boolean or number is a value the field HOLDS, so it reads as populated
    // and the blob's copy of it goes. `featured` is the case that exists: it is
    // always one or the other, never absent, and treating `false` as an empty
    // field would leave the blob key in place for ever.
    if (typeof value === "boolean" || typeof value === "number") return String(value);
    return "";
  }

  /**
   * The arrival fold. Inside a message it is staged for every socket with what
   * the guard stages, so each has it before the message's relay; outside one,
   * the route that wrote the blob sends the document itself. It is sent as the
   * whole state, as the guard's correction is: an update diffed against a
   * state vector taken inside `afterTransaction` leaves out what this nested
   * transaction wrote.
   */
  private foldOnArrival(): void {
    if (!settleCustomFields(this.ydoc) || this.messageGroup === null) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, messageSync);
    syncProtocol.writeSyncStep2(enc, this.ydoc);
    const msg = encoding.toUint8Array(enc);
    for (const ws of this.ctx.getWebSockets()) this.stagedEffects.sends.push({ ws, msg });
  }

  /** The `extra_columns` blob the snapshot writes for one object. */
  private objectCustomBlob(objMap: Y.Map<unknown>): string {
    return customFieldsBlob(objMap, () => customFieldBases(this.ydoc.getArray("objects")));
  }

  private promoteModelledObjectExtras(): void {
    const objectsArray = this.ydoc.getArray<Y.Map<unknown>>("objects");
    if (objectsArray.length === 0) return;

    // Decide everything before opening the transaction, so a document with
    // nothing to repair never opens one at all.
    const repairs: Array<{ map: Y.Map<unknown>; result: PromotedExtras }> = [];
    // One object whose repair cannot be decided or written is one object's
    // stale column, and containing it there is what keeps it there. The
    // objects are independent — each reads its own blob and writes its own
    // keys — so a catch shared across the loop lets the first unreadable
    // object decide the outcome for every object after it. This runs on every
    // load, so a shared catch is the repair off for the whole project on
    // every load for as long as the value stands.
    const skipped: string[] = [];
    for (const objectMap of entityMaps(objectsArray).maps) {
      try {
        const raw = objectMap.get("extra_columns");
        if (typeof raw !== "string" || raw === "") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // A corrupt blob is left exactly as it is: publish already degrades
          // to {} on one, so it emits no column to collide with, and rewriting
          // it here would destroy whatever a recovery might still read.
          continue;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;

        // Every field any alias can target, read whatever shape the key holds:
        // the modelled set covers the whole objects schema, and the objects
        // Y.Map stores some keys as Y.Text and some as plain strings.
        const current: Record<string, string> = {};
        for (const field of new Set(Object.values(MODELLED_OBJECT_EXTRA_ALIASES))) {
          current[field] = ProjectCollaborationDO.readObjectFieldAsString(objectMap.get(field));
        }
        const result = promoteModelledExtras(parsed as Record<string, unknown>, current);
        if (result.changed) repairs.push({ map: objectMap, result });
      } catch (err) {
        skipped.push(`${ProjectCollaborationDO.objectLabel(objectMap)} (read): ${describeError(err)}`);
      }
    }
    if (repairs.length > 0) {
      this.ydoc.transact(() => {
        for (const { map, result } of repairs) {
          try {
            applyCustomBlob(map, Object.keys(result.extras).length > 0 ? JSON.stringify(result.extras) : "");
            for (const [key, value] of Object.entries(result.fields)) {
              // The FIELD's representation, from the registry — never the
              // current occupant's. A document that predates the key has
              // nothing there, and guessing from that writes a plain string
              // into a field the editor reads with `getYText`: it returns null
              // for anything that is not a Y.Text, so the field would read as
              // absent and later edits would never leave the client.
              if (OBJECT_FIELD_YDOC_KIND[key] === "ytext") this.replaceYText(map, key, value);
              else map.set(key, value);
            }
          } catch (err) {
            // Inside the transaction, so this object may already hold part of
            // its repair. That is the same state a second load would reach and
            // the promotion is idempotent — the blob keeps every key the field
            // did not take — so a partial object is repairable and a skipped
            // object is not made worse by it.
            skipped.push(`${ProjectCollaborationDO.objectLabel(map)} (write): ${describeError(err)}`);
          }
        }
      }, null);
    }
    if (skipped.length > 0) this.reportExtrasRepairSkipped(skipped, objectsArray.length);
  }

  /**
   * One object named for a log line, by its D1 row id or as unsaved.
   *
   * The id is read through its domain and nothing else about the object is
   * read: every other key is client-authored, and a log line built from one
   * hands the value back to whoever planted it.
   */
  private static objectLabel(map: Y.Map<unknown>): string {
    const read = readRowId(map.get("_id"));
    return read.ok ? `object ${read.value}` : "an unsaved object";
  }

  /**
   * Report the objects the extras repair could not finish, and what stands
   * after it.
   *
   * The repair is not the author's request and its failure is not theirs to
   * act on, so this is a log line rather than anything the screen shows. What
   * it has to carry is that the repair ran and did not finish HERE: the column
   * it exists to remove stays in the blob, publish writes it beside the
   * field's own, and every later load will try and fail the same way until the
   * value goes. Silence is what made this indistinguishable from a healthy
   * document.
   *
   * A null `total` is the pass itself failing rather than any object in it,
   * which is the one case where the count of objects affected is every object
   * and none of them is named.
   */
  private reportExtrasRepairSkipped(skipped: string[], total: number | null): void {
    console.error(
      `[shape][detected] project ${this.projectId}: arm=extras-repair root=objects — ` +
      (total === null
        ? "the repair did not run and every object kept its extra_columns"
        : `${skipped.length} of ${total} objects kept their extra_columns`) +
      `: ${skipped.join("; ")}`,
    );
  }

  /**
   * Seed Y.Doc keys that pre-date their addition to the snapshot round-trip onto
   * a blob-restored doc, reading current values from D1. Idempotent and
   * non-destructive: only fills a key when it is absent, never overwriting a
   * value already in the live doc (which may hold an unsaved edit). Runs under a
   * null-origin transaction so it is not attributed to any user (no activity /
   * contribution). Without this, an established project (which always restores
   * from the blob, not buildFromD1Rows) would never gain the new keys.
   *
   * A step's `extra_columns` is a passthrough too, seeded the same way: an
   * absent key takes D1's value, and a key already holding one, `""` included,
   * keeps it, because `""` is a removal the snapshot may not have written yet.
   *
   * The four prose keys are the ones that can displace something, so they are
   * the ones reported: the condition is `instanceof Y.Text` rather than an
   * absent key, and a key holding anything else has that value replaced by
   * D1's. The passthroughs and the two config toggles seed on an absent key
   * alone and can displace nothing, so there is nothing about them a reader
   * could act on.
   *
   * What cannot reach an absent prose key is the author. A field is editable
   * only while it holds a `Y.Text` — `getYText` returns null for anything else
   * — so clearing one empties the text in place and the key survives; and the
   * only key deletions in worker code are the course marker and the guarded
   * keys a refused mutation reverts, of which these four are none. So the
   * states this seeds over are a document older than the field, and a client
   * writing straight to the protocol.
   */
  private async backfillBlobGaps(): Promise<void> {
    if (!this.projectId) return;

    // Objects: the four editable Y.Text fields + the three import passthroughs.
    const objectsArray = this.ydoc.getArray<Y.Map<unknown>>("objects");
    let objectRows: { results: ObjectRow[] } = { results: [] };
    if (objectsArray.length > 0) {
      objectRows = await this.env.DB
        .prepare(
          "SELECT id, object_type, subjects, source, credit, thumbnail, dimensions, " +
          "extra_columns, course_project_id FROM objects WHERE project_id = ?",
        )
        .bind(this.projectId)
        .all<ObjectRow>();
    }
    const objectById = new Map(objectRows.results.map((r) => [r.id, r]));

    // Steps: only rows holding kept cells are read; any other step seeds "".
    const storiesArray = this.ydoc.getArray<Y.Map<unknown>>("stories");
    let stepExtraRows: { results: Array<{ id: number; extra_columns: string }> } = { results: [] };
    if (storiesArray.length > 0) {
      stepExtraRows = await this.env.DB
        .prepare(
          "SELECT st.id, st.extra_columns FROM steps st " +
          "INNER JOIN stories s ON st.story_id = s.id " +
          "WHERE s.project_id = ? AND st.extra_columns IS NOT NULL",
        )
        .bind(this.projectId)
        .all<{ id: number; extra_columns: string }>();
    }
    const stepExtrasById = new Map(stepExtraRows.results.map((r) => [r.id, r.extra_columns]));

    // Config: collection_mode and skip_stories are the toggles missing from
    // older blobs.
    const configRow = await this.env.DB
      .prepare("SELECT collection_mode, skip_stories FROM project_config WHERE project_id = ? LIMIT 1")
      .bind(this.projectId)
      .first<{ collection_mode: number | null; skip_stories: number | null }>();

    // One tally per (key, what stood there) pair for the report below. Counts
    // and not objects: the intended population is every object of a legacy
    // project, so a line per object would be thousands, and the number is
    // what the retirement decision needs — the repair can go when this stops
    // being printed.
    const seeded = new Map<string, number>();
    // Counted apart from the tally rather than read back off it: the two cases
    // differ in what the seed cost, and a report that told them apart by the
    // shape of a string it had just built would be answering from its own
    // formatting.
    let displaced = 0;
    const seedProse = (o: Y.Map<unknown>, key: string, value: string): void => {
      const current = o.get(key);
      if (current instanceof Y.Text) return;
      if (current !== undefined) displaced += 1;
      const at = `${key} (${typeNameOf(current)})`;
      seeded.set(at, (seeded.get(at) ?? 0) + 1);
      o.set(key, new Y.Text(value));
    };

    this.ydoc.transact(() => {
      for (const o of entityMaps(objectsArray).maps) {
        // Only a value in the row-id domain addresses a row; anything else
        // looks up nothing, which is what an unsaved object already does here.
        const idRead = readRowId(o.get("_id"));
        const r = idRead.ok ? objectById.get(idRead.value) : undefined;
        // Editable Y.Text fields — create only when absent so a live edit wins.
        seedProse(o, "object_type", r?.object_type ?? "");
        seedProse(o, "subjects", r?.subjects ?? "");
        seedProse(o, "source", r?.source ?? "");
        seedProse(o, "credit", r?.credit ?? "");
        // Passthrough values.
        if (o.get("thumbnail") === undefined) o.set("thumbnail", r?.thumbnail ?? "");
        if (o.get("dimensions") === undefined) o.set("dimensions", r?.dimensions ?? "");
        if (o.get("extra_columns") === undefined) o.set("extra_columns", r?.extra_columns ?? "");
        // The course marker seeds only from a non-null D1 value: an unmarked
        // object must stay key-less, and the snapshot UPDATE binds the absent
        // key as NULL, so seeding null here would be a no-op that hides the
        // real gap — a marked object whose blob predates the key would lose
        // its marker on the next snapshot without this.
        if (o.get("course_project_id") === undefined && r?.course_project_id != null) {
          o.set("course_project_id", r.course_project_id);
        }
      }

      seedStepExtraColumns(storiesArray, stepExtrasById);

      const config = this.ydoc.getMap<unknown>("config");
      if (config.get("collection_mode") === undefined) {
        config.set("collection_mode", configRow?.collection_mode === 1);
      }
      if (config.get("skip_stories") === undefined) {
        config.set("skip_stories", configRow?.skip_stories === 1);
      }
    }, null);

    if (seeded.size > 0) this.reportBlobBackfill(seeded, displaced);
    await this.backfillPageFrontmatter();
  }

  /**
   * A page's `frontmatter` on a blob that predates the key: an absent key
   * takes D1's value, NULL included, and a key already present keeps what it
   * holds, since the document is the one source for it once loaded. Under a
   * null origin, like the rest of the blob backfill.
   */
  private async backfillPageFrontmatter(): Promise<void> {
    const pagesArray = this.ydoc.getArray<Y.Map<unknown>>("pages");
    const missing = entityMaps(pagesArray).maps.filter((m) => !m.has("frontmatter"));
    if (missing.length === 0) return;
    const rows = await this.env.DB
      .prepare("SELECT id, frontmatter FROM project_pages WHERE project_id = ?")
      .bind(this.projectId)
      .all<{ id: number; frontmatter: string | null }>();
    const byId = new Map(rows.results.map((r) => [r.id, r.frontmatter]));
    this.ydoc.transact(() => {
      for (const m of missing) {
        if (m.has("frontmatter")) continue;
        const idRead = readRowId(m.get("_id"));
        m.set("frontmatter", (idRead.ok ? byId.get(idRead.value) : undefined) ?? null);
      }
    }, null);
  }

  /**
   * Report the prose keys the blob backfill seeded from D1, and at what.
   *
   * An absent key is the repair doing what it was written for, so it is a
   * warning: the document predates the field and D1 is the only authority for
   * it. A key holding something else is a value no part of this product
   * writes, and the seed replaced it, so it is an error on the same terms as
   * `reportConfigHold` — and on the same terms it names the TYPE and never
   * the value.
   *
   * Both are reported, not just the second. The absent count is the size of
   * the population the repair exists for, and it is the only measurement that
   * can say the repair has nothing left to do.
   */
  private reportBlobBackfill(seeded: ReadonlyMap<string, number>, displaced: number): void {
    const line =
      `[shape][detected] project ${this.projectId}: arm=blob-backfill root=objects — ` +
      "prose keys holding no Y.Text, seeded from D1: " +
      [...seeded].map(([at, n]) => `${at} ×${n}`).join(", ");
    if (displaced > 0) console.error(`${line}; ${displaced} of them held a value, which is gone`);
    else console.warn(line);
  }

  /**
   * Build the Y.Doc from D1 rows on cold start.
   * Populates config, stories (with steps and layers), objects, and glossary.
   */
  private async buildFromD1Rows(): Promise<void> {
    if (!this.projectId) return;

    // Fetch all data in parallel
    const [configRow, landingRow, stories, steps, layers, objects, glossary, pages] =
      await Promise.all([
        this.env.DB
          .prepare("SELECT * FROM project_config WHERE project_id = ? LIMIT 1")
          .bind(this.projectId)
          .first<ConfigRow>(),
        this.env.DB
          .prepare("SELECT * FROM project_landing WHERE project_id = ? LIMIT 1")
          .bind(this.projectId)
          .first<LandingRow>(),
        this.env.DB
          // order_key is the ordering; "order" and id only settle ties on a
          // document whose keys the backfill has not reached yet.
          .prepare("SELECT * FROM stories WHERE project_id = ? ORDER BY order_key ASC, \"order\" ASC, id ASC")
          .bind(this.projectId)
          .all<StoryRow>(),
        this.env.DB
          .prepare(
            "SELECT st.* FROM steps st " +
            "INNER JOIN stories s ON st.story_id = s.id " +
            // order_key is the ordering; step_number and id only settle ties
            // on a document whose keys the backfill has not reached yet.
            "WHERE s.project_id = ? ORDER BY st.story_id ASC, st.order_key ASC, st.step_number ASC, st.id ASC",
          )
          .bind(this.projectId)
          .all<StepRow>(),
        this.env.DB
          .prepare(
            "SELECT l.* FROM layers l " +
            "INNER JOIN steps st ON l.step_id = st.id " +
            "INNER JOIN stories s ON st.story_id = s.id " +
            "WHERE s.project_id = ? ORDER BY l.step_id ASC, l.order_key ASC, l.layer_number ASC, l.id ASC",
          )
          .bind(this.projectId)
          .all<LayerRow>(),
        this.env.DB
          .prepare(
            "SELECT id, object_id, title, creator, description, alt_text, source_url, " +
            "period, year, object_type, subjects, source, credit, thumbnail, dimensions, " +
            "extra_columns, featured, image_available, order_key, created_by, course_project_id " +
            "FROM objects WHERE project_id = ? ORDER BY order_key ASC, id ASC",
          )
          .bind(this.projectId)
          .all<ObjectRow>(),
        this.env.DB
          .prepare("SELECT * FROM glossary_terms WHERE project_id = ? ORDER BY order_key ASC, id ASC")
          .bind(this.projectId)
          .all<GlossaryRow>(),
        this.env.DB
          .prepare("SELECT id, title, slug, body, frontmatter, \"order\", order_key, created_by FROM project_pages WHERE project_id = ? ORDER BY order_key ASC, \"order\" ASC, id ASC")
          .bind(this.projectId)
          .all<PageRow>(),
      ]);

    // Build lookup maps for steps and layers
    const stepsByStoryId = new Map<number, StepRow[]>();
    for (const step of steps.results) {
      const arr = stepsByStoryId.get(step.story_id) ?? [];
      arr.push(step);
      stepsByStoryId.set(step.story_id, arr);
    }

    const layersByStepId = new Map<number, LayerRow[]>();
    for (const layer of layers.results) {
      const arr = layersByStepId.get(layer.step_id) ?? [];
      arr.push(layer);
      layersByStepId.set(layer.step_id, arr);
    }

    // Populate everything in a single transaction to avoid multiple observer fires
    this.ydoc.transact(() => {
      // ---- meta ----
      const meta = this.ydoc.getMap<unknown>("meta");
      meta.set("projectId", this.projectId);

      // ---- config ----
      const config = this.ydoc.getMap<unknown>("config");
      if (configRow) {
        // Text fields — use Y.Text for character-level merging
        const titleText = new Y.Text(configRow.title ?? "");
        config.set("title", titleText);
        const descText = new Y.Text(configRow.description ?? "");
        config.set("description", descText);
        const authorText = new Y.Text(configRow.author ?? "");
        config.set("author", authorText);
        const emailText = new Y.Text(configRow.email ?? "");
        config.set("email", emailText);

        // Scalar fields — plain values (atomically replaced)
        config.set("lang", configRow.lang ?? "en");
        config.set("baseurl", configRow.baseurl ?? "");
        config.set("url", configRow.url ?? "");
        config.set("telar_version", configRow.telar_version ?? "");
        config.set("theme", configRow.theme ?? "");
        config.set("logo", configRow.logo ?? "");
        config.set("include_demo_content", configRow.include_demo_content === 1);
        config.set("google_sheets_enabled", configRow.google_sheets_enabled === 1);
        config.set("google_sheets_published_url", configRow.google_sheets_published_url ?? "");
        config.set("show_on_homepage", configRow.show_on_homepage !== 0);
        config.set("show_story_steps", configRow.show_story_steps !== 0);
        config.set("show_object_credits", configRow.show_object_credits !== 0);
        config.set("browse_and_search", configRow.browse_and_search !== 0);
        config.set("show_link_on_homepage", configRow.show_link_on_homepage !== 0);
        config.set("show_sample_on_homepage", configRow.show_sample_on_homepage === 1);
        config.set("collection_mode", configRow.collection_mode === 1);
        config.set("skip_stories", configRow.skip_stories === 1);
        config.set("featured_count", configRow.featured_count ?? 4);
        config.set("story_key", configRow.story_key ?? "");
      }

      // ---- landing (nested map inside config) ----
      const landing = new Y.Map<unknown>();
      if (landingRow) {
        landing.set("stories_heading", new Y.Text(landingRow.stories_heading ?? ""));
        landing.set("stories_intro", new Y.Text(landingRow.stories_intro ?? ""));
        landing.set("objects_heading", new Y.Text(landingRow.objects_heading ?? ""));
        landing.set("objects_intro", new Y.Text(landingRow.objects_intro ?? ""));
        landing.set("welcome_body", new Y.Text(landingRow.welcome_body ?? ""));
      }
      config.set("landing", landing);

      // ---- navigation (Y.Array of plain objects inside config map) ----
      const navJson = configRow?.navigation_json ?? null;
      let navItems: unknown[];
      if (navJson) {
        try { navItems = JSON.parse(navJson); } catch { navItems = []; }
      } else {
        // Build default navigation from already-fetched pages + built-in sections
        // (pages is fetched in the parallel Promise.all above — no DB call needed here)
        navItems = [];
        // Built-in sections match Telar site nav order: Home, Objects, Glossary
        navItems.push({ type: "builtin", key: "home", label: "Home", visible: true });
        navItems.push({ type: "builtin", key: "collection", label: "Objects", visible: true });
        navItems.push({ type: "builtin", key: "glossary", label: "Glossary", visible: true });
        // Pages from D1 in order
        for (const page of pages.results) {
          navItems.push({ type: "page", slug: page.slug, label: page.title || page.slug, visible: true });
        }
      }
      const navArray = new Y.Array<unknown>();
      navArray.push(navItems);
      config.set("navigation", navArray);

      // ---- stories ----
      const storiesArray = this.ydoc.getArray<Y.Map<unknown>>("stories");
      for (const story of stories.results) {
        const storyMap = new Y.Map<unknown>();
        storyMap.set("_id", story.id);
        storyMap.set("story_id", story.story_id);
        storyMap.set("title", new Y.Text(story.title ?? ""));
        storyMap.set("subtitle", new Y.Text(story.subtitle ?? ""));
        storyMap.set("byline", new Y.Text(story.byline ?? ""));
        // Carried verbatim; a null or degenerate value is repaired by
        // backfillStoryOrderKeys once the doc is assembled.
        storyMap.set(ORDER_KEY, story.order_key ?? null);
        storyMap.set("private", story.private === 1);
        storyMap.set("draft", story.draft === 1);
        storyMap.set("show_sections", story.show_sections === 1);
        storyMap.set("created_by", story.created_by ?? null);

        // ---- steps ----
        const stepsArray = new Y.Array<Y.Map<unknown>>();
        for (const step of stepsByStoryId.get(story.id) ?? []) {
          const stepMap = new Y.Map<unknown>();
          stepMap.set("_id", step.id);
          stepMap.set("step_number", step.step_number);
          stepMap.set("kind", step.kind ?? "media");
          stepMap.set("object_id", step.object_id ?? "");
          stepMap.set("x", step.x ?? null);
          stepMap.set("y", step.y ?? null);
          stepMap.set("zoom", step.zoom ?? null);
          stepMap.set("page", step.page ?? "");
          stepMap.set("question", new Y.Text(step.question ?? ""));
          stepMap.set("answer", new Y.Text(step.answer ?? ""));
          stepMap.set("alt_text", new Y.Text(step.alt_text ?? ""));
          stepMap.set("clip_start", step.clip_start ?? "");
          stepMap.set("clip_end", step.clip_end ?? "");
          stepMap.set("loop", step.loop ?? "");
          stepMap.set("extra_columns", stepExtraColumnsValue(step.extra_columns));
          // Carried verbatim; a null or degenerate value is repaired by
          // backfillOrderKeysEverywhere once the doc is assembled.
          stepMap.set(ORDER_KEY, step.order_key ?? null);
          stepMap.set("created_by", step.created_by ?? null);

          // ---- layers ----
          const layersArray = new Y.Array<Y.Map<unknown>>();
          for (const layer of layersByStepId.get(step.id) ?? []) {
            const layerMap = new Y.Map<unknown>();
            layerMap.set("_id", layer.id);
            layerMap.set("layer_number", layer.layer_number);
            layerMap.set("title", new Y.Text(layer.title ?? ""));
            layerMap.set("button_label", new Y.Text(layer.button_label ?? ""));
            layerMap.set("content", new Y.Text(layer.content ?? ""));
            layerMap.set(ORDER_KEY, layer.order_key ?? null);
            layerMap.set("created_by", layer.created_by ?? null);
            layersArray.push([layerMap]);
          }
          stepMap.set("layers", layersArray);
          stepsArray.push([stepMap]);
        }
        storyMap.set("steps", stepsArray);
        storiesArray.push([storyMap]);
      }

      // ---- objects ----
      const objectsArray = this.ydoc.getArray<Y.Map<unknown>>("objects");
      for (const obj of objects.results) {
        const objMap = new Y.Map<unknown>();
        objMap.set("_id", obj.id);
        objMap.set("object_id", obj.object_id);
        objMap.set("title", new Y.Text(obj.title ?? ""));
        objMap.set("creator", new Y.Text(obj.creator ?? ""));
        objMap.set("description", new Y.Text(obj.description ?? ""));
        objMap.set("alt_text", new Y.Text(obj.alt_text ?? ""));
        objMap.set("source_url", obj.source_url ?? "");
        objMap.set("period", new Y.Text(obj.period ?? ""));
        objMap.set("year", new Y.Text(obj.year ?? ""));
        // object_type/subjects/source/credit are edited as Y.Text on the detail
        // page; they MUST be loaded here or getYText() returns null and edits go
        // nowhere (telar-compositor#23). thumbnail/dimensions/extra_columns are
        // repo-import passthrough — carried as plain values so the snapshot
        // INSERT/UPDATE round-trips them instead of resetting them.
        objMap.set("object_type", new Y.Text(obj.object_type ?? ""));
        objMap.set("subjects", new Y.Text(obj.subjects ?? ""));
        objMap.set("source", new Y.Text(obj.source ?? ""));
        objMap.set("credit", new Y.Text(obj.credit ?? ""));
        objMap.set("thumbnail", obj.thumbnail ?? "");
        objMap.set("dimensions", obj.dimensions ?? "");
        objMap.set("extra_columns", obj.extra_columns ?? "");
        objMap.set("featured", obj.featured === 1);
        objMap.set("image_available", obj.image_available === 1);
        objMap.set(ORDER_KEY, obj.order_key ?? null);
        objMap.set("created_by", obj.created_by ?? null);
        // Only a marked object carries the key: an unmarked one must come back
        // from a cold start with no key at all, not a null (contract 1). Miss
        // this and every cold start strips the course-item delete protection.
        if (obj.course_project_id != null) {
          objMap.set("course_project_id", obj.course_project_id);
        }
        objectsArray.push([objMap]);
      }

      // ---- glossary ----
      const glossaryArray = this.ydoc.getArray<Y.Map<unknown>>("glossary");
      for (const term of glossary.results) {
        const termMap = new Y.Map<unknown>();
        termMap.set("_id", term.id);
        termMap.set("term_id", term.term_id);
        termMap.set("title", new Y.Text(term.title ?? ""));
        termMap.set("definition", new Y.Text(term.definition ?? ""));
        termMap.set("kind", term.kind ?? "");
        termMap.set(ORDER_KEY, term.order_key ?? null);
        termMap.set("created_by", term.created_by ?? null);
        glossaryArray.push([termMap]);
      }

      // ---- pages ----
      const pagesArray = this.ydoc.getArray<Y.Map<unknown>>("pages");
      for (const pg of pages.results) {
        const pageMap = new Y.Map<unknown>();
        pageMap.set("_id", pg.id);
        pageMap.set("title", new Y.Text(pg.title ?? ""));
        pageMap.set("slug", pg.slug);
        pageMap.set("body", new Y.Text(pg.body ?? ""));
        pageMap.set("frontmatter", pg.frontmatter);
        pageMap.set(ORDER_KEY, pg.order_key ?? null);
        pageMap.set("created_by", pg.created_by ?? null);
        pagesArray.push([pageMap]);
      }
    });
  }

  /**
   * Snapshot the Y.Doc to D1 — writes both the binary blob and all entity rows.
   * Uses D1 batch for atomicity.
   *
   * Handles INSERT for new Y.Array items (with _id === null) and DELETE for D1
   * rows absent from the Y.Array. For INSERTs, the auto-incremented D1 ID is
   * written back to the Y.Map via ydoc.transact() and broadcast to connected
   * clients so all peers converge on the canonical ID.
   *
   * Protected by isSnapshotting lock to prevent concurrent snapshot invocations
   * (alarm vs. disconnect vs. forceSnapshot) from issuing duplicate INSERTs.
   */
  /** The objects array's entries a snapshot cannot read, then its duplicates; whether either changed it. */
  private settleObjectsArray(d1KeyToId: ReadonlyMap<string, number>): boolean {
    const dropped = this.dropIdentityFreeObjectEntries();
    return this.deduplicateYArray("objects", "object_id", d1KeyToId) || dropped;
  }

  /**
   * Removes from the objects array every entry that is not a Y.Map and carries
   * no identity: a bare value, an array, `null`, or a plain object holding none
   * of `_id`, `_temp_id` and `object_id`. Such an entry claims no D1 row and
   * holds nothing a snapshot would have written, since a plain value is never
   * read, so dropping it loses nothing; left in place it turns the orphan
   * sweep off for the whole table (`snapshotFlatEntity`), and a removal the
   * document has made never reaches D1. An entry that does carry identity may
   * be the claim on a live row and stays.
   *
   * Returns whether it removed anything, so the caller has the removal
   * broadcast.
   */
  private dropIdentityFreeObjectEntries(): boolean {
    const array = this.ydoc.getArray<unknown>("objects");
    const bare = (member: unknown): boolean => {
      if (member instanceof Y.AbstractType) return false;
      if (member === null || typeof member !== "object" || Array.isArray(member)) return true;
      return !["_id", "_temp_id", "object_id"].some((key) => Object.hasOwn(member, key));
    };
    const positions = array.toArray().flatMap((member, i) => (bare(member) ? [i] : []));
    if (positions.length === 0) return false;
    this.ydoc.transact(() => {
      for (const i of positions.reverse()) array.delete(i, 1);
    });
    console.warn(`[snapshot] Dropped ${positions.length} unreadable identity-free entr(ies) from objects`);
    return true;
  }

  /**
   * Remove (or re-key) duplicate entries from a top-level Y.Array<Y.Map> keyed
   * by `entityKey`. What happens to a same-key NON-keeper depends on what its
   * `_id` says it is, and the same rule holds in every root:
   *
   *   - An `_id` equal to the keeper's is the SAME persisted row twice. That,
   *     and only that, collapses via DELETE: re-keying it would mint a phantom
   *     row out of one real one, and there is no second entity to preserve.
   *   - Anything else that carries a key is a distinct entity, and is RE-KEYED.
   *     A distinct non-null `_id` is a second live D1 row; deleting it drops
   *     the Y.Map out of the document and the orphan sweep then deletes that
   *     row — and the collision is authorable: `slug` and `term_id` are rename
   *     features, so one collaborator renaming their page onto another's slug
   *     is a permitted edit that would destroy the other member's page
   *     (through `pages.slug`). A NULL `_id` is UNSAVED, not disposable: before
   *     a project's first snapshot every map carries one, so a null there is a
   *     statement about D1's progress and not about whether anybody is writing
   *     the entity. Both the key and the array position are client-writable, so
   *     reading the null as licence to delete would let a peer place a hollow
   *     map carrying someone else's key above their real one and have the DO
   *     remove the real one. A mangled key is recoverable; a deleted entity is
   *     not.
   *
   * The cost of that is two same-key unsaved maps becoming two entities where a
   * user may have meant one — a spare draft under a `-2` key, which they can
   * see and delete. That is the trade the rule takes deliberately: a visible
   * duplicate over unrecoverable work.
   *
   * The minted key comes from `makeUniqueTermId`, which is `normaliseSlug` plus
   * the `-2`/`-3` suffix — the generator all four human keys are already
   * produced by, so this invents no key format. It avoids every key the
   * document keeps AND every key D1 holds, because `stories(project_id,
   * story_id)` and `project_pages(project_id, slug)` are UNIQUE: a minted key
   * landing on a live row would abort the whole snapshot batch.
   *
   * The re-key reaches D1 through each pipeline's own UPDATE, which writes
   * `object_id`, `slug`, `term_id` and `story_id`. Nothing is lost either
   * way, which is the property that matters.
   *
   * A re-key is not free: a step points at its media by `object_id`, so
   * re-keying an object leaves those steps pointing at a slug nothing answers
   * to. Which steps meant which of the two claimants is not answerable — that
   * ambiguity IS the collision — but a broken reference is repairable in the
   * editor and a deleted object is not, so the re-key is still the lesser harm.
   *
   * `d1KeyToId` is D1's own key -> row-id map for the table, from
   * `fetchEntityKeys`. It decides every collision it can answer; see the keeper
   * passes below for why position cannot be trusted to.
   *
   * `mayRepeat` names the keys several entities may share, which are neither
   * kept nor re-keyed: a glossary term_id that publishes no term
   * (`isHeldTermId`) is written back as the author wrote it, and
   * re-keying one would normalise it into an id that publishes a term.
   *
   * Returns true iff it changed the document — re-keyed OR deleted — so the
   * caller broadcasts the result. Both need it, and a delete needs it most: a
   * peer that keeps the removed Y.Map goes on editing an entity the server has
   * thrown away, and every edit it makes is discarded by the next snapshot,
   * which has no Y.Map left to write them from. A re-key at least leaves the
   * peer editing something that still exists.
   */
  private deduplicateYArray(
    arrayName: string,
    entityKey: string,
    d1KeyToId?: ReadonlyMap<string, number>,
    mayRepeat?: (key: string) => boolean,
  ): boolean {
    const yArray = this.ydoc.getArray<Y.Map<unknown>>(arrayName);
    if (yArray.length === 0) return false;

    // Every read of a human key in this class goes through `renderedKey`, whose
    // totality is what keeps an unrenderable value from refusing the snapshot
    // outright. Such a value is the unkeyed sentinel, which the `!key` skip
    // below leaves alone.
    // A position that does not hold a Y.Map at all reads as the unkeyed
    // sentinel and as no row id, which puts it exactly where the `!key` skip
    // already leaves an unrenderable key: outside every collision, keeping
    // nothing and losing to nothing. Reading it any other way would mean
    // resolving identity out of a value the server refused, which is the
    // operation this whole class is made of.
    const mapAt = (i: number): Y.Map<unknown> | null => {
      const member = yArray.get(i);
      return member instanceof Y.Map ? member : null;
    };
    // A key several entities may share reads as unkeyed, which the passes
    // below already leave outside every collision.
    const keyAt = (i: number): string => sharedAsUnkeyed(renderedKey(mapAt(i)?.get(entityKey)), mayRepeat);
    const idAt = (i: number): number | null => {
      const v = mapAt(i)?.get("_id");
      return typeof v === "number" ? v : null;
    };

    // First pass: choose the keeper index per human key.
    //
    // D1 decides where it can. Both the human key and the array position are
    // client-writable, so resolving a collision by "first occurrence" hands the
    // outcome to whoever inserts earliest: rename a Y.Map onto another's key,
    // place it above, and the DO removes the real one and the orphan sweep
    // deletes its row, with no delete ever issued to revert. The one
    // party to the collision no client can write to is D1, which already says
    // which row owns the key — so the entry whose `_id` IS that row wins,
    // wherever it sits.
    //
    // Where D1 has no answer — an unsaved key, or a row id neither claimant
    // carries — the older rule stands: prefer the entry that already carries a
    // non-null _id (the persisted copy) over an _id=null duplicate, otherwise
    // dedup could drop the live row and keep the null one, re-keying the entity
    // and orphan-deleting its D1 row (FK breakage). Failing that, first
    // occurrence.
    const keeperByKey = new Map<string, number>();
    for (let i = 0; i < yArray.length; i++) {
      const key = keyAt(i);
      if (!key) continue; // empty keys: new items not yet keyed — never key-deduped
      const incumbent = keeperByKey.get(key);
      keeperByKey.set(key, incumbent === undefined ? i : keeperOfTwo(i, incumbent, {
        idAt,
        d1Id: d1KeyToId?.get(key),
      }));
    }

    // A keeper per `_id`, so an exact-`_id` collision — two Y.Maps claiming one
    // persisted row — is resolved on the same terms rather than by position. A
    // key-keeper owns its row id; when two key-keepers claim one row, D1's key
    // for that row decides, exactly as above. Everything else falls back to
    // first occurrence.
    const keeperById = new Map<number, number>();
    for (const idx of keeperByKey.values()) {
      const id = idAt(idx);
      if (id === null) continue;
      const incumbent = keeperById.get(id);
      if (incumbent === undefined) {
        keeperById.set(id, idx);
        continue;
      }
      if (d1KeyToId?.get(keyAt(idx)) === id && d1KeyToId?.get(keyAt(incumbent)) !== id) {
        keeperById.set(id, idx);
      }
    }
    for (let i = 0; i < yArray.length; i++) {
      const id = idAt(i);
      if (id !== null && !keeperById.has(id)) keeperById.set(id, i);
    }

    // Second pass: classify each non-keeper, on what its `_id` says it is.
    const indicesToDelete: number[] = [];
    const indicesToRekey: number[] = [];
    for (let i = 0; i < yArray.length; i++) {
      const id = idAt(i);
      const key = keyAt(i);

      // Exact _id duplicate (same persisted row) collapses first, in BOTH modes —
      // re-keying same-_id Y.Maps would mint a phantom row.
      if (id !== null && keeperById.get(id) !== i) {
        indicesToDelete.push(i);
        continue;
      }

      // Everything else that carries a key is a distinct entity — a second
      // live row, or unsaved work that has not reached D1 yet. Deleting either
      // is what hands the orphan sweep, or the array position, another member's
      // record. `!key` above has already skipped the unkeyed maps, so this
      // branch only ever sees entities.
      if (key && keeperByKey.get(key) !== i) indicesToRekey.push(i);
    }

    if (indicesToRekey.length === 0 && indicesToDelete.length === 0) return false;

    // Re-keys must avoid EVERY live key — the ones the document keeps and the
    // ones D1 holds, since two of these columns are UNIQUE and a minted key
    // landing on a live row would abort the snapshot batch. The set grows as
    // each loser is assigned a fresh, collision-free key.
    const takenKeys = new Set<string>(keeperByKey.keys());
    if (d1KeyToId) for (const k of d1KeyToId.keys()) takenKeys.add(k);
    this.ydoc.transact(() => {
      // Re-key first (no length change), then delete in reverse (indices shift).
      for (const i of indicesToRekey) {
        const yMap = yArray.get(i);
        const current = renderedKey(yMap.get(entityKey));
        const fresh = makeUniqueTermId(current, [...takenKeys]);
        takenKeys.add(fresh);
        yMap.set(entityKey, fresh);
      }
      for (let i = indicesToDelete.length - 1; i >= 0; i--) {
        yArray.delete(indicesToDelete[i], 1);
      }
    });

    // Dedup runs as a recovery path; surface as a warning so a real bug
    // producing dupes is distinguishable from idle snapshot traffic.
    if (indicesToRekey.length > 0) {
      console.warn(
        `[snapshot] Deduplicated ${arrayName}: re-keyed ${indicesToRekey.length} duplicate(s) to a unique ${entityKey} (content preserved)`,
      );
    }
    if (indicesToDelete.length > 0) {
      console.warn(
        `[snapshot] Deduplicated ${arrayName}: removed ${indicesToDelete.length} duplicate(s)`,
      );
    }
    return true;
  }

  /**
   * Remove duplicate entries from a Y.Array<Y.Map> by _id in place.
   * The first occurrence wins; later duplicates are appended to toDelete and
   * removed synchronously (caller is responsible for wrapping in a transact).
   * Items with a null/undefined _id are distinct pending inserts — never removed.
   *
   * `deduplicateYArray`'s D1-decided keeper has no counterpart here, and the
   * reason is structural rather than an omission: the collision key at this
   * level IS D1's primary key, and `steps`/`layers` carry no second key D1
   * could be asked about (a step's `object_id` is a reference to an object, not
   * its own identity; layers have none at all). Two Y.Maps claiming row 42 are
   * both, as far as D1 can say, row 42 — it corroborates the id equally for
   * each and cannot name a keeper. Position therefore still decides here, and
   * the guard that matters for this level is upstream: `_id` is DO-owned on
   * step and layer maps (workers/can-delete.ts), so a colliding id cannot be
   * written onto a map that already existed.
   *
   * Returns whether it removed anything, so the caller can have the removal
   * broadcast: a peer holding a step or layer the server has dropped keeps
   * editing it into a snapshot that will never read it again.
   */
  private dedupeByIdInPlace(arr: Y.Array<Y.Map<unknown>>): boolean {
    const seen = new Set<number>();
    const toDelete: number[] = [];
    for (let i = 0; i < arr.length; i++) {
      const member = arr.get(i);
      // Not a Y.Map: no id, so it duplicates nothing and nothing duplicates it.
      if (!(member instanceof Y.Map)) continue;
      // Only a value in the row-id domain names a row. An out-of-domain `_id`
      // is a pending insert as far as this pass is concerned — never a
      // duplicate of anything, and so never deleted on the strength of it.
      const id = readRowId(member.get("_id"));
      if (id.ok) {
        if (seen.has(id.value)) {
          toDelete.push(i);
          continue;
        }
        seen.add(id.value);
      }
    }
    // Delete in reverse order so earlier indices stay valid
    for (let i = toDelete.length - 1; i >= 0; i--) {
      arr.delete(toDelete[i], 1);
    }
    if (toDelete.length > 0) {
      console.warn(
        `[snapshot] Deduplicated nested array: removed ${toDelete.length} duplicate(s)`,
      );
    }
    return toDelete.length > 0;
  }

  /**
   * Walk each story's `steps` array (and each step's `layers` array) and
   * remove entries whose `_id` already appeared (first occurrence wins).
   * Mirrors `deduplicateYArray` for the nested level that the top-level pass
   * cannot reach.
   *
   * All mutations are wrapped in a single ydoc.transact so peers receive one
   * atomic update rather than a delete per duplicate.
   *
   * Returns whether anything was removed, on the same terms as the top-level
   * pass: a mutation the server makes to its own document has to reach the
   * peers, or they keep editing what the server has dropped.
   */
  private deduplicateNestedStepArrays(): boolean {
    const storiesArray = this.ydoc.getArray<Y.Map<unknown>>("stories");
    if (storiesArray.length === 0) return false;

    let removed = false;
    this.ydoc.transact(() => {
      // `entityMaps` rather than an index walk: a position holding plain JSON
      // passes the container's `instanceof Y.Array` guard and throws on the
      // `.get` after it, which inside this transaction would refuse the whole
      // snapshot.
      for (const storyMap of entityMaps(storiesArray).maps) {
        const stepsArr = storyMap.get("steps");
        if (!(stepsArr instanceof Y.Array)) continue;

        const steps = stepsArr as Y.Array<Y.Map<unknown>>;
        if (this.dedupeByIdInPlace(steps)) removed = true;

        for (const stepMap of entityMaps(steps).maps) {
          const layersArr = stepMap.get("layers");
          if (layersArr instanceof Y.Array) {
            if (this.dedupeByIdInPlace(layersArr as Y.Array<Y.Map<unknown>>)) removed = true;
          }
        }
      }
    });
    return removed;
  }

  /**
   * Snapshot and report whether it actually happened.
   *
   * `snapshotToD1` returns silently when another snapshot holds the lock (or
   * the doc is not loaded), which is right for the fire-and-forget callers but
   * wrong for a route that must not answer until D1 is flushed. This mirrors
   * those guards immediately before the call — with no await in between, so the
   * flag cannot change underneath it — and turns the silence into a `false` the
   * caller can retry on.
   */
  private async flushSnapshotNow(): Promise<boolean> {
    // A halt entered by a snapshot that had already started reaches the route as
    // a thrown refusal; every call after it stops here instead.
    if (this.persistenceHalted !== null) return false;
    if (this.isSnapshotting || !this.projectId || !this.docLoaded) return false;
    await this.snapshotToD1();
    return true;
  }

  async snapshotToD1(): Promise<void> {
    // A halted document is one this instance must not write out: it may hold a
    // deletion enforcement refused, or belong to a row that has passed to a
    // replacement. See `persistenceHalted`.
    if (this.persistenceHalted !== null) return;
    if (!this.projectId || !this.docLoaded) return;
    if (this.isSnapshotting) return; // Prevent duplicate INSERTs from concurrent calls
    this.isSnapshotting = true;
    try {
      await this.doSnapshot();
    } finally {
      this.isSnapshotting = false;
    }
  }

  /**
   * Sections 3+4: project_config + project_landing. These are singleton rows
   * (one per project). They are normally created at import/onboarding, but if a
   * project ever reaches the DO without one, a plain UPDATE would match zero rows
   * and silently drop every config/landing edit forever (the same strand class
   * as Fix A). So we SELECT-guard: UPDATE when the row exists, INSERT-on-missing
   * otherwise. `project_config`/`project_landing` have no UNIQUE(project_id)
   * index, hence the explicit existence check rather than ON CONFLICT.
   */
  private async snapshotConfig(statements: D1PreparedStatement[], now: string): Promise<void> {
    // 3. Snapshot config
    const config = this.ydoc.getMap<unknown>("config");
    const landingRead = readYMap(config.get("landing"));
    if (!landingRead.ok && landingRead.reason === "wrong_type") {
      this.reportMalformed("config", "config.landing", landingRead.found);
    }
    const landing = landingRead.ok ? landingRead.value : undefined;

    // Which columns this UPDATE writes, and what each one binds. Both lists
    // are built in the same pass over one table, so a column dropped from the
    // SET list drops its bind with it and the pairing cannot drift.
    const configExists = await this.env.DB
      .prepare("SELECT id FROM project_config WHERE project_id = ?")
      .bind(this.projectId)
      .first<{ id: number }>();
    const columns: string[] = [];
    const configVals: unknown[] = [];
    for (const entry of CONFIG_COLUMNS) {
      const read = entry.read(config.get(entry.key));
      if (read.ok) {
        columns.push(entry.column);
        configVals.push(read.value);
        continue;
      }
      if (read.reason === "missing" && !entry.holdOnMissing) {
        columns.push(entry.column);
        configVals.push(entry.unset);
        continue;
      }
      // A value the snapshot cannot read is HELD: the column is left out of
      // the UPDATE, so D1 keeps what it holds and the site publishes that. No
      // read is made for it, so a plant adds no read that could fail before
      // the blob is written and no window a direct writer of `project_config`
      // could be overwritten in. On the INSERT branch there is nothing to
      // hold, so the column binds the value an untouched project writes.
      this.reportConfigHold(entry.key, typeNameOf(config.get(entry.key)), Boolean(configExists));
      if (configExists) continue;
      columns.push(entry.column);
      configVals.push(entry.unset);
    }
    columns.push("updated_at");
    configVals.push(now);

    if (configExists) {
      statements.push(
        this.env.DB
          .prepare(
            `UPDATE project_config SET ${columns.map((c) => `${c} = ?`).join(", ")} ` +
            "WHERE project_id = ?",
          )
          .bind(...configVals, this.projectId),
      );
    } else {
      statements.push(
        this.env.DB
          .prepare(
            `INSERT INTO project_config (project_id, ${columns.join(", ")}) ` +
            `VALUES (${new Array(columns.length + 1).fill("?").join(", ")})`,
          )
          .bind(this.projectId, ...configVals),
      );
    }

    // 4. Snapshot landing (project_landing)
    if (landing) {
      // The two statements bind the same five keys and resolve an unreadable
      // one DIFFERENTLY, so they cannot share one array: a hold is `null` on
      // the UPDATE, where `COALESCE` turns it into the value D1 holds, and `""`
      // on the INSERT, where there is no prior value for a null to stand for
      // and it would write NULL instead.
      const landingKeys = ["stories_heading", "stories_intro", "objects_heading", "objects_intro", "welcome_body"];
      const landingExists = await this.env.DB
        .prepare("SELECT id FROM project_landing WHERE project_id = ?")
        .bind(this.projectId)
        .first<{ id: number }>();
      if (landingExists) {
        statements.push(
          this.env.DB
            .prepare(
              "UPDATE project_landing SET " +
              "stories_heading = COALESCE(?, stories_heading), " +
              "stories_intro = COALESCE(?, stories_intro), " +
              "objects_heading = COALESCE(?, objects_heading), " +
              "objects_intro = COALESCE(?, objects_intro), " +
              "welcome_body = COALESCE(?, welcome_body), updated_at = ? " +
              "WHERE project_id = ?",
            )
            .bind(
              ...landingKeys.map((key) => proseUpdateBind("landing", landing, key)),
              now,
              this.projectId,
            ),
        );
      } else {
        statements.push(
          this.env.DB
            .prepare(
              "INSERT INTO project_landing (project_id, " +
              "stories_heading, stories_intro, objects_heading, objects_intro, welcome_body, updated_at) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(
              this.projectId,
              ...landingKeys.map((key) => proseInsertBind("landing", landing, key)),
              now,
            ),
        );
      }
    }
  }

  /**
   * Crash-proof INSERT for one entity row, shared by all six snapshot pipelines
   * (stories, steps, layers, objects, glossary terms, pages). This is the ONE
   * place the insert-retry policy lives — read it here once, not six times:
   *
   *   - No explicit id (a brand-new Y.Map): one autoincrement INSERT, then
   *     `backfill` the returned id onto the Y.Map. On failure: warn, reschedule
   *     a retry, return id 0 — never throw, because a snapshot must not abort
   *     mid-flush.
   *   - Explicit id (re-creating a row stranded by an out-from-under DELETE):
   *     INSERT with that same id so the Y.Doc `_id` and any FK children stay
   *     valid; do NOT backfill (the id is already correct). On a constraint
   *     failure retry ONCE as a fresh autoincrement row + backfill the new id;
   *     if that also fails (e.g. a UNIQUE human-key collision) warn, reschedule,
   *     return id 0 so the caller skips this row's children this pass.
   *
   * Not aborting is not the same as not reporting. Every outcome without a
   * usable id is recorded on `snapshotInsertFailures` under its own `kind`, so
   * the routes that answer a caller after the flush can say which entities D1
   * does not hold — see `InsertOutcome` for why the two kinds must not be
   * reported alike.
   *
   * Does insert retry on collision? Yes — exactly once, and only in the
   * explicit-id path, degrading to a logged no-op. The plain new-insert path
   * does not retry. The id-bearing and autoincrement SQL variants are generated
   * from the one `columns` list so they can never drift apart. The per-entity
   * table, columns, bound values, the `_id` backfill (plus any second-key
   * backfill — see glossary's term_id), and the two warn strings come from the
   * six thin wrappers below.
   */
  private async insertRow(
    table: string,
    key: string,
    columns: string[],
    binds: unknown[],
    explicitId: number | undefined,
    backfill: (id: number) => void,
    warnBlocked: string,
    warnNew: string,
  ): Promise<InsertOutcome> {
    // Before the row is written at all. A standalone INSERT is persistence of
    // exactly the kind a document with an unwritten record must not reach, and
    // the transaction that could not be logged may be one this pass ran itself
    // — a dedup re-key, an earlier entity's backfill — or one that arrived
    // while the pass was awaiting D1.
    this.refusePastHalt();

    const run = async (withId: boolean): Promise<number> => {
      const cols = withId ? ["id", ...columns] : columns;
      const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
      const res = await this.env.DB
        .prepare(sql)
        .bind(...(withId ? [explicitId, ...binds] : binds))
        .run();
      return withId ? (explicitId as number) : (res.meta.last_row_id as number);
    };

    const refused = (warning: string): InsertOutcome => {
      console.warn(warning);
      this.snapshotInsertFailures.push({ table, key, kind: "insert" });
      this.scheduleSnapshot();
      return { id: 0, backfilled: false, failure: "insert" };
    };

    // The INSERT and the `_id` backfill get their own catch each. Under one
    // catch a backfill that threw was indistinguishable from a row D1 never
    // wrote, and the remedy for the second — issue the INSERT again — mints a
    // duplicate row when applied to the first. The id is returned either way,
    // so the caller can still write this entity's children under the FK D1
    // actually holds.
    const insertThenBackfill = async (): Promise<InsertOutcome> => {
      const id = await run(false);
      try {
        backfill(id);
      } catch (err) {
        // The backfill's structs are integrated whether or not the listener
        // that ran after them returned, so the record's failure is read on this
        // exit as well as on the successful one; a pass that returned here
        // would carry on inserting behind a mutation the log does not hold.
        this.refusePastHalt();
        console.warn(
          `[snapshot] ${table} "${key}" committed as id ${id} but its _id backfill failed`,
          err,
        );
        this.snapshotInsertFailures.push({ table, key, kind: "backfill" });
        this.scheduleSnapshot();
        return { id, backfilled: false, failure: "backfill" };
      }
      // Immediately after the backfill, which is a transaction the log has to
      // carry: the row is committed and the `_id` is on the Y.Map, so a record
      // the log could not hold means this snapshot must write nothing further.
      this.refusePastHalt();
      return { id, backfilled: true };
    };

    if (explicitId !== undefined) {
      try {
        return { id: await run(true), backfilled: false }; // re-created same id; _id already correct
      } catch {
        try {
          return await insertThenBackfill();
        } catch (err) {
          // A halt refusal is not an insert this pass can fall back from: the
          // fallback would write more rows behind a record the log rejected.
          if (err instanceof PersistenceHaltedError) throw err;
          return refused(warnBlocked);
        }
      }
    }
    try {
      return await insertThenBackfill();
    } catch (err) {
      if (err instanceof PersistenceHaltedError) throw err;
      return refused(warnNew);
    }
  }

  /**
   * Who last edited a row being INSERTed, from the field paths this window
   * stamped.
   *
   * Looked up under whichever id the row's paths carry: the D1 id when the
   * Y.Map already has one (a row being re-INSERTed after its D1 row went
   * missing), and the client `_temp_id` when it does not. A row created and
   * written into before the first snapshot is the ordinary case — a step
   * somebody adds and immediately fills — and without this it would INSERT
   * with no editor at all and wait for a later window to name one.
   *
   * A rendered id must be non-empty to match, on the same terms as
   * `matchesFieldPathId`: an id the document cannot state is not an id any
   * field path named, and treating two unrenderable ids as equal would file one
   * row's editor under another row's name.
   */
  private editorForInsert(
    map: Y.Map<unknown>,
    edits: Map<string, { at: string; by: number }>,
  ): number | null {
    for (const key of ["_id", "_temp_id"] as const) {
      const rendered = renderedValue(map.get(key));
      if (rendered.length === 0) continue;
      const hit = edits.get(rendered);
      if (hit) return hit.by;
    }
    return null;
  }

  /**
   * INSERT one story row. Thin wrapper over `insertRow` (retry policy lives
   * there). `order_key` is the story's own place; `order` is the dense rank it
   * holds in that ordering, threaded in by the caller for project.csv.
   */
  private async insertStoryRow(
    storyMap: Y.Map<unknown>,
    order: number,
    now: string,
    lastEditedBy: number | null,
    explicitId?: number,
    preservedExtraColumns: string | null = null,
    preservedSourcePath: string | null = null,
  ): Promise<InsertOutcome> {
    const slug = renderedKey(storyMap.get("story_id"));
    const columns = [
      "project_id", "story_id", "title", "subtitle", "byline", '"order"',
      "order_key", "private", "draft", "show_sections", "extra_columns", "source_path", "created_by",
      "last_edited_by", "updated_at",
    ];
    const binds = [
      this.projectId,
      slug,
      proseInsertBind("stories", storyMap, "title"),
      proseInsertBind("stories", storyMap, "subtitle"),
      proseInsertBind("stories", storyMap, "byline"),
      order,
      orderKeyBind(storyMap),
      flagBind(storyMap.get("private")),
      flagBind(storyMap.get("draft")),
      flagBind(storyMap.get("show_sections")),
      // D1-only: the document never carries the custom project.csv columns, so
      // a recreated row takes the surviving row's value and a new story has none.
      preservedExtraColumns,
      // D1-only: the file a publish lays the story out from, which the
      // document never carries; a new story has none.
      preservedSourcePath,
      rowIdBind(storyMap.get("created_by")),
      lastEditedBy,
      now,
    ];
    return this.insertRow(
      "stories",
      slug,
      columns,
      binds,
      explicitId,
      (id) => { this.ydoc.transact(() => { storyMap.set("_id", id); }); },
      `[snapshot] story "${slug}" insert blocked (likely slug collision) — manual remediation needed`,
      `[snapshot] new story "${slug}" insert failed`,
    );
  }

  /**
   * INSERT one step row. Thin wrapper over `insertRow`. `storyId` is the
   * injected FK parent; `order_key` is the step's own place and `stepNumber`
   * the dense rank it holds in that ordering, threaded in by the caller for
   * story.csv.
   */
  private async insertStepRow(
    stepMap: Y.Map<unknown>,
    storyId: number,
    stepNumber: number,
    now: string,
    lastEditedBy: number | null,
    explicitId?: number,
  ): Promise<InsertOutcome> {
    const columns = [
      "story_id", "step_number", "order_key", "kind", "object_id", "x", "y", "zoom", "page",
      "question", "answer", "alt_text", "clip_start", "clip_end", "loop", "extra_columns",
      "created_by", "last_edited_by", "updated_at",
    ];
    const binds = [
      storyId,
      stepNumber,
      orderKeyBind(stepMap),
      renderedValue(stepMap.get("kind"), "media"),
      renderedKey(stepMap.get("object_id")),
      coordinateBind(stepMap.get("x")),
      coordinateBind(stepMap.get("y")),
      coordinateBind(stepMap.get("zoom")),
      renderedValue(stepMap.get("page")),
      proseInsertBind("steps", stepMap, "question"),
      proseInsertBind("steps", stepMap, "answer"),
      proseInsertBind("steps", stepMap, "alt_text"),
      renderedValue(stepMap.get("clip_start")),
      renderedValue(stepMap.get("clip_end")),
      renderedValue(stepMap.get("loop")),
      stepExtraColumnsBind(stepMap),
      rowIdBind(stepMap.get("created_by")),
      lastEditedBy,
      now,
    ];
    return this.insertRow(
      "steps",
      `story ${storyId} step ${stepNumber}`,
      columns,
      binds,
      explicitId,
      (id) => { this.ydoc.transact(() => { stepMap.set("_id", id); }); },
      "[snapshot] step insert blocked — manual remediation needed",
      "[snapshot] new step insert failed",
    );
  }

  /**
   * INSERT one layer row. Thin wrapper over `insertRow`. `stepId` is the
   * injected FK parent; `order_key` is the layer's own place and `layerNumber`
   * the dense rank it holds in that ordering — which is also the layer{n}_*
   * cell pair story.csv puts it in.
   */
  private async insertLayerRow(
    layerMap: Y.Map<unknown>,
    stepId: number,
    layerNumber: number,
    now: string,
    lastEditedBy: number | null,
    explicitId?: number,
  ): Promise<InsertOutcome> {
    const columns = [
      "step_id", "layer_number", "order_key", "title", "button_label", "content",
      "created_by", "last_edited_by", "updated_at",
    ];
    const binds = [
      stepId,
      layerNumber,
      orderKeyBind(layerMap),
      proseInsertBind("layers", layerMap, "title"),
      proseInsertBind("layers", layerMap, "button_label"),
      proseInsertBind("layers", layerMap, "content"),
      rowIdBind(layerMap.get("created_by")),
      lastEditedBy,
      now,
    ];
    return this.insertRow(
      "layers",
      `step ${stepId} layer ${layerNumber}`,
      columns,
      binds,
      explicitId,
      (id) => { this.ydoc.transact(() => { layerMap.set("_id", id); }); },
      "[snapshot] layer insert blocked — manual remediation needed",
      "[snapshot] new layer insert failed",
    );
  }

  /**
   * Section 5: stories + nested steps + layers. INSERT (with _id backfill),
   * UPDATE, DELETE, and the story→steps→layers cascade. Returns whether any
   * INSERT backfilled an _id onto a Y.Map (the caller's didBackfill).
   */
  private async snapshotStories(
    statements: D1PreparedStatement[],
    now: string,
    prefetched: EntityKeyIndex,
  ): Promise<boolean> {
    let didBackfill = false;
    // Who last edited each story, step and layer, and when — derived from the
    // field paths the handler stamped. Computed once for the whole walk: the
    // alternative for the time is `now` on every row, which is the snapshot's
    // clock and says nothing about any individual one, and the alternative for
    // the actor is nothing at all.
    const storyEdits = rowEditsFromPaths(this.editsByPath, "stories");
    const stepEdits = rowEditsFromPaths(this.editsByPath, "steps");
    const layerEdits = rowEditsFromPaths(this.editsByPath, "layers");
    // 5. Snapshot stories, steps, and layers — handles INSERT for new Y.Maps
    //    (with _id === null), UPDATE for existing ones, DELETE for D1 rows
    //    absent from the Y.Array, and cascade deletes (story → steps → layers).
    const storiesArray = this.ydoc.getArray<Y.Map<unknown>>("stories");

    // D1's story ids, read once in `doSnapshot` and shared with the dedupe
    // keeper. Copied because the orphan pass consumes the set.
    const d1StoryIds = new Set(prefetched.ids);

    // Walk in order_key order, not array order: the array position carries no
    // meaning, and `si` below is the dense rank that project.csv publishes.
    const { maps: orderedStories, skipped: skippedStories } =
      orderedEntries(storiesArray);
    // A position the reader refused may be carrying the `_id` of a live row,
    // and there is no safe way to find out: reading identity off a refused
    // position is unsafe, so no story row is swept while one stands. A row
    // left in place is recoverable and a row deleted is not.
    if (skippedStories.length > 0) {
      this.reportMalformed("stories", `stories[${skippedStories.join(",")}]`);
      d1StoryIds.clear();
    }

    const firstStatement = statements.length;
    const written: Array<{ id: number; key: string }> = [];

    for (let si = 0; si < orderedStories.length; si++) {
      const storyMap = orderedStories[si];
      // A row id the server cannot read names no row, and there is no safe way
      // to find out which one it meant — reading identity out of a refused
      // value is the operation this class is made of. So the entity is left
      // exactly as it stands: not written, not adopted, not re-inserted, and
      // its table's orphan sweep suspended, because a row it might have been
      // carrying must not be swept on the strength of not knowing.
      const storyIdRead = readRowId(storyMap.get("_id"));
      if (!storyIdRead.ok && storyIdRead.reason === "wrong_type") {
        this.reportMalformed("stories", `stories[${si}]._id`, storyIdRead.found);
        d1StoryIds.clear();
        continue;
      }
      let storyId = storyIdRead.ok ? storyIdRead.value : null;

      const storyFlagPlant = this.malformedFlags(storyMap, [
        "private",
        "draft",
        "show_sections",
      ]);
      if (storyFlagPlant) {
        this.reportMalformed(
          "stories",
          `stories[${si}].${storyFlagPlant.key}`,
          storyFlagPlant.found,
        );
        // The row is known and stays: this story is in the document, so it is
        // not an orphan, and its steps and layers are not walked at all.
        if (storyId !== null) d1StoryIds.delete(storyId);
        continue;
      }

      // A story INSERT this pipeline loses is almost always the UNIQUE
      // stories(project_id, story_id) refusing a second claim on a live row's
      // slug. `insertRow` swallows that and returns id 0, and the row whose
      // slug it collided with is still in the orphan set — so without this the
      // refusal turns into a DELETE of that row and a cascade over its steps
      // and layers. Protect it and leave the Y.Map for the next snapshot.
      const protectCollidingRow = (): void => {
        const claimed = prefetched.keyToId.get(renderedKey(storyMap.get("story_id")));
        if (claimed !== undefined) d1StoryIds.delete(claimed);
      };

      if (storyId === null || storyId === undefined) {
        // New Y.Map — INSERT (autoincrement) + backfill the canonical id.
        const r = await this.insertStoryRow(storyMap, si, now, this.editorForInsert(storyMap, storyEdits));
        if (r.backfilled) didBackfill = true;
        storyId = r.id;
        // Only a refused INSERT strands the story. A backfill that threw still
        // yields the committed id, so this story's steps and layers are written
        // under the FK D1 actually holds.
        if (r.failure === "insert") { protectCollidingRow(); continue; } // retry next snapshot
      } else if (!d1StoryIds.has(storyId)) {
        // Stale _id: the D1 row was deleted out from under this Y.Map. Stories own
        // FK children (steps/layers), so we do NOT adopt a same-slug live row
        // (that would clobber the live row's children). Re-INSERT with the SAME
        // id so the children's story_id FK stays valid; on a constraint failure
        // insertStoryRow falls back to a new id, and a same-slug collision
        // degrades to caught+logged+stranded (no crash, no silent clobber).
        const surviving = await this.env.DB
          .prepare("SELECT extra_columns, source_path, story_id FROM stories WHERE id = ? AND project_id = ?")
          .bind(storyId, this.projectId)
          .first<{ extra_columns: string | null; source_path: string | null; story_id: string }>();
        const r = await this.insertStoryRow(
          storyMap, si, now, this.editorForInsert(storyMap, storyEdits), storyId, surviving?.extra_columns ?? null,
          await this.previousStoryFile(storyId, surviving, renderedKey(storyMap.get("story_id"))),
        );
        if (r.backfilled) didBackfill = true;
        storyId = r.id;
        // re-INSERT blocked; left stranded for remediation, and the row it
        // collided with left standing.
        if (r.failure === "insert") { protectCollidingRow(); continue; }
        statements.push(...this.previousStoryIdStatement(storyId, surviving?.story_id, renderedKey(storyMap.get("story_id")), now));
      } else {
        statements.push(...this.previousStoryFileStatement(storyId, renderedKey(storyMap.get("story_id")), prefetched));
        statements.push(
          this.env.DB
            .prepare(
              // story_id is written only when the document states a key, on
              // the terms `snapshotPages` writes a page's slug:
              // stories(project_id, story_id) is UNIQUE (migration 0002) and
              // this UPDATE rides in the atomic D1 batch, so an empty key,
              // which `deduplicateYArray` does not settle, keeps the id D1
              // holds rather than risk two rows writing one.
              // COALESCE on the three prose columns, so a value the snapshot
              // cannot read leaves the column D1 holds standing instead of
              // overwriting it with a render no editor could have produced.
              "UPDATE stories SET story_id = COALESCE(NULLIF(?, ''), story_id), " +
              "title = COALESCE(?, title), " +
              "subtitle = COALESCE(?, subtitle), byline = COALESCE(?, byline), " +
              "\"order\" = ?, order_key = ?, private = ?, draft = ?, show_sections = ?, " +
              // COALESCE, so a story this window saw no edit to keeps the
              // editor it already had. A story nobody has touched since the
              // column shipped stays null, which reads as not recorded.
              "last_edited_by = COALESCE(?, last_edited_by), " +
              // COALESCE for the same reason: the snapshot writes every story
              // in one batch, so its own clock says when IT ran and nothing
              // about any one story.
              "updated_at = COALESCE(?, updated_at) WHERE id = ?",
            )
            .bind(
              renderedKey(storyMap.get("story_id")),
              proseUpdateBind("stories", storyMap, "title"),
              proseUpdateBind("stories", storyMap, "subtitle"),
              proseUpdateBind("stories", storyMap, "byline"),
              si, // dense rank in order_key order — what project.csv publishes
              orderKeyBind(storyMap),
              flagBind(storyMap.get("private")),
              flagBind(storyMap.get("draft")),
              flagBind(storyMap.get("show_sections")),
              storyEdits.get(String(storyId))?.by ?? null,
              storyEdits.get(String(storyId))?.at ?? null,
              storyId,
            ),
        );
        statements.push(...this.previousStoryIdStatement(
          storyId, [...prefetched.keyToId].find(([, id]) => id === storyId)?.[0], renderedKey(storyMap.get("story_id")), now,
        ));
        d1StoryIds.delete(storyId);
        written.push({ id: storyId, key: renderedKey(storyMap.get("story_id")) });
      }

      // --- steps for this story ---
      // `steps` is a client-writable key, so it holds whatever a collaborator
      // put there. Absent means the story has no steps and its rows are
      // orphans; malformed means the server cannot say what steps the story
      // has, and that is not the same answer — sweeping on it would delete
      // every step row the project holds because the walk found none.
      const stepsRead = readYArray(storyMap.get("steps"));
      const d1StepsResult = await this.env.DB
        .prepare("SELECT id FROM steps WHERE story_id = ?")
        .bind(storyId)
        .all<{ id: number }>();
      const d1StepIds = new Set(d1StepsResult.results.map((r) => r.id));

      if (!stepsRead.ok && stepsRead.reason === "wrong_type") {
        this.reportMalformed("stories", `stories[${si}].steps`, stepsRead.found);
        d1StepIds.clear();
      }

      const stepsArray = stepsRead.ok ? stepsRead.value : undefined;
      if (stepsArray) {
        // Walk in order_key order, not array order: the array position carries
        // no meaning, and `sti` below is the dense rank story.csv publishes.
        const { maps: orderedSteps, skipped: skippedSteps } =
          orderedEntries(stepsArray);
        if (skippedSteps.length > 0) {
          this.reportMalformed(
            "stories",
            `stories[${si}].steps[${skippedSteps.join(",")}]`,
          );
          d1StepIds.clear();
        }
        for (let sti = 0; sti < orderedSteps.length; sti++) {
          const stepMap = orderedSteps[sti];
          const stepIdRead = readRowId(stepMap.get("_id"));
          if (!stepIdRead.ok && stepIdRead.reason === "wrong_type") {
            this.reportMalformed(
              "stories",
              `stories[${si}].steps[${sti}]._id`,
              stepIdRead.found,
            );
            d1StepIds.clear();
            continue;
          }
          let stepId = stepIdRead.ok ? stepIdRead.value : null;

          if (stepId === null || stepId === undefined) {
            const r = await this.insertStepRow(stepMap, storyId, sti + 1, now, this.editorForInsert(stepMap, stepEdits));
            if (r.backfilled) didBackfill = true;
            stepId = r.id;
            if (r.failure === "insert") continue; // no row to hang layers off
          } else if (!d1StepIds.has(stepId)) {
            // Stale _id: the D1 row was deleted (e.g. cascade when its story was
            // orphaned, then undo restored the Y.Map). Re-INSERT with the same id
            // so the layers' step_id FK stays valid. No human key → no adopt.
            const r = await this.insertStepRow(stepMap, storyId, sti + 1, now, this.editorForInsert(stepMap, stepEdits), stepId);
            if (r.backfilled) didBackfill = true;
            stepId = r.id;
            if (r.failure === "insert") continue;
          } else {
            statements.push(
              this.env.DB
                .prepare(
                  "UPDATE steps SET step_number = ?, order_key = ?, kind = ?, object_id = ?, " +
                  "x = ?, y = ?, zoom = ?, " +
                  // COALESCE on the three prose columns: a value the snapshot
                  // cannot read leaves D1's standing rather than blanking it.
                  "page = ?, question = COALESCE(?, question), " +
                  "answer = COALESCE(?, answer), alt_text = COALESCE(?, alt_text), " +
                  "clip_start = ?, clip_end = ?, loop = ?, extra_columns = ?, " +
                  "last_edited_by = COALESCE(?, last_edited_by), " +
                  "updated_at = COALESCE(?, updated_at) WHERE id = ?",
                )
                .bind(
                  sti + 1, // dense rank in order_key order — what story.csv publishes
                  orderKeyBind(stepMap),
                  renderedValue(stepMap.get("kind"), "media"),
                  renderedKey(stepMap.get("object_id")),
                  coordinateBind(stepMap.get("x")),
                  coordinateBind(stepMap.get("y")),
                  coordinateBind(stepMap.get("zoom")),
                  renderedValue(stepMap.get("page")),
                  proseUpdateBind("steps", stepMap, "question"),
                  proseUpdateBind("steps", stepMap, "answer"),
                  proseUpdateBind("steps", stepMap, "alt_text"),
                  renderedValue(stepMap.get("clip_start")),
                  renderedValue(stepMap.get("clip_end")),
                  renderedValue(stepMap.get("loop")),
                  stepExtraColumnsBind(stepMap),
                  stepEdits.get(String(stepId))?.by ?? null,
                  stepEdits.get(String(stepId))?.at ?? null,
                  stepId,
                ),
            );
            d1StepIds.delete(stepId);
          }

          // --- layers for this step ---
          const layersRead = readYArray(stepMap.get("layers"));
          const d1LayersResult = await this.env.DB
            .prepare("SELECT id FROM layers WHERE step_id = ?")
            .bind(stepId)
            .all<{ id: number }>();
          const d1LayerIds = new Set(d1LayersResult.results.map((r) => r.id));

          if (!layersRead.ok && layersRead.reason === "wrong_type") {
            this.reportMalformed(
              "stories",
              `stories[${si}].steps[${sti}].layers`,
              layersRead.found,
            );
            d1LayerIds.clear();
          }

          const layersArray = layersRead.ok ? layersRead.value : undefined;
          if (layersArray) {
            const { maps: orderedLayers, skipped: skippedLayers } =
              orderedEntries(layersArray);
            if (skippedLayers.length > 0) {
              this.reportMalformed(
                "stories",
                `stories[${si}].steps[${sti}].layers[${skippedLayers.join(",")}]`,
              );
              d1LayerIds.clear();
            }
            for (let li = 0; li < orderedLayers.length; li++) {
              const layerMap = orderedLayers[li];
              const layerIdRead = readRowId(layerMap.get("_id"));
              if (!layerIdRead.ok && layerIdRead.reason === "wrong_type") {
                this.reportMalformed(
                  "stories",
                  `stories[${si}].steps[${sti}].layers[${li}]._id`,
                  layerIdRead.found,
                );
                d1LayerIds.clear();
                continue;
              }
              let layerId = layerIdRead.ok ? layerIdRead.value : null;

              if (layerId === null || layerId === undefined) {
                const r = await this.insertLayerRow(layerMap, stepId, li + 1, now, this.editorForInsert(layerMap, layerEdits));
                if (r.backfilled) didBackfill = true;
              } else if (!d1LayerIds.has(layerId)) {
                // Stale _id: re-INSERT with the same id (no human key → no adopt).
                const r = await this.insertLayerRow(layerMap, stepId, li + 1, now, this.editorForInsert(layerMap, layerEdits), layerId);
                if (r.backfilled) didBackfill = true;
              } else {
                statements.push(
                  this.env.DB
                    .prepare(
                      // COALESCE on the three prose columns: a value the
                      // snapshot cannot read leaves D1's standing.
                      "UPDATE layers SET layer_number = ?, order_key = ?, " +
                      "title = COALESCE(?, title), " +
                      "button_label = COALESCE(?, button_label), " +
                      "content = COALESCE(?, content), " +
                      "last_edited_by = COALESCE(?, last_edited_by), " +
                      // COALESCE, so a layer nobody touched keeps the time it
                      // already had. Binding `now` for every layer is what makes
                      // this column read as one instant across a whole project:
                      // the snapshot writes them all together, so its clock
                      // says when IT ran and nothing about any row.
                      "updated_at = COALESCE(?, updated_at) WHERE id = ?",
                    )
                    .bind(
                      li + 1, // dense rank in order_key order
                      orderKeyBind(layerMap),
                      proseUpdateBind("layers", layerMap, "title"),
                      proseUpdateBind("layers", layerMap, "button_label"),
                      proseUpdateBind("layers", layerMap, "content"),
                      layerEdits.get(String(layerId))?.by ?? null,
                      layerEdits.get(String(layerId))?.at ?? null,
                      layerId,
                    ),
                );
                d1LayerIds.delete(layerId);
              }
            }
          }

          // DELETE orphan layers for this step
          for (const orphanLayerId of d1LayerIds) {
            statements.push(
              this.env.DB
                .prepare("DELETE FROM layers WHERE id = ?")
                .bind(orphanLayerId),
            );
          }
        }
      }

      // DELETE orphan steps for this story (cascade to their layers first)
      for (const orphanStepId of d1StepIds) {
        statements.push(
          this.env.DB
            .prepare("DELETE FROM layers WHERE step_id = ?")
            .bind(orphanStepId),
        );
        statements.push(
          this.env.DB
            .prepare("DELETE FROM steps WHERE id = ?")
            .bind(orphanStepId),
        );
      }
    }

    // DELETE orphan stories (cascade: layers → steps → story)
    const firstOrphanStatement = statements.length;
    for (const orphanStoryId of d1StoryIds) {
      const orphanStepsResult = await this.env.DB
        .prepare("SELECT id FROM steps WHERE story_id = ?")
        .bind(orphanStoryId)
        .all<{ id: number }>();
      for (const s of orphanStepsResult.results) {
        statements.push(
          this.env.DB
            .prepare("DELETE FROM layers WHERE step_id = ?")
            .bind(s.id),
        );
      }
      statements.push(
        this.env.DB
          .prepare("DELETE FROM steps WHERE story_id = ?")
          .bind(orphanStoryId),
      );
      statements.push(
        this.env.DB
          .prepare("DELETE FROM stories WHERE id = ?")
          .bind(orphanStoryId),
      );
    }
    // Ahead of every story UPDATE: a deleted story's ID is free to reuse, and
    // the parked rows have left the IDs their neighbours take.
    const leading = [...this.parkRenamedStories(written, prefetched), ...statements.splice(firstOrphanStatement)];
    statements.splice(firstStatement, 0, ...leading);
    return didBackfill;
  }

  /**
   * INSERT one object row. Thin wrapper over `insertRow`. Carries every content
   * column the Y.Map holds — including object_type/subjects/source/credit
   * (editable) and thumbnail/dimensions/extra_columns (import passthrough), all
   * loaded by buildFromD1Rows — so a re-INSERT preserves them instead of
   * resetting them. origin defaults to "iiif" and missing_from_repo=0 on a fresh
   * insert (both D1-only, not round-tripped through the Y.Map).
   */
  private async insertObjectRow(
    objMap: Y.Map<unknown>,
    now: string,
    lastEditedBy: number | null,
    explicitId?: number,
    preserved?: Record<string, unknown>,
    park?: ParkTest,
  ): Promise<InsertOutcome> {
    const slug = renderedKey(objMap.get("object_id"));
    const parked = parkedBind(slug, park);
    const columns = [
      "project_id", "object_id", "title", "creator", "description", "alt_text",
      "source_url", "period", "year", "object_type", "subjects", "source",
      "credit", "thumbnail", "dimensions", "extra_columns", "featured",
      "image_available", "order_key", "origin", "missing_from_repo",
      "course_project_id", "created_by", "last_edited_by", "created_by_actor",
      "updated_at",
    ];
    const binds = [
      this.projectId,
      parked.bind,
      proseInsertBind("objects", objMap, "title"),
      proseInsertBind("objects", objMap, "creator"),
      proseInsertBind("objects", objMap, "description"),
      proseInsertBind("objects", objMap, "alt_text"),
      renderedValue(objMap.get("source_url")),
      proseInsertBind("objects", objMap, "period"),
      proseInsertBind("objects", objMap, "year"),
      proseInsertBind("objects", objMap, "object_type"),
      proseInsertBind("objects", objMap, "subjects"),
      proseInsertBind("objects", objMap, "source"),
      proseInsertBind("objects", objMap, "credit"),
      renderedValue(objMap.get("thumbnail")),
      renderedValue(objMap.get("dimensions")),
      this.objectCustomBlob(objMap),
      flagBind(objMap.get("featured")),
      flagBind(objMap.get("image_available")),
      orderKeyBind(objMap),
      // origin is D1-only (the cold build never loads it onto the Y.Map). On a
      // stale-id re-INSERT, `preserved` carries the surviving row's origin so a
      // repo/compositor object is not silently reclassified as "iiif".
      renderedValue(preserved?.origin ?? objMap.get("origin"), "iiif"),
      0, // missing_from_repo = false on insert
      // Deliberately NOT preserved from the surviving D1 row: preserve would
      // prefer D1 over the Y copy and resurrect a marker the leave sequence
      // has just cleared. The Y.Doc is authoritative for the marker.
      courseMarkerBind(objMap),
      rowIdBind(objMap.get("created_by")),
      lastEditedBy,
      // D1-only, and absent from the document by design. On a stale-id
      // re-INSERT `preserved` carries the surviving row's provenance; a
      // compositor-created object has a person in `created_by` and binds null.
      preservedActor(preserved),
      now,
    ];
    const outcome = await this.insertRow(
      "objects",
      slug,
      columns,
      binds,
      explicitId,
      (id) => {
        this.objectInsertIds.set(objMap, id);
        this.ydoc.transact(() => { objMap.set("_id", id); });
      },
      `[snapshot] object "${slug}" insert blocked — manual remediation needed`,
      `[snapshot] new object "${slug}" insert failed`,
    );
    return { ...outcome, ...parked.pending };
  }

  /**
   * Sections 6–8: the flat single-table pipelines — objects, glossary terms,
   * pages — share ONE INSERT / UPDATE / DELETE shape with a stale-`_id`
   * "adopt-or-re-INSERT" branch, walked here once.
   *
   * Only these three flat pipelines belong here. stories/steps/layers do NOT:
   * they own FK children and cascade-delete, and they DELIBERATELY never adopt a
   * live same-key row (adopting would silently clobber the live row's children) —
   * see snapshotStories, which keeps its own nested walker.
   *
   * Per-entity divergences are explicit parameters, not hidden in shared code:
   *   - `skip`       — objects skip a row that is BOTH `_validation_state ===
   *                    "pending"` and `_id === null`, so an unvalidated IIIF
   *                    manifest never persists. Objects only. A skipped row is
   *                    withheld from reconciliation entirely, so the predicate
   *                    must never match a row that has a D1 id — see the note
   *                    at the skip itself.
   *   - `pushUpdate` — the in-place UPDATE. It writes the human key (object_id /
   *                    term_id / slug). `project_pages(project_id, slug)` is
   *                    UNIQUE, so the pages UPDATE writes a slug only when the
   *                    document states one (see `snapshotPages`).
   *                    `index` is the Y.Array position (pages thread it into the
   *                    `"order"` column; objects/glossary ignore it).
   *   - `insert`     — the crash-proof insert wrapper (order-aware for pages).
   * The stale-`_id` else-branch adopts a live same-key row (UPDATE it + backfill
   * `_id`) when one exists, else re-INSERTs under the stale id.
   */
  /**
   * One `SELECT id, <keyField> FROM <table> WHERE project_id = ?`, shaped for
   * the two consumers that need it: `ids` is the orphan-detection set, and
   * `keyToId` answers "which row owns this human key?" for the dedupe keeper
   * and the stale-`_id` adopt branch. `ids` is handed out by copy at each use
   * because the orphan pass empties it.
   */
  /**
   * The course this site is attached to, read from D1: null when it is in
   * none, including when its course has been deleted. Throws when D1 cannot
   * answer, so a caller never reads a failed read as "in no course", which
   * would strip markers the site is bound by.
   */
  private async readParentProjectId(): Promise<number | null> {
    const row = await this.env.DB
      .prepare("SELECT parent_project_id FROM projects WHERE id = ?")
      .bind(this.projectId)
      .first<{ parent_project_id: number | null }>();
    return markerCourse(row?.parent_project_id ?? null);
  }

  /**
   * The site's parent, read only when an insert carries a course marker: an
   * ingest with none, which is every ingest but a preload, costs no read.
   */
  private async parentForMarkedInserts(
    inserts: ReadonlyArray<{ course_project_id?: unknown }>,
  ): Promise<number | null> {
    if (!inserts.some((ins) => markerCourse(ins.course_project_id) !== null)) return null;
    return this.readParentProjectId();
  }

  /**
   * Drop the course markers that do not name the site's parent
   * (`course-marker-invariant.ts`), as one transaction the log carries, and
   * owe the peers the change until a snapshot broadcasts it.
   */
  private dropStrandedCourseMarkers(parent: number | null): void {
    this.ydoc.transact(() => {
      if (dropStrandedMarkers(this.ydoc.getArray<Y.Map<unknown>>("objects"), parent)) {
        this.markerBroadcastOwed = true;
      }
    });
  }

  private async fetchEntityKeys(table: string, keyField: string): Promise<EntityKeyIndex> {
    const result = await this.env.DB
      .prepare(`SELECT id, ${keyField} FROM ${table} WHERE project_id = ? ORDER BY id`)
      .bind(this.projectId)
      .all<Record<string, unknown>>();
    const ids = new Set<number>();
    const everyKey = new Map<string, number>();
    for (const r of result.results) {
      const id = r.id as number;
      ids.add(id);
      // Where D1 holds one key on several rows (glossary terms written before
      // migration 0072, and held terms, which the index leaves out), the
      // lowest id owns it, so the dedupe keeper names the same row every pass.
      const k = renderedKey(r[keyField] ?? "");
      if (!everyKey.has(k)) everyKey.set(k, id);
    }
    const keyToId = new Map([...everyKey].filter(([k]) => k !== ""));
    return { ids, keyToId, everyKey };
  }

  private async snapshotFlatEntity(
    statements: D1PreparedStatement[],
    prefetched: EntityKeyIndex,
    cfg: {
      arrayName: string;
      table: string;
      keyField: string;
      // The entity's boolean columns. One of them out of domain means the
      // entity is not written at all this snapshot — see `malformedFlags`.
      flagFields?: readonly string[];
      skip?: (m: Y.Map<unknown>) => boolean;
      pushUpdate: (m: Y.Map<unknown>, index: number, targetId: number) => void;
      // Writes what a new entity carries that the UPDATE leaves to the row,
      // where the entity takes over a row (`UniqueKey.adoptsUnclaimedHolder`).
      pushAdopted?: (m: Y.Map<unknown>, targetId: number) => void;
      // D1-only columns that the Y.Map never carries (object.origin,
      // glossary.related_terms). On a stale-`_id` re-INSERT they must be read
      // back from D1 so the recreated row keeps them instead of resetting to
      // the insert default — see the re-INSERT branch below.
      preserveColumns?: string[];
      // Set where the table is UNIQUE on (project_id, keyField). Unset, the
      // pipeline issues its statements in walk order.
      uniqueKey?: UniqueKey;
      insert: FlatInsert;
    },
  ): Promise<boolean> {
    let didBackfill = false;
    const array = this.ydoc.getArray<Y.Map<unknown>>(cfg.arrayName);
    const firstStatement = statements.length;
    // The rows this pass UPDATEs, with the key each is written, and the rows
    // it inserted under a parking key, with the key each still has to take.
    const written: Array<{ id: number; key: string }> = [];
    const placed: Array<{ id: number; key: string }> = [];
    // New entities whose key D1 still holds, inserted once the walk has said
    // which rows this pass deletes and renames.
    const deferred: Array<{ m: Y.Map<unknown>; index: number }> = [];
    // The read is taken once per table in `doSnapshot` and shared with the
    // dedupe keeper — the orphan set is consumed here, so it arrives as a
    // fresh copy rather than the shared one.
    const d1Ids = new Set(prefetched.ids);
    const d1KeyToId = prefetched.keyToId;

    // order_key order, not array order. `i` is therefore the entity's rank in
    // the list — which pages thread into their "order" column; objects and
    // glossary publish no order and ignore it.
    const { maps: ordered, skipped } = orderedEntries(array);
    if (skipped.length > 0) {
      this.reportMalformed(cfg.arrayName, `${cfg.arrayName}[${skipped.join(",")}]`);
      d1Ids.clear();
    }
    for (let i = 0; i < ordered.length; i++) {
      const m = ordered[i];

      // A skipped entity is withheld from its UPDATE and, being `continue`d
      // before the orphan set is touched, from the orphan sweep too. Every
      // `skip` predicate must therefore be false for any entity that has a D1
      // row, or a client could park a live row outside reconciliation by
      // writing the field the predicate reads.
      if (cfg.skip?.(m)) continue;

      // An out-of-domain `_id` is neither absent nor stale. Absent would mint a
      // second row for an entity that already has one; stale would hand the
      // value to `.bind()` as an explicit id, which is the raw bind this pass
      // exists to remove. So it takes the stale branch WITHOUT the id: the
      // adopt-by-human-key arm below settles it against the row D1 says owns
      // the key, which is the pipeline that already owns that question and the
      // downstream behaviour the detect-only ruling recorded. Where there is
      // no key to adopt by, there is nothing left that does not involve
      // trusting the value, so the entity is left alone and the sweep with it.
      const flagPlant = cfg.flagFields
        ? this.malformedFlags(m, cfg.flagFields)
        : null;
      if (flagPlant) {
        this.reportMalformed(
          cfg.arrayName,
          `${cfg.arrayName}[${i}].${flagPlant.key}`,
          flagPlant.found,
        );
        const known = readRowId(m.get("_id"));
        // The entity is in the document, so its row is not an orphan — but
        // only an id in domain can say which row that is. Without one, the
        // table keeps everything.
        if (known.ok) d1Ids.delete(known.value);
        else d1Ids.clear();
        continue;
      }

      const idRead = readRowId(m.get("_id"));
      const idMalformed = !idRead.ok && idRead.reason === "wrong_type";
      if (idMalformed) {
        this.reportMalformed(cfg.arrayName, `${cfg.arrayName}[${i}]._id`, idRead.found);
      }
      const id = idRead.ok ? idRead.value : null;
      if (!idMalformed && (id === null || id === undefined)) {
        const r = await this.insertOrDefer(cfg, m, i, prefetched.everyKey, deferred);
        if (r.backfilled) didBackfill = true;
        // A refused INSERT must never become a DELETE of the row it collided
        // with. `insertRow` swallows the failure — a snapshot cannot abort
        // mid-flush — and the only INSERT this pipeline can lose to is the
        // UNIQUE human key (project_pages(project_id, slug)). Leaving that row
        // in the orphan set would sweep away the live record whose key the
        // failed insert wanted, which is the reverse of what refusing meant.
        //
        // Only a refused INSERT. A backfill that threw leaves a row D1 does
        // hold, at an id no other Y.Map claims, so nothing here is at risk from
        // the orphan sweep.
        if (r.failure === "insert") {
          const claimed = d1KeyToId.get(renderedKey(m.get(cfg.keyField)));
          if (claimed !== undefined) d1Ids.delete(claimed);
        }
      } else if (id !== null && d1Ids.has(id)) {
        cfg.pushUpdate(m, i, id);
        this.pushMarkedAdoption(cfg, m, id);
        written.push(...keyWritten(cfg.uniqueKey, id, renderedKey(m.get(cfg.keyField))));
        d1Ids.delete(id);
      } else {
        // Stale _id: adopt a live same-key row when one exists, else re-INSERT
        // with the same id. The adopt UPDATE writes the key the adopted row
        // already holds, so it collides with nothing.
        const key = renderedKey(m.get(cfg.keyField));
        const liveId = key ? d1KeyToId.get(key) : undefined;
        if (liveId !== undefined) {
          cfg.pushUpdate(m, i, liveId);
          written.push({ id: liveId, key });
          const adoptId = liveId;
          this.ydoc.transact(() => { m.set("_id", adoptId); });
          // The adoption is a transaction outside `insertThenBackfill`, and it
          // carries the same obligation: a record the log could not hold stops
          // this snapshot before its blob write and its entity batch.
          this.refusePastHalt();
          didBackfill = true;
          d1Ids.delete(liveId);
        } else if (idMalformed || id === null) {
          // No live row owns the key, and the id names no row this can bind.
          // Nothing is written for this entity, and the table keeps every row
          // it has: one of them may be the row the unreadable id was carrying.
          d1Ids.clear();
          continue;
        } else {
          // Re-INSERT under the stale id. The Y.Map does not carry every D1
          // column — object.origin and glossary.related_terms live only in D1 —
          // so rebuilding the row from the Y.Map alone would reset them to their
          // INSERT defaults. When a row for this id still survives, read those
          // columns back and hand them to the insert so the recreation stays
          // faithful; otherwise the insert falls back to its default.
          let preserved: Record<string, unknown> | undefined;
          if (cfg.preserveColumns?.length) {
            const oldRow = await this.env.DB
              .prepare(
                `SELECT ${cfg.preserveColumns.join(", ")} FROM ${cfg.table} WHERE id = ? AND project_id = ?`,
              )
              .bind(id, this.projectId)
              .first<Record<string, unknown>>();
            if (oldRow) preserved = oldRow;
          }
          const r = await cfg.insert(m, i, id, preserved);
          if (r.backfilled) didBackfill = true;
        }
      }
    }

    const late = await this.insertDeferred(statements, cfg, deferred, { written, placed, orphans: d1Ids, prefetched, backfilled: didBackfill });
    const firstOrphanStatement = statements.length;
    for (const orphanId of d1Ids) {
      statements.push(
        this.env.DB.prepare(`DELETE FROM ${cfg.table} WHERE id = ?`).bind(orphanId),
      );
    }
    this.leadWithFreedKeys(statements, cfg, { firstStatement, firstOrphanStatement }, { written, placed, blocked: late.blocked }, prefetched);
    return late.backfilled;
  }

  /**
   * INSERT one new flat entity, or, under a UNIQUE key (`cfg.uniqueKey`) that
   * D1 still holds on another row, hold it in `deferred` for `insertDeferred`.
   */
  private async insertOrDefer(
    cfg: { keyField: string; uniqueKey?: UniqueKey; insert: FlatInsert },
    m: Y.Map<unknown>,
    index: number,
    d1KeyToId: ReadonlyMap<string, number>,
    deferred: Array<{ m: Y.Map<unknown>; index: number }>,
  ): Promise<InsertOutcome> {
    const key = renderedKey(m.get(cfg.keyField));
    if (!cfg.uniqueKey?.indexed(key) || !d1KeyToId.has(key)) return cfg.insert(m, index);
    deferred.push({ m, index });
    return { id: 0, backfilled: false };
  }

  /**
   * INSERT the entities `insertOrDefer` held back. One whose key this pass
   * frees — its holder deleted, or renamed and not blocked (`blockedRenames`)
   * — goes in under a placeholder, and the UPDATE giving it its own key is
   * queued, its row recorded in `placed`. Any other is inserted as it is, and
   * D1 refuses it until a later snapshot finds the key free. Answers whether
   * the pass, `pass.backfilled` so far and these INSERTs, backfilled the
   * document, and the blocked renames.
   */
  private async insertDeferred(
    statements: D1PreparedStatement[],
    cfg: { table: string; keyField: string; uniqueKey?: UniqueKey; insert: FlatInsert; pushUpdate: (m: Y.Map<unknown>, index: number, targetId: number) => void; pushAdopted?: (m: Y.Map<unknown>, targetId: number) => void },
    deferred: ReadonlyArray<{ m: Y.Map<unknown>; index: number }>,
    pass: { written: Array<{ id: number; key: string }>; placed: Array<{ id: number; key: string }>; orphans: Set<number>; prefetched: EntityKeyIndex; backfilled: boolean },
  ): Promise<{ backfilled: boolean; blocked: ReadonlySet<number> }> {
    const unique = cfg.uniqueKey;
    if (!unique) return { backfilled: pass.backfilled, blocked: new Set() };
    const keyToId = pass.prefetched.everyKey;
    const toInsert = unique.adoptsUnclaimedHolder ? this.adoptUnclaimedHolders(cfg, deferred, pass) : deferred;
    const renamed = pass.written.filter((w) => keyToId.get(w.key) !== w.id);
    const blocked = blockedRenames(renamed, keyToId, pass.orphans, unique.indexed);
    const moving = new Set(renamed.filter((w) => !blocked.has(w.id)).map((w) => w.id));
    const park: ParkTest = {
      holds: (key) => unique.indexed(key) && this.freedThisPass(keyToId.get(key), pass.orphans, moving),
      placeholder: unique.placeholder,
    };
    let backfilled = pass.backfilled || toInsert.length < deferred.length;
    for (const { m, index } of toInsert) {
      const r = await cfg.insert(m, index, undefined, undefined, park);
      backfilled ||= r.backfilled;
      if (r.pendingKey === undefined || r.failure === "insert") continue;
      pass.placed.push({ id: r.id, key: r.pendingKey });
      statements.push(this.writeUniqueKey(cfg.table, cfg.keyField, r.pendingKey, r.id));
    }
    return { backfilled, blocked };
  }

  /**
   * UPDATE, in place of an INSERT, each deferred entity whose key is held by
   * a row this pass would delete, taking that row's id into the document and
   * out of the orphans. Answers the entities left to insert.
   */
  private adoptUnclaimedHolders(
    cfg: { keyField: string; pushUpdate: (m: Y.Map<unknown>, index: number, targetId: number) => void; pushAdopted?: (m: Y.Map<unknown>, targetId: number) => void },
    deferred: ReadonlyArray<{ m: Y.Map<unknown>; index: number }>,
    pass: { written: Array<{ id: number; key: string }>; orphans: Set<number>; prefetched: EntityKeyIndex },
  ): Array<{ m: Y.Map<unknown>; index: number }> {
    const left: Array<{ m: Y.Map<unknown>; index: number }> = [];
    for (const entry of deferred) {
      const key = renderedKey(entry.m.get(cfg.keyField));
      const holder = pass.prefetched.everyKey.get(key);
      if (holder === undefined || !pass.orphans.has(holder)) {
        left.push(entry);
        continue;
      }
      cfg.pushUpdate(entry.m, entry.index, holder);
      cfg.pushAdopted?.(entry.m, holder);
      pass.written.push({ id: holder, key });
      pass.orphans.delete(holder);
      this.ydoc.transact(() => {
        entry.m.set("_id", holder);
        if (cfg.pushAdopted) entry.m.set(ADOPTED_MARK, true);
      });
      if (cfg.pushAdopted) this.adoptionMarks.push(entry.m);
      // As with the stale-id adoption: a record the log could not hold stops
      // this snapshot before its blob write and its entity batch.
      this.refusePastHalt();
    }
    return left;
  }

  /** Whether the row holding a key gives it up in this pass. */
  private freedThisPass(holder: number | undefined, orphans: ReadonlySet<number>, moving: ReadonlySet<number>): boolean {
    return holder !== undefined && (orphans.has(holder) || moving.has(holder));
  }

  /**
   * Under a UNIQUE key, D1 checks each statement as it runs, so a key a
   * deleted row or a renamed one gives up is free only once that statement
   * has run: the pipeline's deletions, and any parking, move ahead of every
   * key it writes. Without one, the statements stay in walk order.
   */
  private leadWithFreedKeys(
    statements: D1PreparedStatement[],
    cfg: { table: string; keyField: string; uniqueKey?: UniqueKey },
    at: { firstStatement: number; firstOrphanStatement: number },
    pass: { written: ReadonlyArray<{ id: number; key: string }>; placed: ReadonlyArray<{ id: number; key: string }>; blocked: ReadonlySet<number> },
    prefetched: EntityKeyIndex,
  ): void {
    if (!cfg.uniqueKey) return;
    const leading = [
      ...statements.splice(at.firstOrphanStatement),
      ...this.parkRenamedRows(cfg.table, cfg.keyField, pass, prefetched, cfg.uniqueKey),
    ];
    statements.splice(at.firstStatement, 0, ...leading);
  }

  /**
   * The SET clause that writes a row's human key under a UNIQUE index, with
   * its binds. Where another row of the project holds the key when the
   * statement runs, the row keeps the key it has: the snapshot batch is atomic,
   * so one refused UPDATE would discard every entity's writes, and every retry
   * would issue it again. The document still carries the key, and the next
   * snapshot writes it once the other row has given it up.
   *
   * A row is parked only where its key is free by the time its UPDATE runs
   * (`parkRenamedRows`), so what a row keeps here is its own key.
   */
  private uniqueKeySet(
    table: string,
    column: string,
    key: string,
    indexed: boolean,
  ): { sql: string; binds: unknown[] } {
    if (!indexed) return { sql: `${column} = ?`, binds: [key] };
    // One bind and no WHERE inside the assignment, so the SET list keeps one
    // `?` per column: the holder is found by a join against the row being
    // updated, which the subquery reads through the table's own name.
    return {
      sql:
        `${column} = (SELECT CASE WHEN COUNT(held.id) > 0 THEN ${table}.${column} ELSE wanted.k END ` +
        `FROM (SELECT ? AS k) AS wanted LEFT JOIN ${table} AS held ON held.project_id = ${table}.project_id ` +
        `AND held.${column} = wanted.k AND held.id <> ${table}.id)`,
      binds: [key],
    };
  }

  /** The UPDATE that gives a row inserted under a parking key its own key. */
  private writeUniqueKey(table: string, column: string, key: string, rowId: number): D1PreparedStatement {
    const set = this.uniqueKeySet(table, column, key, true);
    return this.env.DB
      .prepare(`UPDATE ${table} SET ${set.sql} WHERE id = ?`)
      .bind(...set.binds, rowId);
  }

  /**
   * `parkRenamedStories` for the flat pipelines with a UNIQUE key. Rows that
   * exchange keys, or pass one along a chain, collide on the first UPDATE
   * whatever the walk order, so when a key this pass writes is held by another
   * row this pass renames, every renamed row first moves to its table's
   * parking key (`UniqueKey.parkSql`). A rename whose key stays held through
   * the batch (`blockedRenames`) is not parked, so every parked row's UPDATE
   * finds its key free and no parking key is left in D1.
   */
  private parkRenamedRows(
    table: string,
    column: string,
    pass: { written: ReadonlyArray<{ id: number; key: string }>; placed: ReadonlyArray<{ id: number; key: string }>; blocked: ReadonlySet<number> },
    d1Keys: EntityKeyIndex,
    unique: UniqueKey,
  ): D1PreparedStatement[] {
    const writtenIds = new Set(pass.written.map((w) => w.id));
    const renamed = pass.written.filter((w) => d1Keys.everyKey.get(w.key) !== w.id && !pass.blocked.has(w.id));
    const needed = [...renamed, ...pass.placed].some((w) => {
      if (!unique.indexed(w.key)) return false;
      const holder = d1Keys.everyKey.get(w.key);
      return holder !== undefined && holder !== w.id && writtenIds.has(holder);
    });
    if (!needed) return [];
    return renamed.map((w) =>
      this.env.DB.prepare(`UPDATE ${table} SET ${column} = ${unique.parkSql} WHERE id = ?`).bind(w.id),
    );
  }

  /** Section 6: objects INSERT (with _id backfill) / UPDATE / DELETE. */
  private snapshotObjects(
    statements: D1PreparedStatement[],
    now: string,
    prefetched: EntityKeyIndex,
  ): Promise<boolean> {
    const objectEdits = rowEditsFromPaths(this.editsByPath, "objects");
    return this.snapshotFlatEntity(statements, prefetched, {
      arrayName: "objects",
      table: "objects",
      flagFields: ["featured", "image_available"],
      keyField: "object_id",
      // A never-persisted IIIF object whose manifest has not validated yet is
      // not ready for D1 (objects only — no other flat pipeline has this
      // guard). `_id === null` is half the predicate, not an accident of it:
      // `_validation_state` is client-writable, and a skip that fired on a row
      // with a D1 id would let a client park that row outside reconciliation —
      // no UPDATE, no orphan DELETE — by writing "pending" onto it. The
      // legitimate state only ever occurs together with a null `_id`:
      // `createObjectYMap` sets both, and validation flips the field once, to
      // "valid" or "error", before the first snapshot gives the row an id.
      skip: (m) => m.get("_validation_state") === "pending" && (m.get("_id") ?? null) === null,
      pushUpdate: (m, _index, targetId) => {
        const objectId = this.uniqueKeySet(
          "objects", "object_id", renderedKey(m.get("object_id")), true,
        );
        statements.push(
          this.env.DB
            .prepare(
              // object_id is written on every UPDATE, through `uniqueKeySet`:
              // objects(project_id, object_id) is UNIQUE (migration 0071) and
              // this UPDATE rides in the atomic batch. origin and
              // missing_from_repo are D1-only and preserved by omission.
              // COALESCE on the ten prose columns, so a value the snapshot
              // cannot read leaves D1's standing. object_id is a human key and
              // keeps its own rule; the passthrough columns keep theirs.
              `UPDATE objects SET title = COALESCE(?, title), ${objectId.sql}, ` +
              "creator = COALESCE(?, creator), description = COALESCE(?, description), " +
              "alt_text = COALESCE(?, alt_text), " +
              "source_url = ?, period = COALESCE(?, period), year = COALESCE(?, year), " +
              "object_type = COALESCE(?, object_type), subjects = COALESCE(?, subjects), " +
              "source = COALESCE(?, source), credit = COALESCE(?, credit), " +
              "thumbnail = ?, dimensions = ?, extra_columns = ?, " +
              "featured = ?, image_available = ?, order_key = ?, course_project_id = ?, " +
              "last_edited_by = COALESCE(?, last_edited_by), " +
              "updated_at = COALESCE(?, updated_at) WHERE id = ?",
            )
            .bind(
              proseUpdateBind("objects", m, "title"),
              ...objectId.binds,
              proseUpdateBind("objects", m, "creator"),
              proseUpdateBind("objects", m, "description"),
              proseUpdateBind("objects", m, "alt_text"),
              renderedValue(m.get("source_url")),
              proseUpdateBind("objects", m, "period"),
              proseUpdateBind("objects", m, "year"),
              proseUpdateBind("objects", m, "object_type"),
              proseUpdateBind("objects", m, "subjects"),
              proseUpdateBind("objects", m, "source"),
              proseUpdateBind("objects", m, "credit"),
              renderedValue(m.get("thumbnail")),
              renderedValue(m.get("dimensions")),
              this.objectCustomBlob(m),
              flagBind(m.get("featured")),
              flagBind(m.get("image_available")),
              orderKeyBind(m),
              // Written, not preserved by omission: the marker-clear route
              // removes the key from the Y.Map and this UPDATE is what makes
              // D1 agree. Preserving it would leave the delete gate refusing
              // deletes on objects that are ordinary site objects again.
              courseMarkerBind(m),
              objectEdits.get(String(targetId))?.by ?? null,
              objectEdits.get(String(targetId))?.at ?? null,
              targetId,
            ),
        );
      },
      // origin is D1-only; carry it across a stale-id re-INSERT (missing_from_repo
      // is likewise D1-only but is re-derived by the next repo sync, so it is
      // left to default here). created_by_actor is D1-only for a stronger
      // reason: it is deliberately absent from the document so no client can
      // write it, which means a re-INSERT is the only place it could be lost.
      preserveColumns: ["origin", "created_by_actor"],
      uniqueKey: OBJECTS_UNIQUE_KEY,
      insert: (m, _index, explicitId, preserved, park) =>
        this.insertObjectRow(m, now, this.editorForInsert(m, objectEdits), explicitId, preserved, park),
    });
  }

  /**
   * A `term_id` no row and no other mint in this snapshot already holds.
   *
   * A minted identifier some row already holds is refused by
   * glossary_terms(project_id, term_id) (migration 0072), and every retry
   * would mint the same one from the same title and `_temp_id`. Nothing
   * upstream stops the collision. The candidate is built from a title and a `_temp_id`, both
   * client-writable, so two terms can state the same pair, and a minted
   * candidate can equal a key some other term already carries.
   *
   * `makeUniqueTermId` is the generator the dedupe pass re-keys with, so a
   * minted identifier and a re-keyed one have one format. It answers
   * `untitled` for a candidate that normalises to nothing, and answers it
   * WITHOUT consulting the set — the one result that can come back taken. A
   * random candidate normalises to itself, so the retry terminates.
   */
  private mintTermId(candidate: string, taken: Set<string>): string {
    let minted = makeUniqueTermId(candidate, [...taken]);
    while (taken.has(minted)) {
      minted = makeUniqueTermId(crypto.randomUUID(), [...taken]);
    }
    taken.add(minted);
    return minted;
  }

  /**
   * INSERT one glossary term. Thin wrapper over `insertRow`, with the glossary's
   * one divergence: it derives a `resolvedTermId` (slugify the title + an 8-char
   * suffix for a brand-new term; keep the existing slug for a re-created stranded
   * term, whose term_id is already set) ONCE — a fresh `crypto.randomUUID()` must
   * not be recomputed between the INSERT bind and the backfill — and its backfill
   * writes that second key onto the Y.Map when it was newly generated. No other
   * pipeline computes or backfills a second identity field.
   *
   * `takenTermIds` is the snapshot's live set of glossary identifiers, which
   * `mintTermId` reads and extends. It is the caller's because it must span
   * every term this snapshot inserts, not one of them.
   */
  private async insertGlossaryRow(
    termMap: Y.Map<unknown>,
    now: string,
    lastEditedBy: number | null,
    takenTermIds: Set<string>,
    explicitId?: number,
    preserved?: Record<string, unknown>,
    park?: ParkTest,
  ): Promise<InsertOutcome> {
    // Both are client-writable, and both were cast to `string | undefined`
    // before being used as one: `existingTermId` decides the row's human key,
    // and `tempId` has `.slice(0, 8)` called on it — a `TypeError` on a plain
    // object, thrown inside the snapshot batch. A value outside the domain is
    // read as unset, which is the branch this row would have taken before
    // anyone wrote it: mint a fresh id rather than adopt an unreadable one.
    const existingTermIdRead = readHumanKey(termMap.get("term_id"));
    const existingTermId = existingTermIdRead.ok ? existingTermIdRead.value : undefined;
    const tempIdRead = readHumanKey(termMap.get("_temp_id"));
    const tempId = tempIdRead.ok ? tempIdRead.value : undefined;
    if (!existingTermIdRead.ok && existingTermIdRead.reason === "wrong_type") {
      this.reportMalformed("glossary", "glossary[].term_id", existingTermIdRead.found);
    }
    if (!tempIdRead.ok && tempIdRead.reason === "wrong_type") {
      this.reportMalformed("glossary", "glossary[]._temp_id", tempIdRead.found);
    }
    // The INSERT's title bind AND the source of a brand-new term's permanent
    // `term_id`. A title the snapshot cannot read is `""` here, so the slug
    // base is empty and the term is minted under its `_temp_id` (or a fresh
    // UUID) instead of under a slug derived from a render of the plant.
    const titleStr = proseInsertBind("glossary", termMap, "title");
    const slugBase = titleStr.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    // An identifier the document already carries is adopted verbatim — a
    // rename is the author's, and `takenTermIds` already holds it. Only a
    // MINTED one goes through the uniqueness guard, because only a minted one
    // is this pass's to choose.
    const resolvedTermId = existingTermId
      ? existingTermId
      : this.mintTermId(
          slugBase
            ? `${slugBase}-${(tempId ?? crypto.randomUUID()).slice(0, 8)}`
            : (tempId ?? crypto.randomUUID()),
          takenTermIds,
        );
    // A minted id avoids every key D1 holds, so only an adopted one is parked.
    const parked = parkedBind(resolvedTermId, park);

    // related_terms and extra_columns are D1-only passthrough columns — neither
    // is part of the Y.Doc glossary shape, so the compositor never edits them.
    // On a stale-id re-INSERT, `preserved` carries the surviving row's values so
    // they are not dropped; a brand-new term has none, binding NULL (both
    // schema-nullable).
    const preservedText = (column: string): string | null =>
      (preserved?.[column] as string | null) ?? null;
    const columns = ["project_id", "term_id", "title", "definition", "kind", "related_terms", "extra_columns", "order_key", "created_by", "last_edited_by", "created_by_actor", "updated_at"];
    const binds = [
      this.projectId,
      parked.bind,
      titleStr,
      proseInsertBind("glossary", termMap, "definition"),
      kindForInsert(termMap.get("kind"), preservedText("kind")),
      preservedText("related_terms"),
      preservedText("extra_columns"),
      orderKeyBind(termMap),
      rowIdBind(termMap.get("created_by")),
      lastEditedBy,
      preservedActor(preserved),
      now,
    ];
    const outcome = await this.insertRow(
      "glossary_terms",
      resolvedTermId,
      columns,
      binds,
      explicitId,
      (id) => {
        this.ydoc.transact(() => {
          termMap.set("_id", id);
          if (!existingTermId) termMap.set("term_id", resolvedTermId);
        });
      },
      `[snapshot] glossary term "${resolvedTermId}" insert blocked — manual remediation needed`,
      `[snapshot] new glossary term "${resolvedTermId}" insert failed`,
    );
    return { ...outcome, ...parked.pending };
  }

  /** Section 7: glossary_terms INSERT (with _id backfill) / UPDATE / DELETE. */
  private snapshotGlossary(
    statements: D1PreparedStatement[],
    now: string,
    prefetched: EntityKeyIndex,
  ): Promise<boolean> {
    const termEdits = rowEditsFromPaths(this.editsByPath, "glossary");
    // Every identifier a mint below must avoid: the ones D1 holds for this
    // project, and the ones the document carries. The document half is not
    // redundant — a term whose own `term_id` is adopted verbatim is never
    // minted, so a mint can only avoid it by finding it here — and neither is
    // the D1 half, because a term the document has dropped still owns its row
    // until the orphan sweep at the end of this same pass.
    const takenTermIds = new Set<string>(prefetched.keyToId.keys());
    for (const m of entityMaps(this.ydoc.getArray<unknown>("glossary")).maps) {
      const key = renderedKey(m.get("term_id"));
      if (key) takenTermIds.add(key);
    }
    return this.snapshotFlatEntity(statements, prefetched, {
      arrayName: "glossary",
      table: "glossary_terms",
      keyField: "term_id",
      pushUpdate: (m, _index, targetId) => {
        // term_id is a human key, not prose: it binds through `renderedKey`
        // like the page slug, whose sentinel for a value nothing can render
        // is the `""` an unkeyed map already carries. A prose rule here would
        // be an identifier rule.
        const key = renderedKey(m.get("term_id"));
        const termId = this.uniqueKeySet(
          "glossary_terms", "term_id", key, inGlossaryIndex(key),
        );
        statements.push(
          this.env.DB
            .prepare(
              // term_id is written on every UPDATE, since the glossary editor
              // renames a term's id, and through `uniqueKeySet`, since
              // glossary_terms(project_id, term_id) is UNIQUE outside held ids
              // (migration 0072) and this UPDATE rides in the atomic batch.
              // COALESCE on the two prose columns, so a value the snapshot
              // cannot read leaves D1's standing. term_id is a human key and
              // keeps its own rule.
              `UPDATE glossary_terms SET title = COALESCE(?, title), ${termId.sql}, ` +
              "definition = COALESCE(?, definition), " +
              "kind = COALESCE(?, kind), order_key = ?, " +
              "last_edited_by = COALESCE(?, last_edited_by), " +
              "updated_at = COALESCE(?, updated_at) WHERE id = ?",
            )
            .bind(
              proseUpdateBind("glossary", m, "title"),
              ...termId.binds,
              proseUpdateBind("glossary", m, "definition"),
              kindBind(m.get("kind")),
              orderKeyBind(m),
              termEdits.get(String(targetId))?.by ?? null,
              termEdits.get(String(targetId))?.at ?? null,
              targetId,
            ),
        );
      },
      // related_terms and extra_columns are D1-only passthroughs; carry them
      // across a stale-id re-INSERT so the recreated term keeps them (the Y.Doc
      // never holds either). created_by_actor is D1-only for the same
      // structural reason, and kept out of the document on purpose so no client
      // can write it.
      preserveColumns: ["related_terms", "extra_columns", "kind", "created_by_actor"],
      uniqueKey: GLOSSARY_UNIQUE_KEY,
      insert: (m, _index, explicitId, preserved, park) =>
        this.insertGlossaryRow(
          m, now, this.editorForInsert(m, termEdits), takenTermIds, explicitId, preserved, park,
        ),
    });
  }

  /**
   * INSERT one project_pages row. Thin wrapper over `insertRow`. `order_key` is
   * the page's own place; `order` is the dense rank it holds in that ordering,
   * threaded in by the caller.
   */
  private async insertPageRow(
    pageMap: Y.Map<unknown>,
    order: number,
    now: string,
    lastEditedBy: number | null,
    explicitId?: number,
    preserved?: Record<string, unknown>,
    park?: ParkTest,
  ): Promise<InsertOutcome> {
    const slug = renderedKey(pageMap.get("slug"));
    const parked = parkedBind(slug, park);
    const columns = [
      "project_id", "title", "slug", "body", "frontmatter", "frontmatter_source",
      '"order"', "order_key", "created_by", "last_edited_by", "updated_at",
    ];
    const binds = [
      this.projectId,
      // `project_pages.title` is NOT NULL, so this bind must be a string:
      // `proseInsertBind` answers `""` for a value it cannot read, where a
      // null would fail the statement rather than hold anything.
      proseInsertBind("pages", pageMap, "title"),
      parked.bind,
      proseInsertBind("pages", pageMap, "body"),
      pageFrontmatterBind(pageMap),
      // D1-only, like the glossary's passthroughs: a stale-id re-INSERT
      // carries the surviving row's value, and a new page has none.
      (preserved?.frontmatter_source as string | null | undefined) ?? null,
      order,
      orderKeyBind(pageMap),
      rowIdBind(pageMap.get("created_by")),
      lastEditedBy,
      now,
    ];
    const outcome = await this.insertRow(
      "project_pages",
      slug,
      columns,
      binds,
      explicitId,
      (id) => { this.ydoc.transact(() => { pageMap.set("_id", id); }); },
      `[snapshot] page "${slug}" insert blocked — manual remediation needed`,
      `[snapshot] new page "${slug}" insert failed`,
    );
    return { ...outcome, ...parked.pending };
  }

  /**
   * For a story the document renames, records the file it was last written to
   * as its `source_path`, for the next publish's layout. It runs before the
   * UPDATE in the batch, so `story_id` is still D1's. A path in the
   * spreadsheets folder is kept (the story's own, or an earlier unpublished
   * rename's); any other, or none, becomes the old ID's file when no other
   * story records it (`PREVIOUS_STORY_FILE_SQL`).
   */
  private previousStoryFileStatement(storyId: number, renamedTo: string, d1Keys: EntityKeyIndex): D1PreparedStatement[] {
    const held = [...d1Keys.keyToId].find(([, id]) => id === storyId)?.[0];
    if (renamedTo === "" || held === undefined || held === renamedTo) return [];
    return [this.env.DB
      .prepare(
        // A row `parkRenamedStories` moved to `~<id>` has had its file recorded.
        `UPDATE stories SET source_path = ${PREVIOUS_STORY_FILE_SQL} WHERE id = ? AND story_id <> ? AND substr(story_id, 1, 1) <> '~'`,
      )
      .bind(storyId, renamedTo)];
  }

  /**
   * Records `held`, the ID story row `storyRowId` leaves for `renamedTo`, so an
   * editor address with it still finds the story (migration 0073). Nothing for
   * no rename, a blank new ID, or a parked `~<id>`. The SELECT inserts no row
   * when the story is gone, so the record can never refuse the batch it rides
   * in; REPLACE points an ID another story left earlier at this one.
   */
  private previousStoryIdStatement(storyRowId: number, held: string | undefined, renamedTo: string, now: string): D1PreparedStatement[] {
    if (held === undefined || held === "" || held.startsWith("~") || renamedTo === "" || held === renamedTo) return [];
    return [this.env.DB
      .prepare(
        "INSERT OR REPLACE INTO story_previous_ids (project_id, story_id, story_row_id, recorded_at) " +
        "SELECT project_id, ?, id, ? FROM stories WHERE id = ? AND project_id = ?",
      )
      .bind(held, now, storyRowId, this.projectId)];
  }

  /**
   * The `source_path` a story row re-inserted at `renamedTo` carries from the
   * row `surviving` it replaces: its own across no rename, else
   * `PREVIOUS_STORY_FILE_SQL`'s. With no row left there is nothing to carry.
   */
  private async previousStoryFile(
    storyId: number,
    surviving: { source_path: string | null; story_id: string } | null,
    renamedTo: string,
  ): Promise<string | null> {
    if (surviving === null) return null;
    if (renamedTo === "" || renamedTo === surviving.story_id) return surviving.source_path;
    const row = await this.env.DB
      .prepare(`SELECT ${PREVIOUS_STORY_FILE_SQL} AS source_path FROM stories WHERE id = ?`)
      .bind(storyId)
      .first<{ source_path: string | null }>();
    return row?.source_path ?? null;
  }

  /**
   * D1 checks stories(project_id, story_id) after each statement, so stories
   * that exchange IDs, or pass one along a chain, collide on the first UPDATE
   * whatever order the walk takes. When a rename's target is held by another
   * row this snapshot also writes, every row it writes a new ID to first moves
   * to `~<id>` (no story ID has a `~`), so each UPDATE after it lands on a
   * free key. Only rows whose UPDATE is queued are parked, so none stays so.
   * The caller places these ahead of the UPDATEs, with the orphan deletions,
   * which free the keys of deleted stories. The same statement records the
   * file the story was last written to, which `previousStoryFileStatement`
   * would read from `story_id` after it had moved.
   */
  private parkRenamedStories(
    written: ReadonlyArray<{ id: number; key: string }>,
    d1Keys: EntityKeyIndex,
  ): D1PreparedStatement[] {
    const writtenIds = new Set(written.map((w) => w.id));
    const renamed = written.filter((w) => w.key !== "" && d1Keys.keyToId.get(w.key) !== w.id);
    if (!renamed.some((w) => { const held = d1Keys.keyToId.get(w.key); return held !== undefined && writtenIds.has(held); })) return [];
    return renamed.map((w) => this.env.DB.prepare(
      `UPDATE stories SET source_path = ${PREVIOUS_STORY_FILE_SQL}, story_id = '~' || id WHERE id = ?`,
    ).bind(w.id));
  }

  /** Section 8: project_pages INSERT (with _id backfill) / UPDATE / DELETE. */
  private snapshotPages(
    statements: D1PreparedStatement[],
    now: string,
    prefetched: EntityKeyIndex,
  ): Promise<boolean> {
    const pageEdits = rowEditsFromPaths(this.editsByPath, "pages");
    return this.snapshotFlatEntity(statements, prefetched, {
      arrayName: "pages",
      table: "project_pages",
      keyField: "slug",
      // Pages are the one flat pipeline with a rank column: the page's rank in
      // order_key order threads into "order" so D1 carries the same dense rank
      // the editor shows. The published menu order is navigation_json, not this.
      pushUpdate: (m, index, targetId) => {
        const slugKey = renderedKey(m.get("slug"));
        const slug = slugKey === ""
          ? { sql: `slug = ${UNPARKED_BLANK_SLUG_SQL}`, binds: [slugKey] as unknown[] }
          : this.uniqueKeySet("project_pages", "slug", slugKey, true);
        statements.push(
          this.env.DB
            .prepare(
              // The slug column is written only when the document states a
              // key, and then through `uniqueKeySet`.
              // `project_pages(project_id, slug)` is UNIQUE (migration 0021)
              // and this UPDATE rides in the atomic D1 batch, so two pages
              // writing one slug would discard EVERY entity's writes in the
              // snapshot and every retry would re-issue the same pair.
              // Two pages CAN state one slug: `renderedKey` answers `""` both
              // for a page nobody has keyed and for a value nothing can
              // render, and `deduplicateYArray` skips the empty key by design,
              // so neither claimant is collapsed before the batch is built.
              //
              // Declining to write is not choosing between them. The empty
              // string is not a key: it addresses no page in a built site, and
              // a row that keeps the slug D1 already holds keeps a key the DO
              // itself last wrote. Every real rename still lands, because a
              // real slug is non-empty.
              // COALESCE on the two prose columns, so a value the snapshot
              // cannot read leaves D1's standing. The slug's own rule is a
              // different one — an empty key, not an unreadable value — and
              // keeps its own semantics.
              //
              // `frontmatter` takes COALESCE too: a map holding no string is a
              // page whose file was never read, which says nothing about the
              // file, so it never clears a block D1 holds.
              `UPDATE project_pages SET title = COALESCE(?, title), ${slug.sql}, ` +
              "body = COALESCE(?, body), " +
              "frontmatter = COALESCE(?, frontmatter), " +
              '"order" = ?, order_key = ?, last_edited_by = COALESCE(?, last_edited_by), ' +
              "updated_at = COALESCE(?, updated_at) WHERE id = ?",
            )
            .bind(
              proseUpdateBind("pages", m, "title"),
              ...slug.binds,
              proseUpdateBind("pages", m, "body"),
              pageFrontmatterBind(m),
              index, // dense rank in order_key order
              orderKeyBind(m),
              pageEdits.get(String(targetId))?.by ?? null,
              pageEdits.get(String(targetId))?.at ?? null,
              targetId,
            ),
        );
      },
      // frontmatter_source is D1-only and never in the UPDATE, so a rename
      // keeps it; a stale-id re-INSERT carries the surviving row's value.
      // A page that takes over a row is credited to the person who made it,
      // which the UPDATE leaves to the row.
      pushAdopted: (m, targetId) => {
        statements.push(
          this.env.DB
            .prepare("UPDATE project_pages SET created_by = COALESCE(?, created_by) WHERE id = ?")
            .bind(rowIdBind(m.get("created_by")), targetId),
        );
      },
      preserveColumns: ["frontmatter_source"],
      uniqueKey: PAGES_UNIQUE_KEY,
      insert: (m, index, explicitId, preserved, park) =>
        this.insertPageRow(m, index, now, this.editorForInsert(m, pageEdits), explicitId, preserved, park),
    });
  }

  /**
   * Every entity in the document, by the ids its field paths could have named.
   *
   * A contributor is accumulated against whichever id the path carried: a D1
   * `_id` for a row that already existed, and the client's `_temp_id` for one
   * created this window. Only the document knows those are the same entity, so
   * this walk registers both keys against the row's real id.
   *
   * Runs after sections 5-8, which is why the temp ids resolve: an INSERT
   * executes immediately and backfills `_id` onto the Y.Map before the batch is
   * sent, so by here every entity that survived has a real id. An entity whose
   * INSERT was refused still has none, and its contributors are held in memory
   * for the next snapshot rather than written against a guess.
   */
  private entityIdsByKind(): Map<ContributorEntityKind, Map<string, number>> {
    const byKind = new Map<ContributorEntityKind, Map<string, number>>();
    const register = (kind: ContributorEntityKind, map: Y.Map<unknown>): number | null => {
      const read = readRowId(map.get("_id"));
      if (!read.ok || read.value === null) return null;
      let ids = byKind.get(kind);
      if (!ids) {
        ids = new Map<string, number>();
        byKind.set(kind, ids);
      }
      for (const key of ["_id", "_temp_id"] as const) {
        const rendered = renderedValue(map.get(key));
        if (rendered.length > 0) ids.set(rendered, read.value);
      }
      return read.value;
    };

    for (const story of entityMaps(this.ydoc.getArray<unknown>("stories")).maps) {
      register(CONTRIBUTOR_ENTITY_KINDS.story, story);
      const steps = readYArray(story.get("steps"));
      if (!steps.ok || steps.value === null) continue;
      for (const step of entityMaps(steps.value).maps) {
        register(CONTRIBUTOR_ENTITY_KINDS.step, step);
        const layers = readYArray(step.get("layers"));
        if (!layers.ok || layers.value === null) continue;
        for (const layer of entityMaps(layers.value).maps) {
          register(CONTRIBUTOR_ENTITY_KINDS.layer, layer);
        }
      }
    }
    for (const [root, kind] of [
      ["objects", CONTRIBUTOR_ENTITY_KINDS.object],
      ["glossary", CONTRIBUTOR_ENTITY_KINDS.term],
      ["pages", CONTRIBUTOR_ENTITY_KINDS.page],
    ] as const) {
      for (const map of entityMaps(this.ydoc.getArray<unknown>(root)).maps) {
        register(kind, map);
      }
    }
    return byKind;
  }

  /**
   * Record what every prose field holds right now, before anybody edits one.
   *
   * The word count is a rise measured against a remembered value, so a field
   * this instance has never seen pays nothing (see `WordBaseline`). Without this
   * walk, every field of an existing project would be unseen at load and the
   * first edit to each — a typo fix on somebody else's four hundred words — would
   * establish the baseline instead of crediting the person who actually typed
   * them. The walk costs one pass over a document already in memory.
   *
   * The paths built here must be the ones `resolveFieldPaths` will build later,
   * or the baseline addresses fields nobody will ever look up. That is why the id
   * is read the same way it is there: the D1 `_id` when the row has one, the
   * client `_temp_id` when it does not.
   */
  private seedWordBaseline(): void {
    const idOf = (map: Y.Map<unknown>): string | null => {
      const id = map.get("_id");
      if (id !== null && id !== undefined) return renderedValue(id);
      const temp = map.get("_temp_id");
      if (temp !== null && temp !== undefined) return renderedValue(temp);
      return null;
    };
    const record = (prefix: string, segment: string, map: Y.Map<unknown>): string | null => {
      const id = idOf(map);
      if (id === null) return null;
      const base = `${prefix}${segment}:${id}`;
      for (const field of proseFieldNames(segment)) {
        this.wordBaseline.set(`${base}:${field}`, countWords(yTextToString(map.get(field))));
      }
      return base;
    };

    for (const story of entityMaps(this.ydoc.getArray<unknown>("stories")).maps) {
      const storyBase = record("", "stories", story);
      if (storyBase === null) continue;
      const steps = readYArray(story.get("steps"));
      if (!steps.ok || steps.value === null) continue;
      for (const step of entityMaps(steps.value).maps) {
        const stepBase = record(`${storyBase}:`, "steps", step);
        if (stepBase === null) continue;
        const layers = readYArray(step.get("layers"));
        if (!layers.ok || layers.value === null) continue;
        for (const layer of entityMaps(layers.value).maps) {
          record(`${stepBase}:`, "layers", layer);
        }
      }
    }
    for (const segment of ["objects", "glossary", "pages"] as const) {
      for (const map of entityMaps(this.ydoc.getArray<unknown>(segment)).maps) {
        record("", segment, map);
      }
    }
  }

  /**
   * Answer the whole project's editing and writing seconds: the stored figure
   * plus what this instance is holding.
   *
   * Both reads happen here because a snapshot can land between them. The batch
   * adds the pending seconds to `member_editing_time` and only then subtracts
   * them from the ledger, so a caller that read the table itself and asked the
   * instance for the remainder would count a settling window twice or lose it
   * altogether, depending which side of the batch each read fell. The epoch
   * makes the pair either consistent or visibly not.
   *
   * No `docLoaded` gate and no `ensureDocLoaded`. An instance that has just
   * started has an empty ledger and the stored figure alone is the right
   * answer; an instance mid-reset has `docLoaded === false` and a ledger that
   * may not be empty, and the stored figure plus the ledger is still the right
   * answer. Loading a document to answer a question about seconds would cost
   * the whole state restore for nothing.
   *
   * The route reads. It never settles: seconds are given up where they are
   * written, and a reader that took them would be the one losing the work.
   */
  private async readEditingTime(request: Request): Promise<Response> {
    const markerError = await verifyInternalMarker(
      request,
      this.env.SESSION_SECRET,
      "editing-time",
    );
    if (markerError) return markerError;
    // Before the read, not after: a fresh instance has no project id of its
    // own, and a SELECT bound to null answers nothing at all — which the
    // caller would install over the real rows.
    const bindError = await this.bindProjectIdFromMarker(request);
    if (bindError) return bindError;

    for (let attempt = 0; attempt < EDITING_TIME_READ_ATTEMPTS; attempt++) {
      const epoch = this.settleEpoch;
      let stored: MemberEditingTime[];
      try {
        stored = await this.readStoredEditingTime();
      } catch (err) {
        console.error(`[editing-time] project ${this.projectId}: table unreadable`, err);
        return new Response("editing_time_unavailable", { status: 503 });
      }
      const pending = peekTimeCredits(this.timeLedger);
      if (this.settleEpoch === epoch) {
        return Response.json({ times: mergeEditingTime(stored, pending) });
      }
    }

    // A figure that raced a settle every time is one this instance cannot
    // vouch for, and a wrong clock is worse than an old one: the caller reads
    // the table instead, which is behind by at most the window just written.
    console.error(
      `[editing-time] project ${this.projectId}: a settle landed inside every read`,
    );
    return new Response("editing_time_unavailable", { status: 503 });
  }

  /** The seconds `member_editing_time` holds for this project, per person. */
  private async readStoredEditingTime(): Promise<MemberEditingTime[]> {
    const rows = await this.env.DB
      .prepare(
        "SELECT user_id, editing_seconds, writing_seconds FROM member_editing_time WHERE project_id = ?",
      )
      .bind(this.projectId)
      .all<{ user_id: number; editing_seconds: number; writing_seconds: number }>();
    return (rows.results ?? []).map((row) => ({
      userId: row.user_id,
      editingSeconds: row.editing_seconds,
      writingSeconds: row.writing_seconds,
    }));
  }

  /**
   * Read the stamps that say whether a change continues the last instance's
   * stretch of work.
   *
   * Stamps only. The stored totals stay in D1: what this instance accumulates is
   * a delta, and holding the running total in memory is how a later assignment
   * gets written by mistake — the defect migration 0048 documents at length.
   *
   * Seeded means READ. The flag moves only once the rows have been applied, and
   * a read that fails throws: a repair that reported itself done on a read that
   * never happened would leave the ledger empty with the flag set, and the next
   * change would be credited a whole minute against a null stamp with no second
   * read to correct it. A throw here is a repair failure like any other — the
   * load attempt fails and the next retries, and in a reset the build fails
   * before the replacement write, the reset is abandoned, and the retry reads
   * again. Reseeding is idempotent: a stamp only ever moves forward.
   */
  private async seedEditingTime(): Promise<void> {
    if (this.projectId === null || this.timeSeeded) return;
    const rows = await this.env.DB
      .prepare("SELECT user_id, last_change_at, last_write_at FROM member_editing_time WHERE project_id = ?")
      .bind(this.projectId)
      .all<{ user_id: number; last_change_at: string | null; last_write_at: string | null }>();
    for (const row of rows.results ?? []) {
      seedTimeLedger(this.timeLedger, row.user_id, row.last_change_at, row.last_write_at);
    }
    this.timeSeeded = true;
  }

  /**
   * Add this window's editing and writing seconds to what each person has
   * already accumulated.
   *
   * Added, never assigned, for the reason the contributor UPSERT gives: this
   * instance holds only what it has seen since it started, so an assignment would
   * write one lifetime over a whole term's work.
   *
   * The two stamps travel with the totals because they are what the NEXT
   * instance reads at hydration. Each moves forward only, and each is guarded
   * separately: a window in which somebody edited without typing carries a null
   * write stamp, which must leave the stored one alone rather than clear it.
   */
  private snapshotEditingTime(statements: D1PreparedStatement[]): TimeCredit[] {
    if (this.projectId === null) return [];
    const written: TimeCredit[] = [];
    for (const credit of peekTimeCredits(this.timeLedger)) {
      if (credit.editingSeconds === 0 && credit.writingSeconds === 0 && credit.lastChangeAt === null) {
        continue;
      }
      written.push(credit);
      statements.push(
        this.env.DB
          .prepare(
            "INSERT INTO member_editing_time " +
            "(project_id, user_id, editing_seconds, writing_seconds, last_change_at, last_write_at) " +
            "VALUES (?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT (project_id, user_id) DO UPDATE SET " +
            "editing_seconds = member_editing_time.editing_seconds + excluded.editing_seconds, " +
            "writing_seconds = member_editing_time.writing_seconds + excluded.writing_seconds, " +
            "last_change_at = CASE " +
            "WHEN excluded.last_change_at IS NULL THEN member_editing_time.last_change_at " +
            "WHEN member_editing_time.last_change_at IS NULL THEN excluded.last_change_at " +
            "WHEN excluded.last_change_at > member_editing_time.last_change_at THEN excluded.last_change_at " +
            "ELSE member_editing_time.last_change_at END, " +
            "last_write_at = CASE " +
            "WHEN excluded.last_write_at IS NULL THEN member_editing_time.last_write_at " +
            "WHEN member_editing_time.last_write_at IS NULL THEN excluded.last_write_at " +
            "WHEN excluded.last_write_at > member_editing_time.last_write_at THEN excluded.last_write_at " +
            "ELSE member_editing_time.last_write_at END",
          )
          .bind(
            this.projectId,
            credit.userId,
            credit.editingSeconds,
            credit.writingSeconds,
            credit.lastChangeAt,
            credit.lastWriteAt,
          ),
      );
    }
    return written;
  }

  /**
   * UPSERT one row per (entity, person) who wrote TEXT in it.
   *
   * Prose only, and the deepest row of the path only — `proseFieldOf`'s test,
   * which is also the one the word ledger uses. `edited` on the record means
   * what a person wrote text in, so it and `words` are two readings of one
   * parse and cannot report different people.
   *
   * UNION, never assignment, and the SQL is what enforces it: this instance holds
   * only the contributors it has seen since it started, so an assignment would
   * drop everyone who wrote before the last eviction. That is precisely how
   * `fields_edited` came to overwrite a stored count with one lifetime's tally.
   *
   * `first_edit_at` takes the earlier of the two and `last_edit_at` the later, so
   * two instances snapshotting out of order cannot move either backwards. The
   * COALESCE guards a stored NULL, which should not occur — a stamp is always
   * bound — but which would otherwise make both comparisons NULL and keep the
   * NULL forever.
   */
  private snapshotEntityContributors(statements: D1PreparedStatement[]): WordCredit[] {
    if (this.editsByPath.size === 0 || this.projectId === null) return [];
    const idsByKind = this.entityIdsByKind();
    const written: WordCredit[] = [];

    for (const [segment, kind] of [
      ["stories", CONTRIBUTOR_ENTITY_KINDS.story],
      ["steps", CONTRIBUTOR_ENTITY_KINDS.step],
      ["layers", CONTRIBUTOR_ENTITY_KINDS.layer],
      ["objects", CONTRIBUTOR_ENTITY_KINDS.object],
      ["glossary", CONTRIBUTOR_ENTITY_KINDS.term],
      ["pages", CONTRIBUTOR_ENTITY_KINDS.page],
    ] as const) {
      const contributors = proseContributorsFromPaths(this.editsByPath, segment);
      if (contributors.size === 0) continue;
      const ids = idsByKind.get(kind);
      if (!ids) continue;
      // Words and contributors are keyed alike, so a (row, person) here has an
      // entry in the ledger unless a previous snapshot already settled it. That
      // is the case that binds null: NULL means nobody counted this window and
      // the UPSERT keeps the stored figure, where a zero would assert that the
      // person wrote nothing.
      const wordsForSegment = this.wordsByRow.get(segment);
      const wordsFor = (rowId: string, userId: number): number | null => {
        const words = wordsForSegment?.get(rowId)?.get(userId);
        if (words === undefined) return null;
        written.push({ segment, rowId, userId, words });
        return words;
      };

      for (const [pathId, byUser] of contributors) {
        const entityId = ids.get(pathId);
        if (entityId === undefined) continue;
        for (const [userId, contribution] of byUser) {
          statements.push(
            this.env.DB
              .prepare(
                "INSERT INTO entity_contributors " +
                "(project_id, entity_kind, entity_id, user_id, first_edit_at, last_edit_at, words_written) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?) " +
                "ON CONFLICT (project_id, entity_kind, entity_id, user_id) DO UPDATE SET " +
                // Cleared, not left alone: this row is an observation — the DO
                // saw the edit arrive on an authenticated socket — and it
                // outranks whatever a recovery had inferred from the document.
                // Leaving the old label would keep presenting recorded evidence
                // as a guess.
                "basis = NULL, " +
                "first_edit_at = MIN(" +
                "COALESCE(entity_contributors.first_edit_at, excluded.first_edit_at), " +
                "excluded.first_edit_at), " +
                "last_edit_at = MAX(" +
                "COALESCE(entity_contributors.last_edit_at, excluded.last_edit_at), " +
                "excluded.last_edit_at), " +
                // Added when anything was counted, including a nought. A
                // window in which somebody only changed a zoom level binds NULL
                // and must leave the column alone: NULL means nobody counted —
                // a row from before migration 0051, or one recovered from the
                // document — and writing a zero over it would assert that this
                // person wrote nothing, which is a different claim. A window in
                // which they edited prose and added no words binds 0, and that
                // zero is a measurement: it turns a stored NULL into a counted
                // nought without inventing anything.
                "words_written = CASE WHEN excluded.words_written IS NULL " +
                "THEN entity_contributors.words_written " +
                "ELSE COALESCE(entity_contributors.words_written, 0) + excluded.words_written END",
              )
              .bind(
                this.projectId,
                kind,
                entityId,
                userId,
                contribution.first,
                contribution.last,
                wordsFor(pathId, userId),
              ),
          );
        }
      }
    }
    return written;
  }

  /**
   * Section 9: project_members contribution UPDATEs + activity_log INSERTs +
   * retention prune. Returns the activity keys to commit to `activityEmitted`
   * only AFTER the batch succeeds (the caller owns that deferral).
   */
  private async snapshotContributions(
    statements: D1PreparedStatement[],
    now: string,
  ): Promise<Array<{ actorUserId: number; entityKey: string }>> {
    // 9. Snapshot contribution data to project_members.
    // fields_edited is sourced from userFieldSets.get(userId).size (unique-field
    // Set semantics). The Set is NOT cleared after snapshot — it keeps accumulating
    // within the DO's lifetime (accepted behaviour).
    // Contribution UPDATE statements are added to the same batch for atomicity.
    //
    // Deferred in-memory mutations: activityEmitted and newSessions are
    // updated only AFTER the batch succeeds. Declared here so they remain in
    // scope at the commit point after the try/catch.
    const newlyEmittedKeys: Array<{ actorUserId: number; entityKey: string }> = [];
    if (this.projectId) {
      const allUserIds = new Set<number>([...this.userFieldSets.keys(), ...this.newSessions]);
      // Include all users with field edits or new sessions
      const activeUserIds = [...allUserIds].filter((uid) =>
        (this.userFieldSets.get(uid)?.size ?? 0) > 0 || this.newSessions.has(uid)
      );

      if (activeUserIds.length > 0) {
        // Batch all contribution reads into a single query
        const placeholders = activeUserIds.map(() => "?").join(", ");
        const existingRows = await this.env.DB
          .prepare(
            `SELECT user_id, contributions FROM project_members WHERE project_id = ? AND user_id IN (${placeholders})`,
          )
          .bind(this.projectId, ...activeUserIds)
          .all<{ user_id: number; contributions: string | null }>();

        const existingMap = new Map(
          existingRows.results.map((r) => [r.user_id, r.contributions]),
        );

        for (const userId of activeUserIds) {
          const fieldSet = this.userFieldSets.get(userId);
          const isNewSession = this.newSessions.has(userId);
          const raw = existingMap.get(userId) ?? null;
          const prev = raw ? JSON.parse(raw) : {};
          // `now` is the snapshot's clock and is deliberately NOT used for
          // `last_active`: every member of a project snapshots together, so it
          // stamped them all with one instant and read as though a whole class
          // had been working at the same second. The stamp comes from the
          // handler that saw each edit.
          const updated = buildContributionUpdate(
            prev, fieldSet, isNewSession, this.lastEditAt.get(userId),
          );
          statements.push(
            this.env.DB
              .prepare("UPDATE project_members SET contributions = ? WHERE project_id = ? AND user_id = ?")
              .bind(JSON.stringify(updated), this.projectId, userId),
          );
        }

        // Emit coarse activity rows for editor edits. The build/dedup/prune
        // logic is extracted into buildActivityStatements so the SAME code runs
        // from two callers: here (the snapshot, a backstop) and eagerly from
        // flushActivityRows on the warm webSocketMessage path. The warm path is
        // the PRIMARY emitter — the snapshot usually runs cold after hibernation
        // eviction with an empty userFieldSets, so deferring emission to it lost
        // nearly every editor edit. In-memory activityEmitted dedups across both
        // callers within a DO instance, so there is no double-emit. These rows
        // ride the same atomic batch as the contribution UPDATEs.
        const built = this.buildActivityStatements(now);
        statements.push(...built.inserts);
        newlyEmittedKeys.push(...built.newlyEmittedKeys);
      }
      // userFieldSets Sets are NOT cleared — they keep accumulating.
      // NOTE: newSessions.clear() and activityEmitted updates are deferred;
      // they happen after the batch succeeds (below).
    }
    return newlyEmittedKeys;
  }

  /**
   * Build the activity_log INSERT statements (+ retention prune) for the
   * field-paths accumulated in userFieldSets, deduped against activityEmitted
   * and a per-call seenKeys set. Pure w.r.t. D1: it returns prepared statements
   * and the keys to commit to activityEmitted AFTER the caller's batch succeeds
   * (never mutates activityEmitted membership itself — it only creates the
   * per-user Set so it exists at commit time). Shared by snapshotContributions
   * (backstop) and flushActivityRows (the warm primary emitter).
   *
   * buildActivityRows derives one coarse row per (user, entity) touched. We
   * resolve each row's field-path id to the entity's human slug + title
   * (entity_id / entity_label) and dedup on the RESOLVED slug, so a same-session
   * add (temp-uuid id) and a later edit (numeric id) of one entity collapse to a
   * single feed row. Actor is the server-resolved userId, never client-supplied.
   */
  private buildActivityStatements(
    now: string,
  ): { inserts: D1PreparedStatement[]; newlyEmittedKeys: Array<{ actorUserId: number; entityKey: string }> } {
    const inserts: D1PreparedStatement[] = [];
    const newlyEmittedKeys: Array<{ actorUserId: number; entityKey: string }> = [];
    if (!this.projectId) return { inserts, newlyEmittedKeys };

    const userIds = [...this.userFieldSets.keys()];
    const activityRows = buildActivityRows(userIds, this.userFieldSets, this.projectId);
    const seenKeys = new Set<string>();
    for (const row of activityRows) {
      let emitted = this.activityEmitted.get(row.actorUserId);
      if (!emitted) {
        emitted = new Set<string>();
        this.activityEmitted.set(row.actorUserId, emitted);
      }
      const resolved = resolveActivityEntity(this.ydoc, row.entityType, row.entityId);
      const entityKey = `${row.entityType}:${resolved.entityId ?? row.entityId}`;
      if (emitted.has(entityKey) || seenKeys.has(entityKey)) continue; // already recorded
      seenKeys.add(entityKey);
      newlyEmittedKeys.push({ actorUserId: row.actorUserId, entityKey });
      inserts.push(
        this.env.DB
          .prepare(
            "INSERT INTO activity_log (project_id, actor_user_id, verb, entity_type, entity_id, entity_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(
            this.projectId,
            row.actorUserId,
            row.verb,
            row.entityType,
            resolved.entityId ?? row.entityId,
            resolved.entityLabel,
            now,
          ),
      );
    }

    // Opportunistic prune: editor edits are the high-volume activity producer
    // and write the raw INSERTs above (NOT recordActivity), so the per-project
    // retention cap must be enforced here too. Shares ACTIVITY_RETENTION_CAP as
    // the single source of truth. Rides AFTER the inserts in the same batch (D1
    // batch is sequential+transactional, so the subquery sees the new rows).
    // Only when rows were inserted, to avoid a needless DELETE.
    if (inserts.length > 0) {
      inserts.push(
        this.env.DB
          .prepare(
            `DELETE FROM activity_log
                 WHERE project_id = ?
                   AND id NOT IN (
                     SELECT id FROM activity_log
                     WHERE project_id = ?
                     ORDER BY created_at DESC, id DESC
                     LIMIT ?
                   )`,
          )
          .bind(this.projectId, this.projectId, ACTIVITY_RETENTION_CAP),
      );
    }

    return { inserts, newlyEmittedKeys };
  }

  /**
   * Emit pending editor-edit activity rows NOW, while the DO instance is warm.
   *
   * Called from webSocketMessage the moment an edit applies — the only point at
   * which getUserContext(ws) can attribute the edit and the Y.Doc is guaranteed
   * loaded. This is the PRIMARY activity emitter: deferring emission to the +30s
   * alarm snapshot lost nearly every edit because the DO hibernates between
   * events and the snapshot runs cold with an empty userFieldSets. Writes its
   * own small batch (the activity feed is append-only — it does not need to be
   * atomic with the yjs_state blob). Best-effort: a D1 failure is logged and the
   * keys are NOT committed, so the snapshot backstop can retry them. Never
   * throws — it must not break the realtime message path.
   */
  private async flushActivityRows(): Promise<void> {
    if (!this.projectId || !this.docLoaded) return;
    const now = new Date().toISOString();
    const { inserts, newlyEmittedKeys } = this.buildActivityStatements(now);
    if (inserts.length === 0) return;
    // Commit the dedup keys SYNCHRONOUSLY — before the await below — so that
    // concurrent webSocketMessage handlers (which interleave only at awaits)
    // can't each slip past the dedup check and re-emit the same entity once per
    // keystroke. Deferring the commit to after the await (as the snapshot path
    // safely does, because it runs single-shot) produced a per-keystroke flood
    // under real concurrent typing. On a write failure we roll the keys back so
    // a later edit can re-emit; losing one coarse row on a rare D1 error is
    // acceptable for an append-only feed.
    for (const { actorUserId, entityKey } of newlyEmittedKeys) {
      this.activityEmitted.get(actorUserId)?.add(entityKey);
    }
    try {
      await this.env.DB.batch(inserts);
    } catch (err) {
      for (const { actorUserId, entityKey } of newlyEmittedKeys) {
        this.activityEmitted.get(actorUserId)?.delete(entityKey);
      }
      console.error("[activity] eager flush failed; will retry on next edit", err);
    }
  }

  private async doSnapshot(): Promise<void> {
    // Cleared before the guards, not after them, so the ledger never survives a
    // pass into the answer a later route gives.
    this.snapshotInsertFailures = [];
    this.adoptionMarks = [];
    if (!this.projectId || !this.docLoaded) return;
    if (this.persistenceHalted !== null) return;

    // The early exit, and the tag every write below carries: a storage access
    // from an invocation the platform has replaced throws here, before any
    // statement. It is read fresh rather than from the cache because the cache
    // says what this instance last knew, not what it still owns.
    let generation: number;
    try {
      generation = await this.readGenerationFromStorage();
    } catch (err) {
      throw this.ownExactBaseLine(err);
    }

    // A loaded document holds the revision its load claimed; without one no
    // write can be conditioned, so nothing may be written.
    const held = this.docWrite;
    if (!isSafeCount(held) || !isBaseSeq(this.docSeq)) {
      throw this.ownExactBaseLine(new ExactBaseError(this.projectId, "bad_revision"));
    }
    // Room for both of this snapshot's moves, checked before the standalone
    // INSERTs so a snapshot that cannot complete writes no entity row at all.
    if (held > MAX_WRITE_REVISION - 2) {
      this.closeAllSockets(DOCUMENT_UNAVAILABLE_CLOSE.code, DOCUMENT_UNAVAILABLE_CLOSE.reason);
      throw this.ownExactBaseLine(new ExactBaseError(this.projectId, "revision_exhausted"));
    }

    // --- Corruption guard: deduplicate Y.Arrays before snapshot ---
    // Duplicates reach D1 as a UNIQUE-refused INSERT or a wrong-row UPDATE, so
    // they are settled here first. They are detected by _id (D1 primary key)
    // for existing items and by entity key (story_id, object_id, term_id, slug)
    // for all items; who keeps the key is D1's to say, not the array's.
    // Track whether the Y.Doc was mutated in a way connected clients must adopt —
    // either an INSERT backfilled a canonical _id, or a dedup pass re-keyed a
    // duplicate. Either way we broadcast the updated state at the end; without
    // it a peer's stale value resurrects the problem via Yjs LWW.
    let didBackfill = false;

    // D1's id + human key for each top-level table, read once and used twice:
    // the dedupe keeper below needs to know which row owns a colliding key, and
    // the entity pipelines need the same rows for their orphan set and their
    // adopt-or-reinsert branch. Reading here rather than inside each pipeline
    // keeps the count at one SELECT per table, unchanged.
    const d1Stories = await this.fetchEntityKeys("stories", "story_id");
    const d1Objects = await this.fetchEntityKeys("objects", "object_id");
    const d1Glossary = await this.fetchEntityKeys("glossary_terms", "term_id");
    const d1Pages = await this.fetchEntityKeys("project_pages", "slug");
    const parentCourse = await this.readParentProjectId();

    // Every root resolves a key collision the same way: the exact-`_id`
    // duplicate — one persisted row claimed twice — collapses, and every other
    // same-key loser keeps its content under a fresh key. Both outcomes mutate
    // the document and MUST be broadcast: a peer's stale key resurrects the
    // collision by last-write-wins, and a peer's stale copy of a removed map
    // leaves it editing an entity no later snapshot will read — so each result
    // feeds the broadcast flag.
    if (this.deduplicateYArray("stories", "story_id", d1Stories.keyToId)) {
      didBackfill = true;
    }
    if (this.settleObjectsArray(d1Objects.keyToId)) {
      didBackfill = true;
    }
    if (this.deduplicateYArray("glossary", "term_id", d1Glossary.keyToId, isHeldTermId)) {
      didBackfill = true;
    }
    if (this.deduplicateYArray("pages", "slug", d1Pages.keyToId)) {
      didBackfill = true;
    }
    if (this.deduplicateNestedStepArrays()) {
      didBackfill = true;
    }
    // After the dedupe, so every map that survives it is checked. The flag
    // outlives a failed attempt: the retry finds the markers already gone and
    // would otherwise never tell the peers that still show them.
    this.dropStrandedCourseMarkers(parentCourse);
    // Before any object is read, for an object the arrival fold (see
    // `attachDocHandlers`) has not reached: one with no map, or a blob not yet
    // folded. A blob already folded matches its base and is not folded again.
    if (settleCustomFields(this.ydoc)) didBackfill = true;
    // The dedup passes above are transactions of their own — a re-key and a
    // removal are both changes the log has to carry — so the latch is read here
    // too, before the first entity INSERT and before anything else this pass
    // writes.
    this.refusePastHalt();

    const now = new Date().toISOString();

    const statements: D1PreparedStatement[] = [];

    // NOTE: projects.yjs_state blob write is appended at the end of this method
    // so the encoded state includes any INSERT ID backfills applied by sections
    // 5-8. Otherwise a cold-start restore from the blob would see _id: null
    // items that have already been INSERTed to D1 and would re-INSERT them.

    await this.snapshotConfig(statements, now);

    if (await this.snapshotStories(statements, now, d1Stories)) didBackfill = true;

    if (await this.snapshotObjects(statements, now, d1Objects)) didBackfill = true;

    if (await this.snapshotGlossary(statements, now, d1Glossary)) didBackfill = true;

    if (await this.snapshotPages(statements, now, d1Pages)) didBackfill = true;

    // AFTER 5-8, and that ordering is load-bearing: a contributor is held
    // against whichever id the field path carried, so a row created this window
    // is keyed by its `_temp_id` until one of those INSERTs backfills a real
    // `_id` onto its Y.Map. Run earlier, every entity somebody created and
    // immediately wrote into would find no id and be dropped.
    const wordsWritten = this.snapshotEntityContributors(statements);
    const timeWritten = this.snapshotEditingTime(statements);
    // Captured beside the peeks and before every await below. A settlement
    // subtracts what D1 accepted from the entries the peeks read; an abandonment
    // in the meantime clears those entries and the repairs reseed them, and
    // subtracting an older figure from a reseeded entry would leave it negative.
    const peekedEpoch = this.settleEpoch;

    const newlyEmittedKeys = await this.snapshotContributions(statements, now);

    // Encode the full Y.Doc state as a binary blob AFTER all backfills so the
    // restored state on cold start matches the D1 rows inserted above.
    //
    // Write the blob standalone FIRST so it always reflects the entity INSERTs
    // already committed above (and their backfilled _ids). If the UPDATE/DELETE
    // batch later fails, the blob + INSERTs stay consistent and a cold-start
    // restore won't orphan-delete the new entities.
    //
    // The sequence is read here, beside the encoding and after the backfills,
    // never carried down from the top of the method: the backfills above are
    // transactions, and the pair the row carries has to name the state these
    // bytes hold rather than the state the snapshot started from.
    // Once more before the encoding, for every transaction between the last
    // checked backfill and here: the blob and the batch below are exactly the
    // persistence a document with an unwritten record must not reach.
    this.refusePastHalt();

    const blob = Y.encodeStateAsUpdate(this.ydoc);
    this.warnOnBlobSize(blob.length);
    const encodedSeq = this.docSeq;
    if (!isBaseSeq(encodedSeq)) {
      throw this.ownExactBaseLine(new ExactBaseError(this.projectId, "bad_revision"));
    }
    // Captured beside the encoding, so the record names the sequence these
    // bytes hold rather than the one the pass started from.
    this.snapshotEncodedSeq = encodedSeq;
    await this.writeFencedBase(blob, generation, encodedSeq, held, now);
    // The default stands before the branch: a pass with nothing to run has
    // nothing attempted, and a batch that runs settles its own outcome.
    this.snapshotBatch = { outcome: "not_attempted", reason: "no_statements" };
    if (statements.length > 0) {
      await this.runFencedBatch(statements, held + 1, generation, encodedSeq);
    }

    // Commit deferred in-memory mutations — only reached when the batch
    // succeeded (the catch above rethrows, so any code here is success-only).
    // Mutating these before the batch would permanently mark entities as
    // emitted and clear session counts even when the DB writes failed.
    for (const { actorUserId, entityKey } of newlyEmittedKeys) {
      this.activityEmitted.get(actorUserId)?.add(entityKey);
    }
    this.newSessions.clear();
    this.clearAdoptionMarks();
    // Settled here rather than when the statements were built, and subtracted
    // rather than reset: a refused batch must leave the work still owed, and
    // edits arriving while this one was in flight must survive it.
    if (this.settleEpoch === peekedEpoch) {
      settleWords(this.wordsByRow, wordsWritten);
      settleTimeCredits(this.timeLedger, timeWritten);
    }
    // After the subtraction, and whether or not it ran: the batch landed either
    // way, so a reader that saw the pre-settle ledger and the post-settle table
    // reads a moved epoch and takes both figures again.
    this.settleEpoch++;

    this.broadcastSnapshotChanges(didBackfill);
  }

  /**
   * The adopting columns again, for a map whose adoption a refused batch left
   * marked: the ordinary UPDATE it now takes does not write them.
   */
  private pushMarkedAdoption(cfg: { pushAdopted?: (m: Y.Map<unknown>, id: number) => void }, m: Y.Map<unknown>, id: number): void {
    if (m.get(ADOPTED_MARK) !== true || !cfg.pushAdopted) return;
    cfg.pushAdopted(m, id);
    this.adoptionMarks.push(m);
  }

  /** Drops the marks of the adoptions the landed batch wrote. */
  private clearAdoptionMarks(): void {
    if (this.adoptionMarks.length === 0) return;
    const marked = this.adoptionMarks;
    this.adoptionMarks = [];
    this.ydoc.transact(() => { for (const m of marked) m.delete(ADOPTED_MARK); });
    this.markerBroadcastOwed = true;
  }

  /**
   * Send the peers the document after a snapshot changed it: an id backfilled
   * into a new row, a duplicate re-keyed, or a stranded course marker dropped,
   * this pass or a failed one before it.
   */
  private broadcastSnapshotChanges(didBackfill: boolean): void {
    // Broadcast ID-backfill updates to all connected clients.
    // The DO's in-memory Y.Doc received ydoc.transact() mutations during INSERT
    // to write the canonical D1 IDs back to each Y.Map, but the sync relay only
    // forwards client-originated messages. Without an explicit broadcast here,
    // peers would keep their local _id: null sentinels until their next full
    // sync (page refresh). Re-encoding the full state is safe — Yjs peers
    // idempotently merge updates they already have.
    if (!didBackfill && !this.markerBroadcastOwed) return;
    const updateEncoder = encoding.createEncoder();
    encoding.writeVarUint(updateEncoder, messageSync);
    syncProtocol.writeSyncStep2(updateEncoder, this.ydoc);
    const updateMsg = encoding.toUint8Array(updateEncoder);
    for (const client of this.ctx.getWebSockets()) {
      try {
        client.send(updateMsg);
      } catch {
        // Client may have disconnected; ignore
      }
    }
    this.markerBroadcastOwed = false;
  }

  // -------------------------------------------------------------------------
  // The alarm's record
  // -------------------------------------------------------------------------

  /**
   * The line an invocation emits before any phase, so that one which never
   * completes is still discoverable.
   *
   * Workers Logs carries a custom line and the invocation event as separate
   * rows sharing a request id: an event with an entry line and no exit line is
   * a gate reset or a failure, whatever a later retry left behind. An
   * invocation that failed before this line — on the controls read itself — is
   * discoverable by its event alone, which is why the protocol enumerates
   * events rather than lines.
   */
  private emitAlarmEntry(draft: AlarmDraft): void {
    if (!draft.recording) return;
    console.log(
      "[diagnostic][alarm-entry]",
      JSON.stringify({
        recordId: draft.recordId,
        objectId: this.ctx.id.toString(),
        retryCount: draft.retryCount,
        isRetry: draft.isRetry,
      }),
    );
  }

  /** The line that joins a finished record to its invocation event. */
  private emitAlarmExit(record: AlarmRecord): void {
    console.log(
      "[diagnostic][alarm]",
      JSON.stringify({
        recordId: record.recordId,
        objectId: this.ctx.id.toString(),
        kind: record.kind,
        generation: record.generation,
        branch: record.retirement === null ? "none" : record.retirement.branch,
        outcomes: {
          maintenance: record.maintenance === null ? null : record.maintenance.rejected,
          retirement: record.retirement === null ? null : record.retirement.outcome,
          blob: record.snapshot === null ? null : record.snapshot.blob.outcome,
          batch: record.snapshot === null ? null : record.snapshot.batch.outcome,
          finaliser: record.scheduling.finaliser,
        },
      }),
    );
  }

  /** The tail this instance is carrying above its exact base, or null. */
  private debtOf(): { records: number; bytes: number } | null {
    const base = this.baseSeq;
    const seq = this.docSeq;
    if (!this.docLoaded || !isBaseSeq(base) || !isBaseSeq(seq)) return null;
    return { records: seq - base, bytes: this.logBytesSinceBase };
  }

  /**
   * What the maintenance slice is about to sweep, taken before it sweeps.
   *
   * The populations are exactly the sweeper's own: one old generation's log
   * prefix, its base header and colon-terminated part prefix, its halt key, and
   * the current generation's orphan parts — which exist only while no value at
   * all stands at the current header, so `headerPresent` says why a zero is a
   * zero.
   */
  private async captureMaintenanceEntry(
    draft: AlarmDraft | null,
    current: number,
    floor: number,
  ): Promise<void> {
    if (draft === null) return;
    const old = floor < current ? floor : null;
    const entry: PhaseEntry = {
      generation: old, floor: null, eligible: null, debt: this.debtOf(),
    };
    if (draft.recording) {
      entry.eligible = await this.underPhase(
        "diagnostic",
        () => this.maintenanceEligible(old, current),
      );
    }
    draft.maintenanceEntry = entry;
  }

  private async maintenanceEligible(old: number | null, current: number): Promise<unknown> {
    const log = old === null ? emptyCount() : await this.countRange(logPrefix(old), {});
    const base = old === null ? emptyCount() : await this.countBaseNamespace(old);
    const halt = old === null ? emptyCount() : await this.countExactKey(haltKey(old));
    const headerPresent = (await this.diagnosticGet(baseKey(current))) !== undefined;
    const orphans = headerPresent
      ? emptyCount()
      : await this.countRange(`${baseKey(current)}:`, {});
    return { log, base, halt, orphans, headerPresent };
  }

  /** A generation's base header and its parts, as one population. */
  private async countBaseNamespace(generation: number): Promise<Count> {
    const count = await this.countRange(`${baseKey(generation)}:`, {});
    const header = await this.countExactKey(baseKey(generation));
    count.keys += header.keys;
    count.records += header.records;
    return count;
  }

  /** One key, counted when it stands. A prefix cannot name an exact key. */
  private async countExactKey(key: string): Promise<Count> {
    const count = emptyCount();
    if ((await this.diagnosticGet(key)) !== undefined) countKeyInto(count, key);
    return count;
  }

  /** What the retirement is about to spend its budget on, before it spends it. */
  private async captureRetirementEntry(
    draft: AlarmDraft | null,
    branch: "cleanup" | "compaction",
    generation: number,
    floor: number | null,
  ): Promise<void> {
    if (draft === null) return;
    draft.retirementBranch = branch;
    const entry: PhaseEntry = {
      generation, floor, eligible: null, debt: this.debtOf(),
    };
    if (draft.recording && isBaseSeq(floor)) {
      entry.eligible = await this.underPhase(
        "diagnostic",
        () => this.countLogBelow(generation, floor),
      );
    }
    draft.retirementEntry = entry;
  }

  /** What the snapshot half is about to fold, on both sides of its own bound. */
  private async captureSnapshotEntry(draft: AlarmDraft): Promise<PhaseEntry> {
    const base = this.baseSeq;
    const generation = this.docGeneration;
    const entry: PhaseEntry = {
      generation, floor: base, eligible: null, debt: this.debtOf(),
    };
    if (!draft.recording || generation === null || !isBaseSeq(base)) return entry;
    entry.eligible = await this.underPhase("diagnostic", async () => ({
      below: await this.countLogBelow(generation, base),
      above: await this.countLogAbove(generation, base),
    }));
    return entry;
  }

  /**
   * The record, the scheduling and the ring, inside the gate and never
   * throwing.
   *
   * The scheduling runs inside the gate so that what it armed is observed in
   * the invocation that armed it; `scheduleAfterAlarm` holds no gate of its
   * own, so nesting is not at issue. A throw from it becomes the invocation's
   * failure and is rethrown outside the gate exactly as any other is.
   */
  private async finaliseAlarm(draft: AlarmDraft, run: AlarmRun): Promise<void> {
    draft.scheduling.finaliser = await this.runAlarmScheduler(draft, run);
    draft.scheduling.scheduleSnapshotCalls = this.scheduleSnapshotCalls;
    if (draft.recording) await this.settleScheduling(draft);
    const record = this.assembleAlarmRecord(draft, run);
    this.lastAlarm = record;
    this.alarmRing.push(record);
    if (this.alarmRing.length > DIAG_RING) this.alarmRing.shift();
    if (!draft.recording) return;
    await this.persistRing();
    this.emitAlarmExit(record);
  }

  /** Arm the next alarm, unless this invocation has nothing to arm one for. */
  private async runAlarmScheduler(
    draft: AlarmDraft,
    run: AlarmRun,
  ): Promise<SchedulingRecord["finaliser"]> {
    if (draft.kind !== "ran" || run.failure !== undefined) return "skipped";
    try {
      return await this.scheduleAfterAlarm(run.slice, run.turn, run.generation);
    } catch (err) {
      this.failAlarm(draft, run, err);
      return "skipped";
    }
  }

  /**
   * Wait, under a bound, on the scheduling attempts this invocation made, then
   * read what stands pending.
   *
   * Only while recording is on: production pays neither the wait nor the
   * `getAlarm`. The bound is what keeps a wedged attempt from holding the gate
   * open, and what could not settle inside it is reported rather than waited
   * for.
   */
  private async settleScheduling(draft: AlarmDraft): Promise<void> {
    const outstanding = new Set(this.scheduleSnapshotChains);
    const tracked = this.scheduleSnapshotChains.map(
      (chain) => chain.then(() => { outstanding.delete(chain); }),
    );
    await Promise.race([
      Promise.all(tracked),
      new Promise((resolve) => setTimeout(resolve, DIAG_SETTLE_MS)),
    ]);
    draft.scheduling.unsettledScheduling = outstanding.size;
    // Named before the read, so that a recording invocation always carries the
    // three settlement fields and an unread alarm is a `true` rather than a
    // field that is not there.
    draft.scheduling.pendingAlarmUnread = false;
    draft.scheduling.pendingAlarmAt = await this.readPendingAlarm(draft);
  }

  private async readPendingAlarm(draft: AlarmDraft): Promise<number | null> {
    try {
      return await this.storage().getAlarm();
    } catch {
      draft.scheduling.pendingAlarmUnread = true;
      return null;
    }
  }

  /** Write the ring, and say so once per load when storage refuses it. */
  private async persistRing(): Promise<void> {
    try {
      await this.storage().put(DIAG_ALARMS_KEY, this.alarmRing);
    } catch (err) {
      if (this.ringPutStated) return;
      this.ringPutStated = true;
      console.error(
        `[diagnostic] project ${this.projectId}: the alarm ring was not written`,
        err,
      );
    }
  }

  private assembleAlarmRecord(draft: AlarmDraft, run: AlarmRun): AlarmRecord {
    return {
      recordId: draft.recordId,
      startedAt: draft.startedAt,
      endedAt: Date.now(),
      generation: draft.generation,
      firstAlarmInInstance: draft.firstAlarmInInstance,
      retryCount: draft.retryCount,
      isRetry: draft.isRetry,
      sockets: draft.sockets,
      recording: draft.recording,
      kind: draft.kind,
      failure: draft.failure,
      preflight: draft.preflight,
      maintenance: draft.maintenanceEntry === null ? null : {
        entry: draft.maintenanceEntry,
        floor: run.slice.floor,
        pending: run.slice.pending,
        rejected: run.slice.rejected,
        lists: run.slice.lists,
        deleted: run.slice.deleted,
      },
      retirement: this.retirementOf(draft, run),
      snapshot: draft.snapshot,
      scheduling: draft.scheduling,
      diagnosticLists: this.diagnosticLists,
    };
  }

  private retirementOf(draft: AlarmDraft, run: AlarmRun): AlarmRecord["retirement"] {
    if (draft.kind === "halted" || draft.kind === "held") return null;
    const spent = run.turn.record ?? retirementRecordOf(null, null);
    return { branch: draft.retirementBranch, entry: draft.retirementEntry, ...spent };
  }

  // -------------------------------------------------------------------------
  // The diagnostic read
  // -------------------------------------------------------------------------

  /**
   * The operator's route for this request, or null when it names none.
   *
   * The three share a shape — a path, a method, and a handler that verifies its
   * own marker — so `fetch` asks once rather than testing each in turn. A path
   * this object owns reached with the wrong method answers with the dispatch's
   * own fallthrough rather than with another route's refusal.
   */
  private operatorRoute(request: Request, url: URL): (() => Promise<Response>) | null {
    const path = url.pathname;
    if (path.endsWith("/persistence-state")) {
      return request.method === "GET" ? () => this.answerPersistenceState(request) : null;
    }
    if (!path.endsWith("/diagnostic")) return null;
    // What this object knows about the project's persistence, read without
    // loading, binding, repairing or writing anything; and the two
    // staging-only controls the staging exercises set, refused outside staging
    // by the object itself so that no caller carries a rule of its own.
    if (request.method === "GET") return () => this.answerDiagnostic(request, url);
    return request.method === "POST" ? () => this.answerDiagnosticControl(request, url) : null;
  }

  /**
   * GET /diagnostic — what this object knows, without loading, binding,
   * repairing or writing anything.
   *
   * Identity is request-local. The project id in the verified marker is
   * compared with what memory holds and with what storage holds, and a
   * disagreement is refused; nothing here assigns `this.projectId` and nothing
   * calls `bindIdentity`, so an operator's read can never leave an object bound
   * to a project it was not serving.
   *
   * The row is read first and OUTSIDE the gate, and reported with a reading of
   * its own: it can move between its read and the gated collection, so the two
   * are stated apart and `coherent: false` says so.
   */
  private async answerDiagnostic(request: Request, url: URL): Promise<Response> {
    const markerError = await verifyInternalMarker(
      request,
      this.env.SESSION_SECRET,
      "diagnostic",
    );
    if (markerError) return markerError;
    const claimed = Number(request.headers.get("X-Internal-Project"));
    if (!Number.isSafeInteger(claimed) || claimed <= 0) {
      return new Response("identity_malformed", { status: 400 });
    }
    const options = this.readDiagnosticOptions(url);
    if (options instanceof Response) return options;
    const row = await this.readDiagnosticRow(claimed);
    let answer!: Response;
    // The callback always resolves: an exception escaping it discards the
    // Durable Object, which a read must never be able to do.
    await this.ctx.blockConcurrencyWhile(async () => {
      answer = await this.collectDiagnostic(claimed, options, row);
    });
    return answer;
  }

  /**
   * The read's options, once the environment has admitted them.
   *
   * `validate` and `count` list values and are staging's alone; the reverse
   * scan's page budget is wider there for the same reason. The refusal is
   * decided here, before any validation or counting read is issued.
   */
  private readDiagnosticOptions(url: URL): DiagnosticOptions | Response {
    const staging = this.environment === "staging";
    const validate = url.searchParams.get("validate") === "1";
    const raw = url.searchParams.get("count");
    if (!staging && (validate || raw !== null)) {
      return new Response("diagnostic_controls_unavailable", { status: 403 });
    }
    const count = raw === null ? null : parseCanonicalGeneration(raw);
    if (raw !== null && (count === null || count > MAX_SEQ)) {
      return new Response("bad_count", { status: 400 });
    }
    return {
      validate,
      count,
      reversePages: staging ? DIAG_REVERSE_PAGES_STAGING : DIAG_REVERSE_PAGES,
    };
  }

  /**
   * The row's metadata alone, bound to the request-local id and allocating no
   * blob: `length(yjs_state)` is the size, never the bytes.
   */
  private async readDiagnosticRow(projectId: number): Promise<Record<string, unknown>> {
    const readAt = Date.now();
    try {
      const row = await this.env.DB
        .prepare(
          "SELECT yjs_generation, yjs_seq, yjs_write, length(yjs_state) AS blob_bytes " +
          "FROM projects WHERE id = ?",
        )
        .bind(projectId)
        .first<Record<string, unknown>>();
      if (!row) return { ok: false, error: "row_missing" };
      return {
        ok: true,
        generation: row.yjs_generation ?? null,
        seq: row.yjs_seq ?? null,
        revision: row.yjs_write ?? null,
        blobBytes: row.blob_bytes ?? null,
        readAt,
      };
    } catch {
      // The rest of the answer stands: a transport failure on the row is a fact
      // about D1 and says nothing about what this object holds.
      return { ok: false, error: "row_unread" };
    }
  }

  /** The gated half, with the phase tag set and every failure carried out. */
  private async collectDiagnostic(
    projectId: number,
    options: DiagnosticOptions,
    row: Record<string, unknown>,
  ): Promise<Response> {
    const enclosing = this.phase;
    this.phase = "diagnostic";
    try {
      return await this.buildDiagnosticAnswer(projectId, options, row);
    } catch (err) {
      return diagnosticRefusal(err);
    } finally {
      this.phase = enclosing;
    }
  }

  private async buildDiagnosticAnswer(
    projectId: number,
    options: DiagnosticOptions,
    row: Record<string, unknown>,
  ): Promise<Response> {
    const controls = await this.controls();
    const identity = await this.diagnosticIdentity(projectId);
    if (identity instanceof Response) return identity;
    const generation = await this.diagnosticGeneration();
    return Response.json({
      object: {
        id: this.ctx.id.toString(),
        nonce: this.nonce,
        build: this.build,
        environment: this.environment,
        collectedAt: Date.now(),
        coherent: false,
      },
      identity,
      document: this.diagnosticDocument(),
      halt: await this.diagnosticHalt(generation),
      generation,
      clients: this.diagnosticClients(),
      base: await this.diagnosticBase(generation, options),
      log: await this.diagnosticLog(generation, options),
      row,
      alarms: await this.diagnosticAlarms(controls),
      counts: await this.diagnosticCounts(generation, options.count),
      controls,
    }, { headers: { "Cache-Control": "no-store" } });
  }

  /**
   * The three ids, compared and never assigned.
   *
   * Absence on either side is agreement: a socketless instance holds none in
   * memory and an unbound one holds none in storage, and a read must work
   * against exactly that object. A stored value that stands and is not this
   * project's id is a disagreement whatever it is — another project's id, or a
   * value outside the domain at all — and is reported as it was read, because a
   * binding storage holds and the object cannot use is the fact the operator
   * came for.
   */
  private async diagnosticIdentity(projectId: number): Promise<unknown> {
    const stored = await this.diagnosticGet(PROJECT_ID_KEY);
    const identity = {
      projectId,
      memory: this.projectId,
      stored: observedProjectId(stored),
    };
    const agrees =
      (identity.memory === null || identity.memory === projectId) &&
      (stored === undefined || stored === projectId);
    if (agrees) return identity;
    return Response.json({ error: "identity_mismatch", identity }, { status: 409 });
  }

  private async diagnosticGeneration(): Promise<number> {
    if (this.docLoaded && this.docGeneration !== null) return this.docGeneration;
    return await this.readGenerationFromStorage(this.uncachedStorage());
  }

  private diagnosticDocument(): unknown {
    return {
      loaded: this.docLoaded,
      generation: this.docLoaded ? this.docGeneration : null,
      seq: this.docLoaded ? this.docSeq : null,
    };
  }

  /** The resident halt and the durable marker, stated apart. */
  private async diagnosticHalt(generation: number): Promise<unknown> {
    const halted = this.persistenceHalted;
    const resident = halted === null ? null : {
      generation: halted.generation,
      reason: halted.marker.reason,
      at: halted.marker.at,
    };
    const durable = await this.readDurableHalt(generation);
    return { resident, durable, effective: resident !== null || durable !== null };
  }

  private async readDurableHalt(generation: number): Promise<unknown> {
    try {
      const marker = await readHalt(this.uncachedStorage(), generation);
      return marker === null ? null : { reason: marker.reason, at: marker.at };
    } catch (err) {
      // A damaged marker carries no time of its own, and none is invented.
      if (err instanceof LogCorruptionError) return { reason: "bad_halt" };
      throw err;
    }
  }

  /**
   * The attached population, deserialised in memory: the same work
   * `/active-ws-count` does, bounded by the platform's socket limit.
   */
  private diagnosticClients(): unknown {
    const list = this.ctx.getWebSockets().map((ws) => {
      const attachment = readAttachment(ws);
      if (attachment === null) return { malformed: true };
      return {
        userId: attachment.userId,
        role: attachment.role,
        generation: attachment.generation,
        awarenessClientId: attachment.awarenessClientId ?? null,
      };
    });
    return { count: list.length, list };
  }

  private async diagnosticBase(
    generation: number,
    options: DiagnosticOptions,
  ): Promise<unknown> {
    let header;
    try {
      header = await readBaseHeader(this.uncachedStorage(), generation);
    } catch (err) {
      // The codec's own rejection class. A storage rejection is the caller's to
      // hear about and answers 503.
      if (!(err instanceof LogCorruptionError)) throw err;
      return { header: { error: "malformed" } };
    }
    if (header === null) return null;
    return {
      header: {
        generation: header.generation,
        seq: header.seq,
        parts: header.parts,
        length: header.length,
        checksum: header.checksum,
      },
      validated: options.validate ? await this.validateBase(generation) : false,
    };
  }

  /**
   * Read the base back through the codec, in the same request the header was
   * read in — so a header that stood a moment ago and a base that is gone now
   * is `base_vanished` rather than an absent base.
   */
  private async validateBase(generation: number): Promise<unknown> {
    try {
      const base = await readBase(this.uncachedStorage(), generation);
      return base === null ? { error: "base_vanished" } : true;
    } catch (err) {
      if (err instanceof LogCorruptionError) return { error: err.reason };
      throw err;
    }
  }

  /**
   * The log's physical and logical populations, stated apart: the retirement
   * spends its budget on keys, and the codec's own reads find headers.
   */
  private async diagnosticLog(
    generation: number,
    options: DiagnosticOptions,
  ): Promise<unknown> {
    const storage = this.uncachedStorage();
    const prefix = logPrefix(generation);
    const first = [...(await storage.list<unknown>({ prefix, limit: 1 })).keys()];
    const last = [...(await storage.list<unknown>({
      prefix, reverse: true, limit: 1,
    })).keys()];
    const page = [...(await storage.list<unknown>({ prefix, limit: DIAG_PAGE })).keys()];
    const firstPage = emptyCount();
    for (const key of page) countKeyInto(firstPage, key);
    const lowest = firstHeaderSeqIn(page);
    const highest = await this.boundedHighest(storage, generation, options.reversePages);
    return {
      keys: { first: first[0] ?? null, last: last[0] ?? null },
      firstPage: {
        keys: firstPage.keys,
        records: firstPage.records,
        parts: firstPage.parts,
        malformed: firstPage.malformed,
      },
      records: {
        lowest,
        lowestUnknown: lowest === null && page.length === DIAG_PAGE,
        highest: highest.highest,
        highestUnknown: highest.highestUnknown,
      },
      accounting: this.diagnosticAccounting(),
    };
  }

  /**
   * The highest record header, inside a page budget.
   *
   * Three ends, and only one of them is unknown. A header inside the budget is
   * FOUND. A page shorter than the width — the final permitted page included —
   * proves the prefix is exhausted, so absence is established and the answer is
   * a known `null`. Only a full final permitted page holding no header leaves
   * the question open, and there is no lookahead past the budget to close it.
   */
  private async boundedHighest(
    storage: LogStorage,
    generation: number,
    pages: number,
  ): Promise<{ highest: number | null; highestUnknown: boolean }> {
    const prefix = logPrefix(generation);
    let end: string | undefined;
    for (let page = 0; page < pages; page++) {
      const keys = [...(await storage.list<unknown>({
        prefix, reverse: true, limit: DIAG_PAGE, end,
      })).keys()];
      const seq = firstHeaderSeqIn(keys);
      if (seq !== null) return { highest: seq, highestUnknown: false };
      if (keys.length < DIAG_PAGE) return { highest: null, highestUnknown: false };
      end = keys[keys.length - 1];
    }
    return { highest: null, highestUnknown: true };
  }

  private diagnosticAccounting(): unknown {
    if (!this.docLoaded) return null;
    return {
      baseSeq: this.baseSeq,
      records: this.logBytes.length,
      bytes: this.logBytesSinceBase,
    };
  }

  /**
   * The records this instance holds, newest first, or the ring a previous
   * instance left at `diag:alarms` when recording is on and this one has none.
   */
  private async diagnosticAlarms(controls: Controls): Promise<unknown> {
    if (this.alarmRing.length > 0) {
      const recent = [...this.alarmRing].reverse();
      return { last: this.lastAlarm, recent };
    }
    if (!controls.recording) return { last: null, recent: [] };
    const stored = await this.diagnosticGet<AlarmRecord[]>(DIAG_ALARMS_KEY);
    if (!Array.isArray(stored) || stored.length === 0) return { last: null, recent: [] };
    const recent = [...stored].reverse().slice(0, DIAG_RING);
    return { last: recent[0], recent };
  }

  /**
   * The two populations either side of the retirement's own lexical bound.
   *
   * `below` is exactly what `retireLogBelow(g, seq)` would delete and `above`
   * what it would leave, so a reader can hold a phase's requirement against the
   * same split the sweeper uses.
   */
  private async diagnosticCounts(
    generation: number,
    seq: number | null,
  ): Promise<unknown> {
    if (seq === null) return undefined;
    // ONE budget for the request, spent below first and above with what is
    // left: `pages` is the request's own figure, and a side the budget did not
    // reach reports zero counts under `capped` rather than a second traversal's
    // worth of listings.
    const budget = countBudget();
    const below = await this.countLogBelow(generation, seq, budget);
    const above = await this.countLogAbove(generation, seq, budget);
    return { seq, below, above, pages: DIAG_COUNT_PAGES - budget.pages };
  }

  private async countLogBelow(
    generation: number,
    seq: number,
    budget: CountBudget = countBudget(),
  ): Promise<Count> {
    return await this.countRange(logPrefix(generation), {
      // At `MAX_SEQ` there is no successor inside the codec's domain, and the
      // domain is not widened for one listing: the prefix alone bounds it.
      end: seq < MAX_SEQ ? logKey(generation, seq + 1) : undefined,
    }, budget);
  }

  private async countLogAbove(
    generation: number,
    seq: number,
    budget: CountBudget = countBudget(),
  ): Promise<Count> {
    if (seq >= MAX_SEQ) return emptyCount();
    return await this.countRange(logPrefix(generation), {
      start: logKey(generation, seq + 1),
    }, budget);
  }

  /**
   * Classify a bounded range, a page at a time, retaining none of it.
   *
   * Each page is discarded once counted, so what this holds at once is one
   * page of keys; a budget that runs out with the range still open reports
   * `capped`, which makes every figure a lower bound rather than a claim. The
   * budget is the caller's, so ranges counted for one request share it.
   */
  private async countRange(
    prefix: string,
    bounds: { start?: string; end?: string },
    budget: CountBudget = countBudget(),
  ): Promise<Count> {
    const count = emptyCount();
    const storage = this.uncachedStorage();
    let startAfter: string | undefined;
    while (budget.pages > 0) {
      budget.pages -= 1;
      this.diagnosticLists += 1;
      const keys = [...(await storage.list<unknown>({
        prefix,
        start: startAfter === undefined ? bounds.start : undefined,
        startAfter,
        end: bounds.end,
        limit: DIAG_COUNT_PAGE,
      })).keys()];
      for (const key of keys) countKeyInto(count, key);
      if (keys.length < DIAG_COUNT_PAGE) return count;
      startAfter = keys[keys.length - 1];
    }
    count.capped = true;
    return count;
  }

  private async diagnosticGet<T = unknown>(key: string): Promise<T | undefined> {
    return await this.uncachedStorage().get<T>(key);
  }

  // -------------------------------------------------------------------------
  // The diagnostic's controls
  // -------------------------------------------------------------------------

  /**
   * POST /diagnostic — set one of the two staging-only flags.
   *
   * The control string is bound into the signature as `/reset` binds its
   * preconditions, so a marker minted to stop recording cannot be replayed to
   * release a hold. Refused outside staging whatever storage holds.
   */
  private async answerDiagnosticControl(request: Request, url: URL): Promise<Response> {
    const control = readControlRequest(url);
    if (control === null) return new Response("bad_control", { status: 400 });
    const markerError = await verifyInternalMarker(
      request,
      this.env.SESSION_SECRET,
      "diagnostic-control",
      control.text,
    );
    if (markerError) return markerError;
    if (this.environment !== "staging") {
      return new Response("diagnostic_controls_unavailable", { status: 403 });
    }
    try {
      await this.controls();
    } catch {
      return new Response("storage_unavailable", { status: 503 });
    }
    if (control.intent === "hold" && control.on) return await this.takeHold(control);
    return await this.writeControl(control);
  }

  /**
   * Take the hold over an object with no snapshot in flight.
   *
   * The drain is the bounded pre-gate one `runForcedSnapshot` uses: inside the
   * gate a running snapshot's own D1 responses are blocked, so the flag could
   * never be observed clearing there. The recheck inside the gate is what makes
   * the acknowledgement mean something — the flag is not set at all when a
   * snapshot is still in flight, and the caller retries.
   */
  private async takeHold(control: ControlRequest): Promise<Response> {
    for (let i = 0; this.isSnapshotting && i < SNAPSHOT_DRAIN_MAX_POLLS; i++) {
      await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_DRAIN_POLL_MS));
    }
    let answer!: Response;
    await this.ctx.blockConcurrencyWhile(async () => {
      answer = this.isSnapshotting
        ? new Response("snapshot_in_flight", { status: 409 })
        : await this.writeControl(control);
    });
    return answer;
  }

  /** Write one flag, publish it only once the put has resolved, and settle. */
  private async writeControl(control: ControlRequest): Promise<Response> {
    try {
      await this.storage().put(control.key, control.on);
    } catch (err) {
      console.error(
        `[diagnostic] project ${this.projectId}: the control ${control.text} was not written`,
        err,
      );
      return new Response("storage_unavailable", { status: 503 });
    }
    const flags = { ...(this.controlsCache ?? { recording: false, held: false }) };
    if (control.intent === "hold") flags.held = control.on;
    else flags.recording = control.on;
    this.controlsCache = flags;
    try {
      await this.afterControl(control);
    } catch (err) {
      console.error(
        `[diagnostic] project ${this.projectId}: the control ${control.text} was not settled`,
        err,
      );
      return new Response("storage_unavailable", { status: 503 });
    }
    return Response.json(flags);
  }

  /**
   * What each release owes: stopping the recording forgets the ring, so a later
   * window measures no ring put of its own; clearing the hold arms an alarm, so
   * the work the hold suppressed runs at once.
   */
  private async afterControl(control: ControlRequest): Promise<void> {
    if (control.intent === "record" && !control.on) {
      this.alarmRing = [];
      this.lastAlarm = null;
      await this.storage().delete([DIAG_ALARMS_KEY]);
    }
    if (control.intent === "hold" && !control.on) {
      await this.storage().setAlarm(Date.now());
    }
  }

  // -------------------------------------------------------------------------
  // Session token validation
  // -------------------------------------------------------------------------

  /**
   * Validate the session token from the WebSocket query string.
   *
   * Thin wrapper around the shared `getUserIdFromToken` helper in
   * `workers/auth.ts`; kept as a method so existing call sites remain
   * unchanged. The shared helper accepts the SESSION_SECRET as an argument
   * so the module is decoupled from `this.env`.
   */
  private async getUserIdFromToken(token: string): Promise<number | null> {
    return getUserIdFromTokenShared(token, this.env.SESSION_SECRET);
  }
}
