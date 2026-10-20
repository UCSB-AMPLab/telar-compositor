/**
 * A `_config.yml` value may run on below its key and still be valid YAML: a
 * plain or quoted scalar folded over indented lines, as YAML dumpers write any
 * long value, or a `|` or `>` block scalar. The publish writes Site settings
 * into the file one key line at a time, so it has to replace the lines below
 * the key as well. Left in place, they sit under the new one-line value, the
 * result does not parse, and the publish check reports the site's own valid
 * file as broken.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect } from "vitest";
import { load as loadYaml } from "js-yaml";

import {
  publishableConfigYaml,
  runPrePublishValidation,
  UnreadableConfigValueError,
  updateConfigFields,
} from "~/lib/publish.server";
import { project_config } from "~/db/schema";

type ProjectConfigRow = typeof project_config.$inferSelect;

const DESCRIPTION =
  "Telar is a static site generator built on Jekyll that weaves together IIIF images, text, and layered contextual information into interactive digital narrative exhibitions.";
const AUTHOR = "Juan Cobo Betancourt, Ana María Cárdenas Gasca, Adelaida Ávila, O'Brien";

function makeConfig(overrides: Partial<ProjectConfigRow> = {}): ProjectConfigRow {
  return {
    id: 1,
    project_id: 1,
    title: "Telar",
    lang: "en",
    baseurl: "",
    url: "https://example.org",
    telar_version: null,
    theme: null,
    description: DESCRIPTION,
    author: AUTHOR,
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
    featured_count: 4,
    answer_word_limit: null,
    story_key: null,
    ...overrides,
  } as ProjectConfigRow;
}

const CONFIG = makeConfig();

/** Long values folded over indented lines, as PyYAML's dump writes them. */
const FOLDED_PLAIN = `# Site Settings
title: Telar
description: Telar is a static site generator built on Jekyll that weaves together
  IIIF images, text, and layered contextual information into interactive digital narrative
  exhibitions.
url: https://example.org
baseurl: ""
author: Juan Cobo Betancourt, Ana María Cárdenas Gasca, Adelaida Ávila,
  O'Brien
telar_language: en # Options: "en" (English), "es" (Español)
`;

const FOLDED_SINGLE_QUOTED = `title: 'Telar'
description: 'Telar is a static site generator built on Jekyll that weaves
  together IIIF images, text, and layered contextual information.'
url: https://example.org
`;

const BLOCK_SCALARS = `title: Telar
description: |
  Telar is a static site generator.

  # This line is text inside the block, not a comment.
  It weaves together IIIF images.
author: >-
  Juan Cobo Betancourt,
  Ana María Cárdenas Gasca
url: https://example.org
`;

/** One-line values, with an indented comment and a blank line after them. */
const ONE_LINE_WITH_COMMENT = `title: Telar
description: A description
  # kept: a comment under a one-line value

url: https://example.org
`;

function parsed(yaml: string | null): Record<string, unknown> {
  expect(yaml).not.toBeNull();
  return loadYaml(yaml!, { json: true }) as Record<string, unknown>;
}

function blockerCodes(yaml: string): string[] {
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
    config: CONFIG,
  }).blockers.map((b) => b.code);
}

describe("a value that runs on below its key", () => {
  it("each fixture is valid YAML before the publish touches it", () => {
    for (const yaml of [FOLDED_PLAIN, FOLDED_SINGLE_QUOTED, BLOCK_SCALARS, ONE_LINE_WITH_COMMENT]) {
      expect(() => loadYaml(yaml)).not.toThrow();
    }
  });

  it("replaces a folded plain value whole, so the file still parses", () => {
    const out = publishableConfigYaml(FOLDED_PLAIN, CONFIG);
    const doc = parsed(out);
    expect(doc.description).toBe(DESCRIPTION);
    expect(doc.author).toBe(AUTHOR);
    expect(doc.url).toBe("https://example.org");
    expect(doc.telar_language).toBe("en");
    expect(out).not.toMatch(/^ {2}(IIIF|exhibitions|O'Brien)/m);
    expect(out).toContain("# Site Settings");
  });

  it("raises no config_needs_rewrite for a valid file with folded values", () => {
    expect(blockerCodes(FOLDED_PLAIN)).not.toContain("config_needs_rewrite");
  });

  it("replaces a folded single-quoted value whole", () => {
    const doc = parsed(publishableConfigYaml(FOLDED_SINGLE_QUOTED, CONFIG));
    expect(doc.description).toBe(DESCRIPTION);
    expect(doc.url).toBe("https://example.org");
  });

  it("replaces block scalars whole, including blank lines and # lines inside them", () => {
    const doc = parsed(publishableConfigYaml(BLOCK_SCALARS, CONFIG));
    expect(doc.description).toBe(DESCRIPTION);
    expect(doc.author).toBe(AUTHOR);
    expect(doc.url).toBe("https://example.org");
  });

  it("keeps an indented comment and a blank line that follow a one-line value", () => {
    const out = updateConfigFields(ONE_LINE_WITH_COMMENT, { description: '"New"' });
    expect(out).toBe(`title: Telar
description: "New"
  # kept: a comment under a one-line value

url: https://example.org
`);
  });
});

/**
 * Where each kind of value ends, as the writer reads it: every case's input
 * is valid YAML, the value's own lines go, and what follows it stays.
 */
const ENDS: Array<[name: string, input: string, expected: string]> = [
  [
    "a single-quoted value with a # line inside it",
    "description: 'first\n  # text\n  last'\nurl: keep\n",
    'description: "New"\nurl: keep\n',
  ],
  [
    "a block scalar with an indentation indicator, then a comment outside it",
    "description: |2-\n  old\n # keep comment\nurl: keep\n",
    'description: "New"\n # keep comment\nurl: keep\n',
  ],
  [
    "a nested mapping split by a comment at column 0",
    "description:\n  nested: old\n# inside\n  another: old\n# after\nurl: keep\n",
    'description: "New"\n# after\nurl: keep\n',
  ],
  [
    "a list written without indentation",
    "description:\n- old\n- second\nurl: keep\n",
    'description: "New"\nurl: keep\n',
  ],
  [
    "a tagged block scalar holding a # line",
    "description: !!str |\n  old\n  # text\n  more\nurl: keep\n",
    'description: "New"\nurl: keep\n',
  ],
  [
    "a plain value folded over lines, then blank lines and a comment",
    "description: first\n  second\n\n# keep\nurl: keep\n",
    'description: "New"\n\n# keep\nurl: keep\n',
  ],
  [
    "a flow list over several lines",
    "description: [\n  old,\n  second\n]\nurl: keep\n",
    'description: "New"\nurl: keep\n',
  ],
  [
    "a list without indentation, in CRLF lines",
    "description:\r\n- old\r\n- second\r\nurl: keep\r\n",
    'description: "New"\nurl: keep\r\n',
  ],
  [
    "a quoted value that starts below its key and runs on to column 0",
    'description:\n  "first\nlast"\nurl: keep\n',
    'description: "New"\nurl: keep\n',
  ],
  [
    "an anchored list without indentation",
    "description: &desc\n- old\n- second\nurl: keep\n",
    'description: "New"\nurl: keep\n',
  ],
  [
    "a block scalar whose first line opens with a tab",
    "description: |\n  \told\n  next\nurl: keep\n",
    'description: "New"\nurl: keep\n',
  ],
  [
    "a value followed by a quoted key",
    'description: old\n"custom": keep\nurl: keep\n',
    'description: "New"\n"custom": keep\nurl: keep\n',
  ],
  [
    "a value followed by a key with a space before its colon",
    "description: old\ncustom : keep\nurl: keep\n",
    'description: "New"\ncustom : keep\nurl: keep\n',
  ],
  [
    "a value followed by an explicit key",
    "description: old\n? custom\n: keep\nurl: keep\n",
    'description: "New"\n? custom\n: keep\nurl: keep\n',
  ],
  [
    "a block scalar whose last line begins with #, which stays as a comment",
    "description: |\n  old\n  # text\nurl: keep\n",
    'description: "New"\n  # text\nurl: keep\n',
  ],
  [
    "a value in CRLF lines",
    "description: first\r\n  second\r\nurl: keep\r\n",
    'description: "New"\nurl: keep\r\n',
  ],
];

describe("where a value ends", () => {
  it("each input is valid YAML", () => {
    for (const [name, input] of ENDS) {
      expect({ name, parses: (() => { try { loadYaml(input); return true; } catch { return false; } })() })
        .toEqual({ name, parses: true });
    }
  });

  it("replaces the value's lines and keeps what follows", () => {
    for (const [name, input, expected] of ENDS) {
      expect({ name, out: updateConfigFields(input, { description: '"New"' }) }).toEqual({
        name,
        out: expected,
      });
    }
  });

  it("replaces a story_key whose quoted value runs on to a line at column 0", () => {
    const input = 'story_key: "first\nsecond"\nurl: keep\n';
    expect(() => loadYaml(input)).not.toThrow();
    expect(updateConfigFields(input, { story_key: '"New"' })).toBe('story_key: "New"\nurl: keep\n');
  });

  // A file that parses is never swept: the sweep would take the key-shaped
  // line with the value, so the write is refused and the rewrite offered.
  it("refuses a quoted value holding a key-shaped line rather than sweeping it", () => {
    const input = 'custom: .nan\ndescription: "first\ncustom: null # last"\n';
    expect(() => loadYaml(input)).not.toThrow();
    expect(() => updateConfigFields(input, { description: '"New"' })).toThrow(UnreadableConfigValueError);
    expect(blockerCodes(input)).toContain("config_needs_rewrite");
  });

  it("replaces a quoted value that runs on when it is the file's only key", () => {
    const input = 'description: "first\nsecond"\n';
    expect(updateConfigFields(input, { description: '"New"' })).toBe('description: "New"\n');
  });

  // An anchored value is not complete on its key line, and a file that repeats
  // a key has no exact reading, so its end is unknown and nothing is removed.
  it("removes no other line from a file that repeats a key: it refuses the anchored value", () => {
    const input = "description: &d old\ncustom: *d\ncustom: keep\n";
    expect(() => updateConfigFields(input, { description: '"New"' })).toThrow(UnreadableConfigValueError);
  });

  it("compares a value that holds itself through an alias", () => {
    const input = "description: old\ncustom: &c [*c]\n";
    expect(updateConfigFields(input, { description: '"New"' })).toBe('description: "New"\ncustom: &c [*c]\n');
  });

  it("removes no line that could open a top-level entry, and refuses the write instead", () => {
    const cases = [
      'description: "first\nurl: inside\nlast"\nbaseurl: keep\n',
      "description: {\ncustom: old\n}\nurl: keep\n",
      "description: &d\n  custom: keep\n# Preserve this comment\n<<: *d\ncustom: keep\n",
      'seed: &d {"-custom": old}\n<<: *d\ndescription: &s old\n-custom: *s\nurl: keep\n',
      'seed: &d {"\u00a0custom": old}\n!!merge <<: *d\ndescription: &s old\n\u00a0custom: *s\nurl: keep\n',
      'seed: &d {custom: old}\r\n!!merge "<<": *d\r\ndescription: &s old\r\n?\r\n  custom\r\n:\r\n  *s\r\nurl: keep\r\n',
      "description: old\n? {\ndescription: [\n  old\n],\n  custom: keep\n}\n: value\n",
      '{\nseed: &d {custom: keep},\n!!merge "\\x3c\\x3c":*d,\ndescription: old,\n"custom":keep\n}\n',
    ];
    for (const input of cases) {
      expect(() => loadYaml(input)).not.toThrow();
      let out: string;
      try {
        out = updateConfigFields(input, { description: '"New"' });
      } catch (err) {
        expect(err).toBeInstanceOf(UnreadableConfigValueError);
        expect(blockerCodes(input)).toContain("config_needs_rewrite");
        continue;
      }
      const kept = input
        .split("\n")
        .filter((l) => !l.startsWith("description:") && /^([?:]|[^ \t#].*?:)([ \t\r]|$)|^"custom":keep$/.test(l));
      for (const line of kept) expect({ input, has: out.split("\n").includes(line) }).toEqual({ input, has: true });
      expect(publishableConfigYaml(input, CONFIG)).toBeNull();
      expect(blockerCodes(input)).toContain("config_needs_rewrite");
    }
  });
});

/**
 * In a file that parses, the unclosed-quote sweep never runs: a value whose
 * end cannot be read is refused, and the publish check offers the rewrite.
 * The sweep is kept for files that do not parse, where it repairs what an
 * older serializer left.
 */
describe("updateConfigFields — refusing instead of sweeping", () => {
  it("throws on bug report #68's eleventh-round input instead of sweeping an unrelated entry", () => {
    const input = 'description: "first\nnote: inside\nlast"\ncustom: keep\nurl: keep\n';
    expect(() => loadYaml(input)).not.toThrow();
    expect(() => updateConfigFields(input, { description: '"New"' })).toThrow(UnreadableConfigValueError);
  });

  it("throws on a folded quoted value in a file that repeats a key", () => {
    const input = 'description: "first\n  second"\ncustom: a\ncustom: b\n';
    expect(() => loadYaml(input, { json: true })).not.toThrow();
    expect(() => updateConfigFields(input, { description: '"New"' })).toThrow(UnreadableConfigValueError);
  });

  it("still replaces a single-line value in a file that repeats a key", () => {
    const input = "description: old # note\ncustom: a\ncustom: b\n";
    expect(updateConfigFields(input, { description: '"New"' })).toBe('description: "New"\ncustom: a\ncustom: b\n');
  });

  it("still sweeps an unclosed quote in a file that does not parse", () => {
    const input = 'title: "A site"\ndescription: "A description\nthat ran on\n\npast its quote\nurl: https://example.org\n';
    expect(() => loadYaml(input)).toThrow();
    expect(updateConfigFields(input, { description: '"New"' })).toBe(
      'title: "A site"\ndescription: "New"\nurl: https://example.org\n',
    );
  });
});
