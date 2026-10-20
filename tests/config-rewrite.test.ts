/**
 * The rewrite of a `_config.yml` the publish writer cannot update
 * (`app/lib/config-rewrite.server.ts`): the file rebuilt from the release's
 * template with the site's settings copied in, the Site settings written over
 * them, and a report of what the rewrite does.
 *
 * The template below follows the shape of the Telar template's `_config.yml`
 * (its keys, blocks and comments) with neutral values; no site's content is
 * used.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { load as loadYaml } from "js-yaml";

const { fetchFrameworkFile, fetchLatestRelease } = vi.hoisted(() => ({
  fetchFrameworkFile: vi.fn(),
  fetchLatestRelease: vi.fn(),
}));
vi.mock("~/lib/upgrade.server", () => ({ fetchFrameworkFile, fetchLatestRelease }));

import {
  configRewriteFingerprint,
  fetchConfigTemplate,
  prepareConfigRewrite,
  rebuildConfigYaml,
  rewriteKeepsSite,
} from "~/lib/config-rewrite.server";
import { configNeedsRewrite, runPrePublishValidation } from "~/lib/publish.server";
import { cleanCommitContent } from "~/lib/commit.server";
import { project_config } from "~/db/schema";
import enPublish from "~/i18n/locales/en/publish.json";
import esPublish from "~/i18n/locales/es/publish.json";

type ProjectConfigRow = typeof project_config.$inferSelect;

/** A row that writes nothing: every managed column null. */
function makeConfig(overrides: Partial<ProjectConfigRow> = {}): ProjectConfigRow {
  return {
    id: 1,
    project_id: 1,
    title: null,
    lang: null,
    baseurl: null,
    url: null,
    telar_version: "1.8.2",
    theme: null,
    description: null,
    author: null,
    email: null,
    logo: null,
    include_demo_content: null,
    google_sheets_enabled: false,
    google_sheets_published_url: null,
    show_on_homepage: null,
    show_story_steps: null,
    show_object_credits: null,
    browse_and_search: null,
    show_link_on_homepage: null,
    show_sample_on_homepage: null,
    collection_mode: null,
    featured_count: null,
    skip_stories: null,
    glossary_kinds_json: null,
    answer_word_limit: null,
    story_key: null,
    ...overrides,
  } as ProjectConfigRow;
}

const TEMPLATE_TEXT = `# Telar - Digital Storytelling Framework
# https://telar.org

# Site Settings
title: "Telar"
description: "A Telar site."
url: ""
baseurl: ""
author: ""
email: ""
telar_theme: "trama" # Options: trama, paisajes, neogranadina, santa-barbara, austin, or custom
logo: ""
telar_language: "en" # Options: "en" (English), "es" (Español)
collection_mode: false # Set to true to show objects first

# Story Interface Settings
story_interface:
  show_on_homepage: true # Set to false to hide stories section from homepage
  show_story_steps: true # Set to false to hide "Step X" overlay in stories
  show_object_credits: true # Set to true to display object credits badge
  include_demo_content: true # Fetch demo stories from content.telar.org

# Collection Interface Settings
collection_interface:
  browse_and_search: true # Set to false to disable filtering sidebar
  show_link_on_homepage: true # Set to false to hide "View the objects" link
  show_sample_on_homepage: true # Set to true to show a sample of objects
  featured_count: 4 # Number of objects to show on homepage (default 4)

# Story Protection (optional)
story_key: ""

# Google Sheets Integration (optional)
google_sheets:
  enabled: false
  published_url: ""

#
# PLEASE DO NOT EDIT BELOW THIS LINE UNLESS YOU KNOW WHAT YOU ARE DOING
#

# Collections
collections:
  stories:
    output: true
    permalink: /stories/:name/

# Build Settings
markdown: kramdown
permalink: pretty
exclude:
  - Gemfile
  - node_modules

# Telar Settings (version information)
telar:
  version: "1.8.2"
  release_date: "2026-10-16"

# Plugins
plugins:
  - jekyll-seo-tag

# Development & Testing
development-features:
  christmas_tree_mode: false
  skip_stories: false
`;

const TEMPLATE = { tag: "v1.8.2", text: TEMPLATE_TEXT };

function doc(text: string): Record<string, unknown> {
  return loadYaml(text) as Record<string, unknown>;
}

function rebuild(site: string, config: ProjectConfigRow = makeConfig()) {
  const rebuilt = rebuildConfigYaml(site, TEMPLATE, config);
  expect(rebuilt).not.toBeNull();
  return rebuilt!;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("rebuildConfigYaml — header and comments", () => {
  it("writes the template's header and keeps the comments inside the site's entries", () => {
    const site = `# My own heading
title: "Mine"
exclude:
  # kept: a comment inside the value
  - vendor
`;
    const { text, report } = rebuild(site);
    expect(text.startsWith("# Telar - Digital Storytelling Framework\n# https://telar.org\n")).toBe(true);
    expect(text).toContain("exclude:\n  # kept: a comment inside the value\n  - vendor\n");
    expect(text).not.toContain("# My own heading");
    expect(report.commentsDropped).toBe(true);
  });

  it("says no comment was dropped when the site's comments all reach the result", () => {
    const site = `# Telar - Digital Storytelling Framework
title: "Mine"
`;
    expect(rebuild(site).report.commentsDropped).toBe(false);
  });

  it("reports a header line that is not a comment as removed", () => {
    const site = `%YAML 1.2
---
title: "Mine"
`;
    const { report } = rebuild(site);
    expect(report.removed).toEqual(["%YAML 1.2", "---"]);
  });

  // A quoted key above the first plain one is a header line the rebuild
  // removes, and the file read whole holds it, so the rewrite would lose a
  // setting: none is offered.
  it("offers no rewrite that would remove a setting the file read whole holds", () => {
    const site = `"quoted": 1
title: "Mine"
`;
    expect(rebuildConfigYaml(site, TEMPLATE, makeConfig())).toBeNull();
  });
});

describe("rebuildConfigYaml — documents", () => {
  it("reports a second document as removed and never promotes it into the file", () => {
    const site = `title: "Mine"
---
markdown: commonmark
custom: from-the-second-document
`;
    const { text, report } = rebuild(site);
    expect(report.removed).toEqual(["---", "markdown: commonmark", "custom: from-the-second-document"]);
    const result = doc(text);
    expect(result.markdown).toBe("kramdown");
    expect(result).not.toHaveProperty("custom");
  });
});

describe("rebuildConfigYaml — entries", () => {
  it("copies a site entry verbatim", () => {
    const entry = `exclude:   # the site's own list
  - Gemfile
  -   "odd spacing"
  - node_modules
`;
    const { text, report } = rebuild(`title: "Mine"\n${entry}`);
    expect(text).toContain(entry);
    expect(report.kept).toContain("exclude");
  });

  it("gives a key the site lacks the template's value, and says so", () => {
    const { text, report } = rebuild(`title: "Mine"\n`);
    expect(doc(text).markdown).toBe("kramdown");
    expect(report.templateValues).toContain("markdown");
    expect(report.templateValues).not.toContain("title");
  });

  it("removes and reports an entry that does not parse on its own", () => {
    const site = `title: "Mine"
defaults:
\tscope: all
markdown: commonmark
`;
    const { text, report } = rebuild(site);
    expect(report.removed).toEqual(["defaults:", "\tscope: all"]);
    expect(doc(text)).not.toHaveProperty("defaults");
    expect(doc(text).markdown).toBe("commonmark");
  });

  it("keeps the last readable occurrence of a repeated key and reports the earlier one", () => {
    const site = `custom: first
title: "Mine"
custom: second
`;
    const { text, report } = rebuild(site);
    expect(doc(text).custom).toBe("second");
    expect(report.removed).toEqual(["custom: first"]);
  });

  it("puts a key the template lacks after the template's keys, in the site's order", () => {
    const site = `zeta: 1
title: "Mine"
alpha: 2
`;
    const { text } = rebuild(site);
    const keys = Object.keys(doc(text));
    expect(keys.slice(-2)).toEqual(["zeta", "alpha"]);
  });
});

describe("rebuildConfigYaml — managed blocks and settings", () => {
  it("writes a flow-style managed block as an indented block, keeping its other children", () => {
    const site = `title: "Mine"
story_interface: {show_on_homepage: false, custom_child: "kept"}
`;
    const config = makeConfig({ show_on_homepage: true });
    expect(configNeedsRewrite(site, config)).toBe(true);
    const { text } = rebuild(site, config);
    expect(text).toMatch(/^story_interface:\n {2}show_on_homepage: true\n {2}custom_child: "kept"$/m);
    expect(doc(text).story_interface).toEqual({ custom_child: "kept", show_on_homepage: true });
    expect(configNeedsRewrite(text, config)).toBe(false);
  });

  it("accepts telar.version healed of its leading v", () => {
    const site = `title: "Mine"
telar:
  version: "v1.2.0"
`;
    const { text, report } = rebuild(site);
    expect((doc(text).telar as Record<string, unknown>).version).toBe("1.2.0");
    expect(report.kept).toContain("telar");
  });

  it("names the settings the Site settings write over a different value", () => {
    const site = `title: "Old title"
story_interface:
  show_on_homepage: false
  show_story_steps: true
`;
    const config = makeConfig({ title: "New title", show_on_homepage: true, show_story_steps: true });
    const { text, report } = rebuild(site, config);
    expect(doc(text).title).toBe("New title");
    expect(report.fromSettings).toEqual(["title", "story_interface.show_on_homepage"]);
    expect(report.kept).not.toContain("title");
  });
});

/**
 * The shape of the site in bug report #68: a file in the template's shape
 * whose description and author were written folded over several lines.
 */
const FOLDED_SITE = TEMPLATE_TEXT.replace(
  'description: "A Telar site."',
  "description: Placeholder text for a site description that runs on past the\n  width of one line, as a YAML dumper folds a long value, and ends on\n  this third line.",
).replace(
  'author: ""',
  "author: First Placeholder Author, Second Placeholder Author,\n  Third Placeholder Author",
);

describe("rebuildConfigYaml — folded values (bug report #68's shape)", () => {
  it("is a file that parses, with its values folded over lines", () => {
    expect(doc(FOLDED_SITE).author).toBe(
      "First Placeholder Author, Second Placeholder Author, Third Placeholder Author",
    );
  });

  it("rebuilds with the Site settings over the folded values and every other value kept", () => {
    const config = makeConfig({ description: "One line now", author: "One author" });
    const { text, report } = rebuild(FOLDED_SITE, config);
    const result = doc(text);
    expect(result.description).toBe("One line now");
    expect(result.author).toBe("One author");
    expect(result.markdown).toBe("kramdown");
    expect(report.fromSettings).toEqual(["description", "author"]);
    expect(report.removed).toEqual([]);
    expect(report.commentsDropped).toBe(false);
    expect(rewriteKeepsSite(FOLDED_SITE, text, config)).toBe(true);
  });
});

describe("rewriteKeepsSite — the self-check", () => {
  const site = `title: "Mine"
custom: keep
`;

  it("passes the rewrite rebuilt from the site", () => {
    expect(rewriteKeepsSite(site, rebuild(site).text, makeConfig())).toBe(true);
  });

  it("refuses a result that loses a value the site's file held", () => {
    const lost = rebuild(site).text.replace("custom: keep\n", "");
    expect(doc(lost)).not.toHaveProperty("custom");
    expect(rewriteKeepsSite(site, lost, makeConfig())).toBe(false);
  });

  it("refuses a result that changes a value the site's file held", () => {
    const changed = rebuild(site).text.replace("custom: keep", "custom: other");
    expect(rewriteKeepsSite(site, changed, makeConfig())).toBe(false);
  });

  it("refuses a result that does not hold a value the Site settings write", () => {
    const config = makeConfig({ title: "From settings" });
    const text = rebuild(site, config).text.replace('title: "From settings"', 'title: "Mine"');
    expect(rewriteKeepsSite(site, text, config)).toBe(false);
  });
});

describe("rebuildConfigYaml — the self-check refuses", () => {
  // A kept block scalar holds the blank lines below it, which the split gives
  // to the entry under them: the entry read alone loses them, and only the
  // site's whole reading shows the value the rebuilt file no longer holds.
  it("a rebuild whose split loses the blank lines a kept block scalar holds", () => {
    const site = `title: "Mine"
custom: |+
  text

markdown: kramdown
`;
    expect(doc(site).custom).toBe("text\n\n");
    expect(rebuildConfigYaml(site, TEMPLATE, makeConfig())).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      "[config-rewrite] the rebuilt file does not keep the site's settings",
      { template: "v1.8.2" },
    );
  });
});

describe("rebuildConfigYaml — the text checked is the text committed", () => {
  // The commit cleans out characters a Telar build rejects, a U+2028 among
  // them, which it turns into a space. The rebuild cleans first, so the
  // self-check judges the bytes the commit writes, and a value the clean
  // would change refuses the rewrite instead of changing in the commit.
  it("refuses a rewrite whose commit clean would change a value the site held", () => {
    const site = 'custom: "one\u2028two"\nstory_interface: {show_on_homepage: true}\n';
    expect(doc(site).custom).toBe("one\u2028two");
    expect(rebuildConfigYaml(site, TEMPLATE, makeConfig())).toBeNull();
  });

  it("gives a text the commit clean leaves as it is", () => {
    const { text } = rebuild(FOLDED_SITE, makeConfig({ description: "One line" }));
    expect(cleanCommitContent("_config.yml", text)).toBe(text);
  });
});

describe("rebuildConfigYaml — the report reads the site's values whole", () => {
  // The split gives the blank line a kept block scalar holds to the entry
  // below it, so the entry read alone says "text\n" where the site's file says
  // "text\n\n". The Site settings write "text\n": a change, not a kept value.
  it("lists a block scalar the Site settings change under from_settings", () => {
    const site = `description: |+
  text

url: ""
story_interface: {show_on_homepage: true}
`;
    expect(doc(site).description).toBe("text\n\n");
    const { text, report } = rebuild(site, makeConfig({ description: "text\n" }));
    expect(doc(text).description).toBe("text\n");
    expect(report.fromSettings).toContain("description");
    expect(report.kept).not.toContain("description");
  });
});

describe("rebuildConfigYaml — entries that read only through the whole document", () => {
  // `defaults` is an alias to another entry, so it does not parse alone; the
  // whole document gives it the expanded list, which the rebuilt file keeps.
  const site = `page_defaults: &page_defaults
  - scope: {path: ""}
    values: {layout: page}
defaults: *page_defaults
story_interface: {show_on_homepage: true}
`;
  const expanded = [{ scope: { path: "" }, values: { layout: "page" } }];

  it("keeps the value an alias resolves to, written from that value", () => {
    expect(doc(site).defaults).toEqual(expanded);
    const { text, report } = rebuild(site);
    expect(doc(text).defaults).toEqual(expanded);
    expect(report.removed).toEqual([]);
    expect(report.kept).toContain("defaults");
    expect(rewriteKeepsSite(site, text, makeConfig())).toBe(true);
  });

  it("still removes an entry the whole document does not read either", () => {
    const broken = `title: "Mine"\ndefaults:\n\tscope: all\n`;
    expect(rebuild(broken).report.removed).toEqual(["defaults:", "\tscope: all"]);
  });
});

describe("rebuildConfigYaml — every key the file read whole holds", () => {
  it("keeps a key spaced from its colon as its own entry, verbatim", () => {
    const site = `title: "Mine"
timezone : America/Bogota
story_interface: {show_on_homepage: true}
`;
    const { text, report } = rebuild(site);
    expect(text).toContain("\ntimezone : America/Bogota\n");
    expect(doc(text).timezone).toBe("America/Bogota");
    expect(report.kept).toContain("timezone");
    expect(report.removed).toEqual([]);
  });

  // A quoted key at column 0 is not a line the split starts an entry at, so
  // it joins the entry above, which then parses to two keys and is written
  // from the one it is named for. The second key is not in the result.
  it("offers no rewrite when an entry read alone holds a key the result loses", () => {
    const site = `title: "Mine"
"custom": keep
story_interface: {show_on_homepage: true}
`;
    expect(doc(site).custom).toBe("keep");
    expect(rebuildConfigYaml(site, TEMPLATE, makeConfig())).toBeNull();
    const withoutCustom = rebuild(site.replace('"custom": keep\n', "")).text;
    expect(rewriteKeepsSite(site, withoutCustom, makeConfig())).toBe(false);
  });
});

describe("rebuildConfigYaml — merges, as Jekyll reads them", () => {
  // `defaults` reads only through the whole file and is written from its
  // value, where the core reading holds `<<` as an ordinary key: written back
  // quoted, it is no longer a merge, and Jekyll would lose `layout: page`.
  it("offers no rewrite that would turn a merge into an ordinary key", () => {
    const site = `common: &common
  layout: page
defaults:
  - scope: {path: ""}
    values: {<<: *common}
story_interface: {show_on_homepage: true}
`;
    expect(loadYaml(site)).toMatchObject({ defaults: [{ values: { layout: "page" } }] });
    expect(rebuildConfigYaml(site, TEMPLATE, makeConfig())).toBeNull();
  });
});

describe("rebuildConfigYaml — values Jekyll reads as YAML 1.1", () => {
  // `show_drafts` reads only through the whole file and is written from its
  // value. The core reading gives the plain `no` as the string "no", written
  // back quoted; Psych reads the site's `no` as false, so the site would
  // change. No rewrite is offered.
  it("offers no rewrite that writes back a string YAML 1.1 reads as a boolean", () => {
    const site = `title: "Archive"
future: &preview no
show_drafts: *preview
story_interface: {show_on_homepage: true}
`;
    expect(rebuildConfigYaml(site, TEMPLATE, makeConfig())).toBeNull();
  });

  it.each([["1:20"], ["0755"], ["0b101"], ["1_000"], ["On"]])(
    "refuses a regenerated block holding %s, as a value or a key",
    (scalar) => {
      const asValue = `title: "Mine"\nstory_interface: {show_on_homepage: true, note: "${scalar}"}\n`;
      const asKey = `title: "Mine"\nstory_interface: {show_on_homepage: true, "${scalar}": x}\n`;
      expect(rebuildConfigYaml(asValue, TEMPLATE, makeConfig())).toBeNull();
      expect(rebuildConfigYaml(asKey, TEMPLATE, makeConfig())).toBeNull();
    },
  );

  // Psych reads `04000` as an octal; the core reading gives 4000, which
  // written back is a different number to Jekyll. No number is written back.
  it("offers no rewrite that writes back a number read through an alias", () => {
    const site = `title: "Mine"
port: &port 04000
livereload_port: *port
story_interface: {show_on_homepage: true}
`;
    expect(rebuildConfigYaml(site, TEMPLATE, makeConfig())).toBeNull();
  });

  it("refuses a regenerated block holding a plain number, as a value or a key", () => {
    const asValue = `title: "Mine"\nstory_interface: {show_on_homepage: true, per_page: 10}\n`;
    const asKey = `title: "Mine"\nstory_interface: {show_on_homepage: true, "10": x}\n`;
    expect(rebuildConfigYaml(asValue, TEMPLATE, makeConfig())).toBeNull();
    expect(rebuildConfigYaml(asKey, TEMPLATE, makeConfig())).toBeNull();
  });

  it("still rewrites a flow block of booleans, and one whose number the Site settings write", () => {
    const flow = `title: "Mine"\nstory_interface: {show_on_homepage: true}\n`;
    expect(rebuild(flow).text).toContain("story_interface:\n  show_on_homepage: true");
    const counted = `title: "Mine"\ncollection_interface: {featured_count: 2}\n`;
    expect(doc(rebuild(counted, makeConfig({ featured_count: 6 })).text).collection_interface).toEqual({ featured_count: 6 });
  });

  it("still rewrites a regenerated block holding only unambiguous strings", () => {
    const site = `title: "Mine"
story_interface: {show_on_homepage: true, note: "nobody", code: "0x1", time: "1:75"}
`;
    expect(doc(rebuild(site).text).story_interface).toMatchObject({ note: "nobody", code: "0x1" });
  });
});

describe("rebuildConfigYaml — a block the Site settings clear", () => {
  it("lists the block's cleared child under from_settings", () => {
    const site = `title: "Mine"
glossary:
  kinds:
    - {id: place, label: Place, heading: Places}
story_interface: {show_on_homepage: true}
`;
    const { text, report } = rebuild(site, makeConfig({ glossary_kinds_json: "[]" }));
    expect(doc(text)).not.toHaveProperty("glossary");
    expect(report.fromSettings).toContain("glossary.kinds");
    expect(report.kept).not.toContain("glossary");
  });
});

describe("rebuildConfigYaml — comments on entries written from their values", () => {
  it("reports a trailing comment dropped from a regenerated block", () => {
    const site = `title: "Mine"
story_interface: {show_on_homepage: true} # Keep hidden until launch
`;
    const { text, report } = rebuild(site);
    expect(text).not.toContain("Keep hidden until launch");
    expect(report.commentsDropped).toBe(true);
  });

  // Quotes are not read: a # after whitespace inside one reports too.
  it("reports a # after whitespace inside a quoted value", () => {
    const site = `title: "Mine"
story_interface: {show_on_homepage: true, note: "top #1 priority"}
`;
    expect(rebuild(site).report.commentsDropped).toBe(true);
  });

  it("reports a trailing comment after a value holding an apostrophe", () => {
    const site = `title: "Mine"
story_interface: {show_on_homepage: true, note: author's choice} # Don't show before launch
`;
    const { text, report } = rebuild(site);
    expect(text).not.toContain("show before launch");
    expect(report.commentsDropped).toBe(true);
  });

  it("does not report a regenerated block with no # in it", () => {
    const site = `title: "Mine"
story_interface: {show_on_homepage: true, note: "plain"}
`;
    expect(rebuild(site).report.commentsDropped).toBe(false);
  });
});

describe("fetchConfigTemplate", () => {
  it("reads the template at the site's own release", async () => {
    fetchFrameworkFile.mockResolvedValueOnce({ kind: "found", content: TEMPLATE_TEXT });
    expect(await fetchConfigTemplate("tok", "1.8.2")).toEqual({ tag: "v1.8.2", text: TEMPLATE_TEXT });
    expect(fetchFrameworkFile).toHaveBeenCalledWith("tok", "_config.yml", "v1.8.2");
    expect(fetchLatestRelease).not.toHaveBeenCalled();
  });

  it("falls back to the latest release when the site's tag has no file", async () => {
    fetchFrameworkFile
      .mockResolvedValueOnce({ kind: "absent" })
      .mockResolvedValueOnce({ kind: "found", content: TEMPLATE_TEXT });
    fetchLatestRelease.mockResolvedValueOnce({ tagName: "v1.9.0" });
    expect(await fetchConfigTemplate("tok", "0.0.1", "v1.9.0")).toEqual({ tag: "v1.9.0", text: TEMPLATE_TEXT });
    expect(fetchLatestRelease).toHaveBeenCalledWith("tok", "v1.9.0");
  });

  it("falls back to the latest release when the site has no stored version", async () => {
    fetchFrameworkFile.mockResolvedValueOnce({ kind: "found", content: TEMPLATE_TEXT });
    fetchLatestRelease.mockResolvedValueOnce({ tagName: "v1.8.2" });
    expect(await fetchConfigTemplate("tok", null)).toEqual({ tag: "v1.8.2", text: TEMPLATE_TEXT });
  });

  it("answers null when no template can be read", async () => {
    fetchFrameworkFile.mockResolvedValueOnce({ kind: "failed" });
    expect(await fetchConfigTemplate("tok", "1.8.2")).toBeNull();
    fetchLatestRelease.mockRejectedValueOnce(new Error("rate limited"));
    expect(await fetchConfigTemplate("tok", null)).toBeNull();
  });
});

describe("prepareConfigRewrite", () => {
  it("fingerprints the rebuilt text itself", async () => {
    fetchFrameworkFile.mockResolvedValue({ kind: "found", content: TEMPLATE_TEXT });
    const site = `title: "Mine"\n`;
    const ready = await prepareConfigRewrite({ frameworkToken: "tok", site, config: makeConfig() });
    expect(ready.kind).toBe("ready");
    if (ready.kind !== "ready") return;
    expect(ready.fingerprint).toBe(await configRewriteFingerprint(ready.text));
    const other = await prepareConfigRewrite({ frameworkToken: "tok", site, config: makeConfig({ title: "Changed" }) });
    expect(other.kind === "ready" && other.fingerprint).not.toBe(ready.fingerprint);
  });

  it("offers no rewrite when the template cannot be read", async () => {
    fetchFrameworkFile.mockResolvedValue({ kind: "failed" });
    expect(await prepareConfigRewrite({ frameworkToken: "tok", site: "title: x\n", config: makeConfig() })).toEqual({
      kind: "template_unavailable",
    });
  });
});

describe("config_needs_rewrite — the blocker", () => {
  const config = makeConfig({ title: "A site", description: "New" });
  const codes = (configYml: string, configRewrite?: { acknowledged: string; fingerprint: string | null }) =>
    runPrePublishValidation({
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
      configRewrite,
    }).blockers.map((b) => b.code);

  const CAUSES: Array<[string, string]> = [
    ["a healed file that does not parse", 'title: "A site"\ndefaults:\n\tscope: all\n'],
    ["a managed block in a shape its writer cannot edit", 'title: "A site"\nstory_interface: {show_on_homepage: true}\n'],
    ["a value whose end cannot be read in a file that parses", 'description: "first\nnote: inside\nlast"\ncustom: keep\n'],
  ];

  it.each(CAUSES)("is raised once for %s", (_name, yaml) => {
    expect(codes(yaml)).toEqual(["config_needs_rewrite"]);
  });

  it("is dropped by an acknowledgement matching the rewrite rebuilt now", () => {
    for (const [, yaml] of CAUSES) {
      expect(codes(yaml, { acknowledged: "abc", fingerprint: "abc" })).toEqual([]);
    }
  });

  it("stands for an acknowledgement of a rewrite that is no longer the one rebuilt", () => {
    for (const [, yaml] of CAUSES) {
      expect(codes(yaml, { acknowledged: "abc", fingerprint: "def" })).toEqual(["config_needs_rewrite"]);
      expect(codes(yaml, { acknowledged: "abc", fingerprint: null })).toEqual(["config_needs_rewrite"]);
    }
  });

  it("is not raised for a file the writer can update", () => {
    expect(codes('title: "A site"\nstory_interface:\n  show_on_homepage: true\n')).toEqual([]);
  });
});

describe("the catalogues", () => {
  const NEW_CHECKS = ["config_needs_rewrite", "config_rewrite_review", "config_rewrite_ready"];
  const NEW_DIALOG = [
    "title", "preparing", "intro", "kept_one", "kept_other", "from_settings", "template_values",
    "removed", "comments_dropped", "history", "confirm", "template_unavailable", "failed", "stale",
  ];

  it("no longer carry the two codes the rewrite replaces", () => {
    for (const catalogue of [enPublish, esPublish]) {
      expect(Object.keys(catalogue.checks)).not.toContain("config_unparseable");
      expect(Object.keys(catalogue.checks)).not.toContain("config_block_unwritable");
    }
  });

  it("carry the rewrite's strings in both languages", () => {
    for (const catalogue of [enPublish, esPublish]) {
      for (const key of NEW_CHECKS) expect(catalogue.checks).toHaveProperty(key);
      expect(Object.keys(catalogue.config_rewrite).sort()).toEqual([...NEW_DIALOG].sort());
    }
  });
});
