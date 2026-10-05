/**
 * Rows an import before object ids were read as written stored under a
 * stripped id, and the rename-only updates that give them GitHub's spelling.
 *
 * Every path that writes objects.csv from D1, or records a head as read after
 * reading objects.csv, gives such rows GitHub's spelling first: written from D1
 * as they stand, `map` would replace GitHub's `map  `. Which rows qualify is
 * `legacyStrippedIds`'s rule. Kept apart from sync.server.ts so that the
 * objects commit's preparation (pending-object-ops.server.ts), which
 * sync.server.ts reaches through publish.server.ts, can use it without a cycle.
 *
 * @version v1.5.0-beta
 */

import { and, eq, isNull } from "drizzle-orm";
import { projects } from "~/db/schema";
import type { getDb } from "~/lib/db.server";
import { makeInternalMarkerHeaders } from "~/lib/internal-marker.server";
import { legacyStrippedIds } from "~/lib/objects.server";
import { pythonStrip } from "~/lib/python-whitespace";

/**
 * A D1 row an earlier import stored under a stripped id, and GitHub's padded
 * spelling of it (`legacyStrippedIds`).
 */
export interface LegacyRespelling {
  /** The id as D1 holds it. */
  objectId: string;
  docId: number;
  /** The id as GitHub's objects.csv writes it. */
  githubId: string;
}

/**
 * By D1 row id, the rows `legacyStrippedIds` pairs with GitHub's padded ids:
 * `repoIds` as GitHub's objects.csv writes them, `recordedIds` as the recorded
 * version writes them (null for no readable recorded version, which pairs
 * nothing).
 */
export function legacyRespellings(
  repoIds: readonly string[],
  d1Rows: ReadonlyArray<{ id: number; object_id: string }>,
  recordedIds: readonly string[] | null,
): Map<number, LegacyRespelling> {
  const pairs = legacyStrippedIds(repoIds, d1Rows.map((row) => row.object_id), recordedIds);
  const respellings = new Map<number, LegacyRespelling>();
  for (const [githubId, objectId] of pairs) {
    const row = d1Rows.find((o) => o.object_id === objectId);
    if (row) respellings.set(row.id, { objectId, docId: row.id, githubId });
  }
  return respellings;
}

/** The `objects.update` entry that gives one row GitHub's spelling and changes nothing else. */
export function respellingUpdate(respelling: LegacyRespelling): {
  objectId: string; docId: number; fields: Record<string, never>; renameTo: string;
} {
  return { objectId: respelling.objectId, docId: respelling.docId, fields: {}, renameTo: respelling.githubId };
}

/**
 * Send the rename-only updates for `respellings` through the collaboration
 * object, in one ingest. The caller holds the objects lease. Answers true when
 * every row took GitHub's spelling; false when the ingest failed or a row was
 * re-created or deleted since it was read.
 */
export async function sendRespellings(
  env: {
    SESSION_SECRET: string;
    COLLABORATION: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
  },
  projectId: number,
  respellings: readonly LegacyRespelling[],
): Promise<boolean> {
  if (respellings.length === 0) return true;
  const headers = await makeInternalMarkerHeaders(projectId, env.SESSION_SECRET, "ingest-sync");
  const stub = env.COLLABORATION.get(env.COLLABORATION.idFromName(String(projectId)));
  const res = await stub.fetch(
    new Request("https://internal/ingest-sync", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ objects: { update: respellings.map(respellingUpdate), insert: [], remove: [] } }),
    }),
  );
  if (!res.ok) return false;
  const answer = (await res.json().catch(() => ({}))) as {
    skipped?: { objectUpdate?: string[] };
    superseded?: { objectUpdate?: string[] };
  };
  return (answer.skipped?.objectUpdate ?? []).length === 0 && (answer.superseded?.objectUpdate ?? []).length === 0;
}

/**
 * The commit a legacy pairing is judged against: the one whose object rows D1
 * accounts for (`objects_read_sha`, which the import sets), else the recorded
 * head; null for neither. Not the base an ordinary three-way diff uses, which
 * is the recorded head alone and is NULL for a project whose onboarding made
 * no commit.
 */
export function legacyRecordRef(project: { objects_read_sha?: string | null; head_sha?: string | null }): string | null {
  return project.objects_read_sha ?? project.head_sha ?? null;
}

/**
 * The commit a project's legacy pairing is judged against (`legacyRecordRef`),
 * or undefined once the first sync check an author started, or Keep my
 * version, has repaired its ids (`legacy_ids_repaired_at`, migration 0063):
 * from then on every id difference is an ordinary change.
 */
export async function legacyPairingRef(
  db: ReturnType<typeof getDb>,
  projectId: number,
): Promise<string | null | undefined> {
  const [row] = await db
    .select({
      at: projects.legacy_ids_repaired_at,
      objects_read_sha: projects.objects_read_sha,
      head_sha: projects.head_sha,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (row === undefined || row.at !== null) return undefined;
  return legacyRecordRef(row);
}

/** Whether any of `ids` carries whitespace CPython strips, which only a padded id does. */
export function hasPaddedId(ids: Iterable<unknown>): boolean {
  for (const value of ids) {
    const id = String(value ?? "");
    if (pythonStrip(id) !== id) return true;
  }
  return false;
}

/** Record that the project's ids have been repaired, once: a later call leaves the first time. */
export async function markLegacyIdsRepaired(
  db: ReturnType<typeof getDb>,
  projectId: number,
  now: string = new Date().toISOString(),
): Promise<void> {
  await db
    .update(projects)
    .set({ legacy_ids_repaired_at: now })
    .where(and(eq(projects.id, projectId), isNull(projects.legacy_ids_repaired_at)));
}
