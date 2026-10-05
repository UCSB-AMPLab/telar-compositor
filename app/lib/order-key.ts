/**
 * order-key.ts — fractional index keys, the ordering primitive that lets a
 * collaborative list be reordered by writing one field instead of moving an
 * item between array positions.
 *
 * An integer rank cannot express "between": dropping an item between ranks 1
 * and 2 has nowhere to land, so an integer scheme must renumber the
 * neighbours — many writes per drag, and two concurrent renumbers interleave
 * into a scrambled list. A fractional index is a string over a base-62 digit
 * alphabet, compared lexicographically, and for any two distinct keys a third
 * always exists strictly between them. One drag is therefore one field write
 * on one map, and two concurrent drags are last-write-wins on two independent
 * fields rather than a contest over array structure.
 *
 * A naive "midpoint of two fractions" scheme grows one digit every few
 * appends, because appending halves the remaining space above. The integer
 * part avoids that: the head character encodes how many digits follow ('a' =>
 * 2, 'b' => 3, ... and 'Z' => 2, 'Y' => 3, ... running downwards for keys
 * before the origin), so appending increments an integer and stays short.
 * That is the standard construction; this is an implementation of it, not an
 * invention.
 *
 * The alphabet is ASCII-ascending, so JavaScript string comparison and SQL
 * `ORDER BY` on a TEXT column agree without a collation.
 *
 * `generateKeyBetween` is a pure function of its bounds, which is what makes
 * the algebra testable and what makes a repair reproducible — but it also
 * means two clients that cannot see each other, computing "between A and B"
 * from the same two neighbours, mint the same string. In a CRDT that is a
 * collision by construction, not a race to be excluded: nothing coordinates
 * the two. `generateDistinctKeyBetween` is the minting entry point for that
 * reason. It appends random digits inside the same interval, so independent
 * clients land on different keys and the list keeps a strict order to drop
 * into. The deterministic function stays exported for the repair path, where
 * agreeing IS the desired outcome.
 *
 * @version v1.5.0-beta
 */

export const BASE_62_DIGITS =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const ZERO = BASE_62_DIGITS[0];
const LAST = BASE_62_DIGITS[BASE_62_DIGITS.length - 1];

/** The smallest representable integer part; a key equal to it alone is illegal. */
const SMALLEST_INTEGER = "A" + ZERO.repeat(26);

/**
 * Digits strictly between `a` and `b`, both read as fractions written in
 * `BASE_62_DIGITS` with an implied leading "0.". `b === undefined` means "no
 * upper bound". Neither argument may carry a trailing zero: a trailing zero
 * is a non-canonical spelling of a shorter key and would break the
 * strictly-between guarantee.
 */
function midpoint(a: string, b: string | undefined): string {
  if (b !== undefined && a >= b) {
    throw new Error(`order-key: midpoint bounds out of order (${a} >= ${b})`);
  }
  if (a.slice(-1) === ZERO || (b !== undefined && b.slice(-1) === ZERO)) {
    throw new Error("order-key: midpoint bound has a trailing zero");
  }
  if (b !== undefined) {
    // Strip the common prefix and recurse on what actually differs.
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n += 1;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a.length > 0 ? BASE_62_DIGITS.indexOf(a[0]) : 0;
  const digitB = b !== undefined ? BASE_62_DIGITS.indexOf(b[0]) : BASE_62_DIGITS.length;
  if (digitB - digitA > 1) {
    return BASE_62_DIGITS[Math.round(0.5 * (digitA + digitB))];
  }
  // The leading digits are consecutive: descend into `a`'s tail (or truncate
  // `b`, when `b` has a tail of its own to be shorter than).
  if (b !== undefined && b.length > 1) return b.slice(0, 1);
  return BASE_62_DIGITS[digitA] + midpoint(a.slice(1), undefined);
}

/** How many digits follow the head character of an integer part. */
function integerLength(head: string): number {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - "a".charCodeAt(0) + 2;
  if (head >= "A" && head <= "Z") return "Z".charCodeAt(0) - head.charCodeAt(0) + 2;
  throw new Error(`order-key: invalid head character "${head}"`);
}

function assertWellFormedInteger(int: string): void {
  if (int.length !== integerLength(int[0])) {
    throw new Error(`order-key: malformed integer part "${int}"`);
  }
  for (let i = 1; i < int.length; i++) {
    if (BASE_62_DIGITS.indexOf(int[i]) < 0) {
      throw new Error(`order-key: non-digit in integer part "${int}"`);
    }
  }
}

function integerPartOf(key: string): string {
  const len = integerLength(key[0]);
  if (len > key.length) throw new Error(`order-key: truncated key "${key}"`);
  return key.slice(0, len);
}

function assertWellFormedKey(key: string): void {
  if (key === SMALLEST_INTEGER) throw new Error("order-key: reserved smallest key");
  const int = integerPartOf(key);
  assertWellFormedInteger(int);
  const frac = key.slice(int.length);
  if (frac.slice(-1) === ZERO) throw new Error(`order-key: trailing zero in "${key}"`);
  for (const ch of frac) {
    if (BASE_62_DIGITS.indexOf(ch) < 0) throw new Error(`order-key: non-digit in "${key}"`);
  }
}

/** The next integer part above `x`, or null when the space is exhausted. */
function incrementInteger(x: string): string | null {
  assertWellFormedInteger(x);
  const head = x[0];
  const digits = x.slice(1).split("");
  let carry = true;
  for (let i = digits.length - 1; carry && i >= 0; i--) {
    const d = BASE_62_DIGITS.indexOf(digits[i]) + 1;
    if (d === BASE_62_DIGITS.length) digits[i] = ZERO;
    else { digits[i] = BASE_62_DIGITS[d]; carry = false; }
  }
  if (!carry) return head + digits.join("");
  if (head === "Z") return "a" + ZERO;
  if (head === "z") return null;
  const nextHead = String.fromCharCode(head.charCodeAt(0) + 1);
  if (nextHead > "a") digits.push(ZERO);
  else digits.pop();
  return nextHead + digits.join("");
}

/** The next integer part below `x`, or null when the space is exhausted. */
function decrementInteger(x: string): string | null {
  assertWellFormedInteger(x);
  const head = x[0];
  const digits = x.slice(1).split("");
  let borrow = true;
  for (let i = digits.length - 1; borrow && i >= 0; i--) {
    const d = BASE_62_DIGITS.indexOf(digits[i]) - 1;
    if (d === -1) digits[i] = LAST;
    else { digits[i] = BASE_62_DIGITS[d]; borrow = false; }
  }
  if (!borrow) return head + digits.join("");
  if (head === "a") return "Z" + LAST;
  if (head === "A") return null;
  const prevHead = String.fromCharCode(head.charCodeAt(0) - 1);
  if (prevHead < "Z") digits.push(LAST);
  else digits.pop();
  return prevHead + digits.join("");
}

/**
 * A key strictly between `a` and `b`. Either bound may be null, meaning
 * "nothing on that side" — `generateKeyBetween(null, null)` mints the first
 * key of an empty list, `generateKeyBetween(last, null)` appends.
 *
 * Throws when the bounds are equal or reversed: that is a caller bug (an
 * unsorted list, or a duplicate key the backfill should have healed), and
 * minting something plausible would hide it.
 */
export function generateKeyBetween(a: string | null, b: string | null): string {
  if (a !== null) assertWellFormedKey(a);
  if (b !== null) assertWellFormedKey(b);
  if (a !== null && b !== null && a >= b) {
    throw new Error(`order-key: bounds out of order (${a} >= ${b})`);
  }

  if (a === null) {
    if (b === null) return "a" + ZERO;
    const intB = integerPartOf(b);
    const fracB = b.slice(intB.length);
    if (intB === SMALLEST_INTEGER) return intB + midpoint("", fracB);
    if (intB < b) return intB;
    const dec = decrementInteger(intB);
    if (dec === null) throw new Error("order-key: key space exhausted below");
    return dec;
  }

  const intA = integerPartOf(a);
  const fracA = a.slice(intA.length);

  if (b === null) {
    const inc = incrementInteger(intA);
    return inc === null ? intA + midpoint(fracA, undefined) : inc;
  }

  const intB = integerPartOf(b);
  const fracB = b.slice(intB.length);
  if (intA === intB) return intA + midpoint(fracA, fracB);
  const inc = incrementInteger(intA);
  if (inc === null) throw new Error("order-key: key space exhausted above");
  if (inc < b) return inc;
  return intA + midpoint(fracA, undefined);
}

/**
 * Whether `value` is a canonical key this module would itself have minted.
 * Everything else — undefined, a number left over from the integer column, an
 * empty string, a key with a trailing zero — is degenerate and is what the
 * backfill exists to repair.
 */
export function isValidOrderKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    assertWellFormedKey(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Random digits appended to a minted key. Five base-62 digits with a
 * non-zero last one is a little under 2^29 distinct suffixes, against a
 * population of the handful of people dragging one list in one session —
 * so two independent mints into one gap colliding is not a case the
 * ordering has to survive, while five characters per key is a cost it can
 * carry indefinitely.
 */
export const KEY_JITTER_DIGITS = 5;

/**
 * `n` random digits whose last one is non-zero, so the result is a canonical
 * fraction that can be appended to any key.
 */
function randomDigits(n: number): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < n - 1; i++) out += BASE_62_DIGITS[bytes[i] % 62];
  // The final digit is drawn from the 61 non-zero ones: a trailing zero is a
  // non-canonical spelling of a shorter key and `assertWellFormedKey` refuses
  // it.
  out += BASE_62_DIGITS[1 + (bytes[n - 1] % 61)];
  return out;
}

/**
 * Digits that may be appended to `base` while keeping the result below `b`.
 *
 * Appending only ever makes a string larger, so the lower bound needs no
 * thought — but the upper one does. When `base` is a proper prefix of `b`
 * (which is exactly what repeated insertion into one shrinking gap
 * produces), an unconstrained suffix can overshoot `b`. In that case the
 * suffix is held below `b`'s remaining digits: zeros up to `b`'s first
 * non-zero digit, then a digit below it, then free digits that cannot
 * matter because the comparison is already settled.
 */
function jitterUnder(base: string, b: string | null): string {
  if (b === null || !b.startsWith(base)) return randomDigits(KEY_JITTER_DIGITS);

  const tail = b.slice(base.length);
  // A canonical key has no trailing zero, so `tail` — a suffix of `b` — ends
  // in a non-zero digit and the search always terminates inside it.
  let lead = 0;
  while (tail[lead] === ZERO) lead += 1;
  const ceiling = BASE_62_DIGITS.indexOf(tail[lead]);
  const bytes = new Uint8Array(1);
  crypto.getRandomValues(bytes);
  const digit = BASE_62_DIGITS[bytes[0] % ceiling];
  return ZERO.repeat(lead) + digit + randomDigits(KEY_JITTER_DIGITS);
}

/**
 * A key strictly between `a` and `b`, as `generateKeyBetween`, but drawn at
 * random from that interval rather than at its midpoint.
 *
 * This is the function every mint should call. Two clients dropping
 * different entries into the same gap have the same two neighbours and no
 * way to consult each other, so a deterministic midpoint gives them the same
 * key and leaves the list with a tie no later drop can be placed inside.
 * Randomising the tail costs five characters and removes the tie.
 *
 * Repairs deliberately do NOT use this: two clients healing the same broken
 * list should agree, and a deterministic key is how they do.
 */
export function generateDistinctKeyBetween(
  a: string | null,
  b: string | null,
): string {
  const base = generateKeyBetween(a, b);
  return base + jitterUnder(base, b);
}

/**
 * `n` ascending keys after `after` (or from the start when null). Used by the
 * backfill, which lays a fresh sequence over a list whose keys are absent or
 * degenerate. Appending one at a time is deliberate: the integer part keeps
 * each key short, so there is nothing to gain from a bisecting split.
 */
export function generateNKeysAfter(after: string | null, n: number): string[] {
  const out: string[] = [];
  let prev = after;
  for (let i = 0; i < n; i++) {
    prev = generateKeyBetween(prev, null);
    out.push(prev);
  }
  return out;
}
