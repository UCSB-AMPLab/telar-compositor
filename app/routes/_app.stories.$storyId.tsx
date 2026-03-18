/**
 * Story Editor — full three-column story editing route.
 *
 * Loader: fetches story by story_id slug, all its steps (ordered),
 *         layers for all steps, project objects for the object picker,
 *         and project config for constructing IIIF URLs.
 * Action: handles autosave intents for story fields (title, subtitle, byline),
 *         step fields (question, answer), capture-position, and change-object.
 * Component: wires EditorShell, StepSidebar, NarrativeColumn, and ViewerColumn.
 */

import { useState } from "react";
import { redirect, useFetcher } from "react-router";
import { and, eq, inArray, max } from "drizzle-orm";
import type { Route } from "./+types/_app.stories.$storyId";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { stories, steps, layers, objects, projects, project_config } from "~/db/schema";
import { createSessionStorage } from "~/lib/session.server";
import { EditorShell } from "~/components/features/editor/EditorShell";
import { StepSidebar } from "~/components/features/editor/StepSidebar";
import { NarrativeColumn } from "~/components/features/editor/NarrativeColumn";
import { ViewerColumn } from "~/components/features/editor/ViewerColumn";
import { LayerPanel } from "~/components/features/editor/LayerPanel";
import { DeleteStepDialog } from "~/components/features/editor/DeleteStepDialog";
import { useTranslation } from "react-i18next";

export const handle = { i18n: ["editor", "common"] };

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);

  // Read activeProjectId from session
  const sessionStorage = createSessionStorage(env.SESSION_SECRET);
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));
  const activeProjectId = session.get("activeProjectId") as number | undefined;

  if (!activeProjectId) throw redirect("/dashboard");

  // Verify the active project belongs to the user
  const projectRows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, Number(activeProjectId)), eq(projects.user_id, user.id)))
    .limit(1);

  if (projectRows.length === 0) throw redirect("/dashboard");

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

  return {
    story,
    steps: storySteps,
    layers: storyLayers,
    objects: projectObjects,
    siteBaseUrl,
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

  switch (intent) {
    case "autosave-story-field": {
      const field = formData.get("field") as string;
      const value = formData.get("value") as string;
      const entityId = Number(formData.get("entityId"));

      // Whitelist allowed fields
      const allowed = ["title", "subtitle", "byline"];
      if (!allowed.includes(field)) return { error: "Invalid field" };

      await db
        .update(stories)
        .set({ [field]: value, updated_at: now })
        .where(eq(stories.id, entityId));

      return { ok: true, intent };
    }

    case "autosave-step-field": {
      const field = formData.get("field") as string;
      const value = formData.get("value") as string;
      const entityId = Number(formData.get("entityId"));

      // Whitelist allowed fields
      const allowed = ["question", "answer"];
      if (!allowed.includes(field)) return { error: "Invalid field" };

      await db
        .update(steps)
        .set({ [field]: value, updated_at: now })
        .where(eq(steps.id, entityId));
      await touchStory();

      return { ok: true, intent };
    }

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

    case "add-step": {
      const storyId = Number(formData.get("storyId"));
      const maxRow = await db
        .select({ maxNum: max(steps.step_number) })
        .from(steps)
        .where(eq(steps.story_id, storyId))
        .get();
      const nextNumber = (maxRow?.maxNum ?? 0) + 1;
      await db.insert(steps).values({
        story_id: storyId,
        step_number: nextNumber,
        updated_at: now,
      });
      await touchStory();
      return { ok: true, intent: "add-step" };
    }

    case "delete-step": {
      const stepId = Number(formData.get("stepId"));
      await db.delete(layers).where(eq(layers.step_id, stepId));
      await db.delete(steps).where(eq(steps.id, stepId));
      await touchStory();
      return { ok: true, intent: "delete-step" };
    }

    case "reorder-steps": {
      const orderJson = formData.get("order") as string;
      const order: number[] = JSON.parse(orderJson);
      await Promise.all(
        order.map((id, idx) =>
          db
            .update(steps)
            .set({ step_number: idx + 1, updated_at: now })
            .where(eq(steps.id, id))
        )
      );
      await touchStory();
      return { ok: true, intent: "reorder-steps" };
    }

    case "create-layer": {
      const stepId = Number(formData.get("stepId"));
      const layerNumber = Number(formData.get("layerNumber")); // 1 or 2
      const buttonLabel = (formData.get("buttonLabel") as string) || null;
      await db.insert(layers).values({
        step_id: stepId,
        layer_number: layerNumber,
        title: buttonLabel,
        button_label: buttonLabel,
        content: "",
        updated_at: now,
      });
      await touchStory();
      return { ok: true, intent: "create-layer" };
    }

    case "save-layer": {
      const layerId = Number(formData.get("layerId"));
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
      const layerId = Number(formData.get("projectId"));
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

    case "delete-layer": {
      const layerId = Number(formData.get("layerId"));
      const stepId = Number(formData.get("stepId"));
      const layerToDelete = await db
        .select()
        .from(layers)
        .where(eq(layers.id, layerId))
        .get();
      if (layerToDelete?.layer_number === 1) {
        const layer2 = await db
          .select()
          .from(layers)
          .where(and(eq(layers.step_id, stepId), eq(layers.layer_number, 2)))
          .get();
        if (layer2) {
          return {
            error: "Cannot delete layer 1 while layer 2 exists",
            intent: "delete-layer",
          };
        }
      }
      await db.delete(layers).where(eq(layers.id, layerId));
      await touchStory();
      return { ok: true, intent: "delete-layer" };
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

export default function StoryEditorPage({ loaderData }: Route.ComponentProps) {
  const { story, steps: storySteps, layers: storyLayers, objects: projectObjects, siteBaseUrl } =
    loaderData;
  const { t } = useTranslation("editor");

  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [deletingStep, setDeletingStep] = useState<{
    id: number;
    step_number: number;
    question: string | null;
  } | null>(null);

  // Layer panel state — both can be open simultaneously (stacked)
  const [layer1Open, setLayer1Open] = useState(false);
  const [layer2Open, setLayer2Open] = useState(false);

  const captureFetcher = useFetcher();
  const changeObjectFetcher = useFetcher();
  const addStepFetcher = useFetcher();
  const deleteStepFetcher = useFetcher();
  const reorderFetcher = useFetcher();
  const layerFetcher = useFetcher();

  // activeStepIndex 0 = title card; 1+ = storySteps[activeStepIndex - 1]
  // storySteps includes step 0 from DB — we only pass steps with step_number > 0
  // to the sidebar. Filter out step 0 so sidebar shows only regular steps.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sidebarSteps = (storySteps as any[]).filter((s) => s.step_number > 0);
  const activeStep =
    activeStepIndex > 0 ? sidebarSteps[activeStepIndex - 1] ?? null : null;
  const activeLayers = activeStep
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? (storyLayers as any[]).filter((l) => l.step_id === activeStep.id)
    : [];

  const isStepZero = activeStepIndex === 0;
  const totalSteps = sidebarSteps.length;

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

  function handleAddStep() {
    addStepFetcher.submit(
      { intent: "add-step", storyId: String(story.id) },
      { method: "post" }
    );
  }

  function handleReorderSteps(orderedIds: number[]) {
    reorderFetcher.submit(
      { intent: "reorder-steps", order: JSON.stringify(orderedIds) },
      { method: "post" }
    );
  }

  function handleDeleteStepConfirm() {
    if (!deletingStep) return;
    deleteStepFetcher.submit(
      { intent: "delete-step", stepId: String(deletingStep.id) },
      { method: "post" }
    );
    setDeletingStep(null);
    // If the deleted step was active, go back to title card
    if (activeStepIndex > 0) setActiveStepIndex(0);
  }

  function handleCapturePosition(pos: { x: number; y: number; zoom: number; page: string }) {
    if (!activeStep) return;
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
    changeObjectFetcher.submit(
      { intent: "change-object", stepId: String(targetStep.id), objectId },
      { method: "post" }
    );
  }

  function handleCreateLayer(stepId: number, layerNumber: number, defaultLabel: string) {
    layerFetcher.submit(
      {
        intent: "create-layer",
        stepId: String(stepId),
        layerNumber: String(layerNumber),
        buttonLabel: defaultLabel,
      },
      { method: "post" }
    );
  }

  function handleDeleteLayer(layerId: number) {
    if (!activeStep) return;
    // Determine which layer is being deleted to close the right panel
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deletedLayer = (storyLayers as any[]).find((l) => l.id === layerId);
    layerFetcher.submit(
      { intent: "delete-layer", layerId: String(layerId), stepId: String(activeStep.id) },
      { method: "post" }
    );
    if (deletedLayer?.layer_number === 2) setLayer2Open(false);
    else { setLayer1Open(false); setLayer2Open(false); }
  }

  // Calculate layer count for the step pending deletion
  const deletingStepLayerCount = deletingStep
    ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (storyLayers as any[]).filter((l) => l.step_id === deletingStep.id).length
    : 0;

  // Layer 1 cannot be deleted while layer 2 exists for the same step
  const canDeleteLayer1 = (() => {
    if (!activeStep) return true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const layer2Exists = (storyLayers as any[]).some(
      (l) => l.step_id === activeStep.id && l.layer_number === 2
    );
    return !layer2Exists;
  })();

  // Whether layer 2 exists for the active step (used by LayerPanel layer-1 "Add panel" button)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasLayer2ForActiveStep = activeStep
    ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (storyLayers as any[]).some(
        (l) => l.step_id === activeStep.id && l.layer_number === 2
      )
    : false;

  // Get layer data for the active step
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const activeLayer1 = activeStep
    ? (storyLayers as any[]).find((l) => l.step_id === activeStep.id && l.layer_number === 1) ?? null
    : null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const activeLayer2 = activeStep
    ? (storyLayers as any[]).find((l) => l.step_id === activeStep.id && l.layer_number === 2) ?? null
    : null;

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
      sidebar={
        <StepSidebar
          steps={sidebarSteps}
          storyTitle={story.title}
          activeStepIndex={activeStepIndex}
          onStepSelect={(idx: number) => { setActiveStepIndex(idx); setLayer1Open(false); setLayer2Open(false); }}
          onReorderSteps={handleReorderSteps}
          onAddStep={handleAddStep}
          onDeleteStep={setDeletingStep}
        />
      }
      narrative={
        <NarrativeColumn
          activeStepIndex={activeStepIndex}
          story={story}
          activeStep={activeStep}
          layers={activeLayers}
          onOpenLayer={(layer) => {
            if (layer.layer_number === 1) setLayer1Open(true);
            else setLayer2Open(true);
          }}
          onCreateLayer={handleCreateLayer}
          actionUrl={`/stories/${story.slug}`}
        />
      }
      viewer={
        <ViewerColumn
          step={viewerStep}
          isStepZero={isStepZero}
          stepDisplayNumber={activeStepIndex}
          totalSteps={totalSteps}
          objects={pickerObjects}
          manifestUrl={manifestUrl}
          infoJsonUrl={infoJsonUrl}
          isSelfHosted={isSelfHosted}
          siteBaseUrl={siteBaseUrl}
          onCapturePosition={handleCapturePosition}
          onChangeObject={handleChangeObject}
        >
          {/* Layer 1 panel */}
          {activeLayer1 && (
            <LayerPanel
              layer={activeLayer1}
              open={layer1Open}
              onClose={() => { setLayer1Open(false); setLayer2Open(false); }}
              onDelete={handleDeleteLayer}
              actionUrl={`/stories/${story.slug}`}
              canDelete={canDeleteLayer1}
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
            />
          )}
          {/* Layer 2 panel — stacked on top of layer 1 */}
          {activeLayer2 && (
            <LayerPanel
              layer={activeLayer2}
              open={layer2Open}
              onClose={() => setLayer2Open(false)}
              onDelete={handleDeleteLayer}
              actionUrl={`/stories/${story.slug}`}
              canDelete={true}
              hasLayer2={false}
              objects={editorObjects}
            />
          )}
        </ViewerColumn>
      }
    />
    <DeleteStepDialog
      open={deletingStep !== null}
      onClose={() => setDeletingStep(null)}
      onConfirm={handleDeleteStepConfirm}
      step={deletingStep}
      layerCount={deletingStepLayerCount}
    />
    </>
  );
}
