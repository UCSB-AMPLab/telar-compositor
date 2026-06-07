/**
 * This file is the Story Editor route — the full three-column story
 * editing surface (sidebar / narrative / viewer) the user lands on
 * when they click into an individual story.
 *
 * Loader fetches the story by `story_id` slug, all its steps
 * (ordered), layers for all steps, project objects for the object
 * picker, project config for constructing IIIF URLs, and team
 * members (for delete-confirmation contributor warnings). Action
 * handles `capture-position`, `change-object`, and `save-layer`
 * only. Structural ops (`add-step`, `delete-step`,
 * `reorder-steps`, `create-layer`, `delete-layer`) are migrated to
 * Yjs via `useStructuralOps` — `snapshotToD1` reconciles Y.Array
 * state back to D1 entity tables every 30 seconds.
 *
 * Wires `EditorShell`, `StepSidebar`, `NarrativeColumn`, and
 * `ViewerColumn`. Reads steps and layers from the Y.Array when a
 * Y.Doc is available, otherwise falls back to loader data.
 *
 * Computes a plain `layersByStep` map so the sidebar can render nested
 * L1/L2 navigation sub-rows, and additively mirrors in-editor
 * navigation into `?step`/`?layer` via `setSearchParams(…, { replace: true })`
 * on the step-select / layer-open / layer-close handlers — never
 * inside the one-shot `deepLinkConsumedRef` mount read.
 *
 * @version v1.3.0-beta
 */

import { useState, useEffect, useRef, useMemo } from "react";
import { redirect, useFetcher, useNavigate, useOutletContext, useSearchParams, Link, useRouteError, isRouteErrorResponse } from "react-router";
import { and, eq, inArray } from "drizzle-orm";
import type { Route } from "./+types/_app.stories.$storyId";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { stories, steps, layers, objects, project_config, project_members, users as usersTable } from "~/db/schema";
import { resolveActiveProject, requireProjectMember } from "~/lib/membership.server";
import { createSessionStorage } from "~/lib/session.server";
import { EditorShell } from "~/components/features/editor/EditorShell";
import { StepSidebar } from "~/components/features/editor/StepSidebar";
import type { SidebarLayerSummary } from "~/components/features/editor/StepSidebar";
import { NarrativeColumn } from "~/components/features/editor/NarrativeColumn";
import { SectionCardView } from "~/components/features/editor/SectionCardView";
import { ViewerColumn } from "~/components/features/editor/ViewerColumn";
import { LayerPanel } from "~/components/features/editor/LayerPanel";
import { DeleteStepDialog } from "~/components/features/editor/DeleteStepDialog";
import { DeleteConfirmationModal } from "~/components/ui/DeleteConfirmationModal";
import { useTranslation } from "react-i18next";
import { detectMediaType } from "~/lib/media-type";
import type { MediaType } from "~/lib/media-type";
import { useCollaborationContext, useSetAwarenessLocation } from "~/hooks/use-collaboration";
import { useStructuralOps } from "~/hooks/use-structural-ops";
import { useToast } from "~/hooks/use-toast";
import { findYMapById, getYText } from "~/lib/yjs-helpers";
import { recordError } from "~/lib/error-capture";
import * as Y from "yjs";

export const handle = { i18n: ["editor", "common"] };

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);

  // Read activeProjectId from session, fall back to first project
  const sessionStorage = createSessionStorage(env.SESSION_SECRET);
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));
  const sessionActiveId = session.get("activeProjectId") as number | undefined;

  const resolved = await resolveActiveProject(db, user.id, sessionActiveId);
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

  if (storyRows.length === 0) throw new Response("Not Found", { status: 404 });
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

  // Fetch project objects for the object picker
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
    .where(eq(objects.project_id, Number(activeProjectId)));

  // Fetch project config for IIIF URL construction (self-hosted objects)
  const configRows = await db
    .select({ url: project_config.url, baseurl: project_config.baseurl })
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
    repoFullName: activeProject.github_repo_full_name,
    members,
    currentUserId: user.id,
    userRole,
  };
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
  async function touchStory(projectId: number) {
    await db
      .update(stories)
      .set({ updated_at: now })
      .where(
        and(
          eq(stories.story_id, params.storyId),
          eq(stories.project_id, projectId)
        )
      );
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

  switch (intent) {
    case "capture-position": {
      const stepId = Number(formData.get("stepId"));
      // Gate on project membership before mutating the step.
      const projectId = await resolveStepProjectId(stepId);
      await requireProjectMember(db, projectId, user.id);
      const x = parseFloat(formData.get("x") as string);
      const y = parseFloat(formData.get("y") as string);
      const zoom = parseFloat(formData.get("zoom") as string);
      const page = (formData.get("page") as string) || null;

      await db
        .update(steps)
        .set({ x, y, zoom, page, updated_at: now })
        .where(eq(steps.id, stepId));

      await touchStory(projectId);
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

    // Structural ops (add-step, delete-step, reorder-steps, create-layer,
    // delete-layer) migrated to Yjs via useStructuralOps — snapshotToD1
    // reconciles Y.Array state back to D1 every 30 seconds and on disconnect.

    case "save-layer": {
      const layerId = Number(formData.get("layerId"));
      const projectId = await resolveLayerProjectId(layerId);
      await requireProjectMember(db, projectId, user.id);
      const content = (formData.get("content") as string) ?? "";
      const buttonLabel = (formData.get("buttonLabel") as string) || null;
      await db
        .update(layers)
        .set({ content, button_label: buttonLabel, updated_at: now })
        .where(eq(layers.id, layerId));
      await touchStory(projectId);
      return { ok: true, intent: "save-layer" };
    }

    case "autosave-layer": {
      const layerId = Number(formData.get("layerId"));
      const projectId = await resolveLayerProjectId(layerId);
      await requireProjectMember(db, projectId, user.id);
      const field = formData.get("field") as string;
      const value = (formData.get("value") as string) ?? "";
      const updateData: Record<string, unknown> = { updated_at: now };
      if (field === "content") updateData.content = value;
      if (field === "title") updateData.title = value;
      if (field === "button_label") updateData.button_label = value;
      await db.update(layers).set(updateData).where(eq(layers.id, layerId));
      await touchStory(projectId);
      return { ok: true, intent: "autosave-layer" };
    }

    default:
      return { error: "Unknown intent" };
  }
}

// ---------------------------------------------------------------------------
// Helper: resolve IIIF URLs for an object
// ---------------------------------------------------------------------------

function resolveIiifUrls(
  objectId: string | null,
  objectsWithSource: Array<{ object_id: string; source_url: string | null }>,
  siteBaseUrl: string | null
): { manifestUrl: string | null; infoJsonUrl: string | null; isSelfHosted: boolean } {
  if (!objectId) {
    return { manifestUrl: null, infoJsonUrl: null, isSelfHosted: false };
  }

  const obj = objectsWithSource.find((o) => o.object_id === objectId);
  if (!obj) {
    return { manifestUrl: null, infoJsonUrl: null, isSelfHosted: false };
  }

  const isExternal =
    obj.source_url !== null &&
    (obj.source_url.startsWith("http://") || obj.source_url.startsWith("https://"));

  if (isExternal) {
    return { manifestUrl: obj.source_url, infoJsonUrl: null, isSelfHosted: false };
  }

  if (siteBaseUrl) {
    return {
      manifestUrl: `${siteBaseUrl}/iiif/objects/${objectId}/manifest.json`,
      infoJsonUrl: `${siteBaseUrl}/iiif/objects/${objectId}/info.json`,
      isSelfHosted: true,
    };
  }

  return { manifestUrl: null, infoJsonUrl: null, isSelfHosted: true };
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
  _tempId: string | null;
  _createdBy: number | null;
  _yMap: Y.Map<unknown> | null;
  _yLayerCount: number;
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

function stepFromYMap(s: Y.Map<unknown>): EditorStep {
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
    _tempId: (s.get("_temp_id") as string | null) ?? null,
    _createdBy: (s.get("created_by") as number | null) ?? null,
    _yMap: s,
    _yLayerCount:
      layersArr instanceof Y.Array ? (layersArr as Y.Array<unknown>).length : 0,
  };
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

export default function StoryEditorPage({ loaderData }: Route.ComponentProps) {
  const {
    story,
    steps: storySteps,
    layers: storyLayers,
    objects: projectObjects,
    siteBaseUrl,
    repoFullName,
    members,
    currentUserId,
    userRole,
  } = loaderData;
  const { t } = useTranslation("editor");
  const { t: tStructural } = useTranslation("structural");
  const { openDoc } = useOutletContext<{ openDoc?: (id: string) => void }>() ?? {};
  const { ydoc, remoteCollaborators } = useCollaborationContext();
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

  // Layer panel state — both can be open simultaneously (stacked)
  const [layer1Open, setLayer1Open] = useState(false);
  const [layer2Open, setLayer2Open] = useState(false);

  // Capture-position Undo. The baseline is the step's
  // x/y/zoom/page snapshotted BEFORE the capture transaction, keyed to the
  // step it belongs to. A repeated capture replaces it (re-baselines); selecting
  // a different step clears it (the undo is scoped to the just-captured step).
  // The baseline identifies its step by BOTH the D1 id and
  // the Yjs _tempId. A freshly-added step has only a _tempId at capture time;
  // after snapshotToD1 backfills the real id the step's stable key flips from
  // _tempId to the numeric id. Storing a single `stepKey` (the pre-backfill
  // key) would then fail to resolve the target in handleUndoCapture, silently
  // no-op'ing the Undo while the pill is still shown. Matching on either id OR
  // _tempId survives the backfill.
  const [captureUndo, setCaptureUndo] = useState<{
    id: number | null;
    tempId: string | null;
    prior: { x: unknown; y: unknown; zoom: unknown; page: unknown };
    // Bumped on every capture so a repeated capture of the SAME step re-shows
    // the toast and resets its 5s auto-dismiss timer (replace-on-recapture).
    nonce: number;
  } | null>(null);

  const captureFetcher = useFetcher();
  const changeObjectFetcher = useFetcher();
  // clipFetcher removed — clip/loop values flow through the Y.Doc only;
  // there is no "autosave-step-field" action handler, so the prior fallback
  // POST silently failed. The no-ydoc edge now warns instead (see
  // handleCaptureClip / handleToggleLoop).

  // ---------------------------------------------------------------------------
  // Y.Array-backed step state
  // ---------------------------------------------------------------------------
  const storiesArray = ydoc?.getArray<Y.Map<unknown>>("stories") ?? null;
  const storyYMap = storiesArray ? findYMapById(storiesArray, story.id) : null;
  const stepsArray: Y.Array<Y.Map<unknown>> | null =
    storyYMap && storyYMap.get("steps") instanceof Y.Array
      ? (storyYMap.get("steps") as Y.Array<Y.Map<unknown>>)
      : null;

  const [yjsSteps, setYjsSteps] = useState<EditorStep[] | null>(null);
  useEffect(() => {
    if (!stepsArray) {
      setYjsSteps(null);
      return;
    }
    const recompute = () => {
      const next: EditorStep[] = [];
      for (let i = 0; i < stepsArray.length; i++) {
        next.push(stepFromYMap(stepsArray.get(i)));
      }
      setYjsSteps(next);
    };
    recompute();
    stepsArray.observeDeep(recompute);
    return () => stepsArray.unobserveDeep(recompute);
  }, [stepsArray]);

  const useYjs = ydoc !== null && ops !== null && yjsSteps !== null;

  // activeStepIndex 0 = title card; 1+ = sidebarSteps[activeStepIndex - 1].
  // In D1 fallback, step_number > 0 filters the title card (step 0). In Yjs
  // mode, step 0 is not stored in the Y.Array — we include all entries
  // returned by the observer.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sidebarSteps: EditorStep[] = useYjs
    ? yjsSteps!.filter((s) => (s.step_number ?? 0) > 0 || s.id > 0 || s._tempId)
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
      const next: EditorLayer[] = [];
      for (let i = 0; i < arr.length; i++) {
        next.push(layerFromYMap(arr.get(i), parentId));
      }
      setYjsLayers(next);
    };
    recompute();
    arr.observeDeep(recompute);
    return () => arr.unobserveDeep(recompute);
  }, [activeStepLayersArray, activeStep]);

  const activeLayers: EditorLayer[] = useYjs && yjsLayers
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

  const isStepZero = activeStepIndex === 0;
  const isSectionCard = !isStepZero && activeStep?.kind === "section";
  const totalSteps = sidebarSteps.length;

  // Per-step layer summaries for the sidebar's nested L1/L2 sub-rows.
  // Computed here (plain data) so SortableStepItem never reads `_yMap`. Keyed by
  // the step's stable key (id > 0 ? id : _tempId) — matching StepSidebar.keyFor.
  // In Yjs mode every step Y.Map carries a `layers` Y.Array; in the D1 fallback
  // the flat `storyLayers` list is grouped by step_id. Reactive because it
  // derives from sidebarSteps (recomputed by the stepsArray observeDeep) and
  // storyLayers.
  const layersByStep = useMemo<Record<string, SidebarLayerSummary[]>>(() => {
    const map: Record<string, SidebarLayerSummary[]> = {};
    for (const s of sidebarSteps) {
      if (s.kind === "section") continue;
      const key = String(s.id > 0 ? s.id : s._tempId ?? "");
      if (!key) continue;
      let summaries: SidebarLayerSummary[] = [];
      const layersArr = s._yMap?.get("layers");
      if (s._yMap && layersArr instanceof Y.Array) {
        const arr = layersArr as Y.Array<Y.Map<unknown>>;
        summaries = [];
        for (let i = 0; i < arr.length; i++) {
          const l = layerFromYMap(arr.get(i), s.id);
          summaries.push({
            layer_number: l.layer_number,
            button_label: l.button_label,
          });
        }
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        summaries = (storyLayers as any[])
          .filter((l) => l.step_id === s.id)
          .map((l) => ({
            layer_number: l.layer_number as number,
            button_label: (l.button_label as string | null) ?? null,
          }));
      }
      if (summaries.length > 0) map[key] = summaries;
    }
    return map;
  }, [sidebarSteps, storyLayers]);

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
  // The deep-link pulse timer is held in a ref, NOT torn down by the
  // consume effect's cleanup. The consume effect depends on [totalSteps,
  // searchParams]; if searchParams changes within the 350ms before the pulse
  // fires (e.g. the URL-mirror write the effect's own setActiveStepIndex
  // triggers, or a fast click), the effect's cleanup would clear the timer and
  // the re-run returns early (consume guard) without re-registering it — so the
  // chip never pulses. A ref survives re-runs; a single unmount-only effect
  // clears it.
  const pulseTimerRef = useRef<number | null>(null);
  const pulseRemoveTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (pulseTimerRef.current !== null) window.clearTimeout(pulseTimerRef.current);
      if (pulseRemoveTimerRef.current !== null) window.clearTimeout(pulseRemoveTimerRef.current);
    };
  }, []);
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
    // visible. Layer-WITHIN-step precision (pulsing the exact occurrence inside
    // the correct expanded panel) is a Phase-50 layer-panel-DOM concern; here we
    // open the requested layer and pulse the first glossary chip that mounts.
    const rawLayer = searchParams.get("layer");
    const parsedLayer = rawLayer === null ? null : Number.parseInt(rawLayer, 10);
    const validLayer =
      parsedLayer === 1 || parsedLayer === 2 ? parsedLayer : null;
    if (validLayer === 1) setLayer1Open(true);
    else if (validLayer === 2) {
      setLayer1Open(true);
      setLayer2Open(true);
    }

    // After the step (and any layer panel) mounts, scroll the [[term]] chip —
    // rendered as a `.cm-glossary-chip` widget by the editor's ViewPlugin — into
    // view with a transient pulse that fades. The chip DOM is guaranteed present
    // by the glossary-chip rendering. Deferred so the layer panel + its CodeMirror have
    // mounted; if no chip is present (e.g. step-level landing only) this is a
    // no-op and the step navigate above still stands.
    pulseTimerRef.current = window.setTimeout(() => {
      const chip = document.querySelector<HTMLElement>(".cm-glossary-chip");
      if (!chip) return;
      chip.scrollIntoView({ behavior: "smooth", block: "center" });
      chip.classList.add("cm-glossary-chip-pulse");
      pulseRemoveTimerRef.current = window.setTimeout(
        () => chip.classList.remove("cm-glossary-chip-pulse"),
        2400,
      );
    }, 350);

    // No effect-level cleanup tearing down the pulse timer — it lives in
    // pulseTimerRef and is cleared only on unmount. A re-run of this effect
    // (searchParams change) returns early via deepLinkConsumedRef, so it would
    // never re-register the timer; clearing it here would lose the pulse.
  }, [totalSteps, searchParams]);

  // ---------------------------------------------------------------------------
  // Additive URL mirror. `activeStepIndex` + `layer1Open`/
  // `layer2Open` remain the navigation drivers; these helpers mirror the
  // current position into ?step/?layer with REPLACE history so the URL is a
  // restorable + shareable bookmark and browser Back exits the editor rather
  // than stepping through every click.
  //
  // CRITICAL: these writes hang ONLY off the user-action handlers
  // (step select, layer open, layer close). They are NEVER called inside the
  // one-shot deepLinkConsumedRef read effect above — that effect consumes-then-
  // guards (sets .current = true before reading), so a mirror write changing
  // searchParams can never re-trigger the read.
  //
  // Mapping: step select index N>0 → ?step=N (drop ?layer); index 0 (title card)
  // → drop both; open L1 → ?layer=1; open L2 → ?layer=2; close → drop ?layer.
  const mirrorStepParam = (index: number) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (index > 0) next.set("step", String(index));
        else next.delete("step");
        next.delete("layer"); // selecting a step closes any open layer
        return next;
      },
      { replace: true },
    );
  };
  const mirrorLayerParam = (layer: 1 | 2 | null) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (layer === null) next.delete("layer");
        else next.set("layer", String(layer));
        return next;
      },
      { replace: true },
    );
  };

  // Section-card count drives the helper-text visibility on the title-card
  // show_sections toggle.
  const sectionCardCount = sidebarSteps.filter((s) => s.kind === "section").length;

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
  const activeStepKeyRef = useRef<string | null>(null);
  activeStepKeyRef.current = activeStep
    ? String(activeStep.id > 0 ? activeStep.id : activeStep._tempId ?? "")
    : null;

  // The remote-delete effect below has deps [sidebarSteps, useYjs,
  // userRole] (exhaustive-deps disabled) but reads activeStepIndex (for the
  // toast step number) and remoteCollaborators (for the deleter name). Reading
  // those directly captures a stale closure — the toast could show the wrong
  // step number or attribute the deletion to a stale/empty collaborator. Mirror
  // both into refs written during render so the effect reads current values.
  const activeStepIndexRef = useRef(activeStepIndex);
  activeStepIndexRef.current = activeStepIndex;
  const remoteCollaboratorsRef = useRef(remoteCollaborators);
  remoteCollaboratorsRef.current = remoteCollaborators;

  useEffect(() => {
    if (!useYjs) return;
    const curr = new Set<string>();
    for (const s of sidebarSteps) {
      curr.add(String(s.id > 0 ? s.id : s._tempId ?? ""));
    }
    const deletedKeys: string[] = [];
    prevStepKeysRef.current.forEach((k) => {
      if (!curr.has(k)) deletedKeys.push(k);
    });
    prevStepKeysRef.current = curr;
    if (deletedKeys.length === 0) return;

    // If the active step was deleted, toast + reset to title card.
    const activeKey = activeStepKeyRef.current;
    const deleterName = remoteCollaboratorsRef.current[0]?.user.name ?? "";
    if (activeKey && deletedKeys.includes(activeKey)) {
      const stepLabel = tStructural("entity_step", {
        number: activeStepIndexRef.current,
      });
      const message = deleterName
        ? tStructural("toast_item_deleted", {
            label: stepLabel,
            name: deleterName,
          })
        : tStructural("toast_item_deleted_generic", { label: stepLabel });
      showToast({
        message,
        type: "destructive",
        ...(userRole === "convenor"
          ? {
              action: {
                label: tStructural("toast_item_deleted_undo"),
                onClick: () => {
                  // The global TabNav Undo button / Ctrl+Z drives
                  // the shared UndoManager — no direct call here.
                },
              },
            }
          : {}),
      });
      setActiveStepIndex(0);
      setLayer1Open(false);
      setLayer2Open(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarSteps, useYjs, userRole]);

  // Parent-story delete detection — when the current story is removed from
  // the stories Y.Array, redirect to /stories with a toast.
  useEffect(() => {
    if (!useYjs || !storiesArray) return;
    const handler = () => {
      const gone = findYMapById(storiesArray, story.id) === null;
      if (gone) {
        const deleterName = remoteCollaborators[0]?.user.name ?? "";
        const label = story.title ?? story.story_id;
        showToast({
          message: deleterName
            ? tStructural("toast_item_deleted", { label, name: deleterName })
            : tStructural("toast_item_deleted_generic", { label }),
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

  // Does a capture baseline refer to the given step? Matches
  // on either the D1 id OR the Yjs _tempId so the match survives the id-backfill
  // that flips a step's stable key after snapshotToD1.
  const captureUndoMatchesStep = (
    baseline: { id: number | null; tempId: string | null },
    step: { id: number; _tempId: string | null } | null,
  ): boolean => {
    if (!step) return false;
    if (baseline.id !== null && step.id > 0 && step.id === baseline.id) return true;
    if (baseline.tempId !== null && step._tempId === baseline.tempId) return true;
    return false;
  };

  // The capture-undo toast shows only while the captured step
  // is still the active step (switching steps dismisses it). This gate is the
  // belt-and-braces complement to the explicit setCaptureUndo(null) on the
  // step-select handlers. The nonce changes on every capture so ViewerColumn
  // re-shows the toast and resets its 5s timer on a repeated capture.
  const captureUndoNonce =
    captureUndo !== null && captureUndoMatchesStep(captureUndo, activeStep)
      ? captureUndo.nonce
      : null;

  const { manifestUrl, infoJsonUrl, isSelfHosted } = resolveIiifUrls(
    viewerObjectId,
    projectObjects,
    siteBaseUrl
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

  // Pre-compute media type per object for StepSidebar badges
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const objectsByType: Record<string, MediaType> = {};
  for (const obj of (projectObjects as any[])) {
    objectsByType[obj.object_id as string] = detectMediaType(
      obj.source_url as string | null,
      obj.object_id as string
    );
  }

  // ---------------------------------------------------------------------------
  // Resolve Y.Text instances for story title/subtitle/byline and active step fields
  // (storyYMap and stepsArray declared above for Y.Array observation).
  // ---------------------------------------------------------------------------

  const titleYText = getYText(storyYMap, "title");
  const subtitleYText = getYText(storyYMap, "subtitle");
  const bylineYText = getYText(storyYMap, "byline");

  // Step-level Y.Text (for StepView — resolved from the active step's Y.Map)
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
      const k = String(s.id > 0 ? s.id : s._tempId ?? "");
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
      remoteCollaborators[0]?.user.color ?? "rgba(198, 208, 248, 0.9)";
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

  function handleAddStep() {
    if (useYjs && storyYMap) {
      ops!.addStep(storyYMap);
      return;
    }
    // D1-mode fallback no longer supported. Log for visibility.
    // eslint-disable-next-line no-console
    console.warn("[story-editor] add-step without active ydoc; ignored");
  }

  // Mirrors handleAddStep exactly — same control flow, same ydoc gate, same
  // log-on-missing-ydoc behaviour. Only the ops method differs (B-01 parity).
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

  function handleCapturePosition(pos: { x: number; y: number; zoom: number; page: string }) {
    if (!activeStep) return;
    // Y.Doc is the source of truth for step state in collaborative mode;
    // snapshotToD1 reconciles. The D1-only fetcher would be clobbered.
    if (useYjs && ydoc && activeStep._yMap) {
      const stepYMap = activeStep._yMap;
      // Snapshot the step's CURRENT four values
      // BEFORE the capture transact, stashed as the undo baseline keyed to the
      // active step. Reading after the write would capture the post-write state
      // and Undo would be a no-op. Replaces any existing baseline
      // (repeated-capture re-baselining).
      const prior = {
        x: stepYMap.get("x"),
        y: stepYMap.get("y"),
        zoom: stepYMap.get("zoom"),
        page: stepYMap.get("page"),
      };
      setCaptureUndo((prevUndo) => ({
        id: activeStep.id > 0 ? activeStep.id : null,
        tempId: activeStep._tempId ?? null,
        prior,
        nonce: (prevUndo?.nonce ?? 0) + 1,
      }));
      ydoc.transact(() => {
        stepYMap.set("x", pos.x);
        stepYMap.set("y", pos.y);
        stepYMap.set("zoom", pos.zoom);
        stepYMap.set("page", pos.page);
      });
      return;
    }
    captureFetcher.submit(
      {
        intent: "capture-position",
        stepId: String(activeStep.id),
        x: String(pos.x),
        y: String(pos.y),
        zoom: String(pos.zoom),
        page: pos.page,
      },
      { method: "post" }
    );
  }

  // Revert the just-captured step to its pre-capture
  // baseline in ONE transaction. Last-write-wins — we simply write the snapshot
  // back with no conflict detection, even if a remote peer changed the keys
  // after capture. Clears the toast afterwards.
  function handleUndoCapture() {
    if (!captureUndo) return;
    // Resolve the target by matching either the D1 id OR the
    // Yjs _tempId. The baseline may have been captured before snapshotToD1
    // backfilled the real id (flipping the step's stable key), so a single-key
    // match would return undefined and silently no-op the Undo.
    const target = sidebarSteps.find((s) =>
      captureUndoMatchesStep(captureUndo, s)
    );
    const stepYMap = target?._yMap;
    if (ydoc && stepYMap) {
      const { prior } = captureUndo;
      ydoc.transact(() => {
        stepYMap.set("x", prior.x);
        stepYMap.set("y", prior.y);
        stepYMap.set("zoom", prior.zoom);
        stepYMap.set("page", prior.page);
      });
    }
    setCaptureUndo(null);
  }

  function handleChangeObject(objectId: string) {
    // For step 0, changing the object changes step 1's object
    const targetStep = isStepZero ? (sidebarSteps[0] ?? null) : activeStep;
    if (!targetStep) return;
    // When the Y.Doc is the source of truth (sidebarSteps comes from yjsSteps),
    // mutate the step's Y.Map so the UI updates immediately and snapshotToD1
    // reconciles the change back to D1. The D1-only fetcher would be silently
    // overwritten by the next snapshotToD1 cycle.
    if (useYjs && ydoc && targetStep._yMap) {
      const stepYMap = targetStep._yMap;
      ydoc.transact(() => {
        stepYMap.set("object_id", objectId);
      });
      return;
    }
    changeObjectFetcher.submit(
      { intent: "change-object", stepId: String(targetStep.id), objectId },
      { method: "post" }
    );
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
      ops!.addLayer(activeStep._yMap, layerNumber, defaultLabel);
      return;
    }
    // eslint-disable-next-line no-console
    console.warn("[story-editor] create-layer without active ydoc; ignored");
  }

  function handleDeleteLayer(layerId: number) {
    if (!activeStep) return;
    const layerInList = activeLayers.find((l) => l.id === layerId);
    if (useYjs && activeStep._yMap && layerInList) {
      // Layer-1-while-layer-2-exists constraint enforced client-side (same
      // invariant previously enforced by the D1 delete-layer action).
      if (layerInList.layer_number === 1) {
        const hasLayer2 = activeLayers.some((l) => l.layer_number === 2);
        if (hasLayer2) return;
      }
      // Open the centralised modal for consistency with step delete — the
      // LayerPanel already has its own Dialog too, but the plan asks for a
      // unified DeleteConfirmationModal across structural deletes.
      setDeletingLayer(layerInList);
      return;
    }
    // D1 path removed — close panels.
    const deletedLayer = activeLayers.find((l) => l.id === layerId);
    if (deletedLayer?.layer_number === 2) setLayer2Open(false);
    else { setLayer1Open(false); setLayer2Open(false); }
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
    if (deletingLayer.layer_number === 2) setLayer2Open(false);
    else {
      setLayer1Open(false);
      setLayer2Open(false);
    }
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

  // Whether layer 2 exists for the active step (used by LayerPanel layer-1 "Add panel" button)
  const hasLayer2ForActiveStep = activeLayers.some((l) => l.layer_number === 2);

  // Get layer data for the active step — from Yjs-backed activeLayers when
  // available, otherwise falls back to the loader's flat storyLayers list.
  const activeLayer1: EditorLayer | null =
    activeLayers.find((l) => l.layer_number === 1) ?? null;
  const activeLayer2: EditorLayer | null =
    activeLayers.find((l) => l.layer_number === 2) ?? null;

  // Resolve layer 1's button_label Y.Text once and thread it through
  // NarrativeColumn → StepView so the trigger pill writes the SAME Y.Text the
  // layer-panel strip writes (live two-place sync). Mirrors the existing L2
  // resolution at the LayerPanel render below.
  const layer1ButtonLabelYText = getYText(activeLayer1?._yMap ?? null, "button_label");

  // Strip source_url from objects for the MarkdownEditor image picker (keep image_available for thumbnail guard)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorObjects = (projectObjects as any[]).map((o) => ({
    object_id: o.object_id as string,
    title: o.title as string | null,
    thumbnail: o.thumbnail as string | null,
    image_available: o.image_available as boolean | null,
  }));

  return (
    <>
    <EditorShell
      storyTitle={story.title ?? ""}
      hideViewer={isStepZero || isSectionCard}
      sidebar={
        <StepSidebar
          steps={sidebarSteps}
          storyTitle={story.title}
          activeStepIndex={activeStepIndex}
          onStepSelect={(idx: number) => { setActiveStepIndex(idx); setLayer1Open(false); setLayer2Open(false); mirrorStepParam(idx); setCaptureUndo(null); }}
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
          canDeleteStep={(s) => {
            if (!useYjs) return true;
            const yMap = s._yMap as Y.Map<unknown> | null | undefined;
            return yMap ? ops!.canDelete(yMap) : true;
          }}
          deleteTooltip={tStructural("tooltip_cannot_delete")}
          highlightColorByKey={highlightedStepKeys}
          fadingKeys={fadingStepKeys}
          layersByStep={layersByStep}
          openLayerNumber={layer2Open ? 2 : layer1Open ? 1 : null}
          onOpenLayer={(stepIndex: number, layerNumber: number) => {
            // Navigate to a layer from a sidebar sub-row: select the step, then
            // open the requested layer. Opening L2 implies L1 is open beneath it.
            // Mirror both the step and the layer into the URL.
            if (stepIndex !== activeStepIndex) setCaptureUndo(null);
            setActiveStepIndex(stepIndex);
            if (layerNumber === 2) {
              setLayer1Open(true);
              setLayer2Open(true);
            } else {
              setLayer1Open(true);
              setLayer2Open(false);
            }
            mirrorStepParam(stepIndex);
            mirrorLayerParam(layerNumber === 2 ? 2 : 1);
          }}
        />
      }
      narrative={
        isSectionCard && activeStep ? (
          <SectionCardView
            step={{
              id: activeStep.id,
              step_number: activeStep.step_number,
              question: activeStep.question ?? null,
              answer: activeStep.answer ?? null,
            }}
            storyId={String(story.story_id ?? story.id)}
            questionYText={questionYText}
            answerYText={answerYText}
          />
        ) : (
          <NarrativeColumn
            activeStepIndex={activeStepIndex}
            storyId={story.story_id}
            story={{
              id: story.id,
              title: story.title,
              subtitle: story.subtitle,
              byline: story.byline,
              order: story.order,
              show_sections: showSectionsValue,
            }}
            activeStep={activeStep}
            layers={activeLayers}
            onOpenLayer={(layer) => {
              if (layer.layer_number === 1) {
                setLayer1Open(true);
                mirrorLayerParam(1);
              } else {
                setLayer2Open(true);
                mirrorLayerParam(2);
              }
            }}
            onCreateLayer={handleCreateLayer}
            actionUrl={`/stories/${story.story_id}`}
            isFirstStep={activeStepIndex === 1}
            titleYText={titleYText}
            subtitleYText={subtitleYText}
            bylineYText={bylineYText}
            sectionCardCount={sectionCardCount}
            onToggleShowSections={handleToggleShowSections}
            questionYText={questionYText}
            answerYText={answerYText}
            altTextYText={altTextYText}
            buttonLabelYText={layer1ButtonLabelYText}
            onOpenDoc={openDoc}
          />
        )
      }
      viewer={
        <ViewerColumn
          step={viewerStep}
          isStepZero={isStepZero}
          stepDisplayNumber={activeStepIndex}
          totalSteps={totalSteps}
          objects={viewerObjects}
          manifestUrl={manifestUrl}
          infoJsonUrl={infoJsonUrl}
          isSelfHosted={isSelfHosted}
          siteBaseUrl={siteBaseUrl}
          onCapturePosition={handleCapturePosition}
          onChangeObject={handleChangeObject}
          onCaptureClip={handleCaptureClip}
          onToggleLoop={handleToggleLoop}
          repoFullName={repoFullName}
          captureUndoNonce={captureUndoNonce}
          onUndoCapture={handleUndoCapture}
          onOpenDoc={openDoc}
        >
          {/* Layer 1 panel */}
          {activeLayer1 && (
            <LayerPanel
              layer={{
                id: activeLayer1.id,
                layer_number: activeLayer1.layer_number,
                title: activeLayer1.title,
                button_label: activeLayer1.button_label,
                content: activeLayer1.content,
              }}
              open={layer1Open}
              onClose={() => { setLayer1Open(false); setLayer2Open(false); mirrorLayerParam(null); }}
              onDelete={handleDeleteLayer}
              actionUrl={`/stories/${story.story_id}`}
              canDelete={
                canDeleteLayer1 &&
                (useYjs && activeLayer1._yMap
                  ? ops!.canDelete(activeLayer1._yMap)
                  : true)
              }
              deleteTooltip={tStructural("tooltip_cannot_delete")}
              skipInternalConfirm={useYjs}
              hasLayer2={hasLayer2ForActiveStep}
              layer2ButtonLabel={activeLayer2?.button_label ?? null}
              layer2Id={activeLayer2?.id}
              onCreateLayer2={() =>
                activeStep &&
                handleCreateLayer(
                  activeStep.id,
                  2,
                  t("layer.default_label_2")
                )
              }
              onOpenLayer2={() => { setLayer2Open(true); mirrorLayerParam(2); }}
              objects={editorObjects}
              siteBaseUrl={siteBaseUrl}
              titleYText={getYText(activeLayer1._yMap, "title")}
              contentYText={getYText(activeLayer1._yMap, "content")}
              layer2ButtonLabelYText={getYText(activeLayer2?._yMap ?? null, "button_label")}
              buttonLabelYText={layer1ButtonLabelYText}
              storyTitle={story.title}
              stepNumber={activeStepIndex}
              onOpenDoc={openDoc}
            />
          )}
          {/* Layer 2 panel — stacked on top of layer 1 */}
          {activeLayer2 && (
            <LayerPanel
              layer={{
                id: activeLayer2.id,
                layer_number: activeLayer2.layer_number,
                title: activeLayer2.title,
                button_label: activeLayer2.button_label,
                content: activeLayer2.content,
              }}
              open={layer2Open}
              onClose={() => { setLayer2Open(false); mirrorLayerParam(1); }}
              onDelete={handleDeleteLayer}
              actionUrl={`/stories/${story.story_id}`}
              canDelete={
                useYjs && activeLayer2._yMap
                  ? ops!.canDelete(activeLayer2._yMap)
                  : true
              }
              deleteTooltip={tStructural("tooltip_cannot_delete")}
              skipInternalConfirm={useYjs}
              titleYText={getYText(activeLayer2._yMap, "title")}
              contentYText={getYText(activeLayer2._yMap, "content")}
              buttonLabelYText={getYText(activeLayer2._yMap, "button_label")}
              storyTitle={story.title}
              stepNumber={activeStepIndex}
              hasLayer2={false}
              objects={editorObjects}
              siteBaseUrl={siteBaseUrl}
              onOpenDoc={openDoc}
            />
          )}
        </ViewerColumn>
      }
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
