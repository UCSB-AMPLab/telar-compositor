// @vitest-environment jsdom
/**
 * Pins the horizontal <PublishingStepper> — the Publish-page running-state
 * tracker: 7 nodes joined by connectors, a step caption, and a Watch-on-GitHub
 * link. Pure presentation; takes already-resolved steps from resolvePublishSteps.
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import type { PublishStep } from "~/components/features/site-status/build-phase-collapse";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        "publishing.building": "Building your site · step {{step}} of {{total}}",
        "publishing.steps.dispatch": "Dispatch build",
        "publishing.steps.setup": "Set up",
        "publishing.steps.build_js": "Build code",
        "publishing.steps.process_data": "Process content",
        "publishing.steps.build_site": "Build pages",
        "publishing.steps.media": "Images and/or audio",
        "publishing.steps.deploy": "Deploy",
        "publishing.watch_github": "Watch on GitHub",
      };
      let out = map[key] ?? key;
      if (opts) for (const [k, v] of Object.entries(opts)) out = out.replace(`{{${k}}}`, String(v));
      return out;
    },
  }),
}));

import { PublishingStepper } from "~/components/features/site-status/PublishingStepper";

const STEPS: PublishStep[] = [
  { id: "dispatch", labelKey: "popover.publishing.steps.dispatch", status: "completed" },
  { id: "setup", labelKey: "popover.publishing.steps.setup", status: "completed" },
  { id: "build-js", labelKey: "popover.publishing.steps.build_js", status: "completed" },
  { id: "process-data", labelKey: "popover.publishing.steps.process_data", status: "completed" },
  { id: "build-site", labelKey: "popover.publishing.steps.build_site", status: "completed" },
  { id: "iiif", labelKey: "popover.publishing.steps.media", status: "in_progress" },
  { id: "deploy", labelKey: "popover.publishing.steps.deploy", status: "queued" },
];

describe("PublishingStepper", () => {
  it("renders exactly 7 step nodes with their labels", () => {
    const { container, getByText } = render(
      <PublishingStepper steps={STEPS} activeStep={6} totalSteps={7} buildUrl={null} />,
    );
    expect(container.querySelectorAll("[data-step-node]")).toHaveLength(7);
    getByText("Dispatch build");
    getByText("Images and/or audio");
    getByText("Deploy");
  });

  it("shows the running caption with the active step number", () => {
    const { getByText } = render(
      <PublishingStepper steps={STEPS} activeStep={6} totalSteps={7} buildUrl={null} />,
    );
    getByText("Building your site · step 6 of 7");
  });

  it("renders a Watch-on-GitHub link to buildUrl when present", () => {
    const { container } = render(
      <PublishingStepper
        steps={STEPS}
        activeStep={6}
        totalSteps={7}
        buildUrl="https://github.com/o/r/actions/runs/1"
      />,
    );
    const link = container.querySelector('a[href="https://github.com/o/r/actions/runs/1"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain("Watch on GitHub");
  });

  it("a completed node shows the Check icon; a failed node uses the terracotta token", () => {
    const failed = STEPS.map((s) =>
      s.id === "build-site" ? { ...s, status: "failed" as const } : s,
    );
    const { container } = render(
      <PublishingStepper steps={failed} activeStep={5} totalSteps={7} buildUrl={null} />,
    );
    // done nodes render a check (lucide svg)
    expect(container.querySelector("[data-step-node] svg")).not.toBeNull();
    // failed node carries the terracotta background token
    expect(container.querySelector(".bg-terracotta")).not.toBeNull();
  });
});
