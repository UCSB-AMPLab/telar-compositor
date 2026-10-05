// @vitest-environment jsdom
/**
 * The object page's Change ID button and dialog.
 *
 * The button is offered to whoever the `rename-object` action admits, the
 * convenor or whoever created the object, and never on a course item. The
 * dialog judges the typed ID against the rows the page loaded, says what the
 * change does to steps, images and texts, and posts the ID the page showed.
 * An answer is read once, for this object only: success moves to the new
 * address keeping the query, `pending` stays with a note, a refusal is named,
 * and a Sheets site is offered the switch, which posts `disableSheets`. The
 * form posts what the dialog said about the steps; an answer carrying other
 * facts replaces them, says so, and the next post carries the new ones.
 *
 * `t` echoes the key and its values, so each assertion names the message the
 * page chose and what it filled in.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import {
  objectRenameFacts,
  renameFactsFingerprint,
  renameIdRefusal,
  type ObjectRenameFacts,
} from "~/lib/object-rename-id";

const OBJECT_DB_ID = 10;
const CONVENOR_ID = 7;
const CREATOR_ID = 8;
const OTHER_ID = 9;

let fetcherState: "idle" | "submitting" = "idle";
let fetcherData: unknown;
let submissions: Record<string, string>[] = [];
const navigate = vi.fn();

/** `key`, or `key {values}` when the call carries values. */
function echo(key: string, values?: Record<string, unknown>): string {
  return values ? `${key} ${JSON.stringify(values)}` : key;
}

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: echo }),
}));

vi.mock("react-router", () => ({
  Link: ({ children, to, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...rest}>{children}</a>
  ),
  useNavigate: () => navigate,
  useFetcher: () => ({
    state: fetcherState,
    data: fetcherData,
    submit: vi.fn(),
    Form: ({ children, onSubmit, ...rest }: React.FormHTMLAttributes<HTMLFormElement>) => (
      <form
        {...rest}
        onSubmit={(event) => {
          event.preventDefault();
          submissions.push(Object.fromEntries(new FormData(event.currentTarget).entries()) as Record<string, string>);
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
  useCollaborationContext: () => ({ ydoc: null, provider: null }),
}));
vi.mock("~/components/features/objects/IiifViewer", () => ({ IiifViewer: () => null }));
vi.mock("~/components/features/objects/CommitAndBuildModal", () => ({ CommitAndBuildModal: () => null }));
vi.mock("~/components/features/editor/VideoEmbed", () => ({ VideoEmbed: () => null }));
vi.mock("~/components/features/editor/AudioPlayer", () => ({ AudioPlayer: () => null }));
vi.mock("~/components/ui/Switch", () => ({ Switch: () => null }));
vi.mock("~/components/ui/InlineTextField", () => ({ InlineTextField: () => null }));
vi.mock("~/components/ui/InlineTextArea", () => ({ InlineTextArea: () => null }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/db.server", () => ({ getDb: vi.fn() }));
vi.mock("~/lib/active-project.server", () => ({ resolveActiveProjectFromRequest: vi.fn() }));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn() }));
vi.mock("~/lib/error-capture", () => ({ recordError: vi.fn() }));
vi.mock("~/lib/github.server", () => ({ githubHeaders: vi.fn() }));
vi.mock("~/lib/commit.server", () => ({
  dispatchWorkflow: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
}));
vi.mock("~/lib/github-status.server", () => ({ bumpProjectHeadFrom: vi.fn() }));
vi.mock("~/lib/github-app.server", () => ({ resolveProjectToken: vi.fn() }));
vi.mock("~/lib/object-repo-delete.server", () => ({ deleteObjectWithRecord: vi.fn() }));
vi.mock("~/lib/object-rename.server", () => ({ renameObjectFromPage: vi.fn() }));

import ObjectDetailPage from "~/routes/_app.objects.$objectId";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** The facts for `object_id` among `rows`, with `steps` as every step's value. */
function facts(objectId: string, rows: string[], steps: string[] = []): ObjectRenameFacts {
  const order = rows.map((id) => ({ object_id: id }));
  return objectRenameFacts({ object_id: objectId }, { sheet: order, d1: order, version: "1.8.0" }, steps);
}

interface PageSetup {
  objectId?: string;
  userRole?: string;
  currentUserId?: number;
  courseProjectId?: number | null;
  rename?: ObjectRenameFacts;
}

function loaderData(setup: PageSetup = {}) {
  const objectId = setup.objectId ?? "mapa";
  return {
    object: {
      id: OBJECT_DB_ID,
      project_id: 42,
      object_id: objectId,
      title: "Mapa",
      description: null,
      creator: null,
      period: null,
      year: null,
      object_type: null,
      subjects: null,
      source: null,
      credit: null,
      alt_text: null,
      source_url: null,
      featured: false,
      image_available: true,
      missing_from_repo: false,
      course_project_id: setup.courseProjectId ?? null,
      created_by: CREATOR_ID,
    },
    sheetHeader: null,
    manifestUrl: null,
    infoJsonUrl: null,
    isExternal: false,
    usedInStories: [],
    rename: setup.rename ?? facts(objectId, [objectId, "carta"], [objectId, objectId, "carta"]),
    siteBase: null,
    userRole: setup.userRole ?? "convenor",
    currentUserId: setup.currentUserId ?? CONVENOR_ID,
  };
}

type Rendered = ReturnType<typeof render>;
type PageProps = { loaderData: ReturnType<typeof loaderData>; actionData: undefined };
const Page = ObjectDetailPage as unknown as (p: PageProps) => React.ReactElement;

function renderPage(setup: PageSetup = {}): Rendered {
  return render(<Page loaderData={loaderData(setup)} actionData={undefined} />);
}

/** Open the dialog and type `value` into its ID field. */
function openAndType(value: string) {
  fireEvent.click(screen.getByText("rename_button"));
  fireEvent.change(screen.getByLabelText("upload_object_id", { selector: "input" }), { target: { value } });
}

/** The dialog's confirm button, by its label. */
function confirmButton(label = "rename_confirm"): HTMLButtonElement {
  return screen.getByText(label) as HTMLButtonElement;
}

function submit(label = "rename_confirm") {
  fetcherState = "submitting";
  fireEvent.submit(confirmButton(label).closest("form") as HTMLFormElement);
}

/** Deliver one answer and let the page re-render with it. */
function answer(view: Rendered, data: unknown, setup: PageSetup = {}) {
  fetcherState = "idle";
  fetcherData = data;
  view.rerender(<Page loaderData={loaderData(setup)} actionData={undefined} />);
}

function refusal(error: string, params?: Record<string, string>) {
  return { ok: false, intent: "rename-object", objectDbId: OBJECT_DB_ID, error, ...(params ? { params } : {}) };
}

function success(pending = false) {
  return {
    ok: true, intent: "rename-object", objectDbId: OBJECT_DB_ID, newId: "mapa-nuevo", pending, committed: true, dispatchRunId: 5,
  };
}

beforeEach(() => {
  fetcherState = "idle";
  fetcherData = undefined;
  submissions = [];
  navigate.mockClear();
  window.history.replaceState(null, "", "/objects/mapa");
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// The button
// ---------------------------------------------------------------------------

describe("the Change ID button", () => {
  it("is offered to the convenor", () => {
    renderPage();
    expect(screen.queryByText("rename_button")).not.toBeNull();
  });

  it("is offered to whoever created the object", () => {
    renderPage({ userRole: "collaborator", currentUserId: CREATOR_ID });
    expect(screen.queryByText("rename_button")).not.toBeNull();
  });

  it("is not offered to another collaborator", () => {
    renderPage({ userRole: "collaborator", currentUserId: OTHER_ID });
    expect(screen.queryByText("rename_button")).toBeNull();
  });

  it("is not offered on a course item, which says why", () => {
    renderPage({ courseProjectId: 3 });
    expect(screen.queryByText("rename_button")).toBeNull();
    expect(screen.queryByText("course_item_rename_refused")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The dialog before it posts
// ---------------------------------------------------------------------------

describe("the dialog before it posts", () => {
  it("is prefilled with the ID and offers no change until the ID differs", () => {
    renderPage();
    fireEvent.click(screen.getByText("rename_button"));
    expect((screen.getByLabelText("upload_object_id", { selector: "input" }) as HTMLInputElement).value).toBe("mapa");
    expect(confirmButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("upload_object_id", { selector: "input" }), { target: { value: "mapa-nuevo" } });
    expect(confirmButton().disabled).toBe(false);
  });

  it("counts the steps the change updates", () => {
    renderPage();
    fireEvent.click(screen.getByText("rename_button"));
    expect(screen.queryByText(echo("rename_steps", { count: 2 }))).not.toBeNull();
  });

  it("shows the upload's rule for an ID it breaks, as typed", () => {
    renderPage();
    openAndType("Mapa-Nuevo");
    expect(screen.queryByText("upload_error_invalid_id")).not.toBeNull();
    expect(confirmButton().disabled).toBe(true);
  });

  it("refuses an ID another object has", () => {
    renderPage();
    openAndType("carta");
    expect(screen.queryByText(echo("rename_taken", { id: "carta" }))).not.toBeNull();
    expect(confirmButton().disabled).toBe(true);
  });

  it("refuses an ID the site reads as another object", () => {
    renderPage({ rename: facts("mapa", ["mapa", "carta.jpg"]) });
    openAndType("carta");
    expect(screen.queryByText(echo("rename_site_taken", { id: "carta", other: "carta.jpg" }))).not.toBeNull();
  });

  it("counts the steps that name no object and that the new ID takes over", () => {
    renderPage({ rename: facts("mapa", ["mapa"], ["mapa", "plano", "Plano.jpg", "otro"]) });
    openAndType("plano");
    expect(screen.queryByText(echo("rename_steps_taken_over", { count: 2, id: "plano" }))).not.toBeNull();
  });

  it("names the text references outside a collision", () => {
    renderPage();
    fireEvent.click(screen.getByText("rename_button"));
    expect(screen.queryByText("rename_texts")).not.toBeNull();
    expect(screen.queryByText("rename_page_address")).not.toBeNull();
  });

  it("inside a collision, shows the warning by the field, the shared image and the steps that keep their value", () => {
    // `map` and `map.jpg` are one object to the site, which shows the later
    // row, `map.jpg`, for both `map` and `map.jpg` in steps. Renaming
    // `map.jpg` rewrites only the step naming it exactly; the step naming
    // `map` keeps its value and shows `map` afterwards.
    renderPage({ objectId: "map.jpg", rename: facts("map.jpg", ["map", "map.jpg"], ["map.jpg", "map"]) });
    expect(screen.queryByText(echo("site_id_shared", { others: "map", shown: "map.jpg" }))).not.toBeNull();
    fireEvent.click(screen.getByText("rename_button"));
    expect(screen.queryByText(echo("rename_steps", { count: 1 }))).not.toBeNull();
    expect(screen.queryByText(echo("rename_steps_kept", { count: 1, after: "map" }))).not.toBeNull();
    expect(screen.queryByText(echo("rename_shared_image", { others: "map" }))).not.toBeNull();
    expect(screen.queryByText("rename_texts")).toBeNull();
  });

  it("inside a collision, counts a rewritten step that shows the other row today apart from the steps that show this one", () => {
    // Rows `map.jpg`, then `map`: the site shows the later row, `map`, for a
    // step valued `map.jpg`. Renaming `map.jpg` rewrites that value, so the
    // step moves from `map` to this object.
    const rename = facts("map.jpg", ["map.jpg", "map"], ["map.jpg"]);
    expect(rename).toMatchObject({ stepsRewritten: 0, stepsTakenOver: 1, takenOverFrom: ["map"], stepsGained: 0 });
    renderPage({ objectId: "map.jpg", rename });
    fireEvent.click(screen.getByText("rename_button"));
    expect(screen.queryByText(echo("rename_steps_switched", { count: 1, shown: "map" }))).not.toBeNull();
    expect(screen.queryByText(/^rename_steps \{/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The post and its answers
// ---------------------------------------------------------------------------

describe("the post", () => {
  it("posts the ID the page showed beside the new one, without switching Sheets off", () => {
    renderPage();
    openAndType("mapa-nuevo");
    submit();
    expect(submissions).toEqual([
      {
        intent: "rename-object",
        objectDbId: String(OBJECT_DB_ID),
        shownObjectId: "mapa",
        newId: "mapa-nuevo",
        confirmedFacts: renameFactsFingerprint(loaderData().rename, "mapa-nuevo"),
      },
    ]);
  });
});

describe("the answers", () => {
  it("moves to the new address on success, keeping the query", () => {
    window.history.replaceState(null, "", "/objects/mapa?site=42");
    const view = renderPage();
    openAndType("mapa-nuevo");
    submit();
    answer(view, success());
    expect(navigate).toHaveBeenCalledWith("/objects/mapa-nuevo?site=42");
  });

  it("stays with a note when the Compositor half is still owed", () => {
    const view = renderPage();
    openAndType("mapa-nuevo");
    submit();
    answer(view, success(true));
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.queryByText("rename_document_pending")).not.toBeNull();
    expect(screen.queryByText("rename_confirm")).toBeNull();
  });

  it("ignores another intent's answer and another object's", () => {
    const view = renderPage();
    openAndType("mapa-nuevo");
    answer(view, { ok: false, error: "forbidden", objectDbId: OBJECT_DB_ID });
    answer(view, { ...success(), objectDbId: OBJECT_DB_ID + 1 });
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.queryByText("rename_forbidden")).toBeNull();
  });

  const refusals: Array<[string, Record<string, string> | undefined, string]> = [
    ["rename_taken", { id: "carta" }, "rename_taken"],
    ["rename_site_taken", { id: "carta", other: "carta.jpg" }, "rename_site_taken"],
    ["rename_file_exists", { file: "mapa-nuevo.png" }, "rename_file_exists"],
    ["rename_stale_head", undefined, "rename_stale_head"],
    ["rename_operation_in_progress", undefined, "rename_operation_in_progress"],
    ["rename_failed", undefined, "rename_failed"],
    ["rename_cache_unreachable", undefined, "rename_cache_unreachable"],
    ["rename_unregistered_files", undefined, "rename_unregistered_files"],
    ["course_item_rename_refused", undefined, "course_item_rename_refused"],
    ["invalid_id", undefined, "upload_error_invalid_id"],
    ["rename_unchanged", undefined, "rename_unchanged"],
    ["rename_sheets_not_disableable", undefined, "rename_sheets_not_disableable"],
    ["rename_id_unreadable", { id: "null" }, "rename_id_unreadable"],
    ["rename_too_many_files", { count: "9500", limit: "9000" }, "rename_too_many_files"],
    ["rename_stale_object", undefined, "rename_stale_object"],
    ["upgrade_required", undefined, "repo_write_upgrade_required"],
    ["upgrade_awaits_convenor", undefined, "repo_write_upgrade_awaits_convenor"],
    ["release_unknown", undefined, "repo_write_release_unknown"],
    ["forbidden", undefined, "rename_forbidden"],
    ["something_new", undefined, "rename_failed"],
  ];
  for (const [error, params, key] of refusals) {
    it(`names the refusal ${error}`, () => {
      const view = renderPage();
      openAndType("mapa-nuevo");
      submit();
      answer(view, refusal(error, params));
      expect(screen.queryByText(echo(key, params))).not.toBeNull();
      expect(navigate).not.toHaveBeenCalled();
    });
  }

  it("shows the facts the action found instead of renaming, says the counts were updated, and posts them next", () => {
    const view = renderPage();
    openAndType("mapa-nuevo");
    submit();
    // The head's sheet has `mapa.jpg` after `mapa`, so both steps show `mapa.jpg` today.
    const found = facts("mapa", ["mapa", "mapa.jpg", "carta"], ["mapa", "mapa", "carta"]);
    answer(view, { ok: false, intent: "rename-object", objectDbId: OBJECT_DB_ID, error: "rename_facts_changed", facts: found });
    expect(screen.queryByText("rename_facts_changed")).not.toBeNull();
    expect(screen.queryByText(echo("rename_steps_switched", { count: 2, shown: "mapa.jpg" }))).not.toBeNull();
    expect(screen.queryByText(echo("rename_steps", { count: 2 }))).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    submit();
    expect(submissions[1].confirmedFacts).toBe(renameFactsFingerprint(found, "mapa-nuevo"));
    expect(submissions[1].confirmedFacts).not.toBe(submissions[0].confirmedFacts);
  });

  it("links to the upgrade from the upgrade refusal", () => {
    const view = renderPage();
    openAndType("mapa-nuevo");
    submit();
    answer(view, refusal("upgrade_required"));
    expect(screen.getByText("upload_upgrade_link").getAttribute("href")).toBe("/upgrade?from=/objects");
  });

  it("offers to switch Google Sheets off, and posts the switch with the same ID", () => {
    const view = renderPage();
    openAndType("mapa-nuevo");
    submit();
    answer(view, refusal("rename_sheets_on"));
    expect(screen.queryByText("rename_sheets_on")).not.toBeNull();
    submit("rename_sheets_confirm");
    expect(submissions[1]).toEqual({
      intent: "rename-object",
      objectDbId: String(OBJECT_DB_ID),
      shownObjectId: "mapa",
      newId: "mapa-nuevo",
      confirmedFacts: renameFactsFingerprint(loaderData().rename, "mapa-nuevo"),
      disableSheets: "true",
    });
  });
});

// ---------------------------------------------------------------------------
// The shared judgement
// ---------------------------------------------------------------------------

describe("renameIdRefusal", () => {
  it("refuses an ID a site before 1.8.0 reads as missing or as a number", () => {
    expect(renameIdRefusal("null", [], "1.7.0")).toEqual({ error: "rename_id_unreadable", params: { id: "null" } });
    expect(renameIdRefusal("1234", [], "1.7.0")).toEqual({ error: "rename_id_unreadable", params: { id: "1234" } });
    expect(renameIdRefusal("1234", [], "1.8.0")).toBeNull();
  });

  it("refuses an ID another row reads as, ignoring case", () => {
    expect(renameIdRefusal("map", ["Map"], "1.8.0")).toEqual({
      error: "rename_site_taken", params: { id: "map", other: "Map" },
    });
  });
});
