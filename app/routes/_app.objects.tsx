/**
 * This file is the Objects route — the full IIIF object manager list
 * view, where the user browses every image, audio, and video object
 * in their project and edits metadata, featured status, and IIIF
 * source URLs.
 *
 * Loader fetches the active project's objects ordered by title ASC,
 * plus a step-reference count per `object_id` for "used in" info.
 * Action handles the `toggle-featured`, `compute-sync-diff`,
 * `sync-apply`, `fetch-iiif-preview`, `upload-image`, `commit-objects`,
 * and `poll-build` intents, among others. The page renders a table
 * view with thumbnails, sort/filter controls, featured-star toggles, a
 * slide-in edit panel, and a build progress banner.
 *
 * Registering an uploaded or synced object is the one action here
 * that does not reach D1 on its own: the committing actions and the
 * objects sync apply post the rows to the collaboration DO, which
 * appends them to the shared document and lets its snapshot write
 * them. `objects` has no unique index on `(project_id, object_id)`,
 * so a writer outside that gate can duplicate a key the snapshot is
 * minting with nothing to refuse it. The one column that cannot travel
 * that way — the D1-only `origin` — is patched in afterwards. Each
 * commit is recorded in `pending_object_ops` until its objects are
 * registered, and every committing action finishes earlier records
 * before it reads D1;
 * `insert-pending-objects` is the modal's retry of one record.
 *
 * As the daily home, this page also hosts the full-repo sync review
 * modal (SyncConfirmModal, opened via the `?sync=1` deep-link) — not
 * to be confused with this route's own objects-scoped SyncDiffDialog.
 * The modal's intents live on the /dashboard action; this page only
 * mounts it and surfaces the version-change toast.
 *
 * @version v1.5.0-beta
 */

import { and, asc, eq } from "drizzle-orm";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { redirect, useFetcher, useOutletContext, useRouteLoaderData, useSearchParams } from "react-router";
import * as Y from "yjs";
import { GraduationCap, RefreshCw } from "lucide-react";
import type { Route } from "./+types/_app.objects";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { readSiteTelarVersion } from "~/lib/site-version.server";
import { projects, objects, project_config, project_members, users } from "~/db/schema";
import { resolveActiveProjectFromRequest, siteChangedAnswer } from "~/lib/active-project.server";
import { gatePageSite } from "~/lib/page-site-gate.server";
import { setObjectFeatured } from "~/lib/object-featured.server";
import { useSiteFetcher } from "~/lib/page-site";
import { answerReadsWhenUnreachable, isUnreachableAnswer } from "~/lib/unreachable-write";
import { useRetryWhileUnreachable } from "~/lib/use-retry-unreachable";
import { isSiteChanged } from "~/components/features/site-status/SiteChangedNotice";
import { isPublishingRole } from "~/lib/publishing-roles";

import { readRepoWriteRefusal, readUploadRefusal } from "~/lib/upgrade-gate.server";
import { describeUploadNotice, describeUploadRefusalAction, uploadNotice } from "~/lib/upload-notice";
import type { RegistrationResult } from "~/lib/register-objects.server";
import {
  commitUnderRecord,
  completePendingObjectOps,
  countPendingObjectOps,
  finishRecordedRegistration,
  ObjectsSheetChanged,
  pendingObjectOpIdOf,
  prepareObjectsCommit,
  prepareRegistrationRecord,
  readObjectsSheetAt,
  readPendingObjectOp,
} from "~/lib/pending-object-ops.server";
import { repairSiteConfig } from "~/lib/config-repair.server";
import { compareSheetOrder, getObjectStepCounts, objectsSheetOrder } from "~/lib/objects.server";
import { configFrameworkVersion, configSiteBase, sharedSiteIds } from "~/lib/object-id";
import { readyTilesForProject } from "~/lib/tile-readiness.server";
import { requestObjectEnrichment } from "~/lib/object-enrichment.server";
import { useTileReadiness } from "~/hooks/use-tile-readiness";
import { useObjectEnrichment } from "~/hooks/use-object-enrichment";
import { ownValue } from "~/components/features/dashboard/sync-changes";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { useDocumentStepCounts } from "~/hooks/use-document-step-counts";
import { useSiteStatus } from "~/components/features/site-status/useSiteStatus";
import { useStructuralOps } from "~/hooks/use-structural-ops";
import { useYjsArraySync } from "~/hooks/use-yjs-array-sync";
import { useDocumentSource } from "~/hooks/use-document-source";
import { compareByOrderKey, readOrderKey } from "~/lib/field-order";
import { findYMapById, findYMapByIdOrTempId } from "~/lib/yjs-helpers";
import { writeObjectThumbnail } from "~/lib/object-thumbnail-refresh";
import { keyFor } from "~/lib/item-key";
import { useRemoteDeleteToast } from "~/hooks/use-remote-delete-toast";
import { useToast } from "~/hooks/use-toast";
import { DeleteConfirmationModal } from "~/components/ui/DeleteConfirmationModal";
import { DocsLink } from "~/components/ui/DocsLink";
import {
  SyncConfirmModal,
  SYNC_DIFF_FETCHER_KEY,
} from "~/components/features/dashboard/SyncConfirmModal";
import { useVersionChangeToast } from "~/hooks/use-version-change-toast";
import { useSyncApplyOutcome } from "~/hooks/use-sync-apply-outcome";
import { useCompletePendingObjects } from "~/hooks/use-complete-pending-objects";
import { fetchAndParseManifest } from "~/lib/iiif.server";
import { deriveStatus } from "~/lib/iiif-types";
import type { IiifFetchResult } from "~/lib/iiif-types";
import { decrypt } from "~/lib/crypto.server";
import { getFileContent, getFileOnDefaultBranch, getRepoHead } from "~/lib/github.server";
import { holdOperationLease, recordIfLeaseFree } from "~/lib/operation-lease.server";
import { syncedRowsFingerprint } from "~/lib/synced-rows-fingerprint.server";
import {
  computeSyncDiff, applySyncChanges, finishPendingBeforeCheck, checkRepairingLegacyIds, objectsBaseAt, ObjectsSyncStale, SyncBaseStale, SyncEntriesRefused, refuseMovedObjectsBase,
} from "~/lib/sync.server";
import { legacyRecordRef } from "~/lib/legacy-object-ids.server";
import { headConfigSheets, headHasGlossaryCsv, markSheetsEffects } from "~/lib/unreadable-characters.server";
import { syncFailure } from "~/lib/sync-failure.server";
import type { CollidingColumns } from "~/lib/sync-failure.server";
import { syncErrorToast } from "~/components/features/objects/sync-error-toast";
import { SheetChoicesDialog, choicesQuestionOf, type SheetChoicesQuestion } from "~/components/features/dashboard/SheetChoicesStep";
import { bumpObjectsReadFrom, bumpProjectHeadFrom } from "~/lib/github-status.server";
import { generateUniqueObjectSlug, slugify } from "~/lib/slugify";
import {
  commitFilesToRepo,
  dispatchWorkflow,
  listWorkflowRunsBySha,
  getJobSteps,
  mapStepsToBuildPhases,
  isGoogleSheetsEnabled,
  disableGoogleSheetsInConfig,
  verifySiteUrl,
  StaleHeadError,
} from "~/lib/commit.server";
import type { BuildPhaseStatus, WorkflowRun } from "~/lib/commit.server";
import { githubHeaders } from "~/lib/github.server";
import { resolveProjectToken } from "~/lib/github-app.server";
import { serializeObjectsCsv, dbObjectToCsvRow } from "~/lib/csv-export.server";
import { ManifestValidationNote } from "~/components/features/objects/ManifestValidationNote";
import { ObjectRow } from "~/components/features/objects/ObjectRow";
import { ObjectsEmptyState, ObjectsLoadingNote } from "~/components/features/objects/ObjectsEmptyState";
import { SyncDiffDialog } from "~/components/features/objects/SyncDiffDialog";
import { AddObjectDialog } from "~/components/features/objects/AddObjectDialog";
import { CommitAndBuildModal } from "~/components/features/objects/CommitAndBuildModal";
import type { ObjectRowObject } from "~/components/features/objects/ObjectRow";
import type { SyncDiff, SyncChanges, PendingObject } from "~/lib/sync.server";
import type {
  AddObjectIiifPayload,
  AddObjectExternalPayload,
} from "~/components/features/objects/AddObjectDialog";
import type { UploadImageConfirmPayload } from "~/lib/upload-types";
import { matchesObjectFilter } from "~/lib/objects-filter";
import { siteSheetFileAt } from "~/lib/site-sheets.server";
import { commitMultipleBinaryFilesWithCsv, createImageBlobs, arrayBufferToBase64, validateUploadFile } from "~/lib/upload.server";
import { storedExtensionFor, UPLOAD_ACCEPTED_FORMAT_LIST, uploadedSourceUrl } from "~/lib/file-types";
import type { SyncApplyPayload } from "~/components/features/objects/SyncDiffDialog";

// "dashboard" and "upgrade" ride along for the full-repo sync review modal
// this page hosts (SyncConfirmModal + its version-change toast).
export const handle = { i18n: ["common", "objects", "structural", "dashboard", "upgrade"] };

/**
 * What `sync-apply` answers for a failed apply. A check whose commit is not
 * GitHub's head, or whose base is no longer the project's objects_read_sha, is
 * `sync_stale`, which the page answers by checking again; an apply held back
 * for entries the Compositor cannot store is `entries_refused`; anything else
 * is the shared sync failure.
 */
function syncApplyFailure(err: unknown) {
  if (err instanceof ObjectsSyncStale || err instanceof SyncBaseStale) return { ok: false as const, intent: "sync-apply" as const, error: "sync_stale" as const };
  if (err instanceof SyncEntriesRefused) return syncFailure("sync-apply", err, "entries_refused");
  return syncFailure("sync-apply", err, "apply_failed");
}

/** The project's record of the last commit whose objects.csv D1 accounts for. */
function objectsReadShaOf(project: { objects_read_sha?: string | null }): string | null {
  return project.objects_read_sha ?? null;
}

/**
 * Advance the project's objects_read_sha to `readAt`, a commit whose
 * objects.csv object rows D1 now accounts for, from the record the page
 * loaded. Best-effort: a record left behind only refuses the next objects
 * commit, which the objects sync clears. Returns whether the record moved.
 */
async function recordObjectsRead(
  db: ReturnType<typeof getDb>,
  project: { id: number; objects_read_sha?: string | null },
  readAt: string | undefined,
  label: string,
): Promise<boolean> {
  if (!readAt) return false;
  try {
    return await bumpObjectsReadFrom(db, project.id, objectsReadShaOf(project), readAt);
  } catch (err) {
    console.error(`${label}: objects_read_sha write failed`, err);
    return false;
  }
}


/**
 * An objects check that finds nothing to bring in from GitHub: no new,
 * changed or missing object, no reorder, and no row still under a stripped id
 * whose repair did not land. Image files with no row are not
 * rows of objects.csv, so they do not count.
 */
function syncDiffBringsNothingIn(diff: SyncDiff): boolean {
  const listed = diff.newObjects.length + diff.changedObjects.length + diff.missingObjects.length;
  return listed === 0 && diff.reordered == null && diff.respelled === undefined;
}

/**
 * Record a landed objects commit: head_sha only from the commit it was built
 * on, since a parent other than the recorded head is a GitHub edit the
 * Compositor has not read, and objects_read_sha from the record the commit's
 * check compared against, since the commit's objects.csv is the one it wrote
 * from D1. Made under the objects lease the commit was made under, before it
 * is released. Best-effort: the commit has landed, so a D1 failure here must
 * not report it as failed.
 */
async function recordObjectsCommit(
  db: ReturnType<typeof getDb>,
  projectId: number,
  heads: { parent: string; readSha: string | null; committed: string },
  label: string,
): Promise<void> {
  try {
    await bumpProjectHeadFrom(db, projectId, heads.parent, heads.committed);
  } catch (err) {
    console.error(`${label}: head_sha write failed after commit`, err);
  }
  try {
    await bumpObjectsReadFrom(db, projectId, heads.readSha, heads.committed);
  } catch (err) {
    console.error(`${label}: objects_read_sha write failed after commit`, err);
  }
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);

  const resolved = await resolveActiveProjectFromRequest(request, env, user.id);
  if (!resolved) {
    // No active project — send to onboarding (which creates one). Must NOT
    // bounce to /dashboard: that route now redirects to /objects, which would
    // loop back here for a zero-project user.
    return redirect("/onboarding");
  }
  const { project: activeProject, userRole } = resolved;

  // Fetch all objects ordered by title ASC — matches the published Telar
  // objects index (objects-index.html sorts by title), so the manager list
  // and the live site agree. Objects are not reorderable; there is no order
  // field to sort by.
  const projectObjects = await db
    .select()
    .from(objects)
    .where(eq(objects.project_id, activeProject.id))
    .orderBy(asc(objects.title));

  // Team members for the delete confirmation contributor warning.
  const memberRows = await db
    .select({
      userId: project_members.user_id,
      name: users.github_name,
      login: users.github_login,
      contributions: project_members.contributions,
    })
    .from(project_members)
    .innerJoin(users, eq(project_members.user_id, users.id))
    .where(eq(project_members.project_id, activeProject.id));

  const members = memberRows.map((m) => ({
    userId: m.userId,
    name: m.name || m.login,
    contributions: m.contributions ? JSON.parse(m.contributions) : null,
  }));

  // Project config: the site base for self-hosted thumbnail URLs, and the
  // framework version that decides the id the site gives each object.
  const [config] = await db
    .select()
    .from(project_config)
    .where(eq(project_config.project_id, activeProject.id))
    .limit(1);
  const frameworkVersion = configFrameworkVersion(config);

  // The loader reads no manifest. External IIIF objects are filled from theirs
  // by the collaboration server, which the page asks once the document has
  // synced (`enrich-external`); self-hosted ones are ready when their tiles
  // answer on the deployed site, which the page asks too (`probe-tiles`).

  // Objects in the order a publish writes them to objects.csv, which decides
  // the row the site shows where two share its id.
  const inSheetOrder = [...projectObjects].sort(compareSheetOrder);

  // Count step references per object_id, scoped to the active project (a
  // global count would inflate shared seeded slugs like `telar-placeholder`).
  const objectStepCounts = await getObjectStepCounts(db, activeProject.id, inSheetOrder, frameworkVersion);

  const siteBaseUrl = configSiteBase(config);

  // The page asks for these to be completed (`complete-pending-objects`); the
  // loader only counts them.
  const pendingObjectOps = await countPendingObjectOps(db, activeProject.id);

  return {
    project: activeProject,
    objects: projectObjects,
    objectStepCounts,
    siteBaseUrl,
    frameworkVersion,
    sharedSiteIds: Object.fromEntries(sharedSiteIds(inSheetOrder, frameworkVersion)),
    members,
    currentUserId: user.id,
    userRole,
    pendingObjectOps,
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

/**
 * The reads this page makes in the background, answered in the browser: one
 * that fails in transit (the request never completes, a bare 5xx, an
 * undecodable answer) is answered unreachable, with its intent and status 503
 * (`answerReadsWhenUnreachable`), so the page and the commit dialog stay open
 * and ask again. `enrich-external` is answered the same way: the page writes
 * nothing through it and asks it in the background, and a later visit asks
 * again. Every other intent reaches the server action unchanged: those write.
 */
export async function clientAction({ request, serverAction }: Route.ClientActionArgs) {
  return answerReadsWhenUnreachable(request, serverAction, [
    "poll-build",
    "pre-commit-check",
    "compute-sync-diff",
    "fetch-iiif-preview",
    "probe-tiles",
    "enrich-external",
  ]);
}

/** The pre-commit check's answer when `_config.yml` could not be read: not "Sheets off". */
const PRE_COMMIT_UNREACHABLE = { ok: false as const, reason: "unreachable" as const, intent: "pre-commit-check" as const };

/** The pre-commit check's answer when the site has no project or no `_config.yml`. */
const PRE_COMMIT_NOTHING_TO_CHECK = {
  ok: true as const,
  intent: "pre-commit-check" as const,
  sheetsEnabled: false,
  objectsFile: "objects.csv",
  urlCheck: { match: true, pagesUrl: "", configUrl: "" },
};

/**
 * The pre-commit check. It is read-only. A read of `_config.yml` that fails
 * is answered unreachable, never as Sheets off: the commit posts
 * `disableSheets` from this answer. Membership-aware resolution (no
 * first-owned-project fallback) has already produced `resolved`.
 */
async function answerPreCommitCheck(
  resolved: { project: { installation_id: number; github_repo_full_name: string }; userRole: string | null } | null,
  user: { encrypted_access_token: string },
  env: Env,
) {
  if (!resolved) return PRE_COMMIT_NOTHING_TO_CHECK;
  try {
    // A collaborator's own token may have no read access to a private repo —
    // reading it here would otherwise skip the check rather than run it.
    const userToken = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
    const token = await resolveProjectToken(
      env.GITHUB_APP_ID,
      env.GITHUB_PRIVATE_KEY,
      resolved.project.installation_id,
      userToken,
      resolved.userRole,
    );
    const [owner, repo] = resolved.project.github_repo_full_name.split("/");

    const read = await getFileOnDefaultBranch(token, owner, repo, "_config.yml");
    if (read.status === "error") return PRE_COMMIT_UNREACHABLE;
    if (read.status === "absent") return PRE_COMMIT_NOTHING_TO_CHECK;

    const sheetsEnabled = isGoogleSheetsEnabled(read.content);
    // The commit rewrites the file the site holds: objects.csv, else objetos.csv.
    const objectsFile = (await siteSheetFileAt("objects", (path) => getFileOnDefaultBranch(token, owner, repo, path))).name;
    const urlCheck = await verifySiteUrl(token, owner, repo, read.content);
    if (urlCheck.readFailed) return PRE_COMMIT_UNREACHABLE;
    // Without a Pages site (Pages off, or a read that was refused) there is no
    // Pages URL to compare, so there is no mismatch to show; the dialog has no
    // message for Pages being off, and retrying would not change the answer.
    if (!urlCheck.pagesEnabled) {
      return { ok: true as const, intent: "pre-commit-check" as const, sheetsEnabled, objectsFile, urlCheck: { ...urlCheck, match: true } };
    }
    return { ok: true as const, intent: "pre-commit-check" as const, sheetsEnabled, objectsFile, urlCheck };
  } catch {
    // A check that could not be made answers neither "off" nor "matches".
    return PRE_COMMIT_UNREACHABLE;
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // Intents skipped by the page-site check below. `toggle-featured` acts on
  // the object row's own site; `fetch-iiif-preview` reads a manifest and acts
  // on no site; `insert-pending-objects` compares the commit's own site.
  const PAGE_SITE_EXEMPT = ["toggle-featured", "fetch-iiif-preview", "insert-pending-objects"];

  // Every other intent acts on the session's site, and only when the page
  // that posted it showed that site. `null` is the no-project case, which each
  // intent answers in its own shape.
  const gate = await gatePageSite(request, env, user.id, formData, intent, PAGE_SITE_EXEMPT);
  if (gate.refused) return gate.refused;
  const page = gate.page;

  switch (intent) {
    case "toggle-featured":
      await setObjectFeatured(
        db,
        user.id,
        Number(formData.get("objectDbId")),
        formData.get("currentValue") !== "true",
      );
      return { ok: true, intent: "toggle-featured" };

    case "compute-sync-diff": {
      // Membership-aware resolution — the old owner-only query with the
      // ?? allProjects[0] fallback could diff the WRONG owned project when
      // the session id pointed elsewhere. Sync is convenor-only in the UI;
      // enforce the same here.
      const resolvedDiff = page;
      if (!resolvedDiff) {
        return { ok: false, intent: "compute-sync-diff", error: "no_project" };
      }
      if (resolvedDiff.userRole !== "convenor") {
        return { ok: false, intent: "compute-sync-diff", error: "forbidden" };
      }
      const activeProject = resolvedDiff.project;

      try {
        const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
        const [owner, repo] = activeProject.github_repo_full_name.split("/");
        await finishPendingBeforeCheck(env, db, activeProject.id, user.id, { token, owner, repo });
        // Everything in D1 the check compares, taken before it reads any of
        // it, the site's version included: a write landing during the check's
        // reads, or after them, answers a different fingerprint at the record
        // below.
        const compared = await syncedRowsFingerprint(db, activeProject.id);
        const version = { d1: await readSiteTelarVersion(db, activeProject.id) };
        // Three-way against the commit whose objects.csv D1 last accounted
        // for, as the full sync compares against its recorded base; two-way
        // where there is no record or GitHub does not hold the commit.
        const recorded = await objectsBaseAt(token, owner, repo, objectsReadShaOf(activeProject));
        // The first check on the project gives rows an earlier import stored
        // under a stripped id GitHub's spelling, with nothing offered.
        const diff = await checkRepairingLegacyIds(
          env,
          activeProject.id,
          user.id,
          (legacyRef) => computeSyncDiff(
            activeProject.id, token, owner, repo, db, recorded, undefined, true, version, legacyRef,
          ),
          (checked) => checked,
          { db, open: activeProject.legacy_ids_repaired_at == null, ref: legacyRecordRef(activeProject) },
        );
        // Google Sheets as the build reads it: from _config.yml at the head
        // the check read.
        await markSheetsEffects(diff.warnings, headConfigSheets(token, owner, repo, diff.headSha), undefined, headHasGlossaryCsv(token, owner, repo, diff.headSha));
        // D1 already holds everything the commit's objects.csv holds. Recorded
        // only under the objects lease, and only while D1 is as it was before
        // the check read it (`recordIfLeaseFree`, `compared`).
        const advanced = syncDiffBringsNothingIn(diff) && await recordIfLeaseFree(
          env, activeProject.id, user.id, "objects",
          async () => (await syncedRowsFingerprint(db, activeProject.id)) === compared
            && recordObjectsRead(db, activeProject, diff.headSha, "compute-sync-diff"),
        );
        // The base the apply must still find: the record as this check left it.
        const baseSha = advanced ? diff.headSha ?? null : objectsReadShaOf(activeProject);
        return { ok: true, intent: "compute-sync-diff", diff: { ...diff, baseSha } };
      } catch (err) {
        return await (await import("~/lib/sheet-choices.server")).refusalOrChoices("compute-sync-diff", err, "sync_failed", { env, user, project: activeProject });
      }
    }

    case "sync-apply": {
      const changesJson = formData.get("changes") as string;
      if (!changesJson) {
        return { ok: false, intent: "sync-apply", error: "missing_changes" };
      }

      let changes: SyncChanges;
      try {
        changes = JSON.parse(changesJson) as SyncChanges;
      } catch {
        return { ok: false, intent: "sync-apply", error: "invalid_changes" };
      }

      // Membership-aware resolution + convenor gate (matches the UI; the old
      // owner-only query could apply sync changes to the wrong owned project).
      const resolvedApply = page;
      if (!resolvedApply) {
        return { ok: false, intent: "sync-apply", error: "no_project" };
      }
      if (resolvedApply.userRole !== "convenor") {
        return { ok: false, intent: "sync-apply", error: "forbidden" };
      }
      const activeProject = resolvedApply.project;

      try {
        const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
        const [owner, repo] = activeProject.github_repo_full_name.split("/");

        await refuseMovedObjectsBase(db, activeProject.id, changes);
        // The apply holds the objects lease and changes the document on the
        // server; the page removes nothing.
        const applied = await applySyncChanges(
          activeProject.id,
          changes,
          token,
          owner,
          repo,
          db,
          env,
          user.id,
        );
        // The apply recorded objects_read_sha under its lease
        // (`readRecorded`); false is a record another writer moved first, so
        // what the apply landed is not recorded as read and the page says so.
        return {
          ok: true,
          intent: "sync-apply",
          projectId: activeProject.id,
          appliedCount: applied.appliedCount,
          pendingObjects: applied.pendingObjects,
          notAdded: applied.notAdded,
          changedSinceReview: applied.changedSinceReview ?? [],
          ...(applied.readRecorded === false ? { readNotRecorded: true as const } : {}),
        };
      } catch (err) {
        return syncApplyFailure(err);
      }
    }

    case "fetch-iiif-preview": {
      const url = (formData.get("url") as string | null)?.trim();
      if (!url) {
        return { ok: false, intent: "fetch-iiif-preview", error: "missing_url" };
      }

      const result = await fetchAndParseManifest(url);
      return { ok: true, intent: "fetch-iiif-preview", result };
    }

    // add-iiif-object: migrated to Yjs. IIIF objects now flow through
    // ops.addIiifObject → Y.Array with _validation_state. The snapshotToD1
    // cycle INSERTs them once validation succeeds. Any clients on old code
    // that still submit this intent hit the 400 default below. Self-hosted
    // uploads continue to use upload-image.

    // delete-object: not handled here. The delete lives on the object's own
    // detail route, where the document write and the repository cleanup are
    // ordered against each other; a direct `db.delete(objects)` from this
    // route would race the snapshot that owns the row. No client submits the
    // intent, so it reaches the 400 default below.

    case "upload-image": {
      // 1. Parse multipart form data — supports multiple image files (multi-image batch)
      const imageFiles = formData.getAll("imageFile") as File[];
      const metadataArrayJson = formData.get("metadataArray") as string | null;

      if (!imageFiles.length || !metadataArrayJson) {
        return { ok: false, intent: "upload-image", error: "missing_data" };
      }

      // Cap batch size to prevent excessive API calls and memory usage
      const MAX_BATCH = 10;
      if (imageFiles.length > MAX_BATCH) {
        return { ok: false, intent: "upload-image", error: "batch_too_large" };
      }

      // 2. Server-side validation for each file (validate all before processing)
      for (const imageFile of imageFiles) {
        const uploadValidationError = validateUploadFile(imageFile);
        if (uploadValidationError) {
          return { ok: false, intent: "upload-image", error: uploadValidationError };
        }
      }

      let metadataArray: Array<{
        objectId: string;
        title: string;
        creator: string;
        description: string;
        source: string;
        credit: string;
        period: string;
        year: string;
        altText: string;
      }>;
      try {
        const parsed = JSON.parse(metadataArrayJson);
        if (!Array.isArray(parsed)) {
          return { ok: false, intent: "upload-image", error: "missing_data" };
        }
        metadataArray = parsed;
      } catch {
        return { ok: false, intent: "upload-image", error: "missing_data" };
      }

      if (metadataArray.length !== imageFiles.length) {
        return { ok: false, intent: "upload-image", error: "missing_data" };
      }

      for (const metadata of metadataArray) {
        if (!metadata || typeof metadata !== "object") {
          return { ok: false, intent: "upload-image", error: "missing_data" };
        }
        if (!metadata.title?.trim()) {
          return { ok: false, intent: "upload-image", error: "title_required" };
        }
      }

      // 3. Get active project — membership-aware, no first-owned-project
      // fallback (the old owner-only query + ?? allProjects[0] could target
      // the wrong project on a stale session). A publishing role — every
      // admitted role is named in the set, never inferred.
      const resolvedUpload = page;
      if (!resolvedUpload) {
        return { ok: false, intent: "upload-image", error: "no_project" };
      }
      const uploadActiveProject = resolvedUpload.project;

      // May this person upload to this site now. Uploading commits to the
      // repository and dispatches its build, so a site behind the latest
      // release, or one whose release cannot be read, is refused here as
      // well as by the Upload tab's notice: that notice is only as current as
      // the load that drew the page, and on a cold tag cache the loader's
      // reading is provisional.
      const uploadRefusal = await readUploadRefusal(db, env, {
        project: uploadActiveProject,
        userRole: resolvedUpload.userRole,
        encryptedToken: user.encrypted_access_token,
      });
      if (uploadRefusal) {
        return { ok: false, intent: "upload-image", error: uploadRefusal };
      }

      // Everything from here to the commit runs inside try/catch: decrypt,
      // slug generation (D1 queries), file reads, the CSV fetch and the D1
      // object listing can all throw, and an uncaught throw becomes an opaque
      // 500. Issue #25's report ("check your connection", deterministic)
      // came from failures in this region being either thrown or collapsed.
      try {
      const uploadToken = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
      const [uploadOwner, uploadRepo] = uploadActiveProject.github_repo_full_name.split("/");
      const uploadReadSha = objectsReadShaOf(uploadActiveProject);

      // Every read and the eventual commit run on the installation token: a
      // collaborator's own token has no write access to the convenor's
      // repository, and on a private repo may have no read access either.
      // The user token is a fallback for the convenor only, matching
      // _app.upgrade.tsx's resolveDispatchToken.
      const uploadCommitToken = await resolveProjectToken(
        env.GITHUB_APP_ID,
        env.GITHUB_PRIVATE_KEY,
        uploadActiveProject.installation_id,
        uploadToken,
        resolvedUpload.userRole,
      );

      // 4. Generate unique object IDs for each image and build pending objects
      const uploadPendingObjects: PendingObject[] = [];
      const imagePayloads: Array<{ imagePath: string; imageBase64: string }> = [];

      for (let i = 0; i < imageFiles.length; i++) {
        const imageFile = imageFiles[i];
        const metadata = metadataArray[i];

        // Normalise the user-typed id with the same slugifier used for
        // titles — users type "Mission Bell #2" in good faith, and rejecting
        // it was issue #25's deterministic failure. Fall back to the title,
        // then to "object" for titles with no ASCII alphanumerics
        // (slugify("中文") === ""). generateUniqueObjectSlug appends -2, -3…
        // on collision; each call sees previously generated IDs via DB.
        const requestedSlug =
          slugify(metadata.objectId, 0) || slugify(metadata.title) || "object";
        const uploadObjectId = await generateUniqueObjectSlug(requestedSlug, uploadActiveProject.id, db);

        // Backstop: slug must stay path-safe (no traversal, only lowercase
        // alphanumerics + hyphens). With the normalisation above this should
        // be unreachable for real input.
        const safeSlugPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
        if (!safeSlugPattern.test(uploadObjectId)) {
          return { ok: false, intent: "upload-image", error: "invalid_object_id" };
        }

        // 5. Derive file extension from MIME type (not filename) to prevent
        // extension spoofing. The mapping is the one in `~/lib/file-types`, so
        // the stored extension can never disagree with what upload accepts.
        const ext = storedExtensionFor(imageFile.type);
        const imagePath = `telar-content/objects/${uploadObjectId}.${ext}`;

        // 6. Read binary and encode to base64
        const arrayBuffer = await imageFile.arrayBuffer();
        const imageBase64 = arrayBufferToBase64(arrayBuffer);

        imagePayloads.push({ imagePath, imageBase64 });

        // 7. Build pending object (NOT inserted to D1 yet)
        uploadPendingObjects.push({
          object_id: uploadObjectId,
          title: metadata.title.trim(),
          featured: false,
          creator: metadata.creator.trim() || null,
          description: metadata.description.trim() || null,
          source_url: uploadedSourceUrl(uploadObjectId, ext),
          period: metadata.period.trim() || null,
          year: metadata.year.trim() || null,
          object_type: null,
          subjects: null,
          source: metadata.source.trim() || null,
          credit: metadata.credit.trim() || null,
          thumbnail: null,
          alt_text: metadata.altText.trim() || metadata.title.trim(),
          image_available: false,
        });
      }

      // 8. The images' blobs first: they change nothing in the repository
      // until a tree names them, so they are made before the lock is taken,
      // and the lock covers only the reads and the commit.
      const imageBlobs = await createImageBlobs({
        token: uploadCommitToken, owner: uploadOwner, repo: uploadRepo, images: imagePayloads,
      });

      // From here until the objects are registered, no publish or upgrade may
      // begin, and this upload does not begin during one: the CSV is
      // assembled from a read of the repository and of D1, and a publish
      // landing in between, or reading D1 before the registration, would
      // write the other's objects.csv over it. Editors do not wait on it.
      const uploaded = await holdOperationLease(env, uploadActiveProject.id, user.id, "objects", async (landed) => {
        // 9. Read at one head and commit on it, so a commit that landed since
        // the read is refused as stale rather than written over. The sheet is
        // read strictly: a failed read taken for a missing file would rewrite
        // objects.csv without its comment and instruction rows.
        // Earlier operations whose objects D1 may still lack are finished
        // before D1 is read, or the CSV written from it drops them. Object
        // rows GitHub has that D1 does not account for refuse the upload.
        const uploadHead = await getRepoHead(uploadCommitToken, uploadOwner, uploadRepo, "main");
        const uploadCsv = await prepareObjectsCommit(env, db, uploadActiveProject.id, {
          token: uploadCommitToken, owner: uploadOwner, repo: uploadRepo, head: uploadHead,
        }, { unreadCheck: { readSha: uploadReadSha } });

        // In the order a publish writes objects.csv, the new rows after the
        // existing ones in the order they were added (`objectsSheetOrder`).
        const uploadProjectObjects = await db.select().from(objects)
          .where(eq(objects.project_id, uploadActiveProject.id))
          .orderBy(objectsSheetOrder());
        const uploadExportableObjects = uploadProjectObjects.filter((o) => !o.missing_from_repo);

        const uploadAllObjectsForCsv = [
          ...uploadExportableObjects,
          ...uploadPendingObjects.map((p) => ({
            ...p,
            alt_text: p.alt_text ?? null,
            missing_from_repo: false,
          })),
        ];

        const uploadCsvContent = serializeObjectsCsv(
          uploadAllObjectsForCsv.map(dbObjectToCsvRow), uploadCsv.existingCsv,
        );

        // The record that outlives a registration this action cannot finish.
        const uploadOpId = await prepareRegistrationRecord(db, {
          projectId: uploadActiveProject.id,
          objects: uploadPendingObjects,
          parentSha: uploadHead,
          actorId: user.id,
        });

        // All images and the CSV in a single Git commit, on the same
        // installation token resolved above.
        const commitLabel = uploadPendingObjects.map((p) => p.object_id).join(", ");
        const commitResult = await commitUnderRecord(db, uploadOpId, () =>
          commitMultipleBinaryFilesWithCsv({
            token: uploadCommitToken,
            owner: uploadOwner,
            repo: uploadRepo,
            branch: "main",
            images: imagePayloads,
            imageBlobs,
            expectedHeadSha: uploadHead,
            csvPath: uploadCsv.path,
            csvContent: uploadCsvContent,
            commitMessage: `Add ${commitLabel} via Telar Compositor`,
          }),
        );
        landed();

        // 10. Register the objects now that their commit has landed, whatever
        // the build then does. Never throws.
        const registration = await finishRecordedRegistration(
          env, db, uploadActiveProject.id, user.id, uploadPendingObjects,
          uploadOpId, commitResult.newHeadSha,
        );
        // Recorded before the lease is released: a sync apply records what
        // it applied under the same lease, and the two move the same columns.
        await recordObjectsCommit(db, uploadActiveProject.id, {
          parent: uploadHead, readSha: uploadReadSha, committed: commitResult.newHeadSha,
        }, "upload-image");
        return { commitResult, registration, operationId: uploadOpId };
      });
      if (uploaded.refused) {
        return { ok: false, intent: "upload-image", error: "operation_in_progress" };
      }
      const {
        commitResult: uploadCommitResult,
        registration: uploadRegistration,
        operationId: uploadOperationId,
      } = uploaded.value;

      // 11. Dispatch IIIF-only workflow and capture run ID for direct polling
      let dispatchRunId: number | null = null;
      let dispatchHtmlUrl: string | null = null;
      try {
        const dispatch = await dispatchWorkflow(uploadCommitToken, uploadOwner, uploadRepo, "build.yml");
        dispatchRunId = dispatch.runId || null;
        dispatchHtmlUrl = dispatch.htmlUrl || null;
      } catch {
        // Non-fatal: tiles will generate on next full build
      }

      // 12. Return the objects and their registration for CommitAndBuildModal,
      //     which retries a failed registration and tracks the build.
      return {
        ok: true,
        intent: "upload-image",
        projectId: uploadActiveProject.id,
        registration: uploadRegistration,
        operationId: uploadOperationId,
        objectId: uploadPendingObjects[0].object_id,
        newHeadSha: uploadCommitResult.newHeadSha,
        pendingObject: uploadPendingObjects[0],
        pendingObjects: uploadPendingObjects,
        dispatchRunId,
        dispatchHtmlUrl,
      };
      } catch (err) {
        // Nothing is registered before the commit lands, so a failure here
        // leaves nothing to roll back. The operation's record, if the commit
        // was attempted, is settled by `commitUnderRecord`. Object rows
        // changed on GitHub are refused as a head that moved: the objects sync
        // clears both.
        if (err instanceof StaleHeadError || err instanceof ObjectsSheetChanged) {
          return { ok: false, intent: "upload-image", error: "stale_head" };
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("413") || msg.includes("too large")) {
          return { ok: false, intent: "upload-image", error: "payload_too_large" };
        }
        return { ok: false, intent: "upload-image", error: "upload_failed" };
      }
    }

    case "probe-tiles": {
      const { site, ready, notFound } = await readyTilesForProject(db, env, user, page, formData.get("objectIds"));
      return { ok: true as const, intent: "probe-tiles" as const, site, ready, notFound };
    }

    case "enrich-external":
      return { ok: await requestObjectEnrichment(env, page), intent: "enrich-external" as const };

    case "pre-commit-check":
      return answerPreCommitCheck(page, user, env);

    case "commit-objects": {
      // Membership-aware resolution (the old owner-only query could commit
      // to the wrong owned project on a stale session). A publishing role —
      // every admitted role is named in the set, never inferred.
      const resolvedCommit = page;
      if (!resolvedCommit) {
        return { ok: false, intent: "commit-objects", error: "no_project" };
      }
      if (!isPublishingRole(resolvedCommit.userRole)) {
        return { ok: false, intent: "commit-objects", error: "forbidden" };
      }
      const activeProject = resolvedCommit.project;

      // The commit rewrites objects.csv and dispatches the site's build, so a
      // site behind the latest release, or one whose release cannot be read,
      // is refused before the lease is taken and anything is read or written.
      const commitRefusal = await readRepoWriteRefusal(db, env, {
        project: activeProject,
        userRole: resolvedCommit.userRole,
        encryptedToken: user.encrypted_access_token,
      });
      if (commitRefusal) {
        return { ok: false, intent: "commit-objects", error: commitRefusal };
      }

      const disableSheets = formData.get("disableSheets") === "true";

      // These escape the leased block below: the post-commit dispatch and the
      // answer need them. The block either assigns them all or returns the
      // failure it met, which is answered before any is read.
      let token!: string;
      let owner!: string;
      let repo!: string;
      let commitResult!: { newHeadSha: string };
      // The head the commit was built on.
      let commitParent!: string;
      // The record the commit's check compared GitHub's object rows against.
      const commitReadSha = objectsReadShaOf(activeProject);
      let pendingObjects: PendingObject[] = [];
      let commitRegistration!: RegistrationResult;
      // The record of this commit's objects, when it carries any.
      let commitOpId: number | null = null;
      // The site URL the commit fixes, written to D1 only once the commit lands.
      let fixedUrl: { url: string; baseurl: string } | null = null;

      // From here until the objects are registered and the Sheets flag
      // repaired, no publish or upgrade may begin, and this commit does not
      // begin during one. Editors do not wait on it.
      const committed = await holdOperationLease(env, activeProject.id, user.id, "objects", async (landed) => {
      try {
      token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
      [owner, repo] = activeProject.github_repo_full_name.split("/");

      // Every read below and the eventual commit run on the installation
      // token: a collaborator's own token has no write access to the
      // convenor's repository, and on a private repo may have no read
      // access either. The user token is a fallback for the convenor only,
      // matching the upload flow and _app.upgrade.tsx's resolveDispatchToken
      // — a mint failure for a collaborator surfaces as commit_failed below
      // instead of a token guaranteed to fail at GitHub.
      const commitToken = await resolveProjectToken(
        env.GITHUB_APP_ID,
        env.GITHUB_PRIVATE_KEY,
        activeProject.installation_id,
        token,
        resolvedCommit.userRole,
      );

      // Server-side recheck — supersedes client-passed fixUrl/pagesUrl.
      // The client form fields (CommitAndBuildModal: fixUrl, pagesUrl) are
      // derived from a `pre-commit-check` fired on mount; if the user opens
      // the modal hours later or the repo's _config.yml has been edited
      // externally, those flags are stale. We re-run verifySiteUrl here with
      // a freshly fetched _config.yml and override the fix flags from that
      // result. The fetched configContent is reused by the rewrite block
      // below, avoiding a second getFileContent round-trip.
      // (image-upload flow)
      // Read at one head and commit on it, so a commit that landed since the
      // reads is refused as stale rather than written over.
      const commitHead = await getRepoHead(commitToken, owner, repo, "main");
      commitParent = commitHead;
      let configContent = await getFileContent(commitToken, owner, repo, "_config.yml", commitHead);
      let fixUrl = false;
      let pagesUrl: string | null = null;
      if (configContent) {
        const urlCheck = await verifySiteUrl(commitToken, owner, repo, configContent);
        if (urlCheck.pagesEnabled && !urlCheck.match) {
          fixUrl = true;
          pagesUrl = urlCheck.pagesUrl;
        }
      }

      // Read objects.csv strictly at the same head: a failed read taken for a
      // missing file would rewrite it without its comment and instruction
      // rows. Object rows GitHub has that D1 does not account for refuse the
      // commit. Then finish earlier operations whose objects D1 may still
      // lack, before D1 is read, or the CSV written from it drops them.
      const commitCsv = await prepareObjectsCommit(env, db, activeProject.id, {
        token: commitToken, owner, repo, head: commitHead,
      }, { unreadCheck: { readSha: commitReadSha } });

      // Parse pending objects from form data (not yet in D1)
      const pendingJson = formData.get("pendingObjects") as string | null;
      pendingObjects = pendingJson ? JSON.parse(pendingJson) : [];

      // Query existing D1 objects, excluding missing_from_repo
      const projectObjects = await db
        .select()
        .from(objects)
        .where(eq(objects.project_id, activeProject.id))
        .orderBy(objectsSheetOrder());

      const exportableObjects = projectObjects.filter((o) => !o.missing_from_repo);

      // Existing D1 objects, then the pending ones in the order they were
      // added: the order a publish writes objects.csv (`objectsSheetOrder`).
      const allObjectsForCsv = [
        ...exportableObjects,
        ...pendingObjects.map((p) => ({
          ...p,
          alt_text: p.alt_text ?? null,
          missing_from_repo: false,
        })),
      ];

      // The existing CSV's comment and instruction rows are preserved.
      const csvContent = serializeObjectsCsv(allObjectsForCsv.map(dbObjectToCsvRow), commitCsv.existingCsv);

      const files: Array<{ path: string; content: string }> = [
        { path: commitCsv.path, content: csvContent },
      ];

      const commitParts = [`Updated ${commitCsv.path.slice(commitCsv.path.lastIndexOf("/") + 1)}`];

      // Check if _config.yml needs modification (sheets or URL fix).
      // Reuses the outer `configContent` fetched above for the URL recheck,
      // so _config.yml is only fetched once per action invocation.
      if (disableSheets || fixUrl) {
        if (configContent) {
          if (disableSheets) {
            configContent = disableGoogleSheetsInConfig(configContent);
            commitParts.push("disable Google Sheets");
          }
          if (fixUrl && pagesUrl) {
            // Parse the Pages URL into url + baseurl
            const parsed = new URL(pagesUrl);
            const newUrl = `${parsed.protocol}//${parsed.host}`;
            const newBaseurl = parsed.pathname.replace(/\/+$/, "");
            // Replace url and baseurl in _config.yml
            configContent = configContent.replace(
              /^(url:\s*)"?[^"\n]*"?\s*$/m,
              `$1"${newUrl}"`
            );
            configContent = configContent.replace(
              /^(baseurl:\s*)"?[^"\n]*"?\s*$/m,
              `$1"${newBaseurl}"`
            );
            commitParts.push("fix site URL");
            fixedUrl = { url: newUrl, baseurl: newBaseurl };
          }
          files.push({ path: "_config.yml", content: configContent });
        }
      }

      const commitMessage = `${commitParts.join(", ")} via Telar Compositor`;

      // Commit on the same installation token resolved above.

      // The record that outlives a registration this action cannot finish.
      commitOpId = await prepareRegistrationRecord(db, {
        projectId: activeProject.id,
        objects: pendingObjects,
        parentSha: commitHead,
        actorId: user.id,
      });

      // Commit with [skip ci] to prevent the full build.yml from firing.
      // Full build dispatched below to deploy changes via GitHub Pages.
      commitResult = await commitUnderRecord(db, commitOpId, () => commitFilesToRepo(
        commitToken, owner, repo, "main", files, commitMessage,
        undefined, undefined,
        true, // skipCi — suppress full build
        commitHead,
      ));
      landed();

      } catch (err) {
        if (err instanceof StaleHeadError || err instanceof ObjectsSheetChanged) {
          return { ok: false, intent: "commit-objects", error: "stale_head" };
        }
        return {
          ok: false,
          intent: "commit-objects",
          error: "commit_failed",
          message: err instanceof Error ? err.message : "Unknown error",
        };
      }

      // Post-commit: register the objects the commit carried, whatever the
      // build then does. Never throws.
      commitRegistration = await finishRecordedRegistration(
        env, db, activeProject.id, user.id, pendingObjects, commitOpId, commitResult.newHeadSha,
      );

      await recordObjectsCommit(db, activeProject.id, {
        parent: commitParent, readSha: commitReadSha, committed: commitResult.newHeadSha,
      }, "commit-objects");

      // Post-commit: the sheets-flag and site-URL repairs reach D1 only once
      // the commit carrying them has landed, so a refused or failed commit
      // leaves D1 agreeing with the repository. They are best-effort and must
      // NOT flip the result — the repo commit already landed, so a D1/DO hiccup here misreporting commit_failed would send
      // the client down its discard path and strand rows already committed to
      // the repo (same isolation as the dispatch block below). Both go through
      // the collaboration document, so a warm document cannot write the old
      // values back and no editor's changes are lost; `repairSiteConfig`
      // never throws. If the Sheets flag does not land, the settings-page
      // reconcile repairs it on its next load.
      if (disableSheets || fixedUrl) {
        await repairSiteConfig(db, env as never, activeProject.id, {
          ...(disableSheets ? { google_sheets_enabled: false as const } : {}),
          ...(fixedUrl ?? {}),
        });
      }

      return null;
      });
      if (committed.refused) {
        return { ok: false, intent: "commit-objects", error: "operation_in_progress" };
      }
      if (committed.value) return committed.value;

      // Post-commit: dispatch is best-effort and must NOT flip the result —
      // the commit already landed. (Previously a
      // getInstallationToken failure here returned commit_failed for a commit
      // that succeeded, sending users into stale-head retries; and a silently
      // swallowed dispatch failure left the modal polling by SHA for a run
      // that never started. dispatchFailed tells the modal to skip build
      // tracking — tiles regenerate on the next full build.)
      let commitObjectsDispatchRunId: number | null = null;
      try {
        // Same convenor-only fallback as the commit above — a failed mint
        // for a collaborator throws here and lands in this block's own
        // catch, which is already the non-fatal "dispatch failed" path.
        const dispatchToken = await resolveProjectToken(
          env.GITHUB_APP_ID,
          env.GITHUB_PRIVATE_KEY,
          activeProject.installation_id,
          token,
          resolvedCommit.userRole,
        );
        const dispatch = await dispatchWorkflow(dispatchToken, owner, repo, "build.yml");
        commitObjectsDispatchRunId = dispatch.runId || null;
      } catch {
        // Dispatch failed — objects committed, processing deferred to next full build
      }

      return {
        ok: true,
        intent: "commit-objects",
        projectId: activeProject.id,
        registration: commitRegistration,
        operationId: commitOpId,
        newHeadSha: commitResult.newHeadSha,
        dispatchRunId: commitObjectsDispatchRunId,
        dispatchFailed: commitObjectsDispatchRunId === null,
      };
    }

    case "poll-build": {
      const sha = formData.get("sha") as string | null;
      const runIdParam = formData.get("runId") as string | null;

      // Require either sha or runId (runId-only path is for the upload flow)
      if (!sha && !runIdParam) {
        return { ok: false, intent: "poll-build", error: "missing_sha" };
      }

      // Membership-aware (member-level: polling is read-only build status).
      const resolvedPoll = page;
      if (!resolvedPoll) {
        return { ok: false, intent: "poll-build", error: "no_project" };
      }
      const activeProject = resolvedPoll.project;

      try {
        // A collaborator's own token has no read access to a private repo it
        // is not a GitHub collaborator on — polling under it here would fail
        // every attempt with poll_failed, which CommitAndBuildModal.tsx
        // retries forever, so pending objects would never register. Same
        // token as upload-image and commit-objects.
        const pollUserToken = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
        const token = await resolveProjectToken(
          env.GITHUB_APP_ID,
          env.GITHUB_PRIVATE_KEY,
          activeProject.installation_id,
          pollUserToken,
          resolvedPoll.userRole,
        );
        const [owner, repo] = activeProject.github_repo_full_name.split("/");

        // Run-ID-only path: polls the dispatched run directly by ID.
        if (runIdParam && !sha) {
          const runId = Number(runIdParam);
          const runRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}`,
            { headers: githubHeaders(token) },
          );
          if (!runRes.ok) {
            const errBody = await runRes.text();
            return { ok: false, intent: "poll-build", error: "poll_failed" };
          }
          const run = (await runRes.json()) as WorkflowRun;
          const steps = await getJobSteps(token, owner, repo, runId);
          const phases = mapStepsToBuildPhases(steps);
          return {
            ok: true,
            intent: "poll-build",
            buildStatus: run.status,
            buildConclusion: run.conclusion,
            buildUrl: run.html_url,
            runId: run.id,
            phases,
          };
        }

        // SHA-based path: normal commit flow (sync-apply, add-iiif-object, commit-objects)
        const runs = await listWorkflowRunsBySha(token, owner, repo, sha!);

        if (runs.length === 0) {
          return {
            ok: true,
            intent: "poll-build",
            buildStatus: "pending",
            buildConclusion: null,
            buildUrl: null,
            runId: null,
            phases: null,
          };
        }

        // The run the modal is tracking, when it names one and the listing
        // still holds it: a later run for the same commit, listed first,
        // is not the build this commit's objects are waiting on.
        const run = (runIdParam && runs.find((r) => r.id === Number(runIdParam))) || runs[0];

        if (runIdParam) {
          // Fetch step-level detail
          const steps = await getJobSteps(token, owner, repo, Number(runIdParam));
          const phases = mapStepsToBuildPhases(steps);
          return {
            ok: true,
            intent: "poll-build",
            buildStatus: run.status,
            buildConclusion: run.conclusion,
            buildUrl: run.html_url,
            runId: run.id,
            phases,
          };
        }

        return {
          ok: true,
          intent: "poll-build",
          buildStatus: run.status,
          buildConclusion: run.conclusion,
          buildUrl: run.html_url,
          runId: run.id,
          phases: null,
        };
      } catch (err) {
        return {
          ok: false,
          intent: "poll-build",
          error: "poll_failed",
          message: err instanceof Error ? err.message : "Unknown error",
        };
      }
    }

    case "complete-pending-objects": {
      // The page's request to finish the operations still owed, for someone
      // who can publish. Silent: a refused lease or a failure leaves the
      // records for the next publish, upload or visit.
      const resolvedComplete = page;
      if (!resolvedComplete) {
        return { ok: false, intent: "complete-pending-objects", error: "no_project" };
      }
      if (!isPublishingRole(resolvedComplete.userRole)) {
        return { ok: false, intent: "complete-pending-objects", error: "forbidden" };
      }
      const completed = await completePendingObjectsQuietly(env, db, user, resolvedComplete);
      return { ok: completed, intent: "complete-pending-objects" };
    }

    case "insert-pending-objects": {
      // The retry of a registration that failed after its commit landed. It
      // names the operation's record rather than re-sending objects, so it
      // finishes only work that is still owed, for the project that commit
      // ran against.
      const operationId = pendingObjectOpIdOf(formData.get("operationId"));
      if (operationId === null) {
        return { ok: false, intent: "insert-pending-objects", error: "missing_data" };
      }

      const resolvedIns = await resolveActiveProjectFromRequest(request, env, user.id);
      if (!resolvedIns) {
        return { ok: false, intent: "insert-pending-objects", error: "no_project" };
      }
      // The session's active project can have changed since the commit, in
      // another tab; objects committed to one site are never registered on
      // another.
      if (formData.get("projectId") !== String(resolvedIns.project.id)) {
        return siteChangedAnswer("insert-pending-objects", resolvedIns.project.github_repo_full_name);
      }
      const retryProject = resolvedIns.project;

      // A prepared record is completed only on the sheet's evidence, read at
      // the head; a committed one needs no read, so the read is made only when
      // completion asks for it.
      const readRetrySheet = async () => {
        try {
          const retryUserToken = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
          const retryToken = await resolveProjectToken(
            env.GITHUB_APP_ID,
            env.GITHUB_PRIVATE_KEY,
            retryProject.installation_id,
            retryUserToken,
            resolvedIns.userRole,
          );
          const [retryOwner, retryRepo] = retryProject.github_repo_full_name.split("/");
          const retryHead = await getRepoHead(retryToken, retryOwner, retryRepo, "main");
          return (await readObjectsSheetAt(retryToken, retryOwner, retryRepo, retryHead)).sheet;
        } catch (err) {
          console.error("insert-pending-objects: objects.csv could not be read", err);
          return null;
        }
      };

      // Under the objects lease, as every completion runs: no publish may
      // serialise objects.csv from D1 while this is registering.
      const retried = await holdOperationLease(env, retryProject.id, user.id, "objects", async (landed) => {
        try {
          const record = await readPendingObjectOp(db, retryProject.id, operationId);
          if (record === null) {
            landed();
            return true;
          }
          const completion = await completePendingObjectOps(
            env, db, retryProject.id, readRetrySheet, { opIds: [operationId] },
          );
          if (!completion.ok || completion.outcomes.get(operationId) === "kept") return false;
          landed();
          return true;
        } catch (err) {
          console.error("insert-pending-objects: completion failed", err);
          return false;
        }
      });
      if (retried.refused) {
        return { ok: false, intent: "insert-pending-objects", error: "operation_in_progress" };
      }
      if (!retried.value) {
        return { ok: false, intent: "insert-pending-objects", error: "insert_failed" };
      }
      return { ok: true, intent: "insert-pending-objects", operationId };
    }

    default:
      throw new Response("Bad request", { status: 400 });
  }
}

/**
 * Complete the project's pending records under the `objects` lease, with
 * objects.csv read strictly at the head. True when they were completed;
 * false, and logged, when the lease was refused or anything failed. Nothing
 * is thrown: the page that asked shows nothing either way.
 */
async function completePendingObjectsQuietly(
  env: Env,
  db: ReturnType<typeof getDb>,
  user: { id: number; encrypted_access_token: string },
  resolved: { project: { id: number; github_repo_full_name: string; installation_id: number }; userRole: string },
): Promise<boolean> {
  const projectId = resolved.project.id;
  try {
    const held = await holdOperationLease(env, projectId, user.id, "objects", async (landed) => {
      const userToken = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
      const token = await resolveProjectToken(
        env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY, resolved.project.installation_id, userToken, resolved.userRole,
      );
      const [owner, repo] = resolved.project.github_repo_full_name.split("/");
      const head = await getRepoHead(token, owner, repo, "main");
      await prepareObjectsCommit(env, db, projectId, { token, owner, repo, head });
      landed();
    });
    return !held.refused;
  } catch (err) {
    console.error(`complete-pending-objects: project ${projectId} left for later`, err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sort / filter helpers
// ---------------------------------------------------------------------------

// sortObjects — default title-ascending ordering for the non-Yjs fallback
// branch. The sort/status selects were dropped, so the only remaining
// ordering is the default title sort; Yjs mode preserves Y.Array order.
function sortObjects(objs: ObjectRowObject[]): ObjectRowObject[] {
  return [...objs].sort((a, b) =>
    (a.title ?? a.object_id).localeCompare(b.title ?? b.object_id)
  );
}

// ---------------------------------------------------------------------------
// IIIF manifest validation — client-side fetch that marks the
// Y.Map's _validation_state as "valid" or "error" so all connected users see
// the outcome via Yjs sync. Runs outside React so it survives rerenders.
// ---------------------------------------------------------------------------

function validateManifestOnYMap(
  objYMap: Y.Map<unknown>,
  manifestUrl: string
): void {
  if (!manifestUrl) {
    objYMap.doc?.transact(() => {
      objYMap.set("_validation_state", "error");
      objYMap.set("_validation_error", "missing_url");
    });
    return;
  }
  fetch(manifestUrl)
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      let manifest: Record<string, unknown>;
      try {
        manifest = (await response.json()) as Record<string, unknown>;
      } catch {
        throw new Error("parse_failed");
      }
      const isManifest =
        "@context" in manifest || "id" in manifest || "@id" in manifest;
      objYMap.doc?.transact(() => {
        if (isManifest) {
          objYMap.set("_validation_state", "valid");
          objYMap.set("_validation_error", null);
        } else {
          objYMap.set("_validation_state", "error");
          objYMap.set("_validation_error", "invalid_manifest");
        }
      });
    })
    .catch(() => {
      objYMap.doc?.transact(() => {
        objYMap.set("_validation_state", "error");
        objYMap.set("_validation_error", "fetch_failed");
      });
    });
}

// ---------------------------------------------------------------------------
// Y.Map → ObjectRowObject transform (Yjs mode)
// ---------------------------------------------------------------------------

function readScalarFromYMap(yMap: Y.Map<unknown>, key: string): string | null {
  const val = yMap.get(key);
  if (val === null || val === undefined) return null;
  if (val instanceof Y.Text) {
    const s = val.toString();
    return s.length === 0 ? null : s;
  }
  if (typeof val === "string") return val.length === 0 ? null : val;
  return null;
}

interface YjsObjectRow extends ObjectRowObject {
  _tempId?: string | null;
  _createdBy?: number | null;
  _yIndex?: number;
  /** Fractional index the list sorts by; null on a doc awaiting the backfill. */
  _orderKey?: string | null;

  _yMap?: Y.Map<unknown> | null;
  _validationState?: "pending" | "valid" | "error" | null;
  _validationError?: string | null;
  /** Creator string (read from the Y.Map) — used only by the ?q= filter. */
  _creator?: string | null;
  /**
   * Course marker. Named for the D1 column so the Yjs and loader-fallback
   * paths expose it identically: the Y.Map carries it under the same key,
   * and the loader row comes straight from `objects`.
   */
  course_project_id?: number | null;
}

interface ObjectsMember {
  userId: number;
  name: string;
  contributions: {
    stories_edited?: number[];
    objects_edited?: number[];
    fields_edited?: number;
    sessions?: number;
  } | null;
}

function yMapToObjectRow(yMap: Y.Map<unknown>, yIndex: number): YjsObjectRow {
  const id = (yMap.get("_id") as number | null) ?? 0;
  const tempId = (yMap.get("_temp_id") as string | null) ?? null;
  const createdBy = (yMap.get("created_by") as number | null) ?? null;
  const validationState =
    (yMap.get("_validation_state") as "pending" | "valid" | "error" | null) ??
    null;
  const validationError =
    (yMap.get("_validation_error") as string | null) ?? null;

  return {
    id,
    object_id: (yMap.get("object_id") as string) ?? "",
    title: readScalarFromYMap(yMap, "title"),
    year: readScalarFromYMap(yMap, "year"),
    _creator: readScalarFromYMap(yMap, "creator"),
    featured: Boolean(yMap.get("featured") ?? false),
    source_url: (yMap.get("source_url") as string | null) ?? null,
    thumbnail: (yMap.get("thumbnail") as string | null) ?? null,
    image_available: Boolean(yMap.get("image_available") ?? false),
    missing_from_repo: Boolean(yMap.get("missing_from_repo") ?? false),
    _tempId: tempId,
    _createdBy: createdBy,
    _yIndex: yIndex,
    _orderKey: readOrderKey(yMap),
    _yMap: yMap,
    _validationState: validationState,
    _validationError: validationError,
    course_project_id:
      typeof yMap.get("course_project_id") === "number"
        ? (yMap.get("course_project_id") as number)
        : null,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Whether a fetcher has settled on an unreachable answer. */
function commitCheckUnreachable(data: unknown, fetcherState: string): boolean {
  return fetcherState === "idle" && isUnreachableAnswer(data);
}

/**
 * Whether the commit dialog still waits for its pre-commit check: none has
 * answered for the site, or one is in flight. The fetcher keeps an earlier
 * answer while a newer check runs, and the Sheets flag comes from the newer.
 */
function commitCheckPending(checkedSite: number | null, projectId: number, fetcherState: string): boolean {
  return checkedSite !== projectId || fetcherState !== "idle";
}

export default function ObjectsPage({ loaderData }: Route.ComponentProps) {
  const { openDoc } = useOutletContext<{ openDoc?: (id: string) => void }>() ?? {};
  const { t } = useTranslation("objects");
  const { t: tStructural } = useTranslation("structural");
  const { t: tCommon } = useTranslation("common");
  const {
    project,
    objects: loaderObjects,
    objectStepCounts,
    siteBaseUrl,
    frameworkVersion,
    sharedSiteIds: loaderSharedSiteIds,
    members,
    currentUserId,
    userRole,
    pendingObjectOps,
  } = loaderData;

  // Objects saved in the site's files whose registration was left owed.
  useCompletePendingObjects(pendingObjectOps, isPublishingRole(userRole));

  const { ydoc, provider, connectionStatus } = useCollaborationContext();
  const ops = useStructuralOps(currentUserId, userRole);
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  // Page-head substring filter — URL state under ?q=. Mirrors
  // the glossary route's inline ?q= pattern.
  const query = searchParams.get("q") ?? "";
  const setQuery = useCallback(
    (next: string) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next.trim() === "") params.delete("q");
          else params.set("q", next);
          return params;
        },
        { replace: true, preventScrollReset: true },
      );
    },
    [setSearchParams],
  );

  // Sync dialog state. `syncCheckId` names the check the dialog shows, and
  // keys it, so each check starts from the dialog's defaults. `syncNotice`
  // says why the list changed, after an apply was refused as stale.
  const [syncDialogOpen, setSyncDialogOpen] = useState(false);
  const [syncDiffData, setSyncDiffData] = useState<SyncDiff | null>(null);
  const [syncCheckId, setSyncCheckId] = useState(0);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  // A check refused for columns read as one field, offered in the column picker.
  const [syncQuestion, setSyncQuestion] = useState<SheetChoicesQuestion | null>(null);

  // Unified Add Object dialog state (replaces the chooser + AddIiif + Upload
  // trio). The IIIF tab still drives the iiif-preview fetch.
  const [addObjectOpen, setAddObjectOpen] = useState(false);
  const [iiifFetchResult, setIiifFetchResult] = useState<IiifFetchResult | null>(null);

  // Commit modal state
  const [commitModalOpen, setCommitModalOpen] = useState(false);
  const [pendingObjects, setPendingObjects] = useState<PendingObject[]>([]);
  const [sheetsEnabled, setSheetsEnabled] = useState(false);
  const [objectsFile, setObjectsFile] = useState("objects.csv");
  // The site whose pre-commit check last answered (`commitCheckPending`).
  const [checkedSite, setCheckedSite] = useState<number | null>(null);
  const [urlMismatch, setUrlMismatch] = useState<{ pagesUrl: string; configUrl: string } | null>(null);
  // Upload flow: dispatch run ID for direct polling (skips commit step in modal)
  const [dispatchRunId, setDispatchRunId] = useState<number | null>(null);
  // The upload's own registration of its objects, and the project it
  // committed to, for the modal's retry.
  const [uploadRegistration, setUploadRegistration] = useState<RegistrationResult | null>(null);
  const [uploadProjectId, setUploadProjectId] = useState<number | null>(null);
  const [dispatchHtmlUrl, setDispatchHtmlUrl] = useState<string | null>(null);

  // Upload state (the Upload tab lives inside the unified AddObjectDialog now)
  const [uploadError, setUploadError] = useState<string | null>(null);
  // The code behind uploadError, which decides whether the refusal carries a
  // remedy link of its own.
  const [uploadErrorCode, setUploadErrorCode] = useState<string | null>(null);
  // Guard: tracks whether a new upload has been submitted in the current dialog session
  const [uploadSubmitted, setUploadSubmitted] = useState(false);
  // Tracks whether CommitAndBuildModal was opened from the upload flow (skip commit step)
  const [isUploadFlow, setIsUploadFlow] = useState(false);

  // Fetchers
  const featuredFetcher = useFetcher();
  // Each object is asked about once per visit: a manifest that still names the
  // stored thumbnail must not be asked again each time the image fails.
  const refreshedThumbnails = useRef(new Set<number>());
  function handleThumbnailFailed(object: ObjectRowObject) {
    if (!object.source_url || object.id <= 0 || refreshedThumbnails.current.has(object.id)) return null;
    refreshedThumbnails.current.add(object.id);
    return { projectId: String(project.id), objectDbId: String(object.id) };
  }
  function handleThumbnailRefreshed(object: ObjectRowObject, thumbnail: string) {
    writeObjectThumbnail(ydoc, object.id, thumbnail);
  }
  const syncFetcher = useSiteFetcher();
  const iiifFetcher = useFetcher();
  const sheetsFetcher = useSiteFetcher();
  const uploadFetcher = useSiteFetcher();

  // Handle sync diff result
  const syncFetcherData = syncFetcher.data as
    | { ok: true; intent: "compute-sync-diff"; diff: SyncDiff }
    | {
        ok: true;
        intent: "sync-apply";
        projectId: number;
        appliedCount: number;
        pendingObjects: PendingObject[];
        notAdded: string[];
      }
    | { ok: false; intent: string; error: string; collidingColumns?: CollidingColumns; sheet?: string }
    | null
    | undefined;

  const iiifFetcherData = iiifFetcher.data as
    | { ok: true; intent: "fetch-iiif-preview"; result: IiifFetchResult }
    | { ok: false; intent: string; error: string }
    | null
    | undefined;

  const preCommitData = sheetsFetcher.data as
    | { ok: true; intent: "pre-commit-check"; sheetsEnabled: boolean; objectsFile: string; urlCheck: { match: boolean; pagesUrl: string; configUrl: string } }
    | { ok: false; reason: "unreachable"; intent: "pre-commit-check" }
    | null
    | undefined;

  const uploadFetcherData = uploadFetcher.data as
    | { ok: true; intent: "upload-image"; objectId: string; newHeadSha: string; pendingObject: PendingObject; pendingObjects?: PendingObject[]; dispatchRunId?: number | null; dispatchHtmlUrl?: string | null; projectId?: number; registration?: RegistrationResult }
    | { ok: false; intent: "upload-image"; error: string }
    | null
    | undefined;

  // Run pre-commit checks on mount
  useEffect(() => {
    sheetsFetcher.submit({ intent: "pre-commit-check" }, { method: "post" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  // A check that failed in transit is run again, so the commit dialog does
  // not go on without it.
  useRetryWhileUnreachable(sheetsFetcher.data, () =>
    sheetsFetcher.submit({ intent: "pre-commit-check" }, { method: "post" }),
  );

  // One-time denied toast on direct-nav. The routes/_app loader guard
  // redirects a collaborator who opens /publish or /upgrade to
  // /objects?denied=publish|upgrade. Surface a single info toast explaining why,
  // then strip the param so it never re-fires on re-render or refresh. Keyed on
  // the denied value (mirrors use-version-change-toast's fire-once pattern).
  const denied = searchParams.get("denied");
  useEffect(() => {
    if (denied !== "publish" && denied !== "upgrade") return;
    showToast({
      type: "info",
      message: tCommon(denied === "upgrade" ? "role.denied_upgrade" : "role.denied_publish"),
    });
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("denied");
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [denied]);

  // Full-repo sync review modal (SyncConfirmModal) — distinct from this
  // route's objects-scoped SyncDiffDialog. Opened by the ?sync=1 deep-link
  // that the out-of-sync popover and the publish page's stale-head blocker
  // point at; the param is stripped once consumed (mirrors `denied` above)
  // so the modal never re-fires on refresh. The modal's conflict warning reads
  // the count useSiteStatus gives the header chip: the live count, else the loader's estimate.
  const appLoaderData = useRouteLoaderData("routes/_app") as
    | { needsUpgrade?: boolean; upgradeAwaitsConvenor?: boolean; releaseUnknown?: boolean }
    | undefined;
  const upgradeAwaitsConvenor = appLoaderData?.upgradeAwaitsConvenor ?? false;
  const { count: unpublishedCount, countKnown } = useSiteStatus();
  const [fullSyncModalOpen, setFullSyncModalOpen] = useState(false);
  const syncParam = searchParams.get("sync");
  useEffect(() => {
    if (syncParam !== "1") return;
    setFullSyncModalOpen(true);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("sync");
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncParam]);

  // Surface external version drift as a toast. The compute-full-sync-diff
  // submission happens inside SyncConfirmModal via useFetcher({ key }); we
  // subscribe to the same fetcher here so the toast fires once at the page
  // level and stays visible after the modal closes.
  const fullSyncDiffFetcher = useFetcher({ key: SYNC_DIFF_FETCHER_KEY });
  useVersionChangeToast(
    fullSyncDiffFetcher.data as Parameters<typeof useVersionChangeToast>[0],
  );

  // Update state from pre-commit check result. A check that could not be made
  // leaves the dialog waiting: an earlier answer is not the current one.
  const preCheckFailed = isUnreachableAnswer(preCommitData);
  const checkCouldNotBeMade = commitCheckUnreachable(preCommitData, sheetsFetcher.state);
  useEffect(() => {
    if (preCheckFailed) setCheckedSite(null);
    if (preCommitData?.ok && preCommitData.intent === "pre-commit-check") {
      setSheetsEnabled(preCommitData.sheetsEnabled);
      setObjectsFile(preCommitData.objectsFile);
      setCheckedSite(project.id);
      if (!preCommitData.urlCheck.match) {
        setUrlMismatch({ pagesUrl: preCommitData.urlCheck.pagesUrl, configUrl: preCommitData.urlCheck.configUrl });
      } else {
        setUrlMismatch(null);
      }
    }
  }, [preCommitData, preCheckFailed]);

  // Update sync diff data when compute returns
  useEffect(() => {
    if (syncFetcherData?.ok && syncFetcherData.intent === "compute-sync-diff") {
      setSyncDiffData(syncFetcherData.diff);
      setSyncCheckId((id) => id + 1);
    }
  }, [syncFetcherData]);

  // Update IIIF fetch result
  useEffect(() => {
    if (iiifFetcherData?.ok && iiifFetcherData.intent === "fetch-iiif-preview") {
      setIiifFetchResult(iiifFetcherData.result);
    }
  }, [iiifFetcherData]);

  // Close the sync dialog (if open) and open the commit modal on a successful
  // apply, exactly once per response — see useSyncApplyOutcome. Handling does
  // not depend on the dialog being open: the apply has already changed the
  // document by the time its response arrives, so the objects it left to
  // commit need the commit window whether or not the dialog is still on screen.
  const closeSyncDialogAndDiff = useCallback(() => {
    setSyncDialogOpen(false);
    setSyncDiffData(null);
    setSyncNotice(null);
  }, []);
  const openCommitModalWithPending = useCallback(
    (pendingObjects: PendingObject[]) => {
      setPendingObjects(pendingObjects);
      sheetsFetcher.submit({ intent: "pre-commit-check" }, { method: "post" });
      setCommitModalOpen(true);
    },
    [sheetsFetcher.submit],
  );
  const toastSyncNotAdded = useCallback(() => {
    showToast({ type: "warning", message: t("sync_not_added") });
  }, [showToast, t]);
  const toastSyncChangedSinceReview = useCallback(() => {
    showToast({ type: "warning", message: t("sync_changed_none_applied") });
  }, [showToast, t]);
  const toastSyncReadNotRecorded = useCallback(() => {
    showToast({ type: "warning", message: t("sync_read_not_recorded") });
  }, [showToast, t]);
  useSyncApplyOutcome({
    data: syncFetcherData,
    projectId: project.id,
    onClose: closeSyncDialogAndDiff,
    onApplied: openCommitModalWithPending,
    onNotAdded: toastSyncNotAdded,
    onChangedSinceReview: toastSyncChangedSinceReview,
    onReadNotRecorded: toastSyncReadNotRecorded,
  });

  // Surface sync failures: a failed result that is not shown leaves the
  // dialog open on blank content or a stopped spinner. An apply refused because
  // GitHub is not at the commit the author reviewed keeps the dialog open and
  // checks again, with a notice saying why the list changed; any other failure
  // is toasted and the dialog closes so the author can retry.
  useEffect(() => {
    if (
      syncFetcherData &&
      !syncFetcherData.ok &&
      (syncFetcherData.intent === "compute-sync-diff" || syncFetcherData.intent === "sync-apply")
    ) {
      if (syncFetcherData.intent === "sync-apply" && syncFetcherData.error === "sync_stale") {
        setSyncDiffData(null);
        setSyncNotice(t("sync_stale"));
        syncFetcher.submit({ intent: "compute-sync-diff" }, { method: "post" });
        return;
      }
      // The layout's notice speaks for a sync refused because the site
      // changed; the dialog still closes. Columns read as one field go to the picker.
      setSyncQuestion(choicesQuestionOf(syncFetcherData));
      if (!isSiteChanged(syncFetcherData) && !choicesQuestionOf(syncFetcherData)) showToast(syncErrorToast(syncFetcherData, t));
      closeSyncDialogAndDiff();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncFetcherData]);

  // IIIF add flow migrated to Yjs — no route action for add-iiif-object.
  // The confirm handler below writes to the Y.Array and kicks off client-side
  // manifest validation. The dialog closes immediately on confirm.

  useEffect(() => {
    if (!uploadSubmitted) return;
    if (uploadFetcherData?.ok && uploadFetcherData.intent === "upload-image" && addObjectOpen) {
      setAddObjectOpen(false);
      setUploadError(null);
      setUploadErrorCode(null);
      setUploadSubmitted(false);
      // The action committed the images and CSV and registered the objects;
      // the modal reports the registration, offers its retry, and tracks the
      // build. No pre-commit-check is needed here.
      setPendingObjects(uploadFetcherData.pendingObjects ?? [uploadFetcherData.pendingObject]);
      setUploadRegistration(uploadFetcherData.registration ?? null);
      setUploadProjectId(uploadFetcherData.projectId ?? null);
      setDispatchRunId(uploadFetcherData.dispatchRunId ?? null);
      setDispatchHtmlUrl(uploadFetcherData.dispatchHtmlUrl ?? null);
      setIsUploadFlow(true);
      setCommitModalOpen(true);
    } else if (uploadSubmitted && uploadFetcherData && !uploadFetcherData.ok && uploadFetcherData.intent === "upload-image") {
      setUploadSubmitted(false);
      // The layout's notice speaks for an upload refused because the site
      // changed; the dialog keeps the author's files and says nothing more.
      if (isSiteChanged(uploadFetcherData)) return;
      // Map error codes to i18n keys. Every code the action can return MUST
      // be mapped — unmapped codes fell back to the generic "check your
      // connection" copy, which is how issue #25's real cause stayed hidden.
      const errorMap: Record<string, string> = {
        stale_head: t("upload_error_stale"),
        upgrade_required: t("upload_disabled_upgrade_required"),
        upgrade_awaits_convenor: t("upload_disabled_upgrade_awaits_convenor"),
        release_unknown: t("repo_write_release_unknown"),
        payload_too_large: t("upload_error_payload"),
        upload_failed: t("upload_error_generic"),
        operation_in_progress: t("upload_error_operation_in_progress"),
        invalid_format: t("upload_error_format", { formats: UPLOAD_ACCEPTED_FORMAT_LIST }),
        file_too_large: t("upload_error_size"),
        title_required: t("field_title_required"),
        missing_data: t("upload_error_missing_data"),
        batch_too_large: t("upload_error_batch_full"),
        invalid_object_id: t("upload_error_invalid_id"),
        no_project: t("upload_error_no_project"),
        forbidden: t("upload_error_forbidden"),
      };
      setUploadError(errorMap[uploadFetcherData.error] || t("upload_error_generic"));
      setUploadErrorCode(uploadFetcherData.error);
    }
  }, [uploadFetcherData, addObjectOpen, t]);

  function handleToggleFeatured(object: ObjectRowObject) {
    // Y.Doc is the source of truth for object metadata in collaborative mode;
    // snapshotToD1 reconciles. The D1-only fetcher would be clobbered.
    if (useYjs && ydoc) {
      const objectsArray = ydoc.getArray<Y.Map<unknown>>("objects");
      const objYMap = findYMapById(objectsArray, object.id);
      if (objYMap) {
        ydoc.transact(() => {
          objYMap.set("featured", !(object.featured ?? false));
        });
        return;
      }
    }
    featuredFetcher.submit(
      {
        intent: "toggle-featured",
        objectDbId: String(object.id),
        currentValue: String(object.featured ?? false),
      },
      { method: "post" }
    );
  }

  function handleSyncClick() {
    setSyncDiffData(null);
    setSyncNotice(null);
    setSyncDialogOpen(true);
    syncFetcher.submit({ intent: "compute-sync-diff" }, { method: "post" });
  }

  function handleAddObjectClick() {
    setIiifFetchResult(null);
    setAddObjectOpen(true);
  }

  function handleSyncApply(payload: SyncApplyPayload) {
    syncFetcher.submit(
      { intent: "sync-apply", changes: JSON.stringify(payload) },
      { method: "post" }
    );
  }

  function handleIiifFetch(url: string) {
    setIiifFetchResult(null);
    iiifFetcher.submit({ intent: "fetch-iiif-preview", url }, { method: "post" });
  }

  function handleIiifConfirm(payload: AddObjectIiifPayload) {
    // IIIF objects flow through the Y.Array with a "pending" validation
    // state. The DO snapshot skips pending objects, so they do
    // not reach D1 until this client-side fetch marks them valid.
    if (!ops || !ydoc) {
      // No active ydoc — silently drop; reconnect will let the user retry.
      // eslint-disable-next-line no-console
      console.warn("[objects] IIIF add requested without active ydoc; ignored");
      setAddObjectOpen(false);
      setIiifFetchResult(null);
      return;
    }

    const objectId = payload.object_id || slugify(payload.title);
    const tempId = ops.addIiifObject(objectId, payload.title, payload.manifestUrl);

    // Seed additional fields on the just-added Y.Map (addIiifObject writes
    // the minimum set — fill in creator/description/source/credit/thumbnail
    // from the dialog payload so the DO snapshot can INSERT a complete row
    // once validation succeeds). Locate it by its stable _temp_id, NOT by
    // array position: this is a collaborative doc, so a remote push can land
    // between the op and this read, and array.get(length - 1) would then
    // point at the wrong object (seeding/validating the wrong row).
    const objectsArray = ydoc.getArray<Y.Map<unknown>>("objects");
    const justAdded = findYMapByIdOrTempId(objectsArray, null, tempId);
    if (justAdded) {
      ydoc.transact(() => {
        const creatorText = justAdded.get("creator");
        if (creatorText instanceof Y.Text && payload.creator) {
          creatorText.insert(0, payload.creator);
        }
        const descriptionText = justAdded.get("description");
        if (descriptionText instanceof Y.Text && payload.description) {
          descriptionText.insert(0, payload.description);
        }
        const altText = justAdded.get("alt_text");
        if (altText instanceof Y.Text && payload.title) {
          altText.insert(0, payload.title);
        }
        // Year seed — the IIIF tab now carries a year field,
        // which flows through here into the year Y.Text.
        const yearText = justAdded.get("year");
        if (yearText instanceof Y.Text && payload.year) {
          yearText.insert(0, payload.year);
        }
        if (payload.thumbnail) justAdded.set("thumbnail", payload.thumbnail);
        if (payload.source) justAdded.set("source", payload.source);
        if (payload.credit) justAdded.set("credit", payload.credit);
        justAdded.set("image_available", payload.image_available);
      });

      // Fire-and-forget client-side manifest validation.
      // Success → `_validation_state: "valid"`, failure → `"error"`.
      validateManifestOnYMap(justAdded, payload.manifestUrl);
    }

    setAddObjectOpen(false);
    setIiifFetchResult(null);
  }

  function handleExternalConfirm(payload: AddObjectExternalPayload) {
    // External-media objects are born non-pending (origin "compositor") so the
    // DO snapshot INSERTs them immediately. They have no IIIF
    // manifest, so validateManifestOnYMap is intentionally NOT called here.
    // image_available stays false and thumbnail "" (no poster), as already
    // set by the op.
    if (!ops || !ydoc) {
      // No active ydoc — silently drop; reconnect will let the user retry.
      // eslint-disable-next-line no-console
      console.warn("[objects] external add requested without active ydoc; ignored");
      setAddObjectOpen(false);
      return;
    }

    const objectId = payload.object_id || slugify(payload.title);
    const tempId = ops.addExternalMediaObject(objectId, payload.title, payload.sourceUrl);

    // Seed the metadata Y.Texts on the just-added Y.Map, mirroring
    // handleIiifConfirm (creator / description / alt_text / year). No manifest
    // validation — external media has no manifest to fetch. Locate by stable
    // _temp_id, not array position (see handleIiifConfirm for the race).
    const objectsArray = ydoc.getArray<Y.Map<unknown>>("objects");
    const justAdded = findYMapByIdOrTempId(objectsArray, null, tempId);
    if (justAdded) {
      ydoc.transact(() => {
        const creatorText = justAdded.get("creator");
        if (creatorText instanceof Y.Text && payload.creator) {
          creatorText.insert(0, payload.creator);
        }
        const descriptionText = justAdded.get("description");
        if (descriptionText instanceof Y.Text && payload.description) {
          descriptionText.insert(0, payload.description);
        }
        const altText = justAdded.get("alt_text");
        if (altText instanceof Y.Text && payload.title) {
          altText.insert(0, payload.title);
        }
        const yearText = justAdded.get("year");
        if (yearText instanceof Y.Text && payload.year) {
          yearText.insert(0, payload.year);
        }
      });
    }

    setAddObjectOpen(false);
  }

  function handleUploadConfirm(payloads: UploadImageConfirmPayload[]) {
    const fd = new FormData();
    fd.append("intent", "upload-image");
    // Append each image file under the same key — formData.getAll("imageFile") on server
    for (const payload of payloads) {
      fd.append("imageFile", payload.file);
    }
    // Send all metadata as a single JSON array
    fd.append("metadataArray", JSON.stringify(payloads.map((p) => ({
      objectId: p.objectId,
      title: p.title,
      creator: p.creator,
      description: p.description,
      source: p.source,
      credit: p.credit,
      period: p.period,
      year: p.year,
      altText: p.altText,
    }))));
    setUploadSubmitted(true);
    uploadFetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
  }

  function handleBuildFailed() {
    // The build did not succeed; the objects stay registered, since their
    // commit landed. Only the page's pending state is cleared.
    setCommitModalOpen(false);
    setPendingObjects([]);
    setDispatchRunId(null);
    setDispatchHtmlUrl(null);
    setIsUploadFlow(false);
  }

  function handleBuildSuccess(built: boolean) {
    // A build that succeeded made the tiles: mark the uploaded objects
    // image_available in Yjs. A skipped build made none.
    if (built && isUploadFlow && ydoc) {
      const objectsArray = ydoc.getArray<Y.Map<unknown>>("objects");
      const uploadedIds = new Set(pendingObjects.map((p) => p.object_id));
      ydoc.transact(() => {
        for (let i = 0; i < objectsArray.length; i++) {
          const yMap = objectsArray.get(i);
          if (uploadedIds.has(yMap.get("object_id") as string)) {
            yMap.set("image_available", true);
          }
        }
      });
    }
    // Close modal, clear pending objects
    // (D1 insertion is handled by the modal via insert-pending-objects action)
    setCommitModalOpen(false);
    setPendingObjects([]);
    setSheetsEnabled(false);
    setDispatchRunId(null);
    setDispatchHtmlUrl(null);
    setIsUploadFlow(false);
  }

  function handleCommitCancel() {
    // The modal was closed: before a commit, the pending objects are dropped;
    // after one, they are registered or offered their retry, and only the
    // page's pending state is cleared.
    setCommitModalOpen(false);
    setPendingObjects([]);
    setDispatchRunId(null);
    setDispatchHtmlUrl(null);
    setIsUploadFlow(false);
  }

  // Compute IIIF fetch result to pass to dialog
  // If fetcher returned a fetch-iiif-preview result, use it; else if there was
  // an error in the action, construct an error result
  let dialogFetchResult: IiifFetchResult | null = null;
  if (
    iiifFetcherData?.ok &&
    iiifFetcherData.intent === "fetch-iiif-preview"
  ) {
    dialogFetchResult = iiifFetcherData.result;
  } else if (
    iiifFetcherData &&
    !iiifFetcherData.ok &&
    iiifFetcherData.intent === "fetch-iiif-preview"
  ) {
    dialogFetchResult = { ok: false, error: "fetch_failed" };
  }

  const isComputing = syncFetcher.state !== "idle" &&
    syncFetcher.formData?.get("intent") === "compute-sync-diff";
  const isApplying = syncFetcher.state !== "idle" &&
    syncFetcher.formData?.get("intent") === "sync-apply";
  const isFetchingIiif = iiifFetcher.state !== "idle" &&
    iiifFetcher.formData?.get("intent") === "fetch-iiif-preview";
  // add-iiif-object is no longer a route action — the Y.Array path is
  // instantaneous, so the dialog's "adding" spinner is always false now.
  const isAddingIiif = false;
  const isUploading = uploadFetcher.state !== "idle" &&
    uploadFetcher.formData?.get("intent") === "upload-image";

  // --------------------------------------------------------------------
  // Source of truth: Y.Array when ydoc is available, loader data otherwise
  // --------------------------------------------------------------------
  const yjsObjects = useYjsArraySync(
    ydoc ? ydoc.getArray<Y.Map<unknown>>("objects") : null,
    yMapToObjectRow,
  );

  const { useYjs, awaitingDoc } = useDocumentSource({
    provider,
    connectionStatus,
    ydoc,
    ops,
    list: yjsObjects,
  });

  // Self-hosted images not yet ready are asked about on the deployed site;
  // until their tiles answer, their rows say they need tiles.
  useTileReadiness(ydoc, yjsObjects);

  // External objects not yet filled from their manifests are filled by the
  // collaboration server, asked once the document is the page's source.
  useObjectEnrichment(ydoc, useYjs, yjsObjects);

  // Usage counts follow the document's steps; the loader's stand until it has one.
  const stepCounts = useDocumentStepCounts(ydoc, frameworkVersion, objectStepCounts);

  // --------------------------------------------------------------------
  // Delete flow — one path for every object
  // --------------------------------------------------------------------
  const [deleteTarget, setDeleteTarget] = useState<{
    object: YjsObjectRow;
    contributors: string[];
  } | null>(null);

  function openDeleteModalFor(object: YjsObjectRow) {
    // Contributors: objects_edited from member contributions, plus the
    // creator (unless it's the current user).
    const names = new Set<string>();
    const typedMembers = members as ObjectsMember[];
    if (object.id > 0) {
      for (const m of typedMembers) {
        if (m.userId === currentUserId) continue;
        const edited = m.contributions?.objects_edited ?? [];
        if (Array.isArray(edited) && edited.includes(object.id)) {
          names.add(m.name);
        }
      }
    }
    if (object._createdBy && object._createdBy !== currentUserId) {
      const creator = (members as ObjectsMember[]).find(
        (m: ObjectsMember) => m.userId === object._createdBy
      );
      if (creator) names.add(creator.name);
    }
    setDeleteTarget({ object, contributors: Array.from(names) });
  }

  function handleDeleteRequest(object: YjsObjectRow) {
    if (!useYjs) return;
    if (object._yMap && !ops!.canDelete(object._yMap)) return;
    openDeleteModalFor(object);
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    const { object } = deleteTarget;
    // Every deletion from the grid goes through the document. The DO's
    // snapshot DELETE branch removes the D1 row, and repo-side cleanup waits
    // for the next publish. A delete that must also clean the repository
    // belongs on the object's own detail page, which is the only place the
    // document write is ordered against the commit.
    if (ops) {
      ops.deleteObject(object.id > 0 ? object.id : null, object._tempId ?? null);
    }
    setDeleteTarget(null);
  }

  // --------------------------------------------------------------------
  // Upload-completion notice
  //
  // There is no mirror-into-Yjs step here: insert-pending-objects posts the
  // objects to the collaboration DO, which appends them to the shared document
  // and broadcasts the new state, so the list hydrates over the socket like any
  // other edit. Writing them locally as well would push a second Y.Map per
  // object_id and hand the snapshot's dedupe pass a collision to resolve — with
  // no UNIQUE index behind object_id, that collision reaches D1 as a duplicate
  // row rather than a refusal.
  // --------------------------------------------------------------------
  // The modal names the objects it registered: the page's own pending list
  // can already belong to another upload by the time the notice fires.
  function handleObjectsRegistered(pending: PendingObject[]) {
    for (const p of pending) {
      showToast({
        message: tStructural("toast_object_added", {
          title: p.title ?? p.object_id,
        }),
        type: "info",
      });
    }
  }

  // Row keys come from the shared keyFor helper (see ~/lib/item-key). It keys
  // on _tempId first so a key stays stable when snapshotToD1 backfills the
  // numeric D1 id after creation; an id-first key would flip at backfill.
  // order_key order is the canonical order and drag-to-reorder was removed, so
  // no sortable id is needed.

  // Remote-delete toast — fires when an object disappears from the Y.Array
  // because a peer removed it. Shared logic in useRemoteDeleteToast.
  useRemoteDeleteToast({
    items: yjsObjects ?? [],
    enabled: useYjs,
    scope: ydoc,
    getLabel: (o) => o.title ?? o.object_id,
  });

  // --------------------------------------------------------------------
  // Default order + substring filter. The sort and status
  // selects were dropped; the default order is order_key order in Yjs mode
  // (an object's place is a field on the object, not its Y.Array position)
  // and title order in the non-Yjs fallback. The page-head ?q= filter then
  // narrows the list via matchesObjectFilter (substring on
  // title/creator/year/object_id).
  // --------------------------------------------------------------------
  const sourceList: YjsObjectRow[] = useYjs
    ? [...(yjsObjects ?? [])].sort(compareByOrderKey)
    : (sortObjects(loaderObjects as YjsObjectRow[]) as YjsObjectRow[]);
  const processedObjects: YjsObjectRow[] = useMemo(
    () =>
      sourceList.filter((o) =>
        matchesObjectFilter(
          {
            title: o.title,
            // Non-Yjs loader rows carry `creator` directly; Yjs rows expose it
            // as `_creator` (read from the Y.Map in yMapToObjectRow).
            creator:
              o._creator ??
              (o as { creator?: string | null }).creator ??
              null,
            year: o.year ?? null,
            object_id: o.object_id,
          },
          query,
        ),
      ),
    [sourceList, query],
  );

  const hasObjects = sourceList.length > 0;
  // isConvenor still gates sync-from-GitHub and delete authority — those stay
  // convenor-only. canUpload is the separate, broader check the Upload tab
  // and the object-write commit flow use (any publishing role).
  const isConvenor = userRole === "convenor";
  const canUpload = isPublishingRole(userRole);
  // What the Upload tab shows in place of the upload flow on a site behind
  // the latest release — see ~/lib/upload-notice for who is told what.
  // Metadata editing, IIIF and external-object creation are unaffected: they
  // run through the collaboration document, not the repo.
  const { reason: uploadDisabledReason, action: uploadDisabledAction } = describeUploadNotice(
    uploadNotice(appLoaderData),
    t,
  );

  // Display-only external-IIIF thumbnails, keyed by object_id. The Y.Doc is
  // seeded from D1 without the thumbnail column (workers/collaboration.ts), so
  // external IIIF rows have no Yjs thumbnail; the loader resolves the URL from
  // the manifest and returns it here. Nothing is persisted or hosted — the value
  // is a URL pointing at the external IIIF server, used purely as a render fallback.
  const fallbackThumbnails = new Map(
    (loaderObjects as ObjectRowObject[])
      .filter((o) => o.thumbnail)
      .map((o) => [o.object_id, o.thumbnail as string]),
  );

  return (
    <div className="max-w-7xl mx-auto">
      {/* A collaborator whose upgrade the installation's missing
          workflows:write permission would refuse (see routes/_app.tsx's
          upgradeAwaitsConvenor) is not redirected to /upgrade — that would
          only loop them back here. Told plainly instead: the convenor has
          to grant the permission before the upgrade can proceed. */}
      {upgradeAwaitsConvenor && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6">
          <p className="font-body text-sm text-amber-900">
            {tCommon("upgrade_awaits_convenor")}
          </p>
        </div>
      )}

      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-4">
          <h1 className="font-heading font-bold text-2xl text-charcoal">
            {t("title")}
          </h1>
          {openDoc && <DocsLink docId="objects" onOpenDoc={openDoc} />}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Substring filter — ?q= state */}
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("filter_placeholder")}
            aria-label={t("filter_placeholder")}
            className="w-56 font-body text-sm text-charcoal bg-surface border border-gray-200 rounded-md px-3 py-1.5"
          />

          {/* Sync from GitHub — convenor-only ghost button.
              Repo writes require convenor; collaborators see only filter + Add. */}
          {isConvenor && (
            <button
              type="button"
              onClick={handleSyncClick}
              disabled={isComputing || awaitingDoc}
              className="inline-flex items-center gap-1.5 border border-gray-200 text-charcoal hover:bg-cream font-heading font-semibold text-sm uppercase tracking-wider rounded-full px-4 py-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RefreshCw className="w-4 h-4" />
              {t("sync_from_github")}
            </button>
          )}

          {/* Single +Add object — opens the unified AddObjectDialog */}
          <button
            type="button"
            onClick={handleAddObjectClick}
            disabled={awaitingDoc}
            className="inline-flex items-center justify-center bg-anil hover:bg-anil-hover text-charcoal font-heading font-semibold text-sm uppercase tracking-wider rounded-full px-4 py-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t("add_object_button")}
          </button>

        </div>
      </div>

      {/* Main content area — shifts left when side panel is open on lg+ */}
      <div>
        {!hasObjects ? (
          <ObjectsEmptyState
            onSync={handleSyncClick}
            onAddIiif={handleAddObjectClick}
            awaitingSync={awaitingDoc}
          />
        ) : (
          <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
            <ObjectsLoadingNote awaiting={awaitingDoc} />
            {processedObjects.length === 0 ? (
              <p className="font-body text-sm text-gray-500 text-center py-8">
                {query.trim() !== "" ? t("filter_no_matches") : ""}
              </p>
            ) : (
              // Single ObjectRow render (drag-to-reorder removed, both
              // branches collapsed). Yjs-only props (delete affordance, the
              // validation badge) render conditionally via the useYjs flag.
              processedObjects.map((object) => {
                const validationState = useYjs
                  ? object._validationState ?? null
                  : null;
                const isCourseItem = object.course_project_id != null;
                return (
                  <div key={String(keyFor(object))}>
                    <ObjectRow
                      object={object}
                      onToggleFeatured={handleToggleFeatured}
                      readOnly={awaitingDoc}
                      siteBaseUrl={siteBaseUrl}
                      frameworkVersion={frameworkVersion}
                      sharedSiteId={ownValue(loaderSharedSiteIds, object.object_id)}
                      fallbackThumbnail={
                        fallbackThumbnails.get(object.object_id) ?? null
                      }
                      usedInSteps={ownValue(stepCounts, object.object_id) ?? 0}
                      onThumbnailFailed={handleThumbnailFailed}
                      onThumbnailRefreshed={handleThumbnailRefreshed}
                      {...(useYjs
                        ? {
                            onDelete: () => handleDeleteRequest(object),
                            canDelete: object._yMap
                              ? ops!.canDelete(object._yMap)
                              : isConvenor && !isCourseItem,
                            deleteTooltip: isCourseItem
                              ? t("course_item_delete_refused")
                              : tStructural("tooltip_cannot_delete"),
                          }
                        : {})}
                    />
                    {isCourseItem && (
                      <p className="px-4 pb-2 -mt-1">
                        <span className="inline-flex items-center gap-1.5 font-body text-xs rounded-full px-2 py-0.5 bg-anil-pale text-anil-ink">
                          <GraduationCap className="w-3 h-3 shrink-0" />
                          {t("course_item_badge")}
                        </span>
                      </p>
                    )}
                    <ManifestValidationNote state={validationState} />
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Sync diff dialog */}
      <SyncDiffDialog
        key={syncCheckId}
        open={syncDialogOpen}
        onClose={closeSyncDialogAndDiff}
        diffData={syncDiffData}
        onApply={handleSyncApply}
        isComputing={isComputing}
        isApplying={isApplying}
        notice={syncNotice}
      />

      <SheetChoicesDialog question={syncQuestion} onChosen={() => { setSyncQuestion(null); handleSyncClick(); }} onClose={() => setSyncQuestion(null)} />

      {/* Unified Add Object dialog (IIIF / Upload / External) */}
      <AddObjectDialog
        open={addObjectOpen}
        onClose={() => {
          setAddObjectOpen(false);
          setIiifFetchResult(null);
          setUploadError(null);
          setUploadErrorCode(null);
        }}
        projectId={project.id}
        canUpload={canUpload}
        uploadDisabledReason={uploadDisabledReason}
        uploadDisabledAction={uploadDisabledAction}
        fetchResult={dialogFetchResult}
        onFetchUrl={handleIiifFetch}
        onIiifConfirm={handleIiifConfirm}
        isFetching={isFetchingIiif}
        onUploadConfirm={handleUploadConfirm}
        isUploading={isUploading}
        uploadError={uploadError}
        uploadErrorAction={describeUploadRefusalAction(uploadErrorCode, t)}
        existingObjectIds={(loaderObjects as Array<{ object_id: string }>).map((o) => o.object_id)}
        onExternalConfirm={handleExternalConfirm}
        isAdding={isAddingIiif}
      />

      {/* Commit and build modal */}
      <CommitAndBuildModal
        open={commitModalOpen}
        sheetsEnabled={sheetsEnabled}
        objectsFile={objectsFile}
        checkPending={commitCheckPending(checkedSite, project.id, sheetsFetcher.state)}
        checkFailed={checkCouldNotBeMade}
        onRetryCheck={() => sheetsFetcher.submit({ intent: "pre-commit-check" }, { method: "post" })}
        urlMismatch={urlMismatch}
        pendingObjects={pendingObjects}
        skipCommit={isUploadFlow}
        dispatchRunId={dispatchRunId}
        dispatchHtmlUrl={dispatchHtmlUrl}
        registration={uploadRegistration}
        projectId={uploadProjectId}
        onClose={handleCommitCancel}
        onBuildSuccess={handleBuildSuccess}
        onBuildFailed={handleBuildFailed}
        onRegistered={handleObjectsRegistered}
      />

      {/* Delete confirmation */}
      <DeleteConfirmationModal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        entityType="object"
        entityLabel={deleteTarget?.object.title ?? deleteTarget?.object.object_id ?? ""}
        contributors={deleteTarget?.contributors}
      />

      {/* Full-repo sync review (?sync=1 deep-link) */}
      <SyncConfirmModal
        open={fullSyncModalOpen}
        unpublishedCount={unpublishedCount}
        countKnown={countKnown}
        onClose={() => setFullSyncModalOpen(false)}
      />
    </div>
  );
}
