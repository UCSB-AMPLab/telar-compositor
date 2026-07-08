/**
 * CSV serialisation utilities for Telar Compositor.
 *
 * Serialises D1 object rows back to the framework v1.0.0 objects.csv format
 * used by Telar sites. The output includes the standard header row, the
 * bilingual row (required by Telar's CSV parser), and one data row per object.
 *
 * Column set is the v1.0.0 authoritative list — object_type column renamed to
 * medium_genre (matching framework v1.0.0 CSV schema change).
 */

import Papa from "papaparse";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Authoritative v1.0.0 objects.csv column order.
 * Must stay in sync with mapObjectsCsv in import.server.ts.
 *
 * Order matches the framework's shipped objects.csv template
 * (object_id, title, alt_text, featured, …) so that preserved comment rows,
 * which align positionally to the template columns, stay under their headers
 * after a Compositor publish. The framework reads objects.csv strictly by
 * header name, so the alt_text position is a pure output-layout alignment with
 * no functional effect.
 *
 * Note: object_type renamed to medium_genre in framework v1.0.0. The framework
 * template has no dimensions column, so dimensions is appended after thumbnail
 * (the framework reads it by name when present).
 */
export const OBJECTS_CSV_COLUMNS = [
  "object_id",
  "title",
  "alt_text",
  "featured",
  "creator",
  "description",
  "source_url",
  "period",
  "year",
  "medium_genre",
  "subjects",
  "source",
  "credit",
  "thumbnail",
  "dimensions",
] as const;

/**
 * Bilingual header row mapping each English column name to its Spanish equivalent.
 * Required by Telar's CSV parser — the second row is the Spanish label row.
 */
export const BILINGUAL_ROW: Record<string, string> = {
  object_id: "id_objeto",
  title: "titulo",
  featured: "destacado",
  creator: "creador",
  description: "descripcion",
  source_url: "url_fuente",
  period: "periodo",
  year: "año",
  medium_genre: "medio_genero",
  subjects: "temas",
  source: "fuente",
  credit: "credito",
  thumbnail: "miniatura",
  alt_text: "texto_alt",
  dimensions: "dimensiones",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ObjectRow {
  object_id: string;
  title: string | null;
  featured: boolean | null;
  creator: string | null;
  description: string | null;
  source_url: string | null;
  period: string | null;
  year: string | null;
  medium_genre: string | null;
  subjects: string | null;
  source: string | null;
  credit: string | null;
  thumbnail: string | null;
  alt_text: string | null;
  dimensions?: string | null;
  /** JSON passthrough blob of custom columns not mapped to first-class fields. */
  extra_columns?: string | null;
}

/**
 * Shape of a D1 objects row (or a pending-upload row that shadows the D1
 * shape). The only CSV-relevant departure from ObjectRow is the object_type
 * column, which Telar v1.0.0 renamed to medium_genre at the CSV layer
 * while D1 keeps the original `object_type` column name internally.
 */
export interface ObjectDbRow {
  object_id: string;
  title: string | null;
  featured: boolean | null;
  creator: string | null;
  description: string | null;
  source_url: string | null;
  period: string | null;
  year: string | null;
  object_type: string | null;
  subjects: string | null;
  source: string | null;
  credit: string | null;
  thumbnail: string | null;
  alt_text: string | null;
  dimensions?: string | null;
  extra_columns?: string | null;
}

/**
 * Maps a D1 objects row to the ObjectRow shape expected by serializeObjectsCsv.
 * Centralises the object_type ↔ medium_genre column rename so every call site
 * uses the same transform.
 */
export function dbObjectToCsvRow(row: ObjectDbRow): ObjectRow {
  return {
    object_id: row.object_id,
    title: row.title ?? null,
    featured: row.featured ?? null,
    creator: row.creator ?? null,
    description: row.description ?? null,
    source_url: row.source_url ?? null,
    period: row.period ?? null,
    year: row.year ?? null,
    medium_genre: row.object_type ?? null,
    subjects: row.subjects ?? null,
    source: row.source ?? null,
    credit: row.credit ?? null,
    thumbnail: row.thumbnail ?? null,
    alt_text: row.alt_text ?? null,
    dimensions: row.dimensions ?? null,
    extra_columns: row.extra_columns ?? null,
  };
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/**
 * Extracts comment rows (lines starting with # or whose first field starts
 * with #) from an existing CSV string. These are instruction rows, user notes,
 * or any other commented content that should be preserved across rewrites.
 */
export function extractCommentRows(existingCsv: string): string[] {
  return existingCsv
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      // Lines starting with # directly
      if (trimmed.startsWith("#")) return true;
      // Lines starting with "# (quoted comment fields from PapaParse)
      if (trimmed.startsWith('"#')) return true;
      return false;
    });
}

/**
 * Serialises an array of object rows to v0.9.0 objects.csv format.
 *
 * Output structure:
 *   Line 1: English header row (column names)
 *   Line 2: Spanish bilingual row
 *   Lines 3+: Comment/instruction rows (preserved from existing CSV)
 *   Remaining: Data rows (one per object)
 *
 * Conventions:
 *   - `featured: true` → "yes", `featured: false/null` → ""
 *   - All null fields → ""
 *   - Fields with commas or newlines are quoted by PapaParse automatically
 *
 * @param objectRows Array of objects to serialise
 * @param existingCsv Optional existing CSV content — comment rows are extracted
 *                    and preserved in the output
 */
export function serializeObjectsCsv(objectRows: ObjectRow[], existingCsv?: string): string {
  // Parse each row's extra_columns passthrough blob. A corrupt blob must
  // NEVER throw — publish must not crash — so degrade to {} on any parse error
  // or non-object shape.
  const safeParse = (s: string): Record<string, string> => {
    try {
      const o = JSON.parse(s);
      return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, string>) : {};
    } catch {
      return {};
    }
  };

  // Parse extras once per row, preserving order alongside objectRows.
  const allParsed = objectRows.map((row) => (row.extra_columns ? safeParse(row.extra_columns) : {}));

  // Union of every custom key across all rows, sorted alphabetically for a
  // deterministic column order.
  const extraKeys = [...new Set(allParsed.flatMap((p) => Object.keys(p)))].sort();

  // Combined column list: fixed v1.0.0 columns followed by any custom columns.
  const columns = [...OBJECTS_CSV_COLUMNS, ...extraKeys];

  // Helper: normalise PapaParse output to LF-only line endings
  const normalise = (s: string) => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Header line only (PapaParse always adds a header when unparsing objects)
  const headerCsv = normalise(Papa.unparse([{}], { columns })).split("\n")[0];

  // Bilingual row — Spanish column name equivalents required by Telar's CSV
  // parser. Custom columns (from extra_columns) intentionally get an EMPTY
  // cell rather than echoing their key: both header detectors (Compositor's
  // isHeaderRow and the framework's is_header_row) exclude empty cells from
  // their known-bilingual ratio, so emitting empties keeps the ratio at
  // 15/15 = 1.0 regardless of how many custom columns there are. Echoing the
  // keys instead would dilute the ratio below the 0.8 threshold at 4+ custom
  // columns, so the bilingual row would be mis-ingested as a phantom data
  // object (object_id = "id_objeto"), corrupting re-import and the live site.
  const bilingualRow = normalise(
    Papa.unparse([columns.map((col) => BILINGUAL_ROW[col] ?? "")], { header: false }),
  );

  // Preserve comment rows from existing CSV
  const commentRows = existingCsv ? extractCommentRows(existingCsv) : [];

  // Data rows — map DB types to CSV strings, spreading each row's parsed extras
  // so any custom column a row lacks becomes an empty cell.
  const dataRows = objectRows.map((obj, i) => ({
    object_id: obj.object_id,
    title: obj.title ?? "",
    featured: obj.featured ? "yes" : "",
    creator: obj.creator ?? "",
    description: obj.description ?? "",
    source_url: obj.source_url ?? "",
    period: obj.period ?? "",
    year: obj.year ?? "",
    medium_genre: obj.medium_genre ?? "",
    subjects: obj.subjects ?? "",
    source: obj.source ?? "",
    credit: obj.credit ?? "",
    thumbnail: obj.thumbnail ?? "",
    alt_text: obj.alt_text ?? "",
    dimensions: obj.dimensions ?? "",
    ...allParsed[i],
  }));

  // Data CSV without the header line PapaParse generates
  const dataCsv = normalise(Papa.unparse(dataRows, { columns }))
    .split("\n")
    .slice(1)
    .join("\n");

  const sections = [headerCsv, bilingualRow, ...commentRows, dataCsv];
  return sections.join("\n");
}
