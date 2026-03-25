/**
 * StepConnect — repo selection step of the onboarding wizard.
 *
 * Flat list of repos with radio-style selection and client-side search filter.
 * Already-connected repos show a "Connected" badge and an "Unlink" button
 * instead of being selectable.
 */

import { useState } from "react";
import { useFetcher } from "react-router";
import { GitBranch, Lock, AlertTriangle, Link2Off } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { Button } from "~/components/ui/Button";
import type { RepoWithInstallation } from "~/routes/onboarding";

interface ConnectedProject {
  id: number;
  github_repo_full_name: string;
  onboarding_completed: boolean | null;
}

interface StepConnectProps {
  repos: RepoWithInstallation[];
  connectedProjects: ConnectedProject[];
  onSelect: (repo: RepoWithInstallation) => void;
  githubPlan?: string | null;
  hasInstallations: boolean;
  className?: string;
}

export function StepConnect({ repos, connectedProjects, onSelect, githubPlan, hasInstallations, className = "" }: StepConnectProps) {
  const { t } = useTranslation("onboarding");
  const [selected, setSelected] = useState<RepoWithInstallation | null>(null);
  const [search, setSearch] = useState("");
  const [unlinkTarget, setUnlinkTarget] = useState<ConnectedProject | null>(null);
  const unlinkFetcher = useFetcher();

  const connectedRepoNames = new Set(connectedProjects.map((p) => p.github_repo_full_name));

  const filtered = repos.filter((repo) =>
    repo.full_name.toLowerCase().includes(search.toLowerCase()),
  );

  const isUnlinking = unlinkFetcher.state !== "idle";

  function handleUnlink() {
    if (!unlinkTarget) return;
    unlinkFetcher.submit(
      { intent: "unlink-project", project_id: String(unlinkTarget.id) },
      { method: "post", action: "/onboarding" },
    );
    setUnlinkTarget(null);
  }

  return (
    <div className={className}>
      <h2 className="font-heading font-semibold text-xl text-charcoal mb-1">
        {t("step_connect.heading")}
      </h2>
      <p className="font-body text-sm text-gray-500 mb-5">
        {t("step_connect.description")}
      </p>

      {/* Install app prompt — shown when user has no installations */}
      {!hasInstallations && (
        <div className="border border-amber-200 bg-amber-50 rounded-lg p-5 mb-6 text-center">
          <p className="font-body text-sm text-amber-900 mb-3">
            {t("step_connect.no_installations")}
          </p>
          <a
            href="https://github.com/apps/telar-compositor-dev/installations/new"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 font-heading font-semibold text-sm uppercase tracking-wider bg-charcoal text-white rounded-full px-5 py-2 hover:opacity-90 transition-opacity"
          >
            <GitBranch className="w-4 h-4" />
            {t("step_connect.install_app")}
          </a>
          <p className="font-body text-xs text-amber-700 mt-3">
            {t("step_connect.install_hint")}
          </p>
        </div>
      )}

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
          filtered.map((repo) => {
            const isConnected = connectedRepoNames.has(repo.full_name);
            const connectedProject = isConnected
              ? connectedProjects.find((p) => p.github_repo_full_name === repo.full_name)
              : null;

            if (isConnected) {
              return (
                <div
                  key={repo.id}
                  className="w-full rounded-lg p-3 flex items-start gap-3 border border-transparent bg-gray-50"
                >
                  <GitBranch className="w-4 h-4 text-gray-300 flex-shrink-0 mt-0.5" aria-hidden="true" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-heading font-semibold text-sm text-gray-400 truncate">
                        {repo.full_name}
                      </span>
                      <span className="inline-flex items-center text-xs font-body text-green-700 bg-green-50 border border-green-200 rounded px-1.5 py-0.5 flex-shrink-0">
                        {t("step_connect.connected_badge")}
                      </span>
                      {repo.private && (
                        <span className="inline-flex items-center gap-1 text-xs font-body text-gray-400 border border-gray-200 rounded px-1.5 py-0.5 flex-shrink-0">
                          <Lock className="w-3 h-3" aria-hidden="true" />
                          Private
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => connectedProject && setUnlinkTarget(connectedProject)}
                    disabled={isUnlinking}
                    className="inline-flex items-center gap-1 text-xs font-heading font-semibold uppercase tracking-wider text-red-600 hover:bg-red-50 border border-red-200 rounded-full px-3 py-1 transition-colors flex-shrink-0 cursor-pointer"
                    title={t("step_connect.unlink")}
                  >
                    <Link2Off className="w-3.5 h-3.5" aria-hidden="true" />
                    {t("step_connect.unlink")}
                  </button>
                </div>
              );
            }

            return (
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
            );
          })
        )}
      </div>

      {/* GitHub App installation hint */}
      <p className="font-body text-xs text-gray-400 mb-4">
        <Trans
          i18nKey="step_connect.missing_repo_hint"
          ns="onboarding"
          components={{
            installationsLink: (
              <a
                href="https://github.com/settings/installations"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-gray-600"
              />
            ),
          }}
        />
      </p>

      {/* Private repo + free plan warning */}
      {selected?.private && githubPlan === "free" && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 mb-6">
          <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <p className="font-heading font-semibold text-sm text-charcoal">
              {t("step_connect.private_repo_warning_title")}
            </p>
            <p className="font-body text-xs text-gray-600 mt-1">
              <Trans
                i18nKey="step_connect.private_repo_warning_body"
                ns="onboarding"
                components={{
                  repoSettings: (
                    <a
                      href={`https://github.com/${selected.full_name}/settings`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline text-terracotta hover:text-terracotta/80"
                    />
                  ),
                  studentPack: (
                    <a
                      href="https://education.github.com/pack"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline text-terracotta hover:text-terracotta/80"
                    />
                  ),
                }}
              />
            </p>
          </div>
        </div>
      )}

      {/* Continue button */}
      <div className="flex justify-end">
        <Button
          variant="primary"
          disabled={!selected || (selected.private && githubPlan === "free")}
          onClick={() => selected && onSelect(selected)}
        >
          {t("step_connect.continue")}
        </Button>
      </div>

      {/* Unlink confirmation dialog */}
      {unlinkTarget && (
        <>
          <div className="fixed inset-0 z-40 bg-black/40" onClick={() => setUnlinkTarget(null)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
              <h3 className="font-heading font-semibold text-lg text-charcoal mb-2">
                {t("step_connect.unlink_title")}
              </h3>
              <p className="font-body text-sm text-gray-600 mb-1">
                {t("step_connect.unlink_body", { repo: unlinkTarget.github_repo_full_name, interpolation: { escapeValue: false } })}
              </p>
              <p className="font-body text-sm text-red-600 mb-5">
                {t("step_connect.unlink_warning")}
              </p>
              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setUnlinkTarget(null)}
                  className="inline-flex items-center justify-center border border-gray-200 hover:bg-gray-50 text-charcoal font-heading font-semibold text-sm uppercase tracking-wider rounded-full px-6 py-2.5 transition-colors cursor-pointer"
                >
                  {t("step_connect.unlink_cancel")}
                </button>
                <button
                  type="button"
                  onClick={handleUnlink}
                  className="inline-flex items-center justify-center bg-red-600 hover:bg-red-700 text-white font-heading font-semibold text-sm uppercase tracking-wider rounded-full px-6 py-2.5 transition-colors cursor-pointer"
                >
                  {t("step_connect.unlink_confirm")}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
