/**
 * StepSidebar — step list panel for the story editor.
 *
 * Displays the title card (step 0, not reorderable) and all regular steps
 * (1-N) in a dnd-kit SortableContext for drag-to-reorder. Each step row is
 * a SortableStepItem with a GripVertical handle and a Trash2 delete button.
 * "+ Add step" button at the bottom appends a new step via onAddStep.
 *
 * When objectsByType is provided, SortableStepItem shows a media type badge
 * (Video/Music/Text icon) for non-image steps.
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
  question: string | null;
  object_id?: string | null;
  _tempId?: string | null;
  _createdBy?: number | null;
  _yMap?: unknown;
}

interface StepSidebarProps {
  steps: SidebarStep[];
  storyTitle: string | null;
  activeStepIndex: number;
  onStepSelect: (index: number) => void;
  /** Called with the dnd oldIndex/newIndex — positions in the steps array. */
  onReorderSteps: (oldIndex: number, newIndex: number, orderedIds: Array<string | number>) => void;
  onAddStep: () => void;
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
}

export function StepSidebar({
  steps,
  storyTitle,
  activeStepIndex,
  onStepSelect,
  onReorderSteps,
  onAddStep,
  onDeleteStep,
  objectsByType,
  canDeleteStep,
  deleteTooltip,
  highlightColorByKey,
  fadingKeys,
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
          activeStepIndex === 0 ? "bg-lavender/20" : "hover:bg-gray-700"
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
              return (
                <SortableStepItem
                  key={key}
                  sortableId={keyFor(step)}
                  step={step}
                  displayNumber={idx + 1}
                  isActive={activeStepIndex === idx + 1}
                  onClick={() => onStepSelect(idx + 1)}
                  onDelete={() => onDeleteStep(step)}
                  objectsByType={objectsByType}
                  canDelete={canDelete}
                  deleteTooltip={deleteTooltip}
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

        {/* Add step button */}
        <div className="pl-7 pr-3 py-3">
          <button
            type="button"
            onClick={onAddStep}
            className="w-full px-4 py-2 font-heading font-semibold text-sm text-charcoal bg-[#DAB95C] hover:bg-yellow-300 rounded-full transition-colors uppercase tracking-wider"
          >
            {t("step.add_step")}
          </button>
        </div>
      </div>
    </div>
  );
}
