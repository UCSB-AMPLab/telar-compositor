/**
 * `yaml_list_add` against the framework's command-line route, byte for byte
 *: the framework's 400 seeded configurations (`random_configs`,
 * seed 603) and its reader cases, each with what `add_exclude_entries` wrote
 * with its group comments removed, or null where it failed. How the fixture
 * was made is in `fixtures/upgrade-1.8.0/NOTES.md`.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyYamlListAdd, YamlListAddError } from "~/lib/yaml-list-add.server";

interface Case {
  name: string;
  text: string;
  written: string | null;
}

const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "upgrade-1.8.0", "exclude-differential.json"), "utf-8"),
) as { entries: string[]; cases: Case[] };

/** What the operation writes, or null when it throws. */
function compositor(text: string): string | null {
  const files = new Map([["_config.yml", text]]);
  try {
    applyYamlListAdd(files, { type: "yaml_list_add", file: "_config.yml", key: "exclude", values: FIXTURE.entries });
  } catch (err) {
    if (err instanceof YamlListAddError) return null;
    throw err;
  }
  return files.get("_config.yml")!;
}

describe("yaml_list_add — the framework's configurations, byte for byte", () => {
  it("holds the framework's 400 seeded configurations and its reader cases", () => {
    expect(FIXTURE.cases.filter((c) => c.name.startsWith("seed-603 "))).toHaveLength(400);
    expect(FIXTURE.cases.filter((c) => c.written === null).length).toBeGreaterThan(0);
    expect(FIXTURE.cases.filter((c) => c.written !== null && c.written !== c.text).length).toBeGreaterThan(300);
  });

  // Where the two YAML readers disagree, not the edit: js-yaml reads a block
  // scalar that ends the file without a line ending with a final newline,
  // where PyYAML and Jekyll's Psych read none; and PyYAML refuses a tab after
  // the colon, which js-yaml and Psych read.
  const READERS_DIFFER = ["seed-603 355 folded", "failure tab-after-colon"];

  it("writes what the framework writes, and refuses what it refuses", () => {
    const differ = FIXTURE.cases
      .filter((c) => compositor(c.text) !== c.written)
      .map((c) => ({ name: c.name, text: c.text, framework: c.written, compositor: compositor(c.text) }));
    expect(differ.filter((c) => !READERS_DIFFER.includes(c.name))).toEqual([]);
    expect(differ.map((c) => c.name)).toEqual(READERS_DIFFER);
  });
});
