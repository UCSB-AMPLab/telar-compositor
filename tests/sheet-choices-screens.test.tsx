// @vitest-environment jsdom
/**
 * The screens that offer the column picker in place of the colliding-columns
 * message: the import's sync step, the sync dialog and the orphan
 * restore's outcome. Choosing posts the challenge with the choices, and the
 * sync dialog runs its check again once the choice is committed.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const fetchers = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  submits: [] as { key: string; payload: Record<string, string> }[],
}));
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useFetcher: (opts?: { key?: string }) => {
      const key = opts?.key ?? "unkeyed";
      return {
        state: "idle",
        data: fetchers.data.get(key),
        submit: (payload: Record<string, string>) => fetchers.submits.push({ key, payload }),
      };
    },
    useNavigate: () => vi.fn(),
  };
});
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { StepSync } from "~/components/features/onboarding/StepSync";
import { UpgradeColumnPicker } from "~/components/features/upgrade/UpgradeColumnPicker";
import { SyncConfirmModal, SYNC_DIFF_FETCHER_KEY } from "~/components/features/dashboard/SyncConfirmModal";
import { OrphanRecoveryOutcome, ORPHAN_RECOVERY_FETCHER_KEY } from "~/components/features/start/OrphanRecoveryCard";
import type { ImportResult } from "~/lib/import.server";
import type { SheetChoicesQuestion } from "~/lib/sheet-choices.server";

const OBJECTS = "telar-content/spreadsheets/objects.csv";

function askedQuestion(source: "repo" | "tabs" = "repo"): SheetChoicesQuestion {
  return {
    error: "needs_choices",
    source,
    challenge: "signed-challenge",
    notice: null,
    groups: [
      {
        file: OBJECTS,
        sheet: "objects.csv",
        claim: "medium",
        positions: [2, 3],
        columns: [
          { position: 2, header: "medium", values: ["Oil"] },
          { position: 3, header: "object_type", values: ["Painting"] },
        ],
        needsChoice: false,
      },
    ],
  };
}

function keepSecondColumn() {
  fireEvent.click(screen.getAllByRole("radio")[1]);
  fireEvent.click(screen.getByText("columnPickerContinue"));
}

beforeEach(() => {
  fetchers.data.clear();
  fetchers.submits.length = 0;
});
afterEach(cleanup);

describe("the picker after a fresh question", () => {
  it("starts with nothing chosen when new groups arrive in place of the old", () => {
    const first = askedQuestion();
    const view = render(<UpgradeColumnPicker groups={first.groups} notice={null} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("radio")[1]);
    expect((screen.getAllByRole("radio")[1] as HTMLInputElement).checked).toBe(true);

    const fresh = askedQuestion();
    fresh.groups[0].columns[0].values = ["Ink"];
    view.rerender(<UpgradeColumnPicker groups={fresh.groups} notice="sheets_changed" onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getAllByRole("radio").some((r) => (r as HTMLInputElement).checked)).toBe(false);
    expect((screen.getByText("columnPickerContinue").closest("button") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the import's sync step", () => {
  function renderStep(question: SheetChoicesQuestion, onChooseColumns = vi.fn()) {
    const result = { valid: false, validationError: "needs_choices", sheetChoices: question } as unknown as ImportResult;
    render(
      <StepSync
        importResult={result}
        isImporting={false}
        onBack={vi.fn()}
        onContinue={vi.fn()}
        onRetryWithUrl={vi.fn()}
        onFixDefaultBranch={vi.fn()}
        onChooseColumns={onChooseColumns}
      />,
    );
    return onChooseColumns;
  }

  it("offers the picker instead of the refusal, and returns the choice with the challenge", () => {
    const onChooseColumns = renderStep(askedQuestion());
    expect(screen.getByText("upgrade:columnPickerIntroSite")).toBeTruthy();
    keepSecondColumn();
    expect(onChooseColumns).toHaveBeenCalledWith("signed-challenge", [{ file: OBJECTS, positions: [2, 3], keep: 3 }]);
  });

  it("says the Google Sheet stays as it is for an import from Sheets", () => {
    renderStep(askedQuestion("tabs"));
    expect(screen.getByText("upgrade:columnPickerIntroSheets")).toBeTruthy();
  });
});

describe("the sync dialog", () => {
  it("offers the picker for a refused check, posts the choice, and checks again once it is committed", () => {
    const view = render(<SyncConfirmModal open unpublishedCount={0} onClose={() => {}} />);
    fireEvent.click(screen.getByText("sync_modal.check_changes"));
    fetchers.data.set(SYNC_DIFF_FETCHER_KEY, { ok: false, intent: "compute-full-sync-diff", ...askedQuestion() });
    view.rerender(<SyncConfirmModal open unpublishedCount={0} onClose={() => {}} />);
    expect(screen.getByText("columnPickerIntroSite")).toBeTruthy();
    keepSecondColumn();
    expect(fetchers.submits.at(-1)?.payload).toEqual({
      intent: "choose-columns",
      sheet_challenge: "signed-challenge",
      sheet_choices: JSON.stringify([{ file: OBJECTS, positions: [2, 3], keep: 3 }]),
    });

    const checks = fetchers.submits.filter((s) => s.payload.intent === "compute-full-sync-diff").length;
    fetchers.data.set("unkeyed", { ok: true, intent: "choose-columns" });
    view.rerender(<SyncConfirmModal open unpublishedCount={0} onClose={() => {}} />);
    expect(fetchers.submits.filter((s) => s.payload.intent === "compute-full-sync-diff").length).toBe(checks + 1);
  });
});

describe("the orphan restore's outcome", () => {
  it("offers the picker, and restores again once the choice is committed", () => {
    const answer = { ok: false as const, intent: "restore-orphan-drafts" as const, warnings: [], ...askedQuestion() };
    const view = render(<OrphanRecoveryOutcome answer={answer} />);
    expect(screen.getByText("columnPickerIntroSite")).toBeTruthy();
    fetchers.data.set("unkeyed", { ok: true, intent: "choose-columns" });
    view.rerender(<OrphanRecoveryOutcome answer={answer} />);
    expect(fetchers.submits.at(-1)).toEqual({ key: ORPHAN_RECOVERY_FETCHER_KEY, payload: { intent: "restore-orphan-drafts" } });
  });
});
