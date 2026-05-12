/**
 * This file renders the Connect step of the onboarding wizard —
 * the repo-selection screen where the user picks which GitHub repo
 * to bring into the compositor (or creates a new one).
 *
 * Flat list of repos with radio-style selection and client-side
 * search filter. Already-connected repos show a "Connected" badge
 * and an "Unlink" button instead of being selectable.
 *
 * @version v1.2.0-beta
 */

import { useMemo, useState } from "react";
import { useFetcher, Form, Link } from "react-router";
import { GitBranch, Lock, AlertTriangle, Link2Off, Plus, X, ArrowRight, Play } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { Button } from "~/components/ui/Button";
import { CreateSiteForm } from "./CreateSiteForm";
import { InstallationScopePrompt } from "./InstallationScopePrompt";
import type { RepoWithInstallation } from "~/routes/onboarding";
import type { Installation } from "~/lib/github.server";

interface ConnectedProject {
  id: number;
  github_repo_full_name: string;
  onboarding_completed: boolean | null;
}

interface StepConnectProps {
  repos: RepoWithInstallation[];
  installations: Installation[];
  userLogin: string;
  connectedProjects: ConnectedProject[];
  orphanRepoNames?: string[];
  onSelect: (repo: RepoWithInstallation) => void;
  githubPlan?: string | null;
  hasInstallations: boolean;
  githubAppSlug: string;
  // Scope-block state lifted to WizardShell parent.
  // `scopeBlocked` is the repo whose pre-check returned `inScope:false`;
  // when set, the InstallationScopePrompt renders inside the slot below.
  // `onScopeResolved` is called when the user grants access via the
  // prompt's poll (parent clears state + retries import).
  // `isCheckingScope` drives the Continue button's loading spinner while
  // the pre-check is in flight.
  scopeBlocked?: RepoWithInstallation | null;
  onScopeResolved?: (repo: RepoWithInstallation) => void;
  isCheckingScope?: boolean;
  className?: string;
}

interface InstallationOption {
  installationId: number;
  owner: string;
  targetType: "User" | "Organization";
  isOwnAccount: boolean;
}

export function StepConnect({
  repos,
  installations,
  userLogin,
  connectedProjects,
  orphanRepoNames = [],
  onSelect,
  githubPlan,
  hasInstallations,
  githubAppSlug,
  scopeBlocked = null,
  onScopeResolved,
  isCheckingScope = false,
  className = "",
}: StepConnectProps) {
  const { t } = useTranslation("onboarding");
  const [selected, setSelected] = useState<RepoWithInstallation | null>(null);
  const [search, setSearch] = useState("");
  const [unlinkTarget, setUnlinkTarget] = useState<ConnectedProject | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "create">("list");
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  // `scopeBlocked` state lives in WizardShell now —
  // received as a prop and rendered in the existing slot below.
  const unlinkFetcher = useFetcher();

  // Build installation options from the loader's `installations` payload so we
  // know each installation's target_type ("User" vs "Organization") and can
  // identify the user's own personal account. The default selection always
  // prefers the user's personal account when one exists; switching to an
  // organisation requires opening the account modal explicitly.
  //
  // Filter rule: include the user's own personal account and any organisation
  // installations the user belongs to. EXCLUDE other users' personal accounts
  // (`target_type === "User"` with a non-matching login) — those installations
  // exist when the user has collaborator access to a repo in someone else's
  // account, but creating a repo there will always fail because only the
  // account owner can create on their own behalf. Showing them in the picker
  // produces an unwinnable choice.
  const installationOptions = useMemo<InstallationOption[]>(() => {
    return installations
      .filter((inst) => {
        if (inst.target_type === "Organization") return true;
        return inst.target_type === "User" && inst.account.login === userLogin;
      })
      .map((inst) => ({
        installationId: inst.id,
        owner: inst.account.login,
        targetType: inst.target_type,
        isOwnAccount: inst.target_type === "User" && inst.account.login === userLogin,
      }));
  }, [installations, userLogin]);
  const defaultInstallationId =
    installationOptions.find((o) => o.isOwnAccount)?.installationId ??
    installationOptions[0]?.installationId ??
    null;
  const [createInstallationId, setCreateInstallationId] = useState<number | null>(
    defaultInstallationId,
  );
  const activeInstallation =
    installationOptions.find((o) => o.installationId === createInstallationId) ??
    installationOptions.find((o) => o.isOwnAccount) ??
    installationOptions[0] ??
    null;

  const connectedRepoNames = new Set(connectedProjects.map((p) => p.github_repo_full_name));
  const orphanRepoNameSet = useMemo(() => new Set(orphanRepoNames), [orphanRepoNames]);

  const filtered = repos.filter(
    (repo) =>
      !connectedRepoNames.has(repo.full_name) &&
      repo.full_name.toLowerCase().includes(search.toLowerCase()),
  );

  const hasConnectedSites = connectedProjects.length >= 1;

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

      {/* Create-site view — replaces search + repo list when active */}
      {viewMode === "create" && activeInstallation && (
        <>
          {/* Account picker line. Defaults to the user's personal account; the
              "Change" link only appears when there is more than one
              installation. Tapping it opens the account modal. */}
          <div className="mb-4 flex items-center gap-2 text-sm font-body text-charcoal">
            <span className="text-gray-500">{t("create_site.account_picker.creating_in")}:</span>
            <span className="font-semibold">{activeInstallation.owner}</span>
            {activeInstallation.isOwnAccount && (
              <span className="text-gray-500">({t("create_site.account_picker.your_account")})</span>
            )}
            {installationOptions.length > 1 && (
              <button
                type="button"
                onClick={() => setAccountModalOpen(true)}
                className="ml-auto font-heading font-semibold text-xs uppercase tracking-wider text-charcoal underline decoration-dotted underline-offset-4 hover:text-terracotta transition-colors"
              >
                {t("create_site.account_picker.change")}
              </button>
            )}
          </div>
          <CreateSiteForm
            owner={activeInstallation.owner}
            installationId={activeInstallation.installationId}
            onSelect={onSelect}
            onBack={() => setViewMode("list")}
          />
        </>
      )}

      {/* Account selection modal — only opens when the user explicitly clicks
          "Change" on the account picker line. Required by smoke-test feedback:
          users must make a deliberate choice to create a site outside their
          own account. */}
      {accountModalOpen && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4"
          onClick={() => setAccountModalOpen(false)}
          role="presentation"
        >
          <div
            className="bg-cream rounded-2xl shadow-2xl max-w-md w-full p-6"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-modal-title"
          >
            <div className="flex items-start justify-between mb-2">
              <h3 id="account-modal-title" className="font-heading font-semibold text-lg text-charcoal">
                {t("create_site.account_modal.title")}
              </h3>
              <button
                type="button"
                onClick={() => setAccountModalOpen(false)}
                className="text-gray-400 hover:text-charcoal transition-colors"
                aria-label={t("create_site.account_modal.cancel")}
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="font-body text-sm text-gray-500 mb-4">
              {t("create_site.account_modal.description")}
            </p>
            <ul className="flex flex-col gap-2 mb-4">
              {installationOptions.map((opt) => {
                const isActive = opt.installationId === activeInstallation.installationId;
                return (
                  <li key={opt.installationId}>
                    <button
                      type="button"
                      onClick={() => {
                        setCreateInstallationId(opt.installationId);
                        setAccountModalOpen(false);
                      }}
                      className={`w-full flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-left transition-colors ${
                        isActive
                          ? "border-terracotta bg-periwinkle/20"
                          : "border-gray-200 hover:border-charcoal hover:bg-cream-dark"
                      }`}
                    >
                      <div className="flex flex-col">
                        <span className="font-body font-semibold text-sm text-charcoal">{opt.owner}</span>
                        <span className="font-body text-xs text-gray-500">
                          {opt.isOwnAccount
                            ? t("create_site.account_modal.your_account_label")
                            : t("create_site.account_modal.organization_label")}
                        </span>
                      </div>
                      {isActive && <span className="w-2 h-2 rounded-full bg-terracotta" aria-hidden="true" />}
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="flex justify-end">
              <Button variant="secondary" onClick={() => setAccountModalOpen(false)}>
                {t("create_site.account_modal.cancel")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Scope-blocked fallback for the normal connect flow. Copy is
          namespaced under `step_connect.installation_scope.*` per the
          per-consumer-fork decision (the original
          `create_site.installation_scope.body` says "your new repository"
          which is inaccurate when picking an existing repo). */}
      {viewMode === "list" && scopeBlocked && (
        <InstallationScopePrompt
          installationId={scopeBlocked.installationId}
          owner={scopeBlocked.owner.login}
          repoName={scopeBlocked.name}
          i18nKeyPrefix="step_connect.installation_scope"
          onResolved={() => {
            if (onScopeResolved) onScopeResolved(scopeBlocked);
          }}
          className="mb-6"
        />
      )}

      {/* Install app prompt — shown when user has no installations */}
      {viewMode === "list" && !scopeBlocked && !hasInstallations && (
        <div className="border border-amber-200 bg-amber-50 rounded-lg p-5 mb-6 text-center">
          <p className="font-body text-sm text-amber-900 mb-3">
            {t("step_connect.no_installations")}
          </p>
          <a
            href={`https://github.com/apps/${githubAppSlug}/installations/new`}
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

      {viewMode === "list" && !scopeBlocked && hasInstallations && (
      <>
      {/* Your connected sites — only rendered when the user has at least one
          project. Surfaces Open / Resume / Unlink per row so the user can
          manage existing sites without leaving the onboarding surface. */}
      {hasConnectedSites && (
        <section className="mb-6">
          <h3 className="font-heading font-semibold text-sm uppercase tracking-wider text-charcoal mb-2">
            {t("step_connect.your_sites_heading")}
          </h3>
          <ul className="space-y-2">
            {connectedProjects.map((project) => {
              const isComplete = project.onboarding_completed === true;
              return (
                <li
                  key={project.id}
                  className="rounded-lg border border-gray-200 bg-white p-3 flex items-center gap-3"
                >
                  <GitBranch className="w-4 h-4 text-gray-400 flex-shrink-0" aria-hidden="true" />
                  <div className="flex-1 min-w-0 flex items-center gap-2">
                    <span className="font-heading font-semibold text-sm text-charcoal truncate">
                      {project.github_repo_full_name}
                    </span>
                    {!isComplete && (
                      <span className="inline-flex items-center text-xs font-body text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 flex-shrink-0">
                        {t("step_connect.status_incomplete")}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {isComplete ? (
                      <Form method="post" action="/dashboard">
                        <input type="hidden" name="intent" value="switch-project" />
                        <input type="hidden" name="projectId" value={project.id} />
                        <button
                          type="submit"
                          className="inline-flex items-center gap-1 text-xs font-heading font-semibold uppercase tracking-wider text-charcoal hover:bg-gray-50 border border-gray-200 rounded-full px-3 py-1 transition-colors cursor-pointer"
                        >
                          {t("step_connect.open")}
                          <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                      </Form>
                    ) : (
                      <Link
                        to={`/onboarding?resume=${project.id}`}
                        className="inline-flex items-center gap-1 text-xs font-heading font-semibold uppercase tracking-wider text-charcoal hover:bg-gray-50 border border-gray-200 rounded-full px-3 py-1 transition-colors cursor-pointer"
                      >
                        <Play className="w-3.5 h-3.5" aria-hidden="true" />
                        {t("step_connect.resume")}
                      </Link>
                    )}
                    <button
                      type="button"
                      onClick={() => setUnlinkTarget(project)}
                      disabled={isUnlinking}
                      className="inline-flex items-center gap-1 text-xs font-heading font-semibold uppercase tracking-wider text-red-600 hover:bg-red-50 border border-red-200 rounded-full px-3 py-1 transition-colors cursor-pointer"
                      title={t("step_connect.unlink")}
                    >
                      <Link2Off className="w-3.5 h-3.5" aria-hidden="true" />
                      {t("step_connect.unlink")}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* "Add another site" heading — only shown when the connected-sites
          section above is rendered, so first-time users see the original
          uncluttered layout. */}
      {hasConnectedSites && (
        <h3 className="font-heading font-semibold text-sm uppercase tracking-wider text-charcoal mb-3">
          {t("step_connect.add_another_heading")}
        </h3>
      )}

      {/* Create-new-site CTA — sits above the search input. */}
      <div className="mb-4">
        <Button variant="primary" onClick={() => setViewMode("create")}>
          <Plus className="w-4 h-4" />
          {t("create_site.form.title")}
        </Button>
      </div>

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
                    {orphanRepoNameSet.has(repo.full_name) && (
                      <span className="inline-flex items-center rounded-full bg-periwinkle/20 text-charcoal font-body text-xs px-2 py-0.5 flex-shrink-0">
                        {t("step_connect.new_repo_badge")}
                      </span>
                    )}
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

      {/* GitHub App installation callout — users whose repos live in other
          accounts or orgs need to install the app on those too. */}
      <div className="rounded-lg border border-gray-200 bg-cream-dark/60 p-4 mb-4">
        <h3 className="font-heading font-semibold text-sm text-charcoal mb-1.5">
          {t("step_connect.missing_repo_callout_title")}
        </h3>
        <p className="font-body text-xs text-gray-600 mb-3">
          {t("step_connect.missing_repo_callout_body")}
        </p>
        <a
          href={`https://github.com/apps/${githubAppSlug}/installations/new`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 font-heading font-semibold text-xs uppercase tracking-wider bg-charcoal text-white rounded-full px-4 py-1.5 hover:opacity-90 transition-opacity"
        >
          <GitBranch className="w-3.5 h-3.5" aria-hidden="true" />
          {t("step_connect.missing_repo_callout_cta")}
        </a>
      </div>

      {/* Private repo + free plan warning. Treat a null/undefined plan as
          potentially-free — fails safe (worst case: a paying user
          we have no plan info for sees a redundant, dismissible warning). */}
      {selected?.private && (githubPlan == null || githubPlan === "free") && (
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

      {/* Continue button — `loading` shows a spinner alongside the label
          while the scope pre-check is in flight. */}
      <div className="flex justify-end">
        <Button
          variant="primary"
          disabled={!selected || (selected.private && (githubPlan == null || githubPlan === "free"))}
          loading={isCheckingScope}
          onClick={() => selected && onSelect(selected)}
        >
          {t("step_connect.continue")}
        </Button>
      </div>
      </>
      )}

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
