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
 * @version v1.5.0-beta
 */

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useSiteFetcher } from "~/lib/page-site";
import { isSiteChanged } from "~/components/features/site-status/SiteChangedNotice";
import { CheckCircle2, ExternalLink, Loader2, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { BuildPhaseStatus } from "~/lib/commit.server";
import type { RegistrationResult } from "~/lib/register-objects.server";
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
  /** The objects sheet's file name on the site: objects.csv, or objetos.csv where the site holds that one. Only the commit step names it. */
  objectsFile?: string;
  /**
   * The pre-commit check has not answered for this site: Confirm waits, since
   * the commit's Sheets flag and URL check come from that answer.
   */
  checkPending?: boolean;
  /** The pre-commit check could not be made: say so, and offer to run it again. */
  checkFailed?: boolean;
  onRetryCheck?: () => void;
  urlMismatch: { pagesUrl: string; configUrl: string } | null;
  pendingObjects: PendingObject[];
  onClose: () => void;
  /** Called on the success step's Done, with whether a build made the tiles. */
  onBuildSuccess: (built: boolean) => void;
  onBuildFailed: () => void;
  // For the upload flow: skip commit step, poll by run ID directly
  skipCommit?: boolean;
  dispatchRunId?: number | null;
  dispatchHtmlUrl?: string | null;
  /** The upload's own registration of its objects, for the upload flow. */
  registration?: RegistrationResult | null;
  /** The project the upload committed to, for a registration retry. */
  projectId?: number | null;
  /**
   * Called once the objects are registered, by the committing action or a
   * retry, with the objects registered. The page writes nothing: the objects
   * reach the shared document through the collaboration DO, which appends
   * them and broadcasts the new state, so there is only the confirmation to
   * surface.
   */
  onRegistered?: (registered: PendingObject[]) => void;
}

type CommitData =
  | {
      ok: true;
      intent: "commit-objects";
      newHeadSha: string;
      projectId?: number;
      registration?: RegistrationResult;
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

/**
 * Whether a poll answer is for the build this modal is tracking. A response
 * still in flight from an earlier operation answers for nothing. The run id
 * is compared only where the poll names the run itself (`byRunId`, the
 * upload flow): a poll by commit reports the runs listed for that commit, and
 * is kept to the right operation by the reset on close.
 */
function pollAnswersHere(
  pollData: PollData,
  tracking: boolean,
  byRunId: boolean,
  runId: number | null,
): pollData is Extract<PollData, { ok: true }> {
  if (!pollData?.ok || pollData.intent !== "poll-build" || !tracking) return false;
  return !byRunId || runId == null || pollData.runId === runId;
}

/** A finished run's phases, with those still queued marked as not part of it. */
function settledPhases(phases: BuildPhaseStatus[]): BuildPhaseStatus[] {
  return phases.map((p) =>
    p.status === "queued" ? { ...p, status: "completed" as const, conclusion: "skipped" } : p,
  );
}

/** A Map, because the key is a string from a response body. */
const COMMIT_ERROR_HEADING_KEYS = new Map<string, string>([
  ["stale_head", "staleHeadError"],
  ["operation_in_progress", "upload_error_operation_in_progress"],
  ["upgrade_required", "repo_write_upgrade_required"],
  ["upgrade_awaits_convenor", "repo_write_upgrade_awaits_convenor"],
  ["release_unknown", "repo_write_release_unknown"],
]);

/**
 * The failed step's heading. A refused commit names why; the three version
 * refusals wrote nothing, and the upgrade one is followed by its link.
 */
function commitFailureHeadingKey(commitError: string | null, addedBeforeBuild: boolean): string {
  if (commitError) return COMMIT_ERROR_HEADING_KEYS.get(commitError) ?? "commitFailed";
  return addedBeforeBuild ? "commitModal.addedBuildUnfinishedHeading" : "buildFailed";
}

/** What happened to the registration the committing action made. */
type RegistrationState = "none" | "ok" | "failed" | "retrying";
/** What the build that followed the commit did, as far as this modal saw. */
type BuildState = "running" | "success" | "failed" | "skipped";

/**
 * The step to show. Registration and the build are tracked apart: the objects
 * are registered when their commit lands, and the build decides only
 * whether their tiles exist, so a failed registration is offered its retry
 * while the build runs on, and a failed build is reported over objects that
 * are already there.
 */
function stepFor(
  flow: "confirm" | "committing" | "tracking" | "commit_failed",
  registration: RegistrationState,
  build: BuildState,
): ModalStep {
  if (flow === "confirm" || flow === "committing") return flow;
  if (flow === "commit_failed") return "failed";
  if (registration === "retrying") return "inserting";
  if (registration === "failed") return "insert_failed";
  if (build === "running") return "building";
  if (build === "failed") return "failed";
  return "success";
}

/** What the dialog says when the pre-commit check could not be made, with a button to run it again. */
function CheckFailedNote({ failed, onRetry }: { failed?: boolean; onRetry?: () => void }) {
  const { t } = useTranslation("objects");
  if (!failed) return null;
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
      <p className="font-body text-sm text-amber-900 mb-2">{t("commitModal.checkFailed")}</p>
      <button
        type="button"
        onClick={onRetry}
        className="font-heading font-semibold text-xs uppercase tracking-wider border border-amber-300 text-amber-900 rounded-full px-4 py-1.5 hover:bg-amber-100 transition-colors"
      >
        {t("error.retry")}
      </button>
    </div>
  );
}

export function CommitAndBuildModal({ open, sheetsEnabled, objectsFile = "objects.csv", checkPending, checkFailed, onRetryCheck, urlMismatch, pendingObjects, onClose, onBuildSuccess, onBuildFailed, skipCommit, dispatchRunId, dispatchHtmlUrl, registration: uploadRegistration, projectId: uploadProjectId, onRegistered }: Props) {
  const { t } = useTranslation("objects");
  const commitFetcher = useSiteFetcher();
  const pollFetcher = useSiteFetcher();
  const insertFetcher = useSiteFetcher();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [flow, setFlow] = useState<"confirm" | "committing" | "tracking" | "commit_failed">("confirm");
  const [registration, setRegistration] = useState<RegistrationState>("none");
  const [build, setBuild] = useState<BuildState>("running");
  const [projectId, setProjectId] = useState<number | null>(null);
  // The committing action's record of the objects, which a retry names.
  const [operationId, setOperationId] = useState<number | null>(null);
  const [commitSha, setCommitSha] = useState<string | null>(null);
  const [buildUrl, setBuildUrl] = useState<string | null>(null);
  const [runId, setRunId] = useState<number | null>(null);
  const [phases, setPhases] = useState<BuildPhaseStatus[] | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);

  const step = stepFor(flow, registration, build);
  const buildSkipped = build === "skipped";
  /** Objects committed and registered, over a build that did not succeed. */
  const addedBeforeBuild = !commitError && pendingObjects.length > 0;

  const commitData = commitFetcher.data as CommitData;
  const pollData = pollFetcher.data as PollData;

  /** Take the committing action's registration result. */
  function takeRegistration(result: RegistrationResult | null | undefined) {
    setOperationId(result?.operationId ?? null);
    if (pendingObjects.length === 0 || !result) {
      setRegistration("none");
    } else if (result.ok) {
      setRegistration("ok");
      onRegistered?.(pendingObjects);
    } else {
      setRegistration("failed");
    }
  }

  // Reset state when the modal opens, and again when it closes, so that a
  // reopening never starts from the last operation's flow or build: the first
  // render after opening would otherwise poll that operation's run.
  useEffect(() => {
    if (!open) {
      setFlow("confirm");
      setRegistration("none");
      setBuild("running");
      setRunId(null);
      setCommitSha(null);
      return;
    }
    if (open) {
      setPhases(null);
      setCommitError(null);
      setCommitSha(null);

      if (skipCommit) {
        // Upload flow: the images are committed, the objects registered by
        // the upload itself, and the build dispatched, or not.
        setFlow("tracking");
        setProjectId(uploadProjectId ?? null);
        takeRegistration(uploadRegistration);
        setRunId(dispatchRunId ?? null);
        setBuildUrl(dispatchRunId ? dispatchHtmlUrl ?? null : null);
        setBuild(dispatchRunId ? "running" : "skipped");
      } else {
        setFlow("confirm");
        setRegistration("none");
        setBuild("running");
        setProjectId(null);
        setOperationId(null);
        setBuildUrl(null);
        setRunId(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Process commit result
  useEffect(() => {
    if (!commitData) return;
    // Refused because the site changed: nothing was committed, and the
    // layout's notice says why. The dialog goes back to asking.
    if (isSiteChanged(commitData)) {
      setFlow("confirm");
      return;
    }
    if (commitData.ok && commitData.intent === "commit-objects") {
      setProjectId(commitData.projectId ?? null);
      takeRegistration(commitData.registration);
      setFlow("tracking");
      if (commitData.dispatchFailed) {
        // The commit landed but no workflow run started — polling by SHA
        // would spin forever on a run that doesn't exist. Tiles regenerate on
        // the next full build.
        setBuild("skipped");
        return;
      }
      setCommitSha(commitData.newHeadSha);
      setBuild("running");
    } else if (!commitData.ok && commitData.intent === "commit-objects") {
      setCommitError(commitData.error);
      setFlow("commit_failed");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitData]);

  // Process poll results
  useEffect(() => {
    // A poll refused because the site changed is not asked again, and the
    // dialog closes: the layout's notice has said why, the build carries on
    // without this tab, and a tracking screen that can no longer hear it
    // would have nothing to show and no way out.
    if (isSiteChanged(pollData)) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      onClose();
      return;
    }
    if (!pollAnswersHere(pollData, flow === "tracking" && build === "running", !!skipCommit, runId)) return;
    if (pollData.buildUrl) setBuildUrl(pollData.buildUrl);
    if (pollData.runId != null) setRunId(pollData.runId);
    if (pollData.phases) setPhases(pollData.phases);
    if (pollData.buildStatus === "completed") {
      if (pollData.phases) setPhases(settledPhases(pollData.phases));
      // Every conclusion but success, `cancelled` included, is a build that
      // did not make the tiles. The objects are registered either way.
      setBuild(pollData.buildConclusion === "success" ? "success" : "failed");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollData]);

  // Process a retry's result. The failure branch matters (telar-compositor#24):
  // without it a failed D1 registration froze the modal forever while the
  // images sat committed in the repo with no D1 rows.
  useEffect(() => {
    const data = insertFetcher.data as
      | { ok: boolean; intent: string; error?: string }
      | null
      | undefined;
    // Refused because the site changed: the registration is still owed, as
    // it was before the retry, and the layout's notice says why.
    if (isSiteChanged(data)) {
      setRegistration("failed");
      return;
    }
    if (data?.ok && data.intent === "insert-pending-objects") {
      setRegistration("ok");
      onRegistered?.(pendingObjects);
    } else if (data && !data.ok && data.intent === "insert-pending-objects") {
      setRegistration("failed");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insertFetcher.data]);

  // Retry the registration, for the project the commit ran against, by the
  // operation the commit recorded: the server finishes that operation if it is
  // still owed and answers done if it is not. Safe to repeat: the ingest keeps
  // a receipt for each operation it has applied.
  function handleInsertRetry() {
    setRegistration("retrying");
    insertFetcher.submit(
      {
        intent: "insert-pending-objects",
        operationId: String(operationId ?? ""),
        projectId: String(projectId ?? ""),
      },
      { method: "post" }
    );
  }

  // Poll the build while it runs, whatever the registration is doing.
  // In the normal flow, polling requires commitSha (for SHA-based run discovery).
  // In the upload flow (skipCommit), polling uses dispatchRunId directly — no SHA needed.
  //
  // Cross-reference: PublishingPopover.tsx has a structurally similar 5s
  // poll-build loop (same immediate-fire-then-setInterval shape, same
  // double-cleanup-effect pattern) but is NOT extracted into a shared hook
  // with this one — the bodies diverge materially: (1) this effect gates on
  // the modal's build state, while PublishingPopover gates on awareness
  // booleans (isPublishing/isBuilding); (2) this effect branches the submit
  // payload into two distinct shapes (runId-only for the upload flow vs
  // sha+optional-runId for the commit flow), while PublishingPopover always
  // sends sha and reads runId back out of the *previous* poll response via a
  // ref, never from a prop; (3) this effect submits to the ambient route
  // action (no explicit `action`), while PublishingPopover explicitly targets
  // `action: "/publish"` since it can render from outside the /publish route.
  // Forcing a shared hook over those three axes would either lose a real
  // distinction or grow enough parameters to stop being simpler than two
  // 15-line effects.
  const polling = open && flow === "tracking" && build === "running";
  useEffect(() => {
    const canPollBySha = polling && !!commitSha;
    const canPollByRunId = polling && !!skipCommit && !!runId;

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
  }, [polling, commitSha, runId, skipCommit]);

  // Clean up interval on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  function handleConfirm() {
    setFlow("committing");
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
    // Only a build that succeeded made the tiles; a skipped one made none.
    onBuildSuccess(build === "success");
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
              {t("commitModal.description", { count: pendingObjects.length, file: objectsFile })}
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

            <CheckFailedNote failed={checkFailed} onRetry={onRetryCheck} />

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
              <Button variant="primary" type="button" loading={checkPending} onClick={handleConfirm}>
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

        {/* --- Inserting step (a registration retry in flight) --- */}
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
              <h3 className="font-heading font-semibold text-lg text-charcoal text-center">
                {t(commitFailureHeadingKey(commitError, addedBeforeBuild))}
              </h3>
              {commitError === "upgrade_required" && (
                <Link
                  to="/upgrade?from=/objects"
                  className="font-body text-sm text-blue-600 hover:underline"
                >
                  {t("upload_upgrade_link")}
                </Link>
              )}
              {addedBeforeBuild && (
                <p className="font-body text-sm text-gray-500 text-center">
                  {t("commitModal.addedBuildUnfinishedBody")}
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
              {commitError ? (
                <button
                  type="button"
                  onClick={handleFailedDismiss}
                  className="font-heading font-semibold text-sm uppercase tracking-wider bg-red-500 hover:bg-red-600 text-white rounded-full px-6 py-2.5 transition-colors"
                >
                  {t("commitModal.discardChanges")}
                </button>
              ) : (
                // The commit landed, so there is nothing to discard.
                <Button variant="primary" type="button" onClick={handleFailedDismiss}>
                  {t("commitModal.close")}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
