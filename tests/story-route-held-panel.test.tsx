// @vitest-environment jsdom

/**
 * The story route over a real Y.Doc, with the real structural operations: a
 * detail panel added from the card is held in the editor and written to the
 * shared document on its first content (use-pending-layers.ts). Leaving the
 * step without content leaves nothing in the document; the first character
 * typed writes the panel once, with the editor still open and its caret after
 * that character.
 *
 * Mounted as story-route-panels.test.tsx mounts the route, with the
 * collaboration context answering with the test's document.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { EditorView } from "@codemirror/view";
import * as Y from "yjs";
import { createOsdFake, withPoint } from "./helpers/osd-fake";
import { unavailablePanelPreview } from "~/lib/panel-preview-config";
import { resetTargetSaves } from "~/components/ui/target-saves";
import { createUndoManager } from "~/lib/undo-manager";

const heldDoc = vi.hoisted(() => ({ current: null as unknown, undoManager: null as unknown, isPublishing: false }));
const osd = withPoint(createOsdFake());
vi.mock("openseadragon", () => ({ default: osd.ctor }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en", changeLanguage: vi.fn() } }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    ydoc: heldDoc.current,
    provider: null,
    isPublishing: heldDoc.isPublishing,
    undoManager: heldDoc.undoManager,
    remoteCollaborators: [],
    lastEditorByField: new Map(),
  }),
  useSetAwarenessLocation: () => () => {},
  FALLBACK_HIGHLIGHT_COLOR: "#000000",
}));
vi.mock("~/hooks/use-toast", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import StoryEditorPage from "../app/routes/_app.stories.$storyId";

// jsdom has no layout; CodeMirror's coordsAtPos measures a Range.
const heldRouteRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= heldRouteRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

function heldStep(id: number, n: number) {
  return {
    id,
    story_id: 1,
    step_number: n,
    kind: "media",
    question: `Question ${n}`,
    answer: "Answer",
    alt_text: null,
    object_id: null,
    x: null,
    y: null,
    zoom: null,
    page: null,
    clip_start: null,
    clip_end: null,
    loop: null,
  };
}

const loaderSteps = [heldStep(11, 1), heldStep(12, 2)];

/** The document as the server hydrates it: the story, its two steps, no panels. */
function hydratedDoc(): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    const story = new Y.Map<unknown>();
    story.set("_id", 1);
    const steps = new Y.Array<Y.Map<unknown>>();
    story.set("steps", steps);
    doc.getArray<Y.Map<unknown>>("stories").push([story]);
    for (const s of loaderSteps) {
      const step = new Y.Map<unknown>();
      step.set("_id", s.id);
      step.set("step_number", s.step_number);
      step.set("kind", "media");
      step.set("question", new Y.Text(s.question));
      step.set("answer", new Y.Text(s.answer));
      step.set("layers", new Y.Array<Y.Map<unknown>>());
      steps.push([step]);
    }
  });
  return doc;
}

function heldSnapshot() {
  return {
    story: { id: 1, project_id: 3, story_id: "s1", title: "Story", subtitle: null, byline: null, order: 1, show_sections: false },
    steps: loaderSteps,
    layers: [],
    objects: [],
    siteBaseUrl: null,
    siteLang: "en",
    repoFullName: "owner/site",
    members: [],
    currentUserId: 7,
    userRole: "convenor",
    panelPreview: Promise.resolve(unavailablePanelPreview()),
  };
}

let doc: Y.Doc;
let restoreHeldSize: () => void = () => {};
beforeEach(() => {
  osd.reset();
  doc = hydratedDoc();
  heldDoc.current = doc;
  heldDoc.undoManager = null;
  heldDoc.isPublishing = false;
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const saved = {
    w: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth"),
    h: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight"),
  };
  Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => 1240 });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 768 });
  vi.stubGlobal("innerWidth", 1440);
  vi.stubGlobal("innerHeight", 900);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
  restoreHeldSize = () => {
    if (saved.w) Object.defineProperty(proto, "clientWidth", saved.w);
    if (saved.h) Object.defineProperty(proto, "clientHeight", saved.h);
  };
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  resetTargetSaves();
  restoreHeldSize();
  vi.unstubAllGlobals();
});

async function settleHeldRoute() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

async function mountHeld(entry: string) {
  const Stub = createRoutesStub([
    { path: "/stories/:storyId", Component: StoryEditorPage as never, loader: (() => heldSnapshot()) as never },
  ]);
  render(<Stub initialEntries={[entry]} />);
  await screen.findAllByText("Question 1");
  await settleHeldRoute();
}

/** A step's map in the document, by its place. */
const heldStepMap = (index: number) => (doc.getArray<Y.Map<unknown>>("stories").get(0).get("steps") as Y.Array<Y.Map<unknown>>).get(index);

/** Step 1's panels in the document. */
const stepOneLayers = () => heldStepMap(0).get("layers") as Y.Array<Y.Map<unknown>>;

/** Starts or ends a publish's freeze; any change to the document renders the route again under it. */
async function setHeldFreeze(on: boolean) {
  heldDoc.isPublishing = on;
  doc.transact(() => (heldStepMap(1).get("question") as Y.Text).insert(0, "x"));
  await settleHeldRoute();
}

/** Opens the held panel's content editor. */
async function openHeldContent() {
  fireEvent.keyDown(screen.getByTestId("stage-panel-1").querySelector("[data-panel-content]")!, { key: "Enter" });
  await settleHeldRoute();
  return contentEditor()!;
}

/** The step list's row for a step, by its question. */
const sidebarRow = (question: string) =>
  screen.getAllByText(question).find((el) =>
    el.closest("button")?.previousElementSibling?.getAttribute("aria-label")?.startsWith("step_line.move_aria"),
  )!;

const addPanelButton = () => screen.queryByText("layer.add_panel");
const contentEditor = () => {
  const content = document.querySelector('[data-testid="stage-panel-1"] .cm-content') as HTMLElement | null;
  return content ? EditorView.findFromDOM(content) : null;
};

/** Opens a field from its pencil, types into it and finishes it. */
async function finishField(pencil: Element, value: string) {
  fireEvent.click(pencil);
  const input = document.activeElement as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
  await settleHeldRoute();
}

async function addAndOpenPanel() {
  fireEvent.click(addPanelButton()!);
  await settleHeldRoute();
  fireEvent.click(document.querySelector(".text-card .panel-trigger")!);
  await settleHeldRoute();
}

describe("a detail panel added from the card", () => {
  it("is shown on the card and not written to the document", async () => {
    await mountHeld("/stories/s1?step=1");
    fireEvent.click(addPanelButton()!);
    await settleHeldRoute();
    expect(document.querySelector(".text-card .panel-trigger")).not.toBeNull();
    expect(stepOneLayers().length).toBe(0);
  });

  it("left without content, leaves nothing in the document and is gone when the step is selected again", async () => {
    await mountHeld("/stories/s1?step=1");
    await addAndOpenPanel();
    fireEvent.click(sidebarRow("Question 2"));
    await settleHeldRoute();
    fireEvent.click(sidebarRow("Question 1"));
    await settleHeldRoute();
    expect(stepOneLayers().length).toBe(0);
    expect(addPanelButton()).not.toBeNull();
  });

  it("deleted before any content, leaves nothing in the document", async () => {
    await mountHeld("/stories/s1?step=1");
    await addAndOpenPanel();
    fireEvent.click(screen.getByTestId("stage-panel-1").querySelector(".stage-panel-delete")!);
    await settleHeldRoute();
    expect(screen.queryByTestId("stage-panel-1")).toBeNull();
    expect(addPanelButton()).not.toBeNull();
    expect(stepOneLayers().length).toBe(0);
  });

  it("is not written by a button label finished on the card, which is written with the panel's first content", async () => {
    await mountHeld("/stories/s1?step=1");
    fireEvent.click(addPanelButton()!);
    await settleHeldRoute();
    await finishField(screen.getByRole("button", { name: "layer.edit_button_label_aria" }), "Read the letter");
    expect(stepOneLayers().length).toBe(0);
    fireEvent.click(document.querySelector(".text-card .panel-trigger")!);
    await settleHeldRoute();
    await finishField(screen.getByTestId("stage-panel-1").querySelector("h1.offcanvas-title > [data-in-place]")!, "Sources");
    expect(stepOneLayers().length).toBe(1);
    expect((stepOneLayers().get(0).get("button_label") as Y.Text).toString()).toBe("Read the letter");
  });

  it("is its own undo step: one Undo removes the panel and keeps a question edited just before", async () => {
    const undo = createUndoManager([doc.getArray("stories")]);
    heldDoc.undoManager = undo;
    await mountHeld("/stories/s1?step=1");
    await addAndOpenPanel();
    const editor = await openHeldContent();
    const question = heldStepMap(0).get("question") as Y.Text;
    doc.transact(() => question.insert(question.length, "!"));
    act(() => editor.dispatch({ changes: { from: 0, insert: "H" }, selection: { anchor: 1 } }));
    await settleHeldRoute();
    expect(stepOneLayers().length).toBe(1);
    act(() => {
      undo.undo();
    });
    expect(stepOneLayers().length).toBe(0);
    expect(question.toString()).toBe("Question 1!");
  });

  it("while a publish holds the document, its open editor is read-only and writes nothing", async () => {
    await mountHeld("/stories/s1?step=1");
    await addAndOpenPanel();
    await openHeldContent();
    heldDoc.isPublishing = true;
    // Any change to the document renders the route again, under the freeze.
    doc.transact(() => (heldStepMap(1).get("question") as Y.Text).insert(0, "x"));
    await settleHeldRoute();
    const editor = contentEditor()!;
    expect(editor.state.readOnly).toBe(true);
    act(() => editor.dispatch({ changes: { from: 0, insert: "H" } }));
    await settleHeldRoute();
    expect(stepOneLayers().length).toBe(0);
  });

  it("keeps a title finished after a publish starts, and writes the panel once the publish ends", async () => {
    await mountHeld("/stories/s1?step=1");
    await addAndOpenPanel();
    fireEvent.click(screen.getByTestId("stage-panel-1").querySelector("h1.offcanvas-title > [data-in-place]")!);
    const input = document.activeElement as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Sources" } });
    await setHeldFreeze(true);
    fireEvent.blur(input);
    await settleHeldRoute();
    expect(stepOneLayers().length).toBe(0);
    expect(screen.getByTestId("stage-panel-1").querySelector("h1.offcanvas-title")!.textContent).toContain("Sources");
    await setHeldFreeze(false);
    expect(stepOneLayers().length).toBe(1);
    expect((stepOneLayers().get(0).get("title") as Y.Text).toString()).toBe("Sources");
  });

  it("given a title during a publish and left for another step, is written to its own step once the publish ends", async () => {
    await mountHeld("/stories/s1?step=1");
    await addAndOpenPanel();
    fireEvent.click(screen.getByTestId("stage-panel-1").querySelector("h1.offcanvas-title > [data-in-place]")!);
    const input = document.activeElement as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Sources" } });
    await setHeldFreeze(true);
    fireEvent.blur(input);
    await settleHeldRoute();
    // The freeze's own document change put an "x" before step 2's question.
    fireEvent.click(sidebarRow("xQuestion 2"));
    await settleHeldRoute();
    expect(screen.queryByTestId("stage-panel-1")).toBeNull();
    await setHeldFreeze(false);
    expect(stepOneLayers().length).toBe(1);
    expect((stepOneLayers().get(0).get("title") as Y.Text).toString()).toBe("Sources");
    expect((heldStepMap(1).get("layers") as Y.Array<Y.Map<unknown>>).length).toBe(0);
  });

  it("given a title during a publish, is still shown on its step after visiting a step that has a panel in the same place", async () => {
    doc.transact(() => {
      const theirs = new Y.Map<unknown>();
      theirs.set("layer_number", 1);
      theirs.set("title", new Y.Text("Theirs"));
      theirs.set("button_label", new Y.Text("Learn more"));
      theirs.set("content", new Y.Text("Saved on step 2"));
      (heldStepMap(1).get("layers") as Y.Array<Y.Map<unknown>>).push([theirs]);
    });
    await mountHeld("/stories/s1?step=1");
    await addAndOpenPanel();
    fireEvent.click(screen.getByTestId("stage-panel-1").querySelector("h1.offcanvas-title > [data-in-place]")!);
    const input = document.activeElement as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Sources" } });
    await setHeldFreeze(true);
    fireEvent.blur(input);
    await settleHeldRoute();
    fireEvent.click(sidebarRow("xQuestion 2"));
    await settleHeldRoute();
    fireEvent.click(sidebarRow("Question 1"));
    await settleHeldRoute();
    expect(document.querySelector(".text-card .panel-trigger")).not.toBeNull();
    await setHeldFreeze(false);
    expect(stepOneLayers().length).toBe(1);
    expect((stepOneLayers().get(0).get("title") as Y.Text).toString()).toBe("Sources");
  });

  it("keeps Bold pressed during a publish in the held text, and writes it only once the publish ends", async () => {
    await mountHeld("/stories/s1?step=1");
    await addAndOpenPanel();
    await openHeldContent();
    await setHeldFreeze(true);
    fireEvent.click(screen.getByTestId("stage-panel-1").querySelector('button[title="toolbar.bold"]')!);
    await settleHeldRoute();
    const shown = contentEditor()!.state.doc.toString();
    expect(shown).not.toBe("");
    expect(stepOneLayers().length).toBe(0);
    await setHeldFreeze(false);
    expect(stepOneLayers().length).toBe(1);
    expect((stepOneLayers().get(0).get("content") as Y.Text).toString()).toBe(shown);
  });

  it("is written by a title of the author's own finished in the panel", async () => {
    await mountHeld("/stories/s1?step=1");
    await addAndOpenPanel();
    await finishField(screen.getByTestId("stage-panel-1").querySelector("h1.offcanvas-title > [data-in-place]")!, "Sources");
    expect(stepOneLayers().length).toBe(1);
    expect((stepOneLayers().get(0).get("title") as Y.Text).toString()).toBe("Sources");
  });

  it("is written once on the first character, the editor staying open with its caret after it", async () => {
    await mountHeld("/stories/s1?step=1");
    await addAndOpenPanel();
    expect(screen.queryByText("layer.add_further_panel")).toBeNull();
    const first = await openHeldContent();
    act(() => first.dispatch({ changes: { from: 0, insert: "H" }, selection: { anchor: 1 } }));
    await settleHeldRoute();
    expect(stepOneLayers().length).toBe(1);
    const content = stepOneLayers().get(0).get("content") as Y.Text;
    expect(content.toString()).toBe("H");
    const bound = contentEditor()!;
    expect(bound.state.selection.main.head).toBe(1);
    act(() => bound.dispatch({ changes: { from: bound.state.selection.main.head, insert: "i" } }));
    await settleHeldRoute();
    expect(content.toString()).toBe("Hi");
    expect(stepOneLayers().length).toBe(1);
    expect(screen.getByText("layer.add_further_panel")).toBeTruthy();
  });
});
