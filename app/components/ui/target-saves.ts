/**
 * target-saves — the one record of what each edited target holds and what
 * is wanted for it, shared by every in-place field that edits the target.
 * Fields never reason about another field's saves from their own state;
 * they ask this record.
 *
 * Per target key:
 *   - `confirmed`: the last value a save stored, once one has.
 *   - `desired`: the latest value any field wants stored, with a revision
 *     number. It stays set while its save is in flight, and is cleared when
 *     that revision is stored or fails with nothing newer behind it.
 *   - `inflight`: the value being saved now, with its revision.
 *
 * `commit(key, value, save)` asks for `value` to be stored. A value equal
 * to the current `desired` joins that request rather than making a new
 * revision. One worker per key runs at most one save at a time and always
 * saves the current `desired`, so revisions made while a save is in flight
 * collapse into the latest. On success it sets `confirmed` and tells the
 * key's subscribers, which is how open fields learn the new baseline.
 *
 * `nextStamp()` orders every authoritative value a field can learn, from
 * this module or from its loader, on one counter: each stored value carries
 * the stamp of the moment it was confirmed, and a field stamps each loader
 * value as it receives it. The newer stamp wins.
 *
 * A key's record is removed once nothing is desired, in flight, awaited or
 * subscribed, and nothing outlives it: not `confirmed`, and not a
 * per-instance fallback key, which goes with its instance. A value kept
 * past the record would go stale as soon as someone else changes the
 * target, and a field would then close on text that is no longer stored.
 * Once the record is gone, a field's baseline is its loader's value, and
 * the loader revalidates after a save.
 *
 * A draft whose save failed after its field had gone is not a value the
 * target holds, and is kept apart from the record: `recordRecovered` keeps
 * it, with its error, until the author retries it, discards it or saves over
 * it from the field that shows it. It is kept under the field's
 * `recoveryKey` (project and target, as a string) when there is one, in
 * memory and in sessionStorage, so it survives a reload of the tab but not a
 * new tab; without one, in memory by target key. A browser that refuses
 * sessionStorage keeps it in memory only. Each draft has an identity, and
 * clearing names the one to clear. When storage refuses a removal, the
 * cleared ids are remembered for the page, so a stored copy is not offered
 * again. Storage that refuses reads, writes and removals at once can still
 * offer an older draft once it recovers; the author can discard it, and
 * nothing is written without the author choosing it. `watchPending` and
 * `watchRecovered` tell a field when a save for its key starts or settles
 * and when its kept draft changes.
 *
 * A field whose saves can answer out of order (a layer's content, which
 * keeps sending while earlier sends are still out) numbers them with
 * `nextSequence` and records a failure with its number
 * (`recordSequencedFailure`). The numbers and the
 * highest that succeeded (`sequenceSucceeded`) are kept per recovery key
 * with the draft, across a reload of the tab: a failure is kept only when it
 * is newer than the draft kept already and than every send that succeeded,
 * and a success clears only drafts at or below its own number, so an older
 * answer arriving late never replaces or clears a newer one. Callers that
 * record without a number keep the identity-based clearing above.
 *
 * @version v1.5.0-beta
 */

export type SaveFn = (value: string) => Promise<unknown> | unknown;

interface Revision {
  value: string;
  revision: number;
  save: SaveFn;
}

interface Waiter {
  revision: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface TargetRecord {
  confirmed?: string;
  confirmedAt?: number;
  desired: Revision | null;
  inflight: Revision | null;
  waiters: Waiter[];
  subscribers: Set<(confirmed: string, stamp: number) => void>;
  /** Told whenever whether a save is wanted or in flight for the key may have changed. */
  pendingWatchers: Set<(pending: boolean) => void>;
  revisions: number;
}

const records = new Map<unknown, TargetRecord>();
let stamps = 0;

/** The next stamp on the one counter that orders loader and saved values. */
export function nextStamp(): number {
  stamps += 1;
  return stamps;
}

function recordFor(key: unknown): TargetRecord {
  let record = records.get(key);
  if (!record) {
    record = {
      desired: null,
      inflight: null,
      waiters: [],
      subscribers: new Set(),
      pendingWatchers: new Set(),
      revisions: 0,
    };
    records.set(key, record);
  }
  return record;
}

function forgetIfIdle(key: unknown, record: TargetRecord) {
  const idle =
    !record.desired &&
    !record.inflight &&
    record.waiters.length === 0 &&
    record.subscribers.size === 0 &&
    record.pendingWatchers.size === 0;
  if (idle && records.get(key) === record) records.delete(key);
}

/** What the record says about a key, for a field deciding what to do. */
export interface TargetState {
  confirmed?: string;
  desired?: string;
  inflight?: string;
}

export function targetState(key: unknown): TargetState {
  const record = records.get(key);
  if (!record) return {};
  return { confirmed: record.confirmed, desired: record.desired?.value, inflight: record.inflight?.value };
}

/**
 * Asks for `value` to be stored for `key`.
 *
 * The promise resolves once a save of this revision or of any later
 * revision of the key has stored something: a later revision supersedes
 * this one, so the caller must compare `confirmed` with its value to know
 * whether its own text is what was stored. It rejects when the save that
 * carries this revision fails and no later revision has superseded it.
 */
export function commit(key: unknown, value: string, save: SaveFn): Promise<void> {
  const record = recordFor(key);
  let revision: number;
  if (record.desired && record.desired.value === value) {
    revision = record.desired.revision;
  } else {
    revision = ++record.revisions;
    record.desired = { value, revision, save };
  }
  const settled = new Promise<void>((resolve, reject) => {
    record.waiters.push({ revision, resolve, reject });
  });
  saveLatest(key, record);
  tellPending(record);
  return settled;
}

function tellPending(record: TargetRecord) {
  const pending = !!record.desired || !!record.inflight;
  record.pendingWatchers.forEach((watcher) => watcher(pending));
}

function saveLatest(key: unknown, record: TargetRecord) {
  if (record.inflight || !record.desired) return;
  const saving = record.desired;
  record.inflight = saving;
  Promise.resolve()
    .then(() => saving.save(saving.value))
    .then(
      () => {
        record.inflight = null;
        record.confirmed = saving.value;
        const stamp = nextStamp();
        record.confirmedAt = stamp;
        if (record.desired?.revision === saving.revision) record.desired = null;
        settle(record, saving.revision, (waiter) => waiter.resolve());
        record.subscribers.forEach((subscriber) => subscriber(saving.value, stamp));
      },
      (error: unknown) => {
        record.inflight = null;
        const superseded = !!record.desired && record.desired.revision > saving.revision;
        if (!superseded) {
          record.desired = null;
          settle(record, saving.revision, (waiter) => waiter.reject(error));
        }
      },
    )
    .finally(() => {
      saveLatest(key, record);
      tellPending(record);
      forgetIfIdle(key, record);
    });
}

/** Settles, with `how`, every waiter at or before `revision`. */
function settle(record: TargetRecord, revision: number, how: (waiter: Waiter) => void) {
  const due = record.waiters.filter((waiter) => waiter.revision <= revision);
  record.waiters = record.waiters.filter((waiter) => waiter.revision > revision);
  due.forEach(how);
}

/** Calls `subscriber` with each value stored for `key` and its stamp; returns the unsubscribe. */
export function subscribe(key: unknown, subscriber: (confirmed: string, stamp: number) => void): () => void {
  const record = recordFor(key);
  record.subscribers.add(subscriber);
  return () => {
    record.subscribers.delete(subscriber);
    forgetIfIdle(key, record);
  };
}

/**
 * Calls `watcher` with whether a save is wanted or in flight for `key`, now
 * and whenever that may have changed; returns the unsubscribe.
 */
export function watchPending(key: unknown, watcher: (pending: boolean) => void): () => void {
  const record = recordFor(key);
  record.pendingWatchers.add(watcher);
  watcher(!!record.desired || !!record.inflight);
  return () => {
    record.pendingWatchers.delete(watcher);
    forgetIfIdle(key, record);
  };
}

/** Whether a save is wanted or in flight for `key`. */
export function isPending(key: unknown): boolean {
  const record = records.get(key);
  return !!record && (!!record.desired || !!record.inflight);
}

/** Whether the record for `key` is still held. */
export function isTracked(key: unknown): boolean {
  return records.has(key);
}

/**
 * A draft whose save failed after its field had gone, the error that failed
 * it, and its identity: a field that showed one draft clears only that one,
 * never a later failure recorded in its place. The identity is random, not
 * a stamp or a time: a draft read back after a reload must not share an
 * identity with one recorded after it, and the stamp counter starts again
 * with the page while the clock can repeat.
 */
export interface RecoveredDraft {
  draft: string;
  error: string;
  id: string;
  /** The number of the send that failed, for a field that numbers its sends. */
  sequence?: number;
}

/**
 * Where a draft is held in memory: by its recovery key when there is one,
 * since two projects can have targets that compare equal, and by target
 * key otherwise.
 */
class Slots<T> {
  private byRecoveryKey = new Map<string, T>();
  private byTarget = new Map<unknown, T>();
  get(key: unknown, recoveryKey: string | undefined): T | undefined {
    return recoveryKey === undefined ? this.byTarget.get(key) : this.byRecoveryKey.get(recoveryKey);
  }
  set(key: unknown, recoveryKey: string | undefined, value: T): void {
    if (recoveryKey === undefined) this.byTarget.set(key, value);
    else this.byRecoveryKey.set(recoveryKey, value);
  }
  delete(key: unknown, recoveryKey: string | undefined): void {
    if (recoveryKey === undefined) this.byTarget.delete(key);
    else this.byRecoveryKey.delete(recoveryKey);
  }
  clear(): void {
    this.byRecoveryKey.clear();
    this.byTarget.clear();
  }
}

const recovered = new Slots<RecoveredDraft>();
// The identities of drafts cleared or replaced whose stored copy could not
// be removed, by recovery key, so that reading storage does not bring one back.
const tombstones = new Map<string, Set<string>>();
const watchers = new Slots<Set<() => void>>();
const STORAGE_PREFIX = "telar:recovered-draft:";

/** Reading `window.sessionStorage` itself can throw; every caller catches. */
function storage(): Storage | null {
  return typeof window === "undefined" ? null : window.sessionStorage;
}

/** An identity no other draft shares, before or after a reload. */
function newIdentity(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The stored draft under `recoveryKey`, if one can be read whole. */
function readStored(recoveryKey: string): RecoveredDraft | null {
  try {
    const raw = storage()?.getItem(STORAGE_PREFIX + recoveryKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RecoveredDraft>;
    if (typeof parsed.draft !== "string" || typeof parsed.error !== "string" || typeof parsed.id !== "string") {
      return null;
    }
    const kept: RecoveredDraft = { draft: parsed.draft, error: parsed.error, id: parsed.id };
    if (typeof parsed.sequence === "number") kept.sequence = parsed.sequence;
    return kept;
  } catch {
    return null;
  }
}

/**
 * Removes the stored copy under `recoveryKey`. When removal fails, whatever
 * that copy holds is tombstoned, with `alsoId`, so it is not read back.
 */
function dropStored(recoveryKey: string, alsoId?: string) {
  const stored = readStored(recoveryKey);
  try {
    storage()?.removeItem(STORAGE_PREFIX + recoveryKey);
  } catch {
    let ids = tombstones.get(recoveryKey);
    if (!ids) {
      ids = new Set();
      tombstones.set(recoveryKey, ids);
    }
    if (stored) ids.add(stored.id);
    if (alsoId) ids.add(alsoId);
  }
}

function tellRecovered(key: unknown, recoveryKey: string | undefined) {
  watchers.get(key, recoveryKey)?.forEach((watcher) => watcher());
}

/**
 * Keeps `draft` and its error for `key`, and under `recoveryKey` for the
 * tab's session, in place of any draft kept there; returns what it kept.
 */
export function recordRecovered(key: unknown, recoveryKey: string | undefined, draft: string, error: string): RecoveredDraft {
  return keepDraft(key, recoveryKey, { draft, error, id: newIdentity() });
}

/**
 * Keeps the draft of the send numbered `sequence` as `recordRecovered` does,
 * but only when that send is newer than the draft kept already and than the
 * last send that succeeded; otherwise nothing changes and it returns null.
 */
export function recordSequencedFailure(
  key: unknown,
  recoveryKey: string,
  draft: string,
  error: string,
  sequence: number,
): RecoveredDraft | null {
  if (sequence <= sequencingOf(recoveryKey).succeeded) return null;
  const current = recoveredFor(key, recoveryKey);
  if (current && (current.sequence ?? 0) > sequence) return null;
  return keepDraft(key, recoveryKey, { draft, error, id: newIdentity(), sequence });
}

/** Holds `kept` for `key`, in memory and in the tab's session, and tells the key's watchers. */
function keepDraft(key: unknown, recoveryKey: string | undefined, kept: RecoveredDraft): RecoveredDraft {
  recovered.set(key, recoveryKey, kept);
  if (recoveryKey !== undefined) {
    try {
      storage()?.setItem(STORAGE_PREFIX + recoveryKey, JSON.stringify(kept));
    } catch {
      // Storage full or refused: the draft is kept in memory, and the older
      // copy it replaces must not come back from storage.
      dropStored(recoveryKey);
    }
  }
  tellRecovered(key, recoveryKey);
  return kept;
}

/** The draft kept for `key`, from memory or else from the tab's session. */
export function recoveredFor(key: unknown, recoveryKey: string | undefined): RecoveredDraft | null {
  const held = recovered.get(key, recoveryKey);
  if (held) return held;
  if (recoveryKey === undefined) return null;
  const found = readStored(recoveryKey);
  if (!found || tombstones.get(recoveryKey)?.has(found.id)) return null;
  recovered.set(key, recoveryKey, found);
  return found;
}

/**
 * Forgets the draft kept for `key` if it is still the one identified by
 * `id`, in memory and in the tab's session. A later draft recorded in its
 * place is kept.
 */
export function clearRecovered(key: unknown, recoveryKey: string | undefined, id: string): void {
  const current = recoveredFor(key, recoveryKey);
  if (!current || current.id !== id) return;
  recovered.delete(key, recoveryKey);
  if (recoveryKey !== undefined) dropStored(recoveryKey, id);
  tellRecovered(key, recoveryKey);
}

/**
 * Forgets the draft kept for `key` if its send's number is at or below
 * `sequence`; a draft recorded without a number counts as the oldest.
 */
export function clearRecoveredThrough(key: unknown, recoveryKey: string | undefined, sequence: number): void {
  const current = recoveredFor(key, recoveryKey);
  if (!current || (current.sequence ?? 0) > sequence) return;
  clearRecovered(key, recoveryKey, current.id);
}

/** The numbering of one recovery key's sends: the last number given, and the highest that succeeded. */
interface Sequencing {
  last: number;
  succeeded: number;
}

const sequencings = new Map<string, Sequencing>();
const SEQUENCE_PREFIX = "telar:recovered-sequence:";

function sequencingOf(recoveryKey: string): Sequencing {
  const held = sequencings.get(recoveryKey);
  if (held) return held;
  let found: Sequencing = { last: 0, succeeded: 0 };
  try {
    const raw = storage()?.getItem(SEQUENCE_PREFIX + recoveryKey);
    const parsed = raw ? (JSON.parse(raw) as Partial<Sequencing>) : null;
    if (parsed && typeof parsed.last === "number" && typeof parsed.succeeded === "number") {
      found = { last: parsed.last, succeeded: parsed.succeeded };
    }
  } catch {
    // Unreadable storage: numbering starts from what the kept draft says.
  }
  sequencings.set(recoveryKey, found);
  return found;
}

function storeSequencing(recoveryKey: string, sequencing: Sequencing) {
  sequencings.set(recoveryKey, sequencing);
  try {
    storage()?.setItem(SEQUENCE_PREFIX + recoveryKey, JSON.stringify(sequencing));
  } catch {
    // Kept in memory for the page; a reload numbers above the kept draft.
  }
}

/**
 * The number of the next send under `recoveryKey`: above every number given
 * before, in this page or before a reload, and above the kept draft's.
 */
export function nextSequence(recoveryKey: string): number {
  const current = sequencingOf(recoveryKey);
  const kept = recoveredFor(recoveryKey, recoveryKey)?.sequence ?? 0;
  const next = Math.max(current.last, current.succeeded, kept) + 1;
  storeSequencing(recoveryKey, { ...current, last: next });
  return next;
}

/**
 * The send numbered `sequence` under `recoveryKey` succeeded: a failure at
 * or below it is no longer kept, and one recorded later below it is ignored.
 */
export function sequenceSucceeded(key: unknown, recoveryKey: string, sequence: number): void {
  const current = sequencingOf(recoveryKey);
  if (sequence > current.succeeded) storeSequencing(recoveryKey, { ...current, succeeded: sequence });
  clearRecoveredThrough(key, recoveryKey, sequence);
}

/** Calls `watcher` whenever the draft kept for `key` is recorded or cleared; returns the unsubscribe. */
export function watchRecovered(key: unknown, recoveryKey: string | undefined, watcher: () => void): () => void {
  let set = watchers.get(key, recoveryKey);
  if (!set) {
    set = new Set();
    watchers.set(key, recoveryKey, set);
  }
  set.add(watcher);
  return () => {
    const held = watchers.get(key, recoveryKey);
    if (!held) return;
    held.delete(watcher);
    if (held.size === 0) watchers.delete(key, recoveryKey);
  };
}

/**
 * Forgets every record, every recovered draft held in memory, every
 * tombstone and every send numbering; what is in sessionStorage is the test's to clear. A test whose
 * saves never settle leaves its records behind; a suite that mounts fields
 * on the same keys in turn calls this between cases.
 */
export function resetTargetSaves(): void {
  records.clear();
  recovered.clear();
  tombstones.clear();
  sequencings.clear();
}

/** How many target keys anything is held for; for tests that check none is kept. */
export function trackedTargetCount(): number {
  return records.size;
}
