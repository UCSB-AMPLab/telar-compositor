/**
 * The editor's chrome on the framing stage never overlaps itself: at a
 * desktop window, a phone in portrait (390×844 and 360×740) and a phone held
 * sideways (844×390), every piece the stage shows for an image step is placed
 * by `layoutStageChrome` clear of every other, and inside the stage.
 *
 * jsdom lays nothing out, so a label's height is modelled here as the stage
 * measures it: the text's width at 11px wrapped to the width the layout gives
 * it, laid out again until the widths settle, as the stage's measuring does.
 * The other pieces take the sizes they are drawn at. The stage and region come
 * from framing-stage.ts, for the content area the editor leaves at each window.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { cardBox, ceilingBox, mediaCardBelow, regionOf, stageRect, visitorLayout, type Box } from "~/lib/framing-stage";
import { frameInRegion } from "~/lib/authoring-frame";
import { stageBox } from "~/components/features/editor/FramingStage";
import {
  CHROME_DEFAULTS,
  chromeCollisions,
  chromeIsCompact,
  layoutStageChrome,
  type ChromeInput,
  type ChromeLayout,
  type ChromeSizes,
} from "~/lib/stage-chrome";

/** A label's text width at 11px, in pixels, for the Spanish strings (the longer). */
const TEXT = { frameLabel: 290, stageLabel: 500, ceilingLabel: 330 } as const;
const LINE = 15;
const PAD = 8;

/** A label's size at the width the layout gave it, as the browser would wrap it. */
function wrapped(text: number, width: number) {
  const inner = Math.max(1, width - 16);
  return { w: Math.min(text + 16, width), h: Math.ceil(text / inner) * LINE + PAD };
}

interface Case {
  win: { w: number; h: number };
  content: { w: number; h: number };
  media?: "video";
}

function inputFor({ win, content, media }: Case, sizes: ChromeSizes): ChromeInput {
  const stage = stageRect(content, win)!;
  const layout = visitorLayout(win.w, win.h);
  const s = stage.scale;
  const below = media ? mediaCardBelow(layout, win.w, win.h, { kind: "video", tallestContentHeight: 147 }) : null;
  const region = stageBox(regionOf(layout, win.w, win.h, { media: !!media, below }), s);
  const f = frameInRegion(region);
  const ceiling = below ? null : ceilingBox(layout, win.w, win.h, { media: !!media });
  return {
    stage: { w: stage.w, h: stage.h },
    region,
    frame: { x: f.x, y: f.y, w: f.width, h: f.height },
    card: stageBox(cardBox(layout, win.w, win.h, { media: !!media, contentHeight: 147, below }), s),
    cardPlacement: layout.cardPlacement,
    below: !!below,
    ceiling: ceiling ? stageBox(ceiling, s) : null,
    show: {
      viewfinder: !media,
      labels: !media,
      ceilingLabel: !!ceiling,
      zoom: !media,
      bar: true,
      chip: !media,
      counter: true,
    },
    sizes,
  };
}

/** The layout once every label has been measured at the width it was given. */
function settled(c: Case, textScale = 1): { input: ChromeInput; layout: ChromeLayout } {
  const text = (part: keyof typeof TEXT) => TEXT[part] * textScale;
  const stage = stageRect(c.content, c.win)!;
  const region = stageBox(regionOf(visitorLayout(c.win.w, c.win.h), c.win.w, c.win.h), stage.scale);
  const compact = chromeIsCompact(region.w);
  let sizes: ChromeSizes = {
    ...CHROME_DEFAULTS,
    viewfinder: compact ? { w: 136, h: 32 } : { w: 170, h: 32 },
    hint: { w: 160, h: 40 },
    chip: compact ? { w: 36, h: 36 } : { w: 320, h: 36 },
    zoom: { w: 32, h: 104 },
    // The narrow bar lays itself out in two rows.
    bar: { w: 0, h: region.w < 576 ? 80 : 40 },
    frameLabel: wrapped(text("frameLabel"), 240),
    stageLabel: wrapped(text("stageLabel"), 260),
    ceilingLabel: wrapped(text("ceilingLabel"), 300),
  };
  let input = inputFor(c, sizes);
  let layout = layoutStageChrome(input);
  for (let i = 0; i < 5; i++) {
    const next = { ...sizes };
    for (const part of ["frameLabel", "stageLabel", "ceilingLabel"] as const) {
      const box = layout[part];
      if (box) next[part] = wrapped(text(part), box.w);
    }
    sizes = next;
    input = inputFor(c, sizes);
    layout = layoutStageChrome(input);
  }
  return { input, layout };
}

function inside(box: Box, area: { w: number; h: number }) {
  return box.x >= 0 && box.y >= 0 && box.x + box.w <= area.w + 1e-9 && box.y + box.h <= area.h + 1e-9;
}

const CASES: Array<[string, Case]> = [
  ["1440×900", { win: { w: 1440, h: 900 }, content: { w: 1240, h: 768 } }],
  ["1440×757", { win: { w: 1440, h: 757 }, content: { w: 1240, h: 625 } }],
  ["390×844 portrait", { win: { w: 390, h: 844 }, content: { w: 390, h: 712 } }],
  ["360×740 portrait", { win: { w: 360, h: 740 }, content: { w: 360, h: 608 } }],
  ["844×390 sideways", { win: { w: 844, h: 390 }, content: { w: 844, h: 310 } }],
  ["1440×900, a video's card below its player", { win: { w: 1440, h: 757 }, content: { w: 1240, h: 625 }, media: "video" }],
];

describe("the stage's chrome", () => {
  for (const [label, c] of CASES) {
    it(`overlaps nothing, inside the stage, at ${label}`, () => {
      const { input, layout } = settled(c);
      expect(chromeCollisions(layout)).toEqual([]);
      for (const [part, box] of Object.entries(layout)) {
        expect(inside(box, input.stage), `${part} inside the stage`).toBe(true);
        expect(box.w, `${part} has a width`).toBeGreaterThan(0);
      }
    });
  }

  it("keeps the frame label inside the frame, under the top bar", () => {
    for (const [, c] of CASES.filter(([, x]) => !x.media)) {
      const { input, layout } = settled(c);
      const label = layout.frameLabel!;
      expect(label.y).toBeGreaterThanOrEqual(layout.topBar.y + layout.topBar.h);
      expect(label.x).toBeGreaterThanOrEqual(input.frame.x);
      expect(label.y).toBeGreaterThanOrEqual(input.frame.y);
    }
  });

  it("keeps the stage label at the stage's bottom-left beside a side card, and under the frame label in portrait", () => {
    const desk = settled(CASES[0][1]);
    const sl = desk.layout.stageLabel!;
    expect(sl.y + sl.h).toBeCloseTo(desk.input.stage.h - 12, 9);
    expect(sl.x).toBeLessThan(desk.input.region.x);
    const phone = settled(CASES[2][1]);
    expect(phone.layout.stageLabel!.y).toBeGreaterThan(phone.layout.frameLabel!.y + phone.layout.frameLabel!.h);
  });

  it("starts the bottom-left stage label at the margin once the word count has moved up", () => {
    const { input } = settled(CASES[0][1]);
    const layout = layoutStageChrome({ ...input, show: { ...input.show, counterUp: true } });
    expect(layout.counter!.y).toBeLessThan(layout.stageLabel!.y);
    expect(layout.stageLabel!.x).toBe(12);
  });

  it("puts the word count on the card's top edge in portrait, and inside the stage when the card is below its player", () => {
    const phone = settled(CASES[2][1]);
    expect(phone.layout.counter!.y + phone.layout.counter!.h).toBeCloseTo(phone.input.card.y - 6, 9);
    const video = settled(CASES[5][1]);
    expect(video.input.below).toBe(true);
    expect(inside(video.layout.counter!, video.input.stage)).toBe(true);
    expect(video.layout.ceilingLabel).toBeUndefined();
  });
});

/** The content area the editor leaves at a window: the chrome above, the step list at lg and wider. */
function contentFor(win: { w: number; h: number }) {
  return { w: win.w - (win.w >= 1024 ? 200 : 0), h: win.h - 132 };
}

describe("the stage's chrome at every window", () => {
  it("overlaps nothing, stays inside the stage and keeps every control, from 320×480 to 2560×1440, with and without a card below, with long labels", () => {
    const failures: string[] = [];
    const countLeftOut = new Set<string>();
    let checked = 0;
    for (let w = 320; w <= 2560; w += 80) {
      for (let h = 480; h <= 1440; h += 80) {
        for (const [win, label] of [[{ w, h }, "landscape"], [{ w: h, h: w }, "portrait"]] as const) {
          if (win.w < 320 || win.h < 480 || win.w > 2560 || win.h > 2560) continue;
          for (const media of [undefined, "video"] as const) {
            for (const textScale of [1, 2.5]) {
              const c: Case = { win, content: contentFor(win), media };
              if (!stageRect(c.content, c.win)) continue;
              const { input, layout } = settled(c, textScale);
              checked += 1;
              const where = `${win.w}×${win.h} ${label}${media ? " video" : ""}${input.below ? " below" : ""} ×${textScale}`;
              for (const [a, b] of chromeCollisions(layout)) failures.push(`${where}: ${a} meets ${b}`);
              for (const [part, box] of Object.entries(layout)) {
                if (!inside(box, input.stage)) failures.push(`${where}: ${part} outside the stage`);
                if (!(box.w > 0 && box.h > 0)) failures.push(`${where}: ${part} has no area`);
              }
              const controls = media ? ["topBar", "bar"] : ["topBar", "bar", "viewfinder", "zoom", "chip"];
              for (const part of controls) if (!(part in layout)) failures.push(`${where}: ${part} left out`);
              if (!layout.counter) countLeftOut.add(`${win.w}×${win.h}${media ? " video" : ""}`);
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(failures.slice(0, 20)).toEqual([]);
    // Only where the stage is too narrow for the count beside the Viewfinder, once every label has gone.
    expect([...countLeftOut].sort()).toEqual(["320×560", "400×560"]);
  });

  it("leaves out every label before the word count: 320×560 and 400×560", () => {
    for (const w of [320, 400]) {
      const c: Case = { win: { w, h: 560 }, content: contentFor({ w, h: 560 }) };
      const { layout } = settled(c);
      expect(layout.counter, `${w}: count left out`).toBeUndefined();
      for (const part of ["frameLabel", "stageLabel", "ceilingLabel", "hint"] as const) expect(layout[part], `${w}: ${part}`).toBeUndefined();
    }
  });

  it("moves the word count under the top bar, left of the Viewfinder, where the card's top edge has no room: 640×560", () => {
    const c: Case = { win: { w: 640, h: 560 }, content: { w: 640, h: 428 } };
    const { input, layout } = settled(c);
    expect(chromeCollisions(layout)).toEqual([]);
    expect(input.cardPlacement).toBe("bottom");
    expect(layout.counter!.y).toBeCloseTo(layout.topBar.y + layout.topBar.h + 8, 9);
    expect(layout.counter!.x + layout.counter!.w).toBeLessThan(layout.viewfinder!.x);
    expect(layout.counter!.w).toBe(220);
  });

  it("drops the labels, not the controls, where a phone's region has no room: 360×640", () => {
    const c: Case = { win: { w: 360, h: 640 }, content: { w: 360, h: 508 } };
    const { layout } = settled(c);
    expect(chromeCollisions(layout)).toEqual([]);
    expect(layout.bar).toBeDefined();
    expect(layout.zoom).toBeDefined();
    expect(layout.chip).toBeDefined();
    expect(layout.viewfinder).toBeDefined();
    expect(layout.counter).toBeDefined();
    expect(layout.stageLabel).toBeUndefined();
  });

  it("fits the compact row and the word count inside a 232px stage: 320×480", () => {
    const c: Case = { win: { w: 320, h: 480 }, content: { w: 320, h: 348 } };
    const { input, layout } = settled(c);
    expect(input.stage.w).toBeCloseTo(232, 0);
    for (const box of Object.values(layout)) expect(inside(box, input.stage)).toBe(true);
    for (const part of ["bar", "zoom", "chip", "viewfinder", "counter"] as const) expect(layout[part], part).toBeDefined();
    expect(layout.zoom!.x + layout.zoom!.w).toBeLessThanOrEqual(input.stage.w - 12 + 1e-9);
  });
});
