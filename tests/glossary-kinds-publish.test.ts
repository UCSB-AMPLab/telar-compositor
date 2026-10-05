/**
 * The glossary kinds on the publish path: the `_config.yml` a publish commits,
 * the pre-publish check for a `glossary:` the writer cannot edit, and the
 * managed view that change detection and the settings hash are built from.
 *
 * The settings hash itself is pinned by the registry hash probe for
 * `config.glossary_kinds_json` (tests/field-registry-hash-probes.test.ts),
 * since that hash is the JSON of `buildConfigChangeFields`.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { load as loadYaml } from "js-yaml";
import {
  buildConfigChangeFields,
  buildConfigManagedBlocks,
  buildConfigManagedFields,
  healConfigYaml,
  publishableConfigYaml,
  runPrePublishValidation,
  UnwritableConfigBlockError,
} from "~/lib/publish.server";
import { project_config } from "~/db/schema";

type ProjectConfigRow = typeof project_config.$inferSelect;

function makeConfig(overrides: Partial<ProjectConfigRow> = {}): ProjectConfigRow {
  return {
    id: 1,
    project_id: 1,
    title: "A site",
    lang: "en",
    baseurl: null,
    url: "https://example.org",
    telar_version: null,
    theme: null,
    description: "A description",
    author: null,
    email: null,
    logo: null,
    include_demo_content: true,
    google_sheets_enabled: false,
    google_sheets_published_url: null,
    show_on_homepage: true,
    show_story_steps: true,
    show_object_credits: true,
    browse_and_search: true,
    show_link_on_homepage: true,
    show_sample_on_homepage: false,
    collection_mode: false,
    featured_count: 4,
    answer_word_limit: null,
    story_key: null,
    glossary_kinds_json: null,
    ...overrides,
  } as ProjectConfigRow;
}

const KINDS = [{ id: "place", label: "Place", heading: "Places", values: ["sitio"] }];
const WITH_KINDS = makeConfig({ glossary_kinds_json: JSON.stringify(KINDS) });
const WITHOUT_KINDS = makeConfig();

/** A file whose `kinds:` is written in a shape the writer would rewrite. */
const REPO = 'title: "A site"\nglossary:\n  kinds: [{id: old, label: Old, heading: Olds}]\n  other_setting: true\n';

function unwritableBlocks(configYml: string, config: ProjectConfigRow): unknown[] {
  return runPrePublishValidation({
    headSha: "same",
    currentRepoHead: "same",
    stories: [],
    steps: [],
    objects: [],
    pages: [],
    glossary: [],
    storyKey: null,
    configYml,
    config,
  })
    .blockers.filter((b) => b.code === "config_block_unwritable")
    .map((b) => b.entityId);
}

describe("publishableConfigYaml — glossary kinds", () => {
  it("writes the stored kinds when the column is set, keeping the other children", () => {
    const out = publishableConfigYaml(REPO, WITH_KINDS);
    expect(out).not.toBeNull();
    const glossary = (loadYaml(out!) as Record<string, unknown>).glossary;
    expect(glossary).toEqual({ kinds: KINDS, other_setting: true });
  });

  it("writes an empty list as no kinds: at all", () => {
    const out = publishableConfigYaml(REPO, makeConfig({ glossary_kinds_json: "[]" }));
    expect(out).not.toContain("kinds:");
    expect((loadYaml(out!) as Record<string, unknown>).glossary).toEqual({ other_setting: true });
  });

  it("leaves the file's glossary: byte for byte when the column is null", () => {
    const out = publishableConfigYaml(REPO, WITHOUT_KINDS);
    const healed = healConfigYaml(REPO, buildConfigManagedFields(WITHOUT_KINDS), buildConfigManagedBlocks(WITHOUT_KINDS));
    expect(out).toBe(healed);
    expect(out).toContain("glossary:\n  kinds: [{id: old, label: Old, heading: Olds}]\n  other_setting: true\n");
  });
});

describe("pre-publish check — a glossary: the writer cannot edit", () => {
  const FLOW = 'title: "A site"\nglossary: {kinds: []}\n';

  it("raises config_block_unwritable naming glossary when the column is set", () => {
    expect(unwritableBlocks(FLOW, WITH_KINDS)).toEqual(["glossary"]);
  });

  it("says nothing about it when the column is null, since nothing is written there", () => {
    expect(unwritableBlocks(FLOW, WITHOUT_KINDS)).toEqual([]);
  });
});

describe("pre-publish check — shapes the line edit cannot see, judged by the parsed result", () => {
  const OLD = "{id: old, label: Old, heading: Olds}";
  const CASES: Array<[string, string, ProjectConfigRow]> = [
    ["a quoted sibling key", `glossary:\n  kinds: [${OLD}]\n  "other_setting": true\n`, WITH_KINDS],
    ["a quoted kinds key", `glossary:\n  "kinds": [${OLD}]\n  other_setting: true\n`, WITH_KINDS],
    ["a spaced header", `glossary :\n  kinds: [${OLD}]\n  other_setting: true\n`, WITH_KINDS],
    ["a quoted header", `"glossary":\n  kinds: [${OLD}]\n  other_setting: true\n`, WITH_KINDS],
    [
      "two glossary blocks, the kinds cleared",
      `glossary:\n  kinds: [${OLD}]\nglossary:\n  kinds: [{id: recent, label: Recent, heading: Recents}]\n`,
      makeConfig({ glossary_kinds_json: "[]" }),
    ],
  ];
  for (const [name, yaml, config] of CASES) {
    it(`refuses ${name}: the blocker names glossary and no file is written`, () => {
      expect(unwritableBlocks(yaml, config)).toEqual(["glossary"]);
      expect(() => publishableConfigYaml(yaml, config)).toThrow(UnwritableConfigBlockError);
    });
  }
});

describe("buildConfigChangeFields — glossary kinds", () => {
  it("carries the kinds as canonical JSON under glossary.kinds", () => {
    expect(buildConfigChangeFields(WITH_KINDS)["glossary.kinds"]).toBe(JSON.stringify(KINDS));
  });

  it("has no glossary.kinds entry while the column is null", () => {
    expect(Object.keys(buildConfigChangeFields(WITHOUT_KINDS))).not.toContain("glossary.kinds");
  });

  it("moves when the kinds change, and not for a difference only in whitespace", () => {
    const renamed = makeConfig({ glossary_kinds_json: JSON.stringify([{ ...KINDS[0], heading: "Sites" }]) });
    const spaced = makeConfig({ glossary_kinds_json: JSON.stringify([{ ...KINDS[0], label: " Place " }]) });
    expect(buildConfigChangeFields(renamed)).not.toEqual(buildConfigChangeFields(WITH_KINDS));
    expect(buildConfigChangeFields(spaced)).toEqual(buildConfigChangeFields(WITH_KINDS));
  });
});
