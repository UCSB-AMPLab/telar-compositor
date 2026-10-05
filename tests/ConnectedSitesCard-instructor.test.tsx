// @vitest-environment jsdom
/**
 * ConnectedSitesCard's instructor handling: the role badge renders
 * "Docente"/"Instructor" rather than falling through to the collaborator
 * label, and a leave attempt refused because the row is an instructor on a
 * course-enrolled child project (design §5) surfaces its own explanatory
 * toast (`leave_refused_instructor`) instead of the generic failure copy.
 *
 * react-router's `useFetcher` is mocked per-call — ProjectRow constructs
 * three fetchers in a fixed order (delete, ws-count, leave), so the
 * leave-fetcher's return is queued third.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import type React from "react";

const showToastMock = vi.fn();
vi.mock("~/hooks/use-toast", () => ({
  useToast: () => ({ showToast: showToastMock }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>,
}));

let leaveFetcherReturn: { state: string; data: unknown; submit: ReturnType<typeof vi.fn> };

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
    // order: delete, ws-count, leave. A module-scoped counter distinguishes
    // them since react-router's real hook has no such concept.
    fetcherCallIndex += 1;
    if (fetcherCallIndex % 3 === 0) return leaveFetcherReturn;
    return { state: "idle", data: undefined, submit: vi.fn() };
  }),
}));

let fetcherCallIndex = 0;

import { ConnectedSitesCard, type ConnectedSitesProject } from "~/components/features/account/ConnectedSitesCard";

function baseProject(overrides: Partial<ConnectedSitesProject> = {}): ConnectedSitesProject {
  return {
    id: 1,
    title: "owner/course-site",
    userRole: "collaborator",
    last_edited_at: null,
    collaborator_count: 0,
    ...overrides,
  };
}

beforeEach(() => {
  fetcherCallIndex = 0;
  showToastMock.mockClear();
  leaveFetcherReturn = { state: "idle", data: undefined, submit: vi.fn() };
});

describe("ConnectedSitesCard — instructor role label", () => {
  it("renders the instructor role label, not the collaborator label, when collaborator_count > 0", () => {
    const { container } = render(
      <ConnectedSitesCard
        projects={[baseProject({ userRole: "instructor", collaborator_count: 1 })]}
        uiLocale="en"
        nowMs={Date.now()}
      />,
    );
    expect(container.textContent).toContain("role_instructor");
    expect(container.textContent).not.toContain("role_collaborator");
  });

  it("still renders the collaborator role label for an actual collaborator row", () => {
    const { container } = render(
      <ConnectedSitesCard
        projects={[baseProject({ userRole: "collaborator", collaborator_count: 1 })]}
        uiLocale="en"
        nowMs={Date.now()}
      />,
    );
    expect(container.textContent).toContain("role_collaborator");
    expect(container.textContent).not.toContain("role_instructor");
  });
});

describe("ConnectedSitesCard — leave-project instructor-on-child refusal toast", () => {
  it("shows leave_refused_instructor when the fetcher reports error: 'instructor_on_child'", () => {
    leaveFetcherReturn = {
      state: "idle",
      data: { ok: false, intent: "leave-project", error: "instructor_on_child" },
      submit: vi.fn(),
    };
    render(
      <ConnectedSitesCard
        projects={[baseProject({ userRole: "instructor", collaborator_count: 1 })]}
        uiLocale="en"
        nowMs={Date.now()}
      />,
    );
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: "leave_refused_instructor" }),
    );
  });

  it("falls back to the generic failure copy for any other leave-project error", () => {
    leaveFetcherReturn = {
      state: "idle",
      data: { ok: false, intent: "leave-project", error: "something_else" },
      submit: vi.fn(),
    };
    render(
      <ConnectedSitesCard
        projects={[baseProject({ userRole: "collaborator", collaborator_count: 1 })]}
        uiLocale="en"
        nowMs={Date.now()}
      />,
    );
    const messages = showToastMock.mock.calls.map((c) => c[0]?.message);
    expect(messages).toContain("leave_project_toast_failure");
    expect(messages).not.toContain("leave_refused_instructor");
  });
});
