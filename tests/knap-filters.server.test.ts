/**
 * Unit coverage for the `yaml_string` knap filter.
 *
 * Every round-trip assertion parses the filter's output with a YAML parser
 * and checks the value comes back as the identical string — never the
 * emitted text — because YAML 1.1 and 1.2 disagree about which bare words
 * are booleans, so a text assertion could pass while the value still
 * silently changed type under a different parser.
 *
 * That round-trip is done against js-yaml (`parseYaml`), which is what this
 * project actually runs in-process. It cannot, however, show whether
 * `needsExtraEscape` is doing anything: js-yaml with `{ json: true }`
 * accepts every code point that predicate exists to guard against, raw,
 * unchanged. The parser that matters for what this filter is *for* — the
 * front matter Jekyll builds the published site from — is Ruby Psych, and
 * Psych rejects or silently corrupts several of those code points. So the
 * "Psych-unsafe code points" block below asserts structurally on the
 * emitted scalar's raw bytes instead of round-tripping: it checks the
 * dangerous code point is absent from the output and its `\uXXXX` escape is
 * present, which is a property of what this filter emits, verifiable
 * without a Psych binding in the test environment. Every Psych behaviour
 * claim behind that block was checked with `ruby -ryaml` against Psych
 * 4.0.4 / libyaml 0.2.5 — see the module's own comments for the commands.
 *
 * The last block pins knap's own `yaml` filter behaviour directly, so a
 * future knap release that stops type-coercing shows up as a red test here
 * rather than as nothing.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { standardFilters } from "knap";
import { yamlString, filtersWithYamlString } from "~/lib/knap-filters.server";
import { parseYaml } from "~/lib/yaml.server";

/** Round-trips a filter's output through the project's YAML parser. */
function parseFilterOutput(output: string): unknown {
  return parseYaml(output);
}

/** Calls yamlString and narrows its result, which is always a plain string. */
function callYamlString(input: string): string {
  const output = yamlString(input);
  if (typeof output !== "string") {
    throw new Error("yamlString must return a string synchronously");
  }
  return output;
}

describe("yamlString", () => {
  const cases: Array<[label: string, input: string]> = [
    ["true", "true"],
    ["false", "false"],
    ["null", "null"],
    ["yes", "yes"],
    ["no", "no"],
    ["on", "on"],
    ["off", "off"],
    ["y", "y"],
    ["n", "n"],
    ["1234", "1234"],
    ["3.14", "3.14"],
    ["1e5", "1e5"],
    ["0x1F", "0x1F"],
    ["0o17", "0o17"],
    ["bare dash", "-"],
    ["tilde", "~"],
    ["plus", "+"],
    [".inf", ".inf"],
    [".nan", ".nan"],
    ["empty string", ""],
    ["single space", " "],
    ["leading space", "  leading"],
    ["trailing space", "trailing  "],
    ["quoted title", 'A "quoted" title'],
    ["colon", "Title: with a colon"],
    ["embedded newline", "Line one\nLine two"],
    ["frontmatter-shaped", "---\nlooks like frontmatter"],
    ["backslash", "A backslash \\ in the middle"],
    ["star", "*star"],
    ["anchor", "&anchor"],
    ["hash", "#hash"],
    ["tag", "!tag"],
    ["directive", "%directive"],
    ["at", "@at"],
    ["backtick", "`backtick"],
    ["bracket", "[bracket"],
    ["brace", "{brace"],
    ["dash item", "- dash item"],
    ["question", "? question"],
    ["colon-leading", ": colon-leading"],
    ["date-shaped", "2026-09-13"],
    ["time-shaped", "12:30"],
    ["sexagesimal-shaped", "1:2:3"],
    // Real authored text (F5): the case list above is YAML-shaped edge
    // inputs, not the Spanish and indigenous-language content Telar's
    // sites and users actually carry.
    ["accented Spanish", "á é í ó ú ñ ü"],
    ["Spanish punctuation", "¿Cómo estás? ¡Muy bien!"],
    ["non-Latin script", "Привет мир 你好世界"],
    ["paired astral emoji", "Título 😀 con emoji"],
    ["tab", "a\tb"],
    ["CR", "a\rb"],
    ["CRLF", "a\r\nb"],
    // The literal six ASCII characters backslash, u, 0, 0, 8, 5 — not an
    // actual NEL character. Must survive as those six characters; must
    // not be (mis)interpreted as an escape and unescaped into the real
    // U+0085 control character NEL discussed above.
    ["literal backslash-u escape text, not a real NEL", "\\u0085"],
  ];

  it.each(cases)("round-trips %s (%j) as a string", (_label, input) => {
    const output = callYamlString(input);
    const parsed = parseFilterOutput(output);
    // `toBe` on a string already establishes both identity and type; a
    // separate `typeof parsed === "string"` assertion after it is redundant.
    expect(parsed).toBe(input);
  });

  it("never emits an unquoted scalar", () => {
    for (const [, input] of cases) {
      const output = callYamlString(input);
      expect(output.startsWith('"')).toBe(true);
      expect(output.endsWith('"')).toBe(true);
    }
  });
});

// Code points that Ruby Psych 4.0.4 / libyaml 0.2.5 — the parser Jekyll
// actually runs on this front matter — rejects or silently corrupts when
// they appear raw (unescaped) in a double-quoted scalar. js-yaml accepts
// every one of these unchanged, so a round-trip assertion through
// `parseYaml` cannot see whether `needsExtraEscape` is doing anything:
// neutering it to `return false`, or replacing the whole filter body with
// a bare `JSON.stringify`, leaves every `cases` round-trip above green.
// These assertions are structural instead: they check the emitted scalar's
// raw text directly for the property that actually matters — that the
// dangerous code point is absent and its `\uXXXX` escape is present — which
// is a property of the bytes this filter writes, not of what a particular
// parser tolerates.
//
// Verified against Psych 4.0.4 with `ruby -ryaml`:
//   DEL (U+007F) raw            -> Psych::SyntaxError: control characters are not allowed
//   U+009F raw                  -> Psych::SyntaxError: control characters are not allowed
//   NEL (U+0085) raw            -> silently becomes a plain space (no error)
//   U+FFFE / U+FFFF raw         -> Psych::SyntaxError: control characters are not allowed
// An exhaustive sweep of the BMP (0x20-0xFFFF, excluding the quote and
// backslash JSON.stringify already escapes) found 34 code points Psych
// rejects when raw: 32 of the 33 DEL/C1 code points (NEL, U+0085, is the
// one that corrupts rather than rejects — see above) plus these two
// noncharacters. Add the 2,048 lone-surrogate values (verified separately;
// see the module's own comment for the full breakdown) and the total Psych
// rejects outright is 2,082. Nothing else in the BMP changes value when
// left raw.
const PSYCH_UNSAFE_RAW_CODE_POINTS: number[] = [
  ...Array.from({ length: 0x9f - 0x7f + 1 }, (_, i) => 0x7f + i), // DEL + C1 block
  0x2028,
  0x2029,
  0xfffe,
  0xffff,
];

describe("Psych-unsafe code points never appear raw in the emitted scalar", () => {
  it.each(PSYCH_UNSAFE_RAW_CODE_POINTS)(
    "escapes U+%s rather than emitting it raw",
    (codePoint) => {
      const char = String.fromCodePoint(codePoint);
      const output = callYamlString(`a${char}b`);
      const hex = codePoint.toString(16).padStart(4, "0");
      // Assert the exact emitted scalar text, not "raw char absent" and
      // "escape substring present" as two separate checks: both stay
      // green even if the encoder is mutated to double the backslash —
      // emitting the literal text backslash-backslash-u-0-0-8-5 where the
      // correct output is backslash-u-0-0-8-5 (using NEL, U+0085, as the
      // example). The raw NEL character is absent from both outputs, and
      // the substring \u0085 is present in both (the mutated one just has
      // an extra backslash in front of it), so neither of those two
      // checks would catch the mutation — but Psych reads the mutated
      // output as the six literal characters \u0085, not as NEL. An
      // exact match on the whole scalar catches that.
      expect(output).toBe(`"a\\u${hex}b"`);
    },
  );
});

// F3: a lone (unpaired) UTF-16 surrogate is a valid JS string element but
// not a valid Unicode character, and no YAML escape represents one — Psych
// raises `found invalid Unicode character escape code` on `\ud800` even
// though it accepts other `\uXXXX` escapes fine. Verified with `ruby
// -ryaml`: `title: "a\ud800b"` -> Psych::SyntaxError: found invalid Unicode
// character escape code.
//
// This filter's decision (see the module comment) is to replace a lone
// surrogate with U+FFFD before it ever reaches JSON.stringify, so the
// front matter stays publishable rather than the build failing on data
// that was not valid text to begin with.
describe("lone surrogates", () => {
  it("replaces an unpaired high surrogate with U+FFFD", () => {
    const output = callYamlString("a\uD800b");
    const parsed = parseFilterOutput(output);
    expect(parsed).toBe("a�b");
  });

  it("replaces an unpaired low surrogate with U+FFFD", () => {
    const output = callYamlString("a\uDC00b");
    const parsed = parseFilterOutput(output);
    expect(parsed).toBe("a�b");
  });

  it("leaves a correctly paired surrogate (an astral character) untouched", () => {
    const emoji = "\u{1F600}";
    const output = callYamlString(`a${emoji}b`);
    const parsed = parseFilterOutput(output);
    expect(parsed).toBe(`a${emoji}b`);
  });
});

describe("filtersWithYamlString", () => {
  it("registers yaml_string alongside every standard filter", () => {
    expect(filtersWithYamlString.yaml_string).toBe(yamlString);
    for (const name of Object.keys(standardFilters)) {
      expect(filtersWithYamlString[name]).toBe(standardFilters[name]);
    }
  });
});

describe("knap's own yaml filter (pinned, not under test)", () => {
  // This block exists to fail loudly if a future knap release changes the
  // type-coercing behaviour this whole filter was written to route around.
  // It is not asserting anything about yaml_string.

  it("still renders 'true' as a bare boolean", () => {
    const line = `title: ${standardFilters.yaml("true")}`;
    const parsed = parseYaml(line) as { title: unknown };
    // `toBe(true)` already establishes both value and type; a separate
    // `typeof parsed.title === "boolean"` assertion is redundant.
    expect(parsed.title).toBe(true);
  });

  it("still renders '1234' as a bare number", () => {
    const line = `title: ${standardFilters.yaml("1234")}`;
    const parsed = parseYaml(line) as { title: unknown };
    // `toBe(1234)` already establishes both value and type; a separate
    // `typeof parsed.title === "number"` assertion is redundant.
    expect(parsed.title).toBe(1234);
  });

  it("still quotes 'yes' rather than coercing it, unlike 'true'", () => {
    // Asserting on emitted TEXT, not the parsed value, is deliberate here —
    // the one place in this file where it's correct. Bare `yes` *also*
    // parses to the string "yes" under js-yaml with `{ json: true }`
    // (verified), so a parse-based assertion would pass whether or not
    // knap quotes it, and would not notice knap changing its output. The
    // whole point of this block is to detect exactly that change, so it
    // has to look at what knap emits.
    expect(standardFilters.yaml("yes")).toBe('"yes"');
  });
});
