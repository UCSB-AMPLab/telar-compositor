/**
 * ConnectRepoDropdown — project switcher dropdown with active indicator.
 *
 * Shows the current project and all other connected projects.
 * Includes a "Connect new repo" link at the bottom.
 */

import { useState } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";

interface Project {
  id: number;
  github_repo_full_name: string;
}

interface ConnectRepoDropdownProps {
  allProjects: Project[];
  activeProjectId: number;
  onSwitch: (projectId: number) => void;
}

export function ConnectRepoDropdown({
  allProjects,
  activeProjectId,
  onSwitch,
}: ConnectRepoDropdownProps) {
  const { t } = useTranslation("dashboard");
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="px-6 py-2.5 bg-transparent border-2 border-lavender text-charcoal hover:bg-lavender/10 font-heading font-semibold text-sm uppercase tracking-wider rounded-full transition-colors"
      >
        {t("connect_repo_button")} &#9662;
      </button>

      {isOpen && (
        <>
          {/* Click-away backdrop */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />

          {/* Dropdown panel */}
          <div className="absolute top-full right-0 mt-1 z-50 bg-white border border-gray-200 rounded-lg shadow-lg min-w-[240px] overflow-hidden">
            {allProjects.map((project) => (
              <button
                key={project.id}
                type="button"
                onClick={() => {
                  setIsOpen(false);
                  if (project.id !== activeProjectId) {
                    onSwitch(project.id);
                  }
                }}
                className="w-full px-4 py-2.5 font-body text-sm text-gray-900 hover:bg-gray-50 flex items-center justify-between cursor-pointer transition-colors"
              >
                <span className="truncate">{project.github_repo_full_name}</span>
                {project.id === activeProjectId && (
                  <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0 ml-2" />
                )}
              </button>
            ))}

            <div className="border-t border-gray-200 my-1" />

            <Link
              to="/onboarding?force=true"
              onClick={() => setIsOpen(false)}
              className="block px-4 py-2.5 font-body text-sm text-lavender hover:bg-gray-50 transition-colors"
            >
              {t("connect_new_repo")}
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
