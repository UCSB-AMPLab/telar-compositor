/**
 * This file is the read-only resource route backing the Site Status pill's
 * lazy popover payloads. The global pill derives its caption synchronously
 * from the `_app` loader; the heavy popover bodies (change manifest, sync
 * diff, in-sync commit metadata) are too expensive to compute on every
 * navigation, so they load only when a popover opens — via this loader.
 *
 * It is a resource route (loader only, NO default export) nested under the
 * `_app` layout, so it inherits `authMiddleware` (authenticated user +
 * token auto-refresh) and resolves the SESSION's active project exactly the
 * way the dashboard / publish routes do. A client-supplied projectId is
 * never trusted — the active project comes from `resolveActiveProject`
 * (which only returns projects the user is a member of) and membership is
 * re-verified with `getUserRole` before any manifest/diff is computed,
 * guarding against cross-project disclosure.
 *
 * The route is strictly read-only — it wraps the EXISTING server functions
 * (`computeChangeSummary`, `computeFullSyncDiff`) verbatim and performs zero
 * mutations. The `payload` query param is whitelisted against the four allowed
 * values; anything else is a 400. Three values serve lazy popover payloads (`unpublished`,
 * `out-of-sync`, `in-sync`); the fourth (`gh-status`) is the pill's
 * out-of-band GitHub refresh poll. On any GitHub error the `in-sync` payload
 * fails open: it returns the stored timestamps without the commit message
 * rather than erroring (mirrors the `_app` loader's fail-open posture).
 *
 * @version v1.3.0-beta
 */

import type { Route } from "./+types/api.site-status";
import { eq } from "drizzle-orm";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { decrypt } from "~/lib/crypto.server";
import { getUserRole } from "~/lib/membership.server";
import { resolveActiveProjectFromRequest } from "~/lib/active-project.server";
import { githubHeaders } from "~/lib/github.server";
import {
  stories,
  objects,
  project_pages,
  glossary_terms,
  project_config,
  projects,
} from "~/db/schema";
import {
  isStale,
  claimRefresh,
  refreshGithubStatus,
  deriveHeadDiverged,
  getCachedLatestTag,
  type DerivedGithubStatus,
} from "~/lib/github-status.server";
import { compareTelarVersion } from "~/lib/upgrade.server";
import { getInstallationInfo } from "~/lib/github-app.server";
import {
  computeChangeSummary,
  buildEntityHashes,
} from "~/lib/publish.server";
import type { PublishSnapshot } from "~/lib/publish.server";
import { computeFullSyncDiff } from "~/lib/sync.server";
import type { FullSyncDiff } from "~/lib/sync.server";

const GITHUB_API = "https://api.github.com";

/** Assembles currentState + snapshot and returns the real ChangeSummary.
 *  Shared by the `unpublished` popover payload and the `gh-status` count. */
async function loadChangeSummary(
  db: ReturnType<typeof getDb>,
  activeProject: typeof projects.$inferSelect,
) {
  const [storyRows, objectRows, pageRows, glossaryRows, configRow, entityHashes] =
    await Promise.all([
      db.select({ story_id: stories.story_id, title: stories.title, draft: stories.draft })
        .from(stories).where(eq(stories.project_id, activeProject.id)),
      db.select({ object_id: objects.object_id, title: objects.title })
        .from(objects).where(eq(objects.project_id, activeProject.id)),
      db.select({ slug: project_pages.slug, title: project_pages.title })
        .from(project_pages).where(eq(project_pages.project_id, activeProject.id)),
      db.select({ term_id: glossary_terms.term_id, title: glossary_terms.title })
        .from(glossary_terms).where(eq(glossary_terms.project_id, activeProject.id)),
      db.select().from(project_config).where(eq(project_config.project_id, activeProject.id)).limit(1),
      buildEntityHashes(db, activeProject.id),
    ]);

  const config = configRow[0] ?? null;
  const nonDraftStories = storyRows.filter((s) => !s.draft);
  const committablePages = pageRows
    .map((p) => ({ slug: (p.slug ?? "").trim(), title: p.title }))
    .filter((p) => p.slug.length > 0);

  const currentState = {
    entityHashes,
    config,
    stories: nonDraftStories.map((s) => ({ story_id: s.story_id, title: s.title })),
    objects: objectRows.map((o) => ({ object_id: o.object_id, title: o.title })),
    pages: committablePages,
    glossary: glossaryRows,
    allStoryIds: storyRows.map((s) => s.story_id),
  };

  const snapshot: PublishSnapshot | null = activeProject.publish_snapshot
    ? (JSON.parse(activeProject.publish_snapshot) as PublishSnapshot)
    : null;

  return computeChangeSummary(currentState, snapshot);
}

/** Counts changed entities across the ChangeSummary spectrum (0 when up to date). */
function countChangeSummary(summary: ReturnType<typeof computeChangeSummary>): number {
  const bucket = (b: { new: unknown[]; modified: unknown[]; deleted: unknown[] }) =>
    b.new.length + b.modified.length + b.deleted.length;
  let n =
    bucket(summary.stories) + bucket(summary.objects) +
    bucket(summary.pages) + bucket(summary.glossary);
  if (summary.settings.changed.length > 0) n += 1;
  if (summary.landing.changed) n += 1;
  if (summary.navigation.changed) n += 1;
  return n;
}

/**
 * Fail-open empty diff for the out-of-sync branch when the repo name is
 * malformed or the GitHub diff throws. `satisfies FullSyncDiff` makes
 * this fail to compile if the diff shape gains a required field, so it can't
 * silently drift. The pill's `aggregateSyncDiff` reads all-zero from it.
 */
const EMPTY_FULL_SYNC_DIFF = {
  objects: { newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [] },
  stories: { newStories: [], changedStories: [], missingStories: [] },
  config: { changedFields: [], versionChange: null },
  glossary: { added: [], removed: [], changed: [] },
  hasConflicts: false,
} satisfies FullSyncDiff;

/** The four payloads this route can serve. */
const ALLOWED_PAYLOADS = ["unpublished", "out-of-sync", "in-sync", "gh-status"] as const;
type PayloadKind = (typeof ALLOWED_PAYLOADS)[number];

function isAllowedPayload(value: string | null): value is PayloadKind {
  return value !== null && (ALLOWED_PAYLOADS as readonly string[]).includes(value);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  // authMiddleware (applied by the _app layout) guarantees a user here.
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);

  // Whitelist the only untrusted client input.
  const url = new URL(request.url);
  const payload = url.searchParams.get("payload");
  if (!isAllowedPayload(payload)) {
    throw new Response("Bad Request: unknown payload", { status: 400 });
  }

  // Resolve the active project from the SESSION — never a client-supplied id.
  // resolveActiveProject only ever returns projects the user is a member of
  // (it reads getUserProjects). We then re-verify membership explicitly with
  // getUserRole before computing anything, so a manifest/diff can never leak
  // across projects.
  const resolved = await resolveActiveProjectFromRequest(request, env, user.id);
  if (!resolved) {
    throw new Response("Not Found: no active project", { status: 404 });
  }
  const activeProject = resolved.project;

  const role = await getUserRole(db, activeProject.id, user.id);
  if (role === null) {
    throw new Response("Forbidden", { status: 403 });
  }

  switch (payload) {
    case "unpublished": {
      // Wrap the EXISTING change-summary path via the shared loadChangeSummary
      // helper. Read-only: we deliberately do NOT replicate the publish loader's
      // in-place snapshot upgrade.
      const summary = await loadChangeSummary(db, activeProject);
      return Response.json(summary);
    }

    case "out-of-sync": {
      // Wrap the EXISTING full-sync diff verbatim and return it raw — the pill
      // aggregates +/~/- client-side via aggregateSyncDiff. We do NOT
      // pre-aggregate, and we do NOT replicate the dashboard handler's
      // "bump head_sha when no changes" write (read-only).
      // Guard a malformed repo name (older imports / partial onboarding) and
      // fail open on any diff error rather than 500-ing — the in-sync branch
      // already does this; the out-of-sync branch must match.
      if (!activeProject.github_repo_full_name?.includes("/")) {
        return Response.json(EMPTY_FULL_SYNC_DIFF);
      }
      try {
        const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
        const [owner, repo] = activeProject.github_repo_full_name.split("/");
        const diff = await computeFullSyncDiff(
          activeProject.id,
          token,
          owner,
          repo,
          db,
        );
        return Response.json(diff);
      } catch {
        // Network/decrypt/diff failure — degrade to an empty diff (no nag).
        return Response.json(EMPTY_FULL_SYNC_DIFF);
      }
    }

    case "in-sync": {
      // Stored timestamps + head SHA come straight off the projects row (no
      // GitHub call needed). The commit MESSAGE for head_sha is not stored, so
      // fetch it lazily — and fail open: on any GitHub error, return the
      // timestamps WITHOUT the message rather than erroring.
      const base = {
        last_published_at: activeProject.last_published_at,
        head_sha: activeProject.head_sha,
        last_synced_at: activeProject.last_synced_at,
        commitMessage: null as string | null,
      };

      if (!activeProject.head_sha || !activeProject.github_repo_full_name?.includes("/")) {
        return Response.json(base);
      }

      try {
        const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
        const [owner, repo] = activeProject.github_repo_full_name.split("/");
        const res = await fetch(
          `${GITHUB_API}/repos/${owner}/${repo}/commits/${activeProject.head_sha}`,
          { headers: githubHeaders(token) },
        );
        if (!res.ok) {
          // Fail open — stored timestamps without the message.
          return Response.json(base);
        }
        const json = (await res.json()) as { commit?: { message?: string } };
        const message = json.commit?.message ?? null;
        return Response.json({ ...base, commitMessage: message });
      } catch {
        // Network/decrypt/parse failure — degrade to stored timestamps.
        return Response.json(base);
      }
    }

    case "gh-status": {
      // Out-of-band GitHub refresh endpoint. Reads the project's cached GitHub
      // status, refreshes it if stale (claim-deduped so concurrent tabs don't
      // each fire the waterfall), then derives and returns the pill's GitHub
      // status payload. Token is decrypted once and reused for both the refresh
      // waterfall and the latest-tag fetch. Auth guard is identical to all other
      // cases — resolveActiveProject + getUserRole above, preserving the
      // cross-project disclosure guard.
      const now = Date.now();

      // Real unpublished count (content-hash diff), computed independently of the
      // GitHub refresh so a GitHub failure doesn't drop it and vice versa. This is
      // the out-of-band correction the pill merges OVER the loader's cheap proxy.
      let unpublishedCount: number | undefined;
      try {
        unpublishedCount = countChangeSummary(await loadChangeSummary(db, activeProject));
      } catch {
        unpublishedCount = undefined; // keep the loader proxy on the client
      }

      let proj: typeof projects.$inferSelect | undefined; // hoisted so the catch can derive from it
      try {
        // Decrypt once; reuse for the refresh and the tag fetch.
        const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
        const projRows = await db.select().from(projects).where(eq(projects.id, activeProject.id)).limit(1);
        proj = projRows[0];
        if (proj && isStale(proj.gh_checked_at, now)) {
          const claimed = await claimRefresh(db, proj.id, now);
          if (claimed) {
            await refreshGithubStatus(proj, token, db, now);
            // Same claim window: refresh the workflows-permission cache that
            // drives the "approve updated permissions" login modal. App-JWT
            // call, off the per-navigation hot path. Fail-open — a failure
            // leaves the prior cache (cold reads as no-modal).
            try {
              const info = await getInstallationInfo(
                env.GITHUB_APP_ID,
                env.GITHUB_PRIVATE_KEY,
                proj.installation_id,
              );
              await db
                .update(projects)
                .set({
                  gh_workflows_write_missing: info.workflowsWrite ? 0 : 1,
                  gh_install_target_type: info.targetType,
                })
                .where(eq(projects.id, proj.id));
            } catch (permErr) {
              console.warn(
                "[gh-status] workflows-permission check failed",
                permErr,
              );
            }
          }
          // Re-read ONLY when a refresh may have written — the fresh-cache path
          // already has the right row.
          const freshRows = await db.select().from(projects).where(eq(projects.id, activeProject.id)).limit(1);
          proj = freshRows[0] ?? proj;
        }
        const configRows = await db
          .select({ telar_version: project_config.telar_version })
          .from(project_config)
          .where(eq(project_config.project_id, activeProject.id));
        const tag = await getCachedLatestTag(token, now);
        const cmp = compareTelarVersion(configRows[0]?.telar_version ?? null, tag);
        return Response.json({
          repoUnavailable: proj?.gh_repo_available === 0,
          headDiverged: proj ? deriveHeadDiverged(proj, proj.head_sha ?? null) : false,
          needsUpgrade: cmp.needsUpgrade,
          isBelowMinimum: cmp.isBelowMinimum,
          latestTelarTag: tag,
          unpublishedCount,
        } satisfies DerivedGithubStatus);
      } catch (err) {
        // Fail open like the sibling cases — but derive from whatever cache row we
        // read (agrees with the _app loader), NEVER neutral, so a transient poll
        // failure can't flip the pill from out-of-sync to in-sync. Upgrade signal
        // is dropped on error (safe direction); the loader + next poll recover it.
        console.warn("[gh-status] poll failed; returning cache-derived status", err);
        return Response.json({
          repoUnavailable: proj?.gh_repo_available === 0,
          headDiverged: proj ? deriveHeadDiverged(proj, proj.head_sha ?? null) : false,
          needsUpgrade: false,
          isBelowMinimum: false,
          latestTelarTag: null,
          unpublishedCount,
        } satisfies DerivedGithubStatus);
      }
    }
  }
}
