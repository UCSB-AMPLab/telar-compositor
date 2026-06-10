/**
 * i18n infrastructure tests.
 *
 * Tests: config values, locale file key parity (ES mirrors EN),
 * locale cookie configuration (sameSite lax, httpOnly false).
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

  it("contains nav section with dashboard, objects, stories keys", () => {
    const nav = (enCommon as unknown as Record<string, Record<string, unknown>>).nav;
    expect(nav).toBeDefined();
    expect(nav.dashboard).toBeTruthy();
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
// Replaces the former explicit per-namespace parity describes (common, auth,
// config, onboarding, popover, editor). Iterates every namespace present in
// the resource bundle and asserts flatKeys(en[ns]) === flatKeys(es[ns]) in
// BOTH directions, so project_switcher and every future namespace is
// auto-covered and no namespace can silently drift again.
// ---------------------------------------------------------------------------

describe("EN/ES key parity (all namespaces, both directions)", () => {
  const enBundle = resources.en as Record<string, Record<string, unknown>>;
  const esBundle = resources.es as Record<string, Record<string, unknown>>;

  for (const ns of Object.keys(enBundle)) {
    it(`"${ns}" has identical key sets in EN and ES`, () => {
      const enKeys = flatKeys(enBundle[ns]);
      const esKeys = flatKeys(esBundle[ns] ?? {});

      for (const key of enKeys) {
        expect(esKeys.has(key), `ES ${ns} missing key: ${key}`).toBe(true);
      }
      for (const key of esKeys) {
        expect(enKeys.has(key), `EN ${ns} missing key: ${key}`).toBe(true);
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
// The story-editor restructure adds breadcrumb.step/layer, the capture_toast
// block, and layer.button_label_strip_label + L1/L2 markers. Key parity must
// hold across locales; the EN/ES marker VALUES intentionally diverge (EN L1/L2
// — locked visual design; ES C1/C2 — native "capa").
// ---------------------------------------------------------------------------

describe("editor.json story-editor keys", () => {
  type Editor = {
    breadcrumb?: Record<string, string>;
    capture_toast?: Record<string, string>;
    layer?: Record<string, string>;
  };
  const en = enEditor as Editor;
  const es = esEditor as Editor;

  it("EN breadcrumb has step + layer interpolation keys", () => {
    expect(en.breadcrumb?.step).toBe("Step {{number}}");
    expect(en.breadcrumb?.layer).toBe("Layer {{number}}");
  });

  it("ES breadcrumb has step + layer with non-empty Spanish values", () => {
    expect(es.breadcrumb?.step).toBe("Paso {{number}}");
    expect(es.breadcrumb?.layer).toBe("Capa {{number}}");
  });

  it("EN capture_toast has captured + undo", () => {
    expect(en.capture_toast?.captured).toBe("Captured position");
    expect(en.capture_toast?.undo).toBe("Undo");
  });

  it("ES capture_toast has captured + undo with non-empty Spanish values", () => {
    expect(es.capture_toast?.captured).toBe("Posición capturada");
    expect(es.capture_toast?.undo).toBe("Deshacer");
  });

  it("EN layer has button_label_strip_label + L1/L2 markers", () => {
    expect(en.layer?.button_label_strip_label).toBe("Button label");
    expect(en.layer?.marker_l1).toBe("L1");
    expect(en.layer?.marker_l2).toBe("L2");
  });

  it("ES layer markers are the native C1/C2 (capa), intentionally diverging from EN L1/L2", () => {
    expect(es.layer?.button_label_strip_label).toBe("Etiqueta del botón");
    expect(es.layer?.marker_l1).toBe("C1");
    expect(es.layer?.marker_l2).toBe("C2");
  });

  it("does not leave any new story-editor value as an empty string in either locale", () => {
    for (const obj of [en, es]) {
      expect(obj.breadcrumb?.step).toBeTruthy();
      expect(obj.breadcrumb?.layer).toBeTruthy();
      expect(obj.capture_toast?.captured).toBeTruthy();
      expect(obj.capture_toast?.undo).toBeTruthy();
      expect(obj.layer?.button_label_strip_label).toBeTruthy();
      expect(obj.layer?.marker_l1).toBeTruthy();
      expect(obj.layer?.marker_l2).toBeTruthy();
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

import enTeamJson from "~/i18n/locales/en/team.json";
import esTeamJson from "~/i18n/locales/es/team.json";
import enCollabJson from "~/i18n/locales/en/collaboration.json";
import esCollabJson from "~/i18n/locales/es/collaboration.json";

type TeamJson = Record<string, string>;
type CollabJson = Record<string, string>;

describe("metric_* plural pairs (EN team.json)", () => {
  it("has metric_stories_one key", () => {
    expect((enTeamJson as TeamJson)["metric_stories_one"]).toBeTruthy();
  });

  it("has metric_stories_other key", () => {
    expect((enTeamJson as TeamJson)["metric_stories_other"]).toBeTruthy();
  });

  it("metric_stories_one contains singular form ('story')", () => {
    expect((enTeamJson as TeamJson)["metric_stories_one"]).toContain("story");
  });

  it("metric_stories_other contains plural form ('stories')", () => {
    expect((enTeamJson as TeamJson)["metric_stories_other"]).toContain("stories");
  });

  it("does NOT have legacy flat metric_stories key", () => {
    expect((enTeamJson as TeamJson)["metric_stories"]).toBeUndefined();
  });

  it("does NOT have legacy _plural suffix keys", () => {
    const keys = Object.keys(enTeamJson as TeamJson);
    const pluralKeys = keys.filter((k) => k.endsWith("_plural"));
    expect(pluralKeys).toHaveLength(0);
  });
});

describe("metric_* plural pairs (ES team.json)", () => {
  it("has metric_stories_one key in ES", () => {
    expect((esTeamJson as TeamJson)["metric_stories_one"]).toBeTruthy();
  });

  it("metric_stories_one ES contains 'historia'", () => {
    expect((esTeamJson as TeamJson)["metric_stories_one"]).toContain("historia");
  });

  it("metric_stories_other ES contains 'historias'", () => {
    expect((esTeamJson as TeamJson)["metric_stories_other"]).toContain("historias");
  });
});

describe("connection pill copy (EN collaboration.json)", () => {
  it("has connection_status_connected key", () => {
    expect((enCollabJson as CollabJson)["connection_status_connected"]).toBe("Connected");
  });

  it("has connection_status_connecting key", () => {
    expect((enCollabJson as CollabJson)["connection_status_connecting"]).toBeTruthy();
  });

  it("has connection_status_offline key", () => {
    expect((enCollabJson as CollabJson)["connection_status_offline"]).toBe("Offline");
  });

  it("has connection_status_tooltip key", () => {
    expect((enCollabJson as CollabJson)["connection_status_tooltip"]).toBeTruthy();
  });
});

describe("connection pill copy (ES collaboration.json)", () => {
  it("connection_status_connected ES is 'Conectado'", () => {
    expect((esCollabJson as CollabJson)["connection_status_connected"]).toBe("Conectado");
  });

  it("connection_status_offline ES is 'Sin conexión'", () => {
    expect((esCollabJson as CollabJson)["connection_status_offline"]).toBe("Sin conexión");
  });
});
