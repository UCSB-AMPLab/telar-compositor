/**
 * Unit tests for `isStepVisible`, the audience filter the Upgrade page's
 * "done" stage runs post-upgrade manual steps through before display.
 *
 * The validator accepts an audience value this build doesn't recognise
 * rather than rejecting the whole manifest. That only holds if this filter also treats an unrecognised audience as
 * visible — otherwise the step passes validation but is silently dropped
 * here, moving the bug rather than fixing it. See manifest-schema.server.ts
 * and `isStepVisible` in app/components/features/upgrade/PostUpgradeSteps.tsx.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { isStepVisible } from "~/components/features/upgrade/PostUpgradeSteps";
import type { ManualStep } from "~/lib/manifest-schema.server";

function step(audience?: string): ManualStep {
  return audience === undefined
    ? { description: "x" }
    : { description: "x", audience: audience as ManualStep["audience"] };
}

describe("isStepVisible", () => {
  it("shows a step with no audience key at all", () => {
    expect(isStepVisible(step(), false)).toBe(true);
    expect(isStepVisible(step(), true)).toBe(true);
  });

  it("shows an 'all' step", () => {
    expect(isStepVisible(step("all"), false)).toBe(true);
  });

  it("shows a 'compositor' step", () => {
    expect(isStepVisible(step("compositor"), false)).toBe(true);
  });

  it("hides a 'local' step", () => {
    expect(isStepVisible(step("local"), false)).toBe(false);
    expect(isStepVisible(step("local"), true)).toBe(false);
  });

  it("shows a 'google-sheets' step only when sheets are enabled", () => {
    expect(isStepVisible(step("google-sheets"), true)).toBe(true);
    expect(isStepVisible(step("google-sheets"), false)).toBe(false);
  });

  it("shows a step whose audience this build doesn't recognise", () => {
    expect(isStepVisible(step("some-future-value"), false)).toBe(true);
    expect(isStepVisible(step("some-future-value"), true)).toBe(true);
  });
});
