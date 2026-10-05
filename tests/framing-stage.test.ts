/**
 * The visitor's window geometry in `app/lib/framing-stage.ts`, against numbers
 * worked by hand from the framework's declarations.
 *
 * The expectations are literals rather than expressions over the module's own
 * constants, so a changed constant fails here as well as in the parity test.
 * The boundary cases sit on each inclusive edge the framework's media queries
 * draw: 1024px wide, aspect 0.75, 480px high, the short-window bands' corners,
 * and the panel tiers at 1024/1025 and 1200/1201.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";

import {
  cardBox,
  ceilingBox,
  fallbackRegion,
  panelBox,
  panelTier,
  regionOf,
  audioBelowLayout,
  audioWaveformBox,
  mediaCardBelow,
  stageRect,
  videoLayout,
  videoLetterboxRegion,
  visitorLayout,
} from "~/lib/framing-stage";

/** Each named field of `actual` to six places. */
function close(actual: object | null, expected: Record<string, number>): void {
  expect(actual).not.toBeNull();
  const fields = actual as Record<string, number>;
  for (const [k, v] of Object.entries(expected)) expect(fields[k], k).toBeCloseTo(v, 6);
}

describe("visitorLayout", () => {
  it("is horizontal with a side card on a desktop window", () => {
    expect(visitorLayout(1440, 757)).toEqual({ mode: "horizontal", cardPlacement: "side" });
  });

  it("is vertical with a bottom card on a portrait phone", () => {
    expect(visitorLayout(390, 844)).toEqual({ mode: "vertical", cardPlacement: "bottom" });
  });

  it("is vertical at exactly 1024px wide and horizontal at 1025px", () => {
    expect(visitorLayout(1024, 800).mode).toBe("vertical");
    expect(visitorLayout(1025, 800).mode).toBe("horizontal");
  });

  it("is vertical at exactly aspect 0.75 and horizontal just above it", () => {
    expect(visitorLayout(1500, 2000).mode).toBe("vertical");
    expect(visitorLayout(1501, 2000).mode).toBe("horizontal");
  });

  it("keeps a sideways phone vertical with a side card, at 480px high and below", () => {
    expect(visitorLayout(900, 480)).toEqual({ mode: "vertical", cardPlacement: "side" });
    expect(visitorLayout(844, 390)).toEqual({ mode: "vertical", cardPlacement: "side" });
    expect(visitorLayout(900, 481)).toEqual({ mode: "vertical", cardPlacement: "bottom" });
  });

  it("is vertical at 480px high at any width, with a side card", () => {
    expect(visitorLayout(1400, 480)).toEqual({ mode: "vertical", cardPlacement: "side" });
    expect(visitorLayout(3000, 480)).toEqual({ mode: "vertical", cardPlacement: "side" });
  });

  it("is vertical inside each short-window band's corner and horizontal one pixel past it", () => {
    // The first band, 481 to 488 high, is vertical to ceil(718 / 0.52) − 1 =
    // 1380 wide; the band from 593 to 600 to ceil((1544 − 1.6 × 593) / 0.52)
    // − 1 = 1144; the last, 625 to 632, to 1046.
    for (const [w, h] of [[1380, 488], [1380, 481], [1144, 600], [1144, 593], [1046, 632], [1046, 625]]) {
      expect(visitorLayout(w, h), `${w}×${h}`).toEqual({ mode: "vertical", cardPlacement: "bottom" });
    }
    for (const [w, h] of [[1381, 488], [1145, 600], [1144, 601], [1047, 632], [1046, 633], [1100, 640]]) {
      expect(visitorLayout(w, h).mode, `${w}×${h}`).toBe("horizontal");
    }
  });
});

describe("regionOf and fallbackRegion", () => {
  it("frames beside the side card at 1440×757, past 3% and the card's 533px", () => {
    // The card is round(max(0.37 × 1440, 1544 − 1.6 × 757)) = round(532.8).
    const layout = visitorLayout(1440, 757);
    close(regionOf(layout, 1440, 757), { x: 576.2, y: 0, w: 863.8, h: 757 });
    close(fallbackRegion(layout, 1440, 757), { x: 576.2, y: 0, w: 863.8, h: 757 });
  });

  it("does not depend on the side card's content height", () => {
    const layout = visitorLayout(1440, 757);
    close(regionOf(layout, 1440, 757, { contentHeight: 120 }), { x: 576.2, w: 863.8 });
  });

  it("frames above the live bottom card at 390×844, and above 0.6H without one", () => {
    const layout = visitorLayout(390, 844);
    // 844 − 16 − 0.40 × 844 = 490.4
    close(regionOf(layout, 390, 844), { x: 0, y: 0, w: 390, h: 490.4 });
    // 0.6 × 844 = 506.4
    close(fallbackRegion(layout, 390, 844), { x: 0, y: 0, w: 390, h: 506.4 });
  });

  it("frames above the 35% card on a video or audio step", () => {
    // 844 − 16 − 0.35 × 844 = 532.6
    close(regionOf(visitorLayout(390, 844), 390, 844, { media: true }), { h: 532.6 });
  });

  it("frames beside the side card on a sideways phone, live and fallback alike", () => {
    const layout = visitorLayout(844, 390);
    close(regionOf(layout, 844, 390), { x: 337.6, w: 506.4, h: 390 });
    close(fallbackRegion(layout, 844, 390), { x: 337.6, w: 506.4, h: 390 });
  });
});

describe("cardBox and ceilingBox", () => {
  it("centres the desktop side card and caps it at 80% of the height, floored to a pixel", () => {
    const layout = visitorLayout(1440, 757);
    close(cardBox(layout, 1440, 757, { contentHeight: 300 }), {
      x: 43.2,
      y: 228.5,
      w: 533,
      h: 300,
    });
    // The ceiling is floor(0.8 × 757) = 605, under the 664 of room below the
    // band; a card at it is centred at (757 − 605) / 2 = 76, below the band at
    // 54 + 19 = 73.
    close(cardBox(layout, 1440, 757, { contentHeight: 2000 }), { y: 76, h: 605 });
    close(ceilingBox(layout, 1440, 757), { x: 43.2, y: 76, w: 533, h: 605 });
  });

  it("puts the bottom card 16px off the bottom, 16px in from each side, 40% tall", () => {
    close(cardBox(visitorLayout(390, 844), 390, 844, { contentHeight: 50 }), {
      x: 16,
      y: 490.4,
      w: 358,
      h: 337.6,
    });
  });

  it("marks no ceiling for the bottom card", () => {
    expect(ceilingBox(visitorLayout(390, 844), 390, 844)).toBeNull();
  });

  it("holds a sideways phone's side card under the top controls, as the fit model's band does", () => {
    const layout = visitorLayout(844, 390);
    // 390 − 60 − 2 × 9.75 − 1 = 309.5, floored; its top 60 + 10 = 70.
    close(ceilingBox(layout, 844, 390), { x: 25.32, y: 70, w: 312.28, h: 309 });
    close(cardBox(layout, 844, 390, { contentHeight: 200 }), { y: 95, h: 200 });
    close(cardBox(layout, 844, 390, { contentHeight: 5000 }), { y: 70, h: 309 });
    close(cardBox(layout, 844, 390, { contentHeight: 330 }), { y: 70, h: 309 });
  });

  it("gives a sideways phone's card the same ceiling after a video or audio plate", () => {
    const layout = visitorLayout(844, 390);
    close(cardBox(layout, 844, 390, { media: true, contentHeight: 200 }), { y: 95, h: 200 });
    close(ceilingBox(layout, 844, 390, { media: true }), { x: 25.32, y: 70, w: 312.28, h: 309 });
  });

  it("gives the ceiling and top the framework measured live, with the card at rest: C 60 on a phone held sideways, 54 on a desktop", () => {
    // The card's height is the one those tops centre: (h − top) × 2 at 844×390
    // and 932×430, 227 at 1280×720.
    const rows = [
      { w: 844, h: 390, content: 218, ceiling: 309, top: 86 },
      { w: 932, h: 430, content: 218, ceiling: 347, top: 106 },
      { w: 1280, h: 720, content: 227, ceiling: 576, top: 246.5 },
    ];
    for (const { w, h, content, ceiling, top } of rows) {
      const layout = visitorLayout(w, h);
      expect(ceilingBox(layout, w, h)?.h, `${w}×${h} ceiling`).toBe(ceiling);
      close(cardBox(layout, w, h, { contentHeight: content }), { y: top, h: content });
    }
  });

  it("ignores a below arrangement on a sideways phone, where the page reads none", () => {
    const layout = visitorLayout(844, 390);
    const below = { cardTop: 300, topBand: 70 };
    close(cardBox(layout, 844, 390, { contentHeight: 200, below }), { y: 95, h: 200 });
  });

  it("caps a short portrait window's side card at the height less 2rem, centred", () => {
    const layout = visitorLayout(320, 480);
    expect(layout).toEqual({ mode: "vertical", cardPlacement: "side" });
    close(ceilingBox(layout, 320, 480), { y: 16, h: 448 });
    close(cardBox(layout, 320, 480, { contentHeight: 200 }), { y: 140, h: 200 });
  });

  it("caps a short portrait window's side card at 35% of the height on a video or audio step", () => {
    const layout = visitorLayout(320, 480);
    // 0.35 × 480 = 168, centred: (480 − 168) / 2 = 156.
    close(ceilingBox(layout, 320, 480, { media: true }), { y: 156, h: 168 });
    close(cardBox(layout, 320, 480, { media: true, contentHeight: 200 }), { y: 156, h: 168 });
    close(cardBox(layout, 320, 480, { media: true, contentHeight: 100 }), { y: 190, h: 100 });
  });

  it("keeps the desktop side card's 80% ceiling on a video or audio step", () => {
    const layout = visitorLayout(1440, 757);
    close(ceilingBox(layout, 1440, 757, { media: true }), { y: 76, h: 605 });
  });

  it("widens a short horizontal window's side card and caps it under the top controls, on a media step too", () => {
    const layout = visitorLayout(1400, 560);
    expect(layout).toEqual({ mode: "horizontal", cardPlacement: "side" });
    // max(0.8 × 560, 480 − 54 − 2 × 12 − 1) = 448, under the 477 of room; its
    // top held at the band, 54 + 14 = 68, where centred it would be 56;
    // 0.03 × 1400 = 42, and 1544 − 1.6 × 560 = 648 wide, between 518 and 728.
    close(ceilingBox(layout, 1400, 560), { x: 42, y: 68, w: 648, h: 448 });
    close(ceilingBox(layout, 1400, 560, { media: true }), { y: 68, h: 448 });
    close(cardBox(layout, 1400, 560, { contentHeight: 600 }), { y: 68, w: 648, h: 448 });
    close(cardBox(layout, 1400, 560, { contentHeight: 200 }), { y: 180, h: 200 });
  });

  it("holds the side card between 37% and 52% of the width, and to 718px", () => {
    // 1920×600: 1544 − 960 = 584, over 0.37 × 1920 = 710.4, so 710.
    close(cardBox(visitorLayout(1920, 600), 1920, 600, { contentHeight: 100 }), { w: 710 });
    // 1600×520: 1544 − 832 = 712, under 0.52 × 1600 = 832.
    close(cardBox(visitorLayout(1600, 520), 1600, 520, { contentHeight: 100 }), { w: 712 });
    // 1400×482 is vertical (the first band); 1600×482: 1544 − 771.2 = 772.8,
    // held to 718.
    close(cardBox(visitorLayout(1600, 482), 1600, 482, { contentHeight: 100 }), { w: 718 });
    // 1381×488 is the band's first horizontal width: 718, under 0.52 × 1381
    // = 718.12.
    close(cardBox(visitorLayout(1381, 488), 1381, 488, { contentHeight: 100 }), { w: 718 });
  });

  it("keeps a lower controls edge clear, rounded as the page measures it", () => {
    const layout = visitorLayout(1300, 450);
    // Controls at 70.6 round to 71: band 71 + 11 = 82; ceiling
    // floor(450 − 71 − 22.5 − 1) = 355.
    close(ceilingBox(layout, 1300, 450, { topControlsBottom: 70.6 }), { y: 82, h: 355 });
    close(cardBox(layout, 1300, 450, { contentHeight: 300, topControlsBottom: 70.6 }), { y: 82, h: 300 });
  });
});

describe("panelBox", () => {
  it("is 65% capped at 800px and 55% capped at 750px above 1200px", () => {
    close(panelBox(1, 1440, 900), { x: 640, y: 0, w: 800, h: 900 });
    close(panelBox(2, 1440, 900), { x: 690, y: 0, w: 750, h: 900 });
    close(panelBox(1, 1201, 900), { w: 780.65 });
    close(panelBox(2, 1201, 900), { w: 660.55 });
    // 0.55 × 1300 = 715 sits under its cap while layer 1 has reached 800.
    close(panelBox(1, 1300, 900), { w: 800 });
    close(panelBox(2, 1300, 900), { w: 715 });
  });

  it("is 80% and 75%, uncapped, from 769px to 1200px in horizontal layout", () => {
    expect(panelTier(1200, 900)).toBe("narrow");
    close(panelBox(1, 1200, 900), { x: 240, w: 960, h: 900 });
    close(panelBox(2, 1200, 900), { x: 300, w: 900 });
    close(panelBox(1, 1100, 800), { w: 880 });
    close(panelBox(2, 1100, 800), { w: 825 });
  });

  it("is the right-slide sheet in vertical layout, and the narrow tier from 1025px", () => {
    expect(panelTier(768, 1000)).toBe("sheet");
    expect(panelTier(769, 1000)).toBe("sheet");
    expect(panelTier(1024, 800)).toBe("sheet");
    expect(panelTier(1025, 800)).toBe("narrow");
    close(panelBox(1, 390, 844), { x: 7.8, y: 101.28, w: 382.2, h: 641.44 });
    close(panelBox(2, 390, 844), { x: 15.6, y: 84.4, w: 374.4, h: 641.44 });
  });

  it("is the sheet on a tall window inside the narrow tier's widths", () => {
    expect(panelTier(1100, 1600)).toBe("sheet");
  });
});

describe("stageRect", () => {
  it("letterboxes a wider content area by height", () => {
    const s = stageRect({ w: 1000, h: 500 }, { w: 1440, h: 900 });
    close(s, { x: 100, y: 0, w: 800, h: 500, scale: 800 / 1440 });
  });

  it("letterboxes a taller content area by width", () => {
    const s = stageRect({ w: 800, h: 800 }, { w: 1600, h: 900 });
    close(s, { x: 0, y: 175, w: 800, h: 450, scale: 0.5 });
  });

  it("fills a content area of the window's own shape", () => {
    const s = stageRect({ w: 720, h: 378.5 }, { w: 1440, h: 757 });
    close(s, { x: 0, y: 0, w: 720, h: 378.5, scale: 0.5 });
  });

  it("letterboxes a portrait window into a landscape area", () => {
    const s = stageRect({ w: 1000, h: 600 }, { w: 390, h: 844 });
    close(s, { y: 0, h: 600, w: (600 * 390) / 844, scale: 600 / 844 });
  });

  it("is null where either rectangle has no area", () => {
    expect(stageRect({ w: 0, h: 500 }, { w: 1440, h: 900 })).toBeNull();
    expect(stageRect({ w: 1000, h: 500 }, { w: 1440, h: 0 })).toBeNull();
  });
});

describe("videoLayout", () => {
  it("puts a 16:9 player one gutter past the side card at 1440×757", () => {
    // pad = max(8, round(757 × 0.025)) = 19; card right edge round(0.40 × 1440)
    // = 576, so the player starts at 595 and fits 1440 − 595 − 19 = 826 wide,
    // 826 / (16/9) = 464.625 high; card slot at round(43.2), round(532.8) wide.
    const v = videoLayout("horizontal", 1440, 757, 16 / 9);
    expect(v.arrangement).toBe("side-by-side");
    close(v.player, { x: 595, y: 146, w: 826, h: 465 });
    close(v.card, { x: 43, y: 19, w: 533, h: 719 });
    expect(v.padding).toBe(24);
  });

  it("keeps a 2.39:1 player side by side at 1280×1024, where stacking would show it larger", () => {
    // pad = round(25.6) = 26; player from 512 + 26 = 538, 1280 − 538 − 26 = 716
    // wide, 716 / 2.39 = 299.58 high; card slot round(38.4), round(473.6).
    const v = videoLayout("horizontal", 1280, 1024, 2.39);
    expect(v.arrangement).toBe("side-by-side");
    close(v.player, { x: 538, y: 362, w: 716, h: 300 });
    close(v.card, { x: 38, y: 26, w: 474, h: 972 });
    expect(v.padding).toBe(24);
  });

  it("stacks in vertical layout", () => {
    // pad = round(27.5) = 28; stacked height ceiling 0.58 × 1500 = 870.
    const v = videoLayout("vertical", 1100, 1500, 9 / 16);
    expect(v.arrangement).toBe("stacked");
    close(v.player, { x: 306, y: 28, w: 489, h: 870 });
    close(v.card, { x: 28, y: 926, w: 1044, h: 546 });
  });

  it("gives an unknown-aspect player the whole space it could have", () => {
    close(videoLetterboxRegion("horizontal", 1440, 757), { x: 595, y: 19, w: 826, h: 719 });
    close(videoLetterboxRegion("vertical", 390, 844), { x: 10, y: 10, w: 370, h: 490 });
  });
});

describe("audioWaveformBox", () => {
  it("draws the waveform right of the card, half the height, centred", () => {
    // From 43.2 + 533 + 0.01 × 1440 = 590.6 to the window's right edge.
    close(audioWaveformBox("horizontal", 1440, 757), { x: 590.6, y: 189, w: 849.4, h: 379 });
  });

  it("draws it above the bottom card in vertical layout, 35% of the height", () => {
    close(audioWaveformBox("vertical", 390, 844), { x: 19.5, y: 80.38, w: 351, h: 295 });
  });
});

describe("mediaCardBelow and the media functions with the card below", () => {
  // 1440×900, a 125px card: pad = max(8, round(22.5)) = 23; top band 54 + 23
  // = 77; card top round(900 − 23 − 125) = 752. The space above the card is
  // x 23, y 77, 1440 − 46 = 1394 wide, 752 − 23 − 77 = 652 high.
  const layout = visitorLayout(1440, 900);
  const below = { cardTop: 752, topBand: 77 };

  it("puts a 16:9 video's card below where the player gains at least 15%", () => {
    // Beside: 818 × 460 = 376,280. Below: 652 × 16/9 = 1159.1 wide, so 1159 ×
    // 652 = 755,668, twice as much.
    expect(mediaCardBelow(layout, 1440, 900, { kind: "video", aspect: 16 / 9, tallestContentHeight: 125 })).toEqual(below);
    const v = videoLayout("horizontal", 1440, 900, 16 / 9, below);
    expect(v.arrangement).toBe("below");
    // Centred in the space: x round(23 + (1394 − 1159) / 2) = round(140.5).
    close(v.player, { x: 141, y: 77, w: 1159, h: 652 });
    close(v.card, { x: 43, y: 752, w: 533, h: 125 });
    close(videoLetterboxRegion("horizontal", 1440, 900, below), { x: 23, y: 77, w: 1394, h: 652 });
  });

  it("keeps the card beside where the gain falls short", () => {
    // 1440×757, a 148px card: beside 826 × 465 = 384,090; below, card top
    // round(757 − 19 − 148) = 590, space 590 − 19 − 73 = 498 high, 885 × 498
    // = 440,730, 1.1475 of beside.
    expect(mediaCardBelow(visitorLayout(1440, 757), 1440, 757, { kind: "video", aspect: 16 / 9, tallestContentHeight: 148 })).toBeNull();
  });

  it("places the card one gutter above the bottom and the ceiling where a card at it would stand", () => {
    close(cardBox(layout, 1440, 900, { media: true, contentHeight: 125, below }), { x: 43.2, y: 752, w: 533, h: 125 });
    // A shorter card of the same scene keeps its own top: round(900 − 23 − 90).
    close(cardBox(layout, 1440, 900, { media: true, contentHeight: 90, below }), { y: 787, h: 90 });
    // The 720px ceiling: round(900 − 23 − 720) = 157.
    close(ceilingBox(layout, 1440, 900, { media: true, below }), { x: 43.2, y: 157, w: 533, h: 720 });
    // The region stays beside the card, whose right edge is at 576.2.
    close(regionOf(layout, 1440, 900, { media: true, contentHeight: 125, below }), { x: 576.2, y: 0, w: 863.8, h: 900 });
  });

  it("spans the audio waveform above the card and its controls row", () => {
    // Beside: round(849.6) × 450 = 382,500. Below: the waveform keeps its 450
    // (the space leaves 652 − 48 = 604), top round(77 + (652 − 450 − 48) / 2)
    // = 154, 1394 × 450 = 627,300; the row ends 900 − (154 + 450 + 48) = 248
    // above the bottom.
    expect(mediaCardBelow(layout, 1440, 900, { kind: "audio", tallestContentHeight: 125 })).toEqual(below);
    expect(audioBelowLayout(1440, 900, below)).toEqual({ wave: { x: 23, y: 154, w: 1394, h: 450 }, controlsBottom: 248 });
    close(audioWaveformBox("horizontal", 1440, 900, below), { x: 23, y: 154, w: 1394, h: 450 });
  });

  it("does not arrange a vertical layout, and ignores a below handed to one", () => {
    const portrait = visitorLayout(390, 844);
    expect(mediaCardBelow(portrait, 390, 844, { kind: "video", aspect: 16 / 9, tallestContentHeight: 50 })).toBeNull();
    expect(videoLayout("vertical", 390, 844, 16 / 9, below).arrangement).toBe("stacked");
    close(audioWaveformBox("vertical", 390, 844, below), { x: 19.5, y: 80.38, w: 351, h: 295 });
    const sideways = visitorLayout(844, 390);
    close(cardBox(sideways, 844, 390, { media: true, contentHeight: 100, below }), { y: 145, h: 100 });
  });
});
