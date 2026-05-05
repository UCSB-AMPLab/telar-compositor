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
 * Note: object_type renamed to medium_genre in framework v1.0.0.
 */
export const OBJECTS_CSV_COLUMNS = [
  "object_id",
  "title",
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
  "alt_text",
] as const;

/**
 * Bilingual header row mapping each English column name to its Spanish equivalent.
 * Required by Telar's CSV parser — the second row is the Spanish label row.
 */
const BILINGUAL_ROW: Record<string, string> = {
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
  const columns = OBJECTS_CSV_COLUMNS as unknown as string[];

  // Helper: normalise PapaParse output to LF-only line endings
  const normalise = (s: string) => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Header line only (PapaParse always adds a header when unparsing objects)
  const headerCsv = normalise(Papa.unparse([{}], { columns })).split("\n")[0];

  // Bilingual row — Spanish column name equivalents required by Telar's CSV parser
  const bilingualRow = normalise(
    Papa.unparse([columns.map((col) => BILINGUAL_ROW[col] ?? col)], { header: false }),
  );

  // Preserve comment rows from existing CSV
  const commentRows = existingCsv ? extractCommentRows(existingCsv) : [];

  // Data rows — map DB types to CSV strings
  const dataRows = objectRows.map((obj) => ({
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
  }));

  // Data CSV without the header line PapaParse generates
  const dataCsv = normalise(Papa.unparse(dataRows, { columns }))
    .split("\n")
    .slice(1)
    .join("\n");

  const sections = [headerCsv, bilingualRow, ...commentRows, dataCsv];
  return sections.join("\n");
}
