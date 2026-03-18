/**
 * Objects — full IIIF object manager list view.
 *
 * Loader: fetches the active project's objects ordered by title ASC,
 *         plus a step-reference count per object_id for "used in" info.
 * Action: handles nine intents — toggle-featured, update-object,
 *         compute-sync-diff, sync-apply, fetch-iiif-preview, add-iiif-object,
 *         check-google-sheets, commit-objects, poll-build.
 * Component: table view with thumbnails, sort/filter controls, featured
 *            star toggles, a slide-in edit panel, and a build progress banner.
 */

import { asc, count, eq } from "drizzle-orm";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { redirect, useFetcher } from "react-router";
import type { Route } from "./+types/_app.objects";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { projects, objects, steps, project_config } from "~/db/schema";
import { createSessionStorage } from "~/lib/session.server";
import { fetchAndParseManifest } from "~/lib/iiif.server";
import { deriveStatus } from "~/lib/iiif-types";
import type { IiifFetchResult } from "~/lib/iiif-types";
import { decrypt } from "~/lib/crypto.server";
import { getRepoTree, getFileContent } from "~/lib/github.server";
import { computeSyncDiff, applySyncChanges } from "~/lib/sync.server";
import { generateUniqueObjectSlug, slugify } from "~/lib/slugify";
import {
  commitFilesToRepo,
  listWorkflowRunsBySha,
  getJobSteps,
  mapStepsToBuildPhases,
  isGoogleSheetsEnabled,
  disableGoogleSheetsInConfig,
  verifySiteUrl,
  StaleHeadError,
} from "~/lib/commit.server";
import { serializeObjectsCsv } from "~/lib/csv-export.server";
import { ObjectRow } from "~/components/features/objects/ObjectRow";
import { ObjectsEmptyState } from "~/components/features/objects/ObjectsEmptyState";
import { SyncDiffDialog } from "~/components/features/objects/SyncDiffDialog";
import { AddIiifDialog } from "~/components/features/objects/AddIiifDialog";
import { CommitAndBuildModal } from "~/components/features/objects/CommitAndBuildModal";
import type { ObjectRowObject } from "~/components/features/objects/ObjectRow";
import type { SyncDiff, SyncChanges, PendingObject } from "~/lib/sync.server";
import type { AddIiifConfirmPayload } from "~/components/features/objects/AddIiifDialog";
import type { SyncApplyPayload } from "~/components/features/objects/SyncDiffDialog";
import type { BuildPhaseStatus } from "~/lib/commit.server";

export const handle = { i18n: ["common", "objects"] };

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

  const allProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.user_id, user.id));

  if (allProjects.length === 0) {
    return redirect("/dashboard");
  }

  const activeProject =
    allProjects.find((p) => p.id === Number(sessionActiveId)) ?? allProjects[0];

  // Fetch all objects ordered by title ASC
  const projectObjects = await db
    .select()
    .from(objects)
    .where(eq(objects.project_id, activeProject.id))
    .orderBy(asc(objects.title));

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
      for (const obj of unenrichedSelfHosted) {
        if (iiifObjectIds.has(obj.object_id)) {
          await db
            .update(objects)
            .set({
              image_available: true,
              updated_at: new Date().toISOString(),
            })
            .where(eq(objects.id, obj.id));
          obj.image_available = true;
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

  return { project: activeProject, objects: projectObjects, objectStepCounts, siteBaseUrl };
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

    case "add-iiif-object": {
      const title = (formData.get("title") as string | null)?.trim();
      if (!title) {
        return { ok: false, intent: "add-iiif-object", error: "title_required" };
      }

      // Get active project
      const sessionStorage = createSessionStorage(env.SESSION_SECRET);
      const session = await sessionStorage.getSession(request.headers.get("Cookie"));
      const sessionActiveId = session.get("activeProjectId") as number | undefined;

      const allProjects = await db
        .select()
        .from(projects)
        .where(eq(projects.user_id, user.id));

      if (allProjects.length === 0) {
        return { ok: false, intent: "add-iiif-object", error: "no_project" };
      }

      const activeProject =
        allProjects.find((p) => p.id === Number(sessionActiveId)) ?? allProjects[0];

      // Validate and generate unique object_id
      const requestedSlug = (formData.get("object_id") as string | null)?.trim() || slugify(title);
      const objectId = await generateUniqueObjectSlug(requestedSlug, activeProject.id, db);

      const hasIiifTiles = formData.get("image_available") === "true";
      const sourceUrl = (formData.get("source_url") as string | null)?.trim() || null;
      const isExternalManifest = sourceUrl?.startsWith("http://") || sourceUrl?.startsWith("https://");
      const addNow = new Date().toISOString();

      // External IIIF objects (manifest hosted elsewhere, no tile build needed):
      // save directly to D1 and return immediately — no commit/build required.
      if (isExternalManifest) {
        await db.insert(objects).values({
          project_id: activeProject.id,
          object_id: objectId,
          title,
          featured: false,
          creator: (formData.get("creator") as string | null)?.trim() || null,
          description: (formData.get("description") as string | null)?.trim() || null,
          source_url: sourceUrl,
          period: null,
          year: null,
          object_type: null,
          subjects: null,
          source: (formData.get("source") as string | null)?.trim() || null,
          credit: (formData.get("credit") as string | null)?.trim() || null,
          thumbnail: (formData.get("thumbnail") as string | null)?.trim() || null,
          image_available: hasIiifTiles,
          updated_at: addNow,
        });
        return { ok: true, intent: "add-iiif-object", savedDirectly: true };
      }

      // Self-hosted objects: return as pending for commit + build flow
      const pendingObject: PendingObject = {
        object_id: objectId,
        title,
        featured: false,
        creator: (formData.get("creator") as string | null)?.trim() || null,
        description: (formData.get("description") as string | null)?.trim() || null,
        source_url: sourceUrl,
        period: null,
        year: null,
        object_type: null,
        subjects: null,
        source: (formData.get("source") as string | null)?.trim() || null,
        credit: (formData.get("credit") as string | null)?.trim() || null,
        thumbnail: (formData.get("thumbnail") as string | null)?.trim() || null,
        image_available: hasIiifTiles,
      };

      return { ok: true, intent: "add-iiif-object", pendingObject };
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
      const fixUrl = formData.get("fixUrl") === "true";
      const pagesUrl = formData.get("pagesUrl") as string | null;

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
          missing_from_repo: false,
        })),
      ].sort((a, b) => a.object_id.localeCompare(b.object_id));

      // Read existing CSV to preserve comment/instruction rows
      const existingCsv = await getFileContent(token, owner, repo, "telar-content/spreadsheets/objects.csv");
      const csvContent = serializeObjectsCsv(allObjectsForCsv, existingCsv ?? undefined);

      const files: Array<{ path: string; content: string }> = [
        { path: "telar-content/spreadsheets/objects.csv", content: csvContent },
      ];

      const commitParts = ["update objects.csv"];

      // Check if _config.yml needs modification (sheets or URL fix)
      if (disableSheets || fixUrl) {
        let configContent = await getFileContent(token, owner, repo, "_config.yml");
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

      const commitMessage = `chore: ${commitParts.join(", ")} via Telar Compositor`;

      try {
        const result = await commitFilesToRepo(token, owner, repo, "main", files, commitMessage);

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

        return { ok: true, intent: "commit-objects", newHeadSha: result.newHeadSha };
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

      if (!sha) {
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
        const runs = await listWorkflowRunsBySha(token, owner, repo, sha);

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
      }));

      // D1 batch limit: 100 bindings per INSERT, 18 columns → max 5 rows
      const maxRows = Math.floor(100 / 18);
      for (let i = 0; i < rows.length; i += maxRows) {
        await db.insert(objects).values(rows.slice(i, i + maxRows));
      }

      return { ok: true, intent: "insert-pending-objects", insertedCount: rows.length };
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
// Component
// ---------------------------------------------------------------------------

export default function ObjectsPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("objects");
  const { project, objects: loaderObjects, siteBaseUrl } = loaderData;

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

  // Fetchers
  const featuredFetcher = useFetcher();
  const syncFetcher = useFetcher();
  const iiifFetcher = useFetcher();
  const sheetsFetcher = useFetcher();

  // Handle sync diff result
  const syncFetcherData = syncFetcher.data as
    | { ok: true; intent: "compute-sync-diff"; diff: SyncDiff }
    | { ok: true; intent: "sync-apply"; appliedCount: number; pendingObjects: PendingObject[] }
    | { ok: false; intent: string; error: string }
    | null
    | undefined;

  const iiifFetcherData = iiifFetcher.data as
    | { ok: true; intent: "fetch-iiif-preview"; result: IiifFetchResult }
    | { ok: true; intent: "add-iiif-object"; pendingObject: PendingObject; savedDirectly?: never }
    | { ok: true; intent: "add-iiif-object"; savedDirectly: true; pendingObject?: never }
    | { ok: false; intent: string; error: string }
    | null
    | undefined;

  const preCommitData = sheetsFetcher.data as
    | { ok: true; intent: "pre-commit-check"; sheetsEnabled: boolean; urlCheck: { match: boolean; pagesUrl: string; configUrl: string } }
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

  useEffect(() => {
    if (iiifFetcherData?.ok && iiifFetcherData.intent === "add-iiif-object" && addIiifOpen) {
      setAddIiifOpen(false);
      setIiifFetchResult(null);
      if (iiifFetcherData.savedDirectly) {
        // External object saved directly to D1 — no build needed, just reload the list
        return;
      }
      setPendingObjects([iiifFetcherData.pendingObject]);
      sheetsFetcher.submit({ intent: "pre-commit-check" }, { method: "post" });
      setCommitModalOpen(true);
    }
  }, [iiifFetcherData, addIiifOpen]);

  function handleToggleFeatured(object: ObjectRowObject) {
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
    iiifFetcher.submit(
      {
        intent: "add-iiif-object",
        title: payload.title,
        creator: payload.creator,
        description: payload.description,
        source: payload.source,
        credit: payload.credit,
        thumbnail: payload.thumbnail,
        source_url: payload.manifestUrl,
        image_available: String(payload.image_available),
        object_id: payload.object_id,
      },
      { method: "post" }
    );
  }

  function handleBuildFailed() {
    // Build failed — pending objects were never inserted, nothing to clean up
    setCommitModalOpen(false);
    setPendingObjects([]);
  }

  function handleBuildSuccess() {
    // Build succeeded — close modal, clear pending objects
    // (D1 insertion is handled by the modal via insert-pending-objects action)
    setCommitModalOpen(false);
    setPendingObjects([]);
    setSheetsEnabled(false);
  }

  function handleCommitCancel() {
    // User cancelled — pending objects are discarded, nothing was committed
    setCommitModalOpen(false);
    setPendingObjects([]);
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

  // Apply sort + filter
  const processedObjects = filterObjects(
    sortObjects(loaderObjects as ObjectRowObject[], sortBy),
    filterStatus
  );

  const hasObjects = loaderObjects.length > 0;
  const isComputing = syncFetcher.state !== "idle" &&
    syncFetcher.formData?.get("intent") === "compute-sync-diff";
  const isApplying = syncFetcher.state !== "idle" &&
    syncFetcher.formData?.get("intent") === "sync-apply";
  const isFetchingIiif = iiifFetcher.state !== "idle" &&
    iiifFetcher.formData?.get("intent") === "fetch-iiif-preview";
  const isAddingIiif = iiifFetcher.state !== "idle" &&
    iiifFetcher.formData?.get("intent") === "add-iiif-object";

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

          {/* Sync from repo */}
          <button
            type="button"
            onClick={handleSyncClick}
            disabled={isComputing}
            className="font-heading font-semibold text-sm text-charcoal border border-charcoal rounded-full px-4 py-1.5 hover:bg-gray-50 transition-colors uppercase tracking-wider disabled:opacity-50"
          >
            {t("sync_button")}
          </button>

          {/* Add External IIIF */}
          <button
            type="button"
            onClick={handleAddIiifClick}
            className="inline-flex items-center justify-center bg-periwinkle hover:bg-periwinkle-hover text-charcoal font-heading font-semibold text-sm uppercase tracking-wider rounded-full px-4 py-1.5 transition-colors"
          >
            {t("add_iiif_button")}
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
        }}
        diffData={syncDiffData}
        onApply={handleSyncApply}
        isComputing={isComputing}
        isApplying={isApplying}
      />

      {/* Add IIIF dialog */}
      <AddIiifDialog
        open={addIiifOpen}
        onClose={() => {
          setAddIiifOpen(false);
          setIiifFetchResult(null);
        }}
        fetchResult={dialogFetchResult}
        onFetchUrl={handleIiifFetch}
        onConfirm={handleIiifConfirm}
        isFetching={isFetchingIiif}
        isAdding={isAddingIiif}
      />

      {/* Commit and build modal */}
      <CommitAndBuildModal
        open={commitModalOpen}
        sheetsEnabled={sheetsEnabled}
        urlMismatch={urlMismatch}
        pendingObjects={pendingObjects}
        onClose={handleCommitCancel}
        onBuildSuccess={handleBuildSuccess}
        onBuildFailed={handleBuildFailed}
      />
    </div>
  );
}
