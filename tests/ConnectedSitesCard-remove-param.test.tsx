// @vitest-environment jsdom
/**
 * ConnectedSitesCard's `removeProjectId` deep-link handling. When the
 * account page arrives with a target row id (StepConnect's Unlink
 * control lands here via `/account?remove=<id>`), that row's existing
 * removal confirmation opens on first render — the delete-project
 * type-to-confirm flow for a convenor row, the leave-project flow for a
 * collaborator row — and the row scrolls into view. An absent or
 * unmatched id opens nothing.
 *
 * react-router's `useFetcher` is mocked per-call — ProjectRow constructs
 * three fetchers in a fixed order (delete, ws-count, leave), matching the
 * pattern in ConnectedSitesCard-instructor.test.tsx.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
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
  useFetcher: vi.fn(() => {
    // ProjectRow constructs exactly three fetchers per render, in this
    // order: delete, ws-count, leave.
    fetcherCallIndex += 1;
    return { state: "idle", data: undefined, submit: vi.fn() };
  }),
}));

let fetcherCallIndex = 0;

import { ConnectedSitesCard, type ConnectedSitesProject } from "~/components/features/account/ConnectedSitesCard";

function baseProject(overrides: Partial<ConnectedSitesProject> = {}): ConnectedSitesProject {
  return {
    id: 1,
    title: "owner/repo-site",
    userRole: "collaborator",
    last_edited_at: null,
    collaborator_count: 0,
    ...overrides,
  };
}

beforeEach(() => {
  fetcherCallIndex = 0;
  vi.clearAllMocks();
});

describe("ConnectedSitesCard — removeProjectId deep link", () => {
  it("calls onOpenDeleteProject with the row id when removeProjectId matches a convenor row, and scrolls it into view", () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    const onOpenDeleteProject = vi.fn();

    render(
      <ConnectedSitesCard
        projects={[baseProject({ id: 5, userRole: "convenor" })]}
        uiLocale="en"
        nowMs={Date.now()}
        onOpenDeleteProject={onOpenDeleteProject}
        removeProjectId={5}
      />,
    );

    expect(onOpenDeleteProject).toHaveBeenCalledWith(5);
    expect(scrollSpy).toHaveBeenCalled();
  });

  it("opens the leave-project dialog when removeProjectId matches a collaborator row", () => {
    const { container } = render(
      <ConnectedSitesCard
        projects={[baseProject({ id: 9, userRole: "collaborator" })]}
        uiLocale="en"
        nowMs={Date.now()}
        onOpenDeleteProject={vi.fn()}
        removeProjectId={9}
      />,
    );

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("leave_project_title");
  });

  it("opens nothing when removeProjectId is absent or matches no row", () => {
    const onOpenDeleteProject = vi.fn();
    const { container } = render(
      <ConnectedSitesCard
        projects={[
          baseProject({ id: 5, userRole: "convenor" }),
          baseProject({ id: 9, userRole: "collaborator" }),
        ]}
        uiLocale="en"
        nowMs={Date.now()}
        onOpenDeleteProject={onOpenDeleteProject}
        removeProjectId={999}
      />,
    );

    expect(onOpenDeleteProject).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
