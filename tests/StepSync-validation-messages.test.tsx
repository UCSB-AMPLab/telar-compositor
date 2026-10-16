// @vitest-environment jsdom
/**
 * The sync step's message for each refusal code the first import can return:
 * a repository with no default branch is empty, one with files but no
 * `_config.yml` has no Telar site, and a code the step has no message for gets
 * a generic one that claims no cause.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { StepSync, validationErrorMessage } from "~/components/features/onboarding/StepSync";
import { refusedImportResult, type ImportResult } from "~/lib/import.server";

afterEach(cleanup);

const t = (key: string) => key;

function refused(validationError: ImportResult["validationError"]): ImportResult {
  return refusedImportResult({ validationError });
}

describe("validationErrorMessage", () => {
  const cases: Array<[ImportResult["validationError"], string]> = [
    ["not_telar", "step_sync.error_not_telar"],
    ["empty_repo", "step_sync.error_empty_repo"],
    ["no_site_config", "step_sync.error_no_site_config"],
    ["already_connected", "step_sync.error_already_connected"],
    ["main_unreadable", "step_sync.error_main_unreadable"],
    ["rename_pending", "step_sync.error_rename_pending"],
    ["branch_admin_required", "step_sync.error_branch_admin_required"],
    ["scope_check_failed", "create_site.errors.github_error"],
  ];

  for (const [code, key] of cases) {
    it(`${code} reaches ${key}`, () => {
      expect(validationErrorMessage(refused(code), t)).toBe(key);
    });
  }

  it("a code without a message of its own gets the generic message, not the empty-repository one", () => {
    expect(validationErrorMessage(refused("needs_choices"), t)).toBe("step_sync.error_generic");
    expect(validationErrorMessage(refused(undefined), t)).toBe("step_sync.error_generic");
  });
});

describe("StepSync with a repository that has no _config.yml", () => {
  it("says there is no Telar site, not that the repository is empty", () => {
    render(
      <StepSync
        importResult={refused("no_site_config")}
        isImporting={false}
        onBack={() => {}}
        onContinue={() => {}}
        onRetryWithUrl={() => {}}
        onFixDefaultBranch={() => {}}
        onChooseColumns={() => {}}
      />,
    );
    expect(screen.getByText("step_sync.error_no_site_config")).toBeDefined();
    expect(screen.queryByText("step_sync.error_empty_repo")).toBeNull();
  });
});
