/**
 * This file renders the dnd-kit sortable wrapper for a step in the
 * Story Editor sidebar — one row per step, draggable to reorder.
 *
 * The row renders the step QUESTION as its title, a step-kind glyph —
 * `Image` in a chilca-pale square for media, a `§` text glyph in a
 * cream-dark square for a section break (glyphs only; there is no
 * change-kind menu) — and a `GripVertical` drag handle that lives in a
 * fixed ~14px left gutter at 50% opacity, rising to 100% on hover. Drag
 * stays handle-only via `setActivatorNodeRef`. A `Trash2` delete button
 * is revealed on hover via the group-hover CSS pattern.
 *
 * @version v1.3.0-beta
 */

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Trash2, ImageIcon, Video, Music, FileText, Layers } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MediaType } from "~/lib/media-type";
import type { SidebarLayerSummary } from "~/components/features/editor/StepSidebar";

interface SortableStepItemProps {
  step: { id: number; step_number: number; kind?: "media" | "section"; question: string | null; object_id?: string | null };
  /** 1-indexed display number (position in list, not step_number from DB) */
  displayNumber: number;
  isActive: boolean;
  onClick: () => void;
  onDelete: () => void;
  /** Pre-computed map from object_id to MediaType */
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
  /** This step's layers, rendered as nested navigable L1/L2 sub-rows. */
  layers?: SidebarLayerSummary[];
  /** Navigate to a layer of this step (selects the step + opens the layer). */
  onOpenLayer?: (layerNumber: number) => void;
  /** Layer number currently open for this step (drives the sub-row highlight). */
  activeLayerNumber?: number | null;
}

function MediaTypeBadge({ mediaType }: { mediaType: MediaType }) {
  const { t } = useTranslation("editor");

  if (mediaType === "iiif") {
    return null; // No badge for standard image objects
  }

  let Icon: React.ComponentType<{ className?: string }>;
  let label: string;

  if (mediaType === "youtube" || mediaType === "vimeo" || mediaType === "google-drive") {
    Icon = Video;
    label = t("media.media_type_video");
  } else if (mediaType === "audio") {
    Icon = Music;
    label = t("media.media_type_audio");
  } else {
    // text-only
    Icon = FileText;
    label = t("media.media_type_text");
  }

  return (
    <span className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded-full bg-cream-dark/20 text-cream/60 text-[10px] font-body shrink-0">
      <Icon className="w-3 h-3" />
      <span>{label}</span>
    </span>
  );
}

export function SortableStepItem({
  step,
  displayNumber,
  isActive,
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
}: SortableStepItemProps) {
  const { t } = useTranslation("editor");
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sortableId ?? step.id });

  const style: React.CSSProperties = {
    ...rowStyle,
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const isSection = step.kind === "section";
  const mediaType =
    !isSection && step.object_id && objectsByType ? objectsByType[step.object_id] : undefined;

  const sortedLayers = layers
    ? [...layers].sort((a, b) => a.layer_number - b.layer_number)
    : [];
  const showSubRows = !isSection && sortedLayers.length > 0;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      className={`border-b border-gray-700 ${rowClassName ?? ""}`}
    >
    <div
      className={`group flex items-center gap-1 px-2 py-2 cursor-pointer transition-colors ${
        isActive ? "bg-anil/20" : "hover:bg-gray-700"
      }`}
      onClick={onClick}
    >
      {/* Drag handle — fixed ~14px gutter, always present.
          50% opacity at rest, full on row hover; drag stays handle-only. */}
      <div
        ref={setActivatorNodeRef}
        {...listeners}
        className="w-3.5 shrink-0 flex justify-center cursor-grab touch-none text-fg-subtle/50 group-hover:text-fg-subtle transition-colors"
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical className="w-3.5 h-3.5" />
      </div>

      {/* Step-kind glyph — glyphs only, no change-kind menu */}
      <div
        className={`w-5 h-5 shrink-0 rounded flex items-center justify-center ${
          isSection ? "bg-cream-dark" : "bg-chilca-pale"
        }`}
        aria-hidden="true"
      >
        {isSection ? (
          <span className="font-heading font-semibold text-sm text-charcoal leading-none">
            §
          </span>
        ) : (
          <ImageIcon className="w-3 h-3 text-charcoal" />
        )}
      </div>

      {/* Step title — the QUESTION text is the title */}
      <div className="flex-1 min-w-0">
        {isSection ? (
          <div className="font-heading font-semibold text-sm text-cream truncate">
            {step.question || t("step.section_no_heading_yet")}
          </div>
        ) : (
          <div className="flex items-center gap-1.5 min-w-0">
            <div className="font-heading font-semibold text-sm text-cream truncate">
              {step.question || t("step.no_question_yet")}
            </div>
            {mediaType && <MediaTypeBadge mediaType={mediaType} />}
          </div>
        )}
      </div>

      {/* Delete button — visible on hover; disabled with tooltip when canDelete is false */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (!canDelete) return;
          onDelete();
        }}
        disabled={!canDelete}
        title={!canDelete ? deleteTooltip : undefined}
        className={`opacity-0 group-hover:opacity-100 p-0.5 shrink-0 transition-colors ${
          canDelete
            ? "text-gray-500 hover:text-red-400"
            : "text-gray-600 cursor-not-allowed"
        }`}
        aria-label={t("step.delete_aria")}
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>

      {/* Nested L1/L2 layer sub-rows — navigation only, no delete.
          Indented under the step body with a connecting border-l. */}
      {showSubRows && (
        <div className="pl-7 pr-2 pb-1">
          {sortedLayers.map((layer, idx) => {
            const isLayer1 = layer.layer_number === 1;
            const subActive =
              isActive && activeLayerNumber === layer.layer_number;
            return (
              // layer_number can collide — layerFromYMap defaults a missing
              // layer_number to 1, so a malformed/legacy Y.Map could yield two
              // layers both numbered 1, dropping a row and logging a React
              // key-collision warning. SidebarLayerSummary carries no stable
              // id, so fall back to combining the number with the array index
              // for a unique key.
              <button
                key={`${layer.layer_number}-${idx}`}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenLayer?.(layer.layer_number);
                }}
                className={`group/sub w-full flex items-center gap-1.5 pl-2 py-1 border-l border-gray-600 text-left transition-colors ${
                  subActive ? "bg-anil/20" : "hover:bg-gray-700"
                }`}
              >
                <span className="font-mono text-[10px] text-cream/60 shrink-0">
                  {isLayer1 ? t("layer.marker_l1") : t("layer.marker_l2")}
                </span>
                <Layers
                  className={`w-3 h-3 shrink-0 ${
                    isLayer1 ? "text-anil-pale" : "text-terracotta-pale"
                  }`}
                  aria-hidden="true"
                />
                <span className="font-body text-xs text-gray-400 truncate">
                  {layer.button_label || t("layer.button_label")}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
