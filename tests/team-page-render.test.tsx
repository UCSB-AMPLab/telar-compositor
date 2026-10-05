// @vitest-environment jsdom
/**
 * The team page's rows, the poll that refreshes it, and the sidebar link.
 *
 * Each state shows its own line, a row carries only the controls its viewer
 * has on it, and a refused action says why. The page reads again when the
 * existing GitHub-status poll hands it a new answer, and not otherwise.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

const revalidate = vi.fn();
let polled: object | undefined;
vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useRevalidator: () => ({ revalidate, state: "idle" }),
  useFetcher: () => ({ state: "idle", data: undefined, submit: vi.fn() }),
}));
vi.mock("~/hooks/use-github-status-poll", () => ({ useGithubStatusPoll: () => polled }));

import { TeamInvitedRow, TeamMemberRow } from "~/components/features/team/TeamMemberRow";
import TeamRoute from "~/routes/_app.team";
import { teamRowActions } from "~/lib/repo-access";
import type { TeamRowAction, TeamRowState } from "~/lib/repo-access";

const EXPECTED: Record<TeamRowState, string> = {
  invited: "repo_state_invited",
  access: "repo_state_access",
  pending: "repo_state_pending",
  lapsed: "repo_state_lapsed",
  waiting: "repo_state_waiting",
  retrying: "repo_state_retrying",
  stopped: "repo_state_stopped",
  withdrawn: "repo_state_withdrawn",
  before: "repo_state_before",
  unlisted: "repo_state_unlisted",
};

describe("TeamMemberRow", () => {
  it.each(Object.entries(EXPECTED))("shows the %s line and offers no action", (state, key) => {
    const { container } = render(
      <ul>
        <TeamMemberRow githubId={7} username="ana" role="collaborator" state={state as TeamRowState} error="rate limited" />
      </ul>,
    );
    expect(screen.getByText(key)).toBeTruthy();
    expect(screen.getByText("@ana")).toBeTruthy();
    expect(container.querySelector("button, a")).toBeNull();
    expect(screen.getByText(key).getAttribute("title")).toBe("rate limited");
  });
});

describe("TeamRoute", () => {
  const loaderData = {
    rows: [{ userId: 1, githubId: 7, username: "ana", role: "convenor" as const, state: "access" as const, error: null }],
    invited: [],
    checkedAt: null,
    viewer: { userId: 1, convenor: true },
  };
  const props = { loaderData } as unknown as React.ComponentProps<typeof TeamRoute>;
  beforeEach(() => {
    revalidate.mockClear();
    polled = undefined;
  });

  it("reads again each time the status poll hands it a new answer, and not before", () => {
    const { rerender } = render(<TeamRoute {...props} />);
    expect(revalidate).not.toHaveBeenCalled();
    polled = { repoUnavailable: false };
    rerender(<TeamRoute {...props} />);
    expect(revalidate).toHaveBeenCalledTimes(1);
    rerender(<TeamRoute {...props} />);
    expect(revalidate).toHaveBeenCalledTimes(1);
    polled = { repoUnavailable: false };
    rerender(<TeamRoute {...props} />);
    expect(revalidate).toHaveBeenCalledTimes(2);
  });
});

describe("teamRowActions", () => {
  const convenor = { convenor: true, self: false };
  const member = { convenor: false, self: false };
  it("gives a convenor add, reissue and withdrawal by state", () => {
    expect(teamRowActions({ role: "collaborator", state: "access" }, convenor)).toEqual(["revoke"]);
    expect(teamRowActions({ role: "collaborator", state: "pending" }, convenor)).toEqual(["revoke"]);
    expect(teamRowActions({ role: "collaborator", state: "lapsed" }, convenor)).toEqual(["reissue", "revoke"]);
    for (const state of ["waiting", "retrying", "stopped", "withdrawn", "before"] as const) {
      expect(teamRowActions({ role: "collaborator", state }, convenor)).toEqual(["add"]);
    }
  });
  it("gives an instructor's row no control, for anyone", () => {
    for (const state of ["access", "pending", "lapsed", "unlisted"] as const) {
      expect(teamRowActions({ role: "instructor", state }, convenor)).toEqual([]);
      expect(teamRowActions({ role: "instructor", state }, { convenor: false, self: true })).toEqual([]);
    }
  });
  it("never offers to withdraw the convenor's own access", () => {
    expect(teamRowActions({ role: "convenor", state: "access" }, { convenor: true, self: true })).toEqual([]);
  });
  it("gives a collaborator only Accept, on their own pending row", () => {
    expect(teamRowActions({ role: "collaborator", state: "pending" }, { convenor: false, self: true })).toEqual(["accept"]);
    expect(teamRowActions({ role: "collaborator", state: "pending" }, member)).toEqual([]);
    expect(teamRowActions({ role: "collaborator", state: "lapsed" }, { convenor: false, self: true })).toEqual([]);
    expect(teamRowActions({ role: "collaborator", state: "stopped" }, member)).toEqual([]);
  });
});

describe("TeamMemberRow controls", () => {
  function renderControls(actions: TeamRowAction[], extra: Partial<React.ComponentProps<typeof TeamMemberRow>> = {}) {
    const onAction = vi.fn();
    render(
      <ul>
        <TeamMemberRow githubId={7} username="ana" role="collaborator" state="pending" actions={actions} onAction={onAction} {...extra} />
      </ul>,
    );
    return onAction;
  }

  it("sends an add or an accept on one click", () => {
    const onAction = renderControls(["add", "accept"]);
    fireEvent.click(screen.getByText("repo_action_accept"));
    fireEvent.click(screen.getByText("repo_action_add"));
    expect(onAction.mock.calls).toEqual([["accept"], ["add"]]);
  });

  it("asks once more before withdrawing, and sends nothing on cancel", () => {
    const onAction = renderControls(["revoke"]);
    fireEvent.click(screen.getByText("repo_action_revoke"));
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("repo_action_revoke_cancel"));
    fireEvent.click(screen.getByText("repo_action_revoke"));
    fireEvent.click(screen.getByText("repo_action_revoke_confirm"));
    expect(onAction.mock.calls).toEqual([["revoke"]]);
  });

  it("shows a refused accept with the invitation on GitHub as the fallback", () => {
    renderControls(["accept"], { result: { ok: false, userId: 1, error: "accept_refused", fallbackUrl: "https://github.com/o/r/invitations" } });
    expect(screen.getByRole("alert").textContent).toContain("repo_accept_fallback");
    expect(screen.getByText("repo_accept_fallback_link").getAttribute("href")).toBe("https://github.com/o/r/invitations");
  });

  it("shows a refusal for a state that changed, with no link", () => {
    renderControls(["add"], { result: { ok: false, userId: 1, error: "changed" } });
    expect(screen.getByRole("alert").textContent).toContain("repo_error_changed");
    expect(screen.getByRole("alert").querySelector("a")).toBeNull();
  });

  it("tells an instructor's row and a member's own lapsed row why there is no control", () => {
    const { unmount } = render(<ul><TeamMemberRow githubId={7} username="ines" role="instructor" state="access" /></ul>);
    expect(screen.getByText("repo_instructor_note")).toBeTruthy();
    unmount();
    render(<ul><TeamMemberRow githubId={7} username="ana" role="collaborator" state="lapsed" self /></ul>);
    expect(screen.getByText("repo_own_lapsed")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("the team page's freshness and invite rows", () => {
  it("a row behind the page's check time says it has not been checked, and a current row says nothing", () => {
    const { container } = render(
      <ul>
        <TeamMemberRow githubId={7} username="ana" role="collaborator" state="waiting" behind={{ checkedAt: null }} />
        <TeamMemberRow githubId={8} username="beto" role="collaborator" state="access" behind={null} />
      </ul>,
    );
    expect(container.querySelectorAll("[data-freshness]")).toHaveLength(1);
    expect(screen.getByText("team_page_never_checked")).toBeTruthy();
  });

  it("an outstanding invite link shows the invited line and no control", () => {
    const { container } = render(<ul><TeamInvitedRow /></ul>);
    expect(screen.getByText("repo_state_invited")).toBeTruthy();
    expect(screen.getByText("repo_invite_label")).toBeTruthy();
    expect(container.querySelector("button, a")).toBeNull();
  });
});
