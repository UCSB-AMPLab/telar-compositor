// @vitest-environment jsdom

/**
 * ProjectSwitcher header pill. The switcher lists one row
 * per project from the loader's `allProjects`, marks the active project with a
 * Check, shows a per-project role badge (Convenor / Collaborator), and renders
 * the "Add or remove a repo" footer link pointing to /onboarding?force=1.
 * Switching submits a POST to the existing /dashboard switch-project action.
 *
 * react-router is mocked (Form / Link / useRouteLoaderData) so the component
 * renders without a data-router context; react-i18next is mocked key→string.
 * Fixtures are clearly synthetic — no mock/placeholder owner names from the
 * design reference are rendered as real projects/people.
 *
 * @version v1.3.0-beta
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { ProjectSwitcher } from "../app/components/layout/ProjectSwitcher";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("react-router", () => ({
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
  Link: ({
    children,
    to,
    ...rest
  }: {
    children: React.ReactNode;
    to: string;
  }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useRouteLoaderData: () => null,
}));

const PROJECTS = [
  { id: 1, github_repo_full_name: "fixture-org/alpha-site", userRole: "convenor" as const, collaboratorCount: 2 },
  { id: 2, github_repo_full_name: "fixture-org/beta-site", userRole: "collaborator" as const, collaboratorCount: 3 },
];

function renderSwitcher() {
  return render(
    <ProjectSwitcher allProjects={PROJECTS} activeProjectId={1} open />,
  );
}

describe("ProjectSwitcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders one row per project from allProjects", () => {
    const { container } = renderSwitcher();
    expect(container.textContent).toContain("fixture-org/alpha-site");
    expect(container.textContent).toContain("fixture-org/beta-site");
  });

  it("marks the active project with a Check icon", () => {
    const { container } = renderSwitcher();
    const check = container.querySelector(".lucide-check, [data-active='true']");
    expect(check).not.toBeNull();
  });

  it("renders both role-badge labels (convenor + collaborator) when collaboratorCount > 0", () => {
    const { container } = renderSwitcher();
    expect(container.textContent).toContain("role.convenor");
    expect(container.textContent).toContain("role.collaborator");
  });

  it("hides the role badge for a project with collaboratorCount=0 (solo project)", () => {
    const soloProjects = [
      { id: 1, github_repo_full_name: "fixture-org/solo-site", userRole: "convenor" as const, collaboratorCount: 0 },
    ];
    const { container } = render(
      <ProjectSwitcher allProjects={soloProjects} activeProjectId={1} open />,
    );
    expect(container.textContent).not.toContain("role.convenor");
  });

  it("shows the role badge when collaboratorCount > 0", () => {
    const sharedProjects = [
      { id: 1, github_repo_full_name: "fixture-org/shared-site", userRole: "convenor" as const, collaboratorCount: 1 },
    ];
    const { container } = render(
      <ProjectSwitcher allProjects={sharedProjects} activeProjectId={1} open />,
    );
    expect(container.textContent).toContain("role.convenor");
  });

  it("submits switching via the /dashboard switch-project action", () => {
    const { container } = renderSwitcher();
    // The non-active project (id=2) row is wrapped in a Form targeting /dashboard.
    const form = container.querySelector("form[data-action='/dashboard']");
    expect(form).not.toBeNull();
    const intent = form?.querySelector("input[name='intent']") as HTMLInputElement | null;
    expect(intent?.value).toBe("switch-project");
    const projectId = form?.querySelector("input[name='projectId']") as HTMLInputElement | null;
    expect(projectId?.value).toBe("2");
  });

  it("renders the 'Add or remove a repo' footer link to /onboarding?force=1", () => {
    const { container } = renderSwitcher();
    expect(container.textContent).toContain("add_remove_repo");
    const footer = container.querySelector("a[href='/onboarding?force=1']");
    expect(footer).not.toBeNull();
  });

  it("renders only the active pill without crashing when allProjects is undefined", () => {
    const { container } = render(
      <ProjectSwitcher activeProjectId={1} />,
    );
    // No projects → pill renders (empty active label), no row Forms.
    expect(container.querySelector("form[data-action='/dashboard']")).toBeNull();
  });
});
