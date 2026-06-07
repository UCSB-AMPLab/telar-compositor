/**
 * AddObjectDialog — unified three-tab dialog for adding objects.
 *
 * One dialog, three tabs:
 *   - IIIF manifest   : two-step fetch → metadata flow (folded from AddIiifDialog),
 *                       sharing the metadata block; raises an IIIF confirm payload
 *                       extended with `year`.
 *   - Upload image    : the per-file staged-queue flow preserved as-is, hidden
 *                       for collaborators. Raises UploadImageConfirmPayload[].
 *   - External media  : the shared metadata block + a single URL input with
 *                       ~250 ms debounced recognition via detectMediaType.
 *                       The recognised-state pill is TEXT ONLY — the user-entered
 *                       URL never becomes a live href/src, to avoid injecting an
 *                       attacker-controlled URL into the page. No poster subsystem.
 *
 * The shared metadata block (Title* / Creator / Description / Year / read-only
 * derived Slug) applies to the IIIF + External tabs only — the Upload tab keeps
 * its own per-file metadata.
 *
 * The last-used tab persists to localStorage per project, SSR-safe (try/catch,
 * read-on-mount / write-on-change). The restored value is guarded against role
 * so a collaborator never lands on the Upload tab.
 *
 * Tab labels collapse to a <select> below ~520px via Tailwind prefixes.
 *
 * This dialog RAISES payloads via callback props; it does NOT call Yjs ops
 * directly (the route's handlers do that), mirroring the existing AddIiifDialog
 * / UploadImageDialog contract.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Upload, ChevronLeft, X } from "lucide-react";
import { Dialog } from "~/components/ui/Dialog";
import { slugify } from "~/lib/slugify";
import { detectMediaType, type MediaType } from "~/lib/media-type";
import { ACCEPTED_TYPES, MAX_SIZE_BYTES } from "~/lib/upload-constants";
import type { IiifFetchResult, IiifMetadata } from "~/lib/iiif-types";
import type { UploadImageConfirmPayload } from "./UploadImageDialog";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AddObjectTab = "iiif" | "upload" | "external";

/** IIIF confirm payload — mirrors AddIiifConfirmPayload, EXTENDED with `year`. */
export interface AddObjectIiifPayload {
  manifestUrl: string;
  title: string;
  creator: string;
  description: string;
  source: string;
  credit: string;
  thumbnail: string;
  image_available: boolean;
  object_id: string;
  year: string;
}

/** External-media confirm payload — the IIIF single-object shape minus manifest specifics. */
export interface AddObjectExternalPayload {
  title: string;
  creator: string;
  description: string;
  year: string;
  sourceUrl: string;
  object_id: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Project id — keys the per-project last-used-tab localStorage entry. */
  projectId: number | string;
  /** Convenor gate — hides the Upload tab + guards the restored tab. */
  isConvenor: boolean;

  // --- IIIF tab ---
  fetchResult: IiifFetchResult | null;
  onFetchUrl: (url: string) => void;
  onIiifConfirm: (payload: AddObjectIiifPayload) => void;
  isFetching: boolean;

  // --- Upload tab ---
  onUploadConfirm: (payloads: UploadImageConfirmPayload[]) => void;
  isUploading: boolean;
  uploadError: string | null;
  existingObjectIds: string[];

  // --- External-media tab ---
  onExternalConfirm: (payload: AddObjectExternalPayload) => void;

  /** Generic adding spinner shared by IIIF + External confirm buttons. */
  isAdding: boolean;
}

const TAB_STORAGE_PREFIX = "telar-compositor:objects-add-tab:";

const inputClass =
  "w-full font-body text-sm border border-gray-200 rounded-lg px-3 py-2 text-charcoal disabled:bg-gray-50 disabled:text-gray-400";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AddObjectDialog({
  open,
  onClose,
  projectId,
  isConvenor,
  fetchResult,
  onFetchUrl,
  onIiifConfirm,
  isFetching,
  onUploadConfirm,
  isUploading,
  uploadError,
  existingObjectIds,
  onExternalConfirm,
  isAdding,
}: Props) {
  const { t } = useTranslation("objects");

  const [tab, setTab] = useState<AddObjectTab>("iiif");

  // Shared metadata block (IIIF + External tabs only).
  const [title, setTitle] = useState("");
  const [creator, setCreator] = useState("");
  const [description, setDescription] = useState("");
  const [year, setYear] = useState("");

  // IIIF tab — URL + manifest-derived fields.
  const [iiifUrl, setIiifUrl] = useState("");
  const [iiifSource, setIiifSource] = useState("");
  const [iiifCredit, setIiifCredit] = useState("");
  const [iiifThumbnail, setIiifThumbnail] = useState("");
  const [iiifHasTiles, setIiifHasTiles] = useState(false);

  // External tab — URL + debounced recognition.
  const [externalUrl, setExternalUrl] = useState("");
  const [recognised, setRecognised] = useState<MediaType | null>(null);

  // -------------------------------------------------------------------------
  // Tab persistence — SSR-safe, per-project, role-guarded.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!open) return;
    try {
      const stored = localStorage.getItem(`${TAB_STORAGE_PREFIX}${projectId}`);
      if (stored === "iiif" || stored === "external") {
        setTab(stored);
      } else if (stored === "upload") {
        // Guard: collaborators must never land on Upload — fall back.
        setTab(isConvenor ? "upload" : "iiif");
      }
    } catch {
      // localStorage unavailable (SSR / private mode) — keep the default tab.
    }
  }, [open, projectId, isConvenor]);

  const selectTab = useCallback(
    (next: AddObjectTab) => {
      // Defence-in-depth: never select Upload for a collaborator.
      const safe = next === "upload" && !isConvenor ? "iiif" : next;
      setTab(safe);
      try {
        localStorage.setItem(`${TAB_STORAGE_PREFIX}${projectId}`, safe);
      } catch {
        // Ignore storage errors.
      }
    },
    [projectId, isConvenor]
  );

  // -------------------------------------------------------------------------
  // IIIF: auto-populate the shared + IIIF fields when a manifest fetch arrives.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (fetchResult?.ok) {
      const meta: IiifMetadata = fetchResult.metadata;
      setTitle(meta.title ?? "");
      setCreator(meta.creator ?? "");
      setDescription(meta.description ?? "");
      setIiifSource(meta.source ?? "");
      setIiifCredit(meta.credit ?? "");
      setIiifThumbnail(meta.thumbnail ?? "");
      setIiifHasTiles(meta.image_available);
    }
  }, [fetchResult]);

  // -------------------------------------------------------------------------
  // External: ~250 ms debounced recognition via detectMediaType.
  // -------------------------------------------------------------------------
  useEffect(() => {
    const trimmed = externalUrl.trim();
    if (!trimmed) {
      setRecognised(null);
      return;
    }
    const handle = setTimeout(() => {
      const type = detectMediaType(trimmed, null);
      // Only the external media types count as "recognised"; iiif/text-only do not.
      if (type === "youtube" || type === "vimeo" || type === "google-drive" || type === "audio") {
        setRecognised(type);
      } else {
        setRecognised(null);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [externalUrl]);

  // -------------------------------------------------------------------------
  // Reset everything when the dialog closes.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!open) {
      setTitle("");
      setCreator("");
      setDescription("");
      setYear("");
      setIiifUrl("");
      setIiifSource("");
      setIiifCredit("");
      setIiifThumbnail("");
      setIiifHasTiles(false);
      setExternalUrl("");
      setRecognised(null);
    }
  }, [open]);

  const previewSlug = title ? slugify(title) : "";

  const showIiifPreview = fetchResult?.ok === true;
  const iiifFetchError = fetchResult?.ok === false ? fetchResult.error : null;

  function iiifErrorMessage(code: string): string {
    if (code === "fetch_failed") return t("add_iiif_error_fetch");
    if (code === "not_iiif") return t("add_iiif_error_invalid");
    if (code === "parse_error") return t("add_iiif_error_parse");
    return t("add_iiif_error_fetch");
  }

  function handleIiifConfirm() {
    if (!title.trim()) return;
    onIiifConfirm({
      manifestUrl: iiifUrl,
      title: title.trim(),
      creator: creator.trim(),
      description: description.trim(),
      source: iiifSource.trim(),
      credit: iiifCredit.trim(),
      thumbnail: iiifThumbnail.trim(),
      image_available: iiifHasTiles,
      object_id: previewSlug,
      year: year.trim(),
    });
  }

  function handleExternalConfirm() {
    if (!title.trim() || !externalUrl.trim()) return;
    onExternalConfirm({
      title: title.trim(),
      creator: creator.trim(),
      description: description.trim(),
      year: year.trim(),
      sourceUrl: externalUrl.trim(),
      object_id: previewSlug,
    });
  }

  function recognisedLabel(type: MediaType): string {
    if (type === "youtube") return t("external_recognised_youtube");
    if (type === "vimeo") return t("external_recognised_vimeo");
    if (type === "google-drive") return t("external_recognised_gdrive");
    return t("external_recognised_audio");
  }

  // Whether a single-object form (IIIF or External) is dirty — drives the
  // data-loss dismiss guard alongside the Upload tab's staged-files state.
  const singleObjectDirty =
    title.trim() !== "" ||
    creator.trim() !== "" ||
    description.trim() !== "" ||
    year.trim() !== "" ||
    iiifUrl.trim() !== "" ||
    externalUrl.trim() !== "";

  // The Upload tab owns its own dirty flag; lift it so the shared guard sees it.
  const [uploadDirty, setUploadDirty] = useState(false);
  useEffect(() => {
    if (!open) setUploadDirty(false);
  }, [open]);

  const dismissConfirm =
    (tab === "upload" && uploadDirty) || (tab !== "upload" && singleObjectDirty)
      ? t("upload_dismiss_confirm")
      : undefined;

  // -------------------------------------------------------------------------
  // Shared metadata block (IIIF + External). Built as a JSX element (not an
  // inner component) so the inputs do NOT remount/lose focus on each keystroke.
  // -------------------------------------------------------------------------
  const sharedMetadataBlock = (
      <div className="space-y-3">
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
            className={inputClass}
          />
          {!title.trim() && (
            <p className="font-body text-xs text-red-500 mt-0.5">
              {t("field_title_required")}
            </p>
          )}
        </div>

        {/* Object ID preview (read-only, derived slug) */}
        <div>
          <label className="block font-body text-xs font-medium text-charcoal mb-1">
            Object ID
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
            className={inputClass}
          />
        </div>

        {/* Year */}
        <div>
          <label className="block font-body text-xs font-medium text-charcoal mb-1">
            {t("field_year")}
          </label>
          <input
            type="text"
            value={year}
            onChange={(e) => setYear(e.target.value)}
            className={inputClass}
          />
          <p className="font-body text-xs text-gray-400 mt-0.5">{t("field_year_help")}</p>
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
            className={`${inputClass} resize-none`}
          />
        </div>
      </div>
  );

  const tabs: { key: AddObjectTab; label: string }[] = [
    { key: "iiif", label: t("tab_iiif") },
    ...(isConvenor ? [{ key: "upload" as const, label: t("tab_upload") }] : []),
    { key: "external", label: t("tab_external") },
  ];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissConfirm={dismissConfirm}
      className="max-w-lg w-full mx-4 p-0 overflow-hidden"
    >
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-100">
        <h2 className="font-heading font-semibold text-lg text-charcoal">
          {t("add_object_title")}
        </h2>
      </div>

      {/* Tab strip — labels >=520px, <select> below (no JS media query) */}
      <div className="px-6 pt-4">
        {/* Select (small viewports) */}
        <div className="sm:hidden">
          <label className="sr-only" htmlFor="add-object-tab-select">
            {t("tab_select_label")}
          </label>
          <select
            id="add-object-tab-select"
            value={tab}
            onChange={(e) => selectTab(e.target.value as AddObjectTab)}
            className={inputClass}
          >
            {tabs.map((tb) => (
              <option key={tb.key} value={tb.key}>
                {tb.label}
              </option>
            ))}
          </select>
        </div>

        {/* Button row (>=520px) */}
        <div className="hidden sm:flex items-center gap-1 border-b border-gray-100">
          {tabs.map((tb) => (
            <button
              key={tb.key}
              type="button"
              onClick={() => selectTab(tb.key)}
              className={`font-heading text-sm px-3 py-2 -mb-px border-b-2 transition-colors ${
                tab === tb.key
                  ? "border-terracotta text-charcoal font-semibold"
                  : "border-transparent text-gray-500 hover:text-charcoal"
              }`}
            >
              {tb.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="max-h-[60vh] overflow-y-auto px-6 py-4 space-y-4">
        {tab === "iiif" && (
          <div className="space-y-4">
            {/* URL entry */}
            <div>
              <label className="block font-body text-sm font-medium text-charcoal mb-1">
                {t("add_iiif_url_label")}
              </label>
              <div className="flex gap-2">
                <input
                  type="url"
                  value={iiifUrl}
                  onChange={(e) => setIiifUrl(e.target.value)}
                  placeholder={t("add_iiif_url_placeholder")}
                  disabled={isFetching}
                  className="flex-1 font-body text-sm border border-gray-200 rounded-lg px-3 py-2 text-charcoal disabled:bg-gray-50 disabled:text-gray-400"
                />
                <button
                  type="button"
                  onClick={() => {
                    if (iiifUrl.trim()) onFetchUrl(iiifUrl.trim());
                  }}
                  disabled={isFetching || !iiifUrl.trim()}
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
              {iiifFetchError && (
                <p className="font-body text-sm text-red-600 mt-1.5">
                  {iiifErrorMessage(iiifFetchError)}
                </p>
              )}
            </div>

            {/* Metadata preview (step 2) */}
            {showIiifPreview && (
              <div className="space-y-3">
                <h3 className="font-heading font-semibold text-sm text-charcoal">
                  {t("add_iiif_preview")}
                </h3>

                {iiifThumbnail && (
                  <img
                    src={iiifThumbnail}
                    alt={title || "Thumbnail"}
                    className="w-24 h-24 object-cover rounded-lg border border-gray-200"
                  />
                )}

                {sharedMetadataBlock}

                {/* Source */}
                <div>
                  <label className="block font-body text-xs font-medium text-charcoal mb-1">
                    {t("field_source")}
                  </label>
                  <input
                    type="text"
                    value={iiifSource}
                    onChange={(e) => setIiifSource(e.target.value)}
                    className={inputClass}
                  />
                </div>

                {/* Credit */}
                <div>
                  <label className="block font-body text-xs font-medium text-charcoal mb-1">
                    {t("field_credit")}
                  </label>
                  <input
                    type="text"
                    value={iiifCredit}
                    onChange={(e) => setIiifCredit(e.target.value)}
                    className={inputClass}
                  />
                </div>

                {/* IIIF tiles badge (read-only) */}
                <div className="flex items-center gap-2">
                  <span className="font-body text-xs font-medium text-charcoal">
                    {t("field_image_available")}:
                  </span>
                  <span
                    className={`font-body text-xs rounded-full px-2 py-0.5 ${
                      iiifHasTiles
                        ? "bg-green-100 text-green-700"
                        : "bg-gray-100 text-gray-500"
                    }`}
                  >
                    {iiifHasTiles ? "Yes" : "No"}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "upload" && isConvenor && (
          <UploadTabBody
            onConfirm={onUploadConfirm}
            isUploading={isUploading}
            uploadError={uploadError}
            existingObjectIds={existingObjectIds}
            onDirtyChange={setUploadDirty}
          />
        )}

        {tab === "external" && (
          <div className="space-y-4">
            {/* URL input + debounced recognition */}
            <div>
              <label className="block font-body text-sm font-medium text-charcoal mb-1">
                {t("external_url_label")}
              </label>
              <input
                type="url"
                value={externalUrl}
                onChange={(e) => setExternalUrl(e.target.value)}
                placeholder={t("external_url_placeholder")}
                className={inputClass}
              />
              {/* Recognised-state pill — TEXT ONLY (never a live href/src), so
                  the user-entered URL is never injected into the page. */}
              {recognised ? (
                <span className="inline-flex items-center gap-1.5 mt-2 font-body text-xs bg-chilca-pale text-chilca-deep rounded-full px-2.5 py-0.5">
                  <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-chilca" />
                  {recognisedLabel(recognised)}
                </span>
              ) : externalUrl.trim() ? (
                <p className="font-body text-xs text-fg-subtle mt-2">
                  {t("external_unrecognised")}
                </p>
              ) : null}
            </div>

            {sharedMetadataBlock}
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

        {tab === "iiif" && showIiifPreview && (
          <button
            type="button"
            onClick={handleIiifConfirm}
            disabled={!title.trim() || isAdding}
            className="inline-flex items-center gap-2 font-heading font-semibold text-sm bg-anil hover:bg-anil-hover text-charcoal rounded-full px-5 py-1.5 transition-colors uppercase tracking-wider disabled:bg-disabled disabled:text-fg-disabled"
          >
            {isAdding && (
              <div className="w-4 h-4 border-2 border-charcoal border-t-transparent rounded-full animate-spin" />
            )}
            {t("add_iiif_confirm")}
          </button>
        )}

        {tab === "external" && (
          <button
            type="button"
            onClick={handleExternalConfirm}
            disabled={!title.trim() || !recognised || isAdding}
            className="inline-flex items-center gap-2 font-heading font-semibold text-sm bg-anil hover:bg-anil-hover text-charcoal rounded-full px-5 py-1.5 transition-colors uppercase tracking-wider disabled:bg-disabled disabled:text-fg-disabled"
          >
            {isAdding && (
              <div className="w-4 h-4 border-2 border-charcoal border-t-transparent rounded-full animate-spin" />
            )}
            {t("external_confirm")}
          </button>
        )}
        {/* The Upload tab raises its own confirm from within UploadTabBody. */}
      </div>
    </Dialog>
  );
}

// ===========================================================================
// UploadTabBody — the per-file staged-queue Upload flow preserved as-is.
//
// This is the UploadImageDialog flow lifted into the shared shell (it does not
// render its own Dialog/overlay; AddObjectDialog owns that). It raises
// UploadImageConfirmPayload[] unchanged. The shared metadata block does NOT
// apply here — Upload keeps its own per-file metadata incl. period/year/altText.
// ===========================================================================

const MAX_BATCH = 10;

interface StagedImage {
  payload: UploadImageConfirmPayload;
  previewUrl: string;
}

function UploadTabBody({
  onConfirm,
  isUploading,
  uploadError,
  existingObjectIds,
  onDirtyChange,
}: {
  onConfirm: (payloads: UploadImageConfirmPayload[]) => void;
  isUploading: boolean;
  uploadError: string | null;
  existingObjectIds: string[];
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useTranslation("objects");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [stagedImages, setStagedImages] = useState<StagedImage[]>([]);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [pendingIndex, setPendingIndex] = useState(0);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const [objectId, setObjectId] = useState("");
  const [title, setTitle] = useState("");
  const [creator, setCreator] = useState("");
  const [description, setDescription] = useState("");
  const [source, setSource] = useState("");
  const [credit, setCredit] = useState("");
  const [period, setPeriod] = useState("");
  const [year, setYear] = useState("");
  const [altText, setAltText] = useState("");

  // Report dirty state up to the shell's dismiss guard.
  useEffect(() => {
    onDirtyChange(stagedImages.length > 0 || selectedFile !== null);
  }, [stagedImages.length, selectedFile, onDirtyChange]);

  // Revoke the active preview URL on unmount if not owned by a staged image.
  useEffect(() => {
    return () => {
      if (previewUrl && !stagedImages.some((s) => s.previewUrl === previewUrl)) {
        URL.revokeObjectURL(previewUrl);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function loadFileForEditing(file: File) {
    const url = URL.createObjectURL(file);
    setSelectedFile(file);
    setPreviewUrl(url);
    const nameWithoutExt = file.name.replace(/\.[^.]+$/, "");
    setObjectId(slugify(nameWithoutExt, 0));
    setTitle(nameWithoutExt);
    setCreator("");
    setDescription("");
    setSource("");
    setCredit("");
    setPeriod("");
    setYear("");
    setAltText("");
    setStep(2);
  }

  function handleFilesSelect(files: File[]) {
    setValidationError(null);
    const remaining = MAX_BATCH - stagedImages.length;
    if (remaining <= 0) {
      setValidationError(t("upload_error_batch_full"));
      return;
    }
    const valid: File[] = [];
    for (const file of files) {
      if (!ACCEPTED_TYPES.has(file.type)) {
        setValidationError(t("upload_error_format"));
        return;
      }
      if (file.size > MAX_SIZE_BYTES) {
        setValidationError(t("upload_error_size"));
        return;
      }
      valid.push(file);
    }
    if (valid.length > remaining) {
      setValidationError(t("upload_error_too_many", { max: remaining }));
      return;
    }
    setPendingFiles(valid);
    setPendingIndex(0);
    loadFileForEditing(valid[0]);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(true);
  }
  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
  }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) handleFilesSelect(files);
  }
  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) handleFilesSelect(files);
    e.target.value = "";
  }

  function clearCurrentFile() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setSelectedFile(null);
    setValidationError(null);
    setObjectId("");
    setTitle("");
    setCreator("");
    setDescription("");
    setSource("");
    setCredit("");
    setPeriod("");
    setYear("");
    setAltText("");
  }

  function handleBack() {
    clearCurrentFile();
    setPendingFiles([]);
    setPendingIndex(0);
    setStep(stagedImages.length > 0 ? 3 : 1);
  }

  function handleBackFromSummary() {
    if (stagedImages.length === 0) {
      setStep(1);
      return;
    }
    const last = stagedImages[stagedImages.length - 1];
    setStagedImages((prev) => prev.slice(0, -1));
    setSelectedFile(last.payload.file);
    setPreviewUrl(last.previewUrl);
    setObjectId(last.payload.objectId);
    setTitle(last.payload.title);
    setCreator(last.payload.creator);
    setDescription(last.payload.description);
    setSource(last.payload.source);
    setCredit(last.payload.credit);
    setPeriod(last.payload.period);
    setYear(last.payload.year);
    setAltText(last.payload.altText);
    setStep(2);
  }

  function handleAddToBatch() {
    if (!selectedFile || !title.trim() || !previewUrl) return;
    const payload: UploadImageConfirmPayload = {
      file: selectedFile,
      objectId: objectId.trim(),
      title: title.trim(),
      creator: creator.trim(),
      description: description.trim(),
      source: source.trim(),
      credit: credit.trim(),
      period: period.trim(),
      year: year.trim(),
      altText: altText.trim(),
    };
    setStagedImages((prev) => [...prev, { payload, previewUrl }]);
    setSelectedFile(null);
    setPreviewUrl(null);
    const nextIndex = pendingIndex + 1;
    if (nextIndex < pendingFiles.length) {
      setPendingIndex(nextIndex);
      loadFileForEditing(pendingFiles[nextIndex]);
    } else {
      setPendingFiles([]);
      setPendingIndex(0);
      setStep(3);
    }
  }

  function handleRemoveStaged(index: number) {
    setStagedImages((prev) => {
      const removed = prev[index];
      URL.revokeObjectURL(removed.previewUrl);
      const next = prev.filter((_, i) => i !== index);
      if (next.length === 0) setStep(1);
      return next;
    });
  }

  function handleConfirm() {
    if (!selectedFile || !title.trim() || isUploading) return;
    const payload: UploadImageConfirmPayload = {
      file: selectedFile,
      objectId: objectId.trim(),
      title: title.trim(),
      creator: creator.trim(),
      description: description.trim(),
      source: source.trim(),
      credit: credit.trim(),
      period: period.trim(),
      year: year.trim(),
      altText: altText.trim(),
    };
    onConfirm([payload]);
  }

  function handleCommitAll() {
    if (stagedImages.length === 0 || isUploading) return;
    onConfirm(stagedImages.map((s) => s.payload));
  }

  const allExistingIds = [...existingObjectIds, ...stagedImages.map((s) => s.payload.objectId)];
  const idCollision = objectId.trim() && allExistingIds.includes(objectId.trim());

  return (
    <div className="space-y-4">
      {/* Step header / back affordance */}
      {(step === 2 || step === 3) && (
        <button
          type="button"
          onClick={step === 2 ? handleBack : handleBackFromSummary}
          aria-label={t("upload_back_aria")}
          disabled={isUploading}
          className="inline-flex items-center gap-1 font-body text-sm text-charcoal hover:text-gray-500 transition-colors disabled:text-fg-disabled"
        >
          <ChevronLeft size={16} />
          {step === 2 ? t("upload_details_title") : t("upload_batch_header")}
        </button>
      )}

      {step === 1 && (
        <>
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`min-h-[96px] flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed cursor-pointer transition-colors select-none ${
              isDragOver ? "bg-anil/20 border-anil" : "bg-cream border-gray-200"
            }`}
          >
            {isDragOver ? (
              <p className="font-body text-sm text-anil font-medium">{t("upload_drop_active")}</p>
            ) : (
              <>
                <Upload size={24} className="text-gray-400" />
                <p className="font-body text-sm text-charcoal">{t("upload_drop_primary")}</p>
                <p className="font-body text-xs text-gray-400">{t("upload_drop_secondary")}</p>
                <p className="font-body text-xs text-gray-400 mt-1">{t("upload_drop_hint")}</p>
              </>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".jpg,.jpeg,.png,.tif,.tiff"
            multiple
            className="hidden"
            onChange={handleInputChange}
          />

          {validationError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 font-body text-sm text-red-700">
              {validationError}
            </div>
          )}

          {stagedImages.length > 0 && (
            <p className="font-body text-xs text-gray-500 text-center">
              {t("upload_batch_summary", { count: stagedImages.length })}
            </p>
          )}
        </>
      )}

      {step === 2 && selectedFile && (
        <div className="space-y-3">
          {pendingFiles.length > 1 && (
            <p className="font-body text-xs text-gray-500">
              {t("upload_progress", { current: pendingIndex + 1, total: pendingFiles.length })}
            </p>
          )}

          {previewUrl && (
            <img
              src={previewUrl}
              alt={title || selectedFile.name}
              className="w-24 h-24 object-cover rounded-lg border border-gray-200"
            />
          )}

          <div>
            <label className="block font-body text-xs font-medium text-charcoal mb-1">
              {t("upload_object_id")}
            </label>
            <input
              type="text"
              value={objectId}
              onChange={(e) => setObjectId(e.target.value)}
              disabled={isUploading}
              className="w-full font-mono text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 disabled:text-gray-400"
            />
            <p className="font-body text-xs text-gray-400 mt-0.5">{t("upload_object_id_help")}</p>
            {idCollision && (
              <p className="font-body text-xs text-amber-600 mt-0.5">
                {t("upload_id_collision_hint")}
              </p>
            )}
          </div>

          <div>
            <label className="block font-body text-xs font-medium text-charcoal mb-1">
              {t("field_title")} <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={isUploading}
              required
              className={inputClass}
            />
            {!title.trim() && (
              <p className="font-body text-xs text-red-500 mt-0.5">{t("field_title_required")}</p>
            )}
          </div>

          <div>
            <label className="block font-body text-xs font-medium text-charcoal mb-1">
              {t("field_creator")}
            </label>
            <input
              type="text"
              value={creator}
              onChange={(e) => setCreator(e.target.value)}
              disabled={isUploading}
              className={inputClass}
            />
          </div>

          <div>
            <label className="block font-body text-xs font-medium text-charcoal mb-1">
              {t("field_year")}
            </label>
            <input
              type="text"
              value={year}
              onChange={(e) => setYear(e.target.value)}
              disabled={isUploading}
              className={inputClass}
            />
          </div>

          <div>
            <label className="block font-body text-xs font-medium text-charcoal mb-1">
              {t("field_period")}
            </label>
            <input
              type="text"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              disabled={isUploading}
              className={inputClass}
            />
          </div>

          <div>
            <label className="block font-body text-xs font-medium text-charcoal mb-1">
              {t("field_description")}
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={isUploading}
              rows={3}
              className={`${inputClass} resize-none`}
            />
          </div>

          <div>
            <label className="block font-body text-xs font-medium text-charcoal mb-1">
              {t("field_source")}
            </label>
            <input
              type="text"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              disabled={isUploading}
              className={inputClass}
            />
          </div>

          <div>
            <label className="block font-body text-xs font-medium text-charcoal mb-1">
              {t("field_credit")}
            </label>
            <input
              type="text"
              value={credit}
              onChange={(e) => setCredit(e.target.value)}
              disabled={isUploading}
              className={inputClass}
            />
          </div>

          <div>
            <label className="block font-body text-xs font-medium text-charcoal mb-1">
              {t("field_alt_text")}
            </label>
            <input
              type="text"
              value={altText}
              onChange={(e) => setAltText(e.target.value)}
              disabled={isUploading}
              className={inputClass}
            />
            <p className="font-body text-xs text-gray-400 mt-0.5">{t("upload_alt_help")}</p>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-3">
          <p className="font-body text-sm text-charcoal">
            {t("upload_batch_summary", { count: stagedImages.length })}
          </p>
          {stagedImages.map((staged, i) => (
            <div key={i} className="flex items-center gap-3 p-2 rounded-lg border border-gray-100">
              <img
                src={staged.previewUrl}
                alt={staged.payload.title}
                className="w-12 h-12 object-cover rounded border border-gray-200 flex-shrink-0"
              />
              <span className="font-body text-sm text-charcoal flex-1 truncate">
                {staged.payload.title}
              </span>
              <button
                type="button"
                onClick={() => handleRemoveStaged(i)}
                aria-label={t("upload_remove_staged_aria")}
                className="text-gray-400 hover:text-red-500 transition-colors flex-shrink-0"
              >
                <X size={16} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Upload action row (inline — the shared footer hosts only IIIF/External confirm) */}
      <div className="flex flex-col items-end gap-2 pt-2 border-t border-gray-100">
        <div className="flex items-center justify-end gap-3 w-full">
          {step === 2 && stagedImages.length === 0 && pendingFiles.length <= 1 && (
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!title.trim() || isUploading}
              className="inline-flex items-center gap-2 font-heading font-semibold text-sm bg-anil hover:bg-anil-hover text-charcoal rounded-full px-5 py-1.5 transition-colors uppercase tracking-wider disabled:bg-disabled disabled:text-fg-disabled"
            >
              {isUploading && (
                <div className="w-4 h-4 border-2 border-charcoal border-t-transparent rounded-full animate-spin" />
              )}
              {isUploading ? t("upload_uploading") : t("upload_confirm")}
            </button>
          )}

          {step === 2 && (
            <button
              type="button"
              onClick={handleAddToBatch}
              disabled={!title.trim() || isUploading}
              className={`font-heading font-semibold text-sm rounded-full px-5 py-1.5 transition-colors uppercase tracking-wider disabled:text-fg-disabled ${
                pendingFiles.length > 1
                  ? "bg-anil hover:bg-anil-hover text-charcoal disabled:bg-disabled"
                  : "text-charcoal border border-charcoal hover:bg-gray-50"
              }`}
            >
              {pendingFiles.length > 1 && pendingIndex < pendingFiles.length - 1
                ? t("upload_next_image")
                : pendingFiles.length > 1
                  ? t("upload_finish_batch")
                  : t("upload_add_to_batch")}
            </button>
          )}

          {step === 3 && (
            <>
              {stagedImages.length < MAX_BATCH && (
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  disabled={isUploading}
                  className="font-heading font-semibold text-sm text-charcoal border border-charcoal rounded-full px-5 py-1.5 hover:bg-gray-50 transition-colors uppercase tracking-wider disabled:text-fg-disabled"
                >
                  {t("upload_add_more")}
                </button>
              )}
              <button
                type="button"
                onClick={handleCommitAll}
                disabled={isUploading}
                className="inline-flex items-center gap-2 font-heading font-semibold text-sm bg-anil hover:bg-anil-hover text-charcoal rounded-full px-5 py-1.5 transition-colors uppercase tracking-wider disabled:bg-disabled disabled:text-fg-disabled"
              >
                {isUploading && (
                  <div className="w-4 h-4 border-2 border-charcoal border-t-transparent rounded-full animate-spin" />
                )}
                {isUploading ? t("upload_uploading") : t("upload_commit_all", { count: stagedImages.length })}
              </button>
            </>
          )}
        </div>

        {uploadError && (
          <p className="font-body text-sm text-red-600 text-center w-full">{uploadError}</p>
        )}
      </div>
    </div>
  );
}
