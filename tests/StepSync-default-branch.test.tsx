// @vitest-environment jsdom
/**
 * The sync step's answer to a default branch other than `main`.
 *
 * Two cases carry an action the Compositor can take: no `main` (rename the
 * default) and a `main` holding a Telar site (make it the default). A rename
 * GitHub has not finished keeps its button, so a second click imports. Every
 * other case is a message with no button.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { StepSync } from "~/components/features/onboarding/StepSync";
import type { ImportResult } from "~/lib/import.server";

afterEach(cleanup);

function refused(refusal: Partial<ImportResult>): ImportResult {
  return {
    valid: false,
    ...refusal,
    project: { imported: false, storiesFound: 0 },
    objects: { imported: 0, skipped: 0, warnings: [] },
    stories: { imported: 0, warnings: [] },
    glossary: { imported: 0 },
    pages: { imported: 0 },
    themes: { imported: 0, list: [] },
    sheetsEnabled: false,
    sheetsDisabled: false,
    iiifObjectIds: [],
    audioObjectIds: [],
    videoObjectCount: 0,
    configFields: {},
    orphanStoryIds: [],
  };
}

function renderWith(refusal: Partial<ImportResult>) {
  const onFixDefaultBranch = vi.fn();
  render(
    <StepSync
      importResult={refused({ defaultBranch: "master", ...refusal })}
      isImporting={false}
      onBack={vi.fn()}
      onContinue={vi.fn()}
      onRetryWithUrl={vi.fn()}
      onFixDefaultBranch={onFixDefaultBranch}
      onChooseColumns={vi.fn()}
    />,
  );
  return onFixDefaultBranch;
}

describe("StepSync — a default branch other than main", () => {
  it.each([
    [{ validationError: "no_main_branch", mainBranch: "absent" }, "step_sync.rename_to_main"],
    [{ validationError: "no_main_branch", mainBranch: "site" }, "step_sync.make_main_default"],
    [{ validationError: "rename_pending" }, "step_sync.rename_to_main"],
  ] as const)("offers the fix for %o and submits it", (refusal, label) => {
    const onFixDefaultBranch = renderWith(refusal);

    fireEvent.click(screen.getByRole("button", { name: label }));

    expect(onFixDefaultBranch).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it.each([
    { validationError: "no_main_branch", mainBranch: "not_site" },
    { validationError: "main_unreadable" },
    { validationError: "branch_admin_required" },
    { validationError: "not_telar" },
  ] as const)("offers no fix for %o", (refusal) => {
    renderWith(refusal);

    expect(screen.queryByRole("button", { name: "step_sync.rename_to_main" })).toBeNull();
    expect(screen.queryByRole("button", { name: "step_sync.make_main_default" })).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});
