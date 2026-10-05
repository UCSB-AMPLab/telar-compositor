// @vitest-environment jsdom
/**
 * The objects page answers an apply refused as `sync_stale` by checking again
 *
 * The apply is refused when GitHub's head is not the commit the author
 * reviewed. The page keeps the sync dialog open, runs the check again, and
 * says above the new list why it changed; the new list starts from its own
 * defaults, not from the choices made on the refused one. Any other failure
 * still toasts and closes the dialog.
 *
 * An apply that could not add every accepted new row answers them as
 * `notAdded`; the page says so and sends the author back to the sync, and
 * opens the commit window only for what is left pending.
 *
 * This renders the real page on React Router's routes stub, with the real
 * dialog, and answers its submissions from a stand-in action.
 *
 * @version v1.5.0-beta
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRoutesStub, useLoaderData } from "react-router";
import type { SyncDiff } from "~/lib/sync.server";

const showToast = vi.fn();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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
vi.mock("~/components/features/objects/AddObjectDialog", () => ({ AddObjectDialog: () => null }));
vi.mock("~/components/features/objects/CommitAndBuildModal", () => ({
  CommitAndBuildModal: ({ open, checkPending }: { open: boolean; checkPending?: boolean }) =>
    open ? (
      <div>
        commit window<span data-testid="commit-check">{String(checkPending)}</span>
      </div>
    ) : null,
}));
vi.mock("~/components/features/objects/ObjectsEmptyState", () => ({ ObjectsEmptyState: () => null }));

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

const CHECKED = "a".repeat(40);
const LATEST = "b".repeat(40);

function diffAt(headSha: string, repoTitle: string): SyncDiff {
  return {
    newObjects: [],
    changedObjects: [
      {
        object_id: "o1",
        dbId: 1,
        title: "Title of o1",
        changedFields: ["title"],
        conflictFields: [],
        d1Values: { title: "mine" },
        repoValues: { title: repoTitle },
      },
    ],
    missingObjects: [],
    unregisteredFiles: [], reordered: null,
    headSha,
  };
}

/** What each `compute-sync-diff` answers, in order: a check, or a refusal's answer. */
let checks: Array<SyncDiff | Record<string, unknown>>;
/** What `sync-apply` answers. */
let applyAnswer: Record<string, unknown>;
/** Answers the next `compute-sync-diff` as one that failed in transit. */
let checkUnreachable = false;
/** Holds the pre-commit check answered from the second one on, until released. */
let holdLaterPreCommit: Promise<void> | null = null;
let preCommitChecks = 0;
let submitted: Array<Record<string, string>>;

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
      path: "/objects",
      Component: Page as never,
      loader: () => loaderData,
      action: async ({ request }: { request: Request }) => {
        const form = Object.fromEntries((await request.formData()).entries()) as Record<string, string>;
        submitted.push(form);
        if (form.intent === "pre-commit-check") {
          preCommitChecks += 1;
          if (preCommitChecks > 1 && holdLaterPreCommit) await holdLaterPreCommit;
          return { ok: true, intent: "pre-commit-check", sheetsEnabled: false, urlCheck: { match: true, pagesUrl: "", configUrl: "" } };
        }
        if (form.intent === "compute-sync-diff" && checkUnreachable) {
          checkUnreachable = false;
          return { ok: false, reason: "unreachable", intent: "compute-sync-diff" };
        }
        if (form.intent === "compute-sync-diff") {
          const next = checks.shift();
          return next && "ok" in next ? next : { ok: true, intent: "compute-sync-diff", diff: next };
        }
        if (form.intent === "sync-apply") return applyAnswer;
        return null;
      },
    },
    {
      // The column picker commits through the dashboard's action.
      path: "/dashboard",
      action: async ({ request }: { request: Request }) => {
        submitted.push(Object.fromEntries((await request.formData()).entries()) as Record<string, string>);
        return { ok: true, intent: "choose-columns" };
      },
    },
  ]);
  return render(<Stub initialEntries={["/objects"]} />);
}

const SETTLE = { timeout: 3000 };

function checksRun(): number {
  return submitted.filter((f) => f.intent === "compute-sync-diff").length;
}

function titleRadio(value: "repo" | "d1"): HTMLInputElement {
  const el = document.querySelector(`input[type="radio"][name="o1-title"][value="${value}"]`);
  if (!el) throw new Error(`no ${value} radio`);
  return el as HTMLInputElement;
}

async function openCheck() {
  fireEvent.click(await screen.findByRole("button", { name: "sync_from_github" }, SETTLE));
  await screen.findByText("Title of o1", undefined, SETTLE);
}

beforeEach(() => {
  showToast.mockClear();
  submitted = [];
  checkUnreachable = false;
  holdLaterPreCommit = null;
  preCommitChecks = 0;
  checks = [diffAt(CHECKED, "reviewed"), diffAt(LATEST, "latest"), diffAt(LATEST, "latest")];
  applyAnswer = { ok: false, intent: "sync-apply", error: "sync_stale" };
});

afterEach(cleanup);

vi.setConfig({ testTimeout: 15000 });

describe("an apply refused because GitHub changed", () => {
  it("checks again, keeps the dialog open, and says why above the new list", async () => {
    await renderPage();
    await openCheck();

    fireEvent.click(screen.getByRole("button", { name: "sync_apply" }));

    await waitFor(() => expect(checksRun()).toBe(2), SETTLE);
    await screen.findByText("sync_stale", undefined, SETTLE);
    await screen.findByText("latest", undefined, SETTLE);
    const apply = submitted.find((f) => f.intent === "sync-apply");
    expect(JSON.parse(apply!.changes).headSha).toBe(CHECKED);
    expect(screen.getByText("sync_title")).toBeTruthy();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("starts the new list from its defaults, not from the refused list's choices", async () => {
    await renderPage();
    await openCheck();
    fireEvent.click(titleRadio("repo"));
    expect(titleRadio("repo").checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "sync_apply" }));

    await screen.findByText("latest", undefined, SETTLE);
    expect(titleRadio("d1").checked).toBe(true);
    expect(titleRadio("repo").checked).toBe(false);
  });

  it("clears the notice when the dialog closes, and a new check shows none", async () => {
    await renderPage();
    await openCheck();
    fireEvent.click(screen.getByRole("button", { name: "sync_apply" }));
    await screen.findByText("sync_stale", undefined, SETTLE);
    // The sync button is disabled while the re-check runs.
    await screen.findByText("latest", undefined, SETTLE);

    fireEvent.click(screen.getByRole("button", { name: "sync_cancel" }));
    await waitFor(() => expect(screen.queryByText("sync_title")).toBeNull(), SETTLE);
    fireEvent.click(screen.getByRole("button", { name: "sync_from_github" }));

    await waitFor(() => expect(checksRun()).toBe(3), SETTLE);
    await screen.findByText("Title of o1", undefined, SETTLE);
    expect(screen.queryByText("sync_stale")).toBeNull();
  });

  it("clears the notice when another check starts from a click", async () => {
    await renderPage();
    await openCheck();
    fireEvent.click(screen.getByRole("button", { name: "sync_apply" }));
    await screen.findByText("sync_stale", undefined, SETTLE);
    // The sync button is disabled while the re-check runs.
    await screen.findByText("latest", undefined, SETTLE);

    fireEvent.click(screen.getByRole("button", { name: "sync_from_github" }));

    await waitFor(() => expect(checksRun()).toBe(3), SETTLE);
    await screen.findByText("Title of o1", undefined, SETTLE);
    expect(screen.queryByText("sync_stale")).toBeNull();
  });
});

describe("any other failed apply", () => {
  it("still toasts and closes the dialog, without checking again", async () => {
    applyAnswer = { ok: false, intent: "sync-apply", error: "apply_failed", message: "boom" };
    await renderPage();
    await openCheck();

    fireEvent.click(screen.getByRole("button", { name: "sync_apply" }));

    await waitFor(() => expect(showToast).toHaveBeenCalledTimes(1), SETTLE);
    await waitFor(() => expect(screen.queryByText("sync_title")).toBeNull(), SETTLE);
    expect(checksRun()).toBe(1);
  });
});

describe("an apply that could not add every new row", () => {
  const applied = (fields: Record<string, unknown>) => ({
    ok: true, intent: "sync-apply", projectId: 1, appliedCount: 0, pendingObjects: [], notAdded: [], ...fields,
  });
  const commitWindowOpened = () => screen.queryByText("commit window") !== null;

  it("says so, closes the dialog, and opens no commit window", async () => {
    applyAnswer = applied({ notAdded: ["o2"] });
    await renderPage();
    await openCheck();

    fireEvent.click(screen.getByRole("button", { name: "sync_apply" }));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ message: "sync_not_added" })), SETTLE);
    await waitFor(() => expect(screen.queryByText("sync_title")).toBeNull(), SETTLE);
    expect(commitWindowOpened()).toBe(false);
  });

  it("opens no commit window and says nothing when every row was added and nothing is pending", async () => {
    applyAnswer = applied({});
    await renderPage();
    await openCheck();

    fireEvent.click(screen.getByRole("button", { name: "sync_apply" }));

    await waitFor(() => expect(screen.queryByText("sync_title")).toBeNull(), SETTLE);
    expect(showToast).not.toHaveBeenCalled();
    expect(commitWindowOpened()).toBe(false);
  });

  it("opens the commit window for an image file with no row", async () => {
    applyAnswer = applied({ pendingObjects: [{ object_id: "loose", image_available: true }] });
    await renderPage();
    await openCheck();

    fireEvent.click(screen.getByRole("button", { name: "sync_apply" }));

    await waitFor(() => expect(commitWindowOpened()).toBe(true), SETTLE);
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe("a sync check that failed in transit", () => {
  it("shows the sync error and closes the dialog, as any failed check does", async () => {
    checkUnreachable = true;
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "sync_from_github" }, SETTLE));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ message: "sync_error_toast", type: "destructive" })), SETTLE);
    await waitFor(() => expect(screen.queryByText("sync_title")).toBeNull(), SETTLE);
    expect(checksRun()).toBe(1);
  });
});

describe("the commit window's pre-commit check", () => {
  it("waits for the check started when it opens, even after an earlier check succeeded", async () => {
    let release: () => void = () => {};
    holdLaterPreCommit = new Promise<void>((resolve) => (release = resolve));
    applyAnswer = {
      ok: true, intent: "sync-apply", projectId: 1, appliedCount: 0, notAdded: [],
      pendingObjects: [{ object_id: "loose", image_available: true }],
    };
    await renderPage();
    await openCheck();
    // The check made on mount has answered.
    await waitFor(() => expect(preCommitChecks).toBe(1), SETTLE);

    fireEvent.click(screen.getByRole("button", { name: "sync_apply" }));

    await waitFor(() => expect(screen.queryByText("commit window")).not.toBeNull(), SETTLE);
    await waitFor(() => expect(preCommitChecks).toBe(2), SETTLE);
    expect(screen.getByTestId("commit-check").textContent).toBe("true");

    release();
    await waitFor(() => expect(screen.getByTestId("commit-check").textContent).toBe("false"), SETTLE);
  });
});

describe("a check refused for columns read as one field", () => {
  const question = {
    ok: false,
    intent: "compute-sync-diff",
    error: "needs_choices",
    source: "repo",
    challenge: "signed-challenge",
    notice: null,
    groups: [
      {
        file: "telar-content/spreadsheets/objects.csv",
        sheet: "objects.csv",
        claim: "medium",
        positions: [2, 3],
        columns: [
          { position: 2, header: "medium", values: ["Oil"] },
          { position: 3, header: "object_type", values: ["Painting"] },
        ],
        needsChoice: false,
      },
    ],
  };

  it("offers the picker instead of the refusal, commits the choice, and checks again", async () => {
    checks = [question, diffAt(LATEST, "latest")];
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "sync_from_github" }, SETTLE));

    await screen.findByText("columnPickerIntroSite", undefined, SETTLE);
    expect(showToast).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("radio")[1]);
    fireEvent.click(screen.getByText("columnPickerContinue"));

    await waitFor(() => expect(checksRun()).toBe(2), SETTLE);
    expect(submitted.find((f) => f.intent === "choose-columns")).toMatchObject({
      sheet_challenge: "signed-challenge",
      sheet_choices: JSON.stringify([{ file: "telar-content/spreadsheets/objects.csv", positions: [2, 3], keep: 3 }]),
    });
    await screen.findByText("latest", undefined, SETTLE);
  });
});
