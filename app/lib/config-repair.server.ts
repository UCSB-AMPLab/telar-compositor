/**
 * Repair a site setting through the collaboration document.
 *
 * `url`, `baseurl` and `google_sheets_enabled` are document fields, and the
 * collaboration Durable Object's snapshot is the writer of their D1 columns.
 * A value written to D1 alone is overwritten by a warm document still holding
 * the old one, and rebuilding the document from D1 afterwards discards every
 * editor's changes since the last snapshot. So a repair is applied to the
 * document through `/ingest-sync`, which gates it, snapshots it to D1 and sends
 * it to every connected editor, and nothing is rebuilt.
 *
 * When the object does not confirm the repair, it is written to D1 directly,
 * as the repairs did before, and nothing is reset. A halted or unloadable
 * document persists nothing, so there the D1 write sticks, and the halted
 * project's restore rebuilds from D1 with it. An unreachable object, or one
 * whose snapshot failed after the change, leaves the D1 write exposed to a warm
 * document, as before.
 *
 * Best-effort: the callers repair after committing the same values to the
 * repository, and never fail on the repair.
 *
 * @version v1.5.0-beta
 */

import { eq } from "drizzle-orm";
import { project_config } from "~/db/schema";
import type { getDb } from "~/lib/db.server";
import { makeInternalMarkerHeaders } from "~/lib/internal-marker.server";

/** The settings a repair may write. Sheets is only ever turned off. */
export interface ConfigRepair {
  url?: string;
  baseurl?: string;
  google_sheets_enabled?: false;
}

export interface ConfigRepairEnv {
  SESSION_SECRET: string;
  COLLABORATION: {
    idFromName: (name: string) => unknown;
    get: (id: unknown) => { fetch: (request: Request) => Promise<Response> };
  };
}

/**
 * What the object said. `applied`: every value is in the document and D1.
 * `refused`: nothing the object did will reach D1, because it applied nothing
 * or it is halted, and a halted document persists nothing and is restored from
 * D1. `uncertain`: no answer that says which, or a snapshot that failed after
 * the change, so the document may hold some of the repair while D1 does not.
 * Either way D1 is written directly; the two differ in what the log says.
 */
export type ConfigRepairOutcome = "applied" | "refused" | "uncertain";

/** The body the object gives for a halt (`HALTED_BODY`, workers/collaboration.ts). */
const HALTED_BODY = "persistence_halted";

/** The repair's values as the ingest's config arm: a list of entries. */
function configEntries(values: ConfigRepair): Array<{ key: string; value: string | boolean }> {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({ key, value: value as string | boolean }));
}

/** An ingest answer's config counts, or null when it is not in that shape. */
interface ConfigCounts {
  applied: number;
  /** Entries refused or skipped. */
  declined: number;
  diagnostics: number;
}

function arrayAt(value: unknown, ...path: string[]): unknown[] | null {
  let at = value;
  for (const key of path) {
    if (typeof at !== "object" || at === null) return null;
    at = (at as Record<string, unknown>)[key];
  }
  return Array.isArray(at) ? at : null;
}

function configCounts(answer: unknown): ConfigCounts | null {
  const applied = typeof answer === "object" && answer !== null
    ? ((answer as { applied?: { config?: unknown } }).applied?.config)
    : undefined;
  const skipped = arrayAt(answer, "skipped", "config");
  const refused = arrayAt(answer, "refused", "config");
  const diagnostics = arrayAt(answer, "diagnostics");
  if (typeof applied !== "number" || skipped === null || refused === null || diagnostics === null) return null;
  return { applied, declined: skipped.length + refused.length, diagnostics: diagnostics.length };
}

/**
 * Read an ingest answer for `sent` config entries. `applied` only when it says
 * every one was applied and none refused or skipped; `refused` only when it
 * says none was applied and every one was refused or skipped; anything else,
 * a partial apply or a shape this does not recognise, is `uncertain`.
 */
function classifyAnswer(answer: unknown, sent: number): ConfigRepairOutcome {
  const counts = configCounts(answer);
  if (counts === null) return "uncertain";
  if (counts.applied === sent && counts.declined === 0 && counts.diagnostics === 0) return "applied";
  if (counts.applied === 0 && counts.declined === sent) return "refused";
  return "uncertain";
}

/** Send the repair to the object and read what it did. Never throws. */
export async function repairConfigThroughDocument(
  env: ConfigRepairEnv,
  projectId: number,
  values: ConfigRepair,
): Promise<ConfigRepairOutcome> {
  const config = configEntries(values);
  if (config.length === 0) return "applied";
  let res: Response;
  try {
    const headers = await makeInternalMarkerHeaders(projectId, env.SESSION_SECRET, "ingest-sync");
    const stub = env.COLLABORATION.get(env.COLLABORATION.idFromName(String(projectId)));
    res = await stub.fetch(
      new Request("https://internal/ingest-sync", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      }),
    );
  } catch {
    return "uncertain";
  }
  // A 503 is a halt, or a snapshot that failed or was blocked after the change.
  // A halted document persists nothing, so the halt applied nothing that can
  // reach D1; the other two leave the change in the document.
  if (res.status === 503) {
    const body = await res.text().catch(() => "");
    return body === HALTED_BODY ? "refused" : "uncertain";
  }
  if (!res.ok) return res.status >= 500 ? "uncertain" : "refused";
  let answer: unknown;
  try {
    answer = await res.json();
  } catch {
    return "uncertain";
  }
  return classifyAnswer(answer, config.length);
}

/**
 * Repair `values` through the document, and write them to D1 directly when the
 * object does not confirm it. Returns the object's outcome. Never throws.
 */
export async function repairSiteConfig(
  db: ReturnType<typeof getDb>,
  env: ConfigRepairEnv,
  projectId: number,
  values: ConfigRepair,
): Promise<ConfigRepairOutcome> {
  const outcome = await repairConfigThroughDocument(env, projectId, values);
  if (outcome === "applied") return outcome;
  console.warn(`[config-repair] project ${projectId}: the document did not confirm the repair (${outcome}); writing D1`);
  try {
    await db
      .update(project_config)
      .set({ ...values, updated_at: new Date().toISOString() })
      .where(eq(project_config.project_id, projectId));
  } catch (err) {
    console.error(`[config-repair] project ${projectId}: the D1 write failed`, err);
  }
  return outcome;
}
