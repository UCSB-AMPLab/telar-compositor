/**
 * StepSync — import progress checklist with error handling.
 *
 * Shows a checklist of import tasks with spinner/checkmark/X state indicators.
 * Handles sheetsAccessError blocking path: shows inline URL input and retry
 * button. Does NOT offer any fallback or "skip Sheets" option — the Sheet
 * IS the source of truth when google_sheets.enabled is true.
 *
 * Auto-advances to Review after 1.5s when import succeeds.
 */

import { useEffect, useState } from "react";
import { CheckCircle, XCircle, Circle, Loader2, ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "~/components/ui/Button";
import type { ImportResult } from "~/lib/import.server";

interface StepSyncProps {
  importResult: ImportResult | null;
  isImporting: boolean;
  onBack: () => void;
  onContinue: () => void;
  onRetryWithUrl: (url: string) => void;
  className?: string;
}

type ItemState = "pending" | "loading" | "done" | "error";

interface ChecklistItem {
  key: string;
  i18nKey: string;
  /** Extra info appended after the label (e.g. count) */
  detail?: string;
  state: ItemState;
}

export function StepSync({
  importResult,
  isImporting,
  onBack,
  onContinue,
  onRetryWithUrl,
  className = "",
}: StepSyncProps) {
  const { t } = useTranslation("onboarding");
  const [sheetsUrl, setSheetsUrl] = useState("");

  // Pre-fill Sheets URL from importResult on error
  useEffect(() => {
    if (importResult?.sheetsAccessError && importResult.sheetsPublishedUrl) {
      setSheetsUrl(importResult.sheetsPublishedUrl);
    }
  }, [importResult?.sheetsAccessError, importResult?.sheetsPublishedUrl]);

  // No auto-advance — user clicks Continue after reviewing import results

  // Build checklist items
  const items = buildChecklistItems(importResult, isImporting);

  const isValidationError =
    !isImporting &&
    importResult &&
    !importResult.valid &&
    !importResult.sheetsAccessError;

  const isSheetsError =
    !isImporting && importResult?.sheetsAccessError === true;

  return (
    <div className={className}>
      <h2 className="font-heading font-semibold text-xl text-charcoal mb-5">
        {t("step_sync.heading")}
      </h2>

      {/* Checklist */}
      <ul className="space-y-3 mb-6" aria-label="Import progress">
        {items.map((item) => (
          <li key={item.key} className="flex items-center gap-3">
            <StateIcon state={item.state} />
            <span className="font-body text-sm text-charcoal">
              {t(item.i18nKey)}
              {item.detail && (
                <span className="text-gray-500 ml-1">{item.detail}</span>
              )}
            </span>
          </li>
        ))}
      </ul>

      {/* Success — Cancel + Continue buttons */}
      {importResult?.valid && !isImporting && (
        <div className="flex items-center gap-3">
          <Button variant="secondary" onClick={onBack}>
            {t("step_sync.cancel")}
          </Button>
          <Button variant="primary" onClick={onContinue}>
            {t("step_sync.continue")}
          </Button>
        </div>
      )}

      {/* Sheets access error */}
      {isSheetsError && (
        <div className="mt-4 space-y-4">
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <p className="text-red-700 text-sm font-body mb-3">
              {t("step_sync.error_sheets_access")}
            </p>
            <label className="block mb-1">
              <span className="text-sm font-body text-charcoal font-medium">
                {t("step_sync.sheets_url_label")}
              </span>
              <input
                type="url"
                value={sheetsUrl}
                onChange={(e) => setSheetsUrl(e.target.value)}
                placeholder={t("step_sync.sheets_url_placeholder")}
                className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-body text-charcoal placeholder-gray-400"
              />
            </label>
          </div>

          <div className="flex items-center gap-3">
            <Button
              variant="primary"
              onClick={() => onRetryWithUrl(sheetsUrl)}
              disabled={!sheetsUrl.trim()}
            >
              {t("step_sync.sheets_retry")}
            </Button>
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-1.5 text-sm font-body text-gray-500 hover:text-charcoal transition-colors"
            >
              <ArrowLeft className="w-4 h-4" aria-hidden="true" />
              {t("step_sync.back")}
            </button>
          </div>
        </div>
      )}

      {/* Validation error (not_telar or empty_repo) */}
      {isValidationError && (
        <div className="mt-4 space-y-4">
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <p className="text-red-700 text-sm font-body">
              {importResult.validationError === "not_telar"
                ? t("step_sync.error_not_telar")
                : importResult.validationError === "already_connected"
                  ? t("step_sync.error_already_connected")
                  : t("step_sync.error_empty_repo")}
            </p>
          </div>
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 text-sm font-body text-gray-500 hover:text-charcoal transition-colors"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
            {t("step_sync.back")}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function StateIcon({ state }: { state: ItemState }) {
  switch (state) {
    case "loading":
      return <Loader2 className="w-5 h-5 text-anil animate-spin flex-shrink-0" aria-hidden="true" />;
    case "done":
      return <CheckCircle className="w-5 h-5 text-green-500 flex-shrink-0" aria-hidden="true" />;
    case "error":
      return <XCircle className="w-5 h-5 text-red-500 flex-shrink-0" aria-hidden="true" />;
    default:
      return <Circle className="w-5 h-5 text-gray-300 flex-shrink-0" aria-hidden="true" />;
  }
}

function buildChecklistItems(
  result: ImportResult | null,
  isImporting: boolean,
): ChecklistItem[] {
  // While import is running, show first item loading, rest pending
  if (isImporting) {
    return [
      { key: "validating", i18nKey: "step_sync.validating", state: "loading" },
      { key: "config", i18nKey: "step_sync.importing_config", state: "pending" },
      { key: "objects", i18nKey: "step_sync.importing_objects", state: "pending" },
      { key: "stories", i18nKey: "step_sync.importing_stories", state: "pending" },
      { key: "glossary", i18nKey: "step_sync.importing_glossary_entries", state: "pending" },
      { key: "pages", i18nKey: "step_sync.importing_pages", state: "pending" },
      { key: "iiif", i18nKey: "step_sync.scanning_iiif", state: "pending" },
    ];
  }

  if (!result) {
    return [
      { key: "validating", i18nKey: "step_sync.validating", state: "pending" },
      { key: "config", i18nKey: "step_sync.importing_config", state: "pending" },
      { key: "objects", i18nKey: "step_sync.importing_objects", state: "pending" },
      { key: "stories", i18nKey: "step_sync.importing_stories", state: "pending" },
      { key: "glossary", i18nKey: "step_sync.importing_glossary_entries", state: "pending" },
      { key: "pages", i18nKey: "step_sync.importing_pages", state: "pending" },
      { key: "iiif", i18nKey: "step_sync.scanning_iiif", state: "pending" },
    ];
  }

  // Validation failed
  if (!result.valid && result.validationError) {
    return [
      { key: "validating", i18nKey: "step_sync.validating", state: "error" },
      { key: "config", i18nKey: "step_sync.importing_config", state: "pending" },
      { key: "objects", i18nKey: "step_sync.importing_objects", state: "pending" },
      { key: "stories", i18nKey: "step_sync.importing_stories", state: "pending" },
      { key: "glossary", i18nKey: "step_sync.importing_glossary_entries", state: "pending" },
      { key: "pages", i18nKey: "step_sync.importing_pages", state: "pending" },
      { key: "iiif", i18nKey: "step_sync.scanning_iiif", state: "pending" },
    ];
  }

  // Sheets access error
  if (result.sheetsAccessError) {
    const items: ChecklistItem[] = [
      { key: "validating", i18nKey: "step_sync.validating", state: "done" },
      { key: "config", i18nKey: "step_sync.importing_config", state: "done" },
      { key: "objects", i18nKey: "step_sync.importing_objects", state: "pending" },
      { key: "stories", i18nKey: "step_sync.importing_stories", state: "pending" },
      { key: "glossary", i18nKey: "step_sync.importing_glossary_entries", state: "pending" },
      { key: "pages", i18nKey: "step_sync.importing_pages", state: "pending" },
      { key: "iiif", i18nKey: "step_sync.scanning_iiif", state: "pending" },
      { key: "sheets", i18nKey: "step_sync.importing_sheets", state: "error" },
    ];
    return items;
  }

  // Success — all items done with counts
  const audioCount = result.audioObjectIds?.length ?? 0;
  const videoCount = result.videoObjectCount ?? 0;
  const imageCount = result.objects.imported - audioCount - videoCount;
  const objectBreakdown = [
    imageCount > 0 ? `${imageCount} images` : null,
    audioCount > 0 ? `${audioCount} audio` : null,
    videoCount > 0 ? `${videoCount} videos` : null,
  ].filter(Boolean).join(", ");

  const items: ChecklistItem[] = [
    { key: "validating", i18nKey: "step_sync.validating", state: "done" },
    { key: "config", i18nKey: "step_sync.importing_config", state: "done" },
    {
      key: "objects",
      i18nKey: "step_sync.importing_objects",
      state: "done",
      detail: `(${result.objects.imported})${objectBreakdown ? ` — ${objectBreakdown}` : ""}`,
    },
    {
      key: "stories",
      i18nKey: "step_sync.importing_stories",
      state: "done",
      detail: `(${result.stories.imported})`,
    },
    {
      key: "glossary",
      i18nKey: "step_sync.importing_glossary_entries",
      state: "done",
      detail: `(${result.glossary.imported})`,
    },
    {
      key: "pages",
      i18nKey: "step_sync.importing_pages",
      state: "done",
      detail: `(${result.pages.imported})`,
    },
    {
      key: "iiif",
      i18nKey: "step_sync.scanning_iiif",
      state: "done",
      detail: `(${result.iiifObjectIds.length})`,
    },
  ];

  if (result.sheetsEnabled || result.sheetsDisabled) {
    items.push({
      key: "sheets",
      i18nKey: "step_sync.importing_sheets",
      state: "done",
    });
  }

  return items;
}
