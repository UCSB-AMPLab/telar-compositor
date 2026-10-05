/**
 * StagePanels — the step's open layer panels on the framing stage, as the
 * published page draws them, in the visitor's pixels.
 *
 * The panels stand in a second visitor layer (`VisitorLayer`), with the
 * card's geometry and theme, at `STAGE_Z.panels`, above the stage's chrome:
 * the visitor layer is transformed, and so a stacking context, and nothing
 * inside the card's layer could rise above the chrome. The panel layer takes
 * no pointer events and each panel takes its own, so the card and the
 * chrome beside an open panel stay usable, as the page beside an open panel
 * does on the site. Each panel is the framework's `.offcanvas.offcanvas-end`
 * at `panelBox(layer, window)`: its width tier (65% up to 800px and 55% up
 * to 750px above 1200px, 80% and 75% from 1025px to 1200px, the vertical
 * layout's sheets), sliding in from the window's right edge. Layer 2 stands
 * over layer 1.
 *
 * Only a covered panel is made `inert` (telar.js), and its controls are
 * hidden once the panel over it has slid in (visitor-layer.css). What a
 * panel owns is dismissed when it is covered: its content editor's popovers
 * and menus (`dismissed`), and focus in its fields, which the panel over it
 * takes as it opens, ending the fields' presence.
 *
 * Escape and Left arrow close the topmost panel (`usePanelDismissKeys`).
 * Opening moves focus to the top panel's heading, after the panel under it is
 * made inert, unless the panels opened from a deep link. Closing returns
 * focus to what opened the panel if it is still in the page and visible,
 * else to the button that opens that panel (the card's, or layer 1's for
 * layer 2), else to the panel layer; but not when the panels closed because
 * the author selected another step, where focus stays on what they selected.
 *
 * A panel's React key is the layer's `keyFor` key (item-key.ts): its temp id
 * for the life of the map where it has one, so an open panel is not remounted
 * when the worker assigns its database id.
 *
 * @version v1.5.0-beta
 */

import { useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { STAGE_Z, VisitorLayer } from "~/components/features/editor/FramingStage";
import { usePanelDismissKeys } from "~/hooks/use-panel-dismiss-keys";
import { panelBox, panelTier } from "~/lib/framing-stage";
import type { PanelLevel, PanelOpenRequest } from "~/hooks/use-layer-panels";
import type { StageGeometry } from "~/hooks/use-stage-geometry";
import type * as Y from "yjs";
import type { PendingLayerField } from "~/hooks/use-pending-layers";

/** One layer as the stage shows its panel. */
export interface StagePanelLayer {
  /** The layer's `keyFor` key: its temp id where it has one, else its database id. */
  key: string;
  /** The layer's database id, 0 until the worker assigns one. */
  id: number;
  layer_number: 1 | 2;
  title: string | null;
  button_label: string | null;
  content: string | null;
  titleYText: Y.Text | null;
  contentYText: Y.Text | null;
  buttonLabelYText: Y.Text | null;
  canDelete: boolean;
  /**
   * Present while the panel is held in the editor, not yet in the document
   * (use-pending-layers.ts): its fields write here, and the first content
   * writes the panel.
   */
  writeUnsaved?: (field: PendingLayerField, value: string) => void;
  /** Why the delete is disabled, where that differs from the panels' `deleteTooltip`. */
  deleteTooltip?: string;
}

export interface StagePanelsProps {
  geometry: StageGeometry;
  themeStyle?: CSSProperties;
  /** The step shown, as the editor keys a selection: a change of it is a selection, not a close. */
  selectionKey: string;
  layer1: StagePanelLayer | null;
  layer2: StagePanelLayer | null;
  /** The topmost open panel: 0 for none. */
  level: PanelLevel;
  request: PanelOpenRequest;
  onClose: (layerNumber: 1 | 2) => void;
  onDelete: (layerNumber: 1 | 2) => void;
  deleteTooltip?: string;
  /** A panel's heading and content, given whether it is covered. */
  renderPanel: (layer: StagePanelLayer, state: { covered: boolean; headingRef: RefObject<HTMLHeadingElement | null> }) => ReactNode;
}

/**
 * Whether focus can go back to `el`: in the page, shown, and not inside an
 * inert panel or content kept from assistive technology, such as the scene's
 * hidden cards measured for a media step (SceneCards).
 */
function canTakeFocus(el: HTMLElement | null): el is HTMLElement {
  if (!el || !el.isConnected || el.closest('[inert], [aria-hidden="true"]')) return false;
  return typeof el.checkVisibility !== "function" || el.checkVisibility({ visibilityProperty: true });
}

export function StagePanels({
  geometry,
  themeStyle,
  selectionKey,
  layer1,
  layer2,
  level: requested,
  request,
  onClose,
  onDelete,
  deleteTooltip,
  renderPanel,
}: StagePanelsProps) {
  const { t } = useTranslation("editor");
  // A layer that is gone is not open, whatever was asked.
  const level: PanelLevel = requested === 2 && layer1 && layer2 ? 2 : requested >= 1 && layer1 ? 1 : 0;
  const layerRef = useRef<HTMLDivElement>(null);
  const panelRefs = { 1: useRef<HTMLDivElement>(null), 2: useRef<HTMLDivElement>(null) };
  const headingRefs = { 1: useRef<HTMLHeadingElement>(null), 2: useRef<HTMLHeadingElement>(null) };
  const openers = useRef<{ 1: HTMLElement | null; 2: HTMLElement | null }>({ 1: null, 2: null });
  const shown = useRef({ level: 0 as PanelLevel, selectionKey, top: null as string | null, under: null as string | null });

  usePanelDismissKeys({
    enabled: level > 0,
    topPanel: () => (level > 0 ? panelRefs[level as 1 | 2].current : null),
    topHeading: () => (level > 0 ? headingRefs[level as 1 | 2].current : null),
    onClose: () => {
      if (level > 0) onClose(level as 1 | 2);
    },
  });

  // Focus follows the panels, after the render that made the covered panel
  // inert and before the browser paints. A close is told from an open by
  // which layer is at the top: the panels closed down to nothing, or to the
  // layer that was directly under the top one. Any other layer at the top is
  // an opening, whatever its level: another step's layer 1 opened from the
  // step line over this step's layer 2 is one.
  const top = level === 2 ? (layer2?.key ?? null) : level === 1 ? (layer1?.key ?? null) : null;
  const under = level === 2 ? (layer1?.key ?? null) : null;
  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = { level, selectionKey, top, under };
    if (top === before.top) return;
    const closing = top === null || top === before.under;
    if (!closing) {
      openers.current[level as 1 | 2] = request.opener;
      if (request.focus) headingRefs[level as 1 | 2].current?.focus({ preventScroll: true });
      return;
    }
    if (selectionKey !== before.selectionKey) return;
    const closed = before.level as 1 | 2;
    const buttonFor =
      closed === 1
        ? layerRef.current?.closest('[data-testid="framing-stage"]')?.querySelector<HTMLElement>('[data-testid="step-card"] .panel-trigger')
        : panelRefs[1].current?.querySelector<HTMLElement>("[data-layer2-pill]");
    const target = [openers.current[closed], buttonFor ?? null].find(canTakeFocus) ?? layerRef.current;
    target?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, selectionKey, top]);

  const { window: win } = geometry;
  const sheet = panelTier(win.w, win.h) === "sheet";
  const panels: Array<[StagePanelLayer | null, 1 | 2]> = [
    [layer1, 1],
    [layer2, 2],
  ];

  return (
    <VisitorLayer
      geometry={geometry}
      themeStyle={themeStyle}
      zIndex={STAGE_Z.panels}
      testId="panel-layer"
      className="stage-panel-layer"
    >
      <div ref={layerRef} tabIndex={-1} className="absolute inset-0 outline-none">
        {panels.map(([layer, n]) => {
          if (!layer || level < n) return null;
          const covered = level > n;
          const box = panelBox(n, win.w, win.h);
          return (
            <div
              key={layer.key}
              ref={panelRefs[n]}
              data-testid={`stage-panel-${n}`}
              data-layer={n}
              className={`offcanvas offcanvas-end stage-panel stage-panel-${n}`}
              data-sheet={sheet || undefined}
              inert={covered || undefined}
              style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
            >
              <div className="offcanvas-header">
                {!sheet && (
                  <button type="button" className="stage-panel-back" onClick={() => onClose(n)}>
                    {t("layer.back")}
                  </button>
                )}
                <span className="stage-panel-actions">
                  <button
                    type="button"
                    className="stage-panel-delete"
                    onClick={() => layer.canDelete && onDelete(n)}
                    aria-disabled={!layer.canDelete || undefined}
                    title={!layer.canDelete ? layer.deleteTooltip ?? deleteTooltip : undefined}
                    aria-label={t("layer.delete_title")}
                  >
                    <Trash2 className="w-4 h-4" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="btn-close"
                    onClick={() => onClose(n)}
                    aria-label={t("layer.close_panel_aria")}
                  />
                </span>
              </div>
              <div className="offcanvas-body">{renderPanel(layer, { covered, headingRef: headingRefs[n] })}</div>
            </div>
          );
        })}
      </div>
    </VisitorLayer>
  );
}
