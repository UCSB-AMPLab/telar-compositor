// @vitest-environment jsdom
/**
 * ConnectedSitesCard's row "Open" control reproduces the header
 * project switcher's mechanism — a `Form method="post"
 * action="/dashboard"` posting `intent=switch-project` + the row's
 * `projectId` — so opening a row makes that project active and lands on
 * the dashboard action's redirect target, exactly like ProjectSwitcher and
 * StepConnect's own connected-sites rows. No row may link to `/projects/:id`
 * — that route does not exist.
 *
 * react-router is mocked (Form / Link / useFetcher) the same way
 * ConnectedSitesCard-instructor.test.tsx and ProjectSwitcher.test.tsx do —
 * ProjectRow constructs three fetchers per render in a fixed order
 * (delete, ws-count, leave).
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type React from "react";

vi.mock("~/hooks/use-toast", () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>,
}));

vi.mock("react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  Form: ({
    children,
    action,
    method,
  }: {
    children: React.ReactNode;
    action?: string;
    method?: string;
  }) => (
    <form data-action={action} data-method={method}>
      {children}
    </form>
  ),
  useFetcher: vi.fn(() => ({ state: "idle", data: undefined, submit: vi.fn() })),
}));

import { ConnectedSitesCard, type ConnectedSitesProject } from "~/components/features/account/ConnectedSitesCard";

function baseProject(overrides: Partial<ConnectedSitesProject> = {}): ConnectedSitesProject {
  return {
    id: 7,
    title: "owner/repo-site",
    userRole: "collaborator",
    last_edited_at: null,
    collaborator_count: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ConnectedSitesCard — row Open control", () => {
  it("submits intent=switch-project with the row's project id to /dashboard", () => {
    const { container } = render(
      <ConnectedSitesCard
        projects={[baseProject({ id: 7 })]}
        uiLocale="en"
        nowMs={Date.now()}
      />,
    );

    const form = container.querySelector("form[data-action='/dashboard']");
    expect(form).not.toBeNull();
    expect(form?.getAttribute("data-method")).toBe("post");

    const intent = form?.querySelector("input[name='intent']") as HTMLInputElement | null;
    expect(intent?.value).toBe("switch-project");

    const projectId = form?.querySelector("input[name='projectId']") as HTMLInputElement | null;
    expect(projectId?.value).toBe("7");
  });

  it("no longer links to /projects/:id", () => {
    const { container } = render(
      <ConnectedSitesCard
        projects={[baseProject({ id: 7 })]}
        uiLocale="en"
        nowMs={Date.now()}
      />,
    );

    const staleLinks = Array.from(container.querySelectorAll("a")).filter((a) =>
      (a.getAttribute("href") ?? "").startsWith("/projects/"),
    );
    expect(staleLinks).toHaveLength(0);
  });
});

describe("ConnectedSitesCard — course marker and delete label", () => {
  it("marks a site that belongs to a course with the course's name", () => {
    render(
      <ConnectedSitesCard
        projects={[baseProject({ courseName: "Digital Humanities" })]}
        uiLocale="en"
        nowMs={Date.now()}
      />,
    );
    expect(screen.getByText('row_part_of_course:{"course":"Digital Humanities"}')).toBeTruthy();
  });

  it("marks a site outside a course with nothing", () => {
    const { container } = render(
      <ConnectedSitesCard projects={[baseProject({ courseName: null })]} uiLocale="en" nowMs={Date.now()} />,
    );
    expect(container.textContent).not.toContain("row_part_of_course");
  });

  it("labels the delete-project confirmation input with the project-specific label", () => {
    render(
      <ConnectedSitesCard
        projects={[baseProject({ userRole: "convenor" })]}
        uiLocale="en"
        nowMs={Date.now()}
        removeProjectId={7}
      />,
    );
    expect((screen.getByLabelText("delete_project_input_aria") as HTMLInputElement).tagName).toBe("INPUT");
  });
});
