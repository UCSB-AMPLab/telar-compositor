// @vitest-environment jsdom
/**
 * The publish page's objects chip counts a changed order of objects once.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { ChangeSummary as Summary } from "~/lib/publish.server";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { ChangeSummary } from "~/components/features/publish/ChangeSummary";

afterEach(() => cleanup());

const empty = { new: [], modified: [], deleted: [] };

function summary(orderChanged: boolean): Summary {
  return {
    isUpToDate: !orderChanged,
    backCompatBootstrap: false,
    stories: empty,
    objects: empty,
    pages: empty,
    glossary: empty,
    settings: { changed: [] },
    landing: { changed: false },
    navigation: { changed: false },
    objectOrder: { changed: orderChanged },
    fileChanges: { addedStoryFiles: [], removedStoryFiles: [] },
  };
}

describe("the objects chip", () => {
  it("counts a changed order of objects as one", () => {
    render(<ChangeSummary summary={summary(true)} />);
    const chip = screen.getByText("chips.objects").parentElement as HTMLElement;
    expect(chip.textContent).toContain("1");
  });

  it("shows no objects chip without one", () => {
    render(<ChangeSummary summary={summary(false)} />);
    expect(screen.queryByText("chips.objects")).toBeNull();
  });
});
