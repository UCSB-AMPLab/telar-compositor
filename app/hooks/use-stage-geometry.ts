/**
 * useStageGeometry — the framing stage's size and scale, from the content
 * area it letterboxes into and the author's own window.
 *
 * The stage is a visitor's window with the author's proportions, scaled to
 * fit the content area beside the step list (`stageRect`). The window it
 * scales is the browser window, not the content area: the content area is
 * shorter than the window by the editor's chrome, so a scale taken from it
 * would stretch the visitor's window out of shape.
 *
 * The content area is watched with a ResizeObserver and the window with its
 * `resize` event, which also fires on browser zoom. There is no geometry
 * during server rendering or the first client render, as `use-media-query`
 * reads no media query there; the caller renders nothing framed until it has
 * one.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useState, type RefObject } from "react";
import { stageRect, visitorLayout, type StageRect, type VisitorLayout } from "~/lib/framing-stage";

export interface Size {
  w: number;
  h: number;
}

export interface StageGeometry {
  /** The author's window, which is the visitor's window the stage shows. */
  window: Size;
  /** The content area the stage letterboxes into. */
  content: Size;
  /** The stage inside the content area, with its scale from visitor pixels. */
  stage: StageRect;
  /** The published page's layout for a window of `window`. */
  layout: VisitorLayout;
}

/** The geometry for a content area and a window, or null where either has no area. */
export function stageGeometryOf(content: Size, window: Size): StageGeometry | null {
  const stage = stageRect(content, window);
  if (!stage) return null;
  return { window, content, stage, layout: visitorLayout(window.w, window.h) };
}

function sameGeometry(a: StageGeometry | null, b: StageGeometry | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.window.w === b.window.w &&
    a.window.h === b.window.h &&
    a.content.w === b.content.w &&
    a.content.h === b.content.h
  );
}

export function useStageGeometry(contentRef: RefObject<HTMLElement | null>): StageGeometry | null {
  const [geometry, setGeometry] = useState<StageGeometry | null>(null);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measureStage = () => {
      const next = stageGeometryOf(
        { w: el.clientWidth, h: el.clientHeight },
        { w: window.innerWidth, h: window.innerHeight },
      );
      setGeometry((prev) => (sameGeometry(prev, next) ? prev : next));
    };
    measureStage();
    window.addEventListener("resize", measureStage);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measureStage);
    observer?.observe(el);
    return () => {
      window.removeEventListener("resize", measureStage);
      observer?.disconnect();
    };
  }, [contentRef]);

  return geometry;
}
