/**
 * usePendingLayers — the detail panels an author has added to the selected
 * step and not yet given content. They are held here, in this author's
 * editor only, and are written to the shared document on their first
 * content, so a panel nobody wrote in is never published and never shows to
 * collaborators as done. Once written, a panel is the document's: emptying it
 * later does not remove it.
 *
 * Only a title or text is content: publish omits a panel with neither, so a
 * button label alone stays held, and is written with the panel. The default
 * label written as the title is not content. A held panel is dropped when
 * the author selects another step (or the step goes) and when they delete
 * it, and gives way to a panel a
 * collaborator wrote first in the same place. It is held under the temp id it
 * is written with, so its open panel keeps its React key across the write.
 * While a publish holds the document (`frozen`) writes are held, and a panel
 * with content is written when the freeze ends. A panel with content held
 * then is kept, under its step, when the author selects another step, shows
 * again if they return to it, and is written to that step once the freeze
 * has ended, even in the render that selects the other step; `save` refuses
 * it if the step has gone.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useRef, useState } from "react";

export type PendingLayerField = "title" | "button_label" | "content";

export interface PendingLayer {
  tempId: string;
  layer_number: 1 | 2;
  /** The label the panel was given when added, which is not content. */
  defaultLabel: string;
  title: string;
  button_label: string;
  content: string;
}

/** Whether a held panel holds anything the author wrote. */
export function pendingLayerHasContent(layer: PendingLayer): boolean {
  const writtenByAuthor = (value: string) => value.trim() !== "" && value.trim() !== layer.defaultLabel;
  return layer.content.trim() !== "" || writtenByAuthor(layer.title);
}

interface Held {
  stepKey: string | null;
  layers: PendingLayer[];
  /** Panels with content held during a publish for steps not selected. */
  parked: { stepKey: string; layer: PendingLayer }[];
}

/** The held panels for `stepKey`, given the step's panels in the document. */
function heldFor(held: Held, stepKey: string | null, taken: readonly number[]): Held {
  const free = (l: PendingLayer) => !taken.includes(l.layer_number);
  if (held.stepKey === stepKey) return { ...held, layers: held.layers.filter(free) };
  const leaving = held.stepKey !== null ? held.layers.filter(pendingLayerHasContent) : [];
  const parked = [...held.parked, ...leaving.map((layer) => ({ stepKey: held.stepKey as string, layer }))];
  const returning = parked.filter((p) => p.stepKey === stepKey).map((p) => p.layer);
  return { stepKey, layers: returning.filter(free), parked: parked.filter((p) => p.stepKey !== stepKey) };
}

/**
 * `takenBy` reads the panel numbers a step already has from that step's own
 * map in the document, never from the editor's panels, which can still be the
 * previous step's in the render that selects another; `save` writes a held
 * panel to the step `heldStepKey` names and says whether it did.
 */
export function usePendingLayers(
  stepKey: string | null,
  takenBy: (stepKey: string | null) => readonly number[],
  save: (layer: PendingLayer, heldStepKey: string | null) => boolean,
  frozen = false,
) {
  const [held, setHeld] = useState<Held>({ stepKey, layers: [], parked: [] });
  const taken = takenBy(stepKey);
  const stale = held.stepKey !== stepKey || held.layers.some((l) => taken.includes(l.layer_number));
  const current: Held = stale ? heldFor(held, stepKey, taken) : held;
  if (stale) setHeld(current);
  // Writes come from editors' change listeners between renders.
  const latest = useRef(current);
  latest.current = current;
  const frozenNow = useRef(frozen);
  frozenNow.current = frozen;

  const holdOnly = (layers: PendingLayer[]) => {
    latest.current = { ...latest.current, layers };
    setHeld(latest.current);
  };
  const heldExcept = (layerNumber: number) => latest.current.layers.filter((l) => l.layer_number !== layerNumber);
  const writeHeld = (layer: PendingLayer) => {
    holdOnly(heldExcept(layer.layer_number));
    save(layer, latest.current.stepKey);
  };

  useEffect(() => {
    if (frozen) return;
    const parked = latest.current.parked;
    if (parked.length > 0) {
      latest.current = { ...latest.current, parked: [] };
      setHeld(latest.current);
      parked.forEach((p) => save(p.layer, p.stepKey));
    }
    latest.current.layers.filter(pendingLayerHasContent).forEach(writeHeld);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frozen]);

  return {
    layers: current.layers,
    create: (layerNumber: 1 | 2, defaultLabel: string) =>
      holdOnly([
        ...heldExcept(layerNumber),
        { tempId: crypto.randomUUID(), layer_number: layerNumber, defaultLabel, title: "", button_label: defaultLabel, content: "" },
      ]),
    discard: (layerNumber: number) => holdOnly(heldExcept(layerNumber)),
    write: (layerNumber: number, field: PendingLayerField, value: string) => {
      const layer = latest.current.layers.find((l) => l.layer_number === layerNumber);
      if (!layer) return;
      const next = { ...layer, [field]: value };
      if (frozenNow.current || !pendingLayerHasContent(next)) holdOnly([...heldExcept(layerNumber), next]);
      else writeHeld(next);
    },
  };
}
