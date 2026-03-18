/**
 * SortableStepItem — dnd-kit sortable wrapper for a step in the sidebar.
 *
 * Follows the same pattern as SortableStoryRow: a GripVertical drag handle
 * using setActivatorNodeRef so only the handle initiates drag. Shows a
 * Trash2 delete button on hover. Both are hidden by default and revealed
 * via the group-hover CSS pattern.
 */

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Trash2 } from "lucide-react";

interface SortableStepItemProps {
  step: { id: number; step_number: number; question: string | null };
  /** 1-indexed display number (position in list, not step_number from DB) */
  displayNumber: number;
  isActive: boolean;
  onClick: () => void;
  onDelete: () => void;
}

export function SortableStepItem({
  step,
  displayNumber,
  isActive,
  onClick,
  onDelete,
}: SortableStepItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: step.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      className={`group flex items-center gap-1 px-2 py-2 cursor-pointer border-b border-gray-700 transition-colors ${
        isActive ? "bg-lavender/20" : "hover:bg-gray-700"
      }`}
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
        <div className="text-sm font-heading font-semibold text-cream">
          Step {displayNumber}
        </div>
        <div className="text-sm font-body text-gray-400 truncate">
          {step.question || "No question yet"}
        </div>
      </div>

      {/* Delete button — visible on hover */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-500 hover:text-red-400 shrink-0 transition-colors"
        aria-label="Delete step"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
