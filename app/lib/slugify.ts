/**
 * Slug utility — converts titles to URL-safe story and object IDs.
 *
 * Exports:
 *   slugify(title) — pure string transformation
 *   generateUniqueSlug(baseSlug, projectId, db) — collision-safe slug for stories
 *   generateUniqueObjectSlug(baseSlug, projectId, db) — collision-safe slug for objects
 */

import { and, eq } from "drizzle-orm";
import { stories, objects } from "~/db/schema";
import type { getDb } from "~/lib/db.server";

/**
 * Converts a title string into a URL-safe, lowercase, hyphenated slug.
 *
 * Steps:
 *   1. Normalise to NFKD and strip combining diacritical marks
 *   2. Lowercase
 *   3. Strip characters that are neither alphanumeric nor whitespace
 *   4. Replace runs of whitespace with a single hyphen
 *   5. Strip leading and trailing hyphens
 */
export function slugify(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, "") // strip non-alphanumeric, non-space chars
    .trim()
    .replace(/\s+/g, "-") // collapse whitespace runs → hyphen
    .replace(/^-+|-+$/g, ""); // strip leading/trailing hyphens
}

/**
 * Returns a slug that is unique within a project's stories table.
 *
 * If the base slug already exists, appends -2, -3, … until a free slot is found.
 * Queries are batched: we fetch all existing slugs starting with baseSlug in one
 * round trip to avoid N+1 calls.
 */
export async function generateUniqueSlug(
  baseSlug: string,
  projectId: number,
  db: ReturnType<typeof getDb>
): Promise<string> {
  // Fetch all story_ids in this project that could collide
  const existing = await db
    .select({ story_id: stories.story_id })
    .from(stories)
    .where(and(eq(stories.project_id, projectId)));

  const taken = new Set(existing.map((r) => r.story_id));

  if (!taken.has(baseSlug)) {
    return baseSlug;
  }

  let suffix = 2;
  while (taken.has(`${baseSlug}-${suffix}`)) {
    suffix++;
  }
  return `${baseSlug}-${suffix}`;
}

/**
 * Returns a slug that is unique within a project's objects table.
 *
 * If the base slug already exists as an object_id in the project, appends
 * -2, -3, … until a free slot is found. Queries are batched in one round
 * trip to avoid N+1 calls.
 */
export async function generateUniqueObjectSlug(
  baseSlug: string,
  projectId: number,
  db: ReturnType<typeof getDb>
): Promise<string> {
  // Fetch all object_ids in this project that could collide
  const existing = await db
    .select({ object_id: objects.object_id })
    .from(objects)
    .where(and(eq(objects.project_id, projectId)));

  const taken = new Set(existing.map((r) => r.object_id));

  if (!taken.has(baseSlug)) {
    return baseSlug;
  }

  let suffix = 2;
  while (taken.has(`${baseSlug}-${suffix}`)) {
    suffix++;
  }
  return `${baseSlug}-${suffix}`;
}
