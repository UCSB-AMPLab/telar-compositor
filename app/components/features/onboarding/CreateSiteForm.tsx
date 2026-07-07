/**
 * This file renders the create-site form inside the onboarding
 * wizard — the Screen 1 identity form (repo name with a debounced
 * availability check, title prefilled from the slug, language,
 * theme cards, and an Advanced disclosure for description + author),
 * plus the inline provisioning view shown while the new repo is set
 * up. Mirrors existing onboarding patterns (`StepConnect` /
 * `SiteConfigConfirmation` / `StepSync`).
 *
 * The collected fields are submitted with the `create-site` intent and
 * drive born-clean provisioning (`commitBornCleanSite`). Browser-safe
 * identity helpers (`humanizeSlug`, `deriveSiteUrl`, theme metadata)
 * come from `~/lib/site-identity`.
 *
 * Theme token: uses the `anil` accent (matches existing
 * `StepConnect` usage).
 *
 * @version v1.4.0-beta
 */

import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { Check, AlertTriangle, Loader2, ArrowLeft, ExternalLink, ChevronRight, ChevronDown } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { Button } from "~/components/ui/Button";
import { InstallationScopePrompt } from "./InstallationScopePrompt";
import {
  humanizeSlug,
  deriveSiteUrl,
  DEFAULT_THEME,
  THEME_META,
  type ThemeId,
} from "~/lib/site-identity";
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

// Mirrors server-side rules: 1–100 chars, allowed charset, no leading . or -,
// not "." or "..".
export function isValidRepoName(name: string): boolean {
  if (!name) return false;
  if (name.length > 100) return false;
  if (name === "." || name === "..") return false;
  if (name.startsWith(".") || name.startsWith("-")) return false;
  return /^[a-z0-9._-]+$/.test(name);
}

type AvailabilityData =
  | { ok: true; intent: "check-repo-name"; available: true; name?: string }
  | { ok: false; intent: "check-repo-name"; error: "invalid_name" | "name_exists"; name?: string }
  | { ok: false; intent: "check-repo-name"; error: "github_error"; message?: string; name?: string };

type CreateData =
  | {
      ok: true;
      intent: "create-site";
      repoUrl: string;
      defaultBranch: string;
      owner: string;
      name: string;
      // Born-clean fully succeeded this run (commit + Pages + dispatch). Gates
      // skipping the post-import config check downstream.
      bornCleanOk?: boolean;
      // Which born-clean step degraded, when bornCleanOk is false. "scope" means
      // the new repo isn't in the App installation yet — an actionable
      // grant-access state, distinct from the generic "we'll finish it" degrade.
      bornCleanError?: string;
      langPatchFailed?: boolean;
    }
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
  const { t, i18n } = useTranslation(["onboarding", "account"]);

  const [name, setName] = useState("");
  // Site identity collected up front (Screen 1). Title prefills from the
  // humanized slug until the user edits it; language defaults to the UI locale;
  // theme defaults to the template's `trama`; author defaults to the owner.
  const [title, setTitle] = useState("");
  const [titleDirty, setTitleDirty] = useState(false);
  const [language, setLanguage] = useState<"en" | "es">(
    i18n.language?.startsWith("es") ? "es" : "en",
  );
  const [theme, setTheme] = useState<ThemeId>(DEFAULT_THEME);
  const [description, setDescription] = useState("");
  const [author, setAuthor] = useState(owner);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("form");
  const [nameState, setNameState] = useState<NameState>({ kind: "idle" });
  const [createError, setCreateError] = useState<CreateData | null>(null);
  // When langPatchFailed=true, hold the wizard on the progress view with the
  // amber warning visible until the user explicitly confirms via the Continue
  // button. Otherwise the auto-advance via scopeFetcher hides the warning
  // before the user can read it.
  const [pendingRepo, setPendingRepo] = useState<RepoWithInstallation | null>(null);

  const availabilityFetcher = useFetcher<AvailabilityData>();
  const createFetcher = useFetcher<CreateData>();
  const scopeFetcher = useFetcher<ScopeData>();

  // Sequence ref guards stale availability responses.
  const lastCheckedNameRef = useRef<string>("");

  // Return focus to the name field after a recovery (e.g. name-taken) bounces
  // back to the form. The error blocks render in the progress view, so the
  // name input isn't mounted at reset time — flag it and focus once the form
  // view renders again.
  const nameInputRef = useRef<HTMLInputElement>(null);
  const pendingNameFocusRef = useRef(false);
  useEffect(() => {
    if (viewMode === "form" && pendingNameFocusRef.current) {
      pendingNameFocusRef.current = false;
      nameInputRef.current?.focus();
    }
  }, [viewMode]);

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

  // Prefill the title from the humanized slug until the user edits it. Clearing
  // the title field re-enables tracking (titleDirty flips back off below).
  // Depends on `language` too, so switching language re-cases the derived title
  // (English title case vs Spanish sentence case).
  useEffect(() => {
    if (titleDirty) return;
    setTitle(name ? humanizeSlug(name, language) : "");
  }, [name, titleDirty, language]);

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
    const createData = createFetcher.data;
    if (!createData || !createData.ok) return;

    const handoff = () => {
      const syntheticRepo: RepoWithInstallation = {
        id: 0,
        name: createData.name,
        full_name: `${createData.owner}/${createData.name}`,
        owner: { login: createData.owner, avatar_url: "" },
        private: false,
        description: null,
        installationId,
        createdThisRun: true,
        bornClean: createData.bornCleanOk === true,
      };
      // Hold on the progress view if the language patch soft-failed so the
      // amber warning is actually readable. User confirms via "Continue".
      if (createData.langPatchFailed) {
        setPendingRepo(syntheticRepo);
        return;
      }
      onSelect(syntheticRepo);
    };

    if (data.ok && data.inScope) {
      handoff();
      return;
    }
    if (data.ok && data.inScope === false) {
      // Definitive out-of-scope — the render shows InstallationScopePrompt.
      return;
    }
    // !data.ok (github_error) — fail open and hand off, mirroring WizardShell's
    // scope pre-check. The repo already exists; a transient scope-check error
    // must not dead-end. The downstream import / repair flow catches any real
    // scope or config problem (and a degraded born-clean keeps bornClean=false,
    // so the repair step still runs).
    // eslint-disable-next-line no-console
    console.error("check-installation-scope error (failing open):", (data as { message?: string }).message);
    handoff();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeFetcher.data, viewMode, installationId]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (nameState.kind !== "available") return;
    setCreateError(null);
    setViewMode("progress");
    createFetcher.submit(
      {
        intent: "create-site",
        owner,
        name,
        installation_id: String(installationId),
        title: title.trim(),
        description: description.trim(),
        language,
        theme,
        author: author.trim(),
      },
      { method: "post", action: "/onboarding" },
    );
  }

  function resetToForm() {
    setViewMode("form");
    setCreateError(null);
    pendingNameFocusRef.current = true;
  }

  const createSucceeded = Boolean(createFetcher.data && createFetcher.data.ok);
  // The repo was created but born-clean provisioning degraded (commit/Pages/
  // dispatch fell back). The repo exists with the template's demo config, so the
  // first row must not read as a clean success — and the downstream repair step
  // (gated on bornClean=false) finishes the configuration.
  // Out-of-scope is its own actionable state (grant access), not a generic
  // "we'll finish configuring it for you" degrade — so it's excluded from
  // bornCleanDegraded and gets its own message + the InstallationScopePrompt.
  const bornCleanScope = Boolean(
    createFetcher.data?.ok && createFetcher.data.bornCleanError === "scope",
  );
  const bornCleanDegraded = Boolean(
    createFetcher.data?.ok && createFetcher.data.bornCleanOk === false && !bornCleanScope,
  );
  const scopeSucceeded = Boolean(scopeFetcher.data && scopeFetcher.data.ok && (scopeFetcher.data as { inScope?: boolean }).inScope);

  if (viewMode === "progress") {
    return (
      <div className={className}>
        <h3 className="font-heading font-semibold text-lg text-charcoal mb-4">
          {t("create_site.progress.heading")}
        </h3>

        {/* Honest provisioning rows. The server does generate → config+content
            commit → enable Pages → dispatch build as one opaque call, so they
            resolve together under a single "Setting up your site" row rather
            than as four faked checkmarks. "Loading your workspace" (the import)
            follows in StepSync after handoff. */}
        <ul className="space-y-3">
          <li className="flex items-start gap-3">
            <StateIcon
              state={
                createSucceeded
                  ? bornCleanDegraded || bornCleanScope
                    ? "warning"
                    : "done"
                  : createError
                  ? "error"
                  : "pending"
              }
            />
            <div>
              <span className="block font-body text-sm text-charcoal">
                {t("create_site.progress.setting_up")}
              </span>
              <span className="block font-body text-xs text-gray-500">
                {bornCleanScope
                  ? t("create_site.progress.setting_up_scope")
                  : bornCleanDegraded
                  ? t("create_site.progress.setting_up_degraded")
                  : t("create_site.progress.setting_up_detail")}
              </span>
            </div>
          </li>
          <li className="flex items-start gap-3">
            <StateIcon
              state={
                scopeSucceeded ? "done" : createSucceeded ? "pending" : "idle"
              }
            />
            <span className="font-body text-sm text-charcoal">
              {t("create_site.progress.checking_access")}
            </span>
          </li>
        </ul>

        {/* Language note. Born-clean provisioning writes telar_language at
            creation; langPatchFailed is set only when that write never landed
            for a Spanish site (the commit step failed, or provisioning threw
            before it), so this language-specific nudge still fits. Non-blocking
            — the site exists; the user just flips the language manually in
            Config. */}
        {createFetcher.data?.ok && createFetcher.data.langPatchFailed === true && (
          <div
            role="status"
            aria-label={t("preferences.create_site_lang_patch_failed_aria_label", { ns: "account" }) as string}
            className="mt-5 border border-amber-200 bg-amber-50 rounded-lg p-4"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle aria-hidden="true" className="w-4 h-4 text-amber-700 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <p className="font-body text-sm text-amber-900">
                  <Trans
                    i18nKey="preferences.create_site_lang_patch_failed_body"
                    ns="account"
                    components={[
                      <a
                        key="config-link"
                        href="/config"
                        className="text-amber-900 underline rounded-sm"
                      />,
                    ]}
                  />
                </p>
                {pendingRepo && (
                  <button
                    type="button"
                    onClick={() => {
                      const repo = pendingRepo;
                      setPendingRepo(null);
                      onSelect(repo);
                    }}
                    className="mt-3 font-heading font-semibold text-xs uppercase tracking-wider text-amber-900 underline underline-offset-4 hover:text-amber-700 rounded-sm"
                  >
                    {t("preferences.create_site_lang_patch_failed_continue", { ns: "account" })}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

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
              {t("create_site.errors.repo_name_taken_retry")}
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
              {t("create_site.errors.reload")}
            </Button>
          </div>
        )}

        {createError && !createError.ok && createError.error === "github_error" && (
          <div className="mt-5 border border-red-200 bg-red-50 rounded-lg p-4">
            <p className="font-body text-sm text-red-800 mb-3">
              {t("create_site.errors.github_error")}
            </p>
            <Button variant="secondary" onClick={resetToForm}>
              {t("create_site.errors.try_again")}
            </Button>
          </div>
        )}

        {/* Scope check returned inScope:false — prompt user to grant access. */}
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
                  createdThisRun: true,
                  bornClean: createData.bornCleanOk === true,
                };
                onSelect(syntheticRepo);
              }}
            />
          </div>
        )}

        <button
          type="button"
          onClick={onBack}
          className="mt-6 inline-flex items-center gap-2 font-body text-sm text-gray-500 hover:text-charcoal"
        >
          <ArrowLeft className="w-4 h-4" />
          {t("create_site.form.back")}
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
            ref={nameInputRef}
            id="create-site-name"
            type="text"
            value={name}
            // Sanitize to the GitHub repo-name charset as the user types, so
            // spaces and other invalid characters can never be entered (the
            // field otherwise only lowercased, letting spaces through).
            onChange={(e) =>
              setName(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ""))
            }
            placeholder={t("create_site.form.name_placeholder") as string}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-body text-charcoal placeholder-gray-400"
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

        {/* Title — prefilled from the slug, editable. */}
        <div>
          <label htmlFor="create-site-title" className="block font-body text-sm text-charcoal mb-1">
            {t("create_site.form.title_label")}
          </label>
          <input
            id="create-site-title"
            type="text"
            value={title}
            onChange={(e) => {
              const v = e.target.value;
              setTitle(v);
              setTitleDirty(v.trim() !== "");
            }}
            placeholder={t("create_site.form.title_placeholder") as string}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-body text-charcoal placeholder-gray-400"
          />
          <p className="mt-1 font-body text-xs text-gray-500">
            {t("create_site.form.title_hint")}
          </p>
        </div>

        {/* Language — segmented, default = UI locale. Always written to the site. */}
        <div>
          <span className="block font-body text-sm text-charcoal mb-1">
            {t("create_site.form.language_label")}
          </span>
          <div role="group" aria-label={t("create_site.form.language_label") as string} className="inline-flex gap-1">
            {(["en", "es"] as const).map((code) => {
              const active = language === code;
              return (
                <button
                  key={code}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setLanguage(code)}
                  className={`px-3.5 py-1.5 rounded-full border font-body text-sm font-medium transition-colors cursor-pointer ${
                    active
                      ? "bg-charcoal text-white border-charcoal"
                      : "bg-transparent text-charcoal/60 border-charcoal/20 hover:border-charcoal/40 hover:text-charcoal"
                  }`}
                >
                  {t(`create_site.form.language_${code}`)}
                </button>
              );
            })}
          </div>
        </div>

        {/* Theme — swatch cards, general then partner themes. The two visual
            groups are a single choice; toggle buttons (aria-pressed) rather than
            a radiogroup, since we don't wire APG arrow-key roving. */}
        <div role="group" aria-label={t("create_site.form.theme_label") as string}>
          <span className="block font-body text-sm text-charcoal mb-2">
            {t("create_site.form.theme_label")}
          </span>
          <ThemeGroup
            label={t("create_site.form.theme_group_general")}
            themes={THEME_META.filter((m) => !m.partner)}
            selected={theme}
            onSelect={setTheme}
          />
          <ThemeGroup
            label={t("create_site.form.theme_group_partner")}
            themes={THEME_META.filter((m) => m.partner)}
            selected={theme}
            onSelect={setTheme}
            className="mt-3"
          />
        </div>

        {/* Advanced — description + author, collapsed by default. */}
        <div>
          <button
            type="button"
            onClick={() => setAdvancedOpen((o) => !o)}
            aria-expanded={advancedOpen}
            aria-controls="create-site-advanced"
            className="inline-flex items-center gap-1 font-heading font-semibold text-xs uppercase tracking-wider text-charcoal hover:text-terracotta transition-colors"
          >
            {advancedOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            {t("create_site.form.advanced")}
          </button>
          {advancedOpen && (
            <div id="create-site-advanced" className="mt-3 space-y-4">
              <div>
                <label htmlFor="create-site-description" className="block font-body text-sm text-charcoal mb-1">
                  {t("create_site.form.description_label")}
                </label>
                <textarea
                  id="create-site-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-body text-charcoal placeholder-gray-400 resize-none"
                />
                <p className="mt-1 font-body text-xs text-gray-500">
                  {t("create_site.form.description_hint")}
                </p>
              </div>
              <div>
                <label htmlFor="create-site-author" className="block font-body text-sm text-charcoal mb-1">
                  {t("create_site.form.author_label")}
                </label>
                <input
                  id="create-site-author"
                  type="text"
                  value={author}
                  onChange={(e) => setAuthor(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-body text-charcoal placeholder-gray-400"
                />
                <p className="mt-1 font-body text-xs text-gray-500">
                  {t("create_site.form.author_hint")}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Live URL preview. */}
        {name && (
          <div className="rounded-lg bg-cream-dark/60 px-3 py-2">
            <span className="block font-body text-xs text-gray-500">
              {t("create_site.form.url_preview_label")}
            </span>
            <span className="font-body text-sm text-charcoal break-all">
              {deriveSiteUrl(owner, name)}
            </span>
          </div>
        )}

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
            {t("create_site.form.back")}
          </button>
        </div>
      </form>
    </div>
  );
}

function StateIcon({ state }: { state: "idle" | "pending" | "done" | "warning" | "error" }) {
  if (state === "done") return <Check className="w-4 h-4 text-green-600 mt-0.5 flex-shrink-0" />;
  if (state === "warning") return <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />;
  if (state === "error") return <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />;
  if (state === "pending")
    return <Loader2 className="w-4 h-4 text-anil animate-spin mt-0.5 flex-shrink-0" />;
  return <div className="w-4 h-4 rounded-full border border-gray-300 mt-0.5 flex-shrink-0" />;
}

function ThemeGroup({
  label,
  themes,
  selected,
  onSelect,
  className = "",
}: {
  label: string;
  themes: typeof THEME_META;
  selected: ThemeId;
  onSelect: (id: ThemeId) => void;
  className?: string;
}) {
  return (
    <div className={className}>
      <span className="block font-body text-xs uppercase tracking-wider text-gray-400 mb-1.5">
        {label}
      </span>
      <div className="flex flex-wrap gap-2">
        {themes.map((theme) => (
          <ThemeCard
            key={theme.id}
            theme={theme}
            selected={selected === theme.id}
            onSelect={() => onSelect(theme.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ThemeCard({
  theme,
  selected,
  onSelect,
}: {
  theme: (typeof THEME_META)[number];
  selected: boolean;
  onSelect: () => void;
}) {
  // Paint-chip card: a full-bleed band of the theme's three signature colours
  // with the name on its own line below. Fixed height keeps the row even
  // regardless of name length; the band is edge-to-edge so the colours read
  // clearly at a glance.
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={theme.name}
      onClick={onSelect}
      className={`relative flex w-[150px] flex-col overflow-hidden rounded-lg border text-left transition-colors cursor-pointer ${
        selected ? "border-anil ring-1 ring-anil" : "border-gray-200 hover:border-anil-deep"
      }`}
    >
      <span className="flex h-[60px]" aria-hidden="true">
        {theme.swatches.map((color, i) => (
          <span key={i} className="flex-1" style={{ backgroundColor: color }} />
        ))}
      </span>
      <span className="flex items-center px-3 py-2.5 font-heading text-sm text-charcoal">
        {theme.name}
      </span>
      {selected && (
        <span className="absolute top-1.5 right-1.5 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-anil text-anil-ink">
          <Check className="w-3 h-3" aria-hidden="true" />
        </span>
      )}
    </button>
  );
}
