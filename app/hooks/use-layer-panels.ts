/**
 * useLayerPanels — which of the selected step's layer panels are open, the
 * request that opened them, and the `?layer` the URL mirrors.
 *
 * `level` is the topmost open panel: 0 for none, 1 for layer 1, 2 for layer 2
 * over layer 1. Layer 2 is never open without layer 1 under it, as on the
 * published page, so one number holds both.
 *
 * Every write to the URL replaces the history entry and happens once per
 * action: opening a layer of another step writes `?step` and `?layer`
 * together, since two writes from one render can leave the first one's value
 * behind. Closing layer 2 leaves `?layer=1`; closing layer 1 closes both and
 * removes `?layer`. A deep link opens its layer without writing, since the
 * URL already says it.
 *
 * `request` says who opened the panels and whether focus moves into them: an
 * opener the author pressed moves it (the stage returns it there on close); a
 * deep link does not.
 *
 * @version v1.5.0-beta
 */

import { useCallback, useState } from "react";
import { stepParamsFor } from "~/lib/step-selection";

export type PanelLevel = 0 | 1 | 2;

/** Who opened the panels, and whether focus moves to the top panel's heading. */
export interface PanelOpenRequest {
  opener: HTMLElement | null;
  focus: boolean;
}

type SetSearchParams = (
  update: (prev: URLSearchParams) => URLSearchParams,
  options: { replace: boolean },
) => void;

export function useLayerPanels(setSearchParams: SetSearchParams) {
  const [level, setLevel] = useState<PanelLevel>(0);
  const [request, setRequest] = useState<PanelOpenRequest>({ opener: null, focus: false });

  const writeLayer = useCallback(
    (layer: PanelLevel) =>
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (layer === 0) next.delete("layer");
          else next.set("layer", String(layer));
          return next;
        },
        { replace: true },
      ),
    [setSearchParams],
  );

  /** Opens a layer of the step at `stepIndex`, writing `?step` and `?layer` at once. */
  const open = useCallback(
    (stepIndex: number, layerNumber: number, opener: HTMLElement | null = null) => {
      const layer: PanelLevel = layerNumber === 2 ? 2 : 1;
      setLevel(layer);
      setRequest({ opener, focus: true });
      setSearchParams(
        (prev) => {
          const next = stepParamsFor(prev, stepIndex);
          next.set("layer", String(layer));
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  /** Opens the layer a deep link names, leaving focus and the URL as they are. */
  const openFromLink = useCallback((layerNumber: 1 | 2) => {
    setLevel(layerNumber);
    setRequest({ opener: null, focus: false });
  }, []);

  /** Closes a layer: layer 2 leaves layer 1 open, layer 1 closes both. */
  const close = useCallback(
    (layerNumber: 1 | 2) => {
      const next: PanelLevel = layerNumber === 2 ? 1 : 0;
      setLevel((current) => (current > next ? next : current));
      writeLayer(next);
    },
    [writeLayer],
  );

  /** Closes both, leaving the URL to the caller (a step selection writes it). */
  const closeAll = useCallback(() => setLevel(0), []);

  return { level, request, open, openFromLink, close, closeAll };
}
