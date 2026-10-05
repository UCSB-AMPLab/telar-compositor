/**
 * isGoogleSheetsEnabled and disableGoogleSheetsInConfig against the build's
 * reading of `google_sheets.enabled`: `yaml.safe_load`, compared with "True"
 * (build.yml). Expected values were taken from PyYAML 6.0.3 in
 * the framework's Python environment: `str(config["google_sheets"]["enabled"]) == "True"`,
 * with the trailing line breaks the shell's capture removes taken off.
 *
 * @version v1.5.0-beta
 */

import { describe, expect, it } from "vitest";
import { disableGoogleSheetsInConfig, isGoogleSheetsEnabled, SheetsNotDisableableError } from "~/lib/commit.server";

const configWithSheetsEnabled = (value: string) => `title: Site\ngoogle_sheets:\n  enabled: ${value}\n  published_url: ""\nurl: x\n`;

const CASES: Array<[string, boolean]> = [
  ["true", true], ["True", true], ["TRUE", true],
  ["yes", true], ["Yes", true], ["YES", true],
  ["on", true], ["On", true], ["ON", true],
  ["false", false], ["False", false], ["FALSE", false],
  ["no", false], ["No", false], ["NO", false],
  ["off", false], ["Off", false], ["OFF", false],
  ['"true"', false], ["'yes'", false], ["tRuE", false], ["1", false], ["~", false],
  ["true # a comment", true],
];

/** Strings build.yml prints as `True`, and near misses it does not. */
const STRING_CASES: Array<[string, boolean]> = [
  ['"True"', true], ["'True'", true], ["!!str True", true], ['"True\\n\\n"', true],
  ['"True "', false], ['"TRUE"', false], ['" True"', false],
];

describe("isGoogleSheetsEnabled matches the build's safe_load reading", () => {
  it.each(CASES)("enabled: %s is %s", (value, expected) => {
    expect(isGoogleSheetsEnabled(configWithSheetsEnabled(value))).toBe(expected);
  });

  it.each(STRING_CASES)("enabled: %s, a string, is %s", (value, expected) => {
    expect(isGoogleSheetsEnabled(configWithSheetsEnabled(value))).toBe(expected);
  });

  it("is on for a block scalar holding True and a line break", () => {
    expect(isGoogleSheetsEnabled("google_sheets:\n  enabled: |\n    True\n")).toBe(true);
  });

  it("is off with no google_sheets block, and for a file that does not load", () => {
    expect(isGoogleSheetsEnabled("title: Site\n")).toBe(false);
    expect(isGoogleSheetsEnabled("google_sheets:\n  enabled: true\n  published_url: [unclosed\n")).toBe(false);
  });
});

describe("disableGoogleSheetsInConfig turns off every spelling the build reads as on", () => {
  it.each(CASES.filter(([, on]) => on))("enabled: %s is rewritten to false", (value) => {
    const out = disableGoogleSheetsInConfig(configWithSheetsEnabled(value));
    expect(isGoogleSheetsEnabled(out)).toBe(false);
    expect(out).toContain("enabled: false");
  });

  it("leaves a quoted value and an off value as they are", () => {
    for (const v of ['"true"', "no", "false"]) expect(disableGoogleSheetsInConfig(configWithSheetsEnabled(v))).toBe(configWithSheetsEnabled(v));
  });

  it.each(['"True"', "'True'"])("rewrites a quoted %s, which the build reads as on, to false", (value) => {
    const out = disableGoogleSheetsInConfig(configWithSheetsEnabled(value));
    expect(isGoogleSheetsEnabled(out)).toBe(false);
    expect(out).toBe(configWithSheetsEnabled("false"));
  });

  it("throws for a quoted \"True\" in a flow mapping, which no rewrite here turns off", () => {
    expect(() => disableGoogleSheetsInConfig('google_sheets: {enabled: "True", published_url: x}\n')).toThrow(SheetsNotDisableableError);
  });

  it("keeps a trailing comment", () => {
    expect(disableGoogleSheetsInConfig(configWithSheetsEnabled("yes # keep"))).toContain("enabled: false # keep");
  });
});

// Each rewritten file was loaded with PyYAML 6.0.3 (safe_load), where
// google_sheets.enabled is False.
describe("disableGoogleSheetsInConfig rewrites flow style and refuses what it cannot rewrite", () => {
  it.each([
    ["flow on one line", "title: S\ngoogle_sheets: {enabled: yes, published_url: x}\nurl: u\n", "title: S\ngoogle_sheets: {enabled: false, published_url: x}\nurl: u\n"],
    ["flow across lines", "google_sheets: {published_url: x,\n  enabled: ON}\nurl: u\n", "google_sheets: {published_url: x,\n  enabled: false}\nurl: u\n"],
    ["flow on the line after the key", "google_sheets:\n  {enabled: TRUE, published_url: x}\n", "google_sheets:\n  {enabled: false, published_url: x}\n"],
  ])("%s", (_name, before, after) => {
    expect(isGoogleSheetsEnabled(before)).toBe(true);
    const out = disableGoogleSheetsInConfig(before);
    expect(out).toBe(after);
    expect(isGoogleSheetsEnabled(out)).toBe(false);
  });

  it.each([
    ["an alias", "a: &s {enabled: yes}\ngoogle_sheets: *s\n"],
    ["an explicit tag", "google_sheets: {enabled: !!bool yes}\n"],
  ])("throws, rather than carry on as though Sheets were off, for %s", (_name, before) => {
    expect(isGoogleSheetsEnabled(before)).toBe(true);
    expect(() => disableGoogleSheetsInConfig(before)).toThrow(SheetsNotDisableableError);
  });

  it("throws when the rewrite would also change a quoted value that contains `enabled: yes`", () => {
    const before = 'google_sheets: {enabled: yes, note: "first\n  enabled: yes\n  last"}\n';
    expect(isGoogleSheetsEnabled(before)).toBe(true);
    expect(() => disableGoogleSheetsInConfig(before)).toThrow(SheetsNotDisableableError);
  });

  it("keeps every other value when it does rewrite", () => {
    const before = 'title: "enabled: yes"\ngoogle_sheets:\n  enabled: yes # keep\n  published_url: x\n';
    expect(disableGoogleSheetsInConfig(before)).toBe('title: "enabled: yes"\ngoogle_sheets:\n  enabled: false # keep\n  published_url: x\n');
  });

  it("returns a config that is already off unchanged, whatever its form", () => {
    for (const off of ["google_sheets: {enabled: false}\n", "google_sheets: *x\n", "title: S\n"]) {
      expect(disableGoogleSheetsInConfig(off)).toBe(off);
    }
  });
});
