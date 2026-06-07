// @vitest-environment jsdom
/**
 * Unit tests for useSiteStatus — the client hook that derives the single active
 * Site Status state by precedence plus the ~1.5s Saving overlay. The pure
 * deriveState() is tested exhaustively for precedence; the Saving timer is
 * tested through the hook with fake timers and mocked react-router /
 * use-collaboration signals.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import {
  deriveState,
  useSiteStatus,
  type DeriveStateInput,
} from "~/components/features/site-status/useSiteStatus";
import type { DerivedGithubStatus } from "~/lib/github-status.server";

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
});

// ---------------------------------------------------------------------------
// useSiteStatus — Saving overlay timer (1500ms)
// ---------------------------------------------------------------------------

describe("useSiteStatus saving overlay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetchers = [];
    mockLoaderData = { headDiverged: false, needsUpgrade: false, unpublishedCount: 0 };
    mockIsPublishing = false;
    mockIsBuilding = false;
    mockPollData = undefined;
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
