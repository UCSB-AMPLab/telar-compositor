/**
 * The caller's own repository access, read from their row in D1. The
 * reconciler writes that row from GitHub; this reads what it wrote and makes
 * no call of its own, so it is safe on the status poll's request path.
 *
 * @version v1.5.0-beta
 */
import { and, eq } from "drizzle-orm";
import { project_members } from "~/db/schema";
import type { getDb } from "~/lib/db.server";
import type { OwnRepoAccess } from "~/lib/repo-access";

export async function readOwnRepoAccess(
  db: ReturnType<typeof getDb>,
  projectId: number,
  userId: number,
): Promise<OwnRepoAccess | null> {
  try {
    const [row] = await db
      .select({ gh_access: project_members.gh_access, gh_invitation_url: project_members.gh_invitation_url })
      .from(project_members)
      .where(and(eq(project_members.project_id, projectId), eq(project_members.user_id, userId)))
      .limit(1);
    return row?.gh_access ? { stage: row.gh_access, invitationUrl: row.gh_invitation_url } : null;
  } catch (err) {
    console.warn("[own-repo-access] read failed", err);
    return null;
  }
}
