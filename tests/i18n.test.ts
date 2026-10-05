/**
 * i18n infrastructure tests.
 *
 * Tests: config values, locale file key parity (ES mirrors EN),
 * locale cookie configuration (sameSite lax, httpOnly false).
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { supportedLanguages, fallbackLanguage, defaultNS, namespaces } from "~/i18n/config";
import enCommon from "~/i18n/locales/en/common.json";
import enAuth from "~/i18n/locales/en/auth.json";
import esCommon from "~/i18n/locales/es/common.json";
import enEditor from "~/i18n/locales/en/editor.json";
import esEditor from "~/i18n/locales/es/editor.json";
import resources from "~/i18n/locales";
import { localeCookieConfig } from "~/i18n/i18next.server";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { awaitingSpanish } from "./helpers/awaiting-spanish";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a flat dot-notation key set for any nested JSON object */
function flatKeys(obj: Record<string, unknown>, prefix = ""): Set<string> {
  const keys = new Set<string>();
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      for (const nested of flatKeys(v as Record<string, unknown>, path)) {
        keys.add(nested);
      }
    } else {
      keys.add(path);
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe("i18n config", () => {
  it("exports supportedLanguages containing en and es", () => {
    expect(supportedLanguages).toContain("en");
    expect(supportedLanguages).toContain("es");
    expect(supportedLanguages).toEqual(["en", "es"]);
  });

  it("exports fallbackLanguage as en", () => {
    expect(fallbackLanguage).toBe("en");
  });

  it("exports defaultNS as common", () => {
    expect(defaultNS).toBe("common");
  });

  it("exports namespaces array including common and auth", () => {
    expect(namespaces).toContain("common");
    expect(namespaces).toContain("auth");
  });

  it("registers the popover namespace", () => {
    expect(namespaces).toContain("popover");
  });
});

// ---------------------------------------------------------------------------
// Namespace registration completeness
//
// Regression guard: the `start` namespace JSON files existed but were never
// wired into config.ts `namespaces` NOR locales/index.ts resources, so every
// Start-tab string rendered its raw i18n key on the deployed app. The
// component-level tests passed because they load i18n differently than
// runtime. These tests assert the two registration points stay in sync with
// the locale files on disk.
// ---------------------------------------------------------------------------

describe("i18n namespace registration", () => {
  const localesDir = join(dirname(fileURLToPath(import.meta.url)), "../app/i18n/locales");
  const enFiles = readdirSync(join(localesDir, "en"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
  const enBundle = resources.en as Record<string, Record<string, unknown>>;
  const esBundle = resources.es as Record<string, Record<string, unknown>>;

  it("lists every en/*.json file in the namespaces array", () => {
    for (const ns of enFiles) {
      expect(namespaces, `"${ns}" (en/${ns}.json) is missing from config.ts namespaces`).toContain(ns);
    }
  });

  it("registers every declared namespace in the resource bundle (en + es), non-empty", () => {
    for (const ns of namespaces) {
      expect(enBundle, `resources.en is missing "${ns}"`).toHaveProperty(ns);
      expect(esBundle, `resources.es is missing "${ns}"`).toHaveProperty(ns);
      expect(Object.keys(enBundle[ns] ?? {}).length, `resources.en.${ns} is empty`).toBeGreaterThan(0);
      expect(Object.keys(esBundle[ns] ?? {}).length, `resources.es.${ns} is empty`).toBeGreaterThan(0);
    }
  });

  it("wires up the start namespace specifically", () => {
    expect(namespaces).toContain("start");
    expect(enBundle).toHaveProperty("start");
    expect(esBundle).toHaveProperty("start");
  });
});

// ---------------------------------------------------------------------------
// EN locale files
// ---------------------------------------------------------------------------

describe("en/common.json", () => {
  it("contains app_name key with non-empty value", () => {
    expect((enCommon as Record<string, unknown>).app_name).toBeTruthy();
    expect(typeof (enCommon as Record<string, unknown>).app_name).toBe("string");
  });

  it("contains nav section with start, objects, stories keys", () => {
    const nav = (enCommon as unknown as Record<string, Record<string, unknown>>).nav;
    expect(nav).toBeDefined();
    expect(nav.start).toBeTruthy();
    expect(nav.objects).toBeTruthy();
    expect(nav.stories).toBeTruthy();
  });
});

describe("en/auth.json", () => {
  it("contains signin.title key", () => {
    const signin = (enAuth as Record<string, Record<string, unknown>>).signin;
    expect(signin).toBeDefined();
    expect(signin.title).toBeTruthy();
  });

  it("contains signin.intro key", () => {
    const signin = (enAuth as Record<string, Record<string, unknown>>).signin;
    expect(signin.intro).toBeTruthy();
  });

  it("contains signin.button key", () => {
    const signin = (enAuth as Record<string, Record<string, unknown>>).signin;
    expect(signin.button).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// EN/ES key parity — single dynamic both-directions loop over ALL namespaces
//
// Iterates every namespace present in the resource bundle and asserts
// flatKeys(en[ns]) === flatKeys(es[ns]) in BOTH directions, so every namespace
// is auto-covered and none can silently drift. The one exception is the keys
// listed in tests/helpers/awaiting-spanish.ts, whose Colombian Spanish is
// drafted and reviewed separately; each of those has to be missing from ES, so
// the exception cannot outlive the review it stands in for.
// ---------------------------------------------------------------------------

describe("EN/ES key parity (all namespaces, both directions)", () => {
  const enBundle = resources.en as Record<string, Record<string, unknown>>;
  const esBundle = resources.es as Record<string, Record<string, unknown>>;

  for (const ns of Object.keys(enBundle)) {
    it(`"${ns}" has identical key sets in EN and ES`, () => {
      const enKeys = flatKeys(enBundle[ns]);
      const esKeys = flatKeys(esBundle[ns] ?? {});

      const pending = awaitingSpanish(ns);

      for (const key of enKeys) {
        if (pending.includes(key)) continue;
        expect(esKeys.has(key), `ES ${ns} missing key: ${key}`).toBe(true);
      }
      for (const key of esKeys) {
        expect(enKeys.has(key), `EN ${ns} missing key: ${key}`).toBe(true);
      }
      for (const key of pending) {
        expect(enKeys.has(key), `EN ${ns} missing pending key: ${key}`).toBe(true);
        expect(esKeys.has(key), `ES ${ns} already carries a pending key: ${key}`).toBe(false);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Site Status pill — status.* caption content (value-specific, retained)
// ---------------------------------------------------------------------------

describe("status.* captions (common.json)", () => {
  type CommonStatus = { status?: Record<string, string> };

  it("EN out_of_sync caption uses the wording 'GitHub has changed'", () => {
    expect((enCommon as CommonStatus).status?.out_of_sync).toBe("GitHub has changed");
  });

  it("EN upgrade caption uses the wording 'Telar {version} available'", () => {
    expect((enCommon as CommonStatus).status?.upgrade).toContain("Telar");
    expect((enCommon as CommonStatus).status?.upgrade).toContain("available");
  });

  it("ES out_of_sync caption is 'GitHub ha cambiado'", () => {
    expect((esCommon as CommonStatus).status?.out_of_sync).toBe("GitHub ha cambiado");
  });

  it("ES status values are not left equal to their EN counterparts where Spanish differs", () => {
    const en = (enCommon as CommonStatus).status ?? {};
    const es = (esCommon as CommonStatus).status ?? {};
    // in_sync, publishing and the upgrade title differ between languages
    expect(es.in_sync).not.toBe(en.in_sync);
    expect(es.publishing).not.toBe(en.publishing);
    expect(es.upgrade).not.toBe(en.upgrade);
  });
});

// ---------------------------------------------------------------------------
// Story editor — editor.json EN/ES parity + story-editor keys
//
// The capture_toast block, the L1/L2 markers, and the layer panels' title
// pencil. Key parity must hold across locales; the EN/ES marker VALUES
// intentionally diverge (EN L1/L2 — locked visual design; ES C1/C2 — native
// "capa"). The breadcrumb's step and layer keys and the button-label strip's
// label went with the panels' breadcrumb and strip.
// ---------------------------------------------------------------------------

describe("editor.json story-editor keys", () => {
  type Editor = {
    capture_toast?: Record<string, string>;
    layer?: Record<string, string>;
    stage?: Record<string, string>;
  };
  const en = enEditor as Editor;
  const es = esEditor as Editor;

  it("EN capture_toast has captured + undo", () => {
    expect(en.capture_toast?.captured).toBe("Captured position");
    expect(en.capture_toast?.undo).toBe("Undo");
  });

  it("ES capture_toast has captured + undo with non-empty Spanish values", () => {
    expect(es.capture_toast?.captured).toBe("Posición capturada");
    expect(es.capture_toast?.undo).toBe("Deshacer");
  });

  it("does not leave any new story-editor value as an empty string in either locale", () => {
    for (const obj of [en, es]) {
      expect(obj.capture_toast?.captured).toBeTruthy();
      expect(obj.capture_toast?.undo).toBeTruthy();
      expect(obj.stage?.edit_panel_title).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// Locale cookie configuration
// ---------------------------------------------------------------------------

describe("locale cookie config", () => {
  it("uses sameSite lax", () => {
    expect(localeCookieConfig.sameSite).toBe("lax");
  });

  it("httpOnly is false (client JS must read locale)", () => {
    expect(localeCookieConfig.httpOnly).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pluralisation pairs + connection pill copy
// ---------------------------------------------------------------------------

import enContributionsJson from "~/i18n/locales/en/contributions.json";
import esContributionsJson from "~/i18n/locales/es/contributions.json";
import enCollabJson from "~/i18n/locales/en/collaboration.json";
import esCollabJson from "~/i18n/locales/es/collaboration.json";

/** A catalogue read for one key at a time. Nested sections are not read here. */
type FlatJson = Record<string, unknown>;

/**
 * The plural pair is asserted on the namespace that OWNS the count, which is
 * `contributions`. The block that stood here read `team:metric_*`, a family
 * whose screen was rebuilt as the `/contributions` route with a richer model —
 * per kind, added and edited, words and time — in a namespace of its own. Every
 * `metric_*` key it asserted had been unreferenced since that rebuild, so the
 * pair discipline was being enforced on strings nothing rendered while the
 * strings that are rendered went unchecked.
 */
describe("plural pairs (contributions)", () => {
  it("states both forms in EN", () => {
    expect((enContributionsJson as unknown as FlatJson)["meta_one"]).toBeTruthy();
    expect((enContributionsJson as unknown as FlatJson)["meta_other"]).toBeTruthy();
  });

  it("states both forms in ES", () => {
    expect((esContributionsJson as unknown as FlatJson)["meta_one"]).toBeTruthy();
    expect((esContributionsJson as unknown as FlatJson)["meta_other"]).toBeTruthy();
  });

  it("carries no legacy _plural suffix, in either language", () => {
    for (const json of [enContributionsJson, esContributionsJson]) {
      const legacy = Object.keys(json as unknown as FlatJson).filter((k) => k.endsWith("_plural"));
      expect(legacy).toHaveLength(0);
    }
  });
});

/**
 * The pill's three states, on the keys it actually renders. The block that
 * stood here asserted `connection_status_connected` / `_connecting` /
 * `_offline` word for word — copy `ConnectionPill` replaced deliberately,
 * because "Offline" misrepresents an editor that still works locally. Pinning
 * the old wording kept three dead strings looking alive and said nothing about
 * the calm copy that took their place.
 */
describe("connection pill copy", () => {
  it("states the three live pill labels in both languages", () => {
    for (const json of [enCollabJson, esCollabJson]) {
      expect((json as unknown as FlatJson)["presence_live"]).toBeTruthy();
      expect((json as unknown as FlatJson)["presence_reconnecting"]).toBeTruthy();
      expect((json as unknown as FlatJson)["presence_working_solo"]).toBeTruthy();
      expect((json as unknown as FlatJson)["connection_status_tooltip"]).toBeTruthy();
    }
  });

  it("does not name a state the pill stopped claiming", () => {
    // The point of the rewrite: none of the three may come back by the front
    // door, in either language.
    for (const json of [enCollabJson, esCollabJson]) {
      for (const dead of ["connection_status_connected", "connection_status_connecting", "connection_status_offline"]) {
        expect((json as unknown as FlatJson)[dead]).toBeUndefined();
      }
    }
  });
});
