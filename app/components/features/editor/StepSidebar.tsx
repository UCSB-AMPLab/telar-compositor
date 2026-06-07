/**
 * This file renders the step-list sidebar of the Story Editor — the
 * left-hand panel that lists every step in the active story and
 * lets the user drag-reorder them.
 *
 * Displays the title card (step 0, not reorderable) and all regular
 * steps (1-N) in a dnd-kit `SortableContext`. Each step row is a
 * `SortableStepItem` with a `GripVertical` handle and a `Trash2`
 * delete button. A "+ Add step" button at the bottom appends a new
 * step via `onAddStep`.
 *
 * When `objectsByType` is provided, `SortableStepItem` shows a
 * media-type badge (Video/Music/Text icon) for non-image steps.
 *
 * @version v1.3.0-beta
 */

import { useTranslation } from "react-i18next";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { SortableStepItem } from "~/components/features/editor/SortableStepItem";
import type { MediaType } from "~/lib/media-type";

/**
 * Step as rendered by the sidebar. Yjs-mode steps carry `_tempId`,
 * `_createdBy`, and `_yMap` sentinels so the parent can compute
 * dnd-kit ids and permission state. Pre-existing D1-mode callers
 * pass only the numeric id. We intentionally accept `unknown` for
 * `_yMap` to avoid importing Y here; the caller passes it back into
 * its own ops.canDelete() closure.
 */
interface SidebarStep {
  id: number;
  step_number: number;
  kind?: "media" | "section";
  question: string | null;
  object_id?: string | null;
  _tempId?: string | null;
  _createdBy?: number | null;
  _yMap?: unknown;
}

/**
 * Plain per-layer summary rendered as a nested navigation sub-row beneath
 * its parent step. Computed in the route from the observed Yjs data (or the
 * D1 fallback) and passed down — the row never reads `_yMap`.
 */
export interface SidebarLayerSummary {
  layer_number: number;
  button_label: string | null;
}

interface StepSidebarProps {
  steps: SidebarStep[];
  storyTitle: string | null;
  activeStepIndex: number;
  onStepSelect: (index: number) => void;
  /** Called with the dnd oldIndex/newIndex — positions in the steps array. */
  onReorderSteps: (oldIndex: number, newIndex: number, orderedIds: Array<string | number>) => void;
  onAddStep: () => void;
  onAddSectionCard: () => void;
  onDeleteStep: (step: { id: number; step_number: number; question: string | null; _tempId?: string | null }) => void;
  /** Pre-computed map from object_id to MediaType for media type badges */
  objectsByType?: Record<string, MediaType>;
  /** Predicate evaluated per step — controls the delete button disabled state. */
  canDeleteStep?: (step: SidebarStep) => boolean;
  /** Tooltip shown when canDeleteStep returns false. */
  deleteTooltip?: string;
  /** Per-step highlight colour — keyed by sortableId. */
  highlightColorByKey?: Record<string, string>;
  /** Per-step fade-out flag — keyed by sortableId. */
  fadingKeys?: Set<string>;
  /**
   * Per-step layer summaries for the nested L1/L2 sub-rows, keyed by the
   * step's stable key (`id` when > 0, else `_tempId`). Computed in the route;
   * the row renders plain data, never reading `_yMap`.
   */
  layersByStep?: Record<string, SidebarLayerSummary[]>;
  /** Navigate to a layer: select its step (1-based index) and open the layer. */
  onOpenLayer?: (stepIndex: number, layerNumber: number) => void;
  /** Which layer is currently open (for the active step) — drives sub-row highlight. */
  openLayerNumber?: number | null;
}

export function StepSidebar({
  steps,
  storyTitle,
  activeStepIndex,
  onStepSelect,
  onReorderSteps,
  onAddStep,
  onAddSectionCard,
  onDeleteStep,
  objectsByType,
  canDeleteStep,
  deleteTooltip,
  highlightColorByKey,
  fadingKeys,
  layersByStep,
  onOpenLayer,
  openLayerNumber,
}: StepSidebarProps) {
  const { t } = useTranslation("editor");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  // Stable dnd-kit id per step: D1 id when available, `_temp_id` otherwise.
  const keyFor = (s: SidebarStep): string | number =>
    s.id > 0 ? s.id : s._tempId ?? `idx-${steps.indexOf(s)}`;

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const keys = steps.map((s) => keyFor(s));
    const oldIndex = keys.findIndex((k) => k === active.id);
    const newIndex = keys.findIndex((k) => k === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const reordered = arrayMove(steps, oldIndex, newIndex);
    onReorderSteps(oldIndex, newIndex, reordered.map((s) => keyFor(s)));
  }

  return (
    <div className="flex flex-col h-full">
      {/* Title card entry (step 0) — not reorderable */}
      <button
        type="button"
        onClick={() => onStepSelect(0)}
        className={`w-full text-left pl-7 pr-3 py-3 border-b border-gray-700 transition-colors ${
          activeStepIndex === 0 ? "bg-anil/20" : "hover:bg-gray-700"
        }`}
      >
        <p className="font-heading font-semibold text-sm text-cream uppercase tracking-wider">
          {t("step.title_card_label")}
        </p>
        {storyTitle && (
          <p className="font-body text-sm text-gray-400 mt-0.5 truncate">
            {storyTitle}
          </p>
        )}
      </button>

      {/* Regular steps — sortable */}
      <div className="flex-1 overflow-y-auto">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={steps.map((s) => keyFor(s))}
            strategy={verticalListSortingStrategy}
          >
            {steps.map((step, idx) => {
              const key = String(keyFor(step));
              const highlightColor = highlightColorByKey?.[key];
              const isFading = fadingKeys?.has(key) ?? false;
              const canDelete = canDeleteStep ? canDeleteStep(step) : true;
              const stepIndex = idx + 1;
              const rowActive = activeStepIndex === stepIndex;
              const layers = layersByStep?.[key];
              return (
                <SortableStepItem
                  key={key}
                  sortableId={keyFor(step)}
                  step={step}
                  displayNumber={stepIndex}
                  isActive={rowActive}
                  onClick={() => onStepSelect(stepIndex)}
                  onDelete={() => onDeleteStep(step)}
                  objectsByType={objectsByType}
                  canDelete={canDelete}
                  deleteTooltip={deleteTooltip}
                  layers={layers}
                  onOpenLayer={
                    onOpenLayer
                      ? (layerNumber: number) => onOpenLayer(stepIndex, layerNumber)
                      : undefined
                  }
                  activeLayerNumber={rowActive ? openLayerNumber ?? null : null}
                  rowClassName={
                    [
                      highlightColor ? "structural-highlight" : "",
                      isFading ? "structural-fade-out" : "",
                    ]
                      .filter(Boolean)
                      .join(" ") || undefined
                  }
                  rowStyle={
                    highlightColor
                      ? ({
                          ["--structural-highlight-color" as never]: highlightColor,
                        } as React.CSSProperties)
                      : undefined
                  }
                />
              );
            })}
          </SortableContext>
        </DndContext>

        {/* Add step + Insert section break buttons */}
        <div className="pl-7 pr-3 py-3">
          {/* Add step (primary, yellow) */}
          <button
            type="button"
            onClick={onAddStep}
            className="w-full px-4 py-2 font-heading font-semibold text-sm text-charcoal bg-qolle hover:bg-qolle-deep rounded-full transition-colors uppercase tracking-wider"
          >
            {t("step.add_step")}
          </button>

          {/* Insert section break (secondary, smaller, less visual weight) */}
          <button
            type="button"
            onClick={onAddSectionCard}
            className="mt-2 w-full px-4 py-1.5 font-heading font-medium text-xs text-cream/80 bg-transparent border border-gray-600 hover:bg-gray-700 hover:text-cream rounded-full transition-colors uppercase tracking-wider"
          >
            {t("step.add_section_break")}
          </button>
        </div>
      </div>
    </div>
  );
}
