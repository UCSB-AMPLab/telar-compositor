/**
 * Story Editor — full three-column story editing route.
 *
 * Loader: fetches story by story_id slug, all its steps (ordered),
 *         layers for all steps, project objects for the object picker,
 *         project config for constructing IIIF URLs, and team members
 *         (for delete-confirmation contributor warnings).
 * Action: handles capture-position, change-object, and save-layer only.
 *         Structural ops (add-step, add-section-card, delete-step,
 *         reorder-steps, create-layer, delete-layer) migrated to Yjs via
 *         useStructuralOps — snapshotToD1 reconciles Y.Array state back
 *         to D1 entity tables every 30 seconds.
 * Component: wires EditorShell, StepSidebar, NarrativeColumn or
 *            SectionCardView (depending on the active step's `kind`), and
 *            ViewerColumn. Reads steps/layers from the Y.Array when a
 *            Y.Doc is available, otherwise falls back to loader data.
 *            Also owns the per-story `show_sections` toggle that controls
 *            whether section headings appear as a TOC on the published
 *            title card.
 */

import { useState, useEffect, useRef } from "react";
import { redirect, useFetcher, useNavigate } from "react-router";
import { and, eq, inArray } from "drizzle-orm";
import type { Route } from "./+types/_app.stories.$storyId";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { stories, steps, layers, objects, project_config, project_members, users as usersTable } from "~/db/schema";
import { resolveActiveProject, requireProjectMember } from "~/lib/membership.server";
import { createSessionStorage } from "~/lib/session.server";
import { EditorShell } from "~/components/features/editor/EditorShell";
import { StepSidebar } from "~/components/features/editor/StepSidebar";
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

  // Helper: touch the story's updated_at so the stories list reflects recent edits
  async function touchStory() {
    await db
      .update(stories)
      .set({ updated_at: now })
      .where(eq(stories.story_id, params.storyId));
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

  switch (intent) {
    case "capture-position": {
      const stepId = Number(formData.get("stepId"));
      const x = parseFloat(formData.get("x") as string);
      const y = parseFloat(formData.get("y") as string);
      const zoom = parseFloat(formData.get("zoom") as string);
      const page = (formData.get("page") as string) || null;

      await db
        .update(steps)
        .set({ x, y, zoom, page, updated_at: now })
        .where(eq(steps.id, stepId));

      await touchStory();
      return { ok: true, intent: "capture-position" };
    }

    case "change-object": {
      const stepId = Number(formData.get("stepId"));
      const objectId = formData.get("objectId") as string;

      await db
        .update(steps)
        .set({ object_id: objectId, updated_at: now })
        .where(eq(steps.id, stepId));
      await touchStory();

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
      await touchStory();
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
      await touchStory();
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
    // Hydration always sets an explicit `kind` on each step Y.Map;
    // `?? "media"` guards against legacy Y.Maps from before sections shipped.
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
  const { ydoc, remoteCollaborators } = useCollaborationContext();
  const setAwarenessLocation = useSetAwarenessLocation();
  const ops = useStructuralOps(currentUserId, userRole);
  const { showToast } = useToast();
  const navigate = useNavigate();

  // Broadcast storyId to awareness so story card badges and header tooltips
  // can show which story this collaborator is editing.
  useEffect(() => {
    setAwarenessLocation({
      route: `/stories/${story.story_id}`,
      storyId: story.story_id,
      fieldKey: null,
    });
    return () => {
      setAwarenessLocation({
        route: location.pathname,
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

  const captureFetcher = useFetcher();
  const changeObjectFetcher = useFetcher();
  const clipFetcher = useFetcher();

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
    const deleterName = remoteCollaborators[0]?.user.name ?? "";
    if (activeKey && deletedKeys.includes(activeKey)) {
      const stepLabel = tStructural("entity_step", {
        number: activeStepIndex,
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
                  // The global TabNav Undo button / Ctrl+Z drives the shared
                  // UndoManager — no direct call here.
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
  // in app/routes/_app.stories.tsx — Y.Doc is the source of truth and
  // snapshotToD1 reconciles the boolean back to D1.
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
    // The "autosave-step-field" action handler does not exist; clip values
    // live only in the Y.Doc and reach D1 via snapshotToD1. In non-Yjs
    // fallback mode there is no save path, but useYjs is effectively always
    // true once the collab connection is up.
    if (useYjs && ydoc && activeStep._yMap) {
      const stepYMap = activeStep._yMap;
      ydoc.transact(() => {
        stepYMap.set(field, value);
      });
      return;
    }
    clipFetcher.submit(
      { intent: "autosave-step-field", field, value, entityId: String(activeStep.id) },
      { method: "post" }
    );
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
    clipFetcher.submit(
      { intent: "autosave-step-field", field: "loop", value, entityId: String(activeStep.id) },
      { method: "post" }
    );
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
          onStepSelect={(idx: number) => { setActiveStepIndex(idx); setLayer1Open(false); setLayer2Open(false); }}
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
        />
      }
      narrative={
        isSectionCard && activeStep ? (
          <SectionCardView
            step={{
              id: activeStep.id,
              step_number: activeStep.step_number,
              question: activeStep.question ?? null,
            }}
            storyId={String(story.story_id ?? story.id)}
            questionYText={questionYText}
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
              if (layer.layer_number === 1) setLayer1Open(true);
              else setLayer2Open(true);
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
              onClose={() => { setLayer1Open(false); setLayer2Open(false); }}
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
              onOpenLayer2={() => setLayer2Open(true)}
              objects={editorObjects}
              siteBaseUrl={siteBaseUrl}
              titleYText={getYText(activeLayer1._yMap, "title")}
              contentYText={getYText(activeLayer1._yMap, "content")}
              layer2ButtonLabelYText={getYText(activeLayer2?._yMap ?? null, "button_label")}
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
              onClose={() => setLayer2Open(false)}
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
              hasLayer2={false}
              objects={editorObjects}
              siteBaseUrl={siteBaseUrl}
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
