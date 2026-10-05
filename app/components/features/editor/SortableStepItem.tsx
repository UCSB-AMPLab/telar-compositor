/**
 * This file renders one row of the Story Editor's step line, a dnd-kit
 * sortable item: a step or a section card, with the layer branches of a step
 * below it, which move with it.
 *
 * The row is three controls side by side. At the left, a grip button is the
 * drag activator: it is focusable, named after the row, and takes the
 * keyboard sensor's Space and Enter. Then the selection button, which holds
 * the row's mark on the line (`StepLineMark`) and its title, the step's
 * question. At the right, the delete button, shown on hover, disabled with
 * a tooltip where the row may not be deleted. A click on the grip never
 * selects, and a click on the title never drags.
 *
 * Layer rows are navigation only: each opens its layer with the row as the
 * opener. A layer is titled by its title, else its button label, else the
 * default label in the site's language (`panelHeading`), as the panel heads it.
 *
 * @version v1.5.0-beta
 */

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { detectMediaType } from "~/lib/media-type";
import { panelHeading } from "~/lib/panel-heading";
import type { MediaType } from "~/lib/media-type";
import type { SidebarLayerSummary } from "~/components/features/editor/StepSidebar";
import {
  StepLineBranch,
  StepLineMark,
  LAYER_BRANCH_CLASS,
  mediaTypeIcon,
  stepLineRowHeight,
} from "~/components/features/editor/StepLineMark";
import type { StepLineShape } from "~/components/features/editor/StepLineMark";

interface RowStep {
  id: number;
  step_number: number;
  kind?: "media" | "section";
  question: string | null;
  object_id?: string | null;
}

interface SortableStepItemProps {
  step: RowStep;
  isActive: boolean;
  /** The row is the last on the line, where a step's mark is the triangle. */
  isLast?: boolean;
  onClick: () => void;
  onDelete: () => void;
  /** Media type keyed by a step's `object` value, for the object the site shows for it. */
  objectsByType?: Record<string, MediaType>;
  /** Stable dnd-kit identifier — defaults to step.id, override with Yjs _temp_id. */
  sortableId?: string | number;
  /** When false, the delete button is disabled and shows deleteTooltip. */
  canDelete?: boolean;
  deleteTooltip?: string;
  /** Optional className applied to the row wrapper (animations). */
  rowClassName?: string;
  /** Optional inline style applied to the row wrapper (presence highlight). */
  rowStyle?: React.CSSProperties;
  /** This step's layers, drawn as branches off its line. */
  layers?: SidebarLayerSummary[];
  /** Navigate to a layer of this step (selects the step + opens the layer). */
  onOpenLayer?: (layerNumber: number, opener: HTMLElement) => void;
  /** Layer number currently open for this step (drives the layer row highlight). */
  activeLayerNumber?: number | null;
  /** The site's `telar_language`, whose default labels title a layer with no title or label. */
  siteLang?: string | null;
}

/** Width of the grip column, which the title and layer rows keep empty so the line stays aligned. */
export const GRIP_COLUMN_CLASS = "w-[18px] pointer-coarse:w-9 shrink-0";

/**
 * The object type a step's mark shows: the type of the object the site shows
 * for it, else what its `object` value alone says (no value is a text-only
 * step, any other value an image unless it names an audio file).
 */
export function stepMediaType(step: RowStep, objectsByType?: Record<string, MediaType>): MediaType {
  const value = step.object_id ?? null;
  return (value && objectsByType?.[value]) || detectMediaType(null, value);
}

/** The shape of a row's mark: a section is a ring wherever it sits, and the last step is the triangle. */
export function stepShape(isSection: boolean, isLast: boolean): StepLineShape {
  if (isSection) return "section";
  return isLast ? "end" : "step";
}

/** The title a row shows and is announced by: its question, else the placeholder for its kind. */
export function useRowTitle() {
  const { t } = useTranslation("editor");
  return (step: Pick<RowStep, "kind" | "question">) =>
    step.question || t(step.kind === "section" ? "step.section_no_heading_yet" : "step.no_question_yet");
}

function RowTitle({ isSection, isActive, title, mediaLabel }: { isSection: boolean; isActive: boolean; title: string; mediaLabel: string | null }) {
  if (isSection) {
    return (
      <span className="min-w-0 truncate pr-2 font-heading font-semibold text-xs uppercase tracking-[0.06em] text-cream">
        {title}
      </span>
    );
  }
  return (
    <span className={`min-w-0 truncate pr-2 font-body text-[13px] ${isActive ? "text-cream" : "text-fg-faint"}`}>
      {title}
      {mediaLabel && <span className="sr-only">, {mediaLabel}</span>}
    </span>
  );
}

function DeleteButton({ canDelete, deleteTooltip, onDelete }: { canDelete: boolean; deleteTooltip?: string; onDelete: () => void }) {
  const { t } = useTranslation("editor");
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (!canDelete) return;
        onDelete();
      }}
      disabled={!canDelete}
      title={!canDelete ? deleteTooltip : undefined}
      className={`opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 p-0.5 pointer-coarse:p-2 mr-1 shrink-0 transition-colors ${
        canDelete ? "text-gray-500 hover:text-red-400" : "text-gray-600 cursor-not-allowed"
      }`}
      aria-label={t("step.delete_aria")}
    >
      <Trash2 className="w-3.5 h-3.5" />
    </button>
  );
}

interface LayerRowsProps {
  layers: SidebarLayerSummary[];
  isActive: boolean;
  activeLayerNumber?: number | null;
  mainLine: boolean;
  onOpenLayer?: (layerNumber: number, opener: HTMLElement) => void;
  siteLang?: string | null;
}

function LayerRows({ layers, isActive, activeLayerNumber, mainLine, onOpenLayer, siteLang }: LayerRowsProps) {
  const sorted = [...layers].sort((a, b) => a.layer_number - b.layer_number);
  return (
    <>
      {sorted.map((layer, idx) => {
        const level: 1 | 2 = layer.layer_number === 2 ? 2 : 1;
        const stem = level === 1 && sorted.slice(idx + 1).some((l) => l.layer_number === 2);
        const selected = isActive && activeLayerNumber === layer.layer_number;
        return (
          // layer_number can collide — layerFromYMap defaults a missing
          // layer_number to 1 — and the summary carries no id, so the key
          // combines the number with the position.
          <button
            key={`${layer.layer_number}-${idx}`}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenLayer?.(layer.layer_number, e.currentTarget);
            }}
            className={`w-full h-[22px] flex items-center text-left whitespace-nowrap overflow-hidden transition-colors ${
              selected ? "bg-anil/20" : "hover:bg-gray-700"
            }`}
          >
            <span className={GRIP_COLUMN_CLASS} />
            <StepLineBranch level={level} mainLine={mainLine} stem={stem} />
            <span className={`min-w-0 truncate pr-2 font-body text-xs ${LAYER_BRANCH_CLASS[level]}`}>
              {panelHeading(level, layer.title, layer.button_label, siteLang)}
            </span>
          </button>
        );
      })}
    </>
  );
}

export function SortableStepItem({
  step,
  isActive,
  isLast = false,
  onClick,
  onDelete,
  objectsByType,
  sortableId,
  canDelete = true,
  deleteTooltip,
  rowClassName,
  rowStyle,
  layers,
  onOpenLayer,
  activeLayerNumber,
  siteLang,
}: SortableStepItemProps) {
  const { t } = useTranslation("editor");
  const rowTitle = useRowTitle();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: sortableId ?? step.id });

  const style: React.CSSProperties = {
    ...rowStyle,
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const isSection = step.kind === "section";
  const mediaType = isSection ? undefined : stepMediaType(step, objectsByType);
  const labelKey = mediaType ? mediaTypeIcon(mediaType).labelKey : null;
  const shape = stepShape(isSection, isLast);
  const layerRows = !isSection && layers && layers.length > 0 ? layers : null;
  const title = rowTitle(step);

  return (
    <div ref={setNodeRef} style={style} className={rowClassName}>
      <div
        className={`group flex items-center whitespace-nowrap overflow-hidden transition-colors ${
          isActive ? "bg-anil/20" : "hover:bg-gray-700"
        }`}
        style={{ height: stepLineRowHeight(shape) }}
      >
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={t("step_line.move_aria", { title })}
          onClick={(e) => e.stopPropagation()}
          className={`${GRIP_COLUMN_CLASS} h-full flex items-center justify-center pl-1 pointer-coarse:pl-0 cursor-grab touch-none transition-colors group-hover:text-cream pointer-coarse:text-cream ${
            isActive ? "text-cream/85" : "text-cream/40"
          }`}
        >
          <GripVertical className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onClick}
          aria-current={isActive ? "step" : undefined}
          className="flex-1 min-w-0 h-full flex items-center text-left"
        >
          <StepLineMark shape={shape} selected={isActive} mediaType={mediaType} lineBelow={!isLast || layerRows !== null} />
          <RowTitle isSection={isSection} isActive={isActive} title={title} mediaLabel={labelKey ? t(labelKey) : null} />
        </button>
        <DeleteButton canDelete={canDelete} deleteTooltip={deleteTooltip} onDelete={onDelete} />
      </div>
      {layerRows && (
        <LayerRows
          layers={layerRows}
          isActive={isActive}
          activeLayerNumber={activeLayerNumber}
          mainLine={!isLast}
          onOpenLayer={onOpenLayer}
          siteLang={siteLang}
        />
      )}
    </div>
  );
}
