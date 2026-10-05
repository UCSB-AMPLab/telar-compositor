/**
 * useTextEnd — where a mark placed just after a block's text stands: at the
 * right end of the text's last line, centred on that line.
 *
 * The end is the last piece the block draws, in document order: a text node
 * with something other than white space, or a picture or a formula typeset by
 * KaTeX, taken whole: a formula's own parts (a raised exponent, the hidden
 * MathML) are not where its line ends, and a displayed formula ends where its
 * last drawn part does, not at the edge of the line it is centred on.
 * The waiting-draft marker the block may hold is not the text's, and is
 * skipped.
 *
 * The point is given in the unscaled pixels of `box`'s offset parent, the box
 * being the mark's own, absolutely positioned, and in that parent's scrolled
 * content where it scrolls; the layer that holds a card is scaled, and the
 * scale is read from that parent. It is measured again when `deps` change,
 * when the block, that parent or anything before the block within it changes
 * size (the text rewraps, or moves), when the fonts finish loading, and when
 * `measure` is called, for a formula typeset after the render. Where nothing
 * can be measured (a DOM without line boxes), it is null and the mark stays
 * where the flow puts it.
 *
 * @version v1.5.0-beta
 */

import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from "react";

export type TextEnd = { left: number; top: number };

const WHOLE = "img, svg, .katex";

/** The last piece of `block` a reader sees, or null. */
function lastPiece(block: HTMLElement): Text | Element | null {
  let last: Text | Element | null = null;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node instanceof Element && node.matches("[data-in-place-marker]")) return NodeFilter.FILTER_REJECT;
      // A whole piece's insides are part of it.
      if (node.parentElement?.closest(WHOLE)) return NodeFilter.FILTER_REJECT;
      if (node instanceof Element) return node.matches(WHOLE) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      return node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) last = node as Text | Element;
  return last;
}

/** The last line box of `piece`, or null where the DOM draws none. */
function lastRect(piece: Text | Element): DOMRect | null {
  let rects: DOMRectList | undefined;
  // A displayed formula's box is the line's full width; it ends where its last drawn part,
  // or its equation number, does.
  const drawn = piece instanceof Element && piece.matches(".katex") ? [...piece.querySelectorAll(".katex-html > .base, .katex-html > .tag")].at(-1) : undefined;
  if (drawn) rects = drawn.getClientRects?.();
  else if (piece instanceof Element) rects = piece.getClientRects?.();
  else {
    const range = document.createRange();
    if (typeof range.getClientRects !== "function") return null;
    range.selectNodeContents(piece);
    rects = range.getClientRects();
  }
  const list = rects ? [...rects].filter((r) => r.width > 0 || r.height > 0) : [];
  return list.at(-1) ?? null;
}

/**
 * What can move the end of `block`'s text within `origin`: the block, the
 * origin, and every element between them with all its children, since
 * anything beside the text at any level can move it (a question that gains a
 * line pushes the answer down; a button that wraps re-centres the content).
 */
export function movers(block: HTMLElement, origin: HTMLElement | null): HTMLElement[] {
  const found = new Set<HTMLElement>([block]);
  for (let el: HTMLElement | null = block; el && el !== origin; el = el.parentElement) {
    const parent = el.parentElement;
    if (!parent) break;
    found.add(parent);
    for (const child of parent.children) if (child instanceof HTMLElement) found.add(child);
  }
  if (origin) found.add(origin);
  return [...found];
}

export function useTextEnd(
  block: RefObject<HTMLElement | null>,
  box: RefObject<HTMLElement | null>,
  deps: readonly unknown[],
): { at: TextEnd | null; measure: () => void } {
  const [at, setAt] = useState<TextEnd | null>(null);

  const measure = useCallback(() => {
    const b = block.current;
    const origin = box.current?.offsetParent;
    if (!b || !(origin instanceof HTMLElement)) return;
    const piece = lastPiece(b);
    const end = piece && lastRect(piece);
    if (!end) {
      setAt(null);
      return;
    }
    const o = origin.getBoundingClientRect();
    const scale = origin.offsetWidth > 0 && o.width > 0 ? o.width / origin.offsetWidth : 1;
    // A card that scrolls carries the mark with its text, so the point is in its scrolled content.
    const left = (end.right - o.left) / scale - origin.clientLeft + origin.scrollLeft;
    const top = ((end.top + end.bottom) / 2 - o.top) / scale - origin.clientTop + origin.scrollTop;
    const next = { left, top };
    setAt((prev) => (prev && Math.abs(prev.left - next.left) < 0.5 && Math.abs(prev.top - next.top) < 0.5 ? prev : next));
  }, [block, box]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(measure, [measure, ...deps]);

  useEffect(() => {
    const b = block.current;
    const origin = box.current?.offsetParent;
    let current = true;
    void document.fonts?.ready.then(() => current && measure());
    if (!b || typeof ResizeObserver === "undefined") {
      return () => {
        current = false;
      };
    }
    // The mark stands outside all of them, so moving it resizes none.
    const resize = new ResizeObserver(() => measure());
    for (const el of movers(b, origin instanceof HTMLElement ? origin : null)) resize.observe(el);
    return () => {
      current = false;
      resize.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, ...deps]);

  return { at, measure };
}
