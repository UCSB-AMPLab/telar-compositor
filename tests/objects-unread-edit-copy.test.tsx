// @vitest-environment jsdom
/**
 * What the author reads when an objects commit is refused for a GitHub edit to
 * objects.csv the Compositor has not read.
 *
 * Both actions answer the refusal as `stale_head`, the answer they give for a
 * commit that landed during them, so the page shows the copy written for that
 * answer: `objects:upload_error_stale` in the Add Object dialog for the
 * upload, and `objects:staleHeadError` in the commit window for the objects
 * commit. The convenor, who reviews the changes on GitHub, reads the message
 * that says so; everyone else reads who does.
 *
 * `t` echoes the key and its values.
 *
 * @version v1.5.5-beta
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
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values && Object.keys(values).length > 0 ? `${key} ${JSON.stringify(values)}` : key),
    i18n: { language: "en" },
  }),
}));

import { CommitAndBuildModal } from "~/components/features/objects/CommitAndBuildModal";
import { SyncReviewContext } from "~/components/features/dashboard/SyncReviewProvider";

afterEach(() => {
  cleanup();
  commitAnswer.data = undefined;
});

function renderRefused(review: { canReview: boolean; coordinatorName: string | null }) {
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
  render(
    <SyncReviewContext.Provider value={{ ...review, openReview: () => {} }}>
      <CommitAndBuildModal {...(props as unknown as ComponentProps<typeof CommitAndBuildModal>)} />
    </SyncReviewContext.Provider>,
  );
}

describe("the objects commit refused as stale_head", () => {
  it("tells the convenor to review the changes on GitHub", () => {
    renderRefused({ canReview: true, coordinatorName: "Ana" });
    expect(screen.getByText("staleHeadError")).toBeTruthy();
  });

  it("tells a collaborator who reviews them, by name", () => {
    renderRefused({ canReview: false, coordinatorName: "Ana" });
    expect(screen.getByText('staleHeadError_collab {"name":"Ana"}')).toBeTruthy();
  });

  it("tells a collaborator who reviews them without a name when none is stored", () => {
    renderRefused({ canReview: false, coordinatorName: null });
    expect(screen.getByText("staleHeadError_collab_unnamed")).toBeTruthy();
  });
});
