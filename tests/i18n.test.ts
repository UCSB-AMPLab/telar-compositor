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
import esAuth from "~/i18n/locales/es/auth.json";
import { localeCookieConfig } from "~/i18n/i18next.server";

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
    const nav = (enCommon as Record<string, Record<string, unknown>>).nav;
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

  it("contains signin.tagline key", () => {
    const signin = (enAuth as Record<string, Record<string, unknown>>).signin;
    expect(signin.tagline).toBeTruthy();
  });

  it("contains signin.button key", () => {
    const signin = (enAuth as Record<string, Record<string, unknown>>).signin;
    expect(signin.button).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// ES locale key parity
// ---------------------------------------------------------------------------

describe("es/common.json", () => {
  it("has same keys as en/common.json (values can be empty strings)", () => {
    const enKeys = flatKeys(enCommon as Record<string, unknown>);
    const esKeys = flatKeys(esCommon as Record<string, unknown>);

    for (const key of enKeys) {
      expect(esKeys.has(key), `ES common missing key: ${key}`).toBe(true);
    }
  });
});

describe("es/auth.json", () => {
  it("has same keys as en/auth.json (values are empty strings)", () => {
    const enKeys = flatKeys(enAuth as Record<string, unknown>);
    const esKeys = flatKeys(esAuth as Record<string, unknown>);

    for (const key of enKeys) {
      expect(esKeys.has(key), `ES auth missing key: ${key}`).toBe(true);
    }
  });

  it("all es/auth.json values are empty strings", () => {
    function allEmpty(obj: Record<string, unknown>): boolean {
      for (const v of Object.values(obj)) {
        if (v !== null && typeof v === "object" && !Array.isArray(v)) {
          if (!allEmpty(v as Record<string, unknown>)) return false;
        } else if (v !== "") {
          return false;
        }
      }
      return true;
    }
    expect(allEmpty(esAuth as Record<string, unknown>)).toBe(true);
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
