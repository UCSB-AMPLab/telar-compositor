// @vitest-environment jsdom
/**
 * The objects page shows the loader's list while the shared document has not
 * synced, and that list is read-only: the document is the source of truth and
 * would write its own values back at its next snapshot. An empty list from a
 * document that has not synced is not "no objects", so the empty state waits
 * for the sync. After the sync the same controls work, and moving from the
 * loader's list to the document's reports no deletion. An external object is
 * asked about (`enrich-external`) once the document holds it, never from the
 * loader's list, and the page writes none of its manifest into the document.
 *
 * This renders the real page on React Router's routes stub with a live Y.Doc
 * and a provider whose sync the test controls.
 *
 * @version v1.5.0-beta
 */

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { EventEmitter } from "node:events";
import { createRoutesStub, useLoaderData } from "react-router";
import * as Y from "yjs";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
const { collab, showToast } = vi.hoisted(() => ({ collab: { current: null as unknown }, showToast: vi.fn() }));
vi.mock("~/hooks/use-collaboration", () => ({ useCollaborationContext: () => collab.current }));
vi.mock("~/hooks/use-structural-ops", () => ({ useStructuralOps: () => ({ canDelete: () => false }) }));
vi.mock("~/hooks/use-toast", () => ({ useToast: () => ({ showToast }) }));
vi.mock("~/hooks/use-complete-pending-objects", () => ({ useCompletePendingObjects: () => {} }));
vi.mock("~/hooks/use-version-change-toast", () => ({ useVersionChangeToast: () => {} }));
vi.mock("~/components/features/dashboard/SyncConfirmModal", () => ({
  SyncConfirmModal: () => null,
  SYNC_DIFF_FETCHER_KEY: "full-sync-diff",
}));
vi.mock("~/components/features/objects/CommitAndBuildModal", () => ({ CommitAndBuildModal: () => null }));
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

const OBJECT_ROW = {
  id: 5, object_id: "map", title: "Map", source_url: null, thumbnail: null,
  featured: false, image_available: false, missing_from_repo: false, course_project_id: null,
  order_key: "a0",
};

function loaderDataWith(objects: unknown[]) {
  return JSON.parse(JSON.stringify({
    project: { id: 1, github_repo_full_name: "owner/repo" },
    objects,
    objectStepCounts: {},
    sharedSiteIds: {},
    siteBaseUrl: "",
    frameworkVersion: "1.8.0",
    members: [],
    currentUserId: 1,
    userRole: "convenor",
    pendingObjectOps: 0,
  }));
}

function putObjectInDocument(doc: Y.Doc, id: number, objectId: string, title: string) {
  const object = new Y.Map<unknown>();
  object.set("_id", id);
  object.set("object_id", objectId);
  object.set("source_url", `https://iiif.example/${objectId}/manifest`);
  object.set("title", title);
  doc.getArray<Y.Map<unknown>>("objects").push([object]);
}

/** The server's first sync: the document's own objects arrive, then the provider reports synced. */
function firstSyncOfObjectsDoc(doc: Y.Doc, provider: any, objects: Array<[number, string, string]> = []) {
  act(() => {
    doc.transact(() => {
      for (const [id, objectId, title] of objects) putObjectInDocument(doc, id, objectId, title);
    });
    provider.synced = true;
    provider.emit("sync", true);
  });
}

async function renderObjectsBeforeSync(loaderObjects: unknown[], action: (args: { request: Request }) => unknown = () => null) {
  const doc = new Y.Doc();
  const provider = new EventEmitter() as any;
  provider.synced = false;
  collab.current = { ydoc: doc, provider, connectionStatus: "connecting" };
  const data = loaderDataWith(loaderObjects);
  const route = (await import("~/routes/_app.objects")) as unknown as {
    default: React.ComponentType<{ loaderData: unknown }>;
  };
  function Page() {
    return <route.default loaderData={useLoaderData()} />;
  }
  const Stub = createRoutesStub([{ path: "/objects", Component: Page as never, loader: () => data, action: action as never }]);
  render(<Stub initialEntries={["/objects"]} />);
  return { doc, provider };
}

const SETTLE = { timeout: 3000 };

/** Lets the page's effects and the document's first notification run. */
const letObjectsEffectsRun = () => act(async () => { await new Promise((r) => setTimeout(r, 50)); });

afterEach(() => {
  cleanup();
  showToast.mockReset();
});

vi.setConfig({ testTimeout: 15000 });

describe("the objects page before the document has synced", () => {
  it("shows the loader's object with its controls disabled and says why", async () => {
    await renderObjectsBeforeSync([OBJECT_ROW]);
    await screen.findByText("Map", undefined, SETTLE);
    await letObjectsEffectsRun();
    expect(screen.getByText("loading_state")).toBeTruthy();
    expect((screen.getByText("add_object_button") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("mark_featured") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("sync_from_github").closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not show the empty state for an empty list", async () => {
    await renderObjectsBeforeSync([]);
    await screen.findByText("loading_state", undefined, SETTLE);
    await letObjectsEffectsRun();
    expect(screen.queryByText("empty_title")).toBeNull();
    expect(screen.queryByText("empty_sync_button")).toBeNull();
  });
});

describe("the objects page after the document has synced", () => {
  it("shows the empty state when the document holds no objects", async () => {
    const { doc, provider } = await renderObjectsBeforeSync([]);
    await screen.findByText("loading_state", undefined, SETTLE);
    firstSyncOfObjectsDoc(doc, provider);
    await screen.findByText("empty_title", undefined, SETTLE);
    expect(screen.queryByText("loading_state")).toBeNull();
  });

  it("enables the controls and reports no deletion when the document's list replaces the loader's", async () => {
    const { doc, provider } = await renderObjectsBeforeSync([OBJECT_ROW]);
    await screen.findByText("Map", undefined, SETTLE);
    firstSyncOfObjectsDoc(doc, provider, [[6, "atlas", "Atlas"]]);
    await screen.findByText("Atlas", undefined, SETTLE);
    expect(screen.queryByText("loading_state")).toBeNull();
    expect((screen.getByText("add_object_button") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText("mark_featured") as HTMLButtonElement).disabled).toBe(false);
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe("an external object not yet filled from its manifest", () => {
  it("is asked about once the document holds it, and the page writes nothing into it", async () => {
    const intents: string[] = [];
    const action = async ({ request }: { request: Request }) => {
      intents.push(String((await request.formData()).get("intent")));
      return { ok: true, intent: "enrich-external" };
    };
    // The loader's row is external and unfilled too, and is not asked about:
    // the server fills what its document holds.
    const external = { ...OBJECT_ROW, source_url: "https://iiif.example/map/manifest" };
    const { doc, provider } = await renderObjectsBeforeSync([external], action);
    await screen.findByText("Map", undefined, SETTLE);
    await letObjectsEffectsRun();
    expect(intents).not.toContain("enrich-external");

    const updates: unknown[] = [];
    firstSyncOfObjectsDoc(doc, provider, [[6, "atlas", "Atlas"]]);
    doc.on("update", (u) => updates.push(u));
    await screen.findByText("Atlas", undefined, SETTLE);
    await letObjectsEffectsRun();

    expect(intents.filter((i) => i === "enrich-external")).toHaveLength(1);
    expect(updates).toEqual([]);
    const entry = doc.getArray<Y.Map<unknown>>("objects").get(0);
    expect(entry.get("thumbnail")).toBeUndefined();
    expect(entry.get("image_available")).toBeUndefined();
  });
});
