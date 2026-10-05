/**
 * Which objects the Objects page asks the deployed site about, and how the
 * answer is written. A self-hosted image is ready when its tile information
 * file answers on the site (`probeTileStates`); the page writes that into
 * the shared document, whose snapshot writes D1, so a document still holding
 * `false` cannot write an earlier value back. A probe that did not answer
 * proves nothing about the tiles and writes nothing. An object the site
 * definitely lacks (a 404, once the site has answered 2xx for another object)
 * is taken off ready while it is still a self-hosted image, and is marked
 * again when its tiles answer.
 *
 * @version v1.5.0-beta
 */

import type * as Y from "yjs";
import { detectMediaType } from "~/lib/media-type";
import { isExternalSource } from "~/lib/object-id";

/** The most objects one probe asks about; the page sends the rest in later reads. */
export const TILE_PROBE_LIMIT = 24;

/**
 * How long the page waits before asking again about an object a probe did not
 * answer ready. Each probe revalidates the page, so asking again at once would
 * ask about a site still building on every answer.
 */
export const TILE_PROBE_RETRY_MS = 30_000;

/** Whether an object with this id and source is a self-hosted image the site tiles: media and external sources have no tiles of their own. */
export function isTiledImage(objectId: string, sourceUrl: string | null): boolean {
  return objectId !== "" && !isExternalSource(sourceUrl) && detectMediaType(sourceUrl, objectId) === "iiif";
}

/**
 * The self-hosted images among `rows`, those not yet ready first and then the
 * ready ones, so a read that cannot hold them all asks about the unready
 * first: media and external sources have no tiles of their own.
 */
export function tileProbeCandidates(
  rows: ReadonlyArray<{ object_id: string; source_url: string | null; image_available: boolean | null }>,
): string[] {
  const tiled = rows.filter((r) => isTiledImage(r.object_id, r.source_url));
  return [...tiled.filter((r) => !r.image_available), ...tiled.filter((r) => r.image_available)].map((r) => r.object_id);
}

/**
 * Mark the document's objects named in `readyIds` as having their tiles, and
 * those in `missingIds` as lacking them, in one transaction. An object that
 * is no longer a self-hosted image is not probed again, so it keeps its flag.
 */
export function markTilesReady(ydoc: Y.Doc | null, readyIds: readonly string[], missingIds: readonly string[] = []): void {
  if (!ydoc || (readyIds.length === 0 && missingIds.length === 0)) return;
  const ready = new Set(readyIds);
  const missing = new Set(missingIds);
  const objectsArray = ydoc.getArray<Y.Map<unknown>>("objects");
  ydoc.transact(() => {
    for (const entry of objectsArray.toArray()) {
      const id = entry.get("object_id") as string;
      const now = entry.get("image_available") === true;
      if (ready.has(id) && !now) entry.set("image_available", true);
      else if (missing.has(id) && !ready.has(id) && now && isTiledImage(id, (entry.get("source_url") as string | null) ?? null)) {
        entry.set("image_available", false);
      }
    }
  });
}
