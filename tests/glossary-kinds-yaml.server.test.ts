/**
 * The glossary kinds writer: what `_config.yml` text it produces for each
 * shape of `glossary:` it meets, and what it refuses.
 *
 * Every written case is held twice: byte for byte, and parsed back with
 * js-yaml to the list that went in. The exact texts are frozen because they
 * were also read by PyYAML, the parser the framework's `glossary_kinds.py`
 * runs on, in a one-off check (the framework's Python environment, PyYAML 6.0.3,
 * `yaml.safe_load(text)["glossary"]["kinds"]`): every text below gave the
 * same list as js-yaml, and the other children came back unchanged. A change
 * to any expected text needs that check run again.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { load as loadYaml } from "js-yaml";
import { parseStoredGlossaryKinds, writeGlossaryKinds } from "~/lib/glossary-kinds-yaml.server";
import { toSiteKind, type SiteKind } from "~/lib/glossary-kinds";

const KINDS: SiteKind[] = [
  { id: "place", label: "Place", heading: "Places", values: [] },
  { id: "event", label: "Event", heading: "Events", values: ["happening", "acontecimiento"] },
];

/** KINDS as the written file reads back: no `values` for a kind without any. */
const KINDS_READ = [{ id: "place", label: "Place", heading: "Places" }, KINDS[1]];

const KINDS_YAML = [
  "  kinds:",
  '    - id: "place"',
  '      label: "Place"',
  '      heading: "Places"',
  '    - id: "event"',
  '      label: "Event"',
  '      heading: "Events"',
  '      values: ["happening", "acontecimiento"]',
];

function written(yaml: string, kinds: SiteKind[] = KINDS): string {
  const out = writeGlossaryKinds(yaml, kinds);
  if (out === null) throw new Error("writer refused");
  return out;
}

function parsed(yaml: string): Record<string, unknown> {
  return loadYaml(yaml) as Record<string, unknown>;
}

/** The written kinds read back in their stored shape. */
function kindsOf(yaml: string): unknown {
  const kinds = (parsed(yaml).glossary as Record<string, unknown> | undefined)?.kinds;
  return Array.isArray(kinds) ? kinds.map(toSiteKind) : kinds;
}

describe("writeGlossaryKinds — where the list goes", () => {
  it("appends glossary: at the end when the file has none, leaving collections: glossary: alone", () => {
    const yaml = 'title: "Site"\ncollections:\n  glossary:\n    output: true\n';
    const out = written(yaml);
    expect(out).toBe(
      ['title: "Site"', "collections:", "  glossary:", "    output: true", "glossary:", ...KINDS_YAML, ""].join("\n"),
    );
    expect(kindsOf(out)).toEqual(KINDS);
    expect((parsed(out).collections as Record<string, unknown>).glossary).toEqual({ output: true });
  });

  it("inserts kinds: as the first child of a glossary: that has none", () => {
    const yaml = "glossary:\n  # a note\n  other_setting: true\ntitle: x\n";
    const out = written(yaml);
    expect(out).toBe(
      ["glossary:", ...KINDS_YAML, "  # a note", "  other_setting: true", "title: x", ""].join("\n"),
    );
    expect(parsed(out).glossary).toEqual({ kinds: KINDS_READ, other_setting: true });
  });

  it("replaces a block kinds: and keeps the other children and comments", () => {
    const yaml = [
      "glossary:",
      "  # our kinds",
      "  kinds:",
      "    - id: old",
      "      label: Old",
      "      heading: Olds",
      "  # after kinds",
      "  other_setting: true",
      "title: x",
      "",
    ].join("\n");
    const out = written(yaml);
    expect(out).toBe(
      ["glossary:", "  # our kinds", ...KINDS_YAML, "  # after kinds", "  other_setting: true", "title: x", ""].join(
        "\n",
      ),
    );
    expect(parsed(out).glossary).toEqual({ kinds: KINDS_READ, other_setting: true });
  });

  it("replaces a kinds: written as a sequence at its own indentation", () => {
    const yaml = "glossary:\n  kinds:\n  - id: old\n    label: Old\n    heading: Olds\n  other_setting: true\n";
    const out = written(yaml);
    expect(out).toBe(["glossary:", ...KINDS_YAML, "  other_setting: true", ""].join("\n"));
    expect(parsed(out).glossary).toEqual({ kinds: KINDS_READ, other_setting: true });
  });

  it("replaces a one-line flow kinds:", () => {
    const yaml = "glossary:\n  kinds: [{id: old, label: Old, heading: Olds}]\n  other_setting: true\n";
    const out = written(yaml);
    expect(out).toBe(["glossary:", ...KINDS_YAML, "  other_setting: true", ""].join("\n"));
    expect(parsed(out).glossary).toEqual({ kinds: KINDS_READ, other_setting: true });
  });

  it("replaces a flow kinds: spread over lines, its closing bracket at the key's indentation", () => {
    const yaml = "glossary:\n  other_setting: true\n  kinds: [\n    {id: old, label: Old, heading: Olds}\n  ]\nfoot: 1\n";
    const out = written(yaml);
    expect(out).toBe(["glossary:", "  other_setting: true", ...KINDS_YAML, "foot: 1", ""].join("\n"));
    expect(parsed(out)).toEqual({ glossary: { other_setting: true, kinds: KINDS_READ }, foot: 1 });
  });

  it("writes at the block's own child indentation", () => {
    const out = written("glossary:\n    other_setting: true\n", [KINDS[0]]);
    expect(out).toBe(
      ["glossary:", "    kinds:", '      - id: "place"', '        label: "Place"', '        heading: "Places"', "    other_setting: true", ""].join("\n"),
    );
    expect(parsed(out).glossary).toEqual({ kinds: [{ id: "place", label: "Place", heading: "Places" }], other_setting: true });
  });

  it("refuses a file with two glossary: blocks, where an edit to one leaves the other to be read", () => {
    const yaml = "glossary:\n  other_setting: false\ntitle: x\nglossary:\n  other_setting: true\n";
    expect(writeGlossaryKinds(yaml, [KINDS[0]])).toBeNull();
  });
});

describe("writeGlossaryKinds — an empty list", () => {
  it("removes kinds: and keeps a glossary: that has other children", () => {
    const yaml = "glossary:\n  kinds:\n    - id: old\n      label: Old\n      heading: Olds\n  other_setting: true\n";
    expect(written(yaml, [])).toBe("glossary:\n  other_setting: true\n");
  });

  it("removes glossary: too when kinds: was its only child, keeping comments", () => {
    const yaml = "title: x\nglossary:\n  # kept\n  kinds: [{id: old, label: Old, heading: Olds}]\nfoot: 1\n";
    const out = written(yaml, []);
    expect(out).toBe("title: x\n  # kept\nfoot: 1\n");
    expect(parsed(out)).toEqual({ title: "x", foot: 1 });
  });

  it("leaves a file with no glossary: exactly as it was", () => {
    const yaml = "title: x\n";
    expect(written(yaml, [])).toBe(yaml);
  });

  it("leaves a glossary: with no kinds: exactly as it was", () => {
    const yaml = "glossary:\n  other_setting: true\n";
    expect(written(yaml, [])).toBe(yaml);
  });
});

describe("writeGlossaryKinds — shapes it refuses", () => {
  const REFUSED: Array<[string, string]> = [
    ["a flow mapping", "glossary: {kinds: []}\n"],
    ["a scalar", "glossary: none\n"],
    ["an anchor", "glossary: &g\n  kinds: []\n"],
    ["an alias", "base: &b\n  kinds: []\nglossary: *b\n"],
    ["a merge key", "base: &b\n  kinds: []\nglossary:\n  <<: *b\n"],
    ["an anchored kinds:", "glossary:\n  kinds: &k []\nother: *k\n"],
  ];
  for (const [name, yaml] of REFUSED) {
    it(`refuses a glossary: holding ${name}`, () => {
      expect(writeGlossaryKinds(yaml, KINDS)).toBeNull();
    });
  }
});

describe("writeGlossaryKinds — text", () => {
  it("keeps CRLF line endings", () => {
    const yaml = "title: x\r\nglossary:\r\n  other_setting: true\r\n";
    const out = written(yaml, [KINDS[0]]);
    expect(out).toBe(
      'title: x\r\nglossary:\r\n  kinds:\r\n    - id: "place"\r\n      label: "Place"\r\n      heading: "Places"\r\n  other_setting: true\r\n',
    );
    expect(out.replace(/\r\n/g, "")).not.toMatch(/\n/);
  });

  it("quotes every string so YAML reads it back as the same text", () => {
    const awkward: SiteKind[] = [
      { id: "yes", label: 'Lugar: "#1"', heading: "Lugares\\todos", values: ["true", "1", "a, b", "[x]", "Bogotá"] },
    ];
    const out = written("title: x\n", awkward);
    expect(out).toBe(
      [
        "title: x",
        "glossary:",
        "  kinds:",
        '    - id: "yes"',
        '      label: "Lugar: \\"#1\\""',
        '      heading: "Lugares\\\\todos"',
        '      values: ["true", "1", "a, b", "[x]", "Bogotá"]',
        "",
      ].join("\n"),
    );
    expect(kindsOf(out)).toEqual(awkward);
  });
});

describe("parseStoredGlossaryKinds", () => {
  it("is null for a column that holds no list", () => {
    expect(parseStoredGlossaryKinds(null)).toBeNull();
    expect(parseStoredGlossaryKinds("not json")).toBeNull();
    expect(parseStoredGlossaryKinds('{"id":"x"}')).toBeNull();
  });

  it("trims the text fields and gives every kind its values", () => {
    expect(
      parseStoredGlossaryKinds(JSON.stringify([{ id: " place ", label: "Place ", heading: " Places" }])),
    ).toEqual([{ id: "place", label: "Place", heading: "Places", values: [] }]);
  });

  it("keeps an empty list, which removes the kinds", () => {
    expect(parseStoredGlossaryKinds("[]")).toEqual([]);
  });
});
