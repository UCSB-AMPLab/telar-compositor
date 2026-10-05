/**
 * `CAPTURE_MIN_ZOOM_RATIO` against the floor the framework actually honours.
 *
 * The editor's capture viewer is allowed to pull back exactly as far as the
 * published story will, so an author composing here can ask for every framing a
 * spreadsheet author could type. Two numbers in two repositories have to agree
 * for that to hold, and nothing but this file notices when they stop agreeing.
 *
 * Four checks are kept, because they fail on different drifts.
 *
 * The CLAMP check drives the framework's own `overviewPullFraction` across a
 * range. It establishes the clamp's numerical behaviour and nothing about the
 * framing that number feeds.
 *
 * The FRAMING check drives `snapIiifToPosition`, which reaches the private
 * `_applyFocalTarget` where the clamp is actually spent, and asserts on the
 * rectangle the framework hands OSD. It establishes two things the clamp check
 * cannot: that the floor reaches the framing at all — every authored zoom below
 * it frames identically — and that the framing it reaches is the whole-object
 * fit scaled by the clamped zoom, so an authored 1 frames exactly the object
 * and the floor frames it in a rectangle ten times as wide. This is what covers
 * the arithmetic AROUND the clamp: `s_fit * pull` becoming `s_fit * pull * 2`
 * fails all three of its assertions and not one of the clamp check's.
 *
 * The SOURCE-TEXT check reads the declaration and the expression the floor
 * reaches the framing through. It stays because it is the only one of the
 * four that fails on a RENAME rather than on a changed number.
 *
 * The SUBSTITUTION check drives what `_stepFraming` makes of a cell before
 * either of the two above sees it — the editor's answer to a cell that is not a
 * number depends on it entirely. The function is private to card-pool.js, so it
 * is reached through `initCardPool`, which builds the first scene's plate from
 * its result and parks that on the plate's viewer card. Reading the source
 * instead would establish only that the text is still there: a guard INSERTED in
 * front of the parse leaves every quoted expression standing while a numeric
 * cell stops parsing, and that narrowing is the drift this check exists for.
 *
 * The same mechanism holds the authoring frame together. The editor
 * measures a zoom in a frame of `AUTHORING_ASPECT` and draws a focal circle of
 * `FOCAL_DIAMETER_FRAC` of it, and both must equal what replay reads: the
 * aspect is imported from `authoring-frame.js`, the diameter's declaration is
 * read and its effect driven through `computeFocalTarget`. A captured position
 * is replayed through `snapIiifToPosition` and must be fitted centred on the
 * image point the author centred.
 *
 * The framework's module is browser code: it reaches `getComputedStyle` and
 * `matchMedia` while loading. It is therefore driven the way this repo drives
 * the framework's Python — in a subprocess that answers in JSON — rather than
 * imported here, because Vitest's module runner will not resolve a file
 * outside this project and a copy of the file inside it would be the
 * transcription these tests exist to avoid. `matchMedia` is stubbed to report
 * no match, which is the desktop branch the measurements behind this floor
 * were taken on.
 *
 * @version v1.5.0-beta
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { it, expect } from "vitest";

import {
  AUTHORING_ASPECT,
  CAPTURE_MIN_ZOOM_RATIO,
  FOCAL_DIAMETER_FRAC,
  FULL_OBJECT_FRAMING,
  authoringHomeZoom,
  captureViewportState,
} from "~/lib/viewer-utils";
import { osdImageItem } from "./helpers/osd-fake";
import { jsdomPrelude } from "./helpers/framework-jsdom";
import {
  describeWithFramework,
  FRAMEWORK_SCRIPTS_DIR,
  FRAMEWORK_TIMEOUT_MS,
  PUBLISHED_FRAMEWORK_TAG,
} from "./helpers/framework-checkout";

/** The framework's `telar-story/` directory, beside the `scripts/` other probes use. */
const TELAR_STORY_DIR = join(FRAMEWORK_SCRIPTS_DIR, "..", "assets", "js", "telar-story");

/** The framework's card module. */
const IIIF_CARD_JS = join(TELAR_STORY_DIR, "iiif-card.js");

/** The framework's authoring-frame module, which declares the aspect replay divides by. */
const AUTHORING_FRAME_JS = join(TELAR_STORY_DIR, "authoring-frame.js");

/** The framework checkout itself, for reading a file at the published tag. */
const FRAMEWORK_CHECKOUT_DIR = join(FRAMEWORK_SCRIPTS_DIR, "..");

/** The document under the subprocess, and the browser globals the module loads against. */
const JSDOM_PRELUDE = jsdomPrelude();

/**
 * A zoom to probe the framework with.
 *
 * JSON carries no NaN or Infinity, so those three travel as their names and
 * `DECODE_ZOOMS` turns them back into real numbers on the far side — `Number`
 * being the identity on everything else. The decode has to happen, because a
 * STRING is not what the published site would ever hand the framework and is
 * not what these tests are about: `Number.isFinite` rejects every string, so
 * passing "NaN" through would take the non-finite branch for the wrong reason,
 * and "0.2" would take it too. One assertion below pins the decode for exactly
 * that reason.
 */
type ProbeZoom = number | "NaN" | "Infinity" | "-Infinity";

/**
 * Read the zooms the caller sent and undo the JSON transport.
 *
 * Under `node -e`, argv[1] is the first argument after the script: there is no
 * script path to occupy it.
 */
const DECODE_ZOOMS = "const zooms = JSON.parse(process.argv[1]).map(Number);";

/**
 * The framework's own floor and its clamp applied to `zooms`, in one node
 * subprocess with a jsdom document under it.
 *
 * Throws where the module does not export the pair, rather than reporting a
 * default: a floor that cannot be driven has not been checked, and a caller
 * that carried on would report agreement it never established.
 */
function frameworkOverviewPull(zooms: ProbeZoom[]): { floor: number; pulls: number[] } {
  const script = [
    ...JSDOM_PRELUDE,
    `const m = await import(${JSON.stringify(`file://${IIIF_CARD_JS}`)});`,
    "if (typeof m.overviewPullFraction !== 'function' || typeof m.OVERVIEW_MIN_FRACTION !== 'number') {",
    "  throw new Error('iiif-card.js exports no overviewPullFraction/OVERVIEW_MIN_FRACTION pair');",
    "}",
    DECODE_ZOOMS,
    "console.log(JSON.stringify({ floor: m.OVERVIEW_MIN_FRACTION, pulls: zooms.map(m.overviewPullFraction) }));",
  ].join("\n");
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script, JSON.stringify(zooms)],
    { encoding: "utf-8", timeout: FRAMEWORK_TIMEOUT_MS },
  );
  return JSON.parse(out.trim().split("\n").at(-1) as string) as {
    floor: number;
    pulls: number[];
  };
}

/**
 * The geometry the framing probe below composes into, chosen so the answer is
 * determined by the clamp and nothing else.
 *
 * The card overlay is given zero width, which puts its right edge left of the
 * 60% mark the framework's placement heuristic tests and leaves the uncovered
 * region the WHOLE frame. The frame and the image are given the same aspect, so
 * the whole-object fit is a single number on both axes. Under those two the
 * framework's own apply recipe reduces to: an authored zoom of 1 frames exactly
 * the image, and a lower one frames it in a rectangle 1/zoom as wide, centred.
 *
 * Nothing here transcribes the recipe — it is the framework that computes it —
 * but the geometry is picked so the expected rectangle can be stated in image
 * pixels rather than derived alongside it.
 */
const FRAME_W = 1440;
const FRAME_H = 900;
const IMAGE_W = 4000;
const IMAGE_H = 2500; // IMAGE_W / IMAGE_H === FRAME_W / FRAME_H

/** A rectangle the framework asked OSD to fit, in image pixels. */
interface AppliedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The framing the framework applies for each of `zooms`, as the image-pixel
 * rectangle it hands `viewport.fitBounds`, or null where it performed no
 * framing operation at all.
 *
 * `snapIiifToPosition` is the framework's own entry point onto the private
 * `_applyFocalTarget`, where the clamp is spent. The viewer card under it is
 * stubbed down to what that path reads — the source dimensions, the container
 * rect, and the two viewport calls it ends on — so no OpenSeadragon is needed
 * and no part of the recipe is reimplemented. `imageToViewportRectangle` is the
 * identity, which reports the applied rectangle in image pixels; the real one
 * is a linear map, so this changes the units of the answer and nothing about
 * which rectangle was chosen.
 *
 * `centre` is the authored x and y, already parsed: this entry point is
 * downstream of `_stepFraming`, so what it measures is what `_isSane` and the
 * apply recipe do with a pair of numbers, not what the module makes of a cell.
 */
function frameworkAppliedFraming(
  zooms: ProbeZoom[],
  storyDir: string,
  centre: { x: number; y: number } = { x: 0.5, y: 0.5 },
): Array<AppliedRect | null> {
  const script = [
    ...JSDOM_PRELUDE,
    `for (const [k, v] of [['innerWidth', ${FRAME_W}], ['innerHeight', ${FRAME_H}]]) {`,
    "  Object.defineProperty(dom.window, k, { value: v, configurable: true });",
    "}",
    "dom.window.OpenSeadragon = { Rect: class { constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }); } } };",
    `const { state } = await import(${JSON.stringify(`file://${join(storyDir, "state.js")}`)});`,
    // A zero-width card leaves the whole frame as the uncovered region.
    "state.cardOverlayRect = { x: 0, y: 0, width: 0, height: 0 };",
    `const m = await import(${JSON.stringify(`file://${join(storyDir, "iiif-card.js")}`)});`,
    "if (typeof m.snapIiifToPosition !== 'function') {",
    "  throw new Error('iiif-card.js exports no snapIiifToPosition');",
    "}",
    "const drive = (zoom) => {",
    "  const applied = [];",
    "  m.snapIiifToPosition({",
    "    osdViewer: {",
    `      world: { getItemAt: () => ({ source: { width: ${IMAGE_W}, height: ${IMAGE_H} } }) },`,
    "      viewport: {",
    "        imageToViewportRectangle: (r) => r,",
    "        fitBounds: (r) => applied.push({ x: r.x, y: r.y, width: r.width, height: r.height }),",
    "      },",
    "    },",
    `    osdWrapper: { containerEl: { getBoundingClientRect: () => ({ width: ${FRAME_W}, height: ${FRAME_H} }) } },`,
    `  }, ${centre.x}, ${centre.y}, zoom);`,
    "  return applied.length === 1 ? applied[0] : null;",
    "};",
    DECODE_ZOOMS,
    "console.log(JSON.stringify(zooms.map(drive)));",
  ].join("\n");
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script, JSON.stringify(zooms)],
    { encoding: "utf-8", timeout: FRAMEWORK_TIMEOUT_MS },
  );
  return JSON.parse(out.trim().split("\n").at(-1) as string) as Array<AppliedRect | null>;
}

/** What `_stepFraming` made of one step's stored cells, in the framework's own units. */
interface CellFraming {
  x: number;
  y: number;
  zoom: number;
}

/**
 * What the framework makes of each step's STORED CELLS, before any framing.
 *
 * Calls `stepFraming` — the framework's own exported function — once per entry.
 * It is the whole contract: every path that frames a step goes through it, and
 * what it substitutes for a cell it cannot read is what the editor's
 * `publishedFraming` mirrors.
 *
 * Driving it through `initCardPool` and reading a viewer card's `pendingZoom`
 * would measure the same thing at one remove, and did until the card pool
 * stopped owning framing. Calling the exported function is both narrower and
 * harder to misread: the probe cannot answer from a structure that has moved.
 *
 * Every cell travels as JSON, so a stored value arrives as the string or the
 * number it was authored as. NaN and the infinities cannot travel that way and
 * are not asked for here; what they become is the clamp's business, measured
 * above, and `publishedFraming`'s, measured in tests/capture-zoom-floor.test.ts.
 */
function frameworkStepFraming(
  steps: Array<Record<string, unknown>>,
  storyDir: string,
): Array<CellFraming | null> {
  const script = [
    ...JSDOM_PRELUDE,
    // The module's import graph reaches the viewer; neither is entered.
    "globalThis.fetch = async () => { throw new Error('the probe opens no viewer'); };",
    "dom.window.OpenSeadragon = { Rect: class {} };",
    `const plate = await import(${JSON.stringify(`file://${join(storyDir, "plates", "iiif-plate.js")}`)});`,
    "const out = JSON.parse(process.argv[1]).map((step) => {",
    "  const { x, y, zoom } = plate.stepFraming(step);",
    "  return { x, y, zoom };",
    "});",
    "console.log(JSON.stringify(out));",
  ].join("\n");
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script, JSON.stringify(steps)],
    { encoding: "utf-8", timeout: FRAMEWORK_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(out.trim().split("\n").at(-1) as string) as Array<CellFraming | null>;
}

/**
 * The framework's own declaration of the whole-object framing, read by
 * importing it rather than by matching its source text.
 *
 * A regex over a file can only ever report "not found", which reads the same
 * whether the constant was renamed, moved, or never existed — and when it moved
 * to `plates/iiif-plate.js` that is exactly what it reported, as three vague
 * failures rather than one. An import fails at module resolution and names the
 * specifier, so the next move says where it went.
 */
function frameworkFullObjectFraming(storyDir: string): CellFraming {
  const script = [
    ...JSDOM_PRELUDE,
    "globalThis.fetch = async () => { throw new Error('the probe opens no viewer'); };",
    "dom.window.OpenSeadragon = { Rect: class {} };",
    `const plate = await import(${JSON.stringify(`file://${join(storyDir, "plates", "iiif-plate.js")}`)});`,
    "if (!plate.FULL_OBJECT_FRAMING) throw new Error('iiif-plate.js exports no FULL_OBJECT_FRAMING');",
    "console.log(JSON.stringify(plate.FULL_OBJECT_FRAMING));",
  ].join("\n");
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { encoding: "utf-8", timeout: FRAMEWORK_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(out.trim().split("\n").at(-1) as string) as CellFraming;
}

/** Assert a framing to within floating-point error, naming the zoom that failed. */
function expectRect(actual: AppliedRect | null, expected: AppliedRect, at: string) {
  expect(actual, `no framing applied at ${at}`).not.toBeNull();
  const rect = actual as AppliedRect;
  for (const key of ["x", "y", "width", "height"] as const) {
    expect(rect[key], `${key} at ${at}`).toBeCloseTo(expected[key], 6);
  }
}

describeWithFramework("the capture floor, driven through the framework's own clamp", () => {
  it(
    "floors an authored zoom exactly where the capture viewer stops",
    () => {
      // Below the floor the framework refuses to stand back further, so the
      // smallest fraction it will ever apply is the one our viewer stops at.
      const { floor, pulls } = frameworkOverviewPull([
        CAPTURE_MIN_ZOOM_RATIO,
        CAPTURE_MIN_ZOOM_RATIO / 2,
        0,
        -1,
      ]);
      expect(floor).toBe(CAPTURE_MIN_ZOOM_RATIO);
      expect(pulls).toEqual([
        CAPTURE_MIN_ZOOM_RATIO,
        CAPTURE_MIN_ZOOM_RATIO,
        CAPTURE_MIN_ZOOM_RATIO,
        CAPTURE_MIN_ZOOM_RATIO,
      ]);
    },
    FRAMEWORK_TIMEOUT_MS,
  );

  it(
    "passes a framing between the floor and the whole object through untouched",
    () => {
      const zooms = [0.1, 0.2, 0.4, 0.6, 0.8, 0.95, 1];
      expect(frameworkOverviewPull(zooms).pulls).toEqual(zooms);
    },
    FRAMEWORK_TIMEOUT_MS,
  );

  it(
    "reads a detail as the whole object's fit, since above 1 is not a pull-back",
    () => {
      expect(frameworkOverviewPull([1, 1.0001, 2, 40]).pulls).toEqual([1, 1, 1, 1]);
    },
    FRAMEWORK_TIMEOUT_MS,
  );

  // The property an author actually feels: dragging back makes the object
  // smaller at every step, with no flat stretch before the floor and no
  // reversal. The framework asserts it on its own side too.
  it(
    "never grows the object as the authored zoom falls",
    () => {
      const zooms = Array.from({ length: 60 }, (_, i) => 1.2 - i * 0.02);
      const { pulls } = frameworkOverviewPull(zooms);
      let previous = Number.POSITIVE_INFINITY;
      pulls.forEach((pull, i) => {
        expect(pull, `authored ${zooms[i]} after ${previous}`).toBeLessThanOrEqual(previous);
        previous = pull;
      });
      expect(pulls.at(-1)).toBe(CAPTURE_MIN_ZOOM_RATIO);
    },
    FRAMEWORK_TIMEOUT_MS,
  );

  it(
    "returns the whole object's fit for a zoom that is no finite number",
    () => {
      // What the CLAMP does, asked in isolation. It is not what a published
      // story does with such a zoom — see the framing block below, where the
      // clamp is never reached at all.
      expect(frameworkOverviewPull(["NaN", "Infinity", "-Infinity"]).pulls).toEqual([1, 1, 1]);
    },
    FRAMEWORK_TIMEOUT_MS,
  );

  it(
    "receives those as numbers, not as their names",
    () => {
      // Without the decode at the transport boundary the assertion above is
      // empty: `Number.isFinite` rejects every string, so "NaN" would take the
      // non-finite branch for being a string and so would "0.2". A finite name
      // arriving as its value is what tells the two apart.
      expect(frameworkOverviewPull(["0.2" as unknown as ProbeZoom]).pulls).toEqual([0.2]);
    },
    FRAMEWORK_TIMEOUT_MS,
  );
});

describeWithFramework("the capture floor, in the framing the framework applies", () => {
  /** The object filling the frame — the framing an authored zoom of 1 asks for. */
  const WHOLE_OBJECT: AppliedRect = { x: 0, y: 0, width: IMAGE_W, height: IMAGE_H };

  /** The object standing back to `pull` of the frame, centred on its own centre. */
  function pulledBack(pull: number): AppliedRect {
    const width = IMAGE_W / pull;
    const height = IMAGE_H / pull;
    return { x: (IMAGE_W - width) / 2, y: (IMAGE_H - height) / 2, width, height };
  }

  it(
    "frames exactly the object at an authored zoom of 1",
    () => {
      const [applied] = frameworkAppliedFraming([1], TELAR_STORY_DIR);
      expectRect(applied, WHOLE_OBJECT, "zoom 1");
    },
    FRAMEWORK_TIMEOUT_MS,
  );

  it(
    "stands the object back by the authored fraction, down to the floor",
    () => {
      // The relation the editor's stored number means: at the floor the object
      // occupies a tenth of the frame. A constant introduced between the clamp
      // and the applied scale would move every one of these.
      const zooms = [1, 0.8, 0.5, 0.2, CAPTURE_MIN_ZOOM_RATIO];
      const applied = frameworkAppliedFraming(zooms, TELAR_STORY_DIR);
      zooms.forEach((zoom, i) => expectRect(applied[i], pulledBack(zoom), `zoom ${zoom}`));
    },
    FRAMEWORK_TIMEOUT_MS,
  );

  it(
    "applies the floor's own framing to every authored zoom below it",
    () => {
      // The clamp reaching the framing, rather than only the number: the
      // framing stops moving at the floor and nothing under it goes further.
      const zooms = [CAPTURE_MIN_ZOOM_RATIO, 0.05, 0.01, 0.001, 1e-9];
      const applied = frameworkAppliedFraming(zooms, TELAR_STORY_DIR);
      const atFloor = pulledBack(CAPTURE_MIN_ZOOM_RATIO);
      zooms.forEach((zoom, i) => expectRect(applied[i], atFloor, `zoom ${zoom}`));
    },
    FRAMEWORK_TIMEOUT_MS,
  );

  it(
    "performs no framing at all for a zoom the framework calls insane",
    () => {
      // The clamp never sees these. `_applyFocalTarget` calls
      // `computeFocalTarget` first, whose sanity check rejects a non-finite
      // zoom — and one at or below 0 — and returns null, so the apply path
      // returns before the clamp runs. The published behaviour is that the
      // viewer is left exactly where it was, NOT that the whole object is
      // framed, which is what the clamp on its own would suggest.
      expect(
        frameworkAppliedFraming(["NaN", "Infinity", "-Infinity", 0, -1], TELAR_STORY_DIR),
      ).toEqual([
        null,
        null,
        null,
        null,
        null,
      ]);
    },
    FRAMEWORK_TIMEOUT_MS,
  );

  it(
    "performs no framing for a centre off the image either",
    () => {
      // `_isSane` bounds x and y to 0…1 as it bounds the zoom above zero, and
      // the same return carries all three. The editor reaches this case from
      // its own side: a capture taken with the viewer panned clear of the image
      // stores a negative x.
      expect(frameworkAppliedFraming([1], TELAR_STORY_DIR, { x: -0.0833, y: 0.6 })).toEqual([null]);
      expect(frameworkAppliedFraming([1], TELAR_STORY_DIR, { x: 0.4, y: 5 })).toEqual([null]);
      // And an edge is inside the domain, so this one does frame.
      expect(frameworkAppliedFraming([1], TELAR_STORY_DIR, { x: 0, y: 1 })[0]).not.toBeNull();
    },
    FRAMEWORK_TIMEOUT_MS,
  );
});

describeWithFramework("what a stored cell becomes before any of that", () => {
  // The framing probes above enter the framework at `snapIiifToPosition`, which
  // is downstream of `_stepFraming` — the function that decides what a cell the
  // site cannot read as a number becomes. These drive that function instead,
  // through the one path that reaches it without a reader: the first scene's
  // plate, built during `initCardPool`.
  it(
    "is parseFloat's number, taken from a string as readily as from a number",
    () => {
      // The case a `typeof` guard in front of the parse would answer
      // differently: a spreadsheet author's cell arrives as a string, and the
      // published story frames at the number in it. `parseFloat` coerces
      // before it parses, which is why a one-element array parses too.
      expect(
        frameworkStepFraming(
          [
            { x: "0.4", y: "0.6", zoom: "0.2" },
            { x: 0.4, y: 0.6, zoom: 2 },
            { x: 0.4, y: 0.6, zoom: [0.2] },
          ],
          TELAR_STORY_DIR,
        ),
      ).toEqual([
        { x: 0.4, y: 0.6, zoom: 0.2 },
        { x: 0.4, y: 0.6, zoom: 2 },
        { x: 0.4, y: 0.6, zoom: 0.2 },
      ]);
    },
    FRAMEWORK_TIMEOUT_MS,
  );

  it(
    "is the whole-object value per FIELD where the cell reads as no number",
    () => {
      // The substitution the editor's `publishedFraming` mirrors: an unreadable
      // zoom leaves a stored centre standing, and a step with nothing readable
      // frames the whole object at 1.
      expect(
        frameworkStepFraming(
          [
            { x: "garbage", y: 0.6, zoom: 2 },
            { x: 0.4, y: 0.6, zoom: "" },
            { x: 0.4, y: 0.6 },
            {},
          ],
          TELAR_STORY_DIR,
        ),
      ).toEqual([
        { x: 0.5, y: 0.6, zoom: 2 },
        { x: 0.4, y: 0.6, zoom: 1 },
        { x: 0.4, y: 0.6, zoom: 1 },
        { x: 0.5, y: 0.5, zoom: 1 },
      ]);
    },
    FRAMEWORK_TIMEOUT_MS,
  );

  it(
    "declares that whole-object value, and the editor's copy equals it",
    () => {
      // What the drive above cannot see: a rename leaves every number
      // identical. Imported rather than matched out of a file, so a move names
      // the specifier it could not resolve instead of reporting "not found",
      // which is indistinguishable from "renamed" and from "never existed".
      expect(frameworkFullObjectFraming(TELAR_STORY_DIR)).toEqual(FULL_OBJECT_FRAMING);
    },
    FRAMEWORK_TIMEOUT_MS,
  );

  it("takes the same three numbers from the published build, where the JS holds none of them", () => {
    // The assertion above reads the framework being written next door. On the
    // framework users actually publish on there is no JS fallback at all: the
    // constant arrives in 1.8.0, and at PUBLISHED_FRAMEWORK_TAG `stepFraming`'s
    // ancestor is bare `parseFloat`. A blank cell never reaches it, because the
    // BUILD fills one first — `_apply_coordinate_defaults` in
    // processors/stories.py — and those build-time defaults are what the
    // editor's FULL_OBJECT_FRAMING has really been mirroring all along.
    //
    // So the editor's copy has two sources to agree with, in two languages, and
    // this is the one that governs every site published today. Reading only the
    // working tree would have pinned the editor to a constant that does not
    // exist at the tag.
    const source = execFileSync(
      "git",
      ["-C", FRAMEWORK_CHECKOUT_DIR, "show", `${PUBLISHED_FRAMEWORK_TAG}:scripts/telar/processors/stories.py`],
      { encoding: "utf-8", timeout: FRAMEWORK_TIMEOUT_MS },
    );

    const declaration = source.match(/coordinate_defaults\s*=\s*\{([^}]*)\}/);
    expect(
      declaration,
      `no coordinate_defaults mapping in stories.py at ${PUBLISHED_FRAMEWORK_TAG} — the build-time fill has moved or been renamed`,
    ).not.toBeNull();

    const pairs = [...(declaration as RegExpMatchArray)[1].matchAll(/'(\w+)'\s*:\s*'([^']*)'/g)];
    const built = Object.fromEntries(pairs.map(([, key, value]) => [key, parseFloat(value)]));
    expect(built).toEqual(FULL_OBJECT_FRAMING);
  });
});

describeWithFramework("the capture floor against the framework's declaration", () => {
  it("cites the number the framework declares", () => {
    const source = readFileSync(IIIF_CARD_JS, "utf-8");
    const declarations = [
      ...source.matchAll(/^\s*(?:export\s+)?const\s+OVERVIEW_MIN_FRACTION\s*=\s*([0-9.]+)\s*;/gm),
    ];

    // Exactly one declaration, or the read is not measuring what it claims:
    // none means the constant was renamed or removed, and more than one means
    // this cannot say which the code uses.
    expect(
      declarations.length,
      `expected one OVERVIEW_MIN_FRACTION declaration in ${IIIF_CARD_JS}, found ${declarations.length}`,
    ).toBe(1);

    expect(Number(declarations[0][1])).toBe(CAPTURE_MIN_ZOOM_RATIO);
  });

  it("finds that constant still standing between the floor and the framing", () => {
    const source = readFileSync(IIIF_CARD_JS, "utf-8");

    // The floor reaches an authored zoom through this expression. The framing
    // block above measures what the clamp does; this reads that it is still
    // this constant doing it, which is the drift a measurement cannot see —
    // a rename leaves every number identical. Pinned loosely, on the names
    // rather than the spacing.
    expect(
      /Math\.max\(\s*OVERVIEW_MIN_FRACTION\s*,\s*zoom\s*\)/.test(source),
      "the framework no longer clamps an authored zoom up to OVERVIEW_MIN_FRACTION; " +
        "check how the floor now reaches the framing before trusting CAPTURE_MIN_ZOOM_RATIO",
    ).toBe(true);
  });
});

/**
 * The framework's `AUTHORING_ASPECT`, imported from `authoring-frame.js`. The
 * module has no browser dependencies, so no document is set up under it. An
 * import names the specifier it could not resolve, and a missing export
 * throws, so a move or a rename fails rather than reads as a default.
 */
function frameworkAuthoringAspect(): number {
  const script = [
    `const m = await import(${JSON.stringify(`file://${AUTHORING_FRAME_JS}`)});`,
    "if (typeof m.AUTHORING_ASPECT !== 'number') throw new Error('authoring-frame.js exports no AUTHORING_ASPECT');",
    "console.log(JSON.stringify(m.AUTHORING_ASPECT));",
  ].join("\n");
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { encoding: "utf-8", timeout: FRAMEWORK_TIMEOUT_MS },
  );
  return JSON.parse(out.trim().split("\n").at(-1) as string) as number;
}

/**
 * The focal circle's diameter `computeFocalTarget` returns for each case, in
 * image pixels. No card box and the horizontal placement leave the region
 * irrelevant to the diameter, which depends on the image and the zoom alone.
 */
function frameworkFocalDiameters(
  cases: Array<{ W: number; H: number; zoom: number }>,
): number[] {
  const script = [
    ...JSDOM_PRELUDE,
    `const m = await import(${JSON.stringify(`file://${IIIF_CARD_JS}`)});`,
    "if (typeof m.computeFocalTarget !== 'function') throw new Error('iiif-card.js exports no computeFocalTarget');",
    "const cases = JSON.parse(process.argv[1]);",
    "console.log(JSON.stringify(cases.map((c) => m.computeFocalTarget(0.5, 0.5, c.zoom, c.W, c.H, null, 'horizontal').diameterImg)));",
  ].join("\n");
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script, JSON.stringify(cases)],
    { encoding: "utf-8", timeout: FRAMEWORK_TIMEOUT_MS },
  );
  return JSON.parse(out.trim().split("\n").at(-1) as string) as number[];
}

describeWithFramework("the authoring frame's constants against the framework's declarations", () => {
  it(
    "measures in the frame aspect replay divides by",
    () => {
      expect(frameworkAuthoringAspect()).toBe(AUTHORING_ASPECT);
    },
    FRAMEWORK_TIMEOUT_MS,
  );

  it("cites the focal diameter the framework declares", () => {
    // Not exported by the framework, so its declaration is read, and exactly
    // one: none is a rename, more than one cannot say which the code uses.
    const source = readFileSync(IIIF_CARD_JS, "utf-8");
    const declarations = [
      ...source.matchAll(/^\s*(?:export\s+)?const\s+FOCAL_DIAMETER_FRAC\s*=\s*([0-9.]+)\s*;/gm),
    ];
    expect(
      declarations.length,
      `expected one FOCAL_DIAMETER_FRAC declaration in ${IIIF_CARD_JS}, found ${declarations.length}`,
    ).toBe(1);
    expect(Number(declarations[0][1])).toBe(FOCAL_DIAMETER_FRAC);
  });

  it(
    "draws the circle replay frames: FOCAL_DIAMETER_FRAC of the authored frame's width",
    () => {
      // What the declaration read cannot see: that the constant is still what
      // sizes the circle, against the frame width the editor measures.
      const cases = [
        { W: 3000, H: 2000, zoom: 2 },
        { W: 1500, H: 3000, zoom: 4 },
        { W: 3000, H: 3000, zoom: 8 },
      ];
      const diameters = frameworkFocalDiameters(cases);
      cases.forEach(({ W, H, zoom }, i) => {
        const frameWidthImg = W / (authoringHomeZoom(W / H) * zoom);
        expect(diameters[i], `${W}×${H} at ${zoom}`).toBeCloseTo(FOCAL_DIAMETER_FRAC * frameWidthImg, 6);
      });
    },
    FRAMEWORK_TIMEOUT_MS,
  );
});

describeWithFramework("a captured position, replayed by the framework", () => {
  /**
   * The probe's image, as OSD 6 places it: at the origin, one viewport unit
   * wide, so image pixels are viewport units times IMAGE_W on both axes.
   */
  const item = osdImageItem(IMAGE_W, IMAGE_H);

  it(
    "is fitted centred on the image point the author centred, at a detail zoom with no card",
    () => {
      // Points chosen off-centre on both axes and far enough from the edges
      // that the keep-circle clamp leaves the focal where it is. The home
      // bounds handed over are a square pane's, letterbox included — what the
      // old conversion measured on — so a capture that read them would move.
      const homeBounds = { x: 0, y: -0.1875, width: 1, height: 1 };
      for (const point of [{ u: 0.3, v: 0.6 }, { u: 0.7, v: 0.35 }]) {
        const viewportPoint = item.imageToViewportCoordinates(point.u * IMAGE_W, point.v * IMAGE_H);
        const captured = captureViewportState(viewportPoint, 4, 0, homeBounds, 1, item);
        const [applied] = frameworkAppliedFraming([captured.zoom], TELAR_STORY_DIR, captured);
        expect(applied, `no framing at (${point.u}, ${point.v})`).not.toBeNull();
        const rect = applied as AppliedRect;
        expect(rect.x + rect.width / 2, `x at (${point.u}, ${point.v})`).toBeCloseTo(point.u * IMAGE_W, 6);
        expect(rect.y + rect.height / 2, `y at (${point.u}, ${point.v})`).toBeCloseTo(point.v * IMAGE_H, 6);
      }
    },
    FRAMEWORK_TIMEOUT_MS,
  );
});
