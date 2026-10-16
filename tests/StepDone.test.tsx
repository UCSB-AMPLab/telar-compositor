// @vitest-environment jsdom
/**
 * Tests for `StepDone`, the last onboarding screen. A created site and an
 * imported site get their own copy, and only a created site with a URL shows
 * the URL block; the first-build note needs the build to have started, and a
 * created site whose build did not start, or whose settings fixes were
 * skipped, makes no first-build promise. After skipped fixes the screen does
 * not say the setup is complete, lists only the settings left, offers a way
 * back to the settings check, and sends the author nowhere outside the
 * Compositor. Continue completes onboarding and goes to Start only once the
 * completion is confirmed; the Start and recheck buttons show that they are
 * working until the server answers.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { readFileSync } from "node:fs";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const navigate = vi.fn();
let pendingPath: string | undefined;
vi.mock("react-router", () => ({
  useNavigate: () => navigate,
  useNavigation: () => (pendingPath ? { state: "loading", location: { pathname: pendingPath } } : { state: "idle" }),
}));

import { StepDone } from "~/components/features/onboarding/StepDone";

describe("StepDone", () => {
  it("imported site shows the import copy, no created copy, no URL block", () => {
    render(<StepDone onDone={() => {}} />);
    expect(screen.getByText("step_done.description")).toBeDefined();
    expect(screen.queryByText("step_done.created_description")).toBeNull();
    expect(screen.queryByText("step_done.first_build_note")).toBeNull();
  });

  it("created site with a URL shows the created copy + first-build note + the URL", () => {
    render(
      <StepDone onDone={() => {}} created buildStarted siteUrl="https://me.github.io/my-archive" />,
    );
    expect(screen.getByText("step_done.created_description")).toBeDefined();
    expect(screen.queryByText("step_done.description")).toBeNull();
    expect(screen.getByText("step_done.first_build_note")).toBeDefined();
    expect(screen.getByText("https://me.github.io/my-archive")).toBeDefined();
  });

  it("sends a new site to Start", () => {
    pendingPath = undefined;
    navigate.mockClear();
    render(<StepDone onDone={() => {}} created />);
    fireEvent.click(screen.getByText("step_done.go_to_start"));
    expect(navigate).toHaveBeenCalledWith("/start");
  });

  it("shows it is working, and takes no second press, while Start loads", () => {
    pendingPath = "/start";
    render(<StepDone onDone={() => {}} />);
    const button = screen.getByText("step_done.go_to_start").closest("button");
    expect(button?.disabled).toBe(true);
    expect(button?.querySelector(".animate-spin")).not.toBeNull();
    pendingPath = undefined;
  });

  it("created site without a URL still shows created copy but hides the URL block", () => {
    render(<StepDone onDone={() => {}} created />);
    expect(screen.getByText("step_done.created_description")).toBeDefined();
    expect(screen.queryByText("step_done.first_build_note")).toBeNull();
  });

  it("after skipped fixes it does not say the setup is complete, and lists each setting left", () => {
    render(<StepDone onDone={() => {}} unfixed={["sheets", "pages", "url"]} />);
    expect(screen.getByText("step_done.heading_skipped")).toBeDefined();
    expect(screen.getByText("step_done.description_skipped")).toBeDefined();
    expect(screen.queryByText("step_done.heading")).toBeNull();
    expect(screen.queryByText("step_done.description")).toBeNull();
    expect(screen.getByText("step_done.unfixed_sheets")).toBeDefined();
    expect(screen.getByText("step_done.unfixed_pages")).toBeDefined();
    expect(screen.getByText("step_done.unfixed_url")).toBeDefined();
  });

  it("after skipped fixes it offers a way back to the settings check; with nothing left it does not", () => {
    const onRecheck = vi.fn();
    const { unmount } = render(<StepDone onDone={() => {}} unfixed={["pages"]} onRecheck={onRecheck} />);
    fireEvent.click(screen.getByText("step_done.recheck"));
    expect(onRecheck).toHaveBeenCalledTimes(1);
    unmount();
    render(<StepDone onDone={() => {}} onRecheck={onRecheck} />);
    expect(screen.queryByText("step_done.recheck")).toBeNull();
  });

  it("no unfixed line sends the author to _config.yml or GitHub's settings", () => {
    for (const lang of ["en", "es"]) {
      const strings = JSON.parse(readFileSync(`app/i18n/locales/${lang}/onboarding.json`, "utf8")).step_done;
      for (const key of ["unfixed_sheets", "unfixed_pages", "unfixed_url"]) {
        expect(strings[key], `${lang}.${key}`).not.toMatch(/_config\.yml|Settings|On GitHub|En GitHub,|[Cc]onfiguración del repositorio/);
      }
    }
  });

  it("lists only the settings that were left", () => {
    render(<StepDone onDone={() => {}} unfixed={["url"]} />);
    expect(screen.getByText("step_done.unfixed_url")).toBeDefined();
    expect(screen.queryByText("step_done.unfixed_sheets")).toBeNull();
    expect(screen.queryByText("step_done.unfixed_pages")).toBeNull();
  });

  it("a created site whose build was not started makes no first-build promise", () => {
    render(<StepDone onDone={() => {}} created siteUrl="https://me.github.io/my-archive" />);
    expect(screen.queryByText("step_done.first_build_note")).toBeNull();
  });

  it("a created site with settings skipped makes no first-build promise", () => {
    render(<StepDone onDone={() => {}} created buildStarted unfixed={["pages"]} siteUrl="https://me.github.io/my-archive" />);
    expect(screen.queryByText("step_done.first_build_note")).toBeNull();
    expect(screen.getByText("step_done.unfixed_pages")).toBeDefined();
  });

  it("after skipped fixes, Continue completes onboarding instead of going to Start by itself", () => {
    navigate.mockClear();
    const onContinue = vi.fn();
    render(<StepDone onDone={() => {}} unfixed={["pages"]} onContinue={onContinue} />);
    fireEvent.click(screen.getByText("step_done.go_to_start"));
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("goes to Start only once the completion is confirmed, and says when it was refused", () => {
    navigate.mockClear();
    const { rerender } = render(<StepDone onDone={() => {}} unfixed={["pages"]} onContinue={() => {}} continuing />);
    expect(navigate).not.toHaveBeenCalled();
    rerender(<StepDone onDone={() => {}} unfixed={["pages"]} onContinue={() => {}} continueFailed />);
    expect(screen.getByText("step_done.continue_failed")).toBeDefined();
    expect(navigate).not.toHaveBeenCalled();
    rerender(<StepDone onDone={() => {}} unfixed={["pages"]} onContinue={() => {}} completed />);
    expect(navigate).toHaveBeenCalledWith("/start");
  });

  it("shows the recheck as working while the server has not answered", () => {
    render(<StepDone onDone={() => {}} unfixed={["pages"]} onRecheck={() => {}} rechecking />);
    const button = screen.getByText("step_done.recheck").closest("button");
    expect(button?.disabled).toBe(true);
  });
});
