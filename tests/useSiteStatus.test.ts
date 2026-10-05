// @vitest-environment jsdom
/**
 * Unit tests for useSiteStatus — the client hook that derives the single active
 * Site Status state by precedence plus the ~1.5s Saving overlay. The pure
 * deriveState() is tested exhaustively for precedence; the Saving timer is
 * tested through the hook with fake timers and mocked react-router /
 * use-collaboration signals.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import {
  deriveState,
  useSiteStatus,
  type DeriveStateInput,
} from "~/components/features/site-status/useSiteStatus";
import type { DerivedGithubStatus } from "~/lib/github-status.server";
import type { PersistenceHaltResult } from "~/hooks/use-persistence-halt";

// ---------------------------------------------------------------------------
// Mocks for the hook-level (timer) tests
// ---------------------------------------------------------------------------

let mockFetchers: Array<{ state: string; formData: FormData | null }> = [];
let mockLoaderData: Record<string, unknown> | null = null;
let mockIsPublishing = false;
let mockIsBuilding = false;
/** Controlled poll return value. undefined = poll has not returned yet. */
let mockPollData: DerivedGithubStatus | undefined = undefined;

vi.mock("react-router", () => ({
  useFetchers: () => mockFetchers,
  useRouteLoaderData: () => mockLoaderData,
  // useFetcher is used by useGithubStatusPoll (imported by useSiteStatus);
  // return a stable no-op so the poll hook doesn't interfere with these tests.
  useFetcher: () => ({ load: vi.fn(), state: "idle", data: undefined }),
}));

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({ isPublishing: mockIsPublishing, isBuilding: mockIsBuilding }),
}));

// Mock useGithubStatusPoll so we can inject arbitrary poll responses without
// a real fetch. Defaults to undefined (poll not yet returned).
vi.mock("~/hooks/use-github-status-poll", () => ({
  useGithubStatusPoll: () => mockPollData,
}));

// The halt trigger is the hook's one I/O input. It is stubbed here so the
// precedence and overlay tests stay free of timers and fetches of their own;
// its own behaviour is proved in tests/use-persistence-halt.test.tsx.
let mockPersistence: PersistenceHaltResult = {
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
  usePersistenceHalt: () => mockPersistence,
}));

function saveFetcher(intent: string) {
  const fd = new FormData();
  fd.set("intent", intent);
  return { state: "submitting", formData: fd };
}

// ---------------------------------------------------------------------------
// Pure deriveState — precedence
// ---------------------------------------------------------------------------

const BASE: DeriveStateInput = {
  isPublishing: false,
  headDiverged: false,
  unpublishedCount: 0,
  needsUpgrade: false,
};

describe("deriveState (precedence)", () => {
  it("returns 'in-sync' when nothing is set", () => {
    expect(deriveState(BASE)).toBe("in-sync");
  });

  it("returns 'upgrade' when only needsUpgrade", () => {
    expect(deriveState({ ...BASE, needsUpgrade: true })).toBe("upgrade");
  });

  it("returns 'unpublished' when unpublishedCount > 0 (over upgrade)", () => {
    expect(
      deriveState({ ...BASE, unpublishedCount: 2, needsUpgrade: true }),
    ).toBe("unpublished");
  });

  it("returns 'out-of-sync' over unpublished and upgrade", () => {
    expect(
      deriveState({
        ...BASE,
        headDiverged: true,
        unpublishedCount: 5,
        needsUpgrade: true,
      }),
    ).toBe("out-of-sync");
  });

  it("returns 'publishing' as dominant even when headDiverged and unpublishedCount>0", () => {
    expect(
      deriveState({
        isPublishing: true,
        headDiverged: true,
        unpublishedCount: 9,
        needsUpgrade: true,
      }),
    ).toBe("publishing");
  });

  it("treats undefined optional inputs as falsy/zero", () => {
    expect(deriveState({} as DeriveStateInput)).toBe("in-sync");
  });

  it("returns 'repo-unavailable' as dominant over publishing and everything else", () => {
    expect(
      deriveState({
        repoUnavailable: true,
        isPublishing: true,
        headDiverged: true,
        unpublishedCount: 3,
        needsUpgrade: true,
      }),
    ).toBe("repo-unavailable");
  });

  it("does not return 'repo-unavailable' when the flag is absent", () => {
    expect(deriveState({ ...BASE, isPublishing: true })).toBe("publishing");
  });

  it("returns 'publishing' when isBuilding even though isPublishing is false (pill stays through build)", () => {
    expect(deriveState({ ...BASE, isPublishing: false, isBuilding: true })).toBe("publishing");
  });

  it("isBuilding does not override repo-unavailable", () => {
    expect(
      deriveState({ ...BASE, repoUnavailable: true, isBuilding: true }),
    ).toBe("repo-unavailable");
  });

  it("is 'in-sync' when neither isPublishing nor isBuilding is set", () => {
    expect(deriveState({ ...BASE, isPublishing: false, isBuilding: false })).toBe("in-sync");
  });

  it("returns 'persistence-halted' when halted is the only input", () => {
    expect(deriveState({ ...BASE, halted: true })).toBe("persistence-halted");
  });

  it("returns 'persistence-halted' over every other signal at once", () => {
    expect(
      deriveState({
        halted: true,
        repoUnavailable: true,
        isPublishing: true,
        isBuilding: true,
        headDiverged: true,
        unpublishedCount: 12,
        needsUpgrade: true,
      }),
    ).toBe("persistence-halted");
  });

  it.each([
    ["repoUnavailable", { repoUnavailable: true }, "repo-unavailable"],
    ["isPublishing", { isPublishing: true }, "publishing"],
    ["isBuilding", { isBuilding: true }, "publishing"],
    ["headDiverged", { headDiverged: true }, "out-of-sync"],
    ["unpublishedCount", { unpublishedCount: 4 }, "unpublished"],
    ["needsUpgrade", { needsUpgrade: true }, "upgrade"],
    ["nothing", {}, "in-sync"],
  ])("no input other than halted produces it: %s", (_label, input, expected) => {
    expect(deriveState({ ...BASE, ...(input as DeriveStateInput) })).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// useSiteStatus — Saving overlay timer (1500ms)
// ---------------------------------------------------------------------------

describe("deriveState — the member's own repository invitation", () => {
  it("sits below out-of-sync and above unpublished", () => {
    expect(deriveState({ ...BASE, invitationOpen: true, unpublishedCount: 3, needsUpgrade: true })).toBe("repo-invitation");
    expect(deriveState({ ...BASE, invitationOpen: true, headDiverged: true })).toBe("out-of-sync");
  });

  it("yields to publishing and repo-unavailable, and is absent without an invitation", () => {
    expect(deriveState({ ...BASE, invitationOpen: true, isPublishing: true })).toBe("publishing");
    expect(deriveState({ ...BASE, invitationOpen: true, repoUnavailable: true })).toBe("repo-unavailable");
    expect(deriveState({ ...BASE, invitationOpen: false })).toBe("in-sync");
  });
});

describe("useSiteStatus — the invitation comes from the poll", () => {
  const stage = (stage: "pending" | "lapsed" | "access" | "none") => ({
    repoUnavailable: false, headDiverged: false, needsUpgrade: false, isBelowMinimum: false,
    latestTelarTag: null, unpublishedCount: 0, ownRepoAccess: { stage, invitationUrl: "https://github.com/o/r/invitations" },
  });
  afterEach(() => { mockPollData = undefined; });

  it.each(["pending", "lapsed"] as const)("a %s invitation raises the state and is handed on", (s) => {
    mockPollData = stage(s);
    const { result } = renderHook(() => useSiteStatus());
    expect(result.current.state).toBe("repo-invitation");
    expect(result.current.ownRepoAccess).toEqual({ stage: s, invitationUrl: "https://github.com/o/r/invitations" });
  });

  it.each(["access", "none"] as const)("a member whose stage is %s sees nothing", (s) => {
    mockPollData = stage(s);
    expect(renderHook(() => useSiteStatus()).result.current.state).toBe("in-sync");
  });

  it("no ownRepoAccess in the answer sees nothing", () => {
    mockPollData = { ...stage("pending"), ownRepoAccess: null };
    expect(renderHook(() => useSiteStatus()).result.current.state).toBe("in-sync");
  });
});

describe("useSiteStatus saving overlay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetchers = [];
    mockLoaderData = { headDiverged: false, needsUpgrade: false, unpublishedCount: 0 };
    mockIsPublishing = false;
    mockIsBuilding = false;
    mockPollData = undefined;
    mockPersistence = { ...mockPersistence, halted: false };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("saving is true while a matching save fetcher is submitting", () => {
    mockFetchers = [saveFetcher("autosave-story-field")];
    const { result } = renderHook(() => useSiteStatus());
    expect(result.current.saving).toBe(true);
  });

  it("saving stays true at +1499ms after settle, then false at +1501ms", () => {
    mockFetchers = [saveFetcher("autosave-story-field")];
    const { result, rerender } = renderHook(() => useSiteStatus());
    expect(result.current.saving).toBe(true);

    // fetcher settles
    mockFetchers = [];
    act(() => {
      rerender();
    });
    // still showing the overlay just before 1500ms
    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(result.current.saving).toBe(true);

    // crosses 1500ms → silent
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(result.current.saving).toBe(false);
  });

  it("a non-save fetcher does not trigger saving", () => {
    mockFetchers = [saveFetcher("poll-build")];
    const { result } = renderHook(() => useSiteStatus());
    expect(result.current.saving).toBe(false);
  });

  it("saving overlay does not change the returned base state", () => {
    mockLoaderData = { headDiverged: true, needsUpgrade: false, unpublishedCount: 0 };
    mockFetchers = [saveFetcher("autosave-config")];
    const { result } = renderHook(() => useSiteStatus());
    expect(result.current.state).toBe("out-of-sync");
    expect(result.current.saving).toBe(true);
  });

  it("state is 'publishing' while isBuilding is true (build running after commit)", () => {
    mockIsBuilding = true;
    const { result } = renderHook(() => useSiteStatus());
    expect(result.current.state).toBe("publishing");
  });

  it("exposes count, needsUpgrade and userRole from the loader", () => {
    mockLoaderData = {
      headDiverged: false,
      needsUpgrade: true,
      unpublishedCount: 3,
      latestTelarTag: "v1.4.0",
      userRole: "convenor",
    };
    const { result } = renderHook(() => useSiteStatus());
    expect(result.current.count).toBe(3);
    expect(result.current.needsUpgrade).toBe(true);
    expect(result.current.latestTag).toBe("v1.4.0");
    expect(result.current.userRole).toBe("convenor");
  });

  it("loader count is used when poll has not returned yet (live undefined)", () => {
    // useFetcher returns data:undefined → poll returns undefined → loader value used.
    mockLoaderData = { headDiverged: false, needsUpgrade: false, unpublishedCount: 7 };
    const { result } = renderHook(() => useSiteStatus());
    expect(result.current.count).toBe(7);
    expect(result.current.state).toBe("unpublished");
  });
});

// ---------------------------------------------------------------------------
// useSiteStatus — poll unpublishedCount merges OVER loader proxy
// ---------------------------------------------------------------------------

describe("useSiteStatus — poll count overrides loader proxy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetchers = [];
    mockIsPublishing = false;
    mockIsBuilding = false;
    mockPollData = undefined;
    mockPersistence = { ...mockPersistence, halted: false };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("poll count 0 overrides loader count 7 → state 'in-sync' and count 0", () => {
    // Loader says 7 unpublished (stale proxy), poll returns the real diff: 0.
    // The pill MUST show 0 and flip to in-sync.
    mockLoaderData = {
      headDiverged: false,
      needsUpgrade: false,
      unpublishedCount: 7,
      repoUnavailable: false,
    };
    mockPollData = {
      repoUnavailable: false,
      headDiverged: false,
      needsUpgrade: false,
      isBelowMinimum: false,
      latestTelarTag: null,
      unpublishedCount: 0,
    };
    const { result } = renderHook(() => useSiteStatus());
    expect(result.current.count).toBe(0);
    expect(result.current.state).toBe("in-sync");
  });

  it("poll count 3 overrides loader count 0 → state 'unpublished' and count 3", () => {
    mockLoaderData = {
      headDiverged: false,
      needsUpgrade: false,
      unpublishedCount: 0,
      repoUnavailable: false,
    };
    mockPollData = {
      repoUnavailable: false,
      headDiverged: false,
      needsUpgrade: false,
      isBelowMinimum: false,
      latestTelarTag: null,
      unpublishedCount: 3,
    };
    const { result } = renderHook(() => useSiteStatus());
    expect(result.current.count).toBe(3);
    expect(result.current.state).toBe("unpublished");
  });

  it("poll undefined → loader count 7 used (fallback)", () => {
    mockLoaderData = {
      headDiverged: false,
      needsUpgrade: false,
      unpublishedCount: 7,
      repoUnavailable: false,
    };
    mockPollData = undefined;
    const { result } = renderHook(() => useSiteStatus());
    expect(result.current.count).toBe(7);
    expect(result.current.state).toBe("unpublished");
  });

  it("poll with unpublishedCount undefined → loader count 7 used (fallback)", () => {
    // Poll returns a valid DerivedGithubStatus but without unpublishedCount
    // (e.g. the server couldn't compute it). Loader proxy must be used.
    mockLoaderData = {
      headDiverged: false,
      needsUpgrade: false,
      unpublishedCount: 7,
      repoUnavailable: false,
    };
    mockPollData = {
      repoUnavailable: false,
      headDiverged: false,
      needsUpgrade: false,
      isBelowMinimum: false,
      latestTelarTag: null,
      // unpublishedCount intentionally absent
    };
    const { result } = renderHook(() => useSiteStatus());
    expect(result.current.count).toBe(7);
    expect(result.current.state).toBe("unpublished");
  });
});

describe("useSiteStatus — the count is known only once the live status answers", () => {
  beforeEach(() => {
    mockLoaderData = { headDiverged: false, needsUpgrade: false, unpublishedCount: 8 };
    mockPollData = undefined;
  });

  it("countKnown is false while only the loader's stand-in exists", () => {
    const { result } = renderHook(() => useSiteStatus());
    expect(result.current.countKnown).toBe(false);
    expect(result.current.state).toBe("unpublished");
  });

  it("countKnown is false when the poll answers without a count", () => {
    mockPollData = {
      repoUnavailable: false,
      headDiverged: false,
      needsUpgrade: false,
      isBelowMinimum: false,
      latestTelarTag: null,
    };
    const { result } = renderHook(() => useSiteStatus());
    expect(result.current.countKnown).toBe(false);
  });

  it("countKnown is true, with the live number, once the poll answers", () => {
    mockPollData = {
      repoUnavailable: false,
      headDiverged: false,
      needsUpgrade: false,
      isBelowMinimum: false,
      latestTelarTag: null,
      unpublishedCount: 4,
    };
    const { result } = renderHook(() => useSiteStatus());
    expect(result.current.countKnown).toBe(true);
    expect(result.current.count).toBe(4);
  });
});

describe("useSiteStatus — the halt is a state, and Saving stays an overlay over it", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetchers = [];
    mockLoaderData = { headDiverged: true, needsUpgrade: true, unpublishedCount: 3 };
    mockIsPublishing = false;
    mockIsBuilding = false;
    mockPollData = undefined;
    mockPersistence = { ...mockPersistence, halted: false };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("derives persistence-halted from the trigger's halt over the loader's signals", () => {
    mockPersistence = { ...mockPersistence, halted: true };
    const { result } = renderHook(() => useSiteStatus());
    expect(result.current.state).toBe("persistence-halted");
  });

  it("keeps Saving as an overlay on the halted state rather than replacing it", () => {
    mockPersistence = { ...mockPersistence, halted: true };
    mockFetchers = [saveFetcher("autosave-story-field")];
    const { result } = renderHook(() => useSiteStatus());
    expect(result.current.state).toBe("persistence-halted");
    expect(result.current.saving).toBe(true);
  });

  it("returns the trigger's halt, generation and outcome unchanged", () => {
    // The hook calls the trigger once and passes what it answers straight on;
    // what the popover does with it is pinned in its own test.
    const halt = { projectId: 7, reason: "log_corrupt", at: 12, generation: 3 };
    const outcome = { kind: "stale", generation: 4 } as const;
    mockPersistence = {
      ...mockPersistence,
      halted: true,
      lastKnownHalt: halt,
      confirmedGeneration: 3,
      lastReadHalted: true,
      haltedAgain: true,
      outcome,
      submitting: true,
    };
    const { result } = renderHook(() => useSiteStatus());
    expect(result.current.persistence).toBe(mockPersistence);
    expect(result.current.persistence.lastKnownHalt).toEqual(halt);
    expect(result.current.persistence.confirmedGeneration).toBe(3);
    expect(result.current.persistence.outcome).toEqual(outcome);
    expect(result.current.persistence.haltedAgain).toBe(true);
    expect(result.current.persistence.submitting).toBe(true);
  });
});
