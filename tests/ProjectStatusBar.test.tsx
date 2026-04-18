// @vitest-environment jsdom
/**
 * ProjectStatusBar.test.tsx — unit tests for ProjectStatusBar component.
 *
 * Tests: conditional "View site" link rendering based on pagesUrl prop (PUB-06).
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProjectStatusBar } from "~/components/features/dashboard/ProjectStatusBar";

// Mock react-i18next: return key as value for all translations
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// Mock react-router: Link renders as <a>, no navigation needed
vi.mock("react-router", () => ({
  Link: ({
    to,
    children,
    ...props
  }: {
    to: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

// Mock format-relative: return the value or the never label
vi.mock("~/lib/format-relative", () => ({
  formatRelative: (value: string | null, never: string) => value ?? never,
}));

const baseProps = {
  repoName: "user/repo",
  lastPublished: null,
  lastSynced: null,
  unpublishedCount: 0,
  headDiverged: false,
  allProjects: [{ id: 1, github_repo_full_name: "user/repo" }],
  activeProjectId: 1,
  onSwitchProject: vi.fn(),
  onSyncClick: vi.fn(),
};

describe("ProjectStatusBar — pagesUrl (PUB-06)", () => {
  it("renders a 'View site' link when pagesUrl is provided", () => {
    render(
      <ProjectStatusBar
        {...baseProps}
        pagesUrl="https://user.github.io/site"
      />
    );
    const link = screen.getByRole("link", {
      name: /status_bar\.view_site/i,
    });
    expect(link).toBeDefined();
    expect(link.getAttribute("href")).toBe("https://user.github.io/site");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("does not render a view-site link when pagesUrl is null", () => {
    render(<ProjectStatusBar {...baseProps} pagesUrl={null} />);
    const link = screen.queryByRole("link", {
      name: /status_bar\.view_site/i,
    });
    expect(link).toBeNull();
  });

  it("does not render a view-site link when pagesUrl is not provided", () => {
    render(<ProjectStatusBar {...baseProps} />);
    const link = screen.queryByRole("link", {
      name: /status_bar\.view_site/i,
    });
    expect(link).toBeNull();
  });
});
