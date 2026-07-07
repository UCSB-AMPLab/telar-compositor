// @vitest-environment jsdom
/**
 * StepDone.test.tsx — covers the created-vs-imported copy switch and the
 * created-only site-URL block (the props WizardShell now passes).
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("react-router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
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

  it("created site without a URL still shows created copy but hides the URL block", () => {
    render(<StepDone onDone={() => {}} created />);
    expect(screen.getByText("step_done.created_description")).toBeDefined();
    expect(screen.queryByText("step_done.first_build_note")).toBeNull();
  });
});
