import { describe, it, expect } from "vitest";
import {
  settingsChangeI18nKey,
  SETTINGS_CHANGE_FALLBACK_KEY,
} from "~/lib/settings-change-i18n";

describe("settingsChangeI18nKey", () => {
  it("maps flat managed fields to change_<key>", () => {
    expect(settingsChangeI18nKey({ key: "title" })).toBe("change_title");
    expect(settingsChangeI18nKey({ key: "url" })).toBe("change_url");
    expect(settingsChangeI18nKey({ key: "telar_theme" })).toBe("change_telar_theme");
  });

  it("maps language via the target-language label", () => {
    expect(settingsChangeI18nKey({ key: "lang", label: "es" })).toBe(
      "change_language_to_es",
    );
    expect(settingsChangeI18nKey({ key: "lang", label: "en" })).toBe(
      "change_language_to_en",
    );
  });

  it("maps collection_mode via its on/off label", () => {
    expect(settingsChangeI18nKey({ key: "collection_mode", label: "on" })).toBe(
      "change_collection_mode_on",
    );
    expect(settingsChangeI18nKey({ key: "collection_mode", label: "off" })).toBe(
      "change_collection_mode_off",
    );
  });

  it("maps nested boolean blocks to on/off by value, flattening dots", () => {
    expect(
      settingsChangeI18nKey({
        key: "story_interface.include_demo_content",
        value: "false",
      }),
    ).toBe("change_story_interface_include_demo_content_off");
    expect(
      settingsChangeI18nKey({
        key: "story_interface.show_on_homepage",
        value: "true",
      }),
    ).toBe("change_story_interface_show_on_homepage_on");
    expect(
      settingsChangeI18nKey({
        key: "collection_interface.browse_and_search",
        value: "true",
      }),
    ).toBe("change_collection_interface_browse_and_search_on");
  });

  it("maps nested non-boolean blocks (featured_count) to change_<slug> without on/off", () => {
    expect(
      settingsChangeI18nKey({
        key: "collection_interface.featured_count",
        value: "4",
      }),
    ).toBe("change_collection_interface_featured_count");
  });

  it("exposes a generic fallback key", () => {
    expect(SETTINGS_CHANGE_FALLBACK_KEY).toBe("change_generic");
  });
});
