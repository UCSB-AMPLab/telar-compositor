// @vitest-environment jsdom
/**
 * StepDone.test.tsx — covers the created-vs-imported copy switch and the
 * created-only site-URL block (the props WizardShell passes), and the Start
 * button's pending state.
 *
 * @version v1.5.3-beta
 */

import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";

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
      <StepDone onDone={() => {}} created siteUrl="https://me.github.io/my-archive" />,
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
});
