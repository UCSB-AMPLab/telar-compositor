/**
 * The side card on a horizontal layout, in `app/lib/framing-stage.ts`, against
 * the framework's `card-fit.js`, which sizes and places the published card.
 *
 * The framework's modules are imported into a jsdom document, as
 * `framing-stage-parity.test.ts` does: `sideCardWidth` for the card's width,
 * and `fitSideCards` with the three top controls placed at the case's edge and
 * a card whose `offsetHeight` is the height the Compositor gives it. Each case
 * that pins a rule is also run against a copy of the framework module with
 * that rule changed, and must then disagree.
 *
 * @version v1.5.0-beta
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";

import {
  SIDE_CARD_VIEWPORT_FRACTION,
  PHONE_TOP_CONTROLS_BOTTOM,
  STORY_TOP_CONTROLS_BOTTOM,
  cardBox,
  ceilingBox,
  sideCardWidthPx,
  visitorLayout,
} from "~/lib/framing-stage";
import {
  describeWithRequiredFramework as describeWithFramework,
  FRAMEWORK_SCRIPTS_DIR,
  FRAMEWORK_TIMEOUT_MS,
} from "./helpers/framework-checkout";
import { jsdomPrelude } from "./helpers/framework-jsdom";

const FRAMEWORK_DIR = join(FRAMEWORK_SCRIPTS_DIR, "..");
const STORY_DIR = join(FRAMEWORK_DIR, "assets", "js", "telar-story");

/** A `$telar-*` variable from `_responsive.scss`, as declared. */
function responsiveVar(name: string): string {
  const source = readFileSync(join(FRAMEWORK_DIR, "_sass", "_responsive.scss"), "utf-8");
  const m = new RegExp(`^\\${name}:\\s*([^;]+);`, "m").exec(source);
  if (!m) throw new Error(`_responsive.scss declares no ${name}`);
  return m[1].trim();
}

/** A textual change to a framework module, applied `count` times, to prove a case can fail. */
interface FitMutation {
  file: string;
  from: string;
  to: string;
  count: number;
}

/**
 * The URL to import `file` from: the module itself, or a copy with the
 * mutation applied, whose relative imports point back at the checkout.
 */
function fitModuleUrl(file: string, mutation?: FitMutation): string {
  const path = join(STORY_DIR, file);
  if (!mutation || mutation.file !== file) return `file://${path}`;
  const parts = readFileSync(path, "utf-8").split(mutation.from);
  if (parts.length - 1 !== mutation.count) {
    throw new Error(`${file}: ${mutation.from} occurs ${parts.length - 1} times, not ${mutation.count}`);
  }
  const mutated = parts
    .join(mutation.to)
    .replace(/from (['"])(\.\.?\/[^'"]+)\1/g, (_, q, rel) => `from ${q}file://${join(dirname(path), rel)}${q}`);
  return `data:text/javascript;base64,${Buffer.from(mutated).toString("base64")}`;
}

/** Run `body` in a jsdom document carrying the stylesheet's custom properties, and parse its last line. */
function driveFit<T>(body: string[], input: unknown): T {
  const vars = {
    "--telar-card-landscape-max-height": responsiveVar("$telar-card-landscape-max-height"),
    "--telar-video-pad-factor": responsiveVar("$telar-video-pad-factor"),
  };
  const rootVars = Object.entries(vars).map(([k, v]) => `${k}: ${v};`).join(" ");
  const script = [
    ...jsdomPrelude({ head: `<style>:root { ${rootVars} }</style>`, sizedWindow: true }),
    "const input = JSON.parse(process.argv[1]);",
    ...body,
  ].join("\n");
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(input)], {
    encoding: "utf-8",
    timeout: FRAMEWORK_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out.trim().split("\n").at(-1) as string) as T;
}

// ── The width ───────────────────────────────────────────────────────────────

/** The width `sideCardWidth` gives each window, from the :root terms. */
function frameworkWidths(windows: Array<[number, number]>, mutation?: FitMutation): number[] {
  const terms = ["min-share", "max-share", "base", "slope", "max-by-height"];
  return driveFit<number[]>(
    [
      ...terms.map((t) => `document.documentElement.style.setProperty('--telar-card-side-${t}', ${JSON.stringify(responsiveVar(`$telar-card-side-${t}`))});`),
      `const fit = await import(${JSON.stringify(fitModuleUrl("card-fit.js", mutation))});`,
      "console.log(JSON.stringify(input.map(([w, h]) => fit.sideCardWidth(w, h))));",
    ],
    windows,
  );
}

/** Every window the Compositor reads as horizontal, 1025 to 3000 wide and 481 to 1400 high, in steps of 7 and 3. */
const WIDTH_SWEEP: Array<[number, number]> = Array.from({ length: 283 }, (_, i) => 1025 + 7 * i)
  .flatMap((w) => Array.from({ length: 307 }, (_, k) => [w, 481 + 3 * k] as [number, number]))
  .filter(([w, h]) => visitorLayout(w, h).mode === "horizontal");

/** Where our width differs from the framework's, one line each. */
function widthMismatches(windows: Array<[number, number]>, theirs: number[]): string[] {
  return windows.flatMap(([w, h], i) => {
    const ours = cardBox(visitorLayout(w, h), w, h, { contentHeight: 100 }).w;
    return ours === theirs[i] && sideCardWidthPx(w, h) === ours ? [] : [`${w}×${h}: ${theirs[i]}, ours ${ours}`];
  });
}

describeWithFramework("the side card's width, driven through card-fit.js", () => {
  it("agrees on the width at every horizontal window of the sweep", () => {
    const theirs = frameworkWidths(WIDTH_SWEEP);
    expect(theirs).toHaveLength(WIDTH_SWEEP.length);
    // The sweep reaches the 37% floor, the line and its 718px cap. The 52%
    // cap holds nowhere on a horizontal layout: the short-window bands make
    // each window where it would vertical.
    expect(theirs.some((x, i) => x === Math.round(0.37 * WIDTH_SWEEP[i][0]))).toBe(true);
    expect(theirs.some((x, i) => x > Math.round(0.37 * WIDTH_SWEEP[i][0]) && x < 718)).toBe(true);
    expect(theirs).toContain(718);
    expect(theirs.every((x, i) => x < 0.52 * WIDTH_SWEEP[i][0])).toBe(true);
    expect(widthMismatches(WIDTH_SWEEP, theirs)).toEqual([]);
  }, FRAMEWORK_TIMEOUT_MS);

  it("disagrees once the framework drops the height's 718px cap or the 37% floor", () => {
    // 1600×482: the line is 772.8, held to 718; 1920×600: the line is 584,
    // under 37% of the width, 710.4.
    const windows: Array<[number, number]> = [[1600, 482], [1920, 600]];
    expect(widthMismatches(windows, frameworkWidths(windows))).toEqual([]);
    expect(widthMismatches(windows, frameworkWidths(windows, {
      file: "card-fit.js",
      from: "const byHeight = Math.min(maxByHeight, base - slope * H);",
      to: "const byHeight = base - slope * H;",
      count: 1,
    }))).toEqual(["1600×482: 773, ours 718"]);
    expect(widthMismatches(windows, frameworkWidths(windows, {
      file: "card-fit.js",
      from: "Math.max(minShare * W, byHeight)",
      to: "byHeight",
      count: 1,
    }))).toEqual(["1920×600: 584, ours 710"]);
  }, FRAMEWORK_TIMEOUT_MS);
});

// ── The ceiling and the top ─────────────────────────────────────────────────

/** A horizontal window, the card's height there, and the top controls' lowest edge. */
interface SideCase {
  w: number;
  h: number;
  cardH: number;
  controlsBottom: number;
}

interface FrameworkSide {
  ceiling: number;
  maxHeight: string;
  top: number;
}

/** Back to Start, Share and the step counter as boxes the framework measures. */
const CONTROLS_SETUP = [
  "const controls = ['btn-nav-back', 'share-button', 'step-counter'].map((name) => {",
  "  const el = document.createElement('div'); el.className = name; document.body.appendChild(el); return el;",
  "});",
];

/** Size the window to a case and end the three controls at its edge, one of them lower than the others. */
const PLACE_CONTROLS = [
  "  W = c.w; H = c.h;",
  "  const bottoms = [c.controlsBottom - 10, c.controlsBottom, c.controlsBottom - 4];",
  "  controls.forEach((el, k) => { el.getBoundingClientRect = () => ({ x: 0, y: bottoms[k] - 30, left: 0, right: 40, top: bottoms[k] - 30, bottom: bottoms[k], width: 40, height: 30 }); });",
];

/**
 * Place each case's card through `fitSideCards`, with Back to Start, Share and
 * the step counter ending at the case's edge (one of them lower than the
 * others) and no embed banner, as on a story page in the editor's preview.
 */
function frameworkSideCards(cases: SideCase[], mutation?: FitMutation): FrameworkSide[] {
  return driveFit<FrameworkSide[]>(
    [
      `const fit = await import(${JSON.stringify(fitModuleUrl("card-fit.js", mutation))});`,
      ...CONTROLS_SETUP,
      "const out = [];",
      "for (const c of input) {",
      ...PLACE_CONTROLS,
      "  const card = document.createElement('div');",
      "  Object.defineProperty(card, 'offsetHeight', { value: c.cardH });",
      "  document.body.appendChild(card);",
      `  const side = fit.fitSideCards([card], { W, H, peek: 1, fraction: ${SIDE_CARD_VIEWPORT_FRACTION}, activeIndex: 0 });`,
      "  out.push({ ceiling: side.ceiling, maxHeight: card.style.maxHeight, top: parseFloat(card.style.getPropertyValue('top')) });",
      "  card.remove();",
      "}",
      "console.log(JSON.stringify(out));",
    ],
    cases,
  );
}

/** Our side card for a case: its ceiling, and its box for a card of `contentHeight`. */
function ourSide(w: number, h: number, contentHeight: number, controlsBottom: number) {
  const layout = visitorLayout(w, h);
  const ceiling = ceilingBox(layout, w, h, { topControlsBottom: controlsBottom });
  const card = cardBox(layout, w, h, { contentHeight, topControlsBottom: controlsBottom });
  return { layout, ceiling, card };
}

/** For each window, a card at the ceiling, one 50px short of it, and a short one. */
function sideCases(windows: Array<[number, number]>, controlsBottom: number): SideCase[] {
  return windows.flatMap(([w, h]) => {
    const { ceiling } = ourSide(w, h, 0, controlsBottom);
    const full = ceiling?.h ?? 0;
    return [full + 500, full - 50, 100].map((content) => ({
      w,
      h,
      controlsBottom,
      cardH: ourSide(w, h, content, controlsBottom).card.h,
    }));
  });
}

/** Every way the framework's ceiling and top differ from ours, one line each. */
function sideMismatches(cases: SideCase[], results: FrameworkSide[]): string[] {
  if (results.length !== cases.length) return [`${results.length} results for ${cases.length} cases`];
  const out: string[] = [];
  results.forEach((r, i) => {
    const c = cases[i];
    const label = `${c.w}×${c.h} card ${c.cardH} under ${c.controlsBottom}`;
    const { ceiling, card } = ourSide(c.w, c.h, c.cardH, c.controlsBottom);
    if (ceiling?.h !== r.ceiling) out.push(`${label}: ceiling ${r.ceiling}, ours ${ceiling?.h}`);
    if (r.maxHeight !== `${r.ceiling}px`) out.push(`${label}: max-height ${r.maxHeight}`);
    if (Math.abs(card.y - r.top) >= 1e-6) out.push(`${label}: top ${r.top}, ours ${card.y}`);
  });
  return out;
}

/**
 * Every height from 300 to 1200 at three widths, kept where the Compositor
 * reads a horizontal layout; the region test in `framing-stage-parity.test.ts`
 * holds that reading to the framework's at every band's corner.
 */
const SWEEP: Array<[number, number]> = [1100, 1280, 1920]
  .flatMap((w) => Array.from({ length: 901 }, (_, k) => [w, 300 + k] as [number, number]))
  .filter(([w, h]) => visitorLayout(w, h).mode === "horizontal");

describeWithFramework("the side card's ceiling and top, driven through card-fit.js", () => {
  it("gives the design's worked ceilings at 1920 wide under controls ending at 54px", () => {
    // From 481px high a window this wide is horizontal; at 480 and below it is
    // a vertical layout whose side card takes the same ceiling from the band.
    expect(STORY_TOP_CONTROLS_BOTTOM).toBe(54);
    const heights = [400, 450, 480, 481, 500, 502, 505, 560, 720];
    const ours = heights.map((h) => ourSide(1920, h, 0, STORY_TOP_CONTROLS_BOTTOM).ceiling?.h);
    expect(ours).toEqual([325, 372, 401, 401, 401, 401, 404, 448, 576]);
    const theirs = frameworkSideCards(heights.map((h) => ({ w: 1920, h, cardH: 100, controlsBottom: 54 })));
    expect(theirs.map((r) => r.ceiling)).toEqual(ours);
  }, FRAMEWORK_TIMEOUT_MS);

  it("agrees on the ceiling and the card's top at every height from 300 to 1200", () => {
    for (const controlsBottom of [STORY_TOP_CONTROLS_BOTTOM, 70.6]) {
      const cases = sideCases(SWEEP, controlsBottom);
      expect(sideMismatches(cases, frameworkSideCards(cases))).toEqual([]);
    }
  }, FRAMEWORK_TIMEOUT_MS);

  it("holds the card under the controls' band and one gutter above the bottom at 1300×450", () => {
    // pad = round(450 × 0.025) = 11; band = 54 + 11 = 65; ceiling 372, whose
    // centred top (450 − 372) / 2 = 39 is under the band, so it goes to 65, and
    // its bottom, 437, stays one gutter above the window's.
    const { card, ceiling } = ourSide(1300, 450, 5000, 54);
    expect(ceiling).toMatchObject({ y: 65, h: 372 });
    expect(card).toMatchObject({ y: 65, h: 372 });
    expect(ourSide(1300, 450, 330, 54).card.y).toBe(65);
    // A short card stays centred: (450 − 100) / 2 = 175.
    expect(ourSide(1300, 450, 100, 54).card.y).toBe(175);
  });

  it("disagrees once the ceiling loses its floor at the threshold's room", () => {
    // Horizontal windows just above the threshold, wider than every band.
    const cases = sideCases([[3000, 489], [3000, 500]], 54);
    expect(cases.every((c) => visitorLayout(c.w, c.h).mode === "horizontal")).toBe(true);
    const misses = sideMismatches(cases, frameworkSideCards(cases, {
      file: "card-fit.js",
      from: "Math.max(fraction * H, room(T))",
      to: "fraction * H",
      count: 1,
    }));
    expect(misses).toContain("3000×489 card 401 under 54: ceiling 391, ours 401");
    expect(misses).toContain("3000×500 card 401 under 54: ceiling 400, ours 401");
  }, FRAMEWORK_TIMEOUT_MS);

  it("disagrees once the card's top is no longer held under the band", () => {
    const cases = sideCases([[1300, 450]], 54);
    const misses = sideMismatches(cases, frameworkSideCards(cases, {
      file: "card-fit.js",
      from: "return Math.max(band, Math.min(centred, H - pad - cardH));",
      to: "return centred;",
      count: 1,
    }));
    // Centred, the tall card's top is 39 and the shorter one's 64, both under
    // the band at 65; the 100px card is centred at 175 either way.
    expect(misses).toEqual([
      "1300×450 card 372 under 54: top 39, ours 65",
      "1300×450 card 322 under 54: top 64, ours 65",
    ]);
  }, FRAMEWORK_TIMEOUT_MS);
});

// ── A phone held sideways ───────────────────────────────────────────────────

/**
 * Place each case's card as `card-pool.js` places a phone held sideways:
 * `sideCardBand` for the ceiling and the band, `sideCardTop` for the top.
 */
function frameworkPhoneCards(cases: SideCase[], mutation?: FitMutation): FrameworkSide[] {
  return driveFit<FrameworkSide[]>(
    [
      `const fit = await import(${JSON.stringify(fitModuleUrl("card-fit.js", mutation))});`,
      ...CONTROLS_SETUP,
      "const out = [];",
      "for (const c of input) {",
      ...PLACE_CONTROLS,
      `  const b = fit.sideCardBand({ W, H, fraction: ${SIDE_CARD_VIEWPORT_FRACTION} });`,
      "  const top = fit.sideCardTop({ H, cardH: c.cardH, scenePos: 0, runPos: 0, peek: 1, band: b.band, pad: b.pad });",
      "  out.push({ ceiling: b.ceiling, maxHeight: `${b.ceiling}px`, top });",
      "}",
      "console.log(JSON.stringify(out));",
    ],
    cases,
  );
}

/** Phones held sideways, wide ones and narrow ones, and a square window. */
const PHONES: Array<[number, number]> = [[932, 430], [844, 390], [667, 375], [568, 320], [481, 480]];

describeWithFramework("a phone held sideways, driven through sideCardBand and sideCardTop", () => {
  it("is a vertical layout with a side card, wider than it is tall", () => {
    for (const [w, h] of PHONES) {
      const layout = visitorLayout(w, h);
      expect(layout, `${w}×${h}`).toEqual({ mode: "vertical", cardPlacement: "side" });
    }
  });

  it("agrees on the ceiling and the card's top for a long card, a card at the ceiling and a short one", () => {
    for (const controlsBottom of [STORY_TOP_CONTROLS_BOTTOM, PHONE_TOP_CONTROLS_BOTTOM]) {
      const cases = sideCases(PHONES, controlsBottom);
      expect(sideMismatches(cases, frameworkPhoneCards(cases))).toEqual([]);
    }
  }, FRAMEWORK_TIMEOUT_MS);

  it("gives 309 high at 844×390, from a top of 70: the controls at 60 and a 10px gutter", () => {
    const { ceiling, card } = ourSide(844, 390, 5000, PHONE_TOP_CONTROLS_BOTTOM);
    expect(ceiling).toMatchObject({ y: 70, h: 309 });
    expect(card).toMatchObject({ y: 70, h: 309 });
  });

  it("disagrees once the band under the controls loses its gutter", () => {
    const cases = sideCases([[844, 390]], 54);
    const misses = sideMismatches(cases, frameworkPhoneCards(cases, {
      file: "card-fit.js",
      from: "band: C + pad",
      to: "band: C",
      count: 1,
    }));
    expect(misses.length).toBeGreaterThan(0);
  }, FRAMEWORK_TIMEOUT_MS);

  it("keeps a short portrait window's card centred under the stylesheet's cap, which the phone band leaves alone", () => {
    const layout = visitorLayout(320, 480);
    expect(layout).toEqual({ mode: "vertical", cardPlacement: "side" });
    expect(ceilingBox(layout, 320, 480)?.h).toBe(480 - 32);
    expect(cardBox(layout, 320, 480, { contentHeight: 100 }).y).toBe(190);
  });
});
