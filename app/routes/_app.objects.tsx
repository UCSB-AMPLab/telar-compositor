/**
 * This file is the Objects route — the full IIIF object manager list
 * view, where the user browses every image, audio, and video object
 * in their project and edits metadata, featured status, and IIIF
 * source URLs.
 *
 * Loader fetches the active project's objects ordered by title ASC,
 * plus a step-reference count per `object_id` for "used in" info.
 * Action handles ten intents — `toggle-featured`, `update-object`,
 * `compute-sync-diff`, `sync-apply`, `fetch-iiif-preview`,
 * `add-iiif-object`, `upload-image`, `check-google-sheets`,
 * `commit-objects`, and `poll-build`. The page renders a table view
 * with thumbnails, sort/filter controls, featured-star toggles, a
 * slide-in edit panel, and a build progress banner.
 *
 * @version v1.2.0-beta
 */

import { and, asc, count, eq, inArray } from "drizzle-orm";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { redirect, useFetcher } from "react-router";
import * as Y from "yjs";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Trash2 } from "lucide-react";
import type { Route } from "./+types/_app.objects";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { projects, objects, steps, project_config, project_members, users } from "~/db/schema";
import { createSessionStorage } from "~/lib/session.server";
import { resolveActiveProject } from "~/lib/membership.server";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { useStructuralOps } from "~/hooks/use-structural-ops";
import { findYMapById } from "~/lib/yjs-helpers";
import { useToast } from "~/hooks/use-toast";
import { DeleteConfirmationModal } from "~/components/ui/DeleteConfirmationModal";
import { fetchAndParseManifest } from "~/lib/iiif.server";
import { deriveStatus } from "~/lib/iiif-types";
import type { IiifFetchResult } from "~/lib/iiif-types";
import { decrypt } from "~/lib/crypto.server";
import { getRepoTree, getFileContent } from "~/lib/github.server";
import { computeSyncDiff, applySyncChanges } from "~/lib/sync.server";
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
import { AddIiifDialog } from "~/components/features/objects/AddIiifDialog";
import { CommitAndBuildModal } from "~/components/features/objects/CommitAndBuildModal";
import { UploadImageDialog } from "~/components/features/objects/UploadImageDialog";
import type { ObjectRowObject } from "~/components/features/objects/ObjectRow";
import type { SyncDiff, SyncChanges, PendingObject } from "~/lib/sync.server";
import type { AddIiifConfirmPayload } from "~/components/features/objects/AddIiifDialog";
import type { UploadImageConfirmPayload } from "~/components/features/objects/UploadImageDialog";
import { commitMultipleBinaryFilesWithCsv, arrayBufferToBase64, validateUploadFile } from "~/lib/upload.server";
import type { SyncApplyPayload } from "~/components/features/objects/SyncDiffDialog";

export const handle = { i18n: ["common", "objects", "structural"] };

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);

  const sessionStorage = createSessionStorage(env.SESSION_SECRET);
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));
  const sessionActiveId = session.get("activeProjectId") as number | undefined;

  const resolved = await resolveActiveProject(db, user.id, sessionActiveId);
  if (!resolved) {
    return redirect("/dashboard");
  }
  const { project: activeProject, userRole } = resolved;

  // Fetch all objects ordered by `order` ASC — pre-existing rows default
  // to 0, which still sorts consistently before newly-ordered items.
  const projectObjects = await db
    .select()
    .from(objects)
    .where(eq(objects.project_id, activeProject.id))
    .orderBy(asc(objects.order));

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

  // Count step references per object_id
  const stepRefRows = await db
    .select({ object_id: steps.object_id, count: count() })
    .from(steps)
    .groupBy(steps.object_id);

  const objectStepCounts: Record<string, number> = {};
  for (const row of stepRefRows) {
    if (row.object_id) {
      objectStepCounts[row.object_id] = row.count;
    }
  }

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
      await db
        .update(objects)
        .set({ featured: !currentValue, updated_at: new Date().toISOString() })
        .where(eq(objects.id, objectDbId));
      return { ok: true, intent: "toggle-featured" };
    }

    case "update-object": {
      const objectDbId = Number(formData.get("objectDbId"));
      const title = (formData.get("title") as string | null)?.trim() || null;

      if (!title) {
        return { ok: false, error: "title_required" };
      }

      const now = new Date().toISOString();
      await db
        .update(objects)
        .set({
          title,
          creator: (formData.get("creator") as string | null)?.trim() || null,
          description:
            (formData.get("description") as string | null)?.trim() || null,
          period: (formData.get("period") as string | null)?.trim() || null,
          year: (formData.get("year") as string | null)?.trim() || null,
          object_type:
            (formData.get("object_type") as string | null)?.trim() || null,
          subjects:
            (formData.get("subjects") as string | null)?.trim() || null,
          source: (formData.get("source") as string | null)?.trim() || null,
          credit: (formData.get("credit") as string | null)?.trim() || null,
          alt_text: (formData.get("alt_text") as string | null)?.trim() || null,
          featured: formData.get("featured") === "true",
          updated_at: now,
        })
        .where(eq(objects.id, objectDbId));

      return { ok: true, intent: "update-object" };
    }

    case "compute-sync-diff": {
      // Get active project and GitHub token
      const sessionStorage = createSessionStorage(env.SESSION_SECRET);
      const session = await sessionStorage.getSession(request.headers.get("Cookie"));
      const sessionActiveId = session.get("activeProjectId") as number | undefined;

      const allProjects = await db
        .select()
        .from(projects)
        .where(eq(projects.user_id, user.id));

      if (allProjects.length === 0) {
        return { ok: false, intent: "compute-sync-diff", error: "no_project" };
      }

      const activeProject =
        allProjects.find((p) => p.id === Number(sessionActiveId)) ?? allProjects[0];

      const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
      const [owner, repo] = activeProject.github_repo_full_name.split("/");

      try {
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

      // Get active project credentials
      const sessionStorage = createSessionStorage(env.SESSION_SECRET);
      const session = await sessionStorage.getSession(request.headers.get("Cookie"));
      const sessionActiveId = session.get("activeProjectId") as number | undefined;

      const allProjects = await db
        .select()
        .from(projects)
        .where(eq(projects.user_id, user.id));

      if (allProjects.length === 0) {
        return { ok: false, intent: "sync-apply", error: "no_project" };
      }

      const activeProject =
        allProjects.find((p) => p.id === Number(sessionActiveId)) ?? allProjects[0];

      const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
      const [owner, repo] = activeProject.github_repo_full_name.split("/");

      try {
        const { appliedCount, pendingObjects } = await applySyncChanges(
          activeProject.id,
          changes,
          token,
          owner,
          repo,
          db
        );
        return { ok: true, intent: "sync-apply", appliedCount, pendingObjects };
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
      const sessionStorage = createSessionStorage(env.SESSION_SECRET);
      const session = await sessionStorage.getSession(request.headers.get("Cookie"));
      const sessionActiveId = session.get("activeProjectId") as number | undefined;

      const resolvedDel = await resolveActiveProject(db, user.id, sessionActiveId);
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

      // 3. Get active project (same pattern as add-iiif-object)
      const uploadSessionStorage = createSessionStorage(env.SESSION_SECRET);
      const uploadSession = await uploadSessionStorage.getSession(request.headers.get("Cookie"));
      const uploadSessionActiveId = uploadSession.get("activeProjectId") as number | undefined;
      const uploadAllProjects = await db.select().from(projects).where(eq(projects.user_id, user.id));
      if (uploadAllProjects.length === 0) {
        return { ok: false, intent: "upload-image", error: "no_project" };
      }
      const uploadActiveProject =
        uploadAllProjects.find((p) => p.id === Number(uploadSessionActiveId)) ?? uploadAllProjects[0];

      const uploadToken = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
      const [uploadOwner, uploadRepo] = uploadActiveProject.github_repo_full_name.split("/");

      // 4. Generate unique object IDs for each image and build pending objects
      const uploadPendingObjects: PendingObject[] = [];
      const imagePayloads: Array<{ imagePath: string; imageBase64: string }> = [];

      for (let i = 0; i < imageFiles.length; i++) {
        const imageFile = imageFiles[i];
        const metadata = metadataArray[i];

        // Generate unique slug (each call sees previously generated IDs via DB)
        const requestedSlug = metadata.objectId.trim() || slugify(metadata.title);
        const uploadObjectId = await generateUniqueObjectSlug(requestedSlug, uploadActiveProject.id, db);

        // Validate slug is path-safe (no traversal, only lowercase alphanumeric + hyphens)
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

      // 9. Commit all images + CSV atomically in a single Git commit
      const commitLabel = uploadPendingObjects.map((p) => p.object_id).join(", ");
      try {
        const uploadCommitResult = await commitMultipleBinaryFilesWithCsv({
          token: uploadToken,
          owner: uploadOwner,
          repo: uploadRepo,
          branch: "main",
          images: imagePayloads,
          csvContent: uploadCsvContent,
          commitMessage: `Add ${commitLabel} via Telar Compositor`,
        });

        // 10. Update project head_sha
        await db.update(projects)
          .set({ head_sha: uploadCommitResult.newHeadSha, updated_at: new Date().toISOString() })
          .where(eq(projects.id, uploadActiveProject.id));

        // 11. Dispatch IIIF-only workflow and capture run ID for direct polling
        let dispatchRunId: number | null = null;
        let dispatchHtmlUrl: string | null = null;
        try {
          let dispatchToken = uploadToken;
          try {
            dispatchToken = await getInstallationToken(
              env.GITHUB_APP_ID,
              env.GITHUB_PRIVATE_KEY,
              uploadActiveProject.installation_id,
            );
          } catch {
            // Installation token unavailable (local dev) — try user token
          }
          const dispatch = await dispatchWorkflow(dispatchToken, uploadOwner, uploadRepo, "build.yml");
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
      const sessionStorage = createSessionStorage(env.SESSION_SECRET);
      const session = await sessionStorage.getSession(request.headers.get("Cookie"));
      const sessionActiveId = session.get("activeProjectId") as number | undefined;

      const allProjects = await db
        .select()
        .from(projects)
        .where(eq(projects.user_id, user.id));

      if (allProjects.length === 0) {
        return { ok: true, intent: "pre-commit-check", sheetsEnabled: false, urlCheck: { match: true, pagesUrl: "", configUrl: "" } };
      }

      const activeProject =
        allProjects.find((p) => p.id === Number(sessionActiveId)) ?? allProjects[0];

      const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
      const [owner, repo] = activeProject.github_repo_full_name.split("/");

      const content = await getFileContent(token, owner, repo, "_config.yml");
      if (content === null) {
        return { ok: true, intent: "pre-commit-check", sheetsEnabled: false, urlCheck: { match: true, pagesUrl: "", configUrl: "" } };
      }

      const sheetsEnabled = isGoogleSheetsEnabled(content);
      const urlCheck = await verifySiteUrl(token, owner, repo, content);

      return { ok: true, intent: "pre-commit-check", sheetsEnabled, urlCheck };
    }

    case "commit-objects": {
      const sessionStorage = createSessionStorage(env.SESSION_SECRET);
      const session = await sessionStorage.getSession(request.headers.get("Cookie"));
      const sessionActiveId = session.get("activeProjectId") as number | undefined;

      const allProjects = await db
        .select()
        .from(projects)
        .where(eq(projects.user_id, user.id));

      if (allProjects.length === 0) {
        return { ok: false, intent: "commit-objects", error: "no_project" };
      }

      const activeProject =
        allProjects.find((p) => p.id === Number(sessionActiveId)) ?? allProjects[0];

      const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
      const [owner, repo] = activeProject.github_repo_full_name.split("/");

      const disableSheets = formData.get("disableSheets") === "true";

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

      try {
        // Commit with [skip ci] to prevent the full build.yml from firing.
        // Full build dispatched below to deploy changes via GitHub Pages.
        const result = await commitFilesToRepo(
          token, owner, repo, "main", files, commitMessage,
          undefined, undefined,
          true, // skipCi — suppress full build
        );

        // Update projects.head_sha
        await db
          .update(projects)
          .set({ head_sha: result.newHeadSha, updated_at: new Date().toISOString() })
          .where(eq(projects.id, activeProject.id));

        // If sheets were disabled, update project_config
        if (disableSheets) {
          await db
            .update(project_config)
            .set({ google_sheets_enabled: false, updated_at: new Date().toISOString() })
            .where(eq(project_config.project_id, activeProject.id));
        }

        // Dispatch the lightweight objects-only workflow instead of the full build.
        // Fire-and-forget: if dispatch fails, objects are still committed and the
        // full build will pick them up on next push.
        const installToken = await getInstallationToken(
          env.GITHUB_APP_ID,
          env.GITHUB_PRIVATE_KEY,
          activeProject.installation_id,
        );
        let commitObjectsDispatchRunId: number | null = null;
        try {
          const dispatch = await dispatchWorkflow(installToken, owner, repo, "build.yml");
          commitObjectsDispatchRunId = dispatch.runId || null;
        } catch {
          // Dispatch failed — objects committed, processing deferred to next full build
        }

        return {
          ok: true,
          intent: "commit-objects",
          newHeadSha: result.newHeadSha,
          dispatchRunId: commitObjectsDispatchRunId,
        };
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
    }

    case "poll-build": {
      const sha = formData.get("sha") as string | null;
      const runIdParam = formData.get("runId") as string | null;

      // Require either sha or runId (runId-only path is for the upload flow)
      if (!sha && !runIdParam) {
        return { ok: false, intent: "poll-build", error: "missing_sha" };
      }

      const sessionStorage = createSessionStorage(env.SESSION_SECRET);
      const session = await sessionStorage.getSession(request.headers.get("Cookie"));
      const sessionActiveId = session.get("activeProjectId") as number | undefined;

      const allProjects = await db
        .select()
        .from(projects)
        .where(eq(projects.user_id, user.id));

      if (allProjects.length === 0) {
        return { ok: false, intent: "poll-build", error: "no_project" };
      }

      const activeProject =
        allProjects.find((p) => p.id === Number(sessionActiveId)) ?? allProjects[0];

      const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
      const [owner, repo] = activeProject.github_repo_full_name.split("/");

      try {
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
      const pendingJson = formData.get("pendingObjects") as string | null;
      if (!pendingJson) {
        return { ok: false, intent: "insert-pending-objects", error: "missing_data" };
      }

      const pendingObjects: PendingObject[] = JSON.parse(pendingJson);

      const sessionStorage = createSessionStorage(env.SESSION_SECRET);
      const session = await sessionStorage.getSession(request.headers.get("Cookie"));
      const sessionActiveId = session.get("activeProjectId") as number | undefined;

      const allProjects = await db
        .select()
        .from(projects)
        .where(eq(projects.user_id, user.id));

      if (allProjects.length === 0) {
        return { ok: false, intent: "insert-pending-objects", error: "no_project" };
      }

      const activeProject =
        allProjects.find((p) => p.id === Number(sessionActiveId)) ?? allProjects[0];

      // Insert pending objects into D1 now that the build has succeeded
      const rows = pendingObjects.map((p) => ({
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
      }));

      // D1 batch limit: 100 bindings per INSERT, 18 columns → max 5 rows.
      // Collect inserted rows so the client can mirror them into the Yjs
      // Y.Array with canonical D1 ids (self-hosted objects appear in
      // the shared doc only after the repo build succeeds and D1 INSERT
      // completes; the snapshot writes them as UPDATEs on the next cycle).
      const maxRows = Math.floor(100 / 18);
      type InsertedRow = { id: number; object_id: string };
      const inserted: InsertedRow[] = [];
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
    }

    default:
      throw new Response("Bad request", { status: 400 });
  }
}

// ---------------------------------------------------------------------------
// Sort / filter helpers
// ---------------------------------------------------------------------------

type SortBy = "title" | "status";
type FilterStatus = "all" | "ready" | "needs_attention";

const STATUS_PRIORITY: Record<ReturnType<typeof deriveStatus>, number> = {
  missing_from_repo: 0,
  no_metadata: 1,
  image_missing: 2,
  ready: 3,
};

function sortObjects(
  objs: ObjectRowObject[],
  sortBy: SortBy
): ObjectRowObject[] {
  if (sortBy === "title") {
    return [...objs].sort((a, b) =>
      (a.title ?? a.object_id).localeCompare(b.title ?? b.object_id)
    );
  }
  // sort by status priority (ascending — problem cases first)
  return [...objs].sort((a, b) => {
    const sa = deriveStatus(a);
    const sb = deriveStatus(b);
    return STATUS_PRIORITY[sa] - STATUS_PRIORITY[sb];
  });
}

function filterObjects(
  objs: ObjectRowObject[],
  filterStatus: FilterStatus
): ObjectRowObject[] {
  if (filterStatus === "all") return objs;
  if (filterStatus === "ready") {
    return objs.filter((o) => deriveStatus(o) === "ready");
  }
  // needs_attention: everything that isn't ready
  return objs.filter((o) => deriveStatus(o) !== "ready");
}

// ---------------------------------------------------------------------------
// SortableObjectRow — dnd-kit sortable wrapper around ObjectRow for the Yjs
// collaborative mode. Adds a grip handle for reorder, a delete button
// (visible-but-disabled when canDelete is false), and a
// validation-state badge for pending / invalid IIIF manifests.
// ---------------------------------------------------------------------------

interface SortableObjectRowProps {
  sortableId: string | number;
  object: ObjectRowObject;
  canDelete: boolean;
  deleteTooltip: string;
  onDelete: () => void;
  onToggleFeatured: (o: ObjectRowObject) => void;
  siteBaseUrl: string | null;
  validationState: "pending" | "valid" | "error" | null;
  validationLabels: { pending: string; error: string };
}

function SortableObjectRow({
  sortableId,
  object,
  canDelete,
  deleteTooltip,
  onDelete,
  onToggleFeatured,
  siteBaseUrl,
  validationState,
  validationLabels,
}: SortableObjectRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: sortableId });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      className="flex items-stretch border-b border-gray-100 last:border-b-0"
    >
      {/* Object row body (flex-1 so ObjectRow lays out naturally) */}
      <div className="flex-1 min-w-0">
        <ObjectRow
          object={object}
          onToggleFeatured={onToggleFeatured}
          siteBaseUrl={siteBaseUrl}
        />
        {validationState === "pending" && (
          <p className="font-body text-xs text-gray-500 px-4 pb-2 -mt-1">
            <span className="inline-block w-2 h-2 rounded-full bg-gray-300 animate-pulse mr-2" />
            {validationLabels.pending}
          </p>
        )}
        {validationState === "error" && (
          <p className="font-body text-xs text-red-600 px-4 pb-2 -mt-1">
            {validationLabels.error}
          </p>
        )}
      </div>

      {/* Delete button (visible-but-disabled when not deletable) */}
      <div className="shrink-0 px-2 flex items-center">
        <button
          type="button"
          onClick={onDelete}
          disabled={!canDelete}
          title={!canDelete ? deleteTooltip : undefined}
          aria-label="Delete object"
          className="text-terracotta hover:text-terracotta/80 disabled:text-gray-300 disabled:cursor-not-allowed transition-colors"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
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
  const { t } = useTranslation("objects");
  const { t: tStructural } = useTranslation("structural");
  const {
    project,
    objects: loaderObjects,
    siteBaseUrl,
    members,
    currentUserId,
    userRole,
  } = loaderData;

  const { ydoc, remoteCollaborators } = useCollaborationContext();
  const ops = useStructuralOps(currentUserId, userRole);
  const { showToast } = useToast();

  const [sortBy, setSortBy] = useState<SortBy>("title");
  const [filterStatus, setFilterStatus] = useState<FilterStatus>("all");

  // Sync dialog state
  const [syncDialogOpen, setSyncDialogOpen] = useState(false);
  const [syncDiffData, setSyncDiffData] = useState<SyncDiff | null>(null);

  // Add IIIF dialog state
  const [addIiifOpen, setAddIiifOpen] = useState(false);
  const [iiifFetchResult, setIiifFetchResult] = useState<IiifFetchResult | null>(null);

  // Commit modal state
  const [commitModalOpen, setCommitModalOpen] = useState(false);
  const [pendingObjects, setPendingObjects] = useState<PendingObject[]>([]);
  const [sheetsEnabled, setSheetsEnabled] = useState(false);
  const [urlMismatch, setUrlMismatch] = useState<{ pagesUrl: string; configUrl: string } | null>(null);
  // Upload flow: dispatch run ID for direct polling (skips commit step in modal)
  const [dispatchRunId, setDispatchRunId] = useState<number | null>(null);
  const [dispatchHtmlUrl, setDispatchHtmlUrl] = useState<string | null>(null);

  // Add objects chooser modal
  const [addObjectsOpen, setAddObjectsOpen] = useState(false);

  // Upload dialog state
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
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
    | { ok: true; intent: "sync-apply"; appliedCount: number; pendingObjects: PendingObject[] }
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
      setSyncDialogOpen(false);
      setSyncDiffData(null);
      if (syncFetcherData.pendingObjects.length > 0) {
        setPendingObjects(syncFetcherData.pendingObjects);
        sheetsFetcher.submit({ intent: "pre-commit-check" }, { method: "post" });
        setCommitModalOpen(true);
      }
    }
  }, [syncFetcherData, syncDialogOpen]);

  // IIIF add flow migrated to Yjs — no route action for add-iiif-object.
  // The confirm handler below writes to the Y.Array and kicks off client-side
  // manifest validation. The dialog closes immediately on confirm.

  useEffect(() => {
    if (!uploadSubmitted) return;
    if (uploadFetcherData?.ok && uploadFetcherData.intent === "upload-image" && uploadDialogOpen) {
      setUploadDialogOpen(false);
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
      // Map error codes to i18n keys
      const errorMap: Record<string, string> = {
        stale_head: t("upload_error_stale"),
        payload_too_large: t("upload_error_payload"),
        upload_failed: t("upload_error_generic"),
        invalid_format: t("upload_error_format"),
        file_too_large: t("upload_error_size"),
        title_required: t("field_title_required"),
      };
      setUploadError(errorMap[uploadFetcherData.error] || t("upload_error_generic"));
    }
  }, [uploadFetcherData, uploadDialogOpen, t]);

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

  function handleAddIiifClick() {
    setIiifFetchResult(null);
    setAddIiifOpen(true);
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

  function handleIiifConfirm(payload: AddIiifConfirmPayload) {
    // IIIF objects flow through the Y.Array with a "pending" validation
    // state. The DO snapshot (plan 27-03) skips pending objects, so they do
    // not reach D1 until this client-side fetch marks them valid.
    if (!ops || !ydoc) {
      // No active ydoc — silently drop; reconnect will let the user retry.
      // eslint-disable-next-line no-console
      console.warn("[objects] IIIF add requested without active ydoc; ignored");
      setAddIiifOpen(false);
      setIiifFetchResult(null);
      return;
    }

    const objectId = payload.object_id || slugify(payload.title);
    ops.addIiifObject(objectId, payload.title, payload.manifestUrl);

    // Seed additional fields on the just-pushed Y.Map (addIiifObject writes
    // the minimum set — fill in creator/description/source/credit/thumbnail
    // from the dialog payload so the DO snapshot can INSERT a complete row
    // once validation succeeds).
    const objectsArray = ydoc.getArray<Y.Map<unknown>>("objects");
    const justAdded = objectsArray.get(objectsArray.length - 1) as
      | Y.Map<unknown>
      | undefined;
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
        if (payload.thumbnail) justAdded.set("thumbnail", payload.thumbnail);
        if (payload.source) justAdded.set("source", payload.source);
        if (payload.credit) justAdded.set("credit", payload.credit);
        justAdded.set("image_available", payload.image_available);
      });

      // Fire-and-forget client-side manifest validation.
      // Success → `_validation_state: "valid"`, failure → `"error"`.
      validateManifestOnYMap(justAdded, payload.manifestUrl);
    }

    setAddIiifOpen(false);
    setIiifFetchResult(null);
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
  const [yjsObjects, setYjsObjects] = useState<YjsObjectRow[] | null>(null);

  useEffect(() => {
    if (!ydoc) {
      setYjsObjects(null);
      return;
    }
    const objectsArray = ydoc.getArray<Y.Map<unknown>>("objects");
    const recompute = () => {
      const next: YjsObjectRow[] = [];
      for (let i = 0; i < objectsArray.length; i++) {
        next.push(yMapToObjectRow(objectsArray.get(i), i));
      }
      setYjsObjects(next);
    };
    recompute();
    objectsArray.observeDeep(recompute);
    return () => objectsArray.unobserveDeep(recompute);
  }, [ydoc]);

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
    ydoc.transact(() => {
      for (const p of pending) {
        const d1Id = idByObjectId.get(p.object_id);
        if (d1Id === undefined) continue;
        const objMap = new Y.Map<unknown>();
        objMap.set("_id", d1Id);
        objMap.set("_temp_id", crypto.randomUUID());
        objMap.set("created_by", currentUserId);
        objMap.set("object_id", p.object_id);
        objMap.set("title", new Y.Text(p.title ?? ""));
        objMap.set("creator", new Y.Text(p.creator ?? ""));
        objMap.set("description", new Y.Text(p.description ?? ""));
        objMap.set("alt_text", new Y.Text(p.title ?? ""));
        objMap.set("source_url", p.source_url ?? "");
        objMap.set("period", new Y.Text(p.period ?? ""));
        objMap.set("year", new Y.Text(p.year ?? ""));
        objMap.set("featured", p.featured);
        objMap.set("image_available", p.image_available);
        objMap.set("_validation_state", "valid");
        objMap.set("order", objectsArray.length);
        objMap.set("origin", "repo");
        objMap.set("missing_from_repo", false);
        objMap.set("thumbnail", p.thumbnail ?? "");
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

  // --------------------------------------------------------------------
  // dnd-kit sensors (reorder)
  // --------------------------------------------------------------------
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const keyFor = (o: YjsObjectRow): string | number =>
    o.id > 0 ? o.id : o._tempId ?? `idx-${o._yIndex ?? 0}`;

  function handleDragEnd(event: DragEndEvent) {
    if (!useYjs) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const list = yjsObjects ?? [];
    const keys = list.map((o) => keyFor(o));
    const oldIndex = keys.findIndex((k) => k === active.id);
    const newIndex = keys.findIndex((k) => k === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    ops!.reorderObjects(oldIndex, newIndex);
  }

  // --------------------------------------------------------------------
  // Remote-delete toast — fires when an object disappears from the
  // Y.Array. We identify the deleted object by its last known title.
  // --------------------------------------------------------------------
  const prevTitlesRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (!useYjs) return;
    const list = yjsObjects ?? [];
    const curr = new Map<string, string>();
    for (const o of list) curr.set(String(keyFor(o)), o.title ?? o.object_id);
    const deleted: string[] = [];
    prevTitlesRef.current.forEach((title, key) => {
      if (!curr.has(key)) deleted.push(title);
    });
    prevTitlesRef.current = curr;
    if (deleted.length === 0) return;
    const deleterName = remoteCollaborators[0]?.user.name ?? "";
    for (const title of deleted) {
      const message = deleterName
        ? tStructural("toast_item_deleted", { label: title, name: deleterName })
        : tStructural("toast_item_deleted_generic", { label: title });
      showToast({
        message,
        type: "destructive",
        ...(userRole === "convenor"
          ? { action: { label: tStructural("toast_item_deleted_undo"), onClick: () => {} } }
          : {}),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yjsObjects, useYjs, userRole]);

  // --------------------------------------------------------------------
  // Apply sort + filter. Yjs mode preserves Y.Array order for the default
  // ("title") sort — Y.Array position IS the canonical order. Switching to
  // "status" sort falls through to the deriveStatus-based ordering.
  // --------------------------------------------------------------------
  const sourceList: YjsObjectRow[] = useYjs
    ? (yjsObjects ?? [])
    : (loaderObjects as YjsObjectRow[]);
  const processedObjects: YjsObjectRow[] = useYjs
    ? (filterObjects(
        sortBy === "status"
          ? (sortObjects(sourceList, "status") as YjsObjectRow[])
          : sourceList,
        filterStatus
      ) as YjsObjectRow[])
    : (filterObjects(
        sortObjects(sourceList, sortBy),
        filterStatus
      ) as YjsObjectRow[]);

  const hasObjects = sourceList.length > 0;
  const sortableIds: (string | number)[] = processedObjects.map((o) => keyFor(o));
  const isConvenor = userRole === "convenor";

  return (
    <div className="max-w-5xl mx-auto">
      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h1 className="font-heading font-bold text-2xl text-charcoal">
          {t("title")}
        </h1>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Sort */}
          <label className="sr-only" htmlFor="sort-select">
            {t("sort_label")}
          </label>
          <select
            id="sort-select"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortBy)}
            className="font-body text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white text-charcoal focus:outline-none focus:ring-2 focus:ring-periwinkle"
          >
            <option value="title">{t("sort_title_az")}</option>
            <option value="status">{t("sort_status_first")}</option>
          </select>

          {/* Filter */}
          <label className="sr-only" htmlFor="filter-select">
            {t("filter_label")}
          </label>
          <select
            id="filter-select"
            value={filterStatus}
            onChange={(e) =>
              setFilterStatus(e.target.value as FilterStatus)
            }
            className="font-body text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white text-charcoal focus:outline-none focus:ring-2 focus:ring-periwinkle"
          >
            <option value="all">{t("filter_all")}</option>
            <option value="ready">{t("filter_ready")}</option>
            <option value="needs_attention">{t("filter_needs_attention")}</option>
          </select>

          {/* Add objects */}
          <button
            type="button"
            onClick={() => setAddObjectsOpen(true)}
            className="inline-flex items-center justify-center bg-periwinkle hover:bg-periwinkle-hover text-charcoal font-heading font-semibold text-sm uppercase tracking-wider rounded-full px-4 py-1.5 transition-colors"
          >
            {t("add_objects_button")}
          </button>

        </div>
      </div>

      {/* Main content area — shifts left when side panel is open on lg+ */}
      <div>
        {!hasObjects ? (
          <ObjectsEmptyState
            onSync={handleSyncClick}
            onAddIiif={handleAddIiifClick}
          />
        ) : (
          <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
            {/* Column header */}
            <div className="grid grid-cols-[48px_1fr_auto_auto_auto_auto] gap-3 items-center px-4 py-2 bg-gray-50 border-b border-gray-100">
              <span className="col-span-2 font-heading text-xs uppercase tracking-wider text-gray-400">
                {t("header_title")}
              </span>
              <span className="font-heading text-xs uppercase tracking-wider text-gray-400 hidden md:block">
                {t("header_type")}
              </span>
              <span className="font-heading text-xs uppercase tracking-wider text-gray-400">
                {t("header_status")}
              </span>
              <span className="font-heading text-xs uppercase tracking-wider text-gray-400">
                {t("header_featured")}
              </span>
              <span className="font-heading text-xs uppercase tracking-wider text-gray-400">
                {t("header_actions")}
              </span>
            </div>

            {processedObjects.length === 0 ? (
              <p className="font-body text-sm text-gray-500 text-center py-8">
                {filterStatus !== "all" ? t("filter_all") : ""}
              </p>
            ) : useYjs ? (
              processedObjects.map((object) => (
                <SortableObjectRow
                  key={String(keyFor(object))}
                  sortableId={keyFor(object)}
                  object={object}
                  canDelete={
                    object._yMap ? ops!.canDelete(object._yMap) : isConvenor
                  }
                  deleteTooltip={tStructural("tooltip_cannot_delete")}
                  onDelete={() => handleDeleteRequest(object)}
                  onToggleFeatured={handleToggleFeatured}
                  siteBaseUrl={siteBaseUrl}
                  validationState={object._validationState ?? null}
                  validationLabels={{
                    pending: tStructural("validation_pending"),
                    error: tStructural("validation_error"),
                  }}
                />
              ))
            ) : (
              processedObjects.map((object) => (
                <ObjectRow
                  key={object.id}
                  object={object}
                  onToggleFeatured={handleToggleFeatured}
                  siteBaseUrl={siteBaseUrl}
                />
              ))
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
          setAddObjectsOpen(true);
        }}
        diffData={syncDiffData}
        onApply={handleSyncApply}
        isComputing={isComputing}
        isApplying={isApplying}
      />

      {/* Add objects chooser */}
      {addObjectsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md mx-4 p-6">
            <h3 className="font-heading font-semibold text-lg text-charcoal mb-4">
              {t("add_objects_title")}
            </h3>
            <div className="flex flex-col gap-3">
              {/* Sync and upload are convenor-only — they require repo
                  writes (commit + CSV + tile workflow dispatch). Collaborators
                  can still add external IIIF manifests below. */}
              {isConvenor && (
                <button
                  type="button"
                  onClick={() => { setAddObjectsOpen(false); handleSyncClick(); }}
                  disabled={isComputing}
                  className="w-full text-left px-4 py-3 rounded-lg border border-gray-200 hover:border-periwinkle hover:bg-lavender/10 transition-colors group"
                >
                  <p className="font-heading font-semibold text-sm text-charcoal group-hover:text-terracotta">
                    {t("add_objects_sync")}
                  </p>
                  <p className="font-body text-xs text-gray-500 mt-0.5">
                    {t("add_objects_sync_desc")}
                  </p>
                </button>
              )}
              {isConvenor && (
                <button
                  type="button"
                  onClick={() => { setAddObjectsOpen(false); setUploadDialogOpen(true); setUploadError(null); }}
                  className="w-full text-left px-4 py-3 rounded-lg border border-gray-200 hover:border-periwinkle hover:bg-lavender/10 transition-colors group"
                >
                  <p className="font-heading font-semibold text-sm text-charcoal group-hover:text-terracotta">
                    {t("add_objects_upload")}
                  </p>
                  <p className="font-body text-xs text-gray-500 mt-0.5">
                    {t("add_objects_upload_desc")}
                  </p>
                </button>
              )}
              <button
                type="button"
                onClick={() => { setAddObjectsOpen(false); handleAddIiifClick(); }}
                className="w-full text-left px-4 py-3 rounded-lg border border-gray-200 hover:border-periwinkle hover:bg-lavender/10 transition-colors group"
              >
                <p className="font-heading font-semibold text-sm text-charcoal group-hover:text-terracotta">
                  {t("add_objects_iiif")}
                </p>
                <p className="font-body text-xs text-gray-500 mt-0.5">
                  {t("add_objects_iiif_desc")}
                </p>
              </button>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => setAddObjectsOpen(false)}
                className="font-heading font-semibold text-sm uppercase tracking-wider border border-gray-200 text-charcoal rounded-full px-5 py-2 hover:bg-cream transition-colors"
              >
                {t("add_objects_close")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add IIIF dialog */}
      <AddIiifDialog
        open={addIiifOpen}
        onClose={() => {
          setAddIiifOpen(false);
          setIiifFetchResult(null);
          setAddObjectsOpen(true);
        }}
        fetchResult={dialogFetchResult}
        onFetchUrl={handleIiifFetch}
        onConfirm={handleIiifConfirm}
        isFetching={isFetchingIiif}
        isAdding={isAddingIiif}
      />

      {/* Upload Image dialog */}
      <UploadImageDialog
        open={uploadDialogOpen}
        onClose={() => { setUploadDialogOpen(false); setUploadError(null); setAddObjectsOpen(true); }}
        onConfirm={handleUploadConfirm}
        isUploading={isUploading}
        uploadError={uploadError}
        existingObjectIds={(loaderObjects as Array<{ object_id: string }>).map((o) => o.object_id)}
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
    </div>
  );
}
