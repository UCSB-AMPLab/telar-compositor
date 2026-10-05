// @vitest-environment jsdom
/**
 * The Upgrade page's sheet screens in the flow: a prepared
 * upgrade with nothing to show commits straight away, one with a repair
 * report waits on the confirmation, a question goes to the column picker and
 * its answer back to prepare, the offer to stop reading Google Sheets sends
 * its answer back to prepare, and the done screen, built or failed, shows the
 * report, the switch from Google Sheets and the line that sends the author to
 * the sync, with the post-upgrade steps following the upgrade's own result.
 *
 * The harness is upgrade-rebuild.test.tsx's.
 *
 * @version v1.5.0-beta
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const revalidateSpy = vi.hoisted(() => vi.fn());

interface FetcherStub {
  data: unknown;
  state: "idle" | "submitting" | "loading";
  submit: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
}

/** One stub per `useFetcher()` the page calls, named for its slot in
 *  declaration order: the page's own reload, the upgrade itself, the build
 *  poll, the rebuild. */
const FETCHER_SLOTS = ["reload", "upgrade", "poll", "rebuild"] as const;
type FetcherSlot = (typeof FETCHER_SLOTS)[number];

let fetchers: Record<FetcherSlot, FetcherStub>;
let fetcherCallIndex = 0;

const makeFetcher = (): FetcherStub => ({ data: undefined, state: "idle", submit: vi.fn(), load: vi.fn() });

function resetSheetFlowFetchers() {
  fetchers = { reload: makeFetcher(), upgrade: makeFetcher(), poll: makeFetcher(), rebuild: makeFetcher() };
  fetcherCallIndex = 0;
}

/** Every payload the build poll was asked to submit, in order. */
function sheetFlowPollSubmissions(): Array<Record<string, string>> {
  return fetchers.poll.submit.mock.calls.map((c) => c[0] as Record<string, string>);
}

/**
 * Echoes the key followed by whatever the page interpolated into it. A stub
 * that returned the key alone would make "the version is still on screen"
 * indistinguishable from "some line rendered", which is the whole point of the
 * assertion that the landed upgrade's version survives a rebuild.
 *
 * One function identity, defined once: a `t` that changed identity per render
 * would spin any effect that depends on it.
 */
const sheetFlowT = (key: string, opts?: Record<string, unknown>) => {
  const values = opts ? Object.values(opts).map(String).join(" ") : "";
  return values ? `${key} ${values}` : key;
};
vi.mock("react-i18next", () => ({
  Trans: ({ i18nKey, values }: { i18nKey: string; values?: Record<string, unknown> }) =>
    `${i18nKey} ${JSON.stringify(values ?? {})}`,
  useTranslation: () => ({ t: sheetFlowT, i18n: { language: "en" } }),
}));

vi.mock("react-router", () => ({
  useRevalidator: () => ({ revalidate: revalidateSpy, state: "idle" }),
  // A fresh object per call (rather than the same stub reference) so that
  // `useSiteFetcher`'s memoisation (keyed on the fetcher it wraps) recomputes
  // on the render after a test mutates a stub's `.data` in place; `submit`
  // stays the same spy so assertions on it still see every call.
  useFetcher: () => {
    const slot = fetchers[FETCHER_SLOTS[fetcherCallIndex % FETCHER_SLOTS.length]];
    fetcherCallIndex += 1;
    return { ...slot };
  },
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  // The layout's member list, which names the holder of a lock; none here.
  useRouteLoaderData: () => undefined,
  // usePageSiteId's provider is mounted in the layout, not on this page, so
  // the location it reads is never exercised here.
  useLocation: () => ({ key: "test", pathname: "/upgrade" }),
  redirect: (url: string) => ({ url }),
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("~/hooks/use-role", () => ({ useIsConvenor: () => true, useIsPublisher: () => true, useRole: () => "convenor" }));
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({ provider: null }),
}));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: () => ({ getSession: () => ({ get: () => undefined }) }),
}));
vi.mock("~/lib/db.server", () => ({ getDb: () => ({}) }));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn() }));
vi.mock("~/lib/membership.server", () => ({ requirePublishingRole: vi.fn(), resolveActiveProject: vi.fn() }));
vi.mock("~/lib/active-project.server", () => ({ resolveActiveProjectFromRequest: vi.fn() }));
vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(),
  resolveProjectToken: vi.fn(async () => "install-token"),
}));
vi.mock("~/lib/github-status.server", () => ({ bumpProjectHeadFrom: vi.fn(async () => true) }));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function sheetFlowLoaderData() {
  return {
    siteVersion: "1.6.1",
    latestRelease: null,
    releaseNotes: "",
    releaseCount: 0,
    diff: null,
    filesByCategory: {},
    configContent: "",
    isBelowMinimum: false,
    needsUpgrade: true,
    googleSheetsEnabled: false,
    project: {
      id: 1,
      github_pages_url: "https://student.github.io/my-site",
      github_repo_full_name: "student/my-site",
    },
  };
}

let Page: React.ComponentType<{ loaderData: unknown }>;
let rerenderSheetFlowPage: () => void;

async function renderSheetFlowPage(loaded: Partial<ReturnType<typeof sheetFlowLoaderData>> = {}) {
  const mod = (await import("~/routes/_app.upgrade")) as unknown as {
    default: React.ComponentType<{ loaderData: unknown }>;
  };
  Page = mod.default;
  const loaderData = { ...sheetFlowLoaderData(), ...loaded };
  const view = render(<Page loaderData={loaderData as never} />);
  rerenderSheetFlowPage = () => {
    fetcherCallIndex = 0;
    view.rerender(<Page loaderData={loaderData as never} />);
  };
  return view;
}

/** Applies a change to the fetcher stubs and lets the page react to it. */
function pushSheetFlow(change: () => void) {
  act(() => {
    change();
    rerenderSheetFlowPage();
  });
}

const REPORT_LINE = {
  kind: "dropped", sheet: "my-story.csv", column: "note", position: 2, keeper: "Note", keeperPosition: 3,
  bothEmpty: false, chosen: true, file: "telar-content/spreadsheets/my-story.csv",
};

const ANSWER = {
  story: "my-story",
  step: "2",
  position: 2,
  storyHeld: true,
  cellsDropped: false,
  checks: [{ code: "step_answer_has_table", message: "step_answer_has_table", entityId: "my-story.csv:1", params: { number: "2", story: "my-story", count: 1 } }],
};

function preparedWith(sheetReport: unknown[], answers: unknown[] = [], extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    intent: "upgrade-prepare",
    answer: "ready",
    prepared: { newVersion: "v1.8.0", sheetReport, answers, operationId: "op-1", signature: { sigHex: "s", timestamp: 1 }, ...extra },
  };
}

const QUESTION = {
  ok: true,
  intent: "upgrade-prepare",
  answer: "needs_choices",
  challenge: { content: { v: 1 }, signature: { sigHex: "c", timestamp: 1 } },
  notice: null,
  groups: [
    {
      file: "telar-content/spreadsheets/my-story.csv",
      sheet: "my-story.csv",
      claim: "note",
      positions: [2, 3],
      columns: [
        { position: 2, header: "note", values: ["a"] },
        { position: 3, header: "Note", values: ["b"] },
      ],
      needsChoice: false,
    },
  ],
};

function committedWithReport(advancesHead: boolean) {
  return {
    ok: true,
    intent: "upgrade-commit",
    newHeadSha: "upgrade-sha",
    newVersion: "v1.8.0",
    owner: "student",
    repo: "my-site",
    manualSteps: { en: [], es: [] },
    sheetReport: [REPORT_LINE],
    advancesHead,
    answers: [ANSWER],
  };
}

const RUN = (conclusion: string) => ({
  ok: true,
  intent: "poll-build",
  buildStatus: "completed",
  buildConclusion: conclusion,
  buildUrl: "https://github.com/student/my-site/actions/runs/111",
  runId: 111,
  phases: [],
});

const upgradeSubmissions = () => fetchers.upgrade.submit.mock.calls.map((c) => c[0] as Record<string, string>);

beforeEach(() => {
  vi.clearAllMocks();
  resetSheetFlowFetchers();
});

describe("Upgrade page — sheet screens", () => {
  it("commits a prepared upgrade with nothing to show straight away", async () => {
    await renderSheetFlowPage();
    pushSheetFlow(() => {
      fetchers.upgrade.data = preparedWith([]);
    });
    expect(upgradeSubmissions().map((s) => s.intent)).toEqual(["upgrade-commit"]);
  });

  it("waits on the confirmation for a prepared upgrade with a repair report, and commits on confirm", async () => {
    await renderSheetFlowPage();
    pushSheetFlow(() => {
      fetchers.upgrade.data = preparedWith([REPORT_LINE]);
    });
    expect(upgradeSubmissions()).toEqual([]);
    expect(screen.getByText("confirmTitle")).toBeTruthy();
    expect(screen.getByText(/^repairDroppedChosen /)).toBeTruthy();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /^confirmButton/ }));
    });
    expect(upgradeSubmissions()).toEqual([
      { intent: "upgrade-commit", preparedState: JSON.stringify(preparedWith([REPORT_LINE]).prepared) },
    ]);
  });

  it("waits on the confirmation for a prepared upgrade with answers and no repair report, linking each step", async () => {
    await renderSheetFlowPage();
    pushSheetFlow(() => {
      fetchers.upgrade.data = preparedWith([], [ANSWER]);
    });
    expect(upgradeSubmissions()).toEqual([]);
    expect(screen.getByText("answersHeading")).toBeTruthy();
    expect(screen.getByText(/^checks\.step_answer_has_table 2 my-story 1$/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "answerEditStep" }).getAttribute("href")).toBe("/stories/my-story?step=2");
  });

  it("waits on the confirmation for a Sheets site whose tabs were checked, saying they were checked as they stood", async () => {
    await renderSheetFlowPage();
    pushSheetFlow(() => {
      fetchers.upgrade.data = preparedWith([], [], { tabsChecked: true });
    });
    expect(upgradeSubmissions()).toEqual([]);
    expect(screen.getByText("confirmTitle")).toBeTruthy();
    expect(screen.getByText("sheetsCheckedAsTheyStood")).toBeTruthy();
  });

  it("links a step by its position and lists a step of a story the project lacks without a link", async () => {
    await renderSheetFlowPage();
    pushSheetFlow(() => {
      fetchers.upgrade.data = preparedWith([], [{ ...ANSWER, step: "3", position: 1 }, { ...ANSWER, story: "elsewhere", position: null, storyHeld: false, cellsDropped: true, checks: [] }]);
    });
    expect(screen.getAllByRole("link", { name: "answerEditStep" }).map((a) => a.getAttribute("href"))).toEqual(["/stories/my-story?step=1"]);
    expect(screen.getByText(/^answerCellsDropped 2 elsewhere$/)).toBeTruthy();
  });

  it("lets go of the prepared upgrade when the author cancels the confirmation", async () => {
    await renderSheetFlowPage();
    pushSheetFlow(() => {
      fetchers.upgrade.data = preparedWith([REPORT_LINE]);
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "confirmCancel" }));
    });
    expect(upgradeSubmissions().map((s) => s.intent)).toEqual(["upgrade-cancel"]);
    expect(screen.queryByText("confirmTitle")).toBeNull();
  });

  it("shows a question in the picker and sends the answer back through prepare with its challenge", async () => {
    await renderSheetFlowPage();
    pushSheetFlow(() => {
      fetchers.upgrade.data = QUESTION;
    });
    expect(screen.getByText("columnPickerTitle")).toBeTruthy();
    act(() => {
      fireEvent.click(screen.getAllByRole("radio")[1]);
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "columnPickerContinue" }));
    });
    expect(upgradeSubmissions()).toEqual([
      {
        intent: "upgrade-prepare",
        challenge: JSON.stringify(QUESTION.challenge),
        choices: JSON.stringify([{ file: "telar-content/spreadsheets/my-story.csv", positions: [2, 3], keep: 3 }]),
        deletions: "[]",
      },
    ]);
  });

  it.each([
    ["success", "upgradeSuccess"],
    ["failure", "upgradeFailed"],
  ])("shows the report and the sync line on the done screen after a %s build", async (conclusion, heading) => {
    await renderSheetFlowPage();
    pushSheetFlow(() => {
      fetchers.upgrade.data = committedWithReport(false);
    });
    pushSheetFlow(() => {
      fetchers.poll.data = RUN(conclusion);
    });
    expect(screen.getByText(heading)).toBeTruthy();
    expect(screen.getByText(/^repairDroppedChosen /)).toBeTruthy();
    expect(screen.getByText("syncNeeded")).toBeTruthy();
    expect(screen.getByText(/^checks\.step_answer_has_table /)).toBeTruthy();
  });

  it.each([
    [{ error: "sheet_rows_changed", detail: { sheet: "s.csv", columns: "note", reason: "header_row" } }, /^sheetRowsChanged_header_row .*s\.csv/],
    [{ error: "sheet_rows_changed", detail: { sheet: "s.csv", columns: "note", reason: "unsafe" } }, /^sheetRowsChanged_unsafe /],
    [{ error: "sheet_reserved_column", detail: { sheet: "s.csv", column: "_metadata" } }, /^sheetReservedColumn .*_metadata/],
    [{ error: "sheet_unreadable_for_repair", detail: { sheet: "s.csv", columns: "a, A" } }, /^sheetUnreadableForRepair .*a, A/],
    [{ error: "invalid_upgrade_challenge" }, /^invalidUpgradeChallenge$/],
    [{ error: "sheets_columns_refused", detail: { tabs: "my-story, objects", count: 2, collisions: [] } }, /^sheetsColumnsRefused my-story, objects 2$/],
    [{ error: "published_tab_unreadable", detail: { name: "my-story" } }, /^publishedTabUnreadable my-story$/],
    [{ error: "published_sheet_unreadable" }, /^publishedSheetUnreadable$/],
    [{ error: "sheets_switch_unreadable" }, /^sheetsSwitchUnreadable$/],
    [{ error: "sheet_rows_changed", detail: { sheet: "my-story", columns: "note", reason: "rows_changed", tab: true } }, /^tabRowsChanged_rows_changed my-story note$/],
    [{ error: "sheet_rows_changed", detail: { sheet: "my-story", columns: "note", reason: "header_row", tab: true } }, /^tabRowsChanged_header_row /],
    [{ error: "sheet_rows_changed", detail: { sheet: "my-story", columns: "note", reason: "unsafe", tab: true } }, /^tabRowsChanged_unsafe /],
    [{ error: "sheet_reserved_column", detail: { sheet: "my-story", column: "_metadata", tab: true } }, /^tabReservedColumn my-story _metadata$/],
    [{ error: "sheet_unreadable_for_repair", detail: { sheet: "my-story", columns: "a, A", tab: true } }, /^tabUnreadableForRepair my-story a, A$/],
  ])("names a sheet stop with its own message (%#)", async (failure, text) => {
    await renderSheetFlowPage();
    pushSheetFlow(() => {
      fetchers.upgrade.data = { ok: false, intent: "upgrade-prepare", ...failure };
    });
    expect(screen.getByText(text)).toBeTruthy();
  });

  it("lists each tab's colliding columns under the message that names the tabs", async () => {
    await renderSheetFlowPage();
    pushSheetFlow(() => {
      fetchers.upgrade.data = {
        ok: false,
        intent: "upgrade-prepare",
        error: "sheets_columns_refused",
        detail: {
          tabs: "my-story, objects",
          count: 2,
          collisions: [
            { tab: "my-story", columns: ["note", "Note"] },
            { tab: "objects", columns: ["title", "Title", "TITLE"] },
          ],
        },
      };
    });
    expect(screen.getByText("my-story: note, Note").tagName).toBe("LI");
    expect(screen.getByText("objects: title, Title, TITLE").tagName).toBe("LI");
  });

  it("has no sync line when the upgrade recorded itself as synced", async () => {
    await renderSheetFlowPage();
    pushSheetFlow(() => {
      fetchers.upgrade.data = committedWithReport(true);
    });
    pushSheetFlow(() => {
      fetchers.poll.data = RUN("success");
    });
    expect(screen.queryByText("syncNeeded")).toBeNull();
  });

  const SHEETS_OFFER = {
    ok: true,
    intent: "upgrade-prepare",
    answer: "needs_sheets_decision",
    challenge: { content: { v: 1 }, signature: { sigHex: "c", timestamp: 1 } },
    notice: null,
    detail: { tabs: "my-story", count: 1, collisions: [{ tab: "my-story", columns: ["note", "Note"] }] },
  };
  const SWITCH = { written: ["telar-content/spreadsheets/my-story.csv"], deleted: ["telar-content/spreadsheets/proyecto.csv"] };

  it.each([
    ["sheetsDecisionSwitchOff", "off"],
    ["sheetsDecisionKeep", "keep"],
  ])("shows the Google Sheets offer and sends the %s answer back through prepare with its challenge", async (button, answer) => {
    await renderSheetFlowPage();
    pushSheetFlow(() => {
      fetchers.upgrade.data = SHEETS_OFFER;
    });
    expect(screen.getByText("sheetsDecisionTitle")).toBeTruthy();
    expect(screen.getByText("my-story: note, Note").tagName).toBe("LI");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: button }));
    });
    expect(upgradeSubmissions()).toEqual([
      { intent: "upgrade-prepare", challenge: JSON.stringify(SHEETS_OFFER.challenge), sheets: answer, deletions: "[]" },
    ]);
  });

  it("waits on the confirmation for a site that stops reading Google Sheets, listing the files written and deleted", async () => {
    await renderSheetFlowPage();
    pushSheetFlow(() => {
      fetchers.upgrade.data = preparedWith([], [], { sheetsOff: SWITCH, readsGoogleSheetsAfter: false });
    });
    expect(upgradeSubmissions()).toEqual([]);
    expect(screen.getByText("sheetsSwitchHeading")).toBeTruthy();
    expect(screen.getByText("my-story.csv").tagName).toBe("LI");
    expect(screen.getByText("proyecto.csv").tagName).toBe("LI");
  });

  it("shows a site switched off in the upgrade no Sheets-only step, though the settings loaded before said it read Google Sheets", async () => {
    const SHEETS_STEP = { audience: "google-sheets", kind: "action", description: "Republish your Google Sheet." };
    await renderSheetFlowPage({ googleSheetsEnabled: true });
    pushSheetFlow(() => {
      fetchers.upgrade.data = { ...committedWithReport(false), manualSteps: { en: [SHEETS_STEP], es: [] }, sheetsOff: SWITCH, readsGoogleSheetsAfter: false };
    });
    pushSheetFlow(() => {
      fetchers.poll.data = RUN("success");
    });
    expect(screen.getByText("sheetsSwitchedOffDone")).toBeTruthy();
    expect(screen.queryByText(/Republish your Google Sheet/)).toBeNull();
  });

  it("shows a site that still reads Google Sheets its Sheets-only steps", async () => {
    const SHEETS_STEP = { audience: "google-sheets", kind: "action", description: "Republish your Google Sheet." };
    await renderSheetFlowPage();
    pushSheetFlow(() => {
      fetchers.upgrade.data = { ...committedWithReport(true), manualSteps: { en: [SHEETS_STEP], es: [] }, sheetsOff: null, readsGoogleSheetsAfter: true };
    });
    pushSheetFlow(() => {
      fetchers.poll.data = RUN("success");
    });
    expect(screen.getByText(/Republish your Google Sheet/)).toBeTruthy();
  });
});
