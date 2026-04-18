/**
 * UploadImageDialog — three-step dialog for uploading one or more self-hosted images.
 *
 * Step 1: Drop zone for file selection (drag-drop or click-browse).
 *         Client-side validation for format and size; invalid files show
 *         an error pill and block advancing.
 * Step 2: Image preview + metadata form (title required, all others optional).
 *         Object ID auto-generated from filename via slugify, editable.
 *         "Add to batch" stages the image without committing.
 *         "Upload Image" (single-image shortcut) calls onConfirm immediately.
 * Step 3: Staged-images summary — thumbnails, titles, remove buttons.
 *         "Add another image" returns to Step 1. "Commit all" calls onConfirm
 *         with the full array of staged payloads.
 *
 * dismissConfirm fires whenever a file is selected or images are staged so the
 * user cannot accidentally close the dialog mid-flow.
 */

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Upload, ChevronLeft, X } from "lucide-react";
import { Dialog } from "~/components/ui/Dialog";
import { slugify } from "~/lib/slugify";
import { ACCEPTED_TYPES, MAX_SIZE_BYTES } from "~/lib/upload-constants";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UploadImageConfirmPayload {
  file: File;
  objectId: string;
  title: string;
  creator: string;
  description: string;
  source: string;
  credit: string;
  period: string;
  year: string;
  altText: string;
}

interface StagedImage {
  payload: UploadImageConfirmPayload;
  previewUrl: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onConfirm: (payloads: UploadImageConfirmPayload[]) => void;
  isUploading: boolean;
  uploadError: string | null;
  existingObjectIds: string[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function UploadImageDialog({
  open,
  onClose,
  onConfirm,
  isUploading,
  uploadError,
  existingObjectIds,
}: Props) {
  const { t } = useTranslation("objects");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Step state — now 1 | 2 | 3
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Staged images (persists across Step 1/2/3 transitions)
  const [stagedImages, setStagedImages] = useState<StagedImage[]>([]);

  // Pending files queue (multi-file selection cycles through metadata one at a time)
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [pendingIndex, setPendingIndex] = useState(0);

  // File state (active file being edited in Step 2)
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  // Metadata state (for the current file being edited in Step 2)
  const [objectId, setObjectId] = useState("");
  const [title, setTitle] = useState("");
  const [creator, setCreator] = useState("");
  const [description, setDescription] = useState("");
  const [source, setSource] = useState("");
  const [credit, setCredit] = useState("");
  const [period, setPeriod] = useState("");
  const [year, setYear] = useState("");
  const [altText, setAltText] = useState("");

  // Cleanup active preview URL on unmount only — don't revoke on every change,
  // because the previous URL may now be owned by the staged images list.
  useEffect(() => {
    return () => {
      // On unmount, revoke if not owned by a staged image
      if (previewUrl && !stagedImages.some((s) => s.previewUrl === previewUrl)) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset ALL state when dialog closes — revoke ALL staged preview URLs
  useEffect(() => {
    if (!open) {
      setStep(1);
      stagedImages.forEach((s) => URL.revokeObjectURL(s.previewUrl));
      setStagedImages([]);
      setPendingFiles([]);
      setPendingIndex(0);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      setSelectedFile(null);
      setValidationError(null);
      setIsDragOver(false);
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** Maximum images per batch commit */
  const MAX_BATCH = 10;

  /** Load a single file into Step 2 for metadata entry */
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

    // Enforce batch limit
    const remaining = MAX_BATCH - stagedImages.length;
    if (remaining <= 0) {
      setValidationError(t("upload_error_batch_full"));
      return;
    }

    // Validate all files first
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

    // Store the queue and load the first file
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
    // Reset input so same files can be re-selected if user goes back
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
    // If we have staged images, return to summary; otherwise back to drop zone
    // Also abandon the rest of the pending queue
    setPendingFiles([]);
    setPendingIndex(0);
    if (stagedImages.length > 0) {
      setStep(3);
    } else {
      setStep(1);
    }
  }

  /** Pop the last staged image back into the metadata editor */
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
    // Don't revoke previewUrl — it's now owned by the staged list
    setSelectedFile(null);
    setPreviewUrl(null);

    // If more files in the queue, advance to the next one
    const nextIndex = pendingIndex + 1;
    if (nextIndex < pendingFiles.length) {
      setPendingIndex(nextIndex);
      loadFileForEditing(pendingFiles[nextIndex]);
    } else {
      // Queue exhausted — go to summary
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

  // Single-image shortcut: when no staged images, "Upload Image" calls onConfirm
  // directly with a 1-element array (skipping the batch flow).
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

  // Commit all staged images in one batch
  function handleCommitAll() {
    if (stagedImages.length === 0 || isUploading) return;
    onConfirm(stagedImages.map((s) => s.payload));
  }

  // Object ID collision check — includes already-staged IDs so user can't
  // accidentally re-use an ID that's about to be committed in the same batch.
  const allExistingIds = [...existingObjectIds, ...stagedImages.map((s) => s.payload.objectId)];
  const idCollision = objectId.trim() && allExistingIds.includes(objectId.trim());

  const inputClass =
    "w-full font-body text-sm border border-gray-200 rounded-lg px-3 py-2 text-charcoal focus:outline-none focus:ring-2 focus:ring-periwinkle disabled:bg-gray-50 disabled:text-gray-400";

  // Header title based on step
  function getHeaderTitle() {
    if (step === 1) return t("upload_title");
    if (step === 2) return t("upload_details_title");
    return t("upload_batch_header");
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissConfirm={stagedImages.length > 0 || selectedFile ? t("upload_dismiss_confirm") : undefined}
      className="max-w-lg w-full mx-4 p-0 overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-6 py-4 border-b border-gray-100">
        {(step === 2 || step === 3) && (
          <button
            type="button"
            onClick={step === 2 ? handleBack : handleBackFromSummary}
            aria-label={t("upload_back_aria")}
            disabled={isUploading}
            className="text-charcoal hover:text-gray-500 transition-colors disabled:opacity-50 flex-shrink-0"
          >
            <ChevronLeft size={16} />
          </button>
        )}
        <h2 className="font-heading font-semibold text-lg text-charcoal">
          {getHeaderTitle()}
        </h2>
      </div>

      {/* Content */}
      <div className="max-h-[65vh] overflow-y-auto px-6 py-4 space-y-4">
        {step === 1 && (
          <>
            {/* Drop zone */}
            <div
              onClick={() => fileInputRef.current?.click()}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`min-h-[96px] flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed cursor-pointer transition-colors select-none ${
                isDragOver
                  ? "bg-lavender/20 border-periwinkle"
                  : "bg-cream border-gray-200"
              }`}
            >
              {isDragOver ? (
                <p className="font-body text-sm text-periwinkle font-medium">
                  {t("upload_drop_active")}
                </p>
              ) : (
                <>
                  <Upload size={24} className="text-gray-400" />
                  <p className="font-body text-sm text-charcoal">
                    {t("upload_drop_primary")}
                  </p>
                  <p className="font-body text-xs text-gray-400">
                    {t("upload_drop_secondary")}
                  </p>
                  <p className="font-body text-xs text-gray-400 mt-1">
                    {t("upload_drop_hint")}
                  </p>
                </>
              )}
            </div>

            {/* Hidden file input — accepts multiple files */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".jpg,.jpeg,.png,.tif,.tiff"
              multiple
              className="hidden"
              onChange={handleInputChange}
            />

            {/* Validation error */}
            {validationError && (
              <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 font-body text-sm text-red-700">
                {validationError}
              </div>
            )}

            {/* Show staged count if returning to pick another image */}
            {stagedImages.length > 0 && (
              <p className="font-body text-xs text-gray-500 text-center">
                {t("upload_batch_summary", { count: stagedImages.length })}
              </p>
            )}
          </>
        )}

        {step === 2 && selectedFile && (
          <div className="space-y-3">
            {/* Progress indicator for multi-file queue */}
            {pendingFiles.length > 1 && (
              <p className="font-body text-xs text-gray-500">
                {t("upload_progress", { current: pendingIndex + 1, total: pendingFiles.length })}
              </p>
            )}

            {/* Image preview */}
            {previewUrl && (
              <img
                src={previewUrl}
                alt={title || selectedFile.name}
                className="w-24 h-24 object-cover rounded-lg border border-gray-200"
              />
            )}

            {/* Object ID */}
            <div>
              <label className="block font-body text-xs font-medium text-charcoal mb-1">
                {t("upload_object_id")}
              </label>
              <input
                type="text"
                value={objectId}
                onChange={(e) => setObjectId(e.target.value)}
                disabled={isUploading}
                className="w-full font-mono text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-periwinkle disabled:text-gray-400"
              />
              <p className="font-body text-xs text-gray-400 mt-0.5">
                {t("upload_object_id_help")}
              </p>
              {idCollision && (
                <p className="font-body text-xs text-amber-600 mt-0.5">
                  {t("upload_id_collision_hint")}
                </p>
              )}
            </div>

            {/* Title (required) */}
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
                <p className="font-body text-xs text-red-500 mt-0.5">
                  {t("field_title_required")}
                </p>
              )}
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
                disabled={isUploading}
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
                disabled={isUploading}
                className={inputClass}
              />
            </div>

            {/* Period */}
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

            {/* Description */}
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

            {/* Source */}
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

            {/* Credit */}
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

            {/* Alt text */}
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
              <p className="font-body text-xs text-gray-400 mt-0.5">
                {t("upload_alt_help")}
              </p>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3">
            <p className="font-body text-sm text-charcoal">
              {t("upload_batch_summary", { count: stagedImages.length })}
            </p>
            {stagedImages.map((staged, i) => (
              <div
                key={i}
                className="flex items-center gap-3 p-2 rounded-lg border border-gray-100"
              >
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
      </div>

      {/* Footer */}
      <div className="flex flex-col items-end gap-2 px-6 py-4 border-t border-gray-100 bg-gray-50">
        <div className="flex items-center justify-end gap-3 w-full">
          {/* Always-present close/back button */}
          <button
            type="button"
            onClick={onClose}
            disabled={isUploading}
            className="font-heading font-semibold text-sm text-charcoal border border-charcoal rounded-full px-5 py-1.5 hover:bg-gray-50 transition-colors uppercase tracking-wider disabled:opacity-50"
          >
            {t("upload_close")}
          </button>

          {/* Step 2 — single-image shortcut (only when single file, no staged images) */}
          {step === 2 && stagedImages.length === 0 && pendingFiles.length <= 1 && (
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!title.trim() || isUploading}
              className="inline-flex items-center gap-2 font-heading font-semibold text-sm bg-periwinkle hover:bg-periwinkle-hover text-charcoal rounded-full px-5 py-1.5 transition-colors uppercase tracking-wider disabled:opacity-50"
            >
              {isUploading && (
                <div className="w-4 h-4 border-2 border-charcoal border-t-transparent rounded-full animate-spin" />
              )}
              {isUploading ? t("upload_uploading") : t("upload_confirm")}
            </button>
          )}

          {/* Step 2 — "Next image" (multi-file queue) or "Add to batch" (single file) */}
          {step === 2 && (
            <button
              type="button"
              onClick={handleAddToBatch}
              disabled={!title.trim() || isUploading}
              className={`font-heading font-semibold text-sm rounded-full px-5 py-1.5 transition-colors uppercase tracking-wider disabled:opacity-50 ${
                pendingFiles.length > 1
                  ? "bg-periwinkle hover:bg-periwinkle-hover text-charcoal"
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

          {/* Step 3 — "Add another" and "Commit all" */}
          {step === 3 && (
            <>
              {stagedImages.length < MAX_BATCH && (
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  disabled={isUploading}
                  className="font-heading font-semibold text-sm text-charcoal border border-charcoal rounded-full px-5 py-1.5 hover:bg-gray-50 transition-colors uppercase tracking-wider disabled:opacity-50"
                >
                  {t("upload_add_more")}
                </button>
              )}
              <button
                type="button"
                onClick={handleCommitAll}
                disabled={isUploading}
                className="inline-flex items-center gap-2 font-heading font-semibold text-sm bg-periwinkle hover:bg-periwinkle-hover text-charcoal rounded-full px-5 py-1.5 transition-colors uppercase tracking-wider disabled:opacity-50"
              >
                {isUploading && (
                  <div className="w-4 h-4 border-2 border-charcoal border-t-transparent rounded-full animate-spin" />
                )}
                {isUploading
                  ? t("upload_uploading")
                  : t("upload_commit_all", { count: stagedImages.length })}
              </button>
            </>
          )}
        </div>

        {/* Upload error */}
        {uploadError && (
          <p className="font-body text-sm text-red-600 text-center w-full">
            {uploadError}
          </p>
        )}
      </div>
    </Dialog>
  );
}
