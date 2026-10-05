// @vitest-environment jsdom
/**
 * Before the shared document has synced, the stories arrays are empty because
 * nothing has arrived, not because the project has no stories. The list says it
 * is loading then, and only says "no stories yet" once the provider has synced.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import { EventEmitter } from "node:events";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { StoriesEmptyState } from "~/components/features/stories/StoriesEmptyState";
import { storiesSource } from "~/lib/stories-source";
import { useProviderSynced } from "~/hooks/use-provider-synced";

function fakeSyncProvider(synced: boolean) {
  const p = new EventEmitter() as EventEmitter & { synced: boolean; on: any; off: any };
  p.synced = synced;
  return p;
}

describe("StoriesEmptyState while the document has not synced", () => {
  it("shows a loading line and no empty-state claim", () => {
    render(<StoriesEmptyState onCreateNew={() => {}} awaitingSync />);
    expect(screen.getByRole("status").textContent).toContain("loading_state");
    expect(screen.queryByText("empty_state")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the empty state once synced", () => {
    render(<StoriesEmptyState onCreateNew={() => {}} awaitingSync={false} />);
    expect(screen.getByText("empty_state")).toBeTruthy();
  });
});

describe("storiesSource", () => {
  it("reads the loader's stories while the document is unsynced and empty", () => {
    expect(storiesSource({ liveReady: true, syncState: "waiting", liveCount: 0 })).toBe("loader");
  });
  it("reads the live list once synced, even when it is empty", () => {
    expect(storiesSource({ liveReady: true, syncState: "synced", liveCount: 0 })).toBe("live");
  });
  it("reads the live list as soon as it holds rows", () => {
    expect(storiesSource({ liveReady: true, syncState: "waiting", liveCount: 2 })).toBe("live");
  });
  it("reads the loader when there is no document", () => {
    expect(storiesSource({ liveReady: false, syncState: "synced", liveCount: 0 })).toBe("loader");
  });
});

describe("useProviderSynced", () => {
  const opts = { giveUpMs: 1000 };

  it("waits, then reports synced when the provider syncs", () => {
    const provider = fakeSyncProvider(false);
    const { result } = renderHook(() => useProviderSynced(provider as any, opts));
    expect(result.current).toBe("waiting");
    act(() => {
      provider.synced = true;
      provider.emit("sync", true);
    });
    expect(result.current).toBe("synced");
  });

  it("gives up on a provider that never syncs", () => {
    vi.useFakeTimers();
    const provider = fakeSyncProvider(false);
    const { result } = renderHook(() => useProviderSynced(provider as any, opts));
    expect(result.current).toBe("waiting");
    act(() => {
      vi.advanceTimersByTime(1001);
    });
    expect(result.current).toBe("gave-up");
    act(() => {
      provider.synced = true;
      provider.emit("sync", true);
    });
    expect(result.current).toBe("synced");
    vi.useRealTimers();
  });

  it("gives up at once when the connection is offline", () => {
    const { result } = renderHook(() =>
      useProviderSynced(fakeSyncProvider(false) as any, { ...opts, offline: true }),
    );
    expect(result.current).toBe("gave-up");
  });

  it("is synced for a provider already synced and for no provider", () => {
    expect(renderHook(() => useProviderSynced(fakeSyncProvider(true) as any, opts)).result.current).toBe("synced");
    expect(renderHook(() => useProviderSynced(null, opts)).result.current).toBe("synced");
  });
});
