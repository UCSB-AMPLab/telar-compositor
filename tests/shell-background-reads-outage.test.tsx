// @vitest-environment jsdom
/**
 * During an outage the shell's background reads leave the page open.
 *
 * The real status pill and collaboration panel run in a memory router, inside
 * an error boundary, beside an unsaved in-place field. The GitHub-status poll
 * reads through a stubbed `fetch`; the panel reads the record through the
 * Contributions route's real `clientLoader`, and a route answers the status
 * endpoint for the fetcher reads the poll used before. Once every read fails,
 * the pill's state, the panel's record and the field's draft stay on screen
 * through the poll's beat, the panel's beat and a focus; when the reads
 * succeed again, both refresh.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { PersistenceHaltResult } from "~/hooks/use-persistence-halt";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { n?: number }) => (opts?.n !== undefined ? `${key} ${opts.n}` : key),
    i18n: { language: "en" },
  }),
}));
vi.mock("~/lib/db.server", () => ({ getDb: () => ({}) }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));

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

import { clientLoader } from "~/routes/_app.contributions";
import { PageSiteProvider } from "~/lib/page-site";
import { CollaborationContext, type CollaborationContextValue } from "~/hooks/use-collaboration";
import { SiteStatusPill } from "~/components/features/site-status/SiteStatusPill";
import { CollaborationSidebar } from "~/components/features/collaboration/CollaborationSidebar";

const CONTEXT = {
  ydoc: null,
  remoteCollaborators: [],
  isPublishing: false,
  isBuilding: false,
  isUpgrading: false,
  publishSha: null,
  publishCommitUrl: null,
} as unknown as CollaborationContextValue;

const KINDS = { added: 1, edited: 2, words: 3 };

function record(displayName: string) {
  return {
    projectTitle: "A site",
    hasWordsAndTime: true,
    currentUserId: 1,
    projectId: 1,
    members: [
      {
        userId: 1,
        displayName,
        color: "#E47A6F",
        role: "convenor",
        former: false,
        kinds: { objects: KINDS, steps: KINDS, glossary: KINDS, pages: KINDS, panels: KINDS },
        editingSeconds: 60,
        writingSeconds: 30,
      },
    ],
  };
}

function ghStatus(unpublishedCount: number) {
  return { repoUnavailable: false, headDiverged: false, needsUpgrade: false, unpublishedCount };
}

const world = { outage: false, count: 3, name: "Ana Seeded", statusReads: 0, recordReads: 0 };
const fetchMock = vi.fn();

beforeEach(() => {
  world.outage = false;
  world.count = 3;
  world.name = "Ana Seeded";
  world.statusReads = 0;
  world.recordReads = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => {
    world.statusReads += 1;
    if (world.outage) throw new TypeError("Failed to fetch");
    return { ok: true, redirected: false, status: 200, json: async () => ghStatus(world.count) };
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setInterval", "clearInterval"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Shell() {
  return (
    <CollaborationContext.Provider value={CONTEXT}>
      <PageSiteProvider activeProjectId={1}>
        <SiteStatusPill />
        <textarea aria-label="caption" defaultValue="" />
        <CollaborationSidebar open onClose={() => {}} isConvenor={false} members={[]} seats={{ used: 1, limit: 6 }} />
      </PageSiteProvider>
    </CollaborationContext.Provider>
  );
}

function mount() {
  const serverRead = async () => {
    world.recordReads += 1;
    if (world.outage) throw new TypeError("Failed to fetch");
    return record(world.name);
  };
  const router = createMemoryRouter([
    { path: "/", Component: Shell, ErrorBoundary: () => <p>the error card</p> },
    {
      path: "/contributions",
      loader: (args) => clientLoader({ ...args, serverLoader: serverRead } as never),
    },
    {
      // The status endpoint as a route, for a fetcher read of it.
      path: "/api/site-status",
      loader: () => {
        world.statusReads += 1;
        if (world.outage) throw new TypeError("Failed to fetch");
        return ghStatus(world.count);
      },
    },
  ]);
  render(<RouterProvider router={router} />);
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("the shell during an outage", () => {
  it("keeps the pill's state, the panel's record and an unsaved field, and refreshes when the reads succeed", async () => {
    mount();
    await screen.findByText("status.unpublished_other 3");
    await screen.findByText("Ana Seeded");
    fireEvent.change(screen.getByLabelText("caption"), { target: { value: "an unsaved caption" } });

    world.outage = true;
    const before = { status: world.statusReads, record: world.recordReads };
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await advance(30_000);
    await advance(15_000);
    expect(screen.queryByText("the error card")).toBeNull();
    expect(world.statusReads).toBeGreaterThan(before.status);
    expect(world.recordReads).toBeGreaterThan(before.record);
    expect(screen.getByText("status.unpublished_other 3")).toBeTruthy();
    expect(screen.getByText("Ana Seeded")).toBeTruthy();
    expect((screen.getByLabelText("caption") as HTMLTextAreaElement).value).toBe("an unsaved caption");

    world.outage = false;
    world.count = 1;
    world.name = "Ana Recovered";
    await advance(45_000);
    await waitFor(() => expect(screen.getByText("status.unpublished_one 1")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Ana Recovered")).toBeTruthy());
    expect((screen.getByLabelText("caption") as HTMLTextAreaElement).value).toBe("an unsaved caption");
  });
});
