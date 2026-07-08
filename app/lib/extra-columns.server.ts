/**
 * Canonicalisation for the objects `extra_columns` passthrough blob.
 *
 * `extra_columns` is a JSON catch-all carrying whatever custom CSV columns a
 * user's objects sheet has beyond the schema. Two subsystems must judge "same
 * data" identically for it: the publish entity hash (decides whether an object
 * changed and needs re-emitting) and the sync diff (decides whether a repo-side
 * edit should surface in sync review). If their judgments ever diverge, a
 * semantically unchanged object oscillates between "changed" and "unchanged"
 * across a publish/sync cycle. That is why this lives here as the single shared
 * implementation — never fork a local copy into either consumer.
 *
 * Equivalent data canonicalises identically regardless of stored key order;
 * corrupt or absent blobs collapse to "".
 *
 * @version v1.4.2-beta
 */

export function canonicalExtraColumns(raw: string | null | undefined): string {
  if (!raw) return "";
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object" || Array.isArray(o)) return "";
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) sorted[k] = o[k];
    return JSON.stringify(sorted);
  } catch {
    return "";
  }
}
