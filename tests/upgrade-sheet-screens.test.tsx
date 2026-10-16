// @vitest-environment jsdom
/**
 * The upgrade's sheet screens: the column picker, the
 * repair report the confirmation and the done screen share, with the lines
 * for the Compositor's glossary the done screen adds to it, and the line
 * that opens the review of the changes on GitHub when the upgrade did not
 * record itself as synced.
 *
 * @version v1.5.5-beta
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
  }),
}));
vi.mock("react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

import { UpgradeColumnPicker } from "~/components/features/upgrade/UpgradeColumnPicker";
import { UpgradeSheetReport, hasSheetReportLines } from "~/components/features/upgrade/UpgradeSheetReport";
import { UpgradeSyncNeeded } from "~/components/features/upgrade/UpgradeSyncNeeded";
import { SyncReviewContext, type SyncReview } from "~/components/features/dashboard/SyncReviewProvider";
import type { OfferedGroup, SheetReportLine } from "~/lib/upgrade-sheets.server";

const FILE = "telar-content/spreadsheets/my-story.csv";

function offeredGroup(overrides: Partial<OfferedGroup> = {}): OfferedGroup {
  return {
    file: FILE,
    sheet: "my-story.csv",
    claim: "note",
    positions: [2, 3],
    columns: [
      { position: 2, header: "note", values: ["a", "b"] },
      { position: 3, header: "Note", values: [] },
    ],
    needsChoice: false,
    ...overrides,
  };
}

describe("UpgradeColumnPicker", () => {
  it("shows each group with its columns, numbered from one, and their values", () => {
    render(<UpgradeColumnPicker groups={[offeredGroup()]} notice={null} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/columnPickerGroup .*"sheet":"my-story.csv".*"field":"note"/)).toBeTruthy();
    expect(screen.getByText(/columnPickerColumn .*"position":"3".*"header":"note"/)).toBeTruthy();
    expect(screen.getByText(/columnPickerValues .*"values":"a, b"/)).toBeTruthy();
    expect(screen.getByText("columnPickerEmpty")).toBeTruthy();
  });

  it("posts one choice per group, by first-read positions, once every group has one", () => {
    const onSubmit = vi.fn();
    const second = offeredGroup({ file: "telar-content/spreadsheets/b.csv", sheet: "b.csv", positions: [0, 1], columns: [
      { position: 0, header: "title", values: ["x"] },
      { position: 1, header: "Title", values: ["y"] },
    ] });
    render(<UpgradeColumnPicker groups={[offeredGroup(), second]} notice={null} onSubmit={onSubmit} onCancel={vi.fn()} />);
    const continueButton = screen.getByRole("button", { name: "columnPickerContinue" });
    expect((continueButton as HTMLButtonElement).disabled).toBe(true);
    const radios = screen.getAllByRole("radio");
    fireEvent.click(radios[1]);
    fireEvent.click(radios[2]);
    fireEvent.click(continueButton);
    expect(onSubmit).toHaveBeenCalledWith([
      { file: FILE, positions: [2, 3], keep: 3 },
      { file: "telar-content/spreadsheets/b.csv", positions: [0, 1], keep: 0 },
    ]);
  });

  it.each([
    ["sheets_changed", "columnPickerSheetsChanged"],
    ["further_choices", "columnPickerFurther"],
    ["choice_needed", "columnPickerChoiceNeeded"],
  ] as const)("says why it is asking again (%s)", (notice, key) => {
    render(<UpgradeColumnPicker groups={[offeredGroup()]} notice={notice} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(key)).toBeTruthy();
  });

  it("marks the group that still needs a choice", () => {
    render(<UpgradeColumnPicker groups={[offeredGroup({ needsChoice: true })]} notice="choice_needed" onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText("columnPickerNeedsChoice")).toBeTruthy();
  });

  it("cancels", () => {
    const onCancel = vi.fn();
    render(<UpgradeColumnPicker groups={[offeredGroup()]} notice={null} onSubmit={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "columnPickerCancel" }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe("UpgradeSheetReport", () => {
  const dropped = (chosen: boolean, bothEmpty = false): SheetReportLine => ({
    kind: "dropped", sheet: "my-story.csv", column: "note", position: 2, keeper: "Note", keeperPosition: 3, bothEmpty, chosen, file: FILE,
  });

  it.each([
    [dropped(false), "repairDropped"],
    [dropped(false, true), "repairDroppedAllEmpty"],
    [dropped(true), "repairDroppedChosen"],
    [{ kind: "marked", sheet: "s.csv", column: "note", position: 0, markedAs: "#note", chosen: false, heldValues: false, file: FILE } as SheetReportLine, "repairMarked"],
    [{ kind: "marked", sheet: "s.csv", column: "note", position: 0, markedAs: "#note", chosen: true, heldValues: true, file: FILE } as SheetReportLine, "repairMarkedChosen"],
    [{ kind: "unreadable", sheet: "s.csv", error: "x", file: FILE } as SheetReportLine, "repairUnreadable"],
    [{ kind: "glossary_language_matched", sheet: "glossary.csv", term: "telar", file: FILE } as SheetReportLine, "glossaryLanguageMatched"],
    [{ kind: "glossary_language_unconfirmed", sheet: "glossary.csv", term: "telar", file: FILE } as SheetReportLine, "glossaryLanguageUnconfirmed"],
  ])("writes one line for each change (%#)", (line, key) => {
    render(<UpgradeSheetReport lines={[line]} />);
    expect(screen.getByText("sheetReportHeading")).toBeTruthy();
    expect(screen.getByText(new RegExp(`^${key} `))).toBeTruthy();
  });

  it("shows nothing, and counts nothing to show, for a report with no line the author reads", () => {
    const { container } = render(<UpgradeSheetReport lines={[]} />);
    expect(container.textContent).toBe("");
    expect(hasSheetReportLines([])).toBe(false);
    expect(hasSheetReportLines([dropped(false)])).toBe(true);
  });
});

describe("UpgradeSyncNeeded", () => {
  function renderAs(review: SyncReview) {
    return render(
      <SyncReviewContext.Provider value={review}>
        <UpgradeSyncNeeded />
      </SyncReviewContext.Provider>,
    );
  }

  it("opens the review in place for the convenor, and says why", () => {
    const openReview = vi.fn();
    const { container } = renderAs({ openReview, canReview: true, coordinatorName: "Ana Pérez" });
    expect(screen.getByText("syncNeeded")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "syncNeededLink" }));
    expect(openReview).toHaveBeenCalledTimes(1);
    expect(container.querySelector("a")).toBeNull();
  });

  it("tells anyone else who chooses, with no button", () => {
    renderAs({ openReview: vi.fn(), canReview: false, coordinatorName: "Ana Pérez" });
    expect(screen.getByText(/^reviewByCoordinator/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
