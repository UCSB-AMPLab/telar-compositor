// @vitest-environment jsdom
/**
 * The sync step's answer to an import refused because the server could not
 * check that the installation reaches the repository: a failed read
 * of GitHub, shown with the copy the create form already gives one, and the
 * way back to try again. No branch fix is offered.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { StepSync } from "~/components/features/onboarding/StepSync";
import { refusedImportResult } from "~/lib/import.server";

afterEach(cleanup);

describe("StepSync — scope_check_failed", () => {
  it("shows the failed read of GitHub and the way back, with no branch fix", () => {
    render(
      <StepSync
        importResult={refusedImportResult({ validationError: "scope_check_failed" })}
        isImporting={false}
        onBack={vi.fn()}
        onContinue={vi.fn()}
        onRetryWithUrl={vi.fn()}
        onFixDefaultBranch={vi.fn()}
        onChooseColumns={vi.fn()}
      />,
    );

    expect(screen.getByText("create_site.errors.github_error")).toBeDefined();
    expect(screen.getByText("step_sync.back")).toBeDefined();
    expect(screen.queryByText("step_sync.rename_to_main")).toBeNull();
    expect(screen.queryByText("step_sync.error_empty_repo")).toBeNull();
  });
});
