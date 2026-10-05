// @vitest-environment jsdom
/**
 * The header's project switcher gives way to its neighbours at phone width: its
 * button may shrink below its content and the name truncates, so the pill and
 * the switcher share the bar without one drawn over the other.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return { ...actual, Form: (p: any) => <form>{p.children}</form>, Link: (p: any) => <a>{p.children}</a> };
});

import { ProjectSwitcher } from "~/components/features/header/ProjectSwitcher";

describe("ProjectSwitcher in the header", () => {
  it("lets its button shrink so the name truncates instead of overflowing", () => {
    render(
      <ProjectSwitcher
        allProjects={[{ id: 1, github_repo_full_name: "owner/a-very-long-repository-name", userRole: "convenor" }]}
        activeProjectId={1}
      />,
    );
    const button = screen.getByRole("button");
    expect(button.className).toContain("min-w-0");
    expect(button.parentElement?.className).toMatch(/\bflex\b/);
  });
});
