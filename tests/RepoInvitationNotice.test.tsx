/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const submitSpy = vi.fn();
let fetcherState: { state: string; data: unknown } = { state: "idle", data: undefined };
let pollData: unknown;

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return { ...actual, useFetcher: () => ({ submit: submitSpy, load: vi.fn(), ...fetcherState }) };
});
vi.mock("~/hooks/use-github-status-poll", () => ({ useGithubStatusPoll: () => pollData }));

import { RepoInvitationPopover } from "~/components/features/site-status/popovers/RepoInvitationPopover";

const PENDING = { stage: "pending" as const, invitationUrl: "https://github.com/o/r/invitations" };

beforeEach(() => {
  submitSpy.mockClear();
  fetcherState = { state: "idle", data: undefined };
  pollData = undefined;
});

describe("RepoInvitationPopover", () => {
  it("offers Accept for a pending invitation and posts the team page's accept intent", () => {
    render(<RepoInvitationPopover access={PENDING} />);
    fireEvent.click(screen.getByText("repo_invitation.accept"));
    expect(submitSpy).toHaveBeenCalledTimes(1);
    const [target, options] = submitSpy.mock.calls[0];
    expect(target).toMatchObject({ intent: "accept" });
    expect(options).toMatchObject({ method: "post", action: "/team" });
  });

  it("shows the lapsed note and no Accept for a lapsed invitation", () => {
    render(<RepoInvitationPopover access={{ stage: "lapsed", invitationUrl: null }} />);
    expect(screen.getByText("repo_invitation.lapsed")).toBeTruthy();
    expect(screen.queryByText("repo_invitation.accept")).toBeNull();
  });

  it("offers the GitHub link when GitHub refused the accept", () => {
    fetcherState = { state: "idle", data: { ok: false, userId: 1, error: "accept_refused", fallbackUrl: "https://github.com/o/r/invitations/1" } };
    const { container } = render(<RepoInvitationPopover access={PENDING} />);
    expect(screen.getByRole("alert").textContent).toContain("repo_invitation.fallback");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://github.com/o/r/invitations/1");
  });

  it("disables the button while the accept is in flight", () => {
    fetcherState = { state: "submitting", data: undefined };
    render(<RepoInvitationPopover access={PENDING} />);
    expect((screen.getByText("repo_invitation.accept") as HTMLButtonElement).disabled).toBe(true);
  });
});
