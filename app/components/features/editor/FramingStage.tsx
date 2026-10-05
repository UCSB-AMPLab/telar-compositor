/**
 * FramingStage — the published page a visitor with a window shaped like the
 * author's will see, drawn in the editor's content area.
 *
 * The stage is the largest rectangle of the author's window proportions that
 * fits the content area, centred, with the editor chrome's colour around it
 * (`stageRect`); the weave is the viewer's own surface, inside the stage. It
 * clips everything it holds. Its layers, bottom to top, each with its own
 * z-index since the visitor layer's transform makes a stacking context of its
 * own:
 *
 *   0  the image: OpenSeadragon at stage pixels, never transformed, with the
 *      guides and the frame and stage labels it draws over itself;
 *   10 the visitor layer: a box the size of the author's window, scaled onto
 *      the stage from its top left, holding the step card and its ceiling, so
 *      the card lays out at the visitor's width and container queries fire as
 *      they would for the visitor. The layer takes no pointer events and the
 *      card takes its own, so dragging or zooming the uncovered image still
 *      reaches OpenSeadragon;
 *   15 the region's controls, at stage pixels (`StageRegionControls`), and
 *      the stage's labels and word count;
 *   20 the panel layer: a second visitor layer holding the open layer
 *      panels (`StagePanels`), above the controls as the site's panels are
 *      above its page. It takes no pointer events and the panels take their
 *      own, so the card and the controls beside an open panel stay usable.
 *
 * Dialogs and popovers opened from any of them are portalled to the document
 * body, outside every transform.
 *
 * The title card and the section cards frame nothing: `CardStage` draws one
 * in a visitor layer of its own over the stage, with no image and no
 * controls.
 *
 * Geometry comes from `framing-stage.ts` in visitor pixels; `stageBox` turns
 * one of its boxes into stage pixels.
 *
 * @version v1.5.0-beta
 */

import { useCallback, useRef, type CSSProperties, type ReactNode } from "react";
import { regionOf, type Box, type CardOptions } from "~/lib/framing-stage";
import type { RegionOf } from "~/lib/authoring-frame";
import { useStageGeometry, type StageGeometry } from "~/hooks/use-stage-geometry";

/** The stage's stacking levels. */
export const STAGE_Z = { image: 0, visitor: 10, controls: 15, panels: 20 } as const;

/** A box in visitor pixels, in stage pixels. */
export function stageBox(box: Box, scale: number): Box {
  return { x: box.x * scale, y: box.y * scale, w: box.w * scale, h: box.h * scale };
}

/**
 * The region the published page frames the image into, as the capture viewer
 * reads it: a function of the viewer's pane, which is the stage, in the pane's
 * pixels. The scale is taken from the pane handed in, so a pane measured
 * between two renders is still mapped from the visitor's window it shows.
 */
export function useStageRegionOf(geometry: StageGeometry | null, opts: CardOptions = {}): RegionOf | undefined {
  const w = geometry?.window.w ?? 0;
  const h = geometry?.window.h ?? 0;
  const layout = geometry?.layout;
  const media = opts.media === true;
  const fn = useCallback<RegionOf>(
    (pane) => (layout && w > 0 ? stageBox(regionOf(layout, w, h, { media }), pane.w / w) : null),
    [layout, w, h, media],
  );
  return geometry ? fn : undefined;
}

interface FramingStageProps {
  /** The stage's contents, for the geometry measured; nothing is framed until there is one. */
  children: (geometry: StageGeometry) => ReactNode;
}

export function FramingStage({ children }: FramingStageProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const geometry = useStageGeometry(contentRef);
  return (
    <div ref={contentRef} data-testid="stage-area" className="bg-charcoal absolute inset-0 overflow-hidden">
      {geometry && (
        <div
          data-testid="framing-stage"
          className="absolute overflow-hidden isolate bg-charcoal-deep outline outline-1 outline-black/25"
          style={{
            left: geometry.stage.x,
            top: geometry.stage.y,
            width: geometry.stage.w,
            height: geometry.stage.h,
          }}
        >
          {children(geometry)}
        </div>
      )}
    </div>
  );
}

interface VisitorLayerProps {
  geometry: StageGeometry;
  /** The site's theme, as CSS custom properties the visitor layer's styles read. */
  themeStyle?: CSSProperties;
  /** The stage level the layer stands at; the card's by default. */
  zIndex?: number;
  /**
   * Whether the layer itself takes pointer events. It does not by default:
   * what it holds (the card, a panel) takes its own, and the rest reaches
   * what is under the layer.
   */
  pointerEvents?: "none" | "auto";
  testId?: string;
  className?: string;
  children: ReactNode;
}

/** The author's window at the visitor's size, scaled onto the stage. */
export function VisitorLayer({
  geometry,
  themeStyle,
  zIndex = STAGE_Z.visitor,
  pointerEvents = "none",
  testId = "visitor-layer",
  className = "",
  children,
}: VisitorLayerProps) {
  return (
    <div
      data-testid={testId}
      className={`visitor-layer absolute left-0 top-0 ${pointerEvents === "none" ? "pointer-events-none" : "pointer-events-auto"} ${className}`}
      style={{
        ...themeStyle,
        width: geometry.window.w,
        height: geometry.window.h,
        transform: `scale(${geometry.stage.scale})`,
        transformOrigin: "0 0",
        zIndex,
      }}
    >
      {children}
    </div>
  );
}

interface CardStageProps {
  /** The editor's own controls for the card, in a bar above the stage, which the stage letterboxes under. */
  settings?: ReactNode;
  themeStyle?: CSSProperties;
  /** The card, for the geometry measured, drawn in a visitor layer that takes pointer events. */
  children: (geometry: StageGeometry) => ReactNode;
}

/**
 * The stage for a card that frames nothing, the title card or a section
 * card: the card fills the visitor's window, so the visitor layer takes
 * pointer events itself, and there is no image under it.
 */
export function CardStage({ settings, themeStyle, children }: CardStageProps) {
  return (
    <div className="absolute inset-0 flex flex-col">
      {settings}
      <div className="relative flex-1 min-h-0">
        <FramingStage>
          {(geometry) => (
            <VisitorLayer geometry={geometry} themeStyle={themeStyle} pointerEvents="auto">
              {children(geometry)}
            </VisitorLayer>
          )}
        </FramingStage>
      </div>
    </div>
  );
}
