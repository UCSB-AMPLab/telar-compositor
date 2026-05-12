// @vitest-environment jsdom
/**
 * This file pins the RTL contract for the `DangerZoneCard` —
 * the account-settings card that gates account deletion behind
 * a type-to-confirm modal and surfaces solo-convened projects
 * the user must hand off or close before deleting.
 *
 * Three tests covering the component's contract:
 *  1. Gated state (convenedProjects > 0) — disabled Delete account
 *     button, helper text + gated_list_label visible, each convened
 *     project rendered as an inline button that calls
 *     onOpenDeleteProject(id) when clicked.
 *  2. Enabled state (convenedProjects empty) — Delete account button
 *     is enabled (terracotta) and clicking it opens the type-to-confirm
 *     modal (modal title appears in the DOM).
 *  3. Race-guard response — when the fetcher returns
 *     { ok: false, intent: 'delete-account', error: 'convened_projects_exist' },
 *     showToast is called with the danger_zone.race_guard_error key and
 *     type: 'destructive'.
 *
 * @version v1.2.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";

// i18n mock — return the key (plus simple {{var}} interpolation) so
// tests can assert by key, not by EN/ES copy. Trans renders the key.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts === "object") {
        return Object.entries(opts).reduce(
          (acc, [k, v]) => acc.replace(`{{${k}}}`, String(v)),
          key,
        );
      }
      return key;
    },
    i18n: { language: "en" },
  }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>,
}));

// Toast mock — capture showToast calls for Test 3 assertions.
const showToast = vi.fn();
vi.mock("~/hooks/use-toast", () => ({
  useToast: () => ({ showToast, dismissToast: vi.fn() }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Controllable fetcher mock. DangerZoneCard mounts ONE useFetcher
// (delete-account). Reset state/data per test via `currentFetcher`.
type FakeFetcher = {
  state: "idle" | "submitting" | "loading";
  data: unknown;
  submit: ReturnType<typeof vi.fn>;
  Form: React.ComponentType<React.FormHTMLAttributes<HTMLFormElement>>;
};

let currentFetcher: FakeFetcher;

function makeFetcher(): FakeFetcher {
  return {
    state: "idle",
    data: undefined,
    submit: vi.fn(),
    Form: (props) => <form {...props} />,
  };
}

vi.mock("react-router", () => ({
  useFetcher: () => currentFetcher,
}));

import { DangerZoneCard } from "~/components/features/account/DangerZoneCard";

beforeEach(() => {
  showToast.mockClear();
  currentFetcher = makeFetcher();
});

describe("DangerZoneCard", () => {
  it("Test 1: gated state — disabled button + helper text + inline project buttons fire onOpenDeleteProject", () => {
    const onOpenDeleteProject = vi.fn();
    render(
      <DangerZoneCard
        user={{ github_login: "alice" }}
        convenedProjects={[
          { id: 7, title: "alice/site-one" },
          { id: 11, title: "alice/site-two" },
        ]}
        soloConvenedCount={0}
        collaboratorCount={0}
        onOpenDeleteProject={onOpenDeleteProject}
      />,
    );

    // Helper + list-label keys render in the gated state.
    expect(screen.getByText("danger_zone.gated_helper")).toBeTruthy();
    expect(screen.getByText("danger_zone.gated_list_label")).toBeTruthy();

    // The Delete account button is disabled.
    const deleteBtn = screen.getByRole("button", {
      name: "danger_zone.button_label",
    });
    expect((deleteBtn as HTMLButtonElement).disabled).toBe(true);

    // Each convened project renders as an inline button labelled by its
    // title. Clicking one calls onOpenDeleteProject with its id.
    const projectButtons = screen.getAllByRole("button", {
      name: /alice\/site-(one|two)/,
    });
    expect(projectButtons.length).toBe(2);

    fireEvent.click(
      screen.getByRole("button", { name: "alice/site-one" }),
    );
    expect(onOpenDeleteProject).toHaveBeenCalledTimes(1);
    expect(onOpenDeleteProject).toHaveBeenCalledWith(7);

    fireEvent.click(
      screen.getByRole("button", { name: "alice/site-two" }),
    );
    expect(onOpenDeleteProject).toHaveBeenCalledTimes(2);
    expect(onOpenDeleteProject).toHaveBeenLastCalledWith(11);
  });

  it("Test 2: enabled state — terracotta destructive button opens the type-to-confirm modal on click", () => {
    render(
      <DangerZoneCard
        user={{ github_login: "alice" }}
        convenedProjects={[]}
        soloConvenedCount={0}
        collaboratorCount={3}
        onOpenDeleteProject={vi.fn()}
      />,
    );

    // The button is enabled and uses the terracotta destructive style.
    const deleteBtn = screen.getByRole("button", {
      name: "danger_zone.button_label",
    });
    expect((deleteBtn as HTMLButtonElement).disabled).toBe(false);
    expect(deleteBtn.className).toMatch(/bg-terracotta/);

    // Modal is not in the DOM before the click.
    expect(screen.queryByText("danger_zone.modal_title")).toBeNull();

    fireEvent.click(deleteBtn);

    // After clicking, the modal renders — its title key is visible.
    expect(screen.getByText("danger_zone.modal_title")).toBeTruthy();
  });

  it("Test 3: race-guard response — showToast called with race_guard_error + destructive when fetcher returns convened_projects_exist", () => {
    // Pre-arm the fetcher with the race-guard response BEFORE render so
    // the component's effect runs on mount.
    currentFetcher = {
      state: "idle",
      data: {
        ok: false,
        intent: "delete-account",
        error: "convened_projects_exist",
      },
      submit: vi.fn(),
      Form: (props) => <form {...props} />,
    };

    act(() => {
      render(
        <DangerZoneCard
          user={{ github_login: "alice" }}
          convenedProjects={[]}
          soloConvenedCount={0}
          collaboratorCount={0}
          onOpenDeleteProject={vi.fn()}
        />,
      );
    });

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith({
      message: "danger_zone.race_guard_error",
      type: "destructive",
    });
  });

  it("Test 4: enabled state with soloConvenedCount > 0 — opening the modal renders the solo-line copy", () => {
    render(
      <DangerZoneCard
        user={{ github_login: "alice" }}
        convenedProjects={[]}
        soloConvenedCount={2}
        collaboratorCount={1}
        onOpenDeleteProject={vi.fn()}
      />,
    );

    // Open the modal.
    const deleteBtn = screen.getByRole("button", {
      name: "danger_zone.button_label",
    });
    fireEvent.click(deleteBtn);

    // The bodyText is rendered as a single <p> with whitespace-pre-line.
    // i18n mock returns the raw key, so we should see both the
    // modal_body key and the modal_body_solo_line key concatenated in
    // the same node (joined by "\n"). Use a function matcher to find
    // the paragraph carrying both.
    const para = screen.getByText((content) =>
      content.includes("danger_zone.modal_body") &&
      content.includes("danger_zone.modal_body_solo_line"),
    );
    expect(para).toBeTruthy();
  });

  it("Test 5: enabled state with soloConvenedCount === 0 — modal omits the solo-line copy", () => {
    render(
      <DangerZoneCard
        user={{ github_login: "alice" }}
        convenedProjects={[]}
        soloConvenedCount={0}
        collaboratorCount={4}
        onOpenDeleteProject={vi.fn()}
      />,
    );

    const deleteBtn = screen.getByRole("button", {
      name: "danger_zone.button_label",
    });
    fireEvent.click(deleteBtn);

    // modal_body present, modal_body_solo_line absent.
    expect(
      screen.queryByText((content) =>
        content.includes("danger_zone.modal_body_solo_line"),
      ),
    ).toBeNull();
  });
});
