// @vitest-environment jsdom
/**
 * This file pins the bug-report trigger's behaviour inside the shared `Header`.
 * The trigger lives in the user menu as a "Report a problem" item, and a
 * standalone header bug button sits to the right of the user menu — so there
 * are now two entry points, both opening the existing BugReportPanel. These
 * assertions pin both, plus the panel-open coverage in its home file
 * (Header.test.tsx does not duplicate it).
 *
 * @version v1.3.0-beta
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Header } from "../app/components/layout/Header";

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
}));

// Header reads the project-switcher data via useRouteLoaderData and renders a
// sign-out <Form>; a plain MemoryRouter is not a data router. Stub the hook and
// Form while keeping the rest of react-router (MemoryRouter, Link) real.
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useRouteLoaderData: () => null,
    Form: ({ children, ...rest }: { children: React.ReactNode }) => (
      <form {...rest}>{children}</form>
    ),
  };
});

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    connectionStatus: "connected",
    isPublishing: false,
    isUpgrading: false,
  }),
}));

vi.mock("~/components/ui/PresenceBar", () => ({
  PresenceBar: () => null,
}));

vi.mock("~/components/ui/ConnectionPill", () => ({
  ConnectionPill: () => null,
}));

// The Site Status pill is a sibling in the right cluster, not under test here.
// Stub it (mirroring PresenceBar / ConnectionPill above) — it consumes
// useRouteLoaderData via useSiteStatus, which a plain MemoryRouter can't supply.
vi.mock("~/components/features/site-status/SiteStatusPill", () => ({
  SiteStatusPill: () => null,
}));

vi.mock("~/hooks/use-toast", () => ({
  useToast: () => ({ showToast: vi.fn(), dismissToast: vi.fn() }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const baseUser = {
  github_id: 123,
  github_login: "testuser",
  github_name: "Test User",
  github_email: "test@example.com",
};

/** Open the user menu, then return the "Report a problem" menu item. */
function openReportItem() {
  const menuButton = screen.getByRole("button", { name: "user_menu_aria" });
  fireEvent.click(menuButton);
  return screen.getByRole("button", { name: "user_menu.report_problem" });
}

describe("Header bug-report trigger (standalone button + user-menu item)", () => {
  it("renders the standalone header bug button (restored to the right of the user menu)", () => {
    render(
      <MemoryRouter>
        <Header user={baseUser} hasProject={true} />
      </MemoryRouter>,
    );
    expect(
      screen.queryByRole("button", { name: "button_aria" }),
    ).not.toBeNull();
  });

  it("renders a 'Report a problem' item inside the user menu", () => {
    render(
      <MemoryRouter>
        <Header user={baseUser} hasProject={true} />
      </MemoryRouter>,
    );
    expect(openReportItem()).not.toBeNull();
  });

  it("clicking 'Report a problem' opens the panel (panel_title appears)", () => {
    render(
      <MemoryRouter>
        <Header user={baseUser} hasProject={true} />
      </MemoryRouter>,
    );
    fireEvent.click(openReportItem());
    expect(screen.queryByText("panel_title")).not.toBeNull();
  });
});
