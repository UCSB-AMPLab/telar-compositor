/**
 * `skip_stories` end to end, above what the registry-generated suites already
 * force.
 *
 * The setting drops the stories section from a site's homepage, leaving only
 * the collection — the shape a course gallery wants. The framework has
 * implemented it for some time; what is new is the Compositor knowing about it.
 *
 * The one fact everything here turns on: the block is `development-features:`
 * in `_config.yml`. `dev_features` is only a Liquid local in
 * `_layouts/index.html`, so a publisher that wrote `dev_features:` would emit a
 * key the framework never reads, and an importer that looked for it would drop
 * the setting on every import.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildConfigManagedBlocks,
  buildConfigChangeFields,
  computeChangeSummary,
  healConfigYaml,
  buildConfigManagedFields,
  KNOWN_CONFIG_KEYS,
} from "~/lib/publish.server";
import type { CurrentPublishState, PublishSnapshot } from "~/lib/publish.server";
import { mapConfigToProjectConfig } from "~/lib/import.server";
import { parseYaml } from "~/lib/yaml.server";
import { extractConfigFields, MANAGED_CONFIG_FIELDS, CONFIG_YAML_KEY_ALIASES } from "~/lib/sync.server";
import { settingsChangeI18nKey } from "~/lib/settings-change-i18n";
import type { project_config } from "~/db/schema";

type ProjectConfigRow = typeof project_config.$inferSelect;

function configRow(overrides: Partial<ProjectConfigRow> = {}): ProjectConfigRow {
  return {
    id: 1,
    project_id: 1,
    title: "A site",
    lang: "en",
    baseurl: "",
    url: "",
    telar_version: null,
    theme: "trama",
    description: null,
    author: null,
    email: null,
    logo: null,
    include_demo_content: false,
    google_sheets_enabled: false,
    google_sheets_published_url: null,
    show_on_homepage: true,
    show_story_steps: true,
    show_object_credits: true,
    browse_and_search: true,
    show_link_on_homepage: true,
    show_sample_on_homepage: false,
    collection_mode: false,
    skip_stories: false,
    featured_count: 4,
    story_key: "",
    navigation_json: null,
    updated_at: null,
    ...overrides,
  } as ProjectConfigRow;
}

// ---------------------------------------------------------------------------
// The block name
// ---------------------------------------------------------------------------

describe("the publish key is development-features.skip_stories", () => {
  it("publishes under development-features, never dev_features", () => {
    const blocks = buildConfigManagedBlocks(configRow({ skip_stories: true }));
    expect(blocks["development-features"]).toEqual({ skip_stories: "true" });
    expect(blocks).not.toHaveProperty("dev_features");
  });

  it("emits the value unquoted, so js-yaml reads it back as a real boolean", () => {
    // A quoted "false" reads back as a truthy string — the bug this pins.
    expect(buildConfigManagedBlocks(configRow({ skip_stories: false }))["development-features"])
      .toEqual({ skip_stories: "false" });
  });

  it("names development-features as a structural top-level key", () => {
    // Otherwise the config-heal sweep would treat the block header as prose.
    expect(KNOWN_CONFIG_KEYS.has("development-features")).toBe(true);
  });

  it("sync reads the same path it is published under", () => {
    expect(MANAGED_CONFIG_FIELDS).toContain("skip_stories");
    expect(CONFIG_YAML_KEY_ALIASES.skip_stories).toBe("development-features.skip_stories");
  });
});

// ---------------------------------------------------------------------------
// Publish -> repo -> import, on a real config file
// ---------------------------------------------------------------------------

const TEMPLATE = [
  "# Telar site configuration",
  "title: placeholder",
  "development-features:",
  "  skip_collections: false",
  "  skip_stories: false",
  "telar:",
  "  version: 1.4.0",
  "",
].join("\n");

describe("publish and import agree on the block", () => {
  it("replaces the existing key in place, leaving its siblings alone", () => {
    const row = configRow({ skip_stories: true });
    const yaml = healConfigYaml(TEMPLATE, buildConfigManagedFields(row), buildConfigManagedBlocks(row));

    expect(yaml).toContain("  skip_stories: true");
    expect(yaml, "an unmanaged sibling key was disturbed").toContain("  skip_collections: false");
    expect(yaml.match(/^development-features:/gm)).toHaveLength(1);
  });

  it("appends the block when the repo has none", () => {
    const bare = "title: placeholder\n";
    const row = configRow({ skip_stories: true });
    const yaml = healConfigYaml(bare, buildConfigManagedFields(row), buildConfigManagedBlocks(row));

    expect(parseYaml(yaml)["development-features"]).toEqual({ skip_stories: true });
  });

  it("round-trips both sides of the boolean back into the config row", () => {
    for (const value of [true, false]) {
      const row = configRow({ skip_stories: value });
      const yaml = healConfigYaml(TEMPLATE, buildConfigManagedFields(row), buildConfigManagedBlocks(row));
      expect(mapConfigToProjectConfig(parseYaml(yaml)).skip_stories).toBe(value);
    }
  });

  it("import leaves the field undefined when the repo has no such block", () => {
    // Undefined, not false: an absent key must take the column default rather
    // than asserting a value the repo never stated.
    expect(mapConfigToProjectConfig(parseYaml("title: A site\n")).skip_stories).toBeUndefined();
  });

  it("sync reads back exactly what publish wrote", () => {
    const row = configRow({ skip_stories: true });
    const yaml = healConfigYaml(TEMPLATE, buildConfigManagedFields(row), buildConfigManagedBlocks(row));
    expect(extractConfigFields(yaml).skip_stories).toBe("true");
  });

  it("sync reads null from a repo with no development-features block", () => {
    // Null is the repo-empty guard's input: no block means no repo-side edit to
    // reconcile, not a repo-side "false".
    expect(extractConfigFields("title: A site\n").skip_stories).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Change copy
// ---------------------------------------------------------------------------

describe("publish change copy", () => {
  function summaryFor(before: boolean, after: boolean) {
    const current = {
      stories: [],
      objects: [],
      pages: [],
      glossary: [],
      allStoryIds: [],
      config: configRow({ skip_stories: after }),
      entityHashes: {
        version: 2,
        stories: {},
        objects: {},
        pages: {},
        glossary: {},
        navigation: "",
        landing: "",
        settings: "",
      },
    } as unknown as CurrentPublishState;
    const snapshot = {
      config_managed: buildConfigChangeFields(configRow({ skip_stories: before })),
      entity_hashes: {
        version: 2,
        stories: {},
        objects: {},
        pages: {},
        glossary: {},
        navigation: "",
        landing: "",
        settings: "",
      },
      story_ids: [],
      object_ids: [],
    } as unknown as PublishSnapshot;
    return computeChangeSummary(current, snapshot);
  }

  it("reports the change under the bare field name, not the block path", () => {
    const changed = summaryFor(false, true).settings.changed;
    expect(changed.map((c) => c.key)).toContain("skip_stories");
    expect(changed.map((c) => c.key)).not.toContain("development-features.skip_stories");
  });

  it("threads on/off so the copy can say which way it went", () => {
    expect(summaryFor(false, true).settings.changed.find((c) => c.key === "skip_stories")?.label)
      .toBe("on");
    expect(summaryFor(true, false).settings.changed.find((c) => c.key === "skip_stories")?.label)
      .toBe("off");
  });

  it("resolves to the landed auto_commit keys", () => {
    expect(settingsChangeI18nKey({ key: "skip_stories", label: "on" }))
      .toBe("change_skip_stories_on");
    expect(settingsChangeI18nKey({ key: "skip_stories", label: "off" }))
      .toBe("change_skip_stories_off");
  });

  it("reports nothing when the setting did not move", () => {
    expect(summaryFor(true, true).settings.changed.map((c) => c.key)).not.toContain("skip_stories");
  });
});

// ---------------------------------------------------------------------------
// The settings form
// ---------------------------------------------------------------------------

// The config route is a large collaborative component whose direct unit
// invocation is impractical, so the wiring is asserted at the source level —
// the same idiom role-gating.test.tsx uses for the route gates.
const configRouteSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "app", "routes", "_app.config.tsx"),
  "utf-8",
);

describe("the settings toggle", () => {
  it("is wired into the config route's form, action and collaborative sync", () => {
    // A form field the action does not read saves nothing; a field the Y.Doc
    // sync does not carry is lost the moment another editor's snapshot lands.
    const source = configRouteSrc;
    expect(source, "no toggle rendered").toContain('name="skip_stories"');
    expect(source, "action does not persist it").toContain(
      'skip_stories: formData.get("skip_stories") === "true"',
    );
    expect(source, "not carried into the Y.Doc with the other booleans").toMatch(
      /const booleans = \[[^\]]*"skip_stories"/s,
    );
    expect(source, "uses the wrong i18n keys").toContain(
      "sections.collection_interface.field_skip_stories",
    );
  });
});
