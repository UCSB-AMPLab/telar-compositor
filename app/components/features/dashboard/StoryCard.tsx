/**
 * StoryCard — card displaying a single story in the dashboard preview grid.
 *
 * Shows title, subtitle, byline, step count badge, timestamp, synced date,
 * private/draft indicators, and edit button. Draft and private indicators are
 * visual only on the dashboard — clicking them navigates to the Stories tab
 * for management actions. No delete action on dashboard.
 */

import { Lock, LockOpen, PenLine } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { useIiifThumbnail } from "~/lib/use-iiif-thumbnail";
import { formatRelative } from "~/lib/format-relative";
import { useCollaborationContext } from "~/hooks/use-collaboration";

interface StoryCardStory {
  id: number;
  story_id: string;
  title: string | null;
  subtitle: string | null;
  byline: string | null;
  private: boolean | null;
  draft: boolean | null;
  updated_at: string | null;
  thumbnail?: string | null;
}

interface StoryCardProps {
  story: StoryCardStory;
  stepCount: number;
  lastSynced: string | null;
  className?: string;
  isDragOverlay?: boolean;
  coverInfo?: { thumbnail: string | null; objectId: string; imageAvailable: boolean | null } | null;
  siteBaseUrl?: string | null;
}

export function StoryCard({ story, stepCount, lastSynced, className = "", isDragOverlay = false, coverInfo, siteBaseUrl }: StoryCardProps) {
  const { t } = useTranslation("dashboard");
  const { t: tCollab } = useTranslation("collaboration");
  const navigate = useNavigate();
  const isPrivate = story.private ?? false;
  const isDraft = story.draft ?? false;

  const { remoteCollaborators } = useCollaborationContext();
  const storyCollaborators = remoteCollaborators.filter(
    (c) => c.location?.storyId === story.story_id
  );

  // Resolve cover thumbnail from step-1 object (same pattern as ObjectPickerDialog)
  const needsResolve = coverInfo && !coverInfo.thumbnail && coverInfo.imageAvailable && siteBaseUrl;
  const infoJsonUrl = needsResolve
    ? `${siteBaseUrl}/iiif/objects/${coverInfo!.objectId}/info.json`
    : null;
  const resolvedUrl = useIiifThumbnail(infoJsonUrl, 300);

  // Upscale stored IIIF thumbnails
  const storedThumb = coverInfo?.thumbnail
    ? coverInfo.thumbnail.replace(/\/full\/[^/]+\//, "/full/!400,400/")
    : null;
  const thumbSrc = story.thumbnail || storedThumb || resolvedUrl;

  return (
    <div
      className={`bg-white rounded-xl shadow-sm border border-gray-100 p-4 flex flex-col gap-2 hover:shadow-md transition-shadow relative ${isDraft ? "opacity-75" : ""} ${className}`}
    >
      {/* Thumbnail */}
      <div className="aspect-square bg-cream-dark rounded-lg overflow-hidden -mx-4 -mt-4 mb-1 relative">
        {thumbSrc ? (
          <img
            src={thumbSrc}
            alt={story.title || story.story_id}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-300 text-xs font-body">
            No image
          </div>
        )}
        {storyCollaborators.length > 0 && (
          <div className="absolute bottom-2 left-2 flex items-center">
            {storyCollaborators.slice(0, 3).map((collab, i) => (
              <img
                key={collab.clientId}
                src={`https://avatars.githubusercontent.com/u/${collab.user.githubId}?s=40`}
                alt={collab.user.name}
                aria-label={tCollab("presence_card_badge_aria", { name: collab.user.name })}
                className={`w-5 h-5 rounded-full object-cover${i > 0 ? " -ml-1" : ""}`}
                style={{ outline: `1.5px solid ${collab.user.color}`, outlineOffset: "0.5px" }}
              />
            ))}
            {storyCollaborators.length > 3 && (
              <span className="ml-1 font-body text-[10px] text-charcoal">
                +{storyCollaborators.length - 3}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Content */}
      <div>
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-heading font-semibold text-charcoal leading-tight">
            {story.title || story.story_id}
          </h3>
          <div className="flex items-center gap-1.5 flex-shrink-0 mt-0.5">
            <button
              className={`transition-colors ${isDraft ? "text-amber-400 hover:text-amber-500" : "text-gray-200 hover:text-amber-400"}`}
              aria-label={t("story_card.mark_draft")}
              title={t("story_card.mark_draft")}
              type="button"
              onClick={() => navigate("/stories")}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <PenLine className="w-3.5 h-3.5" />
            </button>
            <button
              className={`transition-colors ${isPrivate ? "text-charcoal hover:text-gray-500" : "text-gray-200 hover:text-charcoal"}`}
              aria-label={t("story_card.make_private")}
              title={t("story_card.make_private")}
              type="button"
              onClick={() => navigate("/stories")}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {isPrivate ? <Lock className="w-3.5 h-3.5" /> : <LockOpen className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
        {story.subtitle && (
          <p className="text-gray-500 text-sm mt-0.5">{story.subtitle}</p>
        )}
        {story.byline && (
          <p className="text-gray-400 text-xs mt-0.5">{story.byline}</p>
        )}
      </div>

      {/* Badges */}
      <div className="flex items-center gap-2 mt-1">
        <span className="inline-flex items-center bg-cream-dark text-charcoal text-xs font-body rounded-full px-2 py-0.5">
          {t("story_card.steps", { count: stepCount })}
        </span>
        {isDraft && (
          <span className="inline-flex items-center bg-amber-100 text-amber-700 text-xs font-body rounded-full px-2 py-0.5">
            {t("story_card.draft_badge")}
          </span>
        )}
        {isPrivate && (
          <span className="inline-flex items-center bg-gray-100 text-gray-500 text-xs font-body rounded-full px-2 py-0.5">
            {t("story_card.private_badge")}
          </span>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between mt-auto pt-2">
        <div className="flex flex-col">
          {story.updated_at && (
            <span className="text-xs text-gray-400">
              {t("story_card.updated", { date: formatRelative(story.updated_at) })}
            </span>
          )}
          {lastSynced && (
            <span className="text-xs text-gray-300">
              {t("story_card.synced", { date: formatRelative(lastSynced) })}
            </span>
          )}
        </div>
        <Link
          to={`/stories/${story.story_id}`}
          onPointerDown={(e) => e.stopPropagation()}
          className="inline-flex items-center justify-center bg-periwinkle hover:bg-periwinkle-hover text-charcoal font-heading font-semibold text-xs uppercase tracking-wider rounded-full px-3 py-1 transition-colors"
        >
          {t("story_card.edit")}
        </Link>
      </div>
    </div>
  );
}
