/**
 * CommitAndBuildModal — full commit + build tracking flow in a modal.
 *
 * Multi-step modal that handles:
 * 1. Confirm commit (with Google Sheets warning if needed)
 * 2. Committing objects.csv to repo
 * 3. 6-phase build progress tracking via the Jobs API
 * 4. Success dismissal or failure rollback
 *
 * Triggered after sync-apply or add-iiif-object adds new objects.
 *
 * @version v1.4.0-beta
 */

import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { CheckCircle2, ExternalLink, Loader2, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { BuildPhaseStatus } from "~/lib/commit.server";
import { Button } from "~/components/ui/Button";

/**
 * Static phase definitions — mirrors BUILD_PHASES from commit.server.ts
 * but defined here to avoid importing a server-only module into client code.
 */
const BUILD_PHASES = [
  { id: "setup", labelKey: "build_phase.setup" },
  { id: "build-js", labelKey: "build_phase.build_js" },
  { id: "process-data", labelKey: "build_phase.process_data" },
  { id: "build-site", labelKey: "build_phase.build_site" },
  { id: "iiif", labelKey: "build_phase.iiif_tiles" },
  { id: "deploy", labelKey: "build_phase.deploy" },
] as const;

/** Map a build phase id to its i18n label key (works for live + fallback phases). */
const PHASE_LABEL_KEYS: Record<string, string> = Object.fromEntries(
  BUILD_PHASES.map((p) => [p.id, p.labelKey])
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Pending object shape — matches PendingObject from sync.server.ts */
interface PendingObject {
  object_id: string;
  title: string | null;
  featured: boolean;
  creator: string | null;
  description: string | null;
  source_url: string | null;
  period: string | null;
  year: string | null;
  object_type: string | null;
  subjects: string | null;
  source: string | null;
  credit: string | null;
  thumbnail: string | null;
  image_available: boolean;
}

type ModalStep =
  | "confirm"
  | "committing"
  | "building"
  | "inserting"
  | "success"
  | "failed"
  // D1 registration failed AFTER the repo commit succeeded. Distinct from
  // "failed": the user's images are safely in the repo, so the right offer is
  // a (server-side idempotent) retry — never "discard".
  | "insert_failed";

interface Props {
  open: boolean;
  sheetsEnabled: boolean;
  urlMismatch: { pagesUrl: string; configUrl: string } | null;
  pendingObjects: PendingObject[];
  onClose: () => void;
  onBuildSuccess: () => void;
  onBuildFailed: () => void;
  // For the upload flow: skip commit step, poll by run ID directly
  skipCommit?: boolean;
  dispatchRunId?: number | null;
  dispatchHtmlUrl?: string | null;
  /**
   * Called after insert-pending-objects succeeds with the D1 ids and
   * object_ids. Used so the objects page can mirror self-hosted uploads
   * into the Yjs Y.Array.
   */
  onInserted?: (inserted: Array<{ id: number; object_id: string }>) => void;
}

type CommitData =
  | {
      ok: true;
      intent: "commit-objects";
      newHeadSha: string;
      dispatchRunId?: number | null;
      /** Commit landed but no workflow run started — skip build tracking. */
      dispatchFailed?: boolean;
    }
  | { ok: false; intent: "commit-objects"; error: string; message?: string }
  | null
  | undefined;

type PollData =
  | {
      ok: true;
      intent: "poll-build";
      buildStatus: string;
      buildConclusion: string | null;
      buildUrl: string | null;
      runId: number | null;
      phases: BuildPhaseStatus[] | null;
    }
  | { ok: false; intent: "poll-build"; error: string }
  | null
  | undefined;

// ---------------------------------------------------------------------------
// Phase indicator (reused from BuildProgressBanner)
// ---------------------------------------------------------------------------

function PhaseCircle({ phase }: { phase: BuildPhaseStatus }) {
  if (phase.status === "in_progress") {
    return (
      <div className="w-8 h-8 rounded-full flex items-center justify-center bg-blue-100">
        <Loader2 className="w-4 h-4 text-blue-600 animate-spin" />
      </div>
    );
  }
  if (phase.status === "completed") {
    if (phase.conclusion === "failure") {
      return (
        <div className="w-8 h-8 rounded-full flex items-center justify-center bg-red-100">
          <XCircle className="w-4 h-4 text-red-600" />
        </div>
      );
    }
    if (phase.conclusion === "skipped") {
      return (
        <div className="w-8 h-8 rounded-full flex items-center justify-center bg-gray-50">
          <span className="text-gray-300 font-heading font-semibold text-sm">–</span>
        </div>
      );
    }
    return (
      <div className="w-8 h-8 rounded-full flex items-center justify-center bg-green-100">
        <CheckCircle2 className="w-4 h-4 text-green-600" />
      </div>
    );
  }
  // queued
  return (
    <div className="w-8 h-8 rounded-full flex items-center justify-center bg-gray-100">
      <span className="font-heading font-semibold text-xs text-gray-400">
        {BUILD_PHASES.findIndex((p) => p.id === phase.id) + 1}
      </span>
    </div>
  );
}

function connectorClass(phase: BuildPhaseStatus): string {
  if (phase.status === "completed" && phase.conclusion !== "failure") return "bg-green-300";
  if (phase.status === "in_progress") return "bg-blue-200";
  return "bg-gray-200";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CommitAndBuildModal({ open, sheetsEnabled, urlMismatch, pendingObjects, onClose, onBuildSuccess, onBuildFailed, skipCommit, dispatchRunId, dispatchHtmlUrl, onInserted }: Props) {
  const { t } = useTranslation("objects");
  const commitFetcher = useFetcher();
  const pollFetcher = useFetcher();
  const insertFetcher = useFetcher();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [step, setStep] = useState<ModalStep>("confirm");
  const [commitSha, setCommitSha] = useState<string | null>(null);
  const [buildConclusion, setBuildConclusion] = useState<string | null>(null);
  const [buildUrl, setBuildUrl] = useState<string | null>(null);
  const [runId, setRunId] = useState<number | null>(null);
  const [phases, setPhases] = useState<BuildPhaseStatus[] | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [buildSkipped, setBuildSkipped] = useState(false);

  const commitData = commitFetcher.data as CommitData;
  const pollData = pollFetcher.data as PollData;

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setBuildConclusion(null);
      setPhases(null);
      setCommitError(null);
      setBuildSkipped(false);

      if (skipCommit) {
        // Upload flow: image already committed, workflow already dispatched.
        // If we have a run ID, jump straight to building and initialise run state.
        // If dispatch failed (no run ID), jump to inserting to persist the pending object.
        setCommitSha(null);
        if (dispatchRunId) {
          setStep("building");
          setRunId(dispatchRunId);
          setBuildUrl(dispatchHtmlUrl ?? null);
        } else {
          // Dispatch failed but commit succeeded — skip build tracking, insert directly.
          setBuildSkipped(true);
          setStep("inserting");
          setRunId(null);
          setBuildUrl(null);
        }
      } else {
        // Normal commit flow: start at confirm step
        setStep("confirm");
        setCommitSha(null);
        setBuildUrl(null);
        setRunId(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Process commit result
  useEffect(() => {
    if (!commitData) return;
    if (commitData.ok && commitData.intent === "commit-objects") {
      if (commitData.dispatchFailed) {
        // The commit landed but no workflow run started — polling by SHA
        // would spin forever on a run that doesn't exist. Register the
        // objects directly; tiles regenerate on the next full build.
        setBuildSkipped(true);
        if (pendingObjects.length > 0) {
          setStep("inserting");
          insertFetcher.submit(
            { intent: "insert-pending-objects", pendingObjects: JSON.stringify(pendingObjects) },
            { method: "post" }
          );
        } else {
          setStep("success");
        }
        return;
      }
      setCommitSha(commitData.newHeadSha);
      setStep("building");
    } else if (!commitData.ok && commitData.intent === "commit-objects") {
      setCommitError(commitData.error);
      setStep("failed");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitData]);

  // Process poll results
  useEffect(() => {
    if (!pollData?.ok || pollData.intent !== "poll-build") return;
    if (pollData.buildUrl) setBuildUrl(pollData.buildUrl);
    if (pollData.runId != null) setRunId(pollData.runId);
    if (pollData.phases) setPhases(pollData.phases);
    if (pollData.buildStatus === "completed") {
      // Mark any still-queued phases as skipped — they weren't part of this workflow
      if (pollData.phases) {
        setPhases(pollData.phases.map((p) =>
          p.status === "queued"
            ? { ...p, status: "completed" as const, conclusion: "skipped" }
            : p
        ));
      }
      setBuildConclusion(pollData.buildConclusion);
      if (pollData.buildConclusion === "success") {
        if (pendingObjects.length > 0) {
          // Build succeeded — insert pending objects into D1
          setStep("inserting");
          insertFetcher.submit(
            { intent: "insert-pending-objects", pendingObjects: JSON.stringify(pendingObjects) },
            { method: "post" }
          );
        } else {
          // No pending objects (e.g. tile generation only) — go straight to success
          setStep("success");
        }
      } else {
        setStep("failed");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollData]);

  // Process insert result. The failure branch matters (telar-compositor#24):
  // without it a failed D1 registration froze the modal on "inserting" forever
  // while the images sat committed in the repo with no D1 rows.
  useEffect(() => {
    const data = insertFetcher.data as
      | { ok: boolean; intent: string; inserted?: Array<{ id: number; object_id: string }>; error?: string }
      | null
      | undefined;
    if (data?.ok && data.intent === "insert-pending-objects") {
      if (onInserted && data.inserted && data.inserted.length > 0) {
        onInserted(data.inserted);
      }
      setStep("success");
    } else if (data && !data.ok && data.intent === "insert-pending-objects") {
      setStep("insert_failed");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insertFetcher.data]);

  // Retry the D1 registration. Safe to repeat: the server action is
  // idempotent (already-registered object_ids are skipped and echoed back
  // with their canonical ids).
  function handleInsertRetry() {
    setStep("inserting");
    insertFetcher.submit(
      { intent: "insert-pending-objects", pendingObjects: JSON.stringify(pendingObjects) },
      { method: "post" }
    );
  }

  // When skipCommit and dispatch failed (step jumps directly to inserting on open),
  // trigger D1 insert immediately so pending objects are persisted even without a build.
  const hasTriggeredInsertRef = useRef(false);
  useEffect(() => {
    if (step === "inserting" && skipCommit && !dispatchRunId && !hasTriggeredInsertRef.current) {
      hasTriggeredInsertRef.current = true;
      insertFetcher.submit(
        { intent: "insert-pending-objects", pendingObjects: JSON.stringify(pendingObjects) },
        { method: "post" }
      );
    }
    if (!open) {
      hasTriggeredInsertRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, open]);

  // Set up polling when building.
  // In the normal flow, polling requires commitSha (for SHA-based run discovery).
  // In the upload flow (skipCommit), polling uses dispatchRunId directly — no SHA needed.
  //
  // Cross-reference: PublishingPopover.tsx has a structurally similar 5s
  // poll-build loop (same immediate-fire-then-setInterval shape, same
  // double-cleanup-effect pattern) but is NOT extracted into a shared hook
  // with this one — the bodies diverge materially: (1) this effect gates on
  // a `step` state machine ("building" + commitSha/skipCommit+runId), while
  // PublishingPopover gates on awareness booleans (isPublishing/isBuilding);
  // (2) this effect branches the submit payload into two distinct shapes
  // (runId-only for the upload flow vs sha+optional-runId for the commit
  // flow), while PublishingPopover always sends sha and reads runId back out
  // of the *previous* poll response via a ref, never from a prop; (3) this
  // effect submits to the ambient route action (no explicit `action`), while
  // PublishingPopover explicitly targets `action: "/publish"` since it can
  // render from outside the /publish route. Forcing a shared hook over those
  // three axes would either lose a real distinction or grow enough
  // parameters to stop being simpler than two 15-line effects.
  useEffect(() => {
    const canPollBySha = step === "building" && !!commitSha;
    const canPollByRunId = step === "building" && !!skipCommit && !!runId;

    if (!canPollBySha && !canPollByRunId) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }

    function doPoll() {
      if (skipCommit && runId != null) {
        // Upload flow: poll by run ID directly — no SHA needed
        pollFetcher.submit(
          { intent: "poll-build", runId: String(runId) },
          { method: "post" }
        );
      } else {
        // Normal commit flow: poll by SHA, optionally with known run ID
        const formData: Record<string, string> = { intent: "poll-build", sha: commitSha! };
        if (runId != null) formData.runId = String(runId);
        pollFetcher.submit(formData, { method: "post" });
      }
    }

    // Fire immediately
    doPoll();

    // Then every 5 seconds
    intervalRef.current = setInterval(doPoll, 5000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, commitSha, runId, skipCommit]);

  // Clean up interval on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  function handleConfirm() {
    setStep("committing");
    commitFetcher.submit(
      {
        intent: "commit-objects",
        disableSheets: sheetsEnabled ? "true" : "false",
        fixUrl: urlMismatch ? "true" : "false",
        pagesUrl: urlMismatch?.pagesUrl ?? "",
        pendingObjects: JSON.stringify(pendingObjects),
      },
      { method: "post" }
    );
  }

  function handleSuccessDismiss() {
    onBuildSuccess();
  }

  function handleFailedDismiss() {
    onBuildFailed();
  }

  // Display phases — use live data or fall back to static BUILD_PHASES with queued status
  const displayPhases: BuildPhaseStatus[] =
    phases ??
    BUILD_PHASES.map((p) => ({
      id: p.id,
      label: t(p.labelKey),
      status: "queued" as const,
      conclusion: null,
    }));

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-lg mx-4 overflow-hidden">
        {/* --- Confirm step --- */}
        {step === "confirm" && (
          <div className="p-6">
            <h3 className="font-heading font-semibold text-lg text-charcoal mb-2">
              {t("commitModal.heading", { count: pendingObjects.length })}
            </h3>
            <p className="font-body text-sm text-gray-600 mb-4">
              {t("commitModal.description", { count: pendingObjects.length })}
            </p>

            {urlMismatch && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
                <p className="font-body text-sm text-red-900 mb-1">{t("commitModal.urlMismatch")}</p>
                <p className="font-mono text-xs text-red-700 mb-1">
                  _config.yml: <strong>{urlMismatch.configUrl}</strong>
                </p>
                <p className="font-mono text-xs text-red-700 mb-2">
                  GitHub Pages: <strong>{urlMismatch.pagesUrl}</strong>
                </p>
                <p className="font-body text-xs text-gray-600">{t("commitModal.urlFix")}</p>
              </div>
            )}

            {sheetsEnabled && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
                <p className="font-body text-sm text-amber-900 mb-1">{t("sheetsWarning")}</p>
                <p className="font-body text-xs text-amber-700">{t("sheetsReversible")}</p>
              </div>
            )}

            <div className="flex gap-3 justify-end">
              <button
                type="button"
                onClick={onClose}
                className="font-heading font-semibold text-sm uppercase tracking-wider border border-gray-200 text-charcoal rounded-full px-6 py-2.5 hover:bg-cream transition-colors"
              >
                {t("commitModal.cancel")}
              </button>
              <Button variant="primary" type="button" onClick={handleConfirm}>
                {t("commitModal.confirm")}
              </Button>
            </div>
          </div>
        )}

        {/* --- Committing step --- */}
        {step === "committing" && (
          <div className="p-6 flex flex-col items-center gap-3 py-10">
            <Loader2 className="w-8 h-8 text-anil animate-spin" />
            <p className="font-body text-sm text-gray-600">{t("committingToRepo")}</p>
          </div>
        )}

        {/* --- Building step (6-phase progress) --- */}
        {step === "building" && (
          <div className="p-6">
            <h3 className="font-heading font-semibold text-lg text-charcoal mb-4">
              {t("commitModal.buildingHeading")}
            </h3>

            {/* Phase stepper */}
            {!phases && (
              <div className="flex items-center gap-2 text-gray-500 mb-4">
                <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" />
                <span className="font-body text-sm">{t("buildQueued")}</span>
              </div>
            )}

            {phases && (
              <div className="flex items-start mb-4">
                {displayPhases.map((phase, index) => (
                  <div key={phase.id} className="flex items-center flex-1">
                    <div className="flex flex-col items-center gap-1 flex-shrink-0">
                      <PhaseCircle phase={phase} />
                      <span
                        className={`font-heading text-xs whitespace-nowrap text-center leading-tight ${
                          phase.status === "completed" && phase.conclusion !== "failure"
                            ? "text-green-600"
                            : phase.status === "in_progress"
                            ? "text-blue-600 font-semibold"
                            : "text-gray-400"
                        }`}
                      >
                        {PHASE_LABEL_KEYS[phase.id] ? t(PHASE_LABEL_KEYS[phase.id]) : phase.label}
                      </span>
                    </div>
                    {index < displayPhases.length - 1 && (
                      <div
                        className={`flex-1 min-w-2 h-0.5 mx-1 mb-5 transition-colors ${connectorClass(phase)}`}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}

            {buildUrl && (
              <a
                href={buildUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-body text-xs text-blue-600 hover:underline"
              >
                {t("viewOnGitHub")}
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
        )}

        {/* --- Inserting step (D1 insert after build success) --- */}
        {step === "inserting" && (
          <div className="p-6 flex flex-col items-center gap-3 py-10">
            <Loader2 className="w-8 h-8 text-anil animate-spin" />
            <p className="font-body text-sm text-gray-600">{t("commitModal.insertingObjects")}</p>
          </div>
        )}

        {/* --- Success step --- */}
        {step === "success" && (
          <div className="p-6">
            <div className="flex flex-col items-center gap-3 py-4 mb-4">
              <CheckCircle2 className="w-12 h-12 text-green-500" />
              <h3 className="font-heading font-semibold text-lg text-charcoal">
                {buildSkipped ? t("objectSaved") : t("buildSuccess")}
              </h3>
              {buildSkipped && (
                <p className="font-body text-sm text-gray-500 text-center">
                  {t("objectSavedHint")}
                </p>
              )}
            </div>

            <div className="flex items-center justify-between">
              {buildUrl && (
                <a
                  href={buildUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-body text-sm text-blue-600 hover:underline"
                >
                  {t("viewOnGitHub")}
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
              <Button variant="primary" type="button" onClick={handleSuccessDismiss}>
                {t("commitModal.done")}
              </Button>
            </div>
          </div>
        )}

        {/* --- Insert-failed step (repo commit OK, D1 registration failed) --- */}
        {step === "insert_failed" && (
          <div className="p-6">
            <div className="flex flex-col items-center gap-3 py-4 mb-4">
              <XCircle className="w-12 h-12 text-red-500" />
              <h3 className="font-heading font-semibold text-lg text-charcoal">
                {t("commitModal.insertFailedHeading")}
              </h3>
              <p className="font-body text-sm text-gray-500 text-center">
                {t("commitModal.insertFailedBody")}
              </p>
            </div>
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="font-heading font-semibold text-sm uppercase tracking-wider text-charcoal hover:text-gray-500 px-4 py-2.5 transition-colors"
              >
                {t("commitModal.close")}
              </button>
              <Button variant="primary" type="button" onClick={handleInsertRetry}>
                {t("commitModal.insertRetry")}
              </Button>
            </div>
          </div>
        )}

        {/* --- Failed step --- */}
        {step === "failed" && (
          <div className="p-6">
            <div className="flex flex-col items-center gap-3 py-4 mb-4">
              <XCircle className="w-12 h-12 text-red-500" />
              <h3 className="font-heading font-semibold text-lg text-charcoal">
                {commitError === "stale_head"
                  ? t("staleHeadError")
                  : commitError === "commit_failed"
                    ? t("commitFailed")
                    : t("buildFailed")}
              </h3>
            </div>

            <div className="flex items-center justify-between">
              {buildUrl && (
                <a
                  href={buildUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-body text-sm text-blue-600 hover:underline"
                >
                  {t("viewOnGitHub")}
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
              <button
                type="button"
                onClick={handleFailedDismiss}
                className="font-heading font-semibold text-sm uppercase tracking-wider bg-red-500 hover:bg-red-600 text-white rounded-full px-6 py-2.5 transition-colors"
              >
                {t("commitModal.discardChanges")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
