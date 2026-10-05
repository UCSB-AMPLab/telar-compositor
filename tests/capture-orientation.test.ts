// @vitest-environment jsdom

/**
 * The capture viewer's keyboard cannot rotate or mirror the view, through a
 * real OpenSeadragon viewer and its own canvas key handler.
 *
 * A step stores a point, a zoom and a page, and replay neither rotates nor
 * mirrors, so a view turned or flipped while framing is captured as something
 * else. OSD turns the view on `r` / `R` and mirrors it on `f` / `F`
 * (`onCanvasKeyDown`); `holdOrientation` refuses those keys and no others.
 *
 * The viewer is built with OSD's HTML drawer, the one drawer jsdom can
 * construct. That drawer cannot rotate, and `Viewport.setRotation` does
 * nothing on a drawer that cannot, so the rig tells the drawer it can: the
 * canvas drawer the editor uses can, and without that the rotation case would
 * pass with or without the guard. The unguarded control case shows the key
 * does turn the view in this rig.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, afterEach } from "vitest";
import OpenSeadragon from "openseadragon";
import { holdOrientation } from "~/lib/authoring-frame";
import type { KeyedViewer } from "~/lib/authoring-frame";

interface Rig {
  viewer: OpenSeadragon.Viewer;
  press(keyCode: number, shift?: boolean): void;
}

const live: OpenSeadragon.Viewer[] = [];

afterEach(() => {
  for (const viewer of live.splice(0)) viewer.destroy();
  document.body.innerHTML = "";
});

function rig(guarded: boolean): Rig {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const viewer = OpenSeadragon({
    element,
    showNavigationControl: false,
    drawer: "html",
    prefixUrl: "",
  });
  live.push(viewer);
  (viewer.drawer as unknown as { canRotate(): boolean }).canRotate = () => true;
  if (guarded) holdOrientation(viewer as unknown as KeyedViewer);

  // OSD's canvas tracker hands its key handler this event shape.
  const handler = (viewer as unknown as {
    innerTracker: { keyDownHandler(event: unknown): void };
  }).innerTracker.keyDownHandler;
  const press = (keyCode: number, shift = false) =>
    handler({
      originalEvent: { keyCode, code: "", shiftKey: shift },
      keyCode,
      shift,
      ctrl: false,
      alt: false,
      meta: false,
      preventDefault: false,
    });
  return { viewer, press };
}

const R = 82;
const F = 70;
const ZERO = 48;

describe("holdOrientation", () => {
  it("leaves OSD's keys turning and mirroring the view when it is not attached", () => {
    const { viewer, press } = rig(false);
    press(R);
    expect(viewer.viewport.getRotation()).toBe(90);
    press(F);
    expect(viewer.viewport.getFlip()).toBe(true);
  });

  it("refuses r and R, so the view stays upright", () => {
    const { viewer, press } = rig(true);
    press(R);
    expect(viewer.viewport.getRotation()).toBe(0);
    press(R, true);
    expect(viewer.viewport.getRotation()).toBe(0);
  });

  it("refuses f and F, so the view is never mirrored", () => {
    const { viewer, press } = rig(true);
    press(F);
    expect(viewer.viewport.getFlip()).toBe(false);
    press(F, true);
    expect(viewer.viewport.getFlip()).toBe(false);
  });

  it("leaves every other key to OSD", () => {
    const { viewer, press } = rig(true);
    const seen: boolean[] = [];
    viewer.addHandler("canvas-key", (event) => {
      seen.push((event as { preventDefaultAction: boolean }).preventDefaultAction);
    });
    press(ZERO);
    press(R);
    expect(seen).toEqual([false, true]);
  });

  it("stops refusing once released", () => {
    const { viewer, press } = rig(false);
    const release = holdOrientation(viewer as unknown as KeyedViewer);
    release();
    press(R);
    expect(viewer.viewport.getRotation()).toBe(90);
  });
});
