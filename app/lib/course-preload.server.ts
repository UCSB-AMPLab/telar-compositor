/**
 * Course preloading — copies a course project's collection into a child site
 * at redemption, so a group starts with the objects the course provides.
 *
 * Students do not get a copy of the image; they get their own record. Each
 * child row carries its own title, creator and credit — the group's to
 * catalogue — while every row points at the same `source_url`, so changing what
 * that URL serves changes what every site shows. The copied metadata is a
 * starting point: later edits on the parent do not propagate.
 *
 * The write goes through the collaboration DO's `/ingest-sync` endpoint rather
 * than D1: the Y.Doc is the source of truth for objects, and a D1-only insert
 * would be swept away as an orphan by the next snapshot. The payload carries
 * `objects.insert` and nothing else — the same endpoint also accepts `config`,
 * `stories` and `objects.remove`, and a stray block would overwrite the group's
 * settings or delete their objects under the same signed marker.
 *
 * @version v1.5.0-beta
 */

import { eq } from "drizzle-orm";
import { objects } from "~/db/schema";
import type { getDb } from "~/lib/db.server";
import { makeInternalMarkerHeaders } from "~/lib/internal-marker.server";
import type { IngestObjectInsert } from "../../workers/collaboration";

/**
 * The DO binding + secret the preload needs. Mirrors the FullSyncEnv /
 * CollabResetEnv shape so any real Env satisfies it structurally.
 */
export interface CoursePreloadEnv {
  SESSION_SECRET: string;
  // Method syntax (bivariant params) so the real Env's DurableObjectNamespace
  // satisfies this structural subset without a cast.
  COLLABORATION: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
}

export interface CoursePreloadResult {
  /** Objects newly inserted into the child's document. */
  inserted: number;
  /**
   * Course objects the child already holds under THIS course's marker — a
   * repeated preload (a retry after a lost response, or a redemption re-run to
   * repair a partial one). Nothing went wrong.
   */
  skippedAlreadyOurs: string[];
  /**
   * Course objects whose `object_id` is already taken in the child by an
   * object that is NOT ours — the site made its own object under the same id.
   * A real collision: the group keeps their object and does not get the
   * course's.
   */
  skippedConflict: string[];
  /**
   * Course objects that never left the parent because their image lives in the
   * parent's repository, not at a URL. Preloading one would plant a reference
   * that is dead in the child from its first minute.
   */
  skippedRepoBound: string[];
}

/**
 * True when `value` is the kind of `source_url` a child can inherit: an
 * absolute http(s) URL, which covers IIIF manifests and external media alike.
 *
 * The test establishes shape, not reachability — an unreachable parent URL
 * preloads exactly as broken as the parent already had it. What it excludes is
 * everything repository-bound: a null `source_url` (a self-hosted upload whose
 * files live in the parent's repo) and, because the import path stores
 * repository-local audio filenames in the same column, any value that is not an
 * absolute URL at all.
 */
export function isUrlBackedSource(value: string | null | undefined): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/**
 * Preload the URL-backed objects of `courseProjectId` into `childProjectId`.
 *
 * Idempotent: the DO's insert path skips an `object_id` already present, so a
 * re-run repairs a partial preload rather than duplicating it. The result
 * discriminates the two reasons an insert can be skipped (see
 * CoursePreloadResult).
 *
 * Ordering constraint for the caller: at site creation this must run only once
 * the child's import has fully written D1. An ingest into a cold DO builds the
 * document from whatever D1 holds at that instant, and the next snapshot's
 * orphan sweep would reconcile a half-imported site out of existence.
 *
 * Throws when the DO refuses the ingest, leaving the child unchanged and the
 * preload safe to retry.
 */
/**
 * The child's object refuses a course's objects once the child is no longer
 * attached to that course: the preload was overtaken by a leave or a
 * course delete. Nothing is owed to anyone, so it is logged, not reported.
 */
function logNotEnrolled(refused: string[] | undefined, courseProjectId: number, childProjectId: number): void {
  if (!refused || refused.length === 0) return;
  console.warn(
    `[course-preload] course ${courseProjectId} → child ${childProjectId}: ${refused.length} ` +
      `object(s) refused, the child is no longer attached to the course`,
  );
}

export async function preloadCourseObjects(
  db: ReturnType<typeof getDb>,
  env: CoursePreloadEnv,
  params: { courseProjectId: number; childProjectId: number },
): Promise<CoursePreloadResult> {
  const { courseProjectId, childProjectId } = params;

  const parentRows = await db
    .select()
    .from(objects)
    .where(eq(objects.project_id, courseProjectId));

  const skippedRepoBound: string[] = [];
  const inserts: IngestObjectInsert[] = [];
  for (const row of parentRows) {
    if (!isUrlBackedSource(row.source_url)) {
      skippedRepoBound.push(row.object_id);
      continue;
    }
    inserts.push({
      object_id: row.object_id,
      title: row.title,
      creator: row.creator,
      description: row.description,
      alt_text: row.alt_text,
      period: row.period,
      year: row.year,
      object_type: row.object_type,
      subjects: row.subjects,
      source: row.source,
      credit: row.credit,
      dimensions: row.dimensions,
      extra_columns: row.extra_columns,
      // Carried as-is, never re-validated: these are the parent's values for
      // literally the same URL, right or wrong. A preload neither improves nor
      // degrades them.
      source_url: row.source_url,
      thumbnail: row.thumbnail,
      image_available: Boolean(row.image_available),
      // Featuring is the group's decision about their own homepage.
      featured: false,
      // The truthful provenance: the row was created by the compositor, not
      // read from the child's repo. It is also what keeps sync from flagging
      // every preloaded object as missing until the group's first publish.
      origin: "compositor",
      // The person who catalogued the object did catalogue it; carrying the
      // attribution through is what makes cataloguing visible as labour in the
      // child's contributions view.
      created_by: row.created_by,
      course_project_id: courseProjectId,
    });
  }

  if (inserts.length === 0) {
    return { inserted: 0, skippedAlreadyOurs: [], skippedConflict: [], skippedRepoBound };
  }

  // The marker is signed for the CHILD: this writes into the child's document,
  // and the DO verifies the header project against its own bound id.
  const headers = await makeInternalMarkerHeaders(
    childProjectId,
    env.SESSION_SECRET,
    "ingest-sync",
  );
  const stub = env.COLLABORATION.get(env.COLLABORATION.idFromName(String(childProjectId)));
  const res = await stub.fetch(
    new Request("https://internal/ingest-sync", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ objects: { insert: inserts } }),
    }),
  );
  if (!res.ok) {
    throw new Error(`course preload failed: DO returned ${res.status}`);
  }
  const body = (await res.json()) as {
    applied?: { objectInsert?: number };
    skipped?: { objectInsert?: string[] };
    refused?: { objectInsert?: number[] };
    courseRefused?: { objectInsert?: string[] };
  };
  logNotEnrolled(body.courseRefused?.objectInsert, courseProjectId, childProjectId);
  const inserted = body.applied?.objectInsert ?? 0;
  const skippedIds = body.skipped?.objectInsert ?? [];
  // Objects the DO's identity boundary refused. Everything on this wire is
  // read out of the course's own `objects` rows, where `object_id` is
  // `text NOT NULL` with no constraint on its content — an empty one is a
  // legal row and an illegal identity. Such an object is not preloaded and is
  // neither ours already nor a conflict, so it belongs in none of the returned
  // lists; it is reported by POSITION, the only name it has that is not the
  // value the rule rejected.
  const refusedAt = body.refused?.objectInsert ?? [];
  if (refusedAt.length > 0) {
    console.error(
      `[course-preload] course ${courseProjectId} → child ${childProjectId}: the DO refused ` +
        `${refusedAt.length} object(s) at position(s) ${refusedAt.join(", ")} — object_id out ` +
        `of domain`,
    );
  }

  if (skippedIds.length === 0) {
    return { inserted, skippedAlreadyOurs: [], skippedConflict: [], skippedRepoBound };
  }

  // Discriminate the skips. The ingest ends with a snapshot, so the child's D1
  // rows now mirror its document: a skipped id whose child row carries THIS
  // course's marker is one we preloaded before; one that does not is the site's
  // own object holding the id first.
  const childRows = await db
    .select({ object_id: objects.object_id, course_project_id: objects.course_project_id })
    .from(objects)
    .where(eq(objects.project_id, childProjectId));
  const markerByObjectId = new Map(childRows.map((r) => [r.object_id, r.course_project_id]));

  const skippedAlreadyOurs: string[] = [];
  const skippedConflict: string[] = [];
  for (const objectId of skippedIds) {
    if (markerByObjectId.get(objectId) === courseProjectId) skippedAlreadyOurs.push(objectId);
    else skippedConflict.push(objectId);
  }

  return { inserted, skippedAlreadyOurs, skippedConflict, skippedRepoBound };
}
