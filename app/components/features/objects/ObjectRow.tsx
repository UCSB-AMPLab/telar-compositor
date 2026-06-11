/**
 * ObjectRow — a single row in the Objects list view.
 *
 * The row is deliberately spare: a featured star (caracol when filled,
 * fg-faint when hollow), a 56×56 square thumbnail that falls back to a
 * media or Package icon, the title with its monospace object_id, the year,
 * a "used in" line, and an open-arrow. There is no separate Type badge —
 * the thumbnail tile already carries the Video/Music/Package icon, so the
 * media kind reads at a glance.
 *
 * What the row does surface is an actionable Status signal: "Needs tiles"
 * links through to where tile generation lives, and "Missing from repo"
 * flags objects whose files have gone. A per-row delete affordance sits
 * beside the open-arrow — hidden until hover, gated by canDelete, and
 * wired to the route's existing DeleteConfirmationModal flow through the
 * onDelete prop.
 */

import { Package, Star, Video, Music, Trash2, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { deriveStatus } from "~/lib/iiif-types";
import { useIiifThumbnail } from "~/lib/use-iiif-thumbnail";
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
  /**
   * Year string (the data model stores year as text), rendered in the year
   * column. Optional so the route's existing Y.Map / D1 object construction
   * typechecks without change while the year is wired through from the Y.Map.
   */
  year?: string | null;
}

interface ObjectRowProps {
  object: ObjectRowObject;
  onToggleFeatured: (object: ObjectRowObject) => void;
  /** Site base URL for constructing self-hosted IIIF thumbnail URLs */
  siteBaseUrl: string | null;
  /**
   * Display-only thumbnail URL resolved server-side from the object's external
   * IIIF manifest (loader enrichment). Used when the collaborative Y.Doc copy of
   * the object has no thumbnail — which it never does for external IIIF, since
   * the Y.Doc is seeded from D1 without the thumbnail column. Just a URL string
   * (points at the external IIIF server); nothing is hosted or persisted here.
   */
  fallbackThumbnail?: string | null;
  /**
   * How many story steps reference this object (from the objects loader's
   * `objectStepCounts`, keyed by object_id). Renders a read-only
   * "Used in N steps" / "Unused" line — no toggle, no mutation.
   */
  usedInSteps?: number;
  /**
   * Per-row delete affordance. When provided, a hover-revealed delete button
   * renders beside the open-arrow; the route wires this to its existing
   * DeleteConfirmationModal flow. When omitted, no delete button renders.
   */
  onDelete?: () => void;
  /**
   * Gate for the delete affordance (convenor + not-in-use). When false the
   * delete button renders visible-but-disabled with the deleteTooltip. Defaults
   * to true when an onDelete handler is supplied.
   */
  canDelete?: boolean;
  /** Tooltip shown on the disabled delete button (e.g. "in use, cannot delete"). */
  deleteTooltip?: string;
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

export function ObjectRow({
  object,
  onToggleFeatured,
  siteBaseUrl,
  fallbackThumbnail,
  usedInSteps,
  onDelete,
  canDelete = true,
  deleteTooltip,
}: ObjectRowProps) {
  const { t } = useTranslation("objects");
  const [imgFailed, setImgFailed] = useState(false);
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

  // `||` (not `??`) so an empty-string Y.Doc thumbnail falls through to the
  // server-resolved fallback (external IIIF) or the self-hosted info.json result.
  const thumbnailUrl = object.thumbnail || fallbackThumbnail || resolvedThumbnail;

  return (
    <div className="group flex items-center gap-3 px-4 py-3 border-b border-gray-100 bg-white hover:bg-gray-50 transition-colors">
      {/* Featured star (leftmost) — caracol when filled, fg-faint when hollow */}
      <button
        type="button"
        aria-label={isFeatured ? t("unmark_featured") : t("mark_featured")}
        onClick={() => onToggleFeatured(object)}
        className={`shrink-0 transition-colors ${
          isFeatured
            ? "text-caracol hover:text-caracol"
            : "text-fg-faint hover:text-caracol"
        }`}
      >
        <Star
          className="w-4 h-4"
          fill={isFeatured ? "currentColor" : "none"}
        />
      </button>

      {/* Thumbnail — 56×56 square; the media icon here is why the Type badge is dropped */}
      <div className={`shrink-0 w-14 h-14 rounded-lg overflow-hidden flex items-center justify-center ${isMedia ? "bg-anil" : "bg-gray-100"}`}>
        {isMedia ? (
          mediaType === "audio" ? (
            <Music className="w-5 h-5 text-charcoal/60" />
          ) : (
            <Video className="w-5 h-5 text-charcoal/60" />
          )
        ) : thumbnailUrl && !imgFailed ? (
          <img
            src={thumbnailUrl}
            alt={object.title ?? t("common:untitled")}
            className="w-full h-full object-cover"
            // Fall through to the Package icon if the thumbnail fails to load
            onError={() => setImgFailed(true)}
          />
        ) : (
          <Package className="w-5 h-5 text-gray-400" />
        )}
      </div>

      {/* Title block — title + mono object_id + used-in line */}
      <div className="flex-1 min-w-0">
        <p className="font-heading font-semibold text-charcoal truncate">
          {object.title ?? t("common:untitled")}
        </p>
        {object.title && object.title !== object.object_id && (
          <p className="font-mono text-xs text-gray-400 truncate">
            {object.object_id}
          </p>
        )}
        {/* Read-only "Used in N steps" line. Source: the objects loader's
            objectStepCounts. No toggle, no mutation. */}
        {usedInSteps !== undefined &&
          (usedInSteps > 0 ? (
            <p className="font-body text-xs text-chilca-deep flex items-center gap-1.5">
              <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0 bg-chilca" />
              {t("used_in_n", { count: usedInSteps })}
            </p>
          ) : (
            <p className="font-body text-xs italic text-fg-subtle">
              {t("unused")}
            </p>
          ))}
      </div>

      {/* Year column */}
      <span className="shrink-0 w-16 text-right font-body text-xs text-gray-500 tabular-nums">
        {object.year ?? ""}{/* empty when year absent/null */}
      </span>

      {/* Status badge — retained actionable signal */}
      <StatusBadge status={status} objectId={object.object_id} />

      {/* Per-row delete — hover-revealed, canDelete-gated. */}
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          disabled={!canDelete}
          title={!canDelete ? deleteTooltip : undefined}
          aria-label={t("delete_button")}
          className="shrink-0 text-terracotta hover:text-terracotta/80 opacity-0 group-hover:opacity-100 focus:opacity-100 disabled:text-gray-300 disabled:cursor-not-allowed disabled:opacity-100 transition-all"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      )}

      {/* Open arrow — opens the object detail / edit panel */}
      <Link
        to={`/objects/${object.object_id}`}
        aria-label={t("edit_button")}
        className="shrink-0 inline-flex items-center justify-center text-gray-400 hover:text-charcoal transition-colors"
      >
        <ChevronRight className="w-5 h-5" />
      </Link>
    </div>
  );
}
