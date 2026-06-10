/**
 * Object detail page — IIIF viewer + metadata editor.
 *
 * Layout: two-column — viewer (left ~60%) + scrollable metadata form (right ~40%).
 * Constructs manifest URLs from project config (url + baseurl) for self-hosted
 * objects, or uses source_url directly for external IIIF objects.
 *
 * @version v1.3.0-beta
 */

import { eq, and } from "drizzle-orm";
import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Link, useFetcher, redirect, useRouteError, isRouteErrorResponse } from "react-router";
import { ArrowLeft, Trash2, Video, Music } from "lucide-react";
import type { Route } from "./+types/_app.objects.$objectId";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { objects, project_config, steps, stories } from "~/db/schema";
import { createSessionStorage } from "~/lib/session.server";
import { resolveActiveProject } from "~/lib/membership.server";
import { deriveStatus } from "~/lib/iiif-types";
import { Switch } from "~/components/ui/Switch";
import { InlineTextField } from "~/components/ui/InlineTextField";
import { InlineTextArea } from "~/components/ui/InlineTextArea";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { useStructuralOps } from "~/hooks/use-structural-ops";
import { findYMapById, getYText } from "~/lib/yjs-helpers";
import * as Y from "yjs";
import { IiifViewer } from "~/components/features/objects/IiifViewer";
import { detectMediaType, extractVideoId } from "~/lib/media-type";
import { VideoEmbed } from "~/components/features/editor/VideoEmbed";
import { AudioPlayer } from "~/components/features/editor/AudioPlayer";
import { CommitAndBuildModal } from "~/components/features/objects/CommitAndBuildModal";
import { decrypt } from "~/lib/crypto.server";
import { recordError } from "~/lib/error-capture";
import { getFileContent, getRepoTree, githubHeaders } from "~/lib/github.server";
import { commitFilesToRepo, StaleHeadError, dispatchWorkflow, getJobSteps, mapStepsToBuildPhases } from "~/lib/commit.server";
import { bumpProjectHead } from "~/lib/github-status.server";
import type { WorkflowRun } from "~/lib/commit.server";
import { getInstallationToken } from "~/lib/github-app.server";
import { serializeObjectsCsv, dbObjectToCsvRow } from "~/lib/csv-export.server";
import { asc } from "drizzle-orm";

export const handle = { i18n: ["common", "objects"] };

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);

  // Get active project
  const sessionStorage = createSessionStorage(env.SESSION_SECRET);
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));
  const sessionActiveId = session.get("activeProjectId") as number | undefined;

  const resolved = await resolveActiveProject(db, user.id, sessionActiveId);
  if (!resolved) throw redirect("/onboarding");
  const { project: activeProject, userRole } = resolved;

  // Fetch the object
  const [object] = await db
    .select()
    .from(objects)
    .where(
      and(
        eq(objects.project_id, activeProject.id),
        eq(objects.object_id, params.objectId)
      )
    )
    .limit(1);

  if (!object) throw new Response("Not found", { status: 404 });

  // Fetch project config for site URL
  const [config] = await db
    .select()
    .from(project_config)
    .where(eq(project_config.project_id, activeProject.id))
    .limit(1);

  // Construct IIIF URLs — skip for video/audio objects (they don't have tiles)
  const loaderMediaType = detectMediaType(object.source_url, object.object_id);
  const isMediaObject = loaderMediaType === "youtube" || loaderMediaType === "vimeo"
    || loaderMediaType === "google-drive" || loaderMediaType === "audio";

  const isExternal =
    object.source_url !== null &&
    (object.source_url.startsWith("http://") ||
      object.source_url.startsWith("https://"));

  let manifestUrl: string | null = null;
  let infoJsonUrl: string | null = null;

  if (!isMediaObject) {
    if (isExternal) {
      manifestUrl = object.source_url;
    } else if (config?.url) {
      const base = `${config.url}${config.baseurl ?? ""}`;
      manifestUrl = `${base}/iiif/objects/${object.object_id}/manifest.json`;
      infoJsonUrl = `${base}/iiif/objects/${object.object_id}/info.json`;
    }
  }

  // Fetch story usage for this object
  const stepRefs = await db
    .select({
      story_id: steps.story_id,
      step_number: steps.step_number,
    })
    .from(steps)
    .where(eq(steps.object_id, object.object_id));

  const storyIds = [...new Set(stepRefs.map((r) => r.story_id))];
  let storyTitles: Record<number, string | null> = {};
  if (storyIds.length > 0) {
    const storyRows = await db
      .select({ id: stories.id, title: stories.title })
      .from(stories)
      .where(eq(stories.project_id, activeProject.id));
    storyTitles = Object.fromEntries(storyRows.map((s) => [s.id, s.title]));
  }

  const usedInStories = stepRefs.map((ref) => ({
    storyTitle: storyTitles[ref.story_id] ?? null,
    stepNumber: ref.step_number,
  }));

  // Construct site base URL for audio file access
  const siteBase = config?.url
    ? `${config.url}${config.baseurl ?? ""}`
    : null;

  return {
    object,
    manifestUrl,
    infoJsonUrl,
    isExternal,
    usedInStories,
    siteBase,
    userRole,
    currentUserId: user.id,
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ request, params, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  switch (intent) {
    case "autosave-object-field": {
      const entityId = Number(formData.get("entityId"));
      const field = formData.get("field") as string;
      const value = (formData.get("value") as string | null)?.trim() || null;

      const allowedFields = [
        "title", "creator", "description", "period", "year",
        "object_type", "subjects", "source", "credit", "alt_text",
      ];

      if (!allowedFields.includes(field)) {
        return { ok: false, error: "invalid_field" };
      }

      // Title is required — don't save empty
      if (field === "title" && !value) {
        return { ok: false, error: "title_required" };
      }

      const sessionStorage = createSessionStorage(env.SESSION_SECRET);
      const session = await sessionStorage.getSession(request.headers.get("Cookie"));
      const sessionActiveId = session.get("activeProjectId") as number | undefined;
      const resolved = await resolveActiveProject(db, user.id, sessionActiveId);
      if (!resolved) return { ok: false, error: "no_project" };

      await db
        .update(objects)
        .set({
          [field]: value,
          updated_at: new Date().toISOString(),
        })
        .where(and(eq(objects.id, entityId), eq(objects.project_id, resolved.project.id)));

      return { ok: true, intent: "autosave-object-field" };
    }

    case "autosave-object-featured": {
      const entityId = Number(formData.get("entityId"));
      const featured = formData.get("value") === "true";

      const sessionStorage = createSessionStorage(env.SESSION_SECRET);
      const session = await sessionStorage.getSession(request.headers.get("Cookie"));
      const sessionActiveId = session.get("activeProjectId") as number | undefined;
      const resolved = await resolveActiveProject(db, user.id, sessionActiveId);
      if (!resolved) return { ok: false, error: "no_project" };

      await db
        .update(objects)
        .set({
          featured,
          updated_at: new Date().toISOString(),
        })
        .where(and(eq(objects.id, entityId), eq(objects.project_id, resolved.project.id)));

      return { ok: true, intent: "autosave-object-featured" };
    }

    case "update-object": {
      // Legacy — kept for backward compatibility
      const objectDbId = Number(formData.get("objectDbId"));
      const title = (formData.get("title") as string | null)?.trim() || null;

      if (!title) {
        return { ok: false, error: "title_required" };
      }

      const sessionStorage = createSessionStorage(env.SESSION_SECRET);
      const session = await sessionStorage.getSession(request.headers.get("Cookie"));
      const sessionActiveId = session.get("activeProjectId") as number | undefined;
      const resolved = await resolveActiveProject(db, user.id, sessionActiveId);
      if (!resolved) return { ok: false, error: "no_project" };

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
          updated_at: new Date().toISOString(),
        })
        .where(and(eq(objects.id, objectDbId), eq(objects.project_id, resolved.project.id)));

      return { ok: true, intent: "update-object" };
    }

    case "delete-object": {
      const objectDbId = Number(formData.get("objectDbId"));
      const fromRepo = formData.get("fromRepo") === "true";

      // Look up the object to get object_id and source_url
      const [targetObject] = await db
        .select()
        .from(objects)
        .where(eq(objects.id, objectDbId))
        .limit(1);

      if (!targetObject) throw redirect("/objects");

      // Resolve the caller's active project — also verifies membership
      const sessionStorage = createSessionStorage(env.SESSION_SECRET);
      const session = await sessionStorage.getSession(request.headers.get("Cookie"));
      const sessionActiveId = session.get("activeProjectId") as number | undefined;
      const resolved = await resolveActiveProject(db, user.id, sessionActiveId);
      if (!resolved) throw redirect("/objects");

      // Guard: only delete objects that belong to the caller's active project
      if (targetObject.project_id !== resolved.project.id) throw redirect("/objects");

      if (fromRepo) {
        // Delete from repo: remove image folder + update objects.csv + commit.
        // The whole region runs inside try/catch — decrypt, the CSV fetch and
        // the D1 listing can throw, and an uncaught throw here became an
        // opaque 500 instead of the structured delete_failed.
        const activeProject = resolved.project;

        try {
          const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
          const [owner, repo] = activeProject.github_repo_full_name.split("/");

          // Find files to delete in the object's folder
          const objectFolderPath = `telar-content/objects/${targetObject.object_id}`;
          const deletions: string[] = [];

          try {
            const { tree } = await getRepoTree(token, owner, repo);
            for (const item of tree) {
              if (item.path?.startsWith(objectFolderPath + "/") && item.type === "blob") {
                deletions.push(item.path);
              }
            }
          } catch {
            // If tree fetch fails, we'll just update the CSV without deleting files
          }

          // Build updated objects.csv without this object
          const remainingObjects = await db
            .select()
            .from(objects)
            .where(and(
              eq(objects.project_id, activeProject.id),
              eq(objects.missing_from_repo, false),
            ))
            .orderBy(asc(objects.object_id));

          const filteredObjects = remainingObjects.filter(
            (o) => o.id !== objectDbId
          );

          const existingCsv = await getFileContent(
            token, owner, repo, "telar-content/spreadsheets/objects.csv"
          );
          const updatedCsv = serializeObjectsCsv(filteredObjects.map(dbObjectToCsvRow), existingCsv ?? undefined);

          // Repo WRITE on the App installation token (contents:write
          // independent of the user's own GitHub access); user token is the
          // local-dev fallback — matching the upload/commit flows.
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

          // Commit: updated CSV + deletions
          const result = await commitFilesToRepo(
            commitToken, owner, repo, "main",
            [{ path: "telar-content/spreadsheets/objects.csv", content: updatedCsv }],
            `Remove ${targetObject.object_id} via Telar Compositor`,
            undefined,                                         // messageBody
            deletions.length > 0 ? deletions : undefined,     // deletions
          );

          // Update head_sha (also invalidates GitHub status cache)
          await bumpProjectHead(db, activeProject.id, result.newHeadSha);
        } catch (err) {
          if (err instanceof StaleHeadError) {
            return { ok: false, error: "stale_head" };
          }
          return { ok: false, error: "delete_failed" };
        }
      }

      // Delete from D1 — scoped to the verified project
      await db.delete(objects).where(and(eq(objects.id, objectDbId), eq(objects.project_id, resolved.project.id)));
      throw redirect("/objects");
    }

    case "poll-build": {
      const runIdParam = formData.get("runId") as string | null;
      if (!runIdParam) {
        return { ok: false, intent: "poll-build", error: "missing_run_id" };
      }

      const sessionStoragePoll = createSessionStorage(env.SESSION_SECRET);
      const sessionPoll = await sessionStoragePoll.getSession(request.headers.get("Cookie"));
      const sessionActiveIdPoll = sessionPoll.get("activeProjectId") as number | undefined;

      // Membership-aware (member-level: polling is read-only build status) —
      // no first-owned-project fallback.
      const resolvedPoll = await resolveActiveProject(db, user.id, sessionActiveIdPoll);
      if (!resolvedPoll) {
        return { ok: false, intent: "poll-build", error: "no_project" };
      }
      const activeProjectPoll = resolvedPoll.project;

      try {
        const tokenPoll = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
        const [ownerPoll, repoPoll] = activeProjectPoll.github_repo_full_name.split("/");

        const runId = Number(runIdParam);
        const runRes = await fetch(
          `https://api.github.com/repos/${ownerPoll}/${repoPoll}/actions/runs/${runId}`,
          { headers: githubHeaders(tokenPoll) },
        );
        if (!runRes.ok) {
          return { ok: false, intent: "poll-build", error: "poll_failed" };
        }
        const run = (await runRes.json()) as WorkflowRun;
        const jobSteps = await getJobSteps(tokenPoll, ownerPoll, repoPoll, runId);
        const phases = mapStepsToBuildPhases(jobSteps);
        return {
          ok: true,
          intent: "poll-build",
          buildStatus: run.status,
          buildConclusion: run.conclusion,
          buildUrl: run.html_url,
          runId: run.id,
          phases,
        };
      } catch {
        return { ok: false, intent: "poll-build", error: "poll_failed" };
      }
    }

    case "dispatch-iiif": {
      // Dispatch full site build to generate tiles (tiles are deployed via Pages, not git)
      const sessionStorage3 = createSessionStorage(env.SESSION_SECRET);
      const session3 = await sessionStorage3.getSession(request.headers.get("Cookie"));
      const sessionActiveId3 = session3.get("activeProjectId") as number | undefined;

      // Membership-aware (member-level: the Generate-tiles button renders for
      // any project member; dispatching a rebuild is non-destructive) — no
      // first-owned-project fallback.
      const resolved3 = await resolveActiveProject(db, user.id, sessionActiveId3);
      if (!resolved3) {
        return { ok: false, intent: "dispatch-iiif", error: "no_project" };
      }
      const activeProject3 = resolved3.project;

      try {
        const token3 = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
        const [owner3, repo3] = activeProject3.github_repo_full_name.split("/");

        let dispatchToken = token3;
        try {
          dispatchToken = await getInstallationToken(
            env.GITHUB_APP_ID,
            env.GITHUB_PRIVATE_KEY,
            activeProject3.installation_id,
          );
        } catch {
          // Fall back to user token
        }
        const dispatch = await dispatchWorkflow(
          dispatchToken, owner3, repo3, "build.yml",
        );
        return {
          ok: true,
          intent: "dispatch-iiif",
          runId: dispatch.runId || null,
          htmlUrl: dispatch.htmlUrl || null,
        };
      } catch (err) {
        // Standardised error code — the raw err.message was previously
        // returned AS the code, which no client map could handle.
        return {
          ok: false,
          intent: "dispatch-iiif",
          error: "dispatch_failed",
          message: err instanceof Error ? err.message : "Unknown error",
        };
      }
    }

    default:
      throw new Response("Bad request", { status: 400 });
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ObjectDetailPage({ loaderData }: Route.ComponentProps) {
  const { object, manifestUrl, infoJsonUrl, isExternal, usedInStories, siteBase, userRole, currentUserId } =
    loaderData;
  const { t } = useTranslation("objects");
  // Structural ops let the delete also remove the object's Y.Map — the primary
  // delete signal. Without it the route action deletes the D1 row while the
  // Y.Map survives, and the next snapshot re-INSERTs (resurrects) the object.
  const ops = useStructuralOps(currentUserId, userRole);
  const deleteFetcher = useFetcher();
  const dispatchFetcher = useFetcher();
  const featuredFetcher = useFetcher();
  const [featured, setFeatured] = useState(object.featured ?? false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [buildModalOpen, setBuildModalOpen] = useState(false);
  const [dispatchRunId, setDispatchRunId] = useState<number | null>(null);
  const [dispatchHtmlUrl, setDispatchHtmlUrl] = useState<string | null>(null);

  const { ydoc } = useCollaborationContext();

  // Resolve Y.Text instances for each editable object field from the Yjs doc
  const objectsArray = ydoc?.getArray<Y.Map<unknown>>("objects") ?? null;
  const objectYMap = objectsArray ? findYMapById(objectsArray, object.id) : null;
  const titleYText = getYText(objectYMap, "title");
  const descriptionYText = getYText(objectYMap, "description");
  const creatorYText = getYText(objectYMap, "creator");
  const periodYText = getYText(objectYMap, "period");
  const yearYText = getYText(objectYMap, "year");
  const objectTypeYText = getYText(objectYMap, "object_type");
  const subjectsYText = getYText(objectYMap, "subjects");
  const sourceYText = getYText(objectYMap, "source");
  const creditYText = getYText(objectYMap, "credit");
  const altTextYText = getYText(objectYMap, "alt_text");

  const mediaType = detectMediaType(object.source_url, object.object_id);
  const isMedia = mediaType === "youtube" || mediaType === "vimeo" || mediaType === "google-drive" || mediaType === "audio";
  const hasExternalManifest = !!(object.source_url && /manifest/.test(object.source_url));
  const status = deriveStatus({
    title: object.title,
    image_available: object.image_available || hasExternalManifest,
    missing_from_repo: object.missing_from_repo,
    skipImageCheck: isMedia,
  });

  const isDeleting = deleteFetcher.state !== "idle";

  const isDispatching = dispatchFetcher.state !== "idle";

  // Handle dispatch result — open build modal with run ID
  const dispatchData = dispatchFetcher.data as
    | { ok: true; intent: "dispatch-iiif"; runId: number | null; htmlUrl: string | null }
    | { ok: false; intent: "dispatch-iiif"; error: string }
    | null
    | undefined;

  useEffect(() => {
    if (dispatchData?.ok && dispatchData.intent === "dispatch-iiif") {
      setDispatchRunId(dispatchData.runId);
      setDispatchHtmlUrl(dispatchData.htmlUrl);
      setBuildModalOpen(true);
    }
  }, [dispatchData]);

  function handleGenerateTiles() {
    dispatchFetcher.submit(
      { intent: "dispatch-iiif" },
      { method: "post" },
    );
  }

  function handleFeaturedToggle(checked: boolean) {
    setFeatured(checked);
    // Y.Doc is the source of truth for object metadata; snapshotToD1 reconciles.
    // The D1-only fetcher would be clobbered.
    if (ydoc && objectYMap) {
      ydoc.transact(() => {
        objectYMap.set("featured", checked);
      });
      return;
    }
    featuredFetcher.submit(
      { intent: "autosave-object-featured", entityId: String(object.id), value: String(checked) },
      { method: "post" },
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-7rem)]">
      {/* Breadcrumb bar */}
      <div className="flex items-center gap-3 mb-4 shrink-0">
        <Link
          to="/objects"
          className="inline-flex items-center gap-1.5 font-heading text-sm text-gray-500 hover:text-charcoal transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          {t("breadcrumb_objects")}
        </Link>
        <span className="text-gray-300">/</span>
        <span className="font-heading text-sm font-semibold text-charcoal truncate flex-1">
          {object.title || object.object_id}
        </span>
        <button
          type="button"
          onClick={() => setShowDeleteConfirm(true)}
          className="p-2 rounded-full text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
          title={t("delete_button")}
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {/* Audio: stacked layout (player top, metadata below) */}
      {isMedia && mediaType === "audio" && (
        <div className="shrink-0 mb-4">
          {siteBase && object.source_url ? (
            <AudioPlayer
              audioUrl={`${siteBase}/telar-content/objects/${object.source_url}`}
            />
          ) : (
            <div className="w-full rounded-lg bg-anil p-6 flex flex-col items-center justify-center gap-2 text-charcoal/50">
              <Music className="w-10 h-10" />
              <p className="font-body text-sm">{t("type_audio")}</p>
            </div>
          )}
        </div>
      )}

      {/* Layout: side-by-side for IIIF/video, full-width for audio */}
      <div className={`flex gap-6 flex-1 min-h-0 ${mediaType === "audio" ? "flex-col" : ""}`}>
        {/* Viewer — hidden for audio (shown above), shown for IIIF/video */}
        {mediaType !== "audio" && (
        <div className="w-3/5 shrink-0">
          {isMedia && (mediaType === "youtube" || mediaType === "vimeo" || mediaType === "google-drive") && object.source_url ? (
            <div className="w-full h-full rounded-xl bg-cream-dark flex items-center justify-center p-4">
              <VideoEmbed
                type={mediaType}
                videoId={extractVideoId(mediaType, object.source_url) ?? ""}
              />
            </div>
          ) : (
            <IiifViewer
              manifestUrl={manifestUrl}
              infoJsonUrl={infoJsonUrl}
              isSelfHosted={!isExternal}
              alt={object.title ?? object.object_id}
              className="w-full h-full"
              onGenerateTiles={!isExternal ? handleGenerateTiles : undefined}
              isGenerating={isDispatching}
            />
          )}
        </div>
        )}

        {/* Metadata editor */}
        <div className={`overflow-y-auto bg-white rounded-xl border border-gray-100 ${mediaType === "audio" ? "w-full" : "w-2/5"}`}>
          <div className={`p-6 space-y-4 ${mediaType === "audio" ? "columns-2 gap-8 [&>*]:break-inside-avoid [&>hr]:break-after-column" : ""}`}>
              {/* Status badge */}
              <StatusBadge status={status} />

              {/* Object ID — read-only */}
              <div>
                <FieldLabel htmlFor="field-object-id">Object ID</FieldLabel>
                <p
                  id="field-object-id"
                  className="font-mono text-sm text-gray-500 bg-gray-100 px-3 py-2 rounded-lg truncate"
                  title={object.object_id}
                >
                  {object.object_id}
                </p>
              </div>

              {/* Title */}
              <div>
                <FieldLabel htmlFor="field-title" required>
                  {t("field_title")}
                </FieldLabel>
                <p className="font-body text-xs text-gray-400 mb-1">{t("field_title_help")}</p>
                <InlineTextField
                  initialValue={object.title ?? ""}
                  yText={titleYText}
                  inputClassName="font-body text-sm text-charcoal"
                  bordered
                  fieldKey={`object-${object.object_id}-title`}
                />
              </div>

              {/* Description */}
              <div>
                <FieldLabel htmlFor="field-description">
                  {t("field_description")}
                </FieldLabel>
                <p className="font-body text-xs text-gray-400 mb-1">{t("field_description_help")}</p>
                <InlineTextArea
                  initialValue={object.description ?? ""}
                  yText={descriptionYText}
                  inputClassName="font-body text-sm text-charcoal"
                  rows={3}
                  bordered
                  fieldKey={`object-${object.object_id}-description`}
                />
              </div>

              {/* Creator */}
              <div>
                <FieldLabel htmlFor="field-creator">
                  {t("field_creator")}
                </FieldLabel>
                <p className="font-body text-xs text-gray-400 mb-1">{t("field_creator_help")}</p>
                <InlineTextField
                  initialValue={object.creator ?? ""}
                  yText={creatorYText}
                  inputClassName="font-body text-sm text-charcoal"
                  bordered
                  fieldKey={`object-${object.object_id}-creator`}
                />
              </div>

              {/* Period + Year */}
              <div className="grid grid-cols-2 gap-3 items-end">
                <div>
                  <FieldLabel htmlFor="field-period">
                    {t("field_period")}
                  </FieldLabel>
                  <p className="font-body text-xs text-gray-400 mb-1">{t("field_period_help")}</p>
                  <InlineTextField
                    initialValue={object.period ?? ""}
                    yText={periodYText}
                    inputClassName="font-body text-sm text-charcoal"
                    bordered
                    fieldKey={`object-${object.object_id}-period`}
                  />
                </div>
                <div>
                  <FieldLabel htmlFor="field-year">
                    {t("field_year")}
                  </FieldLabel>
                  <p className="font-body text-xs text-gray-400 mb-1">{t("field_year_help")}</p>
                  <InlineTextField
                    initialValue={object.year ?? ""}
                    yText={yearYText}
                    inputClassName="font-body text-sm text-charcoal"
                    bordered
                    fieldKey={`object-${object.object_id}-year`}
                  />
                </div>
              </div>

              {/* Object Type */}
              <div>
                <FieldLabel htmlFor="field-object-type">
                  {t("field_object_type")}
                </FieldLabel>
                <p className="font-body text-xs text-gray-400 mb-1">{t("field_object_type_help")}</p>
                <InlineTextField
                  initialValue={object.object_type ?? ""}
                  yText={objectTypeYText}
                  inputClassName="font-body text-sm text-charcoal"
                  bordered
                  fieldKey={`object-${object.object_id}-object_type`}
                />
              </div>

              {/* Subjects */}
              <div>
                <FieldLabel htmlFor="field-subjects">
                  {t("field_subjects")}
                </FieldLabel>
                <p className="font-body text-xs text-gray-400 mb-1">{t("field_subjects_help")}</p>
                <InlineTextField
                  initialValue={object.subjects ?? ""}
                  yText={subjectsYText}
                  inputClassName="font-body text-sm text-charcoal"
                  bordered
                  fieldKey={`object-${object.object_id}-subjects`}
                />
              </div>

              {/* Source */}
              <div>
                <FieldLabel htmlFor="field-source">
                  {t("field_source")}
                </FieldLabel>
                <p className="font-body text-xs text-gray-400 mb-1">{t("field_source_help")}</p>
                <InlineTextField
                  initialValue={object.source ?? ""}
                  yText={sourceYText}
                  inputClassName="font-body text-sm text-charcoal"
                  bordered
                  fieldKey={`object-${object.object_id}-source`}
                />
              </div>

              {/* Credit */}
              <div>
                <FieldLabel htmlFor="field-credit">
                  {t("field_credit")}
                </FieldLabel>
                <p className="font-body text-xs text-gray-400 mb-1">{t("field_credit_help")}</p>
                <InlineTextField
                  initialValue={object.credit ?? ""}
                  yText={creditYText}
                  inputClassName="font-body text-sm text-charcoal"
                  bordered
                  fieldKey={`object-${object.object_id}-credit`}
                />
              </div>

              {/* Source URL — read-only */}
              {object.source_url && (
                <div>
                  <FieldLabel htmlFor="field-source-url">
                    {t("field_source_url")}
                  </FieldLabel>
                  <p
                    id="field-source-url"
                    className="font-body text-sm text-gray-500 bg-gray-100 px-3 py-2 rounded-lg truncate"
                    title={object.source_url}
                  >
                    {object.source_url}
                  </p>
                </div>
              )}

              {/* Featured toggle */}
              <div className="flex items-center justify-between">
                <FieldLabel htmlFor="field-featured">
                  {t("field_featured")}
                </FieldLabel>
                <Switch
                  checked={featured}
                  onChange={handleFeaturedToggle}
                  label={t("mark_featured")}
                />
              </div>

              {/* Accessibility section */}
              <hr className="border-gray-100 my-4" />
              <h3 className="font-heading font-semibold text-sm text-charcoal mb-1">
                {t("section_accessibility")}
              </h3>
              <p className="font-body text-xs text-gray-500 mb-3">
                {t("field_alt_text_help")}
              </p>
              <div>
                <FieldLabel htmlFor="field-alt-text">
                  {t("field_alt_text")}
                </FieldLabel>
                <InlineTextArea
                  initialValue={object.alt_text ?? ""}
                  yText={altTextYText}
                  placeholder={t("field_alt_text_placeholder")}
                  inputClassName="font-body text-sm text-gray-500"
                  rows={3}
                  bordered
                  fieldKey={`object-${object.object_id}-alt_text`}
                />
              </div>

              {/* Story usage */}
              {usedInStories.length > 0 && (
                <div>
                  <hr className="border-gray-100 my-4" />
                  <h3 className="font-heading font-semibold text-sm text-charcoal mb-1">
                    {t("used_in_stories")}
                  </h3>
                  <ul className="space-y-1">
                    {usedInStories.map((ref: { storyTitle: string | null; stepNumber: number }, i: number) => (
                      <li
                        key={i}
                        className="font-body text-xs text-gray-500 bg-gray-50 px-3 py-1.5 rounded"
                      >
                        {ref.storyTitle || "Untitled"} — step {ref.stepNumber}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
          </div>

          {/* Delete confirmation modal */}
          {showDeleteConfirm && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
              <div className="bg-white rounded-xl shadow-lg p-6 max-w-sm w-full mx-4">
                <h3 className="font-heading font-semibold text-lg text-charcoal mb-2">
                  {t("delete_title")}
                </h3>
                <p className="font-body text-sm text-gray-600 mb-5">
                  {t("delete_description", { title: object.title || object.object_id })}
                </p>
                <div className="flex flex-col gap-2">
                  {/* Remove from compositor only */}
                  <deleteFetcher.Form
                    method="post"
                    onSubmit={() => ops?.deleteObject(object.id, null)}
                  >
                    <input type="hidden" name="intent" value="delete-object" />
                    <input type="hidden" name="objectDbId" value={object.id} />
                    <button
                      type="submit"
                      disabled={isDeleting}
                      className="w-full font-heading font-semibold text-sm uppercase tracking-wider border border-red-300 text-red-700 rounded-full px-6 py-2.5 hover:bg-red-50 transition-colors disabled:text-fg-disabled"
                    >
                      {t("delete_remove_compositor")}
                    </button>
                  </deleteFetcher.Form>
                  {/* Delete from repo — only for self-hosted objects */}
                  {!isExternal && (
                    <deleteFetcher.Form
                      method="post"
                      onSubmit={() => ops?.deleteObject(object.id, null)}
                    >
                      <input type="hidden" name="intent" value="delete-object" />
                      <input type="hidden" name="objectDbId" value={object.id} />
                      <input type="hidden" name="fromRepo" value="true" />
                      <button
                        type="submit"
                        disabled={isDeleting}
                        className="w-full font-heading font-semibold text-sm uppercase tracking-wider bg-red-500 hover:bg-red-600 text-white rounded-full px-6 py-2.5 transition-colors disabled:bg-disabled disabled:text-fg-disabled"
                      >
                        {t("delete_remove_repo")}
                      </button>
                    </deleteFetcher.Form>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowDeleteConfirm(false)}
                    disabled={isDeleting}
                    className="w-full font-heading font-semibold text-sm uppercase tracking-wider border border-gray-200 text-charcoal rounded-full px-6 py-2.5 hover:bg-cream transition-colors disabled:text-fg-disabled"
                  >
                    {t("delete_cancel")}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Build progress modal (tile generation) */}
      <CommitAndBuildModal
        open={buildModalOpen}
        sheetsEnabled={false}
        urlMismatch={null}
        pendingObjects={[]}
        skipCommit={true}
        dispatchRunId={dispatchRunId}
        dispatchHtmlUrl={dispatchHtmlUrl}
        onClose={() => setBuildModalOpen(false)}
        onBuildSuccess={() => {
          setBuildModalOpen(false);
          setDispatchRunId(null);
          setDispatchHtmlUrl(null);
          // Reload to pick up tile availability
          window.location.reload();
        }}
        onBuildFailed={() => {
          setBuildModalOpen(false);
          setDispatchRunId(null);
          setDispatchHtmlUrl(null);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers (local to this route)
// ---------------------------------------------------------------------------


function FieldLabel({
  htmlFor,
  required,
  children,
}: {
  htmlFor: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="block font-body text-xs font-medium text-gray-600 mb-1"
    >
      {children}
      {required && <span className="text-red-500 ml-0.5">*</span>}
    </label>
  );
}

function StatusBadge({
  status,
}: {
  status: ReturnType<typeof deriveStatus>;
}) {
  const { t } = useTranslation("objects");

  const config: Record<
    ReturnType<typeof deriveStatus>,
    { label: string; dotClass: string; badgeClass: string }
  > = {
    ready: {
      label: t("status_ready"),
      dotClass: "bg-green-500",
      badgeClass: "bg-green-50 text-green-700",
    },
    no_metadata: {
      label: t("status_no_metadata"),
      dotClass: "bg-amber-400",
      badgeClass: "bg-amber-50 text-amber-700",
    },
    image_missing: {
      label: t("status_image_missing"),
      dotClass: "bg-gray-400",
      badgeClass: "bg-gray-100 text-gray-600",
    },
    missing_from_repo: {
      label: t("status_missing_from_repo"),
      dotClass: "bg-red-500",
      badgeClass: "bg-red-50 text-red-700",
    },
  };

  const { label, dotClass, badgeClass } = config[status];

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs rounded-full px-2.5 py-0.5 ${badgeClass}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
      {label}
    </span>
  );
}


/**
 * ErrorBoundary — mirrors the story editor's boundary (_app.stories.$storyId.tsx).
 * Without it, a 404 from the loader (an object present in the Y.Array list but
 * not yet snapshotted to D1, or a stranded object) bubbles to the root boundary
 * and renders the whole-app crash screen — and floods the crash buffer for what
 * is normal not-yet-snapshotted navigation. Here we catch it in-shell:
 *   - 404 is the expected transient "not snapshotted yet" state — recoverable,
 *     not reported (reporting would flood the buffer with normal navigation).
 *   - Any non-404 is a real failure — reported via the same recordError the root
 *     boundary uses (browser-only via useEffect), rendered as a generic card.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const { t } = useTranslation("objects");
  const is404 = isRouteErrorResponse(error) && error.status === 404;

  useEffect(() => {
    if (!is404) recordError(error, "boundary");
  }, [error, is404]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-white rounded-lg shadow-md p-6 text-center">
        <h1 className="font-heading text-xl font-semibold text-charcoal">
          {is404 ? t("error.not_available_title") : t("error.generic_title")}
        </h1>
        <p className="font-body text-sm text-gray-600 mt-3">
          {is404 ? t("error.not_available_body") : t("error.generic_body")}
        </p>
        <div className="flex gap-3 justify-center mt-6">
          <Link
            to="/objects"
            className="font-heading text-sm uppercase tracking-wider px-4 py-2 rounded text-charcoal bg-gray-100 hover:bg-gray-200 transition-colors"
          >
            {t("error.back_to_objects")}
          </Link>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="font-heading text-sm uppercase tracking-wider px-4 py-2 rounded text-white bg-terracotta hover:bg-terracotta/90 transition-colors"
          >
            {t("error.retry")}
          </button>
        </div>
      </div>
    </div>
  );
}
