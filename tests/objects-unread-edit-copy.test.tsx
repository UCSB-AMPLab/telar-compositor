// @vitest-environment jsdom
/**
 * What the author reads when an objects commit is refused for a GitHub edit to
 * objects.csv the Compositor has not read.
 *
 * Both actions answer the refusal as `stale_head`, the answer they already
 * give for a commit that landed during them, so the page shows the copy it
 * already has: `objects:upload_error_stale` in the Add Object dialog for the
 * upload, and `objects:staleHeadError` in the commit window for the objects
 * commit. Both send the author to the objects sync.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";

const commitAnswer: { data: unknown } = { data: undefined };

vi.mock("react-router", () => ({
  Link: ({ children }: { children?: unknown }) => <a>{children as never}</a>,
  useFetcher: () => ({ submit: vi.fn(), state: "idle", data: commitAnswer.data }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

import { CommitAndBuildModal } from "~/components/features/objects/CommitAndBuildModal";

afterEach(() => {
  cleanup();
  commitAnswer.data = undefined;
});

describe("the objects commit refused as stale_head", () => {
  it("shows the commit window's existing stale message", () => {
    commitAnswer.data = { ok: false, intent: "commit-objects", error: "stale_head" };
    const props = {
      open: true,
      sheetsEnabled: false,
      urlMismatch: null,
      pendingObjects: [],
      skipCommit: false,
      onClose: vi.fn(),
      onBuildSuccess: vi.fn(),
      onBuildFailed: vi.fn(),
    };
    render(<CommitAndBuildModal {...(props as unknown as ComponentProps<typeof CommitAndBuildModal>)} />);
    expect(screen.getByText("staleHeadError")).toBeTruthy();
  });
});
