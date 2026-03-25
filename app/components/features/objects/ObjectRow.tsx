/**
 * ObjectRow — a single row in the Objects list view.
 *
 * Shows a thumbnail (or Package icon fallback), title (with object_id
 * below if different), source type badge (self-hosted vs external IIIF),
 * status badge derived from DB fields, featured star toggle, and an Edit
 * button that opens the side panel.
 */

import { Package, Server, Star, Video, Music } from "lucide-react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { deriveStatus } from "~/lib/iiif-types";
import { useIiifThumbnail } from "~/lib/use-iiif-thumbnail";
import { IiifLogo } from "~/components/ui/IiifLogo";
import { detectMediaType } from "~/lib/media-type";

export interface ObjectRowObject {
  id: number;
  object_id: string;
  title: string | null;
  featured: boolean | null;
  source_url: string | null;
  thumbnail: string | null;
  image_available: boolean | null;
  missing_from_repo: boolean | null;
}

interface ObjectRowProps {
  object: ObjectRowObject;
  onToggleFeatured: (object: ObjectRowObject) => void;
  /** Site base URL for constructing self-hosted IIIF thumbnail URLs */
  siteBaseUrl: string | null;
}

function StatusBadge({ status, objectId }: { status: ReturnType<typeof deriveStatus>; objectId?: string }) {
  const { t } = useTranslation("objects");

  const config: Record<
    ReturnType<typeof deriveStatus>,
    { label: string; dotClass: string; badgeClass: string }
  > = {
    ready: {
      label: t("status_ready"),
      dotClass: "bg-green-500",
      badgeClass: "bg-green-50 text-green-700",
    },
    no_metadata: {
      label: t("status_no_metadata"),
      dotClass: "bg-amber-400",
      badgeClass: "bg-amber-50 text-amber-700",
    },
    image_missing: {
      label: t("status_image_missing"),
      dotClass: "bg-amber-400",
      badgeClass: "bg-amber-50 text-amber-700 hover:bg-amber-100 cursor-pointer",
    },
    missing_from_repo: {
      label: t("status_missing_from_repo"),
      dotClass: "bg-red-500",
      badgeClass: "bg-red-50 text-red-700",
    },
  };

  const { label, dotClass, badgeClass } = config[status];

  const inner = (
    <>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
      {label}
    </>
  );

  // "Needs tiles" is actionable — link to object detail where Generate tiles lives
  if (status === "image_missing" && objectId) {
    return (
      <Link
        to={`/objects/${objectId}`}
        className={`shrink-0 inline-flex items-center gap-1.5 text-xs rounded-full px-2 py-0.5 transition-colors ${badgeClass}`}
      >
        {inner}
      </Link>
    );
  }

  return (
    <span
      className={`shrink-0 inline-flex items-center gap-1.5 text-xs rounded-full px-2 py-0.5 ${badgeClass}`}
    >
      {inner}
    </span>
  );
}

function SourceTypeBadge({ sourceUrl, objectId }: { sourceUrl: string | null; objectId: string }) {
  const { t } = useTranslation("objects");
  const mediaType = detectMediaType(sourceUrl, objectId);

  if (mediaType === "youtube" || mediaType === "vimeo" || mediaType === "google-drive") {
    return (
      <span className="shrink-0 inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-600 rounded-full px-2 py-0.5">
        <Video className="w-3 h-3" />
        {t("type_video")}
      </span>
    );
  }

  if (mediaType === "audio") {
    return (
      <span className="shrink-0 inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-600 rounded-full px-2 py-0.5">
        <Music className="w-3 h-3" />
        {t("type_audio")}
      </span>
    );
  }

  const isExternal =
    sourceUrl !== null &&
    (sourceUrl.startsWith("http://") || sourceUrl.startsWith("https://"));

  if (isExternal) {
    return (
      <span className="shrink-0 inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-600 rounded-full px-2 py-0.5">
        <IiifLogo className="w-3 h-3" />
        {t("type_external_iiif")}
      </span>
    );
  }

  return (
    <span className="shrink-0 inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-600 rounded-full px-2 py-0.5">
      <Server className="w-3 h-3" />
      {t("type_self_hosted")}
    </span>
  );
}

export function ObjectRow({ object, onToggleFeatured, siteBaseUrl }: ObjectRowProps) {
  const { t } = useTranslation("objects");
  const isFeatured = object.featured ?? false;
  const mediaType = detectMediaType(object.source_url, object.object_id);
  const isMedia = mediaType === "youtube" || mediaType === "vimeo" || mediaType === "google-drive" || mediaType === "audio";
  const hasExternalManifest = !!(object.source_url && /manifest/.test(object.source_url));
  const status = deriveStatus({
    title: object.title,
    image_available: object.image_available || hasExternalManifest,
    missing_from_repo: object.missing_from_repo,
    skipImageCheck: isMedia,
  });

  // Resolve thumbnail: stored URL for external IIIF, or fetch from
  // info.json for self-hosted (Level 0 — must use pre-generated sizes).
  const isExternal =
    object.source_url !== null &&
    (object.source_url.startsWith("http://") || object.source_url.startsWith("https://"));

  const selfHostedInfoUrl =
    !isExternal && siteBaseUrl && object.image_available
      ? `${siteBaseUrl}/iiif/objects/${object.object_id}/info.json`
      : null;

  const resolvedThumbnail = useIiifThumbnail(
    // Only fetch info.json if we don't already have a stored thumbnail
    object.thumbnail ? null : selfHostedInfoUrl
  );

  const thumbnailUrl = object.thumbnail ?? resolvedThumbnail;

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 bg-white hover:bg-gray-50 transition-colors">
      {/* Thumbnail */}
      <div className={`shrink-0 w-12 h-12 rounded-lg overflow-hidden flex items-center justify-center ${isMedia ? "bg-periwinkle" : "bg-gray-100"}`}>
        {isMedia ? (
          mediaType === "audio" ? (
            <Music className="w-5 h-5 text-charcoal/60" />
          ) : (
            <Video className="w-5 h-5 text-charcoal/60" />
          )
        ) : thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            alt={object.title ?? object.object_id}
            className="w-full h-full object-cover"
            onError={(e) => {
              // Replace with Package icon if thumbnail fails to load
              const parent = (e.target as HTMLElement).parentElement;
              if (parent) {
                (e.target as HTMLElement).style.display = "none";
              }
            }}
          />
        ) : (
          <Package className="w-5 h-5 text-gray-400" />
        )}
      </div>

      {/* Title block */}
      <div className="flex-1 min-w-0">
        <p className="font-heading font-semibold text-charcoal truncate">
          {object.title ?? object.object_id}
        </p>
        {object.title && object.title !== object.object_id && (
          <p className="font-body text-xs text-gray-400 truncate">
            {object.object_id}
          </p>
        )}
      </div>

      {/* Source type badge */}
      <SourceTypeBadge sourceUrl={object.source_url} objectId={object.object_id} />

      {/* Status badge */}
      <StatusBadge status={status} objectId={object.object_id} />

      {/* Featured star */}
      <button
        type="button"
        aria-label={isFeatured ? t("unmark_featured") : t("mark_featured")}
        onClick={() => onToggleFeatured(object)}
        className={`shrink-0 transition-colors ${
          isFeatured
            ? "text-amber-400 hover:text-amber-500"
            : "text-gray-300 hover:text-amber-400"
        }`}
      >
        <Star
          className="w-4 h-4"
          fill={isFeatured ? "currentColor" : "none"}
        />
      </button>

      {/* Edit link */}
      <Link
        to={`/objects/${object.object_id}`}
        className="shrink-0 inline-flex items-center justify-center bg-periwinkle hover:bg-periwinkle-hover text-charcoal font-heading font-semibold text-xs uppercase tracking-wider rounded-full px-3 py-1 transition-colors"
      >
        {t("edit_button")}
      </Link>
    </div>
  );
}
