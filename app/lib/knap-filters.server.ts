/**
 * A knap filter that keeps a string a string in YAML front matter.
 *
 * knap's own `yaml` filter serialises a value's true type: it renders the
 * word `true` as a bare boolean and `1234` as a bare number. Every field the
 * Compositor writes to front matter — a title, a button label, a byline —
 * is semantically a string whatever it looks like, so this filter escapes
 * exactly as knap's `yaml` filter does but never emits a bare scalar. A
 * double-quoted YAML scalar is always a string regardless of its content
 * (YAML core schema), which is what makes "always quote" a fix rather than
 * a workaround.
 *
 * This module only serialises the string; it does not decide which fields
 * are strings. `escapeYamlString` is the single escaper for the whole
 * publish path: the `yaml_string` filter below and `publish.server.ts`'s
 * `yamlQuote` line splicer both go through it, so a scalar written by a
 * template and one written by a hand-built line are escaped identically.
 *
 * Import only from the knap package root. knap's pure render API
 * (createEngine, standardFilters) runs under workerd; the CLI half is absent
 * from the package's `exports` map and has no real filesystem to run
 * against there, so nothing here or downstream may import `knap/dist/cli.js`
 * or anything under `knap/dist/`.
 *
 * @version v1.5.0-beta
 */

import { standardFilters } from "knap";
import type { FilterRegistry, TemplateFilter } from "knap";
import { isUnsafeCodePoint, replaceLoneSurrogates } from "~/lib/unsafe-text";

/*
 * The escaper's predicate is `isUnsafeCodePoint` from `~/lib/unsafe-text`, the
 * set `cleanText` also cleans. It runs over JSON.stringify's output, where the
 * C0 members never appear raw (stringify has already escaped them), so what it
 * adds is the code points a YAML double-quoted scalar needs escaped that
 * JSON.stringify leaves raw. Verified against Ruby Psych 4.0.4 / libyaml
 * 0.2.5 — the parser Jekyll actually uses on the front matter this filter
 * feeds — not against js-yaml, which accepts all of these unescaped and so
 * cannot show the gap.
 *
 * - The C1 control block (U+007F–U+009F) is load-bearing: DEL and most of
 *   the block raise `Psych::SyntaxError: control characters are not
 *   allowed`, and NEL (U+0085) is worse — it does not raise, it silently
 *   becomes a plain space, corrupting an author's text with no error at
 *   all.
 * - U+FFFE and U+FFFF likewise raise `Psych::SyntaxError`. An exhaustive
 *   sweep of the BMP (every code point 0x20–0xFFFF except the quote and
 *   backslash JSON.stringify already escapes, and except the surrogate
 *   range D800–DFFF, which cannot be represented as a real character in a
 *   UTF-8 document for Psych to read in the first place) found 34 code
 *   points Psych rejects outright with `Psych::SyntaxError`: 32 of the 33
 *   DEL/C1 code points (U+007F, U+0080–U+0084, U+0086–U+009F) plus these
 *   two noncharacters. The 33rd, NEL (U+0085), is deliberately not in that
 *   34 — it does not reject, it silently becomes a plain space, as noted
 *   above. Nothing else in the swept range changes value or errors when
 *   left raw. Add the 2,048 lone-surrogate values (verified separately,
 *   as text fed to Psych via a `\uD800`-style escape rather than a raw
 *   sweep — see `replaceLoneSurrogates` in `~/lib/unsafe-text`) and the
 *   total Psych rejects outright is 2,082 (2,048 + 32 + 2); NEL is a 2,083rd unsafe code point
 *   that Psych accepts but corrupts. With the 34 directly-swept code points
 *   plus NEL covered here, and surrogates handled separately (no YAML
 *   escape represents one), this predicate plus `replaceLoneSurrogates`
 *   make BMP coverage complete.
 * - U+2028 and U+2029 (Unicode line/paragraph separator) are, by measurement,
 *   *not* load-bearing for Psych: both round-trip raw without error or
 *   change. They stay escaped anyway because other YAML/JSON consumers of
 *   this output do treat them specially (e.g. as line terminators in some
 *   JS contexts), and escaping them is harmless here.
 */
/*
 * Lone surrogates go through `replaceLoneSurrogates` from `~/lib/unsafe-text`.
 * No YAML escape can represent one: `\ud800` is accepted as *text* by
 * JSON.stringify but Psych rejects it with `found invalid Unicode character
 * escape code`, because the value is not a character to begin with. It must
 * run *before* JSON.stringify: stringify turns a lone surrogate into the
 * literal text `\uD800`, six ordinary ASCII characters no longer visible to a
 * scan for the surrogate code point.
 */

/**
 * Escapes a string as a YAML double-quoted flow scalar. JSON.stringify
 * already produces the quote, backslash, and control-character escapes a
 * YAML double-quoted scalar expects, so the visual style matches knap's own
 * `yaml` filter; `isUnsafeCodePoint` covers the few code points JSON leaves
 * unescaped that YAML does not, and `replaceLoneSurrogates` covers the
 * values no escape can fix at all.
 *
 * Exported because the publish path has two shapes of writer — templates,
 * which reach this through the `yaml_string` filter, and line splicers that
 * emit a single `key: value` line into an existing file — and both must
 * produce the same scalar for the same input.
 *
 * Line breaks are preserved, never normalised — this is the one policy for
 * the whole publish path, and it is stated here because this is the only
 * place that decides it. A carriage return is escaped as `\r` and a line
 * feed as `\n`, two ASCII characters each, so the scalar stays on one line
 * whatever the value contains and a line-oriented reader has nothing to
 * truncate on. Both come back as themselves: measured through
 * buildConfigManagedFields -> updateConfigFields -> extractConfigFields, and
 * through js-yaml and Ruby Psych. Folding CRLF to LF would rewrite what the
 * author typed for no gain, and would put this side out of step with the
 * framework, which preserves.
 */
export function escapeYamlString(value: string): string {
  const json = JSON.stringify(replaceLoneSurrogates(value));
  let out = "";
  for (const char of json) {
    const codePoint = char.codePointAt(0) ?? 0;
    out += isUnsafeCodePoint(codePoint) ? `\\u${codePoint.toString(16).padStart(4, "0")}` : char;
  }
  return out;
}

/**
 * knap filter: serialises its input as a double-quoted YAML string,
 * unconditionally. Never emits a bare boolean, number, or null, no matter
 * what the string looks like.
 *
 * `TemplateFilter`'s declared signature already types `value` as `string` —
 * knap serialises before calling a filter — so there is no `String(value)`
 * coercion here; one would only be defending against a caller that violates
 * that contract, and none is known to.
 */
export const yamlString: TemplateFilter = (value) => escapeYamlString(value);

/**
 * `standardFilters` plus `yaml_string`, ready to pass to `createEngine`.
 * Spread rather than mutate so a future `standardFilters` addition from
 * knap is picked up without this file changing.
 */
export const filtersWithYamlString: FilterRegistry = {
  ...standardFilters,
  yaml_string: yamlString,
};
