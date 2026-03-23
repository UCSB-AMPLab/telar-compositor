/**
 * UploadImageDialog — two-step dialog for uploading a self-hosted image.
 *
 * Step 1: Drop zone for file selection (drag-drop or click-browse).
 *         Client-side validation for format and size; invalid files show
 *         an error pill and block advancing.
 * Step 2: Image preview + metadata form (title required, all others optional).
 *         Object ID auto-generated from filename via slugify, editable.
 *         Clicking "Upload Image" calls onConfirm with the full payload.
 */

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Upload, ChevronLeft } from "lucide-react";
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

interface Props {
  open: boolean;
  onClose: () => void;
  onConfirm: (payload: UploadImageConfirmPayload) => void;
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

  // Step state
  const [step, setStep] = useState<1 | 2>(1);

  // File state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  // Metadata state
  const [objectId, setObjectId] = useState("");
  const [title, setTitle] = useState("");
  const [creator, setCreator] = useState("");
  const [description, setDescription] = useState("");
  const [source, setSource] = useState("");
  const [credit, setCredit] = useState("");
  const [period, setPeriod] = useState("");
  const [year, setYear] = useState("");
  const [altText, setAltText] = useState("");

  // Cleanup preview URL on unmount
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  // Reset all state when dialog closes
  useEffect(() => {
    if (!open) {
      setStep(1);
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

  function handleFileSelect(file: File) {
    setValidationError(null);

    // Client-side validation
    if (!ACCEPTED_TYPES.has(file.type)) {
      setValidationError(t("upload_error_format"));
      return;
    }
    if (file.size > MAX_SIZE_BYTES) {
      setValidationError(t("upload_error_size"));
      return;
    }

    // Valid file — set state and advance to step 2
    const url = URL.createObjectURL(file);
    setSelectedFile(file);
    setPreviewUrl(url);

    // Auto-generate object ID and title from filename (minus extension)
    const nameWithoutExt = file.name.replace(/\.[^.]+$/, "");
    const generatedId = slugify(nameWithoutExt, 0);
    setObjectId(generatedId);
    setTitle(nameWithoutExt);
    setAltText("");
    setStep(2);
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
    const file = e.dataTransfer.files[0];
    if (file) handleFileSelect(file);
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFileSelect(file);
    // Reset input so same file can be re-selected if user goes back
    e.target.value = "";
  }

  function handleBack() {
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
    setStep(1);
  }

  function handleConfirm() {
    if (!selectedFile || !title.trim() || isUploading) return;
    onConfirm({
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
    });
  }

  const idCollision = objectId.trim() && existingObjectIds.includes(objectId.trim());

  const inputClass =
    "w-full font-body text-sm border border-gray-200 rounded-lg px-3 py-2 text-charcoal focus:outline-none focus:ring-2 focus:ring-periwinkle disabled:bg-gray-50 disabled:text-gray-400";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="max-w-lg w-full mx-4 p-0 overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-6 py-4 border-b border-gray-100">
        {step === 2 && (
          <button
            type="button"
            onClick={handleBack}
            aria-label={t("upload_back_aria")}
            disabled={isUploading}
            className="text-charcoal hover:text-gray-500 transition-colors disabled:opacity-50 flex-shrink-0"
          >
            <ChevronLeft size={16} />
          </button>
        )}
        <h2 className="font-heading font-semibold text-lg text-charcoal">
          {step === 1 ? t("upload_title") : t("upload_details_title")}
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

            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".jpg,.jpeg,.png,.tif,.tiff"
              className="hidden"
              onChange={handleInputChange}
            />

            {/* Validation error */}
            {validationError && (
              <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 font-body text-sm text-red-700">
                {validationError}
              </div>
            )}
          </>
        )}

        {step === 2 && selectedFile && (
          <div className="space-y-3">
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
                  This ID already exists — the server will generate a unique one.
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
      </div>

      {/* Footer */}
      <div className="flex flex-col items-end gap-2 px-6 py-4 border-t border-gray-100 bg-gray-50">
        <div className="flex items-center justify-end gap-3 w-full">
          <button
            type="button"
            onClick={onClose}
            disabled={isUploading}
            className="font-heading font-semibold text-sm text-charcoal border border-charcoal rounded-full px-5 py-1.5 hover:bg-gray-50 transition-colors uppercase tracking-wider disabled:opacity-50"
          >
            {t("upload_close")}
          </button>

          {step === 2 && (
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
