/**
 * Field registry — the single declarative statement of where every content
 * field lives and how it moves between the compositor's six subsystems: the
 * D1 schema, the Y.Doc (client factories, DO cold-build, snapshot writeback,
 * restore payload), publish serialization, import parsing, sync diffing, and
 * entity hashing.
 *
 * The registry exists to kill one bug class: a field added to some subsystems
 * but not others fails silently (data resets, repo edits become invisible,
 * restores drop content). Seven gaps of exactly that shape were found and
 * fixed on 2026-07-07; the coverage suite generated from these declarations
 * (tests/field-registry-*.test.ts) is what keeps the class from returning.
 *
 * Reading a declaration: every axis is stated for every field, and
 * non-participation is always `{ excluded, reason }` — never an omitted key.
 * Where a field deviates from full Y.Doc residence in one specific mechanism
 * (cold-load, insert, update, writeback), the deviation is declared on that
 * mechanism with its reason; the coverage suite derives the mechanical
 * obligations from what is declared here.
 *
 * This module is pure data with no imports so both the app and the
 * collaboration Durable Object can consume it, and it is deliberately not a
 * `.server.ts` module: the client-side Y.Map factories are among its coverage
 * targets. Infrastructure fields (`_id`, `_temp_id`, `_validation_state`,
 * `created_by`, timestamps, relational FKs) and non-content tables are out of
 * scope by design — see the field-registry design doc.
 *
 * @version v1.5.0-beta
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Excluded {
  excluded: true;
  reason: string;
}

/**
 * Encoding tokens name the transform a value undergoes at a boundary. The
 * generic tokens are implemented by the coverage suite's round-trip harness;
 * the STRUCTURAL_ENCODINGS are shape-level encodings (file presence, row
 * order, cell pairing) that the generic harness does not implement — fields
 * using them are pinned by dedicated tests instead, named in comments at the
 * declaration site.
 */
export type EncodingToken =
  | "verbatim"
  | "yes-empty" // publish: boolean -> "yes" | ""
  | "bool-yes-true-si" // import whitelist: yes/true/sí/si ("1" rejected)
  | "bool-yes-true-si-1" // import whitelist: yes/true/sí/si/1
  | "int"
  | "float"
  | "viewer-gated-float" // publish: empty unless media step with an object; defaults 0.5/0.5/1
  | "page-normalized" // publish: value "1" emitted as empty
  | "quoted-yaml"
  | "unquoted-yaml"
  | "unquoted-bool"
  | "unquoted-int"
  | "json-spread-columns" // extra_columns: JSON blob <-> individual custom CSV columns
  | "filename-ref" // layer content: CSV cell holds the .md filename; body lives in the file
  | "frontmatter"
  | "frontmatter-of-cell" // layer title: extracted from the content cell's frontmatter on import
  | "frontmatter-block" // page front matter: the whole block between the fences, kept verbatim
  | "md-body"
  | "filename" // page slug: encoded as the .md filename
  | "file-presence" // story draft: file present but absent from project.csv
  | "empty-object-cell" // step kind: section encoded as an empty object cell
  | "layer-cell" // which layerN_* column pair a layer occupies
  | "tree-index" // page order: position in the repo tree scan
  | "navigation-yml" // navigation: structural _data/navigation.yml emission
  | "glossary-kinds-yml"; // glossary kinds: a JSON list written as glossary.kinds in _config.yml

export const STRUCTURAL_ENCODINGS: ReadonlySet<EncodingToken> = new Set([
  "file-presence",
  "empty-object-cell",
  "layer-cell",
  "tree-index",
  "navigation-yml",
  "glossary-kinds-yml",
  "filename",
  "frontmatter-of-cell",
  "frontmatter-block",
  "json-spread-columns",
  "filename-ref",
] as EncodingToken[]);

export type PublishFile =
  | "project.csv"
  | "story.csv"
  | "objects.csv"
  | "glossary.csv"
  | "_config.yml"
  | "index.md"
  | "page.md"
  | "layer.md"
  | "navigation.yml";

export type SyncDiff = "objects" | "storyFields" | "config" | "glossary";

export type HashBucket =
  | "objects"
  | "stories"
  | "pages"
  | "glossary"
  | "navigation"
  | "landing"
  | "settings";

export interface YdocDecl {
  key: string;
  kind: "ytext" | "plain";
  /** DO cold-build does not load this key from D1 (D1 stays authoritative). */
  coldLoad?: Excluded;
  /**
   * Snapshot insert deviates from binding the Y value: either excluded
   * entirely, or the surviving D1 row's value is preferred over the Y copy.
   */
  insert?: Excluded | { preserveFromD1: true; reason: string };
  /** Snapshot UPDATE omits this column (preserved by omission). */
  update?: Excluded;
  /** The snapshot never writes this key back to D1 at all. */
  writeback?: Excluded;
  /**
   * The client Y.Map factory deliberately never sets this key, so the field's
   * absence — not a null value — is the meaningful state for a client-created
   * entity. Excludes the field from the factory key-set probes.
   */
  factory?: Excluded;
  /**
   * /restore-orphans and /ingest-sync do not carry this key from the payload;
   * the DO mints it as it builds the Y.Map. Ordering is the only case: a repo
   * file has no order_key to send, and the sequence the payload arrives in is
   * the order, so the DO appends each entry after the last.
   */
  restore?: Excluded;
}

export interface FieldDecl {
  /** Canonical name = the D1 column name. */
  name: string;
  d1: { column: string; type: "text" | "int" | "bool" | "real" | "json" };
  ydoc: YdocDecl | (Excluded & { preserveFromD1?: true });
  publish:
    | {
        file: PublishFile;
        /** EN column / YAML key / frontmatter key ("(...)" for structural). */
        key: string;
        /** Spanish bilingual header-row value, where the file has one. */
        esKey?: string;
        encoding: EncodingToken;
      }
    | Excluded;
  import:
    | {
        /** Every accepted header/YAML path, EN + ES + legacy aliases. */
        headers: string[];
        encoding: EncodingToken;
      }
    | Excluded;
  sync:
    | {
        diff: SyncDiff;
        /** Diff key rather than compared field (story_id, object_id, term_id). */
        role?: "key";
        /** Sync item property when it differs from the canonical name. */
        itemKey?: string;
        /** _config.yml key when it differs from the canonical name. */
        yamlKey?: string;
      }
    | Excluded;
  hash: { bucket: HashBucket } | Excluded;
}

export interface EntityDecl {
  entity:
    | "stories"
    | "steps"
    | "layers"
    | "objects"
    | "pages"
    | "glossary"
    | "config"
    | "landing";
  /** Entity-level notes on where its Y.Doc lives, for coverage harnesses. */
  ydocLocation: string;
  fields: FieldDecl[];
}

// ---------------------------------------------------------------------------
// Shared exclusion reasons
// ---------------------------------------------------------------------------

const STEP_LAYER_NO_SYNC: Excluded = {
  excluded: true,
  reason:
    "Steps and layers have no per-field sync; full sync imports them only for insertNew stories.",
};

const PAGES_NO_SYNC: Excluded = {
  excluded: true,
  reason:
    "Sync module scope is objects/stories/config/glossary; pages are imported only at initial import or the Pages editor's empty-state import.",
};

const LANDING_NO_SYNC: Excluded = {
  excluded: true,
  reason: "Sync module scope is objects/stories/config/glossary; landing has no sync path.",
};

const INTERNAL_STATE = (what: string): Excluded => ({
  excluded: true,
  reason: `Compositor-internal state (${what}); never published, so never part of change detection.`,
});

// ---------------------------------------------------------------------------
// Stories  (stories table <-> Y root array "stories" <-> project.csv row)
// ---------------------------------------------------------------------------

const stories: EntityDecl = {
  entity: "stories",
  ydocLocation: 'Y root array "stories" of Y.Maps',
  fields: [
    {
      name: "story_id",
      d1: { column: "story_id", type: "text" },
      ydoc: { key: "story_id", kind: "plain" },
      // Also drives the per-story CSV filename telar-content/spreadsheets/{story_id}.csv.
      publish: { file: "project.csv", key: "story_id", esKey: "id_historia", encoding: "verbatim" },
      import: { headers: ["story_id", "id_historia"], encoding: "verbatim" },
      sync: { diff: "storyFields", role: "key" },
      hash: { bucket: "stories" },
    },
    {
      name: "title",
      d1: { column: "title", type: "text" },
      ydoc: { key: "title", kind: "ytext" },
      publish: { file: "project.csv", key: "title", esKey: "titulo", encoding: "verbatim" },
      import: { headers: ["title", "titulo", "título"], encoding: "verbatim" },
      sync: { diff: "storyFields" },
      hash: { bucket: "stories" },
    },
    {
      name: "subtitle",
      d1: { column: "subtitle", type: "text" },
      ydoc: { key: "subtitle", kind: "ytext" },
      publish: { file: "project.csv", key: "subtitle", esKey: "subtitulo", encoding: "verbatim" },
      import: { headers: ["subtitle", "subtitulo"], encoding: "verbatim" },
      sync: { diff: "storyFields" },
      hash: { bucket: "stories" },
    },
    {
      name: "byline",
      d1: { column: "byline", type: "text" },
      ydoc: { key: "byline", kind: "ytext" },
      publish: { file: "project.csv", key: "byline", esKey: "firma", encoding: "verbatim" },
      import: { headers: ["byline", "firma"], encoding: "verbatim" },
      sync: { diff: "storyFields" },
      hash: { bucket: "stories" },
    },
    {
      // The published rank. The snapshot derives it from the story's position
      // in order_key order, so published rows sort by it (stories order IS
      // publishable, unlike objects). Pinned by the snapshot characterization
      // tests.
      name: "order",
      d1: { column: "order", type: "int" },
      ydoc: {
        excluded: true,
        reason:
          "Derived at snapshot time from the rank in order_key order. The document carries order_key and nothing else, so there is no second copy of the ordering to fall out of step with it.",
      },
      publish: { file: "project.csv", key: "order", esKey: "orden", encoding: "int" },
      import: { headers: ["order", "orden"], encoding: "int" },
      sync: {
        excluded: true,
        reason:
          "Deliberate: 0-based import order vs 1-based CSV order produced false positives (comment at the storyFields site).",
      },
      hash: { bucket: "stories" },
    },
    {
      // Where the story actually sorts: a base-62 fractional index
      // (app/lib/order-key.ts). A story moves by writing this one field, so a
      // reorder removes nothing from the stories Y.Array and the own-content
      // delete rule never has to judge whether a drag was really a drag.
      name: "order_key",
      d1: { column: "order_key", type: "text" },
      ydoc: { key: "order_key", kind: "plain" },
      publish: {
        excluded: true,
        reason:
          "Compositor-internal ordering mechanism; project.csv publishes the dense `order` rank derived from it.",
      },
      import: {
        excluded: true,
        reason:
          "No repo representation to import from; a freshly imported story is given a key at the end of the list.",
      },
      sync: {
        excluded: true,
        reason:
          "No repo representation, so nothing to three-way merge; ordering changes reach sync through `order`.",
      },
      hash: {
        excluded: true,
        reason:
          "A reorder already shows as an unpublished change through `order`, which is in the stories bucket; hashing both would double-count it.",
      },
    },
    {
      name: "private",
      d1: { column: "private", type: "bool" },
      ydoc: { key: "private", kind: "plain" },
      publish: { file: "project.csv", key: "private", esKey: "privada", encoding: "yes-empty" },
      import: {
        headers: ["private", "privada", "privado", "protegida"],
        encoding: "bool-yes-true-si",
      },
      sync: { diff: "storyFields", itemKey: "isPrivate" },
      hash: { bucket: "stories" },
    },
    {
      // Encoded as membership: the per-story CSV exists for ALL stories; a
      // draft is a story file absent from project.csv. Pinned by the
      // orphans-are-drafts publish tests.
      name: "draft",
      d1: { column: "draft", type: "bool" },
      ydoc: { key: "draft", kind: "plain" },
      publish: { file: "project.csv", key: "(membership)", encoding: "file-presence" },
      import: {
        excluded: true,
        reason:
          "Never set by mapProjectCsv; the orphan-restore path sets draft = true for stories restored from orphaned files.",
      },
      sync: { excluded: true, reason: "Draft is compositor-side state; not compared." },
      hash: {
        excluded: true,
        reason:
          "Drafts are excluded from the stories hash bucket; draft-file changes are tracked separately via all_story_ids/fileChanges.",
      },
    },
    {
      name: "show_sections",
      d1: { column: "show_sections", type: "bool" },
      ydoc: { key: "show_sections", kind: "plain" },
      publish: {
        file: "project.csv",
        key: "show_sections",
        esKey: "mostrar_secciones",
        encoding: "yes-empty",
      },
      import: { headers: ["show_sections", "mostrar_secciones"], encoding: "bool-yes-true-si" },
      sync: { diff: "storyFields", itemKey: "showSections" },
      hash: { bucket: "stories" },
    },
    {
      // The custom project.csv columns, as the glossary's passthrough: D1 owns
      // it alone because the compositor has no editor for a custom column.
      // The snapshot UPDATE omits it and the story INSERT binds none, so a
      // story made in the compositor has no custom cells and publishes them
      // blank. Sync and hash compare the canonicalized (keys-sorted) form.
      name: "extra_columns",
      d1: { column: "extra_columns", type: "json" },
      ydoc: {
        excluded: true,
        reason:
          "Never in the Y.Doc — the compositor has no editor for a custom column; the snapshot UPDATE omits it, so D1's value stands.",
        preserveFromD1: true,
      },
      publish: {
        file: "project.csv",
        key: "(custom columns)",
        encoding: "json-spread-columns",
      },
      import: { headers: [], encoding: "json-spread-columns" },
      sync: { diff: "storyFields", itemKey: "extraColumns" },
      hash: { bucket: "stories" },
    },
  ],
};

// ---------------------------------------------------------------------------
// Steps  (steps table <-> Y.Maps in story.steps Y.Array <-> {story_id}.csv row)
// ---------------------------------------------------------------------------

const steps: EntityDecl = {
  entity: "steps",
  ydocLocation: 'Y.Maps inside each story Y.Map\'s "steps" Y.Array',
  fields: [
    {
      // Snapshot normalizes to array index + 1; published rows are sorted.
      name: "step_number",
      d1: { column: "step_number", type: "int" },
      ydoc: { key: "step_number", kind: "plain" },
      publish: { file: "story.csv", key: "step", esKey: "paso", encoding: "int" },
      import: { headers: ["step", "paso"], encoding: "int" },
      sync: STEP_LAYER_NO_SYNC,
      hash: { bucket: "stories" },
    },
    {
      // A section is encoded as a meaningful row with an EMPTY object cell;
      // import derives kind the same way. Pinned by serializeStory tests.
      name: "kind",
      d1: { column: "kind", type: "text" },
      ydoc: { key: "kind", kind: "plain" },
      publish: { file: "story.csv", key: "(object cell)", encoding: "empty-object-cell" },
      import: { headers: ["object", "objeto"], encoding: "empty-object-cell" },
      sync: STEP_LAYER_NO_SYNC,
      hash: { bucket: "stories" },
    },
    {
      name: "object_id",
      d1: { column: "object_id", type: "text" },
      ydoc: { key: "object_id", kind: "plain" },
      publish: { file: "story.csv", key: "object", esKey: "objeto", encoding: "verbatim" },
      import: { headers: ["object", "objeto"], encoding: "verbatim" },
      sync: STEP_LAYER_NO_SYNC,
      hash: { bucket: "stories" },
    },
    {
      name: "x",
      d1: { column: "x", type: "real" },
      ydoc: { key: "x", kind: "plain" },
      publish: { file: "story.csv", key: "x", esKey: "x", encoding: "viewer-gated-float" },
      import: { headers: ["x"], encoding: "float" },
      sync: STEP_LAYER_NO_SYNC,
      hash: { bucket: "stories" },
    },
    {
      name: "y",
      d1: { column: "y", type: "real" },
      ydoc: { key: "y", kind: "plain" },
      publish: { file: "story.csv", key: "y", esKey: "y", encoding: "viewer-gated-float" },
      import: { headers: ["y"], encoding: "float" },
      sync: STEP_LAYER_NO_SYNC,
      hash: { bucket: "stories" },
    },
    {
      name: "zoom",
      d1: { column: "zoom", type: "real" },
      ydoc: { key: "zoom", kind: "plain" },
      publish: { file: "story.csv", key: "zoom", esKey: "zoom", encoding: "viewer-gated-float" },
      import: { headers: ["zoom"], encoding: "float" },
      sync: STEP_LAYER_NO_SYNC,
      hash: { bucket: "stories" },
    },
    {
      name: "page",
      d1: { column: "page", type: "text" },
      ydoc: { key: "page", kind: "plain" },
      publish: { file: "story.csv", key: "page", esKey: "pagina", encoding: "page-normalized" },
      import: { headers: ["page", "pagina", "página"], encoding: "verbatim" },
      sync: STEP_LAYER_NO_SYNC,
      hash: { bucket: "stories" },
    },
    {
      // Doubles as the section-card heading for section steps.
      name: "question",
      d1: { column: "question", type: "text" },
      ydoc: { key: "question", kind: "ytext" },
      publish: { file: "story.csv", key: "question", esKey: "pregunta", encoding: "verbatim" },
      import: { headers: ["question", "pregunta"], encoding: "verbatim" },
      sync: STEP_LAYER_NO_SYNC,
      hash: { bucket: "stories" },
    },
    {
      name: "answer",
      d1: { column: "answer", type: "text" },
      ydoc: { key: "answer", kind: "ytext" },
      publish: { file: "story.csv", key: "answer", esKey: "respuesta", encoding: "verbatim" },
      import: { headers: ["answer", "respuesta"], encoding: "verbatim" },
      sync: STEP_LAYER_NO_SYNC,
      hash: { bucket: "stories" },
    },
    {
      name: "alt_text",
      d1: { column: "alt_text", type: "text" },
      ydoc: { key: "alt_text", kind: "ytext" },
      publish: { file: "story.csv", key: "alt_text", esKey: "texto_alt", encoding: "verbatim" },
      import: { headers: ["alt_text", "texto_alt"], encoding: "verbatim" },
      sync: STEP_LAYER_NO_SYNC,
      hash: { bucket: "stories" },
    },
    {
      name: "clip_start",
      d1: { column: "clip_start", type: "text" },
      ydoc: { key: "clip_start", kind: "plain" },
      publish: { file: "story.csv", key: "clip_start", esKey: "inicio_clip", encoding: "verbatim" },
      import: { headers: ["clip_start", "inicio_clip"], encoding: "verbatim" },
      sync: STEP_LAYER_NO_SYNC,
      hash: { bucket: "stories" },
    },
    {
      name: "clip_end",
      d1: { column: "clip_end", type: "text" },
      ydoc: { key: "clip_end", kind: "plain" },
      publish: { file: "story.csv", key: "clip_end", esKey: "fin_clip", encoding: "verbatim" },
      import: { headers: ["clip_end", "fin_clip"], encoding: "verbatim" },
      sync: STEP_LAYER_NO_SYNC,
      hash: { bucket: "stories" },
    },
    {
      name: "loop",
      d1: { column: "loop", type: "text" },
      ydoc: { key: "loop", kind: "plain" },
      publish: { file: "story.csv", key: "loop", esKey: "bucle", encoding: "verbatim" },
      import: { headers: ["loop", "bucle"], encoding: "verbatim" },
      sync: STEP_LAYER_NO_SYNC,
      hash: { bucket: "stories" },
    },
    {
      // JSON blob spread as individual custom CSV columns, after the fixed
      // ones, in the order they first appear across the story's steps. The
      // hash compares the canonicalized (keys-sorted) form, and only when the
      // step has any, so a story without kept columns hashes as if the field
      // did not exist.
      name: "extra_columns",
      d1: { column: "extra_columns", type: "json" },
      ydoc: { key: "extra_columns", kind: "plain" },
      publish: {
        file: "story.csv",
        key: "(custom columns)",
        encoding: "json-spread-columns",
      },
      import: { headers: [], encoding: "json-spread-columns" },
      sync: STEP_LAYER_NO_SYNC,
      hash: { bucket: "stories" },
    },
    {
      // Where the step actually sorts: a base-62 fractional index
      // (app/lib/order-key.ts). A step moves by writing this one field, so a
      // reorder removes nothing from the story's steps Y.Array and the
      // own-content delete rule never has to judge whether a drag was a drag.
      name: "order_key",
      d1: { column: "order_key", type: "text" },
      ydoc: {
        key: "order_key",
        kind: "plain",
        restore: {
          excluded: true,
          reason:
            "No order_key travels in a restore/ingest payload — a repo file carries no key. The DO mints one per entry, appending in the order the payload arrives, which IS the order the file expressed.",
        },
      },
      publish: {
        excluded: true,
        reason:
          "Compositor-internal ordering mechanism; story.csv publishes the dense `step` number derived from it.",
      },
      import: {
        excluded: true,
        reason:
          "No repo representation to import from; an imported step is given a key at the end of its story's list.",
      },
      sync: STEP_LAYER_NO_SYNC,
      hash: {
        excluded: true,
        reason:
          "A reorder already shows as an unpublished change through `step_number`, which is in the stories bucket; hashing both would double-count it.",
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Layers  (layers table <-> Y.Maps in step.layers Y.Array <-> layerN_* cells + .md file)
// ---------------------------------------------------------------------------

const layers: EntityDecl = {
  entity: "layers",
  ydocLocation: 'Y.Maps inside each step Y.Map\'s "layers" Y.Array',
  fields: [
    {
      // Encoded as WHICH layer1_*/layer2_* cell pair the layer occupies;
      // snapshot normalizes to array index + 1.
      name: "layer_number",
      d1: { column: "layer_number", type: "int" },
      ydoc: { key: "layer_number", kind: "plain" },
      publish: { file: "story.csv", key: "(cell pair)", encoding: "layer-cell" },
      import: { headers: [], encoding: "layer-cell" },
      sync: STEP_LAYER_NO_SYNC,
      hash: { bucket: "stories" },
    },
    {
      // Also drives the layer filename {slug}-{slugify(title)}.md, with a
      // {slug}-step{N}-layer{N}.md collision fallback.
      name: "title",
      d1: { column: "title", type: "text" },
      ydoc: { key: "title", kind: "ytext" },
      publish: { file: "layer.md", key: "title", encoding: "frontmatter" },
      import: { headers: [], encoding: "frontmatter-of-cell" },
      sync: STEP_LAYER_NO_SYNC,
      hash: { bucket: "stories" },
    },
    {
      name: "button_label",
      d1: { column: "button_label", type: "text" },
      ydoc: { key: "button_label", kind: "ytext" },
      publish: {
        file: "story.csv",
        key: "layer{n}_button",
        esKey: "boton{n}",
        encoding: "layer-cell",
      },
      import: {
        headers: [
          "layer1_button",
          "layer2_button",
          "boton1",
          "boton2",
          "boton_capa1",
          "boton_capa2",
        ],
        encoding: "verbatim",
      },
      sync: STEP_LAYER_NO_SYNC,
      hash: { bucket: "stories" },
    },
    {
      // The CSV layer{n}_content cell holds the FILENAME of a markdown file
      // under telar-content/texts/stories/; the layer body is that file's
      // content. Import resolves .md-suffixed cells via
      // resolveLayerFileReferences; inline cells keep working.
      name: "content",
      d1: { column: "content", type: "text" },
      ydoc: { key: "content", kind: "ytext" },
      publish: { file: "layer.md", key: "(body)", encoding: "filename-ref" },
      import: {
        headers: [
          "layer1_content",
          "layer2_content",
          "contenido1",
          "contenido2",
          "contenido_capa1",
          "contenido_capa2",
          "archivo_capa1",
          "archivo_capa2",
          "layer1_file",
          "layer2_file",
        ],
        encoding: "filename-ref",
      },
      sync: STEP_LAYER_NO_SYNC,
      hash: { bucket: "stories" },
    },
    {
      // Where the layer sorts within its step. `layer_number` remains the
      // published slot (which layer{n}_* cell pair it occupies) and is the
      // dense rank derived from this key at snapshot time.
      name: "order_key",
      d1: { column: "order_key", type: "text" },
      ydoc: {
        key: "order_key",
        kind: "plain",
        restore: {
          excluded: true,
          reason:
            "No order_key travels in a restore/ingest payload — a repo file carries no key. The DO mints one per entry, appending in the order the payload arrives, which IS the order the file expressed.",
        },
      },
      publish: {
        excluded: true,
        reason:
          "Compositor-internal ordering mechanism; story.csv encodes the layer's slot through the dense `layer_number` derived from it.",
      },
      import: {
        excluded: true,
        reason:
          "No repo representation to import from; an imported layer is given a key at the end of its step's list.",
      },
      sync: STEP_LAYER_NO_SYNC,
      hash: {
        excluded: true,
        reason:
          "A reorder already shows as an unpublished change through `layer_number`, which is in the stories bucket; hashing both would double-count it.",
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Objects  (objects table <-> Y root array "objects" <-> objects.csv row)
// ---------------------------------------------------------------------------

const objects: EntityDecl = {
  entity: "objects",
  ydocLocation: 'Y root array "objects" of Y.Maps',
  fields: [
    {
      name: "object_id",
      d1: { column: "object_id", type: "text" },
      ydoc: { key: "object_id", kind: "plain" },
      publish: { file: "objects.csv", key: "object_id", esKey: "id_objeto", encoding: "verbatim" },
      import: { headers: ["object_id", "id_objeto"], encoding: "verbatim" },
      sync: { diff: "objects", role: "key" },
      hash: { bucket: "objects" },
    },
    {
      name: "title",
      d1: { column: "title", type: "text" },
      ydoc: { key: "title", kind: "ytext" },
      publish: { file: "objects.csv", key: "title", esKey: "titulo", encoding: "verbatim" },
      import: { headers: ["title", "titulo", "título"], encoding: "verbatim" },
      sync: { diff: "objects" },
      hash: { bucket: "objects" },
    },
    {
      name: "featured",
      d1: { column: "featured", type: "bool" },
      ydoc: { key: "featured", kind: "plain" },
      publish: { file: "objects.csv", key: "featured", esKey: "destacado", encoding: "yes-empty" },
      import: { headers: ["featured", "destacado"], encoding: "bool-yes-true-si-1" },
      sync: { diff: "objects" },
      hash: { bucket: "objects" },
    },
    {
      name: "creator",
      d1: { column: "creator", type: "text" },
      ydoc: { key: "creator", kind: "ytext" },
      publish: { file: "objects.csv", key: "creator", esKey: "creador", encoding: "verbatim" },
      import: { headers: ["creator", "creador"], encoding: "verbatim" },
      sync: { diff: "objects" },
      hash: { bucket: "objects" },
    },
    {
      name: "description",
      d1: { column: "description", type: "text" },
      ydoc: { key: "description", kind: "ytext" },
      publish: {
        file: "objects.csv",
        key: "description",
        esKey: "descripcion",
        encoding: "verbatim",
      },
      import: { headers: ["description", "descripcion", "descripción"], encoding: "verbatim" },
      sync: { diff: "objects" },
      hash: { bucket: "objects" },
    },
    {
      name: "source_url",
      d1: { column: "source_url", type: "text" },
      ydoc: { key: "source_url", kind: "plain" },
      publish: {
        file: "objects.csv",
        key: "source_url",
        esKey: "url_fuente",
        encoding: "verbatim",
      },
      import: { headers: ["source_url", "url_fuente"], encoding: "verbatim" },
      sync: { diff: "objects" },
      hash: { bucket: "objects" },
    },
    {
      name: "period",
      d1: { column: "period", type: "text" },
      ydoc: { key: "period", kind: "ytext" },
      publish: { file: "objects.csv", key: "period", esKey: "periodo", encoding: "verbatim" },
      import: { headers: ["period", "periodo"], encoding: "verbatim" },
      sync: { diff: "objects" },
      hash: { bucket: "objects" },
    },
    {
      name: "year",
      d1: { column: "year", type: "text" },
      ydoc: { key: "year", kind: "ytext" },
      publish: { file: "objects.csv", key: "year", esKey: "año", encoding: "verbatim" },
      import: { headers: ["year", "año", "ano"], encoding: "verbatim" },
      sync: { diff: "objects" },
      hash: { bucket: "objects" },
    },
    {
      // The registry's longest alias chain: D1/Y `object_type` <-> CSV
      // `medium_genre` (framework v1.0.0 rename) <-> Spanish aliases <->
      // legacy CSV `object_type` read as a mapper fallback.
      name: "object_type",
      d1: { column: "object_type", type: "text" },
      ydoc: { key: "object_type", kind: "ytext" },
      publish: {
        file: "objects.csv",
        key: "medium_genre",
        esKey: "medio_genero",
        encoding: "verbatim",
      },
      import: {
        headers: ["medium_genre", "medio", "medio_genero", "tipo_objeto", "object_type"],
        encoding: "verbatim",
      },
      sync: { diff: "objects" },
      hash: { bucket: "objects" },
    },
    {
      name: "subjects",
      d1: { column: "subjects", type: "text" },
      ydoc: { key: "subjects", kind: "ytext" },
      publish: { file: "objects.csv", key: "subjects", esKey: "temas", encoding: "verbatim" },
      import: { headers: ["subjects", "temas", "materias", "materia"], encoding: "verbatim" },
      sync: { diff: "objects" },
      hash: { bucket: "objects" },
    },
    {
      name: "source",
      d1: { column: "source", type: "text" },
      ydoc: { key: "source", kind: "ytext" },
      publish: { file: "objects.csv", key: "source", esKey: "fuente", encoding: "verbatim" },
      import: {
        headers: ["source", "fuente", "ubicacion", "ubicación", "location"],
        encoding: "verbatim",
      },
      sync: { diff: "objects" },
      hash: { bucket: "objects" },
    },
    {
      name: "credit",
      d1: { column: "credit", type: "text" },
      ydoc: { key: "credit", kind: "ytext" },
      publish: { file: "objects.csv", key: "credit", esKey: "credito", encoding: "verbatim" },
      import: { headers: ["credit", "credito"], encoding: "verbatim" },
      sync: { diff: "objects" },
      hash: { bucket: "objects" },
    },
    {
      name: "thumbnail",
      d1: { column: "thumbnail", type: "text" },
      ydoc: { key: "thumbnail", kind: "plain" },
      publish: { file: "objects.csv", key: "thumbnail", esKey: "miniatura", encoding: "verbatim" },
      import: { headers: ["thumbnail", "miniatura"], encoding: "verbatim" },
      sync: { diff: "objects" },
      hash: { bucket: "objects" },
    },
    {
      // Import falls back to the title when the cell is blank (survive-import
      // fix); the sync diff compares the RAW cell so that fallback cannot
      // fabricate a repo-side edit.
      name: "alt_text",
      d1: { column: "alt_text", type: "text" },
      ydoc: { key: "alt_text", kind: "ytext" },
      publish: { file: "objects.csv", key: "alt_text", esKey: "texto_alt", encoding: "verbatim" },
      import: { headers: ["alt_text", "texto_alt"], encoding: "verbatim" },
      sync: { diff: "objects" },
      hash: { bucket: "objects" },
    },
    {
      name: "dimensions",
      d1: { column: "dimensions", type: "text" },
      ydoc: { key: "dimensions", kind: "plain" },
      publish: {
        file: "objects.csv",
        key: "dimensions",
        esKey: "dimensiones",
        encoding: "verbatim",
      },
      import: { headers: ["dimensions", "dimensiones"], encoding: "verbatim" },
      sync: { diff: "objects" },
      hash: { bucket: "objects" },
    },
    {
      // JSON blob spread as individual custom CSV columns (sorted union).
      // Sync and hash both compare the canonicalized (keys-sorted) form via
      // the shared extra-columns module, so serialization order can never
      // fabricate a diff.
      name: "extra_columns",
      d1: { column: "extra_columns", type: "json" },
      ydoc: { key: "extra_columns", kind: "plain" },
      publish: {
        file: "objects.csv",
        key: "(custom columns)",
        encoding: "json-spread-columns",
      },
      import: { headers: [], encoding: "json-spread-columns" },
      sync: { diff: "objects" },
      hash: { bucket: "objects" },
    },
    {
      name: "image_available",
      d1: { column: "image_available", type: "bool" },
      ydoc: { key: "image_available", kind: "plain" },
      publish: INTERNAL_STATE("live-site availability probe result"),
      import: {
        excluded: true,
        reason:
          "Computed by the live-site probe during import, not read from any CSV cell (mapObjectsCsv sets false).",
      },
      sync: {
        excluded: true,
        reason:
          "Never diffed or offered for review; on a site with no base the tile probe may ask, the objects apply and the full sync recompute it from the repo tree and send it through the ingest. Probe/sync-derived state.",
      },
      hash: INTERNAL_STATE("live-site availability probe result"),
    },
    {
      name: "missing_from_repo",
      d1: { column: "missing_from_repo", type: "bool" },
      ydoc: {
        key: "missing_from_repo",
        kind: "plain",
        coldLoad: {
          excluded: true,
          reason: "Sync owns this flag; D1 stays authoritative, the Y copy is factory-seeded false.",
        },
        insert: {
          excluded: true,
          reason:
            "Insert defaults it to 0 deliberately — sync re-derives the flag on its next pass (documented at the insert site).",
        },
        update: { excluded: true, reason: "Preserved by omission; sync writes it directly to D1." },
      },
      publish: INTERNAL_STATE("sync-derived missing-object flag"),
      import: { excluded: true, reason: "Schema default false; sync derives the real value." },
      sync: {
        excluded: true,
        reason:
          "WRITTEN by sync (flag/clear on repo-tree membership), not diffed as a field.",
      },
      hash: INTERNAL_STATE("sync-derived missing-object flag"),
    },
    {
      name: "origin",
      d1: { column: "origin", type: "text" },
      ydoc: {
        key: "origin",
        kind: "plain",
        coldLoad: {
          excluded: true,
          reason:
            "Factory-set at creation ('iiif'/'compositor'); D1 authoritative afterwards, never edited.",
        },
        insert: {
          preserveFromD1: true,
          reason:
            "A stale-_id re-INSERT must carry the surviving row's origin forward, not reset to the 'iiif' default (pinned by snapshot-preserve-d1-columns.test.ts).",
        },
        update: { excluded: true, reason: "Preserved by omission on the snapshot UPDATE." },
      },
      publish: INTERNAL_STATE("object provenance classifier"),
      import: { excluded: true, reason: "Importer rows take the schema default 'repo'." },
      sync: {
        excluded: true,
        reason:
          "Consumed by sync as a classifier (origin === 'compositor' skips missing-object flagging), not diffed.",
      },
      hash: INTERNAL_STATE("object provenance classifier"),
    },
    {
      // The course marker: the id of the course project an object was
      // preloaded from. An ordinary Y-carried field — cold-loaded from D1 and
      // bound from the Y.Map on insert — and deliberately NOT preserveFromD1:
      // preserve prefers the surviving D1 value over the Y copy, which would
      // resurrect a marker the leave sequence has just cleared.
      name: "course_project_id",
      d1: { column: "course_project_id", type: "int" },
      ydoc: {
        key: "course_project_id",
        kind: "plain",
        factory: {
          excluded: true,
          reason:
            "An unmarked object carries no key at all — absence, never a null value, is what 'made by this site' means. Only the preload ingest sets it; only the marker-clear route removes it.",
        },
      },
      publish: INTERNAL_STATE("course-collection marker"),
      import: {
        excluded: true,
        reason:
          "Never in any CSV cell: a repo import creates ordinary site objects, and a course object reaches a child only through the preload ingest.",
      },
      sync: {
        excluded: true,
        reason:
          "Consumed by sync as a delete guard (a marked object is exempt from the removed-objects loop and the ingest remove path), not diffed as a field.",
      },
      hash: INTERNAL_STATE("course-collection marker"),
    },
    {
      // Where the object sorts: the order the publish writes objects.csv in.
      // objects.csv has no order column, but its row order reaches the site:
      // of two rows the site reads as one object, it shows the later, and the
      // released framework's homepage sample picks rows by position. The key
      // also stops the Y.Array position being the ordering, which is what
      // forced a reorder to be a delete-and-reinsert.
      name: "order_key",
      d1: { column: "order_key", type: "text" },
      ydoc: { key: "order_key", kind: "plain" },
      publish: {
        excluded: true,
        reason:
          "No column carries it: the publish writes objects.csv's rows in order_key order (objectsSheetOrder), and the row order is what the site reads.",
      },
      import: {
        excluded: true,
        reason:
          "No repo representation to import from; an imported object is given a key at the end of the list.",
      },
      sync: {
        excluded: true,
        reason:
          "Not diffed as a field: the syncs take GitHub's file order for the rows both sides hold (objectOrderChange) and re-key them to it, and place a row they bring in where GitHub's file has it.",
      },
      hash: {
        excluded: true,
        reason:
          "The key's value is not hashed; the row order it gives is, as EntityHashes.objectOrder over the object_id sequence in sheet order (D1 row ids are not stable across the snapshot's re-insert).",
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Pages  (project_pages table <-> Y root array "pages" <-> texts/pages/{slug}.md)
// ---------------------------------------------------------------------------

const pages: EntityDecl = {
  entity: "pages",
  ydocLocation: 'Y root array "pages" of Y.Maps',
  fields: [
    {
      name: "title",
      d1: { column: "title", type: "text" },
      ydoc: { key: "title", kind: "ytext" },
      publish: { file: "page.md", key: "title", encoding: "frontmatter" },
      import: { headers: ["title"], encoding: "frontmatter" },
      sync: PAGES_NO_SYNC,
      hash: { bucket: "pages" },
    },
    {
      name: "slug",
      d1: { column: "slug", type: "text" },
      ydoc: { key: "slug", kind: "plain" },
      publish: { file: "page.md", key: "(filename)", encoding: "filename" },
      import: { headers: [], encoding: "filename" },
      sync: PAGES_NO_SYNC,
      hash: { bucket: "pages" },
    },
    {
      name: "body",
      d1: { column: "body", type: "text" },
      ydoc: { key: "body", kind: "ytext" },
      publish: { file: "page.md", key: "(body)", encoding: "md-body" },
      import: { headers: [], encoding: "md-body" },
      sync: PAGES_NO_SYNC,
      hash: { bucket: "pages" },
    },
    {
      // The block between the page file's fences, kept as text so the keys
      // the Compositor does not model survive. Publish writes it back with
      // only the title changed. NULL is a page whose file was never read; the
      // hash takes the block only when it is non-empty, so a page without
      // front matter, or not yet captured, hashes as if the field did not
      // exist. Pinned by tests/page-frontmatter.test.ts,
      // tests/page-frontmatter-publish.test.ts and
      // tests/workers/page-frontmatter.test.ts.
      name: "frontmatter",
      d1: { column: "frontmatter", type: "text" },
      ydoc: { key: "frontmatter", kind: "plain" },
      publish: { file: "page.md", key: "(front matter)", encoding: "frontmatter-block" },
      import: { headers: [], encoding: "frontmatter-block" },
      sync: PAGES_NO_SYNC,
      hash: { bucket: "pages" },
    },
    {
      // D1-only: the slug of the file a page never captured has its front
      // matter carried forward from at publish. A rename changes the slug,
      // never this, so the page still reads the file it was imported as.
      name: "frontmatter_source",
      d1: { column: "frontmatter_source", type: "text" },
      ydoc: {
        excluded: true,
        reason:
          "Never in the Y.Doc — set by migration 0059 and read only by the publish; the snapshot UPDATE preserves it by omission and the stale-id re-INSERT preserves the surviving D1 row's value.",
        preserveFromD1: true,
      },
      publish: INTERNAL_STATE("which file an uncaptured page's front matter is read from"),
      import: { excluded: true, reason: "Set once by migration 0059; pages imported since carry their front matter and need no source." },
      sync: PAGES_NO_SYNC,
      hash: INTERNAL_STATE("which file an uncaptured page's front matter is read from"),
    },
    {
      // The snapshot derives it from the page's rank in order_key order. Page
      // order reaches the published site solely via navigation_json ->
      // _data/navigation.yml.
      name: "order",
      d1: { column: "order", type: "int" },
      ydoc: {
        excluded: true,
        reason:
          "Derived at snapshot time from the rank in order_key order. The document carries order_key and nothing else, so there is no second copy of the ordering to fall out of step with it.",
      },
      publish: {
        excluded: true,
        reason:
          "Not in the page file; page order publishes solely via navigation_json (the navigation entity).",
      },
      import: { headers: [], encoding: "tree-index" },
      sync: PAGES_NO_SYNC,
      hash: {
        excluded: true,
        reason:
          "Deliberately excluded from the page hash so a reorder surfaces once, as the navigation change row (captured by the navigation hash).",
      },
    },
    {
      // Where the page sorts. `order` is the dense rank derived from it, kept
      // because the editor and D1 both name pages by position.
      name: "order_key",
      d1: { column: "order_key", type: "text" },
      ydoc: { key: "order_key", kind: "plain" },
      publish: {
        excluded: true,
        reason:
          "Not in the page file; page order publishes solely via navigation_json (the navigation entity).",
      },
      import: {
        excluded: true,
        reason:
          "No repo representation to import from; an imported page is given a key at the end of the list.",
      },
      sync: PAGES_NO_SYNC,
      hash: {
        excluded: true,
        reason:
          "Same reason as `order`: a reorder surfaces once, as the navigation change row.",
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Glossary  (glossary_terms table <-> Y root array "glossary" <-> glossary.csv row)
// ---------------------------------------------------------------------------

const glossary: EntityDecl = {
  entity: "glossary",
  ydocLocation: 'Y root array "glossary" of Y.Maps',
  fields: [
    {
      // Renameable (unlike story_id); the DO can mint a {slug}-{8char} id on
      // insert and dedup RE-KEYS duplicates instead of deleting them.
      name: "term_id",
      d1: { column: "term_id", type: "text" },
      ydoc: { key: "term_id", kind: "plain" },
      publish: { file: "glossary.csv", key: "term_id", esKey: "id_término", encoding: "verbatim" },
      import: { headers: ["term_id", "id_termino", "id_término"], encoding: "verbatim" },
      sync: { diff: "glossary", role: "key" },
      hash: { bucket: "glossary" },
    },
    {
      name: "title",
      d1: { column: "title", type: "text" },
      ydoc: { key: "title", kind: "ytext" },
      publish: { file: "glossary.csv", key: "title", esKey: "titulo", encoding: "verbatim" },
      import: { headers: ["title", "titulo", "título"], encoding: "verbatim" },
      sync: { diff: "glossary" },
      hash: { bucket: "glossary" },
    },
    {
      name: "definition",
      d1: { column: "definition", type: "text" },
      ydoc: { key: "definition", kind: "ytext" },
      publish: {
        file: "glossary.csv",
        key: "definition",
        esKey: "definición",
        encoding: "verbatim",
      },
      import: { headers: ["definition", "definicion", "definición"], encoding: "verbatim" },
      sync: { diff: "glossary" },
      hash: { bucket: "glossary" },
    },
    {
      // The entry's kind (term, source, entity, place or a site kind), written
      // as the sheet's kind column. The sheet may head it `tipo`; publish keeps
      // the header the file holds (`keepsFileHeader`), and the registry names
      // the canonical one. A value that names no kind is kept as written.
      name: "kind",
      d1: { column: "kind", type: "text" },
      ydoc: {
        key: "kind",
        kind: "plain",
        factory: {
          excluded: true,
          reason:
            "A new entry has no kind until the author picks one; absence reads as blank, which the framework reads as term.",
        },
      },
      // A kept column, not a fixed one: a sheet without it gets no empty
      // column, and one that has it keeps its own header.
      publish: { file: "glossary.csv", key: "(kind column)", encoding: "verbatim" },
      import: { headers: ["kind", "tipo"], encoding: "verbatim" },
      sync: { diff: "glossary" },
      hash: { bucket: "glossary" },
    },
    {
      // D1-passthrough: the compositor never edits related terms, so the
      // Y.Doc is not their source of truth. The snapshot UPDATE preserves by
      // omission; the re-INSERT preserves from the surviving D1 row.
      name: "related_terms",
      d1: { column: "related_terms", type: "text" },
      ydoc: {
        excluded: true,
        reason:
          "Never in the Y.Doc — compositor does not edit related_terms; re-INSERT preserves the surviving D1 row's value (pinned by snapshot-preserve-d1-columns.test.ts).",
        preserveFromD1: true,
      },
      publish: {
        file: "glossary.csv",
        key: "related_terms",
        esKey: "términos_relacionados",
        encoding: "verbatim",
      },
      import: {
        headers: ["related_terms", "terminos_relacionados", "términos_relacionados"],
        encoding: "verbatim",
      },
      sync: { diff: "glossary" },
      hash: { bucket: "glossary" },
    },
    {
      // A column no subsystem carries. The glossary is exempt from the
      // framework's protected-story leak sweep, so a definition that quotes a
      // locked story needs no acknowledgement to publish. The column stays
      // because it is applied on staging and dropping a live column buys
      // nothing; it is read by nothing, written by nothing, and published to
      // nothing.
      name: "quoted_in_stories",
      d1: { column: "quoted_in_stories", type: "text" },
      ydoc: {
        excluded: true,
        reason:
          "No Y key: the editor has no field for it, so there is no value for the document to carry or for a snapshot to write back.",
      },
      publish: {
        excluded: true,
        reason:
          "Not a glossary.csv column. The framework's glossary mapper has no header for it, so a published cell would land in an author's own passthrough column.",
      },
      import: {
        excluded: true,
        reason:
          "No header maps here. A file that carries the old column is read as an author's own, and `extra_columns` keeps it verbatim.",
      },
      sync: {
        excluded: true,
        reason:
          "No heal and no glossary diff. Nothing writes the column, so the file and the column cannot disagree about anything a sync could act on.",
      },
      hash: {
        excluded: true,
        reason: "Carried by no file, so it cannot change what a publish would ship.",
      },
    },
    {
      // JSON blob spread as individual custom CSV columns (sorted union), the
      // objects passthrough applied to glossary.csv. D1-passthrough like
      // related_terms above and for the same reason: the compositor has no UI
      // for a custom column, so the Y.Doc is not its source of truth, the
      // snapshot UPDATE preserves it by omission and the re-INSERT preserves it
      // from the surviving D1 row. Sync and hash both compare the canonicalized
      // (keys-sorted) form via the shared extra-columns module, so
      // serialization order can never fabricate a diff.
      name: "extra_columns",
      d1: { column: "extra_columns", type: "json" },
      ydoc: {
        excluded: true,
        reason:
          "Never in the Y.Doc — the compositor has no editor for a custom column; re-INSERT preserves the surviving D1 row's value (pinned by snapshot-preserve-d1-columns.test.ts).",
        preserveFromD1: true,
      },
      publish: {
        file: "glossary.csv",
        key: "(custom columns)",
        encoding: "json-spread-columns",
      },
      import: { headers: [], encoding: "json-spread-columns" },
      sync: { diff: "glossary" },
      hash: { bucket: "glossary" },
    },
    {
      // Where the term sits in the glossary Y.Array. The editor always sorts
      // terms by title, so this is not what the reader sees; it exists so the
      // array position stops being the ordering.
      name: "order_key",
      d1: { column: "order_key", type: "text" },
      ydoc: { key: "order_key", kind: "plain" },
      publish: {
        excluded: true,
        reason:
          "glossary.csv encodes no order at all; the editor sorts terms by title, so this is the array's order and nothing the reader sees.",
      },
      import: {
        excluded: true,
        reason:
          "No repo representation to import from; an imported term is given a key at the end of the list.",
      },
      sync: {
        excluded: true,
        reason:
          "No repo representation, so nothing to three-way merge; glossary.csv carries no order to diff.",
      },
      hash: {
        excluded: true,
        reason:
          "The glossary publishes no order, so a reordered array is not an unpublished change and must not read as one.",
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Site config  (project_config table <-> Y map "config" <-> _config.yml et al.)
// ---------------------------------------------------------------------------

const config: EntityDecl = {
  entity: "config",
  ydocLocation: 'Y root map "config" (plus nested "landing" map and "navigation" array)',
  fields: [
    {
      name: "title",
      d1: { column: "title", type: "text" },
      ydoc: { key: "title", kind: "ytext" },
      publish: { file: "_config.yml", key: "title", encoding: "quoted-yaml" },
      import: { headers: ["title"], encoding: "verbatim" },
      sync: { diff: "config" },
      hash: { bucket: "settings" },
    },
    {
      name: "lang",
      d1: { column: "lang", type: "text" },
      ydoc: { key: "lang", kind: "plain" },
      publish: { file: "_config.yml", key: "telar_language", encoding: "unquoted-yaml" },
      import: { headers: ["telar_language"], encoding: "verbatim" },
      sync: { diff: "config", yamlKey: "telar_language" },
      hash: { bucket: "settings" },
    },
    {
      name: "baseurl",
      d1: { column: "baseurl", type: "text" },
      ydoc: { key: "baseurl", kind: "plain" },
      publish: { file: "_config.yml", key: "baseurl", encoding: "quoted-yaml" },
      import: { headers: ["baseurl"], encoding: "verbatim" },
      sync: { diff: "config" },
      hash: { bucket: "settings" },
    },
    {
      name: "url",
      d1: { column: "url", type: "text" },
      ydoc: { key: "url", kind: "plain" },
      publish: { file: "_config.yml", key: "url", encoding: "quoted-yaml" },
      import: { headers: ["url"], encoding: "verbatim" },
      sync: { diff: "config" },
      hash: { bucket: "settings" },
    },
    {
      // Read-only from the compositor's side: publish only heals a `v` prefix
      // on an existing telar.version line; sync's dedicated versionChange
      // detector heals D1 when the repo is ahead.
      name: "telar_version",
      d1: { column: "telar_version", type: "text" },
      ydoc: {
        key: "telar_version",
        kind: "plain",
        writeback: {
          excluded: true,
          reason:
            "The one Y key with no snapshot writeback: D1 is healed by sync's versionChange path, never by the snapshot.",
        },
      },
      publish: {
        excluded: true,
        reason:
          "Not a managed field; publish only strips a v prefix in place on an existing telar.version line.",
      },
      import: { headers: ["telar.version"], encoding: "verbatim" },
      sync: {
        excluded: true,
        reason:
          "Handled by the dedicated versionChange detector and one-way heal, not the managed-field diff.",
      },
      hash: { excluded: true, reason: "Version is framework state, not user content." },
    },
    {
      name: "theme",
      d1: { column: "theme", type: "text" },
      ydoc: { key: "theme", kind: "plain" },
      publish: { file: "_config.yml", key: "telar_theme", encoding: "quoted-yaml" },
      import: { headers: ["telar_theme"], encoding: "verbatim" },
      sync: { diff: "config", yamlKey: "telar_theme" },
      hash: { bucket: "settings" },
    },
    {
      name: "description",
      d1: { column: "description", type: "text" },
      ydoc: { key: "description", kind: "ytext" },
      publish: { file: "_config.yml", key: "description", encoding: "quoted-yaml" },
      import: { headers: ["description"], encoding: "verbatim" },
      sync: { diff: "config" },
      hash: { bucket: "settings" },
    },
    {
      name: "author",
      d1: { column: "author", type: "text" },
      ydoc: { key: "author", kind: "ytext" },
      publish: { file: "_config.yml", key: "author", encoding: "quoted-yaml" },
      import: { headers: ["author"], encoding: "verbatim" },
      sync: { diff: "config" },
      hash: { bucket: "settings" },
    },
    {
      name: "email",
      d1: { column: "email", type: "text" },
      ydoc: { key: "email", kind: "ytext" },
      publish: { file: "_config.yml", key: "email", encoding: "quoted-yaml" },
      import: { headers: ["email"], encoding: "verbatim" },
      sync: { diff: "config" },
      hash: { bucket: "settings" },
    },
    {
      name: "logo",
      d1: { column: "logo", type: "text" },
      ydoc: { key: "logo", kind: "plain" },
      publish: { file: "_config.yml", key: "logo", encoding: "quoted-yaml" },
      import: { headers: ["logo"], encoding: "verbatim" },
      sync: { diff: "config" },
      hash: { bucket: "settings" },
    },
    {
      name: "include_demo_content",
      d1: { column: "include_demo_content", type: "bool" },
      ydoc: { key: "include_demo_content", kind: "plain" },
      publish: {
        file: "_config.yml",
        key: "story_interface.include_demo_content",
        encoding: "unquoted-bool",
      },
      import: { headers: ["story_interface.include_demo_content"], encoding: "verbatim" },
      sync: { diff: "config", yamlKey: "story_interface.include_demo_content" },
      hash: { bucket: "settings" },
    },
    {
      name: "google_sheets_enabled",
      d1: { column: "google_sheets_enabled", type: "bool" },
      ydoc: { key: "google_sheets_enabled", kind: "plain" },
      publish: {
        excluded: true,
        reason:
          "Deliberately never written by publish (corruption-risk class; not Config-UI editable).",
      },
      import: { headers: ["google_sheets.enabled"], encoding: "verbatim" },
      sync: {
        excluded: true,
        reason:
          "Publish deliberately never writes google_sheets.* (corruption-risk class), so sync has no publish-managed value to reconcile against; the Sheets settings are import-only.",
      },
      hash: { excluded: true, reason: "Not publish-managed, so not part of change detection." },
    },
    {
      name: "google_sheets_published_url",
      d1: { column: "google_sheets_published_url", type: "text" },
      ydoc: { key: "google_sheets_published_url", kind: "plain" },
      publish: {
        excluded: true,
        reason:
          "Deliberately never written by publish (corruption-risk class; not Config-UI editable).",
      },
      import: { headers: ["google_sheets.published_url"], encoding: "verbatim" },
      sync: {
        excluded: true,
        reason:
          "Publish deliberately never writes google_sheets.* (corruption-risk class), so sync has no publish-managed value to reconcile against; the Sheets settings are import-only.",
      },
      hash: { excluded: true, reason: "Not publish-managed, so not part of change detection." },
    },
    {
      name: "show_on_homepage",
      d1: { column: "show_on_homepage", type: "bool" },
      ydoc: { key: "show_on_homepage", kind: "plain" },
      publish: {
        file: "_config.yml",
        key: "story_interface.show_on_homepage",
        encoding: "unquoted-bool",
      },
      import: { headers: ["story_interface.show_on_homepage"], encoding: "verbatim" },
      sync: { diff: "config", yamlKey: "story_interface.show_on_homepage" },
      hash: { bucket: "settings" },
    },
    {
      name: "show_story_steps",
      d1: { column: "show_story_steps", type: "bool" },
      ydoc: { key: "show_story_steps", kind: "plain" },
      publish: {
        file: "_config.yml",
        key: "story_interface.show_story_steps",
        encoding: "unquoted-bool",
      },
      import: { headers: ["story_interface.show_story_steps"], encoding: "verbatim" },
      sync: { diff: "config", yamlKey: "story_interface.show_story_steps" },
      hash: { bucket: "settings" },
    },
    {
      name: "show_object_credits",
      d1: { column: "show_object_credits", type: "bool" },
      ydoc: { key: "show_object_credits", kind: "plain" },
      publish: {
        file: "_config.yml",
        key: "story_interface.show_object_credits",
        encoding: "unquoted-bool",
      },
      import: { headers: ["story_interface.show_object_credits"], encoding: "verbatim" },
      sync: { diff: "config", yamlKey: "story_interface.show_object_credits" },
      hash: { bucket: "settings" },
    },
    {
      name: "browse_and_search",
      d1: { column: "browse_and_search", type: "bool" },
      ydoc: { key: "browse_and_search", kind: "plain" },
      publish: {
        file: "_config.yml",
        key: "collection_interface.browse_and_search",
        encoding: "unquoted-bool",
      },
      import: { headers: ["collection_interface.browse_and_search"], encoding: "verbatim" },
      sync: { diff: "config", yamlKey: "collection_interface.browse_and_search" },
      hash: { bucket: "settings" },
    },
    {
      name: "show_link_on_homepage",
      d1: { column: "show_link_on_homepage", type: "bool" },
      ydoc: { key: "show_link_on_homepage", kind: "plain" },
      publish: {
        file: "_config.yml",
        key: "collection_interface.show_link_on_homepage",
        encoding: "unquoted-bool",
      },
      import: { headers: ["collection_interface.show_link_on_homepage"], encoding: "verbatim" },
      sync: { diff: "config", yamlKey: "collection_interface.show_link_on_homepage" },
      hash: { bucket: "settings" },
    },
    {
      name: "show_sample_on_homepage",
      d1: { column: "show_sample_on_homepage", type: "bool" },
      ydoc: { key: "show_sample_on_homepage", kind: "plain" },
      publish: {
        file: "_config.yml",
        key: "collection_interface.show_sample_on_homepage",
        encoding: "unquoted-bool",
      },
      import: { headers: ["collection_interface.show_sample_on_homepage"], encoding: "verbatim" },
      sync: { diff: "config", yamlKey: "collection_interface.show_sample_on_homepage" },
      hash: { bucket: "settings" },
    },
    {
      name: "collection_mode",
      d1: { column: "collection_mode", type: "bool" },
      ydoc: { key: "collection_mode", kind: "plain" },
      publish: { file: "_config.yml", key: "collection_mode", encoding: "unquoted-bool" },
      import: { headers: ["collection_mode"], encoding: "verbatim" },
      sync: { diff: "config" },
      hash: { bucket: "settings" },
    },
    {
      // The framework block is `development-features:` in _config.yml;
      // `dev_features` is only a Liquid local (_layouts/index.html), so the
      // publish key is development-features.skip_stories.
      name: "skip_stories",
      d1: { column: "skip_stories", type: "bool" },
      ydoc: { key: "skip_stories", kind: "plain" },
      publish: {
        file: "_config.yml",
        key: "development-features.skip_stories",
        encoding: "unquoted-bool",
      },
      import: { headers: ["development-features.skip_stories"], encoding: "verbatim" },
      sync: { diff: "config", yamlKey: "development-features.skip_stories" },
      hash: { bucket: "settings" },
    },
    {
      name: "featured_count",
      d1: { column: "featured_count", type: "int" },
      ydoc: { key: "featured_count", kind: "plain" },
      publish: {
        file: "_config.yml",
        key: "collection_interface.featured_count",
        encoding: "unquoted-int",
      },
      import: { headers: ["collection_interface.featured_count"], encoding: "verbatim" },
      sync: { diff: "config", yamlKey: "collection_interface.featured_count" },
      hash: { bucket: "settings" },
    },
    {
      // A column no subsystem carries. The answer limit stopped being a
      // per-site setting: 100 is advice and 200 is where the build cuts, both
      // constants in word-count.ts. The column stays because it is applied on
      // staging and dropping a live column buys nothing; it is read by
      // nothing, written by nothing, and published to nothing.
      name: "answer_word_limit",
      d1: { column: "answer_word_limit", type: "int" },
      ydoc: {
        excluded: true,
        reason:
          "No Y key: nothing writes the column, so there is no value for the document to carry or for a snapshot to write back.",
      },
      publish: {
        excluded: true,
        reason:
          "Not a managed field. `story_content:` is no longer a managed block, so a site whose _config.yml carries the key keeps it verbatim as an unmanaged line.",
      },
      import: {
        excluded: true,
        reason:
          "An imported site's stated limit is not read: the number the build holds it to is the framework's constant, not the file's.",
      },
      sync: {
        excluded: true,
        reason:
          "No heal and no managed-field diff. Nothing writes the column, so the file and the column cannot disagree about anything a sync could act on.",
      },
      hash: {
        excluded: true,
        reason: "Carried by no file, so it cannot change what a publish would ship.",
      },
    },
    {
      // Publish writes it under `protected:` -> `  key:` (with a top-level
      // story_key: fallback and duplicate self-heal); import and sync read
      // protected.key first, then the top-level line — matching the writer's
      // precedence.
      name: "story_key",
      d1: { column: "story_key", type: "text" },
      ydoc: { key: "story_key", kind: "plain" },
      publish: { file: "_config.yml", key: "protected.key", encoding: "quoted-yaml" },
      import: { headers: ["protected.key", "story_key"], encoding: "verbatim" },
      sync: { diff: "config" },
      hash: { bucket: "settings" },
    },
    {
      // D1/Y -> _data/navigation.yml. The sync reads GitHub's file for one
      // thing only: the entry of a page it takes from GitHub
      // (`github-menu.server.ts`), added through the ingest's insert arm.
      // Nothing else in the file is read back. Cold-start default navigation
      // is rebuilt from pages + builtins. Item shape is pinned by the
      // navigation tests; the structural hash covers change detection.
      name: "navigation_json",
      d1: { column: "navigation_json", type: "json" },
      ydoc: { key: "navigation", kind: "plain" },
      publish: { file: "navigation.yml", key: "menu", encoding: "navigation-yml" },
      import: {
        excluded: true,
        reason:
          "The import does not read _data/navigation.yml; the default nav is derived from pages + builtins at cold start.",
      },
      sync: {
        excluded: true,
        reason:
          "Not reconciled: the sync reads _data/navigation.yml only for the entry of a page taken from GitHub, and publish rewrites the file.",
      },
      hash: { bucket: "navigation" },
    },
    {
      // Null follows the repository's _config.yml; a list, including an
      // empty one, is what publish writes. The writer and its shapes are
      // pinned by tests/glossary-kinds-yaml.server.test.ts.
      name: "glossary_kinds_json",
      d1: { column: "glossary_kinds_json", type: "json" },
      ydoc: {
        excluded: true,
        reason:
          "D1 only: the kinds are saved whole by one action with a compare-and-swap, never through the shared document.",
      },
      publish: { file: "_config.yml", key: "glossary.kinds", encoding: "glossary-kinds-yml" },
      import: { headers: ["glossary.kinds"], encoding: "glossary-kinds-yml" },
      sync: { diff: "config", yamlKey: "glossary.kinds" },
      hash: { bucket: "settings" },
    },
  ],
};

// ---------------------------------------------------------------------------
// Landing  (project_landing table <-> nested Y map config.landing <-> index.md)
// ---------------------------------------------------------------------------

const landing: EntityDecl = {
  entity: "landing",
  ydocLocation: 'nested Y.Map at config.landing (Y.Text values)',
  fields: [
    {
      name: "stories_heading",
      d1: { column: "stories_heading", type: "text" },
      ydoc: { key: "stories_heading", kind: "ytext" },
      publish: { file: "index.md", key: "stories_heading", encoding: "frontmatter" },
      import: { headers: ["stories_heading"], encoding: "frontmatter" },
      sync: LANDING_NO_SYNC,
      hash: { bucket: "landing" },
    },
    {
      name: "stories_intro",
      d1: { column: "stories_intro", type: "text" },
      ydoc: { key: "stories_intro", kind: "ytext" },
      publish: { file: "index.md", key: "stories_intro", encoding: "frontmatter" },
      import: { headers: ["stories_intro"], encoding: "frontmatter" },
      sync: LANDING_NO_SYNC,
      hash: { bucket: "landing" },
    },
    {
      name: "objects_heading",
      d1: { column: "objects_heading", type: "text" },
      ydoc: { key: "objects_heading", kind: "ytext" },
      publish: { file: "index.md", key: "objects_heading", encoding: "frontmatter" },
      import: { headers: ["objects_heading"], encoding: "frontmatter" },
      sync: LANDING_NO_SYNC,
      hash: { bucket: "landing" },
    },
    {
      name: "objects_intro",
      d1: { column: "objects_intro", type: "text" },
      ydoc: { key: "objects_intro", kind: "ytext" },
      publish: { file: "index.md", key: "objects_intro", encoding: "frontmatter" },
      import: { headers: ["objects_intro"], encoding: "frontmatter" },
      sync: LANDING_NO_SYNC,
      hash: { bucket: "landing" },
    },
    {
      // The index.md body; the canonical v1.3.0 welcome liquid block is
      // recognized on import and stored as undefined so the framework default
      // keeps rendering.
      name: "welcome_body",
      d1: { column: "welcome_body", type: "text" },
      ydoc: { key: "welcome_body", kind: "ytext" },
      publish: { file: "index.md", key: "(body)", encoding: "md-body" },
      import: { headers: [], encoding: "md-body" },
      sync: LANDING_NO_SYNC,
      hash: { bucket: "landing" },
    },
  ],
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export const FIELD_REGISTRY: readonly EntityDecl[] = [
  stories,
  steps,
  layers,
  objects,
  pages,
  glossary,
  config,
  landing,
];

export function getEntity(name: EntityDecl["entity"]): EntityDecl {
  const entity = FIELD_REGISTRY.find((e) => e.entity === name);
  if (!entity) throw new Error(`Unknown registry entity: ${name}`);
  return entity;
}

/** Type guard for the `{ excluded, reason }` shape any axis may carry. */
export function isExcluded(axis: unknown): axis is Excluded {
  return typeof axis === "object" && axis !== null && (axis as Excluded).excluded === true;
}

/** One field's Y.Doc residence: the key it occupies, and the column it binds. */
export interface YdocField {
  /** The Y.Map key. */
  key: string;
  /** The D1 column, or null for a field that has none. */
  column: string | null;
  kind: "ytext" | "plain";
}

/**
 * Every field each entity keeps in the Y.Doc, by entity, in declaration order.
 *
 * Derived from the declarations above and never listed, because a field's
 * representation is a property of the FIELD: the one place that states it is
 * its own declaration. Consumers needing a narrower view — one entity, one
 * kind, or an index by D1 column — derive it from this rather than walking the
 * registry again, so a declaration that changes kind changes every consumer at
 * once and no call site is edited.
 */
export const YDOC_FIELDS: Record<EntityDecl["entity"], readonly YdocField[]> =
  Object.create(null);
for (const decl of FIELD_REGISTRY) {
  const fields: YdocField[] = [];
  for (const field of decl.fields) {
    if (isExcluded(field.ydoc)) continue;
    const kind = field.ydoc.kind;
    if (kind !== "ytext" && kind !== "plain") continue;
    fields.push({
      key: field.ydoc.key,
      column: isExcluded(field.d1) ? null : field.d1.column,
      kind,
    });
  }
  YDOC_FIELDS[decl.entity] = fields;
}

/** The Y.Doc keys one entity declares as prose. */
export function proseKeysOf(entity: EntityDecl["entity"]): ReadonlySet<string> {
  return new Set(YDOC_FIELDS[entity].filter((f) => f.kind === "ytext").map((f) => f.key));
}
