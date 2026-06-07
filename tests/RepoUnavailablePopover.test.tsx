/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// i18next returns the key path when no instance is initialised; assert on keys.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, opts?: Record<string, unknown>) => (opts?.repo ? `${k}:${opts.repo}` : k) }),
}));

import { RepoUnavailablePopover } from "~/components/features/site-status/popovers/RepoUnavailablePopover";

describe("RepoUnavailablePopover", () => {
  it("names the repo in the body and shows the manage link for convenors", () => {
    const { container } = render(
      <RepoUnavailablePopover repoFullName="owner/repo" userRole="convenor" />,
    );
    // body lead interpolates the repo name
    expect(container.textContent).toContain("owner/repo");
    // convenor sees the manage-access link to GitHub
    const link = container.querySelector("a[href='https://github.com/settings/installations']");
    expect(link).toBeTruthy();
    expect(screen.getByText("repo_unavailable.manage_cta")).toBeTruthy();
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("shows the collaborator note (no link) for collaborators", () => {
    const { container } = render(
      <RepoUnavailablePopover repoFullName="owner/repo" userRole="collaborator" />,
    );
    expect(container.querySelector("a[href='https://github.com/settings/installations']")).toBeNull();
    expect(screen.getByText("repo_unavailable.collaborator_note")).toBeTruthy();
  });

  it("renders without error when repoFullName is null", () => {
    const { container } = render(
      <RepoUnavailablePopover repoFullName={null} userRole="convenor" />,
    );
    const link = container.querySelector("a[href='https://github.com/settings/installations']");
    expect(link).toBeTruthy();
    // body key still renders (with empty repo interpolation)
    expect(container.textContent).toContain("repo_unavailable.body");
  });

  it("falls back to the collaborator branch when userRole is null", () => {
    const { container } = render(
      <RepoUnavailablePopover repoFullName="owner/repo" userRole={null} />,
    );
    expect(container.querySelector("a[href='https://github.com/settings/installations']")).toBeNull();
    expect(screen.getByText("repo_unavailable.collaborator_note")).toBeTruthy();
  });
});
