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
 * @version v1.4.1-beta
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
