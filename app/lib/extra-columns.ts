/**
 * The parts of the `extra_columns` passthrough blob the editor reads as well
 * as the server: parsing a stored blob, and which of a step's kept cells make
 * its row a step of its own.
 *
 * No imports, so a client module can take it. `extra-columns.server.ts`
 * re-exports each of these, and holds the rest of the blob's handling.
 *
 * @version v1.5.0-beta
 */

/**
 * True for a column heading the framework reads as an instruction rather than
 * as data: one that BEGINS with `#`, untrimmed and unfolded.
 *
 * The test is `col.startswith('#')` on the header as pandas holds it, which is
 * how `telar.core.csv_to_json` applies it (scripts/telar/core.py:97 on the test
 * instance, :93 at the published tag) — before the rename and with no strip of
 * its own. The glossary page generator applies
 * the same test (scripts/generate_collections.py:325 on the test instance,
 * :278 at the published tag) but AFTER `df.columns.str.lower().str.strip()`,
 * so a heading of ` #Note` keeps its column in the objects reader and loses it
 * in the glossary one. Measured 15 September against both releases, which agree
 * on all three spellings (`#Note`, ` #Note`, `#Note `).
 *
 * The Compositor cannot tell those spellings apart and does not need to:
 * `parseTelarCsv` strips every header cell as CPython strips before a row is
 * keyed by it, so ` #Note` arrives here as `#Note` and republishes as `#Note` —
 * the one spelling both readers drop. The untrimmed test mirrors what the
 * framework will apply to the file the Compositor writes.
 */
export function isInstructionColumnName(name: string): boolean {
  return name.startsWith("#");
}

/**
 * The story sheet column the framework deletes by name before it reads a row
 * (`_normalise_frame`, scripts/telar/processors/stories.py), matched exactly as
 * it matches it.
 */
const STORY_EXAMPLE_COLUMN = "example";

/**
 * Whether a step's kept cells make its row a step of its own.
 *
 * The framework drops instruction columns and the `example` column before it
 * removes empty rows (scripts/telar/core.py, then `_normalise_frame`), so a
 * row whose only cells sit in those columns is no row at all there. Such
 * cells are still kept on a row that is a step for another reason: they are
 * part of the author's file and are written back.
 */
export function hasStoryRowContent(extras: Record<string, unknown>): boolean {
  return Object.keys(extras).some(
    (key) => !isInstructionColumnName(key) && key !== STORY_EXAMPLE_COLUMN,
  );
}

/**
 * A stored blob as a plain record. A corrupt blob must NEVER throw — publish
 * must not crash — so any parse error or non-object shape degrades to {}.
 */
export function parseExtraColumns(raw: string | null | undefined): Record<string, string> {
  const empty = () => Object.create(null) as Record<string, string>;
  if (!raw) return empty();
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object" || Array.isArray(o)) return empty();
    // Null-prototype, so a LOOKUP for a key the blob does not carry cannot
    // return an inherited member. `JSON.parse` yields an ordinary object, on
    // which `parsed["constructor"]` is the Object constructor rather than
    // undefined — and a serializer asking each row for each column would then
    // publish a function's source as the author's data.
    return Object.assign(empty(), o as Record<string, string>);
  } catch {
    return empty();
  }
}
