/**
 * framing-stage — the visitor's window, as the published story page lays it out.
 *
 * The framing stage shows an author the page a visitor with a window shaped
 * like theirs will see: where the text card sits, the region beside or above
 * it that the framework frames the image into, where the card's height stops,
 * and where the layer panels open. Every number here is the framework's, read
 * from its stylesheets and story modules, and
 * `tests/framing-stage-parity.test.ts` reads each one back from framework
 * source, so a value changed on either side fails rather than drifts.
 *
 * Layout mode and card placement are separate answers. The layout mode is the
 * framework's vertical-layout media query; the card is a side card in
 * horizontal layout and also in a vertical layout too short for a bottom card,
 * which is a phone held sideways. That phone keeps the vertical panel rules.
 *
 * On a horizontal layout the side card is sized from both window dimensions
 * (`sideCardWidth` in `card-fit.js`) and takes its content's height, at the
 * answer's own size, under a ceiling that keeps it clear of the top controls
 * and one gutter above the window's bottom; its top is held between those two
 * lines, and past the ceiling the card clips. A phone held sideways (a
 * vertical layout wider than it is tall, 480px high or less) keeps 37% of the
 * width and takes the same ceiling and the same band for its card's top
 * (`sideCardBand` in `card-fit.js`, which `card-pool.js` writes for it), and
 * its card scrolls inside itself past the ceiling.
 *
 * A video or audio step places its player by the same rules the page does, and
 * on a horizontal layout its scene's cards go beside the player or below it,
 * decided once for the scene from its tallest card by `mediaCardBelow`; every
 * media function takes that answer as `below`.
 *
 * Geometry is in the visitor's CSS pixels, with no safe-area inset and the card
 * at rest: a card's messiness offset and rotation move the rect the framework
 * measures by a few pixels, and those are not modelled.
 *
 * @version v1.5.0-beta
 */

/** A rectangle in the visitor's window, CSS pixels from the top left. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type LayoutMode = "horizontal" | "vertical";
export type CardPlacement = "side" | "bottom";

export interface VisitorLayout {
  mode: LayoutMode;
  cardPlacement: CardPlacement;
}

/** The three width regimes of the layer panels. */
export type PanelTier = "wide" | "narrow" | "sheet";

/** One CSS rem in the framework's stylesheets. */
const REM_PX = 16;

// ── Breakpoints (`_sass/_responsive.scss`) ──────────────────────────────────

/** Vertical layout at this width and below: `max-width: $telar-vertical-min-width`. */
export const VERTICAL_MAX_WIDTH = 1024;

/** Vertical layout at this aspect (width / height) and below: `max-aspect-ratio`. */
export const VERTICAL_MAX_ASPECT = 0.75;

/**
 * A side card at this viewport height and below, and a vertical layout:
 * `max-height: $telar-card-landscape-max-height`, read by `isPhoneHeightSideCard`
 * and the vertical layout's height clause.
 */
export const LANDSCAPE_SIDE_CARD_MAX_HEIGHT = 480;

/** `$telar-vertical-band-step`: the height of each short-window band, in px. */
export const VERTICAL_BAND_STEP = 8;

// ── The side card (`_sass/_story.scss` `.text-card`, `card-pool.js`) ────────

/**
 * `$telar-card-side-left: 3%`, as a fraction of the window's width: the text
 * card's left edge, and the one `video-layout.js` places a player beside.
 */
export const CARD_SIDE_LEFT = 0.03;

/**
 * `$telar-card-side-width: 37%`, as a fraction of the window's width: the side
 * card's width on a vertical layout, where `card-fit.js` publishes none.
 */
export const CARD_SIDE_WIDTH = 0.37;

/**
 * The side card's width terms on a horizontal layout (`$telar-card-side-*`):
 * its share of the window's width at least and at most, and the line in the
 * window's height, base − slope·H px, held to `maxByHeight`, between them.
 */
export const SIDE_CARD_WIDTH_TERMS = { minShare: 0.37, maxShare: 0.52, base: 1544, slope: 1.6, maxByHeight: 718 } as const;

/** The width the side card needs at height `h` before the shares hold it: `_side-card-need`. */
function sideCardNeed(h: number): number {
  const t = SIDE_CARD_WIDTH_TERMS;
  return Math.min(t.maxByHeight, t.base - t.slope * h);
}

/**
 * `sideCardWidth` in `card-fit.js`, the width it publishes as
 * `--telar-card-side-width` on a horizontal layout, in px:
 *
 *   round( min( maxShare·w,  max( minShare·w,  min( maxByHeight,  base − slope·h ) ) ) )
 */
export function sideCardWidthPx(w: number, h: number): number {
  const t = SIDE_CARD_WIDTH_TERMS;
  return Math.round(Math.min(t.maxShare * w, Math.max(t.minShare * w, sideCardNeed(h))));
}

/**
 * `$telar-vertical-short-windows`, as [max height, max width] pairs: from the
 * first height above the side-card threshold, in bands of
 * `VERTICAL_BAND_STEP`, each band's widest window that cannot hold the card's
 * need at the band's bottom height under `maxShare`, until that width is no
 * wider than `VERTICAL_MAX_WIDTH`.
 */
function shortWindows(): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  for (let bottom = LANDSCAPE_SIDE_CARD_MAX_HEIGHT + 1; ; bottom += VERTICAL_BAND_STEP) {
    const maxW = Math.ceil(sideCardNeed(bottom) / SIDE_CARD_WIDTH_TERMS.maxShare) - 1;
    if (maxW <= VERTICAL_MAX_WIDTH) return out;
    out.push([bottom + VERTICAL_BAND_STEP - 1, maxW]);
  }
}

export const VERTICAL_SHORT_WINDOWS: ReadonlyArray<readonly [number, number]> = shortWindows();

/**
 * The side card's share of a tall window (`SIDE_CARD_VIEWPORT_FRACTION` in
 * `card-pool.js`), which `card-fit.js` holds the ceiling to above the
 * side-card threshold. Also the inline height given the bottom card, which its
 * CSS `max-height` then caps.
 */
export const SIDE_CARD_VIEWPORT_FRACTION = 0.8;

/**
 * A side card in a window no taller than the side-card threshold is capped by
 * the stylesheet at the window less this, top and bottom together:
 * `max-height: calc(100dvh - 2rem)`. That cap holds for a short portrait
 * window; a phone held sideways is given the band's ceiling inline instead.
 */
export const LANDSCAPE_CARD_VERTICAL_INSET = 2 * REM_PX;

// ── The bottom card (vertical layout) ───────────────────────────────────────

/** `max-height: 40dvh`, as a fraction of the window's height. */
export const BOTTOM_CARD_HEIGHT_FRACTION = 0.4;

/** `max-height: 35dvh` after a video or audio plate, in vertical layout. */
export const BOTTOM_CARD_HEIGHT_FRACTION_MEDIA = 0.35;

/** `bottom: max(1rem, env(safe-area-inset-bottom))`, with no safe area. */
export const BOTTOM_CARD_INSET = REM_PX;

/** `left: 1rem; width: calc(100% - 2rem)`. */
export const BOTTOM_CARD_SIDE_INSET = REM_PX;

/**
 * Where the framework puts the bottom card's top edge when it has no measured
 * rect: `_defaultCardBox` in `iiif-card.js`, from a 40vh card with no inset.
 */
export const FALLBACK_BOTTOM_CARD_TOP_FRACTION = 0.6;

// ── Layer panels (`_sass/_panels.scss`) ─────────────────────────────────────

/** Above the narrow tier: `#panel-layer1 { width: 65%; max-width: 800px }`, layer 2 55% / 750px. */
export const PANEL_WIDE = {
  1: { fraction: 0.65, maxPx: 800 },
  2: { fraction: 0.55, maxPx: 750 },
} as const;

/** `@media (min-width: $telar-vertical-min-width + 1px) and (max-width: 1200px)`, uncapped. */
export const PANEL_NARROW_MIN_WIDTH = 1025;
export const PANEL_NARROW_MAX_WIDTH = 1200;
export const PANEL_NARROW = {
  1: { fraction: 0.8 },
  2: { fraction: 0.75 },
} as const;

/** Vertical layout: right-slide sheets, width in vw, top and height in vh. */
export const PANEL_SHEET = {
  1: { width: 0.98, top: 0.12, height: 0.76 },
  2: { width: 0.96, top: 0.1, height: 0.76 },
} as const;

// ── Layout ──────────────────────────────────────────────────────────────────

/**
 * Whether the window is in the vertical layout's height clause or one of its
 * short-window clauses: `(max-height: 480px)`, or `(max-height: H) and
 * (max-width: W)` for a pair of `VERTICAL_SHORT_WINDOWS`.
 */
function shortWindow(w: number, h: number): boolean {
  return h <= LANDSCAPE_SIDE_CARD_MAX_HEIGHT || VERTICAL_SHORT_WINDOWS.some(([maxH, maxW]) => h <= maxH && w <= maxW);
}

/**
 * The layout mode and card placement for a window of `w` × `h`.
 *
 * Vertical is the framework's `(max-width: 1024px), (max-aspect-ratio: 0.75)`,
 * the height clause and the short-window clauses, every one inclusive. The
 * side card applies at or below the height threshold, as
 * `isPhoneHeightSideCard` answers it, and on every horizontal layout.
 */
export function visitorLayout(w: number, h: number): VisitorLayout {
  const mode: LayoutMode =
    w <= VERTICAL_MAX_WIDTH || w <= h * VERTICAL_MAX_ASPECT || shortWindow(w, h) ? "vertical" : "horizontal";
  const cardPlacement: CardPlacement =
    mode === "horizontal" || h <= LANDSCAPE_SIDE_CARD_MAX_HEIGHT ? "side" : "bottom";
  return { mode, cardPlacement };
}

// ── The card ────────────────────────────────────────────────────────────────

export interface CardOptions {
  /**
   * The step shows a video or audio plate, which caps the card at 35dvh in
   * vertical layout, the bottom card and a sideways phone's side card alike.
   */
  media?: boolean;
  /** The card's content height; a side card takes it, up to its ceiling. */
  contentHeight?: number;
  /**
   * The scene's media arrangement from `mediaCardBelow`, where it puts the card
   * below the player: the card then sits one gutter above the window's bottom
   * edge instead of centred. Null or absent keeps the card beside.
   */
  below?: MediaBelow | null;
  /**
   * The top controls' lowest bottom edge, which a side card on a horizontal
   * layout keeps clear; `STORY_TOP_CONTROLS_BOTTOM` when absent, or
   * `PHONE_TOP_CONTROLS_BOTTOM` for a phone held sideways.
   */
  topControlsBottom?: number;
}

/**
 * `unroundedMediaPadding`: the gutter before rounding, which the fit model's
 * ceiling is measured with so that it never steps down by a rounding as the
 * window grows.
 */
function unroundedMediaPad(w: number, h: number): number {
  return Math.max(VIDEO_PAD_MIN, Math.min(w, h) * VIDEO_PAD_FACTOR);
}

/**
 * Whether the window is a phone held sideways: a vertical layout shorter than
 * the side-card threshold and wider than it is tall (`phoneBand` in
 * `card-pool.js`). A short portrait window is not one, and keeps the
 * stylesheet's cap.
 */
function sidewaysPhone(layout: VisitorLayout, w: number, h: number): boolean {
  return layout.mode === "vertical" && layout.cardPlacement === "side" && w > h;
}

/**
 * `sideCardCeiling` in `card-fit.js`, for a horizontal layout or a phone
 * held sideways: the room between the band under the top controls and one gutter above the window's
 * bottom, less a pixel, held to 80% of a window taller than the side-card
 * threshold but never below the room at the threshold, floored to a whole
 * pixel:
 *
 *   floor( min( h − C − 2·p̃(h) − 1,  max( 0.8·h,  T − C − 2·p̃(T) − 1 ) ) )
 *
 * with C the controls' lowest edge, rounded, and p̃ the unrounded gutter. It
 * never falls as the window grows. A window shorter than C + 2·p̃ + 1 gives a
 * negative length, which the page's inline `max-height` refuses, leaving the
 * stylesheet's short-window cap; for the story page's controls that is only a
 * window under about 71px tall.
 */
function sideCardFitCeiling(w: number, h: number, topControlsBottom: number): number {
  const c = Math.round(topControlsBottom);
  const room = (x: number) => x - c - 2 * unroundedMediaPad(w, x) - 1;
  const ceiling = Math.floor(
    Math.min(room(h), Math.max(SIDE_CARD_VIEWPORT_FRACTION * h, room(LANDSCAPE_SIDE_CARD_MAX_HEIGHT))),
  );
  return ceiling >= 0 ? ceiling : h - LANDSCAPE_CARD_VERTICAL_INSET;
}

/**
 * The tallest a side card may be before its `overflow: hidden` cuts the text.
 *
 * On a horizontal layout it is the fit model's ceiling (`sideCardFitCeiling`),
 * at every height, and a phone held sideways has the same one, which
 * `card-pool.js` writes as the card's inline `max-height` over the
 * stylesheet's cap. A short portrait window, a vertical layout 480px high or
 * less and no wider than it is tall, keeps the stylesheet's short-window cap,
 * the window less 2rem, or after a video or audio plate the 35dvh media rule,
 * whose selector is more specific.
 */
function sideCardCeiling(layout: VisitorLayout, w: number, h: number, opts: Pick<CardOptions, "media" | "topControlsBottom">): number {
  if (layout.mode === "horizontal" || sidewaysPhone(layout, w, h)) {
    return sideCardFitCeiling(w, h, opts.topControlsBottom ?? controlsBottomFor(layout, w, h));
  }
  if (opts.media) return h * BOTTOM_CARD_HEIGHT_FRACTION_MEDIA;
  return h - LANDSCAPE_CARD_VERTICAL_INSET;
}

/** The side card's width: published for the window on a horizontal layout, 37% on a vertical one. */
function sideCardW(layout: VisitorLayout, w: number, h: number): number {
  return layout.mode === "horizontal" ? sideCardWidthPx(w, h) : w * CARD_SIDE_WIDTH;
}

/**
 * The text card's box. A side card's height is its content's up to the
 * ceiling, and the ceiling itself when no content height is given, rounded to
 * a whole pixel as the page measures it (`offsetHeight`); its top is
 * `sideCardTop`'s. The bottom card's height is the CSS cap whatever it holds,
 * since `card-pool.js` sets it taller.
 */
export function cardBox(layout: VisitorLayout, w: number, h: number, opts: CardOptions = {}): Box {
  if (layout.cardPlacement === "bottom") {
    const cardH =
      h * (opts.media ? BOTTOM_CARD_HEIGHT_FRACTION_MEDIA : BOTTOM_CARD_HEIGHT_FRACTION);
    return {
      x: BOTTOM_CARD_SIDE_INSET,
      y: h - BOTTOM_CARD_INSET - cardH,
      w: w - 2 * BOTTOM_CARD_SIDE_INSET,
      h: cardH,
    };
  }
  const ceiling = sideCardCeiling(layout, w, h, opts);
  // The page places a side card from its offsetHeight, which is the height the
  // ceiling leaves, rounded to a whole pixel.
  const cardH = Math.round(Math.min(opts.contentHeight ?? ceiling, ceiling));
  return { x: w * CARD_SIDE_LEFT, y: sideCardTop(layout, w, h, cardH, opts), w: sideCardW(layout, w, h), h: cardH };
}

/**
 * The side card's ceiling as a box at the card's left and width, where a card
 * at the ceiling would stand (`sideCardTop`). Null for the bottom card, whose
 * height is fixed.
 */
export function ceilingBox(
  layout: VisitorLayout,
  w: number,
  h: number,
  opts: Pick<CardOptions, "media" | "below" | "topControlsBottom"> = {},
): Box | null {
  if (layout.cardPlacement === "bottom") return null;
  const ceiling = sideCardCeiling(layout, w, h, opts);
  return { x: w * CARD_SIDE_LEFT, y: sideCardTop(layout, w, h, ceiling, opts), w: sideCardW(layout, w, h), h: ceiling };
}

/**
 * A side card's top, at the first card of its run.
 *
 * On a horizontal layout: `computeBelowCardTop` where the scene's `below`
 * holds, and otherwise `sideCardTop` in `card-fit.js`, centred and held
 * between the band under the top controls (their lowest edge, rounded, and
 * one gutter) and one gutter above the window's bottom, the band winning
 * where the two cross. A phone held sideways is placed by `sideCardTop` in
 * the same band, and the framework reads no arrangement there (`readBelow`),
 * so a `below` handed in for a vertical layout is ignored. A short portrait
 * window centres the card (`computeCardTop`).
 */
function sideCardTop(
  layout: VisitorLayout,
  w: number,
  h: number,
  cardH: number,
  opts: Pick<CardOptions, "below" | "topControlsBottom">,
): number {
  const horizontal = layout.mode === "horizontal";
  if (!horizontal && !sidewaysPhone(layout, w, h)) return (h - cardH) / 2;
  if (horizontal && opts.below) return belowCardTop(w, h, cardH);
  const pad = videoPad(w, h);
  const band = Math.round(opts.topControlsBottom ?? controlsBottomFor(layout, w, h)) + pad;
  return Math.max(band, Math.min((h - cardH) / 2, h - pad - cardH));
}

// ── The region the framework frames into ────────────────────────────────────

/** `computeFocalTarget`'s uncovered region for a card at `box`. */
function regionBeside(layout: VisitorLayout, w: number, h: number, box: Box): Box {
  if (layout.cardPlacement === "side") {
    const right = box.x + box.w;
    return { x: right, y: 0, w: w - right, h };
  }
  return { x: 0, y: 0, w, h: box.y };
}

/**
 * The region the framework frames the image into once the card has been
 * measured: beside a side card, and above the bottom card's live top edge.
 * Only the bottom card's height enters it. A side card placed below a media
 * player keeps its right edge at 55% of the width at most, short of the 60% at which
 * `_deriveCardPlacement` would read it as a bottom card, so `below` leaves the
 * region where it is.
 */
export function regionOf(layout: VisitorLayout, w: number, h: number, opts: CardOptions = {}): Box {
  return regionBeside(layout, w, h, cardBox(layout, w, h, opts));
}

/**
 * The region before any card has been measured, from `_defaultCardBox`: the
 * side card as its CSS places it, at the width `card-fit.js` publishes, and the bottom card's top at 0.6 of the
 * window, which ignores the 1rem inset and the 35dvh media card.
 */
export function fallbackRegion(layout: VisitorLayout, w: number, h: number): Box {
  const box: Box =
    layout.cardPlacement === "side"
      ? { x: w * CARD_SIDE_LEFT, y: 0, w: sideCardW(layout, w, h), h }
      : {
          x: 0,
          y: h * FALLBACK_BOTTOM_CARD_TOP_FRACTION,
          w,
          h: h * (1 - FALLBACK_BOTTOM_CARD_TOP_FRACTION),
        };
  return regionBeside(layout, w, h, box);
}

// ── Layer panels ────────────────────────────────────────────────────────────

/**
 * Which width rule the panels follow. The narrow tier starts one pixel past the
 * vertical-layout width, and in a window of vertical aspect inside its widths
 * the vertical-layout sheets win, since that block comes later in
 * `_panels.scss` with higher specificity; so the narrow tier holds only for a
 * horizontal window from 1025px to 1200px wide.
 */
export function panelTier(w: number, h: number): PanelTier {
  if (visitorLayout(w, h).mode === "vertical") return "sheet";
  if (w >= PANEL_NARROW_MIN_WIDTH && w <= PANEL_NARROW_MAX_WIDTH) return "narrow";
  return "wide";
}

/**
 * The open panel's box. Every tier opens from the right edge; the desktop
 * tiers take the full height (Bootstrap's `.offcanvas-end`, top 0, bottom 0).
 */
export function panelBox(layer: 1 | 2, w: number, h: number): Box {
  const tier = panelTier(w, h);
  if (tier === "sheet") {
    const sheet = PANEL_SHEET[layer];
    const pw = w * sheet.width;
    return { x: w - pw, y: h * sheet.top, w: pw, h: h * sheet.height };
  }
  const pw =
    tier === "narrow"
      ? w * PANEL_NARROW[layer].fraction
      : Math.min(w * PANEL_WIDE[layer].fraction, PANEL_WIDE[layer].maxPx);
  return { x: w - pw, y: 0, w: pw, h };
}

// ── Video and audio steps ───────────────────────────────────────────────────

/** `$telar-video-pad-factor`: the gutter is this share of the window's shorter side. */
export const VIDEO_PAD_FACTOR = 0.025;

/** The gutter's floor, in `mediaPadding`. */
export const VIDEO_PAD_MIN = 8;

/** `$telar-video-stack-max-h`: the stacked player's height ceiling. */
export const VIDEO_STACK_MAX_H = 0.58;

/** The stacked arrangement's card is never shorter than this. */
export const VIDEO_STACK_CARD_MIN_H = 60;

/** `$telar-audio-height-resize` and `$telar-audio-height-mobile`: the waveform's height. */
export const AUDIO_WAVEFORM_HEIGHT = { horizontal: 0.5, vertical: 0.35 } as const;

/**
 * `.waveform-container`'s centre line, and on a vertical layout its left and
 * width, as fractions of the window. Beside the side card it runs from
 * `AUDIO_WAVE_SIDE_GAP` past the card's right edge to the window's
 * (`$telar-audio-wave-side-left`, `$telar-audio-wave-side-width`).
 */
export const AUDIO_WAVEFORM_BOX = {
  horizontal: { centre: 0.5 },
  vertical: { left: 0.05, width: 0.9, centre: 0.27 },
} as const;

/** `$telar-audio-wave-side-gap`: the waveform's gap past the side card, as a fraction of the window's width. */
export const AUDIO_WAVE_SIDE_GAP = 0.01;

/** The waveform beside the side card: its left edge and width, as the stylesheet's `calc()` gives them. */
function audioWaveBeside(w: number, h: number): { x: number; w: number } {
  const x = w * CARD_SIDE_LEFT + sideCardWidthPx(w, h) + w * AUDIO_WAVE_SIDE_GAP;
  return { x, w: w - x };
}

/**
 * `$telar-media-below-gain`: a media scene puts its card below the player when
 * the player's area there is at least this fraction larger than beside it.
 */
export const MEDIA_BELOW_GAIN = 0.15;

/** `COMPARISON_ASPECT`: the aspect a video is compared at while its own is unknown. */
export const VIDEO_COMPARISON_ASPECT = 16 / 9;

/**
 * The lowest bottom edge of Back to Start, Share and the step counter on a
 * horizontal story page, in CSS pixels. It is a rendered size, not a declared
 * one: `measureTopBand` and `fitSideCards` read the three controls' boxes, and
 * the framework measured 54px on the story page (1.8.0 changelog). No
 * stylesheet value states it, so the parity test cannot read it back. The
 * embed banner, which the side card also clears on an embedded page, has no
 * counterpart in the editor.
 */
export const STORY_TOP_CONTROLS_BOTTOM = 54;

/**
 * The same edge on a phone held sideways, where the controls stand lower: 60px
 * at 844×390 and 932×430, in Chromium and WebKit alike, as the framework
 * measured it live (`measureControlsBottom` over `SIDE_CARD_CONTROLS`, with the
 * card at rest). The embed banner, which would make it 94px in English, has no
 * counterpart in the editor.
 */
export const PHONE_TOP_CONTROLS_BOTTOM = 60;

/** The controls' lowest edge the side card clears in a window of this layout, unless the caller measured it. */
function controlsBottomFor(layout: VisitorLayout, w: number, h: number): number {
  return sidewaysPhone(layout, w, h) ? PHONE_TOP_CONTROLS_BOTTOM : STORY_TOP_CONTROLS_BOTTOM;
}

/** `.audio-btn`'s height, and the gap above the controls row, in `audio-layout.js`. */
export const AUDIO_CONTROLS_HEIGHT = 44;
export const AUDIO_CONTROLS_GAP = 4;

export type MediaKind = "video" | "audio";

/**
 * What `mediaCardBelow` needs to know about a video or audio scene.
 */
export interface MediaScene {
  kind: MediaKind;
  /**
   * A video's width over height. Null or absent where it is not known, which is
   * every Google Drive video, a YouTube video with no full-size thumbnail, and
   * any video before its player reports: the framework compares those at 16:9.
   * Ignored for audio.
   */
  aspect?: number | null;
  /**
   * The content height of the scene's tallest card, in visitor pixels, as
   * `cardBox` takes it (`contentHeight`); the ceiling is applied here as the
   * page's `max-height` applies it to the height the framework measures. A
   * scene is arranged by its tallest card, so every step of it passes the same
   * value. The page decides from the card's `offsetHeight`, the capped height
   * rounded to a whole pixel, and so does this.
   */
  tallestContentHeight: number;
  /** The top controls' lowest bottom edge; `STORY_TOP_CONTROLS_BOTTOM` when absent. */
  topControlsBottom?: number;
}

/**
 * A media scene with its card below the player: the tallest card's top and the
 * band kept clear for the top controls, in visitor pixels from the window's
 * top. These are the two figures `media-arrangement.js` writes on the plate
 * (`data-media-card-top`, `data-media-top-band`) and the player is placed from.
 */
export interface MediaBelow {
  cardTop: number;
  topBand: number;
}

export type VideoArrangement = "side-by-side" | "below" | "stacked";

/**
 * One arrangement of a video step, as `computeVideoLayout` returns it.
 *
 * `card` is the function's own card slot, which the published page does not
 * apply: `_applyVideoLayout` places only the player, and the text card keeps
 * the geometry `cardBox(layout, w, h, { media: true, below })` gives it. The
 * side-by-side and below slots share that card's left edge and width, rounded,
 * but not its height or top.
 */
export interface VideoLayout {
  arrangement: VideoArrangement;
  player: Box;
  card: Box;
  /** The card slot's inner padding. */
  padding: number;
}

/** `mediaPadding`: the gutter for a window of `w` × `h`. */
function videoPad(w: number, h: number): number {
  return Math.max(VIDEO_PAD_MIN, Math.round(Math.min(w, h) * VIDEO_PAD_FACTOR));
}

/** `computeBelowCardTop`: one gutter above the window's bottom edge, rounded. */
function belowCardTop(w: number, h: number, cardH: number): number {
  return Math.round(h - videoPad(w, h) - cardH);
}

/** The card slot's inner padding for a card `cardW` wide beside or below the player. */
function sideSlotPadding(cardW: number): number {
  return cardW > 300 ? 24 : cardW > 200 ? 16 : 10;
}

/** The largest player of `aspect` inside `maxW` × `maxH`. */
function fitPlayer(maxW: number, maxH: number, aspect: number): { w: number; h: number } {
  const byWidth = maxW / aspect;
  return byWidth > maxH ? { w: maxH * aspect, h: maxH } : { w: maxW, h: byWidth };
}

/**
 * Where the player's space starts beside the side card: one gutter past the
 * card's right edge, rounded to a pixel as `_sideCardRight` rounds it.
 */
function playerLeft(w: number, h: number, pad: number): number {
  return Math.round(w * CARD_SIDE_LEFT + sideCardWidthPx(w, h)) + pad;
}

/**
 * `_besideRegion`: the space beside the side card, from one gutter past its
 * right edge to one gutter inside the window's, and from the top band (a
 * gutter at least) to one gutter above the window's bottom edge.
 */
function besideRegion(w: number, h: number, pad: number, topBand: number): Box {
  const x = playerLeft(w, h, pad);
  const y = Math.max(pad, Math.round(topBand) || 0);
  return { x, y, w: w - x - pad, h: Math.max(0, Math.round(h - pad - y)) };
}

/**
 * `_buildSideBySideResult`: the card at the left, the player centred on the
 * window's height unless that would put its top above the top band.
 */
function sideBySide(w: number, h: number, aspect: number, topBand: number): VideoLayout {
  const pad = videoPad(w, h);
  const region = besideRegion(w, h, pad, topBand);
  const fit = fitPlayer(region.w, region.h, aspect);
  const pw = Math.round(fit.w);
  const ph = Math.round(fit.h);
  const cardW = sideCardWidthPx(w, h);
  return {
    arrangement: "side-by-side",
    player: { x: region.x, y: Math.max(region.y, Math.round((h - ph) / 2)), w: pw, h: ph },
    card: { x: Math.round(w * CARD_SIDE_LEFT), y: pad, w: cardW, h: Math.round(h - pad * 2) },
    padding: sideSlotPadding(cardW),
  };
}

/** `_belowRegion`: the whole width less a gutter each side, from the top band to a gutter above the card. */
function belowRegion(w: number, pad: number, below: MediaBelow): Box {
  return {
    x: pad,
    y: below.topBand,
    w: w - pad * 2,
    h: Math.max(0, below.cardTop - pad - below.topBand),
  };
}

/** `_computeBelowLayout`: the player centred in the space above the card. */
function belowPlayer(w: number, h: number, aspect: number, below: MediaBelow): VideoLayout {
  const pad = videoPad(w, h);
  const region = belowRegion(w, pad, below);
  const fit = fitPlayer(region.w, region.h, aspect);
  const pw = Math.round(fit.w);
  const ph = Math.round(fit.h);
  const cardW = sideCardWidthPx(w, h);
  return {
    arrangement: "below",
    player: {
      x: Math.round(region.x + (region.w - pw) / 2),
      y: Math.round(region.y + (region.h - ph) / 2),
      w: pw,
      h: ph,
    },
    card: {
      x: Math.round(w * CARD_SIDE_LEFT),
      y: below.cardTop,
      w: cardW,
      h: Math.max(0, h - pad - below.cardTop),
    },
    padding: sideSlotPadding(cardW),
  };
}

/** `_buildStackedResult`: the player centred at the top, the card below it. */
function stacked(w: number, h: number, aspect: number): VideoLayout {
  const pad = videoPad(w, h);
  const fit = fitPlayer(w - pad * 2, h * VIDEO_STACK_MAX_H, aspect);
  const pw = Math.round(fit.w);
  const ph = Math.round(fit.h);
  const cardTop = pad + ph + pad;
  const cardH = Math.max(VIDEO_STACK_CARD_MIN_H, h - cardTop - pad);
  return {
    arrangement: "stacked",
    player: { x: Math.round((w - pw) / 2), y: pad, w: pw, h: ph },
    card: { x: pad, y: cardTop, w: Math.round(w - pad * 2), h: cardH },
    padding: cardH > 200 ? 22 : cardH > 120 ? 14 : 8,
  };
}

/** `prefersBelow`: below wins by at least the gain, written as the framework writes it. */
function prefersBelow(besideArea: number, belowArea: number): boolean {
  return belowArea >= besideArea * (1 + MEDIA_BELOW_GAIN);
}

/**
 * Whether a video or audio scene's cards go below its player, and if so the
 * figures the player and the cards are placed from; null where they stay
 * beside it or the scene is not arranged.
 *
 * This is `arrangeMediaScene` with `chooseVideoArrangement` or
 * `chooseAudioArrangement`. Only a horizontal layout is arranged, where the
 * cards are always sized to their content. Embed mode keeps the card beside and has no counterpart
 * in the editor. Below is chosen when the player's area there is at least
 * `MEDIA_BELOW_GAIN` larger than beside the card, with a video compared at its
 * own aspect, or 16:9 while that is unknown, and the audio waveform beside the
 * card at the stylesheet's size.
 *
 * Callers pass the result as `below` to `cardBox`, `ceilingBox`, `regionOf`,
 * `videoLayout`, `videoLetterboxRegion` and `audioWaveformBox` for every step of
 * the scene.
 */
export function mediaCardBelow(layout: VisitorLayout, w: number, h: number, scene: MediaScene): MediaBelow | null {
  if (layout.mode !== "horizontal") return null;
  const pad = videoPad(w, h);
  const cardH = cardBox(layout, w, h, {
    media: true,
    contentHeight: scene.tallestContentHeight,
    topControlsBottom: scene.topControlsBottom,
  }).h;
  const below: MediaBelow = {
    cardTop: belowCardTop(w, h, cardH),
    topBand: mediaTopBand(w, h, scene.topControlsBottom, pad),
  };
  let besideArea: number;
  let belowArea: number;
  if (scene.kind === "audio") {
    // `computeAudioBesideWave`: from the card's rounded right edge, less the gap.
    const besideW = Math.round(w - Math.round(w * CARD_SIDE_LEFT + sideCardWidthPx(w, h)) - w * AUDIO_WAVE_SIDE_GAP);
    besideArea = besideW * Math.round(h * AUDIO_WAVEFORM_HEIGHT.horizontal);
    const wave = audioBelowLayout(w, h, below).wave;
    belowArea = wave.w * wave.h;
  } else {
    const aspect = scene.aspect || VIDEO_COMPARISON_ASPECT;
    const side = sideBySide(w, h, aspect, below.topBand).player;
    const under = belowPlayer(w, h, aspect, below).player;
    besideArea = side.w * side.h;
    belowArea = under.w * under.h;
  }
  return prefersBelow(besideArea, belowArea) ? below : null;
}

/**
 * `measureTopBand`: the band a media plate's player keeps clear for the top
 * controls, in visitor pixels from the window's top: the controls' lowest
 * bottom edge (`STORY_TOP_CONTROLS_BOTTOM` when not given), rounded, and one
 * gutter. The page writes it on every media plate of a horizontal layout,
 * whether its card is beside the player or below it (`readTopBand`, which is 0
 * on a vertical layout).
 */
export function mediaTopBand(w: number, h: number, topControlsBottom?: number, pad = videoPad(w, h)): number {
  return Math.round(topControlsBottom ?? STORY_TOP_CONTROLS_BOTTOM) + pad;
}

/**
 * The arrangement the page uses for a player of `aspect` (width / height). It
 * follows the text card: vertical layout is always stacked above the bottom
 * card, a sideways phone included; a horizontal layout is side by side, or the
 * player above the card where the scene's `below` holds. A stacked player on a
 * horizontal layout would be drawn over the side card. `topBand` is the band
 * the player beside the card keeps clear (`mediaTopBand`); 0 leaves it one
 * gutter from the top, as a page with no band measured does.
 */
export function videoLayout(
  mode: LayoutMode,
  w: number,
  h: number,
  aspect: number,
  below: MediaBelow | null = null,
  topBand = 0,
): VideoLayout {
  if (mode === "vertical") return stacked(w, h, aspect);
  return below ? belowPlayer(w, h, aspect, below) : sideBySide(w, h, aspect, topBand);
}

/**
 * The player's box where its aspect is unknown (every Google Drive video, and a
 * YouTube video with no full-size thumbnail): the whole space the arrangement
 * gives it, for the provider's player to letterbox inside.
 */
export function videoLetterboxRegion(
  mode: LayoutMode,
  w: number,
  h: number,
  below: MediaBelow | null = null,
  topBand = 0,
): Box {
  const pad = videoPad(w, h);
  if (mode === "vertical") {
    return { x: pad, y: pad, w: Math.round(w - pad * 2), h: Math.round(h * VIDEO_STACK_MAX_H) };
  }
  if (below) return belowRegion(w, pad, below);
  return besideRegion(w, h, pad, topBand);
}

/**
 * `computeAudioBelowLayout`: with the card below, the waveform spans the width
 * less a gutter each side, as tall as beside the card where the space above the
 * card allows and shorter where it does not, with the controls row under it,
 * the two centred between the top band and a gutter above the card.
 * `controlsBottom` is the controls row's bottom edge measured up from the
 * window's bottom, which is how the stylesheet anchors the row.
 */
export function audioBelowLayout(w: number, h: number, below: MediaBelow): { wave: Box; controlsBottom: number } {
  const pad = videoPad(w, h);
  const row = AUDIO_CONTROLS_GAP + AUDIO_CONTROLS_HEIGHT;
  const space = Math.max(0, below.cardTop - pad - below.topBand);
  const height = Math.max(0, Math.min(Math.round(h * AUDIO_WAVEFORM_HEIGHT.horizontal), space - row));
  const top = Math.round(below.topBand + (space - height - row) / 2);
  return {
    wave: { x: pad, y: top, w: w - pad * 2, h: height },
    controlsBottom: Math.round(h - (top + height + row)),
  };
}

/** `.audio-controls`'s gap between its 44px buttons (`.audio-btn`). */
export const AUDIO_CONTROLS_BUTTON_GAP = 12;

/** The icons `buildAudioControlsHTML` draws: play and pause, and restart and mute (audio-card.js). */
export const AUDIO_PLAY_ICON = 22;
export const AUDIO_CONTROL_ICON = 20;

/**
 * `.audio-elapsed`, the playing time: 16px from the window's right edge, 0.8rem
 * type in 0.4rem × 0.85rem of padding, on a pill of 20px radius.
 */
export const AUDIO_ELAPSED = { right: 16, fontSize: 12.8, paddingY: 6.4, paddingX: 13.6, radius: 20 } as const;

/**
 * With the card below, where the playing time is anchored: its right edge
 * `AUDIO_ELAPSED.right` from the window's right, its bottom at the controls
 * row's (`--telar-audio-controls-bottom`), both measured from the window's
 * edges.
 */
export function audioElapsedBelowAnchor(w: number, h: number, below: MediaBelow): { right: number; bottom: number } {
  return { right: AUDIO_ELAPSED.right, bottom: audioBelowLayout(w, h, below).controlsBottom };
}

/**
 * With the card below, the controls row under the waveform: as wide as the
 * waveform, `AUDIO_CONTROLS_HEIGHT` tall, its bottom `controlsBottom` above the
 * window's bottom edge. The stylesheet centres the row's buttons on the
 * window's width (`left: 50%; translateX(-50%)`), which is this box's centre.
 */
export function audioControlsBelowBox(w: number, h: number, below: MediaBelow): Box {
  const { wave, controlsBottom } = audioBelowLayout(w, h, below);
  return { x: wave.x, y: h - controlsBottom - AUDIO_CONTROLS_HEIGHT, w: wave.w, h: AUDIO_CONTROLS_HEIGHT };
}

/**
 * The audio waveform's box. An audio step has no player to place: the plate
 * fills the window and the waveform is drawn across it, beside the side card,
 * above it where the scene's `below` holds on a horizontal layout, or above the
 * bottom card, which is the 35dvh media card in vertical layout. Beside a card
 * the height is the waveform's own (WaveSurfer's `height` option), centred on
 * the container's centre line.
 */
export function audioWaveformBox(mode: LayoutMode, w: number, h: number, below: MediaBelow | null = null): Box {
  if (below && mode === "horizontal") return audioBelowLayout(w, h, below).wave;
  const wh = Math.round(h * AUDIO_WAVEFORM_HEIGHT[mode]);
  const across = mode === "horizontal" ? audioWaveBeside(w, h) : { x: w * AUDIO_WAVEFORM_BOX.vertical.left, w: w * AUDIO_WAVEFORM_BOX.vertical.width };
  return { x: across.x, y: h * AUDIO_WAVEFORM_BOX[mode].centre - wh / 2, w: across.w, h: wh };
}

// ── The stage ───────────────────────────────────────────────────────────────

export interface StageRect extends Box {
  /** Stage pixels per visitor pixel. */
  scale: number;
}

/**
 * The largest rectangle of the window's aspect that fits the content area,
 * centred in it, with the scale that maps the visitor's window onto it. Null
 * where either has no area.
 */
export function stageRect(
  content: { w: number; h: number },
  window: { w: number; h: number },
): StageRect | null {
  if (!(content.w > 0 && content.h > 0 && window.w > 0 && window.h > 0)) return null;
  const aspect = window.w / window.h;
  const fitsByHeight = content.w / content.h > aspect;
  const w = fitsByHeight ? content.h * aspect : content.w;
  const h = fitsByHeight ? content.h : content.w / aspect;
  return { x: (content.w - w) / 2, y: (content.h - h) / 2, w, h, scale: w / window.w };
}
