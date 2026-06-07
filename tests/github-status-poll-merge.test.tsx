// @vitest-environment jsdom
/**
 * Merge tests for useSiteStatus — verifies that the live poll result from
 * useGithubStatusPoll overrides the loader's cached gh_* values in the
 * derived state. The pure precedence (deriveState) is tested separately in
 * useSiteStatus.test.ts; these tests focus only on the live-over-loader merge.
 *
 * Three cases:
 *  (a) poll undefined → loader values win → "in-sync"
 *  (b) poll headDiverged:true → overrides loader's false → "out-of-sync"
 *  (c) poll repoUnavailable:true → overrides loader's false → "repo-unavailable"
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useSiteStatus } from "~/components/features/site-status/useSiteStatus";
import type { DerivedGithubStatus } from "~/lib/github-status.server";

// ---------------------------------------------------------------------------
// Controlled state
// ---------------------------------------------------------------------------

let mockLoaderData: Record<string, unknown> | null = null;
let mockIsPublishing = false;
let mockPollData: DerivedGithubStatus | undefined = undefined;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("react-router", () => ({
  useFetchers: () => [],
  useRouteLoaderData: () => mockLoaderData,
  useFetcher: () => ({ load: vi.fn(), state: "idle", data: undefined }),
}));

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({ isPublishing: mockIsPublishing }),
}));

vi.mock("~/hooks/use-github-status-poll", () => ({
  useGithubStatusPoll: () => mockPollData,
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useSiteStatus — live-over-loader merge", () => {
  beforeEach(() => {
    mockIsPublishing = false;
    mockPollData = undefined;
    mockLoaderData = {
      headDiverged: false,
      unpublishedCount: 0,
      needsUpgrade: false,
      repoUnavailable: false,
    };
  });

  it("(a) poll undefined + clean loader → state is 'in-sync'", () => {
    mockPollData = undefined;
    const { result } = renderHook(() => useSiteStatus());
    expect(result.current.state).toBe("in-sync");
  });

  it("(b) poll headDiverged:true overrides loader's false → state is 'out-of-sync'", () => {
    mockPollData = {
      headDiverged: true,
      repoUnavailable: false,
      needsUpgrade: false,
      isBelowMinimum: false,
      latestTelarTag: null,
    };
    const { result } = renderHook(() => useSiteStatus());
    expect(result.current.state).toBe("out-of-sync");
  });

  it("(c) poll repoUnavailable:true overrides loader's false → state is 'repo-unavailable'", () => {
    mockPollData = {
      repoUnavailable: true,
      headDiverged: false,
      needsUpgrade: false,
      isBelowMinimum: false,
      latestTelarTag: null,
    };
    const { result } = renderHook(() => useSiteStatus());
    expect(result.current.state).toBe("repo-unavailable");
  });

  it("(d) poll needsUpgrade:true overrides loader's false → state is 'upgrade'", () => {
    mockLoaderData = {
      headDiverged: false,
      unpublishedCount: 0,
      needsUpgrade: false,
      repoUnavailable: false,
    };
    mockPollData = {
      repoUnavailable: false,
      headDiverged: false,
      needsUpgrade: true,
      isBelowMinimum: false,
      latestTelarTag: "v9.9.9",
    };
    const { result } = renderHook(() => useSiteStatus());
    expect(result.current.state).toBe("upgrade");
  });

  it("(e) poll latestTelarTag overrides loader's latestTelarTag → latestTag is poll value", () => {
    mockLoaderData = {
      headDiverged: false,
      unpublishedCount: 0,
      needsUpgrade: false,
      repoUnavailable: false,
      latestTelarTag: "v1.0.0",
    };
    mockPollData = {
      repoUnavailable: false,
      headDiverged: false,
      needsUpgrade: false,
      isBelowMinimum: false,
      latestTelarTag: "v9.9.9",
    };
    const { result } = renderHook(() => useSiteStatus());
    expect(result.current.latestTag).toBe("v9.9.9");
  });
});
