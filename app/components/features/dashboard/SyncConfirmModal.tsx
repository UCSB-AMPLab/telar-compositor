/**
 * This file renders the Sync confirmation modal — the multi-step
 * modal launched from the dashboard when the user pulls changes
 * made directly in the GitHub repo back into the compositor.
 *
 * Provides a state-machine flow:
 *   1. Confirm — prompt user to check what changed in the repo
 *   2. Computing — diffFetcher submits compute-full-sync-diff intent
 *   3. (Optional) Conflict — warns about unpublished local changes
 *   4. DiffReady — category-grouped diff display with apply button
 *   5. Applying — applyFetcher submits apply-full-sync intent
 *   6. Success — brief confirmation, then page refresh
 *   7. Failed — error display with retry option
 *
 * All-or-nothing: the apply step accepts every change in the diff.
 *
 * @version v1.2.0-beta
 */

import { useEffect, useState } from "react";
import { useFetcher, useNavigate } from "react-router";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Dialog } from "~/components/ui/Dialog";
import type { FullSyncDiff, FullSyncChanges } from "~/lib/sync.server";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Shared useFetcher key so the dashboard route can observe the same
 * compute-full-sync-diff response and surface the version-change
 * toast without duplicating the submission.
 */
export const SYNC_DIFF_FETCHER_KEY = "dashboard-sync-diff";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SyncStep =
  | "confirm"
  | "computing"
  | "conflict"
  | "diffReady"
  | "applying"
  | "accepting"
  | "success"
  | "acceptedSuccess"
  | "failed";

interface SyncConfirmModalProps {
  open: boolean;
  unpublishedCount: number;
  onClose: () => void;
}

type DiffFetcherData =
  | { ok: true; intent: "compute-full-sync-diff"; diff: FullSyncDiff }
  | { ok: false; intent: "compute-full-sync-diff"; error: string; message?: string }
  | null
  | undefined;

type ApplyFetcherData =
  | { ok: true; intent: "apply-full-sync"; newHeadSha: string }
  | { ok: false; intent: "apply-full-sync"; error: string }
  | { ok: true; intent: "accept-divergence" }
  | { ok: false; intent: "accept-divergence"; error: string; message?: string }
  | null
  | undefined;

// ---------------------------------------------------------------------------
// Helper: count total changes in a diff
// ---------------------------------------------------------------------------

function hasDiffChanges(diff: FullSyncDiff): boolean {
  return (
    diff.objects.newObjects.length > 0 ||
    diff.objects.changedObjects.length > 0 ||
    diff.objects.missingObjects.length > 0 ||
    diff.stories.newStories.length > 0 ||
    diff.stories.changedStories.length > 0 ||
    diff.stories.missingStories.length > 0 ||
    diff.config.changedFields.length > 0
  );
}

// ---------------------------------------------------------------------------
// Helper: build all-or-nothing FullSyncChanges from a FullSyncDiff
// ---------------------------------------------------------------------------

function buildAllOrNothingChanges(diff: FullSyncDiff): FullSyncChanges {
  return {
    objects: {
      newObjectIds: diff.objects.newObjects.map((o) => o.object_id),
      changedObjectIds: diff.objects.changedObjects.map((o) => o.object_id),
      fieldChoices: Object.fromEntries(
        diff.objects.changedObjects.map((o) => [
          o.object_id,
          Object.fromEntries(o.changedFields.map((f) => [f, "repo" as const])),
        ])
      ),
      removedObjectIds: diff.objects.missingObjects.map((o) => o.object_id),
      unregisteredObjectIds: [],
    },
    stories: {
      accept: diff.stories.changedStories.map((s) => s.story_id),
      reject: [],
      insertNew: diff.stories.newStories.map((s) => s.story_id),
    },
    config: {
      accept: diff.config.changedFields.map((c) => c.key),
      reject: [],
    },
    glossary: {
      accept: diff.glossary.changed.map((t) => t.term_id),
      reject: [],
      insertNew: diff.glossary.added.map((t) => t.term_id),
    },
  };
}

// ---------------------------------------------------------------------------
// Collapsible category section
// ---------------------------------------------------------------------------

interface CategorySectionProps {
  label: string;
  items: string[];
}

function CategorySection({ label, items }: CategorySectionProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border border-gray-100 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 bg-cream-dark hover:bg-cream-dark/80 transition-colors"
      >
        <span className="font-heading font-semibold text-sm text-charcoal">{label}</span>
        {open ? (
          <ChevronUp className="w-4 h-4 text-charcoal/50" />
        ) : (
          <ChevronDown className="w-4 h-4 text-charcoal/50" />
        )}
      </button>
      {open && (
        <ul className="px-4 py-2 space-y-1 bg-white">
          {items.map((item) => (
            <li key={item} className="font-body text-sm text-charcoal/80">
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SyncConfirmModal({ open, unpublishedCount, onClose }: SyncConfirmModalProps) {
  const { t } = useTranslation("dashboard");
  const navigate = useNavigate();
  // Stable fetcher key so the dashboard route can subscribe to the same
  // sync-diff response via useFetcher({ key }) and surface the
  // version-change toast (see _app.dashboard.tsx / useVersionChangeToast).
  const diffFetcher = useFetcher({ key: SYNC_DIFF_FETCHER_KEY });
  const applyFetcher = useFetcher();

  const [step, setStep] = useState<SyncStep>("confirm");
  const [diff, setDiff] = useState<FullSyncDiff | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>("");

  const diffData = diffFetcher.data as DiffFetcherData;
  const applyData = applyFetcher.data as ApplyFetcherData;

  // Reset step when modal opens or closes
  useEffect(() => {
    if (!open) {
      setStep("confirm");
      setDiff(null);
      setErrorMessage("");
    }
  }, [open]);

  // Handle diff fetcher result
  useEffect(() => {
    if (!diffData) return;
    if (!diffData.ok || diffData.intent !== "compute-full-sync-diff") {
      setErrorMessage(
        diffData.ok ? "" : (diffData.message ?? diffData.error ?? "Unknown error")
      );
      setStep("failed");
      return;
    }
    setDiff(diffData.diff);
    const hasChanges = hasDiffChanges(diffData.diff);
    if (!hasChanges) {
      setStep("diffReady");
      return;
    }
    if (unpublishedCount > 0) {
      setStep("conflict");
    } else {
      setStep("diffReady");
    }
  }, [diffData, unpublishedCount]);

  // Handle apply / accept-divergence fetcher result
  useEffect(() => {
    if (!applyData) return;
    if (!applyData.ok) {
      setErrorMessage(applyData.error ?? "Unknown error");
      setStep("failed");
      return;
    }
    if (applyData.intent === "accept-divergence") {
      setStep("acceptedSuccess");
      setTimeout(() => window.location.reload(), 1500);
      return;
    }
    if (applyData.intent === "apply-full-sync") {
      setStep("success");
      setTimeout(() => window.location.reload(), 1500);
    }
  }, [applyData]);

  function handleCheckChanges() {
    setStep("computing");
    diffFetcher.submit({ intent: "compute-full-sync-diff" }, { method: "post" });
  }

  function handleApply() {
    if (!diff) return;
    const changes = buildAllOrNothingChanges(diff);
    setStep("applying");
    applyFetcher.submit(
      { intent: "apply-full-sync", changes: JSON.stringify(changes) },
      { method: "post" }
    );
  }

  function handleAcceptDivergence() {
    setStep("accepting");
    applyFetcher.submit(
      { intent: "accept-divergence" },
      { method: "post" }
    );
  }

  function handlePublishFirst() {
    onClose();
    navigate("/publish");
  }

  // ---------------------------------------------------------------------------
  // Build category sections for diffReady step
  // ---------------------------------------------------------------------------

  function buildCategorySections() {
    if (!diff) return [];
    const sections: { label: string; items: string[] }[] = [];

    // Objects
    const objectItems: string[] = [
      ...diff.objects.newObjects.map((o) => `${o.object_id} (${t("sync_modal.new_items", { count: 1 }).replace("1 ", "").trim()} new)`),
      ...diff.objects.changedObjects.map((o) => `${o.object_id} (changed)`),
      ...diff.objects.missingObjects.map((o) => `${o.object_id} (removed)`),
    ];
    if (objectItems.length > 0) {
      sections.push({
        label: `${t("sync_modal.objects_category")} (${diff.objects.newObjects.length + diff.objects.changedObjects.length + diff.objects.missingObjects.length} ${diff.objects.changedObjects.length > 0 ? "changed" : "total"})`,
        items: objectItems,
      });
    }

    // Stories
    const storyItems: string[] = [
      ...diff.stories.newStories.map((s) => `${s.title ?? s.story_id} (new)`),
      ...diff.stories.changedStories.map((s) => `${s.title ?? s.story_id} (changed)`),
      ...diff.stories.missingStories.map((s) => `${s.title ?? s.story_id} (removed)`),
    ];
    if (storyItems.length > 0) {
      sections.push({
        label: `${t("sync_modal.stories_category")} (${diff.stories.newStories.length + diff.stories.changedStories.length + diff.stories.missingStories.length} total)`,
        items: storyItems,
      });
    }

    // Config
    if (diff.config.changedFields.length > 0) {
      sections.push({
        label: `${t("sync_modal.config_category")} (${diff.config.changedFields.length} changed)`,
        items: diff.config.changedFields.map((c) => c.key),
      });
    }

    return sections;
  }

  const categorySections = buildCategorySections();

  return (
    <Dialog open={open} onClose={onClose} className="max-w-lg p-0">
      {/* ------------------------------------------------------------------ */}
      {/* Confirm step                                                         */}
      {/* ------------------------------------------------------------------ */}
      {step === "confirm" && (
        <div className="p-6">
          <h3 className="font-heading font-semibold text-lg text-charcoal mb-2">
            {t("sync_modal.title")}
          </h3>
          <p className="font-body text-sm text-gray-600 mb-6">
            {t("sync_modal.confirm_body")}
          </p>
          <div className="flex gap-3 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="font-heading font-semibold text-sm uppercase tracking-wider border border-gray-200 text-charcoal rounded-full px-5 py-2 hover:bg-cream transition-colors"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={handleCheckChanges}
              className="font-heading font-semibold text-sm uppercase tracking-wider bg-terracotta hover:bg-terracotta/90 text-cream rounded-full px-5 py-2 transition-colors"
            >
              {t("sync_modal.check_changes")}
            </button>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Computing step                                                       */}
      {/* ------------------------------------------------------------------ */}
      {step === "computing" && (
        <div className="p-6 flex flex-col items-center gap-4 py-12">
          <Loader2 className="w-8 h-8 text-terracotta animate-spin" />
          <p className="font-body text-sm text-gray-600">{t("sync_modal.computing")}</p>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Conflict step                                                        */}
      {/* ------------------------------------------------------------------ */}
      {step === "conflict" && (
        <div className="p-6">
          <div className="flex items-start gap-3 mb-5">
            <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
            <div>
              <h3 className="font-heading font-semibold text-base text-charcoal mb-1">
                {t("sync_modal.title")}
              </h3>
              <p className="font-body text-sm text-gray-600">
                {t("sync_modal.conflict_warning", { count: unpublishedCount })}
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setStep("diffReady")}
              className="w-full font-heading font-semibold text-sm uppercase tracking-wider bg-terracotta hover:bg-terracotta/90 text-cream rounded-full px-5 py-2 transition-colors"
            >
              {t("sync_modal.sync_anyway")}
            </button>
            <button
              type="button"
              onClick={handlePublishFirst}
              className="w-full font-heading font-semibold text-sm uppercase tracking-wider border border-terracotta text-terracotta rounded-full px-5 py-2 hover:bg-terracotta/5 transition-colors"
            >
              {t("sync_modal.publish_first")}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="w-full font-heading font-semibold text-sm uppercase tracking-wider border border-gray-200 text-charcoal rounded-full px-5 py-2 hover:bg-cream transition-colors"
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* DiffReady step                                                       */}
      {/* ------------------------------------------------------------------ */}
      {step === "diffReady" && (
        <div className="p-6">
          <h3 className="font-heading font-semibold text-lg text-charcoal mb-4">
            {categorySections.length > 0
              ? t("sync_modal.changes_found")
              : t("sync_modal.no_changes")}
          </h3>
          {categorySections.length > 0 && (
            <div className="space-y-2 mb-6">
              {categorySections.map((section) => (
                <CategorySection
                  key={section.label}
                  label={section.label}
                  items={section.items}
                />
              ))}
            </div>
          )}
          {categorySections.length > 0 && (
            <p className="font-body text-sm text-gray-600 mb-4">
              {t("sync_modal.use_compositor_helper")}
            </p>
          )}
          {categorySections.length === 0 && (
            <p className="font-body text-sm text-gray-600 mb-4">
              {t("sync_modal.no_changes_body")}
            </p>
          )}
          <div className="flex flex-wrap gap-3 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="font-heading font-semibold text-sm uppercase tracking-wider border border-gray-200 text-charcoal rounded-full px-5 py-2 hover:bg-cream transition-colors"
            >
              {categorySections.length > 0 ? t("cancel") : t("sync_modal.close")}
            </button>
            {categorySections.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={handleAcceptDivergence}
                  className="font-heading font-semibold text-sm uppercase tracking-wider border border-charcoal text-charcoal rounded-full px-5 py-2 hover:bg-charcoal hover:text-cream transition-colors"
                >
                  {t("sync_modal.use_compositor_version")}
                </button>
                <button
                  type="button"
                  onClick={handleApply}
                  className="font-heading font-semibold text-sm uppercase tracking-wider bg-terracotta hover:bg-terracotta/90 text-cream rounded-full px-5 py-2 transition-colors"
                >
                  {t("sync_modal.apply_sync")}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Applying step                                                        */}
      {/* ------------------------------------------------------------------ */}
      {step === "applying" && (
        <div className="p-6 flex flex-col items-center gap-4 py-12">
          <Loader2 className="w-8 h-8 text-terracotta animate-spin" />
          <p className="font-body text-sm text-gray-600">{t("sync_modal.applying")}</p>
        </div>
      )}

      {/* Accepting (accept-divergence in flight) */}
      {step === "accepting" && (
        <div className="p-6 flex flex-col items-center gap-4 py-12">
          <Loader2 className="w-8 h-8 text-charcoal animate-spin" />
          <p className="font-body text-sm text-gray-600">{t("sync_modal.accepting")}</p>
        </div>
      )}

      {/* Accept-divergence succeeded */}
      {step === "acceptedSuccess" && (
        <div className="p-6 flex flex-col items-center gap-4 py-12">
          <CheckCircle2 className="w-10 h-10 text-green-500" />
          <p className="font-body text-sm text-gray-700">{t("sync_modal.accepted_success")}</p>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Success step                                                         */}
      {/* ------------------------------------------------------------------ */}
      {step === "success" && (
        <div className="p-6 flex flex-col items-center gap-4 py-12">
          <CheckCircle2 className="w-10 h-10 text-green-500" />
          <p className="font-body text-sm text-gray-700">{t("sync_modal.success")}</p>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Failed step                                                          */}
      {/* ------------------------------------------------------------------ */}
      {step === "failed" && (
        <div className="p-6">
          <div className="flex flex-col items-center gap-3 py-6 mb-4">
            <AlertCircle className="w-10 h-10 text-red-500" />
            <p className="font-body text-sm text-gray-700 text-center">{errorMessage}</p>
          </div>
          <div className="flex gap-3 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="font-heading font-semibold text-sm uppercase tracking-wider border border-gray-200 text-charcoal rounded-full px-5 py-2 hover:bg-cream transition-colors"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={() => setStep("confirm")}
              className="font-heading font-semibold text-sm uppercase tracking-wider bg-terracotta hover:bg-terracotta/90 text-cream rounded-full px-5 py-2 transition-colors"
            >
              {t("sync_modal.retry")}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
