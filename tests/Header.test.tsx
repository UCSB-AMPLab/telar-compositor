// @vitest-environment jsdom

/**
 * Pins the Header user-menu role chip + "Report a problem" item: the user-menu
 * dropdown shows a role chip (Convenor vs Collaborator per the mocked role)
 * above the divider and a "Report a problem" item.
 *
 * Does NOT duplicate the bug-report-panel-open assertions already pinned in
 * tests/Header.bug-report.test.tsx.
 *
 * @version v1.3.0-beta
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Header } from "../app/components/layout/Header";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en" },
  }),
}));

// Header reads the project-switcher data + activeProjectShared via
// useRouteLoaderData; a plain MemoryRouter is not a data router. Stub the hook
// and Form while keeping the rest of react-router (MemoryRouter, Link) real.
const mockLoaderData = vi.fn<() => { activeProjectShared?: boolean } | null>(() => ({ activeProjectShared: true }));
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useRouteLoaderData: () => mockLoaderData(),
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

vi.mock("~/components/ui/PresenceBar", () => ({ PresenceBar: () => null }));
vi.mock("~/components/ui/ConnectionPill", () => ({ ConnectionPill: () => null }));
vi.mock("~/components/features/site-status/SiteStatusPill", () => ({
  SiteStatusPill: () => null,
}));
vi.mock("~/hooks/use-toast", () => ({
  useToast: () => ({ showToast: vi.fn(), dismissToast: vi.fn() }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Role drives the chip label. Default convenor; tests override.
const mockRole = vi.fn(() => "convenor");
vi.mock("~/hooks/use-role", () => ({
  useRole: () => mockRole(),
  useIsConvenor: () => mockRole() === "convenor",
}));

const baseUser = {
  github_id: 123,
  github_login: "testuser",
  github_name: "Test User",
  github_email: "test@example.com",
};

function renderHeaderMenuOpen() {
  const result = render(
    <MemoryRouter>
      <Header user={baseUser} hasProject={true} />
    </MemoryRouter>,
  );
  // Open the user-menu dropdown.
  const menuButton = screen.getByRole("button", { name: "user_menu_aria" });
  fireEvent.click(menuButton);
  return result;
}

describe("Header user menu — role chip + report item", () => {
  beforeEach(() => {
    mockRole.mockReturnValue("convenor");
    mockLoaderData.mockReturnValue({ activeProjectShared: true });
  });

  it("renders the Convenor role chip when role is convenor and project is shared", () => {
    mockRole.mockReturnValue("convenor");
    mockLoaderData.mockReturnValue({ activeProjectShared: true });
    const { container } = renderHeaderMenuOpen();
    expect(container.textContent).toContain("role.convenor");
  });

  it("renders the Collaborator role chip when role is collaborator and project is shared", () => {
    mockRole.mockReturnValue("collaborator");
    mockLoaderData.mockReturnValue({ activeProjectShared: true });
    const { container } = renderHeaderMenuOpen();
    expect(container.textContent).toContain("role.collaborator");
  });

  it("hides the role chip when activeProjectShared is false (solo project)", () => {
    mockRole.mockReturnValue("convenor");
    mockLoaderData.mockReturnValue({ activeProjectShared: false });
    const { container } = renderHeaderMenuOpen();
    expect(container.textContent).not.toContain("role.convenor");
  });

  it("hides the role chip when loader data is null (no project)", () => {
    mockRole.mockReturnValue("convenor");
    mockLoaderData.mockReturnValue(null);
    const { container } = renderHeaderMenuOpen();
    expect(container.textContent).not.toContain("role.convenor");
  });

  it("renders a 'Report a problem' item in the user menu", () => {
    const { container } = renderHeaderMenuOpen();
    expect(container.textContent).toContain("user_menu.report_problem");
  });
});
