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
 * The create flow's two project-level answers — what is being created, and
 * the class code that joins the new site to a course — ride the repo it
 * hands off and are forwarded here into the import submission, alongside
 * `origin`. The action spends them; what comes back is an outcome the notice
 * below renders, and it is rendered by the shell rather than by a step
 * because the join is settled during sync but still worth reading on review
 * and on done.
 *
 * The server checks the installation against the repository again on every
 * import submission, and answers `scopeBlocked` when it does not reach it.
 * That answer arrives after the author has left the connect step, where the
 * installation prompt renders, so the shell goes back to it and keeps the
 * refused submission: granting access submits that again, with its intent and
 * fields, rather than a plain import.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useRef, useState } from "react";
import { useFetcher, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { forgetSite, rememberSite } from "~/lib/tab-site";
import { isUnreachableAnswer } from "~/lib/unreachable-write";
import { useRetryWhileUnreachable } from "~/lib/use-retry-unreachable";
import type { ImportResult } from "~/lib/import.server";
import type { SubmittedChoice } from "~/lib/upgrade-sheets.server";
import type { ImportScopeBlocked } from "~/lib/onboarding-create-site.server";
import type { RepoWithInstallation } from "~/routes/onboarding";
import type { Installation } from "~/lib/github.server";
import type { AuthenticatedUser } from "~/middleware/auth.server";
import { ProgressBar } from "./ProgressBar";
import { StepConnect } from "./StepConnect";
import { StepSync } from "./StepSync";
import { StepReview } from "./StepReview";
import { StepDone } from "./StepDone";
import { CourseJoinNotice } from "./CourseJoinNotice";
import { SiteConfigConfirmation } from "./SiteConfigConfirmation";
import { deriveSiteUrl } from "~/lib/site-identity";

type Step = "connect" | "sync" | "review" | "configure-site" | "done";

/**
 * Forward the create form's project-level answers into an import
 * submission. Omitted when absent rather than sent empty, so the
 * connect-an-existing-repo path posts exactly what it always did.
 */
function setCourseFields(formData: FormData, repo: RepoWithInstallation) {
  if (repo.kind) formData.set("kind", repo.kind);
  if (repo.courseCode) formData.set("course_code", repo.courseCode);
}

type ImportAnswer = ImportResult | ImportScopeBlocked;

function isScopeBlocked(answer: ImportAnswer): answer is ImportScopeBlocked {
  return (answer as Partial<ImportScopeBlocked>).scopeBlocked === true;
}

/** An import submission's fields, kept so a refused one can be sent again unchanged. */
type ImportSubmission = Array<[string, string]>;

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
  user: Pick<AuthenticatedUser, "github_id" | "github_login" | "github_name" | "github_email">;
  hasInstallations: boolean;
  orphanRepoNames?: string[];
  githubAppSlug: string;
  courseGateOpen: boolean;
  className?: string;
}

export function WizardShell({ repos, installations, connectedProjects, user, hasInstallations, orphanRepoNames = [], githubAppSlug, courseGateOpen, className = "" }: WizardShellProps) {
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

  const fetcher = useFetcher<ImportAnswer>();
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
  // The import submission the server refused as out of scope, sent again
  // when the author grants access. Null when the prompt was raised by the
  // client's own pre-check, which has no submission behind it yet.
  const [blockedSubmission, setBlockedSubmission] = useState<ImportSubmission | null>(null);
  const lastImportSubmission = useRef<ImportSubmission | null>(null);
  const handledImportAnswer = useRef<ImportAnswer | null>(null);
  const resumedId = useRef(0);
  const [searchParams] = useSearchParams();

  // Auto-resume only on an explicit ?resume=<id>, each id once. Without it the
  // wizard opens at the connect step, where each unfinished project offers its
  // own Resume, so an author with one abandoned setup can still add or create
  // another site. Resume is a navigation within this route, which keeps the
  // component mounted, so the effect follows the id rather than the mount.
  const requestedResumeId = Number(searchParams.get("resume")) || 0;
  useEffect(() => {
    if (!requestedResumeId || resumedId.current === requestedResumeId) return;
    resumedId.current = requestedResumeId;
    const incomplete = connectedProjects.find((p) => p.id === requestedResumeId && !p.onboarding_completed);
    if (incomplete) {
      setProjectId(incomplete.id);
      configCheckFetcher.submit(
        { intent: "check-site-config", project_id: String(incomplete.id) },
        { method: "post", action: "/onboarding" },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedResumeId]);

  // When fetcher data arrives, process the result. A scope refusal is not an
  // import result; the effect below answers it.
  const fetcherAnswer = fetcher.data;
  const fetcherData = fetcherAnswer && !isScopeBlocked(fetcherAnswer) ? fetcherAnswer : undefined;

  const submitImport = (submission: ImportSubmission) => {
    lastImportSubmission.current = submission;
    const formData = new FormData();
    for (const [key, value] of submission) formData.set(key, value);
    fetcher.submit(formData, { method: "post", action: "/onboarding" });
  };

  const submitImportForm = (formData: FormData) => {
    submitImport([...formData.entries()].map(([key, value]) => [key, String(value)]));
  };

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
    setCourseFields(formData, repo);
    submitImportForm(formData);
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
    setBlockedSubmission(null);
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
    // The retry is the same creation over again — the first attempt aborted
    // before it wrote a project row — so it carries the same two answers.
    setCourseFields(formData, selectedRepo);
    submitImportForm(formData);
  };

  // The author's column choices for a sheet the import refused: the same
  // submission again, carrying the challenge and the choices that answer it.
  const handleChooseColumns = (challenge: string, choices: SubmittedChoice[]) => {
    const last = (lastImportSubmission.current ?? []).filter(([key]) => key !== "sheet_challenge" && key !== "sheet_choices");
    setImportResult(null);
    submitImport([...last, ["sheet_challenge", challenge], ["sheet_choices", JSON.stringify(choices)]]);
  };

  // The author's answer to a default branch other than `main`: the server
  // moves the repository onto `main` and imports it, deciding what to change
  // from GitHub rather than from what the sync step showed.
  const handleFixDefaultBranch = () => {
    if (!selectedRepo) return;
    setImportResult(null);

    const formData = new FormData();
    formData.set("intent", "fix_default_branch");
    formData.set("installation_id", String(selectedRepo.installationId));
    formData.set("repo_full_name", selectedRepo.full_name);
    if (selectedRepo.createdThisRun) formData.set("origin", "created");
    setCourseFields(formData, selectedRepo);
    submitImportForm(formData);
  };

  // The server found the installation does not reach the repository. The
  // prompt renders on the connect step only, so the author is taken back
  // there, with the refused submission kept for the prompt's retry.
  useEffect(() => {
    const answer = fetcher.data;
    if (fetcher.state !== "idle" || !answer || answer === handledImportAnswer.current) return;
    handledImportAnswer.current = answer;
    if (!isScopeBlocked(answer) || !selectedRepo) return;
    setBlockedSubmission(lastImportSubmission.current);
    setScopeBlocked(selectedRepo);
    setStep("connect");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data, fetcher.state]);

  const handleScopeResolved = (repo: RepoWithInstallation) => {
    setScopeBlocked(null);
    const refused = blockedSubmission;
    setBlockedSubmission(null);
    if (!refused) {
      proceedToImport(repo);
      return;
    }
    setStep("sync");
    submitImport(refused);
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

  // A refused completion leaves the session where it was, and the tab
  // remembers the site it showed.
  const forgottenSite = useRef<number | null>(null);
  const completeAnswer = completeFetcher.data as { ok?: boolean } | undefined;
  useEffect(() => {
    if (completeAnswer?.ok === false) rememberSite(forgottenSite.current);
  }, [completeAnswer]);

  const markOnboardingComplete = () => {
    if (projectId != null) {
      // `complete-onboarding` makes the new site the session's; a tab still
      // remembering the old one would switch the session back in the layout.
      forgottenSite.current = forgetSite();
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
    | { ok: false; reason: "unreachable"; intent: "check-site-config" }
    | null
    | undefined;

  // A check that could not be made is asked again; Continue asks it too.
  useRetryWhileUnreachable(configCheckData, () => {
    if (projectId == null) return;
    configCheckFetcher.submit(
      { intent: "check-site-config", project_id: String(projectId) },
      { method: "post", action: "/onboarding" },
    );
  });

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

  // The code and GitHub's own text are held apart. Concatenated into one
  // string they read the same on screen, but the consumer selects its copy by
  // comparing the code exactly, so a branch that gains a message stops matching
  // itself and falls through to the generic card without anything failing.
  const [configFixError, setConfigFixError] = useState<string | null>(null);
  const [configFixMessage, setConfigFixMessage] = useState<string | null>(null);
  const [installationId, setInstallationId] = useState<number | null>(null);

  useEffect(() => {
    if (!configFixData || configFixData.intent !== "fix-site-config") return;
    if (configFixData.ok) {
      markOnboardingComplete();
    } else {
      setConfigFixError(configFixData.error);
      setConfigFixMessage(configFixData.message ?? null);
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

      {/* The join outcome, once the import has reported one. Outlives the
          sync step that produced it, so it sits in the shell. */}
      {currentResult?.courseJoin && step !== "connect" && (
        <CourseJoinNotice outcome={currentResult.courseJoin} className="mb-6" />
      )}

      <ConfigCheckNote failed={isUnreachableAnswer(configCheckData) && configCheckFetcher.state === "idle"} />

      {/* Step content */}
      {step === "connect" && (
        <StepConnect
          repos={repos}
          installations={installations}
          userLogin={user.github_login}
          connectedProjects={connectedProjects}
          orphanRepoNames={orphanRepoNames}
          onSelect={handleSelectRepo}
          hasInstallations={hasInstallations}
          githubAppSlug={githubAppSlug}
          courseGateOpen={courseGateOpen}
          scopeBlocked={scopeBlocked}
          onScopeResolved={handleScopeResolved}
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
          onFixDefaultBranch={handleFixDefaultBranch}
          onChooseColumns={handleChooseColumns}
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
          errorMessage={configFixMessage}
          repoFullName={selectedRepo?.full_name ?? null}
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

/** What the wizard says when the site-configuration check could not be made. */
function ConfigCheckNote({ failed }: { failed: boolean }) {
  const { t } = useTranslation("onboarding");
  if (!failed) return null;
  return (
    <p role="status" className="font-body text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-6">
      {t("site_config.check_failed")}
    </p>
  );
}
