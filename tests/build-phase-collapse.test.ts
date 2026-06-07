/**
 * Unit tests for resolvePublishSteps — resolves the polled 6-phase GitHub
 * Actions model into the 7-step publish tracker (dispatch + the six
 * BUILD_PHASES). Pure logic, no React, no server runtime.
 */

import { describe, it, expect } from "vitest";
import {
  resolvePublishSteps,
  type PublishStep,
} from "~/components/features/site-status/build-phase-collapse";
import type { BuildPhaseStatus } from "~/lib/commit.server";

// ---------------------------------------------------------------------------
// Fixtures — the 6 real BUILD_PHASES as plain objects typed against the
// imported BuildPhaseStatus shape (type-only import, no server runtime).
// ---------------------------------------------------------------------------

const PHASE_IDS = ["setup", "build-js", "process-data", "build-site", "iiif", "deploy"] as const;

/** Builds the 6 real phases, each at the given status/conclusion. */
function phases(
  status: BuildPhaseStatus["status"],
  conclusion: BuildPhaseStatus["conclusion"] = null,
): BuildPhaseStatus[] {
  return PHASE_IDS.map((id) => ({ id, label: id, status, conclusion }));
}

function stepById(steps: PublishStep[], id: PublishStep["id"]): PublishStep {
  const s = steps.find((x) => x.id === id);
  if (!s) throw new Error(`step ${id} not found`);
  return s;
}

describe("resolvePublishSteps", () => {
  const STEP_IDS = [
    "dispatch", "setup", "build-js", "process-data", "build-site", "iiif", "deploy",
  ] as const;

  it("produces exactly the 7 steps in order with totalSteps 7", () => {
    const { steps, totalSteps } = resolvePublishSteps(null);
    expect(totalSteps).toBe(7);
    expect(steps.map((s) => s.id)).toEqual([...STEP_IDS]);
    for (const s of steps) {
      expect(s.labelKey.startsWith("popover.publishing.steps.")).toBe(true);
    }
  });

  it("with no phases: dispatch is in_progress, the six build steps are queued, activeStep 1", () => {
    const { steps, activeStep } = resolvePublishSteps(null);
    expect(stepById(steps, "dispatch").status).toBe("in_progress");
    expect(stepById(steps, "setup").status).toBe("queued");
    expect(stepById(steps, "deploy").status).toBe("queued");
    expect(activeStep).toBe(1);
  });

  it("treats an empty phases array the same as null (dispatch in_progress)", () => {
    expect(stepById(resolvePublishSteps([]).steps, "dispatch").status).toBe("in_progress");
  });

  it("once any phase data arrives, dispatch is completed and steps 2-7 map by id", () => {
    const p = phases("queued"); // 6 real phases, all queued
    p[0] = { ...p[0], status: "in_progress" }; // setup running
    const { steps, activeStep } = resolvePublishSteps(p);
    expect(stepById(steps, "dispatch").status).toBe("completed");
    expect(stepById(steps, "setup").status).toBe("in_progress");
    // dispatch done (1), setup is first non-completed → activeStep 2
    expect(activeStep).toBe(2);
  });

  it("maps each BUILD_PHASE id onto the matching step status", () => {
    const p = phases("completed", "success");
    p[3] = { ...p[3], status: "in_progress", conclusion: null }; // build-site running
    p[4] = { ...p[4], status: "queued", conclusion: null };      // iiif queued
    p[5] = { ...p[5], status: "queued", conclusion: null };      // deploy queued
    const { steps, activeStep } = resolvePublishSteps(p);
    expect(stepById(steps, "setup").status).toBe("completed");
    expect(stepById(steps, "build-js").status).toBe("completed");
    expect(stepById(steps, "process-data").status).toBe("completed");
    expect(stepById(steps, "build-site").status).toBe("in_progress");
    expect(stepById(steps, "iiif").status).toBe("queued");
    expect(stepById(steps, "deploy").status).toBe("queued");
    // dispatch(1) setup(2) build-js(3) process-data(4) done; build-site(5) running
    expect(activeStep).toBe(5);
  });

  it("marks a step failed when its phase concluded 'failure' and pins activeStep to it", () => {
    const p = phases("completed", "success");
    p[3] = { ...p[3], status: "completed", conclusion: "failure" }; // build-site failed
    const { steps, activeStep } = resolvePublishSteps(p);
    expect(stepById(steps, "build-site").status).toBe("failed");
    // dispatch(1) setup(2) build-js(3) process-data(4) done; build-site(5) is first non-completed
    expect(activeStep).toBe(5);
  });

  it("activeStep pins to 7 when all phases completed successfully", () => {
    const { steps, activeStep } = resolvePublishSteps(phases("completed", "success"));
    for (const s of steps) expect(s.status).toBe("completed");
    expect(activeStep).toBe(7);
  });
});
