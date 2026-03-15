/**
 * StoryCard — card displaying a single story in the dashboard grid.
 *
 * Shows title, subtitle, byline, step count badge, timestamp, edit button,
 * and delete icon.
 */

import { Trash2 } from "lucide-react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";

interface StoryCardStory {
  id: number;
  story_id: string;
  title: string | null;
  subtitle: string | null;
  byline: string | null;
  updated_at: string | null;
}

interface StoryCardProps {
  story: StoryCardStory;
  stepCount: number;
  className?: string;
}

function formatRelative(isoString: string | null): string {
  if (!isoString) return "";
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function StoryCard({ story, stepCount, className = "" }: StoryCardProps) {
  const { t } = useTranslation("dashboard");

  return (
    <div
      className={`bg-white rounded-xl shadow-sm border border-gray-100 p-4 flex flex-col gap-2 hover:shadow-md transition-shadow relative ${className}`}
    >
      {/* Delete button */}
      <button
        className="absolute top-3 right-3 text-gray-300 hover:text-red-400 transition-colors"
        aria-label="Delete story"
        type="button"
      >
        <Trash2 className="w-4 h-4" />
      </button>

      {/* Content */}
      <div className="pr-6">
        <h3 className="font-heading font-semibold text-charcoal leading-tight">
          {story.title || story.story_id}
        </h3>
        {story.subtitle && (
          <p className="text-gray-500 text-sm mt-0.5 truncate">{story.subtitle}</p>
        )}
        {story.byline && (
          <p className="text-gray-400 text-xs mt-0.5">{story.byline}</p>
        )}
      </div>

      {/* Step count badge */}
      <div className="flex items-center gap-2 mt-1">
        <span className="inline-flex items-center bg-cream-dark text-charcoal text-xs font-body rounded-full px-2 py-0.5">
          {t("story_card.steps", { count: stepCount })}
        </span>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between mt-auto pt-2">
        {story.updated_at ? (
          <span className="text-xs text-gray-400">
            {t("story_card.updated", { date: formatRelative(story.updated_at) })}
          </span>
        ) : (
          <span />
        )}
        <Link
          to="/stories"
          className="inline-flex items-center justify-center bg-periwinkle hover:bg-periwinkle-hover text-charcoal font-heading font-semibold text-xs uppercase tracking-wider rounded-full px-3 py-1 transition-colors"
        >
          {t("story_card.edit")}
        </Link>
      </div>
    </div>
  );
}
