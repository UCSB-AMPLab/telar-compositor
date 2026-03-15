/**
 * WizardShell — step state machine for the onboarding wizard.
 *
 * Manages step transitions: connect → sync → review → done.
 * Uses useFetcher to submit the import action and react to results.
 * The sheetsAccessError blocking path keeps the user on "sync" until
 * they provide a corrected Sheet URL and retry.
 */

import { useState } from "react";
import { useFetcher } from "react-router";
import type { ImportResult } from "~/lib/import.server";
import type { RepoWithInstallation } from "~/routes/onboarding";
import type { AuthenticatedUser } from "~/middleware/auth.server";
import { ProgressBar } from "./ProgressBar";
import { StepConnect } from "./StepConnect";
import { StepSync } from "./StepSync";
import { StepReview } from "./StepReview";
import { StepDone } from "./StepDone";

type Step = "connect" | "sync" | "review" | "done";

interface WizardShellProps {
  repos: RepoWithInstallation[];
  user: Pick<AuthenticatedUser, "github_id" | "github_login" | "github_name" | "github_email">;
  className?: string;
}

export function WizardShell({ repos, user, className = "" }: WizardShellProps) {
  const [step, setStep] = useState<Step>("connect");
  const [selectedRepo, setSelectedRepo] = useState<RepoWithInstallation | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [showInlineConfig, setShowInlineConfig] = useState(false);
  const [projectId, setProjectId] = useState<number | null>(null);

  const fetcher = useFetcher<ImportResult>();
  const isImporting = fetcher.state !== "idle";

  // When fetcher data arrives, process the result
  const fetcherData = fetcher.data as ImportResult | undefined;

  // Track last processed fetcher data to avoid stale effects
  const handleSelectRepo = (repo: RepoWithInstallation) => {
    setSelectedRepo(repo);
    setImportResult(null);
    setStep("sync");

    // Submit import action
    const formData = new FormData();
    formData.set("intent", "import");
    formData.set("installation_id", String(repo.installationId));
    formData.set("repo_full_name", repo.full_name);
    fetcher.submit(formData, { method: "post", action: "/onboarding" });
  };

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
  };

  const handleContinueToReview = () => {
    setStep("review");
  };

  const handleDone = () => {
    setStep("done");
  };

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
      {/* Progress bar */}
      <ProgressBar currentStep={step} className="mb-8" />

      {/* Step content */}
      {step === "connect" && (
        <StepConnect repos={repos} onSelect={handleSelectRepo} />
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

      {step === "done" && (
        <StepDone onDone={() => {}} />
      )}
    </div>
  );
}
