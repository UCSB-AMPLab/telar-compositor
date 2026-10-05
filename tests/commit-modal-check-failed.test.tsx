// @vitest-environment jsdom
/**
 * The commit dialog says so when its pre-commit check could not be made, and
 * offers to run it again. The check decides the commit's Sheets
 * flag, so the dialog does not answer for it.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import type { ComponentProps } from "react";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("react-router", () => ({
  Link: ({ children, ...rest }: { children?: unknown; [key: string]: unknown }) => <a {...(rest as object)}>{children as never}</a>,
  useFetcher: () => ({ submit: vi.fn(), state: "idle", data: undefined }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, params?: { file?: string }) => (params?.file ? `${key}:${params.file}` : key), i18n: { language: "en" } }),
}));

import { CommitAndBuildModal } from "~/components/features/objects/CommitAndBuildModal";

const pending = [{ object_id: "a-title", title: "A Title", featured: false, image_available: false }] as never;

function renderCommitModalWithCheck(extra: Record<string, unknown>) {
  const props = {
    open: true,
    sheetsEnabled: false,
    urlMismatch: null,
    pendingObjects: pending,
    onClose: vi.fn(),
    onBuildSuccess: vi.fn(),
    onBuildFailed: vi.fn(),
    ...extra,
  };
  render(<CommitAndBuildModal {...(props as unknown as ComponentProps<typeof CommitAndBuildModal>)} />);
  return props;
}

describe("CommitAndBuildModal when the pre-commit check could not be made", () => {
  it("says so and runs the check again from its button", () => {
    const onRetryCheck = vi.fn();
    renderCommitModalWithCheck({ checkPending: true, checkFailed: true, onRetryCheck });
    expect(screen.getByText("commitModal.checkFailed")).toBeTruthy();
    fireEvent.click(screen.getByText("error.retry"));
    expect(onRetryCheck).toHaveBeenCalledTimes(1);
  });

  it("says nothing while the check has not failed", () => {
    renderCommitModalWithCheck({ checkPending: true, checkFailed: false });
    expect(screen.queryByText("commitModal.checkFailed")).toBeNull();
  });
});

describe("CommitAndBuildModal's description of the commit", () => {
  it("names the objects sheet the site holds, objetos.csv on a Spanish-only site", () => {
    renderCommitModalWithCheck({ checkPending: false, objectsFile: "objetos.csv" });
    expect(screen.getByText("commitModal.description:objetos.csv")).toBeTruthy();
  });

  it("names objects.csv where no file name is given", () => {
    renderCommitModalWithCheck({ checkPending: false });
    expect(screen.getByText("commitModal.description:objects.csv")).toBeTruthy();
  });
});
