// @vitest-environment jsdom
/**
 * The header chip and every other useSiteStatus() consumer share one GitHub
 * status poll. The real provider and hook run in a memory router with
 * `fetch` stubbed: the pill and a second consumer mount together, the status
 * endpoint is read once, and both show the same count. Try again's forced
 * answer stands until a poll read started after it answers.
 *
 * @version v1.5.5-beta
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { PageSiteProvider } from "~/lib/page-site";
import type { PersistenceHaltResult } from "~/hooks/use-persistence-halt";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { n?: number }) => (opts?.n !== undefined ? `${key} ${opts.n}` : key),
    i18n: { language: "en" },
  }),
}));
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({ isPublishing: false, isBuilding: false, publishSha: null, publishCommitUrl: null }),
}));
const NO_HALT: PersistenceHaltResult = {
  halted: false,
  lastKnownHalt: null,
  stateUnreadable: false,
  confirmedGeneration: null,
  lastReadHalted: null,
  haltedAgain: false,
  outcome: null,
  submitting: false,
  checkAgain: vi.fn(),
  restore: vi.fn(),
  dismissOutcome: vi.fn(),
};
vi.mock("~/hooks/use-persistence-halt", () => ({ usePersistenceHalt: () => NO_HALT }));

import { SiteStatusPill } from "~/components/features/site-status/SiteStatusPill";
import { SiteStatusProvider } from "~/components/features/site-status/SiteStatusProvider";
import { useSiteStatus } from "~/components/features/site-status/useSiteStatus";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ({
    ok: true,
    redirected: false,
    status: 200,
    json: async () => ({ repoUnavailable: false, headDiverged: false, needsUpgrade: false, unpublishedCount: 4 }),
  }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function Dialog() {
  const { count, countKnown } = useSiteStatus();
  return <div data-testid="dialog-count">{`${count}/${countKnown}`}</div>;
}

describe("one status poll per page", () => {
  it("reads the status endpoint once for the pill and a second consumer, and both show the same count", async () => {
    const router = createMemoryRouter([
      {
        path: "/",
        Component: () => (
          <PageSiteProvider activeProjectId={1}>
            <SiteStatusProvider>
              <SiteStatusPill />
              <Dialog />
            </SiteStatusProvider>
          </PageSiteProvider>
        ),
      },
    ]);
    render(<RouterProvider router={router} />);
    await screen.findByText("status.unpublished_other 4");
    expect((await screen.findByTestId("dialog-count")).textContent).toBe("4/true");
    const reads = fetchMock.mock.calls.filter(([url]) => url === "/api/site-status?payload=gh-status");
    expect(reads).toHaveLength(1);
  });
});

describe("Try again forces a check and the pill follows its answer", () => {
  const FORCED = "/api/site-status?payload=gh-status&force=1";
  function answer(body: Record<string, unknown>) {
    return { ok: true, redirected: false, status: 200, json: async () => body };
  }
  const base = { repoUnavailable: false, headDiverged: false, firstPublish: false, needsUpgrade: false, unpublishedCount: 0 };

  function mountPill() {
    const router = createMemoryRouter([
      {
        path: "/",
        Component: () => (
          <PageSiteProvider activeProjectId={1}>
            <SiteStatusProvider>
              <SiteStatusPill />
            </SiteStatusProvider>
          </PageSiteProvider>
        ),
      },
    ]);
    render(<RouterProvider router={router} />);
  }

  it("asks the endpoint with force=1 and shows the answer, though the poll still says the check failed", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      answer(url === FORCED ? { ...base, checkFailed: false } : { ...base, checkFailed: true }),
    );
    mountPill();
    const caption = await screen.findByText("status.check_failed");
    fireEvent.click(caption);
    fireEvent.click(await screen.findByRole("button", { name: "check_failed.try_again" }));
    await waitFor(() => expect(screen.queryByText("status.check_failed")).toBeNull());
    expect(screen.getByText("status.in_sync")).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([url]) => url === FORCED)).toHaveLength(1);
  });

  it("keeps the failed state when the forced check cannot be made", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === FORCED) throw new Error("offline");
      return answer({ ...base, checkFailed: true });
    });
    mountPill();
    fireEvent.click(await screen.findByText("status.check_failed"));
    fireEvent.click(await screen.findByRole("button", { name: "check_failed.try_again" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === FORCED)).toBe(true));
    expect(screen.getAllByText("status.check_failed").length).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: "check_failed.try_again" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps the forced answer when a poll read already in flight answers after it, until a later read answers", async () => {
    const POLL = "/api/site-status?payload=gh-status";
    let releaseInFlight: (body: Record<string, unknown>) => void = () => {};
    let polls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === FORCED) return answer({ ...base, checkFailed: false });
      if (url !== POLL) return answer(base);
      polls += 1;
      if (polls === 2) return new Promise((resolve) => { releaseInFlight = (body) => resolve(answer(body)); });
      if (polls >= 3) return answer({ ...base, checkFailed: false, unpublishedCount: 2 });
      return answer({ ...base, checkFailed: true });
    });
    mountPill();
    fireEvent.click(await screen.findByText("status.check_failed"));
    // A poll read starts, and is still in flight when Try again answers.
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(polls).toBe(2));
    fireEvent.click(await screen.findByRole("button", { name: "check_failed.try_again" }));
    await screen.findByText("status.in_sync");
    // The read in flight carries the status from before the check.
    releaseInFlight({ ...base, checkFailed: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("status.check_failed")).toBeNull();
    expect(screen.getByText("status.in_sync")).toBeTruthy();
    // A read started after the forced answer replaces it.
    fireEvent(window, new Event("focus"));
    await screen.findByText("status.unpublished_other 2");
  });
});
