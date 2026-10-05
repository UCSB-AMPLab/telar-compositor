// @vitest-environment jsdom
/**
 * A refused removal says so.
 *
 * `remove-member` returns `{ ok: false, error }` for several states, and the
 * panel toasted on exactly one of them — `instructor_on_child`, the branch its
 * own comment described as defence in depth for a path the kebab already
 * hides. The refusals that fire in ordinary use, `cannot_remove_owner` among
 * them, arrived and rendered nothing: the row stays where it was, which is
 * also what the screen shows when nothing was asked.
 *
 * The subject here is the panel, not a helper it calls. A test of a message
 * function would be green whether or not the panel showed the message, which
 * is the reading that let this sit unnoticed in the first place.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import React from "react";

vi.mock("react-i18next", () => ({
  useTranslation: (_ns?: string | string[]) => ({
    t: (key: string) => key,
    i18n: { language: "en" },
  }),
}));

const showToastMock = vi.fn();
vi.mock("~/hooks/use-toast", () => ({
  useToast: () => ({ showToast: showToastMock, dismissToast: vi.fn() }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Every useFetcher() in the panel is served the same response. Only the
// removal effect reads `ok`; the record fetcher reads `.members`, which an
// action response does not carry, so it sees `undefined` exactly as it does
// with no response at all.
let response: unknown = undefined;

vi.mock("react-router", () => ({
  useFetcher: () => ({
    submit: vi.fn(),
    load: vi.fn(),
    state: "idle",
    formData: undefined,
    get data() {
      return response;
    },
  }),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

import { CollaborationContext } from "~/hooks/use-collaboration";
import type { CollaborationContextValue } from "~/hooks/use-collaboration";
import { CollaborationSidebar } from "~/components/features/collaboration/CollaborationSidebar";

const CONTEXT: CollaborationContextValue = {
  ydoc: null,
  provider: null,
  connected: true,
  connectionStatus: "connected",
  admissionEpoch: 1,
  isPublishing: false,
  isBuilding: false,
  publishError: false,
  publishHeldByOther: false,
  publishHeldBy: null,
  dismissPublishError: vi.fn(),
  publishSha: null,
  publishCommitUrl: null,
  isUpgrading: false,
  upgradeError: false,
  upgradeHeldByOther: false,
  upgradeHeldBy: null,
  dismissUpgradeError: vi.fn(),
  upgradeSucceeded: false,
  objectsHeldBy: null,
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

const MEMBERS = [
  {
    userId: 1,
    githubId: 10,
    username: "ana",
    role: "convenor" as const,
    contributions: null,
    presenceColor: "#883C36",
  },
  {
    userId: 2,
    githubId: 20,
    username: "beto",
    role: "collaborator" as const,
    contributions: null,
    presenceColor: "#C6D0F8",
  },
];

function renderPanel() {
  const trigger = document.createElement("button");
  document.body.appendChild(trigger);
  return render(
    <CollaborationContext.Provider value={CONTEXT}>
      <CollaborationSidebar
        open={true}
        onClose={vi.fn()}
        isConvenor={true}
        members={MEMBERS}
        seats={{ used: 2, limit: 6 }}
        triggerRef={{ current: trigger } as React.RefObject<HTMLButtonElement>}
      />
    </CollaborationContext.Provider>,
  );
}

describe("a removal the server refuses", () => {
  beforeEach(() => {
    showToastMock.mockReset();
    response = undefined;
  });

  it("says so when the refusal is one the convenor meets in ordinary use", () => {
    response = { ok: false, intent: "remove-member", error: "cannot_remove_owner" };
    renderPanel();

    expect(showToastMock).toHaveBeenCalledOnce();
    expect(showToastMock.mock.calls[0][0]).toMatchObject({
      message: "team:error_remove_failed",
      type: "destructive",
    });
  });

  it("keeps the course's own explanation for the course's own refusal", () => {
    response = { ok: false, intent: "remove-member", error: "instructor_on_child" };
    renderPanel();

    expect(showToastMock.mock.calls[0][0].message).toBe("team:remove_instructor_refused");
  });

  it("says something rather than nothing when the refusal names no reason", () => {
    // `no_project` and a missing id both land here, and so would any error
    // code added to the action later without a sentence of its own.
    response = { ok: false, intent: "remove-member" };
    renderPanel();

    expect(showToastMock.mock.calls[0][0].message).toBe("team:error_remove_failed");
  });

  it("stays quiet when the removal succeeded", () => {
    response = { ok: true, intent: "remove-member" };
    renderPanel();

    expect(showToastMock).not.toHaveBeenCalled();
  });

  it("stays quiet when nothing has been asked", () => {
    renderPanel();

    expect(showToastMock).not.toHaveBeenCalled();
  });
});
