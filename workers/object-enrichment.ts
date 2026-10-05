/**
 * The metadata of an external IIIF object, read from its manifest and filled
 * into the document by the collaboration server, which is the one writer of
 * it. A client deciding from its own copy can fill an object whose source
 * another author has already changed, or set a field over a title someone is
 * typing; here the source and each field are read in the same transaction
 * that writes, against the document every client's edits arrive at.
 *
 * Only empty fields are filled, so an author's value always outranks the
 * manifest. A prose field already held as an empty `Y.Text` is inserted into
 * rather than replaced, so a keystroke still in flight into it merges with the
 * filled text instead of being dropped with the replaced type. The field then
 * holds both texts, and the author removes the manifest's in the editor; the
 * server cannot see a keystroke that has not reached it.
 *
 * @version v1.5.0-beta
 */

import * as Y from "yjs";
import { fetchAndParseManifest } from "~/lib/iiif.server";
import type { IiifMetadata } from "~/lib/iiif-types";
import { yTextToString } from "./collaboration-helpers";

/** The prose fields a manifest fills, each held by the document as `Y.Text`. */
const ENRICHED_PROSE_FIELDS = ["title", "creator", "description", "source", "credit", "period", "object_type"] as const;

/** How long one manifest read may take before it counts as failed. */
const MANIFEST_TIMEOUT_MS = 8000;

/** An object whose manifest is to be read: its D1 id and the source it held when chosen. */
export interface EnrichmentCandidate {
  id: number;
  sourceUrl: string;
}

/** A manifest read for `sourceUrl`, which the fill writes only while the object still names it. */
export interface ReadManifest extends EnrichmentCandidate {
  metadata: IiifMetadata;
}

/** An object the fill wrote to, and the prose fields it filled. */
export interface FilledObject {
  id: number;
  entry: Y.Map<unknown>;
  fields: string[];
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || (value instanceof Y.Text ? value.length === 0 : value === "");
}

function objectMaps(ydoc: Y.Doc): Y.Map<unknown>[] {
  return ydoc.getArray<unknown>("objects").toArray().filter((m): m is Y.Map<unknown> => m instanceof Y.Map);
}

const candidateKey = (c: EnrichmentCandidate) => `${c.id}|${c.sourceUrl}`;

/**
 * The objects with a D1 id and an external source whose thumbnail is empty:
 * those whose manifest has not filled them, or whose source changed to one
 * not yet read.
 */
export function enrichmentCandidates(ydoc: Y.Doc): EnrichmentCandidate[] {
  const candidates: EnrichmentCandidate[] = [];
  for (const entry of objectMaps(ydoc)) {
    const id = entry.get("_id");
    const sourceUrl = yTextToString(entry.get("source_url"));
    if (typeof id === "number" && sourceUrl !== "" && isEmpty(entry.get("thumbnail"))) candidates.push({ id, sourceUrl });
  }
  return candidates;
}

/**
 * Takes the candidates no other request is reading, recording them in
 * `inFlight`; the caller releases them with `releaseCandidates` once its fill
 * has run.
 */
export function claimCandidates(candidates: readonly EnrichmentCandidate[], inFlight: Set<string>): EnrichmentCandidate[] {
  const claimed = candidates.filter((c) => !inFlight.has(candidateKey(c)));
  for (const c of claimed) inFlight.add(candidateKey(c));
  return claimed;
}

export function releaseCandidates(claimed: readonly EnrichmentCandidate[], inFlight: Set<string>): void {
  for (const c of claimed) inFlight.delete(candidateKey(c));
}

/**
 * One manifest read, aborted after `MANIFEST_TIMEOUT_MS`. The timer is
 * cleared once the read settles, since a pending one keeps the object from
 * hibernating.
 */
async function readWithinTimeout(url: string, fetchManifest: typeof fetchAndParseManifest) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
  try {
    return await fetchManifest(url, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads each candidate's manifest, in parallel, each bounded by
 * `MANIFEST_TIMEOUT_MS`. A read that fails, times out or is not a manifest
 * is left out: nothing is written for it, and a later request reads it again.
 */
export async function readManifests(
  candidates: readonly EnrichmentCandidate[],
  fetchManifest: typeof fetchAndParseManifest = fetchAndParseManifest,
): Promise<ReadManifest[]> {
  const results = await Promise.allSettled(candidates.map((c) => readWithinTimeout(c.sourceUrl, fetchManifest)));
  return candidates.flatMap((c, i) => {
    const result = results[i];
    return result.status === "fulfilled" && result.value.ok ? [{ ...c, metadata: result.value.metadata }] : [];
  });
}

/** Fills one prose field if it is empty; reports whether it did. */
function fillText(entry: Y.Map<unknown>, key: string, value: string): boolean {
  const held = entry.get(key);
  if (!isEmpty(held)) return false;
  if (held instanceof Y.Text) held.insert(0, value);
  else entry.set(key, new Y.Text(value));
  return true;
}

/**
 * Marks the image available, since an external object's zoom comes from its
 * IIIF image service, and fills the thumbnail and prose fields that are
 * empty. Returns the prose fields filled.
 */
function fillEntry(entry: Y.Map<unknown>, metadata: IiifMetadata): string[] {
  if (entry.get("image_available") !== true) entry.set("image_available", true);
  if (metadata.thumbnail && isEmpty(entry.get("thumbnail"))) entry.set("thumbnail", metadata.thumbnail);
  return ENRICHED_PROSE_FIELDS.filter((key) => {
    const value = metadata[key];
    return Boolean(value) && fillText(entry, key, value as string);
  });
}

/**
 * Writes each manifest into its object, in one transaction. An object the
 * document does not hold, or whose source differs from the one the manifest
 * was read for, is skipped: what was read describes another image.
 */
export function fillFromManifests(ydoc: Y.Doc, manifests: readonly ReadManifest[]): FilledObject[] {
  const filled: FilledObject[] = [];
  if (manifests.length === 0) return filled;
  const byId = new Map(objectMaps(ydoc).map((m) => [m.get("_id"), m]));
  ydoc.transact(() => {
    for (const { id, sourceUrl, metadata } of manifests) {
      const entry = byId.get(id);
      if (!entry || yTextToString(entry.get("source_url")) !== sourceUrl) continue;
      filled.push({ id, entry, fields: fillEntry(entry, metadata) });
    }
  });
  return filled;
}
