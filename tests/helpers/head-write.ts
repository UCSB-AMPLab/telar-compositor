/**
 * Reads a refresh or publish write out of a fake database's `set` payload.
 *
 * A write that depends on the head it was computed against carries those
 * columns as SQL guarded on head_sha, which a fake database cannot evaluate:
 * head_sha itself as the compare-and-set `headAdvancedFrom` builds, and the
 * verdict columns as a CASE on the same head. This renders each and reports
 * the value it writes while the head holds and the head it is guarded on, so a
 * test can say both. What the SQL does against a real row is pinned against D1
 * in tests/workers/project-head-cas.test.ts.
 *
 * @version v1.5.0-beta
 */

import { SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";

const dialect = new SQLiteSyncDialect();

const GUARDED = /^CASE WHEN "projects"\."head_sha" IS \? THEN \? ELSE (.+) END$/;

const READ_WITH_HEAD =
  /^CASE WHEN "projects"\."head_sha" IS \? AND "projects"\."objects_read_sha" IS \? THEN \? ELSE "projects"\."objects_read_sha" END$/;

/**
 * The advance an objects_read_sha value expresses: to `to`, only while head_sha
 * is `head` and the record is `from`. Null for any other value.
 */
export function objectsReadAdvance(value: unknown): { head: string | null; from: string | null; to: string } | null {
  if (!(value instanceof SQL)) return null;
  const { sql, params } = dialect.sqlToQuery(value);
  if (!READ_WITH_HEAD.test(sql)) return null;
  return { head: params[0] as string | null, from: params[1] as string | null, to: params[2] as string };
}

/** A value written only while head_sha is `head`, or null for a plain value. */
export function guardedOnHead(value: unknown): { head: string | null; value: unknown; otherwise: string } | null {
  if (!(value instanceof SQL)) return null;
  const { sql, params } = dialect.sqlToQuery(value);
  const match = GUARDED.exec(sql);
  if (!match) return null;
  return { head: params[0] as string | null, value: params[1], otherwise: match[1] };
}

/** The compare-and-set a head_sha value expresses, or null for a plain value. */
export function headCas(value: unknown): { from: string | null; to: string } | null {
  const guarded = guardedOnHead(value);
  if (!guarded || guarded.otherwise !== '"projects"."head_sha"') return null;
  return { from: guarded.head, to: guarded.value as string };
}

/**
 * The payload with every head-guarded column replaced by the value it writes
 * while the head holds, and `<column>_while_head` added for the head it is
 * guarded on; head_sha's is named `head_sha_from`, the head it advances from.
 * objects_read_sha advancing with the head adds `objects_read_sha_from`, the
 * record it advances from, beside its `_while_head`. Plain values are left as
 * they are.
 */
export function readableHeadWrite(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload };
  for (const [column, value] of Object.entries(payload)) {
    const advance = objectsReadAdvance(value);
    if (advance) {
      out[column] = advance.to;
      out[`${column}_while_head`] = advance.head;
      out[`${column}_from`] = advance.from;
      continue;
    }
    const guarded = guardedOnHead(value);
    if (!guarded) continue;
    out[column] = guarded.value;
    out[column === "head_sha" ? "head_sha_from" : `${column}_while_head`] = guarded.head;
  }
  return out;
}
