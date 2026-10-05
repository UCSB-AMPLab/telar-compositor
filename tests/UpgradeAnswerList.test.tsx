// @vitest-environment jsdom
/**
 * The "Edit this step" link of the upgrade's answer list: a step
 * with a place opens that step, a step of a story the project holds with no
 * identifiable place opens the story alone, and a story the project does not
 * hold has no link.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { UpgradeAnswerList } from "~/components/features/upgrade/UpgradeAnswerList";
import type { UpgradeAnswer } from "~/lib/upgrade-answers.server";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const answer = (over: Partial<UpgradeAnswer>): UpgradeAnswer => ({
  story: "my story",
  step: "2",
  position: 3,
  storyHeld: true,
  cellsDropped: true,
  checks: [],
  ...over,
});

const linkOf = (a: UpgradeAnswer) => {
  const { container } = render(
    <MemoryRouter>
      <UpgradeAnswerList answers={[a]} />
    </MemoryRouter>,
  );
  return container.querySelector("a")?.getAttribute("href") ?? null;
};

describe("UpgradeAnswerList", () => {
  it("links a step by the place found in the editor's order", () => {
    expect(linkOf(answer({}))).toBe("/stories/my%20story?step=3");
  });

  it("links the story alone where the step has no identifiable place", () => {
    expect(linkOf(answer({ position: null }))).toBe("/stories/my%20story");
  });

  it("has no link for a story the project does not hold", () => {
    expect(linkOf(answer({ position: null, storyHeld: false }))).toBeNull();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });
});
