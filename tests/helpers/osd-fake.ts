/**
 * A lifecycle-capable OpenSeadragon fake.
 *
 * The viewer destroys and reconstructs OpenSeadragon on every page and source
 * change, and the framing a step restores is applied on the `open` event of the
 * instance built for that page. A fake that only records construction cannot
 * express any of that, so this one returns a distinct instance per call, keeps
 * them in construction order, drops an instance's handlers on `destroy`, and
 * leaves `open` for the test to fire whenever it likes — including never, and
 * including after a later instance has been built.
 *
 * @version v1.5.0-beta
 */

import { vi } from "vitest";
import type { ImageItem } from "~/lib/viewer-utils";

export interface FakeViewport {
  panTo: ReturnType<typeof vi.fn>;
  zoomTo: ReturnType<typeof vi.fn>;
  goHome: ReturnType<typeof vi.fn>;
  getCenter: ReturnType<typeof vi.fn>;
  getZoom: ReturnType<typeof vi.fn>;
  getHomeBounds: ReturnType<typeof vi.fn>;
  getHomeZoom: ReturnType<typeof vi.fn>;
  zoomBy: ReturnType<typeof vi.fn>;
  /** The instance's own zoom bounds, which the column's zoom buttons clamp against. */
  getMinZoom: ReturnType<typeof vi.fn>;
  getMaxZoom: ReturnType<typeof vi.fn>;
  /** OSD's own re-assertion of the zoom and pan bounds after a programmatic move. */
  applyConstraints: ReturnType<typeof vi.fn>;
  getConstrainedBounds: ReturnType<typeof vi.fn>;
  viewportToViewerElementCoordinates: ReturnType<typeof vi.fn>;
  /** The pane's size in pixels, which the authoring frame is inscribed in. */
  getContainerSize: ReturnType<typeof vi.fn>;
  /**
   * OSD's viewport margins: the constructor's `viewportMargins`, or zero, until
   * `setMargins` replaces them.
   */
  getMargins: ReturnType<typeof vi.fn>;
  setMargins: ReturnType<typeof vi.fn>;
  /** Set by the authoring frame where there is an image to measure. */
  defaultZoomLevel?: number;
}

export interface FakeViewer {
  options: Record<string, unknown>;
  tileSource: unknown;
  destroyed: boolean;
  viewport: FakeViewport;
  /**
   * The tiled images. `getItemAt(0)` answers null by default — an instance with
   * no image geometry, where position falls back to the home bounds and the
   * authoring frame leaves home alone. A test that needs geometry installs an
   * item with `getItemAt.mockReturnValue(...)`.
   */
  world: { getItemAt: ReturnType<typeof vi.fn> };
  addHandler: (event: string, handler: () => void) => void;
  addOnceHandler: (event: string, handler: () => void) => void;
  removeHandler: (event: string, handler: () => void) => void;
  destroy: ReturnType<typeof vi.fn>;
  isOpen: () => boolean;
  /** Fire the `open` event on this instance, as OSD does once tiles resolve. */
  open: () => void;
  /** Fire any other event this instance has handlers for. */
  fire: (event: string) => void;
}

export interface OsdFake {
  ctor: ReturnType<typeof vi.fn>;
  instances: FakeViewer[];
  reset: () => void;
  /** The most recently constructed instance. */
  last: () => FakeViewer;
}

export function createOsdFake(): OsdFake {
  const instances: FakeViewer[] = [];

  const ctor = vi.fn((options: Record<string, unknown>) => {
    const handlers = new Map<string, Array<() => void>>();
    const onceHandlers = new Map<string, Array<() => void>>();
    let opened = false;
    const zero = { left: 0, top: 0, right: 0, bottom: 0 };
    let margins = { ...zero, ...((options.viewportMargins as object | undefined) ?? {}) };

    const viewport: FakeViewport = {
      panTo: vi.fn(),
      zoomTo: vi.fn(),
      goHome: vi.fn(),
      getCenter: vi.fn(() => ({ x: 0.5, y: 0.5 })),
      getZoom: vi.fn(() => 1),
      getHomeBounds: vi.fn(() => ({ x: 0, y: 0, width: 1, height: 1 })),
      getHomeZoom: vi.fn(() => 1),
      zoomBy: vi.fn(),
      // Home zoom is 1 here, and OSD derives these from it: the floor is
      // `minZoomImageRatio` of home, the ceiling is well above it.
      getMinZoom: vi.fn(() => 0.1),
      getMaxZoom: vi.fn(() => 4),
      applyConstraints: vi.fn(),
      getConstrainedBounds: vi.fn(() => ({ x: 0, y: 0, width: 1, height: 1 })),
      viewportToViewerElementCoordinates: vi.fn(() => ({ x: 0, y: 0 })),
      getContainerSize: vi.fn(() => ({ x: 1000, y: 1000 })),
      getMargins: vi.fn(() => ({ ...margins })),
      setMargins: vi.fn((next: object) => {
        margins = { ...zero, ...next };
      }),
    };

    const viewer: FakeViewer = {
      options,
      tileSource: options.tileSources,
      destroyed: false,
      viewport,
      world: { getItemAt: vi.fn(() => null) },
      addHandler: (event, handler) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      addOnceHandler: (event, handler) => {
        const list = onceHandlers.get(event) ?? [];
        list.push(handler);
        onceHandlers.set(event, list);
      },
      removeHandler: (event, handler) => {
        const list = handlers.get(event);
        if (!list) return;
        const at = list.indexOf(handler);
        if (at >= 0) list.splice(at, 1);
      },
      destroy: vi.fn(() => {
        viewer.destroyed = true;
        handlers.clear();
        onceHandlers.clear();
      }),
      isOpen: () => opened,
      fire: (event) => {
        for (const handler of [...(handlers.get(event) ?? [])]) handler();
      },
      open: () => {
        opened = true;
        for (const handler of [...(handlers.get("open") ?? [])]) handler();
        const once = onceHandlers.get("open") ?? [];
        onceHandlers.set("open", []);
        for (const handler of [...once]) handler();
      },
    };

    instances.push(viewer);
    return viewer;
  });

  return {
    ctor,
    instances,
    reset: () => {
      instances.length = 0;
      ctor.mockClear();
    },
    last: () => instances[instances.length - 1],
  };
}

/** Constructs Points for the capture-guides overlay; the fake needs no geometry. */
export function withPoint(fake: OsdFake) {
  const module = fake.ctor as unknown as Record<string, unknown>;
  module.Point = class {
    x: number;
    y: number;
    constructor(x: number, y: number) {
      this.x = x;
      this.y = y;
    }
  };
  return fake;
}

/**
 * OpenSeadragon 6's `TiledImage` conversions for one image of `W` × `H` pixels,
 * placed at `origin` in viewport units and `width` viewport units wide (a lone
 * image sits at the origin, one unit wide). OSD's `_viewportToImageDelta` and
 * `_imageToViewportDelta` scale both axes by `W / width`, its `contentAspectX`
 * being `W / H`; this does the same and nothing more.
 */
export function osdImageItem(
  W: number,
  H: number,
  origin: { x: number; y: number } = { x: 0, y: 0 },
  width = 1
): ImageItem {
  const k = W / width;
  return {
    getContentSize: () => ({ x: W, y: H }),
    viewportToImageCoordinates: (x, y) => ({ x: (x - origin.x) * k, y: (y - origin.y) * k }),
    imageToViewportCoordinates: (x, y) => ({ x: x / k + origin.x, y: y / k + origin.y }),
  };
}
