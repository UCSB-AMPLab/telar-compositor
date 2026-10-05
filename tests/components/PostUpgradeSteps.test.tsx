// @vitest-environment jsdom

/**
 * The done stage's manual steps, grouped by kind.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { PostUpgradeSteps } from "~/components/features/upgrade/PostUpgradeSteps";
import type { ManualStep } from "~/lib/manifest-schema.server";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) => (opts?.count === undefined ? key : `${key} ${opts.count}`),
  }),
}));

afterEach(cleanup);

const step = (description: string, kind?: string, audience?: string): ManualStep => ({ description, kind, audience });

describe("PostUpgradeSteps", () => {
  it("says there is nothing to do when only notes are left, and folds the notes away with a count", () => {
    const { container } = render(
      <PostUpgradeSteps steps={[step("Carousels changed", "note"), step("Edit build.yml", "action", "local")]} googleSheetsEnabled={false} />,
    );
    expect(screen.getByText("manualStepsEmpty")).toBeTruthy();
    expect(screen.queryByText("manualStepsIntro")).toBeNull();
    expect(screen.queryByText("Edit build.yml")).toBeNull();
    const details = container.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toBe("manualStepsNotesToggle 1");
    expect(details?.textContent).toContain("Carousels changed");
  });

  it("lists actions in order, then optional steps, then what it could not classify", () => {
    const { container } = render(
      <PostUpgradeSteps
        steps={[step("Maybe this", "optional"), step("First", "action"), step("Unknown"), step("Second", "action")]}
        googleSheetsEnabled={false}
      />,
    );
    expect(screen.queryByText("manualStepsEmpty")).toBeNull();
    expect([...container.querySelectorAll("ol > li")].map((li) => li.textContent?.trim())).toEqual(["First", "Second"]);
    expect(screen.getByText("manualStepsOptionalIntro")).toBeTruthy();
    expect(screen.getByText("manualStepsUnclassifiedHeading")).toBeTruthy();
    expect(screen.getByText("Unknown")).toBeTruthy();
    expect(container.querySelector("details")).toBeNull();
  });

  it("does not claim nothing is needed while a step is unclassified", () => {
    render(<PostUpgradeSteps steps={[step("Unknown"), step("News", "note")]} googleSheetsEnabled={false} />);
    expect(screen.queryByText("manualStepsEmpty")).toBeNull();
    expect(screen.getByText("manualStepsUnclassifiedIntro")).toBeTruthy();
  });
});
