/**
 * This file pins what the config writer does with a managed block it cannot
 * edit, and what the publish check says about one.
 *
 * The writer works line by line: it finds a top-level `key:` header and
 * rewrites the indented lines under it. That is the only shape it understands.
 * A flow mapping, an anchor, an alias, a tag, a sequence or a plain scalar is
 * valid YAML the line writer cannot take apart, and every attempt to take one
 * apart anyway has lost an unmanaged key, changed a number into a string, or
 * written a value the site then reads from somewhere else.
 *
 * The header line does not settle this. `story_interface:` followed by a flow
 * mapping or a sequence on the NEXT line is exactly as unwritable as one with
 * the braces after the colon, and appending a child under it produces a file
 * no parser accepts. So the judgement is on the block's VALUE: the first line
 * inside it that carries one must be a deeper `key:` entry, or there must be
 * none at all.
 *
 * So the writer does not try. It refuses, loudly — a publish that cannot write
 * a managed block must fail rather than ship a file whose settings silently
 * disagree with the Compositor's — and the publish check reports a blocker
 * naming the block before a publish is ever started.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";

import {
  MANAGED_BLOCK_FIELDS,
  MANAGED_CONFIG_BLOCKS,
  buildConfigManagedBlocks,
  runPrePublishValidation,
  unwritableConfigBlocks,
  updateConfigBlocks,
} from "~/lib/publish.server";

const MANAGED = { story_interface: { show_on_homepage: "true" } };

/** The shapes the writer refuses, each with the finding that named it. */
const UNWRITABLE: Array<[name: string, yaml: string]> = [
  [
    "a flow mapping with a quoted key",
    'story_interface: {show_on_homepage: false, "keep_me": 7}\n',
  ],
  [
    "a flow mapping spanning two lines",
    "story_interface: {show_on_homepage: false,\n  keep_me: 7}\n",
  ],
  [
    "a flow mapping holding an escaped quote",
    'story_interface: {keep_me: "a\\", b", show_on_homepage: false}\n',
  ],
  [
    "a flow mapping followed by a comment holding a brace",
    "story_interface: {show_on_homepage: false, keep_me: 7} # }\n",
  ],
  ["an alias", "defaults: &d {show_on_homepage: false}\nstory_interface: *d\n"],
  ["an anchor on the header", "story_interface: &d\n  show_on_homepage: false\n"],
  ["a tag on the header", "story_interface: !!map\n  show_on_homepage: false\n"],
  // The header says nothing about the value. Each of these is a bare header
  // whose value, on the line below it, is not a block mapping — and a child
  // appended under any of them is a file no parser accepts.
  ["a flow mapping under a bare header", "story_interface:\n  {show_on_homepage: false}\n"],
  ["a sequence in flow style under a bare header", "story_interface:\n  [1, 2]\n"],
  ["a sequence in block style under a bare header", "story_interface:\n  - one\n  - two\n"],
  ["an alias under a bare header", "defaults: &d\n  a: 1\nstory_interface:\n  *d\n"],
  ["a plain scalar under a bare header", "story_interface:\n  some text\n"],
  // A managed child's own value has to be a plain scalar on its key's line.
  // Every other shape a value can take is one this line writer would have to
  // take apart, and each attempt at that has published a file whose value was
  // not the number stored: a block scalar folded into "100 50", an indentless
  // sequence left standing so the file no longer parsed and the block writes
  // were dropped in silence, a comment after the colon glued to the new value
  // as "75# keep".
  [
    "a block scalar under a managed child",
    "story_interface:\n  show_on_homepage: |\n    true\n",
  ],
  [
    "a folded scalar under a managed child",
    "story_interface:\n  show_on_homepage: >\n    true\n",
  ],
  [
    "a nested mapping under a managed child",
    "story_interface:\n  show_on_homepage:\n    weekdays: true\n",
  ],
  [
    "a sequence at the managed child's own indentation",
    "story_interface:\n  show_on_homepage:\n  - true\n",
  ],
  [
    "a comment after the colon with the value on the next line",
    "story_interface:\n  show_on_homepage: # keep\n    true\n",
  ],
  ["a flow collection as a managed child's value", "story_interface:\n  show_on_homepage: [1]\n"],
  ["a tag on a managed child's value", "story_interface:\n  show_on_homepage: !!bool true\n"],
  ["an anchor on a managed child's value", "story_interface:\n  show_on_homepage: &d true\n"],
  [
    "an alias as a managed child's value",
    "defaults: &d true\nstory_interface:\n  show_on_homepage: *d\n",
  ],
  // A value the reader cannot take apart with confidence is a value it does
  // not take apart. A `#` with no space before it is part of the scalar, not a
  // comment, and rewriting around it published `75#c` — a string. Quotes carry
  // the same problem twice over: a `#` inside them is not a comment, and the
  // scalar may not even end on its line.
  ["a hash inside a managed child's value", "story_interface:\n  show_on_homepage: a#c\n"],
  [
    "a quoted value beside a real comment",
    'story_interface:\n  show_on_homepage: "a#b" # real\n',
  ],
  [
    "a quoted value holding what looks like a comment",
    'story_interface:\n  show_on_homepage: "a # not a comment"\n',
  ],
  [
    "a quoted value running onto the next line",
    'story_interface:\n  show_on_homepage: "50\n  "\n',
  ],
  [
    "a single-quoted managed value",
    "story_interface:\n  show_on_homepage: 'true'\n",
  ],
  // Every line of the block is read now, so a key the reader does not
  // recognise can no longer sit unseen beside one it does — which is how a
  // quoted duplicate kept the value the site was reading.
  [
    "a quoted duplicate of a managed key",
    'story_interface:\n  show_on_homepage: false\n  "show_on_homepage": true\n',
  ],
  [
    "a key the reader does not recognise beside one it does",
    'story_interface:\n  show_on_homepage: false\n  "other key": 1\n',
  ],
  [
    "a complex key at the children's own indentation",
    "story_interface:\n  show_on_homepage: false\n  ? a\n  : b\n",
  ],
  // Neither indentation is the block's, so no reader agrees about this block —
  // js-yaml refuses the file outright.
  [
    "a duplicate at a shallower indentation than the first child",
    "story_interface:\n    show_on_homepage: false\n  show_on_homepage: true\n",
  ],
  // YAML forbids a tab in indentation outright, so a block indented with one
  // is a block no parser reads — and the writer, reusing the indentation it
  // found, would write the same unreadable line back.
  ["a tab in the children's indentation", "story_interface:\n\tshow_on_homepage: false\n"],
  [
    "a tab after the spaces a child is indented with",
    "story_interface:\n \tshow_on_homepage: false\n",
  ],
];

describe("a managed block the writer cannot edit", () => {
  // Round 5 had the writer leave the file as it found it. That is not enough on
  // its own: a publish then commits every other file and a _config.yml whose
  // managed settings disagree with D1, and nothing says so. The writer refuses
  // instead, and the publish fails.
  it.each(UNWRITABLE)("refuses to write %s rather than leaving it silently", (_name, yaml) => {
    expect(() => updateConfigBlocks(yaml, MANAGED)).toThrow(/story_interface/);
  });

  it.each(UNWRITABLE)("names %s as unwritable", (_name, yaml) => {
    expect(unwritableConfigBlocks(yaml, ["story_interface"])).toEqual(["story_interface"]);
  });

  it("names nothing in an ordinary block-style file", () => {
    const yaml = "story_interface:\n  show_on_homepage: false\n";

    expect(unwritableConfigBlocks(yaml, ["story_interface"])).toEqual([]);
    expect(updateConfigBlocks(yaml, MANAGED)).toContain("show_on_homepage: true");
  });

  // A merge key inside a block is not the writer's problem: the block is still
  // one key per line, and a direct child written beside `<<` shadows whatever
  // the merge brought in, which is the value the site then reads.
  it("writes a block-style block that merges another mapping into itself", () => {
    const yaml =
      "defaults: &d\n  show_on_homepage: false\nstory_interface:\n  <<: *d\n  other: 1\n";

    const out = updateConfigBlocks(yaml, MANAGED);

    expect(unwritableConfigBlocks(yaml, ["story_interface"])).toEqual([]);
    expect(out).toContain("  <<: *d");
    expect(out).toContain("show_on_homepage: true");
  });

  // An empty block has no value to be the wrong shape, and the writer's answer
  // to one is the same as its answer to a block that is not in the file at all:
  // it writes the children.
  it.each([
    ["at the end of the file", "title: A site\nstory_interface:\n"],
    ["before another top-level key", "story_interface:\ntitle: A site\n"],
    ["holding only a comment", "story_interface:\n  # nothing yet\ntitle: A site\n"],
  ])("writes a bare header with no children of its own, %s", (_name, yaml) => {
    expect(unwritableConfigBlocks(yaml, ["story_interface"])).toEqual([]);
    expect(updateConfigBlocks(yaml, MANAGED)).toContain("  show_on_homepage: true");
  });

  // The check reads a block the same way whether or not this publish writes
  // every key in it. A key whose column is null is not written — but it is in
  // the file, an author can see it, and the next save writes it, so a shape
  // the writer could not edit is reported now rather than at that save.
  it("names a managed key this publish would not write, whose shape it still cannot edit", () => {
    const yaml = "story_interface:\n  show_on_homepage: !!bool true\n";

    expect(unwritableConfigBlocks(yaml, ["story_interface"])).toEqual(["story_interface"]);
    expect(() =>
      updateConfigBlocks(yaml, { story_interface: { show_story_steps: "true" } }),
    ).toThrow(/story_interface/);
  });

  // An unmanaged key's value is never read: the writer copies its lines and
  // has no opinion about what they say.
  it("writes a managed child beside an unmanaged one whose value spans lines", () => {
    const yaml =
      'story_interface:\n  note: "line one\n    line two"\n  show_on_homepage: false\n';

    const out = updateConfigBlocks(yaml, MANAGED);

    expect(unwritableConfigBlocks(yaml, ["story_interface"])).toEqual([]);
    expect(out).toContain('  note: "line one');
    expect(out).toContain("    line two\"");
    expect(out).toContain("  show_on_homepage: true");
  });

  // A key is a key, not a property. Selecting the children to rewrite by
  // property lookup reached `Object.prototype`, so a child an author named
  // `constructor` was published as the constructor's own source text, and
  // `__proto__` as "[object Object]" — neither of them anything anybody wrote.
  it.each([["constructor"], ["__proto__"], ["toString"], ["hasOwnProperty"]])(
    "leaves an unmanaged child named %s exactly as it found it",
    (key) => {
      const yaml = `story_interface:\n  ${key}: untouched\n  show_on_homepage: false\n`;

      const out = updateConfigBlocks(yaml, MANAGED);

      expect(out).toContain(`  ${key}: untouched`);
      expect(out).toContain("  show_on_homepage: true");
    },
  );

  it("names only the managed blocks it was asked about", () => {
    const yaml = "other_block: {a: 1}\nstory_interface:\n  show_on_homepage: false\n";

    expect(unwritableConfigBlocks(yaml, ["story_interface"])).toEqual([]);
  });

  it("names the last occurrence's shape, which is the one the writer would edit", () => {
    const yaml = "story_interface:\n  show_on_homepage: false\nstory_interface: {a: 1}\n";

    expect(unwritableConfigBlocks(yaml, ["story_interface"])).toEqual(["story_interface"]);
  });
});

describe("what the publish check says about one", () => {
  const validate = (configYml: string | null) =>
    runPrePublishValidation({
      headSha: "sha",
      currentRepoHead: "sha",
      stories: [],
      steps: [],
      objects: [],
      pages: [],
      glossary: [],
      configYml,
    });

  it.each(UNWRITABLE)("blocks the publish for %s, naming the block", (_name, yaml) => {
    const blockers = validate(yaml).blockers.filter((b) => b.code === "config_block_unwritable");

    expect(blockers).toHaveLength(1);
    expect(blockers[0].params).toEqual({ block: "story_interface" });
    expect(blockers[0].entityId).toBe("story_interface");
  });

  it("blocks nothing for an ordinary block-style file", () => {
    const yaml = "story_interface:\n  show_on_homepage: false\n";

    expect(validate(yaml).blockers.map((b) => b.code)).not.toContain("config_block_unwritable");
  });

  it("names one blocker per unwritable block", () => {
    const yaml = "story_interface: {a: 1}\ncollection_interface: *d\n";

    const blocks = validate(yaml)
      .blockers.filter((b) => b.code === "config_block_unwritable")
      .map((b) => b.params?.block);

    expect(blocks).toEqual(["story_interface", "collection_interface"]);
  });

  // `story_content:` is nobody's managed block now. The publish leaves it
  // alone whatever shape it is in, so a shape the writer could not have
  // edited is no reason to refuse a publish that will not touch it.
  it("says nothing about a story_content block in any shape", () => {
    const yaml = "story_content: {answer_word_limit: 50}\n";

    expect(validate(yaml).blockers.map((b) => b.code)).not.toContain("config_block_unwritable");
  });

  // The check runs before a publish has a config row in hand, so it reads the
  // managed keys from a list of its own. A key the publish writes and this
  // list does not name would be written into a shape nothing judged.
  it("knows every key the publish writes into a managed block", () => {
    const everyColumnSet = {
      show_on_homepage: true,
      show_story_steps: true,
      show_object_credits: true,
      include_demo_content: true,
      browse_and_search: true,
      show_link_on_homepage: true,
      show_sample_on_homepage: true,
      featured_count: 4,
      skip_stories: true,
    } as unknown as Parameters<typeof buildConfigManagedBlocks>[0];

    const written = buildConfigManagedBlocks(everyColumnSet);

    expect(Object.keys(written).sort()).toEqual([...MANAGED_CONFIG_BLOCKS].sort());
    for (const [block, fields] of Object.entries(written)) {
      expect(Object.keys(fields).sort(), block).toEqual([...MANAGED_BLOCK_FIELDS[block]].sort());
    }
  });

  it("checks every block the publish writes", () => {
    expect([...MANAGED_CONFIG_BLOCKS]).toEqual([
      "story_interface",
      "collection_interface",
      "development-features",
    ]);
  });

  // A publish that cannot read the file has nothing to report about it, and
  // must not block on a file it never saw.
  it("blocks nothing when the caller could not read the file", () => {
    expect(validate(null).blockers.map((b) => b.code)).not.toContain("config_block_unwritable");
  });
});
