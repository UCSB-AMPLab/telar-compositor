// @vitest-environment jsdom
/**
 * The rewritten Pages sidebar pins the landing page as a
 * first Home row that opens the shared landing editor, while content
 * page rows route to the standard page editor.
 *
 * The shared `HomepageEditor` module is mounted by the `/pages` two-column
 * shell for the pinned Home row, and `PagesSidebar` carries the
 * `HOME_ROW_KEY` sentinel. The full route mount
 * is exercised in staging UAT (signed-in collaborative surface); here we pin
 * the testable contracts without importing the server route module (which
 * would break suite collection):
 *   - the shared `HomepageEditor` component exports,
 *   - the `PagesSidebar` renders a pinned Home row keyed by `HOME_ROW_KEY`
 *     that fires `onSelect(HOME_ROW_KEY)` (the route swaps to HomepageEditor),
 *   - selecting a content row fires `onSelect(<page key>)`, distinct from Home
 *     (the route renders the standard editor).
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import {
  PagesSidebar,
  HOME_ROW_KEY,
  type PagesSidebarRow,
} from "~/components/features/pages/PagesSidebar";

describe("shared HomepageEditor module", () => {
  it("~/components/features/pages/HomepageEditor exports a HomepageEditor component", async () => {
    const mod = await import("~/components/features/pages/HomepageEditor");
    expect(typeof mod.HomepageEditor).toBe("function");
  });
});

describe("Pages sidebar selection routing", () => {
  const contentRows: PagesSidebarRow[] = [
    {
      selectKey: "42",
      sortableId: "nav-page-about",
      label: "About",
      isUntitled: false,
      canDelete: true,
    },
  ];

  function renderSidebar(selectedKey: string, onSelect = vi.fn()) {
    render(
      <PagesSidebar
        contentRows={contentRows}
        untitledRows={[]}
        selectedKey={selectedKey}
        onSelect={onSelect}
        onDelete={vi.fn()}
        onAddPage={vi.fn()}
        onDragEnd={vi.fn()}
        sensors={[]}
        isConvenor
        canAdd
      />,
    );
    return onSelect;
  }

  it("the pinned Home row selects HOME_ROW_KEY (the route mounts HomepageEditor)", () => {
    const onSelect = renderSidebar(HOME_ROW_KEY);
    // The Home row is labelled with nav_home and carries the pin tooltip.
    const homeRow = screen.getByTitle("home_pin_tooltip");
    fireEvent.click(homeRow);
    expect(onSelect).toHaveBeenCalledWith(HOME_ROW_KEY);
  });

  it("a content page row selects its page key, NOT Home (route renders the standard editor)", () => {
    const onSelect = renderSidebar(HOME_ROW_KEY);
    fireEvent.click(screen.getByText("About"));
    expect(onSelect).toHaveBeenCalledWith("42");
    expect(onSelect).not.toHaveBeenCalledWith(HOME_ROW_KEY);
  });
});
