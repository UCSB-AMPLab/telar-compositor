/**
 * build-phase-collapse — resolves the polled 6-phase GitHub Actions model
 * (mapStepsToBuildPhases in commit.server.ts) into the 7-step publish tracker
 * model: a synthesised `dispatch` pseudo-step plus the six real BUILD_PHASES.
 * Pure logic; BuildPhaseStatus is imported type-only so no server runtime is
 * pulled into the client bundle.
 *
 * @version v1.3.0-beta
 */

import type { BuildPhaseStatus } from "~/lib/commit.server";

/** One step of the 7-step publish tracker (dispatch + the six BUILD_PHASES). */
export interface PublishStep {
  id: "dispatch" | "setup" | "build-js" | "process-data" | "build-site" | "iiif" | "deploy";
  /** Fully-qualified i18n key under popover.publishing.steps.* */
  labelKey: string;
  status: "queued" | "in_progress" | "completed" | "failed";
}

export interface ResolvedPublishSteps {
  steps: PublishStep[];
  /** 1-based index of the first non-completed step; pins to 7 when all complete. */
  activeStep: number;
  totalSteps: 7;
}

const STEP_LABEL_PREFIX = "popover.publishing.steps";

/** Ordered (phase id → i18n key suffix) for the six real BUILD_PHASES. */
const BUILD_STEP_KEYS: { id: PublishStep["id"]; keySuffix: string }[] = [
  { id: "setup", keySuffix: "setup" },
  { id: "build-js", keySuffix: "build_js" },
  { id: "process-data", keySuffix: "process_data" },
  { id: "build-site", keySuffix: "build_site" },
  { id: "iiif", keySuffix: "media" },
  { id: "deploy", keySuffix: "deploy" },
];

/** Maps one real phase's status/conclusion onto a PublishStep status. */
function stepStatusFromPhase(phase: BuildPhaseStatus | undefined): PublishStep["status"] {
  if (!phase) return "queued";
  if (phase.conclusion === "failure") return "failed";
  if (phase.status === "completed") return "completed";
  if (phase.status === "in_progress") return "in_progress";
  return "queued";
}

/**
 * Builds the 7-step publish model from the polled BUILD_PHASES.
 *
 * The `dispatch` pseudo-step is synthesised client-side: it reads "in_progress"
 * while the commit has landed but no Actions phase data has arrived yet, and
 * flips to "completed" the moment any phase data is present. Steps 2-7 take
 * their status directly from the matching real phase.
 *
 * activeStep is the 1-based index of the first non-completed step (a `failed`
 * step counts as non-completed, so the caption pins to the failing step); it
 * pins to 7 when every step is completed.
 */
export function resolvePublishSteps(
  phases: BuildPhaseStatus[] | null,
): ResolvedPublishSteps {
  const havePhases = !!phases && phases.length > 0;

  const dispatch: PublishStep = {
    id: "dispatch",
    labelKey: `${STEP_LABEL_PREFIX}.dispatch`,
    status: havePhases ? "completed" : "in_progress",
  };

  const buildSteps: PublishStep[] = BUILD_STEP_KEYS.map(({ id, keySuffix }) => ({
    id,
    labelKey: `${STEP_LABEL_PREFIX}.${keySuffix}`,
    status: havePhases
      ? stepStatusFromPhase(phases!.find((p) => p.id === id))
      : "queued",
  }));

  const steps = [dispatch, ...buildSteps];
  const firstIncomplete = steps.findIndex((s) => s.status !== "completed");
  const activeStep = firstIncomplete === -1 ? steps.length : firstIncomplete + 1;

  return { steps, activeStep, totalSteps: 7 };
}
