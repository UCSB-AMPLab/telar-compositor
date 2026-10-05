// @vitest-environment jsdom

/**
 * The layer panels on the framing stage: where they
 * stand, what is inert under them, where focus goes as they open and close,
 * every way they close, and a panel's identity across the worker assigning
 * its layer's id.
 *
 * The stage is mounted as the story editor mounts it, with `useLayerPanels`
 * holding the panels' state and the URL, as the route does. Every expected
 * box is computed from `panelBox` for the window the test sets. jsdom lays
 * nothing out and applies no CSS, so the pointer-event and covered-control
 * contracts are checked as the classes and rules that carry them.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRoutesStub, useSearchParams } from "react-router";
import { useState, type ComponentProps } from "react";
import { createOsdFake, withPoint } from "./helpers/osd-fake";

const osd = withPoint(createOsdFake());
vi.mock("openseadragon", () => ({ default: osd.ctor }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en", changeLanguage: vi.fn() } }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
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

vi.mock("~/components/features/editor/VideoEmbed", () => ({
  VideoEmbed: () => <div data-testid="video-embed" />,
}));

import { StoryStage } from "~/components/features/editor/StoryStage";
import type { StagePanelLayer } from "~/components/features/editor/StagePanels";
import { useLayerPanels } from "~/hooks/use-layer-panels";
import { panelBox, visitorLayout } from "~/lib/framing-stage";
import { unavailablePanelPreview } from "~/lib/panel-preview-config";
import { resetTargetSaves } from "~/components/ui/target-saves";
import { answerOrUnreachable } from "~/lib/unreachable-write";
import { stampFieldSaveAnswer } from "~/hooks/use-route-field-save";
import * as Y from "yjs";

type Size = { w: number; h: number };
let restore: () => void = () => {};

const ORIGINAL = ["clientWidth", "clientHeight", "offsetHeight"].map(
  (k) => [k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)] as const,
);

function setSizes(win: Size, content: Size = { w: 1240, h: 768 }) {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const saved = ORIGINAL;
  Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => content.w });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => content.h });
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get: () => 200 });
  vi.stubGlobal("innerWidth", win.w);
  vi.stubGlobal("innerHeight", win.h);
  restore = () => {
    for (const [k, d] of saved) if (d) Object.defineProperty(proto, k, d);
  };
}

// jsdom has no layout; CodeMirror's coordsAtPos measures a Range.
const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

beforeEach(() => {
  osd.reset();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  setSizes({ w: 1440, h: 900 });
});
afterEach(async () => {
  cleanup();
  // A draft a field left behind is kept once its save settles: let it, before clearing.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  resetTargetSaves();
  sessionStorage.clear();
  stageAction = (form) => ({ ok: true, nonce: form.nonce });
  inTransit = null;
  savesSeen.length = 0;
  restore();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The editor, as the route holds the panels
// ---------------------------------------------------------------------------

function layer(n: 1 | 2, over: Partial<StagePanelLayer> = {}): StagePanelLayer {
  return {
    key: `L${n}`,
    id: 50 + n,
    layer_number: n,
    title: null,
    button_label: n === 1 ? "About Coordinates" : "Go further",
    content: `Layer ${n} text`,
    titleYText: null,
    contentYText: null,
    buttonLabelYText: null,
    canDelete: true,
    ...over,
  };
}

const FILM = {
  object_id: "film",
  title: "Film",
  thumbnail: null,
  image_available: false,
  source_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  alt_text: null,
};

function step(id: number) {
  return { id, step_number: id - 10, question: `Question ${id}`, answer: "Answer", alt_text: null, object_id: null };
}

interface EditorControls {
  layers: { 1: StagePanelLayer | null; 2: StagePanelLayer | null };
}

let controls: EditorControls;
const deleted: number[] = [];

/** The stage with the route's panel state, and controls a test drives it with. */
/** What the stage's route answers a save with; each test may replace it. */
let stageAction: (form: Record<string, string>) => unknown = (form) => ({ ok: true, nonce: form.nonce });
/** What the save's serverAction throws, for a write that fails in transit; null for none. */
let inTransit: unknown = null;
const savesSeen: Array<Record<string, string>> = [];

async function routeAction({ request }: { request: Request }) {
  const form = Object.fromEntries((await request.clone().formData()).entries()) as Record<string, string>;
  savesSeen.push(form);
  if (inTransit === null) return stageAction(form);
  // As the story route's clientAction answers a write whose serverAction threw.
  const failure = inTransit;
  const answer = await answerOrUnreachable(request, () => Promise.reject(failure));
  stampFieldSaveAnswer(answer);
  return answer;
}

function Editor({
  initial = { 1: layer(1), 2: layer(2) } as EditorControls["layers"],
  link = null as null | 1 | 2,
  siteLang = "en",
  video = false,
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const panels = useLayerPanels(setSearchParams);
  const [stepId, setStepId] = useState(11);
  const [stepIndex, setStepIndex] = useState(1);
  const [layers, setLayers] = useState(initial);
  const [linked, setLinked] = useState(false);
  if (link && !linked) {
    setLinked(true);
    panels.openFromLink(link);
  }
  controls = { layers };
  const s = { ...step(stepId), object_id: video ? "film" : null };
  const props: ComponentProps<typeof StoryStage> = {
    storyTitle: "Story",
    sidebar: (
      <>
        <button type="button" onClick={() => { setStepId(12); setStepIndex(2); panels.closeAll(); }}>
          select step 2
        </button>
        <button type="button" onClick={() => { setStepIndex(0); panels.closeAll(); }}>
          select title card
        </button>
        <button type="button" data-testid="row-layer-1" onClick={(e) => panels.open(stepIndex, 1, e.currentTarget)}>
          row layer 1
        </button>
        <button
          type="button"
          data-testid="row-step-2-layer-1"
          onClick={(e) => {
            setStepId(12);
            setStepIndex(2);
            setLayers({ 1: layer(1, { key: "B1", id: 61, button_label: "Second step's panel" }), 2: null });
            panels.open(2, 1, e.currentTarget);
          }}
        >
          row step 2 layer 1
        </button>
      </>
    ),
    titleCard: {
      story: { id: 1, title: "Story", subtitle: null, byline: null, show_sections: false },
      storyId: "s1",
      titleYText: null,
      subtitleYText: null,
      bylineYText: null,
      sectionCardCount: 0, sectionTitles: [],
      onToggleShowSections: () => {}, storyIds: [], canRenameId: false, onRenameId: () => {},
    },
    stepIndex,
    step: stepIndex === 0 ? null : s,
    isSectionCard: false,
    storySlug: "s1",
    projectId: 3,
    questionYText: null,
    answerYText: null,
    altTextYText: null,
    layer1: layers[1] && { id: layers[1].id, button_label: layers[1].button_label },
    layer1ButtonLabelYText: null,
    onCreateLayer1: () => {},
    onOpenLayer1: (opener) => panels.open(stepIndex, 1, opener),
    viewer: {
      step: { ...s, x: null, y: null, zoom: null, page: null },
      isStepZero: stepIndex === 0,
      selectionKey: `id:${stepId}`,
      stepDisplayNumber: stepIndex,
      totalSteps: 3,
      objects: video ? [FILM] : [],
      manifestUrl: null,
      infoJsonUrl: null,
      isSelfHosted: false,
      siteBaseUrl: null,
      onCapturePosition: () => {},
      onChangeObject: () => {},
    },
    panelPreview: Promise.resolve(unavailablePanelPreview()),
    panels: {
      layer1: layers[1],
      layer2: layers[2],
      level: panels.level,
      request: panels.request,
      onClose: panels.close,
      onDelete: (n) => deleted.push(n),
      deleteTooltip: "structural.tooltip_cannot_delete",
      onCreateLayer2: () => {},
      onOpenLayer2: (opener) => panels.open(stepIndex, 2, opener),
      objects: [],
      actionUrl: "/",
      siteLang,
    },
  };
  return (
    <>
      <output data-testid="url">{searchParams.toString()}</output>
      <button type="button" onClick={() => { setLayers((l) => ({ ...l, 2: null })); panels.close(2); }}>
        confirm delete layer 2
      </button>
      <button type="button" onClick={() => { setLayers({ 1: null, 2: null }); panels.close(1); }}>
        confirm delete layer 1
      </button>
      <button type="button" onClick={() => setLayers((l) => ({ ...l, 1: l[1] && { ...l[1], id: 99 } }))}>
        assign id
      </button>
      <StoryStage {...props} />
    </>
  );
}

async function mount(props: ComponentProps<typeof Editor> = {}, initialEntry = "/?step=1") {
  const Stub = createRoutesStub([{ path: "/", Component: () => <Editor {...props} />, action: routeAction }]);
  render(<Stub initialEntries={[initialEntry]} />);
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

const panel = (n: 1 | 2) => screen.queryByTestId(`stage-panel-${n}`);
const heading = (n: 1 | 2) => panel(n)!.querySelector("h1.offcanvas-title") as HTMLElement;
const url = () => screen.getByTestId("url").textContent;
const cardPill = () => document.querySelector(".text-card .panel-trigger") as HTMLButtonElement;
const layer2Pill = () => panel(1)!.querySelector("[data-layer2-pill]") as HTMLButtonElement;

function openLayer1() {
  const pill = cardPill();
  pill.focus();
  fireEvent.click(pill);
}

function openLayer2() {
  const pill = layer2Pill();
  pill.focus();
  fireEvent.click(pill);
}

/** Opens a panel's content into its editor, as a click on the rendered text does; returns the editor's text. */
function openContent(n: 1 | 2): HTMLElement {
  fireEvent.click(panel(n)!.querySelector("[data-panel-content]")!);
  return panel(n)!.querySelector(".cm-content") as HTMLElement;
}

/** The link popover of layer 1's content editor, opened from its toolbar with the keyboard. */
function openLinkPopover() {
  const editor = openContent(1);
  act(() => editor.focus());
  fireEvent.click(panel(1)!.querySelector('[title="toolbar.link"]')!, { detail: 0 });
}

// ---------------------------------------------------------------------------

describe("where the panels stand", () => {
  it("in a panel layer of their own, above the chrome, letting pointer events through to the page beside them", async () => {
    await mount();
    openLayer1();
    const layerEl = screen.getByTestId("panel-layer");
    expect(layerEl.contains(panel(1))).toBe(true);
    expect(screen.getByTestId("visitor-layer").contains(panel(1))).toBe(false);
    expect(Number(layerEl.style.zIndex)).toBe(20);
    expect(Number(layerEl.style.zIndex)).toBeGreaterThan(Number(screen.getByTestId("stage-region-controls").style.zIndex));
    expect(layerEl.classList.contains("pointer-events-none")).toBe(true);
    // The panel layer is a sibling of the controls in the stage, not inside the viewer column's content.
    expect(screen.getByTestId("framing-stage").contains(layerEl)).toBe(true);
    const css = readFileSync(join(process.cwd(), "app/styles/visitor-layer.css"), "utf8");
    const rule = css.slice(css.indexOf(".visitor-layer .offcanvas {"), css.indexOf("}", css.indexOf(".visitor-layer .offcanvas {")));
    expect(rule).toContain("pointer-events: auto");
  });

  it.each([
    ["above 1200px", { w: 1440, h: 900 }],
    ["from 1025px to 1200px", { w: 1100, h: 800 }],
    ["in the vertical layout", { w: 390, h: 844 }],
    ["on a phone on its side, with the side card", { w: 844, h: 390 }],
  ])("at each width tier, both layers by panelBox: %s", async (_tier, win) => {
    setSizes(win);
    await mount();
    openLayer1();
    openLayer2();
    for (const n of [1, 2] as const) {
      const box = panelBox(n, win.w, win.h);
      const el = panel(n)!;
      expect(parseFloat(el.style.left), `layer ${n} left`).toBeCloseTo(box.x, 6);
      expect(parseFloat(el.style.top), `layer ${n} top`).toBeCloseTo(box.y, 6);
      expect(parseFloat(el.style.width), `layer ${n} width`).toBeCloseTo(box.w, 6);
      expect(parseFloat(el.style.height), `layer ${n} height`).toBeCloseTo(box.h, 6);
    }
  });

  it("chooses the vertical panels by the layout's mode, not the card's place: a side card with sheets", async () => {
    const win = { w: 844, h: 390 };
    setSizes(win);
    expect(visitorLayout(win.w, win.h)).toEqual({ mode: "vertical", cardPlacement: "side" });
    await mount();
    expect(screen.getByTestId("step-card").dataset.placement).toBe("side");
    openLayer1();
    expect(panel(1)!.dataset.sheet).toBe("true");
    // No Back in the vertical layout: the close button alone.
    expect(panel(1)!.querySelector(".stage-panel-back")).toBeNull();
  });

  it("shows Back above the vertical layout", async () => {
    await mount();
    openLayer1();
    expect(panel(1)!.querySelector(".stage-panel-back")).not.toBeNull();
    expect(panel(1)!.dataset.sheet).toBeUndefined();
  });
});

describe("the covered panel", () => {
  it("layer 1 is inert under layer 2, and neither layer 2 nor the card is", async () => {
    await mount();
    openLayer1();
    expect(panel(1)!.hasAttribute("inert")).toBe(false);
    openLayer2();
    expect(panel(1)!.hasAttribute("inert")).toBe(true);
    expect(panel(2)!.hasAttribute("inert")).toBe(false);
    expect(screen.getByTestId("step-card").closest("[inert]")).toBeNull();
  });

  it("hides the covered panel's controls once the panel over it has slid in", () => {
    const css = readFileSync(join(process.cwd(), "app/styles/visitor-layer.css"), "utf8");
    expect(css).toContain(
      '.visitor-layer .offcanvas[inert] :is(button, a, [tabindex]:not([tabindex="-1"])):not(.offcanvas-title > [data-in-place], [data-panel-content], [data-prose-link]) {\n  visibility: hidden;\n  transition: visibility 0s linear 0.3s;\n}',
    );
  });

  it("gives focus up when covered, and takes nothing it held over to the panel above", async () => {
    await mount();
    openLayer1();
    const editor = openContent(1);
    editor.focus();
    expect(panel(1)!.contains(document.activeElement)).toBe(true);
    openLayer2();
    expect(panel(1)!.contains(document.activeElement)).toBe(false);
  });
});

describe("what a covered panel owns", () => {
  it("closes its editor's popover when the panel over it opens", async () => {
    await mount();
    openLayer1();
    openLinkPopover();
    expect(await screen.findByPlaceholderText("link_popover.url_placeholder")).toBeTruthy();
    // Opened from the keyboard: no press outside the popover closes it first.
    fireEvent.click(layer2Pill(), { detail: 0 });
    expect(panel(2)).not.toBeNull();
    expect(screen.queryByPlaceholderText("link_popover.url_placeholder")).toBeNull();
  });

  it.each([
    ["the footnote popover", "footnote.button", () => screen.queryByRole("dialog", { name: "footnote.button" })],
    ["the heading menu", "toolbar.heading", () => panel(1)!.querySelector('[title="toolbar.heading"][aria-expanded="true"]')],
    ["the widget menu", "panel.widget", () => panel(1)!.querySelector('[title="panel.widget"][aria-expanded="true"]')],
  ])("closes %s when the panel over it opens", async (_what, title, openThing) => {
    await mount();
    openLayer1();
    const editor = openContent(1);
    act(() => editor.focus());
    fireEvent.click(panel(1)!.querySelector(`[title="${title}"]`)!, { detail: 0 });
    expect(openThing()).not.toBeNull();
    fireEvent.click(layer2Pill(), { detail: 0 });
    expect(panel(2)).not.toBeNull();
    expect(openThing()).toBeNull();
    // Nothing is left counted as open: one Escape closes the panel over it.
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(panel(2)).toBeNull();
  });
});

describe("focus", () => {
  it("moves to the top panel's heading as each opens", async () => {
    await mount();
    openLayer1();
    expect(document.activeElement).toBe(heading(1));
    expect(heading(1).tabIndex).toBe(-1);
    openLayer2();
    expect(document.activeElement).toBe(heading(2));
  });

  it("returns to the opener on close", async () => {
    await mount();
    openLayer1();
    openLayer2();
    fireEvent.click(panel(2)!.querySelector(".btn-close")!);
    expect(panel(2)).toBeNull();
    expect(document.activeElement).toBe(layer2Pill());
    fireEvent.click(panel(1)!.querySelector(".stage-panel-back")!);
    expect(document.activeElement).toBe(cardPill());
  });

  it("returns to the opener from the step list's row", async () => {
    await mount();
    const row = screen.getAllByTestId("row-layer-1")[0];
    row.focus();
    fireEvent.click(row);
    expect(document.activeElement).toBe(heading(1));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(document.activeElement).toBe(row);
  });

  it("moves to another step's layer 1 opened over this one's, and returns to its own opener", async () => {
    await mount();
    const rowA = screen.getAllByTestId("row-layer-1")[0];
    rowA.focus();
    fireEvent.click(rowA);
    const headingA = heading(1);
    expect(document.activeElement).toBe(headingA);
    const rowB = screen.getAllByTestId("row-step-2-layer-1")[0];
    rowB.focus();
    fireEvent.click(rowB);
    expect(heading(1)).not.toBe(headingA);
    expect(document.activeElement).toBe(heading(1));
    expect(titleBlock(1).textContent).toBe("Second step's panel");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(panel(1)).toBeNull();
    expect(document.activeElement).toBe(rowB);
  });

  it("takes another step's layer 1 opened over this step's layer 2 for an opening, not a close", async () => {
    await mount();
    const rowA = screen.getAllByTestId("row-layer-1")[0];
    rowA.focus();
    fireEvent.click(rowA);
    openLayer2();
    expect(document.activeElement).toBe(heading(2));
    const rowB = screen.getAllByTestId("row-step-2-layer-1")[0];
    rowB.focus();
    fireEvent.click(rowB);
    expect(panel(2)).toBeNull();
    expect(document.activeElement).toBe(heading(1));
    expect(titleBlock(1).textContent).toBe("Second step's panel");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(panel(1)).toBeNull();
    expect(document.activeElement).toBe(rowB);
  });

  it("falls back to the card's button when the opener has gone", async () => {
    await mount();
    const row = screen.getAllByTestId("row-layer-1")[0];
    fireEvent.click(row);
    row.remove();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(document.activeElement).toBe(cardPill());
  });

  it("falls back to the shown card's button on a video step, not the scene's hidden measure of it", async () => {
    await mount({ video: true });
    // The scene's hidden cards carry a button of their own, before the card.
    const hidden = document.querySelector('[data-testid="scene-card-measure"] .panel-trigger');
    expect(hidden).not.toBeNull();
    const row = screen.getAllByTestId("row-layer-1")[0];
    fireEvent.click(row);
    row.remove();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByTestId("step-card").querySelector(".panel-trigger"));
  });

  it("passes over an opener now hidden from assistive technology", async () => {
    await mount();
    const row = screen.getAllByTestId("row-layer-1")[0];
    fireEvent.click(row);
    row.setAttribute("aria-hidden", "true");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(document.activeElement).toBe(cardPill());
  });

  it("falls back to the panel layer when the opener and the card's button have gone", async () => {
    await mount();
    const row = screen.getAllByTestId("row-layer-1")[0];
    fireEvent.click(row);
    row.remove();
    cardPill().remove();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByTestId("panel-layer").firstElementChild);
  });

  it("stays on what the author selected when selecting a step closes the panels", async () => {
    await mount();
    openLayer1();
    const select = screen.getAllByText("select step 2")[0];
    select.focus();
    fireEvent.click(select);
    expect(panel(1)).toBeNull();
    expect(document.activeElement).toBe(select);
  });

  it("does not move for a deep link", async () => {
    await mount({ link: 2 }, "/?step=1&layer=2");
    expect(panel(2)).not.toBeNull();
    expect(panel(1)!.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(document.body);
  });
});

describe("every way a panel closes", () => {
  it("Back and the close button, layer 2 leaving layer 1 open", async () => {
    await mount();
    openLayer1();
    openLayer2();
    fireEvent.click(panel(2)!.querySelector(".stage-panel-back")!);
    expect(panel(2)).toBeNull();
    expect(url()).toBe("step=1&layer=1");
    fireEvent.click(panel(1)!.querySelector(".btn-close")!);
    expect(panel(1)).toBeNull();
    expect(url()).toBe("step=1");
  });

  it("Escape and Left arrow, the topmost first", async () => {
    await mount();
    openLayer1();
    openLayer2();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(panel(2)).toBeNull();
    expect(panel(1)).not.toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(panel(1)).toBeNull();
  });

  it("selecting another step or the title card", async () => {
    await mount();
    openLayer1();
    fireEvent.click(screen.getAllByText("select step 2")[0]);
    expect(panel(1)).toBeNull();
    openLayer1();
    fireEvent.click(screen.getAllByText("select title card")[0]);
    expect(screen.queryByTestId("panel-layer")).toBeNull();
  });

  it("deleting layer 2 leaves layer 1 open; deleting layer 1 closes both", async () => {
    await mount();
    openLayer1();
    openLayer2();
    fireEvent.click(panel(2)!.querySelector(".stage-panel-delete")!);
    expect(deleted.pop()).toBe(2);
    fireEvent.click(screen.getByText("confirm delete layer 2"));
    expect(panel(2)).toBeNull();
    expect(panel(1)).not.toBeNull();
    expect(url()).toBe("step=1&layer=1");
    fireEvent.click(screen.getByText("confirm delete layer 1"));
    expect(panel(1)).toBeNull();
    expect(url()).toBe("step=1");
  });

  it("opening a layer writes ?step and ?layer together", async () => {
    await mount({}, "/?step=3");
    openLayer1();
    expect(url()).toBe("step=1&layer=1");
    openLayer2();
    expect(url()).toBe("step=1&layer=2");
  });
});

describe("a panel's identity", () => {
  it("keys two unsaved layers apart", async () => {
    await mount({ initial: { 1: layer(1, { id: 0, key: "temp-a" }), 2: layer(2, { id: 0, key: "temp-b" }) } });
    openLayer1();
    openLayer2();
    expect(panel(1)).not.toBeNull();
    expect(panel(2)).not.toBeNull();
    expect(heading(1)).not.toBe(heading(2));
  });

  /** An unsaved layer, as the shared document makes one: with its Y.Text. */
  const unsaved = () => layer(1, { id: 0, key: "temp-a", contentYText: new Y.Doc().getText("content") });

  it("does not remount an open panel when the worker assigns its id, keeping focus", async () => {
    await mount({ initial: { 1: unsaved(), 2: null } });
    openLayer1();
    const before = panel(1);
    const editor = openContent(1);
    editor.focus();
    fireEvent.click(screen.getByText("assign id"));
    expect(controls.layers[1]!.id).toBe(99);
    expect(panel(1)).toBe(before);
    expect(document.activeElement).toBe(editor);
  });

  it("keeps an open popover when the worker assigns its id", async () => {
    await mount({ initial: { 1: unsaved(), 2: null } });
    openLayer1();
    openLinkPopover();
    const popoverInput = await screen.findByPlaceholderText("link_popover.url_placeholder");
    fireEvent.click(screen.getByText("assign id"), { detail: 0 });
    expect(screen.getByPlaceholderText("link_popover.url_placeholder")).toBe(popoverInput);
  });
});

// ---------------------------------------------------------------------------
// What a panel shows, and its fields
// ---------------------------------------------------------------------------

/** The title's block in the heading, which shows the title and opens its field. */
const titleBlock = (n: 1 | 2) => heading(n).querySelector(":scope > [data-in-place]") as HTMLElement;
/** The pencil beside layer 2's button in layer 1's content. */
const labelPencil = () => panel(1)!.querySelector('.stage-panel-next [aria-label="layer.edit_button_label_aria"]') as HTMLElement;
const titlePencil = (n: 1 | 2) => heading(n).querySelector(".stage-field-pencil > [data-in-place]") as HTMLElement;

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

async function editTitle(n: 1 | 2, text: string) {
  fireEvent.click(titleBlock(n));
  const input = heading(n).querySelector("input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: text } });
  fireEvent.blur(input);
  await settle();
  return input;
}

describe("what a panel shows", () => {
  it("Back, the close button and delete beside it, the heading, the content, and layer 2's button at the end of layer 1's", async () => {
    await mount();
    openLayer1();
    const header = panel(1)!.querySelector(".offcanvas-header")!;
    expect(header.querySelector(".stage-panel-back")!.textContent).toBe("layer.back");
    const actions = header.querySelector(".stage-panel-actions")!;
    expect([...actions.children].map((el) => el.className)).toEqual(["stage-panel-delete", "btn-close"]);
    expect(actions.querySelector(".stage-panel-delete")!.getAttribute("aria-label")).toBe("layer.delete_title");
    const body = panel(1)!.querySelector(".offcanvas-body")!;
    expect(body.firstElementChild).toBe(heading(1));
    const content = body.querySelector(".stage-panel-content")!;
    expect(content.lastElementChild!.querySelector("[data-layer2-pill]")!.textContent).toBe("Go further →");
  });

  it("offers the dashed button that adds layer 2 where there is none, and nothing of the kind on layer 2", async () => {
    await mount({ initial: { 1: layer(1), 2: null } });
    openLayer1();
    expect(panel(1)!.querySelector(".stage-panel-add")!.textContent).toBe("layer.add_further_panel");
    expect(panel(1)!.querySelector("[data-layer2-pill]")).toBeNull();
  });

  it("has no button-label field: each label is edited on its button", async () => {
    await mount();
    openLayer1();
    openLayer2();
    for (const n of [1, 2] as const) {
      expect(panel(n)!.querySelectorAll("input")).toHaveLength(0);
      expect(panel(n)!.textContent).not.toContain("button_label_strip_label");
    }
  });

  it.each([
    ["en", "About Coordinates", "Go further", "About Coordinates", "Go further"],
    ["en", "", "", "Learn more", "Go deeper"],
    ["es", "", "", "Saber más", "Profundizar"],
  ])("heads an untitled panel as the site does (%s, labels %j and %j)", async (lang, label1, label2, heading1, heading2) => {
    await mount({ siteLang: lang, initial: { 1: layer(1, { button_label: label1 }), 2: layer(2, { button_label: label2 }) } });
    openLayer1();
    openLayer2();
    for (const [n, expected] of [[1, heading1], [2, heading2]] as const) {
      const shown = titleBlock(n).querySelector(".text-gray-400");
      expect(shown?.textContent, `layer ${n}`).toBe(expected);
    }
  });

  it("opens an untitled panel's field empty, and stores nothing when it is finished unedited", async () => {
    await mount();
    openLayer1();
    fireEvent.click(titleBlock(1));
    const input = heading(1).querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("");
    fireEvent.blur(input);
    await settle();
    expect(savesSeen).toHaveLength(0);
    expect(titleBlock(1).querySelector(".text-gray-400")?.textContent).toBe("About Coordinates");
  });

  it("keeps a stored title equal to a default label, shown as the title and not as the placeholder", async () => {
    await mount({ initial: { 1: layer(1, { title: "Learn more", button_label: "About Coordinates" }), 2: null } });
    openLayer1();
    expect(titleBlock(1).querySelector(".text-gray-400")).toBeNull();
    expect(titleBlock(1).textContent).toBe("Learn more");
    fireEvent.click(titleBlock(1));
    expect((heading(1).querySelector("input") as HTMLInputElement).value).toBe("Learn more");
  });

  it("keeps each layer's title its own: saving layer 2's leaves layer 1's under it as it was", async () => {
    await mount();
    openLayer1();
    openLayer2();
    await editTitle(2, "Second title");
    expect(savesSeen.at(-1)).toEqual(expect.objectContaining({ layerId: "52", field: "title", value: "Second title" }));
    expect(titleBlock(2).textContent).toBe("Second title");
    expect(titleBlock(1).querySelector(".text-gray-400")?.textContent).toBe("About Coordinates");
  });

  it("opens the title's field from its pencil too", async () => {
    await mount();
    openLayer1();
    fireEvent.click(titlePencil(1));
    expect(heading(1).querySelector("input")).not.toBeNull();
  });

  it("saves a title through autosave-layer to the layer's database id", async () => {
    await mount();
    openLayer1();
    await editTitle(1, "Coordinates");
    expect(savesSeen).toEqual([expect.objectContaining({ intent: "autosave-layer", layerId: "51", field: "title", value: "Coordinates" })]);
    expect(heading(1).querySelector("input")).toBeNull();
    expect(titleBlock(1).textContent).toBe("Coordinates");
  });
});

describe("a panel's delete button", () => {
  it("does nothing where the layer may not be deleted, and says why", async () => {
    await mount({ initial: { 1: layer(1, { canDelete: false }), 2: null } });
    openLayer1();
    const del = panel(1)!.querySelector(".stage-panel-delete") as HTMLButtonElement;
    expect(del.getAttribute("aria-disabled")).toBe("true");
    expect(del.title).toBe("structural.tooltip_cannot_delete");
    deleted.length = 0;
    fireEvent.click(del);
    expect(deleted).toEqual([]);
  });
});

describe("a layer with no database id yet, and no Y.Text", () => {
  it("sends no save for its title, and says the change was not saved", async () => {
    await mount({ initial: { 1: layer(1, { id: 0, key: "temp-a" }), 2: null } });
    openLayer1();
    await editTitle(1, "Nowhere to go");
    expect(savesSeen).toHaveLength(0);
    expect(heading(1).querySelector('[data-testid="in-place-save-error"]')!.textContent).toBe("stage.save_failed");
  });
});

describe("the covered panel's controls", () => {
  it("the adapted rule hides the title's pencil and the other controls, and not the title's text", async () => {
    await mount();
    openLayer1();
    openLayer2();
    const css = readFileSync(join(process.cwd(), "app/styles/visitor-layer.css"), "utf8");
    const at = css.indexOf(".visitor-layer .offcanvas[inert]");
    const selector = css.slice(at, css.indexOf(" {", at));
    const covered = panel(1)!;
    expect(titlePencil(1).matches(selector)).toBe(true);
    expect(covered.querySelector(".btn-close")!.matches(selector)).toBe(true);
    expect(covered.querySelector("[data-layer2-pill]")!.matches(selector)).toBe(true);
    expect(titleBlock(1).matches(selector)).toBe(false);
    // Not the heading itself, which takes focus by script only.
    expect(heading(1).matches(selector)).toBe(false);
    // And nothing on the panel over it.
    expect(titlePencil(2).matches(selector)).toBe(false);
  });
});

describe("layer 2's button label, edited on layer 1's button for it", () => {
  it("writes layer 2's own button_label Y.Text, and shows a collaborator's edit", async () => {
    const doc = new Y.Doc();
    const label2 = doc.getText("layer2-label");
    label2.insert(0, "Go further");
    await mount({ initial: { 1: layer(1), 2: layer(2, { buttonLabelYText: label2 }) } });
    openLayer1();
    fireEvent.click(labelPencil());
    const input = panel(1)!.querySelector(".stage-panel-next input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Further still" } });
    expect(label2.toString()).toBe("Further still");
    fireEvent.blur(input);
    await settle();
    expect(layer2Pill().textContent).toBe("Further still →");
    // A collaborator's edit, from another document.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    doc.on("update", (u: Uint8Array) => Y.applyUpdate(peer, u));
    peer.on("update", (u: Uint8Array) => Y.applyUpdate(doc, u));
    act(() => {
      const t = peer.getText("layer2-label");
      peer.transact(() => {
        t.delete(0, t.length);
        t.insert(0, "Their label");
      });
    });
    expect(layer2Pill().textContent).toBe("Their label →");
    expect(savesSeen).toHaveLength(0);
  });

  it("saves layer 2's label to layer 2's row without a Y.Text", async () => {
    await mount();
    openLayer1();
    fireEvent.click(labelPencil());
    const input = panel(1)!.querySelector(".stage-panel-next input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Deeper" } });
    fireEvent.blur(input);
    await settle();
    expect(savesSeen).toEqual([expect.objectContaining({ layerId: "52", field: "button_label", value: "Deeper" })]);
  });

  it("keeps its target apart from the titles': a saved label leaves both titles as they were", async () => {
    await mount();
    openLayer1();
    fireEvent.click(labelPencil());
    const input = panel(1)!.querySelector(".stage-panel-next input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Deeper" } });
    fireEvent.blur(input);
    await settle();
    expect(titleBlock(1).textContent).toBe("About Coordinates");
    openLayer2();
    expect(titleBlock(2).querySelector(".text-gray-400")?.textContent).toBe("Go further");
  });

  it("opens layer 2 from the button, not the label's field", async () => {
    await mount();
    openLayer1();
    fireEvent.click(layer2Pill());
    expect(panel(2)).not.toBeNull();
    expect(panel(1)!.querySelector(".stage-panel-next input")).toBeNull();
  });
});

describe("a failed save of a panel's field", () => {
  const failures: Array<[string, () => void]> = [
    ["refused", () => { stageAction = (form) => ({ ok: false, nonce: form.nonce }); }],
    ["failed in transit", () => { inTransit = new TypeError("Failed to fetch"); }],
  ];

  it.each(failures)("the title, %s: stage.save_failed under the open field, with the draft", async (_what, fail) => {
    fail();
    await mount();
    openLayer1();
    const input = await editTitle(1, "Unsaved title");
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe("Unsaved title");
    expect(heading(1).querySelector('[data-testid="in-place-save-error"]')!.textContent).toBe("stage.save_failed");
  });

  it.each(failures)("layer 2's label, %s: stage.save_failed under the open field, with the draft", async (_what, fail) => {
    fail();
    await mount();
    openLayer1();
    fireEvent.click(labelPencil());
    const input = panel(1)!.querySelector(".stage-panel-next input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Unsaved label" } });
    fireEvent.blur(input);
    await settle();
    expect(input.isConnected).toBe(true);
    expect(panel(1)!.querySelector('.stage-panel-next [data-testid="in-place-save-error"]')!.textContent).toBe("stage.save_failed");
  });

  it("keeps the title's draft across the panel closing and opening again, with Retry and Discard, and apart from the label's", async () => {
    stageAction = (form) => ({ ok: false, nonce: form.nonce });
    await mount();
    openLayer1();
    await editTitle(1, "Kept title");
    // The panel goes with the field still open, its save failing again.
    fireEvent.click(panel(1)!.querySelector(".btn-close")!);
    await settle();
    expect(panel(1)).toBeNull();
    openLayer1();
    expect(titleBlock(1).dataset.recovered).toBe("true");
    // Layer 2's label, another target, has nothing waiting.
    expect(labelPencil().dataset.recovered).toBeUndefined();
    fireEvent.click(titleBlock(1));
    expect((heading(1).querySelector("input") as HTMLInputElement).value).toBe("Kept title");
    expect(screen.getByTestId("in-place-recovered")).toBeTruthy();
    // Retry, with the route now answering ok.
    stageAction = (form) => ({ ok: true, nonce: form.nonce });
    fireEvent.click(screen.getByText("in_place.recovered_retry"));
    await settle();
    expect(savesSeen.at(-1)).toEqual(expect.objectContaining({ field: "title", value: "Kept title", layerId: "51" }));
    expect(heading(1).querySelector("input")).toBeNull();
    expect(titleBlock(1).dataset.recovered).toBeUndefined();
  });

  it("discards a kept title's draft back to the stored title", async () => {
    stageAction = (form) => ({ ok: false, nonce: form.nonce });
    await mount();
    openLayer1();
    await editTitle(1, "Thrown away");
    fireEvent.click(panel(1)!.querySelector(".btn-close")!);
    await settle();
    openLayer1();
    fireEvent.click(titleBlock(1));
    fireEvent.click(screen.getByText("in_place.recovered_discard"));
    await settle();
    expect(heading(1).querySelector("input")).toBeNull();
    expect(titleBlock(1).querySelector(".text-gray-400")?.textContent).toBe("About Coordinates");
    expect(titleBlock(1).dataset.recovered).toBeUndefined();
  });

  it("the content, refused: stage.save_failed under the editor", async () => {
    stageAction = (form) => ({ ok: false, nonce: form.nonce });
    await mount();
    openLayer1();
    const content = openContent(1);
    const { EditorView } = await import("@codemirror/view");
    const view = EditorView.findFromDOM(content)!;
    act(() => view.dispatch({ changes: { from: 0, insert: "More " } }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1600));
    });
    await settle();
    expect(savesSeen.at(-1)).toEqual(expect.objectContaining({ field: "content", layerId: "51" }));
    expect(panel(1)!.querySelector('[data-testid="editor-save-error"]')!.textContent).toBe("stage.save_failed");
  });
});
