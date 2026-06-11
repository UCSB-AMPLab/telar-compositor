/**
 * Server-side helpers for the Objects tab that need project-scoped database
 * reads. The objects list shows a "used in N steps" count per object so the
 * author can see, at a glance, which uploads are actually referenced by a
 * story and which are safe to remove.
 *
 * That count is deceptively easy to get wrong: `steps.object_id` is the
 * object's human slug (e.g. `telar-placeholder`), and the same slug is seeded
 * into every project. A naive `GROUP BY object_id` over the whole `steps`
 * table therefore sums references across ALL projects and reports a wildly
 * inflated total on shared slugs. The count must be scoped to the active
 * project — and because `steps` carries no `project_id` of its own, the scope
 * comes from the parent story: each step belongs to a story, and the story
 * carries the `project_id`. Joining through `stories` and filtering on
 * `stories.project_id` is the single source of truth for "in THIS project".
 *
 * @version v1.3.6-beta
 */

import { eq, count } from "drizzle-orm";
import { steps, stories } from "~/db/schema";
import type { getDb } from "~/lib/db.server";

type DbInstance = ReturnType<typeof getDb>;

/**
 * The project-scoped step-reference count query, returned as a builder so
 * callers (and tests) can inspect the generated SQL via `.toSQL()`. Counts
 * steps grouped by `object_id`, restricted to steps whose parent story belongs
 * to `projectId`. `steps.story_id` is a NOT NULL FK to `stories.id`, so the
 * inner join drops no legitimate rows.
 */
export function objectStepCountQuery(db: DbInstance, projectId: number) {
  return db
    .select({ object_id: steps.object_id, count: count() })
    .from(steps)
    .innerJoin(stories, eq(steps.story_id, stories.id))
    .where(eq(stories.project_id, projectId))
    .groupBy(steps.object_id);
}

/**
 * Resolve the per-object step-reference counts for a project as a plain
 * `object_id -> count` map. Rows with a null `object_id` (steps not bound to an
 * object) are skipped. An object with no steps in this project is simply absent
 * from the map — SQL `GROUP BY` never emits a zero-count row — which the UI
 * reads as "not used here".
 */
export async function getObjectStepCounts(
  db: DbInstance,
  projectId: number,
): Promise<Record<string, number>> {
  const rows = await objectStepCountQuery(db, projectId);
  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (row.object_id) {
      counts[row.object_id] = row.count;
    }
  }
  return counts;
}
