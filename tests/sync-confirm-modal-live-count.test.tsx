// @vitest-environment jsdom
/**
 * A two-way check (no base) goes straight to the review, whatever count the
 * header reads through useSiteStatus: every change is an item with no choice
 * made, so nothing of the author's is overwritten without their choosing it,
 * and no warning step stands before the list.
 *
 * @version v1.5.5-beta
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
  return <SyncConfirmModal open onClose={() => {}} />;
}

/** Opens the dialog, starts the check, and delivers the diff. */
function check(diff: FullSyncDiff = diffWithChanges) {
  const view = render(<Wired />);
  fetcherData.current = { ok: true, intent: "compute-full-sync-diff", diff };
  view.rerender(<Wired />);
  return view;
}

/** The review's item for the new object, and its Apply button. */
const item = () => screen.getByTestId("sync-item-object:new:o1");
const applyButton = () => screen.getByText("sync_modal.review.apply") as HTMLButtonElement;

describe("SyncConfirmModal on a two-way check, whatever the header's count", () => {
  beforeEach(() => {
    fetcherData.current = undefined;
    poll.current = undefined;
    estimate.current = 8;
  });

  it.each([
    ["the poll has failed (count unknown)", undefined],
    ["the poll answered without a count", {}],
    ["the live count is 0", { unpublishedCount: 0 }],
    ["the live count is 4", { unpublishedCount: 4 }],
  ] as const)("lists the change with no choice made and no warning step when %s", (_label, polled) => {
    poll.current = polled as typeof poll.current;
    check();
    expect(screen.queryByText(/sync_modal\.(conflict_warning|sync_anyway|publish_first)/)).toBeNull();
    expect(item()).toBeTruthy();
    expect((screen.getAllByRole("radio") as HTMLInputElement[]).some((r) => r.checked)).toBe(false);
    expect(applyButton().disabled).toBe(true);
  });

  it("enables Apply once the change has a choice", () => {
    poll.current = { unpublishedCount: 4 };
    check();
    fireEvent.click(screen.getByRole("radio", { name: "sync_modal.review.add" }));
    expect(applyButton().disabled).toBe(false);
  });

  it("shows nothing to sync when the check found no changes", () => {
    const none = {
      ...diffWithChanges,
      objects: { newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [] },
    } as unknown as FullSyncDiff;
    check(none);
    expect(screen.getByText("sync_modal.no_changes")).toBeTruthy();
    expect(screen.queryByTestId(/^sync-item-/)).toBeNull();
  });
});
