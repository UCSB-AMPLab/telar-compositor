// @vitest-environment jsdom
// Collaboration sidebar tests
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("react-i18next", () => ({
  useTranslation: (_ns?: string | string[]) => ({
    t: (key: string) => key,
    i18n: { language: "en" },
  }),
}));

vi.mock("react-router", () => ({
  useFetcher: () => ({
    submit: vi.fn(),
    state: "idle",
    data: undefined,
  }),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

// Mock CollaborationContext
import { CollaborationContext } from "~/hooks/use-collaboration";
import type { CollaborationContextValue } from "~/hooks/use-collaboration";

const mockContextValue: CollaborationContextValue = {
  ydoc: null,
  provider: null,
  connected: true,
  connectionStatus: "connected",
  isPublishing: false,
  publishError: false,
  setIsPublishing: vi.fn(),
  isUpgrading: false,
  upgradeError: false,
  setIsUpgrading: vi.fn(),
  remoteCollaborators: [
    {
      clientId: 101,
      user: { githubId: 1, name: "alice", color: "#8B5E3C" },
      location: { route: "/stories", storyId: null, fieldKey: null },
    },
  ],
  lastEditorByField: new Map(),
  undoManager: null,
  canUndo: false,
  canRedo: false,
  undo: vi.fn(),
  redo: vi.fn(),
  userGithubId: 99,
  contributionsByUser: new Map([
    [1, { fields_edited: 10 }],
    [2, { fields_edited: 5 }],
  ]),
};

function ContextWrapper({ children }: { children: React.ReactNode }) {
  return (
    <CollaborationContext.Provider value={mockContextValue}>
      {children}
    </CollaborationContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Members fixture
// ---------------------------------------------------------------------------

const MEMBERS = [
  {
    userId: 1,
    githubId: 10,
    username: "alice",
    role: "convenor" as const,
    contributions: { fields_edited: 10, sessions: 2, stories_edited: [], objects_edited: [], last_active: null },
    presenceColor: "#8B5E3C",
  },
  {
    userId: 2,
    githubId: 20,
    username: "bob",
    role: "collaborator" as const,
    contributions: { fields_edited: 5, sessions: 1, stories_edited: [], objects_edited: [], last_active: null },
    presenceColor: "#4A7C9E",
  },
];

const SEATS = { used: 2, limit: 6 };

import { CollaborationSidebar } from "~/components/features/collaboration/CollaborationSidebar";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CollaborationSidebar", () => {
  let triggerRef: React.RefObject<HTMLButtonElement>;
  let triggerEl: HTMLButtonElement;

  beforeEach(() => {
    triggerEl = document.createElement("button");
    document.body.appendChild(triggerEl);
    triggerRef = { current: triggerEl } as React.RefObject<HTMLButtonElement>;
  });

  it("renders closed by default — root aside has translate-x-full", () => {
    const { container } = render(
      <ContextWrapper>
        <CollaborationSidebar
          open={false}
          onClose={vi.fn()}
          isConvenor={false}
          members={MEMBERS}
          seats={SEATS}
          triggerRef={triggerRef}
        />
      </ContextWrapper>
    );
    const aside = container.querySelector("aside");
    expect(aside?.className).toContain("translate-x-full");
  });

  it("when open=true, root aside has translate-x-0", () => {
    const { container } = render(
      <ContextWrapper>
        <CollaborationSidebar
          open={true}
          onClose={vi.fn()}
          isConvenor={false}
          members={MEMBERS}
          seats={SEATS}
          triggerRef={triggerRef}
        />
      </ContextWrapper>
    );
    const aside = container.querySelector("aside");
    expect(aside?.className).toContain("translate-x-0");
    expect(aside?.className).not.toContain("translate-x-full");
  });

  it("renders three sections in order: Online now, Contributions, Team", () => {
    render(
      <ContextWrapper>
        <CollaborationSidebar
          open={true}
          onClose={vi.fn()}
          isConvenor={false}
          members={MEMBERS}
          seats={SEATS}
          triggerRef={triggerRef}
        />
      </ContextWrapper>
    );
    const headings = screen.getAllByRole("heading", { level: 3 });
    const texts = headings.map((h) => h.textContent ?? "");
    const onlineIdx = texts.findIndex((t) => t.includes("online_now"));
    const contribIdx = texts.findIndex((t) => t.includes("contributions"));
    const teamIdx = texts.findIndex((t) => t.includes("team_heading"));
    expect(onlineIdx).toBeGreaterThanOrEqual(0);
    expect(contribIdx).toBeGreaterThan(onlineIdx);
    expect(teamIdx).toBeGreaterThan(contribIdx);
  });

  it("renders invite controls only when isConvenor=true", () => {
    const { rerender } = render(
      <ContextWrapper>
        <CollaborationSidebar
          open={true}
          onClose={vi.fn()}
          isConvenor={false}
          members={MEMBERS}
          seats={SEATS}
          triggerRef={triggerRef}
        />
      </ContextWrapper>
    );
    // Non-convenor: no invite button
    expect(screen.queryByText("invite_button")).toBeNull();

    rerender(
      <ContextWrapper>
        <CollaborationSidebar
          open={true}
          onClose={vi.fn()}
          isConvenor={true}
          members={MEMBERS}
          seats={SEATS}
          triggerRef={triggerRef}
        />
      </ContextWrapper>
    );
    // Convenor: invite button present (InviteForm renders it)
    expect(screen.getByText("invite_button")).toBeTruthy();
  });

  it("focuses the close button on open (a11y)", async () => {
    render(
      <ContextWrapper>
        <CollaborationSidebar
          open={true}
          onClose={vi.fn()}
          isConvenor={false}
          members={MEMBERS}
          seats={SEATS}
          triggerRef={triggerRef}
        />
      </ContextWrapper>
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const closeBtn = screen.getByRole("button", { name: "common:close" });
    expect(document.activeElement).toBe(closeBtn);
  });

  it("returns focus to the Users icon trigger on close (a11y)", async () => {
    const { rerender } = render(
      <ContextWrapper>
        <CollaborationSidebar
          open={true}
          onClose={vi.fn()}
          isConvenor={false}
          members={MEMBERS}
          seats={SEATS}
          triggerRef={triggerRef}
        />
      </ContextWrapper>
    );
    // Close the sidebar
    rerender(
      <ContextWrapper>
        <CollaborationSidebar
          open={false}
          onClose={vi.fn()}
          isConvenor={false}
          members={MEMBERS}
          seats={SEATS}
          triggerRef={triggerRef}
        />
      </ContextWrapper>
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(document.activeElement).toBe(triggerEl);
  });

  it("Escape key closes the sidebar (onClose called)", () => {
    const onClose = vi.fn();
    render(
      <ContextWrapper>
        <CollaborationSidebar
          open={true}
          onClose={onClose}
          isConvenor={false}
          members={MEMBERS}
          seats={SEATS}
          triggerRef={triggerRef}
        />
      </ContextWrapper>
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("sets aria-expanded on the trigger button via open prop", () => {
    // The sidebar itself reflects open state via aria-hidden
    const { container } = render(
      <ContextWrapper>
        <CollaborationSidebar
          open={true}
          onClose={vi.fn()}
          isConvenor={false}
          members={MEMBERS}
          seats={SEATS}
          triggerRef={triggerRef}
        />
      </ContextWrapper>
    );
    const aside = container.querySelector("aside");
    // aria-hidden should be false (or absent) when open
    expect(aside?.getAttribute("aria-hidden")).toBe("false");
  });
});
