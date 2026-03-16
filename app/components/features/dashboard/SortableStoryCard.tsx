/**
 * SortableStoryCard — dnd-kit sortable wrapper for StoryCard.
 *
 * Wraps StoryCard with useSortable to enable drag-to-reorder within the
 * dashboard grid. Applies transform/transition styles from dnd-kit and
 * dims the card to 40% opacity while dragging.
 */

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { StoryCard } from "~/components/features/dashboard/StoryCard";

interface SortableStoryCardStory {
  id: number;
  story_id: string;
  title: string | null;
  subtitle: string | null;
  byline: string | null;
  private: boolean | null;
  draft: boolean | null;
  updated_at: string | null;
}

interface SortableStoryCardProps {
  story: SortableStoryCardStory;
  stepCount: number;
  lastSynced: string | null;
}

export function SortableStoryCard({ story, stepCount, lastSynced }: SortableStoryCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: story.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={isDragging ? "cursor-grabbing" : "cursor-grab"}
    >
      <StoryCard
        story={story}
        stepCount={stepCount}
        lastSynced={lastSynced}
      />
    </div>
  );
}
