/**
 * SortableStepItem — dnd-kit sortable wrapper for a step in the sidebar.
 *
 * Follows the same pattern as SortableStoryRow: a GripVertical drag handle
 * using setActivatorNodeRef so only the handle initiates drag. Shows a
 * Trash2 delete button on hover. Both are hidden by default and revealed
 * via the group-hover CSS pattern.
 *
 * Optionally displays a media type badge (Image/Video/Music/FileText icon)
 * when objectsByType is provided and the step has an object_id.
 */

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Trash2, ImageIcon, Video, Music, FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MediaType } from "~/lib/media-type";

interface SortableStepItemProps {
  step: { id: number; step_number: number; question: string | null; object_id?: string | null };
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

  const mediaType =
    step.object_id && objectsByType ? objectsByType[step.object_id] : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      className={`group flex items-center gap-1 px-2 py-2 cursor-pointer border-b border-gray-700 transition-colors ${
        isActive ? "bg-lavender/20" : "hover:bg-gray-700"
      } ${rowClassName ?? ""}`}
      onClick={onClick}
    >
      {/* Drag handle — visible on hover */}
      <div
        ref={setActivatorNodeRef}
        {...listeners}
        className="opacity-0 group-hover:opacity-100 cursor-grab shrink-0 touch-none"
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical className="w-3.5 h-3.5 text-gray-500" />
      </div>

      {/* Step label */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-heading font-semibold text-cream">
            {t("step.step_label", { number: displayNumber })}
          </span>
          {mediaType && <MediaTypeBadge mediaType={mediaType} />}
        </div>
        <div className="text-sm font-body text-gray-400 truncate">
          {step.question || t("step.no_question_yet")}
        </div>
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
  );
}
