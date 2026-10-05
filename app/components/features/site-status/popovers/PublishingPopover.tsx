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
 * A poll that fails in transit is answered unreachable by the Publish route's
 * `clientAction`. The popover keeps its last successful poll, for the project
 * and the commit being built, and shows it while an answer is unreachable, so
 * the progress, the Actions link and the next poll's `runId` survive an outage;
 * the pill passes `phases={null}`, so the prop is no fallback. A poll for
 * another commit, or kept for another project, is not shown.
 *
 * `BuildPhaseStatus` is imported type-only so no `.server` runtime reaches the
 * client bundle.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useRef } from "react";
import { usePageSite, useSiteFetcher } from "~/lib/page-site";
import { isUnreachableAnswer, type UnreachableWrite } from "~/lib/unreachable-write";
import { isSiteChanged } from "~/components/features/site-status/SiteChangedNotice";
import { ArrowUpRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { BuildPhaseStatus } from "~/lib/commit.server";
import { resolvePublishSteps } from "~/components/features/site-status/build-phase-collapse";
import { PublishingRows } from "~/components/features/site-status/PublishingRows";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { useAnswerKeptFor } from "~/hooks/use-answer-kept-for";

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

interface PollAnswer {
  ok: true;
  intent: "poll-build";
  /** The commit the answer is for. */
  sha?: string;
  buildStatus: string;
  runId: number | null;
  buildUrl: string | null;
  phases: BuildPhaseStatus[] | null;
}

type PollData =
  | PollAnswer
  | { ok: false; intent: "poll-build"; error: string }
  | UnreachableWrite
  | null
  | undefined;

/** A successful poll for the commit being built. */
function pollFor(data: PollData, sha: string | null | undefined): PollAnswer | null {
  if (!data?.ok || data.intent !== "poll-build" || !sha) return null;
  return data.sha == null || data.sha === sha ? data : null;
}

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

  const pollFetcher = useSiteFetcher();
  // The interval below outlives renders; it posts through the latest submit,
  // which carries the page's current site.
  const submitRef = useRef(pollFetcher.submit);
  submitRef.current = pollFetcher.submit;
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollData = pollFetcher.data as PollData;
  const projectId = usePageSite().live;

  // The last successful poll, for the project and commit it was sent for.
  const fresh = pollFor(pollData, sha);
  const { kept: keptPoll, markSent } = useAnswerKeptFor<PollAnswer>(
    pollData,
    (answer) => pollFor(answer as PollData, sha),
    `${projectId}:${sha ?? ""}`,
  );
  const shownPoll = fresh ?? (isUnreachableAnswer(pollData) ? keptPoll : null);

  const pollDataRef = useRef({ data: pollData, shown: shownPoll });
  useEffect(() => {
    pollDataRef.current = { data: pollData, shown: shownPoll };
  }, [pollData, shownPoll]);

  // Cross-reference: CommitAndBuildModal.tsx has a structurally similar 5s
  // poll-build loop but is NOT extracted into a shared hook with this one —
  // see the cross-reference comment there for the three material
  // differences (gate variables, payload-shape branching, fetcher action
  // target).
  useEffect(() => {
    if (!sha || !isActive) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    function doPoll() {
      const formData: Record<string, string> = { intent: "poll-build", sha: sha as string };
      const latest = pollDataRef.current;
      // A poll refused because the site changed is not asked again: the
      // layout's notice has said why, and this tab's build is not the
      // session's.
      if (isSiteChanged(latest.data)) {
        if (intervalRef.current) clearInterval(intervalRef.current);
        return;
      }
      const runId = latest.shown?.runId ?? null;
      if (runId != null) formData.runId = String(runId);
      markSent();
      submitRef.current(formData, { method: "post", action: "/publish" });
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

  // Prefer polled phases over the prop.
  const livePhases: BuildPhaseStatus[] = shownPoll?.phases || phases || [];

  // Surface the Actions run URL from the poll, falling back to the off-route
  // prop, then the commit URL (GitHub shows checks on the commit page).
  const liveBuildUrl = shownPoll?.buildUrl ?? buildUrl ?? commitUrl ?? null;

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
