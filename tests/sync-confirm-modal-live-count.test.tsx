// @vitest-environment jsdom
/**
 * SyncConfirmModal chooses its conflict-warning step from the count the header
 * reads through useSiteStatus: the live count when the poll gave one,
 * otherwise the loader's estimate, which can over-warn and never skips the
 * warning (it misses a local deletion, so an unknown count always warns). The number is stated only when it is the live count.
 *
  * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import type { FullSyncDiff } from "~/lib/sync.server";

const fetcherData: { current: unknown } = { current: undefined };
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useFetcher: () => ({ submit: vi.fn(), state: "idle", data: fetcherData.current }),
    useNavigate: () => vi.fn(),
    useFetchers: () => [],
    useRouteLoaderData: () => ({ activeProjectId: 7, unpublishedCount: estimate.current }),
  };
});
const poll: { current: { unpublishedCount?: number } | undefined } = { current: undefined };
const estimate = { current: 8 };
vi.mock("~/hooks/use-github-status-poll", () => ({ useGithubStatusPoll: () => poll.current }));
vi.mock("~/hooks/use-collaboration", () => ({ useCollaborationContext: () => ({ isPublishing: false, isBuilding: false }) }));
vi.mock("~/hooks/use-persistence-halt", () => ({ usePersistenceHalt: () => ({ halted: false }) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) => (opts?.count === undefined ? key : `${key}:${opts.count}`),
  }),
}));

import { useSiteStatus } from "~/components/features/site-status/useSiteStatus";
import { SyncConfirmModal } from "~/components/features/dashboard/SyncConfirmModal";

const diffWithChanges = {
  objects: {
    newObjects: [{ object_id: "o1" }],
    changedObjects: [],
    missingObjects: [],
    unregisteredFiles: [],
  },
  stories: { newStories: [], changedStories: [], missingStories: [] },
  config: { changedFields: [], versionChange: null },
  glossary: { added: [], changed: [], removed: [] },
  hasConflicts: false,
  classification: "two-way",
  suppressedEditorOnly: 0,
  unreadableFiles: [],
  projectId: 7,
  baseSha: null,
  headSha: "0123456789abcdef0123456789abcdef01234567",
} as unknown as FullSyncDiff;

/** The modal wired the way the objects page wires it: one useSiteStatus read. */
function Wired() {
  const { count, countKnown } = useSiteStatus();
  return <SyncConfirmModal open unpublishedCount={count} countKnown={countKnown} onClose={() => {}} />;
}

/** Opens the dialog, starts the check, and delivers the diff. */
function check(diff: FullSyncDiff = diffWithChanges) {
  const view = render(<Wired />);
  fireEvent.click(screen.getByText("sync_modal.check_changes"));
  fetcherData.current = { ok: true, intent: "compute-full-sync-diff", diff };
  view.rerender(<Wired />);
  return view;
}

const warning = /sync_modal\.conflict_warning/;

describe("SyncConfirmModal conflict warning reads the header's count", () => {
  beforeEach(() => {
    fetcherData.current = undefined;
    poll.current = undefined;
    estimate.current = 8;
  });

  it("shows the warning from the estimate when the poll has failed (count unknown)", () => {
    poll.current = undefined;
    check();
    expect(screen.getByText("sync_modal.conflict_warning_unknown")).toBeTruthy();
    expect(screen.queryByText("sync_modal.computing")).toBeNull();
  });

  it("shows the warning from the estimate when the poll answered without a count", () => {
    poll.current = {};
    check();
    expect(screen.getByText("sync_modal.conflict_warning_unknown")).toBeTruthy();
  });

  it("shows no warning when the live count is 0 although the estimate is 8", () => {
    poll.current = { unpublishedCount: 0 };
    check();
    expect(screen.queryByText(warning)).toBeNull();
    expect(screen.getByText("sync_modal.apply_sync")).toBeTruthy();
  });

  it("states the live count in the warning when it is 4", () => {
    poll.current = { unpublishedCount: 4 };
    check();
    expect(screen.getByText("sync_modal.conflict_warning:4")).toBeTruthy();
  });

  it("withdraws a warning chosen from the estimate when the live count lands as 0", () => {
    const view = check();
    expect(screen.getByText("sync_modal.conflict_warning_unknown")).toBeTruthy();
    poll.current = { unpublishedCount: 0 };
    view.rerender(<Wired />);
    expect(screen.queryByText(warning)).toBeNull();
    expect(screen.getByText("sync_modal.apply_sync")).toBeTruthy();
  });

  it("states the number once the live count lands while the warning is shown", () => {
    const view = check();
    poll.current = { unpublishedCount: 4 };
    view.rerender(<Wired />);
    expect(screen.getByText("sync_modal.conflict_warning:4")).toBeTruthy();
  });

  it("warns without a number when the estimate is 0 and the count is unknown (a local deletion is not in the estimate)", () => {
    estimate.current = 0;
    check();
    expect(screen.getByText("sync_modal.conflict_warning_unknown")).toBeTruthy();
    expect(screen.queryByText("sync_modal.apply_sync")).toBeNull();
  });

  it("states the number when the live count lands after a warning chosen from an estimate of 0", () => {
    estimate.current = 0;
    const view = check();
    poll.current = { unpublishedCount: 4 };
    view.rerender(<Wired />);
    expect(screen.getByText("sync_modal.conflict_warning:4")).toBeTruthy();
  });

  it("does not warn when the check found no changes", () => {
    const none = {
      ...diffWithChanges,
      objects: { newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [] },
    } as unknown as FullSyncDiff;
    check(none);
    expect(screen.queryByText(warning)).toBeNull();
  });
});
