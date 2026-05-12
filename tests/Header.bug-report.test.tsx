// @vitest-environment jsdom
/**
 * This file pins the bug-report button's placement and behaviour inside the
 * shared `Header` — it must appear after the users-toggle in DOM order so
 * the rightmost icon in the bar is always the report-issue affordance.
 *
 * @version v1.2.0-beta
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

describe("Header bug-report button", () => {
  it("renders a button with aria-label 'button_aria' in the header", () => {
    render(
      <MemoryRouter>
        <Header user={baseUser} hasProject={true} />
      </MemoryRouter>,
    );
    expect(
      screen.queryByRole("button", { name: "button_aria" }),
    ).not.toBeNull();
  });

  it("bug-report button appears AFTER the Users-toggle in DOM order (rightmost position)", () => {
    render(
      <MemoryRouter>
        <Header user={baseUser} hasProject={true} onToggleSidebar={vi.fn()} />
      </MemoryRouter>,
    );
    const bugBtn = screen.getByRole("button", { name: "button_aria" });
    const usersBtn = screen.getByRole("button", {
      name: "sidebar_open_aria",
    });
    expect(
      bugBtn.compareDocumentPosition(usersBtn) &
        Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
  });

  it("clicking the button opens the panel (panel_title appears)", () => {
    render(
      <MemoryRouter>
        <Header user={baseUser} hasProject={true} />
      </MemoryRouter>,
    );
    const bugBtn = screen.getByRole("button", { name: "button_aria" });
    fireEvent.click(bugBtn);
    expect(screen.queryByText("panel_title")).not.toBeNull();
  });
});
