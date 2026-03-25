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

interface StepSidebarProps {
  steps: Array<{ id: number; step_number: number; question: string | null; object_id?: string | null }>;
  storyTitle: string | null;
  activeStepIndex: number;
  onStepSelect: (index: number) => void;
  onReorderSteps: (orderedIds: number[]) => void;
  onAddStep: () => void;
  onDeleteStep: (step: { id: number; step_number: number; question: string | null }) => void;
  /** Pre-computed map from object_id to MediaType for media type badges */
  objectsByType?: Record<string, MediaType>;
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
}: StepSidebarProps) {
  const { t } = useTranslation("editor");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = steps.findIndex((s) => s.id === active.id);
    const newIndex = steps.findIndex((s) => s.id === over.id);
    const reordered = arrayMove(steps, oldIndex, newIndex);
    onReorderSteps(reordered.map((s) => s.id));
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
            items={steps.map((s) => s.id)}
            strategy={verticalListSortingStrategy}
          >
            {steps.map((step, idx) => (
              <SortableStepItem
                key={step.id}
                step={step}
                displayNumber={idx + 1}
                isActive={activeStepIndex === idx + 1}
                onClick={() => onStepSelect(idx + 1)}
                onDelete={() => onDeleteStep(step)}
                objectsByType={objectsByType}
              />
            ))}
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
