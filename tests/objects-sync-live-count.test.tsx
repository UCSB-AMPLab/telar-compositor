// @vitest-environment jsdom
/**
 * The objects page hands the sync dialog what useSiteStatus gives the header.
 * That the two share one poll is proved in
 * site-status-shared-poll.test.tsx.
 *
 * @version v1.5.0-beta
 */

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createRoutesStub, Outlet, useLoaderData } from "react-router";

const status = { current: { count: 8, countKnown: false } };
vi.mock("~/components/features/site-status/useSiteStatus", () => ({ useSiteStatus: () => status.current }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("~/hooks/use-collaboration", () => ({ useCollaborationContext: () => ({ ydoc: null, provider: null }) }));
vi.mock("~/hooks/use-structural-ops", () => ({ useStructuralOps: () => null }));
vi.mock("~/hooks/use-toast", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("~/hooks/use-complete-pending-objects", () => ({ useCompletePendingObjects: () => {} }));
vi.mock("~/hooks/use-version-change-toast", () => ({ useVersionChangeToast: () => {} }));
vi.mock("~/hooks/use-remote-delete-toast", () => ({ useRemoteDeleteToast: () => {} }));
vi.mock("~/components/features/dashboard/SyncConfirmModal", () => ({
  SyncConfirmModal: ({ unpublishedCount, countKnown }: { unpublishedCount: unknown; countKnown: unknown }) => (
    <div data-testid="sync-count">{`${String(unpublishedCount)}/${String(countKnown)}`}</div>
  ),
  SYNC_DIFF_FETCHER_KEY: "full-sync-diff",
}));
vi.mock("~/components/features/objects/AddObjectDialog", () => ({ AddObjectDialog: () => null }));
vi.mock("~/components/features/objects/CommitAndBuildModal", () => ({ CommitAndBuildModal: () => null }));
vi.mock("~/components/features/objects/ObjectsEmptyState", () => ({ ObjectsEmptyState: () => null }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/db.server", () => ({ getDb: vi.fn() }));
vi.mock("~/lib/active-project.server", () => ({ resolveActiveProjectFromRequest: vi.fn() }));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn() }));
vi.mock("~/lib/github.server", () => ({
  getRepoTree: vi.fn(), getFileContent: vi.fn(), getRepoHead: vi.fn(), githubHeaders: vi.fn(),
}));
vi.mock("~/lib/github-app.server", () => ({ resolveProjectToken: vi.fn() }));
vi.mock("~/lib/github-status.server", () => ({ bumpProjectHeadFrom: vi.fn() }));
vi.mock("~/lib/operation-lease.server", () => ({ holdOperationLease: vi.fn() }));
vi.mock("~/lib/sync.server", () => ({
  checkRepairingLegacyIds: vi.fn(), computeSyncDiff: vi.fn(), applySyncChanges: vi.fn(), ObjectsSyncStale: class extends Error {},
}));
vi.mock("~/lib/sync-failure.server", () => ({ syncFailure: vi.fn() }));
vi.mock("~/lib/pending-object-ops.server", () => ({}));
vi.mock("~/lib/config-repair.server", () => ({ repairSiteConfig: vi.fn() }));
vi.mock("~/lib/objects.server", () => ({ getObjectStepCounts: vi.fn() }));
vi.mock("~/lib/iiif.server", () => ({ fetchAndParseManifest: vi.fn() }));
vi.mock("~/lib/upgrade-gate.server", () => ({ readRepoWriteRefusal: vi.fn(), readUploadRefusal: vi.fn() }));
vi.mock("~/lib/commit.server", () => ({ StaleHeadError: class extends Error {} }));
vi.mock("~/lib/csv-export.server", () => ({ serializeObjectsCsv: vi.fn(), dbObjectToCsvRow: vi.fn() }));
vi.mock("~/lib/upload.server", () => ({}));

const loaderData = {
  project: { id: 1, github_repo_full_name: "owner/repo" },
  objects: [],
  objectStepCounts: {},
  siteBaseUrl: "",
  members: [],
  currentUserId: 1,
  userRole: "convenor",
  pendingObjectOps: 0,
};

async function renderPage() {
  const route = (await import("~/routes/_app.objects")) as unknown as {
    default: React.ComponentType<{ loaderData: unknown }>;
  };
  function Page() {
    return <route.default loaderData={useLoaderData()} />;
  }
  const Stub = createRoutesStub([
    {
      id: "routes/_app",
      loader: () => ({ unpublishedCount: 8 }),
      Component: () => <Outlet />,
      children: [{ path: "/objects", Component: Page as never, loader: () => loaderData }],
    },
  ]);
  return render(<Stub initialEntries={["/objects"]} />);
}

const SETTLE = { timeout: 3000 };

afterEach(cleanup);
vi.setConfig({ testTimeout: 15000 });

describe("the objects page's sync dialog count", () => {
  it("is what useSiteStatus gives the header: a live 4", async () => {
    status.current = { count: 4, countKnown: true };
    await renderPage();
    expect((await screen.findByTestId("sync-count", undefined, SETTLE)).textContent).toBe("4/true");
  });

  it("is the estimate, marked not live, when the header's count is unknown", async () => {
    status.current = { count: 8, countKnown: false };
    await renderPage();
    expect((await screen.findByTestId("sync-count", undefined, SETTLE)).textContent).toBe("8/false");
  });
});
