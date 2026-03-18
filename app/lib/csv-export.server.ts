/**
 * CSV serialisation utilities for Telar Compositor.
 *
 * Serialises D1 object rows back to the v0.9.0 objects.csv format used by
 * Telar sites. The output includes the standard header row, the bilingual row
 * (required by Telar's CSV parser), and one data row per object.
 *
 * Column set is the v0.9.0 authoritative list derived from mapObjectsCsv in
 * import.server.ts.
 */

import Papa from "papaparse";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Authoritative v0.9.0 objects.csv column order.
 * Must stay in sync with mapObjectsCsv in import.server.ts.
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
  "object_type",
  "subjects",
  "source",
  "credit",
  "thumbnail",
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
  object_type: "tipo_objeto",
  subjects: "temas",
  source: "fuente",
  credit: "credito",
  thumbnail: "miniatura",
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
  object_type: string | null;
  subjects: string | null;
  source: string | null;
  credit: string | null;
  thumbnail: string | null;
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

  // Bilingual row (data portion only — skip the header line PapaParse generates)
  const bilingualCsv = normalise(Papa.unparse([BILINGUAL_ROW], { columns }))
    .split("\n")
    .slice(1)
    .join("\n");

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
    object_type: obj.object_type ?? "",
    subjects: obj.subjects ?? "",
    source: obj.source ?? "",
    credit: obj.credit ?? "",
    thumbnail: obj.thumbnail ?? "",
  }));

  // Data CSV without the header line PapaParse generates
  const dataCsv = normalise(Papa.unparse(dataRows, { columns }))
    .split("\n")
    .slice(1)
    .join("\n");

  const sections = [headerCsv, bilingualCsv, ...commentRows, dataCsv];
  return sections.join("\n");
}
