/**
 * The word-character table against the Python the build pins, and the two
 * readers of it (`\b` in a compiled pattern, `endsWord` in the code-element
 * scan) on a code point the engines part on.
 *
 * U+088F is assigned in the Unicode this Node carries and unassigned in
 * Unicode 14.0, the version of the build's Python 3.11.
 *
 * @version v1.5.0-beta
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { codeElements } from "~/lib/glossary-links";
import { compilePythonPattern } from "~/lib/python-regex";
import { isPythonWordCodePoint } from "~/lib/python-word";
import { PYTHON_WORD_RANGES, PYTHON_WORD_UNICODE_VERSION } from "~/lib/python-word-table";

const U088F = String.fromCodePoint(0x088f);

describe("a code point the engines part on", () => {
  it("is a letter to this JavaScript engine, which is why the table exists", () => {
    expect(/^\p{L}$/u.test(U088F)).toBe(true);
  });

  it("is not a word character to the table", () => {
    expect(isPythonWordCodePoint(0x088f)).toBe(false);
    expect(isPythonWordCodePoint(0x88e)).toBe(true);
  });

  it("gives a compiled \\b a boundary after a word character it precedes", () => {
    const re = compilePythonPattern("code\\b", "gi");
    expect([...`code${U088F}`.matchAll(re)].map((m) => m[0])).toEqual(["code"]);
  });

  it("reads <code࢏> as an opening tag in the code-element scan, as CPython does", () => {
    const text = `<code>[[iiif]]<code${U088F}>x</code>`;
    expect(codeElements(text).map(([s, e]) => text.slice(s, e))).toEqual([`<code${U088F}>x</code>`]);
  });
});

/** The build's interpreter: the framework pins 3.11 (build.yml `python-version`). */
const PINNED_PYTHON = [
  process.env.PYTHON311,
  `${process.env.HOME}/.local/bin/python3.11`,
  "/opt/homebrew/bin/python3.11",
  "/usr/local/bin/python3.11",
].find((p): p is string => !!p && existsSync(p));

describe.skipIf(!PINNED_PYTHON)(
  PINNED_PYTHON
    ? "the word-character table against the pinned Python"
    : "the word-character table against the pinned Python [skipped: no python3.11]",
  () => {
    it("agrees with CPython 3.11's \\w on every code point", () => {
      const script =
        "import re,sys,unicodedata,json;w=re.compile(r'\\w');" +
        "print(json.dumps([sys.version_info[:2],unicodedata.unidata_version,[c for c in range(0x110000) if w.match(chr(c))]]))";
      const [version, unicode, points] = JSON.parse(
        execFileSync(PINNED_PYTHON!, ["-c", script], { maxBuffer: 64 * 1024 * 1024 }).toString(),
      ) as [number[], string, number[]];
      expect(version).toEqual([3, 11]);
      expect(unicode).toBe(PYTHON_WORD_UNICODE_VERSION);
      const fromTable: number[] = [];
      for (const [from, to] of PYTHON_WORD_RANGES) for (let c = from; c <= to; c++) fromTable.push(c);
      expect(fromTable).toEqual(points);
    }, 60_000);
  },
);
