/**
 * PublishingPopover — the live publish-log body of the Site Status pill. Renders
 * the 7-step publish model (dispatch + the six real BUILD_PHASES) from
 * resolvePublishSteps, driven by REUSING the existing `poll-build` fetcher loop
 * (every ~5s) — NOT new Actions-polling logic. The polled phases arrive via the
 * `phases` prop (the pill lifts the SHA/commitUrl off-route into awareness);
 * when absent, the model still renders in a dispatching state.
 *
 * `isPublishing`/`isBuilding` are read from useCollaborationContext (awareness —
 * survive navigation), NOT publish-route local state. The footer surfaces a
 * Watch-on-GitHub link to the Actions run (buildUrl), captured from the poll
 * data, falling back to the commit URL until the run is known.
 *
 * `BuildPhaseStatus` is imported type-only so no `.server` runtime reaches the
 * client bundle.
 *
 * @version v1.3.0-beta
 */

import { useEffect, useRef } from "react";
import { useFetcher } from "react-router";
import { ArrowUpRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { BuildPhaseStatus } from "~/lib/commit.server";
import { resolvePublishSteps } from "~/components/features/site-status/build-phase-collapse";
import { PublishingRows } from "~/components/features/site-status/PublishingRows";
import { useCollaborationContext } from "~/hooks/use-collaboration";

export interface PublishingPopoverProps {
  /** The 6 real BUILD_PHASES (null until the first poll lands). */
  phases: BuildPhaseStatus[] | null;
  /** The commit SHA the poll-build fetcher tracks (lifted off-route by the pill). */
  sha?: string | null;
  /** Direct link to the publish commit on GitHub (fallback for the footer link). */
  commitUrl?: string | null;
  /** Actions run URL for the Watch-on-GitHub link (when already known off-route). */
  buildUrl?: string | null;
  className?: string;
}

type PollData =
  | {
      ok: true;
      intent: "poll-build";
      buildStatus: string;
      runId: number | null;
      buildUrl: string | null;
      phases: BuildPhaseStatus[] | null;
    }
  | { ok: false; intent: "poll-build"; error: string }
  | null
  | undefined;

export function PublishingPopover({
  phases,
  sha,
  commitUrl,
  buildUrl,
  className = "",
}: PublishingPopoverProps) {
  const { t } = useTranslation("popover");
  const { isPublishing, isBuilding } = useCollaborationContext();
  const isActive = isPublishing || isBuilding;

  const pollFetcher = useFetcher();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollData = pollFetcher.data as PollData;

  const pollDataRef = useRef<PollData>(pollData);
  useEffect(() => {
    pollDataRef.current = pollData;
  }, [pollData]);

  useEffect(() => {
    if (!sha || !isActive) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    function doPoll() {
      const formData: Record<string, string> = { intent: "poll-build", sha: sha as string };
      const latest = pollDataRef.current;
      const runId = latest?.ok && latest.intent === "poll-build" ? latest.runId : null;
      if (runId != null) formData.runId = String(runId);
      pollFetcher.submit(formData, { method: "post", action: "/publish" });
    }
    doPoll();
    intervalRef.current = setInterval(doPoll, 5000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sha, isActive]);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // Prefer freshly polled phases over the prop.
  const livePhases: BuildPhaseStatus[] =
    (pollData?.ok && pollData.intent === "poll-build" && pollData.phases) || phases || [];

  // Surface the Actions run URL from the poll, falling back to the off-route
  // prop, then the commit URL (GitHub shows checks on the commit page).
  const liveBuildUrl =
    (pollData?.ok && pollData.intent === "poll-build" ? pollData.buildUrl : null) ??
    buildUrl ??
    commitUrl ??
    null;

  const { steps, activeStep, totalSteps } = resolvePublishSteps(
    livePhases.length > 0 ? livePhases : null,
  );

  return (
    <div className={className}>
      {/* Head: Publishing… caption + N/7 */}
      <div
        className="border-b border-border flex items-center justify-between"
        style={{ padding: "14px 18px 12px" }}
      >
        <h3 className="font-heading font-bold text-charcoal" style={{ fontSize: "14px", letterSpacing: "-0.005em" }}>
          {t("publishing.title", { step: activeStep, total: totalSteps })}
        </h3>
        <span className="font-mono text-anil-ink" style={{ fontSize: "11px" }}>
          {activeStep}/{totalSteps}
        </span>
      </div>

      {/* Body: 7 step rows + progress bar */}
      <div style={{ padding: "12px 18px 14px" }}>
        <PublishingRows steps={steps} activeStep={activeStep} totalSteps={totalSteps} />
      </div>

      {/* Footer: Watch on GitHub */}
      <div className="border-t border-border bg-cream flex" style={{ padding: "11px 14px 12px" }}>
        <a
          href={liveBuildUrl ?? "#"}
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={!liveBuildUrl}
          onClick={(e) => {
            if (!liveBuildUrl) e.preventDefault();
          }}
          className="font-heading font-semibold inline-flex items-center gap-1 text-anil-ink hover:underline"
          style={{ fontSize: "12.5px" }}
        >
          {t("publishing.watch_github")}
          <ArrowUpRight className="w-3.5 h-3.5" aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}
