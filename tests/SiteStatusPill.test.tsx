// @vitest-environment jsdom
/**
 * Tests for `SiteStatusPill`, the header pill that shows the site's single
 * active status. Each of the ten states has its own background, ink and dot
 * token pair and its own caption. The unpublished caption carries the count
 * the loader supplies and shows no number while the live count is not yet
 * known. Only the publishing dot pulses. The action label (Publish, Review,
 * Run upgrade, Restore) appears only for the states and roles that can act on
 * it, and the transient "Saving…" overlay leaves the base state's colors
 * unchanged. Below the sm breakpoint the caption collapses to the dot and stays
 * readable by assistive technology.
 *
 * Clicking the pill opens the popover for the active state inside the
 * popover shell. A popover reads its payload when it opens, not on mount, and
 * never shows the answer read for another state. A displayed outcome is
 * dismissed through every close path: the pill, Escape and the outside-click
 * overlay. The halted popover stays open through a restore and when the pill
 * re-derives to another state.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { createContext, useContext } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { SiteStatusResult, SiteStatusState } from "~/components/features/site-status/useSiteStatus";

// --- useSiteStatus is mocked so each test drives one state + saving flag. ---
const checkAgainSpy = vi.fn();
const dismissSpy = vi.fn();

const NO_HALT: SiteStatusResult["persistence"] = {
  halted: false,
  lastKnownHalt: null,
  stateUnreadable: false,
  confirmedGeneration: null,
  lastReadHalted: null,
  haltedAgain: false,
  outcome: null,
  submitting: false,
  checkAgain: checkAgainSpy,
  restore: vi.fn(),
  dismissOutcome: dismissSpy,
};

const recheckSpy = vi.fn(async () => {});

const siteStatusValue: { current: SiteStatusResult } = {
  current: {
    state: "in-sync",
    saving: false,
    count: 0,
    countKnown: true,
    latestTag: "v1.3.0",
    userRole: "convenor",
    needsUpgrade: false,
    ownRepoAccess: null,
    persistence: NO_HALT,
    recheck: recheckSpy,
    rechecking: false,
  },
};
vi.mock("~/components/features/site-status/useSiteStatus", () => ({
  useSiteStatus: () => siteStatusValue.current,
}));

// --- The payload read goes through `fetch`: capture it to assert it fires on open. ---
const fetchSpy = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>(() => {}));
vi.stubGlobal("fetch", fetchSpy);
const submitSpy = vi.fn();
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useFetcher: () => ({ load: vi.fn(), submit: submitSpy, state: "idle", data: undefined }),
    useRouteLoaderData: () => ({ pagesUrl: "https://example.org/site", latestTelarTag: "v1.3.0", userRole: "convenor", repoFullName: "owner/repo" }),
  };
});

// --- Awareness: pill lifts publish SHA/commitUrl from the collaboration ctx. ---
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    connectionStatus: "connected",
    isPublishing: siteStatusValue.current.state === "publishing",
    isUpgrading: false,
    publishSha: "abc1234",
    publishCommitUrl: "https://github.com/o/r/commit/abc1234",
  }),
}));

// --- i18n: identity-ish map with interpolation for the strings the pill uses. ---
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        "status.in_sync": "In sync",
        "status.unpublished": "Unpublished changes",
        "status.unpublished_one": "{{n}} unpublished change",
        "status.unpublished_other": "{{n}} unpublished changes",
        "status.publish_cta": "Publish",
        "status.out_of_sync": "Changes on GitHub",
        "status.first_publish": "Not yet published from the Compositor",
        "status.check_failed": "Couldn't check GitHub",
        "status.review_cta": "Review",
        "status.publishing": "Publishing…",
        "status.upgrade": "Telar {{version}} available",
        "status.upgrade_cta": "Run upgrade",
        "status.saving": "Saving…",
        "status.repo_unavailable": "Repo unavailable",
        "status.halted": "Saving stopped",
        "status.halted_action": "Restore",
      };
      let out = map[key] ?? key;
      if (opts) {
        for (const [k, v] of Object.entries(opts)) {
          out = out.replace(`{{${k}}}`, String(v));
        }
      }
      return out;
    },
  }),
}));

// Stub the five popovers so we can assert which one opens by a stable testid,
// without dragging their full payload-rendering into this unit's surface.
vi.mock("~/components/features/site-status/popovers/InSyncPopover", () => ({
  InSyncPopover: (props: { payload: unknown }) => (
    <div data-testid="popover-in-sync" data-payload={JSON.stringify(props.payload)} />
  ),
}));
vi.mock("~/components/features/site-status/popovers/UnpublishedPopover", () => ({
  UnpublishedPopover: (props: { summary: unknown }) => (
    <div data-testid="popover-unpublished" data-summary={JSON.stringify(props.summary)} />
  ),
}));
vi.mock("~/components/features/site-status/popovers/OutOfSyncPopover", () => ({
  OutOfSyncPopover: () => <div data-testid="popover-out-of-sync" />,
}));
vi.mock("~/components/features/site-status/popovers/CheckFailedPopover", () => ({
  CheckFailedPopover: (props: { onTryAgain: () => void; busy?: boolean }) => (
    <button data-testid="popover-check-failed" data-busy={String(!!props.busy)} onClick={props.onTryAgain} />
  ),
}));
vi.mock("~/components/features/site-status/popovers/FirstPublishPopover", () => ({
  FirstPublishPopover: () => <div data-testid="popover-first-publish" />,
}));
vi.mock("~/components/features/site-status/popovers/PublishingPopover", () => ({
  PublishingPopover: () => <div data-testid="popover-publishing" />,
}));
vi.mock("~/components/features/site-status/popovers/UpgradePopover", () => ({
  UpgradePopover: () => <div data-testid="popover-upgrade" />,
}));
vi.mock("~/components/features/site-status/popovers/RepoInvitationPopover", () => ({
  RepoInvitationPopover: (props: { access: { stage: string } }) => (
    <div data-testid="popover-repo-invitation" data-stage={props.access.stage} />
  ),
}));
vi.mock("~/components/features/site-status/popovers/RepoUnavailablePopover", () => ({
  RepoUnavailablePopover: () => <div data-testid="popover-repo-unavailable" />,
}));
// The halted stub echoes the three props whose provenance is the point of the
// mount rule; what they render is pinned in the popover's own test.
vi.mock("~/components/features/site-status/popovers/PersistenceHaltedPopover", () => ({
  PersistenceHaltedPopover: (props: {
    outcome: { kind: string } | null;
    haltedAgain: boolean;
    lastReadHalted: boolean | null;
  }) => (
    <div
      data-testid="popover-persistence-halted"
      data-outcome={props.outcome?.kind ?? ""}
      data-halted-again={String(props.haltedAgain)}
      data-last-read-halted={String(props.lastReadHalted)}
    />
  ),
}));

import { SiteStatusPill } from "~/components/features/site-status/SiteStatusPill";

function setState(partial: Partial<SiteStatusResult>) {
  siteStatusValue.current = { ...siteStatusValue.current, ...partial };
}

// The route re-renders with each new value, as the pill does when the state it
// derives changes.
const Rerender = createContext(0);

function renderPill() {
  const router = createMemoryRouter([
    {
      path: "/",
      Component: () => {
        useContext(Rerender);
        return <SiteStatusPill />;
      },
    },
  ]);
  let n = 0;
  const view = render(
    <Rerender.Provider value={n}>
      <RouterProvider router={router} />
    </Rerender.Provider>,
  );
  return {
    ...view,
    rerender: () =>
      view.rerender(
        <Rerender.Provider value={++n}>
          <RouterProvider router={router} />
        </Rerender.Provider>,
      ),
  };
}

/** The pill button is the element carrying the per-state bg token. */
function pillButton(container: HTMLElement): HTMLElement {
  const btn = container.querySelector("button");
  if (!btn) throw new Error("pill button not found");
  return btn as HTMLElement;
}

const TOKEN_PAIRS: Record<SiteStatusState, { bg: string; ink: string; dot: string }> = {
  "in-sync": { bg: "bg-chilca-pale", ink: "text-chilca-deep", dot: "bg-chilca" },
  unpublished: { bg: "bg-cream-dark", ink: "text-terracotta", dot: "bg-terracotta" },
  "out-of-sync": { bg: "bg-qolle-pale", ink: "text-qolle-deep", dot: "bg-qolle" },
  publishing: { bg: "bg-anil-pale", ink: "text-anil-ink", dot: "bg-anil-deep" },
  upgrade: { bg: "bg-terracotta-pale", ink: "text-terracotta", dot: "bg-terracotta" },
  "repo-unavailable": { bg: "bg-terracotta-pale", ink: "text-terracotta", dot: "bg-terracotta" },
  "repo-invitation": { bg: "bg-terracotta-pale", ink: "text-terracotta", dot: "bg-terracotta" },
  "check-failed": { bg: "bg-cream-dark", ink: "text-charcoal", dot: "bg-fg-muted" },
  "first-publish": { bg: "bg-anil-pale", ink: "text-anil-ink", dot: "bg-anil-deep" },
  "persistence-halted": { bg: "bg-terracotta-pale", ink: "text-terracotta", dot: "bg-terracotta" },
};

describe("SiteStatusPill — per-state token pairs", () => {
  beforeEach(() => {
    fetchSpy.mockClear();
    submitSpy.mockClear();
    setState({ state: "in-sync", saving: false, count: 0, needsUpgrade: false });
  });

  (Object.keys(TOKEN_PAIRS) as SiteStatusState[]).forEach((state) => {
    it(`state='${state}' renders its locked bg/ink pair`, () => {
      setState({ state, count: state === "unpublished" ? 3 : 0 });
      const { container } = renderPill();
      const btn = pillButton(container);
      const pair = TOKEN_PAIRS[state];
      expect(btn.className).toContain(pair.bg);
      expect(btn.className).toContain(pair.ink);
      // The dot takes its per-state colour.
      const dot = container.querySelector(`.${pair.dot}`);
      expect(dot).not.toBeNull();
    });
  });
});

describe("SiteStatusPill — the three GitHub states", () => {
  beforeEach(() => {
    fetchSpy.mockClear();
    recheckSpy.mockClear();
    setState({ state: "in-sync", saving: false, count: 0, rechecking: false });
  });

  it("amber reads 'Changes on GitHub' with no count and keeps its Review action", () => {
    setState({ state: "out-of-sync", count: 7 });
    const { container } = renderPill();
    expect(container.textContent).toContain("Changes on GitHub");
    expect(container.textContent).toContain("Review →");
    expect(container.textContent).not.toMatch(/\d/);
  });

  it("blue reads 'Not yet published from the Compositor', has no action and no payload fetch", () => {
    setState({ state: "first-publish", count: 9 });
    const { container } = renderPill();
    expect(container.textContent).toContain("Not yet published from the Compositor");
    expect(container.textContent).not.toContain("→");
    fireEvent.click(pillButton(container));
    expect(screen.getByTestId("popover-first-publish")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("grey reads 'Couldn't check GitHub', has no action and no payload fetch", () => {
    setState({ state: "check-failed" });
    const { container } = renderPill();
    expect(container.textContent).toContain("Couldn't check GitHub");
    expect(container.textContent).not.toContain("→");
    fireEvent.click(pillButton(container));
    expect(screen.getByTestId("popover-check-failed")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Try again in the grey popover asks for a recheck, and says when one is running", () => {
    setState({ state: "check-failed", rechecking: true });
    const { container } = renderPill();
    fireEvent.click(pillButton(container));
    const button = screen.getByTestId("popover-check-failed");
    expect(button.getAttribute("data-busy")).toBe("true");
    fireEvent.click(button);
    expect(recheckSpy).toHaveBeenCalledTimes(1);
  });
});

describe("SiteStatusPill — pulse is publishing-only", () => {
  beforeEach(() => setState({ state: "in-sync", saving: false }));

  it("publishing dot carries site-status-pulse", () => {
    setState({ state: "publishing" });
    const { container } = renderPill();
    expect(container.querySelector(".site-status-pulse")).not.toBeNull();
  });

  ([
    "in-sync",
    "unpublished",
    "out-of-sync",
    "upgrade",
    "repo-unavailable",
    "repo-invitation",
    "check-failed",
    "first-publish",
    "persistence-halted",
  ] as SiteStatusState[]).forEach((state) => {
    it(`state='${state}' does NOT pulse`, () => {
      setState({ state, count: state === "unpublished" ? 2 : 0 });
      const { container } = renderPill();
      expect(container.querySelector(".site-status-pulse")).toBeNull();
    });
  });
});

describe("SiteStatusPill — caption count comes from the loader", () => {
  // useSiteStatus reads unpublishedCount off the _app loader (count). The pill's
  // unpublished caption must reflect that number so caption == manifest spectrum.
  beforeEach(() => setState({ state: "unpublished", saving: false }));

  it("pluralised caption shows the loader-supplied count for many changes", () => {
    setState({ count: 5 });
    const { container } = renderPill();
    expect(container.textContent).toContain("5 unpublished changes");
  });

  it("singular caption for a count of 1", () => {
    setState({ count: 1 });
    const { container } = renderPill();
    expect(container.textContent).toContain("1 unpublished change");
  });
});

describe("SiteStatusPill — no number until the live count answers", () => {
  beforeEach(() => setState({ state: "unpublished", saving: false }));

  it("shows the count-less caption and never the stand-in while the count is unknown", () => {
    setState({ count: 8, countKnown: false });
    const { container } = renderPill();
    expect(container.textContent).toContain("Unpublished changes");
    expect(container.textContent).not.toMatch(/\d/);
  });

  it("shows the live number once the count is known", () => {
    setState({ count: 4, countKnown: true });
    const { container } = renderPill();
    expect(container.textContent).toContain("4 unpublished changes");
    expect(container.textContent).not.toContain("8");
  });
});

describe("SiteStatusPill — per-state action label", () => {
  beforeEach(() => setState({ state: "in-sync", saving: false, count: 0 }));

  it("unpublished shows the Publish → action divider", () => {
    setState({ state: "unpublished", count: 4 });
    const { container } = renderPill();
    // The action label node carries the 700-weight divider styling.
    expect(container.textContent).toContain("Publish →");
  });

  it("out-of-sync shows the Review → action divider", () => {
    setState({ state: "out-of-sync" });
    const { container } = renderPill();
    expect(container.textContent).toContain("Review →");
  });

  it.each([["a collaborator", "collaborator"], ["an instructor", "instructor"]] as const)("out-of-sync shows no Review → action for %s, who cannot apply a review", (_who, userRole) => {
    setState({ state: "out-of-sync", userRole });
    const { container } = renderPill();
    expect(container.textContent).toContain("Changes on GitHub");
    expect(container.textContent).not.toContain("Review →");
    setState({ userRole: "convenor" });
  });

  it("upgrade shows the Run upgrade → action divider for a publishing role", () => {
    setState({ state: "upgrade", needsUpgrade: true, userRole: "convenor" });
    const { container } = renderPill();
    expect(container.textContent).toContain("Run upgrade →");
  });

  it("upgrade shows no action divider for a caller who cannot upgrade", () => {
    setState({ state: "upgrade", needsUpgrade: true, userRole: null });
    const { container } = renderPill();
    expect(container.textContent).not.toContain("→");
  });

  it("in-sync renders no action label", () => {
    setState({ state: "in-sync" });
    const { container } = renderPill();
    expect(container.textContent).not.toContain("→");
  });

  it("publishing renders no action label", () => {
    setState({ state: "publishing" });
    const { container } = renderPill();
    expect(container.textContent).not.toContain("→");
  });
});

describe("SiteStatusPill — Saving overlay", () => {
  it("saving=true renders Saving… without changing the base-state bg", () => {
    setState({ state: "unpublished", count: 2, saving: true });
    const { container } = renderPill();
    expect(screen.getByText("Saving…")).toBeTruthy();
    // Base-state bg unchanged (still the unpublished pill colour).
    expect(pillButton(container).className).toContain("bg-cream-dark");
  });

  it("saving=false renders no Saving… text, base bg unchanged", () => {
    setState({ state: "unpublished", count: 2, saving: false });
    const { container } = renderPill();
    expect(screen.queryByText("Saving…")).toBeNull();
    expect(pillButton(container).className).toContain("bg-cream-dark");
  });
});

describe("SiteStatusPill — click opens the matching popover lazily", () => {
  beforeEach(() => {
    fetchSpy.mockClear();
    setState({ state: "in-sync", saving: false, count: 0 });
  });

  it("does NOT fetch the payload on mount", () => {
    setState({ state: "unpublished", count: 3 });
    renderPill();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("clicking opens the in-sync popover and fetches its payload", () => {
    setState({ state: "in-sync" });
    const { container } = renderPill();
    fireEvent.click(pillButton(container));
    expect(screen.getByTestId("popover-in-sync")).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalled();
    expect(fetchSpy.mock.calls[0][0]).toContain("payload=in-sync");
  });

  it("clicking opens the unpublished popover and fetches its payload", () => {
    setState({ state: "unpublished", count: 3 });
    const { container } = renderPill();
    fireEvent.click(pillButton(container));
    expect(screen.getByTestId("popover-unpublished")).toBeTruthy();
    expect(fetchSpy.mock.calls[0][0]).toContain("payload=unpublished");
  });

  it("clicking opens the out-of-sync popover WITHOUT a payload fetch (it shows no counts)", () => {
    setState({ state: "out-of-sync" });
    const { container } = renderPill();
    fireEvent.click(pillButton(container));
    expect(screen.getByTestId("popover-out-of-sync")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("clicking opens the publishing popover WITHOUT a payload fetch (driven by awareness)", () => {
    setState({ state: "publishing" });
    const { container } = renderPill();
    fireEvent.click(pillButton(container));
    expect(screen.getByTestId("popover-publishing")).toBeTruthy();
    // publishing has no api.site-status payload — it polls via awareness SHA.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("clicking opens the upgrade popover WITHOUT a payload fetch", () => {
    setState({ state: "upgrade", needsUpgrade: true });
    const { container } = renderPill();
    fireEvent.click(pillButton(container));
    expect(screen.getByTestId("popover-upgrade")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never hands one payload's answer to another state's popover", async () => {
    fetchSpy.mockImplementationOnce(async () =>
      ({ ok: true, redirected: false, status: 200, json: async () => ({ marker: "in-sync body" }) }) as Response,
    );
    setState({ state: "in-sync" });
    const { container } = renderPill();
    fireEvent.click(pillButton(container));
    await waitFor(() =>
      expect(screen.getByTestId("popover-in-sync").dataset.payload).toContain("in-sync body"),
    );
    fireEvent.click(pillButton(container));

    // The unpublished read never answers; the popover has only its empty shape.
    setState({ state: "unpublished", count: 3 });
    fireEvent.click(pillButton(container));
    expect(fetchSpy.mock.calls.at(-1)?.[0]).toContain("payload=unpublished");
    const summary = screen.getByTestId("popover-unpublished").dataset.summary ?? "";
    expect(summary).not.toContain("in-sync body");
    expect(JSON.parse(summary)).toMatchObject({ isUpToDate: true });
  });

  it("clicking again toggles the popover closed", () => {
    setState({ state: "in-sync" });
    const { container } = renderPill();
    const btn = pillButton(container);
    fireEvent.click(btn);
    expect(screen.queryByTestId("popover-in-sync")).toBeTruthy();
    fireEvent.click(btn);
    expect(screen.queryByTestId("popover-in-sync")).toBeNull();
  });

  it("clicking opens the repo-invitation popover with the member's own state, WITHOUT a payload fetch", () => {
    setState({ state: "repo-invitation", ownRepoAccess: { stage: "pending", invitationUrl: null } });
    const { container } = renderPill();
    fireEvent.click(pillButton(container));
    expect(screen.getByTestId("popover-repo-invitation").getAttribute("data-stage")).toBe("pending");
    expect(fetchSpy).not.toHaveBeenCalled();
    setState({ ownRepoAccess: null });
  });

  it("clicking opens the repo-unavailable popover WITHOUT a payload fetch", () => {
    setState({ state: "repo-unavailable" });
    const { container } = renderPill();
    fireEvent.click(pillButton(container));
    expect(screen.getByTestId("popover-repo-unavailable")).toBeTruthy();
    // repo-unavailable renders from loader flags — no api.site-status payload.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("SiteStatusPill — the halt is the convenor's action and the halt's popover", () => {
  const HALT: SiteStatusResult["persistence"] = {
    ...NO_HALT,
    halted: true,
    lastKnownHalt: { projectId: 7, reason: "apply_failed", at: 1_700_000_000_000, generation: 4 },
    confirmedGeneration: 4,
    lastReadHalted: true,
  };

  beforeEach(() => {
    fetchSpy.mockClear();
    checkAgainSpy.mockClear();
    dismissSpy.mockClear();
    setState({ state: "in-sync", saving: false, count: 0, persistence: NO_HALT, userRole: "convenor" });
  });

  it("shows the Restore action divider for a convenor", () => {
    setState({ state: "persistence-halted", persistence: HALT, userRole: "convenor" });
    const { container } = renderPill();
    expect(container.textContent).toContain("Saving stopped");
    expect(container.textContent).toContain("Restore →");
  });

  it("shows no action divider for a collaborator", () => {
    setState({ state: "persistence-halted", persistence: HALT, userRole: "collaborator" });
    const { container } = renderPill();
    expect(container.textContent).toContain("Saving stopped");
    expect(container.textContent).not.toContain("→");
  });

  it("opens the halted popover WITHOUT a payload fetch", () => {
    setState({ state: "persistence-halted", persistence: HALT });
    const { container } = renderPill();
    fireEvent.click(pillButton(container));
    expect(screen.getByTestId("popover-persistence-halted")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reads the state once when the halted popover is opened", () => {
    // The automatic reads stop at the first halt, so a popover opened an hour
    // later would otherwise show an hour-old confirmation.
    setState({ state: "persistence-halted", persistence: HALT });
    const { container } = renderPill();
    fireEvent.click(pillButton(container));
    expect(checkAgainSpy).toHaveBeenCalledTimes(1);
  });

  it("reads nothing when a popover other than the halted one is opened", () => {
    setState({ state: "in-sync", persistence: NO_HALT });
    const { container } = renderPill();
    fireEvent.click(pillButton(container));
    expect(checkAgainSpy).not.toHaveBeenCalled();
  });

  it("keeps the popover mounted while a restore is in flight and the halt has been cleared", () => {
    // Admission between the click and the response clears the halt, and the
    // outcome has not arrived: without the pending action the convenor's
    // action would leave the screen mid-flight.
    setState({ state: "persistence-halted", persistence: HALT });
    const { container, rerender } = renderPill();
    fireEvent.click(pillButton(container));
    expect(screen.getByTestId("popover-persistence-halted")).toBeTruthy();

    setState({
      state: "in-sync",
      persistence: {
        ...HALT,
        halted: false,
        lastKnownHalt: null,
        lastReadHalted: null,
        outcome: null,
        submitting: true,
      },
    });
    rerender();
    expect(screen.getByTestId("popover-persistence-halted")).toBeTruthy();

    // The response lands on the surface that stayed up, with the pre-reset
    // read discarded rather than reported as a fresh halt.
    setState({
      state: "in-sync",
      persistence: {
        ...HALT,
        halted: false,
        lastKnownHalt: null,
        lastReadHalted: false,
        haltedAgain: false,
        outcome: { kind: "landed" },
        submitting: false,
      },
    });
    rerender();
    const body = screen.getByTestId("popover-persistence-halted");
    expect(body.getAttribute("data-outcome")).toBe("landed");
    expect(body.getAttribute("data-halted-again")).toBe("false");
  });

  it("dismisses a displayed outcome when the popover is closed, and not before", () => {
    setState({
      state: "in-sync",
      persistence: { ...HALT, halted: false, lastKnownHalt: null, outcome: { kind: "landed" } },
    });
    const { container } = renderPill();
    const btn = pillButton(container);

    fireEvent.click(btn);
    expect(screen.getByTestId("popover-persistence-halted")).toBeTruthy();
    expect(dismissSpy).not.toHaveBeenCalled();

    fireEvent.click(btn);
    expect(dismissSpy).toHaveBeenCalledTimes(1);
  });

  it("dismisses a displayed outcome on Escape, and shows the healthy body on reopen", () => {
    setState({
      state: "in-sync",
      persistence: { ...HALT, halted: false, lastKnownHalt: null, outcome: { kind: "landed" } },
    });
    const { container } = renderPill();
    fireEvent.click(pillButton(container));
    expect(screen.getByTestId("popover-persistence-halted")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(dismissSpy).toHaveBeenCalledTimes(1);

    // The dismissal clears the outcome on the real hook; reflect that and reopen.
    setState({ state: "in-sync", persistence: NO_HALT });
    fireEvent.click(pillButton(container));
    expect(screen.getByTestId("popover-in-sync")).toBeTruthy();
    expect(screen.queryByTestId("popover-persistence-halted")).toBeNull();
  });

  it("dismisses a displayed outcome on an outside click, and shows the healthy body on reopen", () => {
    setState({
      state: "in-sync",
      persistence: { ...HALT, halted: false, lastKnownHalt: null, outcome: { kind: "landed" } },
    });
    const { container } = renderPill();
    fireEvent.click(pillButton(container));
    expect(screen.getByTestId("popover-persistence-halted")).toBeTruthy();

    const overlay = container.querySelector(".fixed.inset-0");
    expect(overlay).not.toBeNull();
    fireEvent.click(overlay as Element);
    expect(dismissSpy).toHaveBeenCalledTimes(1);

    // The dismissal clears the outcome on the real hook; reflect that and reopen.
    setState({ state: "in-sync", persistence: NO_HALT });
    fireEvent.click(pillButton(container));
    expect(screen.getByTestId("popover-in-sync")).toBeTruthy();
    expect(screen.queryByTestId("popover-persistence-halted")).toBeNull();
  });

  it("keeps the halted popover open when the pill re-derives to another state", () => {
    setState({ state: "persistence-halted", persistence: HALT });
    const { container, rerender } = renderPill();
    fireEvent.click(pillButton(container));
    expect(screen.getByTestId("popover-persistence-halted")).toBeTruthy();

    // Admission cleared the halt while the outcome was being read: the pill's
    // state falls back to in-sync and the popover has to survive it.
    setState({
      state: "in-sync",
      persistence: { ...HALT, halted: false, lastKnownHalt: null, outcome: { kind: "landed" } },
    });
    rerender();
    expect(screen.getByTestId("popover-persistence-halted")).toBeTruthy();
  });
});

describe("SiteStatusPill — at phone width", () => {
  beforeEach(() => setState({ state: "in-sync", saving: false, count: 0 }));

  it.each([
    "in-sync",
    "unpublished",
    "out-of-sync",
    "publishing",
    "upgrade",
    "repo-unavailable",
    "repo-invitation",
    "persistence-halted",
  ] as const)("%s collapses its caption to the dot below the sm breakpoint, still readable by assistive technology", (state) => {
    setState({ state, count: 4 });
    const { container } = renderPill();
    const caption = pillButton(container).querySelector("span[style*='600']") as HTMLElement;
    expect(caption.textContent).not.toBe("");
    expect(caption.className).toContain("max-sm:sr-only");
  });

  it("collapses the transient Saving text too", () => {
    setState({ state: "in-sync", saving: true });
    const { container } = renderPill();
    expect(within(pillButton(container)).getByRole("status").className).toContain("max-sm:sr-only");
  });
});
