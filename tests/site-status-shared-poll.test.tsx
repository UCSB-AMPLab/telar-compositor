// @vitest-environment jsdom
/**
 * The header chip and every other useSiteStatus() consumer share one GitHub
 * status poll. The real provider and hook run in a memory router with
 * `fetch` stubbed: the pill and a second consumer mount together, the status
 * endpoint is read once, and both show the same count.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
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
