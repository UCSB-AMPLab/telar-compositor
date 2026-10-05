/**
 * This file picks the token a publish commits on. A member whose stored
 * repository access is "access" commits as themselves; every other state, and
 * a member whose access has not been read (no reading time), commits on the
 * installation token, so nobody is refused. A commit the member's token cannot make is made again
 * once on the installation token, on the same expected head, and the member's
 * state is marked unread, so the next publish does not choose the refused token
 * again while the team page keeps showing what it last read.
 *
 * @version v1.5.0-beta
 */

import { and, eq } from "drizzle-orm";
import { project_members } from "~/db/schema";
import type { getDb } from "~/lib/db.server";
import { GitHubPermissionError } from "~/lib/github.server";
import { chooseCommitToken, stageFor } from "~/lib/repo-access";

export async function commitOnOwnToken<T>(
  db: ReturnType<typeof getDb>,
  who: { projectId: number; userId: number; userToken: string; installToken: string },
  commit: (token: string) => Promise<T>,
): Promise<T> {
  const [row] = await db
    .select({ gh_access: project_members.gh_access, gh_access_checked_at: project_members.gh_access_checked_at })
    .from(project_members)
    .where(and(eq(project_members.project_id, who.projectId), eq(project_members.user_id, who.userId)))
    .limit(1);
  // An access reading whose time was cleared is unread, whatever it says.
  const access = row?.gh_access_checked_at ? row.gh_access : null;
  if (chooseCommitToken(stageFor("member", access ?? null, true).stage) === "installation") {
    return commit(who.installToken);
  }
  try {
    return await commit(who.userToken);
  } catch (err) {
    if (!(err instanceof GitHubPermissionError)) throw err;
    await db
      .update(project_members)
      .set({ gh_access_checked_at: null })
      .where(and(eq(project_members.project_id, who.projectId), eq(project_members.user_id, who.userId)));
    return commit(who.installToken);
  }
}
