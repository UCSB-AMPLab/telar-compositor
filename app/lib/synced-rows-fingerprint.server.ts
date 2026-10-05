/**
 * A fingerprint of everything in D1 the full sync's check compares: the
 * project's object rows, story rows with their steps and layers, glossary
 * terms, settings and pages, every column of each, in D1 id order. Taken once
 * before the check reads anything and again when it would record what it
 * read, it answers the same only when nothing the check compared has been
 * written in between, which is what lets the check, and the status refresh
 * that runs it, record a head only over the rows it compared.
 *
 * @version v1.5.0-beta
 */

import { eq, inArray } from "drizzle-orm";
import { glossary_terms, layers, objects, project_config, project_pages, steps, stories } from "~/db/schema";
import type { getDb } from "~/lib/db.server";
import { inRowIdOrder, rowsDigest } from "~/lib/object-rows-fingerprint";

/** The fingerprint of the project's compared rows as D1 holds them now. */
export async function syncedRowsFingerprint(db: ReturnType<typeof getDb>, projectId: number): Promise<string> {
  const storyIds = db.select({ id: stories.id }).from(stories).where(eq(stories.project_id, projectId));
  const stepIds = db.select({ id: steps.id }).from(steps).where(inArray(steps.story_id, storyIds));
  const tables = await Promise.all([
    db.select().from(objects).where(eq(objects.project_id, projectId)),
    db.select().from(stories).where(eq(stories.project_id, projectId)),
    db.select().from(steps).where(inArray(steps.story_id, storyIds)),
    db.select().from(layers).where(inArray(layers.step_id, stepIds)),
    db.select().from(glossary_terms).where(eq(glossary_terms.project_id, projectId)),
    db.select().from(project_config).where(eq(project_config.project_id, projectId)),
    db.select().from(project_pages).where(eq(project_pages.project_id, projectId)),
  ]);
  return rowsDigest(tables.map((rows) => inRowIdOrder(rows as Array<Record<string, unknown>>)));
}
