// @vitest-environment jsdom
/**
 * The objects page shows its stale message for an upload refused because
 * objects.csv has object rows the Compositor has not read.
 *
 * The upload answers that refusal as `stale_head`, the answer it gives for a
 * commit that landed during it, and the Add Object dialog shows
 * `objects:upload_error_stale` to the convenor, who reviews the changes on
 * GitHub, and to everyone else the line that says who does.
 *
 * This renders the real page on React Router's routes stub, and answers the
 * upload from a stand-in action.
 *
 * @version v1.5.5-beta
 */

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRoutesStub, useLoaderData } from "react-router";
import { SyncReviewContext } from "~/components/features/dashboard/SyncReviewProvider";

const showToast = vi.fn();

/** Hoisted with the mocks that read it. */
const { UPLOAD } = vi.hoisted(() => ({
  UPLOAD: {
    // Node's own File, which the request body's FormData accepts; jsdom's is refused.
    file: new (process.getBuiltinModule("node:buffer").File)([new Uint8Array([0xff, 0xd8, 0xff])], "p.jpg", { type: "image/jpeg" }),
    objectId: "", title: "A Title", creator: "", description: "", source: "", credit: "", period: "", year: "", altText: "",
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values && Object.keys(values).length > 0 ? `${key} ${JSON.stringify(values)}` : key),
  }),
}));
vi.mock("~/hooks/use-collaboration", () => ({ useCollaborationContext: () => ({ ydoc: null, provider: null }) }));
vi.mock("~/hooks/use-structural-ops", () => ({ useStructuralOps: () => null }));
vi.mock("~/hooks/use-toast", () => ({ useToast: () => ({ showToast }) }));
vi.mock("~/hooks/use-complete-pending-objects", () => ({ useCompletePendingObjects: () => {} }));
vi.mock("~/hooks/use-version-change-toast", () => ({ useVersionChangeToast: () => {} }));
vi.mock("~/hooks/use-remote-delete-toast", () => ({ useRemoteDeleteToast: () => {} }));
vi.mock("~/components/features/dashboard/SyncConfirmModal", () => ({
  SyncConfirmModal: () => null,
  SYNC_DIFF_FETCHER_KEY: "full-sync-diff",
}));
// The dialog, reduced to what this case reads: the upload it confirms and the
// error the page hands back to it.
vi.mock("~/components/features/objects/AddObjectDialog", () => ({
  AddObjectDialog: (props: { open: boolean; uploadError: string | null; onUploadConfirm: (p: unknown[]) => void }) =>
    props.open ? (
      <div>
        <button type="button" onClick={() => props.onUploadConfirm([UPLOAD])}>confirm-upload</button>
        {props.uploadError ? <p>{props.uploadError}</p> : null}
      </div>
    ) : null,
}));
vi.mock("~/components/features/objects/CommitAndBuildModal", () => ({ CommitAndBuildModal: () => null }));
vi.mock("~/components/features/objects/ObjectsEmptyState", () => ({
  ObjectsEmptyState: (props: { onAddIiif: () => void }) => (
    <button type="button" onClick={props.onAddIiif}>add-object</button>
  ),
}));

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

const uploads: string[] = [];

async function renderPage(review: { canReview: boolean; coordinatorName: string | null }) {
  const route = (await import("~/routes/_app.objects")) as unknown as {
    default: React.ComponentType<{ loaderData: unknown }>;
  };
  function Page() {
    return (
      <SyncReviewContext.Provider value={{ ...review, openReview: () => {} }}>
        <route.default loaderData={useLoaderData()} />
      </SyncReviewContext.Provider>
    );
  }
  const Stub = createRoutesStub([
    {
      path: "/objects",
      Component: Page as never,
      loader: () => loaderData,
      action: async ({ request }: { request: Request }) => {
        const intent = String((await request.formData()).get("intent"));
        uploads.push(intent);
        return intent === "upload-image" ? { ok: false, intent: "upload-image", error: "stale_head" } : null;
      },
    },
  ]);
  return render(<Stub initialEntries={["/objects"]} />);
}

const SETTLE = { timeout: 3000 };

afterEach(() => {
  cleanup();
  uploads.length = 0;
});

vi.setConfig({ testTimeout: 15000 });

async function refuseUpload(review: { canReview: boolean; coordinatorName: string | null }, shown: string) {
  await renderPage(review);
  fireEvent.click(await screen.findByRole("button", { name: "add-object" }, SETTLE));
  fireEvent.click(await screen.findByRole("button", { name: "confirm-upload" }, SETTLE));
  await screen.findByText(shown, undefined, SETTLE);
  expect(uploads).toContain("upload-image");
}

describe("an upload refused as stale_head", () => {
  it("tells the convenor to review the changes on GitHub", async () => {
    await refuseUpload({ canReview: true, coordinatorName: "Ana" }, "upload_error_stale");
  });

  it("tells a collaborator who reviews them, by name", async () => {
    await refuseUpload({ canReview: false, coordinatorName: "Ana" }, 'upload_error_stale_collab {"name":"Ana"}');
  });

  it("tells a collaborator who reviews them without a name when none is stored", async () => {
    await refuseUpload({ canReview: false, coordinatorName: null }, "upload_error_stale_collab_unnamed");
  });
});
