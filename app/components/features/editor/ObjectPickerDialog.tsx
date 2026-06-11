/**
 * ObjectPickerDialog — modal dialog for selecting which object a step uses.
 *
 * Shows a searchable grid of object thumbnails. Filtering is in-memory
 * by title and object_id (case-insensitive). Clicking an item calls
 * onSelect(object_id) and closes the dialog.
 *
 * For self-hosted IIIF objects (no stored thumbnail), resolves thumbnails
 * from info.json via useIiifThumbnail.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ImageOff, Search } from "lucide-react";
import { Dialog } from "~/components/ui/Dialog";
import { useIiifThumbnail } from "~/lib/use-iiif-thumbnail";

interface ObjectInfo {
  object_id: string;
  title: string | null;
  thumbnail: string | null;
  image_available: boolean | null;
}

interface ObjectPickerDialogProps {
  open: boolean;
  onClose: () => void;
  onSelect: (objectId: string) => void;
  objects: ObjectInfo[];
  currentObjectId: string | null;
  siteBaseUrl: string | null;
}

/** Per-object card that resolves its own thumbnail when needed. */
function ObjectCard({
  obj,
  isSelected,
  siteBaseUrl,
  onSelect,
}: {
  obj: ObjectInfo;
  isSelected: boolean;
  siteBaseUrl: string | null;
  onSelect: (objectId: string) => void;
}) {
  const { t } = useTranslation("common");
  // For self-hosted objects without a stored thumbnail, resolve from info.json
  const needsResolve = !obj.thumbnail && obj.image_available && siteBaseUrl;
  const infoJsonUrl = needsResolve
    ? `${siteBaseUrl}/iiif/objects/${obj.object_id}/info.json`
    : null;
  const resolvedUrl = useIiifThumbnail(infoJsonUrl, 300);

  // Upscale stored IIIF thumbnails (from external manifests) that are too small
  const storedThumb = obj.thumbnail
    ? obj.thumbnail.replace(/\/full\/[^/]+\//, "/full/!400,400/")
    : null;
  const thumbSrc = storedThumb || resolvedUrl;

  return (
    <button
      type="button"
      onClick={() => onSelect(obj.object_id)}
      className={`group flex flex-col overflow-hidden rounded-lg border-2 text-left transition-colors hover:border-anil ${
        isSelected
          ? "border-anil bg-anil/10"
          : "border-gray-100 bg-white hover:bg-gray-50"
      }`}
    >
      {/* Thumbnail */}
      <div className="aspect-square w-full bg-gray-100 flex items-center justify-center overflow-hidden">
        {thumbSrc ? (
          <img
            src={thumbSrc}
            alt={obj.title ?? t("common:untitled")}
            className="w-full h-full object-cover"
          />
        ) : (
          <ImageOff className="w-8 h-8 text-gray-300" />
        )}
      </div>
      {/* Labels */}
      <div className="p-2">
        <p className="font-body text-xs font-medium text-charcoal truncate leading-tight">
          {obj.title || t("common:untitled")}
        </p>
        {obj.title && obj.title !== obj.object_id && (
          <p className="font-mono text-[10px] text-gray-400 truncate mt-0.5">
            {obj.object_id}
          </p>
        )}
      </div>
    </button>
  );
}

export function ObjectPickerDialog({
  open,
  onClose,
  onSelect,
  objects,
  currentObjectId,
  siteBaseUrl,
}: ObjectPickerDialogProps) {
  const { t } = useTranslation("editor");
  const [query, setQuery] = useState("");

  const filtered = objects.filter((o) => {
    const q = query.toLowerCase();
    return (
      o.title?.toLowerCase().includes(q) ||
      o.object_id.toLowerCase().includes(q)
    );
  });

  function handleSelect(objectId: string) {
    onSelect(objectId);
    onClose();
  }

  // Reset search when dialog opens/closes
  function handleClose() {
    setQuery("");
    onClose();
  }

  if (!open) return null;

  return (
    <Dialog open={open} onClose={handleClose} className="max-w-3xl p-0">
      {/* Header */}
      <div className="px-5 pt-5 pb-3 border-b border-gray-100">
        <h2 className="font-heading font-semibold text-charcoal text-base mb-3">
          {t("object_picker.title")}
        </h2>
        {/* Search input */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("object_picker.search_placeholder")}
            className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg font-body text-sm text-charcoal placeholder-gray-400"
            autoFocus
          />
        </div>
      </div>

      {/* Grid */}
      <div className="p-4 max-h-[75vh] overflow-y-auto">
        {objects.length === 0 ? (
          <p className="text-center font-body text-sm text-gray-400 py-8">
            {t("object_picker.no_objects")}
          </p>
        ) : filtered.length === 0 ? (
          <p className="text-center font-body text-sm text-gray-400 py-8">
            {t("object_picker.no_results")}
          </p>
        ) : (
          <div className="grid grid-cols-4 gap-3">
            {filtered.map((obj) => (
              <ObjectCard
                key={obj.object_id}
                obj={obj}
                isSelected={obj.object_id === currentObjectId}
                siteBaseUrl={siteBaseUrl}
                onSelect={handleSelect}
              />
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}
