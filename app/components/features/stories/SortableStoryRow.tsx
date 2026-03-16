/**
 * SortableStoryRow — dnd-kit sortable wrapper for StoryRow.
 *
 * Uses setActivatorNodeRef for a GripVertical drag handle so only the handle
 * initiates drag — the row body remains interactive (links, toggles, buttons).
 * Row container gets ref + attributes (NOT listeners); handle gets listeners.
 */

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { StoryRow } from "~/components/features/stories/StoryRow";

interface SortableStoryRowStory {
  id: number;
  story_id: string;
  title: string | null;
  subtitle: string | null;
  byline: string | null;
  private: boolean | null;
  draft: boolean | null;
  updated_at: string | null;
}

interface SortableStoryRowProps {
  story: SortableStoryRowStory;
  index: number;
  stepCount: number;
  onDelete: (story: SortableStoryRowStory) => void;
  onToggleDraft: (story: SortableStoryRowStory) => void;
  onTogglePrivate: (story: SortableStoryRowStory) => void;
}

export function SortableStoryRow({
  story,
  index,
  stepCount,
  onDelete,
  onToggleDraft,
  onTogglePrivate,
}: SortableStoryRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: story.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const dragHandle = (
    <button
      ref={setActivatorNodeRef}
      {...listeners}
      type="button"
      aria-label="Drag to reorder"
      className="cursor-grab touch-none text-gray-300 hover:text-gray-400 transition-colors"
    >
      <GripVertical className="w-4 h-4" />
    </button>
  );

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <StoryRow
        story={story}
        index={index}
        stepCount={stepCount}
        onDelete={onDelete}
        onToggleDraft={onToggleDraft}
        onTogglePrivate={onTogglePrivate}
        dragHandle={dragHandle}
      />
    </div>
  );
}
