// @vitest-environment jsdom
/**
 * The objects page's usage counts follow the shared document once the page has
 * one, and the loader's counts stand before that.
 *
 * This renders the real page on React Router's routes stub with a live Y.Doc,
 * with the row wrapped to record the props the page hands it.
 *
 * @version v1.5.0-beta
 */

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createRoutesStub, useLoaderData } from "react-router";
import * as Y from "yjs";

const { rowProps } = vi.hoisted(() => ({ rowProps: [] as Array<Record<string, unknown>> }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
const { docRef } = vi.hoisted(() => ({ docRef: { current: null as unknown } }));
vi.mock("~/hooks/use-collaboration", () => ({ useCollaborationContext: () => ({ ydoc: docRef.current, provider: null }) }));
vi.mock("~/hooks/use-structural-ops", () => ({ useStructuralOps: () => ({ canDelete: () => false }) }));
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

const loaderData = JSON.parse(JSON.stringify({
  project: { id: 1, github_repo_full_name: "owner/repo" },
  objects: [
    {
      id: 5, object_id: "map", title: "Map", source_url: null, thumbnail: null,
      featured: false, image_available: false, missing_from_repo: false, course_project_id: null,
      order_key: "a0",
    },
  ],
  objectStepCounts: { map: 1 },
  sharedSiteIds: {},
  siteBaseUrl: "",
  frameworkVersion: "1.8.0",
  members: [],
  currentUserId: 1,
  userRole: "convenor",
  pendingObjectOps: 0,
}));

function documentWith(stepObjectIds: string[]): Y.Doc {
  const doc = new Y.Doc();
  const object = new Y.Map<unknown>();
  object.set("_id", 5);
  object.set("object_id", "map");
  object.set("title", "Map");
  doc.getArray<Y.Map<unknown>>("objects").push([object]);
  const story = new Y.Map<unknown>();
  const steps = new Y.Array<Y.Map<unknown>>();
  doc.getArray<Y.Map<unknown>>("stories").push([story]);
  story.set("steps", steps);
  for (const id of stepObjectIds) {
    const step = new Y.Map<unknown>();
    steps.push([step]);
    step.set("object_id", id);
  }
  return doc;
}

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

describe("the usage count on an object's row", () => {
  it("is the document's count, not the loader's, when the document holds the steps", async () => {
    docRef.current = documentWith(["map", "map", "map"]);
    await renderPage();
    await screen.findByText("Map", undefined, SETTLE);
    await waitFor(() => expect(rowProps[rowProps.length - 1].usedInSteps).toBe(3), SETTLE);
  });

  it("is the loader's count while there is no document", async () => {
    docRef.current = null;
    await renderPage();
    await screen.findByText("Map", undefined, SETTLE);
    expect(rowProps[rowProps.length - 1].usedInSteps).toBe(1);
  });
});
