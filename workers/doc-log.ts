/**
 * The codec for the generation-scoped update log the Durable Object keeps in
 * its own storage: keys, headers, parts, checksums, and the reads that put a
 * record back together.
 *
 * Pure functions and the error classes the document's durable state is refused
 * with. Nothing here imports the Durable Object
 * class, and nothing here touches storage except through `LogStorage`, the
 * narrow interface declared below — a real `DurableObjectStorage` satisfies it,
 * and so does a Map-backed fake, which is what lets the same codec be tested
 * outside workerd and inside it.
 *
 * Three constraints shape the whole module.
 *
 * Everything is synchronous up to the write. An `await` between applying an
 * update and issuing its write would let a later message become durable and
 * visible first, so the checksum is a table-driven CRC-32 rather than
 * `crypto.subtle.digest`, and `writeGroup` issues its batches without awaiting
 * between them.
 *
 * Every stored part is a copy. V8 serialises a typed-array view together with
 * its whole backing buffer, so a 96 KiB view into a 300 KiB buffer serialises
 * to 300 KiB and breaks the backend's 128 KiB per-value limit. `PART_LIMIT` is
 * 96 KiB of payload, which keeps a serialised part below 100 KiB, and every
 * part is `slice`d rather than `subarray`d.
 *
 * Memory is bounded by the record ceiling, never by the log's length.
 * `MAX_RECORD_BYTES` is 16 MiB, refused before any buffer is allocated:
 * encoding holds the caller's input plus the copied parts, 32 MiB at the
 * ceiling; replay holds one listed page (64 values of at most one part each,
 * 6 MiB), one fetched parts batch (128 parts, 12 MiB) and one assembled record
 * (16 MiB), 34 MiB. Against the isolate's 128 MB both leave room for the Y.Doc
 * and the runtime's own storage cache.
 *
 * Two limits follow from the ceiling and are the caller's to enforce. An
 * inbound WebSocket message may reach the platform cap of 32 MiB, so a message
 * larger than the ceiling cannot be logged and has to be refused before it is
 * applied. And a document whose encoded state exceeds the ceiling cannot be
 * compacted into a storage base, which the compaction path reports loudly.
 *
 * Domains are checked, never assumed. A generation is a canonical non-negative
 * safe integer in plain decimal; a sequence is 0…999999999999999 written as 15
 * zero-padded digits, so lexicographic order equals numeric order and every
 * value stays a safe integer; a part is 1…9999 in 4 zero-padded digits. An
 * encoder handed anything outside those throws a `RangeError` before it writes
 * or allocates. Damage found in storage is the other kind of failure and gets
 * the other error: `LogCorruptionError`, carrying the key and a reason word,
 * never the bytes. Corruption of an accepted record halts the document; this
 * module only reports it.
 *
 * @version v1.5.0-beta
 */

/** Payload bytes per part. A serialised part stays below 100 KiB. */
export const PART_LIMIT = 96 * 1024;

/** The largest record this codec will encode, read, or believe a header about. */
export const MAX_RECORD_BYTES = 16 * 1024 * 1024;

/** The highest sequence a 15-digit key can carry, and a safe integer. */
export const MAX_SEQ = 999_999_999_999_999;

/** The highest part number a 4-digit key can carry. */
export const MAX_PARTS = 9999;

// The backend caps a multi-put, a multi-get and a multi-delete at 128 keys
// each, so every batched call here uses the same width.
const BATCH_LIMIT = 128;

// Replay lists 64 keys at a time: every value under the log prefix is at most
// one part, so a page is at most 64 × PART_LIMIT of memory.
const REPLAY_PAGE = 64;

// A reverse listing pages downward, and the answer is usually in the first
// page, so it asks for few keys at a time.
const REVERSE_PAGE = 16;

const SEQ_DIGITS = 15;
const PART_DIGITS = 4;

/**
 * The storage surface this module uses, typed as `DurableObjectStorage` types
 * it: `end` is an exclusive upper bound, `startAfter` an exclusive lower one,
 * and `get` of a key list answers with a Map holding only the keys present.
 */
export interface LogListOptions {
  prefix?: string;
  start?: string;
  startAfter?: string;
  end?: string;
  limit?: number;
  reverse?: boolean;
}

export interface LogStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  list<T = unknown>(options?: LogListOptions): Promise<Map<string, T>>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(keys: string[]): Promise<number>;
}

/** Options both listing functions take. */
export interface ListOptions {
  /**
   * Keys per listed page. `replayLog` treats this as a request, not a
   * mandate: it validates a positive integer and caps it at the page bound
   * stated in the module header, so a caller cannot widen the page past the
   * memory budget by asking for more.
   */
  pageSize?: number;
  /** Called with every key under the prefix that this codec cannot parse. */
  onSkipped?: (key: string) => void;
}

/** Options the encoders take. `partLimit` exists for tests; production omits it. */
export interface EncodeOptions {
  partLimit?: number;
}

export interface ParsedKey {
  kind: "log" | "base" | "halt";
  generation: number;
  seq?: number;
  part?: number;
}

/** The header a parted record carries at its own key. */
export interface RecordHeader {
  v: 1;
  parts: number;
  length: number;
  checksum: number;
}

/** A storage base's header: a record header plus what the base is exact for. */
export interface BaseHeader extends RecordHeader {
  generation: number;
  seq: number;
}

export interface StoredBase {
  generation: number;
  seq: number;
  bytes: Uint8Array;
}

export interface LogEntry {
  seq: number;
  bytes: Uint8Array;
}

export interface HaltMarker {
  v: 1;
  reason: string;
  at: number;
}

/**
 * Why a document's persistence is halted, as a closed set.
 *
 * Each value names a state the object REACHED and must not persist from, as
 * against the states an `ExactBaseReason` names, which it merely found and
 * which the same read reports again on the next load. That difference is why
 * these are written down as a marker and those are not.
 */
export type HaltReason =
  | "enforcement_failed"
  | "fence_refused"
  | "apply_failed"
  | "log_corrupt"
  | "group_discarded"
  | "bad_halt";

export type CorruptionReason =
  | "bad_header"
  | "missing_part"
  | "short"
  | "checksum"
  | "bad_halt";

/**
 * Damage found in storage, as opposed to a caller's out-of-domain argument,
 * which is a `RangeError`. The message names the key and the reason and never
 * the bytes, so a log line cannot leak document content.
 */
export class LogCorruptionError extends Error {
  readonly key: string;
  readonly reason: CorruptionReason;

  constructor(key: string, reason: CorruptionReason) {
    super(`durable log record ${key} is corrupt: ${reason}`);
    this.name = "LogCorruptionError";
    this.key = key;
    this.reason = reason;
  }
}

/**
 * Why a document's base could not be proved exact, as a closed set.
 *
 * Every value names a state the loader refuses to open a document in, and each
 * is a fact about D1 and Durable Object storage rather than about any request:
 * the same read gives the same answer until a `/reset` changes it.
 */
export type ExactBaseReason =
  | "generation_unreadable"
  | "generation_malformed"
  | "generation_exhausted"
  | "missing_project"
  | "bad_revision"
  | "revision_exhausted"
  | "bad_tags"
  | "blob_missing_tagged"
  | "base_generation_mismatch"
  | "untagged_under_log"
  | "tail_without_base"
  | "claim_contended"
  | "tag_contended"
  | "initial_write_contended";

/**
 * A base the loader cannot prove exact, or a row it cannot claim.
 *
 * The message names the project and the reason and never the bytes. One caller
 * logs it — the loader that throws it — so every other catch recognises the
 * class and adds nothing.
 */
export class ExactBaseError extends Error {
  readonly projectId: number | null;
  readonly reason: ExactBaseReason;

  constructor(projectId: number | null, reason: ExactBaseReason, options?: ErrorOptions) {
    super(`project ${projectId} has no exact base: ${reason}`, options);
    this.name = "ExactBaseError";
    this.projectId = projectId;
    this.reason = reason;
  }
}

/**
 * The document's persistence is halted for a generation.
 *
 * Thrown by a load that met a durable marker, or that could not apply the base
 * or a replayed record, and carried by the routes as the one refusal a halt
 * gives. The marker travels with it so a caller can name the reason without a
 * second read; the generation is the one the halt belongs to, which a reset
 * advances past.
 */
export class PersistenceHaltedError extends Error {
  readonly projectId: number | null;
  readonly generation: number;
  readonly marker: HaltMarker;

  constructor(projectId: number | null, generation: number, marker: HaltMarker) {
    super(`project ${projectId} is halted at generation ${generation}: ${marker.reason}`);
    this.name = "PersistenceHaltedError";
    this.projectId = projectId;
    this.generation = generation;
    this.marker = marker;
  }
}

/** The write whose outcome could not be reconciled with the row. */
export type FencePhase = "blob" | "batch" | "replacement";

/**
 * The row this instance claimed is not the row it is writing to.
 *
 * Thrown once re-acquisition has read the row, proved this instance still owned
 * the object, and found a revision none of its own writes could have produced.
 * The instance refuses every later persistence until a reset lands, so the
 * class carries the phase that found it rather than a retry hint.
 */
export class FenceRefusedError extends Error {
  readonly projectId: number | null;
  readonly phase: FencePhase;

  constructor(projectId: number | null, phase: FencePhase, detail: string) {
    super(`project ${projectId} lost its ${phase} write fence: ${detail}`);
    this.name = "FenceRefusedError";
    this.projectId = projectId;
    this.phase = phase;
  }
}

// ---------------------------------------------------------------------------
// Checksum
// ---------------------------------------------------------------------------

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

const CRC_TABLE = buildCrcTable();

/**
 * CRC-32 over the bytes, IEEE 802.3 polynomial, as an unsigned 32-bit integer.
 * For corruption detection, not for security: `lib0/hash` offers Rabin and
 * SHA-256, and neither is a synchronous check of this shape.
 */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Domains and keys
// ---------------------------------------------------------------------------

const LOG_KEY = /^log:(0|[1-9]\d*):(\d{15})(?::(\d{4}))?$/;
const BASE_KEY = /^base:(0|[1-9]\d*)(?::(\d{4}))?$/;
const HALT_KEY = /^halt:(0|[1-9]\d*)$/;
const HALT_REASON = /^[a-z_]{1,32}$/;

function isGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSeq(value: unknown): value is number {
  return isGeneration(value) && (value as number) <= MAX_SEQ;
}

function assertGeneration(generation: number): void {
  if (!isGeneration(generation)) {
    throw new RangeError(`generation out of domain: ${generation}`);
  }
}

function assertSeq(seq: number): void {
  if (!isSeq(seq)) {
    throw new RangeError(`sequence out of domain: ${seq}`);
  }
}

/**
 * A generation on the wire: canonical decimal, non-negative, safe. `null`
 * covers both an absent value and one out of domain, so a caller with an
 * optional query parameter needs no separate null check.
 */
export function parseCanonicalGeneration(raw: string | null): number | null {
  if (raw === null || !/^(0|[1-9][0-9]*)$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function pad(value: number, digits: number): string {
  return String(value).padStart(digits, "0");
}

/** The key a log record at `seq` is stored under. */
export function logKey(generation: number, seq: number): string {
  assertGeneration(generation);
  assertSeq(seq);
  return `log:${generation}:${pad(seq, SEQ_DIGITS)}`;
}

/**
 * The listing prefix for a generation's log. Exact: the trailing colon is what
 * keeps generation 1 from matching 10 or 11.
 */
export function logPrefix(generation: number): string {
  assertGeneration(generation);
  return `log:${generation}:`;
}

/**
 * The key a storage base's header is stored under. The base has no listing
 * prefix of its own — `base:1` as a prefix also matches `base:10` — so its
 * parts are enumerated from the header's part count and never listed.
 */
export function baseKey(generation: number): string {
  assertGeneration(generation);
  return `base:${generation}`;
}

/** The key a generation's halt marker is stored under. */
export function haltKey(generation: number): string {
  assertGeneration(generation);
  return `halt:${generation}`;
}

function parsedRecordKey(
  kind: "log" | "base",
  generationText: string,
  seqText: string | undefined,
  partText: string | undefined,
): ParsedKey | null {
  const generation = Number(generationText);
  if (!isGeneration(generation)) return null;
  const parsed: ParsedKey = { kind, generation };
  if (seqText !== undefined) {
    const seq = Number(seqText);
    if (!isSeq(seq)) return null;
    parsed.seq = seq;
  }
  if (partText !== undefined) {
    const part = Number(partText);
    if (part < 1 || part > MAX_PARTS) return null;
    parsed.part = part;
  }
  return parsed;
}

/**
 * A key this codec owns, taken apart, or `null` for anything else — an exact
 * shape, an exact width, digits only, a canonical generation. Every key a
 * listing hands back goes through this, and one it refuses is skipped rather
 * than thrown on: foreign keys share the storage.
 */
export function parseKey(key: string): ParsedKey | null {
  const log = LOG_KEY.exec(key);
  if (log) return parsedRecordKey("log", log[1], log[2], log[3]);

  const base = BASE_KEY.exec(key);
  if (base) return parsedRecordKey("base", base[1], undefined, base[2]);

  const halt = HALT_KEY.exec(key);
  if (!halt) return null;
  const generation = Number(halt[1]);
  return isGeneration(generation) ? { kind: "halt", generation } : null;
}

/** The keys a parted record's parts are stored under, in order. */
export function partKeys(key: string, header: RecordHeader): string[] {
  const keys: string[] = [];
  for (let part = 1; part <= header.parts; part++) {
    keys.push(`${key}:${pad(part, PART_DIGITS)}`);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function partLimitOf(opts: EncodeOptions | undefined): number {
  const limit = opts?.partLimit ?? PART_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`part limit out of domain: ${limit}`);
  }
  return limit;
}

/**
 * A record's own key has to be a canonical log header — no part suffix, and
 * not a base or halt key — or replay would list foreign keys back in as its
 * own records.
 */
function assertLogRecordKey(key: string): void {
  const parsed = parseKey(key);
  if (parsed === null || parsed.kind !== "log" || parsed.part !== undefined) {
    throw new RangeError(`not a log record key: ${key}`);
  }
}

function assertRecordSize(length: number): void {
  if (length > MAX_RECORD_BYTES) {
    throw new RangeError(
      `record of ${length} bytes exceeds the ${MAX_RECORD_BYTES}-byte ceiling`,
    );
  }
}

/**
 * The bytes to store for an inline record. A view with an offset, or one whose
 * backing buffer is longer than the view, is copied: V8 serialises the whole
 * buffer with the view.
 */
function inlineValue(bytes: Uint8Array): Uint8Array {
  const exact = bytes.byteOffset === 0 && bytes.buffer.byteLength === bytes.byteLength;
  return exact ? bytes : bytes.slice();
}

function partedGroup(
  key: string,
  bytes: Uint8Array,
  partLimit: number,
  tag: { generation: number; seq: number } | null,
): Record<string, unknown> {
  // Zero length is one part of zero bytes: parts without a header are orphans,
  // and a header claiming zero parts would name no record at all.
  const parts = Math.max(1, Math.ceil(bytes.length / partLimit));
  if (parts > MAX_PARTS) {
    throw new RangeError(`record needs ${parts} parts, above the ${MAX_PARTS} limit`);
  }

  const group: Record<string, unknown> = {};
  for (let part = 1; part <= parts; part++) {
    const start = (part - 1) * partLimit;
    // `slice`, never `subarray`: a part has to serialise as its own bytes.
    group[`${key}:${pad(part, PART_DIGITS)}`] = bytes.slice(
      start,
      Math.min(start + partLimit, bytes.length),
    );
  }

  const header: RecordHeader = {
    v: 1,
    parts,
    length: bytes.length,
    checksum: crc32(bytes),
  };
  group[key] = tag === null ? header : { ...header, ...tag };
  return group;
}

/**
 * The put group for a log record: the bytes at the key when they fit in one
 * part, otherwise parts plus a header at the key. Touches no storage.
 */
export function encodeRecord(
  key: string,
  bytes: Uint8Array,
  opts?: EncodeOptions,
): Record<string, unknown> {
  assertLogRecordKey(key);
  const partLimit = partLimitOf(opts);
  assertRecordSize(bytes.length);
  if (bytes.length <= partLimit) return { [key]: inlineValue(bytes) };
  return partedGroup(key, bytes, partLimit, null);
}

/**
 * The put group for a storage base. A base is always parted, whatever its
 * size, and its header carries the generation and sequence it is exact for.
 */
export function encodeBase(
  generation: number,
  seq: number,
  bytes: Uint8Array,
  opts?: EncodeOptions,
): Record<string, unknown> {
  const key = baseKey(generation);
  assertSeq(seq);
  const partLimit = partLimitOf(opts);
  assertRecordSize(bytes.length);
  return partedGroup(key, bytes, partLimit, { generation, seq });
}

/**
 * The put group for a generation's halt marker.
 *
 * `at` is a parameter so that a caller holding a resident marker beside this one
 * can give both the same reading: two clock calls would let the halt's time
 * change when the resident state is dropped and the stored marker answers
 * instead.
 */
export function encodeHalt(
  generation: number,
  reason: string,
  at: number = Date.now(),
): Record<string, unknown> {
  const key = haltKey(generation);
  if (!HALT_REASON.test(reason)) {
    throw new RangeError(`halt reason out of domain: ${reason}`);
  }
  const marker: HaltMarker = { v: 1, reason, at };
  return { [key]: marker };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Issue a put group's writes in batches of at most 128 keys, with no `await`
 * between them, and resolve when the runtime has accepted them all; a
 * rejection from any batch rejects the whole, and a synchronous throw from
 * `put` propagates synchronously, which is why this is not an async function.
 *
 * What awaiting the result means: the runtime has accepted the writes, in
 * order. Durability is the Durable Object's output gate — no message initiated
 * while a write is pending leaves the object before that write is durable, and
 * a failed write resets the object — and writes issued without an intervening
 * `await` are coalesced into one atomic commit whether or not they span one
 * `put` call. The message path does not await; the reset path does, for
 * ordering.
 */
export function writeGroup(storage: LogStorage, group: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(group);
  const issued: Promise<void>[] = [];
  for (let start = 0; start < keys.length; start += BATCH_LIMIT) {
    const batch: Record<string, unknown> = {};
    for (const key of keys.slice(start, start + BATCH_LIMIT)) {
      batch[key] = group[key];
    }
    issued.push(storage.put(batch));
  }
  return Promise.all(issued).then(() => undefined);
}

/**
 * Delete keys in batches of at most 128, awaiting each, and answer with the
 * number deleted. For the retirement and maintenance paths, which are ordered
 * and therefore do await.
 */
export async function deleteKeys(storage: LogStorage, keys: string[]): Promise<number> {
  let deleted = 0;
  for (let start = 0; start < keys.length; start += BATCH_LIMIT) {
    deleted += await storage.delete(keys.slice(start, start + BATCH_LIMIT));
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !ArrayBuffer.isView(value)
  );
}

function isChecksum(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffffffff;
}

function isLength(value: unknown, parts: number): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= MAX_RECORD_BYTES &&
    (value as number) <= parts * PART_LIMIT
  );
}

/**
 * A record header, validated in full before any part is fetched or any buffer
 * allocated. Anything short of the contract is `bad_header`.
 */
function parseHeader(key: string, value: unknown): RecordHeader {
  if (!isPlainRecord(value)) throw new LogCorruptionError(key, "bad_header");
  const { v, parts, length, checksum } = value;
  const partCount = Number.isInteger(parts) ? (parts as number) : 0;
  if (v !== 1 || partCount < 1 || partCount > MAX_PARTS) {
    throw new LogCorruptionError(key, "bad_header");
  }
  if (!isLength(length, partCount) || !isChecksum(checksum)) {
    throw new LogCorruptionError(key, "bad_header");
  }
  return { v: 1, parts: partCount, length, checksum };
}

/** A base's header, which carries the pair the base is exact for. */
function parseBaseHeader(key: string, value: unknown, generation: number): BaseHeader {
  const header = parseHeader(key, value);
  const tagged = value as Record<string, unknown>;
  if (!isGeneration(tagged.generation) || tagged.generation !== generation) {
    throw new LogCorruptionError(key, "bad_header");
  }
  if (!isSeq(tagged.seq)) throw new LogCorruptionError(key, "bad_header");
  return { ...header, generation: tagged.generation, seq: tagged.seq };
}

function copyBatch(
  key: string,
  batch: string[],
  values: Map<string, unknown>,
  assembled: Uint8Array,
  offset: number,
): number {
  let filled = offset;
  for (const partKey of batch) {
    const part = values.get(partKey);
    if (!(part instanceof Uint8Array)) throw new LogCorruptionError(key, "missing_part");
    // A part longer than the header's length leaves the record short of its
    // claim just as a missing one does, and is refused before the copy.
    if (filled + part.length > assembled.length) throw new LogCorruptionError(key, "short");
    assembled.set(part, filled);
    filled += part.length;
  }
  return filled;
}

async function assembleParts(
  storage: LogStorage,
  key: string,
  header: RecordHeader,
): Promise<Uint8Array> {
  const keys = partKeys(key, header);
  const assembled = new Uint8Array(header.length);
  let filled = 0;
  for (let start = 0; start < keys.length; start += BATCH_LIMIT) {
    const batch = keys.slice(start, start + BATCH_LIMIT);
    filled = copyBatch(key, batch, await storage.get<unknown>(batch), assembled, filled);
  }
  if (filled !== header.length) throw new LogCorruptionError(key, "short");
  if (crc32(assembled) !== header.checksum) throw new LogCorruptionError(key, "checksum");
  return assembled;
}

function requireRecordKey(key: string): ParsedKey {
  const parsed = parseKey(key);
  if (parsed === null || parsed.kind === "halt" || parsed.part !== undefined) {
    throw new RangeError(`not a record key: ${key}`);
  }
  return parsed;
}

/**
 * The bytes stored at a record key, whether inline or parted. Bytes at a base
 * key are `bad_header`: a base is always parted.
 */
async function assembleValue(
  storage: LogStorage,
  key: string,
  value: unknown,
  parsed: ParsedKey,
): Promise<Uint8Array> {
  if (value instanceof Uint8Array) {
    if (parsed.kind === "base") throw new LogCorruptionError(key, "bad_header");
    return value;
  }
  const header =
    parsed.kind === "base"
      ? parseBaseHeader(key, value, parsed.generation)
      : parseHeader(key, value);
  return assembleParts(storage, key, header);
}

/**
 * The record at a key, or `null` when the key holds nothing. Parts with no
 * header are orphans and answer `null`, because the header is what makes a
 * record exist.
 */
export async function readRecord(storage: LogStorage, key: string): Promise<Uint8Array | null> {
  const parsed = requireRecordKey(key);
  const value = await storage.get<unknown>(key);
  if (value === undefined) return null;
  return assembleValue(storage, key, value, parsed);
}

/**
 * A storage base's header alone, validated in full, with no part fetched and no
 * buffer allocated — or `null` when the generation holds no header.
 *
 * The one read for a caller that needs the sequence a base is exact for rather
 * than its bytes: the whole header contract is checked, so a caller that acts on
 * the sequence acts on a header a reader would also accept, and damage is
 * `LogCorruptionError` here exactly as it is in a full read.
 */
export async function readBaseHeader(
  storage: LogStorage,
  generation: number,
): Promise<BaseHeader | null> {
  const key = baseKey(generation);
  const value = await storage.get<unknown>(key);
  if (value === undefined) return null;
  if (value instanceof Uint8Array) throw new LogCorruptionError(key, "bad_header");
  return parseBaseHeader(key, value, generation);
}

/** The storage base for a generation, or `null` when it has no header. */
export async function readBase(
  storage: LogStorage,
  generation: number,
): Promise<StoredBase | null> {
  const header = await readBaseHeader(storage, generation);
  if (header === null) return null;
  return {
    generation: header.generation,
    seq: header.seq,
    bytes: await assembleParts(storage, baseKey(generation), header),
  };
}

/**
 * The halt marker for a generation, or `null` **only** when the key is absent.
 * A present value that is not a valid marker — a stored `null` included — is
 * `bad_halt`, so damage can never read as "not halted"; the loader treats the
 * error as a halt.
 */
export async function readHalt(
  storage: LogStorage,
  generation: number,
): Promise<HaltMarker | null> {
  const key = haltKey(generation);
  const value = await storage.get<unknown>(key);
  if (value === undefined) return null;
  if (!isPlainRecord(value)) throw new LogCorruptionError(key, "bad_halt");
  const { v, reason, at } = value;
  if (v !== 1 || typeof reason !== "string" || !HALT_REASON.test(reason)) {
    throw new LogCorruptionError(key, "bad_halt");
  }
  if (!Number.isSafeInteger(at) || (at as number) < 0) {
    throw new LogCorruptionError(key, "bad_halt");
  }
  return { v: 1, reason, at: at as number };
}

/**
 * The page size `replayLog` asks storage for: the caller's request, capped at
 * `REPLAY_PAGE` so a caller cannot defeat the page-memory bound the module's
 * header documents. Anything short of a positive integer is out of domain.
 */
function replayPageSize(pageSize: number | undefined): number {
  if (pageSize === undefined) return REPLAY_PAGE;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new RangeError(`replay page size out of domain: ${pageSize}`);
  }
  return Math.min(pageSize, REPLAY_PAGE);
}

// The placeholder a consumed slot takes, so a page releases each value as the
// generator advances past it.
const RELEASED: [string, unknown] = ["", undefined];

async function* replayPage(
  storage: LogStorage,
  entries: [string, unknown][],
  fromSeqExclusive: number,
  opts: ListOptions,
): AsyncGenerator<LogEntry, void, undefined> {
  for (let index = 0; index < entries.length; index++) {
    const [key, value] = entries[index];
    entries[index] = RELEASED;
    const parsed = parseKey(key);
    if (parsed === null) {
      opts.onSkipped?.(key);
      continue;
    }
    // Part keys sort under the prefix too, and their record is read through
    // its header; a gap in the sequence is not an error at this layer.
    if (parsed.part !== undefined || parsed.seq === undefined) continue;
    if (parsed.seq <= fromSeqExclusive) continue;
    yield { seq: parsed.seq, bytes: await assembleValue(storage, key, value, parsed) };
  }
}

/**
 * Every log record above `fromSeqExclusive`, in sequence order.
 *
 * Pages the prefix with `startAfter`, so what this holds at once is one page,
 * plus the parts batch and assembled bytes of whichever record is being put
 * together — bounded by the record ceiling, never by the log's length.
 */
export async function* replayLog(
  storage: LogStorage,
  generation: number,
  fromSeqExclusive: number,
  opts: ListOptions = {},
): AsyncGenerator<LogEntry, void, undefined> {
  const prefix = logPrefix(generation);
  const limit = replayPageSize(opts.pageSize);
  let cursor = logKey(generation, fromSeqExclusive);

  for (;;) {
    const page = await storage.list<unknown>({ prefix, startAfter: cursor, limit });
    if (page.size === 0) return;
    const entries = [...page];
    page.clear();
    cursor = entries[entries.length - 1][0];
    yield* replayPage(storage, entries, fromSeqExclusive, opts);
  }
}

/** The sequence a key names, for a log header only: a part is not a record. */
function logHeaderSeq(parsed: ParsedKey): number | null {
  if (parsed.kind !== "log" || parsed.part !== undefined) return null;
  return parsed.seq ?? null;
}

/** The first log header in a page of keys, or `null` when it holds none. */
function highestInPage(keys: string[], opts: ListOptions): number | null {
  for (const key of keys) {
    const parsed = parseKey(key);
    if (parsed === null) {
      opts.onSkipped?.(key);
      continue;
    }
    const seq = logHeaderSeq(parsed);
    if (seq !== null) return seq;
  }
  return null;
}

/**
 * The highest log sequence under a generation, or `null` when it holds no
 * record header.
 *
 * Pages downward with `end` rather than `startAfter`: `startAfter` stays a
 * lower bound when a listing is reversed, so it cannot walk a reverse listing
 * at all. Orphan parts and foreign keys sort above a header and are stepped
 * over, the unparseable ones reported.
 */
export async function highestSeq(
  storage: LogStorage,
  generation: number,
  opts: ListOptions = {},
): Promise<number | null> {
  const prefix = logPrefix(generation);
  const limit = opts.pageSize ?? REVERSE_PAGE;
  let end: string | undefined;

  for (;;) {
    const page = await storage.list<unknown>({ prefix, reverse: true, limit, end });
    const keys = [...page.keys()];
    if (keys.length === 0) return null;
    const seq = highestInPage(keys, opts);
    if (seq !== null) return seq;
    // A reverse page ends at its lowest key, which becomes the next page's
    // exclusive upper bound.
    end = keys[keys.length - 1];
  }
}
