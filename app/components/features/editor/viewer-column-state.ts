/**
 * What the viewer column derives, once, from a step and from the viewer's
 * source state: which page the step saved, what framing it saved, which page
 * the source is showing, whether Capture may be pressed, and what the viewport
 * it reads is bound to.
 *
 * These are pure readings rather than the column's own state, and they are kept
 * together because they answer one question between them — is what the author
 * is looking at the thing the step describes? The column's own answers depend
 * on all four agreeing.
 *
 * @version v1.5.0-beta
 */

import { effectivePageOf } from "~/components/features/objects/IiifViewer";
import type { SourceState, ViewerInstanceMeta } from "~/components/features/objects/IiifViewer";
import type { WriteBinding } from "~/lib/step-writes";

/** The instance the column currently holds, with the facts it was built from. */
export interface InstanceRecord {
  meta: ViewerInstanceMeta;
  opened: boolean;
}

/** A step's stored viewport, present only when all three values are stored. */
export interface SavedFraming {
  x: number;
  y: number;
  zoom: number;
}

/** The fields of a step these readings need. */
export interface StepReading {
  x: number | null;
  y: number | null;
  zoom: number | null;
  page: string | null;
}

/**
 * The step's saved page as a 1-based number, or null when it stores none. A
 * value that is not a positive integer is treated as no page at all: the
 * framework clears a page the object does not have at build time, and the
 * editor never invents one.
 */
export function savedPageOf(step: StepReading | null): number | null {
  const raw = step?.page ? Number(step.page) : NaN;
  return Number.isInteger(raw) && raw > 0 ? raw : null;
}

/**
 * The saved framing, tested for null rather than truthiness: a saved x or y of
 * 0 is a position at the edge of the image, not an absent one.
 */
export function savedFramingOf(step: StepReading | null): SavedFraming | null {
  if (!step) return null;
  const { x, y, zoom } = step;
  if (x === null || y === null || zoom === null) return null;
  return { x, y, zoom };
}

/**
 * The page and count the source reports, or zeroes while it is loading or
 * unavailable. A count of 0 means the bar shows no page cluster.
 */
export function readyPages(source: SourceState | null): { page: number; count: number } {
  if (!source || source.status !== "ready") return { page: 0, count: 0 };
  return { page: source.page, count: source.pageCount };
}

/**
 * Capture is usable only when the instance in front of the author is the one
 * the current source state describes and it has opened: the source key, the
 * generation and the page must all match, so a viewport can never be pinned
 * onto a page other than the one it was read from.
 */
export function captureIsReady(
  instance: InstanceRecord | null,
  source: SourceState | null
): boolean {
  if (!instance || !instance.opened) return false;
  if (!source || source.status !== "ready") return false;
  const { meta } = instance;
  return (
    meta.sourceKey === source.sourceKey &&
    meta.generation === source.generation &&
    meta.page === source.page
  );
}

/** The inputs the page-selection and framing triggers watch, one render apart. */
export interface TriggerInputs {
  selectionKey: string;
  page: string | null;
  x: number | null;
  y: number | null;
  zoom: number | null;
  sourceKey: string;
}

export function triggerInputs(
  step: StepReading | null,
  selectionKey: string,
  sourceKey: string
): TriggerInputs {
  return {
    selectionKey,
    page: step?.page ?? null,
    x: step?.x ?? null,
    y: step?.y ?? null,
    zoom: step?.zoom ?? null,
    sourceKey,
  };
}

/**
 * What a render's inputs ask for. `retarget` moves the page to the step's own
 * page and reframes there — a selection change, a saved-page change, a source
 * change. `reframe` leaves the page where the author browsed it and lets the
 * request wait until they reach the saved page, which is what a peer's capture
 * or an undo asks for.
 */
export function triggerVerdict(
  prev: TriggerInputs | null,
  cur: TriggerInputs
): "retarget" | "reframe" | "none" {
  if (prev === null) return "retarget";
  if (prev.selectionKey !== cur.selectionKey) return "retarget";
  if (prev.page !== cur.page) return "retarget";
  if (prev.sourceKey !== cur.sourceKey) return "retarget";
  if (prev.x !== cur.x || prev.y !== cur.y || prev.zoom !== cur.zoom) return "reframe";
  return "none";
}

/**
 * Whether a pending request belongs to the instance in front of the author:
 * the source key, the generation and the page must agree across all three of
 * the source state, the instance record and the request, and the source must be
 * `ready`, since a loading or unavailable source describes no instance at all.
 *
 * The request keeps the page it asked for and is resolved against the count
 * only here, because the count is not known when the request is made: a saved
 * page of 900 on a three-page manifest is the last page, and a request for it
 * must land on the instance that already shows it.
 */
export function framingMatches(
  request: { sourceKey: string; page: number },
  instance: InstanceRecord,
  source: SourceState
): boolean {
  if (source.status !== "ready") return false;
  if (instance.meta.sourceKey !== source.sourceKey) return false;
  if (instance.meta.generation !== source.generation) return false;
  if (instance.meta.page !== source.page) return false;
  if (request.sourceKey !== source.sourceKey) return false;
  return effectivePageOf(request.page, source.pageCount) === instance.meta.page;
}

/**
 * What a capture is bound to, or null when nothing may be captured: the
 * instance in front of the author must be the one the current source state
 * describes and have opened, and the step must name a target and an object.
 *
 * This reads the records as they stand at the press, never the flag a render
 * computed: the instance a render was drawn from can have been destroyed by a
 * page change since, and a viewport read from a viewer that has gone would be
 * pinned onto whatever the step shows now.
 */
export function captureBindingOf(
  instance: InstanceRecord | null,
  source: SourceState | null,
  selectionKey: string,
  targetKey: string | null,
  objectId: string | null
): WriteBinding | null {
  if (!instance || !captureIsReady(instance, source)) return null;
  if (!targetKey || !objectId) return null;
  return { selectionKey, targetKey, objectId, sourceKey: instance.meta.sourceKey };
}
