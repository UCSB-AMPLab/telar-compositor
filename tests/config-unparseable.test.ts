/**
 * This file pins what a publish does with a `_config.yml` it cannot heal into
 * valid YAML, and what the publish check says about one before the publish runs.
 *
 * The publish heals the repository's file — escaping the managed fields,
 * sweeping the orphaned multi-line scalars an older serializer left behind —
 * and parses the result before committing it. A result that still will not
 * parse means the file is corrupt in a shape the line-based heal cannot repair,
 * and the write is dropped: committing broken YAML would break the site's
 * build, and overwriting the file would throw away settings nobody chose to
 * lose. Dropping it is right. Dropping it in silence is not, and that is what
 * the blocker here exists to end.
 *
 * The blocker's condition is the publish's condition, not a likeness of it. A
 * file that does not parse TODAY is a different question, and answering that
 * one instead would refuse a publish for every site the heal exists to repair:
 * the orphaned-scalar corruption below does not parse and heals perfectly. So
 * both sides run the same heal through `publishableConfigYaml`, and the last
 * case in this file holds them to the same answer over every fixture.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, beforeAll } from "vitest";
import { load as loadYaml } from "js-yaml";
import { createInstance, type i18n } from "i18next";

import { checkMessage } from "~/components/features/publish/ValidationChecks";
import {
  publishableConfigYaml,
  runPrePublishValidation,
} from "~/lib/publish.server";
import { project_config } from "~/db/schema";
import enPublish from "~/i18n/locales/en/publish.json";
import esPublish from "~/i18n/locales/es/publish.json";

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
    ...overrides,
  } as ProjectConfigRow;
}

const CONFIG = makeConfig();

/** A well-formed file, managed blocks written the way the writer writes them. */
const VALID = `title: "A site"
url: "https://example.org"
story_interface:
  show_on_homepage: true
  show_story_steps: true
  show_object_credits: true
  include_demo_content: true
collection_interface:
  browse_and_search: true
  show_link_on_homepage: true
  show_sample_on_homepage: false
  featured_count: 4
`;

/**
 * The corruption the heal was written for: a pre-fix serializer wrote a
 * description with bare newlines in it, so the opening quote never closes and
 * the paragraphs after it are orphaned lines no parser can place. The file does
 * not parse; the heal replaces the managed line and sweeps its orphans, and the
 * result does. A blocker raised on "does the repo file parse" would refuse
 * every one of these — the publish that repairs them.
 */
const ORPHANED_SCALAR = `title: "A site"
description: "A description
that ran on
past its quote

and again
url: https://example.org
`;

/**
 * Corruption in keys the heal never touches, so the healed result carries it
 * through unchanged and the publish drops the write. `defaults` is an ordinary
 * Jekyll key and neither a managed field nor a managed block.
 */
const UNHEALABLE_TAB = `title: "A site"
defaults:
\tscope: all
url: https://example.org
`;

const UNHEALABLE_FLOW = `title: "A site"
plugins: [jekyll-feed, jekyll-seo
url: https://example.org
`;

const UNHEALABLE_INDENT = `title: "A site"
defaults:
  scope:
   path: ""
    type: pages
url: https://example.org
`;

/** Every fixture above, with what the publish's own gate makes of it. */
const FIXTURES: Array<[name: string, yaml: string, publishWrites: boolean]> = [
  ["a valid config", VALID, true],
  ["an orphaned managed scalar the heal repairs", ORPHANED_SCALAR, true],
  ["a tab in an unmanaged block", UNHEALABLE_TAB, false],
  ["an unclosed flow sequence", UNHEALABLE_FLOW, false],
  ["bad indentation under an unmanaged key", UNHEALABLE_INDENT, false],
];

function parses(yaml: string): boolean {
  try {
    loadYaml(yaml, { json: true });
    return true;
  } catch {
    return false;
  }
}

function blockerCodes(yaml: string | null, config: ProjectConfigRow | null = CONFIG): string[] {
  return runPrePublishValidation({
    headSha: "same",
    currentRepoHead: "same",
    stories: [],
    steps: [],
    objects: [],
    pages: [],
    glossary: [],
    storyKey: null,
    configYml: yaml,
    config,
  }).blockers.map((b) => b.code);
}

describe("config_unparseable — what the fixtures actually are", () => {
  it("the orphaned-scalar fixture does not parse and the heal repairs it", () => {
    expect(parses(ORPHANED_SCALAR)).toBe(false);
    expect(publishableConfigYaml(ORPHANED_SCALAR, CONFIG)).not.toBeNull();
  });

  it("the unhealable fixtures leave the publish with nothing to write", () => {
    for (const [name, yaml, writes] of FIXTURES) {
      expect({ name, writes: publishableConfigYaml(yaml, CONFIG) !== null }).toEqual({
        name,
        writes,
      });
    }
  });
});

describe("config_unparseable — the blocker", () => {
  it("raises when the healed config would not parse, so the publish is refused", () => {
    expect(blockerCodes(UNHEALABLE_TAB)).toContain("config_unparseable");
  });

  it("raises nothing for a file that does not parse but that the heal repairs", () => {
    expect(blockerCodes(ORPHANED_SCALAR)).not.toContain("config_unparseable");
  });

  it("raises nothing for a valid config", () => {
    expect(blockerCodes(VALID)).not.toContain("config_unparseable");
  });

  it("says nothing about a file it was not given", () => {
    expect(blockerCodes(null)).not.toContain("config_unparseable");
    expect(blockerCodes(UNHEALABLE_TAB, null)).not.toContain("config_unparseable");
  });

  it("carries no params, because it names no line", () => {
    const blockers = runPrePublishValidation({
      headSha: "same",
      currentRepoHead: "same",
      stories: [],
      steps: [],
      objects: [],
      pages: [],
      glossary: [],
      storyKey: null,
      configYml: UNHEALABLE_TAB,
      config: CONFIG,
    }).blockers.filter((b) => b.code === "config_unparseable");

    expect(blockers).toEqual([{ code: "config_unparseable", message: "config_unparseable" }]);
  });
});

describe("config_unparseable — what the author reads", () => {
  let en: i18n;
  let es: i18n;

  beforeAll(async () => {
    const build = async (lng: string) => {
      const instance = createInstance();
      await instance.init({
        lng,
        fallbackLng: "en",
        ns: ["publish"],
        defaultNS: "publish",
        resources: { en: { publish: enPublish }, es: { publish: esPublish } },
        interpolation: { escapeValue: false },
      });
      return instance;
    };
    en = await build("en");
    es = await build("es");
  });

  /** The blocker the validation really produced, rendered the way the page does. */
  const sentence = (instance: i18n) => {
    const blocker = runPrePublishValidation({
      headSha: "same",
      currentRepoHead: "same",
      stories: [],
      steps: [],
      objects: [],
      pages: [],
      glossary: [],
      storyKey: null,
      configYml: UNHEALABLE_TAB,
      config: CONFIG,
    }).blockers.find((b) => b.code === "config_unparseable");

    expect(blocker).toBeDefined();
    return checkMessage(
      instance.t.bind(instance) as (key: string, values?: Record<string, unknown>) => string,
      blocker!,
    );
  };

  it("says what is wrong and what it costs, in English", () => {
    expect(sentence(en)).toBe(
      "Your site's _config.yml is not valid YAML, so the Compositor cannot save your " +
        "settings to it. Fix the file in your repository before publishing: until you " +
        "do, what you change in Site settings will not reach the published site.",
    );
  });

  it("says what is wrong and what it costs, in Spanish", () => {
    expect(sentence(es)).toBe(
      "El archivo _config.yml de tu sitio no es YAML válido, así que el Compositor no " +
        "puede guardar ahí tu configuración. Corrige el archivo en el repositorio antes " +
        "de publicar: mientras no lo hagas, lo que cambies en Configuración del sitio " +
        "no llega al sitio publicado.",
    );
  });

  // The healed file the gate parses is not the file in the repository: the heal
  // sweeps orphaned lines, so an error's line in one is not its line in the
  // other. There is no honest line to name, so the message names none, and no
  // key with one may come back.
  it("names no line, in either locale and in either catalogue", () => {
    for (const instance of [en, es]) {
      expect(sentence(instance)).not.toContain("{{");
    }
    for (const catalogue of [enPublish, esPublish]) {
      expect(Object.keys(catalogue.checks)).not.toContain("config_unparseable_at_line");
    }
  });
});

/**
 * A file the raw-file block check passes and the heal cannot write: the rescue
 * pass drops the corrupt `title` line, which leaves the line under it orphaned
 * inside `story_interface`, and the block writer refuses a block it cannot read
 * whole. The throw is out of the same call the parse check makes, so the check
 * has to answer for it — an empty result here is a publish that then fails with
 * nothing on screen saying why.
 */
const RESCUE_ORPHANS_A_BLOCK = `story_interface:
  show_on_homepage: true
title: [broken
  dangling
`;

describe("config_unparseable — a heal that cannot write a block", () => {
  it("names the block the writer could not edit, rather than nothing at all", () => {
    const blockers = runPrePublishValidation({
      headSha: "same",
      currentRepoHead: "same",
      stories: [],
      steps: [],
      objects: [],
      pages: [],
      glossary: [],
      storyKey: null,
      configYml: RESCUE_ORPHANS_A_BLOCK,
      config: CONFIG,
    }).blockers;

    expect(blockers).toEqual([
      {
        code: "config_block_unwritable",
        message: "config_block_unwritable",
        entityId: "story_interface",
        params: { block: "story_interface" },
      },
    ]);
  });

  // The raw-file check already names a block written in a shape the writer
  // cannot edit. A heal that then throws for that same block must not put a
  // second copy of the same sentence on the author's screen.
  it("names a block once when both the file and the heal refuse it", () => {
    const flow = `story_interface: {show_on_homepage: true}
title: "A site"
`;

    const named = runPrePublishValidation({
      headSha: "same",
      currentRepoHead: "same",
      stories: [],
      steps: [],
      objects: [],
      pages: [],
      glossary: [],
      storyKey: null,
      configYml: flow,
      config: CONFIG,
    }).blockers.filter((b) => b.code === "config_block_unwritable");

    expect(named.map((b) => b.entityId)).toEqual(["story_interface"]);
  });
});

describe("config_unparseable — the check and the write cannot drift", () => {
  it("raises the blocker for exactly the files the publish would not write", () => {
    for (const [name, yaml, writes] of FIXTURES) {
      expect({ name, blocked: blockerCodes(yaml).includes("config_unparseable") }).toEqual({
        name,
        blocked: !writes,
      });
    }
  });
});
