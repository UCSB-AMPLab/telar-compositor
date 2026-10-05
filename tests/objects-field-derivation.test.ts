/**
 * Derives the objects field set from the framework's own, so the two cannot
 * drift apart in silence.
 *
 * The Compositor writes objects.csv for the framework to build. A user-authored
 * objects field the framework knows and the Compositor does not is swept into
 * the `extra_columns` passthrough and republished as a custom column beside
 * whichever first-class column the framework renames it onto — two columns
 * claiming one canonical name, which the framework release this publishes
 * against refuses to build.
 *
 * Bound to the TEST INSTANCE, not to production: that is the release the
 * publish gate forces every site onto, so drift against it is the drift that
 * matters, and `OBJECT_FIELDS` does not exist in the production checkout at
 * all. Following the convention of `splitFrontmatterViaFramework` in
 * tests/publish.server.test.ts, this FAILS LOUDLY rather than skipping when
 * the checkout is absent: a machine without the test instance cannot run this
 * test, and being told so is preferred to a silent pass that would let the
 * drift through unnoticed.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

import { COLUMN_NAME_MAPPING, KNOWN_OBJECT_KEYS } from "~/lib/import.server";
import { MODELLED_OBJECT_EXTRA_ALIASES } from "~/lib/extra-columns.server";

import { FRAMEWORK_DIR_ENV, FRAMEWORK_SCRIPTS_DIR, frameworkCheckoutPresent } from "./helpers/framework-checkout";

/**
 * Parity with the framework is checked on a machine that has a framework
 * checkout named in TELAR_FRAMEWORK_DIR; CI has none, and proves the Compositor alone. Skipped rather than
 * failed there, with the reason in the title so the skip is visible in the
 * run — a local run stays strict, because locally the checkout is present.
 */
const FRAMEWORK_PRESENT = frameworkCheckoutPresent;
const WHEN_PRESENT = FRAMEWORK_PRESENT
  ? ""
  : ` [skipped: no framework checkout (${FRAMEWORK_DIR_ENV} unset or not a checkout)]`;


/**
 * The two names the Compositor spells differently from the framework. Owned by
 * this test, explicitly and in one place, so a third divergence has to be
 * declared here rather than absorbed by a clever rule.
 */
const FRAMEWORK_TO_COMPOSITOR: Record<string, string> = {
  medium: "medium_genre",
  location: "source",
};

const toCompositor = (frameworkName: string): string =>
  FRAMEWORK_TO_COMPOSITOR[frameworkName] ?? frameworkName;

/**
 * Names the framework's build writes into an object itself, which no author
 * supplies in a sheet — so the Compositor neither models nor round-trips them.
 * Each verified at the line that assigns it.
 */
const BUILD_GENERATED: Record<string, string> = {
  object_warning:
    "telar/processors/objects/remote.py:299 — df.at[idx, 'object_warning'] from a validation failure",
  object_warning_short:
    "telar/processors/objects/remote.py:111 — df.at[idx, 'object_warning_short'] = get_lang_string(...)",
  is_featured_sample:
    "telar/processors/objects/featured.py:43 — df['is_featured_sample'] = False, then set by the selector",
  _demo:
    "telar/demo.py:128 — '_demo': True, stamped on objects merged in from a demo bundle",
  media_type:
    "telar/processors/objects/__init__.py:134 — df['media_type'] = [detect_media_type(...)]",
  audio_duration:
    "generate_collections.py:138 — {'audio_duration': duration}, probed from the audio file",
  audio_filesize:
    "generate_collections.py:156 — {'audio_filesize': size_str}, probed from the audio file",
  audio_format:
    "generate_collections.py:157 — {'audio_format': ext...}, derived from the file extension",
};

interface FrameworkObjectsTable {
  objectFields: string[];
  /** Alias header -> framework canonical name, for targets in OBJECT_FIELDS. */
  objectAliases: Record<string, string>;
  /**
   * Each OBJECT_FIELDS name resolved through the framework's own mapping.
   * Some names are both a field and an alias for another (`object_type` is in
   * OBJECT_FIELDS and also renames onto `medium`), so the name a sheet may
   * carry is not always the name the framework settles on.
   */
  resolvedObjectFields: Record<string, string>;
}

/** Reads the framework's own tables out of the running Python. */
function readFrameworkObjectsTable(): FrameworkObjectsTable {
  const script = [
    "import sys, json",
    `sys.path.insert(0, ${JSON.stringify(FRAMEWORK_SCRIPTS_DIR)})`,
    "from telar.csv_utils import OBJECT_FIELDS, COLUMN_NAME_MAPPING",
    "aliases = {k: v for k, v in COLUMN_NAME_MAPPING.items() if v in OBJECT_FIELDS}",
    "resolved = {n: COLUMN_NAME_MAPPING.get(n, n) for n in OBJECT_FIELDS}",
    "print(json.dumps({'objectFields': sorted(OBJECT_FIELDS), 'objectAliases': aliases, "
      + "'resolvedObjectFields': resolved}))",
  ].join("\n");
  const out = execFileSync("python3", ["-c", script], { encoding: "utf-8" });
  return JSON.parse(out) as FrameworkObjectsTable;
}

/**
 * The framework object fields the Compositor neither models nor maps. Pure, so
 * the failure simulations below can drive it with a mutated table instead of
 * editing the framework.
 */
function unmappedObjectFields(
  objectFields: string[],
  mapping: Record<string, string>,
  excluded: Record<string, string>,
  resolved: Record<string, string> = {},
): string[] {
  return objectFields.filter((name) => {
    if (name in excluded) return false;
    return mapping[name.toLowerCase()] !== toCompositor(resolved[name] ?? name);
  });
}

/** Framework aliases the Compositor does not fold the same way. */
function divergentAliases(
  objectAliases: Record<string, string>,
  mapping: Record<string, string>,
): string[] {
  return Object.entries(objectAliases)
    .filter(([alias, target]) => mapping[alias.toLowerCase()] !== toCompositor(target))
    .map(([alias, target]) => `${alias} -> ${target}`);
}

// Read only where the checkout exists: this runs at import, so calling it
// unconditionally would throw on CI before any skip could take effect.
const framework: FrameworkObjectsTable = FRAMEWORK_PRESENT
  ? readFrameworkObjectsTable()
  : { objectFields: [], objectAliases: {}, resolvedObjectFields: {} };

describe.skipIf(!FRAMEWORK_PRESENT)(`objects field set derived from the framework${WHEN_PRESENT}`, () => {
  it("reads a non-trivial table out of the framework", () => {
    // Guards the whole file: an empty read would make every assertion below
    // pass vacuously.
    expect(framework.objectFields.length).toBeGreaterThan(20);
    expect(Object.keys(framework.objectAliases).length).toBeGreaterThan(20);
  });

  it("folds every framework alias for a user-authored objects field the same way", () => {
    expect(divergentAliases(framework.objectAliases, COLUMN_NAME_MAPPING)).toEqual([]);
  });

  it("models, maps or explicitly excludes every name in OBJECT_FIELDS", () => {
    expect(
      unmappedObjectFields(
        framework.objectFields,
        COLUMN_NAME_MAPPING,
        BUILD_GENERATED,
        framework.resolvedObjectFields,
      ),
    ).toEqual([]);
  });

  it("excludes only names the framework actually has", () => {
    // An exclusion for a name that has gone away is a stale licence to ignore
    // whatever takes its place.
    for (const name of Object.keys(BUILD_GENERATED)) {
      expect(framework.objectFields, `excluded "${name}" is not in OBJECT_FIELDS`).toContain(name);
    }
  });

  it("consumes every mapped objects name, so none reaches the passthrough", () => {
    for (const name of framework.objectFields) {
      if (name in BUILD_GENERATED) continue;
      const compositorKey = COLUMN_NAME_MAPPING[name.toLowerCase()];
      expect(
        KNOWN_OBJECT_KEYS.has(compositorKey),
        `"${name}" maps to "${compositorKey}", which the objects mapper does not consume — ` +
          `its cell would be captured into extra_columns as well as its field`,
      ).toBe(true);
    }
  });

  // MODELLED_OBJECT_EXTRA_ALIASES is what lifts a modelled column back out of
  // a stored blob, so a header the mapping folds but this table misses is a
  // column that stays in the passthrough and republishes beside its own field.
  // Checked against the FRAMEWORK's alias list, not against a restatement of
  // the Compositor's own derivation — a test that rebuilds the table the same
  // way the code does cannot fail when both are wrong together.
  it("lifts every framework objects alias out of a stored blob", () => {
    const missing: string[] = [];
    for (const [alias, target] of Object.entries(framework.objectAliases)) {
      if (MODELLED_OBJECT_EXTRA_ALIASES[alias.toLowerCase()] === undefined) {
        missing.push(`${alias} -> ${target}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("maps each alias to the D1 column that field actually uses", () => {
    expect(MODELLED_OBJECT_EXTRA_ALIASES["medium"]).toBe("object_type");
    expect(MODELLED_OBJECT_EXTRA_ALIASES["medio_genero"]).toBe("object_type");
    expect(MODELLED_OBJECT_EXTRA_ALIASES["iiif_manifest"]).toBe("source_url");
    expect(MODELLED_OBJECT_EXTRA_ALIASES["crédito"]).toBe("credit");
    expect(MODELLED_OBJECT_EXTRA_ALIASES["ubicación"]).toBe("source");
  });

  it("claims no header the mapping does not fold onto an objects field", () => {
    for (const alias of Object.keys(MODELLED_OBJECT_EXTRA_ALIASES)) {
      const target = COLUMN_NAME_MAPPING[alias];
      expect(target, `"${alias}" is in the alias table but not in the mapping`).toBeDefined();
      expect(
        KNOWN_OBJECT_KEYS.has(target!),
        `"${alias}" folds onto "${target}", which the objects mapper does not consume`,
      ).toBe(true);
    }
  });
});

describe.skipIf(!FRAMEWORK_PRESENT)(`the derivation test's own failure modes${WHEN_PRESENT}`, () => {
  it("fails when `medium` is dropped from the mapping again", () => {
    const without = { ...COLUMN_NAME_MAPPING };
    delete without.medium;
    expect(
      unmappedObjectFields(
        framework.objectFields,
        without,
        BUILD_GENERATED,
        framework.resolvedObjectFields,
      ),
    ).toEqual(["medium"]);
  });

  it("fails when the framework gains an objects field the Compositor has not met", () => {
    // Simulated in the fixture, never by editing the framework.
    const grown = [...framework.objectFields, "provenance_note"];
    expect(
      unmappedObjectFields(
        grown,
        COLUMN_NAME_MAPPING,
        BUILD_GENERATED,
        framework.resolvedObjectFields,
      ),
    ).toEqual(["provenance_note"]);
  });

  it("fails when the framework folds an alias the Compositor folds elsewhere", () => {
    const grown = { ...framework.objectAliases, procedencia: "source" };
    expect(divergentAliases(grown, COLUMN_NAME_MAPPING)).toEqual(["procedencia -> source"]);
  });
});
