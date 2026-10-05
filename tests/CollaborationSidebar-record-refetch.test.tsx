// @vitest-environment jsdom
/**
 * When the collaboration panel asks for the contribution record again.
 *
 * The clocks in the panel show the Durable Object's figure, which moves while
 * the panel is open, so a record loaded once per mount goes stale in front of
 * the person reading it. The panel therefore asks again: on every open, on a
 * thirty-second beat while it stays open, and shortly after the reader's own
 * edits, which are the changes they will look down to see counted.
 *
 * The debounce is what makes the third of those bearable. A burst of typing is
 * one stretch of work, not forty, and the booking rule credits a minute in
 * advance of it either way — so one refetch two seconds after the typing stops
 * says everything a refetch per keystroke would.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import React from "react";
import * as Y from "yjs";

vi.mock("react-i18next", () => ({
  useTranslation: (_ns?: string | string[]) => ({
    t: (key: string) => key,
    i18n: { language: "en" },
  }),
}));

// One shared fetcher for every useFetcher() call in the component: only the
// record fetcher calls `load`, so the spy counts exactly the refetches.
const loadSpy = vi.fn();

vi.mock("react-router", () => ({
  useFetcher: () => ({
    submit: vi.fn(),
    load: loadSpy,
    state: "idle",
    formData: undefined,
    data: undefined,
  }),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

import { CollaborationContext } from "~/hooks/use-collaboration";
import type { CollaborationContextValue } from "~/hooks/use-collaboration";
import { CollaborationSidebar } from "~/components/features/collaboration/CollaborationSidebar";

const MEMBERS = [
  {
    userId: 1,
    githubId: 10,
    username: "ana",
    role: "convenor" as const,
    contributions: null,
    presenceColor: "#E47A6F",
  },
];

const SEATS = { used: 1, limit: 6 };

let ydoc: Y.Doc;

function contextValue(): CollaborationContextValue {
  return {
    ydoc,
    provider: null,
    connected: true,
    connectionStatus: "connected",
    isPublishing: false,
    isBuilding: false,
    publishError: false,
    setIsPublishing: vi.fn(),
    publishSha: null,
    publishCommitUrl: null,
    isUpgrading: false,
    upgradeError: false,
    setIsUpgrading: vi.fn(),
    remoteCollaborators: [],
    lastEditorByField: new Map(),
    undoManager: null,
    canUndo: false,
    canRedo: false,
    undo: vi.fn(),
    redo: vi.fn(),
    userGithubId: 10,
    contributionsByUser: new Map(),
  } as unknown as CollaborationContextValue;
}

function renderSidebar(open: boolean) {
  const view = render(
    <CollaborationContext.Provider value={contextValue()}>
      <CollaborationSidebar open={open} onClose={vi.fn()} isConvenor={false} members={MEMBERS} seats={SEATS} />
    </CollaborationContext.Provider>,
  );
  return {
    ...view,
    setOpen: (next: boolean) =>
      act(() => {
        view.rerender(
          <CollaborationContext.Provider value={contextValue()}>
            <CollaborationSidebar open={next} onClose={vi.fn()} isConvenor={false} members={MEMBERS} seats={SEATS} />
          </CollaborationContext.Provider>,
        );
      }),
  };
}

/** A change this person made, as the provider would report it. */
function localChange(): void {
  act(() => {
    ydoc.transact(() => {
      ydoc.getMap("config").set("title", `t${Math.random()}`);
    }, "local-origin");
  });
}

/** A change somebody else made, arriving as an update from the socket. */
function remoteChange(): void {
  const other = new Y.Doc();
  other.getMap("config").set("title", `remote-${Math.random()}`);
  const update = Y.encodeStateAsUpdate(other);
  act(() => {
    Y.applyUpdate(ydoc, update);
  });
}

function tick(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  loadSpy.mockClear();
  ydoc = new Y.Doc();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CollaborationSidebar — asking for the record again", () => {
  it("loads once on open and again every thirty seconds while open", () => {
    renderSidebar(true);
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(loadSpy).toHaveBeenCalledWith("/contributions?panel=record");

    tick(30_000);
    expect(loadSpy).toHaveBeenCalledTimes(2);

    tick(30_000);
    expect(loadSpy).toHaveBeenCalledTimes(3);
  });

  it("stops asking when the panel closes, and asks at once when it opens again", () => {
    const { setOpen } = renderSidebar(true);
    expect(loadSpy).toHaveBeenCalledTimes(1);

    setOpen(false);
    tick(90_000);
    expect(loadSpy).toHaveBeenCalledTimes(1);

    setOpen(true);
    expect(loadSpy).toHaveBeenCalledTimes(2);
  });

  it("stops asking when the panel unmounts", () => {
    const { unmount } = renderSidebar(true);
    expect(loadSpy).toHaveBeenCalledTimes(1);

    unmount();
    tick(90_000);
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });

  it("does not ask while the panel is closed", () => {
    renderSidebar(false);

    tick(90_000);
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it("asks two seconds after this person's own change, not one", () => {
    renderSidebar(true);
    loadSpy.mockClear();

    localChange();
    tick(1_000);
    expect(loadSpy).not.toHaveBeenCalled();

    tick(1_000);
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });

  it("asks once for a burst of typing, two seconds after it stops", () => {
    renderSidebar(true);
    loadSpy.mockClear();

    localChange();
    tick(500);
    localChange();
    tick(500);
    localChange();
    expect(loadSpy).not.toHaveBeenCalled();

    tick(2_000);
    expect(loadSpy).toHaveBeenCalledTimes(1);

    tick(2_000);
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });

  it("ignores a change that arrived from somebody else", () => {
    renderSidebar(true);
    loadSpy.mockClear();

    remoteChange();
    tick(2_500);

    expect(loadSpy).not.toHaveBeenCalled();
  });

  it("drops a pending refetch when the panel closes", () => {
    const { setOpen } = renderSidebar(true);
    loadSpy.mockClear();

    localChange();
    setOpen(false);
    tick(5_000);

    expect(loadSpy).not.toHaveBeenCalled();
  });
});
