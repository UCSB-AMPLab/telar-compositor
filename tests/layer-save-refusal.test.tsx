// @vitest-environment jsdom
/**
 * A refused layer save leaves the story editor open, and says so. The route's
 * real action and ErrorBoundary run inside createRoutesStub, with the real
 * LayerPanel and its real MarkdownEditor as the page, its fields saving
 * through `useRouteFieldSave` as the stage's do, and its content through the
 * stage's owner of layer content: a layer a collaborator has
 * deleted, or an author who is not a member of the project, answers the save
 * with `{ ok: false }`, and the field that saved shows `stage.save_failed`
 * while the panel stays rendered and the error card does not appear. Nothing
 * is written.
 *
 * `save-layer` has no field posting it, so a stand-in fetcher posts it here to
 * show the route answers it the same way.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, cleanup } from "@testing-library/react";
import { createRoutesStub, useFetcher } from "react-router";
import { EditorView } from "@codemirror/view";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    ydoc: null,
    provider: null,
    isPublishing: false,
    undoManager: null,
    remoteCollaborators: [],
    lastEditorByField: new Map(),
  }),
}));

vi.mock("~/lib/error-capture", () => ({ recordError: vi.fn() }));

const { updateMock, limitMock, requireMemberMock } = vi.hoisted(() => ({
  updateMock: vi.fn(() => ({
    set: vi.fn(() => ({ where: vi.fn(async () => ({ meta: { changes: 1 } })) })),
  })),
  limitMock: vi.fn(async (): Promise<Array<{ projectId: number }>> => [{ projectId: 42 }]),
  requireMemberMock: vi.fn(async () => undefined),
}));

vi.mock("~/lib/db.server", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({ where: () => ({ limit: limitMock }) }),
          where: () => ({ limit: limitMock }),
        }),
      }),
    }),
    update: updateMock,
    batch: async (queries: unknown[]) => Promise.all(queries),
  }),
}));

vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: () => ({ getSession: async () => ({ get: () => undefined }) }),
}));
vi.mock("~/lib/membership.server", () => ({
  requireProjectMember: requireMemberMock,
  requireOwner: vi.fn(async () => undefined),
  resolveActiveProject: vi.fn(async () => null),
}));

import { action, ErrorBoundary } from "~/routes/_app.stories.$storyId";
import { LayerPanel, type LayerFieldSaves } from "~/components/features/editor/LayerPanel";
import type { StagePanelLayer } from "~/components/features/editor/StagePanels";
import { useRouteFieldSave } from "~/hooks/use-route-field-save";
import { useLayerContentDrafts } from "~/hooks/use-layer-content-drafts";
import { resetTargetSaves } from "~/components/ui/target-saves";

// jsdom has no layout; CodeMirror's coordsAtPos measures a Range.
const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

const context = {
  get: () => ({ id: 7, encrypted_access_token: "enc" }),
  cloudflare: { env: { ENCRYPTION_KEY: "key", SESSION_SECRET: "sess", DB: {} } },
} as never;

/** The panels' autosaves are debounced by 1.5s; a round trip follows. */
const SETTLE = { timeout: 6000 };
const TEST_TIMEOUT = 12000;

/** Waits for the action to have read the layer, then for the router to render its answer. */
async function actionAnswered(): Promise<void> {
  await waitFor(() => expect(limitMock).toHaveBeenCalled(), SETTLE);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
}

function panelLayer(n: 1 | 2, id: number, over: Partial<StagePanelLayer> = {}): StagePanelLayer {
  return {
    key: String(id),
    id,
    layer_number: n,
    title: null,
    button_label: n === 1 ? "Learn more" : "Go deeper",
    content: "Body",
    titleYText: null,
    contentYText: null,
    buttonLabelYText: null,
    canDelete: true,
    ...over,
  };
}

/** The panel, with its fields' saves owned above it, as the stage owns them. */
function Editor() {
  const save = useRouteFieldSave();
  const fields: LayerFieldSaves = {
    save: (layer, field, value) =>
      save({ intent: "autosave-layer", layerId: String(layer.id), field, value }),
    fresh: (_layer, _field, value) => value,
    recoveryKey: () => undefined,
    saveErrorMessage: "stage.save_failed",
  };
  const contentDrafts = useLayerContentDrafts({
    scope: { projectId: 42, storyKey: "test-story", actionUrl: "/stories/test-story" },
    send: (_layerId, form, options) => save(form, options),
    errorMessage: "stage.save_failed",
  });
  return (
    <div data-testid="editor">
      <LayerPanel
        layer={panelLayer(1, 99, { title: "Layer" })}
        layer2={panelLayer(2, 100)}
        fields={fields}
        contentDrafts={contentDrafts}
        glossary={{ terms: new Map(), baseUrl: "" }}
        objects={[]}
        actionUrl="/stories/test-story"
      />
      <SaveLayerButton />
    </div>
  );
}

function SaveLayerButton() {
  const fetcher = useFetcher<{ ok: boolean; reason?: string }>();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void fetcher.submit(
            { intent: "save-layer", layerId: "99", content: "x", buttonLabel: "y" },
            { method: "post", action: "/stories/test-story" },
          )
        }
      >
        save-layer
      </button>
      {fetcher.data && (
        <output data-testid="save-layer-answer">{JSON.stringify(fetcher.data)}</output>
      )}
    </>
  );
}

function renderEditor() {
  const Stub = createRoutesStub(
    [{ path: "/stories/:storyId", Component: Editor, action: action as never, ErrorBoundary }],
    context,
  );
  return render(<Stub initialEntries={["/stories/test-story"]} />);
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  limitMock.mockImplementation(async () => [{ projectId: 42 }]);
  requireMemberMock.mockImplementation(async () => undefined);
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  resetTargetSaves();
  consoleError.mockRestore();
});

function refuseAs(refusal: "missing" | "non-member") {
  if (refusal === "missing") limitMock.mockImplementation(async () => []);
  else requireMemberMock.mockImplementation(async () => {
    throw new Response("Forbidden", { status: 403 });
  });
}

const REASON = { missing: "not-found", "non-member": "forbidden" } as const;

function expectEditorStillOpen() {
  expect(screen.queryByTestId("editor")).not.toBeNull();
  expect(screen.queryByText("error.generic_title")).toBeNull();
  expect(screen.queryByText("error.not_available_title")).toBeNull();
}

function contentView(container: HTMLElement): EditorView {
  return EditorView.findFromDOM(container.querySelector(".cm-content") as HTMLElement)!;
}

type Field = {
  name: string;
  edit: (container: HTMLElement) => void;
  /** Where the field says its save failed. */
  shown: () => HTMLElement | null;
};

/** Opens an in-place field from its block, types into it, and finishes it. */
function editInPlace(block: HTMLElement, value: string) {
  fireEvent.click(block);
  const input = document.activeElement as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

const heading = () => document.querySelector("h1.offcanvas-title") as HTMLElement;

const FIELDS: Field[] = [
  {
    name: "the panel title",
    edit: () => editInPlace(heading().querySelector(":scope > [data-in-place]") as HTMLElement, "New title"),
    shown: () => heading().querySelector('[data-testid="in-place-save-error"]'),
  },
  {
    name: "the layer-2 button label",
    edit: () => editInPlace(screen.getByRole("button", { name: "layer.edit_button_label_aria" }), "Deeper still"),
    shown: () => document.querySelector('.stage-panel-next [data-testid="in-place-save-error"]'),
  },
  {
    name: "the layer content",
    edit: (container) => {
      // Opened from its rendered text, as the author opens it.
      fireEvent.click(container.querySelector("[data-panel-content]")!);
      const view = contentView(container);
      act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: " more" } }));
    },
    shown: () => screen.queryByTestId("editor-save-error"),
  },
];

describe.each(["missing", "non-member"] as const)("a refused autosave-layer (%s layer)", (refusal) => {
  it.each(FIELDS)("$name shows stage.save_failed and the editor stays open", async (field) => {
    refuseAs(refusal);
    const { container } = renderEditor();
    await screen.findByTestId("editor");

    field.edit(container);

    await actionAnswered();
    expectEditorStillOpen();
    await waitFor(() => expect(field.shown()?.textContent).toBe("stage.save_failed"));
    expect(updateMock).not.toHaveBeenCalled();
  }, TEST_TIMEOUT);
});

describe.each(["missing", "non-member"] as const)("a refused save-layer (%s layer)", (refusal) => {
  it("answers ok: false and the editor stays open", async () => {
    refuseAs(refusal);
    renderEditor();
    fireEvent.click(await screen.findByRole("button", { name: "save-layer" }));

    await actionAnswered();
    expectEditorStillOpen();
    const answer = await screen.findByTestId("save-layer-answer");
    expect(JSON.parse(answer.textContent ?? "")).toMatchObject({
      ok: false,
      intent: "save-layer",
      reason: REASON[refusal],
    });
    expect(updateMock).not.toHaveBeenCalled();
  }, TEST_TIMEOUT);
});

describe("an accepted autosave-layer", () => {
  it("writes the layer and reports no failure", async () => {
    renderEditor();
    await screen.findByTestId("editor");
    FIELDS[0].edit(document.body);

    // The layer row and the story's timestamp.
    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(2), SETTLE);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(FIELDS[0].shown()).toBeNull();
    expect(heading().querySelector("input")).toBeNull();
    expectEditorStillOpen();
  }, TEST_TIMEOUT);
});
