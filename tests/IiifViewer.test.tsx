// @vitest-environment jsdom

/**
 * The viewer's contract with a parent that drives the page.
 *
 * Two things make this delicate. OpenSeadragon is destroyed and rebuilt on
 * every page and source change, so "the viewer" is never one object a parent
 * can hold; and the manifest read and the tile check are asynchronous, so a
 * previous object's answers can arrive after the author has moved to another.
 * Every case below is either about which instance gets built, or about an
 * answer arriving too late to be allowed to build one.
 *
 * The drawer case is a regression guard of its own: OpenSeadragon 6 defaults to
 * the WebGL drawer, whose texImage2D() throws SecurityError on cross-origin
 * IIIF tiles, leaving the viewer blank until a redraw. Constructing with
 * drawer: "canvas" renders deterministically; if the option is dropped, that
 * case fails.
 *
 * @version v1.5.2-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup, act, screen, fireEvent } from "@testing-library/react";
import { createOsdFake, withPoint } from "./helpers/osd-fake";
import type { SourceState, ViewerInstanceMeta } from "~/components/features/objects/IiifViewer";
import { authoringFrameRect, regionMargins } from "~/lib/authoring-frame";
import type { RegionBox } from "~/lib/authoring-frame";

const osd = withPoint(createOsdFake());
vi.mock("openseadragon", () => ({ default: osd.ctor }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

/** The order the authoring frame and the parent's readiness reach an instance. */
const wiring: string[] = [];
const attachFrame = vi.fn((_viewer: unknown, _readRegion?: () => unknown) => {
  wiring.push("frame");
  return () => wiring.push("detached");
});
const holdOrientation = vi.fn((_viewer: unknown) => {
  wiring.push("orientation");
  return () => wiring.push("released");
});
const holdOverviewCentred = vi.fn((_viewer: unknown) => {
  wiring.push("overview");
  return () => wiring.push("overview released");
});
vi.mock("~/lib/authoring-frame", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/authoring-frame")>()),
  measureInAuthoringFrame: (...args: [unknown, (() => unknown)?]) => attachFrame(...args),
  holdOrientation: (viewer: unknown) => holdOrientation(viewer),
  holdOverviewCentred: (viewer: unknown) => holdOverviewCentred(viewer),
}));

import { IiifViewer } from "~/components/features/objects/IiifViewer";

// ---------------------------------------------------------------------------
// Fetch control
// ---------------------------------------------------------------------------

type Responder = () => Promise<Response> | Response;

const responders = new Map<string, Responder>();
let headResponder: (url: string) => Promise<Response> | Response = () =>
  new Response(null, { status: 200 });

function manifest(pageCount: number, base = "https://example.org/iiif/3") {
  return {
    items: Array.from({ length: pageCount }, (_, i) => ({
      items: [{ items: [{ body: { service: [{ id: `${base}/p${i + 1}` }] } }] }],
    })),
  };
}

function serveManifest(url: string, pageCount: number, base?: string) {
  responders.set(url, () => new Response(JSON.stringify(manifest(pageCount, base))));
}

/** A manifest whose response is held until the returned function is called. */
function deferManifest(url: string, pageCount: number) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  responders.set(url, async () => {
    await gate;
    return new Response(JSON.stringify(manifest(pageCount)));
  });
  return () => { release(); };
}

beforeEach(() => {
  cleanup();
  osd.reset();
  wiring.length = 0;
  attachFrame.mockClear();
  holdOrientation.mockClear();
  holdOverviewCentred.mockClear();
  responders.clear();
  headResponder = () => new Response(null, { status: 200 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "HEAD") return headResponder(url);
      const responder = responders.get(url);
      if (!responder) return new Response("", { status: 404 });
      return responder();
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Let queued microtasks and effects settle. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const MANIFEST = "https://example.org/manifest.json";
const MANIFEST_B = "https://example.org/other.json";
const INFO = "https://example.org/iiif/objects/a/info.json";

// ---------------------------------------------------------------------------

describe("IiifViewer — drawer config (blank-until-interaction regression)", () => {
  it("constructs OpenSeadragon with the Canvas2D drawer, not WebGL", async () => {
    render(<IiifViewer manifestUrl={null} infoJsonUrl={INFO} isSelfHosted={false} />);
    await waitFor(() => expect(osd.ctor).toHaveBeenCalled());
    const opts = osd.ctor.mock.calls[0][0];
    expect(opts.drawer).toBe("canvas");
    expect(opts.tileSources).toBe(INFO);
  });
});

describe("IiifViewer — gesture settings (no click-to-zoom)", () => {
  it("disables click and double-click zoom for mouse, pen and touch, keeping scroll and pinch", async () => {
    render(<IiifViewer manifestUrl={null} infoJsonUrl={INFO} isSelfHosted={false} />);
    await waitFor(() => expect(osd.ctor).toHaveBeenCalled());
    const opts = osd.ctor.mock.calls[0][0];
    expect(opts.gestureSettingsMouse).toMatchObject({
      clickToZoom: false,
      dblClickToZoom: false,
      scrollToZoom: true,
    });
    expect(opts.gestureSettingsPen).toMatchObject({
      clickToZoom: false,
      dblClickToZoom: false,
    });
    expect(opts.gestureSettingsTouch).toMatchObject({
      clickToZoom: false,
      dblClickToZoom: false,
      pinchToZoom: true,
    });
  });
});

describe("IiifViewer — minZoomImageRatio", () => {
  it("is not passed at all when the prop is absent — detail route stays byte-identical", async () => {
    render(<IiifViewer manifestUrl={null} infoJsonUrl={INFO} isSelfHosted={false} />);
    await waitFor(() => expect(osd.ctor).toHaveBeenCalled());
    const opts = osd.ctor.mock.calls[0][0];
    expect("minZoomImageRatio" in opts).toBe(false);
  });

  it("is passed through as minZoomImageRatio when the prop is present", async () => {
    render(
      <IiifViewer
        manifestUrl={null}
        infoJsonUrl={INFO}
        isSelfHosted={false}
        minZoomImageRatio={0.1}
      />
    );
    await waitFor(() => expect(osd.ctor).toHaveBeenCalled());
    const opts = osd.ctor.mock.calls[0][0];
    expect(opts.minZoomImageRatio).toBe(0.1);
  });
});

describe("IiifViewer — measuring in the authoring frame, orientation held", () => {
  it("is not attached to the object page's viewer", async () => {
    render(<IiifViewer manifestUrl={null} infoJsonUrl={INFO} isSelfHosted={false} />);
    await waitFor(() => expect(osd.ctor).toHaveBeenCalled());
    await settle();
    expect(attachFrame).not.toHaveBeenCalled();
    expect(holdOrientation).not.toHaveBeenCalled();
    expect(holdOverviewCentred).not.toHaveBeenCalled();
  });

  it("is attached to the capture viewer before the parent is handed it", async () => {
    const onViewerReady = vi.fn(() => { wiring.push("ready"); });
    render(
      <IiifViewer
        manifestUrl={null}
        infoJsonUrl={INFO}
        isSelfHosted={false}
        measureInAuthoringFrame
        onViewerReady={onViewerReady}
      />
    );
    await waitFor(() => expect(onViewerReady).toHaveBeenCalled());
    expect(attachFrame).toHaveBeenCalledWith(osd.last());
    expect(holdOrientation).toHaveBeenCalledWith(osd.last());
    expect(holdOverviewCentred).toHaveBeenCalledWith(osd.last());
    expect(wiring).toEqual(["frame", "orientation", "overview", "ready"]);
  });

  it("is detached as its instance is destroyed", async () => {
    const { unmount } = render(
      <IiifViewer manifestUrl={null} infoJsonUrl={INFO} isSelfHosted={false} measureInAuthoringFrame />
    );
    await waitFor(() => expect(attachFrame).toHaveBeenCalled());
    unmount();
    expect(wiring).toEqual(["frame", "orientation", "overview", "detached", "released", "overview released"]);
  });
});

describe("IiifViewer — the page prop", () => {
  it("selects the constructed instance's tile source", async () => {
    serveManifest(MANIFEST, 3);
    render(
      <IiifViewer manifestUrl={MANIFEST} infoJsonUrl={null} isSelfHosted={false} page={2} />
    );
    await waitFor(() => expect(osd.instances).toHaveLength(1));
    expect(osd.last().tileSource).toBe("https://example.org/iiif/3/p3/info.json");
  });

  it("clamps a target at or beyond the count to the last page", async () => {
    serveManifest(MANIFEST, 3);
    render(
      <IiifViewer manifestUrl={MANIFEST} infoJsonUrl={null} isSelfHosted={false} page={9} />
    );
    await waitFor(() => expect(osd.instances).toHaveLength(1));
    expect(osd.last().tileSource).toBe("https://example.org/iiif/3/p3/info.json");
  });

  it.each([
    ["negative", -2],
    ["fractional", 1.5],
    ["non-finite", Number.NaN],
  ])("treats a %s target as page 1", async (_shape, value) => {
    serveManifest(MANIFEST, 3);
    render(
      <IiifViewer
        manifestUrl={MANIFEST}
        infoJsonUrl={null}
        isSelfHosted={false}
        page={value}
      />
    );
    await waitFor(() => expect(osd.instances).toHaveLength(1));
    expect(osd.last().tileSource).toBe("https://example.org/iiif/3/p1/info.json");
  });

  it("navigates when the prop changes and reasserts nothing on an unchanged rerender", async () => {
    serveManifest(MANIFEST, 3);
    const view = render(
      <IiifViewer manifestUrl={MANIFEST} infoJsonUrl={null} isSelfHosted={false} page={0} />
    );
    await waitFor(() => expect(osd.instances).toHaveLength(1));

    view.rerender(
      <IiifViewer manifestUrl={MANIFEST} infoJsonUrl={null} isSelfHosted={false} page={0} />
    );
    await settle();
    expect(osd.instances).toHaveLength(1);

    view.rerender(
      <IiifViewer manifestUrl={MANIFEST} infoJsonUrl={null} isSelfHosted={false} page={1} />
    );
    await waitFor(() => expect(osd.instances).toHaveLength(2));
    expect(osd.last().tileSource).toBe("https://example.org/iiif/3/p2/info.json");
  });
});

describe("IiifViewer — onSourceState", () => {
  it("reports loading, then ready with the pages and the count", async () => {
    serveManifest(MANIFEST, 3);
    const states: SourceState[] = [];
    render(
      <IiifViewer
        manifestUrl={MANIFEST}
        infoJsonUrl={null}
        isSelfHosted={false}
        onSourceState={(s) => states.push(s)}
      />
    );
    await waitFor(() => expect(states.at(-1)?.status).toBe("ready"));
    expect(states[0]).toMatchObject({ status: "loading", page: 0, pageCount: 0 });
    expect(states[0].pages).toEqual([]);
    const ready = states.at(-1)!;
    expect(ready.pageCount).toBe(3);
    expect(ready.page).toBe(0);
    expect(ready.pages).toHaveLength(3);
    expect(ready.pages[1].tileSource).toBe("https://example.org/iiif/3/p2/info.json");
  });

  it("reports each page change", async () => {
    serveManifest(MANIFEST, 3);
    const states: SourceState[] = [];
    const view = render(
      <IiifViewer
        manifestUrl={MANIFEST}
        infoJsonUrl={null}
        isSelfHosted={false}
        page={0}
        onSourceState={(s) => states.push(s)}
      />
    );
    await waitFor(() => expect(states.at(-1)?.status).toBe("ready"));
    view.rerender(
      <IiifViewer
        manifestUrl={MANIFEST}
        infoJsonUrl={null}
        isSelfHosted={false}
        page={2}
        onSourceState={(s) => states.push(s)}
      />
    );
    await waitFor(() => expect(states.at(-1)?.page).toBe(2));
  });

  it("reports a count change at an equal page index", async () => {
    serveManifest(MANIFEST, 3);
    serveManifest(MANIFEST_B, 5);
    const states: SourceState[] = [];
    const view = render(
      <IiifViewer
        manifestUrl={MANIFEST}
        infoJsonUrl={null}
        isSelfHosted={false}
        page={0}
        onSourceState={(s) => states.push(s)}
      />
    );
    await waitFor(() => expect(states.at(-1)?.pageCount).toBe(3));
    view.rerender(
      <IiifViewer
        manifestUrl={MANIFEST_B}
        infoJsonUrl={null}
        isSelfHosted={false}
        page={0}
        onSourceState={(s) => states.push(s)}
      />
    );
    await waitFor(() => expect(states.at(-1)?.pageCount).toBe(5));
    expect(states.at(-1)?.page).toBe(0);
  });

  it("reports unavailable for a source with nothing usable", async () => {
    const states: SourceState[] = [];
    render(
      <IiifViewer
        manifestUrl={null}
        infoJsonUrl={null}
        isSelfHosted={false}
        onSourceState={(s) => states.push(s)}
      />
    );
    await waitFor(() => expect(states.at(-1)?.status).toBe("unavailable"));
    expect(osd.instances).toHaveLength(0);
  });

  it("reports unavailable when the self-hosted tiles are missing", async () => {
    headResponder = () => new Response(null, { status: 404 });
    const states: SourceState[] = [];
    render(
      <IiifViewer
        manifestUrl={MANIFEST}
        infoJsonUrl={INFO}
        isSelfHosted
        onSourceState={(s) => states.push(s)}
      />
    );
    await waitFor(() => expect(states.at(-1)?.status).toBe("unavailable"));
    expect(osd.instances).toHaveLength(0);
  });

  it.each([
    ["a manifest that answers with an HTTP error", () => new Response("", { status: 500 })],
    ["a manifest that yields no pages", () => new Response(JSON.stringify({}))],
    ["a manifest whose fetch throws", () => { throw new Error("network"); }],
  ])("is ready with one page for %s beside an info.json", async (_case, responder) => {
    responders.set(MANIFEST, responder as Responder);
    const states: SourceState[] = [];
    render(
      <IiifViewer
        manifestUrl={MANIFEST}
        infoJsonUrl={INFO}
        isSelfHosted={false}
        onSourceState={(s) => states.push(s)}
      />
    );
    await waitFor(() => expect(states.at(-1)?.status).toBe("ready"));
    expect(states.at(-1)?.pageCount).toBe(1);
    expect(states.at(-1)?.pages[0].tileSource).toBe(INFO);
  });

  it("reports a count of 1 for a single-page object", async () => {
    serveManifest(MANIFEST, 1);
    const states: SourceState[] = [];
    render(
      <IiifViewer
        manifestUrl={MANIFEST}
        infoJsonUrl={null}
        isSelfHosted={false}
        onSourceState={(s) => states.push(s)}
      />
    );
    await waitFor(() => expect(states.at(-1)?.status).toBe("ready"));
    expect(states.at(-1)?.pageCount).toBe(1);
  });
});

describe("IiifViewer — the built-in page controls", () => {
  it("keeps them, and the previous behaviour, when the three props are omitted", async () => {
    serveManifest(MANIFEST, 3);
    render(<IiifViewer manifestUrl={MANIFEST} infoJsonUrl={null} isSelfHosted={false} />);
    await waitFor(() => expect(osd.instances).toHaveLength(1));
    expect(screen.getByLabelText("viewer_prev_page_aria")).not.toBeNull();
    expect(screen.getByText("1/3")).not.toBeNull();

    await act(async () => {
      screen.getByLabelText("viewer_next_page_aria").click();
    });
    await waitFor(() => expect(osd.instances).toHaveLength(2));
    expect(osd.last().tileSource).toBe("https://example.org/iiif/3/p2/info.json");
  });

  it("removes them under hidePageControls while page and onSourceState still work", async () => {
    serveManifest(MANIFEST, 3);
    const states: SourceState[] = [];
    render(
      <IiifViewer
        manifestUrl={MANIFEST}
        infoJsonUrl={null}
        isSelfHosted={false}
        hidePageControls
        page={1}
        onSourceState={(s) => states.push(s)}
      />
    );
    await waitFor(() => expect(osd.instances).toHaveLength(1));
    expect(screen.queryByLabelText("viewer_prev_page_aria")).toBeNull();
    expect(osd.last().tileSource).toBe("https://example.org/iiif/3/p2/info.json");
    expect(states.at(-1)).toMatchObject({ status: "ready", page: 1, pageCount: 3 });
  });
});

describe("IiifViewer — construction metadata", () => {
  it("names the source key, generation and page of the instance it built", async () => {
    serveManifest(MANIFEST, 3);
    const seen: ViewerInstanceMeta[] = [];
    render(
      <IiifViewer
        manifestUrl={MANIFEST}
        infoJsonUrl={null}
        isSelfHosted={false}
        page={2}
        onViewerReady={(_v, _g, meta) => seen.push(meta)}
      />
    );
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0].page).toBe(2);
    expect(seen[0].generation).toBe(0);
    expect(seen[0].sourceKey).toContain(MANIFEST);
  });

  it("advances the generation once per source, so A to B to A gives three", async () => {
    serveManifest(MANIFEST, 3);
    serveManifest(MANIFEST_B, 2, "https://example.org/other");
    const seen: ViewerInstanceMeta[] = [];
    const at = (url: string) => (
      <IiifViewer
        manifestUrl={url}
        infoJsonUrl={null}
        isSelfHosted={false}
        onViewerReady={(_v, _g, meta) => seen.push(meta)}
      />
    );
    const view = render(at(MANIFEST));
    await waitFor(() => expect(seen).toHaveLength(1));
    view.rerender(at(MANIFEST_B));
    await waitFor(() => expect(seen).toHaveLength(2));
    view.rerender(at(MANIFEST));
    await waitFor(() => expect(seen).toHaveLength(3));
    expect(seen.map((m) => m.generation)).toEqual([0, 1, 2]);
  });

  it("names the instance it destroys, before the replacement is ready", async () => {
    serveManifest(MANIFEST, 3);
    const ready: ViewerInstanceMeta[] = [];
    const gone: ViewerInstanceMeta[] = [];
    const at = (page: number) => (
      <IiifViewer
        manifestUrl={MANIFEST}
        infoJsonUrl={null}
        isSelfHosted={false}
        page={page}
        onViewerReady={(_v, _g, meta) => ready.push(meta)}
        onViewerDestroyed={(meta) => gone.push(meta)}
      />
    );
    const view = render(at(0));
    await waitFor(() => expect(ready).toHaveLength(1));
    expect(gone).toHaveLength(0);

    await act(async () => { view.rerender(at(1)); });
    await waitFor(() => expect(ready).toHaveLength(2));
    // The instance that went is the one page 0 was built for, and it went
    // before the instance for page 1 announced itself.
    expect(gone).toEqual([ready[0]]);

    view.unmount();
    expect(gone).toEqual([ready[0], ready[1]]);
  });
});

describe("IiifViewer — source changes", () => {
  it("builds no instance against the previous pages and re-resolves the target", async () => {
    serveManifest(MANIFEST, 3);
    serveManifest(MANIFEST_B, 1, "https://example.org/single");
    const states: SourceState[] = [];
    const at = (url: string) => (
      <IiifViewer
        manifestUrl={url}
        infoJsonUrl={null}
        isSelfHosted={false}
        page={2}
        onSourceState={(s) => states.push(s)}
      />
    );
    const view = render(at(MANIFEST));
    await waitFor(() => expect(osd.instances).toHaveLength(1));

    view.rerender(at(MANIFEST_B));
    await waitFor(() => expect(states.at(-1)?.pageCount).toBe(1));
    expect(states.at(-1)).toMatchObject({ status: "ready", page: 0, pageCount: 1 });
    expect(osd.instances).toHaveLength(2);
    expect(osd.last().tileSource).toBe("https://example.org/single/p1/info.json");
  });

  it("re-resolves the same numeric target across a source change", async () => {
    serveManifest(MANIFEST, 3);
    serveManifest(MANIFEST_B, 6, "https://example.org/long");
    const at = (url: string) => (
      <IiifViewer
        manifestUrl={url}
        infoJsonUrl={null}
        isSelfHosted={false}
        page={2}
      />
    );
    const view = render(at(MANIFEST));
    await waitFor(() => expect(osd.instances).toHaveLength(1));
    view.rerender(at(MANIFEST_B));
    await waitFor(() => expect(osd.instances).toHaveLength(2));
    expect(osd.last().tileSource).toBe("https://example.org/long/p3/info.json");
  });

  it("resolves a simultaneous source and page change against the new manifest", async () => {
    serveManifest(MANIFEST, 3);
    serveManifest(MANIFEST_B, 6, "https://example.org/long");
    const view = render(
      <IiifViewer manifestUrl={MANIFEST} infoJsonUrl={null} isSelfHosted={false} page={0} />
    );
    await waitFor(() => expect(osd.instances).toHaveLength(1));
    view.rerender(
      <IiifViewer manifestUrl={MANIFEST_B} infoJsonUrl={null} isSelfHosted={false} page={4} />
    );
    await waitFor(() => expect(osd.instances).toHaveLength(2));
    expect(osd.last().tileSource).toBe("https://example.org/long/p5/info.json");
  });

  it("builds nothing until a delayed manifest arrives", async () => {
    const release = deferManifest(MANIFEST, 3);
    const states: SourceState[] = [];
    render(
      <IiifViewer
        manifestUrl={MANIFEST}
        infoJsonUrl={null}
        isSelfHosted={false}
        onSourceState={(s) => states.push(s)}
      />
    );
    await settle();
    expect(osd.instances).toHaveLength(0);
    expect(states.at(-1)?.status).toBe("loading");

    await act(async () => { release(); });
    await waitFor(() => expect(osd.instances).toHaveLength(1));
  });

  it("drops a late manifest response from the source it has left", async () => {
    const release = deferManifest(MANIFEST, 3);
    serveManifest(MANIFEST_B, 2, "https://example.org/other");
    const states: SourceState[] = [];
    const at = (url: string) => (
      <IiifViewer
        manifestUrl={url}
        infoJsonUrl={null}
        isSelfHosted={false}
        onSourceState={(s) => states.push(s)}
      />
    );
    const view = render(at(MANIFEST));
    await settle();
    view.rerender(at(MANIFEST_B));
    await waitFor(() => expect(states.at(-1)?.pageCount).toBe(2));

    await act(async () => { release(); });
    await settle();
    expect(states.at(-1)?.pageCount).toBe(2);
    expect(osd.last().tileSource).toBe("https://example.org/other/p1/info.json");
  });
});

describe("IiifViewer — tile availability", () => {
  it("does not let a previous source's availability authorise a pending self-hosted source", async () => {
    serveManifest(MANIFEST, 3);
    serveManifest(MANIFEST_B, 2, "https://example.org/other");
    let releaseHead: () => void = () => {};
    const at = (url: string, selfHosted: boolean) => (
      <IiifViewer manifestUrl={url} infoJsonUrl={INFO} isSelfHosted={selfHosted} />
    );

    const view = render(at(MANIFEST, false));
    await waitFor(() => expect(osd.instances).toHaveLength(1));

    const gate = new Promise<void>((resolve) => { releaseHead = resolve; });
    headResponder = async () => { await gate; return new Response(null, { status: 200 }); };

    view.rerender(at(MANIFEST_B, true));
    await settle();
    expect(osd.instances).toHaveLength(1);

    await act(async () => { releaseHead(); });
    await waitFor(() => expect(osd.instances).toHaveLength(2));
  });

  it("drops a late HEAD response from the source it has left", async () => {
    serveManifest(MANIFEST, 3);
    serveManifest(MANIFEST_B, 2, "https://example.org/other");
    let releaseHead: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseHead = resolve; });
    headResponder = async () => { await gate; return new Response(null, { status: 404 }); };

    const states: SourceState[] = [];
    const at = (url: string, selfHosted: boolean) => (
      <IiifViewer
        manifestUrl={url}
        infoJsonUrl={INFO}
        isSelfHosted={selfHosted}
        onSourceState={(s) => states.push(s)}
      />
    );

    const view = render(at(MANIFEST, true));
    await settle();
    view.rerender(at(MANIFEST_B, false));
    await waitFor(() => expect(states.at(-1)?.status).toBe("ready"));

    await act(async () => { releaseHead(); });
    await settle();
    expect(states.at(-1)?.status).toBe("ready");
  });
});

// ---------------------------------------------------------------------------
// The region
// ---------------------------------------------------------------------------

/** A pane of fixed size: jsdom lays nothing out, so every element reports it. */
const PANE = { w: 1000, h: 600 };
/** The region beside a card at 40%, in pane pixels. */
const REGION: RegionBox = { x: 400, y: 0, w: 600, h: 600 };
const regionBeside = () => REGION;

function withPaneSize() {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const saved = {
    w: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth"),
    h: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight"),
  };
  Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => PANE.w });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => PANE.h });
  return () => {
    if (saved.w) Object.defineProperty(proto, "clientWidth", saved.w);
    if (saved.h) Object.defineProperty(proto, "clientHeight", saved.h);
  };
}

describe("IiifViewer — no region (the object page, and the editor until it passes one)", () => {
  it("constructs with no viewportMargins and attaches no region reader", async () => {
    const restore = withPaneSize();
    try {
      render(<IiifViewer manifestUrl={null} infoJsonUrl={INFO} isSelfHosted={false} measureInAuthoringFrame />);
      await waitFor(() => expect(attachFrame).toHaveBeenCalled());
      expect("viewportMargins" in osd.ctor.mock.calls[0][0]).toBe(false);
      expect(attachFrame.mock.calls[0]).toHaveLength(1);
      expect(osd.last().viewport.setMargins).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("gives the object page's viewer no margins, no frame and no region", async () => {
    render(<IiifViewer manifestUrl={null} infoJsonUrl={INFO} isSelfHosted={false} />);
    await waitFor(() => expect(osd.ctor).toHaveBeenCalled());
    await settle();
    expect("viewportMargins" in osd.ctor.mock.calls[0][0]).toBe(false);
    expect(attachFrame).not.toHaveBeenCalled();
    expect(osd.last().viewport.setMargins).not.toHaveBeenCalled();
  });

  it("ignores a region on a viewer not measured in the authoring frame", async () => {
    const restore = withPaneSize();
    try {
      render(<IiifViewer manifestUrl={null} infoJsonUrl={INFO} isSelfHosted={false} regionOf={regionBeside} />);
      await waitFor(() => expect(osd.ctor).toHaveBeenCalled());
      await settle();
      expect("viewportMargins" in osd.ctor.mock.calls[0][0]).toBe(false);
      expect(attachFrame).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

describe("IiifViewer — a region", () => {
  let restore: () => void = () => {};
  beforeEach(() => { restore = withPaneSize(); });
  afterEach(() => restore());

  it("constructs with the region's margins and hands the frame a reader of the current function", async () => {
    const regionOf = vi.fn(regionBeside);
    const view = render(
      <IiifViewer manifestUrl={null} infoJsonUrl={INFO} isSelfHosted={false} measureInAuthoringFrame regionOf={regionOf} />
    );
    await waitFor(() => expect(attachFrame).toHaveBeenCalled());
    expect(osd.ctor.mock.calls[0][0].viewportMargins).toEqual(regionMargins(PANE, REGION));
    expect(osd.ctor.mock.calls[0][0].viewportMargins).toEqual({ left: 400, top: 0, right: 0, bottom: 0 });
    expect(regionOf).toHaveBeenCalledWith(PANE);
    const readRegion = attachFrame.mock.calls[0][1] as () => unknown;
    expect(readRegion()).toBe(regionOf);

    // A new function identity is read through, without a new instance.
    const next = vi.fn(() => ({ x: 0, y: 0, w: 1000, h: 400 }));
    view.rerender(
      <IiifViewer manifestUrl={null} infoJsonUrl={INFO} isSelfHosted={false} measureInAuthoringFrame regionOf={next} />
    );
    await settle();
    expect(osd.instances).toHaveLength(1);
    expect(readRegion()).toBe(next);
  });
});

describe("IiifViewer — a region that changes while the pane keeps its size", () => {
  let restore: () => void = () => {};
  beforeEach(() => { restore = withPaneSize(); });
  afterEach(() => restore());

  it("confines the live instance to the new region after the render that changes it", async () => {
    const view = render(
      <IiifViewer manifestUrl={null} infoJsonUrl={INFO} isSelfHosted={false} measureInAuthoringFrame regionOf={regionBeside} />
    );
    await waitFor(() => expect(attachFrame).toHaveBeenCalled());
    await settle();
    const viewport = osd.last().viewport as unknown as {
      getContainerSize(): { x: number; y: number };
      getMargins(): unknown;
      setMargins: ReturnType<typeof vi.fn>;
    };
    const container = viewport.getContainerSize();
    const pane = { w: container.x, h: container.y };
    expect(viewport.getMargins()).toEqual(regionMargins(pane, REGION));
    viewport.setMargins.mockClear();

    const band: RegionBox = { x: 0, y: 0, w: pane.w, h: pane.h * 0.6 };
    view.rerender(
      <IiifViewer manifestUrl={null} infoJsonUrl={INFO} isSelfHosted={false} measureInAuthoringFrame regionOf={() => band} />
    );
    await settle();
    expect(osd.instances).toHaveLength(1);
    expect(viewport.setMargins).toHaveBeenCalledTimes(1);
    expect(viewport.getMargins()).toEqual(regionMargins(pane, band));

    // The same region again, under a new function identity, asks for nothing.
    view.rerender(
      <IiifViewer manifestUrl={null} infoJsonUrl={INFO} isSelfHosted={false} measureInAuthoringFrame regionOf={() => ({ ...band })} />
    );
    await settle();
    expect(viewport.setMargins).toHaveBeenCalledTimes(1);
  });
});

/** A 2D context that records what the guides draw, and the paths they stroke. */
interface DrawnPath { rects: number[][]; arcs: number[][]; moves: number[][] }

function withRecordingCanvas() {
  const paths: DrawnPath[] = [];
  class RecordingPath {
    rects: number[][] = [];
    arcs: number[][] = [];
    moves: number[][] = [];
    constructor() { paths.push(this); }
    rect(...a: number[]) { this.rects.push(a); }
    arc(...a: number[]) { this.arcs.push(a); }
    moveTo(...a: number[]) { this.moves.push(a); }
    lineTo() {}
  }
  const ctx = {
    setTransform() {}, clearRect() {}, stroke() {}, fill() {},
    lineCap: "", strokeStyle: "", lineWidth: 0, fillStyle: "",
  };
  const savedGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as typeof savedGetContext;
  vi.stubGlobal("Path2D", RecordingPath);
  vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => { f(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  return {
    paths,
    restore: () => { HTMLCanvasElement.prototype.getContext = savedGetContext; },
  };
}

describe("IiifViewer — the guides and labels in the region", () => {
  let restorePane: () => void = () => {};
  let canvas: ReturnType<typeof withRecordingCanvas>;
  beforeEach(() => {
    restorePane = withPaneSize();
    canvas = withRecordingCanvas();
  });
  afterEach(() => {
    restorePane();
    canvas.restore();
  });

  const guided = (regionOf?: () => RegionBox) => (
    <IiifViewer
      manifestUrl={null}
      infoJsonUrl={INFO}
      isSelfHosted={false}
      measureInAuthoringFrame
      enableCaptureGuides
      regionOf={regionOf}
    />
  );

  it("draws the frame inscribed in the region, offset by it, with the target at its centre", async () => {
    render(guided(regionBeside));
    await waitFor(() => expect(canvas.paths.length).toBeGreaterThan(0));
    const frame = authoringFrameRect(REGION.w, REGION.h);
    const outline = canvas.paths.find((p) => p.rects.length === 1)!;
    expect(outline.rects[0][0]).toBeCloseTo(REGION.x + frame.x + 1.5, 9);
    expect(outline.rects[0][1]).toBeCloseTo(REGION.y + frame.y + 1.5, 9);
    expect(outline.rects[0][2]).toBeCloseTo(frame.width - 3, 9);
    expect(outline.rects[0][3]).toBeCloseTo(frame.height - 3, 9);
    // The centre dot is at the region's centre, not the pane's.
    const dot = canvas.paths.find((p) => p.arcs.length === 1 && p.arcs[0][2] === 2)!;
    expect(dot.arcs[0][0]).toBeCloseTo(REGION.x + REGION.w / 2, 9);
    expect(dot.arcs[0][1]).toBeCloseTo(REGION.y + REGION.h / 2, 9);
  });

  it("draws the frame in the whole pane without a region", async () => {
    render(guided());
    await waitFor(() => expect(canvas.paths.length).toBeGreaterThan(0));
    const frame = authoringFrameRect(PANE.w, PANE.h);
    const outline = canvas.paths.find((p) => p.rects.length === 1)!;
    expect(outline.rects[0][0]).toBeCloseTo(frame.x + 1.5, 9);
    const dot = canvas.paths.find((p) => p.arcs.length === 1 && p.arcs[0][2] === 2)!;
    expect(dot.arcs[0][0]).toBeCloseTo(PANE.w / 2, 9);
  });

  it("shows the frame label at the frame's top and the stage label, with the guides", async () => {
    render(guided(regionBeside));
    const frameLabel = await screen.findByTestId("frame-label");
    expect(frameLabel.textContent).toBe("stage.frame_label");
    expect(screen.getByTestId("stage-label").textContent).toBe("stage.stage_label");
    await waitFor(() => expect(frameLabel.style.visibility).toBe("visible"));
    const frame = authoringFrameRect(REGION.w, REGION.h);
    expect(parseFloat(frameLabel.style.left)).toBeCloseTo(REGION.x + frame.x + frame.width / 2, 9);
    expect(parseFloat(frameLabel.style.top)).toBeCloseTo(REGION.y + frame.y + 8, 9);
  });

  it("shows the open eye while the guides are on and the crossed eye while they are off", async () => {
    render(guided(regionBeside));
    await screen.findByTestId("frame-label");
    const toggle = screen.getByRole("button", { name: "stage.guides.toggle" });
    expect(toggle.querySelector(".lucide-eye")).not.toBeNull();
    expect(toggle.querySelector(".lucide-eye-off")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.querySelector(".lucide-eye-off")).not.toBeNull();
    expect(toggle.querySelector(".lucide-eye")).toBeNull();
  });

  it("hides both labels when the guides are turned off", async () => {
    render(guided(regionBeside));
    await screen.findByTestId("frame-label");
    fireEvent.click(screen.getByRole("button", { name: "stage.guides.toggle" }));
    expect(screen.queryByTestId("frame-label")).toBeNull();
    expect(screen.queryByTestId("stage-label")).toBeNull();
  });

  it("shows neither label without a region", async () => {
    render(guided());
    await waitFor(() => expect(canvas.paths.length).toBeGreaterThan(0));
    expect(screen.queryByTestId("frame-label")).toBeNull();
    expect(screen.queryByTestId("stage-label")).toBeNull();
  });
});
