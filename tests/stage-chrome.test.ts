/**
 * The editor's chrome on the framing stage never overlaps itself: at a
 * desktop window, a phone in portrait (390×844 and 360×740) and a phone held
 * sideways (844×390), every piece the stage shows for an image step is placed
 * by `layoutStageChrome` clear of every other, and inside the stage, with any
 * one of the guide tags' sentences open. The tags sit on the guides they name,
 * and where there is no room the chrome leaves pieces out tier by tier: an
 * open sentence first, then the tags, then the word count, then the controls;
 * except that an open sentence is given room by the other tags and the word
 * count before it closes, opens in its fallback place under the top bar where
 * its own place still meets a control, and closes where that place does too.
 *
 * jsdom lays nothing out, so a sentence's height is modelled here as the stage
 * measures it: the text's width at 15px wrapped to the width the layout gives
 * it, laid out again until the widths settle, as the stage's measuring does.
 * The tags and the other pieces take the sizes they are drawn at. The stage
 * and region come from framing-stage.ts, for the content area the editor
 * leaves at each window.
 *
 * @version v1.5.2-beta
 */

import { describe, it, expect } from "vitest";
import { cardBox, ceilingBox, mediaCardBelow, regionOf, stageRect, visitorLayout, type Box } from "~/lib/framing-stage";
import { frameInRegion } from "~/lib/authoring-frame";
import { stageBox } from "~/components/features/editor/FramingStage";
import {
  CHROME_DEFAULTS,
  CHROME_DROP_TIERS,
  CHROME_MARGIN,
  GUIDE_TAG_PART,
  GUIDE_TEXT_PART,
  boxesMeet,
  chromeCollisions,
  chromeIsCompact,
  frameTagOnStroke,
  layoutStageChrome,
  sentenceStandsFree,
  type ChromeInput,
  type ChromeLayout,
  type ChromeSizes,
  type GuideTag,
} from "~/lib/stage-chrome";

/** A sentence's text width at 15px, in pixels, for the Spanish strings (the longer). */
const TEXT = { ceilingText: 430, frameText: 650, targetText: 400, stageText: 650 } as const;
const LINE = 22;
const PAD = 20;

/** The tags' sizes at full size, for the Spanish names, and in a compact region, icon only. */
const TAGS = { tagCeiling: { w: 200, h: 30 }, tagFrame: { w: 94, h: 30 }, tagTarget: { w: 103, h: 30 }, tagStage: { w: 160, h: 30 } };
const ICON = { w: 32, h: 32 };

/** A sentence's size at the width the layout gave it, as the browser would wrap it. */
function wrapped(text: number, width: number) {
  const inner = Math.max(1, width - 26);
  return { w: width, h: Math.ceil(text / inner) * LINE + PAD };
}

interface Case {
  win: { w: number; h: number };
  content: { w: number; h: number };
  media?: "video";
}

function inputFor({ win, content, media }: Case, sizes: ChromeSizes, open: GuideTag | null = null): ChromeInput {
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
      tags: !media,
      ceilingTag: !media && !!ceiling,
      open,
      zoom: !media,
      bar: true,
      chip: !media,
      counter: true,
    },
    sizes,
  };
}

/** The layout once every sentence has been measured at the width it was given. */
function settled(c: Case, textScale = 1, open: GuideTag | null = null): { input: ChromeInput; layout: ChromeLayout } {
  const text = (part: keyof typeof TEXT) => TEXT[part] * textScale;
  const stage = stageRect(c.content, c.win)!;
  const region = stageBox(regionOf(visitorLayout(c.win.w, c.win.h), c.win.w, c.win.h), stage.scale);
  const compact = chromeIsCompact(region.w);
  let sizes: ChromeSizes = {
    ...CHROME_DEFAULTS,
    viewfinder: compact ? { w: 136, h: 32 } : { w: 170, h: 32 },
    chip: compact ? { w: 36, h: 36 } : { w: 320, h: 36 },
    zoom: { w: 32, h: 104 },
    // The narrow bar lays itself out in two rows.
    bar: { w: 0, h: region.w < 576 ? 80 : 40 },
    ...(compact ? { tagCeiling: ICON, tagFrame: ICON, tagTarget: ICON, tagStage: ICON } : TAGS),
    ceilingText: wrapped(text("ceilingText"), 320),
    frameText: wrapped(text("frameText"), 320),
    targetText: wrapped(text("targetText"), 280),
    stageText: wrapped(text("stageText"), 320),
  };
  let input = inputFor(c, sizes, open);
  let layout = layoutStageChrome(input);
  for (let i = 0; i < 5; i++) {
    const next = { ...sizes };
    for (const part of Object.values(GUIDE_TEXT_PART)) {
      const box = layout[part];
      if (box) next[part] = wrapped(text(part), box.w);
    }
    sizes = next;
    input = inputFor(c, sizes, open);
    layout = layoutStageChrome(input);
  }
  return { input, layout };
}

function inside(box: Box, area: { w: number; h: number }) {
  return box.x >= 0 && box.y >= 0 && box.x + box.w <= area.w + 1e-9 && box.y + box.h <= area.h + 1e-9;
}

const right = (b: Box) => b.x + b.w;
const bottom = (b: Box) => b.y + b.h;

const GUIDES: GuideTag[] = ["ceiling", "frame", "target", "stage"];

const CASES: Array<[string, Case]> = [
  ["1440×900", { win: { w: 1440, h: 900 }, content: { w: 1240, h: 768 } }],
  ["1440×757", { win: { w: 1440, h: 757 }, content: { w: 1240, h: 625 } }],
  ["390×844 portrait", { win: { w: 390, h: 844 }, content: { w: 390, h: 712 } }],
  ["360×740 portrait", { win: { w: 360, h: 740 }, content: { w: 360, h: 608 } }],
  ["844×390 sideways", { win: { w: 844, h: 390 }, content: { w: 844, h: 310 } }],
  ["1440×900, a video's card below its player", { win: { w: 1440, h: 757 }, content: { w: 1240, h: 625 }, media: "video" }],
];

const DESK = CASES[0][1];
const PORTRAIT = CASES[2][1];
const SIDEWAYS = CASES[4][1];

describe("the stage's chrome", () => {
  for (const [label, c] of CASES) {
    for (const open of [null, ...GUIDES]) {
      it(`overlaps nothing, inside the stage, at ${label}${open ? `, the ${open} sentence open` : ""}`, () => {
        const { input, layout } = settled(c, 1, open);
        expect(chromeCollisions(layout)).toEqual([]);
        for (const [part, box] of Object.entries(layout)) {
          expect(inside(box, input.stage), `${part} inside the stage`).toBe(true);
          expect(box.w, `${part} has a width`).toBeGreaterThan(0);
        }
      });
    }
  }

  it("shows every tag, and each sentence when it is open, at a desktop window", () => {
    for (const open of GUIDES) {
      const { layout } = settled(DESK, 1, open);
      for (const kind of GUIDES) {
        expect(layout[GUIDE_TEXT_PART[kind]] !== undefined, `${kind} sentence with ${open} open`).toBe(kind === open);
      }
      for (const part of ["tagCeiling", "tagFrame", "tagTarget", "tagStage"] as const) expect(layout[part], part).toBeDefined();
    }
  });

  it("hangs the frame's tag inside the frame's top-left corner, flush to the stroke, its sentence directly under it", () => {
    // In portrait the frame starts below the top bar.
    const { input, layout } = settled(PORTRAIT, 1, "frame");
    expect(input.frame.y + 1).toBeGreaterThanOrEqual(bottom(layout.topBar));
    const tag = layout.tagFrame!;
    expect(tag.x).toBeCloseTo(input.frame.x + 1, 9);
    expect(tag.y).toBeCloseTo(input.frame.y + 1, 9);
    expect(frameTagOnStroke(tag, input.frame)).toBe(true);
    const text = layout.frameText!;
    expect(text.x).toBeCloseTo(tag.x, 9);
    expect(text.y).toBeCloseTo(bottom(tag), 9);
  });

  it("puts the frame's tag under the top bar, at the frame's left stroke, where the frame starts above the bar's bottom", () => {
    // At a desktop window the frame starts behind the top bar.
    const { input, layout } = settled(DESK, 1, "frame");
    expect(input.frame.y + 1).toBeLessThan(bottom(layout.topBar));
    expect(layout.tagFrame!.x).toBeCloseTo(input.frame.x + 1, 9);
    expect(layout.tagFrame!.y).toBeCloseTo(bottom(layout.topBar) + 8, 9);
    expect(frameTagOnStroke(layout.tagFrame, input.frame)).toBe(false);
    expect(layout.frameText!.w).toBe(320);
  });

  it("caps the frame's sentence at the room the Viewfinder leaves", () => {
    const { input } = settled(DESK, 1, "frame");
    // A frame pushed right, so its sentence would reach the Viewfinder's rows at full width.
    const layout = layoutStageChrome({ ...input, frame: { ...input.frame, x: right(input.region) - 12 - 170 - 8 - 200 } });
    const text = layout.frameText!;
    expect(text.y).toBeLessThan(bottom(layout.viewfinder!));
    expect(right(text)).toBeLessThanOrEqual(layout.viewfinder!.x - 8 + 1e-9);
    expect(text.w).toBeLessThan(320);
  });

  it("sits the ceiling's tag on the ceiling's top edge, its sentence 1px under the line, inside the ceiling", () => {
    const { input, layout } = settled(DESK, 1, "ceiling");
    const ceiling = input.ceiling!;
    const tag = layout.tagCeiling!;
    expect(tag.x).toBeCloseTo(ceiling.x, 9);
    expect(bottom(tag)).toBeCloseTo(ceiling.y, 9);
    const text = layout.ceilingText!;
    expect(text.x).toBeCloseTo(ceiling.x, 9);
    expect(text.y).toBeCloseTo(ceiling.y + 1, 9);
    expect(right(text)).toBeLessThanOrEqual(right(ceiling) + 1e-9);
  });

  it("puts the ceiling's tag inside the ceiling's top-left where there is no room above it", () => {
    const { input } = settled(SIDEWAYS, 1, "ceiling");
    const ceiling = { ...input.ceiling!, y: 10 };
    const layout = layoutStageChrome({ ...input, ceiling });
    const tag = layout.tagCeiling!;
    expect(tag.y).toBeCloseTo(ceiling.y + 1, 9);
    expect(tag.x).toBeCloseTo(ceiling.x + 1, 9);
    expect(layout.ceilingText!.y).toBeCloseTo(bottom(tag) + 1, 9);
  });

  it("shows no ceiling tag where no ceiling is drawn: a bottom card, a card below its player", () => {
    expect(settled(PORTRAIT).layout.tagCeiling).toBeUndefined();
    expect(settled(CASES[5][1]).layout.tagCeiling).toBeUndefined();
  });

  it("puts the centre's tag right of the centre target, its sentence 4px under it and 280px wide", () => {
    const { input, layout } = settled(DESK, 1, "target");
    const r = input.region;
    const tag = layout.tagTarget!;
    expect(tag.x).toBeCloseTo(r.x + r.w / 2 + 25, 9);
    expect(tag.y).toBeCloseTo(r.y + r.h / 2 - 15, 9);
    expect(layout.targetText!.y).toBeCloseTo(bottom(tag) + 4, 9);
    expect(layout.targetText!.w).toBe(280);
  });

  it("flips the centre's tag left of the target where it would meet the zoom column", () => {
    const { input } = settled(DESK);
    const r = input.region;
    const zoomX = settled(DESK).layout.zoom!.x;
    // Wide enough to reach the zoom column from the right of the target.
    const w = zoomX - (r.x + r.w / 2 + 25) - 4;
    const layout = layoutStageChrome({ ...input, sizes: { ...input.sizes, tagTarget: { w, h: 30 } } });
    expect(layout.zoom!.x).toBeCloseTo(zoomX, 9);
    expect(layout.tagTarget!.x).toBeCloseTo(r.x + r.w / 2 - 25 - w, 9);
    expect(chromeCollisions(layout)).toEqual([]);
    // One that clears the column by the gap stays on the right.
    const clear = layoutStageChrome({ ...input, sizes: { ...input.sizes, tagTarget: { w: w - 8, h: 30 } } });
    expect(clear.tagTarget!.x).toBeCloseTo(r.x + r.w / 2 + 25, 9);
  });

  it("puts the stage's tag flush in the stage's bottom-left corner beside a side card, its sentence stacked on it", () => {
    const { input, layout } = settled(DESK, 1, "stage");
    const tag = layout.tagStage!;
    expect(tag.x).toBe(0);
    expect(bottom(tag)).toBeCloseTo(input.stage.h, 9);
    const text = layout.stageText!;
    expect(text.x).toBe(0);
    expect(bottom(text)).toBeCloseTo(tag.y, 9);
    // Clear of the word count under the ceiling, and of the region.
    expect(right(text)).toBeLessThanOrEqual(Math.min(layout.counter!.x, input.region.x) - 8 + 1e-9);
  });

  it("puts the stage's tag beside the frame's where the bottom card covers the stage's corner", () => {
    const { layout } = settled(PORTRAIT, 1, "stage");
    const frame = layout.tagFrame!;
    const tag = layout.tagStage!;
    expect(tag.y).toBeCloseTo(frame.y, 9);
    expect(tag.x).toBeCloseTo(right(frame) + 8, 9);
    // Its sentence opens downward from the start of their row.
    expect(layout.stageText!.x).toBeCloseTo(frame.x, 9);
    expect(layout.stageText!.y).toBeCloseTo(bottom(tag) + 4, 9);
  });

  it("hangs the word count flush from the ceiling's bottom edge, right-aligned to it, beside a side card", () => {
    const { input, layout } = settled(DESK);
    const ceiling = input.ceiling!;
    expect(layout.counter!.w).toBe(220);
    expect(right(layout.counter!)).toBeCloseTo(right(ceiling), 9);
    expect(layout.counter!.y).toBeCloseTo(bottom(ceiling), 9);
  });

  it("puts the word count on the card's top edge in portrait, and inside the stage when the card is below its player", () => {
    const phone = settled(PORTRAIT);
    expect(phone.layout.counter!.y + phone.layout.counter!.h).toBeCloseTo(phone.input.card.y - 6, 9);
    const video = settled(CASES[5][1]);
    expect(video.input.below).toBe(true);
    expect(inside(video.layout.counter!, video.input.stage)).toBe(true);
  });

  it("shows no tag while the guides are hidden, and keeps the word count", () => {
    const { input } = settled(DESK, 1, "frame");
    const layout = layoutStageChrome({ ...input, show: { ...input.show, tags: false, ceilingTag: false } });
    for (const part of ["tagCeiling", "tagFrame", "tagTarget", "tagStage", "frameText"] as const) expect(layout[part], part).toBeUndefined();
    expect(layout.counter).toBeDefined();
  });
});

describe("what the chrome leaves out where there is no room", () => {
  it("leaves out, in order, the open sentence, then the tags stage, centre, ceiling, frame, then the word count, then the controls", () => {
    expect(CHROME_DROP_TIERS).toEqual([
      ["stageText", "targetText", "ceilingText", "frameText"],
      ["tagStage", "tagTarget", "tagCeiling", "tagFrame"],
      ["counter"],
      ["viewfinder", "chip", "zoom", "bar"],
    ]);
  });

  it("where two tags meet, leaves out the one earlier in the order: stage before centre, ceiling before frame, stage before frame", () => {
    const { input } = settled(DESK);
    // Tags wide enough to meet each other but not a control.
    const wide = { w: input.region.w * 0.7, h: 30 };
    const tags = ["tagStage", "tagTarget", "tagCeiling", "tagFrame"] as const;
    const left = (...meeting: Array<(typeof tags)[number]>) => {
      const sizes = { ...input.sizes, ...Object.fromEntries(meeting.map((part) => [part, wide])) };
      const layout = layoutStageChrome({ ...input, sizes });
      return tags.filter((part) => layout[part]);
    };
    expect(left("tagStage", "tagTarget")).toEqual(["tagTarget", "tagCeiling", "tagFrame"]);
    expect(left("tagCeiling", "tagFrame")).toEqual(["tagStage", "tagTarget", "tagFrame"]);
    expect(left("tagStage", "tagFrame")).toEqual(["tagTarget", "tagCeiling", "tagFrame"]);
  });

  it("closes an open sentence that meets a control in its own place and in its fallback place, and keeps every tag", () => {
    const { input } = settled(DESK, 1, "target");
    // Measured across the fallback place, tall enough to reach the bottom bar from the centre and the zoom column from the top.
    const targetText = { w: input.region.w - 2 * CHROME_MARGIN, h: input.region.h / 2 };
    const layout = layoutStageChrome({ ...input, sizes: { ...input.sizes, targetText } });
    expect(layout.targetText).toBeUndefined();
    for (const part of ["tagCeiling", "tagFrame", "tagTarget", "tagStage", "bar", "counter"] as const) expect(layout[part], part).toBeDefined();
  });

  describe("an open sentence's fallback place", () => {
    const PHONES: Array<[string, Case, GuideTag]> = [
      ["390×844 portrait", CASES[2][1], "target"],
      ["360×740 portrait", CASES[3][1], "target"],
      ["844×390 sideways", SIDEWAYS, "stage"],
    ];
    for (const [label, c, open] of PHONES) {
      it(`opens under the top bar, across the region, below the Viewfinder, where its own place meets a control: the ${open} sentence at ${label}`, () => {
        const { input, layout } = settled(c, 1, open);
        const text = layout[GUIDE_TEXT_PART[open]]!;
        expect(text).toBeDefined();
        expect(text.x).toBeCloseTo(layout.topBar.x, 9);
        expect(text.w).toBeCloseTo(layout.topBar.w, 9);
        expect(text.y).toBeCloseTo(bottom(layout.viewfinder!) + 8, 9);
        expect(sentenceStandsFree(text, layout[GUIDE_TAG_PART[open]])).toBe(true);
        for (const part of [GUIDE_TAG_PART[open], "viewfinder", "chip", "zoom", "bar"] as const) expect(layout[part], part).toBeDefined();
        expect(chromeCollisions(layout)).toEqual([]);
        for (const box of Object.values(layout)) expect(inside(box, input.stage)).toBe(true);
      });
    }

    it("is not used where the sentence has room in its own place: each sentence at 1440×900 and 1440×757, the frame's on phones", () => {
      const own: Array<[Case, GuideTag]> = [
        ...[DESK, CASES[1][1]].flatMap((c) => GUIDES.map((open): [Case, GuideTag] => [c, open])),
        [PORTRAIT, "frame"],
        [CASES[3][1], "frame"],
        [SIDEWAYS, "frame"],
      ];
      for (const [c, open] of own) {
        const { layout } = settled(c, 1, open);
        const text = layout[GUIDE_TEXT_PART[open]];
        expect(text, `${c.win.w}×${c.win.h} ${open}`).toBeDefined();
        expect(sentenceStandsFree(text, layout[GUIDE_TAG_PART[open]]), `${c.win.w}×${c.win.h} ${open}`).toBe(false);
      }
    });

    it("closes the sentence where the fallback place meets a control too, leaving out nothing for it", () => {
      const { input } = settled(DESK, 1, "target");
      const closed = layoutStageChrome({ ...input, show: { ...input.show, open: null } });
      // Measured across the fallback place, reaching 10px into the zoom column from under the Viewfinder, short of its own tag.
      const top = bottom(closed.viewfinder!) + 8;
      const targetText = { w: input.region.w - 2 * CHROME_MARGIN, h: closed.zoom!.y + 10 - top };
      expect(top + targetText.h).toBeLessThan(closed.tagTarget!.y);
      const layout = layoutStageChrome({ ...input, sizes: { ...input.sizes, targetText } });
      expect(layout.targetText).toBeUndefined();
      expect(layout).toEqual(layoutStageChrome({ ...input, show: { ...input.show, open: null } }));
    });
  });

  it("leaves out a tag that meets a control, not the control", () => {
    const { input } = settled(DESK);
    // A frame's tag wide enough to reach the Viewfinder.
    const layout = layoutStageChrome({ ...input, sizes: { ...input.sizes, tagFrame: { w: input.region.w, h: 30 } } });
    expect(layout.tagFrame).toBeUndefined();
    expect(layout.viewfinder).toBeDefined();
    for (const part of ["tagCeiling", "tagTarget", "tagStage"] as const) expect(layout[part], part).toBeDefined();
  });

  it("keeps an open sentence that meets nothing while a tag that meets a control is left out", () => {
    const { input } = settled(DESK, 1, "stage");
    const wide = { ...input.sizes, tagFrame: { w: input.region.w, h: 30 } };
    const layout = layoutStageChrome({ ...input, sizes: wide });
    expect(layout.tagFrame).toBeUndefined();
    expect(layout.tagStage).toBeDefined();
    expect(layout.stageText).toBeDefined();
  });

  describe("while a sentence is open", () => {
    const TAGS_AND_CONTROLS = ["tagCeiling", "tagFrame", "tagTarget", "tagStage", "viewfinder", "chip", "zoom", "bar"] as const;
    /** At a desktop window, the centre's tag wide enough to stand left of the target, on the frame sentence's way down. */
    function frameReaching(h: number) {
      const { input } = settled(DESK, 1, "frame");
      const sizes = { ...input.sizes, tagTarget: { w: 320, h: 30 }, frameText: { w: 320, h } };
      return { ...input, sizes };
    }

    it("moves another tag the sentence meets out of its way, and keeps the sentence: the centre's to its fallback place under the top bar", () => {
      const input = frameReaching(300);
      // Closed, nothing meets.
      expect(chromeCollisions(layoutStageChrome({ ...input, show: { ...input.show, open: null } }))).toEqual([]);
      const layout = layoutStageChrome(input);
      expect(layout.frameText).toBeDefined();
      expect(layout.tagTarget!.y).toBeCloseTo(bottom(layout.topBar) + 8, 9);
      expect(layout.tagTarget!.x).toBeCloseTo(right(layout.tagFrame!) + 8, 9);
      for (const part of ["tagFrame", "tagCeiling", "tagStage", "counter", "viewfinder", "chip", "zoom", "bar"] as const) expect(layout[part], part).toBeDefined();
      expect(chromeCollisions(layout)).toEqual([]);
    });

    it("moves the word count it meets under the top bar, where the frame's tag gives way to the word count, as the tiers say", () => {
      const { input } = settled(DESK, 1, "ceiling");
      const ceiling = input.ceiling!;
      const closed = layoutStageChrome({ ...input, show: { ...input.show, open: null } });
      expect(closed.counter!.y).toBeCloseTo(bottom(ceiling), 9);
      // Tall enough to reach past the ceiling's bottom, into the word count's rows.
      const h = bottom(ceiling) - (ceiling.y + 1) + 10;
      const layout = layoutStageChrome({ ...input, sizes: { ...input.sizes, ceilingText: { w: 320, h } } });
      expect(layout.ceilingText).toBeDefined();
      expect(layout.counter!.y).toBeCloseTo(bottom(layout.topBar) + 8, 9);
      expect(layout.tagFrame).toBeUndefined();
      for (const part of ["tagCeiling", "tagTarget", "tagStage", "viewfinder", "chip", "zoom", "bar"] as const) expect(layout[part], part).toBeDefined();
      expect(chromeCollisions(layout)).toEqual([]);
    });

    it("leaves the word count out, and keeps the tags, where under the top bar it would have no room either: 360×740 portrait", () => {
      const c = CASES[3][1];
      const closed = settled(c).layout;
      expect(closed.counter).toBeDefined();
      const { input, layout } = settled(c, 1, "frame");
      expect(layout.frameText).toBeDefined();
      expect(layout.counter).toBeUndefined();
      // The centre's tag, in the sentence's way, moves into the row of the frame's and the stage's under the top bar.
      expect(layout.tagTarget!.y).toBeCloseTo(bottom(layout.topBar) + 8, 9);
      for (const part of ["tagFrame", "tagStage", "viewfinder", "chip", "zoom", "bar"] as const) expect(layout[part], part).toBeDefined();
      // Without the word count above the card, the controls sit lower, clear of the sentence.
      expect(layout.chip!.y).toBeGreaterThan(closed.chip!.y);
      expect(chromeCollisions(layout)).toEqual([]);
      for (const box of Object.values(layout)) expect(inside(box, input.stage)).toBe(true);
    });

    it("keeps its own tag where the tag meets the word count, which gives way, as the tag does with nothing open: 1040×720", () => {
      const c: Case = { win: { w: 1040, h: 720 }, content: contentFor({ w: 1040, h: 720 }) };
      const closed = settled(c).layout;
      expect(closed.tagStage).toBeUndefined();
      expect(closed.counter).toBeDefined();
      const { input, layout } = settled(c, 1, "stage");
      expect(layout.tagStage).toBeDefined();
      expect(layout.stageText).toBeDefined();
      // The word count moves under the top bar, and the frame's tag there gives way to it, as the tiers say.
      expect(layout.counter!.y).toBeCloseTo(bottom(layout.topBar) + 8, 9);
      expect(layout.tagFrame).toBeUndefined();
      expect(chromeCollisions(layout)).toEqual([]);
      for (const box of Object.values(layout)) expect(inside(box, input.stage)).toBe(true);
    });

    it("closes where it meets a control, and leaves out nothing for it: neither the control nor the tag it also meets", () => {
      const input = frameReaching(650);
      const layout = layoutStageChrome(input);
      expect(layout.frameText).toBeUndefined();
      for (const part of [...TAGS_AND_CONTROLS, "counter"] as const) expect(layout[part], part).toBeDefined();
      expect(layout).toEqual(layoutStageChrome({ ...input, show: { ...input.show, open: null } }));
    });

    it("with nothing open, leaves out a tag that meets the word count, and keeps the word count where it was", () => {
      const { input } = settled(DESK);
      const before = layoutStageChrome(input).counter!;
      // The stage's tag, in its corner, reaching up and across into the word count.
      const layout = layoutStageChrome({ ...input, sizes: { ...input.sizes, tagStage: { w: before.x + 20, h: input.stage.h - before.y - 10 } } });
      expect(layout.tagStage).toBeUndefined();
      expect(layout.counter).toEqual(before);
    });
  });

  it("moves the tags in their order where two meet: the centre's to its fallback place, not the frame's out", () => {
    const { input } = settled(DESK);
    const r = input.region;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    // A frame's tag reaching over the centre's, and nothing else.
    const tagFrame = { w: cx + 35 - input.frame.x, h: cy - input.frame.y };
    const layout = layoutStageChrome({ ...input, sizes: { ...input.sizes, tagFrame } });
    expect(layout.tagTarget!.x).toBeCloseTo(right(layout.tagFrame!) + 8, 9);
    expect(layout.tagFrame).toBeDefined();
    expect(chromeCollisions(layout)).toEqual([]);
  });

  describe("the centre's tag's fallback place", () => {
    const underTop = (layout: ChromeLayout) => bottom(layout.topBar) + 8;

    it("stands under the top bar, after the frame's and the stage's tags, where its own place meets a control: 844×390 sideways", () => {
      const { input, layout } = settled(SIDEWAYS);
      const r = input.region;
      // Its own place, right of the target, meets the word count above the compact row.
      const own = { x: r.x + r.w / 2 + 25, y: r.y + r.h / 2 - 15, w: 32, h: 32 };
      expect(boxesMeet(own, layout.counter!)).toBe(true);
      const tag = layout.tagTarget!;
      expect(tag.y).toBeCloseTo(underTop(layout), 9);
      expect(tag.y).toBeCloseTo(layout.tagStage!.y, 9);
      expect(tag.x).toBeCloseTo(right(layout.tagStage!) + 8, 9);
      expect(chromeCollisions(layout)).toEqual([]);
    });

    it("is not used where its own place has room: beside the target at 1440×900, 1440×757, 390×844 and 360×740", () => {
      for (const c of [DESK, CASES[1][1], PORTRAIT, CASES[3][1]]) {
        const { input, layout } = settled(c);
        const r = input.region;
        expect(layout.tagTarget!.x, `${c.win.w}×${c.win.h}`).toBeCloseTo(r.x + r.w / 2 + 25, 9);
        expect(layout.tagTarget!.y, `${c.win.w}×${c.win.h}`).toBeCloseTo(r.y + r.h / 2 - 15, 9);
      }
    });

    it("opens its sentence below the tag's row there, clear of every piece: 844×390 sideways", () => {
      const { input, layout } = settled(SIDEWAYS, 1, "target");
      const tag = layout.tagTarget!;
      expect(tag.y).toBeCloseTo(underTop(layout), 9);
      const text = layout.targetText!;
      expect(text.y).toBeGreaterThanOrEqual(bottom(tag) + 8 - 1e-9);
      for (const part of ["tagFrame", "tagStage", "viewfinder", "chip", "zoom", "bar"] as const) expect(layout[part], part).toBeDefined();
      expect(chromeCollisions(layout)).toEqual([]);
      for (const box of Object.values(layout)) expect(inside(box, input.stage)).toBe(true);
    });

    it("leaves the tag out where its fallback place meets a control too", () => {
      const { input } = settled(DESK);
      // As wide as the stage: it leaves the stage either side of the target, and meets the Viewfinder under the bar.
      const layout = layoutStageChrome({ ...input, sizes: { ...input.sizes, tagTarget: { w: input.stage.w, h: 30 } } });
      expect(layout.tagTarget).toBeUndefined();
      for (const part of ["tagFrame", "tagStage", "tagCeiling", "viewfinder", "zoom"] as const) expect(layout[part], part).toBeDefined();
    });
  });

  it("keeps the gap between a sentence in its fallback place and a tag below it, the tag giving way: the centre's at 360×740", () => {
    const { input, layout } = settled(CASES[3][1], 1, "target");
    const text = layout.targetText!;
    expect(sentenceStandsFree(text, layout.tagTarget)).toBe(true);
    // Its own place, under the sentence, starts less than the gap below it.
    const own = input.region.y + input.region.h / 2 - 15;
    expect(own - bottom(text)).toBeGreaterThan(0);
    expect(own - bottom(text)).toBeLessThan(8);
    expect(layout.tagTarget!.y).toBeCloseTo(bottom(layout.topBar) + 8, 9);
    for (const part of ["tagFrame", "tagStage", "tagTarget"] as const) {
      const tag = layout[part]!;
      if (tag.y >= text.y) expect(tag.y - bottom(text), part).toBeGreaterThanOrEqual(8);
    }
  });
});

/** The content area the editor leaves at a window: the chrome above, the step list at lg and wider. */
function contentFor(win: { w: number; h: number }) {
  return { w: win.w - (win.w >= 1024 ? 200 : 0), h: win.h - 132 };
}

describe("the stage's chrome at every window", () => {
  it("overlaps nothing, stays inside the stage and keeps every control, from 320×480 to 2560×1440, with and without a card below, with long sentences, closed or open", () => {
    const failures: string[] = [];
    const countLeftOut = new Set<string>();
    let checked = 0;
    for (let w = 320; w <= 2560; w += 80) {
      for (let h = 480; h <= 1440; h += 80) {
        for (const [win, label] of [[{ w, h }, "landscape"], [{ w: h, h: w }, "portrait"]] as const) {
          if (win.w < 320 || win.h < 480 || win.w > 2560 || win.h > 2560) continue;
          for (const media of [undefined, "video"] as const) {
            for (const [textScale, open] of [[1, null], [2.5, null], [2.5, "frame"], [2.5, "stage"]] as const) {
              const c: Case = { win, content: contentFor(win), media };
              if (!stageRect(c.content, c.win)) continue;
              const { input, layout } = settled(c, textScale, open);
              checked += 1;
              const where = `${win.w}×${win.h} ${label}${media ? " video" : ""}${input.below ? " below" : ""} ×${textScale}${open ? ` ${open} open` : ""}`;
              for (const [a, b] of chromeCollisions(layout)) failures.push(`${where}: ${a} meets ${b}`);
              for (const [part, box] of Object.entries(layout)) {
                if (!inside(box, input.stage)) failures.push(`${where}: ${part} outside the stage`);
                if (!(box.w > 0 && box.h > 0)) failures.push(`${where}: ${part} has no area`);
              }
              const controls = media ? ["topBar", "bar"] : ["topBar", "bar", "viewfinder", "zoom", "chip"];
              for (const part of controls) if (!(part in layout)) failures.push(`${where}: ${part} left out`);
              // An open sentence the word count gives way to takes it; counted here are the stages with none open.
              if (!layout.counter && !open) countLeftOut.add(`${win.w}×${win.h}${media ? " video" : ""}`);
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(failures.slice(0, 20)).toEqual([]);
    // Only where the stage is too narrow for the count beside the Viewfinder, once every tag has gone.
    expect([...countLeftOut].sort()).toEqual(["320×560", "400×560"]);
  });

  it("leaves out every tag before the word count: 320×560 and 400×560", () => {
    for (const w of [320, 400]) {
      const c: Case = { win: { w, h: 560 }, content: contentFor({ w, h: 560 }) };
      const { layout } = settled(c);
      expect(layout.counter, `${w}: count left out`).toBeUndefined();
      for (const part of ["tagFrame", "tagStage", "tagCeiling", "tagTarget"] as const) expect(layout[part], `${w}: ${part}`).toBeUndefined();
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

  it("drops the tags, not the controls, where a phone's region has no room: 360×640", () => {
    const c: Case = { win: { w: 360, h: 640 }, content: { w: 360, h: 508 } };
    const { layout } = settled(c);
    expect(chromeCollisions(layout)).toEqual([]);
    expect(layout.bar).toBeDefined();
    expect(layout.zoom).toBeDefined();
    expect(layout.chip).toBeDefined();
    expect(layout.viewfinder).toBeDefined();
    expect(layout.counter).toBeDefined();
    expect(layout.tagTarget!.y).toBeCloseTo(bottom(layout.topBar) + 8, 9);
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

