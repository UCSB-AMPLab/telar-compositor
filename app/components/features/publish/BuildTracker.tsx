/**
 * BuildTracker — inline 6-phase build progress display for the Publish wizard.
 *
 * Polls the publish route's poll-build intent every 5 seconds.
 * Shows PhaseCircle for each build phase (matching CommitAndBuildModal pattern).
 * Success: CheckCircle2, "Your site is live!", links to live site and commit.
 * Failure: XCircle, "Build failed", link to Actions run and retry option.
 */

import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { CheckCircle2, ExternalLink, Loader2, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { BuildPhaseStatus } from "~/lib/commit.server";
import { Button } from "~/components/ui/Button";
import { Link } from "react-router";

// Static phase definitions — mirrors BUILD_PHASES from commit.server.ts
// Defined here to avoid importing a server-only module into client code.
const BUILD_PHASES = [
  { id: "setup", label: "Setup" },
  { id: "build-js", label: "Build JS" },
  { id: "process-data", label: "Process data" },
  { id: "build-site", label: "Build site" },
  { id: "iiif", label: "IIIF tiles" },
  { id: "deploy", label: "Deploy" },
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

interface BuildTrackerProps {
  sha: string;
  commitUrl: string | null;
  pagesUrl: string | null;
  onRetry?: () => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// Phase indicator
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
// Phase-aware status messages
// ---------------------------------------------------------------------------

const PHASE_MESSAGES: Record<string, string> = {
  setup: "build.phase_setup",
  "build-js": "build.phase_build_js",
  "process-data": "build.phase_process_data",
  "build-site": "build.phase_build_site",
  iiif: "build.phase_iiif",
  deploy: "build.phase_deploy",
};

function getActivePhaseMessage(
  buildStatus: string,
  phases: BuildPhaseStatus[] | null,
  t: (key: string) => string,
): string {
  if (buildStatus === "pending") return t("build.publishing");

  if (phases) {
    const active = phases.find((p) => p.status === "in_progress");
    if (active && PHASE_MESSAGES[active.id]) {
      return t(PHASE_MESSAGES[active.id]);
    }
  }

  return t("build.building");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BuildTracker({ sha, commitUrl, pagesUrl, onRetry, className = "" }: BuildTrackerProps) {
  const { t } = useTranslation("publish");
  const pollFetcher = useFetcher();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [buildStatus, setBuildStatus] = useState<string>("pending");
  const [buildConclusion, setBuildConclusion] = useState<string | null>(null);
  const [buildUrl, setBuildUrl] = useState<string | null>(null);
  const [runId, setRunId] = useState<number | null>(null);
  const [phases, setPhases] = useState<BuildPhaseStatus[] | null>(null);

  const pollData = pollFetcher.data as PollData;
  const isComplete = buildStatus === "completed";

  // Process poll results
  useEffect(() => {
    if (!pollData?.ok || pollData.intent !== "poll-build") return;
    if (pollData.buildUrl) setBuildUrl(pollData.buildUrl);
    if (pollData.runId != null) setRunId(pollData.runId);
    if (pollData.phases) setPhases(pollData.phases);
    setBuildStatus(pollData.buildStatus);
    if (pollData.buildStatus === "completed") {
      setBuildConclusion(pollData.buildConclusion);
    }
  }, [pollData]);

  // Set up polling
  useEffect(() => {
    if (isComplete) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }

    function doPoll() {
      const formData: Record<string, string> = { intent: "poll-build", sha };
      if (runId != null) formData.runId = String(runId);
      pollFetcher.submit(formData, { method: "post" });
    }

    // Fire immediately
    doPoll();

    // Then every 5 seconds
    intervalRef.current = setInterval(doPoll, 5000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sha, isComplete, runId]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const displayPhases: BuildPhaseStatus[] =
    phases ??
    BUILD_PHASES.map((p) => ({
      id: p.id,
      label: p.label,
      status: "queued" as const,
      conclusion: null,
    }));

  const succeeded = isComplete && buildConclusion === "success";
  const failed = isComplete && buildConclusion !== "success";

  return (
    <div className={className}>
      {/* Success state */}
      {succeeded && (
        <div className="text-center py-6">
          <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-3" />
          <h2 className="font-heading font-bold text-xl text-charcoal mb-2">
            {t("build.success_heading")}
          </h2>
          <p className="font-body text-sm text-gray-600 mb-6">
            {t("build.success_description")}
          </p>
          <div className="flex flex-col items-center justify-center gap-3">
            {pagesUrl && (
              <a
                href={pagesUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 font-heading font-semibold text-sm uppercase tracking-wider bg-periwinkle hover:bg-periwinkle-hover text-charcoal rounded-full px-6 py-2.5 transition-colors"
              >
                {t("build.view_site")}
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
            {commitUrl && (
              <a
                href={commitUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 font-body text-sm text-blue-600 hover:underline"
              >
                {t("build.view_commit")}
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
          <div className="mt-4">
            <Link
              to="/dashboard"
              className="font-body text-sm text-gray-500 hover:text-charcoal hover:underline"
            >
              {t("build.back_to_dashboard")}
            </Link>
          </div>
        </div>
      )}

      {/* Failure state */}
      {failed && (
        <div className="text-center py-6">
          <XCircle className="w-12 h-12 text-red-500 mx-auto mb-3" />
          <h2 className="font-heading font-bold text-xl text-charcoal mb-2">
            {t("build.failed_heading")}
          </h2>
          <p className="font-body text-sm text-gray-600 mb-6">
            {t("build.failed_description")}
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            {buildUrl && (
              <a
                href={buildUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 font-body text-sm text-blue-600 hover:underline"
              >
                {t("build.view_actions")}
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
            {onRetry && (
              <Button type="button" variant="primary" onClick={onRetry}>
                {t("build.try_again")}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* In-progress state */}
      {!isComplete && (
        <div>
          <div className="flex items-center gap-2 text-gray-600 mb-4">
            <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" />
            <span className="font-body text-sm">
              {getActivePhaseMessage(buildStatus, phases, t)}
            </span>
          </div>

          {/* Phase stepper */}
          <div className="flex items-start">
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
                    {phase.label}
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

          {buildUrl && (
            <a
              href={buildUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-body text-xs text-blue-600 hover:underline mt-3"
            >
              {t("build.view_actions")}
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      )}
    </div>
  );
}
