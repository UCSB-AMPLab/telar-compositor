// @vitest-environment jsdom
// CollaborationSidebar — pending-invites section (cancel-invite dispatch)
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

// A single shared submit spy so every useFetcher() call in the component
// (removeFetcher AND cancelInviteFetcher) reports into the same mock, letting
// us assert exactly what was dispatched.
const submitSpy = vi.fn();

vi.mock("react-router", () => ({
  useFetcher: () => ({
    submit: submitSpy,
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

const mockContextValue: CollaborationContextValue = {
  ydoc: null,
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
  userGithubId: 99,
  contributionsByUser: new Map(),
};

function ContextWrapper({ children }: { children: React.ReactNode }) {
  return (
    <CollaborationContext.Provider value={mockContextValue}>
      {children}
    </CollaborationContext.Provider>
  );
}

const MEMBERS = [
  {
    userId: 1,
    githubId: 10,
    username: "alice",
    role: "convenor" as const,
    contributions: null,
    presenceColor: "#8B5E3C",
  },
];

const SEATS = { used: 1, limit: 5 };

const PENDING = [
  { id: 42, createdBy: 1 },
  { id: 43, createdBy: 1 },
];

import { CollaborationSidebar } from "~/components/features/collaboration/CollaborationSidebar";

function triggerRef() {
  const el = document.createElement("button");
  document.body.appendChild(el);
  return { current: el } as React.RefObject<HTMLButtonElement>;
}

describe("CollaborationSidebar — pending invites", () => {
  beforeEach(() => {
    submitSpy.mockClear();
  });

  it("lists pending invitations and shows a heading for the convenor", () => {
    render(
      <ContextWrapper>
        <CollaborationSidebar
          open={true}
          onClose={vi.fn()}
          isConvenor={true}
          members={MEMBERS}
          pendingInvites={PENDING}
          seats={SEATS}
          triggerRef={triggerRef()}
        />
      </ContextWrapper>
    );
    expect(screen.getByText("team:pending_invites_heading")).toBeTruthy();
    // Two invite rows, each with a cancel button.
    const cancelButtons = screen.getAllByRole("button", {
      name: "team:cancel_invite_aria",
    });
    expect(cancelButtons.length).toBe(2);
  });

  it("dispatches intent=cancel-invite with the invite id when cancel is clicked", () => {
    render(
      <ContextWrapper>
        <CollaborationSidebar
          open={true}
          onClose={vi.fn()}
          isConvenor={true}
          members={MEMBERS}
          pendingInvites={PENDING}
          seats={SEATS}
          triggerRef={triggerRef()}
        />
      </ContextWrapper>
    );
    const cancelButtons = screen.getAllByRole("button", {
      name: "team:cancel_invite_aria",
    });
    fireEvent.click(cancelButtons[0]);

    expect(submitSpy).toHaveBeenCalledTimes(1);
    const [fd, opts] = submitSpy.mock.calls[0];
    expect(fd).toBeInstanceOf(FormData);
    expect((fd as FormData).get("intent")).toBe("cancel-invite");
    expect((fd as FormData).get("inviteId")).toBe("42");
    expect(opts).toMatchObject({ method: "post", action: "/dashboard" });
  });

  it("hides the pending-invites section entirely for a non-convenor", () => {
    render(
      <ContextWrapper>
        <CollaborationSidebar
          open={true}
          onClose={vi.fn()}
          isConvenor={false}
          members={MEMBERS}
          pendingInvites={PENDING}
          seats={SEATS}
          triggerRef={triggerRef()}
        />
      </ContextWrapper>
    );
    expect(screen.queryByText("team:pending_invites_heading")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "team:cancel_invite_aria" })
    ).toBeNull();
  });

  it("shows the empty state when the convenor has no pending invites", () => {
    render(
      <ContextWrapper>
        <CollaborationSidebar
          open={true}
          onClose={vi.fn()}
          isConvenor={true}
          members={MEMBERS}
          pendingInvites={[]}
          seats={SEATS}
          triggerRef={triggerRef()}
        />
      </ContextWrapper>
    );
    expect(screen.getByText("team:pending_invites_empty")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "team:cancel_invite_aria" })
    ).toBeNull();
  });
});
