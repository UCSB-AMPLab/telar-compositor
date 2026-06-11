/**
 * AddIiifDialog — two-step dialog for adding an external IIIF object.
 *
 * Step 1: URL entry with Fetch button.
 * Step 2: Editable metadata preview with object_id preview (auto-generated
 *         from title via slugify on the client, confirmed on the server).
 */

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "~/components/ui/Dialog";
import { slugify } from "~/lib/slugify";
import type { IiifFetchResult, IiifMetadata } from "~/lib/iiif.server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AddIiifConfirmPayload {
  manifestUrl: string;
  title: string;
  creator: string;
  description: string;
  source: string;
  credit: string;
  thumbnail: string;
  image_available: boolean;
  object_id: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  fetchResult: IiifFetchResult | null;
  onFetchUrl: (url: string) => void;
  onConfirm: (payload: AddIiifConfirmPayload) => void;
  isFetching: boolean;
  isAdding: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AddIiifDialog({
  open,
  onClose,
  fetchResult,
  onFetchUrl,
  onConfirm,
  isFetching,
  isAdding,
}: Props) {
  const { t } = useTranslation("objects");

  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [creator, setCreator] = useState("");
  const [description, setDescription] = useState("");
  const [source, setSource] = useState("");
  const [credit, setCredit] = useState("");
  const [thumbnail, setThumbnail] = useState("");
  const [hasIiifTiles, setHasIiifTiles] = useState(false);

  // Auto-populate fields when fetchResult arrives
  useEffect(() => {
    if (fetchResult?.ok) {
      const meta: IiifMetadata = fetchResult.metadata;
      setTitle(meta.title ?? "");
      setCreator(meta.creator ?? "");
      setDescription(meta.description ?? "");
      setSource(meta.source ?? "");
      setCredit(meta.credit ?? "");
      setThumbnail(meta.thumbnail ?? "");
      setHasIiifTiles(meta.image_available);
    }
  }, [fetchResult]);

  // Reset when dialog closes
  useEffect(() => {
    if (!open) {
      setUrl("");
      setTitle("");
      setCreator("");
      setDescription("");
      setSource("");
      setCredit("");
      setThumbnail("");
      setHasIiifTiles(false);
    }
  }, [open]);

  const previewSlug = title ? slugify(title) : "";
  const showPreview = fetchResult?.ok === true;
  const fetchError = fetchResult?.ok === false ? fetchResult.error : null;

  function errorMessage(code: string): string {
    if (code === "fetch_failed") return t("add_iiif_error_fetch");
    if (code === "not_iiif") return t("add_iiif_error_invalid");
    if (code === "parse_error") return t("add_iiif_error_parse");
    return t("add_iiif_error_fetch");
  }

  function handleConfirm() {
    if (!title.trim()) return;
    onConfirm({
      manifestUrl: url,
      title: title.trim(),
      creator: creator.trim(),
      description: description.trim(),
      source: source.trim(),
      credit: credit.trim(),
      thumbnail: thumbnail.trim(),
      image_available: hasIiifTiles,
      object_id: previewSlug,
    });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="max-w-lg w-full mx-4 p-0 overflow-hidden"
    >
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-100">
        <h2 className="font-heading font-semibold text-lg text-charcoal">
          {t("add_iiif_title")}
        </h2>
      </div>

      {/* Content */}
      <div className="max-h-[65vh] overflow-y-auto px-6 py-4 space-y-4">
        {/* URL entry */}
        <div>
          <label className="block font-body text-sm font-medium text-charcoal mb-1">
            {t("add_iiif_url_label")}
          </label>
          <div className="flex gap-2">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t("add_iiif_url_placeholder")}
              disabled={isFetching}
              className="flex-1 font-body text-sm border border-gray-200 rounded-lg px-3 py-2 text-charcoal disabled:bg-gray-50 disabled:text-gray-400"
            />
            <button
              type="button"
              onClick={() => {
                if (url.trim()) onFetchUrl(url.trim());
              }}
              disabled={isFetching || !url.trim()}
              className="inline-flex items-center gap-2 font-heading font-semibold text-sm bg-anil hover:bg-anil-hover text-charcoal rounded-full px-4 py-2 transition-colors uppercase tracking-wider disabled:bg-disabled disabled:text-fg-disabled whitespace-nowrap"
            >
              {isFetching ? (
                <>
                  <div className="w-4 h-4 border-2 border-charcoal border-t-transparent rounded-full animate-spin" />
                  {t("add_iiif_fetching")}
                </>
              ) : (
                t("add_iiif_fetch")
              )}
            </button>
          </div>

          {/* Fetch error */}
          {fetchError && (
            <p className="font-body text-sm text-red-600 mt-1.5">
              {errorMessage(fetchError)}
            </p>
          )}
        </div>

        {/* Metadata preview (step 2) */}
        {showPreview && (
          <div className="space-y-3">
            <h3 className="font-heading font-semibold text-sm text-charcoal">
              {t("add_iiif_preview")}
            </h3>

            {/* Thumbnail preview */}
            {thumbnail && (
              <img
                src={thumbnail}
                alt={title || "Thumbnail"}
                className="w-24 h-24 object-cover rounded-lg border border-gray-200"
              />
            )}

            {/* Title (required) */}
            <div>
              <label className="block font-body text-xs font-medium text-charcoal mb-1">
                {t("field_title")} <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                className="w-full font-body text-sm border border-gray-200 rounded-lg px-3 py-2 text-charcoal"
              />
              {!title.trim() && (
                <p className="font-body text-xs text-red-500 mt-0.5">
                  {t("field_title_required")}
                </p>
              )}
            </div>

            {/* Object ID preview (read-only) */}
            <div>
              <label className="block font-body text-xs font-medium text-charcoal mb-1">
                {t("upload_object_id")}
              </label>
              <code className="block font-mono text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                {previewSlug || "—"}
              </code>
            </div>

            {/* Creator */}
            <div>
              <label className="block font-body text-xs font-medium text-charcoal mb-1">
                {t("field_creator")}
              </label>
              <input
                type="text"
                value={creator}
                onChange={(e) => setCreator(e.target.value)}
                className="w-full font-body text-sm border border-gray-200 rounded-lg px-3 py-2 text-charcoal"
              />
            </div>

            {/* Description */}
            <div>
              <label className="block font-body text-xs font-medium text-charcoal mb-1">
                {t("field_description")}
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                className="w-full font-body text-sm border border-gray-200 rounded-lg px-3 py-2 text-charcoal resize-none"
              />
            </div>

            {/* Source */}
            <div>
              <label className="block font-body text-xs font-medium text-charcoal mb-1">
                {t("field_source")}
              </label>
              <input
                type="text"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                className="w-full font-body text-sm border border-gray-200 rounded-lg px-3 py-2 text-charcoal"
              />
            </div>

            {/* Credit */}
            <div>
              <label className="block font-body text-xs font-medium text-charcoal mb-1">
                {t("field_credit")}
              </label>
              <input
                type="text"
                value={credit}
                onChange={(e) => setCredit(e.target.value)}
                className="w-full font-body text-sm border border-gray-200 rounded-lg px-3 py-2 text-charcoal"
              />
            </div>

            {/* IIIF tiles badge (read-only) */}
            <div className="flex items-center gap-2">
              <span className="font-body text-xs font-medium text-charcoal">
                {t("field_image_available")}:
              </span>
              <span
                className={`font-body text-xs rounded-full px-2 py-0.5 ${
                  hasIiifTiles
                    ? "bg-green-100 text-green-700"
                    : "bg-gray-100 text-gray-500"
                }`}
              >
                {hasIiifTiles ? "Yes" : "No"}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-100 bg-gray-50">
        <button
          type="button"
          onClick={onClose}
          disabled={isAdding}
          className="font-heading font-semibold text-sm text-charcoal border border-charcoal rounded-full px-5 py-1.5 hover:bg-gray-50 transition-colors uppercase tracking-wider disabled:text-fg-disabled"
        >
          {t("add_iiif_cancel")}
        </button>
        {showPreview && (
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!title.trim() || isAdding}
            className="inline-flex items-center gap-2 font-heading font-semibold text-sm bg-anil hover:bg-anil-hover text-charcoal rounded-full px-5 py-1.5 transition-colors uppercase tracking-wider disabled:bg-disabled disabled:text-fg-disabled"
          >
            {isAdding && (
              <div className="w-4 h-4 border-2 border-charcoal border-t-transparent rounded-full animate-spin" />
            )}
            {t("add_iiif_confirm")}
          </button>
        )}
      </div>
    </Dialog>
  );
}
