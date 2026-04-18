/**
 * SortablePageTab — a single draggable tab in the nav bar preview.
 *
 * Used for both page tabs and built-in nav items (Home, Objects, Glossary).
 * Uses useSortable from @dnd-kit/sortable. Touch target: h-[36px].
 */

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Trash2 } from "lucide-react";

interface SortablePageTabProps {
  sortableId: string;
  label: string;
  isSelected: boolean;
  onSelect: () => void;
  isBuiltin?: boolean;
  onDelete?: () => void;
  canDelete?: boolean;
}

export function SortablePageTab({
  sortableId,
  label,
  isSelected,
  onSelect,
  isBuiltin = false,
  onDelete,
  canDelete = true,
}: SortablePageTabProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sortableId });

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
      {...listeners}
      className={`group/tab h-[36px] flex items-center gap-1.5 font-body text-sm cursor-grab transition-colors whitespace-nowrap select-none ${
        isBuiltin ? "pl-3 pr-5" : "px-1.5"
      } ${
        isSelected && !isBuiltin
          ? "text-charcoal font-medium"
          : isBuiltin
            ? "text-gray-300"
            : "text-gray-500 hover:text-charcoal"
      } ${isDragging ? "cursor-grabbing" : ""}`}
      onClick={isBuiltin ? undefined : onSelect}
    >
      {label || "Untitled"}
      {!isBuiltin && onDelete && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (canDelete) onDelete();
          }}
          disabled={!canDelete}
          className="opacity-0 group-hover/tab:opacity-100 transition-opacity text-gray-300 hover:text-red-400 disabled:text-gray-200 disabled:cursor-not-allowed"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}
