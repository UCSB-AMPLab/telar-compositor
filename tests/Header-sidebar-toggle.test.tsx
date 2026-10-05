// @vitest-environment jsdom

/**
 * The collaboration sidebar's toggle says why it is disabled when the session
 * has no project, and while the site is publishing or upgrading.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Header } from "../app/components/layout/Header";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return { ...actual, useRouteLoaderData: () => null, Form: ({ children }: { children: React.ReactNode }) => <form>{children}</form> };
});
const freeze = vi.hoisted(() => ({ isPublishing: false, isUpgrading: false }));
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({ connectionStatus: "connected", ...freeze }),
}));
vi.mock("~/components/ui/PresenceBar", () => ({ PresenceBar: () => null }));
vi.mock("~/components/ui/ConnectionPill", () => ({ ConnectionPill: () => null }));
vi.mock("~/components/features/site-status/SiteStatusPill", () => ({ SiteStatusPill: () => null }));
vi.mock("~/hooks/use-toast", () => ({
  useToast: () => ({ showToast: vi.fn(), dismissToast: vi.fn() }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("~/hooks/use-role", () => ({ useRole: () => "convenor", useIsConvenor: () => true }));

const user = { github_id: 1, github_login: "u", github_name: "U", github_email: "u@example.com" };

const onToggle = vi.fn();

function toggle(hasProject: boolean) {
  render(
    <MemoryRouter>
      <Header user={user} hasProject={hasProject} onToggleSidebar={onToggle} />
    </MemoryRouter>,
  );
  return screen.getByRole("button", { name: "sidebar_open_aria" });
}

describe("Header's collaboration sidebar toggle", () => {
  afterEach(() => {
    cleanup();
    freeze.isPublishing = false;
    freeze.isUpgrading = false;
    onToggle.mockClear();
  });
  it("says why it is disabled while the site is publishing", () => {
    freeze.isPublishing = true;
    const button = toggle(true);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe("sidebar_publishing_tooltip");
  });
  it("says why it is disabled while the site is upgrading", () => {
    freeze.isUpgrading = true;
    const button = toggle(true);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe("sidebar_upgrading_tooltip");
  });
  it("keeps the no-project explanation when there is no project, whatever is running", () => {
    freeze.isPublishing = true;
    expect(toggle(false).getAttribute("title")).toBe("sidebar_disabled_tooltip");
  });
  it("explains itself when there is no project", () => {
    const button = toggle(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe("sidebar_disabled_tooltip");
  });
  it("can be reached by keyboard while frozen, and describes why, without opening", () => {
    freeze.isPublishing = true;
    const button = toggle(true);
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-describedby")).toBe("sidebar-toggle-why");
    expect(document.getElementById("sidebar-toggle-why")?.textContent).toBe("sidebar_publishing_tooltip");
    button.click();
    expect(onToggle).not.toHaveBeenCalled();
  });
  it("carries no tooltip when enabled", () => {
    const button = toggle(true);
    expect(button.getAttribute("aria-disabled")).toBe("false");
    expect(button.hasAttribute("title")).toBe(false);
  });
});
