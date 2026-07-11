/**
 * Read-side heal for a google_sheets_enabled flag stranded in D1.
 *
 * The repo's _config.yml is the source of truth for whether builds use
 * Google Sheets; D1's project_config.google_sheets_enabled is a cached
 * copy that the settings page renders. The cache can strand at `true`
 * after a successful disable: the collaboration Durable Object is the
 * sole reconciling writer for config columns, so a warm Y.Doc that still
 * held the old `true` clobbers a direct D1 write back on its next
 * snapshot — and once the repo reads `enabled: false`, no later push
 * re-fires the disable path to repair it.
 *
 * This helper reconciles at the point the stale value is rendered. Two
 * constraints shape it:
 *   - Heal only on affirmative repo evidence (fetched content that parses
 *     as disabled). A failed or null fetch fails open to the D1 value —
 *     a transient GitHub outage must not flip the displayed state.
 *   - A D1 repair alone is insufficient: the same warm Y.Doc that caused
 *     the strand would clobber it again, so the heal must also reset the
 *     collaboration doc (resetCollabDocIfBlobExists, the onboarding
 *     repair's guard).
 *
 * The common case (D1 already false) costs nothing: no GitHub read, no
 * D1 write. Reverse drift (repo re-enabled by hand while D1 says false)
 * is deliberately out of scope — writing D1 `true` has behavioural
 * consequences beyond display (start-page nudge, upgrade gating).
 *
 * @version v1.4.3-beta
 */

import { eq } from "drizzle-orm";
import { project_config } from "~/db/schema";
import type { getDb } from "~/lib/db.server";
import { getFileContent } from "~/lib/github.server";
import { isGoogleSheetsEnabled } from "~/lib/commit.server";
import { resetCollabDocIfBlobExists } from "~/lib/collab-reset.server";

/**
 * Returns the effective "Sheets enabled" state to render, healing D1 and
 * the collaboration doc when the repo affirmatively contradicts a D1
 * `true`. Never throws: every failure path falls back to a displayable
 * value (D1's when the repo is unreadable, the repo's when the heal
 * write fails — the next visit retries the heal).
 */
export async function reconcileSheetsFlagFromRepo(
  db: ReturnType<typeof getDb>,
  env: Parameters<typeof resetCollabDocIfBlobExists>[1],
  opts: {
    token: string;
    owner: string;
    repo: string;
    projectId: number;
    d1Enabled: boolean;
  },
): Promise<boolean> {
  if (!opts.d1Enabled) return false;

  let content: string | null;
  try {
    content = await getFileContent(opts.token, opts.owner, opts.repo, "_config.yml");
  } catch {
    return true;
  }
  if (content === null) return true;
  if (isGoogleSheetsEnabled(content)) return true;

  try {
    await db
      .update(project_config)
      .set({ google_sheets_enabled: false, updated_at: new Date().toISOString() })
      .where(eq(project_config.project_id, opts.projectId));
    await resetCollabDocIfBlobExists(db, env, opts.projectId);
  } catch {
    // The repair failed but the repo truth is known — display it; the
    // stale D1 row is retried on the next settings-page load.
  }
  return false;
}
