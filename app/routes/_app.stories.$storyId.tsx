/**
 * This file is the Story Editor route — the full three-column story
 * editing surface (sidebar / narrative / viewer) the user lands on
 * when they click into an individual story.
 *
 * Loader fetches the story by `story_id` slug, all its steps
 * (ordered), layers for all steps, project objects for the object
 * picker, project config for constructing IIIF URLs, and team
 * members (for delete-confirmation contributor warnings), and — streamed,
 * not awaited — the site's preview configuration for the stage's theme and
 * the layer editor's widgets and formulas. Action handles
 * `capture-position`, `change-object`, `set-page`, `save-layer`,
 * `autosave-layer` and `save-step-field`; the last two are also the saves of
 * the fields edited in place on the stage when there is no Y.Doc, and the
 * layer and step-text saves answer a refusal as `{ ok: false }` rather than
 * throwing it. Structural ops (`add-step`, `delete-step`,
 * `reorder-steps`, `create-layer`, `delete-layer`) are migrated to
 * Yjs via `useStructuralOps` — `snapshotToD1` reconciles Y.Array
 * state back to D1 entity tables every 30 seconds.
 *
 * Wires `StepSidebar`, the layer panels and the route's state into
 * `StoryStage`, which lays out the editor. Reads steps and layers from the Y.Array when a
 * Y.Doc is available, otherwise falls back to loader data.
 *
 * Computes a plain `layersByStep` map so the step line can draw each
 * step's layer branches, and mirrors in-editor navigation into
 * `?step`/`?layer` with `setSearchParams(…, { replace: true })`, one write per
 * action (`selectStepIn`, `useLayerPanels`), never inside the one-shot
 * `deepLinkConsumedRef` mount read.
 *
 * @version v1.5.0-beta
 */

import { useState, useEffect, useRef, useMemo } from "react";
import { data, redirect, useFetcher, useNavigate, useOutletContext, useSearchParams, Link, useRouteError, isRouteErrorResponse } from "react-router";
import { and, eq, inArray } from "drizzle-orm";
import { objectsSheetOrder } from "~/lib/objects.server";
import type { Route } from "./+types/_app.stories.$storyId";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { stories, story_previous_ids, steps, layers, objects, project_config, project_members, users as usersTable } from "~/db/schema";
import { requireProjectMember } from "~/lib/membership.server";
import { resolveActiveProjectFromRequest } from "~/lib/active-project.server";
import { readPanelPreviewConfig } from "~/lib/panel-preview-config.server";
import { readGlossaryKinds } from "~/lib/glossary-kinds.server";
import { saveRefusalOf } from "~/lib/save-refusal.server";
import { StoryStage } from "~/components/features/editor/StoryStage";
import { introSectionTitles } from "~/lib/intro-toc";
import type { SceneStepText } from "~/components/features/editor/SceneCards";
import { sceneRun } from "~/lib/media-scenes";
import { StepSidebar } from "~/components/features/editor/StepSidebar";
import type { SidebarLayerSummary } from "~/components/features/editor/StepSidebar";
import type { StagePanelLayer } from "~/components/features/editor/StagePanels";
import { useLayerPanels } from "~/hooks/use-layer-panels";
import { usePendingLayers, type PendingLayerField } from "~/hooks/use-pending-layers";
import { DeleteStepDialog } from "~/components/features/editor/DeleteStepDialog";
import { DeleteConfirmationModal } from "~/components/ui/DeleteConfirmationModal";
import { useTranslation } from "react-i18next";
import { configFrameworkVersion, iiifUrlsFor, mediaTypesByStepValue, resolveStepObject } from "~/lib/object-id";
import { useCollaborationContext, useSetAwarenessLocation, FALLBACK_HIGHLIGHT_COLOR } from "~/hooks/use-collaboration";
import { useStructuralOps } from "~/hooks/use-structural-ops";
import { useYjsArraySync } from "~/hooks/use-yjs-array-sync";
import { useProviderSynced } from "~/hooks/use-provider-synced";
import { editorObjectFromYMap, liveEditorObjects } from "~/lib/story-editor-objects";
import { compareByOrderKey, orderedMaps, readOrderKey } from "~/lib/field-order";
import { useToast } from "~/hooks/use-toast";
import { findYMapById, getYText } from "~/lib/yjs-helpers";
import { keyFor } from "~/lib/item-key";
import { sourceKeyFor } from "~/lib/iiif-pages";
import { isSidebarStep, selectionKeyFor } from "~/lib/step-writes";
import { selectStepIn } from "~/lib/step-selection";
import { useStepPageWrites } from "~/hooks/use-step-page-writes";
import { recordError } from "~/lib/error-capture";
import { nextStamp } from "~/components/ui/target-saves";
import { stampFieldSaveAnswer } from "~/hooks/use-route-field-save";
import { retireLayerContent } from "~/hooks/use-layer-content-drafts";
import { useStageWriteFailure } from "~/hooks/use-stage-write-failure";
import { FOLLOW_FLUSH_INTENT, useFollowStoryId } from "~/hooks/use-follow-story-id";
import { storyIdProblem } from "~/lib/story-id";
import { answerOrUnreachable, asUnreachableAnswer, readAnotherPage } from "~/lib/unreachable-write";
import type { ShouldRevalidateFunctionArgs } from "react-router";
import * as Y from "yjs";

export const handle = { i18n: ["editor", "common"] };

/** The step columns a field in place saves through `save-step-field`. */
const STEP_TEXT_FIELDS = new Set(["question", "answer", "alt_text"]);

// The page carries the member's layer text and the site's preview settings,
// both read for the active project: no response is kept, so switching
// projects can never show another site's.
export function headers(): HeadersInit {
  return { "Cache-Control": "private, no-store" };
}

/**
 * The current ID of the project's story that held `oldId` before it, or null:
 * every ID a story leaves is recorded against its row (`story_previous_ids`),
 * and an ID another story leaves later points at that story. Scoped to the
 * active project. The caller asks only after no live story holds `oldId`.
 */
async function currentIdOfStoryThatHeld(db: ReturnType<typeof getDb>, projectId: number, oldId: string): Promise<string | null> {
  const rows = await db
    .select({ story_id: stories.story_id })
    .from(story_previous_ids)
    .innerJoin(stories, eq(stories.id, story_previous_ids.story_row_id))
    .where(and(eq(story_previous_ids.project_id, projectId), eq(story_previous_ids.story_id, oldId)))
    .limit(1);
  return rows[0]?.story_id ?? null;
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);

  // Read activeProjectId from session, fall back to first project
  const resolved = await resolveActiveProjectFromRequest(request, env, user.id);
  if (!resolved) throw redirect("/dashboard");
  const { project: activeProject, userRole } = resolved;
  const activeProjectId = activeProject.id;

  // Fetch story by story_id slug (URL param is slug, not D1 integer id)
  const storyRows = await db
    .select()
    .from(stories)
    .where(
      and(
        eq(stories.project_id, Number(activeProjectId)),
        eq(stories.story_id, params.storyId)
      )
    )
    .limit(1);

  if (storyRows.length === 0) {
    const renamedTo = await currentIdOfStoryThatHeld(db, Number(activeProjectId), params.storyId);
    if (renamedTo && renamedTo !== params.storyId) throw redirect(`/stories/${encodeURIComponent(renamedTo)}${new URL(request.url).search}`);
    throw new Response("Not Found", { status: 404 });
  }
  const story = storyRows[0];

  // Fetch steps ordered by step_number
  const storySteps = await db
    .select()
    .from(steps)
    .where(eq(steps.story_id, story.id))
    .orderBy(steps.step_number);

  // Fetch layers for all steps in one query
  const stepIds = storySteps.map((s) => s.id);
  const storyLayers =
    stepIds.length > 0
      ? await db
          .select()
          .from(layers)
          .where(inArray(layers.step_id, stepIds))
      : [];

  // Fetch project objects for the object picker, in the order a publish
  // writes them to objects.csv, which decides the row a step shows where two
  // share the site's id (`resolveStepObject`).
  const projectObjects = await db
    .select({
      object_id: objects.object_id,
      title: objects.title,
      thumbnail: objects.thumbnail,
      image_available: objects.image_available,
      source_url: objects.source_url,
      alt_text: objects.alt_text,
    })
    .from(objects)
    .where(eq(objects.project_id, Number(activeProjectId)))
    .orderBy(objectsSheetOrder());

  // Fetch project config for IIIF URL construction (self-hosted objects).
  const configRows = await db
    .select({
      url: project_config.url,
      baseurl: project_config.baseurl,
      lang: project_config.lang,
      telar_version: project_config.telar_version,
      glossary_kinds_json: project_config.glossary_kinds_json,
    })
    .from(project_config)
    .where(eq(project_config.project_id, Number(activeProjectId)))
    .limit(1);

  const siteBaseUrl = configRows[0]?.url
    ? `${configRows[0].url}${configRows[0].baseurl ?? ""}`
    : null;

  // Fetch team members for delete-confirmation contributor warnings
  const memberRows = await db
    .select({
      userId: project_members.user_id,
      name: usersTable.github_name,
      login: usersTable.github_login,
      contributions: project_members.contributions,
    })
    .from(project_members)
    .innerJoin(usersTable, eq(project_members.user_id, usersTable.id))
    .where(eq(project_members.project_id, Number(activeProjectId)));

  const members = memberRows.map((m) => ({
    userId: m.userId,
    name: m.name || m.login,
    contributions: m.contributions ? JSON.parse(m.contributions) : null,
  }));

  return {
    story,
    steps: storySteps,
    layers: storyLayers,
    objects: projectObjects,
    siteBaseUrl,
    // The site's framework version, which decides the id it gives an object.
    frameworkVersion: configFrameworkVersion(configRows[0]),
    // The site's language, whose default button labels head an untitled panel.
    siteLang: configRows[0]?.lang ?? null,
    repoFullName: activeProject.github_repo_full_name,
    members,
    currentUserId: user.id,
    userRole,
    // Not awaited: the page renders while the site's files are read, and the
    // layer editor applies the configuration when it arrives.
    panelPreview: readPanelPreviewConfig(env, user.encrypted_access_token, activeProject),
    // Not awaited either: a glossary callout in a panel shows its entry's
    // kind once the site's kinds arrive.
    glossaryKinds: readGlossaryKinds(env, user.encrypted_access_token, activeProject, configRows[0]?.glossary_kinds_json ?? null),
  };
}

/**
 * Every read of the loader in the browser is stamped, on the counter the
 * fields' saves are confirmed on, as it begins. A read begun before a save
 * and delivered after it then carries a stamp older than the save's
 * confirmation, and the stage keeps it from the fields
 * (`useFreshStepText`), whatever order the router delivers reads in. The
 * first render's data is the server's, and has no stamp.
 */
export async function clientLoader({ serverLoader }: Route.ClientLoaderArgs) {
  const readStamp = nextStamp();
  return { ...(await serverLoader()), readStamp };
}

/**
 * The action, answered in the browser: a field save's answer is stamped as it
 * arrives (`stampFieldSaveAnswer`), before the router begins the read the
 * save starts, so the stage can tell reads begun before the save from reads
 * begun after it. A write that never reached the action's own answer (the
 * request failed, a bare 5xx, an exception) is answered as a failed write
 * (`answerOrUnreachable`), so its field reports it and the editor stays open,
 * with a status that keeps the router from reading anything again.
 */
export async function clientAction({ request, serverAction }: Route.ClientActionArgs) {
  const answer = await answerOrUnreachable(request, serverAction);
  stampFieldSaveAnswer(answer);
  return asUnreachableAnswer(answer);
}

/**
 * Another page is always read, whatever a write's answer held back
 * (`readAnotherPage`). The flush `useFollowStoryId` sends before following a
 * changed ID reads this address nothing again: it may name an ID no row holds
 * any more, and the hook replaces it with the current one. A navigation to
 * another story that the flush's answer overtakes still reads that story.
 */
export function shouldRevalidate(args: ShouldRevalidateFunctionArgs) {
  const following = args.formAction === "/stories" && args.formData?.get("intent") === FOLLOW_FLUSH_INTENT;
  if (following && args.currentParams.storyId === args.nextParams.storyId) return false;
  return readAnotherPage(args);
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const now = new Date().toISOString();

  // Helper: touch the story's updated_at so the stories list reflects recent
  // edits. story_id is the per-project slug, NOT globally unique (the
  // loader fetches by project_id AND story_id). Scoping only by story_id would
  // bump updated_at on EVERY story sharing that slug across ALL projects,
  // corrupting the "recently edited" ordering of unrelated stories. The caller
  // passes the project id it already resolved for its membership check.
  function storyTouch(projectId: number) {
    return db
      .update(stories)
      .set({ updated_at: now })
      .where(
        and(
          eq(stories.story_id, params.storyId),
          eq(stories.project_id, projectId)
        )
      );
  }
  async function touchStory(projectId: number) {
    await storyTouch(projectId);
  }

  // Resolve the owning project for a layer via the layers → steps →
  // stories join, so save-layer / autosave-layer can gate on project
  // membership before any mutation. 400 for non-finite layerId, 404 for
  // unknown layerId.
  async function resolveLayerProjectId(layerId: number): Promise<number> {
    if (!Number.isFinite(layerId) || layerId <= 0) {
      throw new Response("Bad request", { status: 400 });
    }
    const rows = await db
      .select({ projectId: stories.project_id })
      .from(layers)
      .innerJoin(steps, eq(layers.step_id, steps.id))
      .innerJoin(stories, eq(steps.story_id, stories.id))
      .where(eq(layers.id, layerId))
      .limit(1);
    const row = rows[0];
    if (!row) throw new Response("Not found", { status: 404 });
    return row.projectId;
  }

  // Resolve the owning project for a step via the steps → stories join,
  // so capture-position / change-object can gate on project membership before
  // any mutation (mirrors resolveLayerProjectId). 400 for non-finite stepId,
  // 404 for unknown stepId. Without this, any authenticated user could mutate
  // any step's position or object by POSTing an arbitrary stepId (IDOR).
  async function resolveStepProjectId(stepId: number): Promise<number> {
    if (!Number.isFinite(stepId) || stepId <= 0) {
      throw new Response("Bad request", { status: 400 });
    }
    const rows = await db
      .select({ projectId: stories.project_id })
      .from(steps)
      .innerJoin(stories, eq(steps.story_id, stories.id))
      .where(eq(steps.id, stepId))
      .limit(1);
    const row = rows[0];
    if (!row) throw new Response("Not found", { status: 404 });
    return row.projectId;
  }

  // The page a step shows, for the non-collaborative path. The UPDATE is
  // conditioned on the object the chooser was opened over, so a page chosen for
  // one object can never land on a step that meanwhile shows another; no rows
  // updated is a conflict, and nothing — not even the story's timestamp — is
  // touched. No upper bound is checked here: this action loads no manifest, and
  // the framework clears a page the object does not have when it builds the
  // site.
  async function setStepPage(stepId: number, projectId: number) {
    const page = Number(formData.get("page"));
    if (!Number.isSafeInteger(page) || page < 1) {
      throw new Response("Bad request", { status: 400 });
    }
    const expectedObjectId = (formData.get("expectedObjectId") as string) ?? "";

    const result = (await db
      .update(steps)
      .set({ page: String(page), x: null, y: null, zoom: null, updated_at: now })
      .where(
        and(eq(steps.id, stepId), eq(steps.object_id, expectedObjectId))
      )) as unknown as { meta?: { changes?: number } } | undefined;

    if ((result?.meta?.changes ?? 0) === 0) {
      throw new Response("Conflict", { status: 409 });
    }

    await touchStory(projectId);
  }

  // The viewport a step shows it at, for the non-collaborative path. A viewport
  // describes one object on one of its pages, so the UPDATE is conditioned on
  // the object it was read from: a peer's replacement makes it no rows, a
  // conflict, and nothing — not even the story's timestamp — is touched.
  async function captureStepPosition(stepId: number, projectId: number) {
    const x = parseFloat(formData.get("x") as string);
    const y = parseFloat(formData.get("y") as string);
    const zoom = parseFloat(formData.get("zoom") as string);
    const page = (formData.get("page") as string) || null;
    const capturedFrom = (formData.get("expectedObjectId") as string) ?? "";

    const result = (await db
      .update(steps)
      .set({ x, y, zoom, page, updated_at: now })
      .where(
        and(eq(steps.id, stepId), eq(steps.object_id, capturedFrom))
      )) as unknown as { meta?: { changes?: number } } | undefined;

    if ((result?.meta?.changes ?? 0) === 0) {
      throw new Response("Conflict", { status: 409 });
    }

    await touchStory(projectId);
  }

  // A step's text from a field in place, for the non-collaborative path. A
  // refusal is answered, not thrown, so the field keeps its draft and says the
  // save failed rather than the route giving way to its error card. The step
  // and the story's timestamp are written in one batch, so ok: false always
  // means nothing was written.
  async function saveStepText(userId: number) {
    const nonce = (formData.get("nonce") as string | null) ?? undefined;
    const intent = "save-step-field";
    const field = formData.get("field") as string;
    if (!STEP_TEXT_FIELDS.has(field)) return data({ ok: false, intent, reason: "bad-request", nonce }, { status: 400 });
    try {
      const stepId = Number(formData.get("stepId"));
      const projectId = await resolveStepProjectId(stepId);
      await requireProjectMember(db, projectId, userId);
      const value = (formData.get("value") as string) ?? "";
      await db.batch([
        db.update(steps).set({ [field]: value, updated_at: now }).where(eq(steps.id, stepId)),
        storyTouch(projectId),
      ]);
      return { ok: true, intent, nonce };
    } catch (error) {
      const { status, reason } = saveRefusalOf(error);
      return data({ ok: false, intent, reason, nonce }, { status });
    }
  }

  // A layer's text, for the non-collaborative path: `save-layer` writes the
  // content and button label together, `autosave-layer` one field. A refusal
  // (the layer is gone, or the author is not a member of its project) is
  // answered, not thrown, so the field's save fails and the editor stays open
  // rather than the route giving way to its error card. Nothing is written.
  async function saveLayer(intent: "save-layer" | "autosave-layer", userId: number) {
    const nonce = (formData.get("nonce") as string | null) ?? undefined;
    try {
      const layerId = Number(formData.get("layerId"));
      const projectId = await resolveLayerProjectId(layerId);
      await requireProjectMember(db, projectId, userId);
      const updateData: Record<string, unknown> = { updated_at: now };
      if (intent === "save-layer") {
        updateData.content = (formData.get("content") as string) ?? "";
        updateData.button_label = (formData.get("buttonLabel") as string) || null;
      } else {
        const field = formData.get("field") as string;
        const value = (formData.get("value") as string) ?? "";
        if (field === "content") updateData.content = value;
        if (field === "title") updateData.title = value;
        if (field === "button_label") updateData.button_label = value;
      }
      // One batch, so the layer and the story's timestamp commit together or
      // not at all: an answer of ok: false always means nothing was written.
      await db.batch([
        db.update(layers).set(updateData).where(eq(layers.id, layerId)),
        storyTouch(projectId),
      ]);
      return { ok: true, intent, nonce };
    } catch (error) {
      const { status, reason } = saveRefusalOf(error);
      return data({ ok: false, intent, reason, nonce }, { status });
    }
  }

  switch (intent) {
    // The membership gate, then one of the conditional writes above.
    case "capture-position": {
      const stepId = Number(formData.get("stepId"));
      const projectId = await resolveStepProjectId(stepId);
      await requireProjectMember(db, projectId, user.id);
      await captureStepPosition(stepId, projectId);
      return { ok: true, intent: "capture-position" };
    }

    case "change-object": {
      const stepId = Number(formData.get("stepId"));
      // Gate on project membership before mutating the step.
      const projectId = await resolveStepProjectId(stepId);
      await requireProjectMember(db, projectId, user.id);
      const objectId = formData.get("objectId") as string;

      await db
        .update(steps)
        .set({ object_id: objectId, updated_at: now })
        .where(eq(steps.id, stepId));
      await touchStory(projectId);

      return { ok: true, intent: "change-object" };
    }

    // The membership gate, then the other one.
    case "set-page": {
      const stepId = Number(formData.get("stepId"));
      const projectId = await resolveStepProjectId(stepId);
      await requireProjectMember(db, projectId, user.id);
      await setStepPage(stepId, projectId);
      return { ok: true, intent: "set-page" };
    }

    // Structural ops (add-step, delete-step, reorder-steps, create-layer,
    // delete-layer) migrated to Yjs via useStructuralOps — snapshotToD1
    // reconciles Y.Array state back to D1 every 30 seconds and on disconnect.

    // A refusal is answered, not thrown: see saveLayer.
    case "save-layer":
    case "autosave-layer":
      return saveLayer(intent, user.id);

    // A refusal is answered, not thrown: see saveStepText.
    case "save-step-field":
      return saveStepText(user.id);

    default:
      return { error: "Unknown intent" };
  }
}

// ---------------------------------------------------------------------------
// Helper: resolve IIIF URLs for an object
// ---------------------------------------------------------------------------

/** The viewer's addresses for the object the site shows for a step's `object` value. */
function resolveIiifUrls(
  objectId: string | null,
  objectsWithSource: Array<{ object_id: string; source_url: string | null }>,
  siteBaseUrl: string | null,
  frameworkVersion: string | null,
): { manifestUrl: string | null; infoJsonUrl: string | null; isSelfHosted: boolean } {
  return iiifUrlsFor(resolveStepObject(objectsWithSource, objectId, frameworkVersion), siteBaseUrl, frameworkVersion);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Shape of a step as surfaced to the sidebar and narrative column. When the
 * Y.Array is in play, `_tempId` and `_createdBy` are filled from the Y.Map
 * sentinels; legacy D1 rows leave them `null`.
 */
interface EditorStep {
  id: number;
  step_number: number;
  kind: "media" | "section";
  question: string | null;
  answer: string | null;
  alt_text: string | null;
  object_id: string | null;
  x: number | null;
  y: number | null;
  zoom: number | null;
  page: string | null;
  clip_start: string | null;
  clip_end: string | null;
  loop: string | null;
  /** The step's kept cells as stored, which decide whether publish writes it. */
  extra_columns: string | null;
  _tempId: string | null;
  _createdBy: number | null;
  _yMap: Y.Map<unknown> | null;
  _yLayerCount: number;
  // Position within the observed Y.Array, used only as the last-resort key
  // for a step that somehow carries neither a D1 id nor a `_tempId`, and as
  // the tie-break that keeps the order_key sort total.
  _yIndex?: number;
  /** Fractional index the list sorts by; null on a doc awaiting the backfill. */
  _orderKey?: string | null;
}

interface EditorLayer {
  id: number;
  step_id: number;
  layer_number: number;
  title: string | null;
  button_label: string | null;
  content: string | null;
  _tempId: string | null;
  _createdBy: number | null;
  _yMap: Y.Map<unknown> | null;
  /** Present while the layer is held in the editor until its first content. */
  writeUnsaved?: (field: PendingLayerField, value: string) => void;
}

interface EditorMember {
  userId: number;
  name: string;
  contributions: {
    stories_edited?: number[];
    objects_edited?: number[];
  } | null;
}

function readScalarText(yMap: Y.Map<unknown>, key: string): string | null {
  const val = yMap.get(key);
  if (val === null || val === undefined) return null;
  if (val instanceof Y.Text) {
    const s = val.toString();
    return s.length === 0 ? null : s;
  }
  return typeof val === "string" ? (val.length === 0 ? null : val) : null;
}

/**
 * Which entries of the steps array the sidebar shows, and therefore which ones
 * the editor's one-based step numbering counts. Re-exported from the module
 * that owns it, because a write resolved at write time must count the live
 * array by exactly the rule the render counted it by, and both need one
 * definition to share.
 */

function stepFromYMap(s: Y.Map<unknown>, index: number): EditorStep {
  const layersArr = s.get("layers");
  return {
    id: (s.get("_id") as number | null) ?? 0,
    step_number: (s.get("step_number") as number) ?? 0,
    // Every step Y.Map carries an explicit kind after hydration;
    // ?? 'media' guards against legacy Y.Maps from before that field existed.
    kind: ((s.get("kind") as string | undefined) ?? "media") as "media" | "section",
    question: readScalarText(s, "question"),
    answer: readScalarText(s, "answer"),
    alt_text: readScalarText(s, "alt_text"),
    object_id: (s.get("object_id") as string | null) ?? null,
    x: (s.get("x") as number | null) ?? null,
    y: (s.get("y") as number | null) ?? null,
    zoom: (s.get("zoom") as number | null) ?? null,
    page: (s.get("page") as string | null) ?? null,
    clip_start: (s.get("clip_start") as string | null) ?? null,
    clip_end: (s.get("clip_end") as string | null) ?? null,
    loop: (s.get("loop") as string | null) ?? null,
    extra_columns: readScalarText(s, "extra_columns"),
    _tempId: (s.get("_temp_id") as string | null) ?? null,
    _createdBy: (s.get("created_by") as number | null) ?? null,
    _yMap: s,
    _yLayerCount:
      layersArr instanceof Y.Array ? (layersArr as Y.Array<unknown>).length : 0,
    _yIndex: index,
    _orderKey: readOrderKey(s),
  };
}

/**
 * The title and text of each of a step's layers: from its layers Y.Array in
 * Yjs mode, else from the loader's flat layer list.
 */
function stepLayerTexts(
  step: EditorStep,
  loaderLayers: ReadonlyArray<{ step_id: number; title: string | null; content: string | null }>,
): Array<{ title: string | null; content: string | null }> {
  const layersArr = step._yMap?.get("layers");
  if (step._yMap && layersArr instanceof Y.Array) {
    return (layersArr as Y.Array<Y.Map<unknown>>).toArray().map((m) => ({
      title: readScalarText(m, "title"),
      content: readScalarText(m, "content"),
    }));
  }
  return loaderLayers.filter((l) => l.step_id === step.id).map((l) => ({ title: l.title, content: l.content }));
}

function layerFromYMap(yMap: Y.Map<unknown>, parentStepId: number): EditorLayer {
  return {
    id: (yMap.get("_id") as number | null) ?? 0,
    step_id: parentStepId,
    layer_number: (yMap.get("layer_number") as number) ?? 1,
    title: readScalarText(yMap, "title"),
    button_label: readScalarText(yMap, "button_label"),
    content: readScalarText(yMap, "content"),
    _tempId: (yMap.get("_temp_id") as string | null) ?? null,
    _createdBy: (yMap.get("created_by") as number | null) ?? null,
    _yMap: yMap,
  };
}

/** The step whose new panels are held in the editor: the selected one, in Yjs mode. */
function heldStepKey(useYjs: boolean, step: EditorStep | null): string | null {
  return useYjs && step?._yMap ? keyFor(step) : null;
}

/** A step by its key, where it has a map in the document. */
function stepByKey(steps: EditorStep[], key: string | null): EditorStep | undefined {
  return steps.find((s) => s._yMap && keyFor(s) === key);
}

/** The panel numbers a step has in the document, read from its own map. */
function layerNumbersOfStep(step: EditorStep | undefined): number[] {
  const layers = step?._yMap?.get("layers");
  return layers instanceof Y.Array ? (layers as Y.Array<Y.Map<unknown>>).map((m) => m.get("layer_number") as number) : [];
}

/** The held panels as the editor's layers, each writing to its held panel. */
function heldEditorLayers(held: ReturnType<typeof usePendingLayers>, step: EditorStep | null): EditorLayer[] {
  return held.layers.map((layer) => ({
    ...layer,
    id: 0,
    step_id: step?.id ?? 0,
    _tempId: layer.tempId,
    _createdBy: null,
    _yMap: null,
    writeUnsaved: (field: PendingLayerField, value: string) => held.write(layer.layer_number, field, value),
  }));
}

/**
 * Compute contributor names for a step's delete-confirmation modal.
 * Uses contribution data (stories_edited per member) — the step belongs
 * to a story, so any member who has edited this story counts.
 */
function computeStepContributors(
  storyDbId: number,
  stepCreatorId: number | null,
  currentUserId: number,
  members: EditorMember[]
): string[] {
  const names = new Set<string>();
  if (storyDbId > 0) {
    for (const m of members) {
      if (m.userId === currentUserId) continue;
      if ((m.contributions?.stories_edited ?? []).includes(storyDbId)) {
        names.add(m.name);
      }
    }
  }
  if (stepCreatorId && stepCreatorId !== currentUserId) {
    const creator = members.find((m) => m.userId === stepCreatorId);
    if (creator) names.add(creator.name);
  }
  return Array.from(names);
}

/** Whoever may delete the story may change its ID; nobody can before the document loads. */
function mayRenameStory(storyYMap: Y.Map<unknown> | null, ops: ReturnType<typeof useStructuralOps>): boolean {
  return storyYMap !== null && ops !== null && ops.canDelete(storyYMap);
}

export default function StoryEditorPage({ loaderData }: Route.ComponentProps) {
  const {
    story,
    steps: storySteps,
    layers: storyLayers,
    objects: loaderObjects,
    siteBaseUrl,
    frameworkVersion,
    siteLang,
    panelPreview,
    glossaryKinds,
    repoFullName,
    members,
    currentUserId,
    userRole,
  } = loaderData;
  const readStamp = "readStamp" in loaderData ? loaderData.readStamp : undefined;
  const { t } = useTranslation("editor");
  const { t: tStructural } = useTranslation("structural");
  const { openDoc } = useOutletContext<{ openDoc?: (id: string) => void }>() ?? {};
  const { ydoc, provider, remoteCollaborators, undoManager, isPublishing } = useCollaborationContext();
  const setAwarenessLocation = useSetAwarenessLocation();
  const ops = useStructuralOps(currentUserId, userRole);
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Broadcast storyId to awareness so story card badges and header tooltips
  // can show which story this collaborator is editing.
  useEffect(() => {
    setAwarenessLocation({
      route: `/stories/${story.story_id}`,
      storyId: story.story_id,
      fieldKey: null,
    });
    return () => {
      // On teardown the component is unmounting (or the story changed),
      // so clear the awareness location entirely. The previous code read
      // `location.pathname` from the global `window.location` (no react-router
      // `location` was in scope) — undefined on SSR/worker render, and in the
      // browser it reflected the already-navigated URL, recording a wrong route.
      setAwarenessLocation({
        route: null,
        storyId: null,
        fieldKey: null,
      });
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story.story_id]);

  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [deletingStepD1, setDeletingStepD1] = useState<{
    id: number;
    step_number: number;
    question: string | null;
  } | null>(null);
  const [deletingStepYjs, setDeletingStepYjs] = useState<EditorStep | null>(
    null
  );
  const [deletingLayer, setDeletingLayer] = useState<EditorLayer | null>(null);

  // The selected step's open layer panels (layer 2 stacked over layer 1),
  // who opened them, and the `?layer` the URL mirrors.
  const panelState = useLayerPanels(setSearchParams);

  const captureFetcher = useFetcher();
  const changeObjectFetcher = useFetcher();
  const setPageFetcher = useFetcher();
  // clipFetcher removed — clip/loop values flow through the Y.Doc only;
  // there is no "autosave-step-field" action handler, so the prior fallback
  // POST silently failed. The no-ydoc edge now warns instead (see
  // handleCaptureClip / handleToggleLoop).

  // ---------------------------------------------------------------------------
  // Y.Array-backed step state
  // ---------------------------------------------------------------------------
  const storiesArray = ydoc?.getArray<Y.Map<unknown>>("stories") ?? null;
  const storyYMap = storiesArray ? findYMapById(storiesArray, story.id) : null;
  useFollowStoryId(storyYMap, story.story_id);
  const stepsArray: Y.Array<Y.Map<unknown>> | null =
    storyYMap && storyYMap.get("steps") instanceof Y.Array
      ? (storyYMap.get("steps") as Y.Array<Y.Map<unknown>>)
      : null;

  // A step's place is its order_key, not its Y.Array position, so the list is
  // sorted here rather than read off the array. The tie-break on `_yIndex`
  // keeps the sort total and stable for a document whose keys the server-side
  // backfill has not reached yet (it degenerates to array order, which is what
  // such a document always presented).
  const yjsStepsUnsorted = useYjsArraySync(stepsArray, stepFromYMap);
  const yjsSteps = useMemo(
    () => (yjsStepsUnsorted === null ? null : [...yjsStepsUnsorted].sort(compareByOrderKey)),
    [yjsStepsUnsorted],
  );

  const useYjs = ydoc !== null && ops !== null && yjsSteps !== null;

  // The loader's objects are a snapshot from when the editor opened; the
  // document carries the ones added since, by this user or a collaborator.
  const docObjects = useYjsArraySync(
    ydoc ? ydoc.getArray<Y.Map<unknown>>("objects") : null,
    editorObjectFromYMap,
  );
  const docSynced = useProviderSynced(provider, { giveUpMs: 8000 }) === "synced";
  const projectObjects = useMemo(
    () => liveEditorObjects(loaderObjects, docObjects, docSynced),
    [loaderObjects, docObjects, docSynced],
  );

  // activeStepIndex 0 = title card; 1+ = sidebarSteps[activeStepIndex - 1].
  // In D1 fallback, step_number > 0 filters the title card (step 0). In Yjs
  // mode, step 0 is not stored in the Y.Array — we include all entries
  // returned by the observer.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sidebarSteps: EditorStep[] = useYjs
    ? yjsSteps!.filter(isSidebarStep)
    : storySteps
        .filter((s) => s.step_number > 0)
        .map((s) => ({
          ...s,
          _tempId: null,
          _createdBy: null,
          _yMap: null,
          _yLayerCount: 0,
        }));

  const activeStep =
    activeStepIndex > 0 ? sidebarSteps[activeStepIndex - 1] ?? null : null;

  // Active step's layers — Y.Array-backed when available, loader fallback otherwise.
  const activeStepLayersArray: Y.Array<Y.Map<unknown>> | null =
    activeStep?._yMap && activeStep._yMap.get("layers") instanceof Y.Array
      ? (activeStep._yMap.get("layers") as Y.Array<Y.Map<unknown>>)
      : null;
  const [yjsLayers, setYjsLayers] = useState<EditorLayer[] | null>(null);
  useEffect(() => {
    if (!activeStepLayersArray || !activeStep) {
      setYjsLayers(null);
      return;
    }
    const arr = activeStepLayersArray;
    const parentId = activeStep.id;
    const recompute = () => {
      // order_key order, not array order — layers carry their own place now.
      setYjsLayers(orderedMaps(arr).map((m) => layerFromYMap(m, parentId)));
    };
    recompute();
    arr.observeDeep(recompute);
    return () => arr.unobserveDeep(recompute);
  }, [activeStepLayersArray, activeStep]);

  const savedLayers: EditorLayer[] = useYjs && yjsLayers
    ? yjsLayers
    : activeStep
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? (storyLayers as any[])
        .filter((l) => l.step_id === activeStep.id)
        .map((l) => ({
          id: l.id as number,
          step_id: l.step_id as number,
          layer_number: l.layer_number as number,
          title: l.title as string | null,
          button_label: l.button_label as string | null,
          content: l.content as string | null,
          _tempId: null,
          _createdBy: null,
          _yMap: null,
        }))
    : [];

  // A panel added and not yet written to: this author's alone until its first
  // content writes it, with the text held so far, as its own undo step, apart
  // from the edits before and after it. While a publish holds the document,
  // writes stay held and are written to their own step when it ends.
  const heldLayers = usePendingLayers(
    heldStepKey(useYjs, activeStep),
    (key) => (key === null ? savedLayers.map((l) => l.layer_number) : layerNumbersOfStep(stepByKey(sidebarSteps, key))),
    (held, stepKey) => {
      const step = stepByKey(sidebarSteps, stepKey);
      undoManager?.stopCapturing();
      const added = !!step?._yMap && !!ops?.addLayer(step._yMap, held.layer_number, held.button_label, held);
      undoManager?.stopCapturing();
      return added;
    },
    isPublishing,
  );
  const activeLayers: EditorLayer[] = [...savedLayers, ...heldEditorLayers(heldLayers, activeStep)];

  const isStepZero = activeStepIndex === 0;
  const isSectionCard = !isStepZero && activeStep?.kind === "section";
  const totalSteps = sidebarSteps.length;

  // Per-step layer summaries for the step line's layer branches, each named
  // by its title, else its button label.
  // Computed here (plain data) so SortableStepItem never reads `_yMap`. Keyed by
  // the shared tempId-first `keyFor` so these summaries land on the same sidebar
  // rows the highlight, capture, and delete paths already key with — and stay
  // put across the snapshotToD1 id backfill.
  // In Yjs mode every step Y.Map carries a `layers` Y.Array; in the D1 fallback
  // the flat `storyLayers` list is grouped by step_id. Reactive because it
  // derives from sidebarSteps (recomputed by the stepsArray observeDeep) and
  // storyLayers.
  const layersByStep = useMemo<Record<string, SidebarLayerSummary[]>>(() => {
    const map: Record<string, SidebarLayerSummary[]> = {};
    for (const s of sidebarSteps) {
      if (s.kind === "section") continue;
      const key = keyFor(s);
      let summaries: SidebarLayerSummary[] = [];
      const layersArr = s._yMap?.get("layers");
      if (s._yMap && layersArr instanceof Y.Array) {
        const arr = layersArr as Y.Array<Y.Map<unknown>>;
        summaries = [];
        for (let i = 0; i < arr.length; i++) {
          const l = layerFromYMap(arr.get(i), s.id);
          summaries.push({
            layer_number: l.layer_number,
            title: l.title,
            button_label: l.button_label,
          });
        }
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        summaries = (storyLayers as any[])
          .filter((l) => l.step_id === s.id)
          .map((l) => ({
            layer_number: l.layer_number as number,
            title: (l.title as string | null) ?? null,
            button_label: (l.button_label as string | null) ?? null,
          }));
      }
      if (summaries.length > 0) map[key] = summaries;
    }
    return map;
  }, [sidebarSteps, storyLayers]);

  // Each step with the fields that decide whether publish writes it, which
  // the scene of the active step is grouped over (`sceneRun`).
  const sceneInputs = useMemo(
    () =>
      sidebarSteps.map((step) => ({
        step,
        kind: step.kind,
        object_id: step.object_id,
        question: step.question,
        answer: step.answer,
        extra_columns: step.extra_columns,
        layers: stepLayerTexts(step, storyLayers),
      })),
    [sidebarSteps, storyLayers],
  );

  // ---------------------------------------------------------------------------
  // Deep-link: ?step=N&layer=M mount-time read.
  //
  // MINIMAL ADDITIVE read — NOT a refactor of the activeStepIndex navigation
  // model. The glossary "Used in" jump (UsedInPanel) navigates here with
  // ?step=N (1-based, mapping directly to activeStepIndex; 0 = title card) and
  // optional ?layer=M (1 | 2). We consume the params ONCE, the first time the
  // sidebar steps are available, then let component state own navigation so the
  // read never fights normal in-editor clicks. Forward-compatible with
  // the ?step=N&layer=M deep-link contract.
  //
  // Tampering guard: step/layer are parsed as integers and bounds-checked
  // against the actual step count and the layer set {1,2}. An out-of-range or
  // non-numeric param is ignored (falls back to the title card / no layer),
  // never throws or indexes out of bounds.
  const deepLinkConsumedRef = useRef(false);
  // The glossary jump's highlight, asked of the linked layer's panel, which
  // highlights its first glossary link once it has rendered and says so.
  const [glossaryHighlight, setGlossaryHighlight] = useState<{ id: number; layerNumber: 1 | 2 } | null>(null);
  useEffect(() => {
    if (deepLinkConsumedRef.current) return;
    // Wait until the sidebar steps are actually available — in Yjs mode they
    // load asynchronously, so consuming the param before then would bounds-check
    // against an empty list and silently drop a valid deep link.
    if (totalSteps === 0) return;

    deepLinkConsumedRef.current = true;

    const rawStep = searchParams.get("step");
    if (rawStep === null) return;

    const parsedStep = Number.parseInt(rawStep, 10);
    // Valid range: 1..totalSteps. 0 / negative / non-numeric / out-of-range are
    // ignored (the title card stays active). String(parsedStep) === rawStep
    // rejects values like "1.5" or "1abc" that parseInt would otherwise coerce.
    if (
      !Number.isInteger(parsedStep) ||
      String(parsedStep) !== rawStep.trim() ||
      parsedStep < 1 ||
      parsedStep > totalSteps
    ) {
      return;
    }

    setActiveStepIndex(parsedStep);

    // Optional ?layer=M — open layer 1 or 2 so the [[term]] occurrence is
    // visible, and ask that panel to highlight its first glossary link: the
    // link carries the step and layer, not the term.
    const rawLayer = searchParams.get("layer");
    const parsedLayer = rawLayer === null ? null : Number.parseInt(rawLayer, 10);
    const validLayer =
      parsedLayer === 1 || parsedLayer === 2 ? parsedLayer : null;
    if (validLayer !== null) {
      panelState.openFromLink(validLayer);
      setGlossaryHighlight({ id: Date.now(), layerNumber: validLayer });
    }
  }, [totalSteps, searchParams]);

  // Section-card count drives the helper-text visibility on the title-card
  // show_sections toggle; the intro lists what the published intro lists.
  const sectionCardCount = sidebarSteps.filter((s) => s.kind === "section").length;
  const sectionTitles = introSectionTitles(sceneInputs, projectObjects, frameworkVersion);

  // ---------------------------------------------------------------------------
  // show_sections toggle state — Y.Map source of truth in collaborative mode,
  // loader fallback otherwise. Subscribe to storyYMap so a remote peer's
  // toggle change re-renders the title card immediately.
  // ---------------------------------------------------------------------------
  const [showSectionsYjsValue, setShowSectionsYjsValue] = useState<boolean>(() =>
    storyYMap ? Boolean(storyYMap.get("show_sections")) : Boolean(story?.show_sections ?? false),
  );
  useEffect(() => {
    if (!useYjs || !storyYMap) return;
    const recompute = () => setShowSectionsYjsValue(Boolean(storyYMap.get("show_sections")));
    recompute();
    storyYMap.observe(recompute);
    return () => storyYMap.unobserve(recompute);
  }, [useYjs, storyYMap]);
  const showSectionsValue = useYjs && storyYMap
    ? showSectionsYjsValue
    : Boolean(story?.show_sections ?? false);

  // ---------------------------------------------------------------------------
  // Remote-delete detection for steps and parent story
  // ---------------------------------------------------------------------------
  const prevStepKeysRef = useRef<Set<string>>(new Set());

  // The key of the step the user is actually viewing, captured when the
  // SELECTION changes rather than re-derived from the current list on every
  // render. This distinction is the whole fix for detecting a remote delete of
  // the active step: `activeStep` is `sidebarSteps[activeStepIndex - 1]`, so the
  // same render that shrinks `sidebarSteps` when a step vanishes also re-points
  // `activeStep` at whichever step slid into that index. If we read the active
  // key off that survivor, the deleted step's key is never equal to it and the
  // toast can't fire. Freezing the key at selection time keeps the key of the
  // step that was genuinely active, so it still matches the deleted key when the
  // diff below runs. Keyed with the shared tempId-first `keyFor` so the capture
  // survives the snapshotToD1 id backfill (id 0 -> real id) — a backfill leaves
  // the key unchanged and is never mistaken for a deletion.
  const activeStepKeyRef = useRef<string | null>(null);
  const capturedKeyIndexRef = useRef<number | null>(null);
  useEffect(() => {
    // Re-capture only when the user's selection (the index) moves, or when we
    // don't yet hold a key for the current selection — the latter covers the
    // deep-link mount and the async Y.Array populate, where the index is set
    // before the step list has hydrated. We deliberately do NOT re-capture
    // merely because the list changed under a stable index; that is exactly the
    // deletion (or backfill) render that must not overwrite the captured key.
    const indexMoved = capturedKeyIndexRef.current !== activeStepIndex;
    const missingKey = activeStepKeyRef.current === null && activeStep !== null;
    if (indexMoved || missingKey) {
      activeStepKeyRef.current = activeStep ? keyFor(activeStep) : null;
      capturedKeyIndexRef.current = activeStepIndex;
    }
  }, [activeStepIndex, activeStep]);

  // The remote-delete effect below has deps [sidebarSteps, useYjs]
  // (exhaustive-deps disabled) but reads activeStepIndex for the toast's step
  // number. Reading it directly would capture a stale closure and the toast
  // could show the wrong step number, so mirror it into a ref written during
  // render and let the effect read the current value.
  const activeStepIndexRef = useRef(activeStepIndex);
  activeStepIndexRef.current = activeStepIndex;

  useEffect(() => {
    if (!useYjs) return;
    // Key with the shared tempId-first `keyFor` so this set agrees with the
    // captured active key above and stays stable across the id backfill.
    const curr = new Set<string>();
    for (const s of sidebarSteps) {
      curr.add(keyFor(s));
    }
    const deletedKeys: string[] = [];
    prevStepKeysRef.current.forEach((k) => {
      if (!curr.has(k)) deletedKeys.push(k);
    });
    prevStepKeysRef.current = curr;
    if (deletedKeys.length === 0) return;

    // If the active step was deleted, toast + reset to title card. `activeKey`
    // was frozen at selection time, so it still holds the deleted step's key
    // even though `activeStep` has already re-pointed at a survivor.
    const activeKey = activeStepKeyRef.current;
    if (activeKey && deletedKeys.includes(activeKey)) {
      const stepLabel = tStructural("entity_step", {
        number: activeStepIndexRef.current,
      });
      // Stay generic: a Y.Array delete carries no actor, and awareness only
      // tells us who is connected — not who deleted. Naming a collaborator here
      // would misattribute the action. No undo affordance either: a remote
      // delete has no local undo path — the shared UndoManager tracks only
      // local origins, so a collaborator's delete never enters this client's
      // undo stack — and a button wired to it would be a no-op, so omit it
      // rather than show dead UI.
      showToast({
        message: tStructural("toast_item_deleted_generic", { label: stepLabel }),
        type: "destructive",
      });
      setActiveStepIndex(0);
      panelState.closeAll();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarSteps, useYjs]);

  // Parent-story delete detection — when the current story is removed from
  // the stories Y.Array, redirect to /stories with a toast.
  useEffect(() => {
    if (!useYjs || !storiesArray) return;
    const handler = () => {
      // story.id is the loader-provided real D1 id (the route can't load
      // without a persisted story row), so this lookup key never flips under
      // the snapshotToD1 id-backfill — there is no false-deletion risk here.
      const gone = findYMapById(storiesArray, story.id) === null;
      if (gone) {
        // Stay generic: a Y.Array delete carries no actor, and awareness only
        // tells us who is connected — not who deleted. Naming a collaborator
        // here would misattribute the action.
        const label = story.title ?? story.story_id;
        showToast({
          message: tStructural("toast_item_deleted_generic", { label }),
          type: "destructive",
        });
        navigate("/stories");
      }
    };
    storiesArray.observe(handler);
    return () => storiesArray.unobserve(handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useYjs, storiesArray, story.id]);

  // For step 0, show step 1's object in the viewer (Telar convention)
  const viewerStep = isStepZero ? (sidebarSteps[0] ?? null) : activeStep;
  const viewerObjectId = viewerStep?.object_id ?? null;

  const selectionKey = selectionKeyFor(activeStep, isStepZero);

  const { manifestUrl, infoJsonUrl, isSelfHosted } = resolveIiifUrls(
    viewerObjectId,
    projectObjects,
    siteBaseUrl,
    frameworkVersion
  );

  // Strip source_url from objects before passing to picker (not needed by ObjectPickerDialog)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pickerObjects = (projectObjects as any[]).map((o) => ({
    object_id: o.object_id as string,
    title: o.title as string | null,
    thumbnail: o.thumbnail as string | null,
    image_available: o.image_available as boolean | null,
  }));

  // ViewerObjects includes source_url so ViewerColumn can detect media type
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const viewerObjects = (projectObjects as any[]).map((o) => ({
    object_id: o.object_id as string,
    title: o.title as string | null,
    thumbnail: o.thumbnail as string | null,
    image_available: o.image_available as boolean | null,
    source_url: o.source_url as string | null,
    alt_text: o.alt_text as string | null,
  }));

  // Media type per step `object` value for StepSidebar badges: the type of
  // the object the site shows for that value.
  const objectsByType = mediaTypesByStepValue(sidebarSteps, projectObjects, frameworkVersion);

  // ---------------------------------------------------------------------------
  // Resolve Y.Text instances for story title/subtitle/byline and active step fields
  // (storyYMap and stepsArray declared above for Y.Array observation).
  // ---------------------------------------------------------------------------

  const titleYText = getYText(storyYMap, "title");
  const subtitleYText = getYText(storyYMap, "subtitle");
  const bylineYText = getYText(storyYMap, "byline");

  // Step-level Y.Text (for the step card — resolved from the active step's Y.Map)
  const activeStepYMap = activeStep?._yMap ?? null;
  const questionYText = getYText(activeStepYMap, "question");
  const answerYText = getYText(activeStepYMap, "answer");
  const altTextYText = getYText(activeStepYMap, "alt_text");

  // ---------------------------------------------------------------------------
  // Highlight / fade state for steps
  // ---------------------------------------------------------------------------
  const seenStepKeysRef = useRef<Set<string>>(new Set());
  const [highlightedStepKeys, setHighlightedStepKeys] = useState<
    Record<string, string>
  >({});
  const [fadingStepKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!useYjs) return;
    const next = new Set<string>();
    const newly: string[] = [];
    for (const s of sidebarSteps) {
      // Shared tempId-first key: a freshly-created step keeps the same key when
      // snapshotToD1 backfills its real id, so the backfill render is never
      // mistaken for a newly-arrived step and can't fire a false highlight.
      const k = keyFor(s);
      next.add(k);
      if (!seenStepKeysRef.current.has(k)) newly.push(k);
    }
    if (seenStepKeysRef.current.size === 0) {
      seenStepKeysRef.current = next;
      return;
    }
    seenStepKeysRef.current = next;
    if (newly.length === 0) return;
    const colour =
      remoteCollaborators[0]?.user.color ?? FALLBACK_HIGHLIGHT_COLOR;
    setHighlightedStepKeys((prev) => {
      const merged = { ...prev };
      for (const k of newly) merged[k] = colour;
      return merged;
    });
    const timer = setTimeout(() => {
      setHighlightedStepKeys((prev) => {
        const updated = { ...prev };
        for (const k of newly) delete updated[k];
        return updated;
      });
    }, 1500);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarSteps, useYjs]);

  // ---------------------------------------------------------------------------
  // Handlers — Yjs-first, D1 fetcher preserved for capture/change/clip/autosave
  // ---------------------------------------------------------------------------

  /** The source key a step's object resolves to right now. */
  function sourceKeyForObject(objectId: string | null): string {
    const urls = resolveIiifUrls(objectId, projectObjects, siteBaseUrl, frameworkVersion);
    return sourceKeyFor(urls.manifestUrl, urls.infoJsonUrl);
  }

  /**
   * The step-selection sequence a newly-added step goes through: the index,
   * both layer panels closed, the URL mirror — the writes the sidebar's own
   * `onStepSelect` handler performs. The capture baseline belongs to the write
   * hook, which clears it alongside this.
   */
  function selectStep(index: number) {
    selectStepIn(
      { setActiveStepIndex, closePanels: panelState.closeAll, setSearchParams },
      index
    );
  }

  // The writes that must land on one particular step — the seeded addition, the
  // object change, the page choice, the capture and its undo — with the capture
  // baseline they share. The route calls the handlers this returns; they are not
  // reimplemented here, so what the editor runs is what the hook's tests mount.
  const {
    captureUndoNonce,
    clearCaptureUndo,
    pendingNewStep,
    handleNewStepConsumed,
    handleAddStep,
    handleCapturePosition,
    handleUndoCapture,
    handleChangeObject,
    handleChoosePage,
  } = useStepPageWrites({
    useYjs,
    ydoc,
    ops,
    storyYMap,
    stepsArray,
    sidebarSteps,
    activeStep,
    activeStepIndex,
    isStepZero,
    selectionKey,
    sourceKeyForObject,
    onSelectStep: selectStep,
    submitCapture: (fields) => captureFetcher.submit(fields, { method: "post" }),
    submitChangeObject: (fields) =>
      changeObjectFetcher.submit(fields, { method: "post" }),
    submitSetPage: (fields) => setPageFetcher.submit(fields, { method: "post" }),
  });
  // A capture, object change or page choice sent without a live document that
  // came back failed is reported by the viewer column, on the step it targeted.
  const stageWriteFailures = useStageWriteFailure(
    { capture: captureFetcher, object: changeObjectFetcher, page: setPageFetcher },
    selectionKey,
  );

  // The same shape as the seeded addition in the write hook: the same ydoc
  // gate and the same log-on-missing-ydoc behaviour. A section card inherits
  // nothing, so it needs neither a seed nor a selection.
  function handleAddSectionCard() {
    if (useYjs && storyYMap) {
      ops!.addSectionCard(storyYMap);
      return;
    }
    // eslint-disable-next-line no-console
    console.warn("[story-editor] add-section-card without active ydoc; ignored");
  }

  // Per-story show_sections toggle. Mirrors the existing
  // storyYMap.set("draft", ...) / storyYMap.set("private", ...) patterns
  // in app/routes/_app.stories.tsx — Y.Doc is the source of truth, snapshotToD1
  // reconciles the boolean back to D1.
  function handleToggleShowSections(value: boolean) {
    if (useYjs && storyYMap && ydoc) {
      ydoc.transact(() => {
        storyYMap.set("show_sections", value);
      });
      return;
    }
    // eslint-disable-next-line no-console
    console.warn("[story-editor] toggle-show-sections without active ydoc; ignored");
  }

  // Every story's ID in the document, which a new ID must not repeat.
  const documentStoryIds = (): string[] =>
    (storiesArray?.toArray() ?? []).flatMap((m) => {
      const id = m instanceof Y.Map ? m.get("story_id") : null;
      return typeof id === "string" ? [id] : [];
    });

  // A story's ID is renamed in place, as the glossary renames a term's ID;
  // the snapshot writes it to D1 and the next publish writes the story's
  // files under it and deletes the old ones. Checked again here against the
  // document as it stands, since another member may have taken the ID since
  // the field read it.
  function handleRenameStoryId(newId: string) {
    if (!storyYMap || !ydoc || storyIdProblem(newId, story.story_id, documentStoryIds()) !== null) return;
    ydoc.transact(() => {
      storyYMap.set("story_id", newId);
    });
  }

  function handleReorderSteps(
    oldIndex: number,
    newIndex: number,
    _orderedIds: Array<string | number>
  ) {
    if (useYjs && storyYMap) {
      ops!.reorderSteps(storyYMap, oldIndex, newIndex);
      return;
    }
    // eslint-disable-next-line no-console
    console.warn("[story-editor] reorder-steps without active ydoc; ignored");
  }

  function handleDeleteStepConfirm() {
    if (useYjs && deletingStepYjs && storyYMap) {
      ops!.deleteStep(
        storyYMap,
        deletingStepYjs.id > 0 ? deletingStepYjs.id : null,
        deletingStepYjs._tempId ?? null
      );
      setDeletingStepYjs(null);
    } else if (deletingStepD1) {
      // D1 path removed — reset dialog without a server call.
      setDeletingStepD1(null);
    }
    if (activeStepIndex > 0) setActiveStepIndex(0);
  }

  function handleCaptureClip(field: "clip_start" | "clip_end", value: string) {
    if (!activeStep) return;
    // Clip values live in the Y.Doc and reach D1 via snapshotToD1. There is no
    // "autosave-step-field" action handler — useYjs is effectively always true
    // once the collab connection is up, so the no-ydoc branch is the
    // connection-not-yet-up edge.
    if (useYjs && ydoc && activeStep._yMap) {
      const stepYMap = activeStep._yMap;
      ydoc.transact(() => {
        stepYMap.set(field, value);
      });
      return;
    }
    // Previously this POSTed intent "autosave-step-field", which the
    // action switch does not handle (default → { error: "Unknown intent" }),
    // silently dropping the value. Mirror the no-ydoc visibility pattern used by
    // handleAddStep et al. rather than shipping a silent-failing POST.
    // eslint-disable-next-line no-console
    console.warn("[story-editor] capture-clip without active ydoc; ignored");
  }

  function handleToggleLoop(value: string) {
    if (!activeStep) return;
    if (useYjs && ydoc && activeStep._yMap) {
      const stepYMap = activeStep._yMap;
      ydoc.transact(() => {
        stepYMap.set("loop", value);
      });
      return;
    }
    // See handleCaptureClip — no silent POST to an unhandled intent.
    // eslint-disable-next-line no-console
    console.warn("[story-editor] toggle-loop without active ydoc; ignored");
  }

  function handleCreateLayer(_stepId: number, layerNumber: number, defaultLabel: string) {
    if (useYjs && activeStep?._yMap) {
      heldLayers.create(layerNumber === 2 ? 2 : 1, defaultLabel);
      return;
    }
    // eslint-disable-next-line no-console
    console.warn("[story-editor] create-layer without active ydoc; ignored");
  }

  // The layer itself, not its id: two unsaved layers share id 0.
  function handleDeleteLayer(layerInList: EditorLayer) {
    if (!activeStep) return;
    if (layerInList.writeUnsaved) {
      heldLayers.discard(layerInList.layer_number);
      panelState.close(layerInList.layer_number === 2 ? 2 : 1);
      return;
    }
    if (useYjs && activeStep._yMap && layerInList) {
      // Layer-1-while-layer-2-exists constraint enforced client-side (same
      // invariant previously enforced by the D1 delete-layer action).
      if (layerInList.layer_number === 1) {
        const hasLayer2 = activeLayers.some((l) => l.layer_number === 2);
        if (hasLayer2) return;
      }
      // Confirmed in the centralised DeleteConfirmationModal, as a step's
      // delete is.
      setDeletingLayer(layerInList);
      return;
    }
    // D1 path removed — close panels.
    panelState.close(layerInList.layer_number === 2 ? 2 : 1);
  }

  function handleConfirmDeleteLayer() {
    if (!deletingLayer || !activeStep?._yMap) {
      setDeletingLayer(null);
      return;
    }
    ops!.deleteLayer(
      activeStep._yMap,
      deletingLayer.id > 0 ? deletingLayer.id : null,
      deletingLayer._tempId ?? null
    );
    // A content draft or failure kept for the layer goes with it, so a late
    // answer to one of its saves cannot bring it back.
    retireLayerContent(story.project_id, deletingLayer.id);
    // Deleting layer 2 leaves layer 1 open; deleting layer 1 closes both.
    panelState.close(deletingLayer.layer_number === 2 ? 2 : 1);
    setDeletingLayer(null);
  }

  // Calculate layer count for the step pending deletion (D1 fallback)
  const deletingStepLayerCount = deletingStepD1
    ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (storyLayers as any[]).filter((l) => l.step_id === deletingStepD1.id)
        .length
    : 0;

  // Layer 1 cannot be deleted while layer 2 exists for the same step
  const canDeleteLayer1 = (() => {
    if (!activeStep) return true;
    const layer2Exists = activeLayers.some((l) => l.layer_number === 2);
    return !layer2Exists;
  })();


  // Get layer data for the active step — from Yjs-backed activeLayers when
  // available, otherwise falls back to the loader's flat storyLayers list.
  const activeLayer1: EditorLayer | null =
    activeLayers.find((l) => l.layer_number === 1) ?? null;
  const activeLayer2: EditorLayer | null =
    activeLayers.find((l) => l.layer_number === 2) ?? null;

  // The run of steps sharing the step's object, which the published page
  // arranges together: a media scene's tallest card decides where its cards go.
  const sceneSteps: SceneStepText[] = activeStep
    ? sceneRun(sceneInputs, activeStepIndex - 1, projectObjects, frameworkVersion).map(({ step: s }) => {
        const layer = layersByStep[keyFor(s)]?.find((l) => l.layer_number === 1);
        return {
          key: keyFor(s),
          current: s === activeStep,
          question: s.question,
          answer: s.answer,
          buttonLabel: layer ? layer.button_label ?? "" : null,
        };
      })
    : [];

  // Layer 1's button_label Y.Text, which the card's pill edits.
  const layer1ButtonLabelYText = getYText(activeLayer1?._yMap ?? null, "button_label");

  // The MarkdownEditor image picker's objects; source_url tells it which are external.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorObjects = (projectObjects as any[]).map((o) => ({
    object_id: o.object_id as string,
    title: o.title as string | null,
    thumbnail: o.thumbnail as string | null,
    image_available: o.image_available as boolean | null,
    source_url: o.source_url as string | null,
  }));

  // Opens a step's layer, from the step line's layer branches, the stage card's
  // button and layer 1's button for layer 2: select the step, then open the
  // requested layer over layer 1, with the element pressed as its opener.
  const openLayer = (stepIndex: number, layerNumber: number, opener: HTMLElement | null = null) => {
    if (stepIndex !== activeStepIndex) clearCaptureUndo();
    setActiveStepIndex(stepIndex);
    panelState.open(stepIndex, layerNumber, opener);
  };

  /** A layer of the selected step as the stage shows its panel. */
  const stagePanelLayer = (
    layer: EditorLayer | null,
    canDelete: boolean,
    deleteTooltip?: string,
  ): StagePanelLayer | null =>
    layer && {
      key: keyFor(layer),
      id: layer.id,
      layer_number: layer.layer_number === 2 ? 2 : 1,
      title: layer.title,
      button_label: layer.button_label,
      content: layer.content,
      titleYText: getYText(layer._yMap, "title"),
      contentYText: getYText(layer._yMap, "content"),
      buttonLabelYText: getYText(layer._yMap, "button_label"),
      canDelete: canDelete && (useYjs && layer._yMap ? ops!.canDelete(layer._yMap) : true),
      writeUnsaved: layer.writeUnsaved,
      deleteTooltip,
    };

  return (
    <>
    <StoryStage
      storyTitle={story.title ?? ""}
      sidebar={
        <StepSidebar
          steps={sidebarSteps}
          storyTitle={story.title}
          activeStepIndex={activeStepIndex}
          onStepSelect={(idx: number) => { selectStep(idx); clearCaptureUndo(); }}
          onReorderSteps={handleReorderSteps}
          onAddStep={handleAddStep}
          onAddSectionCard={handleAddSectionCard}
          onDeleteStep={(s) => {
            // Route step deletes through the centralised DeleteConfirmationModal
            // in Yjs mode; fall back to the legacy DeleteStepDialog
            // otherwise so pre-sync behaviour is unchanged.
            if (useYjs) {
              const yStep = sidebarSteps.find(
                (x) => (x.id > 0 && x.id === s.id) || (x._tempId && x._tempId === s._tempId)
              );
              if (yStep) setDeletingStepYjs(yStep);
            } else {
              setDeletingStepD1({
                id: s.id,
                step_number: s.step_number,
                question: s.question,
              });
            }
          }}
          objectsByType={objectsByType}
          siteLang={siteLang}
          canDeleteStep={(s) => {
            if (!useYjs) return true;
            const yMap = s._yMap as Y.Map<unknown> | null | undefined;
            return yMap ? ops!.canDelete(yMap) : true;
          }}
          deleteTooltip={tStructural("tooltip_cannot_delete")}
          highlightColorByKey={highlightedStepKeys}
          fadingKeys={fadingStepKeys}
          layersByStep={layersByStep}
          openLayerNumber={panelState.level === 0 ? null : panelState.level}
          onOpenLayer={openLayer}
        />
      }
      titleCard={{
        story: {
          id: story.id,
          title: story.title,
          subtitle: story.subtitle,
          byline: story.byline,
          show_sections: showSectionsValue,
        },
        storyId: story.story_id,
        titleYText,
        subtitleYText,
        bylineYText,
        sectionCardCount,
        sectionTitles,
        onToggleShowSections: handleToggleShowSections,
        storyIds: documentStoryIds(),
        canRenameId: mayRenameStory(storyYMap, ops),
        onRenameId: handleRenameStoryId,
      }}
      stepIndex={activeStepIndex}
      step={activeStep}
      isSectionCard={isSectionCard}
      storySlug={story.story_id}
      questionYText={questionYText}
      answerYText={answerYText}
      altTextYText={altTextYText}
      layer1={activeLayer1}
      sceneSteps={sceneSteps}
      layer1ButtonLabelYText={layer1ButtonLabelYText}
      onCreateLayer1={() => activeStep && handleCreateLayer(activeStep.id, 1, t("layer.default_label_1"))}
      onOpenLayer1={(opener) => openLayer(activeStepIndex, 1, opener)}
      panelPreview={panelPreview}
      glossaryKinds={glossaryKinds}
      readStamp={readStamp}
      projectId={story.project_id}
      viewer={{
        step: viewerStep,
        isStepZero,
        selectionKey,
        stepDisplayNumber: activeStepIndex,
        totalSteps,
        objects: viewerObjects,
        manifestUrl,
        infoJsonUrl,
        isSelfHosted,
        siteBaseUrl,
        frameworkVersion,
        onCapturePosition: handleCapturePosition,
        onChangeObject: handleChangeObject,
        onChoosePage: handleChoosePage,
        pendingNewStep,
        onNewStepConsumed: handleNewStepConsumed,
        onCaptureClip: handleCaptureClip,
        onToggleLoop: handleToggleLoop,
        repoFullName,
        captureUndoNonce,
        onUndoCapture: handleUndoCapture,
        writeFailures: stageWriteFailures,
        onOpenDoc: openDoc,
      }}
      panels={{
        layer1: stagePanelLayer(
          activeLayer1,
          canDeleteLayer1,
          canDeleteLayer1 ? undefined : t("layer.cannot_delete_has_layer2"),
        ),
        layer2: stagePanelLayer(activeLayer2, true),
        level: panelState.level,
        request: panelState.request,
        onClose: panelState.close,
        onDelete: (layerNumber) => {
          const layer = layerNumber === 2 ? activeLayer2 : activeLayer1;
          if (layer) handleDeleteLayer(layer);
        },
        onCreateLayer2: () => activeStep && handleCreateLayer(activeStep.id, 2, t("layer.default_label_2")),
        onOpenLayer2: (opener) => openLayer(activeStepIndex, 2, opener),
        deleteTooltip: tStructural("tooltip_cannot_delete"),
        objects: editorObjects,
        actionUrl: `/stories/${story.story_id}`,
        siteLang,
        onOpenDoc: openDoc,
        highlight: glossaryHighlight,
        onHighlighted: (id) => setGlossaryHighlight((current) => (current?.id === id ? null : current)),
      }}
    />
    {/* Legacy D1-mode step delete confirmation (non-collaborative fallback). */}
    <DeleteStepDialog
      open={!useYjs && deletingStepD1 !== null}
      onClose={() => setDeletingStepD1(null)}
      onConfirm={handleDeleteStepConfirm}
      step={deletingStepD1}
      layerCount={deletingStepLayerCount}
    />
    {/* Yjs-mode step delete confirmation with content summary. */}
    <DeleteConfirmationModal
      open={useYjs && deletingStepYjs !== null}
      onClose={() => setDeletingStepYjs(null)}
      onConfirm={handleDeleteStepConfirm}
      entityType="step"
      entityLabel={
        deletingStepYjs
          ? tStructural("entity_step", {
              number: deletingStepYjs.step_number || 0,
            })
          : ""
      }
      contentSummary={(() => {
        if (!deletingStepYjs) return undefined;
        const layerCount = deletingStepYjs._yLayerCount;
        const wordCount = [
          deletingStepYjs.question,
          deletingStepYjs.answer,
        ]
          .filter(Boolean)
          .map((s) => (s as string).trim().split(/\s+/).length)
          .reduce((a, b) => a + b, 0);
        if (layerCount === 0 && wordCount === 0) return undefined;
        if (layerCount === 0)
          return tStructural("summary_words", { count: wordCount });
        const layersText = tStructural(
          layerCount === 1 ? "summary_layers_one" : "summary_layers",
          { count: layerCount }
        );
        return wordCount > 0
          ? tStructural("summary_layers_words", {
              layers: layersText,
              words: wordCount,
            })
          : layersText;
      })()}
      contributors={
        deletingStepYjs
          ? computeStepContributors(
              story.id,
              deletingStepYjs._createdBy,
              currentUserId,
              members as EditorMember[]
            )
          : []
      }
    />
    {/* Yjs-mode layer delete confirmation. */}
    <DeleteConfirmationModal
      open={deletingLayer !== null}
      onClose={() => setDeletingLayer(null)}
      onConfirm={handleConfirmDeleteLayer}
      entityType="layer"
      entityLabel={
        deletingLayer
          ? tStructural("entity_layer", {
              number: deletingLayer.layer_number,
            })
          : ""
      }
      contentSummary={(() => {
        if (!deletingLayer) return undefined;
        const content = deletingLayer.content ?? "";
        const wordCount = content.trim().length
          ? content.trim().split(/\s+/).length
          : 0;
        if (wordCount === 0) return undefined;
        return tStructural("summary_words", { count: wordCount });
      })()}
      contributors={
        deletingLayer
          ? computeStepContributors(
              story.id,
              deletingLayer._createdBy,
              currentUserId,
              members as EditorMember[]
            )
          : []
      }
    />
    </>
  );
}

/**
 * Route-level ErrorBoundary for the Story Editor.
 *
 * The stories list renders from the Y.Doc (app/routes/_app.stories.tsx), so a
 * story that exists in Yjs but has not yet been snapshotted to D1 still shows an
 * Edit link. The loader queries D1 only and throws a 404 on miss. Without a
 * route boundary that 404 bubbles to the ROOT boundary (app/root.tsx) and
 * renders the full-app crash screen. Because React Router resolves the NEAREST
 * boundary, this one intercepts the throw first and renders a recoverable,
 * in-shell card (inside _app.tsx's header / TabNav shell) rather than replacing
 * the whole app.
 *
 * Error-reporting parity (CRITICAL): the root boundary reports EVERY error via
 * `recordError(error, "boundary")` (app/root.tsx — inside its useEffect). By
 * intercepting here we take over that responsibility for this route, so we must
 * preserve reporting for genuine crashes:
 *   - A 404 is the EXPECTED transient "not snapshotted yet" state. It is a
 *     recoverable, non-crash condition, so we deliberately do NOT report it —
 *     reporting it would flood the crash buffer with normal user navigation.
 *   - Any NON-404 error is a real failure. We call the SAME `recordError(error,
 *     "boundary")` that root uses (via useEffect, the SSR guard — useEffect does
 *     not run during worker SSR, so the browser-only capture singleton is never
 *     touched on the server) AND render a generic in-shell card. We do NOT
 *     re-throw: re-throwing from a route ErrorBoundary is not a supported React
 *     Router recovery path (the throw would itself be uncaught), so calling
 *     recordError directly is how we keep non-404s reported without losing the
 *     in-shell recovery.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const { t } = useTranslation("editor");
  const is404 = isRouteErrorResponse(error) && error.status === 404;

  useEffect(() => {
    // SSR guard: useEffect runs only after client mount. Report non-404 errors
    // through the same path the root boundary uses so genuine crashes on this
    // route are never silently swallowed by the recoverable-card UI. A 404 is an
    // expected transient state, so it is intentionally not reported.
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
            to="/stories"
            className="font-heading text-sm uppercase tracking-wider px-4 py-2 rounded text-charcoal bg-gray-100 hover:bg-gray-200 transition-colors"
          >
            {t("error.back_to_stories")}
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
