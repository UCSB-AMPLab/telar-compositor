/**
 * Client-safe display helpers for the Start-tab activity feed. The feed stores
 * stable machine values (a verb enum, an entity-type enum, and an `entity_id`
 * that is either a slug or — for config edits — the changed field key) and a
 * denormalised `entity_label`. This module turns those into the human label the
 * row shows, with one hard rule: a raw machine key or id must NEVER reach the
 * user.
 *
 * Two cases need care:
 *   - config rows: `entity_id` is the changed field key (`featured_count`,
 *     `collection_mode`, …) and `entity_label` is the site title (the wrong
 *     thing to show for a per-field change). We resolve the field key to the
 *     SAME label the Config tab renders — reusing those translations rather than
 *     duplicating them — and fall back to the generic "settings" noun for any
 *     field we don't have a mapping for.
 *   - story/object/term/page rows with no title yet: `entity_label` is null and
 *     `entity_id` is a bare slug or numeric id. We show a translated "untitled"
 *     placeholder instead of leaking that id.
 *
 * @version v1.3.6-beta
 */

import type { RecentActivityRow } from "~/lib/activity.server";

/** Minimal translator shape (react-i18next's `t`), kept narrow so this stays pure/testable. */
type TFunc = (key: string, opts?: { defaultValue?: string }) => string;

/**
 * Config field key → the existing `config` namespace i18n path for its label.
 * Single source of truth: these point at the very strings the Config tab shows,
 * so the feed and the editor never disagree. Any key absent here degrades to the
 * generic "settings" noun (see below) — it is never shown raw.
 */
export const CONFIG_FIELD_I18N_PATH: Record<string, string> = {
  title: "config:sections.site_settings.field_title",
  description: "config:sections.site_settings.field_description",
  author: "config:sections.site_settings.field_author",
  email: "config:sections.site_settings.field_email",
  demo_content: "config:sections.site_settings.field_demo_content",
  // The sync diff names this field by its D1 column; the Config tab's
  // activity feed historically used the short key above. Same label.
  include_demo_content: "config:sections.site_settings.field_demo_content",
  theme: "config:sections.site_settings.field_theme",
  logo: "config:sections.site_settings.field_logo",
  language: "config:sections.site_settings.field_language",
  url: "config:sections.hosting.field_url",
  baseurl: "config:sections.hosting.field_baseurl",
  show_on_homepage: "config:sections.story_interface.field_show_on_homepage",
  show_story_steps: "config:sections.story_interface.field_show_story_steps",
  show_object_credits: "config:sections.story_interface.field_show_object_credits",
  browse_and_search: "config:sections.collection_interface.field_browse_and_search",
  show_link_on_homepage: "config:sections.collection_interface.field_show_link_on_homepage",
  show_sample_on_homepage: "config:sections.collection_interface.field_show_sample_on_homepage",
  collection_mode: "config:sections.collection_interface.field_collection_mode",
  featured_count: "config:sections.collection_interface.field_featured_count",
  story_key: "config:sections.story_protection.field_story_key",
};

/**
 * Resolve a config field key to its friendly Config-tab label. Returns "" when
 * the key has no mapping, so callers can choose their own generic fallback.
 * Shared by the activity feed and the sync-confirm diff so the two surfaces
 * always name a config field identically.
 */
export function configFieldLabel(key: string | null | undefined, t: TFunc): string {
  const path = key ? CONFIG_FIELD_I18N_PATH[key] : undefined;
  if (!path) return "";
  return t(path, { defaultValue: "" });
}

/**
 * Resolve the user-facing label for one activity row. Never returns a raw key
 * or id: config keys map to friendly field names (or the generic settings
 * noun), and a missing title becomes the translated "untitled" placeholder.
 */
export function activityEntityLabel(row: RecentActivityRow, t: TFunc): string {
  if (row.entity_type === "config") {
    const label = configFieldLabel(row.entity_id, t);
    if (label) return label;
    // Unknown/unmapped field — show the generic "settings" noun, not the key.
    return t("start:activity.entity.config", { defaultValue: "settings" });
  }
  // story / object / term / page / site: prefer the denormalised title; never
  // fall through to the raw slug/id.
  return row.entity_label || t("start:activity.untitled", { defaultValue: "untitled" });
}
