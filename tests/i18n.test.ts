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
  it("has same keys as en/auth.json", () => {
    const enKeys = flatKeys(enAuth as Record<string, unknown>);
    const esKeys = flatKeys(esAuth as Record<string, unknown>);

    for (const key of enKeys) {
      expect(esKeys.has(key), `ES auth missing key: ${key}`).toBe(true);
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
