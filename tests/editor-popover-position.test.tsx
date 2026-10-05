/**
 * @vitest-environment jsdom
 *
 * editor-popover-position.test.tsx — the link and footnote popovers open
 * under the caret and stay inside the window, measured in screen pixels,
 * whatever the scale of a CSS-transformed ancestor of the editor.
 *
 * jsdom has no layout, so the caret's screen coordinates are given, and the
 * popover's box on screen is worked out from what the page says: a popover
 * portalled to the body sits where its fixed position puts it, at its own
 * width; one left inside the scaled stage would be placed relative to the
 * stage and scaled with it. The window is jsdom's, 1024 pixels wide.
 *
 * Once open, a popover follows its caret through a scroll of any ancestor
 * and a resize of the window, and closes when the caret has scrolled out
 * of view or the editor is gone; a footnote closed that way keeps its text.
 * Where the caret cannot be measured, it opens under the editor's toolbar,
 * kept within the toolbar's width and the window. Inside a scrolling panel,
 * the panel hiding the caret or the toolbar closes it too; an ancestor that
 * clips one axis only is judged on that axis. However many scroll and
 * resize events arrive in a frame, the popover is placed once, in the next
 * frame; the cases run frames themselves.
 *
 * A popover that does not fit below its anchor opens above it, and one that
 * fits on neither side takes the side with more room, capped to it. Its
 * height is given by stubbing the box measurements of the popover element,
 * and a change in it is delivered by a stand-in resize observer. The window
 * is 768 pixels tall.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, fireEvent, screen, act } from "@testing-library/react";
import { EditorView } from "@codemirror/view";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock("react-router", () => ({
  useFetcher: () => ({ state: "idle", data: undefined, submit: vi.fn(() => Promise.resolve()) }),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    ydoc: null,
    provider: null,
    isPublishing: false,
    undoManager: null,
  }),
}));

import { MarkdownEditor } from "~/components/ui/MarkdownEditor";
import { POPOVER_EDGE_MARGIN, popoverPositionAt } from "~/components/ui/markdown-editor/EditorPopover";
import { LINK_POPOVER_WIDTH } from "~/components/ui/markdown-editor/LinkPopover";
import { FOOTNOTE_POPOVER_WIDTH } from "~/components/ui/markdown-editor/FootnotePopover";

const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.innerWidth = WINDOW;
});

const WINDOW = 1024;
const STAGE_LEFT = 120;
const CARET_BOTTOM = 320;

function mountAt(scale: number, caretLeft: number) {
  vi.spyOn(EditorView.prototype, "coordsAtPos").mockReturnValue({
    left: caretLeft,
    right: caretLeft,
    top: CARET_BOTTOM - 18,
    bottom: CARET_BOTTOM,
  });
  render(
    <div data-testid="stage" style={{ transform: `scale(${scale})`, transformOrigin: "0 0" }}>
      <MarkdownEditor
        initialValue="alpha omega"
        fieldName="content"
        projectId={1}
        alwaysShowToolbar
        enableFootnotes
      />
    </div>,
  );
  const stage = screen.getByTestId("stage");
  vi.spyOn(stage, "getBoundingClientRect").mockReturnValue(
    new DOMRect(STAGE_LEFT, 0, 1000 * scale, 800 * scale),
  );
  return stage;
}

/** The popover's box on screen, from its styles and where it sits. */
function screenBox(popover: HTMLElement, stage: HTMLElement, scale: number) {
  const left = parseFloat(popover.style.left);
  const top = parseFloat(popover.style.top);
  const width = parseFloat(popover.style.width);
  if (!stage.contains(popover)) return { left, top, width };
  const origin = stage.getBoundingClientRect();
  return { left: origin.left + left * scale, top: origin.top + top * scale, width: width * scale };
}

function openPopover(kind: "link" | "footnote"): HTMLElement {
  const title = kind === "link" ? "toolbar.link" : "footnote.button";
  const button = screen.getByTitle(title);
  button.focus();
  fireEvent.click(button, { detail: 0 });
  const popover = document.querySelector<HTMLElement>("[data-editor-popover]");
  expect(popover).toBeTruthy();
  return popover!;
}

const cases = [
  { kind: "link" as const, width: LINK_POPOVER_WIDTH },
  { kind: "footnote" as const, width: FOOTNOTE_POPOVER_WIDTH },
];

describe.each(cases)("the $kind popover", ({ kind, width }) => {
  describe.each([0.5, 0.75, 1])("in a stage scaled %s", (scale) => {
    it("opens under a caret near the left edge, kept off the edge", () => {
      const stage = mountAt(scale, 4);
      const box = screenBox(openPopover(kind), stage, scale);
      expect(box.width).toBe(width);
      expect(box.left).toBe(POPOVER_EDGE_MARGIN);
      expect(box.top).toBe(CARET_BOTTOM + 4);
    });

    it("opens under a caret near the right edge, inside the window", () => {
      const stage = mountAt(scale, WINDOW - 4);
      const box = screenBox(openPopover(kind), stage, scale);
      expect(box.width).toBe(width);
      expect(box.left + box.width).toBe(WINDOW - POPOVER_EDGE_MARGIN);
      expect(box.top).toBe(CARET_BOTTOM + 4);
    });

    it("starts at the caret where there is room", () => {
      const stage = mountAt(scale, 300);
      const box = screenBox(openPopover(kind), stage, scale);
      expect(box.left).toBe(300);
    });
  });
});

/** Moves the caret the popover is anchored to, as a scroll would. */
function moveCaret(left: number, bottom: number) {
  vi.spyOn(EditorView.prototype, "coordsAtPos").mockReturnValue({ left, right: left, top: bottom - 18, bottom });
}

function viewOf(): EditorView {
  return EditorView.findFromDOM(document.querySelector(".cm-content") as HTMLElement)!;
}

const popover = () => document.querySelector<HTMLElement>("[data-editor-popover]");

/**
 * Frames run when the test says, so a case can fire any number of events in
 * one frame. Placement after a scroll or resize happens in the next frame.
 */
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
beforeEach(() => {
  frames.clear();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
});

function paint() {
  const pending = [...frames.values()];
  frames.clear();
  act(() => pending.forEach((callback) => callback(performance.now())));
}

function scrollAndPaint(target: Element | Window) {
  fireEvent.scroll(target);
  paint();
}

function resizeAndPaint() {
  fireEvent(window, new Event("resize"));
  paint();
}

describe.each(cases)("the $kind popover after it opens", ({ kind, width }) => {
  it("follows its caret when an ancestor scrolls", () => {
    const stage = mountAt(1, 300);
    openPopover(kind);
    moveCaret(340, 200);
    scrollAndPaint(stage);
    expect(popover()!.style.top).toBe("204px");
    expect(popover()!.style.left).toBe("340px");
  });

  it("follows its caret when the window scrolls", () => {
    mountAt(1, 300);
    openPopover(kind);
    moveCaret(300, 250);
    scrollAndPaint(window);
    expect(popover()!.style.top).toBe("254px");
  });

  it("is clamped again when the window narrows", () => {
    mountAt(1, 300);
    openPopover(kind);
    window.innerWidth = 500;
    resizeAndPaint();
    expect(parseFloat(popover()!.style.left) + width).toBe(500 - POPOVER_EDGE_MARGIN);
  });

  it("closes when its caret scrolls out of view", () => {
    const stage = mountAt(1, 300);
    openPopover(kind);
    moveCaret(300, -40);
    scrollAndPaint(stage);
    expect(popover()).toBeNull();
  });

  it("closes when the editor it belongs to is gone", () => {
    mountAt(1, 300);
    openPopover(kind);
    viewOf().dom.remove();
    resizeAndPaint();
    expect(popover()).toBeNull();
  });
});

describe("a footnote closed by a scroll", () => {
  it("keeps an edit to a note, and gives it back when the same note opens again", async () => {
    moveCaret(300, 320);
    render(
      <MarkdownEditor
        initialValue={"Text[^a] here.\n\n[^a]: The note."}
        fieldName="content"
        projectId={1}
        alwaysShowToolbar
        enableFootnotes
        enablePanelAuthoring
      />,
    );
    await act(async () => {});
    const number = () => document.querySelector<HTMLButtonElement>(".cm-panel-reference button");
    expect(number()).toBeTruthy();
    fireEvent.click(number()!);
    const text = () => screen.getByRole("textbox", { name: "footnote.text" }) as HTMLTextAreaElement;
    expect(text().value).toBe("The note.");
    fireEvent.change(text(), { target: { value: "The note, rewritten." } });
    moveCaret(300, -40);
    scrollAndPaint(window);
    expect(popover()).toBeNull();
    moveCaret(300, 320);
    fireEvent.click(number()!);
    expect(text().value).toBe("The note, rewritten.");
  });


  it("keeps what was written, and gives it back when the popover opens again", () => {
    const stage = mountAt(1, 300);
    openPopover("footnote");
    fireEvent.change(screen.getByRole("textbox", { name: "footnote.text" }), {
      target: { value: "Archivo General de la Nación" },
    });
    moveCaret(300, 5000);
    scrollAndPaint(stage);
    expect(popover()).toBeNull();
    moveCaret(300, 320);
    openPopover("footnote");
    expect((screen.getByRole("textbox", { name: "footnote.text" }) as HTMLTextAreaElement).value).toBe(
      "Archivo General de la Nación",
    );
  });
});

describe.each(cases)("the $kind popover where the caret cannot be measured", ({ kind, width }) => {
  function mountUnmeasured(toolbar: DOMRect) {
    render(
      <MarkdownEditor initialValue="alpha omega" fieldName="content" projectId={1} alwaysShowToolbar enableFootnotes />,
    );
    vi.spyOn(EditorView.prototype, "coordsAtPos").mockReturnValue(null);
    const bar = document.querySelector<HTMLElement>("[data-editor-toolbar]");
    expect(bar).toBeTruthy();
    vi.spyOn(bar!, "getBoundingClientRect").mockReturnValue(toolbar);
  }

  it("opens under the editor's toolbar, from its left", () => {
    mountUnmeasured(new DOMRect(200, 100, 500, 40));
    const box = openPopover(kind);
    expect(box.style.top).toBe("144px");
    expect(box.style.left).toBe("200px");
  });

  it("ends at the toolbar's right edge where the toolbar is narrower than it", () => {
    mountUnmeasured(new DOMRect(500, 100, 200, 40));
    const box = openPopover(kind);
    expect(parseFloat(box.style.left) + width).toBe(700);
  });

  it("stays within the toolbar's width and the window", () => {
    mountUnmeasured(new DOMRect(900, 100, 110, 40));
    const box = openPopover(kind);
    expect(parseFloat(box.style.left) + width).toBeLessThanOrEqual(WINDOW - POPOVER_EDGE_MARGIN);
    expect(parseFloat(box.style.left)).toBe(WINDOW - POPOVER_EDGE_MARGIN - width);
  });
});

describe.each(cases)("the $kind popover inside a scrolling panel", ({ kind }) => {
  function mountInPanel() {
    render(
      <div data-testid="panel" style={{ overflowY: "auto" }}>
        <MarkdownEditor initialValue="alpha omega" fieldName="content" projectId={1} alwaysShowToolbar enableFootnotes />
      </div>,
    );
    const panel = screen.getByTestId("panel");
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 600, 200));
    return panel;
  }

  it("stays open while the panel shows its caret", () => {
    moveCaret(300, 220);
    const panel = mountInPanel();
    openPopover(kind);
    moveCaret(300, 260);
    scrollAndPaint(panel);
    expect(popover()!.style.top).toBe("264px");
  });

  it("closes when the panel scrolls its caret out of sight", () => {
    moveCaret(300, 220);
    const panel = mountInPanel();
    openPopover(kind);
    moveCaret(300, 380);
    scrollAndPaint(panel);
    expect(popover()).toBeNull();
  });

  it("closes when the panel hides the toolbar it fell back to", () => {
    const panel = mountInPanel();
    vi.spyOn(EditorView.prototype, "coordsAtPos").mockReturnValue(null);
    const bar = document.querySelector<HTMLElement>("[data-editor-toolbar]")!;
    const toolbar = vi.spyOn(bar, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 120, 500, 40));
    openPopover(kind);
    toolbar.mockReturnValue(new DOMRect(0, 20, 500, 40));
    scrollAndPaint(panel);
    expect(popover()).toBeNull();
  });
});

describe.each(cases)("the $kind popover inside an ancestor that clips one axis", ({ kind }) => {
  function mountInStrip(style: React.CSSProperties) {
    render(
      <div data-testid="strip" style={style}>
        <MarkdownEditor initialValue="alpha omega" fieldName="content" projectId={1} alwaysShowToolbar enableFootnotes />
      </div>,
    );
    const strip = screen.getByTestId("strip");
    vi.spyOn(strip, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 600, 200));
    return strip;
  }

  it("ignores the vertical position when only the horizontal axis clips", () => {
    moveCaret(300, 220);
    const strip = mountInStrip({ overflowX: "clip", overflowY: "visible" });
    openPopover(kind);
    moveCaret(300, 60);
    scrollAndPaint(strip);
    expect(popover()!.style.top).toBe("64px");
  });

  it("closes when the horizontal axis that clips hides the caret", () => {
    moveCaret(300, 220);
    const strip = mountInStrip({ overflowX: "clip", overflowY: "visible" });
    openPopover(kind);
    moveCaret(700, 220);
    scrollAndPaint(strip);
    expect(popover()).toBeNull();
  });

  it("ignores the horizontal position when only the vertical axis clips", () => {
    moveCaret(300, 220);
    const strip = mountInStrip({ overflowX: "visible", overflowY: "clip" });
    openPopover(kind);
    moveCaret(700, 220);
    scrollAndPaint(strip);
    expect(popover()).not.toBeNull();
  });
});

describe("a storm of scroll events", () => {
  it("places the popover once per frame, from the latest anchor", () => {
    const stage = mountAt(1, 300);
    openPopover("link");
    // CodeMirror asks for frames of its own; only the ones the storm adds count.
    paint();
    const measure = vi.spyOn(EditorView.prototype, "coordsAtPos");
    measure.mockClear();
    for (let i = 0; i < 200; i += 1) {
      measure.mockReturnValue({ left: 300, right: 300, top: 100 + i, bottom: 118 + i });
      fireEvent.scroll(stage);
    }
    expect(frames.size).toBe(1);
    expect(measure).not.toHaveBeenCalled();
    paint();
    expect(measure).toHaveBeenCalledTimes(1);
    expect(popover()!.style.top).toBe(`${118 + 199 + 4}px`);
    // The next scroll asks for a frame of its own.
    measure.mockReturnValue({ left: 300, right: 300, top: 400, bottom: 418 });
    scrollAndPaint(stage);
    expect(popover()!.style.top).toBe("422px");
  });

  it("cancels a pending frame when the popover closes", () => {
    const stage = mountAt(1, 300);
    openPopover("link");
    paint();
    fireEvent.scroll(stage);
    const [placement] = [...frames.keys()];
    expect(frames.size).toBe(1);
    fireEvent.click(screen.getByText("link_popover.cancel"));
    expect(frames.has(placement)).toBe(false);
  });
});

describe("where a popover opens", () => {
  const viewport = { width: 1024, height: 768 };
  const size = (height: number) => ({ width: 320, height });
  // The anchor spans 18 pixels; the caret gap is 4 and the edge margin 16.
  const at = (bottom: number, left = 300) => ({ left, top: bottom - 18, bottom });

  it("opens below its anchor where it fits there", () => {
    expect(popoverPositionAt(at(320), size(200), viewport)).toEqual({ top: 324, left: 300 });
  });

  it("opens below where it fits exactly, down to the edge margin", () => {
    // 768 - 16 - (500 + 4) = 248 pixels of room below.
    expect(popoverPositionAt(at(500), size(248), viewport)).toEqual({ top: 504, left: 300 });
  });

  it("opens above its anchor where it fits only there, its bottom the gap over the anchor", () => {
    // 248 pixels below; the anchor's top is 482, so the popover ends at 478.
    expect(popoverPositionAt(at(500), size(249), viewport)).toEqual({ top: 478 - 249, left: 300 });
  });

  it("takes the side with more room where it fits neither, capped to that room", () => {
    // Below: 768 - 16 - 404 = 348. Above: 378 - 16 = 362.
    expect(popoverPositionAt(at(400), size(500), viewport)).toEqual({
      top: POPOVER_EDGE_MARGIN,
      left: 300,
      maxHeight: 362,
    });
    // Below: 768 - 16 - 304 = 448. Above: 278 - 16 = 262.
    expect(popoverPositionAt(at(300), size(500), viewport)).toEqual({ top: 304, left: 300, maxHeight: 448 });
  });

  it("keeps its top inside the window on either side", () => {
    for (const bottom of [40, 200, 400, 600, 760]) {
      const { top, maxHeight } = popoverPositionAt(at(bottom), size(2000), viewport);
      expect(top).toBeGreaterThanOrEqual(POPOVER_EDGE_MARGIN);
      expect(top + (maxHeight ?? 0)).toBeLessThanOrEqual(viewport.height - POPOVER_EDGE_MARGIN);
    }
  });

  it("keeps the horizontal clamping whichever side it opens on", () => {
    for (const bottom of [320, 740]) {
      expect(popoverPositionAt(at(bottom, 4), size(200), viewport).left).toBe(POPOVER_EDGE_MARGIN);
      expect(popoverPositionAt(at(bottom, 1020), size(200), viewport).left).toBe(1024 - POPOVER_EDGE_MARGIN - 320);
      expect(popoverPositionAt(at(bottom, 500), size(200), viewport, { left: 520, right: 1000 }).left).toBe(520);
      expect(popoverPositionAt(at(bottom, 500), size(200), viewport, { left: 400, right: 600 }).left).toBe(600 - 320);
    }
  });
});

/**
 * The popover's two boxes, as the browser would measure them. The content
 * box is always `contentHeight` tall; the outer box is too, unless its style
 * caps it, and its content then scrolls. Borders are left at zero. As on a
 * system whose scrollbars take up room, a capped outer box that scrolls
 * narrows the content box by SCROLLBAR pixels.
 */
let contentHeight = 0;
const CONTENT_WIDTH = 326;
/** Taken from the content box's width, as a window resize might narrow it. */
let widthChange = 0;
const SCROLLBAR = 15;
function stubPopoverHeight() {
  const isOuter = (el: Element) => el.hasAttribute("data-editor-popover");
  const isContent = (el: Element) => el.hasAttribute("data-editor-popover-content");
  const heightOf = (el: Element) => {
    if (isContent(el)) return contentHeight;
    if (!isOuter(el)) return 0;
    const cap = parseFloat((el as HTMLElement).style.maxHeight);
    return Number.isNaN(cap) ? contentHeight : Math.min(cap, contentHeight);
  };
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
    return isOuter(this) || isContent(this) ? contentHeight : 0;
  });
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    return heightOf(this);
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return heightOf(this);
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    if (!isContent(this)) return 0;
    const outer = this.parentElement!;
    const scrolls = outer.style.overflowY === "auto" && heightOf(outer) < contentHeight;
    return CONTENT_WIDTH - widthChange - (scrolls ? SCROLLBAR : 0);
  });
}

/**
 * A stand-in resize observer. As a browser's does, it delivers once for an
 * element when it is first observed, at the size it has then, and after
 * that only when its box has changed width or height since it was last
 * delivered.
 * `deliver` reports how many elements it delivered for.
 */
const observers = new Set<FakeResizeObserver>();

/**
 * The popover's style as written. No observation's callback may change it:
 * a write there can resize the observed box inside its own observation.
 */
const popoverStyle = () =>
  document.querySelector<HTMLElement>("[data-editor-popover]")?.getAttribute("style") ?? "closed";
const styleChangedInCallback: string[] = [];
const sizeOf = (el: Element) => `${(el as HTMLElement).offsetWidth}x${(el as HTMLElement).offsetHeight}`;
class FakeResizeObserver {
  readonly targets = new Map<Element, string>();
  constructor(private callback: ResizeObserverCallback) {
    observers.add(this);
  }
  observe(target: Element) {
    this.targets.set(target, "");
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    observers.delete(this);
  }
  deliver(): number {
    const changed = [...this.targets].filter(([el, last]) => sizeOf(el) !== last);
    if (!changed.length) return 0;
    for (const [el] of changed) this.targets.set(el, sizeOf(el));
    const before = popoverStyle();
    this.callback(
      changed.map(([target]) => ({ target }) as ResizeObserverEntry),
      this as unknown as ResizeObserver,
    );
    const after = popoverStyle();
    if (before !== after) styleChangedInCallback.push(`${before} -> ${after}`);
    return changed.length;
  }
}

/**
 * Delivers resize observations until none are left, and reports how many
 * rounds that took. A browser delivers one round per box in a frame; a
 * second round for the same box is what it reports as a resize-observer
 * loop.
 */
function deliverObservations(): number {
  let rounds = 0;
  act(() => {
    while ([...observers].reduce((n, o) => n + o.deliver(), 0) > 0) rounds += 1;
  });
  return rounds;
}

function resizePopover(height: number) {
  contentHeight = height;
  return deliverObservations();
}

/** Opens the popover and runs the frame in which its first observation arrives. */
function openAndObserve(kind: "link" | "footnote") {
  openPopover(kind);
  deliverObservations();
}

/** The next frame: its animation-frame callbacks, then its observations. */
function frameWithObservations(): number {
  paint();
  return deliverObservations();
}

/** What is observed in the popover; the editor behind it observes boxes of its own. */

const observedInPopover = () =>
  [...observers].flatMap((o) => [...o.targets.keys()]).filter((el) => popover()?.contains(el));

describe.each(cases)("the $kind popover near the bottom of the window", ({ kind }) => {
  beforeEach(() => {
    observers.clear();
    styleChangedInCallback.length = 0;
    contentHeight = 200;
    widthChange = 0;
    stubPopoverHeight();
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.innerHeight = 768;
    // Unmounted before the check, so a failing check leaves nothing behind.
    cleanup();
    // No observation in any case here wrote to the popover itself.
    expect(styleChangedInCallback).toEqual([]);
  });

  it("opens above its anchor when it is taller than the room below, from the first paint", () => {
    // 768 - 16 - 704 = 48 pixels below; the caret's top is 682.
    mountAt(1, 300);
    moveCaret(300, 700);
    openPopover(kind);
    expect(popover()!.style.top).toBe(`${682 - 4 - 200}px`);
    deliverObservations();
    expect(popover()!.style.top).toBe(`${682 - 4 - 200}px`);
    expect(popover()!.style.left).toBe("300px");
  });

  it("moves back below when a scroll gives it room there", () => {
    const stage = mountAt(1, 300);
    moveCaret(300, 700);
    openAndObserve(kind);
    moveCaret(300, 320);
    scrollAndPaint(stage);
    expect(popover()!.style.top).toBe("324px");
  });

  it("moves above when its content grows past the room below, and back when it shrinks", () => {
    // 768 - 16 - 504 = 248 pixels below.
    mountAt(1, 300);
    moveCaret(300, 500);
    openAndObserve(kind);
    expect(popover()!.style.top).toBe("504px");
    // Each move lands in the frame after the observation that calls for it.
    resizePopover(300);
    expect(popover()!.style.top).toBe("504px");
    frameWithObservations();
    expect(popover()!.style.top).toBe(`${482 - 4 - 300}px`);
    resizePopover(240);
    frameWithObservations();
    expect(popover()!.style.top).toBe("504px");
  });

  it("is capped to the roomier side where it fits neither, and scrolls inside", () => {
    // Below: 768 - 16 - 404 = 348. Above: 378 - 16 = 362.
    contentHeight = 500;
    mountAt(1, 300);
    moveCaret(300, 400);
    openAndObserve(kind);
    expect(popover()!.style.top).toBe(`${POPOVER_EDGE_MARGIN}px`);
    expect(popover()!.style.maxHeight).toBe("362px");
    expect(popover()!.style.overflowY).toBe("auto");
    // The cap shrinks its box but not its content, so it stays where it is.
    resizePopover(500);
    expect(popover()!.style.top).toBe(`${POPOVER_EDGE_MARGIN}px`);
    expect(popover()!.style.maxHeight).toBe("362px");
    // Content growing under the cap is measured whole, not at the cap.
    resizePopover(550);
    expect(popover()!.style.top).toBe(`${POPOVER_EDGE_MARGIN}px`);
    expect(popover()!.style.maxHeight).toBe("362px");
  });

  it("sees content shrink to exactly its cap, and opens below uncapped once the window has room", () => {
    // Below: 768 - 16 - 404 = 348. Above: 378 - 16 = 362.
    contentHeight = 500;
    mountAt(1, 300);
    moveCaret(300, 400);
    openAndObserve(kind);
    expect(popover()!.style.maxHeight).toBe("362px");
    // The capped outer box stays 362 tall; only the content's box changes,
    // losing its scrollbar as it comes to fit. The cap is lifted in the next
    // frame, which leaves nothing more to observe.
    expect(resizePopover(362)).toBe(1);
    expect(popover()!.style.maxHeight).toBe("362px");
    expect(frameWithObservations()).toBe(0);
    expect(popover()!.style.top).toBe(`${POPOVER_EDGE_MARGIN}px`);
    expect(popover()!.style.maxHeight).toBe("");
    // A taller window, the anchor at 456-474: 912 - 16 - 478 = 418 below.
    window.innerHeight = 912;
    moveCaret(300, 474);
    resizeAndPaint();
    expect(popover()!.style.top).toBe("478px");
    expect(popover()!.style.maxHeight).toBe("");
    expect(popover()!.style.overflowY).toBe("");
  });

  it("observes the content's box, which capping never resizes", () => {
    // 768 - 16 - 504 = 248 below; 482 - 4 - 16 = 462 above.
    mountAt(1, 300);
    moveCaret(300, 500);
    openAndObserve(kind);
    const content = popover()!.querySelector("[data-editor-popover-content]");
    expect(observedInPopover()).toEqual([content]);
    // Growing past both sides caps the outer box in the next frame; the
    // observed box keeps its height, and its new width arrives in that
    // frame's own round, placing nothing again.
    expect(resizePopover(600)).toBe(1);
    expect(frameWithObservations()).toBe(1);
    expect(popover()!.style.maxHeight).toBe("462px");
    expect((content as HTMLElement).style.maxHeight).toBe("");
    expect((content as HTMLElement).offsetHeight).toBe(600);
    expect(frameWithObservations()).toBe(0);
    expect(popover()!.style.maxHeight).toBe("462px");
  });

  it("does not resize the observed box inside its own observation when a scrollbar comes or goes", () => {
    // 768 - 16 - 504 = 248 below; 482 - 4 - 16 = 462 above.
    mountAt(1, 300);
    moveCaret(300, 500);
    openAndObserve(kind);
    const content = popover()!.querySelector<HTMLElement>("[data-editor-popover-content]")!;
    expect(content.offsetWidth).toBe(CONTENT_WIDTH);
    // The observation that calls for the cap leaves the box as it was.
    expect(resizePopover(600)).toBe(1);
    expect(content.offsetWidth).toBe(CONTENT_WIDTH);
    // The cap and its scrollbar arrive in the next frame, one round there.
    expect(frameWithObservations()).toBe(1);
    expect(content.offsetWidth).toBe(CONTENT_WIDTH - SCROLLBAR);
    // Content that comes to fit loses the scrollbar itself; the cap is
    // lifted in the next frame, with nothing more to observe.
    expect(resizePopover(200)).toBe(1);
    expect(content.offsetWidth).toBe(CONTENT_WIDTH);
    expect(frameWithObservations()).toBe(0);
    expect(popover()!.style.top).toBe("504px");
    expect(popover()!.style.maxHeight).toBe("");
  });

  it("lifts a cap its content still overflows in the next frame, where the anchor has moved to room", () => {
    // Below: 768 - 16 - 404 = 348. Above: 378 - 16 = 362.
    contentHeight = 500;
    mountAt(1, 300);
    moveCaret(300, 400);
    openAndObserve(kind);
    expect(popover()!.style.maxHeight).toBe("362px");
    const content = popover()!.querySelector<HTMLElement>("[data-editor-popover-content]")!;
    expect(content.offsetWidth).toBe(CONTENT_WIDTH - SCROLLBAR);
    // The anchor moves to 682-700, leaving 678 - 16 = 662 above, and the
    // content grows to 550: it overflows its cap still, but fits above.
    moveCaret(300, 700);
    expect(resizePopover(550)).toBe(1);
    expect(popover()!.style.maxHeight).toBe("362px");
    expect(content.offsetWidth).toBe(CONTENT_WIDTH - SCROLLBAR);
    // The next frame lifts the cap; the scrollbar going widens the content
    // box, and that arrives in the frame's own single round.
    expect(frameWithObservations()).toBe(1);
    expect(popover()!.style.top).toBe(`${678 - 550}px`);
    expect(popover()!.style.maxHeight).toBe("");
    expect(content.offsetWidth).toBe(CONTENT_WIDTH);
  });

  it("still caps in the next frame when a newer observation changes only the content's width", () => {
    // 768 - 16 - 504 = 248 below; 482 - 4 - 16 = 462 above.
    mountAt(1, 300);
    moveCaret(300, 500);
    openAndObserve(kind);
    resizePopover(600);
    widthChange = 4;
    expect(deliverObservations()).toBe(1);
    expect(popover()!.style.maxHeight).toBe("");
    frameWithObservations();
    expect(popover()!.style.maxHeight).toBe("462px");
  });

  it("drops a frame waiting to cap when a newer observation places the popover without one", () => {
    // 768 - 16 - 504 = 248 below; 482 - 4 - 16 = 462 above.
    mountAt(1, 300);
    moveCaret(300, 500);
    openAndObserve(kind);
    paint();
    const waiting = new Set(frames.keys());
    resizePopover(600);
    const capping = [...frames.keys()].filter((id) => !waiting.has(id));
    expect(capping).toHaveLength(1);
    // Before that frame, the content settles at 300, which fits above. The
    // frame waiting to cap is dropped, and one frame is asked for in its place.
    resizePopover(300);
    expect(frames.has(capping[0])).toBe(false);
    expect([...frames.keys()].filter((id) => !waiting.has(id) && id !== capping[0])).toHaveLength(1);
    // That frame places the popover once, uncapped above.
    const measure = vi.spyOn(EditorView.prototype, "coordsAtPos");
    measure.mockClear();
    expect(frameWithObservations()).toBe(0);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(popover()!.style.top).toBe(`${478 - 300}px`);
    expect(popover()!.style.maxHeight).toBe("");
  });

  it("brings back the scrollbar for a smaller cap in the next frame, after content that fit its old cap", () => {
    // Anchor at 682-700: 48 below, 678 - 16 = 662 above; content 700.
    contentHeight = 700;
    mountAt(1, 300);
    moveCaret(300, 700);
    openAndObserve(kind);
    expect(popover()!.style.maxHeight).toBe("662px");
    const content = popover()!.querySelector<HTMLElement>("[data-editor-popover-content]")!;
    expect(content.offsetWidth).toBe(CONTENT_WIDTH - SCROLLBAR);
    // The content shrinks to 500, under the old cap, and loses its
    // scrollbar; the anchor moves to 382-400, where the cap would be 362.
    moveCaret(300, 400);
    expect(resizePopover(500)).toBe(1);
    expect(content.offsetWidth).toBe(CONTENT_WIDTH);
    expect(popover()!.style.maxHeight).toBe("662px");
    // The next frame caps it at 362; the scrollbar's return arrives in that
    // frame's own single round, and nothing follows.
    expect(frameWithObservations()).toBe(1);
    expect(popover()!.style.top).toBe(`${POPOVER_EDGE_MARGIN}px`);
    expect(popover()!.style.maxHeight).toBe("362px");
    expect(content.offsetWidth).toBe(CONTENT_WIDTH - SCROLLBAR);
    expect(frameWithObservations()).toBe(0);
  });
});
