/**
 * The withdrawal of repository access a membership's end owes. The person's
 * row leaves the team page with the removal, so nobody could withdraw the
 * access afterwards: the removal records it, and the team-access reconciler
 * withdraws it and deletes the record once GitHub confirms.
 *
 * @version v1.5.0-beta
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { project_members, repo_access_withdrawals, users } from "~/db/schema";
import type { getDb } from "~/lib/db.server";

/**
 * Records a withdrawal for every membership row `ending` matches whose access
 * the App gave or may have given: an add GitHub took (gh_add_state 'sent'),
 * or one sent and not yet answered ('sending'), whose invitation the drain
 * deletes once GitHub lists it. A member who joined before the release
 * (gh_add_owed false), one who already collaborated on the repository, one
 * whose add failed, and one whose access the convenor already withdrew
 * ('revoked') keep their GitHub access as it is.
 * It goes in the removal's own batch, ahead of the delete with the same
 * condition, so the rows it records are the rows the delete takes and a failed
 * removal records none.
 * The account id is copied at that moment, because deleting an account
 * replaces it with a tombstone in the same batch.
 */
export function recordWithdrawals(db: ReturnType<typeof getDb>, ending: SQL | undefined) {
  // An insert from a select names every column, in the table's order.
  const ended = db
    .select({
      id: sql<number>`NULL`.as("id"),
      project_id: project_members.project_id,
      user_id: project_members.user_id,
      attempts: sql<number>`0`.as("attempts"),
      last_error: sql<string | null>`NULL`.as("last_error"),
      created_at: sql<string>`${new Date().toISOString()}`.as("created_at"),
      // Qualified by hand: a one-table select renders its columns unqualified.
      github_id: sql<number | null>`(SELECT u.github_id FROM ${users} AS u WHERE u.id = ${project_members}.user_id)`.as("github_id"),
    })
    .from(project_members)
    .where(and(ending, eq(project_members.gh_add_owed, true), inArray(project_members.gh_add_state, ["sent", "sending"])));
  return db.insert(repo_access_withdrawals).select(ended);
}
