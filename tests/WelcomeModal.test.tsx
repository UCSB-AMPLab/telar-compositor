/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

const submitSpy = vi.fn();
let fetcherState: { state: string; data: unknown } = { state: "idle", data: undefined };
let pollData: unknown;

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return { ...actual, useFetcher: () => ({ submit: submitSpy, load: vi.fn(), ...fetcherState }) };
});
vi.mock("~/hooks/use-github-status-poll", () => ({ useGithubStatusPoll: () => pollData }));

import { WelcomeModal, type WelcomeModalProps } from "~/components/features/site-status/WelcomeModal";

const PENDING = { stage: "pending" as const, invitationUrl: "https://github.com/o/r/invitations" };
const base: WelcomeModalProps = {
  needsWelcome: true,
  siteId: 7,
  project: "o/r",
  convenor: "Ana",
  loaderAccess: null,
  onReport: vi.fn(),
};

beforeEach(() => {
  submitSpy.mockClear();
  fetcherState = { state: "idle", data: undefined };
  pollData = undefined;
});

describe("WelcomeModal with an invitation to accept", () => {
  it("does one job: the paragraph, the email line, Accept and Later, with no Report or Got it", () => {
    pollData = { ownRepoAccess: PENDING };
    render(<WelcomeModal {...base} />);
    expect(screen.getByText("welcome_added_title")).toBeTruthy();
    expect(screen.getByText("repo_invitation.welcome_body")).toBeTruthy();
    expect(screen.getByText("repo_invitation.welcome_email")).toBeTruthy();
    expect(screen.getByText("repo_invitation.accept")).toBeTruthy();
    expect(screen.getByText("repo_invitation.later")).toBeTruthy();
    expect(screen.queryByText("beta_report")).toBeNull();
    expect(screen.queryByText("beta_ack")).toBeNull();
    expect(screen.queryByText("welcome_added_body")).toBeNull();
  });

  it("shows the invitation from the loader's reading before the poll has answered", () => {
    render(<WelcomeModal {...base} loaderAccess={PENDING} />);
    expect(screen.getByText("repo_invitation.accept")).toBeTruthy();
    expect(screen.queryByText("beta_ack")).toBeNull();
  });

  it("switches to the invitation when the poll answers pending after mount, without a reload", () => {
    const view = render(<WelcomeModal {...base} />);
    expect(screen.getByText("beta_ack")).toBeTruthy();
    pollData = { ownRepoAccess: PENDING };
    view.rerender(<WelcomeModal {...base} />);
    expect(screen.getByText("repo_invitation.accept")).toBeTruthy();
    expect(screen.queryByText("beta_ack")).toBeNull();
  });

  it("posts the accept intent to the team page", () => {
    pollData = { ownRepoAccess: PENDING };
    render(<WelcomeModal {...base} />);
    fireEvent.click(screen.getByText("repo_invitation.accept"));
    expect(submitSpy.mock.calls[0][0]).toMatchObject({ intent: "accept" });
    expect(submitSpy.mock.calls[0][1]).toMatchObject({ action: "/team" });
  });

  it("Later acknowledges the welcome and closes it", () => {
    pollData = { ownRepoAccess: PENDING };
    const { container } = render(<WelcomeModal {...base} />);
    fireEvent.click(screen.getByText("repo_invitation.later"));
    const ack = submitSpy.mock.calls.find((c) => c[1]?.action === "/api/welcome-ack");
    expect(ack).toBeTruthy();
    expect(container.textContent).toBe("");
  });

  it("a successful accept acknowledges once and closes", () => {
    pollData = { ownRepoAccess: PENDING };
    const view = render(<WelcomeModal {...base} />);
    fetcherState = { state: "idle", data: { ok: true, userId: 1 } };
    act(() => view.rerender(<WelcomeModal {...base} />));
    act(() => view.rerender(<WelcomeModal {...base} />));
    const acks = submitSpy.mock.calls.filter((c) => c[1]?.action === "/api/welcome-ack");
    expect(acks).toHaveLength(1);
    expect(view.container.textContent).toBe("");
  });

  it("keeps the modal open and says why when GitHub refused the accept", () => {
    pollData = { ownRepoAccess: PENDING };
    fetcherState = { state: "idle", data: { ok: false, userId: 1, error: "accept_refused", fallbackUrl: "https://github.com/o/r/invitations/1" } };
    render(<WelcomeModal {...base} />);
    expect(screen.getByRole("alert").textContent).toContain("repo_invitation.fallback");
    expect(screen.getByText("repo_invitation.later")).toBeTruthy();
  });

  it("a lapsed invitation shows the lapsed note and Later, with no Accept or email line", () => {
    pollData = { ownRepoAccess: { stage: "lapsed", invitationUrl: null } };
    render(<WelcomeModal {...base} />);
    expect(screen.getByText("repo_invitation.lapsed")).toBeTruthy();
    expect(screen.getByText("repo_invitation.later")).toBeTruthy();
    expect(screen.queryByText("repo_invitation.accept")).toBeNull();
    expect(screen.queryByText("repo_invitation.welcome_email")).toBeNull();
    expect(screen.queryByText("beta_ack")).toBeNull();
  });
});

describe("WelcomeModal with nothing to accept", () => {
  it.each([undefined, { ownRepoAccess: null }, { ownRepoAccess: { stage: "access", invitationUrl: null } }, { ownRepoAccess: { stage: "none", invitationUrl: null } }])(
    "is the plain welcome for %j",
    (poll) => {
      pollData = poll;
      render(<WelcomeModal {...base} />);
      expect(screen.getByText("welcome_added_body")).toBeTruthy();
      expect(screen.getByText("beta_report")).toBeTruthy();
      expect(screen.getByText("beta_ack")).toBeTruthy();
      expect(screen.queryByText("repo_invitation.accept")).toBeNull();
    },
  );

  it("Got it acknowledges and closes", () => {
    const { container } = render(<WelcomeModal {...base} />);
    fireEvent.click(screen.getByText("beta_ack"));
    expect(submitSpy.mock.calls.some((c) => c[1]?.action === "/api/welcome-ack")).toBe(true);
    expect(container.textContent).toBe("");
  });

  it("Report a problem opens the reporter and closes the welcome", () => {
    const onReport = vi.fn();
    const { container } = render(<WelcomeModal {...base} onReport={onReport} />);
    fireEvent.click(screen.getByText("beta_report"));
    expect(onReport).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("");
  });

  it("renders nothing when the loader says no welcome is owed", () => {
    const { container } = render(<WelcomeModal {...base} needsWelcome={false} />);
    expect(container.textContent).toBe("");
  });
});

describe("WelcomeModal when the layout is already mounted", () => {
  it("opens when the loader later answers that a welcome is owed for the project reached", () => {
    const view = render(<WelcomeModal {...base} needsWelcome={false} siteId={3} />);
    expect(view.container.textContent).toBe("");
    view.rerender(<WelcomeModal {...base} needsWelcome siteId={7} />);
    expect(screen.getByText("beta_ack")).toBeTruthy();
  });

  it("keeps each project's welcome closed after the member closes it and switches between projects", () => {
    const view = render(<WelcomeModal {...base} needsWelcome siteId={3} />);
    fireEvent.click(screen.getByRole("dialog").parentElement!);
    view.rerender(<WelcomeModal {...base} needsWelcome siteId={7} />);
    fireEvent.click(screen.getByRole("dialog").parentElement!);
    view.rerender(<WelcomeModal {...base} needsWelcome siteId={3} />);
    expect(view.container.textContent).toBe("");
  });
});
