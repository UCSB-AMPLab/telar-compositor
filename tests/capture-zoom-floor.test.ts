/**
 * The editor's capture floor and the sub-1 zoom it produces.
 *
 * The framework now reads an authored zoom below 1 as a fraction of the
 * whole-object fit, floored at OVERVIEW_MIN_FRACTION (telar-story/iiif-card.js).
 * `CAPTURE_MIN_ZOOM_RATIO` is the editor's own citation of that same floor —
 * this file pins the value and traces a pulled-back capture through the
 * pipeline it has to survive unclamped: viewport conversion, the value-domain
 * read the Y document applies, and the publish/import CSV round trip.
 *
 * @version v1.5.0-beta
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import Papa from "papaparse";
import {
  captureViewportState,
  clampCaptureZoom,
  publishedFraming,
  viewportToNormalised,
  CAPTURE_MIN_ZOOM_RATIO,
  FULL_OBJECT_FRAMING,
} from "~/lib/viewer-utils";
import { readCoordinate } from "~/lib/value-domains";
import { serializeStoryCsv } from "~/lib/publish.server";
import { mapStoryCsv } from "~/lib/import.server";

describe("the paths that write a zoom without the capture clamp", () => {
  it("still include the hydration the clamp's docstring names", () => {
    // The docstring lists these so a reader knows the floor is a capture
    // invariant and not a store one, and a list nobody checks goes stale. This
    // is the one entry added after the list was written: a document rebuilt
    // from D1 rows carries each step's stored zoom verbatim.
    const source = readFileSync(
      fileURLToPath(new URL("../workers/collaboration.ts", import.meta.url)),
      "utf-8",
    );
    // Counted rather than located. The worker builds a step Y.Map in two
    // places — the ingest path and the D1 hydration — and both have to carry
    // the stored zoom through untouched, so the count is the assertion: a
    // floor introduced in either one takes it to 1. A third builder takes it
    // to 3 and fails here too, which is the point at which the docstring's
    // list needs revisiting rather than the test relaxing.
    const verbatim = source.match(/stepMap\.set\("zoom", step\.zoom \?\? null\)/g) ?? [];
    expect(
      verbatim.length,
      "expected both step-Y.Map builders in workers/collaboration.ts to carry the stored zoom",
    ).toBe(2);
    expect(source).not.toContain("clampCaptureZoom");
  });
});

describe("CAPTURE_MIN_ZOOM_RATIO", () => {
  it("is the framework's own floor (OVERVIEW_MIN_FRACTION), not a guess", () => {
    // Verified against the framework/assets/js/telar-story/iiif-card.js —
    // the framework's constant of the same name and purpose.
    expect(CAPTURE_MIN_ZOOM_RATIO).toBe(0.1);
  });
});

describe("clampCaptureZoom", () => {
  it("raises anything under the floor to it", () => {
    expect(clampCaptureZoom(0.05)).toBe(CAPTURE_MIN_ZOOM_RATIO);
    expect(clampCaptureZoom(0.0904583)).toBe(CAPTURE_MIN_ZOOM_RATIO);
    expect(clampCaptureZoom(0)).toBe(CAPTURE_MIN_ZOOM_RATIO);
    expect(clampCaptureZoom(-3)).toBe(CAPTURE_MIN_ZOOM_RATIO);
  });

  it("passes the floor itself and everything above it through untouched", () => {
    expect(clampCaptureZoom(CAPTURE_MIN_ZOOM_RATIO)).toBe(CAPTURE_MIN_ZOOM_RATIO);
    expect(clampCaptureZoom(0.1198)).toBe(0.1198);
    expect(clampCaptureZoom(1)).toBe(1);
    expect(clampCaptureZoom(40)).toBe(40);
  });

  it("puts a zoom arithmetic ruined on the floor, which Math.max would not", () => {
    // `Math.max(CAPTURE_MIN_ZOOM_RATIO, NaN)` is NaN. The comparison form is
    // what stops a ruined number being carried out of here.
    expect(clampCaptureZoom(NaN)).toBe(CAPTURE_MIN_ZOOM_RATIO);
    expect(clampCaptureZoom(-Infinity)).toBe(CAPTURE_MIN_ZOOM_RATIO);
    expect(clampCaptureZoom(Infinity)).toBe(Infinity);
  });

  it("sends a value that is not a number wherever its coercion puts it", () => {
    // `>` coerces, so a value above the floor leaves as it arrived and one at
    // or below it leaves as the floor — a number, whatever came in. Nothing
    // hands it a non-number: a capture derives its argument from the viewport,
    // and a restore screens a stored value through `publishedFraming` first.
    // Pinned so a caller that starts passing unchecked values fails here rather
    // than storing one.
    expect(clampCaptureZoom("0.2" as unknown as number)).toBe("0.2");
    expect(clampCaptureZoom(true as unknown as number)).toBe(true);
    expect(clampCaptureZoom("0.05" as unknown as number)).toBe(CAPTURE_MIN_ZOOM_RATIO);
    expect(clampCaptureZoom("garbage" as unknown as number)).toBe(CAPTURE_MIN_ZOOM_RATIO);
    expect(clampCaptureZoom(false as unknown as number)).toBe(CAPTURE_MIN_ZOOM_RATIO);
  });

  it("does not reach the floor at all for a value with no primitive form", () => {
    // The comparison has to complete for the floor to be the answer, and these
    // two cannot be compared: there is no number and no string to compare with.
    // Nothing the docstring says about where a value lands applies to them.
    expect(() => clampCaptureZoom(Symbol("zoom") as unknown as number)).toThrow(TypeError);
    expect(() => clampCaptureZoom(Object.create(null) as number)).toThrow(TypeError);
  });
});

describe("publishedFraming — the framework's pipeline, not one of its functions", () => {
  /** A stored framing with the centre an author composed. */
  const stored = (zoom: unknown, x: unknown = 0.4, y: unknown = 0.6) => ({ x, y, zoom });

  it("substitutes the whole-object value for a zoom that reads as no number", () => {
    // `_stepFraming` parses with `parseFloat` and falls back to 1, so the
    // published story frames these rather than refusing them. The centre is
    // untouched: the substitution is per field.
    for (const zoom of [NaN, Infinity, -Infinity, "", "   ", "garbage", null, undefined, true, {}]) {
      expect(publishedFraming(stored(zoom)), `zoom ${String(zoom)}`).toEqual({
        x: 0.4,
        y: 0.6,
        zoom: FULL_OBJECT_FRAMING.zoom,
      });
    }
  });

  it("falls back per field, so a step with nothing readable frames the whole object", () => {
    expect(publishedFraming({ x: "", y: null, zoom: NaN })).toEqual(FULL_OBJECT_FRAMING);
    // And a readable zoom with an unreadable centre keeps that zoom.
    expect(publishedFraming({ x: "garbage", y: undefined, zoom: 2 })).toEqual({
      x: 0.5,
      y: 0.5,
      zoom: 2,
    });
  });

  it("takes parseFloat's number from a string, and from anything else it parses", () => {
    expect(publishedFraming(stored("0.5"))).toMatchObject({ zoom: 0.5 });
    // parseFloat reads the leading number and stops, which is the number the
    // published story frames at.
    expect(publishedFraming(stored("0.5 of home"))).toMatchObject({ zoom: 0.5 });
    // It coerces before parsing, so this is a framing at 0.4 rather than a
    // fallback — a `typeof` guard here would answer differently.
    expect(publishedFraming(stored([0.4] as unknown))).toMatchObject({ zoom: 0.4 });
  });

  it("refuses a zoom at or below zero, which is where _isSane does bite", () => {
    // `computeFocalTarget` returns null for these and `_applyFocalTarget`
    // leaves the viewer showing what it was showing.
    for (const zoom of [0, -0.5, -1, "-3"]) {
      expect(publishedFraming(stored(zoom)), `zoom ${String(zoom)}`).toBeNull();
    }
    // `parseFloat("0x10")` is 0 — a number the site refuses, not a fallback.
    expect(publishedFraming(stored("0x10"))).toBeNull();
  });

  it("refuses a centre outside the image, the same way and for the same reason", () => {
    // `_isSane` bounds x and y to 0…1. A capture taken where the viewer had
    // been panned off the image stores exactly such a value.
    for (const x of [5, -0.2, "-0.0833", 1.0001]) {
      expect(publishedFraming(stored(1, x)), `x ${String(x)}`).toBeNull();
      expect(publishedFraming(stored(1, 0.4, x)), `y ${String(x)}`).toBeNull();
    }
    // The edges themselves are in range.
    expect(publishedFraming({ x: 0, y: 1, zoom: 1 })).toEqual({ x: 0, y: 1, zoom: 1 });
  });

  it("carries a zoom under the floor through — the floor is the caller's", () => {
    // The framework frames these, at the floor. What this returns is the
    // number it was given; `clampCaptureZoom` is where the viewer stops.
    for (const zoom of [CAPTURE_MIN_ZOOM_RATIO, 0.05, 1e-9]) {
      expect(publishedFraming(stored(zoom)), `zoom ${zoom}`).toMatchObject({ zoom });
    }
  });
});

describe("captureViewportState — the store cannot hold a framing the site will not render", () => {
  // No image item: the centre is read on these home bounds. The zoom is the
  // same division by home either way, and the floor is what is tested here.
  const homeBounds = { x: 0, y: 0, width: 1, height: 1 };

  it("clamps a viewport pulled below the floor up to it", () => {
    // What the zoom-out button reaches on an unconstrained instance: OSD's own
    // floor is 0.1 of home, and six clicks of 0.67 settle under it.
    const pos = captureViewportState({ x: 0.3, y: 0.7 }, 0.0904583, 0, homeBounds, 1);
    expect(pos.zoom).toBe(CAPTURE_MIN_ZOOM_RATIO);
  });

  it("clamps the RATIO, not the raw viewport zoom, so home zoom still counts", () => {
    // At a home zoom of 2, an OSD zoom of 0.1 is a ratio of 0.05 — under the
    // floor even though the raw number is not.
    expect(captureViewportState({ x: 0.5, y: 0.5 }, 0.1, 0, homeBounds, 2).zoom).toBe(
      CAPTURE_MIN_ZOOM_RATIO
    );
    // And an OSD zoom of 0.4 at the same home zoom is a ratio of 0.2, which is
    // above the floor and must survive.
    expect(captureViewportState({ x: 0.5, y: 0.5 }, 0.4, 0, homeBounds, 2).zoom).toBeCloseTo(
      0.2,
      10
    );
  });

  it("leaves the page alone, and stores an overview's centre as the image's, where replay puts it", () => {
    const pos = captureViewportState({ x: 0.3, y: 0.7 }, 0.01, 2, homeBounds, 1);
    expect(pos.x).toBe(0.5);
    expect(pos.y).toBe(0.5);
    expect(pos.page).toBe("3");
  });

  it("holds the floor on the fallback path as well, since that value is stored too", () => {
    expect(captureViewportState({ x: 0.5, y: 0.5 }, 0.05, 0).zoom).toBe(CAPTURE_MIN_ZOOM_RATIO);
  });
});

describe("viewportToNormalised — sub-1 zoom", () => {
  it("yields a normalised zoom below 1 for an OSD zoom below home", () => {
    const homeBounds = { x: 0, y: 0, width: 1, height: 1 };
    const homeZoom = 2;
    const result = viewportToNormalised(homeBounds, homeZoom, 0.5, 0.5, 0.2396);
    expect(result.zoom).toBeCloseTo(0.1198, 6);
    expect(result.zoom).toBeLessThan(1);
  });

  it("reaches the capture floor exactly when OSD is at its own minimum", () => {
    const homeBounds = { x: 0, y: 0, width: 1, height: 1 };
    const homeZoom = 1;
    // OSD constructed with minZoomImageRatio = CAPTURE_MIN_ZOOM_RATIO bottoms
    // out at vzoom = CAPTURE_MIN_ZOOM_RATIO * homeZoom (getMinZoom()).
    const vzoom = CAPTURE_MIN_ZOOM_RATIO * homeZoom;
    const result = viewportToNormalised(homeBounds, homeZoom, 0.5, 0.5, vzoom);
    expect(result.zoom).toBeCloseTo(CAPTURE_MIN_ZOOM_RATIO, 10);
  });
});

describe("a pulled-back capture survives capture → store → publish → import unclamped", () => {
  it("round-trips a sub-floor-adjacent zoom (0.1198) with no clamping at any stage", () => {
    // 1. Capture: OSD viewport state converted to Telar's normalised zoom.
    const homeBounds = { x: 0, y: 0, width: 1, height: 1 };
    const captured = viewportToNormalised(homeBounds, 2, 0.5, 0.5, 0.2396);
    const zoom = captured.zoom;
    expect(zoom).toBeCloseTo(0.1198, 6);

    // 2. Store: the value-domain read the Y document applies before binding
    // to the `zoom` REAL column. Only finiteness is checked — no range.
    const stored = readCoordinate(zoom);
    expect(stored).toEqual({ ok: true, value: zoom });

    // 3. Publish: serialised into the story CSV's zoom cell verbatim.
    const step = {
      step_number: 1,
      kind: "media" as const,
      object_id: "my-object",
      x: 0.5,
      y: 0.5,
      zoom,
      page: null,
      question: "What do you see?",
      answer: null,
      alt_text: null,
      clip_start: null,
      clip_end: null,
      loop: null,
      layers: [],
    };
    const csv = serializeStoryCsv([step], "weavers");
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
    const dataRow = parsed.data[1]; // row 0 is the bilingual header
    expect(Number(dataRow.zoom)).toBeCloseTo(zoom, 10);

    // 4. Import round trip: the published cell is read back with no clamp.
    const imported = mapStoryCsv([{ step: "1", object: "my-object", zoom: dataRow.zoom }], 1);
    expect(imported.steps[0].zoom).toBeCloseTo(zoom, 10);
  });

  it("round-trips a value below the framework's own floor unclamped — nothing enforces the floor here", () => {
    // The floor is held at capture and in the framework's renderer. Downstream
    // of capture nothing enforces it: neither the Y document, publish, nor
    // import correct a value under 0.1. That is deliberate — a step captured
    // under an earlier release keeps the number it has until the author
    // captures again, and these stages carry it rather than rewriting it.
    const zoom = 0.05;
    const stored = readCoordinate(zoom);
    expect(stored).toEqual({ ok: true, value: zoom });

    const step = {
      step_number: 1,
      kind: "media" as const,
      object_id: "my-object",
      x: 0.5,
      y: 0.5,
      zoom,
      page: null,
      question: null,
      answer: null,
      alt_text: null,
      clip_start: null,
      clip_end: null,
      loop: null,
      layers: [],
    };
    const csv = serializeStoryCsv([step], "weavers");
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
    const dataRow = parsed.data[1];
    expect(Number(dataRow.zoom)).toBeCloseTo(zoom, 10);

    const imported = mapStoryCsv([{ step: "1", object: "my-object", zoom: dataRow.zoom }], 1);
    expect(imported.steps[0].zoom).toBeCloseTo(zoom, 10);
  });
});
