/**
 * This file is the server-side activity-log service for the Start-tab
 * activity feed. Two responsibilities:
 *
 *   - `recordActivity` writes ONE coarse row per save/create/sync —
 *     actor + entity_type + entity_id + verb + timestamp. It validates
 *     `verb` and `entity_type` against fixed allow-sets before INSERT
 *     (repudiation/tampering gate: no free-text verbs reach the table),
 *     then opportunistically prunes rows beyond a per-project cap so the
 *     table cannot grow unbounded (no cron — minimal-computing ethos).
 *     The whole call is wrapped in try/catch and FAILS OPEN: an activity
 *     write must never break the save/publish/sync it rides alongside.
 *
 *   - `getRecentActivity` returns the last N rows for a project, newest
 *     first, left-joined to `users` for the actor avatar (github_id /
 *     github_login / github_name). Project-scoping (`WHERE project_id = ?`)
 *     is the security boundary — the loader resolves the active project
 *     via membership before calling, so a member can only ever read their
 *     own project's feed. Fails open to `[]`.
 *
 * Actor identity is always the SERVER-RESOLVED userId (the DO's
 * `getUserContext(origin)?.userId`; route actions' authenticated `user.id`),
 * never a client-supplied request field — the spoofing mitigation lives at
 * the call sites, this module just persists whatever id it is handed.
 *
 * @version v1.3.0-beta
 */

import { eq, desc, sql } from "drizzle-orm";
import { getDb } from "~/lib/db.server";
import { activity_log, users } from "~/db/schema";

type DbInstance = ReturnType<typeof getDb>;

/** Allowed verbs — validated before INSERT (repudiation gate). */
export const ACTIVITY_VERBS = [
  "edited",
  "added",
  "created",
  "synced",
  "published",
] as const;
export type ActivityVerb = (typeof ACTIVITY_VERBS)[number];

/** Allowed entity types — validated before INSERT (repudiation gate). */
export const ACTIVITY_ENTITY_TYPES = [
  "story",
  "object",
  "term",
  "page",
  "config",
  "site",
] as const;
export type ActivityEntityType = (typeof ACTIVITY_ENTITY_TYPES)[number];

/**
 * Per-project retention cap. recordActivity opportunistically deletes rows
 * beyond the most-recent `ACTIVITY_RETENTION_CAP` for the project it just
 * wrote to (unbounded-growth mitigation). The composite index
 * (project_id, created_at) keeps both the prune and the last-5 read cheap.
 *
 * Defined in collaboration-helpers.ts (the only module shared with the DO) and
 * re-exported here so both emit paths — request-side recordActivity and the DO
 * snapshot loop — prune to the same cap. Re-export keeps the public surface of
 * this module unchanged for existing consumers/tests.
 */
export { ACTIVITY_RETENTION_CAP } from "../../workers/collaboration-helpers";
import { ACTIVITY_RETENTION_CAP } from "../../workers/collaboration-helpers";

const VERB_SET = new Set<string>(ACTIVITY_VERBS);
const ENTITY_TYPE_SET = new Set<string>(ACTIVITY_ENTITY_TYPES);

export interface RecordActivityInput {
  projectId: number;
  actorUserId: number | null;
  verb: ActivityVerb;
  entityType: ActivityEntityType;
  entityId?: string | null;
  entityLabel?: string | null;
}

export interface RecentActivityRow {
  id: number;
  verb: string;
  entity_type: string;
  entity_id: string | null;
  entity_label: string | null;
  created_at: string | null;
  actor_user_id: number | null;
  actor_github_id: number | null;
  actor_github_login: string | null;
  actor_github_name: string | null;
}

/**
 * Insert one coarse activity row, then prune rows beyond the per-project cap.
 *
 * Validates `verb` and `entity_type` against the fixed allow-sets; an invalid
 * value is a no-op (returns without inserting) rather than persisting junk.
 * Wrapped in try/catch and fails open — never throws into the caller.
 */
export async function recordActivity(
  db: DbInstance,
  input: RecordActivityInput,
): Promise<void> {
  try {
    // Repudiation gate: reject free-text verbs/entity types.
    if (!VERB_SET.has(input.verb) || !ENTITY_TYPE_SET.has(input.entityType)) {
      return;
    }

    await db.insert(activity_log).values({
      project_id: input.projectId,
      actor_user_id: input.actorUserId ?? null,
      verb: input.verb,
      entity_type: input.entityType,
      entity_id: input.entityId ?? null,
      entity_label: input.entityLabel ?? null,
    });

    // Opportunistic prune: keep only the most-recent ACTIVITY_RETENTION_CAP
    // rows for this project. Subquery selects the ids to keep (DESC by
    // created_at, then id as a tiebreaker); delete everything else for the
    // project. project-scoped — never touches other projects' rows.
    await db.run(sql`
      DELETE FROM ${activity_log}
      WHERE ${activity_log.project_id} = ${input.projectId}
        AND ${activity_log.id} NOT IN (
          SELECT ${activity_log.id} FROM ${activity_log}
          WHERE ${activity_log.project_id} = ${input.projectId}
          ORDER BY ${activity_log.created_at} DESC, ${activity_log.id} DESC
          LIMIT ${ACTIVITY_RETENTION_CAP}
        )
    `);
  } catch {
    // Fail open — an activity write must never break the save/publish/sync
    // it rides alongside. The feed simply misses a row.
  }
}

/**
 * Return the last `limit` activity rows for a project, newest first, joined
 * to `users` for the actor avatar. Project-scoped (WHERE project_id = ?) —
 * the security boundary. Fails open to [].
 */
export async function getRecentActivity(
  db: DbInstance,
  projectId: number,
  limit = 5,
): Promise<RecentActivityRow[]> {
  try {
    const rows = await db
      .select({
        id: activity_log.id,
        verb: activity_log.verb,
        entity_type: activity_log.entity_type,
        entity_id: activity_log.entity_id,
        entity_label: activity_log.entity_label,
        created_at: activity_log.created_at,
        actor_user_id: activity_log.actor_user_id,
        actor_github_id: users.github_id,
        actor_github_login: users.github_login,
        actor_github_name: users.github_name,
      })
      .from(activity_log)
      .leftJoin(users, eq(activity_log.actor_user_id, users.id))
      .where(eq(activity_log.project_id, projectId))
      .orderBy(desc(activity_log.created_at), desc(activity_log.id))
      .limit(limit);

    return rows as RecentActivityRow[];
  } catch {
    return [];
  }
}
