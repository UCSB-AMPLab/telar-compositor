/**
 * This file is the step state machine for the onboarding wizard —
 * the orchestrator that decides which step the user is currently
 * on and handles the transitions between them.
 *
 * Manages step transitions:
 * `connect → sync → review → [configure-site →] done`. Uses
 * `useFetcher` to submit the import action and react to results.
 * The `sheetsAccessError` blocking path keeps the user on "sync"
 * until they provide a corrected Sheet URL and retry. When the
 * imported repo has configuration issues (Google Sheets enabled,
 * URL mismatch), a mandatory `configure-site` step fixes them
 * before Done.
 *
 * @version v1.4.0-beta
 */

import { useEffect, useRef, useState } from "react";
import { useFetcher, useSearchParams } from "react-router";
import type { ImportResult } from "~/lib/import.server";
import type { RepoWithInstallation } from "~/routes/onboarding";
import type { Installation } from "~/lib/github.server";
import type { AuthenticatedUser } from "~/middleware/auth.server";
import { ProgressBar } from "./ProgressBar";
import { StepConnect } from "./StepConnect";
import { StepSync } from "./StepSync";
import { StepReview } from "./StepReview";
import { StepDone } from "./StepDone";
import { SiteConfigConfirmation } from "./SiteConfigConfirmation";
import { deriveSiteUrl } from "~/lib/site-identity";

type Step = "connect" | "sync" | "review" | "configure-site" | "done";

// Discriminated union for the `intent=check-installation-scope` response.
// Mirrors the shape returned by `/onboarding` action — see
// `app/components/features/onboarding/CreateSiteForm.tsx:63-65`.
type ScopeData =
  | { ok: true; intent: "check-installation-scope"; inScope: boolean }
  | {
      ok: false;
      intent: "check-installation-scope";
      error: "github_error";
      message?: string;
    };

interface ConnectedProject {
  id: number;
  github_repo_full_name: string;
  onboarding_completed: boolean | null;
}

interface WizardShellProps {
  repos: RepoWithInstallation[];
  installations: Installation[];
  connectedProjects: ConnectedProject[];
  user: Pick<AuthenticatedUser, "github_id" | "github_login" | "github_name" | "github_email" | "github_plan">;
  hasInstallations: boolean;
  orphanRepoNames?: string[];
  githubAppSlug: string;
  className?: string;
}

export function WizardShell({ repos, installations, connectedProjects, user, hasInstallations, orphanRepoNames = [], githubAppSlug, className = "" }: WizardShellProps) {
  const [step, setStep] = useState<Step>("connect");
  const [selectedRepo, setSelectedRepo] = useState<RepoWithInstallation | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [showInlineConfig, setShowInlineConfig] = useState(false);
  const [projectId, setProjectId] = useState<number | null>(null);

  // Site config check state
  const [sheetsEnabled, setSheetsEnabled] = useState(false);
  const [pagesNotEnabled, setPagesNotEnabled] = useState(false);
  const [urlMismatch, setUrlMismatch] = useState<{ pagesUrl: string; configUrl: string } | null>(null);
  const [configChecked, setConfigChecked] = useState(false);

  const fetcher = useFetcher<ImportResult>();
  const configCheckFetcher = useFetcher();
  const configFixFetcher = useFetcher();
  const completeFetcher = useFetcher();
  // 5th useFetcher — the scope pre-check fired BEFORE intent=import in
  // handleSelectRepo. Adding new useFetcher calls after this line breaks
  // tests/WizardShell.test.tsx (slot index assumptions, modulo 5).
  const scopeFetcher = useFetcher<ScopeData>();
  const isImporting = fetcher.state !== "idle";

  // Lifted from StepConnect — `scopeBlocked` controls whether the
  // InstallationScopePrompt renders inside StepConnect's slot. Set when
  // the pre-check returns `inScope:false`, cleared when the user picks
  // another repo or grants access.
  const [scopeBlocked, setScopeBlocked] = useState<RepoWithInstallation | null>(null);
  const resumeChecked = useRef(false);
  const [searchParams] = useSearchParams();

  // Auto-resume: if there's an incomplete project, jump to config check.
  // Prefer ?resume=<id> when present (explicit Resume click on the connected
  // list); otherwise fall back to the first incomplete project found.
  useEffect(() => {
    if (resumeChecked.current) return;
    resumeChecked.current = true;
    const requestedId = Number(searchParams.get("resume"));
    const incomplete =
      (requestedId
        ? connectedProjects.find((p) => p.id === requestedId && !p.onboarding_completed)
        : null) ?? connectedProjects.find((p) => !p.onboarding_completed);
    if (incomplete) {
      setProjectId(incomplete.id);
      configCheckFetcher.submit(
        { intent: "check-site-config", project_id: String(incomplete.id) },
        { method: "post", action: "/onboarding" },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When fetcher data arrives, process the result
  const fetcherData = fetcher.data as ImportResult | undefined;

  // `proceedToImport` is the original body of `handleSelectRepo` — extracted
  // so the response-handling useEffect below can call it after the scope
  // pre-check resolves (in-scope) or fails open.
  const proceedToImport = (repo: RepoWithInstallation) => {
    setStep("sync");
    const formData = new FormData();
    formData.set("intent", "import");
    formData.set("installation_id", String(repo.installationId));
    formData.set("repo_full_name", repo.full_name);
    // Created sites import their own born-clean content; mark origin so the row
    // records "created" rather than "imported".
    if (repo.createdThisRun) formData.set("origin", "created");
    fetcher.submit(formData, { method: "post", action: "/onboarding" });
  };

  // Fire the scope pre-check BEFORE intent=import. On in-scope,
  // proceedToImport runs; on out-of-scope, setScopeBlocked lifts the
  // prompt; on non-scope errors, we fail open.
  const handleSelectRepo = (repo: RepoWithInstallation) => {
    setSelectedRepo(repo);
    setImportResult(null);
    setConfigChecked(false);
    // Stale-prompt guard — clear any prior block before issuing a new
    // check, so picking a fresh repo never leaves a misleading prompt up.
    setScopeBlocked(null);
    scopeFetcher.submit(
      {
        intent: "check-installation-scope",
        owner: repo.owner.login,
        name: repo.name,
        installation_id: String(repo.installationId),
      },
      { method: "post", action: "/onboarding" },
    );
  };

  // Branch on the scope pre-check response. Mirrors the symmetric pattern
  // at `CreateSiteForm.tsx:163-190`. Fail-open on transient errors.
  useEffect(() => {
    if (!selectedRepo) return;
    const data = scopeFetcher.data;
    if (!data) return;
    if (data.ok && data.inScope === true) {
      proceedToImport(selectedRepo);
      return;
    }
    if (data.ok && data.inScope === false) {
      setScopeBlocked(selectedRepo);
      return;
    }
    // !data.ok — fail open.
    // eslint-disable-next-line no-console
    console.error(
      "check-installation-scope error:",
      (data as { message?: string }).message,
    );
    proceedToImport(selectedRepo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeFetcher.data]);

  const handleRetryWithUrl = (sheetsUrl: string) => {
    if (!selectedRepo) return;
    setImportResult(null);

    const formData = new FormData();
    formData.set("intent", "import_with_url");
    formData.set("installation_id", String(selectedRepo.installationId));
    formData.set("repo_full_name", selectedRepo.full_name);
    formData.set("sheets_url", sheetsUrl);
    fetcher.submit(formData, { method: "post", action: "/onboarding" });
  };

  const handleBack = () => {
    setStep("connect");
    setSelectedRepo(null);
    setImportResult(null);
    setConfigChecked(false);
  };

  const handleContinueToReview = () => {
    setStep("review");
  };

  const markOnboardingComplete = () => {
    if (projectId != null) {
      completeFetcher.submit(
        { intent: "complete-onboarding", project_id: String(projectId) },
        { method: "post", action: "/onboarding" },
      );
    }
    setStep("done");
  };

  const handleDone = () => {
    // Born-clean created sites are verified at creation — their config was just
    // written correct (Sheets off, Pages on, URL matched). Skip the post-import
    // check, both to avoid a redundant round-trip and to dodge the brief
    // Pages-settling window where GET /pages can 404 and wrongly flag a repair.
    // Gated on the per-run bornClean flag, never the "created" label alone, so a
    // partial/failed provisioning still falls through to the repair step.
    const skipCheck = Boolean(selectedRepo?.createdThisRun && selectedRepo?.bornClean);

    // Run config check if not yet done
    if (!skipCheck && !configChecked && projectId != null) {
      configCheckFetcher.submit(
        { intent: "check-site-config", project_id: String(projectId) },
        { method: "post", action: "/onboarding" }
      );
      return; // Wait for check result
    }

    // If there are issues, show the configure-site step
    if (!skipCheck && (sheetsEnabled || pagesNotEnabled || urlMismatch)) {
      setStep("configure-site");
    } else {
      markOnboardingComplete();
    }
  };

  // Process config check result
  const configCheckData = configCheckFetcher.data as
    | { ok: true; intent: "check-site-config"; sheetsEnabled: boolean; pagesNotEnabled: boolean; urlMismatch: { pagesUrl: string; configUrl: string } | null }
    | null
    | undefined;

  useEffect(() => {
    if (configCheckData?.ok && configCheckData.intent === "check-site-config") {
      setSheetsEnabled(configCheckData.sheetsEnabled);
      setPagesNotEnabled(configCheckData.pagesNotEnabled);
      setUrlMismatch(configCheckData.urlMismatch);
      setConfigChecked(true);

      // Route based on results
      if (configCheckData.sheetsEnabled || configCheckData.pagesNotEnabled || configCheckData.urlMismatch) {
        setStep("configure-site");
      } else {
        markOnboardingComplete();
      }
    }
  }, [configCheckData]);

  const handleFixConfig = () => {
    if (projectId == null) return;
    setConfigFixError(null);
    configFixFetcher.submit(
      {
        intent: "fix-site-config",
        project_id: String(projectId),
        fixSheets: sheetsEnabled ? "true" : "false",
        enablePages: pagesNotEnabled ? "true" : "false",
        fixUrl: urlMismatch ? "true" : "false",
        pagesUrl: urlMismatch?.pagesUrl ?? "",
      },
      { method: "post", action: "/onboarding" }
    );
  };

  // Watch config fix result
  const configFixData = configFixFetcher.data as
    | { ok: true; intent: "fix-site-config" }
    | { ok: false; intent: "fix-site-config"; error: string; message?: string; installationId?: number }
    | null
    | undefined;

  const [configFixError, setConfigFixError] = useState<string | null>(null);
  const [installationId, setInstallationId] = useState<number | null>(null);

  useEffect(() => {
    if (!configFixData || configFixData.intent !== "fix-site-config") return;
    if (configFixData.ok) {
      markOnboardingComplete();
    } else {
      setConfigFixError(configFixData.message ? `${configFixData.error}: ${configFixData.message}` : configFixData.error);
      if (!configFixData.ok && configFixData.installationId) {
        setInstallationId(configFixData.installationId);
      }
    }
  }, [configFixData]);

  // Process fetcher results
  if (fetcherData && fetcher.state === "idle") {
    const isNewResult = fetcherData !== importResult;
    if (isNewResult) {
      if (fetcherData.valid && fetcherData.projectId && fetcherData.projectId !== projectId) {
        setProjectId(fetcherData.projectId);
      }
    }
  }

  // Derive current import result from fetcher data (source of truth during wizard)
  const currentResult = (fetcher.state === "idle" && fetcherData) ? fetcherData : importResult;

  return (
    <div className={`bg-white rounded-xl shadow-sm border border-gray-100 p-8 ${className}`}>
      {/* Progress bar — configure-site is a sub-step of review, show review progress */}
      <ProgressBar
        currentStep={step === "configure-site" ? "review" : step}
        className="mb-8"
      />

      {/* Step content */}
      {step === "connect" && (
        <StepConnect
          repos={repos}
          installations={installations}
          userLogin={user.github_login}
          connectedProjects={connectedProjects}
          orphanRepoNames={orphanRepoNames}
          onSelect={handleSelectRepo}
          githubPlan={user.github_plan}
          hasInstallations={hasInstallations}
          githubAppSlug={githubAppSlug}
          scopeBlocked={scopeBlocked}
          onScopeResolved={(repo) => {
            setScopeBlocked(null);
            proceedToImport(repo);
          }}
          isCheckingScope={scopeFetcher.state !== "idle"}
        />
      )}

      {step === "sync" && (
        <StepSync
          importResult={currentResult ?? null}
          isImporting={isImporting}
          onBack={handleBack}
          onContinue={handleContinueToReview}
          onRetryWithUrl={handleRetryWithUrl}
        />
      )}

      {step === "review" && currentResult && currentResult.valid && (
        <StepReview
          importResult={currentResult}
          onDone={handleDone}
          onEditConfig={() => setShowInlineConfig(true)}
          showInlineConfig={showInlineConfig}
          projectId={projectId ?? 0}
        />
      )}

      {step === "configure-site" && (
        <SiteConfigConfirmation
          sheetsEnabled={sheetsEnabled}
          pagesNotEnabled={pagesNotEnabled}
          urlMismatch={urlMismatch}
          error={configFixError}
          installationId={installationId}
          onConfirmed={handleFixConfig}
          onSkip={markOnboardingComplete}
          isSubmitting={configFixFetcher.state !== "idle"}
        />
      )}

      {step === "done" && (
        <StepDone
          onDone={() => {}}
          created={selectedRepo?.createdThisRun ?? false}
          siteUrl={
            selectedRepo?.createdThisRun
              ? deriveSiteUrl(selectedRepo.owner.login, selectedRepo.name)
              : undefined
          }
        />
      )}
    </div>
  );
}
