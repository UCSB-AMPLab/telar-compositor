/**
 * This file derives the checks section's view of the rebuild a workflow
 * repair started, from the repair's own `poll-build` answers. It is kept out
 * of the publish route so the route module exports only route members.
 *
 * @version v1.5.0-beta
 */

import type { WorkflowRepairBuild } from "~/components/features/publish/ValidationChecks";

/** What the repair's own `poll-build` last reported about its rebuild. */
export type RepairPollSnapshot = {
  buildStatus: string;
  buildConclusion: string | null;
  buildUrl: string | null;
};

/**
 * The rebuild the repair's commit started, as the checks section shows it.
 *
 * A run is settled only at `buildStatus === "completed"`: every earlier status,
 * including the `pending` `poll-build` returns while GitHub has not registered
 * the run yet, is still building. `null` before the session's first response,
 * and for the one cancellation this page can account for — its own publish,
 * whose flow is already showing the build that matters.
 */
export function deriveWorkflowRepairBuild(
  poll: RepairPollSnapshot | null,
  publishFollowedRepair: boolean,
): WorkflowRepairBuild | null {
  if (!poll) return null;
  const buildUrl = poll.buildUrl;
  if (poll.buildStatus !== "completed") return { state: "building", buildUrl };
  if (poll.buildConclusion === "success") return { state: "rebuilt", buildUrl };
  if (poll.buildConclusion === "cancelled") {
    return publishFollowedRepair ? null : { state: "cancelled", buildUrl };
  }
  return { state: "failed", buildUrl };
}
