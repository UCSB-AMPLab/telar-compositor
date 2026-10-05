/**
 * The digest a sync check's fingerprint of D1's rows is made with
 * (`syncedRowsFingerprint`): rows taken in D1 id order, hashed as JSON. Two
 * reads of the same rows answer the same digest; any column written between
 * them answers another.
 *
 * @version v1.5.0-beta
 */

/** `rows` in D1 id order, which is the order a fingerprint takes them in. */
export function inRowIdOrder<T extends Record<string, unknown>>(rows: ReadonlyArray<T>): T[] {
  return [...rows].sort((a, b) => Number(a.id) - Number(b.id));
}

/** A SHA-256 hex digest of `value` as JSON. */
export async function rowsDigest(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
