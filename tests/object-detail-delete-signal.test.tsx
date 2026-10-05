// @vitest-environment jsdom
/**
 * The object detail page writes nothing to the document when it deletes.
 *
 * The server does both halves of a deletion before it answers: the
 * repository half when asked, and the document half through the
 * collaboration object, which removes the object's Y.Map and lets the flush
 * take its row. So the page records the request it made, watches the fetcher,
 * and acts on an answer only when it belongs to that request, to the object
 * still displayed, in the project it was displayed under. On `ok` it leaves for
 * /objects; on `ok` with `pending`, the repository half is done and the
 * document half is still owed, so it says so and stays; on a refusal the modal
 * stays open with the failure named. Whether the page has a synced document
 * makes no difference to any of it.
 *
 * The harness gives the fetcher a controllable state and a response object
 * with a stable identity across re-renders (the page's once-guard is that
 * identity), mocks `useNavigate`, and keeps a real Y.Doc and a spy on the
 * delete op, so the assertion that the page writes nothing is about what the
 * document holds afterwards.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import * as Y from "yjs";

// ---------------------------------------------------------------------------
// Controllable harness state
// ---------------------------------------------------------------------------

const OBJECT_DB_ID = 10;
const PROJECT_ID = 42;
const CONVENOR_ID = 7;

/** The action's answer shape, either half. */
type DeleteAnswer =
  | { ok: true; intent: "delete-object"; objectDbId: number; pending?: boolean }
  | { ok: false; error: string; objectDbId: number };

let currentYDoc: Y.Doc | null = null;
let currentProvider: { synced: boolean } | null = null;
let currentOps: { deleteObject: ReturnType<typeof vi.fn> } | null = null;
let fetcherState: "idle" | "submitting" = "idle";
let fetcherData: DeleteAnswer | undefined;
let submissions: Record<string, string>[] = [];
const navigate = vi.fn();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("react-router", () => ({
  Link: ({ children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...rest}>{children}</a>
  ),
  useNavigate: () => navigate,
  useFetcher: () => ({
    state: fetcherState,
    data: fetcherData,
    submit: vi.fn(),
    Form: ({
      children,
      onSubmit,
      ...rest
    }: React.FormHTMLAttributes<HTMLFormElement>) => (
      <form
        {...rest}
        onSubmit={(event) => {
          event.preventDefault();
          const fields = new FormData(event.currentTarget);
          submissions.push(Object.fromEntries(fields.entries()) as Record<string, string>);
          onSubmit?.(event);
        }}
      >
        {children}
      </form>
    ),
  }),
  redirect: vi.fn(),
  useRouteError: () => null,
  isRouteErrorResponse: () => false,
}));

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({ ydoc: currentYDoc, provider: currentProvider }),
}));

vi.mock("~/hooks/use-structural-ops", () => ({
  useStructuralOps: () => currentOps,
}));

// Presentation-only children — the assertions are about the delete affordance.
vi.mock("~/components/features/objects/IiifViewer", () => ({ IiifViewer: () => null }));
vi.mock("~/components/features/objects/CommitAndBuildModal", () => ({
  CommitAndBuildModal: () => null,
}));
vi.mock("~/components/features/editor/VideoEmbed", () => ({ VideoEmbed: () => null }));
vi.mock("~/components/features/editor/AudioPlayer", () => ({ AudioPlayer: () => null }));
vi.mock("~/components/ui/Switch", () => ({ Switch: () => null }));
vi.mock("~/components/ui/InlineTextField", () => ({ InlineTextField: () => null }));
vi.mock("~/components/ui/InlineTextArea", () => ({ InlineTextArea: () => null }));

// Server modules the route pulls in at module scope.
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/db.server", () => ({ getDb: vi.fn() }));
vi.mock("~/lib/active-project.server", () => ({
  resolveActiveProjectFromRequest: vi.fn(),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn() }));
vi.mock("~/lib/error-capture", () => ({ recordError: vi.fn() }));
vi.mock("~/lib/github.server", () => ({ githubHeaders: vi.fn() }));
vi.mock("~/lib/commit.server", () => ({
  dispatchWorkflow: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
}));
vi.mock("~/lib/github-status.server", () => ({ bumpProjectHeadFrom: vi.fn(async () => true) }));
vi.mock("~/lib/github-app.server", () => ({ getInstallationToken: vi.fn() }));
vi.mock("~/lib/object-repo-delete.server", () => ({
  deleteObjectWithRecord: vi.fn(),
}));

import ObjectDetailPage from "~/routes/_app.objects.$objectId";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLoaderData(projectId = PROJECT_ID) {
  return {
    object: {
      id: OBJECT_DB_ID,
      project_id: projectId,
      object_id: "mapa-de-santafe",
      title: "Mapa de Santafé",
      description: null,
      creator: null,
      period: null,
      year: null,
      object_type: null,
      subjects: null,
      source: null,
      credit: null,
      alt_text: null,
      source_url: "objects/mapa-de-santafe/001.jpg",
      featured: false,
      image_available: true,
      missing_from_repo: false,
      course_project_id: null,
      created_by: CONVENOR_ID,
    },
    manifestUrl: null,
    infoJsonUrl: null,
    isExternal: false,
    usedInStories: [],
    rename: { otherIds: [], version: null, stepsRewritten: 0, stepsKept: 0, unresolvedStepValues: [], shared: null },
    siteBase: "https://example.org/site",
    userRole: "convenor" as const,
    currentUserId: CONVENOR_ID,
  };
}

/** A document holding this object's Y.Map, as the editor would have it. */
function seedDocument(): Y.Doc {
  const doc = new Y.Doc();
  const objectsArray = doc.getArray<Y.Map<unknown>>("objects");
  const objMap = new Y.Map<unknown>();
  doc.transact(() => {
    objMap.set("_id", OBJECT_DB_ID);
    objMap.set("_temp_id", "temp-mapa");
    objMap.set("created_by", CONVENOR_ID);
    objMap.set("object_id", "mapa-de-santafe");
    objectsArray.push([objMap]);
  });
  return doc;
}

/**
 * Ops over the seeded document: a spy that performs the real removal, so one
 * fixture serves both the "the map is gone" and the "exactly once" assertions.
 */
function makeOps(doc: Y.Doc) {
  return {
    deleteObject: vi.fn((id: number | null) => {
      const array = doc.getArray<Y.Map<unknown>>("objects");
      doc.transact(() => {
        for (let i = 0; i < array.length; i++) {
          if (array.get(i).get("_id") === id) {
            array.delete(i, 1);
            return;
          }
        }
      });
    }),
  };
}

type Rendered = ReturnType<typeof render>;

function renderPage(projectId = PROJECT_ID): Rendered {
  const props = { loaderData: makeLoaderData(projectId), actionData: undefined };
  const Page = ObjectDetailPage as unknown as (p: typeof props) => React.ReactElement;
  return render(<Page {...props} />);
}

function rerenderPage(view: Rendered, projectId = PROJECT_ID) {
  const props = { loaderData: makeLoaderData(projectId), actionData: undefined };
  const Page = ObjectDetailPage as unknown as (p: typeof props) => React.ReactElement;
  view.rerender(<Page {...props} />);
}

/** Open the modal and submit one of its two forms. */
function submitDelete(which: "delete_remove_compositor" | "delete_remove_repo") {
  fireEvent.click(screen.getByTitle("delete_button"));
  const form = screen.getByText(which).closest("form") as HTMLFormElement;
  fetcherState = "submitting";
  fireEvent.submit(form);
}

/** A document seeded, ops built over it, and the delete already submitted. */
function submittedPage(which: "delete_remove_compositor" | "delete_remove_repo") {
  const doc = seedDocument();
  currentYDoc = doc;
  currentProvider = { synced: true };
  currentOps = makeOps(doc);
  const view = renderPage();
  submitDelete(which);
  return { doc, view, objectsArray: doc.getArray<Y.Map<unknown>>("objects") };
}

/** Deliver one answer and let the page re-render with it. */
function answer(view: Rendered, data: DeleteAnswer, projectId = PROJECT_ID) {
  fetcherState = "idle";
  fetcherData = data;
  rerenderPage(view, projectId);
}

beforeEach(() => {
  currentYDoc = null;
  currentProvider = null;
  currentOps = null;
  fetcherState = "idle";
  fetcherData = undefined;
  submissions = [];
  navigate.mockClear();
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// The affordance
// ---------------------------------------------------------------------------

describe("object detail delete — the affordance", () => {
  // The document carries nothing of the delete, so the page does not wait
  // for one before offering it.
  it("offers the delete while the document is unavailable", () => {
    currentYDoc = null;
    currentOps = null;

    renderPage();

    expect(screen.getByTitle("delete_button")).toBeTruthy();
  });

  it("submits each form with its own fromRepo", () => {
    const { view } = submittedPage("delete_remove_compositor");
    expect(submissions).toEqual([
      { intent: "delete-object", objectDbId: String(OBJECT_DB_ID) },
    ]);

    fetcherState = "idle";
    rerenderPage(view);
    submitDelete("delete_remove_repo");

    expect(submissions[1]).toEqual({
      intent: "delete-object",
      objectDbId: String(OBJECT_DB_ID),
      fromRepo: "true",
    });
  });
});

// ---------------------------------------------------------------------------
// The page leaves the document to the server
// ---------------------------------------------------------------------------

describe("object detail delete — the page writes nothing to the document", () => {
  it("writes nothing while the fetcher is still working", () => {
    const { objectsArray } = submittedPage("delete_remove_repo");

    expect(objectsArray.length).toBe(1);
    expect(currentOps?.deleteObject).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each(["delete_remove_compositor", "delete_remove_repo"] as const)(
    "leaves for /objects once %s answers ok, and deletes nothing from its document",
    (which) => {
      const { view, objectsArray } = submittedPage(which);

      answer(view, { ok: true, intent: "delete-object", objectDbId: OBJECT_DB_ID });

      expect(objectsArray.length).toBe(1);
      expect(currentOps?.deleteObject).not.toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledTimes(1);
      expect(navigate).toHaveBeenCalledWith("/objects");
    },
  );

  it("acts on one answer once, however often the page re-renders", () => {
    const { view } = submittedPage("delete_remove_repo");

    answer(view, { ok: true, intent: "delete-object", objectDbId: OBJECT_DB_ID });
    rerenderPage(view);
    rerenderPage(view);

    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["delete_remove_repo", "delete_document_pending"],
    ["delete_remove_compositor", "delete_compositor_pending"],
  ] as const)("after %s, says the Compositor half is still coming when the answer is pending, and stays", (which, line) => {
    const { view, objectsArray } = submittedPage(which);

    answer(view, { ok: true, intent: "delete-object", objectDbId: OBJECT_DB_ID, pending: true });

    expect(screen.getByText(line)).toBeTruthy();
    expect(objectsArray.length).toBe(1);
    expect(currentOps?.deleteObject).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe("object detail delete — a refusal keeps the object and names itself", () => {
  it("keeps the map, holds the modal open and re-enables the buttons", () => {
    const { view, objectsArray } = submittedPage("delete_remove_repo");

    answer(view, { ok: false, error: "delete_failed", objectDbId: OBJECT_DB_ID });

    expect(objectsArray.length).toBe(1);
    expect(currentOps?.deleteObject).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByText("delete_title")).toBeTruthy();
    expect(screen.getByText("delete_failed")).toBeTruthy();
    expect((screen.getByText("delete_remove_repo") as HTMLButtonElement).disabled).toBe(false);
    expect(
      (screen.getByText("delete_remove_compositor") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  const codes: [string, string, string][] = [
    // error code, line after a compositor delete, line after a repository one
    ["delete_failed", "delete_failed", "delete_failed"],
    ["stale_head", "delete_stale_head", "delete_stale_head"],
    ["course_item_delete_refused", "course_item_delete_refused", "course_item_delete_refused"],
    ["forbidden", "delete_forbidden_compositor", "delete_forbidden_repo"],
    // The repository half's release gate; the compositor delete
    // never meets it, but the line is the same for either answer.
    ["upgrade_required", "repo_write_upgrade_required", "repo_write_upgrade_required"],
    ["upgrade_awaits_convenor", "repo_write_upgrade_awaits_convenor", "repo_write_upgrade_awaits_convenor"],
    ["release_unknown", "repo_write_release_unknown", "repo_write_release_unknown"],
    // Another objects operation, a publish or an upgrade holds the lease.
    ["operation_in_progress", "delete_operation_in_progress", "delete_operation_in_progress"],
  ];

  for (const [error, compositorLine, repoLine] of codes) {
    it(`renders ${compositorLine} for ${error} on the compositor delete`, () => {
      const { view } = submittedPage("delete_remove_compositor");

      answer(view, { ok: false, error, objectDbId: OBJECT_DB_ID });

      expect(screen.getByText(compositorLine)).toBeTruthy();
    });

    it(`renders ${repoLine} for ${error} on the repository delete`, () => {
      const { view } = submittedPage("delete_remove_repo");

      answer(view, { ok: false, error, objectDbId: OBJECT_DB_ID });

      expect(screen.getByText(repoLine)).toBeTruthy();
    });
  }
});

// ---------------------------------------------------------------------------
// An answer that is not this page's
// ---------------------------------------------------------------------------

describe("object detail delete — the answer is bound to the request", () => {
  it("ignores an answer for another object", () => {
    const { view, objectsArray } = submittedPage("delete_remove_compositor");

    answer(view, { ok: true, intent: "delete-object", objectDbId: 999 });

    expect(objectsArray.length).toBe(1);
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.queryByText("delete_failed")).toBeNull();
  });

  it("ignores an answer once the displayed project has changed", () => {
    const { view, objectsArray } = submittedPage("delete_remove_compositor");

    // The request was recorded under project 42; the page is now showing the
    // same object id under another project.
    answer(view, { ok: true, intent: "delete-object", objectDbId: OBJECT_DB_ID }, 99);

    expect(objectsArray.length).toBe(1);
    expect(navigate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// An accepted delete with no document at hand
// ---------------------------------------------------------------------------

describe("object detail delete — ok with no document at hand", () => {
  const unavailable: [string, () => void][] = [
    ["ops gone", () => { currentOps = null; }],
    ["document unsynced", () => { currentProvider = { synced: false }; }],
  ];

  for (const [label, breakIt] of unavailable) {
    it.each(["delete_remove_compositor", "delete_remove_repo"] as const)(
      `leaves for /objects after %s (${label})`,
      (which) => {
        const { view } = submittedPage(which);
        breakIt();

        answer(view, { ok: true, intent: "delete-object", objectDbId: OBJECT_DB_ID });

        expect(navigate).toHaveBeenCalledWith("/objects");
        expect(screen.queryByText("delete_repo_done_reload")).toBeNull();
        expect(screen.queryByText("delete_reload")).toBeNull();
      },
    );
  }
});

describe("object detail delete — the upgrade refusal links to the upgrade", () => {
  it("offers the upgrade link after an upgrade_required answer", () => {
    const { view } = submittedPage("delete_remove_repo");
    answer(view, { ok: false, error: "upgrade_required", objectDbId: OBJECT_DB_ID });
    const link = screen.getByText("upload_upgrade_link").closest("a");
    // The mocked Link renders its `to` as an attribute.
    expect(link?.getAttribute("to")).toBe("/upgrade?from=/objects");
  });

  it("offers no link when the release cannot be read", () => {
    const { view } = submittedPage("delete_remove_repo");
    answer(view, { ok: false, error: "release_unknown", objectDbId: OBJECT_DB_ID });
    expect(screen.queryByText("upload_upgrade_link")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The custom fields section
// ---------------------------------------------------------------------------

describe("object detail — custom fields", () => {
  it("shows the object's custom columns as labelled fields on the page", () => {
    const loaderData = makeLoaderData();
    (loaderData.object as Record<string, unknown>).extra_columns = JSON.stringify({ technique: "oil", material: "wood" });
    const Page = ObjectDetailPage as unknown as (p: { loaderData: typeof loaderData; actionData: undefined }) => React.ReactElement;
    render(<Page loaderData={loaderData} actionData={undefined} />);
    expect((screen.getByLabelText("technique") as HTMLInputElement).value).toBe("oil");
    expect(screen.getByLabelText("material")).toBeTruthy();
  });
});
