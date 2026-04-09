/**
 * CreateSiteForm — Phase 21 Plan 01.
 *
 * Single-field debounced create-site form plus its inline progress view.
 * Mirrors existing onboarding patterns (StepConnect / SiteConfigConfirmation / StepSync).
 *
 * Theme token: uses `periwinkle` accent (matches existing StepConnect usage).
 * Both --color-lavender and --color-periwinkle exist at #C6D0F8 in app.css; we keep
 * `periwinkle` to avoid a split in onboarding.
 *
 * i18n note: `create_site.progress.*` currently ships with `creating`, `still_setting_up`,
 * and `success`. A dedicated `checking_access` key does not yet exist; this file uses
 * `create_site.installation_scope.waiting` as the closest existing key for the second
 * progress row. Plan 03 should add `create_site.progress.checking_access` via the
 * i18n approval gate and swap the reference here.
 */

import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { Check, AlertTriangle, Loader2, ArrowLeft, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "~/components/ui/Button";
import { InstallationScopePrompt } from "./InstallationScopePrompt";
import type { RepoWithInstallation } from "~/routes/onboarding";

interface CreateSiteFormProps {
  owner: string;
  installationId: number;
  onSelect: (repo: RepoWithInstallation) => void;
  onBack: () => void;
  className?: string;
}

type NameState =
  | { kind: "idle" }
  | { kind: "typing" }
  | { kind: "checking" }
  | { kind: "available" }
  | { kind: "taken" }
  | { kind: "invalid_format" }
  | { kind: "error" };

type ViewMode = "form" | "progress";

// Mirrors Phase 19 server-side rules: 1–100 chars, allowed charset, no leading . or -,
// not "." or "..".
export function isValidRepoName(name: string): boolean {
  if (!name) return false;
  if (name.length > 100) return false;
  if (name === "." || name === "..") return false;
  if (name.startsWith(".") || name.startsWith("-")) return false;
  return /^[A-Za-z0-9._-]+$/.test(name);
}

type AvailabilityData =
  | { ok: true; intent: "check-repo-name"; available: true; name?: string }
  | { ok: false; intent: "check-repo-name"; error: "invalid_name" | "name_exists"; name?: string }
  | { ok: false; intent: "check-repo-name"; error: "github_error"; message?: string; name?: string };

type CreateData =
  | { ok: true; intent: "create-site"; repoUrl: string; defaultBranch: string; owner: string; name: string }
  | { ok: false; intent: "create-site"; error: "repo_name_taken" | "permission_denied" | "repo_not_ready" }
  | { ok: false; intent: "create-site"; error: "github_error"; message?: string };

type ScopeData =
  | { ok: true; intent: "check-installation-scope"; inScope: boolean }
  | { ok: false; intent: "check-installation-scope"; error: "github_error"; message?: string };

export function CreateSiteForm({
  owner,
  installationId,
  onSelect,
  onBack,
  className = "",
}: CreateSiteFormProps) {
  const { t } = useTranslation("onboarding");

  const [name, setName] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("form");
  const [nameState, setNameState] = useState<NameState>({ kind: "idle" });
  const [createError, setCreateError] = useState<CreateData | null>(null);
  const [scopeError, setScopeError] = useState<ScopeData | null>(null);

  const availabilityFetcher = useFetcher<AvailabilityData>();
  const createFetcher = useFetcher<CreateData>();
  const scopeFetcher = useFetcher<ScopeData>();

  // Sequence ref guards stale availability responses.
  const lastCheckedNameRef = useRef<string>("");

  // Debounced availability check.
  useEffect(() => {
    if (viewMode !== "form") return;
    if (name === "") {
      setNameState({ kind: "idle" });
      return;
    }
    if (!isValidRepoName(name)) {
      setNameState({ kind: "invalid_format" });
      return;
    }
    setNameState({ kind: "typing" });
    const handle = setTimeout(() => {
      setNameState({ kind: "checking" });
      lastCheckedNameRef.current = name;
      availabilityFetcher.submit(
        { intent: "check-repo-name", owner, name },
        { method: "post", action: "/onboarding" },
      );
    }, 400);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, viewMode, owner]);

  // Apply availability responses, guarding against stale ones.
  useEffect(() => {
    const data = availabilityFetcher.data;
    if (!data) return;
    // Guard: the response's embedded name (if server echoes) or our last-submitted
    // name must match the current field.
    const responseName = data.name ?? lastCheckedNameRef.current;
    if (responseName !== name) return;
    if (data.ok) {
      setNameState({ kind: "available" });
      return;
    }
    if (data.error === "name_exists") {
      setNameState({ kind: "taken" });
    } else if (data.error === "invalid_name") {
      setNameState({ kind: "invalid_format" });
    } else {
      // github_error — console.error raw message, render generic inline error.
      // eslint-disable-next-line no-console
      console.error("check-repo-name github_error:", (data as { message?: string }).message);
      setNameState({ kind: "error" });
    }
  }, [availabilityFetcher.data, name]);

  // React to create-site fetcher responses in progress view.
  useEffect(() => {
    const data = createFetcher.data;
    if (!data) return;
    if (viewMode !== "progress") return;
    if (data.ok) {
      // Kick off scope check.
      scopeFetcher.submit(
        {
          intent: "check-installation-scope",
          owner,
          name: data.name,
          installation_id: String(installationId),
        },
        { method: "post", action: "/onboarding" },
      );
      return;
    }
    if ((data as { ok: false; error?: string }).error === "github_error") {
      // eslint-disable-next-line no-console
      console.error("create-site github_error:", (data as { message?: string }).message);
    }
    setCreateError(data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createFetcher.data, viewMode, owner, installationId]);

  // React to scope fetcher responses.
  useEffect(() => {
    const data = scopeFetcher.data;
    if (!data) return;
    if (viewMode !== "progress") return;
    if (data.ok && data.inScope) {
      // Build synthetic repo and hand off.
      const createData = createFetcher.data;
      if (!createData || !createData.ok) return;
      const syntheticRepo: RepoWithInstallation = {
        id: 0,
        name: createData.name,
        full_name: `${createData.owner}/${createData.name}`,
        owner: { login: createData.owner, avatar_url: "" },
        private: false,
        description: null,
        installationId,
      };
      onSelect(syntheticRepo);
      return;
    }
    if (!data.ok && data.error === "github_error") {
      // eslint-disable-next-line no-console
      console.error("check-installation-scope github_error:", data.message);
    }
    setScopeError(data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeFetcher.data, viewMode, installationId]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (nameState.kind !== "available") return;
    setCreateError(null);
    setScopeError(null);
    setViewMode("progress");
    createFetcher.submit(
      { intent: "create-site", owner, name },
      { method: "post", action: "/onboarding" },
    );
  }

  function resetToForm() {
    setViewMode("form");
    setCreateError(null);
    setScopeError(null);
  }

  const creating = createFetcher.state !== "idle" || (createFetcher.data && createFetcher.data.ok && !scopeFetcher.data);
  const checkingScope =
    scopeFetcher.state !== "idle" ||
    (createFetcher.data && createFetcher.data.ok === true && !scopeFetcher.data);
  const createSucceeded = Boolean(createFetcher.data && createFetcher.data.ok);
  const scopeSucceeded = Boolean(scopeFetcher.data && scopeFetcher.data.ok && (scopeFetcher.data as { inScope?: boolean }).inScope);

  if (viewMode === "progress") {
    return (
      <div className={className}>
        <h3 className="font-heading font-semibold text-lg text-charcoal mb-4">
          {t("create_site.form.title")}
        </h3>

        <ul className="space-y-3">
          <li className="flex items-start gap-3">
            <StateIcon state={createSucceeded ? "done" : createError ? "error" : "pending"} />
            <span className="font-body text-sm text-charcoal">
              {t("create_site.progress.creating")}
            </span>
          </li>
          <li className="flex items-start gap-3">
            <StateIcon
              state={
                scopeSucceeded
                  ? "done"
                  : scopeError
                  ? "error"
                  : createSucceeded
                  ? "pending"
                  : "idle"
              }
            />
            <span className="font-body text-sm text-charcoal">
              {/* checking_access placeholder — see file header note. */}
              {t("create_site.installation_scope.waiting")}
            </span>
          </li>
        </ul>

        {/* Error rendering */}
        {createError && !createError.ok && createError.error === "permission_denied" && (
          <div className="mt-5 border border-red-200 bg-red-50 rounded-lg p-4">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <a
                  href={`https://github.com/settings/installations/${installationId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-body text-sm text-red-800 underline inline-flex items-center gap-1"
                >
                  {t("create_site.errors.permission_denied")}
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>
          </div>
        )}

        {createError && !createError.ok && createError.error === "repo_name_taken" && (
          <div className="mt-5 border border-red-200 bg-red-50 rounded-lg p-4">
            <p className="font-body text-sm text-red-800 mb-3">
              {t("create_site.errors.repo_name_taken")}
            </p>
            <Button variant="secondary" onClick={resetToForm}>
              {t("create_site.form.title")}
            </Button>
          </div>
        )}

        {createError && !createError.ok && createError.error === "repo_not_ready" && (
          <div className="mt-5 border border-amber-200 bg-amber-50 rounded-lg p-4">
            <p className="font-body text-sm text-amber-900 mb-3">
              {t("create_site.progress.still_setting_up")}
            </p>
            <Button
              variant="secondary"
              onClick={() => {
                if (typeof window !== "undefined") window.location.reload();
              }}
            >
              Reload
            </Button>
          </div>
        )}

        {createError && !createError.ok && createError.error === "github_error" && (
          <div className="mt-5 border border-red-200 bg-red-50 rounded-lg p-4">
            <p className="font-body text-sm text-red-800 mb-3">
              {t("create_site.errors.github_error")}
            </p>
            <Button variant="secondary" onClick={resetToForm}>
              {t("create_site.form.title")}
            </Button>
          </div>
        )}

        {/* Scope check returned inScope:false — prompt user to grant access (Plan 02). */}
        {scopeFetcher.data && scopeFetcher.data.ok && scopeFetcher.data.inScope === false && createFetcher.data && createFetcher.data.ok && (
          <div className="mt-5">
            <InstallationScopePrompt
              installationId={installationId}
              owner={(createFetcher.data as { owner: string }).owner}
              repoName={(createFetcher.data as { name: string }).name}
              onResolved={() => {
                const createData = createFetcher.data;
                if (!createData || !createData.ok) return;
                const syntheticRepo: RepoWithInstallation = {
                  id: 0,
                  name: createData.name,
                  full_name: `${createData.owner}/${createData.name}`,
                  owner: { login: createData.owner, avatar_url: "" },
                  private: false,
                  description: null,
                  installationId,
                };
                onSelect(syntheticRepo);
              }}
            />
          </div>
        )}

        {scopeError && !scopeError.ok && (
          <div className="mt-5 border border-red-200 bg-red-50 rounded-lg p-4">
            <p className="font-body text-sm text-red-800">
              {t("create_site.errors.github_error")}
            </p>
          </div>
        )}

        <button
          type="button"
          onClick={onBack}
          className="mt-6 inline-flex items-center gap-2 font-body text-sm text-gray-500 hover:text-charcoal"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
      </div>
    );
  }

  return (
    <div className={className}>
      <h3 className="font-heading font-semibold text-lg text-charcoal mb-4">
        {t("create_site.form.title")}
      </h3>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label
            htmlFor="create-site-name"
            className="block font-body text-sm text-charcoal mb-1"
          >
            {t("create_site.form.name_label")}
          </label>
          <input
            id="create-site-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("create_site.form.name_placeholder") as string}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-body text-charcoal placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-periwinkle"
          />
          <p className="mt-1 font-body text-xs text-gray-500">
            {t("create_site.form.name_hint")}
          </p>

          {/* Inline availability state */}
          <div className="mt-2 min-h-[1.25rem]" aria-live="polite">
            {nameState.kind === "checking" && (
              <span className="inline-flex items-center gap-1 font-body text-xs text-gray-500">
                <Loader2 className="w-3 h-3 animate-spin" />
              </span>
            )}
            {nameState.kind === "available" && (
              <span className="inline-flex items-center gap-1 font-body text-xs text-green-700">
                <Check className="w-3 h-3" />
              </span>
            )}
            {nameState.kind === "invalid_format" && (
              <span className="inline-flex items-center gap-1 font-body text-xs text-red-700">
                <AlertTriangle className="w-3 h-3" />
                {t("create_site.errors.invalid_name")}
              </span>
            )}
            {nameState.kind === "taken" && (
              <span className="inline-flex items-center gap-1 font-body text-xs text-red-700">
                <AlertTriangle className="w-3 h-3" />
                {t("create_site.errors.name_exists")}
              </span>
            )}
            {nameState.kind === "error" && (
              <span className="inline-flex items-center gap-1 font-body text-xs text-red-700">
                <AlertTriangle className="w-3 h-3" />
                {t("create_site.errors.github_error")}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Button
            type="submit"
            variant="primary"
            loading={nameState.kind === "checking"}
            disabled={nameState.kind !== "available"}
          >
            {t("create_site.form.submit")}
          </Button>
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-2 font-body text-sm text-gray-500 hover:text-charcoal"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </button>
        </div>
      </form>
    </div>
  );
}

function StateIcon({ state }: { state: "idle" | "pending" | "done" | "error" }) {
  if (state === "done") return <Check className="w-4 h-4 text-green-600 mt-0.5 flex-shrink-0" />;
  if (state === "error") return <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />;
  if (state === "pending")
    return <Loader2 className="w-4 h-4 text-periwinkle animate-spin mt-0.5 flex-shrink-0" />;
  return <div className="w-4 h-4 rounded-full border border-gray-300 mt-0.5 flex-shrink-0" />;
}
