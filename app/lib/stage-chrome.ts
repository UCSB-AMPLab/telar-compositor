/**
 * stage-chrome — where the editor's own marks and controls go on the framing
 * stage, so that none of them overlaps another.
 *
 * The framework's geometry (the region, the card, its ceiling) comes from
 * framing-stage.ts and is handed in, in stage pixels; this places the
 * editor's chrome around it: the object and step bar, the Viewfinder toggle,
 * the zoom buttons, the bottom bar, the alt-text chip, the word count, and
 * the four guide tags, each fixed to the guide it names, with the sentence of
 * the one that is open. Each piece's size is measured where it is drawn and
 * handed back in (`ChromeSizes`), with a default until it has been; a
 * sentence's width is capped here and its height measured at that width.
 *
 * The region's controls stack from its top and from its bottom:
 *
 *   - at the top, the bar across the region, and under it the Viewfinder
 *     toggle at the right;
 *   - at the bottom, the bottom bar, the alt-text chip above it at the left,
 *     and, where the card is below the region (a bottom card, or a scene's
 *     card below its player), the word count between them;
 *   - the zoom buttons at the right, centred in the space the two stacks
 *     leave.
 *
 * The tags go in after the controls. The frame's hangs inside the frame's
 * top-left corner, under the top bar; the centre's sits right of the centre
 * target, left of it where the zoom buttons are in the way, or under the top
 * bar where neither place has room (`placeTargetTagUp`); the ceiling's
 * sits on the ceiling's top edge, or inside it where the stage has no room
 * above (a phone held sideways). Beside a side card with room under its
 * ceiling, the word count sits flush under the ceiling's bottom edge at its
 * right end, where cut-off text would start, and the stage's tag in the
 * stage's bottom-left corner; elsewhere the word count goes into the region's
 * bottom stack and the stage's tag beside the frame's. A scene's card below
 * its player has no ceiling drawn: the published card never reaches one
 * there, since a card that tall keeps the scene beside.
 *
 * @version v1.5.2-beta
 */

import type { Box } from "~/lib/framing-stage";

export interface Size {
  w: number;
  h: number;
}

/** The four guides that carry a tag: the card's ceiling, the frame, the centre target and the whole stage. */
export type GuideTag = "ceiling" | "frame" | "target" | "stage";

/** Each guide's tag, and the sentence under (or over) it while it is open. */
export const GUIDE_TAG_PART = { ceiling: "tagCeiling", frame: "tagFrame", target: "tagTarget", stage: "tagStage" } as const;
export const GUIDE_TEXT_PART = { ceiling: "ceilingText", frame: "frameText", target: "targetText", stage: "stageText" } as const;

type TagPart = (typeof GUIDE_TAG_PART)[GuideTag];
type TextPart = (typeof GUIDE_TEXT_PART)[GuideTag];

/** The measured size of each piece of chrome; a sentence's at the width it was given. */
export interface ChromeSizes {
  topBar: Size;
  /** The Viewfinder toggle. */
  viewfinder: Size;
  tagCeiling: Size;
  tagFrame: Size;
  tagTarget: Size;
  tagStage: Size;
  ceilingText: Size;
  frameText: Size;
  targetText: Size;
  stageText: Size;
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
  tagCeiling: { w: 200, h: 30 },
  tagFrame: { w: 100, h: 30 },
  tagTarget: { w: 110, h: 30 },
  tagStage: { w: 160, h: 30 },
  ceilingText: { w: 320, h: 85 },
  frameText: { w: 320, h: 85 },
  targetText: { w: 280, h: 85 },
  stageText: { w: 320, h: 85 },
  zoom: { w: 32, h: 104 },
  bar: { w: 0, h: 40 },
  chip: { w: 280, h: 36 },
  counter: { w: 220, h: 44 },
};

/**
 * The narrowest region the chrome is laid out at full size in. A narrower one,
 * a phone's, is compact: the guide tags show their icon only, the alt-text
 * chip shows its icon only, and the zoom buttons lie in a row beside it above
 * the bottom bar, leaving the region's height to the tags.
 */
export const COMPACT_MAX_REGION_WIDTH = 480;

/** A guide tag in a compact region: its icon alone, in a 32px square. */
export const COMPACT_TAG: Size = { w: 32, h: 32 };

/** Whether a region `regionWidth` stage pixels wide takes the compact chrome. */
export function chromeIsCompact(regionWidth: number): boolean {
  return regionWidth < COMPACT_MAX_REGION_WIDTH;
}

/**
 * The widest the sentences, the chip and the word count are drawn: their boxes
 * are this wide, or what room leaves, and the text wraps inside; only their
 * heights are measured, at those widths. The chip's label never wraps: its box
 * is wide enough for its longer label in either language, and where room
 * leaves less the label is cut.
 */
export const CHROME_WIDTHS = {
  ceilingText: 320,
  frameText: 320,
  targetText: 280,
  stageText: 320,
  chip: 440,
  counter: 220,
} as const;

/** The centre target's half-size and the gap kept from it, which the centre's tag stands off by. */
const TARGET_REACH = 15 + 10;

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
    /** The frame's, the centre's and the stage's tags: while an image's guides show. */
    tags: boolean;
    /** The ceiling's tag: while the guides show and a ceiling is drawn. */
    ceilingTag: boolean;
    /** The tag whose sentence is open, if any. */
    open?: GuideTag | null;
    zoom: boolean;
    bar: boolean;
    chip: boolean;
    counter: boolean;
    /** The word count under the top bar, left of the Viewfinder, where its own place has no room. */
    counterUp?: boolean;
    /** The open sentence in its fallback place under the top bar, where its own place has no room (`placeSentenceUp`). */
    textUp?: boolean;
    /** The centre's tag in its fallback place under the top bar, where its own place has no room (`placeTargetTagUp`). */
    tagTargetUp?: boolean;
  } & Partial<Record<TagPart | TextPart, boolean>>;
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
  const compact = chromeIsCompact(given.region.w);
  // The word count is drawn at its own width, capped where there is less room; its measured width is that cap.
  // A compact region's tags are their icon alone, whose size is fixed.
  const input = {
    ...given,
    sizes: {
      ...given.sizes,
      counter: { w: CHROME_WIDTHS.counter, h: given.sizes.counter.h },
      ...(compact ? { tagCeiling: COMPACT_TAG, tagFrame: COMPACT_TAG, tagTarget: COMPACT_TAG, tagStage: COMPACT_TAG } : {}),
    },
  };
  const { stage, region: r, sizes } = input;
  const topBar = { x: r.x + CHROME_MARGIN, y: r.y + CHROME_MARGIN, w: Math.max(0, r.w - 2 * CHROME_MARGIN), h: sizes.topBar.h };
  const cardUnder = input.cardPlacement === "bottom";
  const ceiling = !cardUnder && !input.below ? input.ceiling : null;
  // The word count hangs flush from the ceiling's bottom edge, so that is all the room it needs.
  const roomUnderCeiling = !!ceiling && stage.h - CHROME_MARGIN - bottom(ceiling) >= sizes.counter.h;
  return {
    input,
    layout: { topBar },
    underTop: bottom(topBar) + CHROME_GAP,
    limit: bottom(r) - CHROME_MARGIN,
    cardUnder,
    compact,
    ceiling,
    roomUnderCeiling,
    counterInStack: input.show.counter && !input.show.counterUp && !cardUnder && !roomUnderCeiling,
  };
}

/** `size` no wider than `room`. */
const fitWidth = (size: Size, room: number): Size => ({ w: Math.max(0, Math.min(size.w, room)), h: size.h });

/** A piece of `size` at `x`, `y`. */
const at = (x: number, y: number, size: Size): Box => ({ x, y, w: size.w, h: size.h });

/** The Viewfinder toggle, at the right under the top bar. */
function placeViewfinder(p: Plan) {
  const { region: r, sizes, show } = p.input;
  if (!show.viewfinder) return;
  const s = fitWidth(sizes.viewfinder, r.w - 2 * CHROME_MARGIN);
  p.layout.viewfinder = at(right(r) - CHROME_MARGIN - s.w, p.underTop, s);
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
 * Viewfinder toggle and the bottom stack as far as they fit; the chip above
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
 * toggle and the bottom stack as far as they fit; false where they do not.
 */
function placeZoomColumn(p: Plan): boolean {
  const { region: r, sizes } = p.input;
  const column = p.layout.viewfinder;
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

/**
 * The room a piece at `x` spanning rows `y` to `y + h` has before `edge`, or
 * before the first of the controls right of it that shares those rows.
 */
function roomRightOf(p: Plan, x: number, y: number, h: number, edge = right(p.input.region) - CHROME_MARGIN): number {
  const blockers = [p.layout.viewfinder, p.layout.zoom, p.layout.counter];
  const limit = blockers
    .filter((b): b is Box => !!b && b.x > x && sharesRows(y, h, b))
    .reduce((m, b) => Math.min(m, b.x - CHROME_GAP), edge);
  return Math.max(0, limit - x);
}

/** Whether `tag`'s piece is placed: shown, and not left out on its own. */
function tagShown(p: Plan, tag: GuideTag): boolean {
  const { show } = p.input;
  if (show[GUIDE_TAG_PART[tag]] === false) return false;
  return tag === "ceiling" ? show.ceilingTag && !!p.ceiling : show.tags;
}

/**
 * The frame's tag, hanging inside the frame's top-left corner, flush to the
 * stroke; under the top bar where the frame starts above the bar's bottom,
 * and so off the stroke (`frameTagOnStroke`).
 */
function placeFrameTag(p: Plan) {
  if (!tagShown(p, "frame")) return;
  const { frame } = p.input;
  const flush = frame.y + 1;
  const y = flush >= bottom(p.layout.topBar) ? flush : p.underTop;
  p.layout.tagFrame = at(frame.x + 1, y, p.input.sizes.tagFrame);
}

/** Whether the frame's tag hangs from the frame's top stroke, rather than standing under the top bar. */
export function frameTagOnStroke(tag: Box | undefined, frame: Box): boolean {
  return !!tag && Math.abs(tag.y - (frame.y + 1)) < 1e-6;
}

/**
 * The stage's tag: flush in the stage's bottom-left corner beside a side card
 * with room under its ceiling; elsewhere that corner is the card's (a bottom
 * card, a card below its player, a phone held sideways), and the tag stands
 * beside the frame's, on its row.
 */
function placeStageTag(p: Plan) {
  if (!tagShown(p, "stage")) return;
  const { sizes, stage, frame } = p.input;
  const s = sizes.tagStage;
  if (p.roomUnderCeiling) {
    p.layout.tagStage = at(0, stage.h - s.h, s);
    return;
  }
  const beside = p.layout.tagFrame;
  if (beside) p.layout.tagStage = at(right(beside) + CHROME_GAP, beside.y, s);
  else p.layout.tagStage = at(frame.x + 1, Math.max(frame.y + 1, p.underTop), s);
}

/**
 * The centre's tag, right of the centre target, or left of it where it would
 * meet the zoom buttons or leave the region's margin; or in its fallback place.
 */
function placeTargetTag(p: Plan) {
  if (!tagShown(p, "target")) return;
  if (p.input.show.tagTargetUp) return placeTargetTagUp(p);
  const { region: r, sizes } = p.input;
  const s = sizes.tagTarget;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const box = at(cx + TARGET_REACH, cy - 15, s);
  const zoom = p.layout.zoom;
  const meetsZoom = !!zoom && sharesRows(box.y, box.h, zoom) && right(box) + CHROME_GAP > zoom.x && box.x < right(zoom);
  const leaves = right(box) > right(r) - CHROME_MARGIN;
  p.layout.tagTarget = meetsZoom || leaves ? at(cx - TARGET_REACH - s.w, box.y, s) : box;
}

/**
 * The centre's tag's fallback place, where its own meets a piece or leaves the
 * region: under the top bar, after the tags standing directly under it, or at
 * the region's left inset where none does.
 */
function placeTargetTagUp(p: Plan) {
  const row = [p.layout.tagFrame, p.layout.tagStage].filter((b): b is Box => !!b && b.y <= p.underTop + 1e-6);
  const x = row.reduce((end, b) => Math.max(end, right(b) + CHROME_GAP), p.input.region.x + CHROME_MARGIN);
  p.layout.tagTarget = at(x, p.underTop, p.input.sizes.tagTarget);
}

/**
 * The ceiling's tag, sitting on the ceiling's top edge; inside its top-left
 * corner where the stage has no room above it.
 */
function placeCeilingTag(p: Plan) {
  const ceiling = p.ceiling;
  if (!ceiling || !tagShown(p, "ceiling")) return;
  const s = p.input.sizes.tagCeiling;
  p.layout.tagCeiling = ceiling.y - s.h >= 0 ? at(ceiling.x, ceiling.y - s.h, s) : at(ceiling.x + 1, ceiling.y + 1, s);
}

/** Whether the ceiling's tag went inside the ceiling rather than on its top edge. */
export function ceilingTagInside(tag: Box | undefined, ceiling: Box | null): boolean {
  return !!tag && !!ceiling && tag.y > ceiling.y - tag.h + 1e-6;
}

/** Whether the stage's tag sits in the stage's bottom-left corner. */
export function stageTagInCorner(tag: Box | undefined, stage: Size): boolean {
  return !!tag && tag.x === 0 && Math.abs(bottom(tag) - stage.h) < 1e-6;
}

/**
 * The open tag's sentence, at its width or the room the chrome leaves: under
 * the tag, except the stage's in its corner, which opens upward, stacked on
 * the tag and kept clear of the word count; or in its fallback place
 * (`placeSentenceUp`). Measured last in the fallback place, which is wider, it
 * is read in its own place as tall as that text could be there (`heightAt`),
 * so that it does not return to a place it has no room in.
 */
function placeSentence(p: Plan) {
  const open = p.input.show.open;
  if (!open || p.input.show[GUIDE_TEXT_PART[open]] === false) return;
  const tag = p.layout[GUIDE_TAG_PART[open]];
  if (!tag) return;
  const part = GUIDE_TEXT_PART[open];
  if (p.input.show.textUp) {
    placeSentenceUp(p, part, tag);
    return;
  }
  const size = p.input.sizes[part];
  const corner = open === "stage" && stageTagInCorner(tag, p.input.stage);
  const box = ownSentenceBox(p, open, tag, corner);
  p.layout[part] = Math.abs(size.w - upWidth(p)) < 1 ? asTallAsItGets(box, size, tag, corner) : box;
}

/** The open sentence's box in its own place: stacked on the stage's corner tag, on the ceiling, or under its tag. */
function ownSentenceBox(p: Plan, open: GuideTag, tag: Box, corner: boolean): Box {
  const part = GUIDE_TEXT_PART[open];
  const { h } = p.input.sizes[part];
  const widest = CHROME_WIDTHS[part];
  const { region: r, stage } = p.input;
  if (corner) {
    const y = tag.y - h;
    const edge = r.x > tag.x ? r.x - CHROME_GAP : stage.w - CHROME_MARGIN;
    return { x: tag.x, y, w: Math.min(widest, roomRightOf(p, tag.x, y, h, edge)), h };
  }
  if (open === "ceiling") return { x: tag.x, y: bottom(tag) + 1, w: Math.min(widest, right(p.ceiling!) - tag.x), h };
  const y = bottom(tag) + (open === "frame" ? 0 : 4);
  // The stage's tag beside the frame's opens its sentence from the start of their row.
  const x = open === "stage" ? Math.min(tag.x, p.layout.tagFrame?.x ?? tag.x) : tag.x;
  return { x, y, w: Math.min(widest, roomRightOf(p, x, y, h)), h };
}

/** A sentence's own-place box at the height its text could reach there, still opening upward from a corner tag. */
function asTallAsItGets(box: Box, size: Size, tag: Box, corner: boolean): Box {
  const tall = heightAt(size, box.w, true);
  return { ...box, h: tall, y: corner ? tag.y - tall : box.y };
}

/** The fallback place's width: the region's, at the top bar's inset. */
const upWidth = (p: Plan) => Math.max(0, p.input.region.w - 2 * CHROME_MARGIN);

/**
 * The open sentence's fallback place, where its own has no room even once the
 * other tags and the word count have given way: under the top bar, across the
 * region at the top bar's inset, below the Viewfinder toggle and its own tag
 * where either stands directly under the bar. It stands free of its tag
 * (`sentenceStandsFree`). Measured last in its own place, it is read here as
 * short as its text could be (`heightAt`) until it is measured here: read as
 * tall, it would close where it fits.
 */
function placeSentenceUp(p: Plan, part: TextPart, tag: Box) {
  const { region: r, sizes } = p.input;
  const y = [p.layout.viewfinder, tag].reduce((top, b) => (b && b.y <= p.underTop + 1e-6 ? Math.max(top, bottom(b) + CHROME_GAP) : top), p.underTop);
  const w = upWidth(p);
  p.layout[part] = { x: r.x + CHROME_MARGIN, y, w, h: heightAt(sizes[part], w, false) };
}

/** A sentence's padding across and down, and its line, as `StageGuideTags` draws it (px-[13px] py-[10px], 15px at 1.45). */
export const SENTENCE_TEXT = { padX: 26, padY: 20, line: 15 * 1.45 } as const;

/**
 * A sentence's height at width `w`, from the size it was measured at: the
 * measured height where the two widths are within a pixel (the browser rounds
 * the width it reports); elsewhere its lines rewrapped, read as tall as its
 * text could be (`asTall`: each line full) or as short (its last line all but
 * empty).
 */
function heightAt(size: Size, w: number, asTall: boolean): number {
  if (Math.abs(size.w - w) < 1) return size.h;
  const { padX, padY, line } = SENTENCE_TEXT;
  const lines = Math.max(1, Math.round((size.h - padY) / line));
  const across = Math.max(1, size.w - padX) / Math.max(1, w - padX);
  return padY + (asTall ? Math.ceil(lines * across - 1e-6) : Math.ceil((lines - 1) * across + 1e-6)) * line;
}

/**
 * Whether a sentence stands free of its tag, in its fallback place, rather
 * than opening from it: in its own place it starts at most 4px under the tag,
 * or ends on the tag's top edge.
 */
export function sentenceStandsFree(text: Box | undefined, tag: Box | undefined): boolean {
  if (!text || !tag) return false;
  const under = text.y >= bottom(tag) - 1e-6 && text.y <= bottom(tag) + 4 + 1e-6;
  return !under && Math.abs(bottom(text) - tag.y) > 1e-6;
}

/** Beside a side card with room under its ceiling: the word count flush under the ceiling, at its right end. */
function placeCounterUnderCeiling(p: Plan) {
  const { sizes, show } = p.input;
  const ceiling = p.ceiling;
  if (!ceiling || !show.counter || !p.roomUnderCeiling || show.counterUp) return;
  const s = fitWidth(sizes.counter, ceiling.w);
  p.layout.counter = at(right(ceiling) - s.w, bottom(ceiling), s);
}

/** The guide tags, after the controls, and the open one's sentence. */
function placeGuides(p: Plan) {
  placeFrameTag(p);
  placeStageTag(p);
  placeTargetTag(p);
  placeCeilingTag(p);
  placeSentence(p);
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
  placeCounterUnderCeiling(p);
  placeGuides(p);
  return p.layout;
}

/**
 * What is left out where the stage has no room for everything, tier by tier:
 * an open sentence, which closes and leaves its tag; then the tags, which
 * only explain; then the word count, the author's gauge of the answer's
 * length; then the controls. The top bar always stays.
 *
 * While a sentence is open, the author has asked to read it, so the other
 * tags and then the word count give way to it before it closes: a tag it
 * meets is left out, and the word count moves under the top bar, or is left
 * out, where that clears the sentence (leaving the bottom stack moves the
 * controls in it). Its own tag stays. The controls and the top bar never give
 * way to a sentence: where it still meets one, or leaves the stage, it opens
 * instead in its fallback place under the top bar (`placeSentenceUp`), where
 * the tags and the word count give way to it again, a tag closer under it
 * than the gap counting as meeting it (`crowdedUnder`), and the controls do not;
 * where it has no room there either, it closes, and the pieces that would have
 * given way in either place stay. With no sentence open, the order is the
 * tiers'. The centre's tag moves under the top bar once before it is left out.
 */
export const CHROME_DROP_TIERS: ChromePart[][] = [
  ["stageText", "targetText", "ceilingText", "frameText"],
  ["tagStage", "tagTarget", "tagCeiling", "tagFrame"],
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

/**
 * The open sentence's box as the other pieces must keep clear of it: in its
 * fallback place, with the gap kept between two pieces below it, so that a tag
 * closer under it than the gap meets it.
 */
function sentenceReach(layout: ChromeLayout, show: ChromeInput["show"]): Box | undefined {
  const box = show.open ? layout[GUIDE_TEXT_PART[show.open]] : undefined;
  return box && show.textUp ? { ...box, h: box.h + CHROME_GAP } : box;
}

/** The open sentence in its fallback place and every tag closer under it than the gap; empty where none is. */
function crowdedUnder(layout: ChromeLayout, show: ChromeInput["show"]): ChromePart[] {
  const reach = show.textUp ? sentenceReach(layout, show) : undefined;
  const tags = reach ? CHROME_DROP_TIERS[1].filter((part) => layout[part] && boxesMeet(reach, layout[part]!)) : [];
  return tags.length ? [GUIDE_TEXT_PART[show.open!], ...tags] : [];
}

const SENTENCES = new Set<ChromePart>(Object.values(GUIDE_TEXT_PART));

function tierOf(part: ChromePart): number {
  return CHROME_DROP_TIERS.findIndex((tier) => tier.includes(part));
}

/**
 * What to leave out next: for the first troubled piece in `CHROME_DROP_ORDER`,
 * the first piece of an earlier tier still on the stage, to give it that
 * room; where there is none, the troubled piece itself. An open sentence is
 * left out only where it meets something itself: closing one that meets
 * nothing gives no piece room. While a sentence is drawn its own tag stays:
 * where the tag would be left out, the sentence is in trouble instead, and is
 * given room or closes (`layoutStageChrome`).
 */
function nextToDrop(layout: ChromeLayout, trouble: Set<ChromePart>, open: GuideTag | null | undefined): ChromePart | undefined {
  const first = CHROME_DROP_ORDER.find((part) => trouble.has(part));
  if (!first) return undefined;
  const tier = tierOf(first);
  const pick = CHROME_DROP_ORDER.find((part) => !SENTENCES.has(part) && tierOf(part) < tier && part in layout) ?? first;
  return open && pick === GUIDE_TAG_PART[open] && GUIDE_TEXT_PART[open] in layout ? GUIDE_TEXT_PART[open] : pick;
}

/** `input` with `part` left out; the word count and the centre's tag move under the top bar once before they are. */
function without(input: ChromeInput, part: ChromePart): ChromeInput {
  const { counterUp, tagTargetUp } = input.show;
  const change =
    part === "counter" && !counterUp ? { counterUp: true } : part === "tagTarget" && !tagTargetUp ? { tagTargetUp: true } : { [part]: false };
  return { ...input, show: { ...input.show, ...change } };
}

/**
 * The next piece to give way to the open sentence, which is in trouble in
 * `layout`: the first tag it meets, in the tiers' order; where it meets none,
 * the word count, whose place in the bottom stack moves the controls. Its own
 * tag gives it room only by moving, as the centre's does; left out, it takes
 * the sentence with it.
 */
function givingWay(layout: ChromeLayout, show: ChromeInput["show"]): ChromePart | undefined {
  const sentence = sentenceReach(layout, show)!;
  const tag = CHROME_DROP_TIERS[1].find((part) => layout[part] && boxesMeet(sentence, layout[part]!));
  return tag ?? ("counter" in layout ? "counter" : undefined);
}

/**
 * The ways `part` can give way to an open sentence, each with the piece the
 * result must keep to count: the word count moves under the top bar, kept
 * only where it stays there, and otherwise is left out, without the tags it
 * would have taken with it; a tag is left out.
 */
function waysToGive(input: ChromeInput, part: ChromePart): Array<[ChromeInput, ChromePart | null]> {
  if (part !== "counter" || input.show.counterUp) return [[without(input, part), null]];
  return [
    [without(input, part), "counter"],
    [{ ...input, show: { ...input.show, counter: false } }, null],
  ];
}

/**
 * Places every piece, and where two would meet or one would leave the stage,
 * leaves one out (`nextToDrop`) and places again, until nothing does. The
 * word count is first moved under the top bar, and left out only where it
 * has no room there either. An open sentence in trouble is first given room
 * (`givingWay`), then tried in its fallback place, given room there the same
 * way, and closed only where neither clears it; then the pieces tried for it
 * stay.
 */
export function layoutStageChrome(input: ChromeInput): ChromeLayout {
  let current = input;
  for (;;) {
    const layout = placeAll(current);
    const open = current.show.open;
    const trouble = troubled(layout, current.stage);
    for (const part of crowdedUnder(layout, current.show)) trouble.add(part);
    const drop = nextToDrop(layout, trouble, open);
    if (!drop) return layout;
    const kept = openSentenceRetry(current, layout, drop);
    if (kept) return kept;
    current = without(current, drop);
  }
}

/** Where the open sentence is the piece to drop: the layout once it is given room, or tried in its fallback place, that places it. */
function openSentenceRetry(current: ChromeInput, layout: ChromeLayout, drop: ChromePart): ChromeLayout | undefined {
  const open = current.show.open;
  if (!open || drop !== GUIDE_TEXT_PART[open]) return undefined;
  const yields = givingWay(layout, current.show);
  for (const [next, keeps] of yields ? waysToGive(current, yields) : []) {
    const given = layoutStageChrome(next);
    if (given[drop] && (!keeps || keeps in given)) return given;
  }
  if (current.show.textUp) return undefined;
  const up = layoutStageChrome({ ...current, show: { ...current.show, textUp: true } });
  return up[drop] ? up : undefined;
}
