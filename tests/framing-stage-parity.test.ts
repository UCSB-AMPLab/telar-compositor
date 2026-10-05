/**
 * `app/lib/framing-stage.ts` and the stage colours in `theme-tokens.ts`,
 * against the framework that publishes the page they describe.
 *
 * Two kinds of check, because they fail on different drifts.
 *
 * The DECLARATION checks read each value from framework source: the SCSS rule
 * that sets it, found by its selector and the at-rules around it, and the
 * JavaScript constant by its name. A renamed selector or constant fails here
 * rather than passing on a stale copy, and so does a changed value.
 *
 * The DRIVEN checks import the framework's own modules into a jsdom document
 * with the window sized for each case and a `matchMedia` that evaluates the
 * framework's query strings against that size, then compare what they compute
 * with what the Compositor computes: the layout mode (`getLayoutMode`), the
 * side-card rule (`isPhoneHeightSideCard`; engines before the framework `7d6dadb6` name it `isLandscapeSideCard`), the placement (`_deriveCardPlacement`),
 * the region `computeFocalTarget` frames into, once with no card rect and once
 * with the live rect from `cardBox`, a sideways phone's card centring
 * (`computeCardTop`), the video arrangement (`computeVideoLayout`,
 * `computeVideoLetterboxRegion`), and a media scene's choice between its card
 * beside the player and below it (`arrangeMediaScene`, with the card beside
 * the player placed by `fitSideCards` and the player from what the
 * arrangement writes on the plate). The side card's own ceiling and top on a
 * horizontal layout are driven in `side-card-fit-parity.test.ts`. The custom properties those modules read are
 * set on `:root` from the values parsed out of `_responsive.scss`, so they
 * run on the stylesheet's numbers rather than their own fallbacks.
 *
 * The theme colours are read from `_data/themes/*.yml` with js-yaml.
 *
 * A driven case that pins a constant is only a pin if a changed constant
 * moves it, so the cases that hold the video gutter floor, the stacked card's
 * floor, the waveform's rounding, the arrangement's gain and its top band are
 * also run against a copy of the framework module, or a `:root`, with that
 * constant changed, and must then disagree.
 *
 * Every block here fails, rather than skips, without the framework checkout
 * when `TELAR_PARITY_REQUIRED=1` is set.
 *
 * @version v1.5.0-beta
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import { describe, it, expect } from "vitest";

import {
  AUDIO_WAVEFORM_BOX,
  AUDIO_WAVEFORM_HEIGHT,
  AUDIO_WAVE_SIDE_GAP,
  BOTTOM_CARD_HEIGHT_FRACTION,
  BOTTOM_CARD_HEIGHT_FRACTION_MEDIA,
  BOTTOM_CARD_INSET,
  BOTTOM_CARD_SIDE_INSET,
  CARD_SIDE_LEFT,
  CARD_SIDE_WIDTH,
  FALLBACK_BOTTOM_CARD_TOP_FRACTION,
  LANDSCAPE_CARD_VERTICAL_INSET,
  LANDSCAPE_SIDE_CARD_MAX_HEIGHT,
  PANEL_NARROW,
  PANEL_NARROW_MAX_WIDTH,
  PANEL_NARROW_MIN_WIDTH,
  PANEL_SHEET,
  PANEL_WIDE,
  SIDE_CARD_VIEWPORT_FRACTION,
  SIDE_CARD_WIDTH_TERMS,
  VERTICAL_BAND_STEP,
  VERTICAL_MAX_ASPECT,
  VERTICAL_MAX_WIDTH,
  VERTICAL_SHORT_WINDOWS,
  VIDEO_PAD_FACTOR,
  VIDEO_PAD_MIN,
  VIDEO_STACK_CARD_MIN_H,
  VIDEO_STACK_MAX_H,
  AUDIO_CONTROLS_GAP,
  AUDIO_CONTROLS_BUTTON_GAP,
  AUDIO_CONTROLS_HEIGHT,
  AUDIO_CONTROL_ICON,
  AUDIO_ELAPSED,
  AUDIO_PLAY_ICON,
  MEDIA_BELOW_GAIN,
  STORY_TOP_CONTROLS_BOTTOM,
  VIDEO_COMPARISON_ASPECT,
  audioBelowLayout,
  audioWaveformBox,
  cardBox,
  ceilingBox,
  fallbackRegion,
  mediaCardBelow,
  mediaTopBand,
  regionOf,
  sideCardWidthPx,
  videoLayout,
  videoLetterboxRegion,
  visitorLayout,
  type Box,
  type MediaBelow,
} from "~/lib/framing-stage";
import { STAGE_THEME_COLOURS } from "~/lib/theme-tokens";
import {
  describeWithRequiredFramework as describeWithFramework,
  frameworkBlockMode,
  FRAMEWORK_SCRIPTS_DIR,
  FRAMEWORK_TIMEOUT_MS,
  PARITY_REQUIRED_ENV,
} from "./helpers/framework-checkout";
import { jsdomPrelude } from "./helpers/framework-jsdom";

const FRAMEWORK_DIR = join(FRAMEWORK_SCRIPTS_DIR, "..");
const SASS_DIR = join(FRAMEWORK_DIR, "_sass");
const STORY_DIR = join(FRAMEWORK_DIR, "assets", "js", "telar-story");
const THEMES_DIR = join(FRAMEWORK_DIR, "_data", "themes");

// ── A reader for the framework's SCSS ───────────────────────────────────────

/** One rule or at-rule: its prelude, its own declarations, and what it nests. */
interface ScssRule {
  prelude: string;
  decls: Map<string, string>;
  children: ScssRule[];
}

/**
 * The stylesheet as a tree. Comments go first; `#{…}` interpolation is kept
 * whole so its braces do not open a block. A declaration is `name: value;`
 * directly inside a block, and a later one of the same name replaces an
 * earlier one, as it does in the cascade.
 */
function parseScss(source: string): ScssRule {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const root: ScssRule = { prelude: "", decls: new Map(), children: [] };
  const stack = [root];
  let buf = "";
  const flush = () => {
    const colon = buf.indexOf(":");
    if (colon > 0) {
      const top = stack[stack.length - 1];
      top.decls.set(buf.slice(0, colon).trim(), buf.slice(colon + 1).trim());
    }
    buf = "";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "#" && text[i + 1] === "{") {
      const end = text.indexOf("}", i);
      buf += text.slice(i, end + 1);
      i = end;
    } else if (ch === "{") {
      const rule: ScssRule = { prelude: buf.trim().replace(/\s+/g, " "), decls: new Map(), children: [] };
      stack[stack.length - 1].children.push(rule);
      stack.push(rule);
      buf = "";
    } else if (ch === "}") {
      flush();
      stack.pop();
    } else if (ch === ";") {
      flush();
    } else {
      buf += ch;
    }
  }
  return root;
}

type Step = string | ((prelude: string) => boolean);

/** Every rule reached by following `path` of preludes down from `from`. */
function rulesAt(from: ScssRule, path: Step[]): ScssRule[] {
  let level = [from];
  for (const step of path) {
    const match = typeof step === "string" ? (p: string) => p === step : step;
    level = level.flatMap((r) => r.children.filter((c) => match(c.prelude)));
  }
  return level;
}

/** The value `path` declares for `prop`, the last in source order; throws where none does. */
function declared(sheet: ScssRule, path: Step[], prop: string): string {
  const values = rulesAt(sheet, path)
    .map((r) => r.decls.get(prop))
    .filter((v): v is string => v !== undefined);
  if (values.length === 0) {
    throw new Error(`no ${prop} under ${path.map(String).join(" > ")}`);
  }
  return values[values.length - 1];
}

/** `37%` → 0.37. */
function percent(value: string): number {
  const m = /^(-?\d+(?:\.\d+)?)%$/.exec(value);
  if (!m) throw new Error(`not a percentage: ${value}`);
  return Number(m[1]) / 100;
}

/** `40vh`, `40dvh` or `98vw` → 0.4, 0.4, 0.98. */
function viewportUnits(value: string, unit: "vh" | "dvh" | "vw"): number {
  const m = new RegExp(`^(\\d+(?:\\.\\d+)?)${unit}$`).exec(value);
  if (!m) throw new Error(`not in ${unit}: ${value}`);
  return Number(m[1]) / 100;
}

/** `800px` → 800. */
function pixels(value: string): number {
  const m = /^(\d+(?:\.\d+)?)px$/.exec(value);
  if (!m) throw new Error(`not in px: ${value}`);
  return Number(m[1]);
}

/** `1rem` or `2rem` in CSS pixels. */
function rems(value: string): number {
  const m = /^(\d+(?:\.\d+)?)rem$/.exec(value);
  if (!m) throw new Error(`not in rem: ${value}`);
  return Number(m[1]) * 16;
}

const LAYER = "@layer telar-components";
const VERTICAL = "@include vertical-layout";

const story = () => parseScss(readFileSync(join(SASS_DIR, "_story.scss"), "utf-8"));
const panels = () => parseScss(readFileSync(join(SASS_DIR, "_panels.scss"), "utf-8"));
const responsive = () => parseScss(readFileSync(join(SASS_DIR, "_responsive.scss"), "utf-8"));

/** A `$telar-*` variable from `_responsive.scss`. */
function sassVar(name: string): string {
  const value = responsive().decls.get(name);
  if (value === undefined) throw new Error(`_responsive.scss declares no ${name}`);
  return value;
}

/** A declared value, through the `$telar-*` variable it names where it names one. */
function resolved(value: string): string {
  return value.startsWith("$telar-") ? sassVar(value) : value;
}

/** A top-level `const NAME = <number>;` in a framework module. */
function jsConstant(file: string, name: string): number {
  const source = readFileSync(join(STORY_DIR, file), "utf-8");
  const m = new RegExp(`^const ${name} = (\\d+(?:\\.\\d+)?);`, "m").exec(source);
  if (!m) throw new Error(`${file} declares no ${name}`);
  return Number(m[1]);
}

const SHORT_WINDOW = "@media (max-height: $telar-card-landscape-max-height)";

/**
 * `--telar-vertical-short-windows` as dart-sass 1.100.0 compiles
 * `_responsive.scss` at the width terms the checkout declares, which the
 * declaration checks hold to the Compositor's. The driven checks hand it to
 * `layout-mode.js`, so the framework's bands are the compiled ones, not the
 * Compositor's.
 */
const COMPILED_SHORT_WINDOWS =
  "488px 1380px, 496px 1380px, 504px 1380px, 512px 1380px, 520px 1380px, 528px 1366px, 536px 1341px, 544px 1316px, 552px 1292px, 560px 1267px, 568px 1243px, 576px 1218px, 584px 1193px, 592px 1169px, 600px 1144px, 608px 1119px, 616px 1095px, 624px 1070px, 632px 1046px";

/** Short windows as the stylesheet's property writes them. */
function shortWindowsProperty(pairs: ReadonlyArray<readonly [number, number]>): string {
  return pairs.map(([h, w]) => `${h}px ${w}px`).join(", ");
}

describeWithFramework("the side card against _story.scss and card-pool.js", () => {
  it("is 3% from the left and as wide as card-fit.js publishes, 37% where it publishes nothing", () => {
    const sheet = story();
    expect(declared(sheet, [LAYER, ".text-card"], "left")).toBe("$telar-card-side-left");
    expect(declared(sheet, [LAYER, ".text-card"], "width")).toBe("var(--telar-card-side-width)");
    expect(percent(sassVar("$telar-card-side-left"))).toBe(CARD_SIDE_LEFT);
    expect(percent(sassVar("$telar-card-side-width"))).toBe(CARD_SIDE_WIDTH);
    const root = rulesAt(responsive(), [":root"]);
    expect(root).toHaveLength(1);
    expect(root[0].decls.get("--telar-card-side-left")).toBe("#{$telar-card-side-left}");
    expect(root[0].decls.get("--telar-card-side-width")).toBe("#{$telar-card-side-width}");
    const pool = readFileSync(join(STORY_DIR, "card-pool.js"), "utf-8");
    expect(pool).toContain("const horizontal = getLayoutMode() !== 'vertical';");
    expect(pool).toContain("publishSideCardWidth(viewportW, viewportH, horizontal);");
  });

  it("takes its width terms from _responsive.scss, and card-fit.js computes the width from them", () => {
    const root = rulesAt(responsive(), [":root"])[0];
    const terms: Array<[keyof typeof SIDE_CARD_WIDTH_TERMS, string, string]> = [
      ["minShare", "$telar-card-side-min-share", "min-share"],
      ["maxShare", "$telar-card-side-max-share", "max-share"],
      ["base", "$telar-card-side-base", "base"],
      ["slope", "$telar-card-side-slope", "slope"],
      ["maxByHeight", "$telar-card-side-max-by-height", "max-by-height"],
    ];
    const fit = readFileSync(join(STORY_DIR, "card-fit.js"), "utf-8");
    for (const [key, name, prop] of terms) {
      expect(Number(sassVar(name)), name).toBe(SIDE_CARD_WIDTH_TERMS[key]);
      expect(root.decls.get(`--telar-card-side-${prop}`), prop).toBe(`#{${name}}`);
      expect(fit).toContain(`${key}: term('${prop}', ${SIDE_CARD_WIDTH_TERMS[key]}),`);
    }
    expect(fit).toContain("const byHeight = Math.min(maxByHeight, base - slope * H);");
    expect(fit).toContain("return Math.round(Math.min(maxShare * W, Math.max(minShare * W, byHeight)));");
    expect(fit).toContain("if (horizontal) root.setProperty('--telar-card-side-width', `${sideCardWidth(W, H)}px`);");
    expect(fit).toContain("else root.removeProperty('--telar-card-side-width');");
  });

  it("hands 80% of the height to the side card's ceiling on every horizontal layout, which clears the top controls", () => {
    expect(jsConstant("card-pool.js", "SIDE_CARD_VIEWPORT_FRACTION")).toBe(SIDE_CARD_VIEWPORT_FRACTION);
    const source = readFileSync(join(STORY_DIR, "card-pool.js"), "utf-8");
    expect(source).toMatch(
      /const side = horizontal \? fitSideCards\(changed \|\| cards, \{ W: viewportW, H: viewportH,\s*peek: peekHeight, fraction: SIDE_CARD_VIEWPORT_FRACTION, activeIndex: state\.currentIndex \}\)/,
    );
    const fit = readFileSync(join(STORY_DIR, "card-fit.js"), "utf-8");
    expect(fit).toContain("export const SIDE_CARD_CONTROLS = [...TOP_CONTROLS, '.telar-embed-banner'];");
    expect(fit).toContain("const C = Math.round(measureControlsBottom(SIDE_CARD_CONTROLS));");
    expect(fit).toContain("const ceiling = sideCardCeiling({ H, W, C, T: getCardLandscapeMaxHeight(), fraction });");
  });

  it("places a phone held sideways in the band only while it is wider than it is tall, under the side card's ceiling", () => {
    const source = readFileSync(join(STORY_DIR, "card-pool.js"), "utf-8");
    expect(source).toMatch(/const phoneBand = _phoneBandFor\((phoneHeightSideCard|landscapeSideCard), viewportW, viewportH\);/);
    expect(source).toMatch(
      /return eligible && getLayoutMode\(\) === 'vertical' && viewportW > viewportH\s*\? sideCardBand\(\{ W: viewportW, H: viewportH, fraction: SIDE_CARD_VIEWPORT_FRACTION \}\)/,
    );
    expect(source).toMatch(/_sizeCardToContent\(card, viewportH, (scenePos|runPos), peekHeight, phoneBand\);/);
  });

  it("keeps the side-card geometry at 480px high or less at any width, capped by the stylesheet at the height less 2rem until the page writes its inline ceiling", () => {
    const sheet = story();
    // Outside the vertical-layout block, after it, so it overrides the bottom
    // card's rules; a window this short is a vertical layout.
    expect(rulesAt(sheet, [LAYER, VERTICAL, SHORT_WINDOW])).toHaveLength(0);
    const short = [LAYER, SHORT_WINDOW, ".text-card"];
    expect(declared(sheet, short, "left")).toBe("$telar-card-side-left");
    expect(declared(sheet, short, "width")).toBe("$telar-card-side-width");
    expect(declared(sheet, [...short, "@supports (height: 100dvh)"], "max-height")).toBe("calc(100dvh - 2rem)");
    expect(rems("2rem")).toBe(LANDSCAPE_CARD_VERTICAL_INSET);
    expect(pixels(sassVar("$telar-card-landscape-max-height"))).toBe(LANDSCAPE_SIDE_CARD_MAX_HEIGHT);
    // A short portrait window keeps that cap; a phone held sideways is given
    // the band's ceiling inline (card-pool.js), 390 − 60 − 2 × 9.75 − 1 = 309.
    expect(ceilingBox(visitorLayout(320, 480), 320, 480)?.h).toBe(480 - LANDSCAPE_CARD_VERTICAL_INSET);
    expect(ceilingBox(visitorLayout(844, 390), 844, 390)?.h).toBe(309);
    // A wide window of the same height is in the vertical layout's height
    // clause, a phone's band: 480 − 60 − 2 × 12 − 1 = 395, at 37% of its width.
    const layout = visitorLayout(1400, 480);
    expect(layout).toEqual({ mode: "vertical", cardPlacement: "side" });
    expect(ceilingBox(layout, 1400, 480)).toMatchObject({ w: 518, h: 395 });
  });

  it("gives a short portrait window's card the 35dvh media cap after a video or audio plate, and a wider short window the band's ceiling", () => {
    // The media rule sits in a vertical-layout block and the short-window rule
    // after that block, so the media rule wins on specificity alone.
    const sheet = story();
    const mediaRule = (p: string) => p.includes('[data-card-type="audio"] + .text-card');
    const layerChildren = rulesAt(sheet, [LAYER]).flatMap((r) => r.children);
    const shortAt = layerChildren.findIndex((c) => c.prelude === SHORT_WINDOW);
    const mediaBlockAt = layerChildren.findIndex(
      (c) => c.prelude === VERTICAL && c.children.some((g) => mediaRule(g.prelude)),
    );
    expect(mediaBlockAt).toBeGreaterThanOrEqual(0);
    expect(shortAt).toBeGreaterThan(mediaBlockAt);
    const media = rulesAt(sheet, [LAYER, VERTICAL, mediaRule]);
    expect(media).toHaveLength(1);
    expect(rulesAt(sheet, [LAYER, mediaRule])).toHaveLength(0);
    const specificity = (selector: string) => (selector.match(/[.[]/g) ?? []).length;
    for (const selector of media[0].prelude.split(",")) {
      expect(specificity(selector), selector).toBeGreaterThan(specificity(".text-card"));
    }
    expect(ceilingBox(visitorLayout(320, 480), 320, 480, { media: true })?.h).toBeCloseTo(
      480 * BOTTOM_CARD_HEIGHT_FRACTION_MEDIA,
      9,
    );
    // The page's inline max-height from the band outranks the media rule's.
    expect(ceilingBox(visitorLayout(844, 390), 844, 390, { media: true })?.h).toBe(309);
    expect(ceilingBox(visitorLayout(1400, 480), 1400, 480, { media: true })?.h).toBe(395);
  });
});

describeWithFramework("the bottom card against _story.scss and card-pool.js", () => {
  const MOBILE = [LAYER, VERTICAL, ".text-card"];

  it("sits max(1rem, safe area) off the bottom and 1rem in from each side", () => {
    const sheet = story();
    expect(declared(sheet, MOBILE, "bottom")).toBe("$telar-card-mobile-bottom");
    const bottom = sassVar("$telar-card-mobile-bottom");
    const m = /^max\((\d+rem), env\(safe-area-inset-bottom\)\)$/.exec(bottom);
    expect(m, bottom).not.toBeNull();
    expect(rems((m as RegExpExecArray)[1])).toBe(BOTTOM_CARD_INSET);
    expect(declared(sheet, MOBILE, "left")).toBe("1rem");
    expect(rems("1rem")).toBe(BOTTOM_CARD_SIDE_INSET);
    expect(declared(sheet, MOBILE, "width")).toBe("calc(100% - 2rem)");
  });

  it("is 40dvh tall, capped by the stylesheet under a taller inline height", () => {
    const sheet = story();
    expect(declared(sheet, MOBILE, "max-height")).toBe("$telar-card-mobile-max-height");
    expect(viewportUnits(sassVar("$telar-card-mobile-max-height"), "vh")).toBe(BOTTOM_CARD_HEIGHT_FRACTION);
    expect(
      viewportUnits(declared(sheet, [LAYER, VERTICAL, "@supports (height: 100dvh)", ".text-card"], "max-height"), "dvh"),
    ).toBe(BOTTOM_CARD_HEIGHT_FRACTION);
    // card-pool.js sets the bottom card's inline height to 80% of the window,
    // which the 40dvh cap then holds the card to whatever its content.
    const source = readFileSync(join(STORY_DIR, "card-pool.js"), "utf-8");
    expect(source).toContain("card.style.height = `${viewportH * SIDE_CARD_VIEWPORT_FRACTION}px`;");
    expect(SIDE_CARD_VIEWPORT_FRACTION).toBeGreaterThan(BOTTOM_CARD_HEIGHT_FRACTION);
  });

  it("is 35dvh after a video or an audio plate", () => {
    const sheet = story();
    const mediaRule = (p: string) => p.includes('[data-card-type="audio"] + .text-card');
    for (const path of [
      [LAYER, VERTICAL, mediaRule],
      [LAYER, VERTICAL, "@supports (height: 100dvh)", mediaRule],
    ]) {
      const rules = rulesAt(sheet, path);
      expect(rules).toHaveLength(1);
      const selectors = rules[0].prelude.split(",").map((s) => s.trim());
      expect(selectors.sort()).toEqual(
        ["audio", "google-drive", "vimeo", "youtube"].map((t) => `.viewer-plate[data-card-type="${t}"] + .text-card`),
      );
    }
    expect(viewportUnits(sassVar("$telar-card-mobile-max-height-media"), "vh")).toBe(
      BOTTOM_CARD_HEIGHT_FRACTION_MEDIA,
    );
    expect(
      viewportUnits(declared(sheet, [LAYER, VERTICAL, "@supports (height: 100dvh)", mediaRule], "max-height"), "dvh"),
    ).toBe(BOTTOM_CARD_HEIGHT_FRACTION_MEDIA);
  });

  it("falls back to a card top at 0.6 of the height before any card is measured", () => {
    const source = readFileSync(join(STORY_DIR, "iiif-card.js"), "utf-8");
    const m = /const _CSS_VERT_CARD_H_VH\s*= (\d+) \/ 100;/.exec(source);
    expect(m).not.toBeNull();
    expect(1 - Number((m as RegExpExecArray)[1]) / 100).toBeCloseTo(FALLBACK_BOTTOM_CARD_TOP_FRACTION, 12);
  });
});

describeWithFramework("the layout breakpoints against _responsive.scss and layout-mode.js", () => {
  it("declares 1024px, 0.75, the 480px height and the short windows, and tests each with inclusive max- features", () => {
    expect(pixels(sassVar("$telar-vertical-min-width"))).toBe(VERTICAL_MAX_WIDTH);
    expect(Number(sassVar("$telar-vertical-min-aspect"))).toBe(VERTICAL_MAX_ASPECT);
    const mixin = rulesAt(responsive(), ["@mixin vertical-layout"]);
    expect(mixin).toHaveLength(1);
    expect(mixin[0].decls.get("$query")).toBe(
      "'(max-width: #{$telar-vertical-min-width}), (max-aspect-ratio: #{$telar-vertical-min-aspect}), (max-height: #{$telar-card-landscape-max-height})'",
    );
    expect(mixin[0].children.map((c) => c.prelude)).toEqual([
      "@each $h, $w in $telar-vertical-short-windows",
      "@media #{$query}",
    ]);
    expect(mixin[0].children[0].decls.get("$query")).toBe("'#{$query}, (max-height: #{$h}) and (max-width: #{$w})'");
    const source = readFileSync(join(STORY_DIR, "layout-mode.js"), "utf-8");
    expect(source).toContain(
      "_modeMql = window.matchMedia([`(max-width: ${minW}px)`, `(max-aspect-ratio: ${minA})`,\n    `(max-height: ${maxH}px)`, ...shortWindows].join(', '));",
    );
    expect(source).toContain(".map(([h, w]) => `(max-height: ${h}) and (max-width: ${w})`);");
    expect(source).toContain(".getPropertyValue('--telar-vertical-short-windows'));");
    expect(source).toContain("window.matchMedia(`(max-height: ${getCardLandscapeMaxHeight()}px)`).matches");
    expect(source).toContain(".getPropertyValue('--telar-card-landscape-max-height');");
    expect(source).toContain("return parseFloat(raw) || 480;");
  });

  it("generates the short windows from the width terms in bands of 8px, as the Compositor does", () => {
    const sheet = responsive();
    expect(Number(sassVar("$telar-vertical-band-step"))).toBe(VERTICAL_BAND_STEP);
    expect(sassVar("$telar-vertical-short-windows")).toBe("_short-windows()");
    expect(rulesAt(sheet, [":root"])[0].decls.get("--telar-vertical-short-windows")).toBe("#{$telar-vertical-short-windows}");
    expect(rulesAt(sheet, ["@function _side-card-need($h)"])).toHaveLength(1);
    expect(rulesAt(sheet, ["@function _short-windows()"])).toHaveLength(1);
    const source = readFileSync(join(SASS_DIR, "_responsive.scss"), "utf-8");
    for (const line of [
      "@return math.min($telar-card-side-max-by-height, $telar-card-side-base - $telar-card-side-slope * $h);",
      "$bottom: math.div($telar-card-landscape-max-height, 1px) + 1;",
      "$w: math.ceil(math.div(_side-card-need($bottom), $telar-card-side-max-share)) - 1;",
      "@if $w <= math.div($telar-vertical-min-width, 1px) {",
      "$top: $bottom + $telar-vertical-band-step - 1;",
      "$windows: list.append($windows, ($top * 1px) ($w * 1px), $separator: comma);",
      "$bottom: $bottom + $telar-vertical-band-step;",
    ]) {
      expect(source, line).toContain(line);
    }
    // The property as dart-sass 1.100.0 compiles _responsive.scss at the
    // checkout's terms.
    expect(shortWindowsProperty(VERTICAL_SHORT_WINDOWS)).toBe(COMPILED_SHORT_WINDOWS);
  });
});

describeWithFramework("the layer panels against _panels.scss", () => {
  it("are 65% capped at 800px and 55% capped at 750px on a wide window", () => {
    const sheet = panels();
    for (const layer of [1, 2] as const) {
      const path = [LAYER, `#panel-layer${layer}`];
      expect(percent(declared(sheet, path, "width"))).toBe(PANEL_WIDE[layer].fraction);
      expect(pixels(declared(sheet, path, "max-width"))).toBe(PANEL_WIDE[layer].maxPx);
    }
  });

  it("are 80% and 75%, uncapped, from one pixel past the vertical-layout width to 1200px", () => {
    const sheet = panels();
    const tierAt = /^@media \(min-width: \$telar-vertical-min-width \+ (\d+)px\) and \(max-width: (\d+)px\)$/;
    const tiers = rulesAt(sheet, [LAYER, (p) => tierAt.test(p)]);
    expect(tiers).toHaveLength(1);
    const m = tierAt.exec(tiers[0].prelude) as RegExpExecArray;
    expect([pixels(sassVar("$telar-vertical-min-width")) + Number(m[1]), Number(m[2])]).toEqual([
      PANEL_NARROW_MIN_WIDTH,
      PANEL_NARROW_MAX_WIDTH,
    ]);
    for (const layer of [1, 2] as const) {
      const path = [LAYER, tiers[0].prelude, `#panel-layer${layer}`];
      expect(percent(declared(sheet, path, "width"))).toBe(PANEL_NARROW[layer].fraction);
      expect(declared(sheet, path, "max-width")).toBe("none");
    }
  });

  it("are right-slide sheets in vertical layout", () => {
    const sheet = panels();
    for (const layer of [1, 2] as const) {
      const path = [LAYER, VERTICAL, `#panel-layer${layer}.offcanvas-end`];
      expect(viewportUnits(declared(sheet, path, "width"), "vw")).toBe(PANEL_SHEET[layer].width);
      expect(viewportUnits(declared(sheet, path, "top"), "vh")).toBe(PANEL_SHEET[layer].top);
      expect(viewportUnits(declared(sheet, path, "height"), "vh")).toBe(PANEL_SHEET[layer].height);
    }
    expect(declared(sheet, [LAYER, VERTICAL, ".offcanvas-end"], "right")).toBe("0");
  });
});

describeWithFramework("video and audio steps against _responsive.scss, _story.scss and audio-card.js", () => {
  it("declares the video gutter and stacked ceiling, and places the player beside the side card", () => {
    expect(Number(sassVar("$telar-video-pad-factor"))).toBe(VIDEO_PAD_FACTOR);
    expect(Number(sassVar("$telar-video-stack-max-h"))).toBe(VIDEO_STACK_MAX_H);
    const source = readFileSync(join(STORY_DIR, "video-layout.js"), "utf-8");
    const fallback = (reader: string, name: string) => {
      const m = new RegExp(`${reader}\\('${name}', (\\d+(?:\\.\\d+)?)\\)`).exec(source);
      if (!m) throw new Error(`video-layout.js does not read ${name}`);
      return Number(m[1]);
    };
    expect(fallback("readFraction", "--telar-card-side-left")).toBe(CARD_SIDE_LEFT);
    expect(fallback("readFraction", "--telar-card-side-width")).toBe(CARD_SIDE_WIDTH);
    expect(source).toContain("const published = parseFloat(document.documentElement.style.getPropertyValue('--telar-card-side-width'));");
    expect(source).toContain("return Math.round(W * cardSideLeft + sideCardWidthPx(W));");
    expect(source).toContain("return Math.max(8, Math.round(Math.min(W, H) * videoPadFactor));");
    expect(source).toContain("return Math.round(H - mediaPadding(W, H) - cardH);");
  });

  it("declares the gain a media scene's card goes below the player at, and the aspect an unknown video is compared at", () => {
    expect(Number(sassVar("$telar-media-below-gain"))).toBe(MEDIA_BELOW_GAIN);
    const root = rulesAt(responsive(), [":root"]);
    expect(root[0].decls.get("--telar-media-below-gain")).toBe("#{$telar-media-below-gain}");
    const source = readFileSync(join(STORY_DIR, "video-layout.js"), "utf-8");
    expect(source).toContain("const mediaBelowGain = _readNumber('--telar-media-below-gain', 0.15);");
    expect(source).toContain("return belowArea >= besideArea * (1 + mediaBelowGain);");
    expect(source).toContain("export const COMPARISON_ASPECT = 16 / 9;");
    expect(16 / 9).toBe(VIDEO_COMPARISON_ASPECT);
  });

  it("arranges every horizontal layout's content-sized cards, from the three top controls", () => {
    const pool = readFileSync(join(STORY_DIR, "card-pool.js"), "utf-8");
    expect(pool).toContain("_arrangeMediaScenes(cards, viewportW, viewportH, horizontal, side);");
    // A card beside the player keeps the side card's top, and the band is
    // measured once for every scene of the pass.
    expect(pool).toContain("const besideTop = side?.topOf;");
    expect(pool).toContain("const topBand = measureTopBand(viewportW, viewportH);");
    const arrangement = readFileSync(join(STORY_DIR, "media-arrangement.js"), "utf-8");
    expect(arrangement).toContain("const TOP_CONTROLS = ['.btn-nav-back', '.share-button', '.step-counter'];");
    expect(arrangement).toContain("return Math.round(measureControlsBottom(TOP_CONTROLS)) + mediaPadding(W, H);");
    expect(arrangement).toContain("const cardH = Math.max(...cards.map((card) => card.offsetHeight));");
  });

  it("draws the waveform at the declared box and height in each mode", () => {
    expect(Number(sassVar("$telar-audio-height-resize"))).toBe(AUDIO_WAVEFORM_HEIGHT.horizontal);
    expect(Number(sassVar("$telar-audio-height-mobile"))).toBe(AUDIO_WAVEFORM_HEIGHT.vertical);
    const source = readFileSync(join(STORY_DIR, "audio-card.js"), "utf-8");
    expect(source).toMatch(
      /return \(state\.layoutMode === 'vertical' \|\| state\.isEmbed\)\s*\?\s*audioHeightMobile\s*:\s*audioHeightResize;/,
    );
    const sheet = story();
    for (const [mode, path] of [
      ["horizontal", [LAYER, ".waveform-container"]],
      ["vertical", [LAYER, VERTICAL, ".waveform-container"]],
    ] as const) {
      expect(percent(declared(sheet, [...path], "top"))).toBe(AUDIO_WAVEFORM_BOX[mode].centre);
      expect(declared(sheet, [...path], "transform")).toBe("translateY(-50%)");
    }
    const vertical = [LAYER, VERTICAL, ".waveform-container"];
    expect(percent(resolved(declared(sheet, vertical, "left")))).toBe(AUDIO_WAVEFORM_BOX.vertical.left);
    expect(percent(resolved(declared(sheet, vertical, "width")))).toBe(AUDIO_WAVEFORM_BOX.vertical.width);
    // Beside the card: from the gap past its right edge to the window's.
    const horizontal = [LAYER, ".waveform-container"];
    expect(declared(sheet, horizontal, "left")).toBe("$telar-audio-wave-side-left");
    expect(declared(sheet, horizontal, "width")).toBe("$telar-audio-wave-side-width");
    expect(sassVar("$telar-audio-wave-side-left")).toBe(
      "calc(var(--telar-card-side-left) + var(--telar-card-side-width) + #{$telar-audio-wave-side-gap})",
    );
    expect(sassVar("$telar-audio-wave-side-width")).toBe(
      "calc(100% - var(--telar-card-side-left) - var(--telar-card-side-width) - #{$telar-audio-wave-side-gap})",
    );
    expect(percent(sassVar("$telar-audio-wave-side-gap"))).toBe(AUDIO_WAVE_SIDE_GAP);
  });
});

// ── Driving the framework's modules ─────────────────────────────────────────

/** One window size, and the live card rect the framework would measure there. */
interface RegionCase {
  w: number;
  h: number;
  live: Box;
}

interface FrameworkRegion {
  mode: string;
  landscapeSide: boolean;
  fallbackPlacement: string;
  fallback: Box;
  livePlacement: string;
  live: Box;
}

interface VideoCase {
  w: number;
  h: number;
  aspect: number;
  /** The band the player beside the card keeps clear (`readTopBand`); 0 when absent. */
  topBand?: number;
}

interface FrameworkVideo {
  mode: string;
  layout: {
    mode: string;
    video: { left: number; top: number; width: number; height: number };
    card: { left: number; top: number; width: number; height: number };
    padding: number;
  };
  letterbox: { left: number; top: number; width: number; height: number };
}

/**
 * A jsdom window whose size the script sets per case, with `:root` carrying the
 * custom properties `_responsive.scss` mirrors and a `matchMedia` that reads the
 * max-width, max-height and max-aspect-ratio features the framework builds its
 * queries from. An unrecognised feature throws rather than answering false.
 */
function prelude(): string[] {
  const vars: Record<string, string> = {
    "--telar-vertical-min-width": sassVar("$telar-vertical-min-width"),
    "--telar-vertical-min-aspect": sassVar("$telar-vertical-min-aspect"),
    "--telar-card-landscape-max-height": sassVar("$telar-card-landscape-max-height"),
    "--telar-video-pad-factor": sassVar("$telar-video-pad-factor"),
    "--telar-card-side-left": sassVar("$telar-card-side-left"),
    "--telar-card-side-width": sassVar("$telar-card-side-width"),
    "--telar-video-stack-max-h": sassVar("$telar-video-stack-max-h"),
    "--telar-audio-height-mobile": sassVar("$telar-audio-height-mobile"),
    "--telar-audio-height-resize": sassVar("$telar-audio-height-resize"),
    "--telar-media-below-gain": sassVar("$telar-media-below-gain"),
    "--telar-audio-wave-side-gap": sassVar("$telar-audio-wave-side-gap"),
    "--telar-card-side-min-share": sassVar("$telar-card-side-min-share"),
    "--telar-card-side-max-share": sassVar("$telar-card-side-max-share"),
    "--telar-card-side-base": sassVar("$telar-card-side-base"),
    "--telar-card-side-slope": sassVar("$telar-card-side-slope"),
    "--telar-card-side-max-by-height": sassVar("$telar-card-side-max-by-height"),
    "--telar-vertical-short-windows": COMPILED_SHORT_WINDOWS,
  };
  const rootVars = Object.entries(vars)
    .map(([k, v]) => `${k}: ${v};`)
    .join(" ");
  return [
    ...jsdomPrelude({
      head: `<style>:root { ${rootVars} }</style>`,
      sizedWindow: true,
      matchMedia: [
        "const px = (v) => { const m = /^(\\d+(?:\\.\\d+)?)px$/.exec(v.trim()); if (!m) throw new Error('length ' + v); return Number(m[1]); };",
        "const feature = (f) => {",
        "  const m = /^\\((max-width|max-height|max-aspect-ratio):\\s*([^)]+)\\)$/.exec(f.trim());",
        "  if (!m) throw new Error('media feature ' + f);",
        "  if (m[1] === 'max-width') return W <= px(m[2]);",
        "  if (m[1] === 'max-height') return H <= px(m[2]);",
        "  return W / H <= Number(m[2]);",
        "};",
        "const clause = (c) => c.split(' and ').every(feature);",
        "dom.window.matchMedia = (q) => ({ get matches() { return q.split(',').some(clause); }, addEventListener() {}, removeEventListener() {} });",
      ],
    }),
    // The modules must read the stylesheet's values, not their own fallbacks.
    // jsdom drops the space after a comma in a list, which the reader trims anyway.
    `for (const [k, v] of Object.entries(${JSON.stringify(vars)})) {`,
    "  const got = getComputedStyle(document.documentElement).getPropertyValue(k).trim();",
    "  if (got !== v.replace(/, /g, ',')) throw new Error(`:root ${k} reads ${JSON.stringify(got)}, not ${v}`);",
    "}",
    `const { state } = await import(${JSON.stringify(`file://${join(STORY_DIR, "state.js")}`)});`,
    // getLayoutMode caches its first answer, so each case asks a fresh instance.
    `const modeFor = async (i) => (await import(${JSON.stringify(`file://${join(STORY_DIR, "layout-mode.js")}`)} + '?case=' + i)).getLayoutMode();`,
    // The side card's width for the window, as card-pool.js publishes it at the
    // start of each geometry pass. card-fit.js is imported at the first window,
    // after a case's :root overrides, since the modules it loads read theirs.
    `const fitUrl = ${JSON.stringify(`file://${join(STORY_DIR, "card-fit.js")}`)};`,
    "const enterWindow = async (w, h, i) => {",
    "  W = w; H = h;",
    "  const mode = await modeFor(i);",
    "  (await import(fitUrl)).publishSideCardWidth(W, H, mode !== 'vertical');",
    "  return mode;",
    "};",
  ];
}

/** A textual change to a framework module, applied `count` times, to prove a case can fail. */
interface SourceMutation {
  from: string;
  to: string;
  count: number;
}

/**
 * The URL to import `file` from: the module itself, or a copy with `mutation`
 * applied, served as a data URL whose relative imports point back at the
 * checkout so it shares `state.js` and `layout-mode.js` with everything else.
 */
function moduleUrl(file: string, mutation?: SourceMutation): string {
  const path = join(STORY_DIR, file);
  if (!mutation) return `file://${path}`;
  const source = readFileSync(path, "utf-8");
  const parts = source.split(mutation.from);
  if (parts.length - 1 !== mutation.count) {
    throw new Error(`${file}: ${mutation.from} occurs ${parts.length - 1} times, not ${mutation.count}`);
  }
  const mutated = parts
    .join(mutation.to)
    .replace(/from (['"])(\.\.?\/[^'"]+)\1/g, (_, q, rel) => `from ${q}file://${join(dirname(path), rel)}${q}`);
  return `data:text/javascript;base64,${Buffer.from(mutated).toString("base64")}`;
}

/** Run `body` after the prelude with `cases` as `input`, and parse its last line. */
function drive<T>(body: string[], cases: unknown): T {
  const script = [...prelude(), "const input = JSON.parse(process.argv[1]);", ...body].join("\n");
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(cases)], {
    encoding: "utf-8",
    timeout: FRAMEWORK_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out.trim().split("\n").at(-1) as string) as T;
}

function frameworkRegions(cases: RegionCase[]): FrameworkRegion[] {
  return drive<FrameworkRegion[]>(
    [
      `const m = await import(${JSON.stringify(`file://${join(STORY_DIR, "iiif-card.js")}`)});`,
      `const lm = await import(${JSON.stringify(`file://${join(STORY_DIR, "layout-mode.js")}`)});`,
      "const out = [];",
      "for (const [i, c] of input.entries()) {",
      "  state.layoutMode = await enterWindow(c.w, c.h, i);",
      "  const fallbackPlacement = m._deriveCardPlacement(null, W, H);",
      "  const fallback = m.computeFocalTarget(0.5, 0.5, 1, 1000, 1000, null, fallbackPlacement).region;",
      "  const livePlacement = m._deriveCardPlacement(c.live, W, H);",
      "  const live = m.computeFocalTarget(0.5, 0.5, 1, 1000, 1000, c.live, livePlacement).region;",
      "  out.push({ mode: state.layoutMode, landscapeSide: (lm.isPhoneHeightSideCard ?? lm.isLandscapeSideCard)(), fallbackPlacement, fallback, livePlacement, live });",
      "}",
      "console.log(JSON.stringify(out));",
    ],
    cases,
  );
}

function frameworkVideo(cases: VideoCase[], mutation?: SourceMutation): FrameworkVideo[] {
  return drive<FrameworkVideo[]>(
    [
      `const v = await import(${JSON.stringify(moduleUrl("video-layout.js", mutation))});`,
      "const out = [];",
      "for (const [i, c] of input.entries()) {",
      "  state.layoutMode = await enterWindow(c.w, c.h, i);",
      "  const band = c.topBand ?? 0;",
      "  out.push({ mode: state.layoutMode, layout: v.computeVideoLayout(W, H, c.aspect, null, band), letterbox: v.computeVideoLetterboxRegion(W, H, null, band) });",
      "}",
      "console.log(JSON.stringify(out));",
    ],
    cases,
  );
}

function frameworkCardTops(cases: Array<{ h: number; cardH: number }>): number[] {
  return drive<number[]>(
    [
      `const cp = await import(${JSON.stringify(`file://${join(STORY_DIR, "card-pool.js")}`)});`,
      "console.log(JSON.stringify(input.map((c) => cp.computeCardTop(c.h, c.cardH, 0, 1))));",
    ],
    cases,
  );
}

/** One audio step: the window the player is built and shown in, and the one it is resized to. */
interface AudioCase {
  w: number;
  h: number;
  resizeW: number;
  resizeH: number;
}

/** The waveform heights WaveSurfer was given: at creation, on activation and after the resize. */
interface FrameworkAudio {
  mode: string;
  created: number;
  activated: number;
  resizeMode: string;
  resized: number;
  /** The side-card width published at creation and after the resize; null where none is. */
  published: number | null;
  resizePublished: number | null;
}

/**
 * Build, show and resize an audio player through `audio-card.js`, with
 * WaveSurfer and the AudioContext stubbed so the heights the module hands
 * WaveSurfer can be read off. After the window is resized the plate is
 * re-placed through `layoutAudioPlate`, which is what `card-pool.js` calls
 * for every media plate at the end of its geometry pass.
 */
function frameworkAudio(cases: AudioCase[], mutation?: SourceMutation): FrameworkAudio[] {
  return drive<FrameworkAudio[]>(
    [
      "const created = [], set = [];",
      "const ws = { on() {}, setOptions(o) { if ('height' in o) set.push(o.height); }, play() { return Promise.resolve(); }, pause() {}, setVolume() {}, setTime() {}, getDuration() { return 0; }, destroy() {} };",
      "dom.window.WaveSurfer = { create(o) { created.push(o.height); return ws; }, Regions: { create: () => ({ addRegion() {}, on() {} }) } };",
      "dom.window.AudioContext = class { constructor() { this.state = 'running'; } resume() { return Promise.resolve(); } };",
      "const settle = (ms) => new Promise((r) => setTimeout(r, ms));",
      `const a = await import(${JSON.stringify(moduleUrl("audio-card.js", mutation))});`,
      "const out = [];",
      "for (const [i, c] of input.entries()) {",
      "  const mode = await enterWindow(c.w, c.h, i);",
      "  const published = parseFloat(document.documentElement.style.getPropertyValue('--telar-card-side-width')) || null;",
      "  state.layoutMode = mode;",
      "  const plate = document.createElement('div');",
      "  document.body.appendChild(plate);",
      "  a.createAudioPlayer(plate, 'a.mp3', null, { sceneIndex: i });",
      "  await settle(0); await settle(0);",
      "  if (created.length !== i + 1) throw new Error('WaveSurfer was not created for case ' + i);",
      "  a.activateAudioCard(plate, i);",
      "  const activated = set.at(-1);",
      "  const resizeMode = await enterWindow(c.resizeW, c.resizeH, 1000 + i);",
      "  const resizePublished = parseFloat(document.documentElement.style.getPropertyValue('--telar-card-side-width')) || null;",
      "  state.layoutMode = resizeMode;",
      "  const before = set.length;",
      // card-pool.js re-places every media plate after its geometry pass, on
      // each resize, through the plate's resize(), which is layoutAudioPlate.
      "  a.layoutAudioPlate(plate);",
      "  if (set.length === before) throw new Error('no resize reached WaveSurfer for case ' + i);",
      "  out.push({ mode, created: created.at(-1), activated, resizeMode, resized: set.at(-1), published, resizePublished });",
      "  a.deactivateAudioCard(plate, 0);",
      "}",
      "console.log(JSON.stringify(out));",
    ],
    cases,
  );
}

/** Each field of `actual` against `expected`, to a thousandth of a pixel. */
function expectBox(actual: Box, expected: Box, label: string): void {
  for (const k of ["x", "y", "w", "h"] as const) {
    expect(actual[k], `${label} ${k}`).toBeCloseTo(expected[k], 3);
  }
}

/**
 * Windows either side of every boundary, the short-window bands' corners
 * among them, the plan's fixture windows, a sideways phone, a wide window at
 * the height threshold, and short horizontal windows whose card the height
 * widens.
 */
const WINDOWS: Array<[number, number]> = [
  [1440, 757],
  [1280, 1024],
  [1100, 800],
  [390, 844],
  [1024, 800],
  [1025, 800],
  [1500, 2000],
  [1501, 2000],
  [900, 480],
  [900, 481],
  [844, 390],
  [1400, 480],
  [1380, 488],
  [1381, 488],
  [1380, 489],
  [1381, 489],
  [1144, 600],
  [1145, 600],
  [1144, 601],
  [1046, 632],
  [1047, 632],
  [1046, 633],
  [1400, 560],
  [1600, 520],
];

/**
 * The card rect `_story.scss` gives a window, read from the stylesheet rather
 * than from `cardBox`: the short-window side card at its declared left and
 * width (its height is its content's, here `contentH`, centred), and the
 * bottom card at its declared inset, side insets and 40dvh height.
 */
function stylesheetCardRect(w: number, h: number, contentH: number): Box {
  const sheet = story();
  if (h <= pixels(sassVar("$telar-card-landscape-max-height"))) {
    const short = [LAYER, SHORT_WINDOW, ".text-card"];
    const x = w * percent(resolved(declared(sheet, short, "left")));
    return { x, y: (h - contentH) / 2, w: w * percent(resolved(declared(sheet, short, "width"))), h: contentH };
  }
  const mobile = [LAYER, VERTICAL, ".text-card"];
  const inset = /^max\((\d+rem), env\(safe-area-inset-bottom\)\)$/.exec(sassVar("$telar-card-mobile-bottom"));
  if (!inset) throw new Error("no rem inset in $telar-card-mobile-bottom");
  const bottom = rems(inset[1]);
  const side = rems(declared(sheet, mobile, "left"));
  const cardH = h * viewportUnits(declared(sheet, [LAYER, VERTICAL, "@supports (height: 100dvh)", ".text-card"], "max-height"), "dvh");
  expect(declared(sheet, mobile, "width")).toBe(`calc(100% - ${2 * side / 16}rem)`);
  return { x: side, y: h - bottom - cardH, w: w - 2 * side, h: cardH };
}

/** A window in each new vertical region: a corner of the first, a middle and the last band, and the 480px clause. */
const BAND_REGION_WINDOWS: Array<[number, number]> = [[1380, 488], [1144, 600], [1046, 632], [1400, 480]];

describeWithFramework("the region, driven through the framework's computeFocalTarget", () => {
  it(
    "frames the band windows and the 480px window as the stylesheet's own card rect does",
    () => {
      const cases = BAND_REGION_WINDOWS.map(([w, h]) => ({ w, h, live: stylesheetCardRect(w, h, 100) }));
      const results = frameworkRegions(cases);
      results.forEach((r, i) => {
        const { w, h, live } = cases[i];
        const label = `${w}×${h}`;
        const layout = visitorLayout(w, h);
        expect(r.mode, label).toBe("vertical");
        expect(layout.mode, label).toBe("vertical");
        const ours = cardBox(layout, w, h, { contentHeight: 100 });
        if (layout.cardPlacement === "bottom") expectBox(ours, live, `${label} card`);
        else expectBox({ ...ours, y: live.y, h: live.h }, live, `${label} card`);
        expectBox(r.live, regionOf(layout, w, h, { contentHeight: 100 }), `${label} live`);
      });
    },
    FRAMEWORK_TIMEOUT_MS,
  );

  it(
    "agrees on the layout mode, the placement, and both regions at every window",
    () => {
      const cases = WINDOWS.map(([w, h]) => ({ w, h, live: cardBox(visitorLayout(w, h), w, h) }));
      const results = frameworkRegions(cases);
      expect(results).toHaveLength(cases.length);
      results.forEach((r, i) => {
        const { w, h } = cases[i];
        const label = `${w}×${h}`;
        const layout = visitorLayout(w, h);
        const placement = layout.cardPlacement === "side" ? "horizontal" : "vertical";
        expect(r.mode, label).toBe(layout.mode);
        expect(r.landscapeSide, label).toBe(h <= LANDSCAPE_SIDE_CARD_MAX_HEIGHT);
        expect(r.fallbackPlacement, label).toBe(placement);
        expect(r.livePlacement, label).toBe(placement);
        expectBox(r.fallback, fallbackRegion(layout, w, h), `${label} fallback`);
        expectBox(r.live, regionOf(layout, w, h), `${label} live`);
      });
    },
    FRAMEWORK_TIMEOUT_MS,
  );

  it(
    "gives 490.4 live and 506.4 fallback at 390×844, and 532.6 above the media card",
    () => {
      const layout = visitorLayout(390, 844);
      const [plain, media] = frameworkRegions([
        { w: 390, h: 844, live: cardBox(layout, 390, 844) },
        { w: 390, h: 844, live: cardBox(layout, 390, 844, { media: true }) },
      ]);
      expect(plain.live.h).toBeCloseTo(490.4, 6);
      expect(plain.fallback.h).toBeCloseTo(506.4, 6);
      expect(media.live.h).toBeCloseTo(532.6, 6);
      expect(regionOf(layout, 390, 844, { media: true }).h).toBeCloseTo(media.live.h, 6);
    },
    FRAMEWORK_TIMEOUT_MS,
  );

  it(
    "centres a short portrait window's side card as computeCardTop does",
    () => {
      // A horizontal layout's card, and a phone held sideways's, are placed by
      // the fit model's band instead (side-card-fit-parity.test.ts).
      const cases = [
        { w: 320, h: 480, contentHeight: 200 },
        { w: 320, h: 480, contentHeight: 5000 },
        { w: 360, h: 400, contentHeight: 120 },
      ];
      const boxes = cases.map((c) => cardBox(visitorLayout(c.w, c.h), c.w, c.h, c));
      const tops = frameworkCardTops(boxes.map((b, i) => ({ h: cases[i].h, cardH: b.h })));
      tops.forEach((top, i) => expect(boxes[i].y).toBeCloseTo(top, 6));
    },
    FRAMEWORK_TIMEOUT_MS,
  );
});

/** `{left, top, width, height}` as a Box. */
function asBox(b: { left: number; top: number; width: number; height: number }): Box {
  return { x: b.left, y: b.top, w: b.width, h: b.height };
}

/** Whether two boxes agree to a thousandth of a pixel. */
function sameBox(a: Box, b: Box): boolean {
  return (["x", "y", "w", "h"] as const).every((k) => Math.abs(a[k] - b[k]) < 1e-3);
}

/** Every way the framework's video answers differ from ours, one line each. */
function videoMismatches(cases: VideoCase[], results: FrameworkVideo[]): string[] {
  const out: string[] = [];
  if (results.length !== cases.length) return [`${results.length} results for ${cases.length} cases`];
  results.forEach((r, i) => {
    const { w, h, aspect, topBand = 0 } = cases[i];
    const label = `${w}×${h} at ${aspect.toFixed(3)}${topBand ? ` under ${topBand}` : ""}`;
    const mode = visitorLayout(w, h).mode;
    const ours = videoLayout(mode, w, h, aspect, null, topBand);
    if (r.mode !== mode) out.push(`${label}: mode ${r.mode}, ours ${mode}`);
    if (r.layout.mode !== ours.arrangement) out.push(`${label}: ${r.layout.mode}, ours ${ours.arrangement}`);
    if (!sameBox(ours.player, asBox(r.layout.video))) out.push(`${label}: player`);
    if (!sameBox(ours.card, asBox(r.layout.card))) out.push(`${label}: card slot`);
    if (ours.padding !== r.layout.padding) out.push(`${label}: padding`);
    if (!sameBox(videoLetterboxRegion(mode, w, h, null, topBand), asBox(r.letterbox))) out.push(`${label}: letterbox`);
  });
  return out;
}

/**
 * Horizontal windows, side by side whatever the aspect, a short one among
 * them, and vertical windows, stacked, a sideways phone among them.
 */
const VIDEO_CASES: VideoCase[] = [
  { w: 1440, h: 757, aspect: 16 / 9 },
  { w: 1440, h: 757, aspect: 4 / 3 },
  // a wide player a stacked arrangement would show larger
  { w: 1280, h: 1024, aspect: 2.39 },
  { w: 1400, h: 560, aspect: 16 / 9 },
  { w: 1100, h: 1500, aspect: 9 / 16 },
  { w: 390, h: 844, aspect: 16 / 9 },
  { w: 844, h: 390, aspect: 16 / 9 },
];

/**
 * The player beside the card under the top band (`readTopBand`): at 1400×560
 * a 16:9 player is held by the width under a band of 90, which moves its top
 * down to the band from the 88 centring gives it; a 4:3 player is held by the
 * height, so the band shortens it and moves its top down to the band; at
 * 1440×757 the player is held by the width and a
 * band of 60 leaves it centred, below the band already; a band under the
 * gutter changes nothing; a vertical window ignores the band.
 */
const TOP_BAND_CASES: VideoCase[] = [
  { w: 1400, h: 560, aspect: 16 / 9, topBand: 90 },
  { w: 1400, h: 560, aspect: 4 / 3, topBand: 90 },
  { w: 1440, h: 757, aspect: 16 / 9, topBand: 60 },
  { w: 1440, h: 757, aspect: 9 / 16, topBand: 120 },
  { w: 1400, h: 560, aspect: 16 / 9, topBand: 3 },
  { w: 390, h: 844, aspect: 16 / 9, topBand: 90 },
  // a band off the pixel grid rounds (90.6 to 91); one that is not a number counts as none
  { w: 1400, h: 560, aspect: 16 / 9, topBand: 90.6 },
  { w: 1400, h: 560, aspect: 16 / 9, topBand: Number.NaN },
];

/**
 * Windows where the video gutter sits at its 8px floor: at 300×600 the
 * rounded share is 8 too, and at 300×200 the floor alone holds it there.
 */
const PAD_FLOOR_CASES: VideoCase[] = [
  { w: 300, h: 600, aspect: 16 / 9 },
  { w: 300, h: 200, aspect: 16 / 9 },
];

/** A window so short the stacked card's 60px floor holds it: 100 − 74 − 8 would leave 18. */
const CARD_FLOOR_CASES: VideoCase[] = [{ w: 844, h: 100, aspect: 16 / 9 }];

/** `mediaPadding`'s gutter expression, the one place every arrangement reads it from. */
const PAD_EXPRESSION = "Math.max(8, Math.round(Math.min(W, H) * videoPadFactor))";

describeWithFramework("video steps, driven through the framework's computeVideoLayout", () => {
  it(
    "agrees on the arrangement, the player, the card slot and the letterbox",
    () => {
      const results = frameworkVideo(VIDEO_CASES);
      expect(results.map((r) => r.layout.mode)).toEqual([
        "side-by-side",
        "side-by-side",
        "side-by-side",
        "side-by-side",
        "stacked",
        "stacked",
        "stacked",
      ]);
      expect(videoMismatches(VIDEO_CASES, results)).toEqual([]);
    },
    FRAMEWORK_TIMEOUT_MS,
  );

  it(
    "disagrees once the framework stacks a horizontal window's player",
    () => {
      const mutated = frameworkVideo(VIDEO_CASES, {
        from: "return _computeSideBySideLayout(W, H, aspectRatio, topBand);",
        to: "return _computeStackedLayout(W, H, aspectRatio);",
        count: 1,
      });
      const misses = videoMismatches(VIDEO_CASES, mutated);
      for (const c of VIDEO_CASES.slice(0, 4)) {
        expect(misses).toContain(`${c.w}×${c.h} at ${c.aspect.toFixed(3)}: stacked, ours side-by-side`);
      }
    },
    FRAMEWORK_TIMEOUT_MS,
  );

  it(
    "agrees on the player beside the card under the top band, and disagrees once the band is ignored",
    () => {
      const results = frameworkVideo(TOP_BAND_CASES);
      expect(videoMismatches(TOP_BAND_CASES, results)).toEqual([]);
      // The band moves the player where the height holds it, and not otherwise.
      const moved = results.map((r, i) => r.layout.video.top > Math.round((TOP_BAND_CASES[i].h - r.layout.video.height) / 2));
      expect(moved).toEqual([true, true, false, true, false, false, true, false]);
      const mutated = frameworkVideo(TOP_BAND_CASES, {
        from: "const top = Math.max(pad, Math.round(topBand) || 0);",
        to: "const top = pad;",
        count: 1,
      });
      expect(videoMismatches(TOP_BAND_CASES, mutated)).toEqual([
        "1400×560 at 1.778 under 90: player",
        "1400×560 at 1.778 under 90: letterbox",
        "1400×560 at 1.333 under 90: player",
        "1400×560 at 1.333 under 90: letterbox",
        "1440×757 at 1.778 under 60: letterbox",
        "1440×757 at 0.563 under 120: player",
        "1440×757 at 0.563 under 120: letterbox",
        "1400×560 at 1.778 under 90.6: player",
        "1400×560 at 1.778 under 90.6: letterbox",
      ]);
    },
    FRAMEWORK_TIMEOUT_MS,
  );

  it(
    "agrees at the gutter's 8px floor, and disagrees once the framework's floor is 9",
    () => {
      expect(VIDEO_PAD_MIN).toBe(8);
      expect(videoMismatches(PAD_FLOOR_CASES, frameworkVideo(PAD_FLOOR_CASES))).toEqual([]);
      const mutated = frameworkVideo(PAD_FLOOR_CASES, {
        from: PAD_EXPRESSION,
        to: PAD_EXPRESSION.replace("Math.max(8,", "Math.max(9,"),
        count: 1,
      });
      const misses = videoMismatches(PAD_FLOOR_CASES, mutated);
      for (const c of PAD_FLOOR_CASES) {
        const label = `${c.w}×${c.h} at ${c.aspect.toFixed(3)}`;
        expect(misses).toContain(`${label}: player`);
        expect(misses).toContain(`${label}: letterbox`);
      }
    },
    FRAMEWORK_TIMEOUT_MS,
  );

  it(
    "agrees at the stacked card's 60px floor, and disagrees once the framework's floor is 61",
    () => {
      expect(VIDEO_STACK_CARD_MIN_H).toBe(60);
      const results = frameworkVideo(CARD_FLOOR_CASES);
      expect(results[0].layout.card.height).toBe(60);
      expect(videoMismatches(CARD_FLOOR_CASES, results)).toEqual([]);
      const mutated = frameworkVideo(CARD_FLOOR_CASES, {
        from: "Math.max(60, H - cardTop - pad)",
        to: "Math.max(61, H - cardTop - pad)",
        count: 1,
      });
      expect(videoMismatches(CARD_FLOOR_CASES, mutated)).toEqual(["844×100 at 1.778: card slot"]);
    },
    FRAMEWORK_TIMEOUT_MS,
  );
});

/**
 * Heights whose unrounded value ends in .5, so a floor in place of a round
 * moves them, in both modes and across a mode flip on resize.
 */
const AUDIO_CASES: AudioCase[] = [
  // 757 × 0.5 = 378.5; resized to 901 × 0.5 = 450.5
  { w: 1440, h: 757, resizeW: 1440, resizeH: 901 },
  // 844 × 0.35 = 295.4; resized sideways to 390 × 0.35 = 136.5
  { w: 390, h: 844, resizeW: 844, resizeH: 390 },
  // 1001 × 0.5 = 500.5, horizontal; resized to vertical at 1000 × 1210, where
  // 1210 × 0.35 is 423.5 in floating point (1370 × 0.35 is 479.49999999999994)
  { w: 1300, h: 1001, resizeW: 1000, resizeH: 1210 },
];

/** Every way the framework's waveform heights differ from ours, one line each. */
function audioMismatches(cases: AudioCase[], results: FrameworkAudio[]): string[] {
  const out: string[] = [];
  if (results.length !== cases.length) return [`${results.length} results for ${cases.length} cases`];
  results.forEach((r, i) => {
    const c = cases[i];
    const mode = visitorLayout(c.w, c.h).mode;
    const resizeMode = visitorLayout(c.resizeW, c.resizeH).mode;
    const at = audioWaveformBox(mode, c.w, c.h);
    const after = audioWaveformBox(resizeMode, c.resizeW, c.resizeH);
    if (r.mode !== mode) out.push(`${c.w}×${c.h}: mode`);
    if (r.resizeMode !== resizeMode) out.push(`${c.resizeW}×${c.resizeH}: resize mode`);
    if (r.created !== at.h) out.push(`${c.w}×${c.h}: created ${r.created}, ours ${at.h}`);
    if (r.activated !== at.h) out.push(`${c.w}×${c.h}: activated ${r.activated}, ours ${at.h}`);
    if (r.resized !== after.h) out.push(`${c.resizeW}×${c.resizeH}: resized ${r.resized}, ours ${after.h}`);
  });
  return out;
}

describeWithFramework("audio steps, driven through the framework's audio-card.js", () => {
  it(
    "hands WaveSurfer the height we draw, at creation, on activation and after a resize",
    () => {
      const results = frameworkAudio(AUDIO_CASES);
      expect(results.map((r) => [r.created, r.resized])).toEqual([
        [379, 451],
        [295, 137],
        [501, 424],
      ]);
      expect(audioMismatches(AUDIO_CASES, results)).toEqual([]);
    },
    FRAMEWORK_TIMEOUT_MS,
  );

  it(
    "draws the waveform box from the stylesheet around the height WaveSurfer is given",
    () => {
      const sheet = story();
      const results = frameworkAudio(AUDIO_CASES);
      const left = percent(sassVar("$telar-card-side-left"));
      const gap = percent(sassVar("$telar-audio-wave-side-gap"));
      // Beside the card, the stylesheet's calc(): left + the published width + gap.
      const waveAcross = (mode: string, w: number, published: number | null, path: Step[]) => {
        if (mode === "vertical") {
          return { x: w * percent(resolved(declared(sheet, path, "left"))), w: w * percent(resolved(declared(sheet, path, "width"))) };
        }
        const x = w * left + (published ?? Number.NaN) + w * gap;
        return { x, w: w - x };
      };
      expect(results.map((r) => [r.published, r.resizePublished])).toEqual([[533, 533], [null, null], [481, null]]);
      results.forEach((r, i) => {
        const c = AUDIO_CASES[i];
        for (const [mode, w, h, height, published] of [
          [r.mode, c.w, c.h, r.created, r.published],
          [r.resizeMode, c.resizeW, c.resizeH, r.resized, r.resizePublished],
        ] as const) {
          const path = mode === "vertical" ? [LAYER, VERTICAL, ".waveform-container"] : [LAYER, ".waveform-container"];
          const { x, w: width } = waveAcross(mode, w, published, path);
          const expected: Box = {
            x,
            y: h * percent(declared(sheet, path, "top")) - height / 2,
            w: width,
            h: height,
          };
          expectBox(audioWaveformBox(mode as "horizontal" | "vertical", w, h), expected, `${w}×${h}`);
        }
      });
    },
    FRAMEWORK_TIMEOUT_MS,
  );

  it(
    "disagrees once the framework floors the height instead of rounding it",
    () => {
      // Creation, activation and re-placing all read the height beside the
      // card from this one expression.
      const floored = frameworkAudio(AUDIO_CASES, {
        from: "return belowHeight ?? Math.round(window.innerHeight * _audioHeightFraction());",
        to: "return belowHeight ?? Math.floor(window.innerHeight * _audioHeightFraction());",
        count: 1,
      });
      expect(audioMismatches(AUDIO_CASES, floored)).toEqual([
        "1440×757: created 378, ours 379",
        "1440×757: activated 378, ours 379",
        "1440×901: resized 450, ours 451",
        "844×390: resized 136, ours 137",
        "1300×1001: created 500, ours 501",
        "1300×1001: activated 500, ours 501",
        "1000×1210: resized 423, ours 424",
      ]);
    },
    FRAMEWORK_TIMEOUT_MS,
  );
});

// ── The media arrangement, driven through media-arrangement.js ──────────────

/** A video or audio scene: its window, its plate, and its cards' content heights. */
interface ArrangementCase {
  w: number;
  h: number;
  type: "youtube" | "vimeo" | "google-drive" | "audio";
  /** A video's aspect; null for a plate whose aspect is unknown (letterboxed). */
  aspect: number | null;
  contents: number[];
  /** The top controls' lowest bottom edge, when it is not the story page's. */
  controlsBottom?: number;
  /** Why the case is here. */
  note: string;
}

interface FrameworkArrangement {
  mode: string;
  arrangement: string | null;
  below: MediaBelow | null;
  tops: number[];
  regions: Box[];
  video: { left: number; top: number; width: number; height: number } | null;
  letterbox: { left: number; top: number; width: number; height: number } | null;
  audio: { height: number | null; top: string; left: string; width: string; controlsBottom: string } | null;
}

/** The layout, the arrangement and each card as the Compositor has them, for one case. */
function ours(c: ArrangementCase) {
  const layout = visitorLayout(c.w, c.h);
  const topControlsBottom = c.controlsBottom;
  const below = mediaCardBelow(layout, c.w, c.h, {
    kind: c.type === "audio" ? "audio" : "video",
    aspect: c.aspect,
    tallestContentHeight: Math.max(...c.contents),
    topControlsBottom: c.controlsBottom,
  });
  const cards = c.contents.map((contentHeight) =>
    cardBox(layout, c.w, c.h, { media: true, contentHeight, below, topControlsBottom }),
  );
  return { layout, below, cards };
}

/**
 * Arrange each case's scene through the framework's `arrangeMediaScene`, then
 * place its player as `video-card.js` and `audio-card.js` do from what the
 * plate carries: `readBelow` into `computeVideoLayout` or
 * `computeVideoLetterboxRegion`, and `placeAudioBelow`. The cards are elements
 * whose `offsetHeight` is the height the Compositor gives each card, which is
 * what the page's `max-height` leaves of its content, rounded to a whole pixel
 * as a browser reports it; the three top controls
 * are elements whose boxes end at the case's controls edge, one of them lower
 * than the others. Each card's region is `computeFocalTarget`'s for the card
 * rect the Compositor draws. `eligible` is `card-pool.js`'s `contentSized`
 * under the fit model, which is a horizontal layout, and there, as in
 * `card-pool.js`, the cards are first placed by `fitSideCards`, whose `topOf`
 * is the top a card beside the player keeps, and the band is measured once
 * and handed to the arrangement.
 *
 * `rootOverrides` sets custom properties on `:root` before the modules load,
 * which is how a case proves the gain it pins is the one the modules read.
 */
function frameworkArrangement(
  cases: ArrangementCase[],
  opts: { rootOverrides?: Record<string, string>; arrangementMutation?: SourceMutation } = {},
): FrameworkArrangement[] {
  const input = cases.map((c) => {
    const { cards } = ours(c);
    // The browser's offsetHeight is the card's height rounded to a whole pixel.
    return { ...c, heights: cards.map((b) => Math.round(b.h)), rects: cards, controlsBottom: c.controlsBottom ?? STORY_TOP_CONTROLS_BOTTOM };
  });
  return drive<FrameworkArrangement[]>(
    [
      `for (const [k, v] of Object.entries(${JSON.stringify(opts.rootOverrides ?? {})})) {`,
      "  document.documentElement.style.setProperty(k, v);",
      "  const got = getComputedStyle(document.documentElement).getPropertyValue(k).trim();",
      "  if (got !== v) throw new Error(`override ${k} reads ${JSON.stringify(got)}, not ${v}`);",
      "}",
      `const ma = await import(${JSON.stringify(moduleUrl("media-arrangement.js", opts.arrangementMutation))});`,
      `const v = await import(${JSON.stringify(`file://${join(STORY_DIR, "video-layout.js")}`)});`,
      `const ic = await import(${JSON.stringify(`file://${join(STORY_DIR, "iiif-card.js")}`)});`,
      `const cp = await import(${JSON.stringify(`file://${join(STORY_DIR, "card-pool.js")}`)});`,
      `const fit = await import(${JSON.stringify(`file://${join(STORY_DIR, "card-fit.js")}`)});`,
      "const controls = ['btn-nav-back', 'share-button', 'step-counter'].map((name) => {",
      "  const el = document.createElement('div'); el.className = name; document.body.appendChild(el); return el;",
      "});",
      "const PROPS = ['--telar-audio-wave-top', '--telar-audio-wave-left', '--telar-audio-wave-width', '--telar-audio-controls-bottom'];",
      "const out = [];",
      "for (const [i, c] of input.entries()) {",
      "  state.layoutMode = await enterWindow(c.w, c.h, i);",
      "  state.isEmbed = false;",
      "  const bottoms = [c.controlsBottom - 10, c.controlsBottom, c.controlsBottom - 4];",
      "  controls.forEach((el, k) => { el.getBoundingClientRect = () => ({ x: 0, y: bottoms[k] - 30, left: 0, right: 40, top: bottoms[k] - 30, bottom: bottoms[k], width: 40, height: 30 }); });",
      "  const plate = document.createElement('div');",
      "  plate.dataset.cardType = c.type;",
      "  if (c.type !== 'audio') {",
      "    if (c.aspect === null) plate.dataset.videoLetterbox = 'true';",
      "    else plate.dataset.aspectRatio = String(c.aspect);",
      "  }",
      "  const cards = c.heights.map((h) => { const el = document.createElement('div'); Object.defineProperty(el, 'offsetHeight', { value: h }); return el; });",
      "  const eligible = state.layoutMode !== 'vertical';",
      `  const side = eligible ? fit.fitSideCards(cards, { W, H, peek: 1, fraction: ${SIDE_CARD_VIEWPORT_FRACTION}, activeIndex: 0 }) : null;`,
      "  const besideTop = side?.topOf ?? ((card) => cp.computeCardTop(H, card.offsetHeight, 0, 1));",
      "  const arrangement = ma.arrangeMediaScene(plate, cards, { W, H, eligible, besideTop, topBand: ma.measureTopBand(W, H) });",
      "  const tops = cards.map((el) => parseFloat(el.style.getPropertyValue('top')));",
      "  const below = ma.readBelow(plate);",
      "  const regions = c.rects.map((r) => ic.computeFocalTarget(0.5, 0.5, 1, 1000, 1000, r, ic._deriveCardPlacement(r, W, H)).region);",
      "  let video = null, letterbox = null, audio = null;",
      "  if (c.type === 'audio') {",
      "    const height = ma.placeAudioBelow(plate);",
      "    const [top, left, width, controlsBottom] = PROPS.map((p) => plate.style.getPropertyValue(p));",
      "    audio = { height, top, left, width, controlsBottom };",
      "  } else if (c.aspect === null) {",
      "    letterbox = v.computeVideoLetterboxRegion(W, H, below, ma.readTopBand(plate));",
      "  } else {",
      "    video = v.computeVideoLayout(W, H, c.aspect, below, ma.readTopBand(plate)).video;",
      "  }",
      "  out.push({ mode: state.layoutMode, arrangement, below, tops, regions, video, letterbox, audio });",
      "}",
      "console.log(JSON.stringify(out));",
    ],
    input,
  );
}

/** Every way the framework's arrangement differs from ours, one line each. */
function arrangementMismatches(cases: ArrangementCase[], results: FrameworkArrangement[]): string[] {
  const out: string[] = [];
  if (results.length !== cases.length) return [`${results.length} results for ${cases.length} cases`];
  results.forEach((r, i) => {
    const c = cases[i];
    const label = `${c.w}×${c.h} ${c.type} [${c.contents.join(", ")}]`;
    const { layout, below, cards } = ours(c);
    const expected = layout.mode === "vertical" ? null : below ? "below" : "beside";
    if (r.mode !== layout.mode) out.push(`${label}: mode ${r.mode}, ours ${layout.mode}`);
    if (r.arrangement !== expected) out.push(`${label}: ${r.arrangement}, ours ${expected}`);
    if (JSON.stringify(r.below) !== JSON.stringify(below)) {
      out.push(`${label}: below ${JSON.stringify(r.below)}, ours ${JSON.stringify(below)}`);
    }
    if (expected !== null) {
      r.tops.forEach((top, k) => {
        if (Math.abs(top - cards[k].y) >= 1e-3) out.push(`${label}: card ${k} top ${top}, ours ${cards[k].y}`);
      });
    }
    r.regions.forEach((region, k) => {
      const mine = regionOf(layout, c.w, c.h, { media: true, contentHeight: c.contents[k], below });
      if (!sameBox(mine, region)) out.push(`${label}: card ${k} region`);
    });
    const band = layout.mode === "vertical" ? 0 : mediaTopBand(c.w, c.h, c.controlsBottom);
    if (r.video) {
      const player = videoLayout(layout.mode, c.w, c.h, c.aspect as number, below, band).player;
      if (!sameBox(player, asBox(r.video))) out.push(`${label}: player`);
    }
    if (r.letterbox && !sameBox(videoLetterboxRegion(layout.mode, c.w, c.h, below, band), asBox(r.letterbox))) {
      out.push(`${label}: letterbox`);
    }
    if (r.audio) {
      const wave = below ? audioBelowLayout(c.w, c.h, below) : null;
      const drawn = wave
        ? { height: wave.wave.h, top: `${wave.wave.y}px`, left: `${wave.wave.x}px`, width: `${wave.wave.w}px`, controlsBottom: `${wave.controlsBottom}px` }
        : { height: null, top: "", left: "", width: "", controlsBottom: "" };
      if (JSON.stringify(r.audio) !== JSON.stringify(drawn)) {
        out.push(`${label}: waveform ${JSON.stringify(r.audio)}, ours ${JSON.stringify(drawn)}`);
      }
      if (wave && !sameBox(audioWaveformBox(layout.mode, c.w, c.h, below), wave.wave)) out.push(`${label}: waveform box`);
    }
  });
  return out;
}

/**
 * Pairs one pixel of card height apart across the gain, below first: the ratio
 * of the player's area below to beside, from `mediaCardBelow`'s own
 * arithmetic, is in each note. Short horizontal windows, whose card the height
 * widens, are arranged as any other; a window 480px high or less is vertical
 * and is not arranged.
 */
const ARRANGEMENT_CASES: ArrangementCase[] = [
  { w: 1440, h: 757, type: "youtube", aspect: 16 / 9, contents: [147, 90], note: "1.1524, below; the shorter card sits lower" },
  { w: 1440, h: 757, type: "youtube", aspect: 16 / 9, contents: [148], note: "1.1475, beside" },
  { w: 1440, h: 757, type: "google-drive", aspect: null, contents: [147], note: "unknown aspect, compared at 16:9: 1.1524, below" },
  { w: 1440, h: 757, type: "google-drive", aspect: null, contents: [148], note: "unknown aspect: 1.1475, beside" },
  { w: 1100, h: 900, type: "vimeo", aspect: 16 / 9, contents: [406], note: "1.1559, below" },
  { w: 1100, h: 900, type: "vimeo", aspect: 16 / 9, contents: [407], note: "1.1493, beside" },
  { w: 1280, h: 800, type: "youtube", aspect: 4 / 3, contents: [200], note: "4:3 keeps it beside, where 16:9 would put it below (1.41)" },
  { w: 1440, h: 757, type: "audio", aspect: null, contents: [333, 120], note: "1.1533, below" },
  { w: 1440, h: 757, type: "audio", aspect: null, contents: [334], note: "1.1489, beside" },
  { w: 1400, h: 560, type: "audio", aspect: null, contents: [252], note: "a 648px card, 1.1546, below" },
  { w: 1400, h: 560, type: "audio", aspect: null, contents: [253], note: "1.1476, beside" },
  { w: 1600, h: 520, type: "audio", aspect: null, contents: [222], note: "a 712px card, 1.1535, below" },
  { w: 1600, h: 520, type: "audio", aspect: null, contents: [223], note: "1.1461, beside" },
  { w: 1400, h: 560, type: "youtube", aspect: 16 / 9, contents: [52], note: "1.1516, below" },
  { w: 1400, h: 560, type: "youtube", aspect: 16 / 9, contents: [53], note: "1.1472, beside" },
  { w: 1400, h: 560, type: "youtube", aspect: 16 / 9, contents: [600], note: "past the 448px ceiling: no room above, beside" },
  { w: 1600, h: 520, type: "youtube", aspect: 16 / 9, contents: [60], note: "a short window, 0.8564, beside" },
  { w: 1381, h: 488, type: "youtube", aspect: 16 / 9, contents: [20], note: "the first band's first horizontal width, 1.2642, below" },
  { w: 900, h: 480, type: "youtube", aspect: 16 / 9, contents: [150], note: "vertical: not arranged" },
  { w: 1400, h: 480, type: "audio", aspect: null, contents: [176], note: "480px high, vertical: not arranged" },
  { w: 1380, h: 488, type: "youtube", aspect: 16 / 9, contents: [20], note: "inside the first band, vertical: not arranged" },
  { w: 1440, h: 757, type: "youtube", aspect: 16 / 9, contents: [100], controlsBottom: 70, note: "a lower top band, below" },
  { w: 1440, h: 757, type: "youtube", aspect: 16 / 9, contents: [120.4], note: "a height off the pixel grid, below: the top rounds" },
  { w: 1440, h: 757, type: "youtube", aspect: 16 / 9, contents: [147.5], note: "measured as 148, beside, where 147.5 would be below" },
  { w: 1440, h: 757, type: "youtube", aspect: 16 / 9, contents: [900], note: "at the 605px ceiling, beside" },
  { w: 1440, h: 757, type: "youtube", aspect: 16 / 9, contents: [100], controlsBottom: 70.6, note: "a controls edge off the pixel grid rounds into the band, below" },
];

describeWithFramework("media scenes, driven through the framework's media-arrangement.js", () => {
  it(
    "agrees on the arrangement, the card tops, the region, the player and the waveform",
    () => {
      const results = frameworkArrangement(ARRANGEMENT_CASES);
      expect(results.map((r) => r.arrangement)).toEqual([
        "below", "beside", "below", "beside", "below", "beside", "beside",
        "below", "beside", "below", "beside", "below", "beside", "below", "beside",
        "beside", "beside", "below", null, null, null, "below", "below", "beside", "beside", "below",
      ]);
      expect(arrangementMismatches(ARRANGEMENT_CASES, results)).toEqual([]);
    },
    FRAMEWORK_TIMEOUT_MS,
  );

  it(
    "disagrees on the cases that straddle the gain once the modules read another",
    () => {
      const flipped = (gain: string) =>
        arrangementMismatches(ARRANGEMENT_CASES, frameworkArrangement(ARRANGEMENT_CASES, {
          rootOverrides: { "--telar-media-below-gain": gain },
        }))
          .filter((m) => / (below|beside), ours (below|beside)$/.test(m));
      expect(flipped("0.16")).toEqual([
        "1440×757 youtube [147, 90]: beside, ours below",
        "1440×757 google-drive [147]: beside, ours below",
        "1100×900 vimeo [406]: beside, ours below",
        "1440×757 audio [333, 120]: beside, ours below",
        "1400×560 audio [252]: beside, ours below",
        "1600×520 audio [222]: beside, ours below",
        "1400×560 youtube [52]: beside, ours below",
      ]);
      expect(flipped("0.14")).toEqual([
        "1440×757 youtube [148]: below, ours beside",
        "1440×757 google-drive [148]: below, ours beside",
        "1100×900 vimeo [407]: below, ours beside",
        "1440×757 audio [334]: below, ours beside",
        "1400×560 audio [253]: below, ours beside",
        "1600×520 audio [223]: below, ours beside",
        "1400×560 youtube [53]: below, ours beside",
        "1440×757 youtube [147.5]: below, ours beside",
      ]);
    },
    FRAMEWORK_TIMEOUT_MS,
  );

  it(
    "disagrees once the top band loses its gutter",
    () => {
      const misses = arrangementMismatches(ARRANGEMENT_CASES, frameworkArrangement(ARRANGEMENT_CASES, {
        arrangementMutation: {
          from: "return Math.round(measureControlsBottom(TOP_CONTROLS)) + mediaPadding(W, H);",
          to: "return Math.round(measureControlsBottom(TOP_CONTROLS));",
          count: 1,
        },
      }));
      expect(misses.some((m) => m.startsWith("1440×757 youtube [147, 90]: below "))).toBe(true);
      expect(misses.some((m) => m.startsWith("1440×757 audio [333, 120]: below "))).toBe(true);
    },
    FRAMEWORK_TIMEOUT_MS,
  );

  it("reads the controls row it centres under the waveform from audio-layout.js", async () => {
    const source = readFileSync(join(STORY_DIR, "audio-layout.js"), "utf-8");
    expect(source).toContain(`export const AUDIO_CONTROLS_HEIGHT = ${AUDIO_CONTROLS_HEIGHT};`);
    expect(source).toContain(`export const AUDIO_CONTROLS_GAP = ${AUDIO_CONTROLS_GAP};`);
    expect(source).toContain(`const waveSideGap = readFraction('--telar-audio-wave-side-gap', ${AUDIO_WAVE_SIDE_GAP});`);
    expect(source).toContain("width: Math.round(W - sideCardRight(W) - W * waveSideGap),");
    expect(source).toContain("height: Math.round(H * audioHeightResize),");
    expect(pixels(declared(story(), [LAYER, ".audio-controls"], "gap"))).toBe(AUDIO_CONTROLS_BUTTON_GAP);
    expect(pixels(declared(story(), [LAYER, ".audio-btn"], "height"))).toBe(AUDIO_CONTROLS_HEIGHT);
  });

  it("reads the controls' icons from audio-card.js and the elapsed readout from _story.scss", () => {
    const card = readFileSync(join(STORY_DIR, "audio-card.js"), "utf-8");
    for (const icon of ["play", "pause"]) expect(card).toContain(`_svg("${icon}", ${AUDIO_PLAY_ICON})`);
    for (const icon of ["rotate-ccw", "volume-2", "volume-x"]) expect(card).toContain(`_svg("${icon}", ${AUDIO_CONTROL_ICON})`);
    const elapsed = [LAYER, ".audio-elapsed"];
    expect(pixels(declared(story(), elapsed, "right"))).toBe(AUDIO_ELAPSED.right);
    expect(rems(declared(story(), elapsed, "font-size"))).toBeCloseTo(AUDIO_ELAPSED.fontSize, 9);
    const [py, px] = declared(story(), elapsed, "padding").split(" ").map(rems);
    expect(py).toBeCloseTo(AUDIO_ELAPSED.paddingY, 9);
    expect(px).toBeCloseTo(AUDIO_ELAPSED.paddingX, 9);
    expect(pixels(declared(story(), elapsed, "border-radius"))).toBe(AUDIO_ELAPSED.radius);
    // With the card below, the readout's bottom is the controls row's.
    expect(
      declared(story(), [LAYER, '.viewer-plate.audio-plate[data-media-arrangement="below"]', ".audio-elapsed"], "bottom"),
    ).toBe("var(--telar-audio-controls-bottom)");
  });
});

describe("the parity gate's required mode", () => {
  it("runs with the checkout, skips without it, and fails without it when required", () => {
    expect(frameworkBlockMode(true, {})).toBe("run");
    expect(frameworkBlockMode(true, { [PARITY_REQUIRED_ENV]: "1" })).toBe("run");
    expect(frameworkBlockMode(false, {})).toBe("skip");
    expect(frameworkBlockMode(false, { [PARITY_REQUIRED_ENV]: "0" })).toBe("skip");
    expect(frameworkBlockMode(false, { [PARITY_REQUIRED_ENV]: "1" })).toBe("fail");
  });
});

describeWithFramework("the stage colours against _data/themes/*.yml", () => {
  it("carries every shipped theme's heading, body, button and panel colours", () => {
    const files = readdirSync(THEMES_DIR).filter((f) => f.endsWith(".yml"));
    expect(files.map((f) => f.replace(/\.yml$/, "")).sort()).toEqual(Object.keys(STAGE_THEME_COLOURS).sort());
    for (const file of files) {
      const theme = yaml.load(readFileSync(join(THEMES_DIR, file), "utf-8")) as {
        colors: { text: Record<string, string>; background: Record<string, string> };
      };
      const { text, background } = theme.colors;
      expect(STAGE_THEME_COLOURS[file.replace(/\.yml$/, "")], file).toEqual({
        heading: text.heading,
        body: text.body,
        link: text.link,
        buttonText: text.button,
        buttonBg: background.button,
        panelLayer1Text: text.panel_layer1,
        panelLayer1Bg: background.panel_layer1,
        panelLayer2Text: text.panel_layer2,
        panelLayer2Bg: background.panel_layer2,
      });
    }
  });
});
