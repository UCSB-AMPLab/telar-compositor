/**
 * The manifest's `yaml_list_add`: every case in the framework's
 * `docs/migration-manifest.md`, the edit's own check, and the operation run
 * against the command-line route (`add_exclude_entries`, framework
 * `scripts/migrations/v180_sources.py`) on real `_config.yml` files. The
 * fixtures are described in `fixtures/upgrade-1.8.0/NOTES.md`.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { applyYamlListAdd, YamlListAddError } from "~/lib/yaml-list-add.server";
import { applyManifestChain } from "~/lib/manifest-runner.server";
import { validateManifest, type YamlListAddOp } from "~/lib/manifest-schema.server";
import { sameYamlValue } from "~/lib/yaml.server";

const FIXTURES = join(__dirname, "fixtures", "upgrade-1.8.0");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf-8");

/** The 1.8.0 manifest's operation, as the framework's generator writes it. */
const MANIFEST = validateManifest(JSON.parse(fixture("migration.json")));
const EXCLUDE_OP = MANIFEST.operations.find((op) => op.type === "yaml_list_add") as YamlListAddOp;
const VALUES = ["telar-content/texts/", "tests/", "pytest.ini", "vitest.config.js"];

function op(values: string[] = VALUES, key = "exclude"): YamlListAddOp {
  return { type: "yaml_list_add", file: "_config.yml", key, values };
}

/** The file after the operation, or the error it threw. */
function applyEdit(text: string | undefined, operation: YamlListAddOp = op()): string {
  const files = new Map<string, string>();
  if (text !== undefined) files.set("_config.yml", text);
  applyYamlListAdd(files, operation);
  return files.get("_config.yml")!;
}

function thrown(fn: () => unknown): YamlListAddError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(YamlListAddError);
    return err as YamlListAddError;
  }
  throw new Error("expected the operation to throw");
}

const parsed = (text: string) => load(text, { json: true }) as Record<string, unknown>;

describe("the 1.8.0 manifest's operation", () => {
  it("adds the four exclude entries to _config.yml, the hard one first", () => {
    expect(EXCLUDE_OP).toEqual({ type: "yaml_list_add", file: "_config.yml", key: "exclude", values: VALUES });
  });
});

describe("yaml_list_add — a block list", () => {
  it("appends each missing value after the last item, at the items' indentation, keeping what follows", () => {
    const before = "title: Site\nexclude:\n  - Gemfile\n  - scripts/\n\n# Defaults\ndefaults: []\n";
    expect(applyEdit(before)).toBe(
      "title: Site\nexclude:\n  - Gemfile\n  - scripts/\n" +
        "  - telar-content/texts/\n  - tests/\n  - pytest.ini\n  - vitest.config.js\n" +
        "\n# Defaults\ndefaults: []\n",
    );
  });

  it("keeps comments and blank lines between the items and after the last", () => {
    const before = "exclude:\n  # tooling\n  - Gemfile\n\n  - vendor # vendored gems\n  # end of list\nother: 1\n";
    expect(applyEdit(before, op(["tests/"]))).toBe(
      "exclude:\n  # tooling\n  - Gemfile\n\n  - vendor # vendored gems\n  - tests/\n  # end of list\nother: 1\n",
    );
  });

  it("follows the items' own indentation and dash spacing", () => {
    expect(applyEdit("exclude:\n    -   a\nother: 1\n", op(["b"]))).toBe("exclude:\n    -   a\n    -   b\nother: 1\n");
    expect(applyEdit("exclude:\n- a\nother: 1\n", op(["b"]))).toBe("exclude:\n- a\n- b\nother: 1\n");
  });

  it("appends after an item written over several lines", () => {
    expect(applyEdit("exclude:\n  - >-\n    folded\n    item\nother: 1\n", op(["b"]))).toBe(
      "exclude:\n  - >-\n    folded\n    item\n  - b\nother: 1\n",
    );
  });

  it("ends a last line that had no line ending before appending", () => {
    expect(applyEdit("exclude:\n  - a", op(["b"]))).toBe("exclude:\n  - a\n  - b\n");
  });

  it("writes CRLF lines into a CRLF file", () => {
    expect(applyEdit("exclude:\r\n  - a\r\nother: 1\r\n", op(["b"]))).toBe("exclude:\r\n  - a\r\n  - b\r\nother: 1\r\n");
  });

  it("adds only the values the list does not hold", () => {
    expect(applyEdit("exclude:\n  - tests\n  - pytest.ini\n")).toBe(
      "exclude:\n  - tests\n  - pytest.ini\n  - telar-content/texts/\n  - vitest.config.js\n",
    );
  });
});

describe("yaml_list_add — a flow list", () => {
  it("inserts the values before the closing bracket, comma-separated", () => {
    expect(applyEdit("exclude: [Gemfile, vendor] # tools\nother: 1\n")).toBe(
      "exclude: [Gemfile, vendor, telar-content/texts/, tests/, pytest.ini, vitest.config.js] # tools\nother: 1\n",
    );
  });

  it("fills an empty flow list", () => {
    expect(applyEdit("exclude: []\n", op(["a", "b"]))).toBe("exclude: [a, b]\n");
  });

  it("keeps a trailing comma's spacing, and a list written over several lines", () => {
    expect(applyEdit("exclude: [a,]\n", op(["b"]))).toBe("exclude: [a, b]\n");
    expect(applyEdit("exclude: [\n  a,\n  b\n]\n", op(["c"]))).toBe("exclude: [\n  a,\n  b, c\n]\n");
  });

  it("puts the values on a line before a `]` of its own when the last item ends in a comment", () => {
    expect(applyEdit("exclude: [\n  a,\n  b  # the last one\n]\nother: 1\n", op(["c", "d"]))).toBe(
      "exclude: [\n  a,\n  b,  # the last one\n  c, d\n]\nother: 1\n",
    );
    expect(applyEdit("exclude: [\r\n  a,  # first\r\n]\r\n", op(["b"]))).toBe("exclude: [\r\n  a,  # first\r\n  b\r\n]\r\n");
  });

  it("puts the values before the `]` after a comment line, and into an empty list with a comment", () => {
    expect(applyEdit("exclude: [\n  a,\n  # more to come\n]\n", op(["b"]))).toBe("exclude: [\n  a,\n  # more to come\n  b\n]\n");
    expect(applyEdit("exclude: [ # none yet\n]\n", op(["a"]))).toBe("exclude: [ # none yet\n  a\n]\n");
  });

  it("skips a comment holding a quote or a bracket when finding the closing `]`", () => {
    expect(applyEdit("exclude: [a, # don't ] stop\n  b]\n", op(["c"]))).toBe("exclude: [a, # don't ] stop\n  b, c]\n");
  });

  it("skips brackets inside quoted items", () => {
    expect(applyEdit('exclude: ["a]", \'[b\']\n', op(["c"]))).toBe('exclude: ["a]", \'[b\', c]\n');
  });
});

describe("yaml_list_add — the three edge cases", () => {
  it("fills a bare key followed by another key as a block list under its own line", () => {
    expect(applyEdit("exclude:\nother: 1\n", op(["a", "b"]))).toBe("exclude:\n  - a\n  - b\nother: 1\n");
  });

  it("fills a bare key with a comment on its line", () => {
    expect(applyEdit("exclude: # none yet\nother: 1\n", op(["a"]))).toBe("exclude: # none yet\n  - a\nother: 1\n");
  });

  it("fails on a mapping under the key, naming the file, the key and the values it had to add", () => {
    const err = thrown(() => applyEdit("exclude:\n  a: 1\nother: 1\n", op(["b", "c"])));
    expect(err.file).toBe("_config.yml");
    expect(err.key).toBe("exclude");
    expect(err.values).toEqual(["b", "c"]);
  });

  it("fails on a flow mapping under the key", () => {
    expect(thrown(() => applyEdit("exclude: {a: 1}\n", op(["b"]))).values).toEqual(["b"]);
  });

  it("fails on a file that does not parse, and on one that is not a mapping", () => {
    expect(thrown(() => applyEdit("exclude: [a\n", op(["b"]))).values).toEqual(["b"]);
    expect(thrown(() => applyEdit("- a\n- b\n", op(["c"]))).values).toEqual(["c"]);
  });

  it("fails on a file the chain does not hold", () => {
    expect(thrown(() => applyEdit(undefined, op(["a"]))).file).toBe("_config.yml");
  });
});

describe("yaml_list_add — a single value under the key", () => {
  it("rewrites a plain scalar as the first item of a block list, the values after it", () => {
    expect(applyEdit("title: Site\nexclude: vendor\nother: 1\n", op(["a", "b"]))).toBe(
      "title: Site\nexclude:\n  - vendor\n  - a\n  - b\nother: 1\n",
    );
  });

  it("keeps a quoted scalar's text as the item", () => {
    expect(applyEdit('exclude: "vendor # not a comment"\nother: 1\n', op(["a"]))).toBe(
      'exclude:\n  - "vendor # not a comment"\n  - a\nother: 1\n',
    );
    expect(applyEdit("exclude: 'it''s here' # note\n", op(["a"]))).toBe("exclude: # note\n  - 'it''s here'\n  - a\n");
  });

  it("keeps a trailing comment on the key line", () => {
    expect(applyEdit("exclude: vendor   # third-party gems\nother: 1\n", op(["a"]))).toBe(
      "exclude: # third-party gems\n  - vendor\n  - a\nother: 1\n",
    );
    expect(applyEdit('exclude: "a b" #c\n', op(["d"]))).toBe('exclude: #c\n  - "a b"\n  - d\n');
  });

  it("does not add a value the scalar already is, with or without its trailing slash", () => {
    expect(applyEdit("exclude: tests/\n", op(["tests/", "pytest.ini"]))).toBe("exclude:\n  - tests/\n  - pytest.ini\n");
    expect(applyEdit("exclude: tests\n", op(["tests/", "pytest.ini"]))).toBe("exclude:\n  - tests\n  - pytest.ini\n");
  });

  it("rewrites a single value as a list even when it already is every value to add", () => {
    expect(applyEdit("exclude: tests # ours\nother: 1\n", op(["tests/"]))).toBe("exclude: # ours\n  - tests\nother: 1\n");
    expect(parsed(applyEdit("exclude: pytest.ini\n", op(["pytest.ini"]))).exclude).toEqual(["pytest.ini"]);
  });

  it("uses the file's line endings and ends a last line that had none", () => {
    expect(applyEdit("exclude: vendor\r\nother: 1\r\n", op(["a"]))).toBe("exclude:\r\n  - vendor\r\n  - a\r\nother: 1\r\n");
    expect(applyEdit("exclude: vendor", op(["a"]))).toBe("exclude:\n  - vendor\n  - a\n");
  });

  it("leaves an indented comment after the scalar in place", () => {
    expect(applyEdit("exclude: vendor\n  # gems\nother: 1\n", op(["a"]))).toBe(
      "exclude:\n  - vendor\n  - a\n  # gems\nother: 1\n",
    );
  });

  it("writes a scalar continued onto further lines as one double-quoted item", () => {
    expect(applyEdit("exclude: | # kept\n  vendor\n  gems\n\nother: 1\n", op(["a"]))).toBe(
      'exclude: # kept\n  - "vendor\\ngems\\n"\n  - a\n\nother: 1\n',
    );
    expect(applyEdit("exclude: vendor\n  gems\nother: 1\n", op(["a"]))).toBe('exclude:\n  - "vendor gems"\n  - a\nother: 1\n');
  });

  it("keeps a comment under a scalar continued onto further lines", () => {
    expect(applyEdit("exclude: vendor\n  gems\n  # the gems we vendor\nother: 1\n", op(["a"]))).toBe(
      'exclude:\n  - "vendor gems"\n  - a\n  # the gems we vendor\nother: 1\n',
    );
  });

  it("keeps a scalar that is not a string as the value it parses to", () => {
    const out = applyEdit("exclude: 42\n", op(["a"]));
    expect(out).toBe("exclude:\n  - 42\n  - a\n");
    expect(parsed(out).exclude).toEqual([42, "a"]);
  });

  it("is idempotent once rewritten", () => {
    const once = applyEdit("exclude: vendor # c\n");
    expect(applyEdit(once)).toBe(once);
  });
});

describe("yaml_list_add — a null written out", () => {
  it("fills `~`, `null` and `NULL` as a bare key, dropping the token and keeping a comment", () => {
    expect(applyEdit("exclude: ~\nother: 1\n", op(["a"]))).toBe("exclude:\n  - a\nother: 1\n");
    expect(applyEdit("exclude: null # none yet\r\nother: 1\r\n", op(["a", "b"]))).toBe(
      "exclude: # none yet\r\n  - a\r\n  - b\r\nother: 1\r\n",
    );
    expect(applyEdit("exclude: NULL", op(["a"]))).toBe("exclude:\n  - a\n");
  });

  it("refuses a tagged null, as a shape the edit does not make", () => {
    expect(thrown(() => applyEdit('exclude: !!null ""\n', op(["a"]))).kind).toBe("other");
  });
});

describe("yaml_list_add — why an edit is refused", () => {
  it("names a mapping under the key, block or flow, as a mapping", () => {
    expect(thrown(() => applyEdit("exclude:\n  a: 1\n", op(["b"]))).kind).toBe("mapping");
    expect(thrown(() => applyEdit("exclude: {a: 1}\n", op(["b"]))).kind).toBe("mapping");
  });

  it("names every other refusal as other", () => {
    const cases: Array<[string, string | undefined]> = [
      ["an absent file", undefined],
      ["a file that does not parse", "exclude: [a\n"],
      ["a file that is not a mapping", "- a\n"],
      ["an anchor on the key's list", "exclude: &x [a]\nother: *x\n"],
      ["a tag on the key's list", "exclude: !!seq [a]\n"],
    ];
    for (const [, text] of cases) {
      expect(thrown(() => applyEdit(text, op(["b"]))).kind).toBe("other");
    }
    expect(thrown(() => applyEdit("exclude:\n  - a\n", op(["b: c"]))).kind).toBe("other");
  });
});

describe("yaml_list_add — an absent key", () => {
  it("is added at the end of the file as a block list, after a blank line", () => {
    expect(applyEdit("title: Site\n", op(["a", "b"]))).toBe("title: Site\n\nexclude:\n  - a\n  - b\n");
  });

  it("ends a last line with no line ending, and uses the file's CRLF", () => {
    expect(applyEdit("title: Site", op(["a"]))).toBe("title: Site\n\nexclude:\n  - a\n");
    expect(applyEdit("title: Site\r\n", op(["a"]))).toBe("title: Site\r\n\r\nexclude:\r\n  - a\r\n");
  });

  it("is written into a file of only comments", () => {
    expect(applyEdit("# nothing yet\n", op(["a"]))).toBe("# nothing yet\n\nexclude:\n  - a\n");
  });
});

describe("yaml_list_add — presence", () => {
  it("counts the same string after parsing, with one trailing slash dropped from either side", () => {
    const before = "exclude:\n  - tests\n  - \"telar-content/texts\"\n  - 'pytest.ini'\n  - vitest.config.js/\n";
    expect(applyEdit(before)).toBe(before);
  });

  it("does not count a trailing space inside quotes, a doubled slash or another case", () => {
    const before = 'exclude:\n  - "tests/ "\n  - tests//\n  - Tests/\n';
    expect(applyEdit(before, op(["tests/"]))).toBe(`${before}  - tests/\n`);
  });

  it("does not count a value written elsewhere in the file", () => {
    expect(applyEdit("title: tests/\nexclude:\n  - a\n", op(["tests/"]))).toBe("title: tests/\nexclude:\n  - a\n  - tests/\n");
  });
});

describe("yaml_list_add — the edit's check", () => {
  it("refuses a value that would not parse back as itself", () => {
    const before = "exclude:\n  - a\n";
    const err = thrown(() => applyEdit(before, op(["b: c"])));
    expect(err.values).toEqual(["b: c"]);
    expect(thrown(() => applyEdit("exclude: [a]\n", op(["b]"]))).values).toEqual(["b]"]);
  });

  it("refuses a shape the edit does not make: an anchored list", () => {
    expect(thrown(() => applyEdit("exclude: &x [a]\nother: *x\n", op(["b"]))).values).toEqual(["b"]);
  });

  it("edits the last of two duplicate keys, the one the file's value comes from", () => {
    expect(applyEdit("exclude: [a]\nexclude:\n  - b\n", op(["c"]))).toBe("exclude: [a]\nexclude:\n  - b\n  - c\n");
  });

  it("is idempotent: a second run changes nothing", () => {
    for (const before of ["exclude:\n  - a\n", "exclude: [a]\n", "title: x\n", "exclude:\nother: 1\n"]) {
      const once = applyEdit(before);
      expect(applyEdit(once)).toBe(once);
    }
  });
});

describe("yaml_list_add — against the command-line route on real configurations", () => {
  const CASES = [
    { name: "the 1.7.0 template", input: "config-v1.7.0.yml", cli: "config-v1.7.0.cli.yml", lastItem: "  - scripts/\n" },
    { name: "the 1.7.0 template in Spanish", input: "config-v1.7.0-es.yml", cli: "config-v1.7.0-es.cli.yml", lastItem: "  - scripts/\n" },
    { name: "the demo content", input: "config-demo-content.yml", cli: "config-demo-content.cli.yml", lastItem: "  - LICENSE\n" },
  ];

  for (const { name, input, cli, lastItem } of CASES) {
    describe(name, () => {
      const before = fixture(input);
      const after = applyEdit(before, EXCLUDE_OP);
      const byCli = fixture(cli);

      it("holds the same exclude entries as the command-line route, each route in its own order", () => {
        const ours = parsed(after).exclude as string[];
        const theirs = parsed(byCli).exclude as string[];
        expect([...ours].sort()).toEqual([...theirs].sort());
        const old = parsed(before).exclude as string[];
        expect(ours).toEqual([...old, ...VALUES]);
      });

      it("leaves every other key as it parsed before", () => {
        const { exclude: _a, ...ours } = parsed(after);
        const { exclude: _b, ...original } = parsed(before);
        const { exclude: _c, ...theirs } = parsed(byCli);
        expect(sameYamlValue(ours, original)).toBe(true);
        expect(sameYamlValue(ours, theirs)).toBe(true);
      });

      it("changes no line of the file, only adds the entries after the list's last item", () => {
        const added = VALUES.map((value) => `  - ${value}\n`).join("");
        const at = before.indexOf(lastItem) + lastItem.length;
        expect(before.split(lastItem)).toHaveLength(2);
        expect(after).toBe(before.slice(0, at) + added + before.slice(at));
      });

      it("is idempotent", () => {
        expect(applyEdit(after, EXCLUDE_OP)).toBe(after);
      });
    });
  }

  it("leaves a configuration that already carries every entry as it is", () => {
    const current = fixture("config-0dd90d52.yml");
    expect(applyEdit(current, EXCLUDE_OP)).toBe(current);
  });
});

describe("yaml_list_add — through the manifest runner", () => {
  it("runs as a manifest operation and throws its named error from the chain", () => {
    const files = new Map([["_config.yml", "exclude:\n  vendor: true\n"]]);
    expect(() => applyManifestChain([MANIFEST], files, "en")).toThrow(YamlListAddError);
    const result = applyManifestChain([MANIFEST], new Map([["_config.yml", "title: x\n"]]), "en");
    expect(parsed(result.files.get("_config.yml")!).exclude).toEqual(VALUES);
  });
});
