/**
 * Re-reads an external object's manifest for the thumbnail it advertises now.
 * The stored thumbnail is written once, at the object's first enrichment, so a
 * manifest corrected afterwards leaves the stored URL answering 404; the page
 * asks for this when that image fails to load.
 *
 * @version v1.5.0-beta
 */

import { and, eq } from "drizzle-orm";
import { objects } from "~/db/schema";
import type { getDb } from "~/lib/db.server";
import type { fetchAndParseManifest } from "~/lib/iiif.server";

/**
 * The manifest's thumbnail when it is not the stored one, otherwise null: the
 * object has no source, the manifest cannot be read, it names no thumbnail, or
 * it names the one already stored.
 */
export async function refreshedThumbnail(
  object: { source_url: string | null; thumbnail: string | null },
  fetchManifest: typeof fetchAndParseManifest,
): Promise<string | null> {
  if (!object.source_url) return null;
  const result = await fetchManifest(object.source_url);
  if (!result.ok) return null;
  const current = result.metadata.thumbnail;
  return current && current !== object.thumbnail ? current : null;
}

/**
 * The manifest's current thumbnail for object `objectDbId` of project
 * `projectId` when it differs from the stored one, otherwise null. Reads only: the thumbnail is written into the live document by
 * the page, because a D1 write the document does not hold is overwritten by the
 * next snapshot.
 */
export async function currentThumbnail(
  db: ReturnType<typeof getDb>,
  projectId: number,
  objectDbId: number,
  fetchManifest: typeof fetchAndParseManifest,
): Promise<string | null> {
  const [stored] = await db
    .select()
    .from(objects)
    .where(and(eq(objects.id, objectDbId), eq(objects.project_id, projectId)))
    .limit(1);
  return stored ? refreshedThumbnail(stored, fetchManifest) : null;
}
