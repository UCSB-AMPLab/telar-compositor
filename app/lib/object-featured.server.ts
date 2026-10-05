/**
 * Sets an object's featured flag on the object row's own site.
 *
 * The row names its site, which is the one the page showed it on, so the
 * write lands there, for a member of that site, whichever site the session
 * names. An object that does not exist writes nothing.
 *
 * @version v1.5.0-beta
 */

import { and, eq } from "drizzle-orm";
import { objects } from "~/db/schema";
import type { getDb } from "~/lib/db.server";
import { requireProjectMember } from "~/lib/membership.server";

export async function setObjectFeatured(
  db: ReturnType<typeof getDb>,
  userId: number,
  objectDbId: number,
  featured: boolean,
): Promise<void> {
  const [row] = await db
    .select({ project_id: objects.project_id })
    .from(objects)
    .where(eq(objects.id, objectDbId))
    .limit(1);
  if (!row) return;
  await requireProjectMember(db, row.project_id, userId);
  await db
    .update(objects)
    .set({ featured, updated_at: new Date().toISOString() })
    .where(and(eq(objects.id, objectDbId), eq(objects.project_id, row.project_id)));
}
