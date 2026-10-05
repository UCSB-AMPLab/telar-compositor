/**
 * The header-name table every Telar CSV is read through, and the objects keys
 * the objects mapper consumes.
 *
 * Dependency-free on purpose. It is imported by `import.server.ts` (which
 * re-exports both for existing callers) and by `extra-columns.server.ts`,
 * which the Durable Object loads: a module on this path that reached GitHub,
 * Google Sheets or the database would pull that whole graph into the DO
 * bundle, and importing back from `import.server.ts` would close a cycle.
 * Anything added here must keep that property.
 *
 * @version v1.5.0-beta
 */

import { FIELD_REGISTRY, YDOC_FIELDS, isExcluded } from "~/lib/field-registry";
import { pythonLower } from "~/lib/python-lower";
import { pythonStrip } from "~/lib/python-whitespace";

/**
 * Spanish (and alias) CSV header -> Compositor canonical English key.
 * Ported from Telar's csv_utils.py COLUMN_NAME_MAPPING, with two deliberate
 * retargets to the Compositor's canonical keys (which differ from the
 * framework's): medio/medio_genero/tipo_objeto -> medium_genre (NOT `medium`),
 * and privada/privado/protegida/protegido/protected -> private (NOT
 * `protected`) — the last covers a site still carrying the column under
 * Telar's pre-v0.9.0 name. Keys are in folded form; a lookup passes the header
 * through `foldHeader` first. Identity entries for the canonical English names
 * normalise Google-Sheets capitalisation.
 *
 * Every non-canonical spelling of `private` (privada, privado, protegida,
 * protegido, protected — see PROJECT_ONLY_ALIASES, derived from this table)
 * is a project-column spelling only: `parseTelarCsv` renames it exclusively
 * when parsing project.csv (or the project sheet tab), so a same-named
 * column belonging to objects.csv, a story CSV, glossary.csv, or a
 * non-project sheet tab keeps its own header rather than being folded into
 * `private`. Every other entry here applies to every Telar CSV alike.
 */
export const COLUMN_NAME_MAPPING: Record<string, string> = {
  // Story steps
  paso: "step", objeto: "object", pregunta: "question", respuesta: "answer",
  boton_capa1: "layer1_button", boton1: "layer1_button",
  contenido_capa1: "layer1_content", contenido1: "layer1_content", archivo_capa1: "layer1_content",
  boton_capa2: "layer2_button", boton2: "layer2_button",
  contenido_capa2: "layer2_content", contenido2: "layer2_content", archivo_capa2: "layer2_content",
  inicio_clip: "clip_start", fin_clip: "clip_end", bucle: "loop",
  texto_alt: "alt_text",
  pagina: "page", "página": "page",
  layer1_file: "layer1_content", layer2_file: "layer2_content",
  // Objects
  id_objeto: "object_id", titulo: "title", "título": "title",
  descripcion: "description", "descripción": "description",
  url_fuente: "source_url", creador: "creator", periodo: "period",
  dimensiones: "dimensions",
  ubicacion: "source", "ubicación": "source", fuente: "source", location: "source",
  credito: "credit", "crédito": "credit", miniatura: "thumbnail",
  "año": "year", ano: "year",
  medio: "medium_genre", medio_genero: "medium_genre", tipo_objeto: "medium_genre",
  // The framework renames `medium`, `object_type`, `tipo_objeto`,
  // `medium_genre` and `medio_genero` alike onto its own `medium`
  // (scripts/telar/csv_utils.py), and its docs tell authors to write
  // `medium`. A header this table does not carry is swept into
  // `extra_columns` and republished as a column of its own beside the
  // Compositor's `medium_genre`, which the framework then renames onto the
  // same name — two columns claiming one canonical name in the published
  // file. Every spelling the framework folds together must fold together
  // here too, onto the one field that stores it.
  medium: "medium_genre", object_type: "medium_genre",
  temas: "subjects", materias: "subjects", materia: "subjects",
  destacado: "featured",
  // Project
  orden: "order", id_historia: "story_id",
  subtitulo: "subtitle", "subtítulo": "subtitle", firma: "byline",
  privada: "private", privado: "private", protegida: "private", protegido: "private",
  protected: "private",
  mostrar_secciones: "show_sections",
  // Glossary
  id_termino: "term_id", "id_término": "term_id",
  definicion: "definition", "definición": "definition",
  terminos_relacionados: "related_terms", "términos_relacionados": "related_terms",
  // Identity entries (canonical English; case-insensitive via lowercased lookup)
  object_id: "object_id", title: "title", featured: "featured", creator: "creator",
  description: "description", source_url: "source_url", period: "period", year: "year",
  medium_genre: "medium_genre", dimensions: "dimensions", subjects: "subjects",
  // Identity, deliberately NOT a rename onto `source_url`. The framework
  // reads the pair by preferring whichever is non-empty (`get_source_url`,
  // scripts/telar/csv_utils.py), not by letting one column win the name, so
  // renaming here would hand a populated `iiif_manifest` the field over a
  // populated `source_url` and invert that preference. The entry exists so a
  // capitalised header normalises to the name the objects mapper reads;
  // `KNOWN_OBJECT_KEYS` then consumes it, and only `source_url` is published.
  iiif_manifest: "iiif_manifest",
  source: "source", credit: "credit", thumbnail: "thumbnail", alt_text: "alt_text",
  order: "order", story_id: "story_id", subtitle: "subtitle", byline: "byline",
  private: "private", show_sections: "show_sections",
  step: "step", object: "object", x: "x", y: "y", zoom: "zoom", page: "page",
  question: "question", answer: "answer", clip_start: "clip_start", clip_end: "clip_end",
  loop: "loop", layer1_button: "layer1_button", layer1_content: "layer1_content",
  layer2_button: "layer2_button", layer2_content: "layer2_content",
  term_id: "term_id", definition: "definition", related_terms: "related_terms",
};
/**
 * Header names only glossary.csv reads, in folded form, on top of
 * COLUMN_NAME_MAPPING: the framework's `GLOSSARY_COLUMN_ALIASES`
 * (scripts/telar/csv_utils.py) with an identity entry for its target.
 *
 * `tipo` is a word an author uses for a column of their own on an objects or
 * story sheet, so there it stays the author's header. On the glossary it is
 * `kind`, and a Spanish second header row naming it is a header row. The
 * identity entry makes `Kind` the `kind` column: the glossary readers lowercase
 * every header (scripts/telar/glossary.py), so the build reads it as `kind`.
 */
export const GLOSSARY_COLUMN_ALIASES: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, string>, { tipo: "kind", kind: "kind" }),
);

// A header cell is a file-supplied string, so a lookup on a plain object
// literal returns an inherited property for keys like `__proto__` or
// `constructor` instead of `undefined` — this line removes every inherited
// property so a lookup here can only ever return one of the entries above,
// or `undefined`.
Object.setPrototypeOf(COLUMN_NAME_MAPPING, null);

// objects.csv keys mapped to first-class D1 columns; any other column is
// preserved verbatim in `extra_columns` (custom-column passthrough).
//
// Every key here is consumed by the mapper, so none of them reaches
// `extra_columns` and none is republished as a custom column of its own. That
// is the constraint the set exists to hold: a modelled name left out of it is
// stored twice — once in its field, once in the passthrough blob — and
// published as two columns the framework then folds onto one name.
//
// `object_type` is absent because the header now renames onto `medium_genre`
// before the mapper sees it. `iiif_manifest` is present without being a field
// of its own: the mapper reads it as the fallback source of `source_url` and
// only `source_url` is ever written back out.
export const KNOWN_OBJECT_KEYS = new Set([
  "object_id", "title", "featured", "creator", "description", "source_url",
  "iiif_manifest", "period", "year", "medium_genre", "subjects", "source",
  "credit", "thumbnail", "alt_text", "dimensions",
]);

/**
 * The objects keys whose D1 column holds text, and so can receive a value
 * lifted out of an `extra_columns` blob.
 *
 * Derived from the registry's own `d1.type`, never listed. A blob value is a
 * CSV cell, which is text; writing one into a column the rest of the system
 * reads as a boolean plants a string where a flag belongs, and the snapshot's
 * flag validator then refuses the whole object's UPDATE — every later edit to
 * that object stops reaching D1. `featured` is the case that exists.
 */
export const TEXT_OBJECT_KEYS: ReadonlySet<string> = new Set(
  FIELD_REGISTRY.filter((decl) => decl.entity === "objects")
    .flatMap((decl) => decl.fields)
    .filter((field) => !isExcluded(field.d1) && field.d1.type === "text")
    .map((field) => (field.d1 as { column: string }).column),
);

/**
 * Objects keys a value is never lifted into from a passthrough blob, whatever
 * their column type.
 *
 * `object_id` is the row's identity: every other table references an object by
 * it, the published file is keyed by it, and the sync diff matches rows on it.
 * A blob carrying `id_objeto` against a blank id would rename the row to
 * whatever the blob said — repairing identity from a passthrough column, which
 * is the one thing a repair must never do. It is excluded here rather than by
 * type, because it IS a text column and would otherwise qualify.
 */
export const NEVER_PROMOTED_OBJECT_FIELDS: ReadonlySet<string> = new Set(["object_id"]);

/** The objects keys a blob value may actually be written into. */
export const PROMOTABLE_OBJECT_FIELDS: ReadonlySet<string> = new Set(
  [...TEXT_OBJECT_KEYS].filter((key) => !NEVER_PROMOTED_OBJECT_FIELDS.has(key)),
);

/**
 * How each objects field is represented in the Y.Doc, by D1 column name.
 *
 * A field's representation is a property of the FIELD, not of whatever happens
 * to occupy its key: a document that predates the key has nothing there at
 * all, and a repair that took its cue from the occupant would write a plain
 * string where the editor expects a Y.Text. `getYText` returns null for
 * anything that is not one, so the editor would read the field as absent and
 * keep every later edit local.
 */
export const OBJECT_FIELD_YDOC_KIND: Record<string, "ytext" | "plain"> = Object.create(null);
for (const field of YDOC_FIELDS.objects) {
  if (field.column === null) continue;
  OBJECT_FIELD_YDOC_KIND[field.column] = field.kind;
}



/** `str.strip()` as CPython performs it; a header fold has to strip what Python strips. */
export { pythonStrip };

/**
 * The identity of a header: the form every place in the Compositor that
 * decides what a column IS compares it under.
 *
 * It is CPython's fold because the framework's is. A published CSV is read by
 * a pandas pipeline that folds each header with `str(col).lower().strip()`, so
 * a header the two sides fold differently has two identities at once — the
 * framework reads `title` where the Compositor reads a custom column, leaves
 * the field unset, and republishes that column beside its own generated
 * `title`, two columns claiming one canonical name in a file the framework
 * then refuses to build. One function, so the two can only be the same fold.
 *
 * Lowered as the build's Python 3.11 lowers (`pythonLower`), not as
 * JavaScript does: the two part on letters Unicode added after 14.0, and a
 * header holding one would fold here to a name the build never gives it.
 */
export function foldHeader(header: string): string {
  return pythonStrip(pythonLower(header));
}

// ---------------------------------------------------------------------------
// The fixed columns each sheet is published with, in canonical order. Here
// rather than beside their serializers, which import import.server.ts: the
// import names the headings a publish rewrites from the same lists.
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

export const PROJECT_CSV_COLUMNS = [
  "order",
  "story_id",
  "title",
  "subtitle",
  "byline",
  "private",
  "show_sections",
] as const;

export const STORY_CSV_COLUMNS = [
  "step",
  "object",
  "x",
  "y",
  "zoom",
  "page",
  "question",
  "answer",
  "alt_text",
  "layer1_button",
  "layer1_content",
  "layer2_button",
  "layer2_content",
  "clip_start",
  "clip_end",
  "loop",
] as const;

export const GLOSSARY_CSV_COLUMNS = ["term_id", "title", "definition", "related_terms"] as const;
