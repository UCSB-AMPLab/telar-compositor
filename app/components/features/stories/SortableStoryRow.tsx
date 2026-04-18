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
import { useTranslation } from "react-i18next";
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

/**
 * The dnd-kit sortable identifier for a row. Stories created in the Y.Array
 * but not yet backfilled by snapshotToD1 carry `_id: null` — use the
 * client-generated `_temp_id` (UUID string) as the sortable id until the
 * canonical D1 id is assigned. For D1-mode rows, this is just `story.id`.
 */
type SortableId = string | number;

interface SortableStoryRowProps {
  story: SortableStoryRowStory;
  index: number;
  stepCount: number;
  onDelete: (story: SortableStoryRowStory) => void;
  onToggleDraft: (story: SortableStoryRowStory) => void;
  onTogglePrivate: (story: SortableStoryRowStory) => void;
  /** Stable identifier for dnd-kit — defaults to story.id, override when
   *  items may not yet have a D1 id (Yjs _temp_id fallback). */
  sortableId?: SortableId;
  /** When false, the delete button is disabled and shows deleteTooltip. */
  canDelete?: boolean;
  deleteTooltip?: string;
  /** When true, trash click calls onDelete directly (parent handles confirm). */
  skipInternalConfirm?: boolean;
  /** Optional extra className applied to the inner row (e.g. animations). */
  rowClassName?: string;
  /** Optional inline style on the row (e.g. --structural-highlight-color). */
  rowStyle?: React.CSSProperties;
}

export function SortableStoryRow({
  story,
  index,
  stepCount,
  onDelete,
  onToggleDraft,
  onTogglePrivate,
  sortableId,
  canDelete,
  deleteTooltip,
  skipInternalConfirm,
  rowClassName,
  rowStyle,
}: SortableStoryRowProps) {
  const { t } = useTranslation("stories");
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sortableId ?? story.id });

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
      aria-label={t("drag_reorder_aria")}
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
        canDelete={canDelete}
        deleteTooltip={deleteTooltip}
        skipInternalConfirm={skipInternalConfirm}
        rowClassName={rowClassName}
        rowStyle={rowStyle}
      />
    </div>
  );
}
