/**
 * Saves the site's own glossary kinds to `project_config.glossary_kinds_json`.
 *
 * Null in the column means the repository's `_config.yml` is the kinds'
 * source; a stored list, `[]` included, replaces it. A save names the column
 * as the client read it and is written only if the column still holds that,
 * so a save over someone else's is refused rather than lost. The kinds are
 * checked against the core kinds read here, not the client's copy, and a list
 * holding any kind the framework would leave out is refused whole: a rejected
 * kind is never stored. When nothing is stored yet, the save also rests on
 * the config: it is refused unless `_config.yml` was read, and unless its
 * site kinds are still the ones the client was shown, since a sync may have
 * brought newer ones without touching the column. The list being replaced
 * is the config's, rejected kinds included, so a kind fixed and renamed in its
 * first save still reports its old id.
 *
 * @version v1.5.0-beta
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { getDb } from "~/lib/db.server";
import { project_config, projects } from "~/db/schema";
import { isPublishingRole } from "~/lib/publishing-roles";
import {
  isAcceptedKind,
  serializeSiteKinds,
  storedSiteKinds,
  toSiteKind,
  validateSiteKinds,
  type GlossaryKinds,
  type SiteKindProblems,
} from "~/lib/glossary-kinds";

type Db = ReturnType<typeof getDb>;

export interface SaveKindsRequest {
  projectId: number;
  role: string | null;
  /** The column as the client read it. */
  base: string | null;
  /** With a null base, the config's site kinds as the client was shown them (`GlossaryKinds.repoSite`). */
  seenRepo?: string | null;
  /** The commit `readRepoKinds` reads at: a first save is written only while the project is still at it. */
  headSha: string | null;
  /** The kinds to store; each may name in `from` the id it had in the list it replaces. */
  kinds: unknown;
  /** The repository's kinds at the project's commit, its config's site kinds included. */
  readRepoKinds: () => Promise<GlossaryKinds>;
}

export type SaveKindsRefusal = "forbidden" | "malformed" | "unavailable" | "invalid" | "conflict";

export type SaveKindsResult =
  | { ok: true; stored: string; renamed: Record<string, string> }
  | {
      ok: false;
      reason: SaveKindsRefusal;
      message: "kinds_conflict" | "kinds_save_failed";
      problems?: SiteKindProblems[];
    };

const refused = (reason: SaveKindsRefusal, problems?: SiteKindProblems[]): SaveKindsResult => ({
  ok: false,
  reason,
  message: reason === "conflict" ? "kinds_conflict" : "kinds_save_failed",
  ...(problems ? { problems } : {}),
});

/**
 * What the column must still hold for a save to be written: `base`, or with
 * a null base, nothing while the project is still at the commit whose config
 * the save was checked against. A sync that moves the head in between may
 * have brought other kinds, and the save is then a conflict.
 */
function unchangedSince(request: SaveKindsRequest) {
  const column = project_config.glossary_kinds_json;
  if (request.base !== null) return eq(column, request.base);
  const head = sql`(SELECT ${projects.head_sha} FROM ${projects} WHERE ${projects.id} = ${request.projectId})`;
  return and(isNull(column), sql`${head} IS ${request.headSha}`);
}

/** Writes `stored` if nothing it rests on has changed; false when something has. */
async function swapKinds(db: Db, request: SaveKindsRequest, stored: string): Promise<boolean> {
  const written = await db
    .update(project_config)
    .set({ glossary_kinds_json: stored, updated_at: new Date().toISOString() })
    .where(and(eq(project_config.project_id, request.projectId), unchangedSince(request)))
    .returning({ id: project_config.id });
  return written.length > 0;
}

/** Old id to new id for each kind whose `from` names a kind of the replaced list under another id. */
function renamedIds(kinds: unknown[], replaced: unknown[]): Record<string, string> {
  const before = new Set(replaced.map((kind) => toSiteKind(kind).id).filter(Boolean));
  const renamed = new Map<string, string>();
  for (const entry of kinds) {
    const from = (entry as { from?: unknown } | null)?.from;
    const { id } = toSiteKind(entry);
    if (typeof from === "string" && before.has(from) && from !== id && !renamed.has(from)) renamed.set(from, id);
  }
  return Object.fromEntries(renamed);
}

/** Why a save over the config's kinds cannot rest on this read of them, or null when it can. */
function firstSaveRefusal(request: SaveKindsRequest, repo: GlossaryKinds): SaveKindsRefusal | null {
  if (request.base !== null) return null;
  if (repo.configInconclusive) return "unavailable";
  return request.seenRepo === repo.repoSite ? null : "conflict";
}

export async function saveGlossaryKinds(db: Db, request: SaveKindsRequest): Promise<SaveKindsResult> {
  if (!isPublishingRole(request.role)) return refused("forbidden");
  if (!Array.isArray(request.kinds)) return refused("malformed");
  const repo = await request.readRepoKinds();
  if (!repo.available) return refused("unavailable");
  const unsure = firstSaveRefusal(request, repo);
  if (unsure) return refused(unsure);
  const problems = validateSiteKinds(repo.core, request.kinds);
  if (!problems.every(isAcceptedKind)) return refused("invalid", problems);
  const stored = serializeSiteKinds(request.kinds);
  if (!(await swapKinds(db, request, stored))) return refused("conflict");
  const replaced = storedSiteKinds(request.base) ?? repo.site;
  return { ok: true, stored, renamed: renamedIds(request.kinds, replaced) };
}
