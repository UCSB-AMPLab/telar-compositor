// @vitest-environment jsdom
/**
 * The objects page lists an object whose id names an Object.prototype
 * property (`constructor`; an object titled "Constructor" slugs to it).
 *
 * The loader sends the shared-site-id notices and the step counts as plain
 * objects keyed by object id, which arrive on the page with Object.prototype
 * behind them. The page must read only their own properties: an inherited
 * `constructor` read as a shared-site-id notice crashes the row on
 * `others.join`.
 *
 * This renders the real page on React Router's routes stub, with the row
 * wrapped to record the props the page hands it.
 *
 * @version v1.5.0-beta
 */

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createRoutesStub, useLoaderData } from "react-router";

const { rowProps } = vi.hoisted(() => ({ rowProps: [] as Array<Record<string, unknown>> }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("~/hooks/use-collaboration", () => ({ useCollaborationContext: () => ({ ydoc: null, provider: null }) }));
vi.mock("~/hooks/use-structural-ops", () => ({ useStructuralOps: () => null }));
vi.mock("~/hooks/use-toast", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("~/hooks/use-complete-pending-objects", () => ({ useCompletePendingObjects: () => {} }));
vi.mock("~/hooks/use-version-change-toast", () => ({ useVersionChangeToast: () => {} }));
vi.mock("~/hooks/use-remote-delete-toast", () => ({ useRemoteDeleteToast: () => {} }));
vi.mock("~/components/features/dashboard/SyncConfirmModal", () => ({
  SyncConfirmModal: () => null,
  SYNC_DIFF_FETCHER_KEY: "full-sync-diff",
}));
vi.mock("~/components/features/objects/CommitAndBuildModal", () => ({ CommitAndBuildModal: () => null }));
vi.mock("~/components/features/objects/ObjectRow", async (importActual) => {
  const actual = await importActual<typeof import("~/components/features/objects/ObjectRow")>();
  return {
    ObjectRow: (props: React.ComponentProps<typeof actual.ObjectRow>) => {
      rowProps.push(props as unknown as Record<string, unknown>);
      return <actual.ObjectRow {...props} />;
    },
  };
});

// Server modules the route pulls in; the page never runs them here.
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
  checkRepairingLegacyIds: vi.fn(async (_env: unknown, _project: unknown, _user: unknown, run: () => Promise<unknown>) => run()),
  computeSyncDiff: vi.fn(), applySyncChanges: vi.fn(), ObjectsSyncStale: class extends Error {},
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

/** The loader's answer as the page receives it: JSON, so plain objects. */
const loaderData = JSON.parse(JSON.stringify({
  project: { id: 1, github_repo_full_name: "owner/repo" },
  objects: [
    {
      id: 5, object_id: "constructor", title: "Constructor", source_url: null, thumbnail: null,
      featured: false, image_available: false, missing_from_repo: false, course_project_id: null,
      order_key: "a0",
    },
  ],
  objectStepCounts: {},
  sharedSiteIds: {},
  siteBaseUrl: "",
  frameworkVersion: "1.8.0",
  members: [],
  currentUserId: 1,
  userRole: "convenor",
  pendingObjectOps: 0,
}));

async function renderPage() {
  const route = (await import("~/routes/_app.objects")) as unknown as {
    default: React.ComponentType<{ loaderData: unknown }>;
  };
  function Page() {
    return <route.default loaderData={useLoaderData()} />;
  }
  const Stub = createRoutesStub([{ path: "/objects", Component: Page as never, loader: () => loaderData }]);
  return render(<Stub initialEntries={["/objects"]} />);
}

const SETTLE = { timeout: 3000 };

afterEach(() => {
  cleanup();
  rowProps.length = 0;
});

vi.setConfig({ testTimeout: 15000 });

describe("an object whose id is `constructor`", () => {
  it("renders its row with no shared-site-id notice and no step uses", async () => {
    await renderPage();
    await screen.findByText("Constructor", undefined, SETTLE);
    expect(screen.queryByText("site_id_shared")).toBeNull();
    expect(screen.getByText("unused")).toBeTruthy();
    const props = rowProps[rowProps.length - 1];
    expect(props.sharedSiteId).toBeUndefined();
    expect(props.usedInSteps).toBe(0);
  });
});
