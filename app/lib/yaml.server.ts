/**
 * Thin wrapper around js-yaml for use in Cloudflare Workers runtime, the
 * mapping reader and deep equality the in-place YAML edits check themselves
 * with (`yamlMappingOf`, `sameYamlValue`), and the reading of a front matter
 * block as the framework's PyYAML reads it (`safeLoadTitle`).
 *
 * Only the `load` function is imported to keep bundle size minimal (~40KB
 * vs the full js-yaml package). Call this from server-only modules (.server.ts)
 * — never import into client bundles.
 *
 * @version v1.5.0-beta
 */

import { load, FAILSAFE_SCHEMA, Type } from "js-yaml";
import { composePyYaml, constructionFails, mappingValue, STR_TAG } from "~/lib/pyyaml";

/**
 * Parses a YAML string and returns the result as a plain object.
 *
 * Uses js-yaml's safe `load` which handles all standard YAML features
 * including multiline strings, anchors, and type coercion. Throws if
 * the input is not valid YAML.
 */
export function parseYaml(yamlString: string): Record<string, unknown> {
  return load(yamlString, { json: true }) as Record<string, unknown>;
}

/** A YAML mapping as `parseYaml` returns it. */
export type YamlMapping = Record<string, unknown>;

export function isYamlMapping(value: unknown): value is YamlMapping {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/**
 * YAML text as a mapping under the resolving schema, or null when it will not
 * parse or is not a mapping. Text of only comments or blank lines is an empty
 * mapping: there is nothing in it for an edit to displace.
 */
export function yamlMappingOf(text: string): YamlMapping | null {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return null;
  }
  if (doc === null || doc === undefined) return {};
  return isYamlMapping(doc) ? doc : null;
}

/**
 * Deep equality over what YAML parses to. An alias can make a value contain
 * itself, so each pair of containers already being compared is taken as
 * equal when it comes round again; `seen` is shared by comparisons that are
 * one check.
 */
export function sameYamlValue(a: unknown, b: unknown, seen: Map<object, Set<object>> = new Map()): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (a instanceof Date || b instanceof Date) return sameDate(a, b);
  if (alreadyCompared(a, b, seen)) return true;
  return sameContainer(a, b, seen);
}

function sameDate(a: object, b: object): boolean {
  return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
}

/** True when this pair is already being compared; otherwise records it. */
function alreadyCompared(a: object, b: object, seen: Map<object, Set<object>>): boolean {
  const partners = seen.get(a);
  if (partners?.has(b)) return true;
  seen.set(a, (partners ?? new Set<object>()).add(b));
  return false;
}

function sameContainer(a: object, b: object, seen: Map<object, Set<object>>): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
      a.every((v, i) => sameYamlValue(v, b[i], seen));
  }
  return isYamlMapping(a) && isYamlMapping(b) && sameEntries(a, b, seen);
}

/** The two mappings hold the same keys with equal values; order is not compared. */
function sameEntries(a: YamlMapping, b: YamlMapping, seen: Map<object, Set<object>>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length &&
    keys.every((k) => Object.hasOwn(b, k) && sameYamlValue(a[k], b[k], seen));
}

/**
 * The standard scalar tags the failsafe schema does not know, each carried as
 * the text under it.
 *
 * `!!str`, `!!map` and `!!seq` are already in the failsafe schema, and a merge
 * key needs no type there — measured, not assumed. These six are the ones it
 * refuses, and refusing them refuses the whole DOCUMENT: one `!!int` on a key
 * nobody asked about makes every failsafe read of that file throw, so a value
 * read this way is lost over a tag beside it. The caller is `failsafeTitle`
 * (`app/lib/import.server.ts`), which needs a title as the file spells it
 * rather than as a schema would coerce it. A tag says what the node's type is;
 * the text under it is what this parse exists to return, and the reader that
 * judges the text is unchanged by it.
 */
const TEXTUAL_SCALAR_TAGS = [
  "int",
  "float",
  "bool",
  "null",
  "binary",
  "timestamp",
].map(
  (name) =>
    new Type(`tag:yaml.org,2002:${name}`, {
      kind: "scalar",
      resolve: () => true,
      construct: (data: unknown) => data,
    }),
);

const TEXTUAL_SCHEMA = FAILSAFE_SCHEMA.extend(TEXTUAL_SCALAR_TAGS);

/**
 * Parses YAML with the failsafe schema, in which every scalar is a string.
 *
 * `parseYaml` above resolves types: `2024` is a number, `~` is null, `yes` is
 * a string but `true` is a boolean, and a date-shaped scalar is a date. That
 * is right for reading a config a human wrote as data. It is wrong for
 * reading a value the Compositor will write back out, where the question is
 * what text the author typed — a resolved value cannot be turned back into
 * its source text, so a title of `2024` would be republished as the number it
 * resolved to, or guessed at by re-reading the line.
 *
 * Under the failsafe schema there is nothing to resolve: the three node kinds
 * are string, sequence and mapping. Everything YAML treats as syntax still
 * applies — quoted scalars decode their escapes, block scalars fold and chomp,
 * anchors and aliases resolve, and the last of two duplicate keys wins, the
 * same as under the default schema and under PyYAML.
 *
 * The standard scalar tags are declared so that a tag anywhere in the file
 * does not refuse the file; each carries its text through unresolved, which is
 * what this parse is for. A merge key is still an ordinary key called `<<`
 * here, as it is in any failsafe read, so a caller that needs merges resolved
 * uses `parseYaml`.
 */
export function parseYamlFailsafe(yamlString: string): unknown {
  return load(yamlString, { schema: TEXTUAL_SCHEMA, json: true });
}

/**
 * A front matter block as `yaml.safe_load` would load it, reduced to what a
 * layer title needs: whether it loads at all, and if it is a mapping carrying
 * `title` (merged titles included), whether that title is a string and its
 * text.
 *
 * This is the title the import stores. It is not what the change check
 * compares: the compare form reads a block's title only when the block is in
 * the Compositor writer's own form, and otherwise compares the block's text
 * (story-content.server.ts), so no comparison depends on this emulation.
 *
 * What it does: js-yaml composes the block, and each node is typed as PyYAML
 * types it. An explicit tag decides by itself; a quoted or block scalar with
 * no tag is `str`; a plain scalar, or one tagged with the bare `!`, is typed
 * by SafeLoader's implicit resolver table (PYYAML_IMPLICIT_RESOLVERS in pyyaml.ts, a port
 * of PyYAML 6.0.3 yaml/resolver.py). An alias is its anchored node. It agrees
 * with the framework's `_split_frontmatter` on every block of the cross-check
 * fixture (tests/fixtures/story-canonical/layer-titles), which is generated by
 * running the framework itself.
 *
 * Known divergences, not modelled:
 * - a tagged block scalar at the end of the block, which keeps the line
 *   break js-yaml appends;
 * - an alias preceded by a comment, which is read as the comment;
 * - SafeConstructor's outcomes that depend on a node's shape and not only its
 *   tag and kind: a mapping read as a string through a `=` key
 *   (`!!str {=: Hello}` is "Hello"), and the construction errors raised by a
 *   `!!str` sequence, a malformed `!!binary` or a `!!omap` that is not a list
 *   of pairs, which make the framework fall back to the raw capture;
 * - a document js-yaml composes differently from PyYAML (a syntax one accepts
 *   and the other refuses);
 * - an unhashable mapping key;
 * - a value whose constructor raises something other than a YAML error
 *   (`2024-13-45` as a timestamp raises ValueError, which escapes
 *   `_split_frontmatter` and drops the panel).
 */
export function safeLoadTitle(
  text: string,
): { loads: false } | { loads: true; title: { isString: boolean; text: string } | undefined } {
  const root = composePyYaml(text);
  if (root === null || constructionFails(root)) return { loads: false };
  const title = mappingValue(root, "title");
  if (title === undefined) return { loads: true, title: undefined };
  return { loads: true, title: { isString: title.kind === "scalar" && title.tag === STR_TAG, text: title.text } };
}
