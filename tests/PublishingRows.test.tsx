// @vitest-environment jsdom
/**
 * Pins the vertical <PublishingRows> — the 7-step publish list (pill popover
 * body): dispatch + the six BUILD_PHASES, plus the activeStep progress bar.
 * Pure presentation; takes already-resolved steps from resolvePublishSteps.
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import type { PublishStep } from "~/components/features/site-status/build-phase-collapse";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        "publishing.steps.dispatch": "Dispatch build",
        "publishing.steps.setup": "Set up",
        "publishing.steps.build_js": "Build code",
        "publishing.steps.process_data": "Process content",
        "publishing.steps.build_site": "Build pages",
        "publishing.steps.media": "Images and/or audio",
        "publishing.steps.deploy": "Deploy",
        "publishing.active": "active",
      };
      return map[key] ?? key;
    },
  }),
}));

import { PublishingRows } from "~/components/features/site-status/PublishingRows";

const STEPS: PublishStep[] = [
  { id: "dispatch", labelKey: "popover.publishing.steps.dispatch", status: "completed" },
  { id: "setup", labelKey: "popover.publishing.steps.setup", status: "completed" },
  { id: "build-js", labelKey: "popover.publishing.steps.build_js", status: "completed" },
  { id: "process-data", labelKey: "popover.publishing.steps.process_data", status: "completed" },
  { id: "build-site", labelKey: "popover.publishing.steps.build_site", status: "completed" },
  { id: "iiif", labelKey: "popover.publishing.steps.media", status: "in_progress" },
  { id: "deploy", labelKey: "popover.publishing.steps.deploy", status: "queued" },
];

describe("PublishingRows", () => {
  it("renders exactly the 7 step rows with their labels", () => {
    const { container, getByText } = render(
      <PublishingRows steps={STEPS} activeStep={6} totalSteps={7} />,
    );
    expect(container.querySelectorAll("[data-phase-row]")).toHaveLength(7);
    getByText("Dispatch build");
    getByText("Build pages");
    getByText("Images and/or audio · active");
    getByText("Deploy");
  });

  it("renders the progress fill at (activeStep/totalSteps)*100%", () => {
    const { container } = render(
      <PublishingRows steps={STEPS} activeStep={6} totalSteps={7} />,
    );
    const fill = container.querySelector(".bg-anil-deep") as HTMLElement | null;
    expect(fill).not.toBeNull();
    expect(fill!.style.width.startsWith("85.7")).toBe(true);
  });

  it("a failed step uses the terracotta swatch token", () => {
    const failed = STEPS.map((s) =>
      s.id === "build-site" ? { ...s, status: "failed" as const } : s,
    );
    const { container } = render(
      <PublishingRows steps={failed} activeStep={5} totalSteps={7} />,
    );
    expect(container.querySelector(".bg-terracotta")).not.toBeNull();
  });
});
