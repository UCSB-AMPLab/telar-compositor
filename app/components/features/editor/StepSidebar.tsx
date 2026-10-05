/**
 * This file renders the Story Editor's step list as the step line: the
 * story's narrative line, from the title card's square through a mark per
 * step and section card to the last row, with each step's layer panels
 * branching off it.
 *
 * The title card (step 0) heads the line and is not reorderable. Steps and
 * section cards (1-N) sit in a dnd-kit `SortableContext`, one
 * `SortableStepItem` each, reordered from the grip at the left of the row
 * with the mouse, touch or keyboard sensors every sortable list shares. A
 * drop reports the old and new positions and the new order of the stable
 * `keyFor` keys; the route persists it. Moves are announced by the row's
 * title and position, never its key. Which row is last is decided here,
 * from the current order, so the end of the line follows reorders and
 * deletes.
 *
 * "+ Add step" and "Add section title" follow the line.
 *
 * @version v1.5.0-beta
 */

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DndContext, closestCenter } from "@dnd-kit/core";
import type { Announcements, DragEndEvent, UniqueIdentifier } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { useSortableSensors } from "~/hooks/use-sortable-sensors";
import { GRIP_COLUMN_CLASS, SortableStepItem, useRowTitle } from "~/components/features/editor/SortableStepItem";
import { StepLineMark } from "~/components/features/editor/StepLineMark";
import { keyFor } from "~/lib/item-key";
import { useOverlayOpen } from "~/hooks/use-overlay-open";
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
  /** Position in the observed list — the shared `keyFor` last-resort fallback. */
  _yIndex?: number;
}

/**
 * Plain per-layer summary drawn as a branch beneath its parent step.
 * Computed in the route from the observed Yjs data (or the D1 fallback) and
 * passed down — the row never reads `_yMap`.
 */
export interface SidebarLayerSummary {
  layer_number: number;
  /** The layer's own title, which names its branch when it has one. */
  title?: string | null;
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
  /** Pre-computed map from object_id to MediaType, for the icon in each step's mark */
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
   * Per-step layer summaries for the layer branches, keyed by the step's
   * stable key (the shared tempId-first `keyFor`). Computed in the route;
   * the row renders plain data, never reading `_yMap`.
   */
  layersByStep?: Record<string, SidebarLayerSummary[]>;
  /** The site's `telar_language`, whose default labels title a layer with no title or label. */
  siteLang?: string | null;
  /** Navigate to a layer: select its step (1-based index) and open the layer. */
  onOpenLayer?: (stepIndex: number, layerNumber: number, opener: HTMLElement) => void;
  /** Which layer is currently open (for the active step) — drives the layer row highlight. */
  openLayerNumber?: number | null;
}

/**
 * The screen-reader messages for a move, naming the row by its title and its
 * position among the steps. dnd-kit reports the row over itself as soon as it
 * is picked up, so a position is announced only when it changes, or the
 * pick-up message would be replaced at once.
 */
function useStepLineAnnouncements(steps: SidebarStep[]): { announcements: Announcements; screenReaderInstructions: { draggable: string } } {
  const { t } = useTranslation("editor");
  const rowTitle = useRowTitle();
  const lastOver = useRef<UniqueIdentifier | null>(null);
  const keys = steps.map((s) => keyFor(s));
  const total = steps.length;
  const position = (id: UniqueIdentifier) => keys.indexOf(String(id)) + 1;
  const titleOf = (id: UniqueIdentifier) => {
    const step = steps[keys.indexOf(String(id))];
    return step ? rowTitle(step) : "";
  };
  const announce = (key: string, title: UniqueIdentifier, over: UniqueIdentifier) =>
    t(key, { title: titleOf(title), position: position(over), total });
  return {
    screenReaderInstructions: { draggable: t("step_line.drag_instructions") },
    announcements: {
      onDragStart: ({ active }) => {
        lastOver.current = active.id;
        return announce("step_line.picked_up", active.id, active.id);
      },
      onDragOver: ({ active, over }) => {
        if (!over || over.id === lastOver.current) return undefined;
        lastOver.current = over.id;
        return announce("step_line.moved", active.id, over.id);
      },
      onDragEnd: ({ active, over }) => announce("step_line.dropped", active.id, (over ?? active).id),
      onDragCancel: ({ active }) => announce("step_line.cancelled", active.id, active.id),
    },
  };
}

function TitleCardRow({ storyTitle, isActive, lineBelow, onSelect }: { storyTitle: string | null; isActive: boolean; lineBelow: boolean; onSelect: () => void }) {
  const { t } = useTranslation("editor");
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={isActive ? "step" : undefined}
      className={`w-full h-12 flex items-center text-left transition-colors ${isActive ? "bg-anil/20" : "hover:bg-gray-700"}`}
    >
      <span className={GRIP_COLUMN_CLASS} />
      <StepLineMark shape="title" selected={isActive} lineBelow={lineBelow} />
      <span className="min-w-0 pr-2">
        <span className="block font-heading font-semibold text-xs text-cream uppercase tracking-wider">
          {t("step.title_card_label")}
        </span>
        {storyTitle && <span className="block font-body text-xs text-fg-subtle truncate">{storyTitle}</span>}
      </span>
    </button>
  );
}

function rowClassFor(highlightColor: string | undefined, isFading: boolean): string | undefined {
  return [highlightColor ? "structural-highlight" : "", isFading ? "structural-fade-out" : ""]
    .filter(Boolean)
    .join(" ") || undefined;
}

function rowStyleFor(highlightColor: string | undefined): React.CSSProperties | undefined {
  return highlightColor
    ? ({ ["--structural-highlight-color" as never]: highlightColor } as React.CSSProperties)
    : undefined;
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
  siteLang,
}: StepSidebarProps) {
  const { t } = useTranslation("editor");
  const sensors = useSortableSensors();
  const accessibility = useStepLineAnnouncements(steps);
  // A drag counts as open: dnd-kit's Escape cancels it, and the same press
  // must not also close a layer panel.
  const [dragging, setDragging] = useState(false);
  useOverlayOpen(dragging);

  function handleDragEnd(event: DragEndEvent) {
    setDragging(false);
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
      <div className="flex-1 overflow-y-auto pt-1.5">
        <TitleCardRow
          storyTitle={storyTitle}
          isActive={activeStepIndex === 0}
          lineBelow={steps.length > 0}
          onSelect={() => onStepSelect(0)}
        />
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          accessibility={accessibility}
          onDragStart={() => setDragging(true)}
          onDragCancel={() => setDragging(false)}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={steps.map((s) => keyFor(s))}
            strategy={verticalListSortingStrategy}
          >
            {steps.map((step, idx) => {
              const key = keyFor(step);
              const highlightColor = highlightColorByKey?.[key];
              const stepIndex = idx + 1;
              const rowActive = activeStepIndex === stepIndex;
              return (
                <SortableStepItem
                  key={key}
                  sortableId={key}
                  step={step}
                  isActive={rowActive}
                  isLast={idx === steps.length - 1}
                  onClick={() => onStepSelect(stepIndex)}
                  onDelete={() => onDeleteStep(step)}
                  objectsByType={objectsByType}
                  canDelete={canDeleteStep ? canDeleteStep(step) : true}
                  deleteTooltip={deleteTooltip}
                  layers={layersByStep?.[key]}
                  siteLang={siteLang}
                  onOpenLayer={
                    onOpenLayer
                      ? (layerNumber: number, opener: HTMLElement) => onOpenLayer(stepIndex, layerNumber, opener)
                      : undefined
                  }
                  activeLayerNumber={rowActive ? openLayerNumber ?? null : null}
                  rowClassName={rowClassFor(highlightColor, fadingKeys?.has(key) ?? false)}
                  rowStyle={rowStyleFor(highlightColor)}
                />
              );
            })}
          </SortableContext>
        </DndContext>

        {/* Add step + Insert section break buttons */}
        <div className="mt-1.5 p-2.5 flex flex-col gap-1.5 border-t border-gray-700">
          <button
            type="button"
            onClick={onAddStep}
            className="w-full px-4 py-2 font-heading font-semibold text-xs text-charcoal bg-qolle hover:bg-qolle-deep rounded-full transition-colors uppercase tracking-wider"
          >
            {t("step.add_step")}
          </button>
          <button
            type="button"
            onClick={onAddSectionCard}
            className="w-full px-4 py-2 font-heading font-semibold text-xs text-cream bg-transparent border border-gray-600 hover:bg-gray-700 rounded-full transition-colors uppercase tracking-wider"
          >
            {t("step.add_section_break")}
          </button>
        </div>
      </div>
    </div>
  );
}
