/**
 * Pins the activity-feed entity LABEL resolution: the feed must never show a
 * raw machine key or id to the user.
 *
 * - config rows carry the changed field key in `entity_id` (e.g. `featured_count`)
 *   → resolve to the SAME friendly label the Config tab uses; unknown keys
 *   degrade to the generic "settings" noun, never the raw key.
 * - story/object/term/page rows whose title is empty (entity_label null) → a
 *   translated "untitled" placeholder, never the raw slug/numeric id.
 */

import { describe, it, expect } from "vitest";
import { activityEntityLabel } from "~/lib/activity-display";
import type { RecentActivityRow } from "~/lib/activity.server";

// Fake translator: returns the key's known string, else the provided defaultValue.
const STRINGS: Record<string, string> = {
  "config:sections.collection_interface.field_featured_count": "Featured Count",
  "start:activity.entity.config": "settings",
  "start:activity.untitled": "untitled",
};
const t = ((key: string, opts?: { defaultValue?: string }) =>
  STRINGS[key] ?? opts?.defaultValue ?? key) as never;

function row(over: Partial<RecentActivityRow>): RecentActivityRow {
  return {
    id: 1, verb: "edited", entity_type: "config", entity_id: null,
    entity_label: null, created_at: null, actor_user_id: 1,
    actor_github_id: 1, actor_github_login: "x", actor_github_name: "X",
    ...over,
  };
}

describe("activityEntityLabel", () => {
  it("config: maps a known field key to its Config-tab label", () => {
    expect(activityEntityLabel(row({ entity_type: "config", entity_id: "featured_count" }), t))
      .toBe("Featured Count");
  });

  it("config: unknown field key degrades to the generic settings noun", () => {
    expect(activityEntityLabel(row({ entity_type: "config", entity_id: "some_future_key" }), t))
      .toBe("settings");
  });

  it("config: ignores the (site-title) entity_label and shows the field", () => {
    expect(activityEntityLabel(
      row({ entity_type: "config", entity_id: "featured_count", entity_label: "My Site" }), t,
    )).toBe("Featured Count");
  });

  it("story with a title shows the title", () => {
    expect(activityEntityLabel(
      row({ entity_type: "story", entity_id: "190", entity_label: "Love" }), t,
    )).toBe("Love");
  });

  it("story with no title shows the untitled placeholder, never the raw id", () => {
    const label = activityEntityLabel(
      row({ entity_type: "story", entity_id: "190", entity_label: null }), t,
    );
    expect(label).toBe("untitled");
    expect(label).not.toBe("190");
  });
});
