// @vitest-environment jsdom

/**
 * The framing stage as the story editor mounts it: the stage letterboxed at
 * the author's window proportions, the visitor layer scaled onto it, the step
 * card placed by `framing-stage.ts`, and the controls, the ceiling, the word
 * count and the alt-text chip where the rulings put them.
 *
 * Every expected rectangle is computed here from the framing-stage functions
 * and the window and content sizes the test sets, and compared with what the
 * mounted components wrote, so a placement that stops coming from the library
 * fails. jsdom lays nothing out: sizes are stubbed (the content area's
 * `clientWidth`/`clientHeight`, the window's `innerWidth`/`innerHeight`, the
 * card's and the bottom bar's `offsetHeight`), and CSS is not applied, so the
 * pointer-event contract is checked as the classes and rules that carry it.
 * Dragging the image and the card taking clicks are for the browser pass.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRoutesStub, UNSAFE_ErrorResponseImpl } from "react-router";
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
vi.mock("~/components/features/editor/VideoEmbed", async () => {
  const { useEffect } = await import("react");
  return {
    // Reports the aspect a test sets on the global, as the Vimeo player does once ready.
    VideoEmbed: ({ onAspect }: { onAspect?: (aspect: number) => void }) => {
      useEffect(() => {
        const aspect = (globalThis as { __playerAspect?: number }).__playerAspect;
        if (aspect) onAspect?.(aspect);
      }, [onAspect]);
      return <div data-testid="video-embed" />;
    },
  };
});
vi.mock("~/components/features/editor/AudioPlayer", () => ({
  AudioPlayer: () => <div data-testid="audio-player" />,
}));

import { StoryStage, stageChromeFor } from "~/components/features/editor/StoryStage";
import { stageGeometryOf } from "~/hooks/use-stage-geometry";
import { CHROME_DEFAULTS } from "~/lib/stage-chrome";
import { stageBox } from "~/components/features/editor/FramingStage";
import {
  audioControlsBelowBox,
  audioWaveformBox,
  cardBox,
  mediaCardBelow,
  ceilingBox,
  regionOf,
  stageRect,
  videoLayout,
  videoLetterboxRegion,
  mediaTopBand,
  visitorLayout,
  type Box,
} from "~/lib/framing-stage";
import { frameInRegion } from "~/lib/authoring-frame";
import { parsePanelPreviewConfig, unavailablePanelPreview } from "~/lib/panel-preview-config";
import { resetTargetSaves } from "~/components/ui/target-saves";
import { answerOrUnreachable } from "~/lib/unreachable-write";
import { stampFieldSaveAnswer } from "~/hooks/use-route-field-save";

// ---------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------

type Size = { w: number; h: number };

/** The card's content height, and the one-row bottom bar's, in visitor or stage pixels. */
const CARD_CONTENT_H = 300;
/** The shown card's measured height, and the scene's hidden cards' by step key; each test may set them. */
let cardContentH = CARD_CONTENT_H;
const sceneCardHeights: Record<string, number> = {};
const BAR_H = 40;
/** The add-panel row's measured height, on a step without a panel; each test may set it. */
let addPanelRowH = 56;
/** The empty answer's placeholder line, as measured in the shown card. */
let placeholderH = 26;
/** The card's bottom line, as tall as it is drawn; the card does not count it. */
const HINT_H = 18;

let restore: () => void = () => {};

function setSizes(win: Size, content: Size) {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const saved = ["clientWidth", "clientHeight", "offsetHeight"].map(
    (k) => [k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)] as const,
  );
  Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => content.w });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => content.h });
  Object.defineProperty(proto, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.dataset?.testid === "step-card") return cardContentH;
      if (this.dataset?.editorRow === "add-panel") return addPanelRowH;
      if (this.dataset?.testid === "card-hint") return HINT_H;
      if (this.dataset?.inPlace !== undefined && this.dataset.empty !== undefined) return placeholderH;
      // A hidden card of the scene: the height a test gave its step, or the
      // shown card's where the test gave none.
      if (this.dataset?.testid === "scene-card-measure") {
        const key = this.dataset.sceneKey ?? "";
        return sceneCardHeights[key] ?? (key === "k0" || key.startsWith("shown:") ? cardContentH : 0);
      }
      return BAR_H;
    },
  });
  vi.stubGlobal("innerWidth", win.w);
  vi.stubGlobal("innerHeight", win.h);
  restore = () => {
    for (const [k, d] of saved) if (d) Object.defineProperty(proto, k, d);
  };
}

/** A 2D context that draws nothing, so the guides run and place the frame label. */
function withCanvas() {
  const ctx = { setTransform() {}, clearRect() {}, stroke() {}, fill() {}, lineCap: "", strokeStyle: "", lineWidth: 0, fillStyle: "" };
  HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  vi.stubGlobal("Path2D", class { rect() {} arc() {} moveTo() {} lineTo() {} });
  vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => { f(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
}

const MANIFEST = "https://example.org/iiif/plate/manifest.json";

beforeEach(() => {
  osd.reset();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === MANIFEST) {
        return new Response(JSON.stringify({ items: [{ items: [{ items: [{ body: { service: [{ id: "https://example.org/iiif/plate/p1" }] } }] }] }] }));
      }
      return new Response("", { status: 404 });
    }),
  );
  withCanvas();
});
afterEach(() => {
  cleanup();
  resetTargetSaves();
  cardContentH = CARD_CONTENT_H;
  addPanelRowH = 56;
  for (const key of Object.keys(sceneCardHeights)) delete sceneCardHeights[key];
  stageAction = (form) => ({ ok: true, nonce: form.nonce });
  inTransit = null;
  savesSeen.length = 0;
  restore();
  delete (globalThis as { __playerAspect?: number }).__playerAspect;
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

const OBJECTS = {
  image: { object_id: "plate", title: "Plate", thumbnail: null, image_available: true, source_url: MANIFEST, alt_text: null },
  video: { object_id: "film", title: "Film", thumbnail: null, image_available: false, source_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", alt_text: null },
  vimeo: { object_id: "reel", title: "Reel", thumbnail: null, image_available: false, source_url: "https://vimeo.com/76979871", alt_text: null },
  drive: { object_id: "clip", title: "Clip", thumbnail: null, image_available: false, source_url: "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view", alt_text: null },
  audio: { object_id: "song", title: "Song", thumbnail: null, image_available: false, source_url: "song.mp3", alt_text: null },
};

type Kind = keyof typeof OBJECTS;

function stageStep(kind: Kind) {
  return {
    id: 11,
    step_number: 1,
    question: "Notice the head",
    answer: "Spain is depicted as the head of this imperial project.",
    alt_text: null,
    object_id: OBJECTS[kind].object_id,
    x: null,
    y: null,
    zoom: null,
    page: null,
  };
}

type StageProps = ComponentProps<typeof StoryStage>;

function props(kind: Kind, over: Partial<StageProps> = {}): StageProps {
  const step = stageStep(kind);
  return {
    storyTitle: "Story",
    sidebar: <div data-testid="sidebar-content" />,
    titleCard: {
      story: { id: 1, title: "Story", subtitle: null, byline: null, show_sections: false },
      storyId: "s1",
      titleYText: null,
      subtitleYText: null,
      bylineYText: null,
      sectionCardCount: 0, sectionTitles: [],
      onToggleShowSections: () => {}, storyIds: [], canRenameId: false, onRenameId: () => {},
    },
    stepIndex: 1,
    step,
    isSectionCard: false,
    storySlug: "s1",
    projectId: 3,
    questionYText: null,
    answerYText: null,
    altTextYText: null,
    layer1: { id: 5, button_label: "About Coordinates" },
    layer1ButtonLabelYText: null,
    onCreateLayer1: () => {},
    onOpenLayer1: () => {},
    viewer: {
      step,
      isStepZero: false,
      selectionKey: "id:11",
      stepDisplayNumber: 1,
      totalSteps: 3,
      objects: Object.values(OBJECTS),
      manifestUrl: kind === "image" ? MANIFEST : null,
      infoJsonUrl: null,
      isSelfHosted: false,
      siteBaseUrl: "https://example.org/site",
      onCapturePosition: () => {},
      onChangeObject: () => {},
    },
    panelPreview: Promise.resolve(unavailablePanelPreview()),
    ...over,
  };
}

/** What the stage's route answers a save with; each test may replace it. */
let stageAction: (form: Record<string, string>) => unknown = (form) => ({ ok: true, nonce: form.nonce });
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

/** What the save's serverAction throws, for a write that fails in transit; null for none. */
let inTransit: unknown = null;

async function mount(p: StageProps) {
  const Stub = createRoutesStub([
    { path: "/", Component: () => <StoryStage {...p} />, action: routeAction, ErrorBoundary: () => <p>route error</p> },
  ]);
  const view = render(<Stub initialEntries={["/"]} />);
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
  return view;
}

/**
 * The stage for one step, with a control that selects another in place, as
 * the step list does: the stage stays mounted and only its step changes.
 */
async function mountSelectable(first: StageProps, next: StageProps) {
  function Selectable() {
    const [p, setP] = useState(first);
    return (
      <>
        <button type="button" onClick={() => setP(next)}>select next step</button>
        <StoryStage {...p} />
      </>
    );
  }
  const Stub = createRoutesStub([{ path: "/", Component: Selectable, action: routeAction }]);
  render(<Stub initialEntries={["/"]} />);
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function px(el: HTMLElement, prop: "left" | "top" | "width" | "height" | "maxHeight" | "maxWidth" | "bottom"): number {
  return parseFloat(el.style[prop]);
}

function expectBox(el: HTMLElement, box: Box, label: string) {
  expect(px(el, "left"), `${label} left`).toBeCloseTo(box.x, 6);
  expect(px(el, "top"), `${label} top`).toBeCloseTo(box.y, 6);
  expect(px(el, "width"), `${label} width`).toBeCloseTo(box.w, 6);
}

/** The stage for a window and content area, as the editor measures it. */
function stageOf(win: Size, content: Size) {
  return stageRect(content, win)!;
}

/** The region on the stage for an image step. */
function regionOnStage(win: Size, content: Size) {
  const layout = visitorLayout(win.w, win.h);
  return stageBox(regionOf(layout, win.w, win.h), stageOf(win, content).scale);
}

/**
 * Where the stage's chrome puts each piece for an image step with the guides
 * on, at the default sizes: jsdom measures nothing, so those are the sizes the
 * stage lays out with here.
 */
function chromeAt(win: Size, content: Size, opts: { media?: boolean; below?: ReturnType<typeof mediaCardBelow>; publishedHeight?: number } = {}) {
  return stageChromeFor(stageGeometryOf(content, win)!, {
    media: opts.media ?? false,
    below: opts.below ?? null,
    publishedHeight: opts.publishedHeight ?? CARD_CONTENT_H,
    image: !opts.media,
    guidesShown: true,
    sizes: CHROME_DEFAULTS,
  }).layout;
}

/** Geometry the test expects, from the library alone. */
function expected(win: Size, content: Size) {
  const stage = stageRect(content, win)!;
  const layout = visitorLayout(win.w, win.h);
  return { stage, layout, s: stage.w / win.w };
}

// ---------------------------------------------------------------------------

describe("the stage and the visitor layer", () => {
  const win = { w: 1440, h: 900 };
  const content = { w: 1240, h: 768 };

  it("letterboxes the stage at the author's window proportions and scales the window onto it", async () => {
    setSizes(win, content);
    await mount(props("image"));
    const { stage, s } = expected(win, content);
    const el = screen.getByTestId("framing-stage");
    expectBox(el, stage, "stage");
    expect(px(el, "height")).toBeCloseTo(stage.h, 6);
    // The scale is the stage's width over the window's, not the content area's.
    expect(s).not.toBeCloseTo(stage.w / content.w, 3);
    const layer = screen.getByTestId("visitor-layer");
    expect(layer.style.width).toBe("1440px");
    expect(layer.style.height).toBe("900px");
    expect(layer.style.transform).toBe(`scale(${s})`);
    expect(layer.style.transformOrigin).toBe("0 0");
  });

  it("fills the margins around the stage with the chrome's colour, and keeps the weave inside it", async () => {
    setSizes(win, content);
    await mount(props("image"));
    const area = screen.getByTestId("stage-area");
    expect(area.classList.contains("bg-charcoal")).toBe(true);
    expect(area.classList.contains("iiif-viewer-surface")).toBe(false);
    const weaves = [...document.querySelectorAll(".iiif-viewer-surface")];
    expect(weaves.length).toBeGreaterThan(0);
    for (const weave of weaves) expect(screen.getByTestId("framing-stage").contains(weave)).toBe(true);
  });

  it("stacks the image, the visitor layer and the controls at explicit levels", async () => {
    setSizes(win, content);
    await mount(props("image"));
    const layer = screen.getByTestId("visitor-layer");
    const controls = screen.getByTestId("stage-region-controls");
    const image = document.querySelector('[role="img"][aria-label]')!.closest('[style*="z-index"]') as HTMLElement;
    expect(Number(image.style.zIndex)).toBe(0);
    expect(Number(layer.style.zIndex)).toBe(10);
    expect(Number(controls.style.zIndex)).toBe(15);
    // The layer panels stand above all three (stage-panels.test.tsx).
  });

  it("passes pointer events through the layer and the region to the image, and gives them to the card and the controls", async () => {
    setSizes(win, content);
    await mount(props("image"));
    expect(screen.getByTestId("visitor-layer").classList.contains("pointer-events-none")).toBe(true);
    const controls = screen.getByTestId("stage-region-controls");
    expect(controls.classList.contains("pointer-events-none")).toBe(true);
    expect(controls.className).toContain("[&>*]:pointer-events-auto");
    const css = readFileSync(join(process.cwd(), "app/styles/visitor-layer.css"), "utf8");
    const cardRule = css.slice(css.indexOf(".visitor-layer .text-card {"), css.indexOf("}", css.indexOf(".visitor-layer .text-card {")));
    expect(cardRule).toContain("pointer-events: auto");
    // The ceiling is a mark, not a surface.
    const ceilingRule = css.slice(css.indexOf(".visitor-layer .card-ceiling {"), css.indexOf("}", css.indexOf(".visitor-layer .card-ceiling {")));
    expect(ceilingRule).toContain("pointer-events: none");
  });
});

describe("the step card, placed by framing-stage", () => {
  it("horizontal: a side card as tall as its content, centred, the dashed ceiling and the count under it", async () => {
    const win = { w: 1440, h: 900 };
    const content = { w: 1240, h: 768 };
    setSizes(win, content);
    await mount(props("image"));
    const { layout, s } = expected(win, content);
    expect(layout).toEqual({ mode: "horizontal", cardPlacement: "side" });

    const card = screen.getByTestId("step-card");
    expect(card.dataset.placement).toBe("side");
    expectBox(card, cardBox(layout, win.w, win.h, { contentHeight: CARD_CONTENT_H }), "card");
    const ceiling = ceilingBox(layout, win.w, win.h)!;
    expect(px(card, "maxHeight")).toBeCloseTo(ceiling.h, 6);

    const mark = screen.getByTestId("card-ceiling");
    expectBox(mark, ceiling, "ceiling");
    expect(mark.getAttribute("aria-label")).toBe("stage.card_ceiling");

    const counter = screen.getByTestId("stage-line-counter");
    const onStage = stageBox(ceiling, s);
    expect(px(counter, "left")).toBeCloseTo(onStage.x, 6);
    expect(px(counter, "top")).toBeCloseTo(onStage.y + onStage.h + 8, 6);
    expect(counter.textContent).toContain("answer_budget_count");
  });

  it("vertical: the bottom card at its fixed height, no ceiling, the count on the card's top edge", async () => {
    const win = { w: 390, h: 844 };
    const content = { w: 390, h: 712 };
    setSizes(win, content);
    await mount(props("image"));
    const { layout, s } = expected(win, content);
    expect(layout).toEqual({ mode: "vertical", cardPlacement: "bottom" });

    const card = screen.getByTestId("step-card");
    const box = cardBox(layout, win.w, win.h);
    expectBox(card, box, "card");
    expect(px(card, "height")).toBeCloseTo(box.h, 6);
    expect(screen.queryByTestId("card-ceiling")).toBeNull();

    const counter = screen.getByTestId("stage-line-counter");
    const onStage = stageBox(box, s);
    const at = chromeAt(win, content).counter!;
    expectBox(counter, at, "counter");
    expect(at.y + at.h).toBeCloseTo(onStage.y - 6, 6);
  });

  it("a phone held sideways: a side card in vertical layout, its ceiling the fit model's band under the top controls", async () => {
    const win = { w: 844, h: 390 };
    const content = { w: 844, h: 300 };
    setSizes(win, content);
    await mount(props("image"));
    const { layout } = expected(win, content);
    expect(layout).toEqual({ mode: "vertical", cardPlacement: "side" });
    const card = screen.getByTestId("step-card");
    expectBox(card, cardBox(layout, win.w, win.h, { contentHeight: CARD_CONTENT_H }), "card");
    const ceiling = ceilingBox(layout, win.w, win.h)!;
    expect(ceiling.h).toBe(309);
    expect(px(card, "maxHeight")).toBeCloseTo(ceiling.h, 6);
    expect(screen.getByTestId("card-ceiling")).toBeTruthy();
  });
});

describe("the region's controls and labels", () => {
  const win = { w: 1440, h: 900 };
  const content = { w: 1240, h: 768 };

  it("places the controls where the chrome puts them, and the alt-text chip above the bottom bar", async () => {
    setSizes(win, content);
    await mount(props("image"));
    const at = chromeAt(win, content);
    const topBar = screen.getByTestId("stage-region-controls").firstElementChild as HTMLElement;
    expectBox(topBar, at.topBar, "top bar");
    expect(at.topBar.x).toBeCloseTo(regionOnStage(win, content).x + 12, 6);
    const chip = screen.getByTestId("alt-text-chip");
    expect(px(chip, "left")).toBeCloseTo(at.chip!.x, 6);
    expect(px(chip, "top")).toBeCloseTo(at.chip!.y, 6);
    expect(at.chip!.y + at.chip!.h).toBeLessThanOrEqual(at.bar!.y);
    expect(chip.className).toContain("bg-anil-deep");
    expect(chip.textContent).toBe("stage.alt_text_add");
    const zoom = screen.getByTestId("zoom-cluster");
    expect(px(zoom, "left")).toBeCloseTo(at.zoom!.x, 6);
    expect(px(zoom, "top")).toBeCloseTo(at.zoom!.y, 6);
    const viewfinder = screen.getByTestId("viewfinder");
    expect(parseFloat(viewfinder.style.right)).toBeCloseTo(stageOf(win, content).w - (at.viewfinder!.x + at.viewfinder!.w), 6);
    expect(px(viewfinder, "top")).toBeCloseTo(at.viewfinder!.y, 6);
    // The hint shows where the chrome gives it room.
    expect(at.hint).toBeDefined();
    expect(screen.getByText("viewer_viewfinder_hint")).toBeTruthy();
  });

  it("puts the stage label in the stage's bottom-left and the frame label inside the frame, under the top bar", async () => {
    setSizes(win, content);
    await mount(props("image"));
    const at = chromeAt(win, content);
    const stageLabel = await screen.findByTestId("stage-label");
    expect(screen.getByTestId("framing-stage").contains(stageLabel)).toBe(true);
    expect(px(stageLabel, "left")).toBeCloseTo(at.stageLabel!.x, 6);
    expect(px(stageLabel, "top")).toBeCloseTo(at.stageLabel!.y, 6);
    expect(px(stageLabel, "maxWidth")).toBeCloseTo(at.stageLabel!.w, 6);
    expect(at.stageLabel!.y + at.stageLabel!.h).toBeCloseTo(stageOf(win, content).h - 12, 6);
    expect(at.stageLabel!.x).toBeGreaterThanOrEqual(at.counter!.x + at.counter!.w);
    const frameLabel = screen.getByTestId("frame-label");
    expect(px(frameLabel, "left")).toBeCloseTo(at.frameLabel!.x, 6);
    expect(px(frameLabel, "top")).toBeCloseTo(at.frameLabel!.y, 6);
    expect(at.frameLabel!.y).toBeGreaterThanOrEqual(at.topBar.y + at.topBar.h);
    // Both are neutral: the viewfinder's dark chip, not the accessibility blue.
    expect(stageLabel.className).toContain("bg-black/60");
    expect(frameLabel.className).toContain("bg-black/60");
  });

  it("in portrait, puts the stage label under the frame label, where the bottom card leaves it visible", async () => {
    const win = { w: 390, h: 844 };
    const content = { w: 390, h: 712 };
    setSizes(win, content);
    await mount(props("image"));
    const { layout } = expected(win, content);
    expect(layout.cardPlacement).toBe("bottom");
    const at = chromeAt(win, content);
    const stageLabel = await screen.findByTestId("stage-label");
    const frameLabel = screen.getByTestId("frame-label");
    expect(px(frameLabel, "top")).toBeCloseTo(at.frameLabel!.y, 6);
    expect(px(stageLabel, "top")).toBeCloseTo(at.stageLabel!.y, 6);
    expect(px(stageLabel, "left")).toBeCloseTo(px(frameLabel, "left"), 6);
    expect(at.stageLabel!.y).toBeGreaterThan(at.frameLabel!.y + at.frameLabel!.h);
  });

  it("shows what the dashed ceiling means beside it, with the guides, and hides it with them", async () => {
    setSizes(win, content);
    await mount(props("image"));
    const { layout, s } = expected(win, content);
    const label = await screen.findByTestId("ceiling-label");
    expect(label.textContent).toBe("stage.card_ceiling");
    expect(label.className).toContain("bg-black/60");
    const ceiling = stageBox(ceilingBox(layout, win.w, win.h)!, s);
    const at = chromeAt(win, content).ceilingLabel!;
    expect(px(label, "left")).toBeCloseTo(ceiling.x, 6);
    expect(px(label, "top")).toBeCloseTo(at.y, 6);
    expect(at.y + at.h).toBeCloseTo(ceiling.y - 4, 6);
    // The ceiling keeps the text as its accessible name.
    expect(screen.getByTestId("card-ceiling").getAttribute("aria-label")).toBe("stage.card_ceiling");

    fireEvent.click(await screen.findByRole("button", { name: "viewer_viewfinder_toggle" }));
    await waitFor(() => expect(screen.queryByTestId("ceiling-label")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "viewer_viewfinder_toggle" }));
    await screen.findByTestId("ceiling-label");
  });

  it("labels no ceiling in portrait, where the bottom card has none", async () => {
    setSizes({ w: 390, h: 844 }, { w: 390, h: 712 });
    await mount(props("image"));
    expect(screen.queryByTestId("ceiling-label")).toBeNull();
  });

  it("the alt-text chip opens its field in a popover outside the stage", async () => {
    setSizes(win, content);
    await mount(props("image"));
    fireEvent.click(screen.getByTestId("alt-text-chip"));
    const dialog = await screen.findByRole("dialog", { name: "step.alt_text_section" });
    expect(screen.getByTestId("framing-stage").contains(dialog)).toBe(false);
    expect(dialog.querySelector("textarea")).not.toBeNull();
  });
});

describe("media steps, through the media functions", () => {
  it("video, horizontal: the 16:9 embed in the player's box beside the card, no alt-text chip", async () => {
    const win = { w: 1440, h: 900 };
    const content = { w: 1240, h: 768 };
    setSizes(win, content);
    await mount(props("video"));
    const { layout, s } = expected(win, content);
    const player = screen.getByTestId("video-embed").parentElement!.parentElement!;
    expectBox(player, stageBox(videoLayout(layout.mode, win.w, win.h, 16 / 9).player, s), "player");
    expectBox(screen.getByTestId("step-card"), cardBox(layout, win.w, win.h, { media: true, contentHeight: CARD_CONTENT_H }), "card");
    expect(screen.queryByTestId("alt-text-chip")).toBeNull();
  });

  it("video, vertical: the stacked player and the 35dvh media card", async () => {
    const win = { w: 390, h: 844 };
    const content = { w: 390, h: 712 };
    setSizes(win, content);
    await mount(props("video"));
    const { layout, s } = expected(win, content);
    const player = screen.getByTestId("video-embed").parentElement!.parentElement!;
    expectBox(player, stageBox(videoLayout(layout.mode, win.w, win.h, 16 / 9).player, s), "player");
    const card = screen.getByTestId("step-card");
    const box = cardBox(layout, win.w, win.h, { media: true });
    expect(box.h).toBeCloseTo(win.h * 0.35, 9);
    expect(px(card, "height")).toBeCloseTo(box.h, 6);
  });

  it("audio, beside: the player across the waveform's box, centred on it", async () => {
    const win = { w: 1440, h: 757 };
    const content = { w: 1240, h: 652 };
    cardContentH = 600;
    setSizes(win, content);
    await mount(props("audio"));
    const { layout, s } = expected(win, content);
    expect(mediaCardBelow(layout, win.w, win.h, { kind: "audio", tallestContentHeight: 600 })).toBeNull();
    const wrap = screen.getByTestId("audio-player").parentElement!.parentElement!;
    const box = stageBox(audioWaveformBox(layout.mode, win.w, win.h), s);
    expect(px(wrap, "left")).toBeCloseTo(box.x, 6);
    expect(px(wrap, "width")).toBeCloseTo(box.w, 6);
    expect(px(wrap, "top")).toBeCloseTo(box.y + box.h / 2, 6);
  });

  it("audio, below: the waveform across the width above the card, the card one gutter off the bottom", async () => {
    const win = { w: 1440, h: 757 };
    const content = { w: 1240, h: 652 };
    setSizes(win, content);
    await mount(props("audio"));
    const { layout } = expected(win, content);
    const below = mediaCardBelow(layout, win.w, win.h, { kind: "audio", tallestContentHeight: CARD_CONTENT_H });
    expect(below).not.toBeNull();
    // The waveform and controls row are placed by the real player: stage-audio-waveform.test.tsx.
    expectBox(screen.getByTestId("step-card"), cardBox(layout, win.w, win.h, { media: true, contentHeight: CARD_CONTENT_H, below }), "card");
    // Below its player the card has no ceiling drawn, nor a label for one.
    expect(screen.queryByTestId("card-ceiling")).toBeNull();
    expect(screen.queryByTestId("ceiling-label")).toBeNull();
    const at = chromeAt(win, content, { media: true, below, publishedHeight: CARD_CONTENT_H });
    const counter = screen.getByTestId("stage-line-counter");
    expect(px(counter, "top")).toBeCloseTo(at.counter!.y, 6);
    expect(at.counter!.y + at.counter!.h).toBeLessThanOrEqual(stageOf(win, content).h);
  });
});

describe("a media scene's arrangement, decided by its tallest card", () => {
  const scene = (heights: number[]) =>
    heights.map((_, i) => ({
      key: `k${i}`,
      current: i === 0,
      question: `Question ${i}`,
      answer: "An answer.",
      buttonLabel: null,
    }));

  async function videoScene(win: { w: number; h: number }, heights: number[]) {
    const content = { w: win.w - 200, h: win.h - 105 };
    cardContentH = heights[0];
    heights.forEach((h, i) => { sceneCardHeights[`k${i}`] = h; });
    setSizes(win, content);
    await mount(props("video", { sceneSteps: scene(heights) }));
    return expected(win, content);
  }

  it("goes below at 1440×757 for a 147px card: the player above, the card one gutter off the bottom", async () => {
    const win = { w: 1440, h: 757 };
    const { layout, s } = await videoScene(win, [147]);
    const below = mediaCardBelow(layout, win.w, win.h, { kind: "video", tallestContentHeight: 147 });
    expect(below).not.toBeNull();
    const player = screen.getByTestId("video-embed").parentElement!.parentElement!;
    expectBox(player, stageBox(videoLayout(layout.mode, win.w, win.h, 16 / 9, below).player, s), "player");
    expect(videoLayout(layout.mode, win.w, win.h, 16 / 9, below).arrangement).toBe("below");
    expectBox(screen.getByTestId("step-card"), cardBox(layout, win.w, win.h, { media: true, contentHeight: 147, below }), "card");
    const at = chromeAt(win, { w: win.w - 200, h: win.h - 105 }, { media: true, below, publishedHeight: 147 });
    expectBox(
      screen.getByTestId("stage-region-controls").firstElementChild as HTMLElement,
      at.topBar,
      "top bar",
    );
    expect(at.topBar.x).toBeCloseTo(stageBox(regionOf(layout, win.w, win.h, { media: true, below }), s).x + 12, 6);
    // The word count stays on the stage, clear of the media bar.
    const counter = screen.getByTestId("stage-line-counter");
    expect(px(counter, "top")).toBeCloseTo(at.counter!.y, 6);
    expect(at.counter!.y + at.counter!.h).toBeLessThanOrEqual(at.bar!.y);
  });

  it("stays beside at 1100×900 for a 407px card", async () => {
    const win = { w: 1100, h: 900 };
    const { layout, s } = await videoScene(win, [407]);
    expect(mediaCardBelow(layout, win.w, win.h, { kind: "video", tallestContentHeight: 407 })).toBeNull();
    const player = screen.getByTestId("video-embed").parentElement!.parentElement!;
    expectBox(player, stageBox(videoLayout(layout.mode, win.w, win.h, 16 / 9).player, s), "player");
    expectBox(screen.getByTestId("step-card"), cardBox(layout, win.w, win.h, { media: true, contentHeight: 407 }), "card");
  });

  it("keeps the first step beside when the scene's taller second card does not fit below", async () => {
    const win = { w: 1440, h: 757 };
    const { layout, s } = await videoScene(win, [100, 200]);
    // Alone, the first card would go below; the second card decides.
    expect(mediaCardBelow(layout, win.w, win.h, { kind: "video", tallestContentHeight: 100 })).not.toBeNull();
    expect(mediaCardBelow(layout, win.w, win.h, { kind: "video", tallestContentHeight: 200 })).toBeNull();
    const hidden = screen.getAllByTestId("scene-card-measure");
    expect(hidden).toHaveLength(2);
    // Each hidden card is held under the ceiling, so it measures as the
    // published card does.
    const ceiling = ceilingBox(layout, win.w, win.h, { media: true })!;
    for (const el of hidden) {
      expect(px(el, "maxHeight")).toBe(ceiling.h);
    }
    const player = screen.getByTestId("video-embed").parentElement!.parentElement!;
    expectBox(player, stageBox(videoLayout(layout.mode, win.w, win.h, 16 / 9).player, s), "player");
    expectBox(screen.getByTestId("step-card"), cardBox(layout, win.w, win.h, { media: true, contentHeight: 100 }), "card");
  });
});

describe("a card below its player holds the editor's rows", () => {
  const scene = (heights: number[]) =>
    heights.map((_, i) => ({ key: `k${i}`, current: i === 0, question: `Question ${i}`, answer: "An answer.", buttonLabel: null }));

  /** A scene of `kind` whose shown card is the first of `heights`, as the stage places it. */
  async function belowScene(kind: "video" | "audio", win: Size, heights: number[], over: Partial<StageProps> = {}) {
    const content = { w: win.w - 200, h: win.h - 105 };
    cardContentH = heights[0];
    heights.forEach((h, i) => { sceneCardHeights[`k${i}`] = h; });
    setSizes(win, content);
    await mount(props(kind, { sceneSteps: scene(heights), ...over }));
    const layout = visitorLayout(win.w, win.h);
    const below = mediaCardBelow(layout, win.w, win.h, { kind, tallestContentHeight: Math.max(...heights) });
    expect(below, "the scene goes below").not.toBeNull();
    const published = cardBox(layout, win.w, win.h, { media: true, contentHeight: heights[0], below });
    return { layout, below: below!, published, card: screen.getByTestId("step-card") };
  }

  it("lifts the card by the add-panel row where there is room above it, so the stage card does not scroll", async () => {
    const win = { w: 1440, h: 757 };
    addPanelRowH = 56;
    const { layout, below, published, card } = await belowScene("video", win, [100, 147], { layer1: null });
    const player = videoLayout(layout.mode, win.w, win.h, 16 / 9, below).player;
    // The published card fits where it stands; with the row below it, it would not.
    expect(win.h - published.y).toBeGreaterThanOrEqual(100);
    expect(win.h - published.y).toBeLessThan(100 + addPanelRowH);
    expect(published.y - addPanelRowH).toBeGreaterThanOrEqual(player.y + player.h);
    expect(px(card, "top")).toBeCloseTo(published.y - addPanelRowH, 6);
    expect(px(card, "maxHeight")).toBeGreaterThanOrEqual(100 + addPanelRowH);
    expect(px(card, "left")).toBeCloseTo(published.x, 6);
  });

  it("lifts a step with an empty answer by the placeholder and the row's margins too, so the stage card does not scroll", async () => {
    const win = { w: 1440, h: 757 };
    addPanelRowH = 24;
    placeholderH = 14;
    const margins = vi.spyOn(window, "getComputedStyle").mockReturnValue({ marginTop: "8px", marginBottom: "8px" } as CSSStyleDeclaration);
    try {
      const empty = [
        { key: "k0", current: true, question: "Question 0", answer: "", buttonLabel: null },
        { key: "k1", current: false, question: "Question 1", answer: "An answer.", buttonLabel: null },
      ];
      const { layout, below, published, card } = await belowScene("video", win, [100, 147], { layer1: null, sceneSteps: empty, step: { ...stageStep("video"), answer: "" } });
      const extra = 14 + 8 + 24 + 8;
      const player = videoLayout(layout.mode, win.w, win.h, 16 / 9, below).player;
      expect(published.y - extra).toBeGreaterThanOrEqual(player.y + player.h);
      expect(px(card, "top")).toBeCloseTo(published.y - extra, 6);
      expect(px(card, "maxHeight")).toBeGreaterThanOrEqual(100 + extra);
    } finally {
      margins.mockRestore();
    }
  });

  it("lifts the card only to the player's lowest edge where the row would cross it, and the rest scrolls", async () => {
    const win = { w: 1440, h: 757 };
    addPanelRowH = 56;
    const { layout, below, published, card } = await belowScene("video", win, [147], { layer1: null });
    const player = videoLayout(layout.mode, win.w, win.h, 16 / 9, below).player;
    const playerBottom = player.y + player.h;
    expect(published.y - addPanelRowH).toBeLessThan(playerBottom);
    expect(px(card, "top")).toBeCloseTo(playerBottom, 6);
    expect(px(card, "top")).toBeLessThan(published.y);
    expect(px(card, "maxHeight")).toBeCloseTo(win.h - playerBottom, 6);
    expect(px(card, "maxHeight")).toBeLessThan(147 + addPanelRowH);
  });

  it("lifts an audio scene's card no higher than the controls row under the waveform", async () => {
    const win = { w: 1636, h: 899 };
    addPanelRowH = 56;
    const { below, published, card } = await belowScene("audio", win, [284], { layer1: null });
    const controls = audioControlsBelowBox(win.w, win.h, below);
    expect(px(card, "top")).toBeCloseTo(controls.y + controls.h, 6);
    expect(px(card, "top")).toBeGreaterThan(published.y - addPanelRowH);
    expect(px(card, "top")).toBeLessThan(published.y);
  });

  it("does not lift the card of a step with a panel: the hint sits in the card's padding and adds no height", async () => {
    const win = { w: 1440, h: 757 };
    addPanelRowH = 56;
    const { published, card } = await belowScene("video", win, [100, 147]);
    expect(card.querySelector("[data-editor-row]")).toBeNull();
    // The hint is measured at its own height here, and still not counted.
    expect(screen.getByTestId("card-hint").offsetHeight).toBe(HINT_H);
    expect(px(card, "top")).toBeCloseTo(published.y, 6);
    expect(px(card, "maxHeight")).toBeCloseTo(win.h - published.y, 6);
  });
});

describe("the sidebar keeps the shell's lg boundary", () => {
  const tailwindLg = () =>
    readFileSync(join(process.cwd(), "node_modules/tailwindcss/theme.css"), "utf8").includes("--breakpoint-lg: 64rem;");

  for (const win of [{ w: 1024, h: 1366 }, { w: 1600, h: 2200 }]) {
    it(`at ${win.w}×${win.h}, where the visitor's layout is vertical, the static sidebar still shows at lg`, async () => {
      setSizes(win, { w: win.w - 200, h: win.h - 132 });
      await mount(props("image"));
      expect(visitorLayout(win.w, win.h).mode).toBe("vertical");
      expect(tailwindLg()).toBe(true);
      expect(readFileSync(join(process.cwd(), "app/styles/app.css"), "utf8")).not.toContain("--breakpoint-lg");
      const statics = screen.getAllByTestId("sidebar-content").map((el) => el.parentElement!);
      const sidebar = statics.find((el) => el.className.includes("lg:block"))!;
      expect(sidebar.className).toContain("hidden lg:block");
      expect(sidebar.className).not.toMatch(/vertical|max-lg/);
    });
  }
});

describe("focus and keyboard entry into the card", () => {
  it("reaches the question, opens it with Enter and returns to it on Escape", async () => {
    setSizes({ w: 1440, h: 900 }, { w: 1240, h: 768 });
    await mount(props("image"));
    const question = screen.getByRole("button", { name: "step.question_placeholder" });
    expect(question.tabIndex).toBe(0);
    question.focus();
    fireEvent.keyDown(question, { key: "Enter" });
    const input = await waitFor(() => {
      const el = screen.getByTestId("step-card").querySelector("input");
      expect(el).not.toBeNull();
      return el!;
    });
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "step.question_placeholder" })),
    );
  });

  it("orders the card's question, answer and button for Tab, each pencil after its text", async () => {
    setSizes({ w: 1440, h: 900 }, { w: 1240, h: 768 });
    await mount(props("image"));
    const card = screen.getByTestId("step-card");
    const focusable = [...card.querySelectorAll<HTMLElement>('[tabindex="0"], button')];
    expect(focusable.map((el) => el.getAttribute("aria-label") ?? el.textContent)).toEqual([
      "step.question_placeholder",
      "stage.edit_question",
      "step.answer_placeholder",
      "stage.edit_answer",
      "About Coordinates →",
      "layer.edit_button_label_aria",
    ]);
  });
});

describe("the title card and section cards on the stage", () => {
  const sized = () => setSizes({ w: 1440, h: 900 }, { w: 1240, h: 768 });

  it("draws the title card as the story intro in the visitor layer, framing nothing, with its settings above the stage", async () => {
    sized();
    await mount(props("image", { stepIndex: 0, step: null }));
    const layer = screen.getByTestId("visitor-layer");
    expect(layer.contains(screen.getByTestId("story-intro"))).toBe(true);
    expect(layer.className).toContain("pointer-events-auto");
    expect(screen.queryByTestId("step-card")).toBeNull();
    expect(osd.instances).toHaveLength(0);
    expect(screen.getByTestId("framing-stage").contains(screen.getByTestId("title-card-settings"))).toBe(false);
    expect(screen.getByRole("switch", { name: "title_card.show_sections_label" })).toBeTruthy();
    expect(screen.getByText("title_card.story_id_label")).toBeTruthy();
  });

  it("draws a section card as the framework's centred card in the visitor layer, framing nothing", async () => {
    sized();
    await mount(props("image", { isSectionCard: true }));
    const layer = screen.getByTestId("visitor-layer");
    const card = screen.getByTestId("section-card");
    expect(layer.contains(card)).toBe(true);
    expect(card.querySelector("h2.title-card-heading")?.textContent).toBe("Notice the head");
    expect(screen.queryByTestId("step-card")).toBeNull();
    expect(osd.instances).toHaveLength(0);
    expect(screen.queryByTestId("title-card-settings")).toBeNull();
  });

  it("saves a section card's question through the route's step-field save, with no Y.Text", async () => {
    sized();
    await mount(props("image", { isSectionCard: true }));
    fireEvent.click(screen.getByRole("button", { name: "section_card.heading_label" }));
    const input = await waitFor(() => screen.getByTestId("section-card").querySelector("input")!);
    fireEvent.change(input, { target: { value: "Sound and Movement" } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByTestId("section-card").querySelector("input")).toBeNull());
    expect(savesSeen.at(-1)).toMatchObject({ intent: "save-step-field", stepId: "11", field: "question", value: "Sound and Movement" });
    expect(screen.getByTestId("section-card").querySelector("h2")?.textContent).toBe("Sound and Movement");
  });

  it("keeps a section card's field open with its draft when the save is refused", async () => {
    sized();
    stageAction = (form) => ({ ok: false, intent: "save-step-field", reason: "forbidden", nonce: form.nonce });
    await mount(props("image", { isSectionCard: true }));
    fireEvent.click(screen.getByRole("button", { name: "section_card.subtitle_label" }));
    const box = await waitFor(() => screen.getByTestId("section-card").querySelector("textarea")!);
    fireEvent.change(box, { target: { value: "Now we turn to sound." } });
    fireEvent.blur(box);
    await screen.findByText("stage.save_failed");
    expect(screen.getByTestId("section-card").querySelector("textarea")?.value).toBe("Now we turn to sound.");
  });

  it("follows the selection: another step's text on the card", async () => {
    sized();
    const first = props("image");
    const other = { ...stageStep("image"), id: 12, question: "Consider the necklace" };
    await mountSelectable(first, { ...first, step: other, viewer: { ...first.viewer, step: other, selectionKey: "id:12" } });
    await screen.findByText("Notice the head");
    fireEvent.click(screen.getByRole("button", { name: "select next step" }));
    await screen.findByText("Consider the necklace");
    expect(screen.queryByText("Notice the head")).toBeNull();
  });

  it("offers to add a panel where a step without one would show its button", async () => {
    sized();
    const onCreateLayer1 = vi.fn();
    await mount(props("image", { layer1: null, onCreateLayer1 }));
    fireEvent.click(screen.getByRole("button", { name: "layer.add_panel" }));
    expect(onCreateLayer1).toHaveBeenCalledTimes(1);
  });
});



/**
 * Unmounts a stage whose field holds a failed draft and lets the draft reach
 * its target's saves before they are reset, so the next test's
 * field does not open it as a recovered draft.
 */
async function leaveNoDraft() {
  cleanup();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  resetTargetSaves();
  sessionStorage.clear();
}

/** The field's failure path: its error line, with the failed-save message. */
async function expectSaveFailed() {
  await waitFor(() => expect(screen.queryByTestId("in-place-save-error")?.textContent).toBe("stage.save_failed"), {
    timeout: 3000,
  });
}

describe("the layer button's label, saved without a Y.Text", () => {
  async function editPill(text: string) {
    setSizes({ w: 1440, h: 900 }, { w: 1240, h: 768 });
    await mount(props("image"));
    fireEvent.click(screen.getByRole("button", { name: "layer.edit_button_label_aria" }));
    const input = await waitFor(() => {
      const el = screen.getByTestId("step-card").querySelector(".step-actions input") as HTMLInputElement | null;
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.change(input, { target: { value: text } });
    fireEvent.blur(input);
    return input;
  }

  it("sends the label through autosave-layer and closes on the action's ok", async () => {
    await editPill("Learn about coordinates");
    await waitFor(() => expect(savesSeen).toHaveLength(1));
    expect(savesSeen[0]).toMatchObject({ intent: "autosave-layer", layerId: "5", field: "button_label", value: "Learn about coordinates" });
    await waitFor(() => expect(screen.getByTestId("step-card").querySelector(".step-actions input")).toBeNull());
  });

  it("keeps the draft open with the failure message when the action answers ok: false", async () => {
    stageAction = (form) => ({ ok: false, nonce: form.nonce });
    const input = await editPill("Refused label");
    await expectSaveFailed();
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe("Refused label");
  });

  it("treats a refusal answered with a non-2xx status as a failed save", async () => {
    stageAction = (form) => Response.json({ ok: false, nonce: form.nonce }, { status: 403 });
    await editPill("Forbidden label");
    await expectSaveFailed();
  });

  it("does not take an answer that is not the action's for a stored label", async () => {
    stageAction = () => ({ error: "Unknown intent" });
    await editPill("Unanswered label");
    await expectSaveFailed();
  });

  for (const [what, failure] of [
    ["a request that never completes", new TypeError("Failed to fetch")],
    ["a bare 503 from an upstream", new UNSAFE_ErrorResponseImpl(503, "Service Unavailable", "upstream")],
  ] as const) {
    it(`keeps the editor open and the draft, with the failure message, after ${what}`, async () => {
      inTransit = failure;
      const input = await editPill("Label in transit");
      await expectSaveFailed();
      expect(input.isConnected).toBe(true);
      expect(input.value).toBe("Label in transit");
      expect(screen.queryByText("route error")).toBeNull();
      expect(screen.getByTestId("step-card")).toBeTruthy();
      await leaveNoDraft();
    });
  }
});

describe("the layer button opens its panel, and the pencil beside it edits its label", () => {
  const pillButton = () => screen.getByRole("button", { name: "About Coordinates" });
  const pencil = () => screen.getByRole("button", { name: "layer.edit_button_label_aria" });
  const labelInput = () => screen.getByTestId("step-card").querySelector(".step-actions input") as HTMLInputElement | null;
  // Earlier tests leave failed label drafts under the same row's key.
  beforeEach(() => sessionStorage.clear());
  afterEach(() => sessionStorage.clear());

  async function mountWithOpen() {
    setSizes({ w: 1440, h: 900 }, { w: 1240, h: 768 });
    const onOpenLayer1 = vi.fn();
    await mount(props("image", { onOpenLayer1 }));
    return onOpenLayer1;
  }

  async function openByPencil() {
    fireEvent.click(pencil());
    return waitFor(() => {
      expect(labelInput()).not.toBeNull();
      return labelInput()!;
    });
  }

  it("opens the first panel from the button, and does not edit its label", async () => {
    const onOpenLayer1 = await mountWithOpen();
    fireEvent.click(pillButton());
    expect(onOpenLayer1).toHaveBeenCalledTimes(1);
    expect(labelInput()).toBeNull();
    expect(pencil()).toBeTruthy();
  });

  it("is a native button reached by Tab, so Enter and Space open the panel; a key on it never edits", async () => {
    const onOpenLayer1 = await mountWithOpen();
    const pill = pillButton();
    expect(pill.tagName).toBe("BUTTON");
    expect(pill.getAttribute("type")).toBe("button");
    expect(pill.tabIndex).toBe(0);
    pill.focus();
    expect(document.activeElement).toBe(pill);
    fireEvent.keyDown(pill, { key: "Enter" });
    fireEvent.keyDown(pill, { key: " " });
    expect(labelInput()).toBeNull();
    // A browser activates a focused button on Enter or Space by clicking it.
    fireEvent.click(pill);
    expect(onOpenLayer1).toHaveBeenCalledTimes(1);
  });

  it("edits the label from the pencil, in place of the button, and does not open the panel", async () => {
    const onOpenLayer1 = await mountWithOpen();
    const input = await openByPencil();
    expect(input.value).toBe("About Coordinates");
    expect(screen.queryByRole("button", { name: "About Coordinates" })).toBeNull();
    expect(screen.queryByRole("button", { name: "layer.edit_button_label_aria" })).toBeNull();
    expect(onOpenLayer1).not.toHaveBeenCalled();
  });

  it("opens the field from the pencil with Enter", async () => {
    const onOpenLayer1 = await mountWithOpen();
    fireEvent.keyDown(pencil(), { key: "Enter" });
    await waitFor(() => expect(labelInput()).not.toBeNull());
    expect(onOpenLayer1).not.toHaveBeenCalled();
  });

  it("saves the label typed there and closes back to the button and the pencil", async () => {
    const onOpenLayer1 = await mountWithOpen();
    const input = await openByPencil();
    fireEvent.change(input, { target: { value: "Learn about coordinates" } });
    fireEvent.blur(input);
    await waitFor(() => expect(savesSeen).toHaveLength(1));
    expect(savesSeen[0]).toMatchObject({ intent: "autosave-layer", layerId: "5", field: "button_label", value: "Learn about coordinates" });
    await waitFor(() => expect(labelInput()).toBeNull());
    expect(screen.getByRole("button", { name: "Learn about coordinates" }).className).toContain("panel-trigger");
    expect(pencil()).toBeTruthy();
    expect(onOpenLayer1).not.toHaveBeenCalled();
  });

  it("keeps the draft open with stage.save_failed when the save fails", async () => {
    stageAction = (form) => ({ ok: false, nonce: form.nonce });
    await mountWithOpen();
    const input = await openByPencil();
    fireEvent.change(input, { target: { value: "Refused label" } });
    fireEvent.blur(input);
    await expectSaveFailed();
    expect(labelInput()).toBe(input);
    expect(input.value).toBe("Refused label");
    expect(screen.queryByRole("button", { name: "Refused label" })).toBeNull();
  });

  it("says the pencil's words on the card's bottom line, the marker's line, not beside a button that may fill the card", async () => {
    await mountWithOpen();
    const line = screen.getByTestId("card-hint");
    fireEvent.pointerOver(pencil());
    expect(line.dataset.kind).toBe("pencil");
    expect(line.textContent).toBe("layer.edit_button_label");
    expect(pencil().getAttribute("aria-label")).toBe("layer.edit_button_label_aria");
    // Nothing between the pencil and the card is positioned, so the marker
    // the pencil's block carries is placed against the card.
    const card = screen.getByTestId("step-card");
    for (let el = pencil().parentElement; el && el !== card; el = el.parentElement) {
      expect(el.className, el.tagName).not.toMatch(/\b(relative|absolute|fixed|sticky)\b|translate|transform/);
      expect(el.style.position, el.tagName).toBe("");
    }
    const css = readFileSync(join(process.cwd(), "app/styles/visitor-layer.css"), "utf8");
    const ruleOf = (selector: string) => {
      const at = css.indexOf(`${selector} {`);
      expect(at, selector).toBeGreaterThan(-1);
      return css.slice(at, css.indexOf("}", at));
    };
    expect(ruleOf(".visitor-layer .text-card")).toContain("position: absolute");
    const hintRule = ruleOf(".visitor-layer .text-card .stage-card-hint");
    const marker = ruleOf(".visitor-layer .text-card [data-in-place-marker]");
    for (const decl of ["position: absolute", "left: 2rem", "right: 2rem", "bottom: 0.3rem"]) {
      expect(hintRule, decl).toContain(decl);
      expect(marker, decl).toContain(decl);
    }
    expect(hintRule).toContain("white-space: nowrap");
    expect(hintRule).not.toContain("overflow");
  });

  it("marks the pencil while a failed draft of the label waits, and puts it back when the pencil opens the field", async () => {
    stageAction = (form) => ({ ok: false, nonce: form.nonce });
    setSizes({ w: 1440, h: 900 }, { w: 1240, h: 768 });
    const first = await mount(props("image"));
    const input = await openByPencil();
    fireEvent.change(input, { target: { value: "Left behind" } });
    first.unmount();
    await waitFor(() => expect(JSON.stringify({ ...sessionStorage })).toContain("project:3/layer:5/button_label"));
    await mount(props("image"));
    const described = await waitFor(() => {
      const id = pencil().getAttribute("aria-describedby");
      expect(id).toBeTruthy();
      return id!;
    });
    expect(document.getElementById(described)?.textContent).toBe("in_place.recovered_marker");
    const reopened = await openByPencil();
    expect(reopened.value).toBe("Left behind");
  });
});

describe("the pencils beside the question and the answer open their fields", () => {
  const questionPencil = () => screen.getByRole("button", { name: "stage.edit_question" });
  const answerPencil = () => screen.getByRole("button", { name: "stage.edit_answer" });
  const questionText = () => screen.getByRole("button", { name: "step.question_placeholder" });
  const answerText = () => screen.getByRole("button", { name: "step.answer_placeholder" });
  const questionInput = () => screen.getByTestId("step-card").querySelector(".step-question input") as HTMLInputElement | null;
  const answerInput = () => screen.getByTestId("step-card").querySelector(".step-answer textarea") as HTMLTextAreaElement | null;
  beforeEach(() => sessionStorage.clear());
  afterEach(() => sessionStorage.clear());

  async function mountCard() {
    setSizes({ w: 1440, h: 900 }, { w: 1240, h: 768 });
    const onOpenLayer1 = vi.fn();
    const view = await mount(props("image", { onOpenLayer1 }));
    return { onOpenLayer1, view };
  }

  for (const [what, failure] of [
    ["a request that never completes", new TypeError("Failed to fetch")],
    ["a bare 503 from an upstream", new UNSAFE_ErrorResponseImpl(503, "Service Unavailable", "upstream")],
  ] as const) {
    it(`keeps the editor open and the question's draft, with the failure message, after ${what}`, async () => {
      inTransit = failure;
      await mountCard();
      fireEvent.click(questionText());
      const input = await waitFor(() => questionInput()!);
      fireEvent.change(input, { target: { value: "Question in transit" } });
      fireEvent.blur(input);
      await waitFor(() => expect(savesSeen.at(-1)).toMatchObject({ intent: "save-step-field", field: "question" }));
      await expectSaveFailed();
      expect(questionInput()?.value).toBe("Question in transit");
      expect(screen.queryByText("route error")).toBeNull();
      await leaveNoDraft();
    });
  }

  it("opens the question from its pencil, and not the answer or the panel", async () => {
    const { onOpenLayer1 } = await mountCard();
    fireEvent.click(questionPencil());
    await waitFor(() => expect(questionInput()).not.toBeNull());
    expect(questionInput()!.value).toBe("Notice the head");
    expect(answerInput()).toBeNull();
    expect(screen.queryByRole("button", { name: "stage.edit_question" })).toBeNull();
    expect(answerPencil()).toBeTruthy();
    expect(onOpenLayer1).not.toHaveBeenCalled();
  });

  it("opens the answer from its pencil, and not the question or the panel", async () => {
    const { onOpenLayer1 } = await mountCard();
    fireEvent.click(answerPencil());
    await waitFor(() => expect(answerInput()).not.toBeNull());
    expect(answerInput()!.value).toBe("Spain is depicted as the head of this imperial project.");
    expect(questionInput()).toBeNull();
    expect(screen.queryByRole("button", { name: "stage.edit_answer" })).toBeNull();
    expect(questionPencil()).toBeTruthy();
    expect(onOpenLayer1).not.toHaveBeenCalled();
  });

  it("still opens each field from its text", async () => {
    await mountCard();
    fireEvent.click(questionText());
    await waitFor(() => expect(questionInput()).not.toBeNull());
    expect(answerInput()).toBeNull();
    fireEvent.keyDown(questionInput()!, { key: "Escape" });
    await waitFor(() => expect(questionInput()).toBeNull());
    fireEvent.click(answerText());
    await waitFor(() => expect(answerInput()).not.toBeNull());
    expect(questionInput()).toBeNull();
  });

  it("opens each field from its pencil with Enter", async () => {
    await mountCard();
    fireEvent.keyDown(questionPencil(), { key: "Enter" });
    await waitFor(() => expect(questionInput()).not.toBeNull());
    expect(answerInput()).toBeNull();
    fireEvent.keyDown(questionInput()!, { key: "Escape" });
    await waitFor(() => expect(questionInput()).toBeNull());
    fireEvent.keyDown(answerPencil(), { key: "Enter" });
    await waitFor(() => expect(answerInput()).not.toBeNull());
    expect(questionInput()).toBeNull();
  });

  it("puts focus back on the pencil on Escape when the pencil opened the field, and on the text when the text did", async () => {
    await mountCard();
    questionPencil().focus();
    fireEvent.keyDown(questionPencil(), { key: "Enter" });
    await waitFor(() => expect(document.activeElement).toBe(questionInput()));
    fireEvent.keyDown(questionInput()!, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(questionPencil()));

    fireEvent.click(answerPencil());
    await waitFor(() => expect(document.activeElement).toBe(answerInput()));
    fireEvent.keyDown(answerInput()!, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(answerPencil()));

    fireEvent.click(answerText());
    await waitFor(() => expect(document.activeElement).toBe(answerInput()));
    fireEvent.keyDown(answerInput()!, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(answerText()));
  });

  it("saves the question and the answer opened from their pencils, and closes back to text and pencil", async () => {
    await mountCard();
    fireEvent.click(questionPencil());
    const question = await waitFor(() => questionInput()!);
    fireEvent.change(question, { target: { value: "Notice the crown" } });
    fireEvent.blur(question);
    await waitFor(() => expect(questionInput()).toBeNull());
    expect(savesSeen.at(-1)).toMatchObject({ field: "question", value: "Notice the crown" });
    expect(questionText().textContent).toContain("Notice the crown");
    expect(questionPencil()).toBeTruthy();

    fireEvent.click(answerPencil());
    const answer = await waitFor(() => answerInput()!);
    fireEvent.change(answer, { target: { value: "The crown sits on the head." } });
    fireEvent.blur(answer);
    await waitFor(() => expect(answerInput()).toBeNull());
    expect(savesSeen.at(-1)).toMatchObject({ field: "answer", value: "The crown sits on the head." });
    expect(answerText().textContent).toContain("The crown sits on the head.");
    expect(answerPencil()).toBeTruthy();
  });

  it("stands each pencil in an absolute box of no size after its text, the box holding its words", async () => {
    await mountCard();
    const card = screen.getByTestId("step-card");
    for (const [pencil, field, words] of [
      [questionPencil(), ".step-question", "stage.edit_question"],
      [answerPencil(), ".step-answer", "stage.edit_answer"],
    ] as const) {
      const box = pencil.parentElement!;
      expect(box.className).toBe("stage-field-pencil");
      expect(box.dataset.stagePencil).toBe(words);
      // Right after the text's block among the field's shown children.
      const shown = [...card.querySelector(field)!.children].filter((el) => !el.classList.contains("hidden"));
      const at = shown.indexOf(box);
      expect(at).toBeGreaterThan(0);
      expect(shown[at - 1]?.getAttribute("aria-label")).toMatch(/^step\./);
      expect(pencil.textContent).toBe("");
    }
    const css = readFileSync(join(process.cwd(), "app/styles/visitor-layer.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const ruleOf = (selector: string) => {
      const at = css.indexOf(`${selector} {`);
      expect(at, selector).toBeGreaterThan(-1);
      return css.slice(at, css.indexOf("}", at));
    };
    const box = ruleOf(".visitor-layer .text-card .stage-field-pencil");
    for (const decl of ["position: absolute", "width: 0", "height: 0"]) expect(box, decl).toContain(decl);
    expect(box).not.toContain("float");
  });

  it("marks the question's pencil while a failed draft waits, draws the marker once, and puts the draft back from the pencil", async () => {
    stageAction = (form) => ({ ok: false, nonce: form.nonce });
    const { view } = await mountCard();
    fireEvent.click(questionPencil());
    const input = await waitFor(() => questionInput()!);
    fireEvent.change(input, { target: { value: "Unsaved question" } });
    view.unmount();
    await waitFor(() => expect(JSON.stringify({ ...sessionStorage })).toContain("project:3/step:11/question"));
    resetTargetSaves();
    await mount(props("image"));
    const pencil = questionPencil();
    expect(pencil.dataset.recovered).toBeDefined();
    const described = pencil.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(document.getElementById(described!)?.textContent).toBe("in_place.recovered_marker");
    expect(questionText().getAttribute("aria-describedby")).toBe(described);
    expect(screen.getByTestId("step-card").querySelectorAll("[data-in-place-marker]")).toHaveLength(1);
    expect(answerPencil().dataset.recovered).toBeUndefined();
    fireEvent.click(questionPencil());
    await waitFor(() => expect(questionInput()?.value).toBe("Unsaved question"));
  });

  it("marks the answer's pencil while a failed draft waits", async () => {
    stageAction = (form) => ({ ok: false, nonce: form.nonce });
    const { view } = await mountCard();
    fireEvent.click(answerPencil());
    const input = await waitFor(() => answerInput()!);
    fireEvent.change(input, { target: { value: "Unsaved answer" } });
    view.unmount();
    await waitFor(() => expect(JSON.stringify({ ...sessionStorage })).toContain("project:3/step:11/answer"));
    resetTargetSaves();
    await mount(props("image"));
    const described = answerPencil().getAttribute("aria-describedby");
    expect(document.getElementById(described!)?.textContent).toBe("in_place.recovered_marker");
    expect(answerPencil().dataset.recovered).toBeDefined();
    fireEvent.click(answerPencil());
    await waitFor(() => expect(answerInput()?.value).toBe("Unsaved answer"));
  });
});

describe("the card's bottom line shows one text at a time", () => {
  const card = () => screen.getByTestId("step-card");
  const line = () => screen.getByTestId("card-hint");
  const pencilNamed = (name: string) => screen.getByRole("button", { name });
  const said = () => [line().dataset.kind, line().textContent];
  beforeEach(() => sessionStorage.clear());
  afterEach(() => sessionStorage.clear());

  async function mountCard() {
    setSizes({ w: 1440, h: 900 }, { w: 1240, h: 768 });
    await mount(props("image"));
  }

  it("is one element: no pencil and no other hint writes on the line", async () => {
    await mountCard();
    expect(card().querySelectorAll(".stage-card-hint")).toHaveLength(1);
    expect(card().querySelectorAll("[data-stage-pencil]")).toHaveLength(3);
    for (const box of card().querySelectorAll("[data-stage-pencil]")) expect(box.textContent).toBe("");
    expect(line().getAttribute("aria-hidden")).toBe("true");
    expect(said()).toEqual(["edit", "stage.edit_hint"]);
  });

  it("follows the pointer from pencil to pencil, and back to the edit hint off them", async () => {
    await mountCard();
    fireEvent.pointerOver(pencilNamed("stage.edit_question"));
    expect(said()).toEqual(["pencil", "stage.edit_question"]);
    fireEvent.pointerOver(pencilNamed("stage.edit_answer"));
    expect(said()).toEqual(["pencil", "stage.edit_answer"]);
    fireEvent.pointerOver(pencilNamed("layer.edit_button_label_aria"));
    expect(said()).toEqual(["pencil", "layer.edit_button_label"]);
    fireEvent.pointerOver(pencilNamed("step.answer_placeholder"));
    expect(said()).toEqual(["edit", "stage.edit_hint"]);
    fireEvent.pointerOver(pencilNamed("stage.edit_question"));
    fireEvent.pointerLeave(card());
    expect(said()).toEqual(["edit", "stage.edit_hint"]);
  });

  it("says the hovered pencil's words over the focused one's, and the focused one's once the pointer leaves", async () => {
    await mountCard();
    // The question pencil focused, the answer pencil hovered.
    act(() => pencilNamed("stage.edit_question").focus());
    expect(said()).toEqual(["pencil", "stage.edit_question"]);
    fireEvent.pointerOver(pencilNamed("stage.edit_answer"));
    expect(said()).toEqual(["pencil", "stage.edit_answer"]);
    fireEvent.pointerOver(pencilNamed("step.question_placeholder"));
    expect(said()).toEqual(["pencil", "stage.edit_question"]);
    act(() => pencilNamed("step.answer_placeholder").focus());
    expect(said()).toEqual(["edit", "stage.edit_hint"]);
  });

  it("on a touch screen, says a pencil's words only once it holds focus, never a touch's alone", async () => {
    await mountCard();
    fireEvent.pointerOver(pencilNamed("stage.edit_answer"), { pointerType: "touch" });
    expect(said()).toEqual(["edit", "stage.edit_hint"]);
    // A field pencil focused where the pointer is
    // coarse; the layer pencil's words are not also on the line.
    act(() => pencilNamed("stage.edit_answer").focus());
    expect(said()).toEqual(["pencil", "stage.edit_answer"]);
    expect(card().querySelectorAll(".stage-card-hint")).toHaveLength(1);
  });

  it("drops a pencil's words when its field opens under the pointer", async () => {
    await mountCard();
    fireEvent.pointerOver(pencilNamed("stage.edit_question"));
    fireEvent.click(pencilNamed("stage.edit_question"));
    await waitFor(() => expect(card().querySelector(".step-question input")).not.toBeNull());
    await waitFor(() => expect(said()).toEqual(["edit", "stage.edit_hint"]));
  });

  it("gives the line to a waiting draft's marker in every state: every rule that shows it names a card without one", () => {
    // jsdom neither computes specificity nor matches :hover, so this reads
    // the stylesheet: every rule, in a media query or not, that gives the
    // line an opacity above zero must name the card without a marker. Only
    // the line and the marker are set on the card's bottom padding.
    const css = readFileSync(join(process.cwd(), "app/styles/visitor-layer.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
    const showing = rules.filter(
      (rule) => /\.stage-card-hint[^ ]*$/.test(rule.selector) && Number(/opacity:\s*([\d.]+)/.exec(rule.body)?.[1] ?? 0) > 0,
    );
    expect(showing.map((rule) => rule.selector)).toHaveLength(2);
    for (const rule of showing) {
      for (const selector of rule.selector.split(/,(?![^(]*\))/)) {
        expect(selector, selector).toMatch(/:not\(:has\(\[data-in-place-marker\][,)]/);
      }
    }
    // The edit hint says nothing while a field is open.
    const edit = showing.filter((rule) => rule.selector.includes('[data-kind="edit"]'));
    expect(edit).toHaveLength(1);
    expect(edit[0].selector).toMatch(/:not\(:has\([^)]*\binput, textarea, \.cm-editor\)\)/);
    const onTheLine = rules.filter((rule) => /bottom:\s*0\.3rem/.test(rule.body)).map((rule) => rule.selector);
    expect(onTheLine).toEqual([".visitor-layer .text-card .stage-card-hint", ".visitor-layer .text-card [data-in-place-marker]"]);
    expect(css).not.toMatch(/stage-pencil-hint|stage-edit-hint|pointer:\s*coarse/);
  });
});

describe("the alt-text chip, saved without a Y.Text", () => {
  async function openChip(text: string) {
    fireEvent.click(screen.getByTestId("alt-text-chip"));
    const dialog = await screen.findByRole("dialog", { name: "step.alt_text_section" });
    const field = dialog.querySelector("textarea")!;
    fireEvent.change(field, { target: { value: text } });
    return field;
  }

  it("saves when the field is finished and closes once the save has landed", async () => {
    setSizes({ w: 1440, h: 900 }, { w: 1240, h: 768 });
    await mount(props("image"));
    const field = await openChip("The head, crowned");
    fireEvent.blur(field);
    // A draft a previous case left open may still be arriving; only this field's saves count.
    const altSaves = () => savesSeen.filter((f) => f.field === "alt_text");
    await waitFor(() => expect(altSaves()).toHaveLength(1));
    expect(altSaves()[0]).toMatchObject({ intent: "save-step-field", stepId: "11", value: "The head, crowned" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "step.alt_text_section" })).toBeNull());
    expect(screen.getByTestId("alt-text-chip").textContent).toBe("stage.alt_text_edit");
  });

  it("keeps the popover open with the draft and the failure when the save is refused", async () => {
    stageAction = (form) => ({ ok: false, nonce: form.nonce });
    setSizes({ w: 1440, h: 900 }, { w: 1240, h: 768 });
    await mount(props("image"));
    const field = await openChip("Refused description");
    fireEvent.blur(field);
    await expectSaveFailed();
    const dialog = screen.getByRole("dialog", { name: "step.alt_text_section" });
    expect(dialog.querySelector("textarea")!.value).toBe("Refused description");
  });

  it("sends a draft left open when the author moves to another step", async () => {
    setSizes({ w: 1440, h: 900 }, { w: 1240, h: 768 });
    const first = props("image");
    const other = { ...stageStep("image"), id: 12, question: "Consider the necklace" };
    await mountSelectable(first, { ...first, step: other, viewer: { ...first.viewer, step: other, selectionKey: "id:12" } });
    await openChip("Left open");
    fireEvent.click(screen.getByRole("button", { name: "select next step" }));
    await waitFor(() => expect(savesSeen.map((f) => f.value)).toContain("Left open"));
    expect(savesSeen.find((f) => f.value === "Left open")).toMatchObject({ field: "alt_text", stepId: "11" });
  });
});

describe("the answer's word count reads the field the author edits", () => {
  const long = Array.from({ length: 201 }, (_, i) => `word${i}`).join(" ");
  const counter = () => screen.getByTestId("stage-line-counter");

  it("follows a draft typed without a Y.Text", async () => {
    setSizes({ w: 1440, h: 900 }, { w: 1240, h: 768 });
    await mount(props("image"));
    expect(counter().querySelector('[data-testid="answer-over-hard-limit"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "step.answer_placeholder" }));
    const field = await waitFor(() => {
      const el = screen.getByTestId("step-card").querySelector("textarea");
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.change(field, { target: { value: long } });
    await waitFor(() => expect(counter().querySelector('[data-testid="answer-over-hard-limit"]')).not.toBeNull());
  });
});

describe("a failed draft on the card survives a reload of the tab", () => {
  afterEach(() => sessionStorage.clear());

  it("keeps the question's draft under its project and step, marks the closed field, and puts it back when opened", async () => {
    stageAction = (form) => ({ ok: false, nonce: form.nonce });
    setSizes({ w: 1440, h: 900 }, { w: 1240, h: 768 });
    const view = await mount(props("image"));
    fireEvent.click(screen.getByRole("button", { name: "step.question_placeholder" }));
    const input = await waitFor(() => {
      const el = screen.getByTestId("step-card").querySelector("input");
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.change(input, { target: { value: "Unsaved question" } });
    // The author leaves with the field open; its save then fails.
    view.unmount();
    await waitFor(() => expect(JSON.stringify({ ...sessionStorage })).toContain("Unsaved question"));
    expect(JSON.stringify({ ...sessionStorage })).toContain("project:3/step:11/question");

    // A reload keeps sessionStorage and loses everything in memory.
    resetTargetSaves();
    await mount(props("image"));
    const block = screen.getByRole("button", { name: "step.question_placeholder" });
    expect(block.dataset.recovered).toBeDefined();
    const marker = block.querySelector("[data-in-place-marker]");
    expect(marker?.textContent).toBe("in_place.recovered_marker");
    expect(block.textContent).toContain("Notice the head");
    fireEvent.click(block);
    await waitFor(() => {
      const el = screen.getByTestId("step-card").querySelector("input") as HTMLInputElement | null;
      expect(el?.value).toBe("Unsaved question");
    });
  });

  it("marks the closed alt-text chip while a recovered draft waits, and puts the draft back when opened", async () => {
    stageAction = (form) => ({ ok: false, nonce: form.nonce });
    setSizes({ w: 1440, h: 900 }, { w: 1240, h: 768 });
    const view = await mount(props("image"));
    fireEvent.click(screen.getByTestId("alt-text-chip"));
    const dialog = await screen.findByRole("dialog", { name: "step.alt_text_section" });
    fireEvent.change(dialog.querySelector("textarea")!, { target: { value: "Unsaved description" } });
    view.unmount();
    await waitFor(() => expect(JSON.stringify({ ...sessionStorage })).toContain("Unsaved description"));

    resetTargetSaves();
    await mount(props("image"));
    const chip = screen.getByTestId("alt-text-chip");
    expect(chip.dataset.recovered).toBeDefined();
    const dot = chip.querySelector("[data-in-place-marker]");
    expect(dot).not.toBeNull();
    // The dot and the empty mark both show, each in its own place: the mark after the label, the dot last.
    const mark = chip.querySelector("[data-alt-text-mark]")!;
    expect(mark.getAttribute("data-alt-text-mark")).toBe("empty");
    expect(mark.contains(dot) || dot!.contains(mark)).toBe(false);
    expect(dot!.parentElement).toBe(chip);
    expect(chip.lastElementChild).toBe(dot);
    expect(mark.compareDocumentPosition(dot!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const described = chip.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(document.getElementById(described!)?.textContent).toBe("in_place.recovered_marker");
    fireEvent.click(chip);
    const reopened = await screen.findByRole("dialog", { name: "step.alt_text_section" });
    expect(reopened.querySelector("textarea")!.value).toBe("Unsaved description");
  });

  it("keys the pill's and the alt text's drafts by their own rows", async () => {
    stageAction = (form) => ({ ok: false, nonce: form.nonce });
    setSizes({ w: 1440, h: 900 }, { w: 1240, h: 768 });
    const view = await mount(props("image"));
    fireEvent.click(screen.getByRole("button", { name: "layer.edit_button_label_aria" }));
    const pill = await waitFor(() => {
      const el = screen.getByTestId("step-card").querySelector(".step-actions input") as HTMLInputElement | null;
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.change(pill, { target: { value: "Unsaved label" } });
    fireEvent.click(screen.getByTestId("alt-text-chip"));
    const dialog = await screen.findByRole("dialog", { name: "step.alt_text_section" });
    fireEvent.change(dialog.querySelector("textarea")!, { target: { value: "Unsaved description" } });
    view.unmount();
    await waitFor(() => {
      const stored = JSON.stringify({ ...sessionStorage });
      expect(stored).toContain("project:3/layer:5/button_label");
      expect(stored).toContain("project:3/step:11/alt_text");
    });
  });
});

describe("a media scene's shown step is measured as the published card, not as the editable one", () => {
  const win = { w: 1440, h: 757 };
  const content = { w: 1240, h: 652 };
  const oneStep = [{ key: "k0", current: true, question: "Question", answer: "An answer.", buttonLabel: null }];
  const arrangement = () => {
    const card = screen.getByTestId("step-card");
    const layout = visitorLayout(win.w, win.h);
    const below = mediaCardBelow(layout, win.w, win.h, { kind: "video", tallestContentHeight: 147 });
    // Below the player the card stands between the player's lowest edge and
    // the published card's top, lifted there for the editor's rows.
    const player = videoLayout(layout.mode, win.w, win.h, 16 / 9, below).player;
    const top = px(card, "top");
    return below && top >= player.y + player.h && top <= cardBox(layout, win.w, win.h, { media: true, contentHeight: 147, below }).y
      ? "below"
      : "beside";
  };

  it("arranges the scene the same with the answer open and closed, and with Add panel on the card", async () => {
    // The published rendering of the step is 147px, which goes below; the
    // editable card, with its field chrome, is far taller, which would not.
    sceneCardHeights.k0 = 147;
    cardContentH = 600;
    setSizes(win, content);
    await mount(props("video", { sceneSteps: oneStep, layer1: null }));
    expect(screen.getByRole("button", { name: "layer.add_panel" })).toBeTruthy();
    expect(arrangement()).toBe("below");

    fireEvent.click(screen.getByRole("button", { name: "step.answer_placeholder" }));
    await waitFor(() => expect(screen.getByTestId("step-card").querySelector("textarea")).not.toBeNull());
    expect(arrangement()).toBe("below");
    expect(screen.getAllByTestId("scene-card-measure").map((el) => el.dataset.sceneKey)).toEqual(["k0"]);
  });
});

describe("a neighbouring card's formula is measured typeset, as the shown answer is", () => {
  it("re-measures the card once display maths is typeset, and the taller card decides", async () => {
    const win = { w: 1440, h: 757 };
    const content = { w: 1240, h: 652 };
    // The neighbour is 100px as raw TeX, which would go below, and 300px typeset.
    const measure = HTMLElement.prototype as unknown as Record<string, unknown>;
    const base = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
    setSizes(win, content);
    const stubbed = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
    Object.defineProperty(measure, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        if (this.dataset?.sceneKey === "k1") return this.querySelector(".katex") ? 300 : 100;
        return stubbed.get!.call(this);
      },
    });
    try {
      sceneCardHeights.k0 = 100;
      cardContentH = 100;
      const scene = [
        { key: "k0", current: true, question: "Q0", answer: "An answer.", buttonLabel: null },
        { key: "k1", current: false, question: "Q1", answer: "Before.\n\n$$\\frac{a}{b}$$\n\nAfter.", buttonLabel: null },
      ];
      await mount(props("video", { sceneSteps: scene, panelPreview: Promise.resolve(parsePanelPreviewConfig(null, null)) }));
      const layout = visitorLayout(win.w, win.h);
      await waitFor(() => expect(screen.getAllByTestId("scene-card-measure")[1].querySelector(".katex")).not.toBeNull());
      const beside = cardBox(layout, win.w, win.h, { media: true, contentHeight: 100 });
      await waitFor(() => expect(px(screen.getByTestId("step-card"), "top")).toBeCloseTo(beside.y, 6));
      expect(mediaCardBelow(layout, win.w, win.h, { kind: "video", tallestContentHeight: 100 })).not.toBeNull();
    } finally {
      Object.defineProperty(measure, "offsetHeight", base);
    }
  });
});

describe("the shown step's hidden card follows its fields' drafts", () => {
  const oneStep = [{ key: "k0", current: true, question: "Question", answer: "An answer.", buttonLabel: "Learn" }];
  const hidden = () => screen.getAllByTestId("scene-card-measure").find((el) => el.dataset.sceneKey === "k0")!;

  it("takes the question and the button label as they are typed, before either field is finished", async () => {
    setSizes({ w: 1440, h: 757 }, { w: 1240, h: 652 });
    await mount(props("video", { sceneSteps: oneStep }));

    fireEvent.click(screen.getByRole("button", { name: "step.question_placeholder" }));
    const question = await waitFor(() => {
      const el = screen.getByTestId("step-card").querySelector(".step-question input") as HTMLInputElement | null;
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.change(question, { target: { value: "A question being typed" } });
    await waitFor(() => expect(hidden().querySelector(".step-question")?.textContent).toBe("A question being typed"));

    fireEvent.click(screen.getByRole("button", { name: "layer.edit_button_label_aria" }));
    const label = await waitFor(() => {
      const el = screen.getByTestId("step-card").querySelector(".step-actions input") as HTMLInputElement | null;
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.change(label, { target: { value: "A label being typed" } });
    await waitFor(() => expect(hidden().querySelector(".panel-trigger")?.textContent).toContain("A label being typed"));
  });

  it("holds the published button alone, without the pencil the shown card carries", async () => {
    setSizes({ w: 1440, h: 757 }, { w: 1240, h: 652 });
    await mount(props("video", { sceneSteps: oneStep }));
    expect(screen.getByTestId("step-card").querySelector("[data-in-place][aria-label='layer.edit_button_label_aria']")).not.toBeNull();
    const actions = hidden().querySelector(".step-actions")!;
    expect(actions.children).toHaveLength(1);
    expect(actions.firstElementChild!.className).toBe("panel-trigger");
    expect(actions.querySelector("button, [data-in-place], svg")).toBeNull();
  });

  it("holds the published question and answer alone, without the pencils the shown card carries", async () => {
    setSizes({ w: 1440, h: 757 }, { w: 1240, h: 652 });
    await mount(props("video", { sceneSteps: oneStep }));
    const shown = screen.getByTestId("step-card");
    expect(shown.querySelectorAll(".stage-field-pencil")).toHaveLength(2);
    for (const field of [".step-question", ".step-answer"]) {
      const published = hidden().querySelector(field)!;
      expect(published, field).not.toBeNull();
      expect(published.querySelector(".stage-field-pencil, [data-stage-pencil], [data-in-place], [role='button'], svg"), field).toBeNull();
    }
    expect(hidden().querySelector(".step-question")!.textContent).toBe("Notice the head");
  });
});

describe("a scene's card below the player, with the editor's own rows on it", () => {
  it("is lifted for the editor's rows no higher than the player, and ends inside the stage", async () => {
    const win = { w: 1440, h: 757 };
    const content = { w: 1240, h: 652 };
    // The published card is 147px, which goes below; "Add panel" makes the editable card taller.
    sceneCardHeights.k0 = 147;
    cardContentH = 190;
    setSizes(win, content);
    const oneStep = [{ key: "k0", current: true, question: "Question", answer: "An answer.", buttonLabel: null }];
    await mount(props("video", { sceneSteps: oneStep, layer1: null }));
    const layout = visitorLayout(win.w, win.h);
    const below = mediaCardBelow(layout, win.w, win.h, { kind: "video", tallestContentHeight: 147 })!;
    expect(below).not.toBeNull();
    const card = screen.getByTestId("step-card");
    const published = cardBox(layout, win.w, win.h, { media: true, contentHeight: 147, below });
    expect(published.y).toBe(below.cardTop);
    const player = videoLayout(layout.mode, win.w, win.h, 16 / 9, below).player;
    expect(px(card, "top")).toBeCloseTo(Math.max(published.y - addPanelRowH, player.y + player.h), 6);
    // The card ends inside the window, and never stands up over the player.
    expect(px(card, "top") + px(card, "maxHeight")).toBeLessThanOrEqual(win.h);
    expect(player.y + player.h).toBeLessThanOrEqual(px(card, "top"));
  });
});

describe("a phone's region takes the compact chrome", () => {
  it("drops the Viewfinder hint, shows the chip's icon only and lays the zoom buttons in a row", async () => {
    const win = { w: 390, h: 844 };
    const content = { w: 390, h: 712 };
    setSizes(win, content);
    await mount(props("image"));
    const at = chromeAt(win, content);
    expect(screen.queryByText("viewer_viewfinder_hint")).toBeNull();
    const chip = screen.getByTestId("alt-text-chip");
    expect(chip.textContent).toBe("");
    expect(chip.getAttribute("aria-label")).toBe("stage.alt_text_add");
    const zoom = screen.getByTestId("zoom-cluster");
    expect(zoom.className).toContain("flex-row");
    expect(px(zoom, "top")).toBeCloseTo(at.zoom!.y, 6);
    // Beside the chip where the row has room, above it where it has not (jsdom measures nothing, so the chip keeps its default width here).
    expect(at.zoom!.w).toBeGreaterThan(at.zoom!.h);
    expect(at.zoom!.y + at.zoom!.h <= at.chip!.y || at.zoom!.x >= at.chip!.x + at.chip!.w).toBe(true);
  });

  it("keeps the hint and the full chip at a desktop window", async () => {
    setSizes({ w: 1440, h: 900 }, { w: 1240, h: 768 });
    await mount(props("image"));
    expect(screen.getByText("viewer_viewfinder_hint")).toBeTruthy();
    expect(screen.getByTestId("alt-text-chip").textContent).toBe("stage.alt_text_add");
    expect(screen.getByTestId("zoom-cluster").className).toContain("flex-col");
  });
});

describe("a video scene, arranged at the video's own aspect", () => {
  const win = { w: 1440, h: 757 };
  const content = { w: win.w - 200, h: win.h - 105 };

  /** The thumbnail probe: an image of `size` loads, or none does. */
  function thumbnail(size: { w: number; h: number } | null) {
    vi.stubGlobal(
      "Image",
      class {
        naturalWidth = size?.w ?? 0;
        naturalHeight = size?.h ?? 0;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_: string) {
          queueMicrotask(() => (size ? this.onload?.() : this.onerror?.()));
        }
      },
    );
  }

  async function mountVideo(kind: Kind) {
    cardContentH = 147;
    sceneCardHeights.k0 = 147;
    setSizes(win, content);
    await mount(props(kind, { sceneSteps: [{ key: "k0", current: true, question: "Q", answer: "A", buttonLabel: null }] }));
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    return expected(win, content);
  }

  function expectPlayer(box: Box, s: number) {
    const player = screen.getByTestId("video-embed").parentElement!.parentElement!;
    expectBox(player, stageBox(box, s), "player");
    expect(px(player, "height"), "player height").toBeCloseTo(box.h * s, 6);
  }

  it.each([
    ["a portrait video", 9 / 16, { w: 720, h: 1280 }],
    ["a 4:3 video", 4 / 3, { w: 1280, h: 960 }],
  ])("YouTube, %s: the arrangement and the player box follow its thumbnail", async (_, aspect, size) => {
    thumbnail(size);
    const { layout, s } = await mountVideo("video");
    const below = mediaCardBelow(layout, win.w, win.h, { kind: "video", aspect, tallestContentHeight: 147 });
    const sixteenNine = mediaCardBelow(layout, win.w, win.h, { kind: "video", tallestContentHeight: 147 });
    expect(Boolean(below)).not.toBe(Boolean(sixteenNine));
    expectPlayer(videoLayout(layout.mode, win.w, win.h, aspect, below, mediaTopBand(win.w, win.h)).player, s);
  });

  it("YouTube with no full-size thumbnail: the whole region, compared at 16:9", async () => {
    thumbnail(null);
    const { layout, s } = await mountVideo("video");
    const below = mediaCardBelow(layout, win.w, win.h, { kind: "video", tallestContentHeight: 147 });
    expectPlayer(videoLetterboxRegion(layout.mode, win.w, win.h, below, mediaTopBand(win.w, win.h)), s);
  });

  it("YouTube with a placeholder thumbnail smaller than 320×180 is not trusted", async () => {
    thumbnail({ w: 120, h: 90 });
    const { layout, s } = await mountVideo("video");
    const below = mediaCardBelow(layout, win.w, win.h, { kind: "video", tallestContentHeight: 147 });
    expectPlayer(videoLetterboxRegion(layout.mode, win.w, win.h, below, mediaTopBand(win.w, win.h)), s);
  });

  it("Vimeo: the aspect its player reports", async () => {
    (globalThis as { __playerAspect?: number }).__playerAspect = 9 / 16;
    const { layout, s } = await mountVideo("vimeo");
    const below = mediaCardBelow(layout, win.w, win.h, { kind: "video", aspect: 9 / 16, tallestContentHeight: 147 });
    expectPlayer(videoLayout(layout.mode, win.w, win.h, 9 / 16, below, mediaTopBand(win.w, win.h)).player, s);
  });

  it("Vimeo before its player reports: 16:9, and not the whole region", async () => {
    const { layout, s } = await mountVideo("vimeo");
    const below = mediaCardBelow(layout, win.w, win.h, { kind: "video", tallestContentHeight: 147 });
    expectPlayer(videoLayout(layout.mode, win.w, win.h, 16 / 9, below, mediaTopBand(win.w, win.h)).player, s);
  });

  it("Google Drive: the whole region, compared at 16:9", async () => {
    const { layout, s } = await mountVideo("drive");
    const below = mediaCardBelow(layout, win.w, win.h, { kind: "video", tallestContentHeight: 147 });
    expectPlayer(videoLetterboxRegion(layout.mode, win.w, win.h, below, mediaTopBand(win.w, win.h)), s);
  });
});
