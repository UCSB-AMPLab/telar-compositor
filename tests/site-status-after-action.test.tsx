// @vitest-environment jsdom
/**
 * The pill's count refreshes after a publish completes.
 *
 * The GitHub-status poll is a background read, outside the router, so the
 * router's revalidation after an action does not reach it; it reads again
 * itself when a submission completes. Here the real pill and `useSiteStatus`
 * run in a memory router with `fetch` stubbed: the poll's first answer counts
 * three unpublished changes, a publish submission completes, and the next
 * answer, read because it completed, puts the pill in sync. An open popover's
 * body is read again after a submission in the same way.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useFetcher } from "react-router";
import { PageSiteProvider } from "~/lib/page-site";
import type { PersistenceHaltResult } from "~/hooks/use-persistence-halt";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { n?: number }) => (opts?.n !== undefined ? `${key} ${opts.n}` : key),
    i18n: { language: "en" },
  }),
}));

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    isPublishing: false,
    isBuilding: false,
    publishSha: null,
    publishCommitUrl: null,
  }),
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
vi.mock("~/hooks/use-persistence-halt", () => ({
  usePersistenceHalt: () => NO_HALT,
}));

import { SiteStatusPill } from "~/components/features/site-status/SiteStatusPill";

function status(unpublishedCount: number) {
  return {
    ok: true,
    redirected: false,
    status: 200,
    json: async () => ({ repoUnavailable: false, headDiverged: false, needsUpgrade: false, unpublishedCount }),
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function Publisher() {
  const publish = useFetcher();
  return (
    <button type="button" onClick={() => publish.submit({ intent: "publish" }, { method: "post", action: "/publish" })}>
      publish
    </button>
  );
}

describe("the pill after a publish", () => {
  it("reads the status again when the publish submission completes, and shows its count", async () => {
    let published = false;
    fetchMock.mockImplementation(async () => status(published ? 0 : 3));
    const router = createMemoryRouter([
      {
        path: "/",
        Component: () => (
          <PageSiteProvider activeProjectId={1}>
            <SiteStatusPill />
            <Publisher />
          </PageSiteProvider>
        ),
      },
      {
        path: "/publish",
        action: async () => {
          published = true;
          return { ok: true, intent: "publish" };
        },
      },
    ]);
    render(<RouterProvider router={router} />);
    await screen.findByText("status.unpublished_other 3");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "publish" }));
    });
    await waitFor(() => expect(screen.getByText("status.in_sync")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/site-status?payload=gh-status");

    // An open popover's body is read again after the next submission too.
    const payloadReads = () => fetchMock.mock.calls.filter(([url]) => url === "/api/site-status?payload=in-sync").length;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /status\.in_sync/ }));
    });
    expect(payloadReads()).toBe(1);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "publish" }));
    });
    await waitFor(() => expect(payloadReads()).toBe(2));
  });
});
