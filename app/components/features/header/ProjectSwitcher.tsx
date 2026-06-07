/**
 * ProjectSwitcher — the global project switcher pill in the charcoal header.
 * A mono pill shows the active project's repo name; clicking it opens a
 * dropdown listing every accessible project with a per-project role badge and
 * an active-project Check, plus a "+ Add or remove a repo" footer.
 *
 * Switching reuses the existing `/dashboard` switch-project action (a
 * `Form method="post"` with `intent=switch-project` + `projectId`) — no new
 * endpoint. The action validates membership server-side, so a forged projectId
 * cannot switch into a project the user is not a member of.
 *
 * The component tolerates `allProjects` being undefined/empty: it renders the
 * pill with just the active repo name and does not crash. This keeps it
 * independently testable and resilient if rendered before the _app loader's
 * `allProjects` field is present.
 *
 * Copy guard: only the user's real `github_repo_full_name` from the loader is
 * rendered. No mock/placeholder repo or owner names.
 *
 * @version v1.3.0-beta
 */

import { useState } from "react";
import { Form, Link } from "react-router";
import { Check, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface ProjectSwitcherProject {
  id: number;
  github_repo_full_name: string;
  userRole: "convenor" | "collaborator";
  ownerLogin?: string;
  /** Members excluding the owner. When 0, the role badge is hidden — the
   * Convenor/Collaborator distinction has no meaning on a solo project. */
  collaboratorCount?: number;
}

export interface ProjectSwitcherProps {
  allProjects?: ProjectSwitcherProject[];
  activeProjectId: number | null;
  /** Force the dropdown open (testing / controlled use). When omitted, the
   * pill manages its own open state. */
  open?: boolean;
  className?: string;
}

/** Per-project role badge — caracol for convenor, cream-dark for collaborator. */
function RoleBadge({ role }: { role: "convenor" | "collaborator" }) {
  const { t } = useTranslation("common");
  const cls =
    role === "convenor"
      ? "bg-caracol-pale text-caracol"
      : "bg-cream-dark text-charcoal";
  return (
    <span
      className={`inline-flex items-center font-heading font-semibold uppercase rounded-pill ${cls}`}
      style={{ fontSize: "10px", letterSpacing: "0.05em", padding: "3px 9px" }}
    >
      {t(`role.${role}`)}
    </span>
  );
}

export function ProjectSwitcher({
  allProjects,
  activeProjectId,
  open,
  className = "",
}: ProjectSwitcherProps) {
  const { t } = useTranslation("project_switcher");
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = open !== undefined;
  const dropdownOpen = isControlled ? open : internalOpen;

  const projects = allProjects ?? [];
  const activeProject =
    projects.find((p) => p.id === activeProjectId) ?? projects[0] ?? null;
  const activeLabel = activeProject?.github_repo_full_name ?? "";

  const closeDropdown = () => {
    if (!isControlled) setInternalOpen(false);
  };

  return (
    <div className={`relative shrink-0 ${className}`}>
      <button
        type="button"
        onClick={() => setInternalOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 font-mono text-xs text-white hover:bg-white/20 transition-colors max-w-[220px]"
        aria-haspopup="true"
        aria-expanded={dropdownOpen}
      >
        <span className="truncate">{activeLabel}</span>
        <ChevronDown
          className={`w-3.5 h-3.5 shrink-0 transition-transform ${dropdownOpen ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>

      {dropdownOpen && (
        <>
          {/* Fixed-inset backdrop dismiss (ProjectStatusBar pattern). */}
          <div
            className="fixed inset-0 z-40"
            onClick={closeDropdown}
            aria-hidden="true"
          />
          <div
            className="absolute right-0 z-50 min-w-[320px] overflow-hidden rounded-lg bg-surface border border-gray-200"
            style={{
              top: "calc(100% + 6px)",
              padding: "6px 0",
              boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
            }}
          >
            {/* Dropdown header label */}
            <p
              className="font-heading font-semibold uppercase text-fg-muted"
              style={{ fontSize: "10px", letterSpacing: "0.05em", padding: "6px 14px 8px" }}
            >
              {t("header")}
            </p>

            {projects.map((project) => {
              const isActive = project.id === activeProjectId;
              const row = (
                <div
                  className="flex items-center justify-between gap-2"
                  style={{ padding: "8px 14px" }}
                >
                  <span
                    className={`font-body truncate ${isActive ? "text-charcoal font-medium" : "text-charcoal"}`}
                    style={{ fontSize: "13px" }}
                  >
                    {project.github_repo_full_name}
                  </span>
                  <span className="flex items-center gap-2 shrink-0">
                    {/* Hide role badge on solo projects — the Convenor/Collaborator
                        label has no meaning until at least one collaborator exists. */}
                    {(project.collaboratorCount ?? 0) > 0 && (
                      <RoleBadge role={project.userRole} />
                    )}
                    {isActive && (
                      <Check
                        className="w-4 h-4 text-caracol"
                        data-active="true"
                        aria-hidden="true"
                      />
                    )}
                  </span>
                </div>
              );

              if (isActive) {
                // Active row is inert — no submission.
                return (
                  <div key={project.id} aria-current="true">
                    {row}
                  </div>
                );
              }

              return (
                <Form
                  key={project.id}
                  method="post"
                  action="/dashboard"
                  onSubmit={closeDropdown}
                >
                  <input type="hidden" name="intent" value="switch-project" />
                  <input type="hidden" name="projectId" value={project.id} />
                  <button
                    type="submit"
                    className="w-full text-left hover:bg-cream transition-colors cursor-pointer"
                  >
                    {row}
                  </button>
                </Form>
              );
            })}

            <div className="border-t border-gray-200" style={{ margin: "6px 0" }} />
            <Link
              to="/onboarding?force=1"
              onClick={closeDropdown}
              className="block font-body text-anil hover:bg-cream transition-colors"
              style={{ fontSize: "13px", padding: "8px 14px" }}
            >
              {t("add_remove_repo")}
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
