/**
 * EditorPopover — the shell the editor's link and footnote popovers share:
 * portalled to `document.body`, fixed at a position in screen pixels, and
 * registered as a layer of the focus scope that opened it (focus-scope.ts).
 *
 * The editor can sit inside an ancestor scaled with a CSS transform. There, a
 * caret's coordinates are screen pixels while a width set in CSS is scaled
 * with the ancestor, so a popover placed inside it would be measured in one
 * space and clamped in another. In `document.body` the popover's width, its
 * position and the window it is clamped to are all screen pixels.
 *
 * A fixed popover does not move with the page, so it is placed from an
 * anchor, not a position: measured when it opens, and again on any scroll
 * (of the window or of any element, caught in the capture phase) and on a
 * resize of the window, once per animation frame however many events
 * arrive in it. When the caret has scrolled out of the window or out
 * of any ancestor that clips (the editor's own scroller, a scrolling panel
 * around it), or the editor is gone, the popover calls `onDetach` instead,
 * and its owner closes it. A fallback anchor is held to the same test.
 *
 * Where the caret cannot be measured (CodeMirror answers null for a
 * position it has not drawn), the popover opens under the anchor's
 * fallback, the editor's toolbar or the editor itself, kept within that
 * element's width as well as the window.
 *
 * A popover opens below its anchor when it fits there and above it when it
 * fits only there (an anchor near the bottom of the window, such as the
 * stage's alt-text chip). Whether it fits depends on its height, known only
 * once it has rendered, so it is measured in a layout effect and placed
 * again before the browser paints, and measured again whenever its content
 * changes size (a save error appearing, a textarea growing), when it is
 * placed again in the next frame.
 *
 * The popover is two boxes: an outer one that is placed, framed and capped,
 * and an inner one holding the content, which is never capped. The inner
 * box is the one measured and observed, so its height is always the whole
 * content's: a change in the content is seen even while the outer box is
 * held at its cap, and capping the outer box never resizes what is
 * observed.
 *
 * @version v1.5.0-beta
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import type { EditorView } from "@codemirror/view";
import { useFocusScopeLayer } from "~/components/ui/focus-scope";

/** Distance kept between a popover and either side of the window. */
export const POPOVER_EDGE_MARGIN = 16;

/** Gap between the caret's line and the popover under or over it. */
const POPOVER_CARET_GAP = 4;

/**
 * Where a popover sits, in screen pixels. `maxHeight` is set only when it
 * fits neither below nor above its anchor, and is the room on the side it
 * took; its content then scrolls inside it.
 */
export type PopoverPosition = { top: number; left: number; maxHeight?: number };

type Horizontal = { left: number; right: number };

type CaretRect = { left: number; top: number; bottom: number };

type Size = { width: number; height: number };

function windowSize(): Size {
  if (typeof window === "undefined") return { width: Infinity, height: Infinity };
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * Where a popover of `size` opens at screen coordinates, in a window of
 * `viewport`, keeping POPOVER_EDGE_MARGIN from every side of it.
 *
 * Across, it starts at the anchor's left, moved in to keep the margin from
 * both sides. A popover wider than the window allows is narrowed by its CSS
 * to fit, and starts at the margin. With `within`, it is first kept inside
 * that span; a popover wider than the span ends at the span's right edge.
 *
 * Down, it opens below the anchor where its height fits there, and above it
 * (its bottom edge the caret gap over the anchor's top) where it fits only
 * there. Where it fits on neither side, it takes the side with more room,
 * against the anchor, and is capped to that room so its content scrolls.
 * Pushing it back inside the window instead would lay it over the anchor
 * the author is working at; capping it keeps the anchor in sight and every
 * part of the popover within reach.
 */
export function popoverPositionAt(
  coords: CaretRect | null,
  size: Size,
  viewport: Size = windowSize(),
  within?: Horizontal,
): PopoverPosition {
  if (!coords) return { top: 40 + POPOVER_EDGE_MARGIN, left: POPOVER_EDGE_MARGIN };
  const fitted = Math.min(size.width, viewport.width - 2 * POPOVER_EDGE_MARGIN);
  let left = coords.left;
  if (within) left = Math.min(Math.max(left, within.left), within.right - fitted);
  const right = viewport.width - POPOVER_EDGE_MARGIN - fitted;
  left = Math.max(POPOVER_EDGE_MARGIN, Math.min(left, right));

  const below = coords.bottom + POPOVER_CARET_GAP;
  const above = coords.top - POPOVER_CARET_GAP;
  const roomBelow = viewport.height - POPOVER_EDGE_MARGIN - below;
  const roomAbove = above - POPOVER_EDGE_MARGIN;
  if (size.height <= roomBelow) return { top: below, left };
  if (size.height <= roomAbove) return { top: above - size.height, left };
  if (roomAbove > roomBelow) return { top: POPOVER_EDGE_MARGIN, left, maxHeight: roomAbove };
  return { top: below, left, maxHeight: Math.max(roomBelow, 0) };
}

/** What a popover is placed from, read afresh each time it is placed. */
export interface PopoverAnchor {
  /** The caret's screen coordinates; null where they cannot be measured. */
  caret: () => CaretRect | null;
  /**
   * The element the caret is in: the anchor is gone once it is not in the
   * page, and hidden when an ancestor of it that clips hides the caret.
   */
  owner: () => Element | null;
  /** What the popover opens under when the caret cannot be measured. */
  fallback?: () => Element | null;
}

/** An anchor at a position in an editor's document. */
export function caretAnchor(view: EditorView, pos: number, fallback?: () => Element | null): PopoverAnchor {
  return {
    caret: () => view.coordsAtPos(Math.min(pos, view.state.doc.length)),
    owner: () => view.contentDOM,
    fallback,
  };
}

/** An anchor under an element, such as a widget's input. */
export function elementAnchor(element: Element): PopoverAnchor {
  return {
    caret: () => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, bottom: rect.bottom };
    },
    owner: () => element,
  };
}

type Span = { top: number; bottom: number; left: number; right: number };
type Box = Span & { width: number; height: number };

type Axes = { x: boolean; y: boolean };

/**
 * Whether a span lies outside a box on the axes given. An axis the box has
 * no size in was not measured (jsdom, an element not laid out) and hides
 * nothing.
 */
function hiddenBy(span: Span, box: Box, axes: Axes = { x: true, y: true }) {
  const vertically = axes.y && box.height > 0 && (span.bottom < box.top || span.top > box.bottom);
  const horizontally = axes.x && box.width > 0 && (span.right < box.left || span.left > box.right);
  return vertically || horizontally;
}

const VISIBLE = new Set(["", "visible"]);

/**
 * The axes on which an element cuts off what overflows it, each read from
 * its own computed overflow: `overflow-x: clip` with `overflow-y: visible`
 * clips sideways only. Where neither longhand is reported, the shorthand
 * stands for both.
 */
function clippedAxes(el: Element): Axes {
  const style = getComputedStyle(el);
  const x = style.overflowX || style.overflow;
  const y = style.overflowY || style.overflow;
  return { x: !VISIBLE.has(x), y: !VISIBLE.has(y) };
}

/**
 * Whether the span is out of view: outside the window, or outside any
 * ancestor of `from` that clips, up to the document, such as a scrolling
 * layer panel or the editor's own scroller.
 */
function outOfView(span: Span, from: Element | null): boolean {
  const viewport = { top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth };
  if (hiddenBy(span, { ...viewport, width: window.innerWidth, height: window.innerHeight })) return true;
  for (let el = from?.parentElement ?? null; el && el !== document.documentElement; el = el.parentElement) {
    const axes = clippedAxes(el);
    if ((axes.x || axes.y) && hiddenBy(span, el.getBoundingClientRect(), axes)) return true;
  }
  return false;
}

/**
 * Where a popover `width` pixels wide and `height` tall goes now, or null
 * when its anchor has scrolled out of view or is gone. A height of 0 stands
 * for one not yet measured.
 */
export function placePopover(anchor: PopoverAnchor, width: number, height = 0): PopoverPosition | null {
  const owner = anchor.owner();
  if (!owner || !owner.isConnected) return null;
  const size = { width, height };
  const caret = anchor.caret();
  if (!caret) {
    const under = anchor.fallback?.();
    if (!under) return popoverPositionAt(null, size);
    const rect = under.getBoundingClientRect();
    if (outOfView(rect, under)) return null;
    return popoverPositionAt({ left: rect.left, top: rect.top, bottom: rect.bottom }, size, undefined, rect);
  }
  if (outOfView({ ...caret, right: caret.left }, owner)) return null;
  return popoverPositionAt(caret, size);
}

/**
 * The height a popover asks for, whatever cap it is under: its content box,
 * padding included, plus the outer box's borders.
 */
function naturalHeight(outer: HTMLElement, content: HTMLElement): number {
  return content.offsetHeight + outer.offsetHeight - outer.clientHeight;
}

interface EditorPopoverProps {
  anchor: PopoverAnchor;
  /** Width in screen pixels; the popover narrows to the window beyond it. */
  width: number;
  /** Called when the anchor has scrolled out of view or is gone. */
  onDetach: () => void;
  className?: string;
  role?: string;
  "aria-label"?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  /** Receives the popover's root, for outside-click detection. */
  rootRef?: (el: HTMLDivElement | null) => void;
  children: ReactNode;
}

export function EditorPopover({
  anchor,
  width,
  onDetach,
  className = "",
  role,
  "aria-label": ariaLabel,
  onKeyDown,
  rootRef,
  children,
}: EditorPopoverProps) {
  const root = useRef<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  useFocusScopeLayer(root);
  const [position, setPosition] = useState(() => (typeof window === "undefined" ? null : placePopover(anchor, width)));
  const latest = useRef({ anchor, width, onDetach });
  latest.current = { anchor, width, onDetach };
  const height = useRef(0);

  // Places the popover from its anchor as it is now, at its last measured
  // height, or detaches it when the anchor is out of view or gone.
  const placeAtAnchor = () => {
    const { anchor: current, width: w, onDetach: detach } = latest.current;
    const next = placePopover(current, w, height.current);
    if (next) setPosition(next);
    else detach();
  };

  // An anchor already out of view when the popover opens detaches it at once.
  useLayoutEffect(() => {
    if (!position) latest.current.onDetach();
  }, [position]);

  // The popover's height decides whether it fits below its anchor. It is
  // measured once rendered and placed again before the first paint, then
  // again whenever its content changes size. A resize observer's callback
  // runs before the browser paints, and flushSync commits the new position
  // there.
  //
  // Where the popover goes can change its box: a cap, or a cap lifted,
  // adds or removes the outer box's scrollbar, which narrows or widens the
  // observed content box where scrollbars take up room. A write to the
  // popover inside the observer's callback resizes the observed box in the
  // same round of observations, and the browser reports a resize-observer
  // loop. So an observation never writes to the popover: it measures, and
  // the placement it calls for commits in the next animation frame, before
  // that frame's observations. The constraint costs one frame: a flip, move
  // or cap that follows a change in the content lands a frame after it.
  // Each observation cancels a frame still waiting and asks for its own; a
  // frame it cancelled is asked for again even when the height has not
  // changed since. The first measurement, in this effect, runs before any
  // observation and commits at once, so the popover opens where it belongs.
  useLayoutEffect(() => {
    const outer = root.current;
    const inner = content.current;
    if (!outer || !inner) return;
    let frame = 0;
    const measured = () => {
      const h = naturalHeight(outer, inner);
      if (h === height.current) return false;
      height.current = h;
      return true;
    };
    if (measured()) placeAtAnchor();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const waiting = frame !== 0;
      if (waiting) cancelAnimationFrame(frame);
      frame = 0;
      if (!measured() && !waiting) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        flushSync(placeAtAnchor);
      });
    });
    observer.observe(inner);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  // However many scroll and resize events arrive in a frame, the popover is
  // placed once, in the next frame, from the anchor as it is then.
  useEffect(() => {
    let frame = 0;
    const placeInFrame = () => {
      frame = 0;
      placeAtAnchor();
    };
    const request = (event: Event) => {
      if (event.target instanceof Node && root.current?.contains(event.target)) return;
      if (!frame) frame = requestAnimationFrame(placeInFrame);
    };
    window.addEventListener("scroll", request, true);
    window.addEventListener("resize", request);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", request, true);
      window.removeEventListener("resize", request);
    };
  }, []);

  if (typeof document === "undefined" || !position) return null;
  return createPortal(
    <div
      ref={(el) => {
        root.current = el;
        rootRef?.(el);
      }}
      role={role}
      aria-label={ariaLabel}
      data-editor-popover=""
      style={{
        top: position.top,
        left: position.left,
        width,
        maxWidth: `calc(100vw - ${2 * POPOVER_EDGE_MARGIN}px)`,
        maxHeight: position.maxHeight,
        overflowY: position.maxHeight === undefined ? undefined : "auto",
      }}
      className={`fixed z-50 bg-white border border-gray-200 rounded-lg shadow-lg ${className}`}
      onKeyDown={onKeyDown}
    >
      <div ref={content} data-editor-popover-content="" className="p-3">
        {children}
      </div>
    </div>,
    document.body,
  );
}
