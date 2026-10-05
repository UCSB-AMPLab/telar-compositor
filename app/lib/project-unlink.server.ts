/**
 * project-unlink.server — deletes a project and everything that depends on
 * it when its owner unlinks the repository from the onboarding wizard.
 *
 * @version v1.5.0-beta
 */

import { eq, inArray } from "drizzle-orm";
import {
  projects,
  project_config,
  project_themes,
  project_landing,
  project_members,
  project_invites,
  project_pages,
  pending_object_ops,
  objects,
  stories,
  steps,
  layers,
  glossary_terms,
  activity_log,
} from "~/db/schema";
import { contributionDeletes, orphanedStaffDelete } from "~/lib/import.server";
import type { StaffCopy } from "~/lib/import.server";

/**
 * Cascade-delete every row that depends on `projectId`, in dependency order:
 * layers → steps → stories → objects → glossary_terms → project_config →
 * project_themes → project_landing → project_pages → pending_object_ops →
 * project_members →
 * project_invites → projects. Kept out of the route module because the client build cannot hold a
 * route export that depends on server code.
 *
 * project_pages must be included: its `project_id` FK to projects has no
 * ON DELETE CASCADE, so omitting it fails the projects-row delete with a FK
 * error for any project that has pages. (Kept in sync with
 * `deleteProjectCascade` in import.server.ts, which already deletes it.)
 *
 * The deletes are issued as a single `db.batch([...])` so D1 executes them
 * atomically; a worker that's evicted mid-cascade can no longer leave behind
 * orphan rows referencing a deleted parent.
 */
export async function unlinkProjectCascade(
  // biome-ignore lint/suspicious/noExplicitAny: drizzle DB type is route-scoped
  db: any,
  projectId: number,
): Promise<StaffCopy[]> {
  // Resolve dependent ids before the batch — these are reads, not writes,
  // so they don't need to be inside the atomic group.
  const storyIds = await db
    .select({ id: stories.id })
    .from(stories)
    .where(eq(stories.project_id, projectId));
  const ids = storyIds.map((s: { id: number }) => s.id);

  let stepIds: { id: number }[] = [];
  if (ids.length > 0) {
    stepIds = await db
      .select({ id: steps.id })
      .from(steps)
      .where(inArray(steps.story_id, ids));
  }

  // biome-ignore lint/suspicious/noExplicitAny: drizzle batch tuple typing
  const batchOps: any[] = orphanedStaffDelete(db, projectId);
  if (stepIds.length > 0) {
    batchOps.push(
      db
        .delete(layers)
        .where(inArray(layers.step_id, stepIds.map((s: { id: number }) => s.id))),
    );
  }
  if (ids.length > 0) {
    batchOps.push(db.delete(steps).where(inArray(steps.story_id, ids)));
  }
  batchOps.push(
    ...contributionDeletes(db, projectId),
    db.delete(stories).where(eq(stories.project_id, projectId)),
    db.delete(objects).where(eq(objects.project_id, projectId)),
    db.delete(glossary_terms).where(eq(glossary_terms.project_id, projectId)),
    db.delete(project_config).where(eq(project_config.project_id, projectId)),
    db.delete(project_themes).where(eq(project_themes.project_id, projectId)),
    db.delete(project_landing).where(eq(project_landing.project_id, projectId)),
    db.delete(project_pages).where(eq(project_pages.project_id, projectId)),
    db.delete(pending_object_ops).where(eq(pending_object_ops.project_id, projectId)),
    // The project's members keep their repository access: deleting or
    // unlinking a project records no withdrawal.
    db.delete(project_members).where(eq(project_members.project_id, projectId)),
    db.delete(project_invites).where(eq(project_invites.project_id, projectId)),
    db.delete(activity_log).where(eq(activity_log.project_id, projectId)),
    db.delete(projects).where(eq(projects.id, projectId)),
  );

  const [, orphaned] = await db.batch(batchOps);
  return orphaned as StaffCopy[];
}
