/**
 * StepConnect — repo selection step of the onboarding wizard.
 *
 * Flat list of repos with radio-style selection and client-side search filter.
 * Repo items show owner/name, description, and private badge.
 */

import { useState } from "react";
import { GitBranch, Lock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "~/components/ui/Button";
import type { RepoWithInstallation } from "~/routes/onboarding";

interface StepConnectProps {
  repos: RepoWithInstallation[];
  onSelect: (repo: RepoWithInstallation) => void;
  className?: string;
}

export function StepConnect({ repos, onSelect, className = "" }: StepConnectProps) {
  const { t } = useTranslation("onboarding");
  const [selected, setSelected] = useState<RepoWithInstallation | null>(null);
  const [search, setSearch] = useState("");

  const filtered = repos.filter((repo) =>
    repo.full_name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className={className}>
      <h2 className="font-heading font-semibold text-xl text-charcoal mb-1">
        {t("step_connect.heading")}
      </h2>
      <p className="font-body text-sm text-gray-500 mb-5">
        {t("step_connect.description")}
      </p>

      {/* Search input */}
      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t("step_connect.search_placeholder")}
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-body text-charcoal placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-periwinkle mb-4"
      />

      {/* Repo list */}
      <div className="space-y-2 max-h-72 overflow-y-auto mb-6">
        {filtered.length === 0 ? (
          <p className="text-sm font-body text-gray-500 py-4 text-center">
            {t("step_connect.no_repos")}
          </p>
        ) : (
          filtered.map((repo) => (
            <button
              key={repo.id}
              type="button"
              onClick={() => setSelected(repo)}
              className={`w-full text-left rounded-lg p-3 flex items-start gap-3 hover:bg-gray-50 cursor-pointer transition-colors border ${
                selected?.id === repo.id
                  ? "border-periwinkle bg-periwinkle/10"
                  : "border-transparent"
              }`}
              aria-pressed={selected?.id === repo.id}
            >
              <GitBranch className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" aria-hidden="true" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-heading font-semibold text-sm text-charcoal truncate">
                    {repo.full_name}
                  </span>
                  {repo.private && (
                    <span className="inline-flex items-center gap-1 text-xs font-body text-gray-500 border border-gray-200 rounded px-1.5 py-0.5 flex-shrink-0">
                      <Lock className="w-3 h-3" aria-hidden="true" />
                      Private
                    </span>
                  )}
                </div>
                {repo.description && (
                  <p className="text-xs font-body text-gray-500 mt-0.5 truncate">
                    {repo.description}
                  </p>
                )}
              </div>
            </button>
          ))
        )}
      </div>

      {/* Continue button */}
      <div className="flex justify-end">
        <Button
          variant="primary"
          disabled={!selected}
          onClick={() => selected && onSelect(selected)}
        >
          {t("step_connect.continue")}
        </Button>
      </div>
    </div>
  );
}
