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
 * As the daily home, this page also hosts the full-repo sync review
 * modal (SyncConfirmModal, opened via the `?sync=1` deep-link) — not
 * to be confused with this route's own objects-scoped SyncDiffDialog.
 * The modal's intents live on the /dashboard action; this page only
 * mounts it and surfaces the version-change toast.
 *
 * @version v1.4.3-beta
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, redirect, useFetcher, useOutletContext, useRouteLoaderData, useSearchParams } from "react-router";
import * as Y from "yjs";
import { RefreshCw } from "lucide-react";
import type { Route } from "./+types/_app.objects";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { projects, objects, project_config, project_members, users } from "~/db/schema";
import { resolveActiveProjectFromRequest } from "~/lib/active-project.server";
import { resetCollabDocIfBlobExists } from "~/lib/collab-reset.server";
import { getObjectStepCounts } from "~/lib/objects.server";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { useStructuralOps } from "~/hooks/use-structural-ops";
import { useYjsArraySync } from "~/hooks/use-yjs-array-sync";
import { findYMapById, findYMapByIdOrTempId } from "~/lib/yjs-helpers";
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
import { fetchAndParseManifest } from "~/lib/iiif.server";
import { deriveStatus } from "~/lib/iiif-types";
import type { IiifFetchResult } from "~/lib/iiif-types";
import { decrypt } from "~/lib/crypto.server";
import { getRepoTree, getFileContent } from "~/lib/github.server";
import { computeSyncDiff, applySyncChanges } from "~/lib/sync.server";
import { bumpProjectHead } from "~/lib/github-status.server";
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
import { getInstallationToken } from "~/lib/github-app.server";
import { serializeObjectsCsv, dbObjectToCsvRow } from "~/lib/csv-export.server";
import { ObjectRow } from "~/components/features/objects/ObjectRow";
import { ObjectsEmptyState } from "~/components/features/objects/ObjectsEmptyState";
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
import { makeObjectYMap } from "~/lib/object-ymap";
import { commitMultipleBinaryFilesWithCsv, arrayBufferToBase64, validateUploadFile } from "~/lib/upload.server";
import type { SyncApplyPayload } from "~/components/features/objects/SyncDiffDialog";

// "dashboard" and "upgrade" ride along for the full-repo sync review modal
// this page hosts (SyncConfirmModal + its version-change toast).
export const handle = { i18n: ["common", "objects", "structural", "dashboard", "upgrade"] };

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

  // Lazy-enrich objects that haven't been checked yet.
  // External IIIF (has source_url): fetch manifest for thumbnail; always
  //   image_available=true because zoom is available via the IIIF Image API.
  // Self-hosted (no source_url): check repo tree for iiif/objects/{id}/.
  // Runs once per object — after enrichment the fields are populated.
  const unenrichedExternal = projectObjects.filter(
    (o) => o.source_url && o.thumbnail === null
  );
  const unenrichedSelfHosted = projectObjects.filter(
    (o) => !o.source_url && !o.image_available
  );

  // Enrich external IIIF objects (fetch manifests in parallel)
  if (unenrichedExternal.length > 0) {
    const results = await Promise.allSettled(
      unenrichedExternal.map(async (obj) => {
        const result = await fetchAndParseManifest(obj.source_url!);
        if (!result.ok) return null;
        const { metadata } = result;
        // Only fill fields that are currently empty — don't overwrite
        // metadata the user has already entered manually.
        const updates: Record<string, unknown> = {
          image_available: true,
          updated_at: new Date().toISOString(),
        };
        if (!obj.thumbnail && metadata.thumbnail) updates.thumbnail = metadata.thumbnail;
        if (!obj.title && metadata.title) updates.title = metadata.title;
        if (!obj.creator && metadata.creator) updates.creator = metadata.creator;
        if (!obj.description && metadata.description) updates.description = metadata.description;
        if (!obj.source && metadata.source) updates.source = metadata.source;
        if (!obj.credit && metadata.credit) updates.credit = metadata.credit;
        if (!obj.period && metadata.period) updates.period = metadata.period;
        if (!obj.object_type && metadata.object_type) updates.object_type = metadata.object_type;

        await db
          .update(objects)
          .set(updates)
          .where(eq(objects.id, obj.id));

        // Update in-memory objects so the current request reflects changes
        obj.image_available = true;
        if (updates.thumbnail) obj.thumbnail = metadata.thumbnail;
        if (updates.title) obj.title = metadata.title;
        if (updates.creator) obj.creator = metadata.creator;
        if (updates.description) obj.description = metadata.description;
        if (updates.source) obj.source = metadata.source;
        if (updates.credit) obj.credit = metadata.credit;
        if (updates.period) obj.period = metadata.period as string;
        if (updates.object_type) obj.object_type = metadata.object_type as string;
        return obj.id;
      })
    );
    void results;
  }

  // Enrich self-hosted objects (check repo tree for IIIF tile directories)
  if (unenrichedSelfHosted.length > 0) {
    try {
      const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
      const [owner, repo] = activeProject.github_repo_full_name.split("/");
      const { tree } = await getRepoTree(token, owner, repo);
      const imageExtensions = new Set(["jpg", "jpeg", "png", "tif", "tiff", "pdf"]);
      const iiifObjectIds = new Set(
        tree
          .filter((entry) => {
            if (entry.type !== "blob") return false;
            const parts = entry.path.split("/");
            if (parts.length !== 3 || parts[0] !== "telar-content" || parts[1] !== "objects") return false;
            const ext = parts[2].split(".").pop()?.toLowerCase() ?? "";
            return imageExtensions.has(ext);
          })
          .map((entry) => entry.path.split("/")[2].replace(/\.[^.]+$/, ""))
      );
      const toUpdateIds = unenrichedSelfHosted
        .filter((obj) => iiifObjectIds.has(obj.object_id))
        .map((obj) => obj.id);

      if (toUpdateIds.length > 0) {
        await db
          .update(objects)
          .set({ image_available: true, updated_at: new Date().toISOString() })
          .where(inArray(objects.id, toUpdateIds));
        // Update in-memory objects to reflect changes
        for (const obj of unenrichedSelfHosted) {
          if (toUpdateIds.includes(obj.id)) obj.image_available = true;
        }
      }
    } catch {
      // Silently ignore — self-hosted objects stay unenriched until next load
    }
  }

  // Count step references per object_id, scoped to the active project (a
  // global count would inflate shared seeded slugs like `telar-placeholder`).
  const objectStepCounts = await getObjectStepCounts(db, activeProject.id);

  // Fetch project config for self-hosted thumbnail URL construction
  const [config] = await db
    .select()
    .from(project_config)
    .where(eq(project_config.project_id, activeProject.id))
    .limit(1);

  const siteBaseUrl = config?.url
    ? `${config.url}${config.baseurl ?? ""}`
    : null;

  return {
    project: activeProject,
    objects: projectObjects,
    objectStepCounts,
    siteBaseUrl,
    members,
    currentUserId: user.id,
    userRole,
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ request, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  switch (intent) {
    case "toggle-featured": {
      const objectDbId = Number(formData.get("objectDbId"));
      const currentValue = formData.get("currentValue") === "true";
      const resolved = await resolveActiveProjectFromRequest(request, env, user.id);
      if (!resolved) return { ok: false, intent: "toggle-featured", error: "no_project" };
      await db
        .update(objects)
        .set({ featured: !currentValue, updated_at: new Date().toISOString() })
        .where(and(eq(objects.id, objectDbId), eq(objects.project_id, resolved.project.id)));
      return { ok: true, intent: "toggle-featured" };
    }

    case "compute-sync-diff": {
      // Membership-aware resolution — the old owner-only query with the
      // ?? allProjects[0] fallback could diff the WRONG owned project when
      // the session id pointed elsewhere. Sync is convenor-only in the UI;
      // enforce the same here.
      const resolvedDiff = await resolveActiveProjectFromRequest(request, env, user.id);
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
        const diff = await computeSyncDiff(
          activeProject.id,
          token,
          owner,
          repo,
          db
        );
        return { ok: true, intent: "compute-sync-diff", diff };
      } catch (err) {
        return {
          ok: false,
          intent: "compute-sync-diff",
          error: "sync_failed",
          message: err instanceof Error ? err.message : "Unknown error",
        };
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
      const resolvedApply = await resolveActiveProjectFromRequest(request, env, user.id);
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

        const { appliedCount, pendingObjects, removedObjectIds } = await applySyncChanges(
          activeProject.id,
          changes,
          token,
          owner,
          repo,
          db
        );
        return { ok: true, intent: "sync-apply", appliedCount, pendingObjects, removedObjectIds };
      } catch (err) {
        return {
          ok: false,
          intent: "sync-apply",
          error: "apply_failed",
          message: err instanceof Error ? err.message : "Unknown error",
        };
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

    case "delete-object": {
      // Convenor-only deletion of self-hosted objects requiring repo cleanup.
      // IIIF / external objects are deleted client-side via the Y.Array only
      // snapshotToD1 handles the D1 row removal on the next cycle.
      const objectDbId = Number(formData.get("objectDbId"));
      if (!objectDbId) {
        return { ok: false, intent: "delete-object", error: "missing_id" };
      }

      // Verify ownership + project scope.
      const resolvedDel = await resolveActiveProjectFromRequest(request, env, user.id);
      if (!resolvedDel) {
        return { ok: false, intent: "delete-object", error: "no_project" };
      }
      if (resolvedDel.userRole !== "convenor") {
        return { ok: false, intent: "delete-object", error: "forbidden" };
      }
      const delActiveProject = resolvedDel.project;

      // Remove the row; the repo-side cleanup (folder removal + CSV update)
      // happens lazily on the next publish cycle — we keep this action light
      // so the Y.Array removal on the client remains the primary signal.
      await db
        .delete(objects)
        .where(and(eq(objects.id, objectDbId), eq(objects.project_id, delActiveProject.id)));

      return { ok: true, intent: "delete-object", deleted: true };
    }

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
      // the wrong project on a stale session). The Upload tab is convenor-
      // gated in the UI; enforce the same server-side.
      const resolvedUpload = await resolveActiveProjectFromRequest(request, env, user.id);
      if (!resolvedUpload) {
        return { ok: false, intent: "upload-image", error: "no_project" };
      }
      if (resolvedUpload.userRole !== "convenor") {
        return { ok: false, intent: "upload-image", error: "forbidden" };
      }
      const uploadActiveProject = resolvedUpload.project;

      // Everything from here to the commit runs inside try/catch: decrypt,
      // slug generation (D1 queries), file reads, the CSV fetch and the D1
      // object listing can all throw, and an uncaught throw becomes an opaque
      // 500. Issue #25's report ("check your connection", deterministic)
      // came from failures in this region being either thrown or collapsed.
      try {
      const uploadToken = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
      const [uploadOwner, uploadRepo] = uploadActiveProject.github_repo_full_name.split("/");

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

        // 5. Derive file extension from MIME type (not filename) to prevent extension spoofing
        const mimeToExt: Record<string, string> = {
          "image/jpeg": "jpg",
          "image/png": "png",
          "image/tiff": "tif",
        };
        const ext = mimeToExt[imageFile.type] ?? "jpg";
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
          source_url: null,
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

      // 8. Serialise objects.csv — merge ALL new objects in a single pass
      const uploadExistingCsv = await getFileContent(uploadToken, uploadOwner, uploadRepo, "telar-content/spreadsheets/objects.csv");

      const uploadProjectObjects = await db.select().from(objects)
        .where(eq(objects.project_id, uploadActiveProject.id))
        .orderBy(asc(objects.object_id));
      const uploadExportableObjects = uploadProjectObjects.filter((o) => !o.missing_from_repo);

      const uploadAllObjectsForCsv = [
        ...uploadExportableObjects,
        ...uploadPendingObjects.map((p) => ({
          ...p,
          alt_text: p.alt_text ?? null,
          missing_from_repo: false,
        })),
      ].sort((a, b) => a.object_id.localeCompare(b.object_id));

      const uploadCsvContent = serializeObjectsCsv(uploadAllObjectsForCsv.map(dbObjectToCsvRow), uploadExistingCsv ?? undefined);

      // 9. Commit all images + CSV atomically in a single Git commit.
      // The repo WRITE uses the App installation token — it carries
      // contents:write on the repo regardless of the signed-in user's own
      // GitHub access (an owner whose personal access lapsed, e.g. after a
      // repo transfer, previously failed here with the generic copy). The
      // user token is the local-dev fallback, matching _app.upgrade.tsx.
      let uploadCommitToken = uploadToken;
      try {
        uploadCommitToken = await getInstallationToken(
          env.GITHUB_APP_ID,
          env.GITHUB_PRIVATE_KEY,
          uploadActiveProject.installation_id,
        );
      } catch {
        // Installation token unavailable (local dev) — fall back to user token
      }

      const commitLabel = uploadPendingObjects.map((p) => p.object_id).join(", ");
      const uploadCommitResult = await commitMultipleBinaryFilesWithCsv({
        token: uploadCommitToken,
        owner: uploadOwner,
        repo: uploadRepo,
        branch: "main",
        images: imagePayloads,
        csvContent: uploadCsvContent,
        commitMessage: `Add ${commitLabel} via Telar Compositor`,
      });

      // 10. Update project head_sha (also invalidates GitHub status cache)
      await bumpProjectHead(db, uploadActiveProject.id, uploadCommitResult.newHeadSha);

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

      // 12. Return the first pending object for CommitAndBuildModal
      //     (multi-object insert is handled by insert-pending-objects with the full array)
      return {
        ok: true,
        intent: "upload-image",
        objectId: uploadPendingObjects[0].object_id,
        newHeadSha: uploadCommitResult.newHeadSha,
        pendingObject: uploadPendingObjects[0],
        pendingObjects: uploadPendingObjects,
        dispatchRunId,
        dispatchHtmlUrl,
      };
      } catch (err) {
        // No D1 rollback needed — nothing was inserted (pending-object pattern)
        if (err instanceof StaleHeadError) {
          return { ok: false, intent: "upload-image", error: "stale_head" };
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("413") || msg.includes("too large")) {
          return { ok: false, intent: "upload-image", error: "payload_too_large" };
        }
        return { ok: false, intent: "upload-image", error: "upload_failed" };
      }
    }

    case "pre-commit-check": {
      // Membership-aware resolution (no first-owned-project fallback). This
      // check is read-only and fail-open by design, so any internal failure
      // degrades to the same benign default instead of an uncaught 500.
      const resolvedCheck = await resolveActiveProjectFromRequest(request, env, user.id);
      if (!resolvedCheck) {
        return { ok: true, intent: "pre-commit-check", sheetsEnabled: false, urlCheck: { match: true, pagesUrl: "", configUrl: "" } };
      }
      const activeProject = resolvedCheck.project;

      try {
        const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
        const [owner, repo] = activeProject.github_repo_full_name.split("/");

        const content = await getFileContent(token, owner, repo, "_config.yml");
        if (content === null) {
          return { ok: true, intent: "pre-commit-check", sheetsEnabled: false, urlCheck: { match: true, pagesUrl: "", configUrl: "" } };
        }

        const sheetsEnabled = isGoogleSheetsEnabled(content);
        const urlCheck = await verifySiteUrl(token, owner, repo, content);

        return { ok: true, intent: "pre-commit-check", sheetsEnabled, urlCheck };
      } catch {
        return { ok: true, intent: "pre-commit-check", sheetsEnabled: false, urlCheck: { match: true, pagesUrl: "", configUrl: "" } };
      }
    }

    case "commit-objects": {
      // Membership-aware resolution + convenor gate (the commit modal flows
      // are convenor-only in the UI; the old owner-only query could commit
      // to the wrong owned project on a stale session).
      const resolvedCommit = await resolveActiveProjectFromRequest(request, env, user.id);
      if (!resolvedCommit) {
        return { ok: false, intent: "commit-objects", error: "no_project" };
      }
      if (resolvedCommit.userRole !== "convenor") {
        return { ok: false, intent: "commit-objects", error: "forbidden" };
      }
      const activeProject = resolvedCommit.project;

      const disableSheets = formData.get("disableSheets") === "true";

      // token/owner/repo escape the try below: the post-commit dispatch needs
      // them after the commit has already succeeded.
      let token: string;
      let owner: string;
      let repo: string;
      let commitResult: { newHeadSha: string };

      try {
      token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
      [owner, repo] = activeProject.github_repo_full_name.split("/");

      // Server-side recheck — supersedes client-passed fixUrl/pagesUrl.
      // The client form fields (CommitAndBuildModal: fixUrl, pagesUrl) are
      // derived from a `pre-commit-check` fired on mount; if the user opens
      // the modal hours later or the repo's _config.yml has been edited
      // externally, those flags are stale. We re-run verifySiteUrl here with
      // a freshly fetched _config.yml and override the fix flags from that
      // result. The fetched configContent is reused by the rewrite block
      // below, avoiding a second getFileContent round-trip.
      // (image-upload flow)
      let configContent = await getFileContent(token, owner, repo, "_config.yml");
      let fixUrl = false;
      let pagesUrl: string | null = null;
      if (configContent) {
        const urlCheck = await verifySiteUrl(token, owner, repo, configContent);
        if (urlCheck.pagesEnabled && !urlCheck.match) {
          fixUrl = true;
          pagesUrl = urlCheck.pagesUrl;
        }
      }

      // Parse pending objects from form data (not yet in D1)
      const pendingJson = formData.get("pendingObjects") as string | null;
      const pendingObjects: PendingObject[] = pendingJson ? JSON.parse(pendingJson) : [];

      // Query existing D1 objects, excluding missing_from_repo
      const projectObjects = await db
        .select()
        .from(objects)
        .where(eq(objects.project_id, activeProject.id))
        .orderBy(asc(objects.object_id));

      const exportableObjects = projectObjects.filter((o) => !o.missing_from_repo);

      // Merge existing D1 objects with pending objects for CSV generation
      const allObjectsForCsv = [
        ...exportableObjects,
        ...pendingObjects.map((p) => ({
          ...p,
          alt_text: p.alt_text ?? null,
          missing_from_repo: false,
        })),
      ].sort((a, b) => a.object_id.localeCompare(b.object_id));

      // Read existing CSV to preserve comment/instruction rows
      const existingCsv = await getFileContent(token, owner, repo, "telar-content/spreadsheets/objects.csv");
      const csvContent = serializeObjectsCsv(allObjectsForCsv.map(dbObjectToCsvRow), existingCsv ?? undefined);

      const files: Array<{ path: string; content: string }> = [
        { path: "telar-content/spreadsheets/objects.csv", content: csvContent },
      ];

      const commitParts = ["Updated objects.csv"];

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

            // Also update project_config in D1
            await db
              .update(project_config)
              .set({ url: newUrl, baseurl: newBaseurl, updated_at: new Date().toISOString() })
              .where(eq(project_config.project_id, activeProject.id));
          }
          files.push({ path: "_config.yml", content: configContent });
        }
      }

      const commitMessage = `${commitParts.join(", ")} via Telar Compositor`;

      // Repo WRITE on the App installation token (contents:write independent
      // of the user's own GitHub access); user token is the local-dev
      // fallback — matching the upload flow and _app.upgrade.tsx.
      let commitToken = token;
      try {
        commitToken = await getInstallationToken(
          env.GITHUB_APP_ID,
          env.GITHUB_PRIVATE_KEY,
          activeProject.installation_id,
        );
      } catch {
        // Installation token unavailable (local dev) — fall back to user token
      }

      // Commit with [skip ci] to prevent the full build.yml from firing.
      // Full build dispatched below to deploy changes via GitHub Pages.
      commitResult = await commitFilesToRepo(
        commitToken, owner, repo, "main", files, commitMessage,
        undefined, undefined,
        true, // skipCi — suppress full build
      );

      // Update projects.head_sha (also invalidates GitHub status cache)
      await bumpProjectHead(db, activeProject.id, commitResult.newHeadSha);
      } catch (err) {
        if (err instanceof StaleHeadError) {
          return { ok: false, intent: "commit-objects", error: "stale_head" };
        }
        return {
          ok: false,
          intent: "commit-objects",
          error: "commit_failed",
          message: err instanceof Error ? err.message : "Unknown error",
        };
      }

      // Post-commit: the sheets-flag repair is best-effort and must NOT flip
      // the result — the repo commit already landed and head_sha is bumped, so
      // a D1/DO hiccup here misreporting commit_failed would send the client
      // down its discard path and strand rows already committed to the repo
      // (same isolation as the dispatch block below). The D1 write flips the
      // cached flag; the collab-doc reset keeps a warm Y.Doc still holding
      // google_sheets_enabled=true from clobbering it back on its next
      // snapshot (the same guard onboarding's fix-site-config uses). If either
      // fails, the settings-page reconcile repairs the flag on its next load.
      if (disableSheets) {
        try {
          await db
            .update(project_config)
            .set({ google_sheets_enabled: false, updated_at: new Date().toISOString() })
            .where(eq(project_config.project_id, activeProject.id));
          await resetCollabDocIfBlobExists(db, env as never, activeProject.id);
        } catch {
          // Best-effort — see above.
        }
      }

      // Post-commit: dispatch is best-effort and must NOT flip the result —
      // the commit already landed and head_sha is bumped. (Previously a
      // getInstallationToken failure here returned commit_failed for a commit
      // that succeeded, sending users into stale-head retries; and a silently
      // swallowed dispatch failure left the modal polling by SHA for a run
      // that never started. dispatchFailed tells the modal to skip build
      // tracking — tiles regenerate on the next full build.)
      let commitObjectsDispatchRunId: number | null = null;
      try {
        let dispatchToken = token;
        try {
          dispatchToken = await getInstallationToken(
            env.GITHUB_APP_ID,
            env.GITHUB_PRIVATE_KEY,
            activeProject.installation_id,
          );
        } catch {
          // Installation token unavailable (local dev) — try user token
        }
        const dispatch = await dispatchWorkflow(dispatchToken, owner, repo, "build.yml");
        commitObjectsDispatchRunId = dispatch.runId || null;
      } catch {
        // Dispatch failed — objects committed, processing deferred to next full build
      }

      return {
        ok: true,
        intent: "commit-objects",
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
      const resolvedPoll = await resolveActiveProjectFromRequest(request, env, user.id);
      if (!resolvedPoll) {
        return { ok: false, intent: "poll-build", error: "no_project" };
      }
      const activeProject = resolvedPoll.project;

      try {
        const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
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

        const run = runs[0];

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

    case "insert-pending-objects": {
      // Hardened for telar-compositor#24: by the time this intent fires the
      // images are ALREADY committed to the repo by upload-image, so any
      // failure here strands them (repo/D1 divergence). The action must never
      // throw — an uncaught throw becomes an opaque 500 that white-screens the
      // route — and must be idempotent so the modal's retry cannot duplicate
      // rows (objects has no UNIQUE(project_id, object_id)).
      const pendingJson = formData.get("pendingObjects") as string | null;
      if (!pendingJson) {
        return { ok: false, intent: "insert-pending-objects", error: "missing_data" };
      }

      let pendingObjects: PendingObject[];
      try {
        const parsed = JSON.parse(pendingJson);
        if (!Array.isArray(parsed)) throw new Error("pendingObjects must be an array");
        pendingObjects = parsed;
      } catch {
        return { ok: false, intent: "insert-pending-objects", error: "missing_data" };
      }

      const resolvedIns = await resolveActiveProjectFromRequest(request, env, user.id);
      if (!resolvedIns) {
        return { ok: false, intent: "insert-pending-objects", error: "no_project" };
      }
      const activeProject = resolvedIns.project;

      try {
        // Idempotency pre-check: a retry after a mid-chunk failure (or a
        // double submit) re-sends the same pending objects. Skip object_ids
        // that already have a D1 row, but return them WITH their canonical ids
        // so the client's Y.Array mirror still works on the retry pass.
        const existingRows = await db
          .select({ id: objects.id, object_id: objects.object_id })
          .from(objects)
          .where(eq(objects.project_id, activeProject.id));
        const existingByKey = new Map(existingRows.map((r) => [r.object_id, r.id]));

        const rows = pendingObjects
          .filter((p) => !existingByKey.has(p.object_id))
          .map((p) => ({
            project_id: activeProject.id,
            object_id: p.object_id,
            title: p.title,
            featured: p.featured,
            creator: p.creator,
            description: p.description,
            source_url: p.source_url,
            period: p.period,
            year: p.year,
            object_type: p.object_type,
            subjects: p.subjects,
            source: p.source,
            credit: p.credit,
            thumbnail: p.thumbnail,
            image_available: p.image_available,
            missing_from_repo: false,
            origin: (p as any).origin ?? "compositor",
            alt_text: (p as any).alt_text ?? null,
            dimensions: (p as any).dimensions ?? null,
            extra_columns: (p as any).extra_columns ?? null,
          }));

        type InsertedRow = { id: number; object_id: string };
        const inserted: InsertedRow[] = pendingObjects
          .filter((p) => existingByKey.has(p.object_id))
          .map((p) => ({ id: existingByKey.get(p.object_id)!, object_id: p.object_id }));

        // D1 caps bound parameters at 100 per INSERT. Each objects row binds
        // 21 params — the 20 explicit columns above plus the updated_at
        // $defaultFn that Drizzle auto-binds — so a chunk holds at most 4 rows
        // (84 params); 5 rows would bind 105 and D1 rejects the statement
        // ("too many SQL variables"). Collect inserted rows so the client can
        // mirror them into the Yjs Y.Array with canonical D1 ids (self-hosted
        // objects appear in the shared doc only after the repo build succeeds
        // and the D1 INSERT completes; the snapshot writes them as UPDATEs on
        // the next cycle).
        const maxRows = 4;
        for (let i = 0; i < rows.length; i += maxRows) {
          const chunk = await db
            .insert(objects)
            .values(rows.slice(i, i + maxRows))
            .returning({ id: objects.id, object_id: objects.object_id });
          for (const row of chunk) inserted.push(row);
        }

        return {
          ok: true,
          intent: "insert-pending-objects",
          insertedCount: rows.length,
          inserted,
        };
      } catch (err) {
        return {
          ok: false,
          intent: "insert-pending-objects",
          error: "insert_failed",
          message: err instanceof Error ? err.message : "Unknown error",
        };
      }
    }

    default:
      throw new Response("Bad request", { status: 400 });
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
  _yMap?: Y.Map<unknown> | null;
  _validationState?: "pending" | "valid" | "error" | null;
  _validationError?: string | null;
  /** origin: "iiif" (added via Yjs) vs "repo" (self-hosted upload). */
  _origin?: string | null;
  /** Creator string (read from the Y.Map) — used only by the ?q= filter. */
  _creator?: string | null;
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
  const origin = (yMap.get("origin") as string | null) ?? null;
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
    _yMap: yMap,
    _validationState: validationState,
    _validationError: validationError,
    _origin: origin,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

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
    members,
    currentUserId,
    userRole,
  } = loaderData;

  const { ydoc } = useCollaborationContext();
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

  // Sync dialog state
  const [syncDialogOpen, setSyncDialogOpen] = useState(false);
  const [syncDiffData, setSyncDiffData] = useState<SyncDiff | null>(null);

  // Unified Add Object dialog state (replaces the chooser + AddIiif + Upload
  // trio). The IIIF tab still drives the iiif-preview fetch.
  const [addObjectOpen, setAddObjectOpen] = useState(false);
  const [iiifFetchResult, setIiifFetchResult] = useState<IiifFetchResult | null>(null);

  // Commit modal state
  const [commitModalOpen, setCommitModalOpen] = useState(false);
  const [pendingObjects, setPendingObjects] = useState<PendingObject[]>([]);
  const [sheetsEnabled, setSheetsEnabled] = useState(false);
  const [urlMismatch, setUrlMismatch] = useState<{ pagesUrl: string; configUrl: string } | null>(null);
  // Upload flow: dispatch run ID for direct polling (skips commit step in modal)
  const [dispatchRunId, setDispatchRunId] = useState<number | null>(null);
  const [dispatchHtmlUrl, setDispatchHtmlUrl] = useState<string | null>(null);

  // Upload state (the Upload tab lives inside the unified AddObjectDialog now)
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Guard: tracks whether a new upload has been submitted in the current dialog session
  const [uploadSubmitted, setUploadSubmitted] = useState(false);
  // Tracks whether CommitAndBuildModal was opened from the upload flow (skip commit step)
  const [isUploadFlow, setIsUploadFlow] = useState(false);

  // Fetchers
  const featuredFetcher = useFetcher();
  const syncFetcher = useFetcher();
  const iiifFetcher = useFetcher();
  const sheetsFetcher = useFetcher();
  const uploadFetcher = useFetcher();

  // Handle sync diff result
  const syncFetcherData = syncFetcher.data as
    | { ok: true; intent: "compute-sync-diff"; diff: SyncDiff }
    | { ok: true; intent: "sync-apply"; appliedCount: number; pendingObjects: PendingObject[]; removedObjectIds: string[] }
    | { ok: false; intent: string; error: string }
    | null
    | undefined;

  const iiifFetcherData = iiifFetcher.data as
    | { ok: true; intent: "fetch-iiif-preview"; result: IiifFetchResult }
    | { ok: false; intent: string; error: string }
    | null
    | undefined;

  const preCommitData = sheetsFetcher.data as
    | { ok: true; intent: "pre-commit-check"; sheetsEnabled: boolean; urlCheck: { match: boolean; pagesUrl: string; configUrl: string } }
    | null
    | undefined;

  const uploadFetcherData = uploadFetcher.data as
    | { ok: true; intent: "upload-image"; objectId: string; newHeadSha: string; pendingObject: PendingObject; pendingObjects?: PendingObject[]; dispatchRunId?: number | null; dispatchHtmlUrl?: string | null }
    | { ok: false; intent: "upload-image"; error: string }
    | null
    | undefined;

  // Run pre-commit checks on mount
  useEffect(() => {
    sheetsFetcher.submit({ intent: "pre-commit-check" }, { method: "post" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

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
  // so the modal never re-fires on refresh. unpublishedCount comes from the
  // _app layout loader — the same updated_at proxy the retired dashboard
  // page used to compute for the modal's conflict warning.
  const appLoaderData = useRouteLoaderData("routes/_app") as
    | { unpublishedCount?: number }
    | undefined;
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

  // Update state from pre-commit check result
  useEffect(() => {
    if (preCommitData?.ok && preCommitData.intent === "pre-commit-check") {
      setSheetsEnabled(preCommitData.sheetsEnabled);
      if (!preCommitData.urlCheck.match) {
        setUrlMismatch({ pagesUrl: preCommitData.urlCheck.pagesUrl, configUrl: preCommitData.urlCheck.configUrl });
      } else {
        setUrlMismatch(null);
      }
    }
  }, [preCommitData]);

  // Update sync diff data when compute returns
  useEffect(() => {
    if (syncFetcherData?.ok && syncFetcherData.intent === "compute-sync-diff") {
      setSyncDiffData(syncFetcherData.diff);
    }
  }, [syncFetcherData]);

  // Update IIIF fetch result
  useEffect(() => {
    if (iiifFetcherData?.ok && iiifFetcherData.intent === "fetch-iiif-preview") {
      setIiifFetchResult(iiifFetcherData.result);
    }
  }, [iiifFetcherData]);

  // Close dialogs on successful apply/add → collect pending objects → open commit modal
  useEffect(() => {
    if (syncFetcherData?.ok && syncFetcherData.intent === "sync-apply" && syncDialogOpen) {
      // The sync deleted these objects from D1. Remove their Y.Maps too — the
      // Y.Doc is the source of truth, and the next snapshot would otherwise
      // re-INSERT (resurrect) any object whose Y.Map still exists.
      if (ydoc && ops && syncFetcherData.removedObjectIds?.length) {
        const removed = new Set(syncFetcherData.removedObjectIds);
        const objectsArray = ydoc.getArray<Y.Map<unknown>>("objects");
        const targets: Array<{ id: number | null; tempId: string | null }> = [];
        for (let i = 0; i < objectsArray.length; i++) {
          const m = objectsArray.get(i);
          if (removed.has(String(m.get("object_id") ?? ""))) {
            targets.push({
              id: (m.get("_id") as number | null) ?? null,
              tempId: (m.get("_temp_id") as string | null) ?? null,
            });
          }
        }
        for (const target of targets) ops.deleteObject(target.id, target.tempId);
      }
      setSyncDialogOpen(false);
      setSyncDiffData(null);
      if (syncFetcherData.pendingObjects.length > 0) {
        setPendingObjects(syncFetcherData.pendingObjects);
        sheetsFetcher.submit({ intent: "pre-commit-check" }, { method: "post" });
        setCommitModalOpen(true);
      }
    }
  }, [syncFetcherData, syncDialogOpen, ydoc, ops]);

  // Surface sync failures — previously ok:false results were silently
  // ignored: the dialog hung open (blank content or a stopped spinner) with
  // no feedback at all. Toast the failure and close so the user can retry.
  useEffect(() => {
    if (
      syncFetcherData &&
      !syncFetcherData.ok &&
      (syncFetcherData.intent === "compute-sync-diff" || syncFetcherData.intent === "sync-apply")
    ) {
      showToast({ message: t("sync_error_toast"), type: "destructive" });
      setSyncDialogOpen(false);
      setSyncDiffData(null);
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
      setUploadSubmitted(false);
      // Pass pending objects to CommitAndBuildModal — it will call insert-pending-objects
      // after build success, inserting them to D1 (pending-objects pattern).
      // Images + CSV are already committed by the action; no pre-commit-check needed here.
      setPendingObjects(uploadFetcherData.pendingObjects ?? [uploadFetcherData.pendingObject]);
      setDispatchRunId(uploadFetcherData.dispatchRunId ?? null);
      setDispatchHtmlUrl(uploadFetcherData.dispatchHtmlUrl ?? null);
      setIsUploadFlow(true);
      setCommitModalOpen(true);
    } else if (uploadSubmitted && uploadFetcherData && !uploadFetcherData.ok && uploadFetcherData.intent === "upload-image") {
      setUploadSubmitted(false);
      // Map error codes to i18n keys. Every code the action can return MUST
      // be mapped — unmapped codes fell back to the generic "check your
      // connection" copy, which is how issue #25's real cause stayed hidden.
      const errorMap: Record<string, string> = {
        stale_head: t("upload_error_stale"),
        payload_too_large: t("upload_error_payload"),
        upload_failed: t("upload_error_generic"),
        invalid_format: t("upload_error_format"),
        file_too_large: t("upload_error_size"),
        title_required: t("field_title_required"),
        missing_data: t("upload_error_missing_data"),
        batch_too_large: t("upload_error_batch_full"),
        invalid_object_id: t("upload_error_invalid_id"),
        no_project: t("upload_error_no_project"),
        forbidden: t("upload_error_forbidden"),
      };
      setUploadError(errorMap[uploadFetcherData.error] || t("upload_error_generic"));
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

  // Capture the pending payload at submit time so the Yjs mirror hook has the
  // full metadata to hand even after state changes (upload flow transitions
  // pendingObjects through several setState calls).
  useEffect(() => {
    if (pendingObjects.length > 0) {
      lastInsertedPendingRef.current = pendingObjects;
    }
  }, [pendingObjects]);

  function handleBuildFailed() {
    // Build failed — pending objects were never inserted, nothing to clean up
    setCommitModalOpen(false);
    setPendingObjects([]);
    setDispatchRunId(null);
    setDispatchHtmlUrl(null);
    setIsUploadFlow(false);
  }

  function handleBuildSuccess() {
    // Build succeeded — mark uploaded objects as image_available in Yjs
    if (isUploadFlow && ydoc) {
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
    // User cancelled — pending objects are discarded, nothing was committed
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

  const useYjs = ydoc !== null && ops !== null && yjsObjects !== null;

  // --------------------------------------------------------------------
  // Delete flow — hybrid IIIF vs self-hosted
  // --------------------------------------------------------------------
  const deleteFetcher = useFetcher();
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
    // Self-hosted objects (origin === "repo") require the D1-side delete
    // route action so repo cleanup can run. IIIF objects live only in the
    // Y.Array; the DO snapshot DELETE branch handles D1 removal.
    if (object._origin === "repo" && object.id > 0) {
      deleteFetcher.submit(
        { intent: "delete-object", objectDbId: String(object.id) },
        { method: "post" }
      );
    }
    if (ops) {
      ops.deleteObject(object.id > 0 ? object.id : null, object._tempId ?? null);
    }
    setDeleteTarget(null);
  }

  // --------------------------------------------------------------------
  // Upload-completion → Y.Array mirror
  //
  // After insert-pending-objects succeeds, CommitAndBuildModal calls
  // onInserted with the real D1 ids. We push matching Y.Maps into the
  // objects Y.Array with the canonical id so all connected clients see the
  // new self-hosted upload (and receive a toast notification). The _id is
  // set to the D1 id, so the next snapshotToD1 pass will UPDATE (not
  // duplicate-INSERT) this row.
  // --------------------------------------------------------------------
  const lastInsertedPendingRef = useRef<PendingObject[] | null>(null);
  function handleInsertedToD1(
    inserted: Array<{ id: number; object_id: string }>
  ) {
    if (!ydoc) return;
    const pending = lastInsertedPendingRef.current ?? pendingObjects;
    if (!pending || pending.length === 0) return;
    const idByObjectId = new Map<string, number>();
    for (const row of inserted) idByObjectId.set(row.object_id, row.id);

    const objectsArray = ydoc.getArray<Y.Map<unknown>>("objects");
    // Dedupe guard: the hardened insert action is idempotent and echoes ids
    // for objects that already existed in D1 — some of those may already have
    // Y.Maps (e.g. registered by an earlier attempt or another client).
    // Pushing again would duplicate them in the shared doc.
    const alreadyInDoc = new Set<string>();
    for (let i = 0; i < objectsArray.length; i++) {
      const oid = objectsArray.get(i).get("object_id");
      if (typeof oid === "string") alreadyInDoc.add(oid);
    }
    ydoc.transact(() => {
      for (const p of pending) {
        const d1Id = idByObjectId.get(p.object_id);
        if (d1Id === undefined) continue;
        if (alreadyInDoc.has(p.object_id)) continue;
        // makeObjectYMap sets EVERY snapshot-bound key. The hand-rolled
        // version omitted object_type/subjects/source/credit/dimensions/
        // extra_columns — the next snapshot UPDATE then erased the
        // just-uploaded values in D1 (yTextToString(undefined) === "") — and
        // wrote the TITLE into alt_text, clobbering the user's alt text.
        const objMap = makeObjectYMap({
          id: d1Id,
          createdBy: currentUserId,
          objectId: p.object_id,
          title: p.title,
          creator: p.creator,
          description: p.description,
          altText: p.alt_text ?? p.title,
          sourceUrl: p.source_url,
          period: p.period,
          year: p.year,
          objectType: p.object_type,
          subjects: p.subjects,
          source: p.source,
          credit: p.credit,
          thumbnail: p.thumbnail,
          dimensions: p.dimensions,
          extraColumns: p.extra_columns,
          featured: p.featured,
          imageAvailable: p.image_available,
          validationState: "valid",
          origin: "repo",
        });
        objectsArray.push([objMap]);
      }
    });

    // Toast for other collaborators — locally the convenor sees the modal
    // flow, but showing the toast is harmless and consistent.
    for (const p of pending) {
      showToast({
        message: tStructural("toast_object_added", {
          title: p.title ?? p.object_id,
        }),
        type: "info",
      });
    }
    lastInsertedPendingRef.current = null;
  }

  // Row keys come from the shared keyFor helper (see ~/lib/item-key). It keys
  // on _tempId first so a key stays stable when snapshotToD1 backfills the
  // numeric D1 id after creation; an id-first key would flip at backfill.
  // Y.Array order is the canonical order and drag-to-reorder was removed, so
  // no sortable id is needed.

  // Remote-delete toast — fires when an object disappears from the Y.Array
  // because a peer removed it. Shared logic in useRemoteDeleteToast.
  useRemoteDeleteToast({
    items: yjsObjects ?? [],
    enabled: useYjs,
    getLabel: (o) => o.title ?? o.object_id,
  });

  // --------------------------------------------------------------------
  // Default order + substring filter. The sort and status
  // selects were dropped; the default order is Y.Array order in Yjs
  // mode (Y.Array position IS the canonical order) and title order in the
  // non-Yjs fallback. The page-head ?q= filter then narrows the list via
  // matchesObjectFilter (substring on title/creator/year/object_id).
  // --------------------------------------------------------------------
  const sourceList: YjsObjectRow[] = useYjs
    ? (yjsObjects ?? [])
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
  const isConvenor = userRole === "convenor";

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
              disabled={isComputing}
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
            className="inline-flex items-center justify-center bg-anil hover:bg-anil-hover text-charcoal font-heading font-semibold text-sm uppercase tracking-wider rounded-full px-4 py-1.5 transition-colors"
          >
            {t("add_object_button")}
          </button>

        </div>
      </div>

      {/* Main content area — shifts left when side panel is open on lg+ */}
      <div>
        {!hasObjects ? (
          <>
            <ObjectsEmptyState
              onSync={handleSyncClick}
              onAddIiif={handleAddObjectClick}
            />
            {/* Safety net: a low-key hint pointing a user who skipped
                onboarding back to Site settings (/config) to finish setup.
                The empty_body copy names Site settings inline; the trailing
                link provides the navigable target to /config. */}
            <p className="font-body text-xs text-fg-muted text-center max-w-sm mx-auto -mt-12 mb-12">
              {tCommon("objects.empty_body")}{" "}
              <Link
                to="/config"
                className="font-semibold text-anil-ink hover:underline whitespace-nowrap"
              >
                {tCommon("nav.config")} →
              </Link>
            </p>
          </>
        ) : (
          <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
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
                return (
                  <div key={String(keyFor(object))}>
                    <ObjectRow
                      object={object}
                      onToggleFeatured={handleToggleFeatured}
                      siteBaseUrl={siteBaseUrl}
                      fallbackThumbnail={
                        fallbackThumbnails.get(object.object_id) ?? null
                      }
                      usedInSteps={objectStepCounts[object.object_id] ?? 0}
                      {...(useYjs
                        ? {
                            onDelete: () => handleDeleteRequest(object),
                            canDelete: object._yMap
                              ? ops!.canDelete(object._yMap)
                              : isConvenor,
                            deleteTooltip: tStructural("tooltip_cannot_delete"),
                          }
                        : {})}
                    />
                    {validationState === "pending" && (
                      <p className="font-body text-xs text-gray-500 px-4 pb-2 -mt-1">
                        <span className="inline-block w-2 h-2 rounded-full bg-gray-300 animate-pulse mr-2" />
                        {tStructural("validation_pending")}
                      </p>
                    )}
                    {validationState === "error" && (
                      <p className="font-body text-xs text-red-600 px-4 pb-2 -mt-1">
                        {tStructural("validation_error")}
                      </p>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Sync diff dialog */}
      <SyncDiffDialog
        open={syncDialogOpen}
        onClose={() => {
          setSyncDialogOpen(false);
          setSyncDiffData(null);
        }}
        diffData={syncDiffData}
        onApply={handleSyncApply}
        isComputing={isComputing}
        isApplying={isApplying}
      />

      {/* Unified Add Object dialog (IIIF / Upload / External) */}
      <AddObjectDialog
        open={addObjectOpen}
        onClose={() => {
          setAddObjectOpen(false);
          setIiifFetchResult(null);
          setUploadError(null);
        }}
        projectId={project.id}
        isConvenor={isConvenor}
        fetchResult={dialogFetchResult}
        onFetchUrl={handleIiifFetch}
        onIiifConfirm={handleIiifConfirm}
        isFetching={isFetchingIiif}
        onUploadConfirm={handleUploadConfirm}
        isUploading={isUploading}
        uploadError={uploadError}
        existingObjectIds={(loaderObjects as Array<{ object_id: string }>).map((o) => o.object_id)}
        onExternalConfirm={handleExternalConfirm}
        isAdding={isAddingIiif}
      />

      {/* Commit and build modal */}
      <CommitAndBuildModal
        open={commitModalOpen}
        sheetsEnabled={sheetsEnabled}
        urlMismatch={urlMismatch}
        pendingObjects={pendingObjects}
        skipCommit={isUploadFlow}
        dispatchRunId={dispatchRunId}
        dispatchHtmlUrl={dispatchHtmlUrl}
        onClose={handleCommitCancel}
        onBuildSuccess={handleBuildSuccess}
        onBuildFailed={handleBuildFailed}
        onInserted={handleInsertedToD1}
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
        unpublishedCount={appLoaderData?.unpublishedCount ?? 0}
        onClose={() => setFullSyncModalOpen(false)}
      />
    </div>
  );
}
