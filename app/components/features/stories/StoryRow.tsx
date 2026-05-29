/**
 * StoryRow — a single row in the Stories list view.
 *
 * Shows story number, title, subtitle, byline, step count badge,
 * last-edited timestamp, draft/private Switch toggles, Edit link,
 * and trash icon. Reduced opacity when story is in draft.
 */

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Switch } from "~/components/ui/Switch";
import { DeleteStoryDialog } from "~/components/features/dashboard/DeleteStoryDialog";
import { useRelativeTime } from "~/lib/use-relative-time";

interface StoryRowStory {
  id: number;
  story_id: string;
  title: string | null;
  subtitle: string | null;
  byline: string | null;
  private: boolean | null;
  draft: boolean | null;
  updated_at: string | null;
}

interface StoryRowProps {
  story: StoryRowStory;
  index: number;
  stepCount: number;
  onDelete: (story: StoryRowStory) => void;
  onToggleDraft: (story: StoryRowStory) => void;
  onTogglePrivate: (story: StoryRowStory) => void;
  /** When true, renders as a lightweight drag overlay (no interactions). */
  isDragOverlay?: boolean;
  /** Drag handle slot — injected by SortableStoryRow. */
  dragHandle?: React.ReactNode;
  /** When false, the delete button is disabled and shows a tooltip. */
  canDelete?: boolean;
  /** Tooltip shown when the delete button is disabled. */
  deleteTooltip?: string;
  /** When true, trash click calls onDelete directly (parent handles confirm). */
  skipInternalConfirm?: boolean;
  /** Optional extra className applied to the row wrapper (e.g. animations). */
  rowClassName?: string;
  /** Optional inline style applied to the row wrapper (e.g. presence highlight). */
  rowStyle?: React.CSSProperties;
}

export function StoryRow({
  story,
  index,
  stepCount,
  onDelete,
  onToggleDraft,
  onTogglePrivate,
  isDragOverlay = false,
  dragHandle,
  canDelete = true,
  deleteTooltip,
  skipInternalConfirm = false,
  rowClassName,
  rowStyle,
}: StoryRowProps) {
  const { t } = useTranslation("stories");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const isDraft = story.draft ?? false;
  const isPrivate = story.private ?? false;
  // Client-only relative timestamp (see useRelativeTime); empty until mount.
  const updatedRelative = useRelativeTime(story.updated_at);

  return (
    <>
      <div
        style={rowStyle}
        className={`flex items-center gap-3 px-4 py-3 border-b border-gray-100 bg-white hover:bg-gray-50 transition-colors ${isDraft ? "opacity-75" : ""} ${isDragOverlay ? "shadow-lg rounded-lg" : ""} ${rowClassName ?? ""}`}
      >
        {/* Drag handle slot */}
        {dragHandle && (
          <div className="shrink-0 flex items-center">{dragHandle}</div>
        )}

        {/* Story number */}
        <span className="shrink-0 w-6 text-right font-body text-sm text-gray-400 select-none">
          {index + 1}
        </span>

        {/* Title + subtitle + byline */}
        <div className="flex-1 min-w-0">
          <p className="font-heading font-semibold text-charcoal truncate">
            {story.title || story.story_id}
          </p>
          {story.subtitle && (
            <p className="font-body text-sm text-gray-500 truncate">{story.subtitle}</p>
          )}
          {story.byline && (
            <p className="font-body text-xs text-gray-400 truncate">{story.byline}</p>
          )}
        </div>

        {/* Step count badge */}
        <span className="shrink-0 inline-flex items-center bg-cream-dark text-charcoal text-xs font-body rounded-full px-2 py-0.5">
          {t("story_row.steps", { count: stepCount })}
        </span>

        {/* Last edited */}
        {updatedRelative && (
          <span className="shrink-0 text-xs text-gray-400 hidden md:block mr-3">
            {t("story_row.updated", { date: updatedRelative })}
          </span>
        )}

        {/* Draft toggle */}
        {!isDragOverlay && (
          <div className="shrink-0 flex items-center gap-1.5">
            <span className="text-xs text-gray-500 hidden lg:block">
              {t("draft_toggle")}
            </span>
            <Switch
              checked={isDraft}
              onChange={() => onToggleDraft(story)}
              label={t("draft_toggle")}
            />
          </div>
        )}

        {/* Private toggle */}
        {!isDragOverlay && (
          <div className="shrink-0 flex items-center gap-1.5">
            <span className="text-xs text-gray-500 hidden lg:block">
              {t("private_toggle")}
            </span>
            <Switch
              checked={isPrivate}
              onChange={() => onTogglePrivate(story)}
              label={t("private_toggle")}
            />
          </div>
        )}

        {/* Edit button */}
        <Link
          to={`/stories/${story.story_id}`}
          onPointerDown={(e) => e.stopPropagation()}
          className="shrink-0 inline-flex items-center justify-center bg-periwinkle hover:bg-periwinkle-hover text-charcoal font-heading font-semibold text-xs uppercase tracking-wider rounded-full px-3 py-1 transition-colors"
        >
          {t("story_row.edit")}
        </Link>

        {/* Trash icon */}
        {!isDragOverlay && (
          <button
            type="button"
            aria-label={t("delete_story.title")}
            onClick={() => {
              if (!canDelete) return;
              if (skipInternalConfirm) onDelete(story);
              else setDeleteOpen(true);
            }}
            onPointerDown={(e) => e.stopPropagation()}
            disabled={!canDelete}
            title={!canDelete ? deleteTooltip : undefined}
            className={`shrink-0 transition-colors ${
              canDelete
                ? "text-gray-300 hover:text-red-400 cursor-pointer"
                : "text-gray-200 cursor-not-allowed"
            }`}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Internal delete confirmation dialog — bypassed when skipInternalConfirm is true */}
      {!isDragOverlay && !skipInternalConfirm && (
        <DeleteStoryDialog
          open={deleteOpen}
          onClose={() => setDeleteOpen(false)}
          onConfirm={() => {
            setDeleteOpen(false);
            onDelete(story);
          }}
          storyTitle={story.title ?? story.story_id}
          stepCount={stepCount}
        />
      )}
    </>
  );
}
