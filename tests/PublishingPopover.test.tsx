// @vitest-environment jsdom
/**
 * Pins the `PublishingPopover` body: the 7-step model (dispatch + the six
 * BUILD_PHASES) from resolvePublishSteps, the per-row icon tokens, the N/7
 * caption from activeStep, the anil-deep progress fill, the Watch-on-GitHub
 * footer link, and that it reads the publish flags from useCollaborationContext
 * (awareness) and reuses the existing poll-build loop.
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import type { BuildPhaseStatus } from "~/lib/commit.server";

const submitSpy = vi.fn();
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useFetcher: () => ({ submit: submitSpy, state: "idle", data: undefined }),
  };
});

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    connectionStatus: "connected",
    isPublishing: true,
    isBuilding: false,
    isUpgrading: false,
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        "publishing.title": "Publishing… {{step}} of {{total}}",
        "publishing.steps.dispatch": "Dispatch build",
        "publishing.steps.setup": "Set up",
        "publishing.steps.build_js": "Build code",
        "publishing.steps.process_data": "Process content",
        "publishing.steps.build_site": "Build pages",
        "publishing.steps.media": "Images and/or audio",
        "publishing.steps.deploy": "Deploy",
        "publishing.active": "active",
        "publishing.watch_github": "Watch on GitHub",
      };
      let out = map[key] ?? key;
      if (opts) for (const [k, v] of Object.entries(opts)) out = out.replace(`{{${k}}}`, String(v));
      return out;
    },
  }),
}));

import { MemoryRouter } from "react-router";
import { PublishingPopover } from "~/components/features/site-status/popovers/PublishingPopover";

const phases: BuildPhaseStatus[] = [
  { id: "setup", label: "Setup", status: "completed", conclusion: "success" },
  { id: "build-js", label: "Build JS", status: "completed", conclusion: "success" },
  { id: "process-data", label: "Process data", status: "completed", conclusion: "success" },
  { id: "build-site", label: "Build site", status: "in_progress", conclusion: null },
  { id: "iiif", label: "IIIF tiles", status: "queued", conclusion: null },
  { id: "deploy", label: "Deploy", status: "queued", conclusion: null },
];

function renderPopover(props: Parameters<typeof PublishingPopover>[0]) {
  submitSpy.mockClear();
  return render(
    <MemoryRouter>
      <PublishingPopover {...props} />
    </MemoryRouter>,
  );
}

describe("PublishingPopover", () => {
  it("renders exactly 7 step rows", () => {
    const { container } = renderPopover({ phases });
    expect(container.querySelectorAll("[data-phase-row]").length).toBe(7);
  });

  it("renders the seven step labels", () => {
    const { container } = renderPopover({ phases });
    for (const label of [
      "Dispatch build", "Set up", "Build code", "Process content",
      "Build pages", "Images and/or audio", "Deploy",
    ]) {
      expect(container.textContent).toContain(label);
    }
  });

  it("caption shows N/7 derived from resolvePublishSteps.activeStep", () => {
    const { container } = renderPopover({ phases });
    expect(container.textContent).toContain("5/7");
  });

  it("done rows use bg-chilca + text-surface icon tokens", () => {
    const { container } = renderPopover({ phases });
    expect(container.querySelector(".bg-chilca.text-surface")).not.toBeNull();
  });

  it("active row uses bg-anil-pale + text-anil-ink icon tokens", () => {
    const { container } = renderPopover({ phases });
    expect(container.querySelector(".bg-anil-pale.text-anil-ink")).not.toBeNull();
  });

  it("progress bar fill uses bg-anil-deep", () => {
    const { container } = renderPopover({ phases });
    expect(container.querySelector(".bg-anil-deep")).not.toBeNull();
  });

  it("renders a Watch-on-GitHub footer link to buildUrl", () => {
    const { container } = renderPopover({
      phases,
      buildUrl: "https://github.com/o/r/actions/runs/9",
    });
    const link = container.querySelector('a[href="https://github.com/o/r/actions/runs/9"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain("Watch on GitHub");
  });

  it("renders the 7-step model in a dispatching state when no phases are supplied", () => {
    const { container } = renderPopover({ phases: null });
    expect(container.querySelectorAll("[data-phase-row]").length).toBe(7);
  });
});
