/**
 * stage-chrome — where the editor's own marks and controls go on the framing
 * stage, so that none of them overlaps another.
 *
 * The framework's geometry (the region, the card, its ceiling) comes from
 * framing-stage.ts and is handed in, in stage pixels; this places the
 * editor's chrome around it: the object and step bar, the Viewfinder toggle
 * with its hint, the zoom buttons, the bottom bar, the alt-text chip, the
 * word count, and the frame, stage and ceiling labels. Each control's size is
 * measured where it is drawn and handed back in (`ChromeSizes`), with a
 * default until it has been; a label's width is capped here and its height
 * measured at that width.
 *
 * The region's controls stack from its top and from its bottom:
 *
 *   - at the top, the bar across the region, and under it the Viewfinder
 *     column at the right;
 *   - at the bottom, the bottom bar, the alt-text chip above it at the left,
 *     and, where the card is below the region (a bottom card, or a scene's
 *     card below its player), the word count between them;
 *   - the zoom buttons at the right, centred in the space the two stacks
 *     leave;
 *   - the frame label inside the frame, under the top bar, and, in portrait,
 *     the stage label under it, both in the column the right-hand controls
 *     leave.
 *
 * Beside a side card, the word count sits under the card's ceiling, the
 * ceiling label above it, and the stage label in the stage's bottom-left
 * corner clear of the word count, where the stage has room under the ceiling;
 * a window too short for that (a phone held sideways) takes the word count
 * into the region's bottom stack and the stage label under the frame label,
 * and shows the ceiling label only where there is room above the ceiling.
 * A scene's card below its player has no ceiling drawn: the published card
 * never reaches one there, since a card that tall keeps the scene beside.
 *
 * @version v1.5.0-beta
 */

import type { Box } from "~/lib/framing-stage";

export interface Size {
  w: number;
  h: number;
}

/** The measured size of each piece of chrome; a label's at the width it was given. */
export interface ChromeSizes {
  topBar: Size;
  /** The Viewfinder toggle. */
  viewfinder: Size;
  /** Its hint, under it while the guides show, in a full-size region. */
  hint: Size;
  frameLabel: Size;
  stageLabel: Size;
  ceilingLabel: Size;
  zoom: Size;
  bar: Size;
  chip: Size;
  counter: Size;
}

export type ChromePart = keyof ChromeSizes;

/** Sizes until a piece has been measured. */
export const CHROME_DEFAULTS: ChromeSizes = {
  topBar: { w: 0, h: 36 },
  viewfinder: { w: 170, h: 32 },
  hint: { w: 160, h: 40 },
  frameLabel: { w: 240, h: 20 },
  stageLabel: { w: 260, h: 34 },
  ceilingLabel: { w: 300, h: 20 },
  zoom: { w: 32, h: 104 },
  bar: { w: 0, h: 40 },
  chip: { w: 280, h: 36 },
  counter: { w: 220, h: 44 },
};

/**
 * The narrowest region the chrome is laid out at full size in. A narrower one,
 * a phone's, is compact: the Viewfinder's hint is left out (the frame label
 * says what the frame is), the alt-text chip shows its icon only, and the zoom
 * buttons lie in a row beside it above the bottom bar, leaving the region's
 * height to the labels.
 */
export const COMPACT_MAX_REGION_WIDTH = 480;

/** Whether a region `regionWidth` stage pixels wide takes the compact chrome. */
export function chromeIsCompact(regionWidth: number): boolean {
  return regionWidth < COMPACT_MAX_REGION_WIDTH;
}

/**
 * The widest the labels, the chip and the word count are drawn: their boxes are this wide, or
 * what room leaves, and the text wraps inside; only their heights are
 * measured, at those widths. The chip's label never wraps: its box is wide
 * enough for its longer label in either language, and where room leaves less
 * the label is cut.
 */
export const CHROME_WIDTHS = { frameLabel: 240, stageLabel: 260, ceilingLabel: 300, chip: 440, counter: 220 } as const;

/** The margin kept from an edge, and the gap kept between two pieces. */
export const CHROME_MARGIN = 12;
export const CHROME_GAP = 8;

export interface ChromeInput {
  stage: Size;
  /** The region the image is framed into. */
  region: Box;
  /** The frame the capture is measured in, inside the region. */
  frame: Box;
  /** The text card, and whether it is a side card (beside, or below a player) or the bottom card. */
  card: Box;
  cardPlacement: "side" | "bottom";
  /** A scene's card below its player, on a horizontal layout. */
  below: boolean;
  /** The side card's ceiling, where one is drawn. */
  ceiling: Box | null;
  show: {
    viewfinder: boolean;
    /** The frame and stage labels and the Viewfinder hint: while the guides show. */
    labels: boolean;
    /** The hint on its own, where the labels keep their room; shown with them when absent. */
    hint?: boolean;
    /** Either label on its own, where the other keeps its room; both shown when absent. */
    frameLabel?: boolean;
    stageLabel?: boolean;
    ceilingLabel: boolean;
    zoom: boolean;
    bar: boolean;
    chip: boolean;
    counter: boolean;
    /** The word count under the top bar, left of the Viewfinder, where its own place has no room. */
    counterUp?: boolean;
  };
  sizes: ChromeSizes;
}

export type ChromeLayout = Partial<Record<ChromePart, Box>> & { topBar: Box };

const right = (b: Box) => b.x + b.w;
const bottom = (b: Box) => b.y + b.h;

/** Whether two boxes share any area. */
export function boxesMeet(a: Box, b: Box): boolean {
  return a.x < right(b) && b.x < right(a) && a.y < bottom(b) && b.y < bottom(a);
}

/** Every pair of placed pieces that overlap, by name; empty where none do. */
export function chromeCollisions(layout: ChromeLayout): Array<[ChromePart, ChromePart]> {
  const entries = Object.entries(layout) as Array<[ChromePart, Box]>;
  const found: Array<[ChromePart, ChromePart]> = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (boxesMeet(entries[i][1], entries[j][1])) found.push([entries[i][0], entries[j][0]]);
    }
  }
  return found;
}

/** Whether a piece's vertical span meets a box's. */
function sharesRows(y: number, h: number, other: Box | undefined): boolean {
  return !!other && y < bottom(other) && other.y < y + h;
}

/** What the placing steps share: the input, the layout so far, and the decisions made first. */
interface Plan {
  input: ChromeInput;
  layout: ChromeLayout;
  /** Just under the top bar. */
  underTop: number;
  /** How far down the region's bottom stack leaves room, from above. */
  limit: number;
  cardUnder: boolean;
  compact: boolean;
  /** The ceiling beside a side card, where there is one. */
  ceiling: Box | null;
  roomUnderCeiling: boolean;
  counterInStack: boolean;
}

function planOf(given: ChromeInput): Plan {
  // The word count is drawn at its own width, capped where there is less room; its measured width is that cap.
  const input = { ...given, sizes: { ...given.sizes, counter: { w: CHROME_WIDTHS.counter, h: given.sizes.counter.h } } };
  const { stage, region: r, sizes } = input;
  const topBar = { x: r.x + CHROME_MARGIN, y: r.y + CHROME_MARGIN, w: Math.max(0, r.w - 2 * CHROME_MARGIN), h: sizes.topBar.h };
  const cardUnder = input.cardPlacement === "bottom";
  const ceiling = !cardUnder && !input.below ? input.ceiling : null;
  const roomUnderCeiling =
    !!ceiling && stage.h - CHROME_MARGIN - (bottom(ceiling) + CHROME_GAP) >= sizes.counter.h;
  return {
    input,
    layout: { topBar },
    underTop: bottom(topBar) + CHROME_GAP,
    limit: bottom(r) - CHROME_MARGIN,
    cardUnder,
    compact: chromeIsCompact(r.w),
    ceiling,
    roomUnderCeiling,
    counterInStack: input.show.counter && !input.show.counterUp && !cardUnder && !roomUnderCeiling,
  };
}

/** `size` no wider than `room`. */
const fitWidth = (size: Size, room: number): Size => ({ w: Math.max(0, Math.min(size.w, room)), h: size.h });

/** A piece of `size` at `x`, `y`. */
const at = (x: number, y: number, size: Size): Box => ({ x, y, w: size.w, h: size.h });

/** The Viewfinder column, at the right under the top bar. */
function placeViewfinder(p: Plan) {
  const { region: r, sizes, show } = p.input;
  if (!show.viewfinder) return;
  const s = fitWidth(sizes.viewfinder, r.w - 2 * CHROME_MARGIN);
  p.layout.viewfinder = at(right(r) - CHROME_MARGIN - s.w, p.underTop, s);
  if (!show.labels || show.hint === false || p.compact) return;
  const h = fitWidth(sizes.hint, r.w - 2 * CHROME_MARGIN);
  p.layout.hint = at(right(r) - CHROME_MARGIN - h.w, bottom(p.layout.viewfinder) + 6, h);
}

/** From the bottom: the word count on a card below the region, then the bar. */
function placeBottom(p: Plan) {
  const { region: r, sizes, show, stage, card } = p.input;
  if (show.counter && p.cardUnder && !show.counterUp) {
    const s = fitWidth(sizes.counter, stage.w - 2 * CHROME_MARGIN);
    const y = Math.min(card.y - 6, stage.h - CHROME_MARGIN) - s.h;
    p.layout.counter = at(Math.min(right(card), stage.w - CHROME_MARGIN) - s.w, y, s);
    p.limit = Math.min(p.limit, y - CHROME_GAP);
  }
  if (show.bar) {
    const h = sizes.bar.h;
    p.layout.bar = { x: r.x + CHROME_MARGIN, y: p.limit - h, w: Math.max(0, r.w - 2 * CHROME_MARGIN), h };
    p.limit = p.layout.bar.y - CHROME_GAP;
  }
}

/**
 * A compact region's tools above the bar: the word count where it has no other
 * place, the chip and the zoom row, left to right, in as many rows as the
 * region's width needs, the first nearest the bar.
 */
function placeCompactRow(p: Plan) {
  const { region: r, sizes, show } = p.input;
  const room = r.w - 2 * CHROME_MARGIN;
  const items: Array<[ChromePart, Size]> = [];
  if (p.counterInStack) items.push(["counter", fitWidth(sizes.counter, room)]);
  if (show.chip) items.push(["chip", fitWidth(sizes.chip, room)]);
  if (show.zoom) items.push(["zoom", fitWidth(zoomShape(sizes.zoom, true), room)]);
  const rows: Array<Array<[ChromePart, Size]>> = [];
  let used = Infinity;
  for (const item of items) {
    if (used + item[1].w > room) {
      rows.push([]);
      used = 0;
    }
    rows[rows.length - 1].push(item);
    used += item[1].w + CHROME_GAP;
  }
  for (const row of rows) {
    const rowH = Math.max(...row.map(([, size]) => size.h));
    const y = p.limit - rowH;
    let x = r.x + CHROME_MARGIN;
    for (const [part, size] of row) {
      p.layout[part] = at(x, y, size);
      x += size.w + CHROME_GAP;
    }
    p.limit = y - CHROME_GAP;
  }
}

/** The word count in the region's bottom stack, where it has no other place. */
function placeStackedCounter(p: Plan) {
  const { region: r, sizes } = p.input;
  p.layout.counter = at(r.x + CHROME_MARGIN, p.limit - sizes.counter.h, fitWidth(sizes.counter, r.w - 2 * CHROME_MARGIN));
  p.limit = p.layout.counter.y - CHROME_GAP;
}

/**
 * A full-size region: the zoom buttons at the right, centred between the
 * Viewfinder column and the bottom stack as far as they fit; the chip above
 * the stack, kept left of them where it meets their rows.
 */
function placeWideTools(p: Plan) {
  const { region: r, sizes, show } = p.input;
  if (p.counterInStack) placeStackedCounter(p);
  const zoomRow = show.zoom && !placeZoomColumn(p);
  // Where the column has no room, the buttons lie in a row at the right of the chip's.
  const row = zoomShape(sizes.zoom, true);
  const rowH = Math.max(show.chip ? sizes.chip.h : 0, zoomRow ? row.h : 0);
  if (zoomRow) p.layout.zoom = at(right(r) - CHROME_MARGIN - row.w, p.limit - rowH, row);
  if (show.chip) placeWideChip(p, zoomRow ? rowH : sizes.chip.h);
}

/**
 * The zoom buttons upright at the right, centred between the Viewfinder
 * column and the bottom stack as far as they fit; false where they do not.
 */
function placeZoomColumn(p: Plan): boolean {
  const { region: r, sizes } = p.input;
  const column = p.layout.hint ?? p.layout.viewfinder;
  const top = column ? bottom(column) + CHROME_GAP : p.underTop;
  const upright = zoomShape(sizes.zoom, false);
  if (p.limit - top < upright.h) return false;
  const centred = r.y + r.h / 2 - upright.h / 2;
  p.layout.zoom = at(right(r) - CHROME_MARGIN - upright.w, Math.max(top, Math.min(centred, p.limit - upright.h)), upright);
  return true;
}

/** The chip above the bottom stack, its row `rowH` tall, kept left of the zoom buttons where it meets their rows. */
function placeWideChip(p: Plan, rowH: number) {
  const { region: r, sizes } = p.input;
  const s = sizes.chip;
  const y = p.limit - rowH;
  const zoom = p.layout.zoom;
  const edge = zoom && sharesRows(y, s.h, zoom) ? zoom.x - CHROME_GAP : right(r) - CHROME_MARGIN;
  p.layout.chip = { x: r.x + CHROME_MARGIN, y, w: Math.min(CHROME_WIDTHS.chip, Math.max(0, edge - (r.x + CHROME_MARGIN))), h: s.h };
}

/**
 * The zoom buttons' size in a row or a column, from their measured size in
 * either: three buttons one way, one the other.
 */
function zoomShape(size: Size, row: boolean): Size {
  const long = Math.max(size.w, size.h);
  const short = Math.min(size.w, size.h);
  return row ? { w: long, h: short } : { w: short, h: long };
}

/** Whether the zoom buttons are placed in a row: wider than they are tall. */
export function zoomIsRow(box: Box | undefined): boolean {
  return !!box && box.w > box.h;
}

/** The room a label at `x` spanning rows `y` to `y + h` has before the right-hand controls. */
function labelRoom(p: Plan, x: number, y: number, h: number): number {
  const { region: r } = p.input;
  const blockers = [p.layout.viewfinder, p.layout.hint, p.layout.zoom];
  const edge = blockers
    .filter((b): b is Box => !!b && sharesRows(y, h, b))
    .reduce((m, b) => Math.min(m, b.x - CHROME_GAP), right(r) - CHROME_MARGIN);
  return Math.max(0, edge - x);
}

/** The frame label inside the frame under the top bar, and the stage label under it where it goes there. */
function placeFrameLabels(p: Plan) {
  const { region: r, frame, sizes, show } = p.input;
  if (!show.labels) return;
  const x = Math.max(frame.x + CHROME_GAP, r.x + CHROME_MARGIN);
  if (show.frameLabel === false) return placeStageLabelUnder(p, x, p.underTop - 6);
  const fy = Math.max(frame.y + CHROME_GAP, p.underTop);
  const fh = sizes.frameLabel.h;
  p.layout.frameLabel = { x, y: fy, w: Math.min(CHROME_WIDTHS.frameLabel, labelRoom(p, x, fy, fh)), h: fh };
  placeStageLabelUnder(p, x, bottom(p.layout.frameLabel));
}

/** The stage label under the frame label, from `above`, where it goes there. */
function placeStageLabelUnder(p: Plan, x: number, above: number) {
  const { sizes, show } = p.input;
  if (p.roomUnderCeiling || show.stageLabel === false) return;
  const sy = above + 6;
  const sh = sizes.stageLabel.h;
  p.layout.stageLabel = { x, y: sy, w: Math.min(CHROME_WIDTHS.stageLabel, labelRoom(p, x, sy, sh)), h: sh };
}

/**
 * Beside a side card with room under its ceiling: the word count there, the
 * ceiling label above the ceiling where there is room, the stage label in the
 * stage's bottom-left clear of the count.
 */
function placeBesideCeiling(p: Plan) {
  const { region: r, sizes, show } = p.input;
  const ceiling = p.ceiling;
  if (!ceiling) return;
  const counterHere = show.counter && p.roomUnderCeiling && !show.counterUp;
  if (counterHere) p.layout.counter = at(ceiling.x, bottom(ceiling) + CHROME_GAP, fitWidth(sizes.counter, r.x - CHROME_GAP - ceiling.x));
  if (show.ceilingLabel) placeCeilingLabel(p, ceiling);
  if (show.labels && show.stageLabel !== false && p.roomUnderCeiling) placeStageLabelBottom(p, counterHere ? p.layout.counter : undefined);
}

/** The ceiling label just above the ceiling, where the stage has room for it there. */
function placeCeilingLabel(p: Plan, ceiling: Box) {
  const ch = p.input.sizes.ceilingLabel.h;
  if (ceiling.y - 4 - ch < CHROME_MARGIN) return;
  p.layout.ceilingLabel = { x: ceiling.x, y: ceiling.y - 4 - ch, w: Math.min(CHROME_WIDTHS.ceilingLabel, ceiling.w), h: ch };
}

/** The stage label in the stage's bottom-left, right of the word count where it sits there. */
function placeStageLabelBottom(p: Plan, counter: Box | undefined) {
  const { region: r, sizes, stage } = p.input;
  const s = sizes.stageLabel;
  const x = counter ? right(counter) + CHROME_GAP : CHROME_MARGIN;
  const w = Math.min(CHROME_WIDTHS.stageLabel, Math.max(0, r.x - CHROME_GAP - x));
  p.layout.stageLabel = { x, y: stage.h - CHROME_MARGIN - s.h, w, h: s.h };
}

/** The word count under the top bar at the region's left, at its full width. */
function placeCounterUp(p: Plan) {
  const { region: r, sizes, show } = p.input;
  if (show.counter && show.counterUp) p.layout.counter = at(r.x + CHROME_MARGIN, p.underTop, sizes.counter);
}

/** The pieces placed from `input`, before anything is left out. */
function placeAll(input: ChromeInput): ChromeLayout {
  const p = planOf(input);
  placeViewfinder(p);
  placeCounterUp(p);
  placeBottom(p);
  if (p.compact) placeCompactRow(p);
  else placeWideTools(p);
  placeFrameLabels(p);
  placeBesideCeiling(p);
  return p.layout;
}

/**
 * What is left out where the stage has no room for everything, tier by tier:
 * the labels and the Viewfinder's hint, which only explain; then the word
 * count, the author's gauge of the answer's length; then the controls. The
 * top bar always stays.
 */
export const CHROME_DROP_TIERS: ChromePart[][] = [
  ["stageLabel", "frameLabel", "ceilingLabel", "hint"],
  ["counter"],
  ["viewfinder", "chip", "zoom", "bar"],
];

export const CHROME_DROP_ORDER: ChromePart[] = CHROME_DROP_TIERS.flat();

/** Every piece that meets another, leaves the stage, or has no room at all. */
function troubled(layout: ChromeLayout, stage: Size): Set<ChromePart> {
  const found = new Set<ChromePart>();
  for (const [a, b] of chromeCollisions(layout)) {
    found.add(a);
    found.add(b);
  }
  for (const [part, box] of Object.entries(layout) as Array<[ChromePart, Box]>) {
    const outside = box.x < 0 || box.y < 0 || right(box) > stage.w + 1e-6 || bottom(box) > stage.h + 1e-6;
    if (outside || !(box.w > 0 && box.h > 0)) found.add(part);
  }
  return found;
}

function tierOf(part: ChromePart): number {
  return CHROME_DROP_TIERS.findIndex((tier) => tier.includes(part));
}

/**
 * What to leave out next: for the first troubled piece in `CHROME_DROP_ORDER`,
 * the first piece of an earlier tier still on the stage, to give it that
 * room; where there is none, the troubled piece itself.
 */
function nextToDrop(layout: ChromeLayout, trouble: Set<ChromePart>): ChromePart | undefined {
  const first = CHROME_DROP_ORDER.find((part) => trouble.has(part));
  if (!first) return undefined;
  const tier = tierOf(first);
  return CHROME_DROP_ORDER.find((part) => tierOf(part) < tier && part in layout) ?? first;
}

/**
 * Places every piece, and where two would meet or one would leave the stage,
 * leaves one out (`nextToDrop`) and places again, until nothing does. The
 * word count is first moved under the top bar, and left out only where it
 * has no room there either.
 */
export function layoutStageChrome(input: ChromeInput): ChromeLayout {
  let current = input;
  for (;;) {
    const layout = placeAll(current);
    const drop = nextToDrop(layout, troubled(layout, current.stage));
    if (!drop) return layout;
    // The word count moves up once before it is left out.
    const change = drop === "counter" && !current.show.counterUp ? { counterUp: true } : { [drop]: false };
    current = { ...current, show: { ...current.show, ...change } };
  }
}
