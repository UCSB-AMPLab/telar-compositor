/**
 * Unit coverage for the shared `_config.yml` block walker — the idiom
 * extracted from commit.server.ts (disableGoogleSheetsInConfig,
 * isGoogleSheetsEnabled), upgrade.server.ts (updateTelarVersionInConfig),
 * and sync.server.ts (extractTelarVersion).
 *
 * Each block below exercises the shared walker against the exact shape one
 * of those four call sites depends on, so a regression here is caught
 * before it reaches any of them. The findYamlBlockRegions block covers the
 * boundary primitive both walkers and publish.server's updateConfigBlocks
 * now build on.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import {
  mutateYamlBlock,
  findInYamlBlock,
  findYamlBlockRegions,
  configLineRegex,
  readConfigScalar,
} from "~/lib/config-yaml-block.server";

describe("mutateYamlBlock", () => {
  it("replaces a matched child line, preserving comments/indentation outside the block", () => {
    const yaml = `title: My Site
google_sheets:
  enabled: true
  # a comment
  published_url: "https://example.com"
baseurl: /my-repo`;

    const result = mutateYamlBlock(yaml, "google_sheets", (line) =>
      /^(\s+enabled:\s*)true\b/.test(line)
        ? line.replace(/^(\s+enabled:\s*)true\b/, "$1false")
        : null,
    );

    expect(result).toBe(`title: My Site
google_sheets:
  enabled: false
  # a comment
  published_url: "https://example.com"
baseurl: /my-repo`);
  });

  it("is idempotent when the child line is already in the target state", () => {
    const yaml = `google_sheets:
  enabled: false`;
    expect(mutateYamlBlock(yaml, "google_sheets", (line) =>
      /^(\s+enabled:\s*)true\b/.test(line) ? line.replace(/^(\s+enabled:\s*)true\b/, "$1false") : null,
    )).toBe(yaml);
  });

  it("no-ops when the block is absent", () => {
    const yaml = `title: My Site
baseurl: /my-repo`;
    expect(mutateYamlBlock(yaml, "google_sheets", () => "should not run")).toBe(yaml);
  });

  it("mutates multiple distinct child keys within the same block in one pass (updateTelarVersionInConfig shape)", () => {
    const yaml = `telar:
  version: "1.2.0"
  release_date: "2026-01-01"
title: My Site`;

    const result = mutateYamlBlock(yaml, "telar", (line) => {
      if (/^\s+version:/.test(line)) return line.replace(/^(\s+version:\s*).*/, `$1"1.4.0"`);
      if (/^\s+release_date:/.test(line)) return line.replace(/^(\s+release_date:\s*).*/, `$1"2026-07-06"`);
      return null;
    });

    expect(result).toBe(`telar:
  version: "1.4.0"
  release_date: "2026-07-06"
title: My Site`);
  });

  it("stops matching once a non-indented, non-comment, non-empty line ends the block", () => {
    const yaml = `google_sheets:
  enabled: true
title: My Site
  enabled: true`; // a same-named key outside the block must not be touched

    const result = mutateYamlBlock(yaml, "google_sheets", (line) =>
      /^(\s+enabled:\s*)true\b/.test(line) ? line.replace(/^(\s+enabled:\s*)true\b/, "$1false") : null,
    );

    expect(result).toBe(`google_sheets:
  enabled: false
title: My Site
  enabled: true`);
  });
});

describe("findInYamlBlock", () => {
  it("returns the first matched value inside the block (isGoogleSheetsEnabled shape)", () => {
    const yaml = `google_sheets:
  enabled: true
  published_url: "https://example.com"`;

    const result = findInYamlBlock(yaml, "google_sheets", (line) =>
      /^\s+enabled:\s*(true|True)\b/.test(line) ? true : undefined,
    );
    expect(result).toBe(true);
  });

  it("returns undefined when the block is absent or has no match", () => {
    expect(findInYamlBlock("title: My Site", "google_sheets", (line) =>
      /enabled/.test(line) ? true : undefined,
    )).toBeUndefined();

    expect(findInYamlBlock("google_sheets:\n  published_url: x", "google_sheets", (line) =>
      /^\s+enabled:\s*(true|True)\b/.test(line) ? true : undefined,
    )).toBeUndefined();
  });

  it("extracts a quoted scalar value from a child key (extractTelarVersion shape)", () => {
    const yaml = `telar:
  version: "1.4.0"
title: My Site`;

    const result = findInYamlBlock(
      yaml,
      "telar",
      (line) => {
        const m = line.match(/^\s+version:\s*["']?([^\s"'#]+)/);
        return m ? m[1] : undefined;
      },
      { haltAfterBlock: true },
    );
    expect(result).toBe("1.4.0");
  });

  it("haltAfterBlock stops scanning at the first block's end, ignoring a later duplicate block key", () => {
    const yaml = `telar:
  other_key: x
title: My Site
telar:
  version: "2.0.0"`;

    // Without haltAfterBlock, scanning would continue into the second `telar:`
    // occurrence and find the version there.
    const continueScan = findInYamlBlock(yaml, "telar", (line) => {
      const m = line.match(/^\s+version:\s*["']?([^\s"'#]+)/);
      return m ? m[1] : undefined;
    });
    expect(continueScan).toBe("2.0.0");

    // With haltAfterBlock (extractTelarVersion's original `break` semantics),
    // the walk stops once the first telar: block closes without a match.
    const haltedScan = findInYamlBlock(
      yaml,
      "telar",
      (line) => {
        const m = line.match(/^\s+version:\s*["']?([^\s"'#]+)/);
        return m ? m[1] : undefined;
      },
      { haltAfterBlock: true },
    );
    expect(haltedScan).toBeUndefined();
  });

  it("extracts an integer child key from a block (extractAnswerWordLimit shape)", () => {
    const yaml = `story_content:
  answer_word_limit: 60
title: My Site`;

    const result = findInYamlBlock(
      yaml,
      "story_content",
      (line) => {
        const m = line.match(/^\s+answer_word_limit:\s*["']?([^\s"'#]+)/);
        return m ? m[1] : undefined;
      },
      { haltAfterBlock: true },
    );
    expect(result).toBe("60");
  });

  it("matches a child key whose value is the digit zero", () => {
    // "0" is falsy as a string is not, but a matcher returning it must still be
    // read as a hit: the walk stops on `!== undefined`, never on truthiness.
    const result = findInYamlBlock(
      "story_content:\n  answer_word_limit: 0\n",
      "story_content",
      (line) => {
        const m = line.match(/^\s+answer_word_limit:\s*["']?([^\s"'#]+)/);
        return m ? m[1] : undefined;
      },
      { haltAfterBlock: true },
    );
    expect(result).toBe("0");
  });
});

describe("findYamlBlockRegions", () => {
  it("locates a block's header, exclusive end, and child indent", () => {
    const lines = [
      "title: Site",
      "telar:",
      "  # a comment inside the region",
      "  version: 1.2.3",
      "",
      "baseurl: /x",
    ];
    expect(findYamlBlockRegions(lines, "telar")).toEqual([
      { headerIdx: 1, regionEnd: 5, childIndent: "  " },
    ]);
  });

  it("returns every occurrence in order (the walkers process all of them)", () => {
    const lines = ["telar:", "  version: 1.0.0", "other: x", "telar:", "  version: 2.0.0"];
    const regions = findYamlBlockRegions(lines, "telar");
    expect(regions.map((r) => r.headerIdx)).toEqual([0, 3]);
    expect(regions.map((r) => r.regionEnd)).toEqual([2, 5]);
  });

  it("treats an adjacent duplicate header as a flush region (regionEnd === next headerIdx)", () => {
    const lines = ["telar:", "  version: 1.0.0", "telar:", "  version: 2.0.0"];
    const regions = findYamlBlockRegions(lines, "telar");
    expect(regions).toHaveLength(2);
    expect(regions[0].regionEnd).toBe(regions[1].headerIdx);
  });

  it("runs the region to EOF when no line ends the block", () => {
    const lines = ["telar:", "  version: 1.0.0", "", "  # trailing comment"];
    expect(findYamlBlockRegions(lines, "telar")).toEqual([
      { headerIdx: 0, regionEnd: 4, childIndent: "  " },
    ]);
  });

  it("reads the child indent from the first non-comment child (tabs/deep indent respected)", () => {
    const lines = ["story_interface:", "  # comment first", "    show_on_homepage: true", "end: y"];
    expect(findYamlBlockRegions(lines, "story_interface")[0].childIndent).toBe("    ");
  });

  it("defaults the child indent to two spaces for an empty region", () => {
    const lines = ["telar:", "next: y"];
    expect(findYamlBlockRegions(lines, "telar")).toEqual([
      { headerIdx: 0, regionEnd: 1, childIndent: "  " },
    ]);
  });

  it("returns no regions when the key is absent or only appears indented", () => {
    expect(findYamlBlockRegions(["a: 1", "  telar: x"], "telar")).toEqual([]);
  });

  it("treats the block key as a literal, hyphens and all", () => {
    // `development-features:` is the framework's own block name, and the first
    // caller whose key is not a bare identifier. The key is documented as
    // literal, so regex metacharacters in it must not become syntax.
    const lines = ["development-features:", "  skip_stories: true", "next: y"];
    expect(findYamlBlockRegions(lines, "development-features")).toEqual([
      { headerIdx: 0, regionEnd: 2, childIndent: "  " },
    ]);
    // A dot would otherwise match any character — a near-miss key must not
    // resolve to a real block.
    expect(findYamlBlockRegions(lines, "development.features")).toEqual([]);
  });

  it("haltAfterBlock still scans through an ADJACENT duplicate block (walker fidelity)", () => {
    // The pre-primitive walker consumed a flush same-key header before its
    // halt could fire, so the second region was scanned; a separated
    // duplicate was not. Both behaviours are pinned.
    const adjacent = "telar:\n  a: 1\ntelar:\n  version: 9.9.9";
    const separated = "telar:\n  a: 1\nother: x\ntelar:\n  version: 9.9.9";
    const read = (yaml: string) =>
      findInYamlBlock(
        yaml,
        "telar",
        (line) => line.match(/version:\s*(\S+)/)?.[1],
        { haltAfterBlock: true },
      );
    expect(read(adjacent)).toBe("9.9.9");
    expect(read(separated)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Top-level scalar line matcher — shared by create-site (buildBornCleanConfig,
// rewriteConfigUrl), commit (verifySiteUrl), and onboarding (fix-site-config).
// ---------------------------------------------------------------------------

describe("readConfigScalar", () => {
  it("reads a double-quoted value, stripping the quotes (comment-free regression pin)", () => {
    expect(readConfigScalar(`url: "https://x.github.io"`, "url")).toBe(
      "https://x.github.io",
    );
  });

  it("reads a single-quoted value, stripping the quotes", () => {
    expect(readConfigScalar(`url: 'https://x.github.io'`, "url")).toBe(
      "https://x.github.io",
    );
  });

  it("reads a bare (unquoted) value", () => {
    expect(readConfigScalar(`baseurl: /my-repo`, "baseurl")).toBe("/my-repo");
  });

  it("reads an empty quoted value as the empty string", () => {
    expect(readConfigScalar(`baseurl: ""`, "baseurl")).toBe("");
  });

  it("returns undefined when the key's line is absent", () => {
    expect(readConfigScalar(`title: My Site`, "url")).toBeUndefined();
  });

  it("reads a quoted value WITHOUT folding in a trailing inline comment", () => {
    // The pre-refactor anchored regex failed this match entirely and read "".
    expect(
      readConfigScalar(`url: "https://x.github.io" # managed by Telar`, "url"),
    ).toBe("https://x.github.io");
  });

  it("reads a bare value WITHOUT folding in a trailing inline comment", () => {
    // The pre-refactor bare path captured the comment text into the value.
    expect(readConfigScalar(`baseurl: /my-repo # the base path`, "baseurl")).toBe(
      "/my-repo",
    );
  });

  it("picks the value from within a full multi-line config body", () => {
    const body = `title: My Site
url: "https://x.github.io" # deploy target
baseurl: "/my-repo"
`;
    expect(readConfigScalar(body, "url")).toBe("https://x.github.io");
    expect(readConfigScalar(body, "baseurl")).toBe("/my-repo");
  });
});

describe("configLineRegex rewrite shape (fix-site-config / rewriteConfigUrl)", () => {
  // Mirrors the exact replacement expression onboarding's fix-site-config and
  // create-site's rewriteConfigUrl run: `.replace(re, '$1"<value>"$2')`.
  const rewrite = (body: string, key: string, value: string) =>
    body.replace(configLineRegex(key), `$1"${value}"$2`);

  it("rewrites a comment-free line byte-identically to the pre-refactor output", () => {
    expect(rewrite(`url: "https://old.github.io"`, "url", "https://new.github.io")).toBe(
      `url: "https://new.github.io"`,
    );
    expect(rewrite(`baseurl: "/old"`, "baseurl", "/new")).toBe(`baseurl: "/new"`);
  });

  it("rewrites a bare comment-free line", () => {
    expect(rewrite(`baseurl: /old`, "baseurl", "/new")).toBe(`baseurl: "/new"`);
  });

  it("preserves an inline comment on the rewritten line (the point of the fix)", () => {
    expect(
      rewrite(`url: "https://old.github.io" # managed by Telar`, "url", "https://new.github.io"),
    ).toBe(`url: "https://new.github.io" # managed by Telar`);
    expect(rewrite(`baseurl: /old # base path`, "baseurl", "/new")).toBe(
      `baseurl: "/new" # base path`,
    );
  });

  it("rewrites only the target line within a full config body", () => {
    const body = `title: My Site
url: "https://old.github.io"
baseurl: "/old"`;
    const out = rewrite(rewrite(body, "url", "https://new.github.io"), "baseurl", "/new");
    expect(out).toBe(`title: My Site
url: "https://new.github.io"
baseurl: "/new"`);
  });
});

// ---------------------------------------------------------------------------
// readConfigScalar decodes, it does not unquote
// ---------------------------------------------------------------------------
//
// The publish path writes _config.yml scalars as double-quoted YAML with real
// escapes, so a reader that strips the outer quote pair and returns what is
// between them returns the escape text and not the value. `verifySiteUrl`
// compares what it reads against the URL that produced the line, so a url
// carrying a quote or a backslash compared unequal against itself.
//
// This reads through the same parser `extractConfigFields` uses, so both
// readers of the same file agree about what a line says.
describe("readConfigScalar decodes escaped scalars", () => {
  const cases: Array<[label: string, written: string, value: string]> = [
    ["an escaped double quote", 'url: "https://x.test/a\\"b"', 'https://x.test/a"b'],
    ["an escaped backslash", 'url: "https://x.test/a\\\\b"', "https://x.test/a\\b"],
    ["both together", 'url: "a\\\\b\\"c"', 'a\\b"c'],
    ["a carriage return", 'url: "a\\rb"', "a\rb"],
    ["a line feed", 'url: "a\\nb"', "a\nb"],
    ["a NEL escape", 'url: "a\\u0085b"', "ab"],
    ["a plain quoted value", 'url: "https://x.test/"', "https://x.test/"],
    ["a single-quoted value", "url: 'it''s here'", "it's here"],
  ];

  it.each(cases)("%s", (_label, written, value) => {
    expect(readConfigScalar(`${written}\n`, "url")).toBe(value);
  });

  it("returns undefined for an absent key and empty string for a bare one", () => {
    expect(readConfigScalar("title: X\n", "url")).toBeUndefined();
    expect(readConfigScalar("url:\n", "url")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// A `#` is only a comment where YAML says it is
// ---------------------------------------------------------------------------
//
// `configLineRegex` splits a trailing comment into its own group, which the
// REWRITE path needs so it can put the comment back after replacing a value.
// A reader must not use that split: it loses every `#` that is part of the
// value. Where a comment starts is the parser's judgement — YAML wants
// whitespace before the `#`, and never reads one inside quotes.
describe("readConfigScalar and the hash character", () => {
  const cases: Array<[label: string, line: string, value: string]> = [
    ["a hash inside a double-quoted value", 'url: "a\\"b#c"', 'a"b#c'],
    ["a hash inside a single-quoted value", "url: 'it''s # here'", "it's # here"],
    ["a hash with no space before it is part of a bare value", "url: a#b", "a#b"],
    ["a hash with a space before it starts a comment", "url: a #comment", "a"],
    ["a comment after a quoted value", 'url: "x" # note', "x"],
    ["a comment after a bare path", "url: /my-repo # the base path", "/my-repo"],
  ];

  it.each(cases)("%s", (_label, line, value) => {
    expect(readConfigScalar(`${line}\n`, "url")).toBe(value);
  });

  it("agrees with extractConfigFields, which shares the matcher", async () => {
    const { extractConfigFields } = await import("~/lib/sync.server");
    for (const [, line, value] of cases) {
      expect(extractConfigFields(`${line}\n`).url).toBe(value);
    }
  });
});

// A remainder that is only a comment is no value. YAML's rule is that a `#`
// needs whitespace before it to start a comment, and the matcher that hands
// this reader its remainder has already eaten the space after the colon — so
// the rule has to be applied knowing that a plain scalar cannot begin with a
// `#` in the first place.
describe("a key whose whole value is a comment", () => {
  const cases: Array<[label: string, line: string, value: string]> = [
    ["a comment in the value position", "baseurl: # root site", ""],
    ["a comment with no space after the colon", "baseurl: #root", ""],
    ["no value at all", "baseurl:", ""],
    ["a value then a comment", "url: a # c", "a"],
    ["a quoted value containing a hash", 'url: "a#b"', "a#b"],
  ];

  it.each(cases)("%s", (_label, line, value) => {
    const key = line.slice(0, line.indexOf(":"));
    expect(readConfigScalar(`${line}\n`, key)).toBe(value);
  });

  it("agrees with extractConfigFields", async () => {
    const { extractConfigFields } = await import("~/lib/sync.server");
    expect(extractConfigFields("baseurl: # root site\n").baseurl).toBeNull();
    expect(extractConfigFields("url: a # c\n").url).toBe("a");
  });
});
