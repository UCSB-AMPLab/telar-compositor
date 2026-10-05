/**
 * `mapObjectsCsv` reads the `featured` cell the way the framework's own
 * homepage-sampling step does: `scripts/telar/processors/objects/featured.py`
 * treats yes/true/sí/si/1 (case-insensitive, trimmed) as an explicit feature
 * request, and a Compositor that read a narrower set would import a Spanish
 * `destacado: sí` sheet as not featured, publish an empty cell, and lose a
 * flag its author set.
 *
 * The plain block below needs no framework checkout — it is a contract
 * `FEATURED_TRUTHY` has to keep regardless of what is on disk. The two
 * `describeWithFramework*` blocks drive the framework's own
 * `_select_featured_objects` — not a constant read off its compiled bytecode,
 * which proves nothing about what the function actually accepts, only about
 * what CPython happened to fold last time this was written — over the same
 * corpus `mapObjectsCsv` is fed, at the test instance's HEAD and at the tag
 * the published sites are on, and assert the two sides agree cell by cell.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";

import { mapObjectsCsv } from "~/lib/import.server";
import {
  describeWithFramework,
  describeWithFrameworkTag,
  driveFrameworkSelector,
  frameworkScriptsAtTag,
  FRAMEWORK_TIMEOUT_MS,
  PUBLISHED_FRAMEWORK_TAG,
} from "./helpers/framework-checkout";

// ---------------------------------------------------------------------------
// mapObjectsCsv itself — no checkout needed
// ---------------------------------------------------------------------------

/** One row through `mapObjectsCsv`, reporting only the `featured` verdict. */
function featuredFor(raw: string | undefined): boolean {
  const row: Record<string, string> = { object_id: "o1" };
  if (raw !== undefined) row.featured = raw;
  return Boolean(mapObjectsCsv([row], 1)[0].featured);
}

const TRUTHY_SPELLINGS = ["yes", "true", "si", "sí", "1"];

describe("mapObjectsCsv reads the featured cell the way the framework does", () => {
  it.each(TRUTHY_SPELLINGS)("marks %j featured", (value) => {
    expect(featuredFor(value)).toBe(true);
  });

  it.each(TRUTHY_SPELLINGS)("marks %j featured upper-cased", (value) => {
    expect(featuredFor(value.toUpperCase())).toBe(true);
  });

  // U+00A0 is in PYTHON_WHITESPACE (python-whitespace.ts) — pythonStrip
  // removes it exactly as it removes an ordinary space.
  it.each(TRUTHY_SPELLINGS)("marks %j featured under leading/trailing U+00A0", (value) => {
    expect(featuredFor(` ${value} `)).toBe(true);
  });

  // U+FEFF is NOT in PYTHON_WHITESPACE, so pythonStrip leaves it in place —
  // the same thing CPython's own str.strip() does (see python-whitespace.ts's
  // docstring, and the object_id note a few lines above mapObjectsCsv's own
  // featured read). A BOM wrapped around an otherwise-truthy spelling does
  // not strip down to it, on either side, and reads as false here too.
  it.each(TRUTHY_SPELLINGS)("does not mark %j featured under leading/trailing U+FEFF", (value) => {
    expect(featuredFor(`﻿${value}﻿`)).toBe(false);
  });

  it.each([
    "no", "false", "0", "2", "s", "si.", "yes yes",
    // "sí" spelled s + i + U+0301 (combining acute) — a different string
    // from the precomposed "sí" this file uses everywhere else, and not
    // truthy in the framework either: see FEATURED_TRUTHY's own docstring.
    "sí",
  ])("does not mark %j featured", (value) => {
    expect(featuredFor(value)).toBe(false);
  });

  it("does not mark an empty cell featured", () => {
    expect(featuredFor("")).toBe(false);
  });

  it("does not mark an absent column featured", () => {
    expect(featuredFor(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mapObjectsCsv vs the framework's own selector, over one corpus
// ---------------------------------------------------------------------------

/**
 * Every spelling `mapObjectsCsv`'s plain block above checks, fed to the
 * framework's own selector instead of asserted against by hand. Cells travel
 * to Python as a list of strings (see `driveFrameworkSelector`), not through
 * `pd.read_csv` — this corpus measures the whitelist alone, not the reader
 * pandas would apply on top of it (the numeric-spelling divergence that
 * reader produces is measured separately, in
 * `objects-featured-numeric-divergence.test.ts`).
 */
const FEATURED_CORPUS = [
  ...TRUTHY_SPELLINGS,
  ...TRUTHY_SPELLINGS.map((value) => value.toUpperCase()),
  ...TRUTHY_SPELLINGS.map((value) => ` ${value} `),
  ...TRUTHY_SPELLINGS.map((value) => `﻿${value}﻿`),
  "sí", // "sí" as s + i + U+0301 (combining acute), not the precomposed "sí"
  "no",
  "false",
  "0",
  "2",
  "s",
  "si.",
  "yes yes",
  "",
];

/**
 * Drives `featuredCells` through the framework's selector alongside a
 * known-truthy control row ("yes"), and returns only the verdicts for
 * `featuredCells`, in order.
 *
 * Without a control row, a frame where nothing matches falls through to the
 * function's random homepage-sample fallback and marks rows anyway —
 * acceptance and fallback would be indistinguishable from outside. The
 * control row's own verdict is asserted here, loudly, rather than folded
 * into the corpus comparison: a probe that stopped proving what it claims to
 * prove must fail the run, not quietly report an empty disagreement.
 */
function driveFrameworkSelectorWithControl(featuredCells: string[], scriptsDir?: string): boolean[] {
  const driven = driveFrameworkSelector([...featuredCells, "yes"], scriptsDir);
  expect(
    driven.at(-1),
    "the known-truthy control row ('yes') was not marked featured — the probe is broken, not the corpus",
  ).toBe(true);
  return driven.slice(0, featuredCells.length);
}

describeWithFramework(
  "mapObjectsCsv vs the framework's own selector, over the featured corpus (test instance)",
  () => {
    it(
      "agrees with the framework's verdict on every cell",
      () => {
        const framework = driveFrameworkSelectorWithControl(FEATURED_CORPUS);
        const compositor = FEATURED_CORPUS.map((cell) => featuredFor(cell));
        expect(compositor).toEqual(framework);
      },
      FRAMEWORK_TIMEOUT_MS,
    );
  },
);

describeWithFrameworkTag(
  PUBLISHED_FRAMEWORK_TAG,
  `mapObjectsCsv vs the framework's own selector, over the featured corpus (${PUBLISHED_FRAMEWORK_TAG})`,
  () => {
    it(
      "agrees with the framework's verdict on every cell",
      () => {
        const scriptsDir = frameworkScriptsAtTag(PUBLISHED_FRAMEWORK_TAG);
        const framework = driveFrameworkSelectorWithControl(FEATURED_CORPUS, scriptsDir);
        const compositor = FEATURED_CORPUS.map((cell) => featuredFor(cell));
        expect(compositor).toEqual(framework);
      },
      FRAMEWORK_TIMEOUT_MS,
    );
  },
);
