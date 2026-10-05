/**
 * The approved convenor-only config split, as a table.
 *
 * Ruling 6 (2026-08-27) draws the line at anything that changes where the
 * site lives, how it is built, or where its data comes from. Six fields fall
 * on the convenor's side of it; everything else in `project_config` stays
 * collaborator-writable, matching what a member can already reach through the
 * homepage editor's autosave.
 *
 * These tests pin the list itself, because it is an approved list rather than
 * a derived one — a field added to `project_config` later is collaborator-
 * writable by default, and moving it across the line is a decision, not a
 * refactor.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import {
  CONVENOR_ONLY_CONFIG_FIELDS,
  isConvenorOnlyConfigField,
  canWriteConfigField,
} from "~/lib/config-fields";

const COLLABORATOR_WRITABLE = [
  "title",
  "description",
  "author",
  "email",
  "lang",
  "theme",
  "logo",
  "show_on_homepage",
  "show_story_steps",
  "show_object_credits",
  "browse_and_search",
  "show_link_on_homepage",
  "show_sample_on_homepage",
  "collection_mode",
  "skip_stories",
  "featured_count",
  // The site's own glossary kinds: any publishing role edits them.
  "glossary_kinds_json",
];

describe("the convenor-only config field list", () => {
  it("is exactly the six fields ruling 6 names", () => {
    expect([...CONVENOR_ONLY_CONFIG_FIELDS].sort()).toEqual([
      "baseurl",
      "google_sheets_enabled",
      "google_sheets_published_url",
      "include_demo_content",
      "story_key",
      "url",
    ]);
  });

  it("does not claim any field ruling 6 leaves with collaborators", () => {
    for (const field of COLLABORATOR_WRITABLE) {
      expect(isConvenorOnlyConfigField(field), `${field} is not convenor-only`).toBe(false);
    }
  });
});

describe("canWriteConfigField", () => {
  it("lets the convenor write every field", () => {
    for (const field of [...CONVENOR_ONLY_CONFIG_FIELDS, ...COLLABORATOR_WRITABLE]) {
      expect(canWriteConfigField(field, "convenor"), field).toBe(true);
    }
  });

  it("lets a collaborator write the approved fields and refuses the six", () => {
    for (const field of COLLABORATOR_WRITABLE) {
      expect(canWriteConfigField(field, "collaborator"), field).toBe(true);
    }
    for (const field of CONVENOR_ONLY_CONFIG_FIELDS) {
      expect(canWriteConfigField(field, "collaborator"), field).toBe(false);
    }
  });

  it("treats an instructor exactly as a collaborator", () => {
    for (const field of COLLABORATOR_WRITABLE) {
      expect(canWriteConfigField(field, "instructor"), field).toBe(true);
    }
    for (const field of CONVENOR_ONLY_CONFIG_FIELDS) {
      expect(canWriteConfigField(field, "instructor"), field).toBe(false);
    }
  });

  it("refuses every field to a caller with no role or an unknown one", () => {
    for (const field of [...CONVENOR_ONLY_CONFIG_FIELDS, ...COLLABORATOR_WRITABLE]) {
      expect(canWriteConfigField(field, null), field).toBe(false);
      expect(canWriteConfigField(field, undefined), field).toBe(false);
      expect(canWriteConfigField(field, "spectator"), field).toBe(false);
    }
  });
});
