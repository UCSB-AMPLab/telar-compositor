/**
 * Shared, client-safe resolver mapping a settings-change entry to its
 * `auto_commit.*` i18n key (WITHOUT the `auto_commit.` prefix). Used by BOTH
 * the publish route's auto commit-message builder and the unpublished-changes
 * popover so the two surfaces always render an identical, translated label for
 * the same change — never a raw field key.
 *
 * Value-dependent entries pick a variant:
 *  - `lang` → `change_language_to_<en|es>` (target language carried in `label`)
 *  - `collection_mode` → `change_collection_mode_<on|off>` (carried in `label`)
 *  - nested boolean block fields (`story_interface.*`, `collection_interface.*`)
 *    → `change_<slug>_<on|off>`, chosen from the post-change boolean `value`
 *  - nested non-boolean block fields (e.g. `featured_count`) → `change_<slug>`
 *  - everything else (`title`, `url`, `telar_theme`, …) → `change_<key>`
 *
 * Dots are flattened to underscores: i18next treats "." as a key separator, so
 * `change_story_interface.show_on_homepage` would resolve as a nested lookup and
 * miss. Callers should pass the result through `t()` with a `defaultValue` of
 * the `SETTINGS_CHANGE_FALLBACK_KEY` string so an unmapped future field degrades
 * to "update a setting" instead of leaking a raw key into a commit message.
 *
 * @version v1.3.0-beta
 */
export interface SettingsChangeEntry {
  key: string;
  /** Target value for value-keyed entries (lang target, collection_mode on/off). */
  label?: string;
  /** Post-change raw value ("true"/"false"/number string) for nested block fields. */
  value?: string;
}

export function settingsChangeI18nKey(entry: SettingsChangeEntry): string {
  const { key, label, value } = entry;
  if (key === "lang") return `change_language_to_${label ?? ""}`;
  if (key === "collection_mode") return `change_collection_mode_${label ?? ""}`;
  if (key.includes(".")) {
    const slug = key.replace(/\./g, "_");
    if (value === "true" || value === "false") {
      return `change_${slug}_${value === "true" ? "on" : "off"}`;
    }
    return `change_${slug}`;
  }
  return `change_${key}`;
}

export const SETTINGS_CHANGE_FALLBACK_KEY = "change_generic";
