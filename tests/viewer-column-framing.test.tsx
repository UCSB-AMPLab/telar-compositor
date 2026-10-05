// @vitest-environment jsdom

/**
 * Framing requests, Capture and Reset.
 *
 * Every OpenSeadragon instance the column sees is a different object built for
 * one page of one source, and the saved framing of a step is meaningless on any
 * other page. So a request records what it is for and waits, and Capture is
 * refused until the instance in front of the author is demonstrably the one the
 * source state describes.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";

vi.mock("openseadragon", async () => {
  const { osd } = await import("./helpers/viewer-column-harness");
  return { default: osd.ctor };
});
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values
        ? `${key}|${Object.entries(values).map(([k, v]) => `${k}=${String(v)}`).join(",")}`
        : key,
    i18n: { language: "en" },
  }),
}));

import { sourceKeyFor } from "~/lib/iiif-pages";
import { CAPTURE_MAX_ZOOM_LEVEL, inscribedFrameHomeZoom } from "~/lib/viewer-utils";
import { osdImageItem } from "./helpers/osd-fake";
import {
  buildColumn,
  installFetch,
  openInstanceForPage,
  openLatest,
  osd,
  renderColumn,
  selfHostedObject,
  SITE_BASE,
  serveObject,
  settle,
  step,
  videoObject,
} from "./helpers/viewer-column-harness";

const CODEX = selfHostedObject("codex", "Codex");
const ATLAS = selfHostedObject("atlas", "Atlas");
const FILM = videoObject("film", "Film");
const OBJECTS = [CODEX, ATLAS, FILM];

beforeEach(() => {
  cleanup();
  osd.reset();
  installFetch();
  serveObject("codex", 3);
  serveObject("atlas", 3);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const capture = () => screen.getByText("viewer.capture_position").closest("button")!;
const reset = () => screen.getByText("viewer.reset_position").closest("button")!;
const next = () => screen.getByLabelText("viewer.next_page_aria");
const prev = () => screen.getByLabelText("viewer.prev_page_aria");

/** Every instance built for the given 0-based page, in construction order. */
function instancesForPage(page: number) {
  return osd.instances.filter((v) =>
    String(v.tileSource).includes(`/p${page + 1}/info.json`)
  );
}

describe("ViewerColumn — capture floor", () => {
  it("constructs the capture instance with the framework's floor as minZoomImageRatio and the raised maximum as maxZoomLevel", async () => {
    await renderColumn(buildColumn, {
      step: step({ object_id: "codex" }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await waitFor(() => expect(osd.instances).toHaveLength(1));
    expect(osd.last().options.minZoomImageRatio).toBe(0.1);
    expect(osd.last().options.maxZoomLevel).toBe(CAPTURE_MAX_ZOOM_LEVEL);
  });

  // `minZoomImageRatio` bounds gestures only, so the column's own zoom buttons
  // have to assert the floor themselves. Where the constraint actually lands the
  // zoom, and what it costs the centre, is measured against the real
  // OpenSeadragon in tests/capture-zoom-constraints.test.ts; what belongs here
  // is the wiring — the fake's zoom is 1, its bounds 0.1 and 4.
  it.each([
    ["viewer.zoom_out_aria", 0.67],
    ["viewer.zoom_in_aria", 1.5],
  ])("zooms to the requested value, within bounds, after %s", async (label, factor) => {
    await renderColumn(buildColumn, {
      step: step({ object_id: "codex" }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await openInstanceForPage(0);
    const vp = osd.last().viewport;

    await act(async () => { fireEvent.click(screen.getByLabelText(label)); });

    expect(vp.zoomTo).toHaveBeenCalledTimes(1);
    expect(vp.zoomTo.mock.calls[0][0]).toBeCloseTo(factor, 10);
  });

  it.each([
    ["viewer.zoom_out_aria", 0.12, 0.67, 0.1],
    ["viewer.zoom_in_aria", 3, 1.5, 4],
  ])(
    "clamps the requested zoom to the instance's own bound after %s",
    async (label, from, factor, landing) => {
      await renderColumn(buildColumn, {
        step: step({ object_id: "codex" }),
        isStepZero: false,
        selectionKey: "id:1",
        objects: OBJECTS,
      });
      await openInstanceForPage(0);
      const vp = osd.last().viewport;
      vp.getZoom.mockReturnValue(from);

      await act(async () => { fireEvent.click(screen.getByLabelText(label)); });

      // Unclamped this would be `from * factor`, past the bound.
      expect(vp.zoomTo.mock.calls[0][0]).toBeCloseTo(landing, 10);
    }
  );

  it.each(["viewer.zoom_out_aria", "viewer.zoom_in_aria"])(
    "ends on the viewport's own constraints after %s, as every other zoom path does",
    async (label) => {
      // The pan bounds move with the zoom, so a framing acceptable before the
      // click can be outside them after it; the constrained bounds, which
      // `settleCentre` pans to, put the image back on screen. What that does to a centre is measured against
      // the real OpenSeadragon in tests/capture-zoom-constraints.test.ts.
      //
      // The ORDER is the assertion, not the count: constrained before the zoom
      // it reads the bounds of the zoom being left behind, correcting a centre
      // against the view the author is leaving and letting the one they asked
      // for stand uncorrected. `invocationCallOrder` is vitest's own sequence
      // number across mocks, so the two are compared as they happened.
      await renderColumn(buildColumn, {
        step: step({ object_id: "codex" }),
        isStepZero: false,
        selectionKey: "id:1",
        objects: OBJECTS,
      });
      await openInstanceForPage(0);
      const vp = osd.last().viewport;

      await act(async () => { fireEvent.click(screen.getByLabelText(label)); });

      expect(vp.zoomTo).toHaveBeenCalledTimes(1);
      // Only the centre is settled, never the zoom, so `applyConstraints`, which
      // also takes the zoom to OSD's limits, is not the call.
      expect(vp.applyConstraints).not.toHaveBeenCalled();
      expect(vp.getConstrainedBounds).toHaveBeenCalledTimes(1);
      expect(vp.getConstrainedBounds.mock.invocationCallOrder[0]).toBeGreaterThan(
        vp.zoomTo.mock.invocationCallOrder[0]
      );
      // The column moves no centre of its own: the constraint is OSD's.
      expect(vp.panTo).not.toHaveBeenCalled();
    }
  );

  it("stores the floor for a viewport that got below it", async () => {
    const column = await renderColumn(buildColumn, {
      step: step({ object_id: "codex" }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await openInstanceForPage(0);
    osd.last().viewport.getZoom.mockReturnValue(0.0904583);

    await act(async () => { fireEvent.click(capture()); });
    expect(column.onCapturePosition.mock.calls[0][0]).toMatchObject({ zoom: 0.1 });
  });

  it("shows a framing stored below the floor as the site would render it", async () => {
    await renderColumn(buildColumn, {
      step: step({ object_id: "codex", page: "1", x: 0.4, y: 0.6, zoom: 0.05 }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await openInstanceForPage(0);
    const vp = instancesForPage(0)[0].viewport;

    // Home zoom is 1 in the fake, so the applied zoom is the ratio itself.
    expect(vp.zoomTo).toHaveBeenCalledTimes(1);
    expect(vp.zoomTo.mock.calls[0][0]).toBeCloseTo(0.1, 10);
    // An overview is centred on the image whatever its x and y, as the site
    // centres it; with no image item open the fake's home bounds stand in.
    expect(vp.panTo.mock.calls[0][0]).toMatchObject({ x: 0.5, y: 0.5 });
  });

  // What the published story does with a stored value is decided by two of its
  // functions in sequence — `_stepFraming` parses and substitutes, `_isSane`
  // then refuses what is left — so a value the editor cannot read is not the
  // same case as one the site refuses. The rows are pinned against
  // `publishedFraming` in tests/capture-zoom-floor.test.ts; these are the two
  // answers reaching the viewer.
  it.each([
    ["not a number", NaN],
    ["infinite", Infinity],
    ["blank", ""],
    ["not numeric at all", "garbage"],
  ])("frames the image's centre at 1 for a %s zoom, as the site does", async (_label, zoom) => {
    await renderColumn(buildColumn, {
      step: step({ object_id: "codex", page: "1", x: 0.4, y: 0.6, zoom: zoom as number }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await openInstanceForPage(0);
    const vp = instancesForPage(0)[0].viewport;

    // Home zoom is 1 in the fake, so the applied zoom is the ratio itself.
    expect(vp.zoomTo.mock.calls[0][0]).toBeCloseTo(1, 10);
    expect(vp.panTo.mock.calls[0][0]).toMatchObject({ x: 0.5, y: 0.5 });
  });

  it.each([
    ["zero", 0, 0.4],
    ["negative", -1, 0.4],
    ["an x off the image", 1, 5],
    ["a negative x", 1, -0.0833],
  ])("applies no framing at all for %s", async (_label, zoom, x) => {
    await renderColumn(buildColumn, {
      step: step({ object_id: "codex", page: "1", x, y: 0.6, zoom }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await openInstanceForPage(0);
    const vp = instancesForPage(0)[0].viewport;

    expect(vp.panTo).not.toHaveBeenCalled();
    expect(vp.zoomTo).not.toHaveBeenCalled();
    // Nor is it sent home: leaving the viewer alone is the published behaviour,
    // and home is a framing of its own.
    expect(vp.goHome).not.toHaveBeenCalled();
  });

  it("does not write anything back for a zoom it refuses to frame", async () => {
    const column = await renderColumn(buildColumn, {
      step: step({ object_id: "codex", page: "1", x: 0.4, y: 0.6, zoom: 0 }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await openInstanceForPage(0);

    expect(column.onCapturePosition).not.toHaveBeenCalled();
    expect(column.props.step?.zoom).toBe(0);
  });

  it("does not rewrite that step on load — showing it is not editing it", async () => {
    const column = await renderColumn(buildColumn, {
      step: step({ object_id: "codex", page: "1", x: 0.4, y: 0.6, zoom: 0.05 }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await openInstanceForPage(0);

    expect(column.onCapturePosition).not.toHaveBeenCalled();
    expect(column.props.step?.zoom).toBe(0.05);
  });
});

/**
 * A 3000×2000 image as OSD 6 places it: at the origin, one viewport unit wide,
 * so image pixels are viewport units times 3000 on both axes. The fake's home
 * bounds stay the unit square, which is where the old conversion measured.
 */
const IMAGE_ITEM = osdImageItem(3000, 2000);

/** Wait for the page's instance, give it the image, then open it. */
async function openWithImage(page: number) {
  await waitFor(() => expect(instancesForPage(page).length).toBeGreaterThan(0));
  const instance = instancesForPage(page).at(-1)!;
  instance.world.getItemAt.mockReturnValue(IMAGE_ITEM);
  await act(async () => { instance.open(); });
  return instance;
}

describe("ViewerColumn — position through the image, zoom in the authoring frame", () => {
  it("measures the capture instance in the authoring frame once its image opens", async () => {
    await renderColumn(buildColumn, {
      step: step({ object_id: "codex" }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    const instance = await openWithImage(0);
    // The fake's pane is 1000×1000.
    expect(instance.viewport.defaultZoomLevel).toBeCloseTo(inscribedFrameHomeZoom(1.5, 1), 12);
    expect(instance.viewport.goHome).toHaveBeenCalledWith(true);
  });

  it("restores a saved position as that point of the image", async () => {
    await renderColumn(buildColumn, {
      step: step({ object_id: "codex", page: "1", x: 0.25, y: 0.25, zoom: 3 }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    const instance = await openWithImage(0);
    const [point] = instance.viewport.panTo.mock.calls[0];
    expect(point.x).toBeCloseTo(750 / 3000, 12);
    expect(point.y).toBeCloseTo(500 / 3000, 12);
  });

  it("captures and reads out the centre as a fraction of the image", async () => {
    const column = await renderColumn(buildColumn, {
      step: step({ object_id: "codex" }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await waitFor(() => expect(instancesForPage(0).length).toBeGreaterThan(0));
    // Image point (2400, 900): 0.8 across, 0.45 down, at zoom 2, where the
    // stored point is the view's centre.
    instancesForPage(0).at(-1)!.viewport.getCenter.mockReturnValue({ x: 0.8, y: 0.3 });
    instancesForPage(0).at(-1)!.viewport.getZoom.mockReturnValue(2);
    await openWithImage(0);

    expect(screen.getAllByText("y 0.450").length).toBeGreaterThan(0);
    await act(async () => { fireEvent.click(capture()); });
    const pos = column.onCapturePosition.mock.calls[0][0];
    expect(pos.x).toBeCloseTo(0.8, 12);
    expect(pos.y).toBeCloseTo(0.45, 12);
  });
});

describe("ViewerColumn — the visitor's view either side of zoom 1 (ruling 17)", () => {
  it("restores a framing above zoom 1 at the stored point, as the site puts it", async () => {
    await renderColumn(buildColumn, {
      step: step({ object_id: "codex", page: "1", x: 0.2, y: 0.8, zoom: 1.5 }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    const instance = await openWithImage(0);
    // Image point (0.2 × 3000, 0.8 × 2000), one unit wide.
    const [point] = instance.viewport.panTo.mock.calls[0];
    expect(point.x).toBeCloseTo(600 / 3000, 12);
    expect(point.y).toBeCloseTo(1600 / 3000, 12);
  });

  it("restores a framing at zoom 1 at the image's centre, whatever is stored", async () => {
    await renderColumn(buildColumn, {
      step: step({ object_id: "codex", page: "1", x: 0.2, y: 0.8, zoom: 1 }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    const instance = await openWithImage(0);
    // Image point (1500, 1000), one unit wide.
    const [point] = instance.viewport.panTo.mock.calls[0];
    expect(point.x).toBeCloseTo(1500 / 3000, 12);
    expect(point.y).toBeCloseTo(1000 / 3000, 12);
  });

  it("stores the view's centre above zoom 1, reads it out, and settles on it", async () => {
    const column = await renderColumn(buildColumn, {
      step: step({ object_id: "codex" }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await waitFor(() => expect(instancesForPage(0).length).toBeGreaterThan(0));
    const instance = instancesForPage(0).at(-1)!;
    // At zoom 1.25 a view centred on image point (900, 900): 0.3 across and
    // 0.45 down, stored as it is.
    instance.viewport.getCenter.mockReturnValue({ x: 0.3, y: 0.3 });
    instance.viewport.getZoom.mockReturnValue(1.25);
    await openWithImage(0);
    expect(screen.getAllByText("x 0.300").length).toBeGreaterThan(0);
    expect(screen.getAllByText("y 0.450").length).toBeGreaterThan(0);

    instance.viewport.panTo.mockClear();
    await act(async () => { fireEvent.click(capture()); });
    const pos = column.onCapturePosition.mock.calls[0][0];
    expect(pos.x).toBeCloseTo(0.3, 12);
    expect(pos.y).toBeCloseTo(0.45, 12);
    expect(pos.zoom).toBeCloseTo(1.25, 12);
    const [point] = instance.viewport.panTo.mock.calls.at(-1)!;
    expect(point.x).toBeCloseTo(900 / 3000, 12);
    expect(point.y).toBeCloseTo(900 / 3000, 12);
  });
});

describe("ViewerColumn — Capture", () => {
  it("is disabled until the instance in front of the author has opened", async () => {
    await renderColumn(buildColumn, {
      step: step({ object_id: "codex" }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await waitFor(() => expect(osd.instances).toHaveLength(1));
    expect(capture().hasAttribute("disabled")).toBe(true);
    await openLatest();
    expect(capture().hasAttribute("disabled")).toBe(false);
  });

  it("captures the page the author is looking at", async () => {
    const column = await renderColumn(buildColumn, {
      step: step({ object_id: "codex" }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await openInstanceForPage(0);
    await act(async () => { fireEvent.click(next()); });
    await openInstanceForPage(1);

    await act(async () => { fireEvent.click(capture()); });
    expect(column.onCapturePosition).toHaveBeenCalledTimes(1);
    expect(column.onCapturePosition.mock.calls[0][0]).toMatchObject({ page: "2" });
  });

  it("hands the write the identity of what the viewer was showing", async () => {
    const column = await renderColumn(buildColumn, {
      step: step({ id: 4, object_id: "codex" }),
      isStepZero: false,
      selectionKey: "id:4",
      objects: OBJECTS,
    });
    await openInstanceForPage(0);
    await act(async () => { fireEvent.click(capture()); });

    // The source key is the instance's own, not one recomputed from the props
    // the render happened to hold.
    expect(column.onCapturePosition.mock.calls[0][1]).toEqual({
      selectionKey: "id:4",
      targetKey: "id:4",
      objectId: "codex",
      sourceKey: sourceKeyFor(
        `${SITE_BASE}/iiif/objects/codex/manifest.json`,
        `${SITE_BASE}/iiif/objects/codex/info.json`
      ),
    });
  });

  it("registers live-coordinate tracking on the instance built after paging", async () => {
    await renderColumn(buildColumn, {
      step: step({ object_id: "codex" }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await openInstanceForPage(0);
    await act(async () => { fireEvent.click(next()); });
    await openInstanceForPage(1);

    const current = osd.last();
    expect(screen.queryByText("viewer.no_position")).toBeNull();
    // The animation handler belongs to THIS instance: firing it moves the bar.
    current.viewport.getCenter.mockReturnValue({ x: 0.25, y: 0.75 });
    current.viewport.getZoom.mockReturnValue(2);
    await act(async () => { current.fire("animation"); });
    expect(screen.getByText("x 0.250")).not.toBeNull();
  });
});

describe("ViewerColumn — framing requests", () => {
  it("restores on the instance for the saved page and never on page 1's", async () => {
    await renderColumn(buildColumn, {
      step: step({ object_id: "codex", page: "2", x: 0.2, y: 0.3, zoom: 2 }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await waitFor(() => expect(instancesForPage(1)).toHaveLength(1));
    // No instance was ever built for page 1 with this target, so nothing there
    // could have been panned; the page-2 instance restores on its own open.
    const target = instancesForPage(1)[0];
    expect(target.viewport.panTo).not.toHaveBeenCalled();
    await act(async () => { target.open(); });
    expect(target.viewport.panTo).toHaveBeenCalledTimes(1);
    expect(target.viewport.zoomTo).toHaveBeenCalledTimes(1);
    for (const other of instancesForPage(0)) {
      expect(other.viewport.panTo).not.toHaveBeenCalled();
    }
  });

  it("applies a request made after construction but before the open", async () => {
    const column = await renderColumn(buildColumn, {
      step: step({ id: 1, object_id: "codex", page: "1" }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await waitFor(() => expect(osd.instances).toHaveLength(1));
    const instance = osd.last();

    // The saved coordinates arrive while the instance is constructed but unopened.
    await column.update({
      step: step({ id: 1, object_id: "codex", page: "1", x: 0.4, y: 0.6, zoom: 3 }),
    });
    expect(instance.viewport.panTo).not.toHaveBeenCalled();

    await act(async () => { instance.open(); });
    expect(instance.viewport.panTo).toHaveBeenCalledTimes(1);
  });

  it("drops a request whose selection changed before the instance opened", async () => {
    const column = await renderColumn(buildColumn, {
      step: step({ id: 1, object_id: "codex", page: "1", x: 0.4, y: 0.6, zoom: 3 }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await waitFor(() => expect(osd.instances).toHaveLength(1));
    const stale = osd.last();

    await column.update({
      step: step({ id: 2, step_number: 2, object_id: "codex", page: "1" }),
      selectionKey: "id:2",
    });
    await act(async () => { stale.open(); });
    expect(stale.viewport.panTo).not.toHaveBeenCalled();
  });

  it("does not reapply a restore after the author browses away and back", async () => {
    await renderColumn(buildColumn, {
      step: step({ object_id: "codex", page: "1", x: 0.4, y: 0.6, zoom: 3 }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await openInstanceForPage(0);
    expect(instancesForPage(0)[0].viewport.panTo).toHaveBeenCalledTimes(1);

    await act(async () => { fireEvent.click(next()); });
    await openInstanceForPage(1);
    await act(async () => { fireEvent.click(prev()); });
    await openInstanceForPage(0);

    const returned = instancesForPage(0).at(-1)!;
    expect(returned.viewport.panTo).not.toHaveBeenCalled();
  });

  it("moves the page and lands the request there when the saved page changes", async () => {
    const column = await renderColumn(buildColumn, {
      step: step({ id: 1, object_id: "codex", page: "1" }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await openInstanceForPage(0);
    // Visit page 2 so an instance for it already exists, then return.
    await act(async () => { fireEvent.click(next()); });
    await openInstanceForPage(1);
    await act(async () => { fireEvent.click(prev()); });
    await openInstanceForPage(0);

    await column.update({
      step: step({ id: 1, object_id: "codex", page: "2", x: 0.1, y: 0.2, zoom: 4 }),
    });
    await openInstanceForPage(1);
    const landed = instancesForPage(1).at(-1)!;
    expect(landed.viewport.panTo).toHaveBeenCalledTimes(1);
  });

  it("applies a coordinate change when the saved page is reached, without moving the page", async () => {
    const column = await renderColumn(buildColumn, {
      step: step({ id: 1, object_id: "codex", page: "2" }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await openInstanceForPage(1);
    await act(async () => { fireEvent.click(next()); });
    await openInstanceForPage(2);

    // A peer captures on the step while the author is browsing page 3.
    await column.update({
      step: step({ id: 1, object_id: "codex", page: "2", x: 0.1, y: 0.2, zoom: 4 }),
    });
    await settle();
    // The page did not move, and page 3's instance was not panned.
    expect(
      screen.getByText(/^viewer\.page_indicator\|/).textContent
    ).toBe("viewer.page_indicator|page=3,count=3");
    expect(instancesForPage(2).at(-1)!.viewport.panTo).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(prev()); });
    await openInstanceForPage(1);
    expect(instancesForPage(1).at(-1)!.viewport.panTo).toHaveBeenCalledTimes(1);
  });

  it("re-targets the saved page and reapplies the framing on a new source", async () => {
    const column = await renderColumn(buildColumn, {
      step: step({ id: 1, object_id: "codex", page: "2", x: 0.1, y: 0.2, zoom: 4 }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await openInstanceForPage(1);

    await column.update({
      step: step({ id: 1, object_id: "atlas", page: "2", x: 0.1, y: 0.2, zoom: 4 }),
    });
    await waitFor(() =>
      expect(String(osd.last().tileSource)).toContain("/atlas/p2/info.json")
    );
    const onAtlas = osd.last();
    await act(async () => { onAtlas.open(); });
    expect(onAtlas.viewport.panTo).toHaveBeenCalledTimes(1);
  });

  it("goes home on the existing instance for an unframed step on the same source and page", async () => {
    const column = await renderColumn(buildColumn, {
      step: step({ id: 1, object_id: "codex", page: "1", x: 0.4, y: 0.6, zoom: 3 }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await openInstanceForPage(0);
    const instance = instancesForPage(0)[0];

    await column.update({
      step: step({ id: 2, step_number: 2, object_id: "codex", page: "1" }),
      selectionKey: "id:2",
    });
    await settle();
    // No new instance was needed: the same source and page, so the same viewer.
    expect(osd.last()).toBe(instance);
    expect(instance.viewport.goHome).toHaveBeenCalled();
  });
});

describe("ViewerColumn — instance records across source changes", () => {
  it("refuses a stale record after codex, atlas, codex until the new instance opens", async () => {
    const column = await renderColumn(buildColumn, {
      step: step({ id: 1, object_id: "codex", page: "1", x: 0.4, y: 0.6, zoom: 3 }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await openInstanceForPage(0);
    expect(capture().hasAttribute("disabled")).toBe(false);

    await column.update({ step: step({ id: 1, object_id: "atlas", page: "1", x: 0.4, y: 0.6, zoom: 3 }) });
    await waitFor(() => expect(capture().hasAttribute("disabled")).toBe(true));

    await column.update({ step: step({ id: 1, object_id: "codex", page: "1", x: 0.4, y: 0.6, zoom: 3 }) });
    await settle();
    // Back on the first object, but its earlier instance is gone; Capture stays
    // refused until the replacement instance for this source has opened.
    expect(capture().hasAttribute("disabled")).toBe(true);
    await waitFor(() =>
      expect(String(osd.last().tileSource)).toContain("/codex/p1/info.json")
    );
    await openLatest();
    expect(capture().hasAttribute("disabled")).toBe(false);
  });

  it("refuses a stale record and a capture across an image, a video and the same image", async () => {
    const column = await renderColumn(buildColumn, {
      step: step({ id: 1, object_id: "codex", page: "1", x: 0.4, y: 0.6, zoom: 3 }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await openInstanceForPage(0);

    // A video unmounts the viewer entirely, so the column reports nothing.
    await column.update({ step: step({ id: 1, object_id: "film" }) });
    await settle();
    expect(screen.queryByText("viewer.capture_position")).toBeNull();

    await column.update({
      step: step({ id: 1, object_id: "codex", page: "1", x: 0.4, y: 0.6, zoom: 3 }),
    });
    await settle();
    expect(capture().hasAttribute("disabled")).toBe(true);
    // A capture attempted before the replacement opens writes nothing.
    await act(async () => { fireEvent.click(capture()); });
    expect(column.onCapturePosition).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(String(osd.last().tileSource)).toContain("/codex/p1/info.json")
    );
    const replacement = osd.last();
    expect(replacement.viewport.panTo).not.toHaveBeenCalled();
    await act(async () => { replacement.open(); });
    expect(replacement.viewport.panTo).toHaveBeenCalledTimes(1);
    expect(capture().hasAttribute("disabled")).toBe(false);
  });
});

describe("ViewerColumn — Reset", () => {
  it("is enabled for a saved position of zero and restores it", async () => {
    await renderColumn(buildColumn, {
      step: step({ object_id: "codex", page: "1", x: 0, y: 0, zoom: 1 }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await openInstanceForPage(0);
    const instance = instancesForPage(0)[0];
    expect(reset().hasAttribute("disabled")).toBe(false);

    instance.viewport.panTo.mockClear();
    await act(async () => { fireEvent.click(reset()); });
    expect(instance.viewport.panTo).toHaveBeenCalledTimes(1);
  });

  it("is disabled with no saved coordinates", async () => {
    await renderColumn(buildColumn, {
      step: step({ object_id: "codex" }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await openInstanceForPage(0);
    expect(reset().hasAttribute("disabled")).toBe(true);
  });

  it("lands on the saved page from another page and from that page itself", async () => {
    await renderColumn(buildColumn, {
      step: step({ object_id: "codex", page: "2", x: 0.1, y: 0.2, zoom: 4 }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await openInstanceForPage(1);
    const onSavedPage = instancesForPage(1)[0];
    expect(onSavedPage.viewport.panTo).toHaveBeenCalledTimes(1);

    // From the saved page itself.
    onSavedPage.viewport.panTo.mockClear();
    await act(async () => { fireEvent.click(reset()); });
    expect(onSavedPage.viewport.panTo).toHaveBeenCalledTimes(1);

    // From another page: the page returns first, then the framing lands.
    await act(async () => { fireEvent.click(next()); });
    await openInstanceForPage(2);
    await act(async () => { fireEvent.click(reset()); });
    await openInstanceForPage(1);
    expect(instancesForPage(1).at(-1)!.viewport.panTo).toHaveBeenCalledTimes(1);
  });

  it("lands on the last page for a saved page beyond the count", async () => {
    await renderColumn(buildColumn, {
      step: step({ object_id: "codex", page: "900", x: 0.1, y: 0.2, zoom: 4 }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    // Three pages, so the saved 900th is the third, and the request the initial
    // render made resolves there once the count is known.
    await openInstanceForPage(2);
    const clamped = instancesForPage(2)[0];
    expect(clamped.viewport.panTo).toHaveBeenCalledTimes(1);

    // Reset asks for the saved page again — still 900, still the third.
    clamped.viewport.panTo.mockClear();
    await act(async () => { fireEvent.click(reset()); });
    expect(clamped.viewport.panTo).toHaveBeenCalledTimes(1);
  });
});

describe("ViewerColumn — an instance that has been destroyed", () => {
  it("neither receives nor consumes a request made while it is being replaced", async () => {
    const column = await renderColumn(buildColumn, {
      step: step({ id: 1, object_id: "codex", page: "2" }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await openInstanceForPage(1);
    const onSavedPage = instancesForPage(1)[0];

    // Paging destroys the instance for page 2 and starts building page 3's; the
    // synchronous act stops in that gap, before the replacement is constructed.
    act(() => { fireEvent.click(next()); });
    expect(onSavedPage.destroyed).toBe(true);

    // A peer's capture on the step arrives in the gap. Its request belongs to
    // page 2, whose instance has gone.
    await column.update({
      step: step({ id: 1, object_id: "codex", page: "2", x: 0.1, y: 0.2, zoom: 4 }),
    });
    await openInstanceForPage(2);
    expect(onSavedPage.viewport.panTo).not.toHaveBeenCalled();

    // Returning to page 2 restores on the instance built for it.
    await act(async () => { fireEvent.click(prev()); });
    await openInstanceForPage(1);
    expect(instancesForPage(1).at(-1)!.viewport.panTo).toHaveBeenCalledTimes(1);
  });
});
