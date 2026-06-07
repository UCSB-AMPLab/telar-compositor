/**
 * ProjectStatusBar — repo bar with detailed sync/publish timestamps and the
 * project switcher.
 *
 * Layout: [ repo-name | synced-timestamp | published-timestamp | switch-repos ▾ ]
 *
 * The sync/publish status chip (out_of_sync / unpublished / up_to_date) that
 * used to live here was retired — that signal now lives in the Site Status
 * pill (Header). The repo name, timestamps, and switcher remain here.
 */

import { useState } from "react";
import { Link } from "react-router";
import { Github, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useRelativeTime } from "~/lib/use-relative-time";

interface Project {
  id: number;
  github_repo_full_name: string;
}

interface ProjectStatusBarProps {
  repoName: string;
  lastPublished: string | null;
  lastSynced: string | null;
  allProjects: Project[];
  activeProjectId: number;
  onSwitchProject: (projectId: number) => void;
  className?: string;
}

export function ProjectStatusBar({
  repoName,
  lastPublished,
  lastSynced,
  allProjects,
  activeProjectId,
  onSwitchProject,
  className = "",
}: ProjectStatusBarProps) {
  const { t } = useTranslation("dashboard");
  const neverLabel = t("status_bar.never");
  const [dropdownOpen, setDropdownOpen] = useState(false);

  // Client-only relative timestamps (see useRelativeTime). A present timestamp
  // shows empty until mount; a null one shows the neverLabel immediately.
  const syncedRelative = useRelativeTime(lastSynced, neverLabel);
  const publishedRelative = useRelativeTime(lastPublished, neverLabel);

  return (
    <div
      className={`bg-white rounded-lg border border-gray-100 px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm font-body ${className}`}
    >
      {/* Repo name — links to GitHub */}
      <a
        href={`https://github.com/${repoName}`}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t("status_bar.view_on_github")}
        title={t("status_bar.view_on_github")}
        className="flex items-center gap-2 text-charcoal font-medium shrink-0 hover:underline"
      >
        <Github className="w-4 h-4 text-gray-400" />
        <span>{repoName}</span>
      </a>

      {/* Timestamps */}
      <div className="flex items-center gap-6 text-gray-500">
        <div className="flex flex-col items-start sm:flex-row sm:items-center sm:gap-1">
          <span className="text-xs text-gray-400">{t("status_bar.last_synced")}:</span>
          <span className="text-xs font-medium">{syncedRelative}</span>
        </div>
        <div className="flex flex-col items-start sm:flex-row sm:items-center sm:gap-1">
          <span className="text-xs text-gray-400">{t("status_bar.last_published")}:</span>
          <span className="text-xs font-medium">{publishedRelative}</span>
        </div>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Switch/add/remove repos dropdown */}
      <div className="relative shrink-0">
        <button
          type="button"
          onClick={() => setDropdownOpen((prev) => !prev)}
          className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-charcoal transition-colors"
        >
          {t("status_bar.manage_repos")}
          <ChevronDown className="w-3 h-3" />
        </button>

        {dropdownOpen && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => setDropdownOpen(false)}
            />
            <div className="absolute top-full right-0 mt-1 z-50 bg-white border border-gray-200 rounded-lg shadow-lg min-w-[240px] overflow-hidden">
              {allProjects.map((project) => {
                const isActive = project.id === activeProjectId;
                return (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => {
                      setDropdownOpen(false);
                      if (!isActive) onSwitchProject(project.id);
                    }}
                    className={`w-full px-4 py-2.5 font-body text-sm hover:bg-gray-50 flex items-center justify-between text-left cursor-pointer transition-colors ${isActive ? "text-charcoal font-medium" : "text-gray-600"}`}
                  >
                    <span className="truncate">{project.github_repo_full_name}</span>
                    {isActive && (
                      <span className="text-xs text-gray-400 ml-2 shrink-0">{t("status_bar.current")}</span>
                    )}
                  </button>
                );
              })}
              <div className="border-t border-gray-200 my-1" />
              <Link
                to="/onboarding?force=1"
                onClick={() => setDropdownOpen(false)}
                className="block px-4 py-2.5 font-body text-sm text-anil hover:bg-gray-50 transition-colors"
              >
                {t("connect_new_repo")}
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
