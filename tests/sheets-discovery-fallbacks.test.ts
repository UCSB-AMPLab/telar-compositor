/**
 * Tab discovery on a published sheet: the `items.push` reading, then the
 * `sheet-button-*` reading, then bare `gid=` numbers named `Tab N`, as
 * discover_sheet_gids.py's `discover_gids_from_published` tries them. The
 * plain block states what each fixture must give; the framework block runs the
 * Python on the same HTML and compares.
 *
 * @version v1.5.0-beta
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { discoverSheetTabs } from "~/lib/sheets.server";
import {
  FRAMEWORK_PYTHON,
  FRAMEWORK_SCRIPTS_DIR,
  FRAMEWORK_TIMEOUT_MS,
  describeWithRequiredFramework,
} from "./helpers/framework-checkout";

const URL_ = "https://docs.google.com/spreadsheets/d/e/TEST/pubhtml";

const PRIMARY = `<script>items.push({name: "objects", pageUrl: "x", gid: "30"});
items.push({name: "story", gid: "20"});</script>
<ul><li id="sheet-button-99">Ignored</li></ul>`;

const BUTTONS = `<ul>
<li id="sheet-button-30"><a href="#gid=30">Objects &amp; things</a></li>
<li id="sheet-button-20">  Story  </li>
<li id="sheet-button-30">Duplicate</li>
<li id="sheet-button-7"><a href="https://x/pubhtml?gid=8">Moved</a></li>
</ul><p>gid=500</p>`;

const GID_ONLY = `<a href="?gid=300">a</a><a href="?gid=20">b</a><a href="?gid=0">c</a><a href="?gid=20">d</a>
<a href="?gid=1000">e</a><a href="?gid=9">f</a>`;

const NONE = `<html><body>No tabs, gid=0 only: <a href="?gid=0">x</a></body></html>`;

const ENTITIES = `<li id="sheet-button-1">caf&eacute;</li><li id="sheet-button-2">A &amp B</li>
<li id="sheet-button-3">Caf&#233; &#x41; &ampfoo</li>`;
const VALUELESS_ID = `<div id></div><li id="sheet-button-30"><a href="?gid=30">objects</a></li>`;
const VALUELESS_HREF = `<li id="sheet-button-30"><a href>objects</a></li><a href="?gid=40">x</a>`;

const FIXTURES: Record<string, string> = { PRIMARY, BUTTONS, GID_ONLY, NONE, ENTITIES, VALUELESS_ID, VALUELESS_HREF };

async function tabsOf(html: string) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => html }));
  return discoverSheetTabs(URL_);
}

afterEach(() => vi.unstubAllGlobals());

describe("discoverSheetTabs fallbacks", () => {
  it("reads items.push first and ignores sheet-button elements beside it", async () => {
    expect(await tabsOf(PRIMARY)).toEqual([
      { name: "objects", gid: "30" },
      { name: "story", gid: "20" },
    ]);
  });

  it("reads sheet-button elements when items.push finds nothing: decoded, stripped, first gid wins, href gid replaces the id's", async () => {
    expect(await tabsOf(BUTTONS)).toEqual([
      { name: "Objects & things", gid: "30" },
      { name: "Story", gid: "20" },
      { name: "Moved", gid: "8" },
    ]);
  });

  it("names bare gids Tab N in numeric order, without 0 and without repeats", async () => {
    expect(await tabsOf(GID_ONLY)).toEqual([
      { name: "Tab 1", gid: "9" },
      { name: "Tab 2", gid: "20" },
      { name: "Tab 3", gid: "300" },
      { name: "Tab 4", gid: "1000" },
    ]);
  });

  it("decodes named, semicolonless and numeric references as html.unescape does", async () => {
    expect(await tabsOf(ENTITIES)).toEqual([
      { name: "café", gid: "1" },
      { name: "A & B", gid: "2" },
      { name: "Café A &foo", gid: "3" },
    ]);
  });

  it("answers no tabs, not Tab N, where the Python raises on a valueless id or href", async () => {
    expect(await tabsOf(VALUELESS_ID)).toEqual([]);
    expect(await tabsOf(VALUELESS_HREF)).toEqual([]);
  });

  it("gives an empty list when no reading finds a tab", async () => {
    expect(await tabsOf(NONE)).toEqual([]);
  });
});

describeWithRequiredFramework("discoverSheetTabs against discover_sheet_gids.py", () => {
  it("finds the tabs the build's discover_gids_from_published finds, in its order", () => {
    const dir = mkdtempSync(join(tmpdir(), "discover-"));
    try {
      const names = Object.keys(FIXTURES);
      names.forEach((n) => writeFileSync(join(dir, `${n}.html`), FIXTURES[n]));
      const script = [
        "import sys, json",
        `sys.path.insert(0, ${JSON.stringify(FRAMEWORK_SCRIPTS_DIR)})`,
        "import discover_sheet_gids as d",
        "out = {}",
        "for n in json.loads(sys.stdin.read()):",
        "    r = d.discover_gids_from_published('file://' + sys.argv[1] + '/' + n + '.html')",
        "    out[n] = None if r is None else [list(t) for t in r]",
        "print(json.dumps(out))",
      ].join("\n");
      const out = execFileSync(FRAMEWORK_PYTHON, ["-c", script, dir], {
        input: JSON.stringify(names),
        encoding: "utf-8",
        timeout: FRAMEWORK_TIMEOUT_MS,
      });
      const python = JSON.parse(out.trim().split("\n").at(-1) as string) as Record<string, string[][] | null>;
      return Promise.all(
        names.map(async (n) => {
          const ours = (await tabsOf(FIXTURES[n])).map((t) => [t.name, t.gid]);
          expect(ours, n).toEqual(python[n] ?? []);
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, FRAMEWORK_TIMEOUT_MS);
});
