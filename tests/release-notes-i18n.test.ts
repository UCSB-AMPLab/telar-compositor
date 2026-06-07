import { describe, it, expect } from "vitest";
import en from "../app/i18n/locales/en/release-notes.json";
import es from "../app/i18n/locales/es/release-notes.json";
import { CURRENT_RELEASE } from "~/lib/release-notes";

function keys(o: object): string[] {
  return Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.keys(v).map((c) => `${k}.${c}`)
      : [k],
  );
}

describe("release-notes i18n", () => {
  it("EN and ES have identical key structure", () => {
    expect(keys(es)).toEqual(keys(en));
  });

  it("has a content block for the current release id", () => {
    expect(en).toHaveProperty(CURRENT_RELEASE.i18nKey);
    expect(es).toHaveProperty(CURRENT_RELEASE.i18nKey);
  });

  it("features and fixes are non-empty arrays in both languages", () => {
    for (const loc of [en, es]) {
      const block = (loc as Record<string, { features: string[]; fixes: string[] }>)[
        CURRENT_RELEASE.i18nKey
      ];
      expect(Array.isArray(block.features) && block.features.length > 0).toBe(true);
      expect(Array.isArray(block.fixes) && block.fixes.length > 0).toBe(true);
    }
  });
});
