/**
 * ProjectStatusBar — project metadata bar shown above the story grid.
 *
 * Displays: repo name, last published, last synced, unpublished changes.
 */

import { Github } from "lucide-react";
import { useTranslation } from "react-i18next";

interface ProjectStatusBarProps {
  repoName: string;
  lastPublished: string | null;
  lastSynced: string | null;
  unpublishedCount: number;
  className?: string;
}

function formatRelative(isoString: string | null, neverLabel: string): string {
  if (!isoString) return neverLabel;
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) return "Just now";
  if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes !== 1 ? "s" : ""} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? "s" : ""} ago`;
  if (diffDays < 30) return `${diffDays} day${diffDays !== 1 ? "s" : ""} ago`;
  return date.toLocaleDateString();
}

export function ProjectStatusBar({
  repoName,
  lastPublished,
  lastSynced,
  unpublishedCount,
  className = "",
}: ProjectStatusBarProps) {
  const { t } = useTranslation("dashboard");
  const neverLabel = t("status_bar.never");

  return (
    <div
      className={`bg-white rounded-lg border border-gray-100 px-4 py-3 flex items-center justify-between text-sm font-body ${className}`}
    >
      <div className="flex items-center gap-2 text-charcoal font-medium">
        <Github className="w-4 h-4 text-gray-400" />
        <span>{repoName}</span>
      </div>

      <div className="flex items-center gap-6 text-gray-500">
        <div className="flex flex-col items-end sm:flex-row sm:items-center sm:gap-1">
          <span className="text-xs text-gray-400">{t("status_bar.last_published")}:</span>
          <span className="text-xs">{formatRelative(lastPublished, neverLabel)}</span>
        </div>
        <div className="flex flex-col items-end sm:flex-row sm:items-center sm:gap-1">
          <span className="text-xs text-gray-400">{t("status_bar.last_synced")}:</span>
          <span className="text-xs">{formatRelative(lastSynced, neverLabel)}</span>
        </div>
        {unpublishedCount > 0 && (
          <span className="text-xs bg-periwinkle text-charcoal rounded-full px-2 py-0.5">
            {t("status_bar.unpublished_changes", { count: unpublishedCount })}
          </span>
        )}
      </div>
    </div>
  );
}
