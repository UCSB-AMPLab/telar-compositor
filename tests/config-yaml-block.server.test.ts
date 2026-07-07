/**
 * Unit coverage for the shared `_config.yml` block walker — the idiom
 * extracted from commit.server.ts (disableGoogleSheetsInConfig,
 * isGoogleSheetsEnabled), upgrade.server.ts (updateTelarVersionInConfig),
 * and sync.server.ts (extractTelarVersion).
 *
 * Each block below exercises the shared walker against the exact shape one
 * of those four call sites depends on, so a regression here is caught
 * before it reaches any of them.
 *
 * @version v1.4.0-beta
 */

import { describe, it, expect } from "vitest";
import { mutateYamlBlock, findInYamlBlock } from "~/lib/config-yaml-block.server";

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
