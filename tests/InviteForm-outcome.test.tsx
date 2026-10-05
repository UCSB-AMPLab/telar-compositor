// @vitest-environment jsdom
/**
 * What the invite form says happened.
 *
 * The search runs against GitHub, so the person it finds usually has no
 * Compositor account, and `send-invite` answers that case by minting a
 * 48-hour link rather than writing a membership row. Nothing in the
 * Compositor sends mail, so that link is the whole of the invitation — and
 * the form read `generateFetcher.data?.inviteUrl` and nothing else, dropping
 * it at the point of receipt. The invitation existed in D1, showed in the
 * panel as pending, and could never reach the person it named.
 *
 * The refusals were silent in the same way, which made all three outcomes —
 * row written, link to hand over, refused — render identically: as nothing.
 *
 * The clipboard cases matter because the clipboard is the part that is not
 * the Compositor's to guarantee. It is absent outside a secure context and
 * refuses on a page without focus, and neither may be what decides whether
 * the invitation is legible.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

// Keys and interpolations both survive, so an assertion can name the sentence
// AND the person it is about.
vi.mock("react-i18next", () => ({
  useTranslation: (_ns?: string | string[]) => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
    i18n: { language: "en" },
  }),
}));

// Every useFetcher() in the form is served the same response. That is the
// point rather than a shortcut: each effect guards on the intent its own
// fetcher was given, so a response meant for one half of the form must not be
// read by the other.
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
}));

import { InviteForm } from "~/components/features/dashboard/InviteForm";

/** Render the form and open it — it starts collapsed behind one button. */
function renderExpanded() {
  const view = render(<InviteForm projectId={1} isOwner={true} />);
  fireEvent.click(screen.getByRole("button", { name: /invite_button/ }));
  return view;
}

/** The outcome line, or null while the form has nothing to report. */
function outcome(): string | null {
  return screen.queryByRole("status")?.textContent ?? null;
}

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", {
    value,
    configurable: true,
    writable: true,
  });
}

const ORIGINAL_CLIPBOARD = Object.getOwnPropertyDescriptor(navigator, "clipboard");

beforeEach(() => {
  response = undefined;
  setClipboard({ writeText: vi.fn(() => Promise.resolve()) });
});

afterEach(() => {
  if (ORIGINAL_CLIPBOARD) Object.defineProperty(navigator, "clipboard", ORIGINAL_CLIPBOARD);
});

describe("an invite that produced a membership row", () => {
  it("names the person who is now in the project", () => {
    response = { ok: true, intent: "send-invite", added: true, username: "beto" };
    renderExpanded();

    expect(outcome()).toContain("invite_added");
    expect(outcome()).toContain("beto");
  });
});

describe("an invite that produced a link", () => {
  it("copies the link and says who it is for", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    setClipboard({ writeText });
    response = {
      ok: true,
      intent: "send-invite",
      added: false,
      inviteUrl: "https://compositor.telar.org/invite/tok-1",
      username: "beto",
    };
    renderExpanded();

    await waitFor(() => expect(outcome()).toContain("invite_link_copied"));
    expect(writeText).toHaveBeenCalledWith("https://compositor.telar.org/invite/tok-1");
    expect(outcome()).toContain("beto");
  });

  it("shows the link itself when the clipboard refuses it", async () => {
    setClipboard({ writeText: vi.fn(() => Promise.reject(new Error("denied"))) });
    response = {
      ok: true,
      intent: "send-invite",
      added: false,
      inviteUrl: "https://compositor.telar.org/invite/tok-2",
      username: "beto",
    };
    renderExpanded();

    await waitFor(() => expect(outcome()).toContain("invite_link_manual"));
    expect(outcome()).toContain("https://compositor.telar.org/invite/tok-2");
  });

  it("shows the link itself where there is no clipboard to reach", async () => {
    // Outside a secure context `navigator.clipboard` is undefined, and
    // reading `.writeText` throws rather than rejecting — inside an effect
    // that reaches the error boundary and takes the panel down over a copy.
    setClipboard(undefined);
    response = {
      ok: true,
      intent: "send-invite",
      added: false,
      inviteUrl: "https://compositor.telar.org/invite/tok-3",
      username: "beto",
    };
    renderExpanded();

    await waitFor(() => expect(outcome()).toContain("invite_link_manual"));
    expect(outcome()).toContain("https://compositor.telar.org/invite/tok-3");
  });
});

describe("an invite the server refused", () => {
  it("says the attempt failed rather than settling like a success", () => {
    response = { ok: false, intent: "send-invite", error: "no_project" };
    renderExpanded();

    expect(outcome()).toContain("error_invite_failed");
  });

  it("gives a course its own explanation, which names what to do instead", () => {
    response = { ok: false, intent: "send-invite", error: "invite_refused_course" };
    renderExpanded();

    expect(outcome()).toContain("invite_refused_course");
  });

  it("reports a refusal it has no sentence for rather than none at all", () => {
    response = { ok: false, intent: "send-invite", error: "something_added_later" };
    renderExpanded();

    expect(outcome()).toContain("error_invite_failed");
  });
});

describe("the share-link half of the form", () => {
  it("reports its own refusal", () => {
    response = { ok: false, intent: "generate-invite", error: "invite_refused_course" };
    renderExpanded();

    expect(outcome()).toContain("invite_refused_course");
  });

  it("does not have its response read as an invite outcome", async () => {
    // Both halves post to the same action and hold their own fetcher, so
    // without the intent guard a generated link would be reported as though
    // somebody had been invited — naming a person the response never carried.
    const writeText = vi.fn(() => Promise.resolve());
    setClipboard({ writeText });
    response = {
      ok: true,
      intent: "generate-invite",
      inviteUrl: "https://compositor.telar.org/invite/tok-4",
    };
    renderExpanded();

    await waitFor(() => expect(screen.getByText("link_copied")).toBeTruthy());
    expect(outcome()).toBeNull();
  });
});

describe("the form with nothing behind it", () => {
  it("renders nothing at all for a collaborator", () => {
    const { container } = render(<InviteForm projectId={1} isOwner={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("reports nothing before anything has been asked", () => {
    renderExpanded();
    expect(outcome()).toBeNull();
  });
});
