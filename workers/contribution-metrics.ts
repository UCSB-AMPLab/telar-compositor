/**
 * The two measures the contribution record adds: how many words each person
 * wrote, and how long they spent working.
 *
 * Both are derived from the same thing — a change arriving on an authenticated
 * socket, with a field path, a person and a stamp — and neither can be recovered
 * afterwards. A stored document holds the text but not who added which word; a
 * rehydrated one holds neither. So this module is only ever fed live, by the
 * Durable Object's after-transaction handler, and everything here is pure so
 * that the accounting can be tested without one.
 *
 * Nothing here writes to D1. The ledgers accumulate in memory and are drained
 * into statements by the snapshot; see `workers/collaboration.ts` and migration
 * `0051_contribution_words_and_time.sql`.
 *
 * @version v1.5.0-beta
 */

import { countWords } from "~/lib/contributions";

/**
 * How long one change keeps the clock running.
 *
 * The user-facing statement of this rule is "the clock starts on a change and
 * stops after a minute, unless a new change is detected", so the constant and
 * the sentence have to stay in step: changing it here changes what the copy in
 * the contribution record claims.
 */
export const EDITING_WINDOW_MS = 60_000;

/**
 * The fields that hold prose, by the collection segment that owns them.
 *
 * Two things read this. Writing time counts only the stretches spent typing into
 * one of these, which is what separates it from editing time — framing an image,
 * reordering a list and setting a flag are changes to the site and are not
 * writing. And words are counted only here, because a word count over a zoom
 * level or an order key is not a count of anything.
 *
 * Stories are included even though the record shows no Stories row: typing a
 * story title is writing, and the words are recorded against the story whether
 * or not any view totals them. Leaving them out would have made the writing
 * clock stop while someone retitled their story.
 */
const PROSE_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  stories: new Set(["title", "subtitle", "byline"]),
  steps: new Set(["question", "answer", "alt_text"]),
  layers: new Set(["title", "button_label", "content"]),
  objects: new Set([
    "title", "creator", "description", "alt_text", "period", "object_type",
    "subjects", "source", "credit", "dimensions",
  ]),
  glossary: new Set(["title", "definition"]),
  pages: new Set(["title", "body"]),
};

/**
 * The prose fields of one collection, for a caller walking the document rather
 * than reacting to a change — the hydration seed, which has to visit each field
 * by name because nothing has told it which ones exist.
 */
export function proseFieldNames(segment: string): readonly string[] {
  const fields = PROSE_FIELDS[segment];
  return fields ? [...fields] : [];
}

/**
 * A client `_temp_id`: the UUID-shaped id the editor mints for a row D1 has not
 * numbered yet. Shape only — the version and variant nibbles are not read, so
 * any UUID-shaped segment is accepted.
 */
const TEMP_ID_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a path segment is the id of a row awaiting its D1 number. */
export function isTempRowId(segment: string): boolean {
  return TEMP_ID_UUID.test(segment);
}

/**
 * Whether a path segment is an id a row can be keyed by — a D1 row id or a
 * client `_temp_id`. Anything else is a segment the field-path resolver could
 * not render an id for, which collapsed the path and left a field name where
 * the id should be.
 *
 * One validator for both derivations. Words and contributor rows are read out
 * of the same paths, and an id one accepts and the other refuses leaves words
 * owed to a row no contributor row is ever written for.
 */
export function isRowIdSegment(segment: string): boolean {
  if (isTempRowId(segment)) return true;
  const n = Number(segment);
  return segment.length > 0 && Number.isInteger(n) && n > 0;
}

/** Which row a prose edit belongs to. */
export interface ProseField {
  /** The collection segment owning the field: "steps", "layers", "objects"… */
  segment: string;
  /** The row's id as it stands in the path — a D1 `_id` or a client `_temp_id`. */
  rowId: string;
  field: string;
}

/**
 * Read a field path as a prose field, or null if it is not one.
 *
 * The owning row is the DEEPEST one in the path, and only that one. A field path
 * names its whole ancestry — `stories:7:steps:11:layers:91:content` — and taking
 * any ancestor as the owner would report the same 200 words against the panel,
 * its step and its story, three counts of one piece of writing.
 *
 * This is also the test behind `edited` on the contribution record, through
 * `proseContributorsFromPaths`. The two measures are one parse on purpose: a
 * person shown as having edited a row is the person whose words are counted
 * against it, and a row somebody added and never typed in has neither.
 */
export function proseFieldOf(path: string): ProseField | null {
  const parts = path.split(":");
  if (parts.length < 3) return null;
  const segment = parts[parts.length - 3];
  const rowId = parts[parts.length - 2];
  const field = parts[parts.length - 1];
  if (!PROSE_FIELDS[segment]?.has(field)) return null;
  if (!isRowIdSegment(rowId)) return null;
  return { segment, rowId, field };
}


/**
 * What one person has accrued in this Durable Object instance and not yet had
 * written to D1.
 *
 * Milliseconds rather than seconds, because the snapshot writes whole seconds and
 * a value rounded at every snapshot would drift: thirty seconds of work split
 * across ten snapshots can lose five of them to rounding. The remainder stays
 * here and is carried into the next window.
 */
export interface TimeAccrual {
  pendingEditingMs: number;
  pendingWritingMs: number;
  lastChangeAt: string | null;
  lastWriteAt: string | null;
}

export type TimeLedger = Map<number, TimeAccrual>;

function accrualFor(ledger: TimeLedger, userId: number): TimeAccrual {
  let held = ledger.get(userId);
  if (!held) {
    held = { pendingEditingMs: 0, pendingWritingMs: 0, lastChangeAt: null, lastWriteAt: null };
    ledger.set(userId, held);
  }
  return held;
}

/**
 * Seed one person's stamps from what D1 already holds.
 *
 * Called once, at hydration, before any change is credited. Without it an
 * instance that has just started treats the next change as the beginning of a
 * new stretch of work and credits a full minute for it, so a pause long enough
 * to evict the Durable Object — ten seconds of quiet — would be recorded as a
 * minute of work every time the person came back.
 *
 * Seeds stamps only. The stored totals stay in D1 and are never read into
 * memory: what is accumulated here is a delta, and holding the running total
 * would invite an assignment somewhere down the line.
 */
export function seedTimeLedger(
  ledger: TimeLedger,
  userId: number,
  lastChangeAt: string | null,
  lastWriteAt: string | null,
): void {
  const accrual = accrualFor(ledger, userId);
  if (lastChangeAt && (accrual.lastChangeAt === null || lastChangeAt > accrual.lastChangeAt)) {
    accrual.lastChangeAt = lastChangeAt;
  }
  if (lastWriteAt && (accrual.lastWriteAt === null || lastWriteAt > accrual.lastWriteAt)) {
    accrual.lastWriteAt = lastWriteAt;
  }
}

/** How much a change at `stamp` adds, given when the previous one was. */
function creditFor(previous: string | null, stamp: string): number {
  if (previous === null) return EDITING_WINDOW_MS;
  const gap = Date.parse(stamp) - Date.parse(previous);
  if (!Number.isFinite(gap)) return 0;
  // Not forward: two instances can stamp out of order, and a stamp older than
  // the one already held describes a stretch of work that has been paid for.
  if (gap <= 0) return 0;
  return Math.min(gap, EDITING_WINDOW_MS);
}

/**
 * Credit one change to one person.
 *
 * The clock runs for a minute from every change, and the total is the measure of
 * the union of those windows — which is what makes this incremental: a change
 * adds the gap since the previous one, capped at the window, and the first change
 * of a stretch adds the whole window. A single isolated change therefore records
 * a minute, and a run of changes a minute apart records its whole span.
 *
 * `isWriting` splits the same stream in two rather than counting a second one.
 * Writing time uses its own previous stamp, so a person who types, spends five
 * minutes framing an image, then types again has one continuous stretch of
 * editing time and two separate minutes of writing time inside it.
 */
export function creditChange(
  ledger: TimeLedger,
  userId: number,
  stamp: string,
  isWriting: boolean,
): void {
  const accrual = accrualFor(ledger, userId);

  accrual.pendingEditingMs += creditFor(accrual.lastChangeAt, stamp);
  if (accrual.lastChangeAt === null || stamp > accrual.lastChangeAt) {
    accrual.lastChangeAt = stamp;
  }

  if (!isWriting) return;
  accrual.pendingWritingMs += creditFor(accrual.lastWriteAt, stamp);
  if (accrual.lastWriteAt === null || stamp > accrual.lastWriteAt) {
    accrual.lastWriteAt = stamp;
  }
}

/** One person's row of the time table, as a snapshot would write it. */
export interface TimeCredit {
  userId: number;
  editingSeconds: number;
  writingSeconds: number;
  lastChangeAt: string | null;
  lastWriteAt: string | null;
}

/**
 * The whole seconds owed to each person, without taking them.
 *
 * Read and settle are separate because a snapshot can fail. Taking the seconds
 * while building the statements would lose them for good whenever the batch was
 * refused — the work happened, and the only record of it is this ledger. So the
 * caller reads here, writes, and calls `settleTimeCredits` only once D1 has
 * accepted the batch; a failed snapshot leaves everything owed and the next one
 * pays it.
 *
 * A person whose only pending time is a fraction of a second still appears, with
 * zero seconds and their stamps, because the stamps are what the next instance
 * needs in order not to credit a fresh minute.
 */
export function peekTimeCredits(ledger: TimeLedger): TimeCredit[] {
  const credits: TimeCredit[] = [];
  for (const [userId, accrual] of ledger) {
    credits.push({
      userId,
      editingSeconds: Math.floor(accrual.pendingEditingMs / 1000),
      writingSeconds: Math.floor(accrual.pendingWritingMs / 1000),
      lastChangeAt: accrual.lastChangeAt,
      lastWriteAt: accrual.lastWriteAt,
    });
  }
  return credits;
}

/**
 * Subtract what D1 has accepted, leaving the sub-second remainder and anything
 * credited since.
 *
 * Subtraction rather than a reset, because edits keep arriving while a snapshot
 * is in flight: clearing the ledger would throw away the seconds accrued between
 * the statements being built and the batch returning.
 */
export function settleTimeCredits(ledger: TimeLedger, credits: readonly TimeCredit[]): void {
  for (const credit of credits) {
    const accrual = ledger.get(credit.userId);
    if (!accrual) continue;
    accrual.pendingEditingMs -= credit.editingSeconds * 1000;
    accrual.pendingWritingMs -= credit.writingSeconds * 1000;
  }
}

/**
 * One person's editing and writing seconds as a reader should see them: what
 * D1 holds and what has been booked against it but not yet written.
 *
 * The stamps are absent on purpose. They are the ledger's own bookkeeping —
 * what the next instance needs in order not to credit a fresh minute — and a
 * reader asking how long somebody has worked has no use for them.
 */
export interface MemberEditingTime {
  userId: number;
  editingSeconds: number;
  writingSeconds: number;
}

/**
 * The stored seconds and the unsettled ones, as one figure per person.
 *
 * A person the ledger knows and D1 does not is included: their first stretch
 * of work has not reached the table yet, and leaving them out would show a
 * clock at nothing while they were typing.
 */
export function mergeEditingTime(
  stored: readonly MemberEditingTime[],
  pending: readonly TimeCredit[],
): MemberEditingTime[] {
  const merged = new Map<number, MemberEditingTime>();
  for (const row of stored) {
    merged.set(row.userId, { ...row });
  }
  for (const credit of pending) {
    const held = merged.get(credit.userId);
    if (held) {
      held.editingSeconds += credit.editingSeconds;
      held.writingSeconds += credit.writingSeconds;
      continue;
    }
    merged.set(credit.userId, {
      userId: credit.userId,
      editingSeconds: credit.editingSeconds,
      writingSeconds: credit.writingSeconds,
    });
  }
  return [...merged.values()];
}

/**
 * Words added, per row, per person: `segment -> rowId -> userId -> words`.
 *
 * Shaped like the statements it becomes — one UPSERT per (entity, person), the
 * same row `entity_contributors` already holds — so the snapshot has nothing to
 * regroup.
 */
export type WordsByRow = Map<string, Map<string, Map<number, number>>>;

/**
 * What each prose field held when this instance last saw it.
 *
 * The baseline is the whole difficulty of counting words honestly. A transaction
 * carries the field's new text and says nothing about its old, so the rise has to
 * be measured against something remembered. Seeded from the document at hydration
 * and moved forward on every edit.
 *
 * A field this instance has never seen credits nobody: the edit establishes the
 * baseline and pays out from the next one. Reading an absent baseline as zero
 * would cost far more than the word it saves, because a field path is not stable
 * for the life of a row. A step created in the editor carries a client
 * `_temp_id` until the next snapshot puts it in D1, and every path under it is
 * rewritten to the real id the moment that happens — so each new row would meet
 * an absent baseline a second time, and the words already credited under the
 * temporary path would all be credited again under the permanent one.
 */
export type WordBaseline = Map<string, number>;

/**
 * Credit the rise in one field's word count to whoever caused it.
 *
 * Never below zero, so deleting is not negative writing. A person who cuts a
 * paragraph has not unwritten it, and letting the number fall would mean an
 * editor tightening somebody else's prose reduced their own count. The cost is
 * that rewriting your own paragraph counts twice, which is stated where the
 * number is shown.
 *
 * Returns the words credited, so a caller can tell a real rise from a no-op.
 */
export function creditWords(
  words: WordsByRow,
  baseline: WordBaseline,
  path: string,
  userId: number,
  text: string,
): number {
  const prose = proseFieldOf(path);
  if (!prose) return 0;

  const after = countWords(text);
  const before = baseline.get(path);
  baseline.set(path, after);
  // First sight of this field: establish the baseline and credit nothing. See
  // WordBaseline for why an absent baseline must not be read as zero. A field
  // the editor creates is created empty, so it is established at nought by its
  // own creation and nothing a person types is lost.
  const added = before === undefined ? 0 : Math.max(0, after - before);

  // An entry is made even for nothing added, and that is the point of doing it
  // here rather than only when the count rises. Somebody who fixes a typo or
  // cuts a sentence HAS been counted, and their nought is a measurement; a
  // person who only reframed an image has not been counted at all. The record
  // shows the first as a zero and the second as an em dash, and this is where
  // the two are told apart.
  let rows = words.get(prose.segment);
  if (!rows) {
    rows = new Map<string, Map<number, number>>();
    words.set(prose.segment, rows);
  }
  let byUser = rows.get(prose.rowId);
  if (!byUser) {
    byUser = new Map<number, number>();
    rows.set(prose.rowId, byUser);
  }
  byUser.set(userId, (byUser.get(userId) ?? 0) + added);
  return added;
}

/** Words written into D1 for one (row, person), pending settlement. */
export interface WordCredit {
  segment: string;
  rowId: string;
  userId: number;
  words: number;
}

/**
 * Subtract the words D1 has accepted from the ledger.
 *
 * Same reasoning as `settleTimeCredits`, and the same hazard it avoids: a person
 * who kept typing while the snapshot was in flight would lose those words to a
 * reset, and a snapshot that failed would lose all of them.
 */
export function settleWords(words: WordsByRow, credits: readonly WordCredit[]): void {
  for (const credit of credits) {
    const byUser = words.get(credit.segment)?.get(credit.rowId);
    if (!byUser) continue;
    const held = byUser.get(credit.userId);
    if (held === undefined) continue;
    const left = held - credit.words;
    // A settled nought leaves nothing owed, so the entry goes: it has done its
    // work of turning a stored NULL into a counted zero.
    if (left > 0) byUser.set(credit.userId, left);
    else byUser.delete(credit.userId);
  }
}
