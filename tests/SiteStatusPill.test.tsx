// @vitest-environment jsdom
/**
 * Pins the `SiteStatusPill` — the global header pill that shows one of five
 * states with its LOCKED bg/ink pair, pulses only when publishing, renders the
 * transient `Saving…` overlay, and opens the matching popover (lazily fetching
 * its payload) inside the StatusPopoverShell on click.
 *
 * Asserts:
 *   - each of the five states renders its exact bg/ink token pair
 *   - only the `publishing` dot carries the `site-status-pulse` ring animation
 *   - the per-state action label (Publish → / Review →) appears only for the two
 *     actionable states
 *   - saving=true renders a "Saving…" element over the unchanged base-state colour;
 *     saving=false renders none
 *   - clicking the pill opens the popover matching the active state, and the
 *     popover payload fetch fires on open (not on mount)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { SiteStatusResult, SiteStatusState } from "~/components/features/site-status/useSiteStatus";

// --- useSiteStatus is mocked so each test drives one state + saving flag. ---
const siteStatusValue: { current: SiteStatusResult } = {
  current: {
    state: "in-sync",
    saving: false,
    count: 0,
    latestTag: "v1.3.0",
    userRole: "convenor",
    needsUpgrade: false,
  },
};
vi.mock("~/components/features/site-status/useSiteStatus", () => ({
  useSiteStatus: () => siteStatusValue.current,
}));

// --- The lazy payload fetcher: capture .load to assert it fires on open. ---
const loadSpy = vi.fn();
const submitSpy = vi.fn();
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useFetcher: () => ({ load: loadSpy, submit: submitSpy, state: "idle", data: undefined }),
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
        "status.unpublished_one": "{{n}} unpublished change",
        "status.unpublished_other": "{{n}} unpublished changes",
        "status.publish_cta": "Publish",
        "status.out_of_sync": "GitHub has changed",
        "status.review_cta": "Review",
        "status.publishing": "Publishing…",
        "status.upgrade": "Telar {{version}} available",
        "status.upgrade_cta": "Run upgrade",
        "status.saving": "Saving…",
        "status.repo_unavailable": "Repo unavailable",
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
  InSyncPopover: () => <div data-testid="popover-in-sync" />,
}));
vi.mock("~/components/features/site-status/popovers/UnpublishedPopover", () => ({
  UnpublishedPopover: () => <div data-testid="popover-unpublished" />,
}));
vi.mock("~/components/features/site-status/popovers/OutOfSyncPopover", () => ({
  OutOfSyncPopover: () => <div data-testid="popover-out-of-sync" />,
}));
vi.mock("~/components/features/site-status/popovers/PublishingPopover", () => ({
  PublishingPopover: () => <div data-testid="popover-publishing" />,
}));
vi.mock("~/components/features/site-status/popovers/UpgradePopover", () => ({
  UpgradePopover: () => <div data-testid="popover-upgrade" />,
}));
vi.mock("~/components/features/site-status/popovers/RepoUnavailablePopover", () => ({
  RepoUnavailablePopover: () => <div data-testid="popover-repo-unavailable" />,
}));

import { SiteStatusPill } from "~/components/features/site-status/SiteStatusPill";

function setState(partial: Partial<SiteStatusResult>) {
  siteStatusValue.current = { ...siteStatusValue.current, ...partial };
}

function renderPill() {
  return render(
    <MemoryRouter>
      <SiteStatusPill />
    </MemoryRouter>,
  );
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
};

describe("SiteStatusPill — five-state token pairs", () => {
  beforeEach(() => {
    loadSpy.mockClear();
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

describe("SiteStatusPill — pulse is publishing-only", () => {
  beforeEach(() => setState({ state: "in-sync", saving: false }));

  it("publishing dot carries site-status-pulse", () => {
    setState({ state: "publishing" });
    const { container } = renderPill();
    expect(container.querySelector(".site-status-pulse")).not.toBeNull();
  });

  (["in-sync", "unpublished", "out-of-sync", "upgrade", "repo-unavailable"] as SiteStatusState[]).forEach((state) => {
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
    loadSpy.mockClear();
    setState({ state: "in-sync", saving: false, count: 0 });
  });

  it("does NOT fetch the payload on mount", () => {
    setState({ state: "unpublished", count: 3 });
    renderPill();
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it("clicking opens the in-sync popover and fetches its payload", () => {
    setState({ state: "in-sync" });
    const { container } = renderPill();
    fireEvent.click(pillButton(container));
    expect(screen.getByTestId("popover-in-sync")).toBeTruthy();
    expect(loadSpy).toHaveBeenCalled();
    expect(loadSpy.mock.calls[0][0]).toContain("payload=in-sync");
  });

  it("clicking opens the unpublished popover and fetches its payload", () => {
    setState({ state: "unpublished", count: 3 });
    const { container } = renderPill();
    fireEvent.click(pillButton(container));
    expect(screen.getByTestId("popover-unpublished")).toBeTruthy();
    expect(loadSpy.mock.calls[0][0]).toContain("payload=unpublished");
  });

  it("clicking opens the out-of-sync popover and fetches its payload", () => {
    setState({ state: "out-of-sync" });
    const { container } = renderPill();
    fireEvent.click(pillButton(container));
    expect(screen.getByTestId("popover-out-of-sync")).toBeTruthy();
    expect(loadSpy.mock.calls[0][0]).toContain("payload=out-of-sync");
  });

  it("clicking opens the publishing popover WITHOUT a payload fetch (driven by awareness)", () => {
    setState({ state: "publishing" });
    const { container } = renderPill();
    fireEvent.click(pillButton(container));
    expect(screen.getByTestId("popover-publishing")).toBeTruthy();
    // publishing has no api.site-status payload — it polls via awareness SHA.
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it("clicking opens the upgrade popover WITHOUT a payload fetch", () => {
    setState({ state: "upgrade", needsUpgrade: true });
    const { container } = renderPill();
    fireEvent.click(pillButton(container));
    expect(screen.getByTestId("popover-upgrade")).toBeTruthy();
    expect(loadSpy).not.toHaveBeenCalled();
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

  it("clicking opens the repo-unavailable popover WITHOUT a payload fetch", () => {
    setState({ state: "repo-unavailable" });
    const { container } = renderPill();
    fireEvent.click(pillButton(container));
    expect(screen.getByTestId("popover-repo-unavailable")).toBeTruthy();
    // repo-unavailable renders from loader flags — no api.site-status payload.
    expect(loadSpy).not.toHaveBeenCalled();
  });
});
