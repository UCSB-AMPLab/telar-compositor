/**
 * The wire domain of every value `/ingest-sync` applies, and the partition
 * that judges a payload against it before the document is touched.
 *
 * `isIdentityValueInDomain` states the domain for the identity keys at this
 * boundary. The rest of the payload holds the same standing: the endpoint is
 * reachable by anything holding the internal marker, the transaction it
 * mutates under is null-origin, and null origin exempts a write from every
 * entry pass. So the values the arms consume need a domain of their own,
 * stated here per key rather than as a coarse JSON-type rule — a boolean
 * field that accepts the string "false" is read as true, and a text field
 * that accepts `null` deletes a `Y.Text` and then throws mid-transaction.
 *
 * Each domain is the PRODUCER's, derived from the builder that emits the field:
 * `resolveFullSyncPayload` in `app/lib/sync.server.ts`, the page import in
 * `app/routes/_app.pages.tsx`, the object registration in
 * `app/routes/_app.objects.tsx`, `preloadCourseObjects`, and the publish's
kept-columns capture in `app/lib/kept-columns-capture.server.ts`, and the
 * publish's written-block store in `app/lib/page-written-frontmatter.server.ts`.
 * A field no producer emits at all is absent from the tables and is ignored,
 * which is what keeps an unknown key on an object update from refusing the
 * entry that carries it; the written-block arm alone refuses one
 * (`refusedStrictly`).
 *
 * Nothing here renders a value. A refusal names the arm, the position, the
 * field path and the type that stood there, because rendering an untrusted
 * value to describe it is the operation this whole boundary exists to prevent.
 *
 * @version v1.5.0-beta
 */

import { pythonStrip } from "~/lib/python-whitespace";
import { typeNameOf } from "~/lib/value-domains";
import {
  partitionOnIdentityDomainIndexed,
  type IngestIdentityRoot,
} from "./can-delete";

// ---------------------------------------------------------------------------
// Config allow-lists
// ---------------------------------------------------------------------------

/**
 * Config keys carried as `Y.Text` for character-level merge, mirroring
 * `buildFromD1Rows` so an ingested value round-trips through the snapshot.
 */
export const CONFIG_YTEXT_KEYS: ReadonlySet<string> = new Set([
  "title", "description", "author", "email",
]);

/**
 * Plain config keys the ingest may set. Together with `CONFIG_YTEXT_KEYS` this
 * is the full set of managed config fields; an unlisted key is never written —
 * named back in `skipped.config` when it is safe to report, refused by
 * position otherwise — because a stray key like "navigation" or "landing"
 * would replace a Y.Array/Y.Map with a scalar and break every future
 * `snapshotConfig` read.
 *
 * Deliberately shorter than the snapshot's own `CONFIG_COLUMNS`: the two Google
 * Sheets keys and `navigation` are written by the snapshot and are not in it.
 * `google_sheets_enabled` is taken beside it, only as `false`; see
 * `CONFIG_REPAIR_OFF_KEY`.
 */
export const CONFIG_PLAIN_KEYS: ReadonlySet<string> = new Set([
  "lang", "baseurl", "url", "theme", "logo", "story_key",
  "collection_mode", "skip_stories", "include_demo_content", "show_on_homepage",
  "show_story_steps", "show_object_credits", "browse_and_search",
  "show_link_on_homepage", "show_sample_on_homepage", "featured_count",
]);

/**
 * The plain keys whose producer emits a real boolean.
 * `resolveFullSyncPayload` coerces each repo scalar with `raw === "true"`, so
 * the string "false" never leaves the producer — and accepting it here would
 * store a setting the author turned off as on.
 */
const CONFIG_FLAG_KEYS: ReadonlySet<string> = new Set([
  "collection_mode", "skip_stories", "include_demo_content", "show_on_homepage",
  "show_story_steps", "show_object_credits", "browse_and_search",
  "show_link_on_homepage", "show_sample_on_homepage",
]);

/** The one plain key whose producer emits a number. */
const CONFIG_COUNT_KEY = "featured_count";

/**
 * The one plain key a repair writes and no full sync carries, and which it may
 * only turn off: the ingest runs as the internal origin, past socket role
 * enforcement, and turning Google Sheets on is a convenor's edit in settings.
 */
const CONFIG_REPAIR_OFF_KEY = "google_sheets_enabled";

// ---------------------------------------------------------------------------
// Field domains
// ---------------------------------------------------------------------------

/** True when a value is one the field's producers emit. */
type WireDomain = (value: unknown) => boolean;

const isWireString: WireDomain = (value) => typeof value === "string";

const isWireBoolean: WireDomain = (value) => typeof value === "boolean";
const isWireFalse: WireDomain = (value) => value === false;

/**
 * An integer a column can hold. `Number.isSafeInteger` excludes `NaN`, the
 * infinities and fractions, and it also excludes the magnitudes past
 * 2^53 - 1 that `Number.parseInt` will happily produce from a repo cell: a
 * count no column can round-trip is a deliberate restriction of this boundary.
 */
const isWireInteger: WireDomain = (value) =>
  typeof value === "number" && Number.isSafeInteger(value);

/**
 * A step or layer position: an integer, with none of `isWireInteger`'s
 * safe-range restriction. A position is compared and ordered, never bound to
 * a REAL or INTEGER column read back at the safe-integer ceiling, so the
 * restriction that protects `featured_count` and `_id` has no target here.
 */
const isWireIndex: WireDomain = (value) =>
  typeof value === "number" && Number.isInteger(value);

/** A D1 row id: the domain `isIdentityValueInDomain` states for `_id`. */
const isWireRowId: WireDomain = (value) =>
  isWireInteger(value) && (value as number) > 0;

/**
 * A REAL column a viewport reads back. Finite excludes `NaN` and the
 * infinities, which SQLite stores but no viewport can use.
 */
const isWireCoordinate: WireDomain = (value) =>
  typeof value === "number" && Number.isFinite(value);

/** The domain, plus the absence for which the Durable Object has a default. */
function orAbsent(domain: WireDomain): WireDomain {
  return (value) => value === undefined || domain(value);
}

/** The domain, plus the `null` that clears the column. */
function orNull(domain: WireDomain): WireDomain {
  return (value) => value === null || domain(value);
}

/** Every field of one entry shape that a producer emits, and its domain. */
type FieldDomains = Readonly<Record<string, WireDomain>>;

/** One field of one entry, stated out of domain. */
interface FieldRefusal {
  field: string;
  found: string;
}

const STORY_SCALARS: FieldDomains = {
  title: orAbsent(isWireString),
  subtitle: orAbsent(isWireString),
  byline: orAbsent(isWireString),
  isPrivate: orAbsent(isWireBoolean),
  showSections: orAbsent(isWireBoolean),
};

const STEP_FIELDS: FieldDomains = {
  step_number: orAbsent(isWireIndex),
  kind: orAbsent(isWireString),
  object_id: orAbsent(isWireString),
  x: orAbsent(orNull(isWireCoordinate)),
  y: orAbsent(orNull(isWireCoordinate)),
  zoom: orAbsent(orNull(isWireCoordinate)),
  page: orAbsent(isWireString),
  question: orAbsent(isWireString),
  answer: orAbsent(isWireString),
  alt_text: orAbsent(isWireString),
  clip_start: orAbsent(isWireString),
  clip_end: orAbsent(isWireString),
  loop: orAbsent(isWireString),
  extra_columns: orAbsent(isWireString),
};

/**
 * A layer states both of its indexes: `step_index` threads it onto the step
 * built at that position and `layer_number` is written to its column verbatim.
 */
const LAYER_FIELDS: FieldDomains = {
  step_index: isWireIndex,
  layer_number: isWireIndex,
  title: orAbsent(isWireString),
  button_label: orAbsent(isWireString),
  content: orAbsent(isWireString),
};

/** The object text columns, each of which a producer may clear with `null`. */
export const OBJECT_TEXT_FIELDS = [
  "title", "creator", "description", "alt_text", "period", "year",
  "object_type", "subjects", "source", "credit", "source_url", "thumbnail",
  "dimensions", "extra_columns",
];

function objectTextDomains(): Record<string, WireDomain> {
  const table: Record<string, WireDomain> = {};
  for (const field of OBJECT_TEXT_FIELDS) table[field] = orAbsent(orNull(isWireString));
  return table;
}

const OBJECT_UPDATE_FIELDS: FieldDomains = {
  ...objectTextDomains(),
  featured: orAbsent(isWireBoolean),
  image_available: orAbsent(isWireBoolean),
};

/** The object update's own row id, beside its `fields` map. */
const OBJECT_UPDATE_ROW: FieldDomains = {
  docId: orAbsent(isWireRowId),
};

/**
 * An `objects.order` entry names the row it orders by key and D1 id, as the
 * sync paired it with GitHub's row; an entry with no id names no row.
 */
const OBJECT_ORDER_ROW: FieldDomains = {
  docId: isWireRowId,
};

/**
 * An `objects.sheet` entry is one row of GitHub's objects.csv: a row the
 * document holds names its D1 id, and a row the same ingest inserts has none.
 */
const OBJECT_SHEET_ROW: FieldDomains = {
  docId: orAbsent(isWireRowId),
};

/**
 * `origin` and `course_project_id` are deliberately absent.
 *
 * `buildObjectYMap` reads each of them through a test that admits exactly one
 * shape — `=== "compositor"` for the provenance, a positive integer for the
 * marker — and carries the key only when the test passes. A value outside those
 * shapes is therefore already ignored rather than written, and the object still
 * takes its D1 defaults, which is behaviour a course preload and the object
 * registration both depend on. Refusing the entry over such a value would
 * discard an object for a key the document does not end up holding.
 */
const OBJECT_INSERT_FIELDS: FieldDomains = {
  ...objectTextDomains(),
  featured: orAbsent(isWireBoolean),
  image_available: orAbsent(isWireBoolean),
  created_by: orAbsent(orNull(isWireRowId)),
};

const GLOSSARY_UPDATE_FIELDS: FieldDomains = {
  title: orAbsent(isWireString),
  definition: orAbsent(isWireString),
  kind: orAbsent(isWireString),
};

const GLOSSARY_INSERT_FIELDS: FieldDomains = {
  title: isWireString,
  definition: isWireString,
  kind: orAbsent(isWireString),
};

/**
 * A front matter capture names its page by D1 row id and carries the block
 * the Pages loader read from the page's file: `""` for a file that is absent,
 * never null, since null is the uncaptured state the capture ends.
 */
const PAGE_CAPTURE_FIELDS: FieldDomains = {
  frontmatter: isWireString,
};

/**
 * A written block names its page by D1 row id and carries the block the
 * publish read (`expected`) and the block it wrote (`frontmatter`). Its one
 * producer is the publish (`storeWrittenPageFrontmatter`), and the arm is
 * checked strictly: a field outside this table and the row id refuses the
 * entry, since the arm overwrites a block and no other producer may reach it.
 */
const PAGE_STORE_WRITTEN_FIELDS: FieldDomains = {
  expected: isWireString,
  frontmatter: isWireString,
};

/** The one field a strictly checked entry may hold beside its table: its row id. */
const PAGE_ROW_IDENTITY = "pageId";

/**
 * An accepted page names its page by D1 row id and carries GitHub's version
 * as the import parses the file, the block `""` for a file with none, never
 * null, and the raw hash of the version the author reviewed.
 */
const PAGE_REPLACE_CONTENT_FIELDS: FieldDomains = {
  expected: isWireString,
  title: isWireString,
  body: isWireString,
  frontmatter: isWireString,
};

/**
 * A page slug as the page arms state one: a file name directly in the pages
 * folder without its `.md`, so non-empty and holding no `/`.
 */
const isWirePageSlug: WireDomain = (value) =>
  typeof value === "string" && value !== "" && !value.includes("/");

/** The saved menu entry an added page follows, by the field each kind is named by. */
const MENU_ANCHOR_FIELD: Readonly<Record<string, string>> = { page: "slug", builtin: "key", external: "url" };

function isWireMenuAnchor(value: unknown): boolean {
  if (!isWireEntry(value)) return false;
  const held = value as Record<string, unknown>;
  const field = typeof held.type === "string" && Object.hasOwn(MENU_ANCHOR_FIELD, held.type)
    ? MENU_ANCHOR_FIELD[held.type]
    : null;
  return field !== null && typeof held[field] === "string" && held[field] !== "";
}

/** The menu entry a page taken from GitHub carries: a label, and the entry it follows or null. */
function isWirePageMenuEntry(value: unknown): boolean {
  if (!isWireEntry(value)) return false;
  const { label, after } = value as { label?: unknown; after?: unknown };
  return isWireString(label) && (after === null || isWireMenuAnchor(after));
}

const PAGE_INSERT_FIELDS: FieldDomains = {
  title: isWireString,
  body: isWireString,
  frontmatter: orAbsent(orNull(isWireString)),
  created_by: orAbsent(orNull(isWireRowId)),
  menu: orAbsent(isWirePageMenuEntry),
};

/**
 * A page deleted on GitHub names its page by D1 row id, the slug the check
 * read it at, and the raw hash of the version the author reviewed.
 */
const PAGE_REMOVE_FIELDS: FieldDomains = {
  slug: isWirePageSlug,
  expected: isWireString,
};

/**
 * A page renamed on GitHub names its page by D1 row id, its old and new
 * slugs, and the block GitHub's file holds: `""` for a file with none, never
 * null, since the arm stores it only onto a block never captured.
 */
const PAGE_RENAME_FIELDS: FieldDomains = {
  from: isWirePageSlug,
  to: isWirePageSlug,
  frontmatter: isWireString,
};

// ---------------------------------------------------------------------------
// Reading an entry against a table
// ---------------------------------------------------------------------------

/**
 * True for a value an arm can carry as an entry: a non-null object that is not
 * an array. Yjs stores plain JSON verbatim, and every arm's accessor reads a
 * property off the entry, so `null` and `[]` are the shapes that throw before
 * any domain gets to speak.
 */
function isWireEntry(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every field of `table` the entry states out of domain, by path. */
function refusedFields(entry: object, table: FieldDomains, prefix: string): FieldRefusal[] {
  const held = entry as Record<string, unknown>;
  const refusals: FieldRefusal[] = [];
  for (const [field, domain] of Object.entries(table)) {
    const value = held[field];
    if (domain(value)) continue;
    refusals.push({ field: `${prefix}${field}`, found: typeNameOf(value) });
  }
  return refusals;
}

/** The name a field outside a strict table is reported under; the key itself is never rendered. */
const UNLISTED_FIELD = "unlisted";

/**
 * Every field of `table` the entry states out of domain, and one refusal for
 * each field it holds that is neither in `table` nor `identity`.
 */
function refusedStrictly(entry: object, table: FieldDomains, identity: string): FieldRefusal[] {
  const held = entry as Record<string, unknown>;
  const unlisted = Object.keys(held)
    .filter((field) => field !== identity && !Object.hasOwn(table, field))
    .map((field) => ({ field: UNLISTED_FIELD, found: typeNameOf(held[field]) }));
  return [...unlisted, ...refusedFields(entry, table, "")];
}

/**
 * Whether an array-shaped container field is one an arm can read: absent, or
 * an array whose elements are all non-null objects. Reported alongside the
 * entry's own shape, before identity, so `steps: {}` and `layers: [null]`
 * never reach the builder that removes an existing story of the same key on
 * its way to an iteration that would throw on them.
 */
function refusedInContainerShape(value: unknown, name: string): FieldRefusal[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return [{ field: name, found: typeNameOf(value) }];
  const refusals: FieldRefusal[] = [];
  value.forEach((element, index) => {
    if (!isWireEntry(element)) {
      refusals.push({ field: `${name}[${index}]`, found: typeNameOf(element) });
    }
  });
  return refusals;
}

/**
 * The field values inside an array-shaped container, once
 * `refusedInContainerShape` has already passed it: every element here is
 * known to be a non-null object, so only its fields are read.
 */
function refusedInContainerFields(value: unknown, name: string, table: FieldDomains): FieldRefusal[] {
  if (!Array.isArray(value)) return [];
  const refusals: FieldRefusal[] = [];
  value.forEach((element, index) => {
    refusals.push(...refusedFields(element as object, table, `${name}[${index}].`));
  });
  return refusals;
}

/**
 * Whether a single-object container field is one an arm can read: absent, or
 * a non-null, non-array object. The object-update `fields` map is this shape,
 * not an array, so it gets its own version of the container-shape rule.
 */
function refusedInObjectContainerShape(value: unknown, name: string): FieldRefusal[] {
  if (value === undefined) return [];
  return isWireEntry(value) ? [] : [{ field: name, found: typeNameOf(value) }];
}

/** A story insert carries its steps and layers as two sibling arrays. */
function shapeOfStoryInsert(entry: object): FieldRefusal[] {
  const held = entry as { steps?: unknown; layers?: unknown };
  return [
    ...refusedInContainerShape(held.steps, "steps"),
    ...refusedInContainerShape(held.layers, "layers"),
  ];
}

/** The story insert's own fields and its already-shaped containers' fields. */
function valueOfStoryInsert(entry: object): FieldRefusal[] {
  const held = entry as { steps?: unknown; layers?: unknown };
  return [
    ...refusedFields(entry, STORY_SCALARS, ""),
    ...refusedInContainerFields(held.steps, "steps", STEP_FIELDS),
    ...refusedInContainerFields(held.layers, "layers", LAYER_FIELDS),
  ];
}

/**
 * A content replacement states its steps and layers as a story insert does,
 * and the raw canonical hash the author reviewed, which the arm compares with
 * the live story before applying anything.
 */
function shapeOfStoryReplaceContent(entry: object): FieldRefusal[] {
  const held = entry as { steps?: unknown; layers?: unknown };
  // Both stated: an absent list would read as a story with no steps, and
  // replacing a story's content with nothing is an accept of its own.
  const absent = (["steps", "layers"] as const)
    .filter((name) => held[name] === undefined)
    .map((name) => ({ field: name, found: typeNameOf(undefined) }));
  return [...absent, ...shapeOfStoryInsert(entry)];
}

function valueOfStoryReplaceContent(entry: object): FieldRefusal[] {
  const held = entry as { steps?: unknown; layers?: unknown; expected?: unknown };
  return [
    ...refusedFields(entry, { expected: isWireString }, ""),
    ...refusedInContainerFields(held.steps, "steps", STEP_FIELDS),
    ...refusedInContainerFields(held.layers, "layers", LAYER_FIELDS),
  ];
}

/**
 * A kept-columns blob as the capture's producer emits one: a JSON object with
 * at least one key and a string at every key, the form `mapStoryCsv` records
 * (`extrasBlob`). Nothing else is a capture: an empty blob records nothing,
 * and a value that is not a string has no cell to publish.
 */
function isKeptColumnsBlob(value: unknown): boolean {
  if (typeof value !== "string") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const cells = Object.values(parsed as Record<string, unknown>);
  return cells.length > 0 && cells.every((cell) => typeof cell === "string");
}

const CAPTURE_STEP_FIELDS: FieldDomains = {
  stepId: isWireRowId,
  extra_columns: isKeptColumnsBlob,
};

/**
 * A row the capture inserts: the step it follows, by D1 row id or null for
 * first, and the row's fields as the story reader mapped them. The fields are
 * a section step's, which holds no object, prose or layers, and its kept
 * cells are what makes it a row at all.
 */
const CAPTURE_INSERT_FIELDS: FieldDomains = {
  afterStepId: orNull(isWireRowId),
};

const CAPTURE_INSERT_STEP_FIELDS: FieldDomains = {
  page: orAbsent(isWireString),
  x: orAbsent(isWireCoordinate),
  y: orAbsent(isWireCoordinate),
  zoom: orAbsent(isWireCoordinate),
  clip_start: orAbsent(isWireString),
  clip_end: orAbsent(isWireString),
  loop: orAbsent(isWireString),
  extra_columns: isKeptColumnsBlob,
};

/**
 * A kept-columns capture states its steps, each by D1 row id, and the raw
 * canonical hash of the story the capture was aligned against; and may state
 * rows to insert, each with its `step` an object.
 */
function shapeOfStepCaptureKeptColumns(entry: object): FieldRefusal[] {
  const { steps, inserts } = entry as { steps?: unknown; inserts?: unknown };
  if (steps === undefined) return [{ field: "steps", found: typeNameOf(undefined) }];
  const refusals = [...refusedInContainerShape(steps, "steps"), ...refusedInContainerShape(inserts, "inserts")];
  if (refusals.length > 0 || inserts === undefined) return refusals;
  (inserts as Array<{ step?: unknown }>).forEach((insert, index) => {
    if (!isWireEntry(insert.step)) refusals.push({ field: `inserts[${index}].step`, found: typeNameOf(insert.step) });
  });
  return refusals;
}

/** Each insert's place and its step's fields, the containers already shaped. */
function refusedCaptureInserts(inserts: unknown): FieldRefusal[] {
  if (!Array.isArray(inserts)) return [];
  return inserts.flatMap((insert: { step: object }, index) => [
    ...refusedFields(insert, CAPTURE_INSERT_FIELDS, `inserts[${index}].`),
    ...refusedFields(insert.step, CAPTURE_INSERT_STEP_FIELDS, `inserts[${index}].step.`),
  ]);
}

/** The expected hash, every step's id and blob, no step named twice, and every insert. */
function valueOfStepCaptureKeptColumns(entry: object): FieldRefusal[] {
  const held = entry as { steps?: unknown; inserts?: unknown };
  const refusals = [
    ...refusedFields(entry, { expected: isWireString }, ""),
    ...refusedInContainerFields(held.steps, "steps", CAPTURE_STEP_FIELDS),
    ...refusedCaptureInserts(held.inserts),
  ];
  const seen = new Set<unknown>();
  (held.steps as Array<{ stepId?: unknown }>).forEach((step, index) => {
    if (seen.has(step.stepId)) refusals.push({ field: `steps[${index}].stepId`, found: "duplicate" });
    seen.add(step.stepId);
  });
  return refusals;
}

/**
 * An object update carries its values in a `fields` map, and may name the D1
 * row it means (`docId`). A `docId` that is not a row id is refused here,
 * before the arm compares it with the document's `_id`s: an update naming no
 * row it could hold would otherwise be answered as skipped.
 */
function shapeOfObjectUpdate(entry: object): FieldRefusal[] {
  const held = entry as { fields?: unknown; docId?: unknown; seen?: unknown };
  return [
    ...refusedFields(held, OBJECT_UPDATE_ROW, ""),
    ...refusedInObjectContainerShape(held.fields, "fields"),
    ...refusedInObjectContainerShape(held.seen, "seen"),
    ...refusedRename(entry),
  ];
}

/**
 * An update's `renameTo`: absent, or a spelling of the entry's own id that
 * differs from it only in the whitespace CPython strips, and is not blank. It
 * exists to give an object stored under a stripped id the spelling GitHub's
 * objects.csv writes, and nothing else; any other rename is refused.
 */
function refusedRename(entry: object): FieldRefusal[] {
  const { objectId, renameTo } = entry as { objectId?: unknown; renameTo?: unknown };
  if (renameTo === undefined) return [];
  const respelling =
    typeof renameTo === "string" &&
    typeof objectId === "string" &&
    renameTo !== objectId &&
    pythonStrip(renameTo) !== "" &&
    pythonStrip(renameTo) === pythonStrip(objectId);
  return respelling ? [] : [{ field: "renameTo", found: typeNameOf(renameTo) }];
}

/**
 * The already-shaped `fields` and `seen` maps' own values. Unknown keys there
 * are ignored rather than refused, which is the arm's own rule: the update
 * loop writes, and compares, only the keys it recognises, so a payload
 * carrying `_id` beside a title still applies the title.
 */
function valueOfObjectUpdate(entry: object): FieldRefusal[] {
  const { fields, seen } = entry as { fields?: unknown; seen?: unknown };
  return [
    ...(fields === undefined ? [] : refusedFields(fields as object, OBJECT_UPDATE_FIELDS, "fields.")),
    ...(seen === undefined ? [] : refusedFields(seen as object, OBJECT_UPDATE_FIELDS, "seen.")),
  ];
}

// ---------------------------------------------------------------------------
// The arms
// ---------------------------------------------------------------------------

/** The arm names the response and the diagnostics use. */
export type IngestArmName =
  | "storyUpdate" | "storyInsert" | "storyReplaceContent"
  | "stepCaptureKeptColumns"
  | "objectUpdate" | "objectInsert" | "objectRemove" | "objectOrder" | "objectSheet"
  | "glossaryUpdate" | "glossaryInsert"
  | "pageInsert" | "pageCaptureFrontmatter" | "pageReplaceContent" | "pageStoreWrittenFrontmatter"
  | "pageRemove" | "pageRename";

/** The arm name a top-level field is reported under. */
export const TOP_LEVEL_ARM = "top";

/** The arm name the config entries are reported under. */
export const CONFIG_ARM = "config";

/** The field name a refusal of the entry itself is reported under. */
const ENTRY_FIELD = "entry";

/** The field name a refusal of the arm's own container is reported under. */
const ENTRIES_FIELD = "entries";

interface ArmDomain {
  /** The root whose identity key vets the entry. */
  root: IngestIdentityRoot;
  /**
   * Set for an arm that names its entity by D1 row id rather than by the
   * root's human key: the identity is then a row id, as `isWireRowId` states
   * it, and absence is refused as it is for a human key.
   */
  byRowId?: true;
  /** `objects.remove` states its identity as the entry itself, a string. */
  entriesAreStrings: boolean;
  /**
   * The container-shape checks that run BEFORE identity, alongside the
   * entry's own object-shape check: an out-of-shape container must be caught
   * here so it cannot reach the builder that removes an existing same-key
   * entry before it iterates the container.
   */
  shapeCheck: ((entry: object) => FieldRefusal[]) | null;
  /** The value domains applied to the survivors of the shape and identity partitions. */
  check: ((entry: object) => FieldRefusal[]) | null;
}

const INGEST_ARMS: Readonly<Record<IngestArmName, ArmDomain>> = {
  storyUpdate: {
    root: "stories",
    entriesAreStrings: false,
    shapeCheck: null,
    check: (entry) => refusedFields(entry, STORY_SCALARS, ""),
  },
  storyInsert: {
    root: "stories",
    entriesAreStrings: false,
    shapeCheck: shapeOfStoryInsert,
    check: valueOfStoryInsert,
  },
  storyReplaceContent: {
    root: "stories",
    entriesAreStrings: false,
    shapeCheck: shapeOfStoryReplaceContent,
    check: valueOfStoryReplaceContent,
  },
  stepCaptureKeptColumns: {
    root: "stories",
    entriesAreStrings: false,
    shapeCheck: shapeOfStepCaptureKeptColumns,
    check: valueOfStepCaptureKeptColumns,
  },
  objectUpdate: {
    root: "objects",
    entriesAreStrings: false,
    shapeCheck: shapeOfObjectUpdate,
    check: valueOfObjectUpdate,
  },
  objectInsert: {
    root: "objects",
    entriesAreStrings: false,
    shapeCheck: null,
    check: (entry) => refusedFields(entry, OBJECT_INSERT_FIELDS, ""),
  },
  objectRemove: { root: "objects", entriesAreStrings: true, shapeCheck: null, check: null },
  objectOrder: {
    root: "objects",
    entriesAreStrings: false,
    shapeCheck: (entry) => refusedFields(entry, OBJECT_ORDER_ROW, ""),
    check: null,
  },
  objectSheet: {
    root: "objects",
    entriesAreStrings: false,
    shapeCheck: (entry) => refusedFields(entry, OBJECT_SHEET_ROW, ""),
    check: null,
  },
  glossaryUpdate: {
    root: "glossary",
    entriesAreStrings: false,
    shapeCheck: null,
    check: (entry) => refusedFields(entry, GLOSSARY_UPDATE_FIELDS, ""),
  },
  glossaryInsert: {
    root: "glossary",
    entriesAreStrings: false,
    shapeCheck: null,
    check: (entry) => refusedFields(entry, GLOSSARY_INSERT_FIELDS, ""),
  },
  pageInsert: {
    root: "pages",
    entriesAreStrings: false,
    shapeCheck: null,
    check: (entry) => refusedFields(entry, PAGE_INSERT_FIELDS, ""),
  },
  pageCaptureFrontmatter: {
    root: "pages",
    byRowId: true,
    entriesAreStrings: false,
    shapeCheck: null,
    check: (entry) => refusedFields(entry, PAGE_CAPTURE_FIELDS, ""),
  },
  pageReplaceContent: {
    root: "pages",
    byRowId: true,
    entriesAreStrings: false,
    shapeCheck: null,
    check: (entry) => refusedFields(entry, PAGE_REPLACE_CONTENT_FIELDS, ""),
  },
  pageStoreWrittenFrontmatter: {
    root: "pages",
    byRowId: true,
    entriesAreStrings: false,
    shapeCheck: null,
    check: (entry) => refusedStrictly(entry, PAGE_STORE_WRITTEN_FIELDS, PAGE_ROW_IDENTITY),
  },
  pageRemove: {
    root: "pages",
    byRowId: true,
    entriesAreStrings: false,
    shapeCheck: null,
    check: (entry) => refusedFields(entry, PAGE_REMOVE_FIELDS, ""),
  },
  pageRename: {
    root: "pages",
    byRowId: true,
    entriesAreStrings: false,
    shapeCheck: null,
    check: (entry) => refusedFields(entry, PAGE_RENAME_FIELDS, ""),
  },
};

/** The identity split for an arm, by the root's human key or by row id. */
function identityPartition<T>(
  entries: readonly T[],
  domain: ArmDomain,
  identity: (entry: T) => unknown,
): { accepted: Array<{ position: number; entry: T }>; refused: number[] } {
  if (!domain.byRowId) return partitionOnIdentityDomainIndexed(entries, domain.root, identity);
  const accepted: Array<{ position: number; entry: T }> = [];
  const refused: number[] = [];
  entries.forEach((entry, position) => {
    if (isWireRowId(identity(entry))) accepted.push({ position, entry });
    else refused.push(position);
  });
  return { accepted, refused };
}

// ---------------------------------------------------------------------------
// Partitioning a payload
// ---------------------------------------------------------------------------

/**
 * One refused field, named by the arm it arrived on, the entry's position in
 * that arm, the field's path inside the entry, and the TYPE that stood there.
 *
 * `position` is null for a top-level field, which belongs to no entry.
 */
export interface IngestDiagnostic {
  arm: string;
  position: number | null;
  field: string;
  found: string;
}

/** One ingest arm split on the shape, identity and value domains. */
export interface IngestArmPartition<T> {
  accepted: T[];
  /** Positions in the arm as it arrived, ascending. */
  refused: number[];
}

/**
 * The arm's entries, or none. An arm that is not an array carries no entry to
 * report by position, so it is named once at the arm and treated as empty —
 * the alternative is a `forEach` on a non-array, which ends the request in a
 * 500 before the gate.
 */
function armEntries(raw: unknown, arm: string, diagnostics: IngestDiagnostic[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw === undefined) return [];
  diagnostics.push({ arm, position: null, field: ENTRIES_FIELD, found: typeNameOf(raw) });
  return [];
}

/**
 * Split one ingest arm into the entries the document may take and the positions
 * of those it may not, BEFORE any of it reaches the document.
 *
 * Shape, then identity, then value, and every refusal carries the entry's
 * ORIGINAL position: the structural check has to run first because the identity
 * accessor reads a property off the entry, and the value check runs on the
 * survivors of a partition that has already dropped entries, so the position it
 * reports has to be carried rather than recomputed.
 *
 * An entry with one or more out-of-domain fields is refused whole and counted
 * once: the arms write an entry's fields together, and applying the readable
 * half would leave a row stating a mixture of the payload and the document that
 * no producer sent.
 *
 * The array type on `raw` is the PRODUCER's declaration and is not evidence:
 * the payload is parsed from a request body, so the arm itself is checked for
 * being an array before anything walks it.
 */
/** Record one entry's refusal, by position, with every field it named. */
function recordRefusal(
  refused: number[],
  diagnostics: IngestDiagnostic[],
  arm: string,
  position: number,
  refusals: readonly FieldRefusal[],
): void {
  refused.push(position);
  for (const { field, found } of refusals) diagnostics.push({ arm, position, field, found });
}

/**
 * The entry's own object shape, plus the arm's container shapes, stated
 * out of domain — or none, when the entry may proceed to identity.
 * `objects.remove` entries are strings and carry no shape to check.
 */
function shapeRefusals(entry: unknown, domain: ArmDomain): FieldRefusal[] {
  if (domain.entriesAreStrings) return [];
  if (!isWireEntry(entry)) return [{ field: ENTRY_FIELD, found: typeNameOf(entry) }];
  return domain.shapeCheck ? domain.shapeCheck(entry as object) : [];
}

export function partitionIngestArm<T>(
  raw: readonly T[] | undefined,
  arm: IngestArmName,
  identity: (entry: T) => unknown,
  diagnostics: IngestDiagnostic[],
): IngestArmPartition<T> {
  const domain = INGEST_ARMS[arm];
  const refused: number[] = [];
  const shaped: Array<{ position: number; entry: T }> = [];
  armEntries(raw, arm, diagnostics).forEach((entry, position) => {
    const refusals = shapeRefusals(entry, domain);
    if (refusals.length > 0) {
      recordRefusal(refused, diagnostics, arm, position, refusals);
      return;
    }
    shaped.push({ position, entry: entry as T });
  });

  const identified = identityPartition(shaped.map((held) => held.entry), domain, identity);
  for (const at of identified.refused) refused.push(shaped[at].position);

  const accepted: T[] = [];
  for (const { position, entry } of identified.accepted) {
    const original = shaped[position].position;
    const refusals = domain.check ? domain.check(entry as object) : [];
    if (refusals.length === 0) {
      accepted.push(entry);
      continue;
    }
    recordRefusal(refused, diagnostics, arm, original, refusals);
  }
  refused.sort((a, b) => a - b);
  return { accepted, refused };
}

// ---------------------------------------------------------------------------
// The config arm
// ---------------------------------------------------------------------------

/**
 * The longest key `skipped.config` will name back to the caller, and the
 * characters it may hold. `skipped.config` is a `string[]` a caller renders, so
 * only a key that is already a plain identifier goes into it; every other
 * unknown key is refused by position, which names the entry without stating it.
 */
const CONFIG_KEY_MAX = 64;
const CONFIG_KEY_SHAPE = /^[a-z_]+$/;

function isReportableConfigKey(key: string): boolean {
  return key.length <= CONFIG_KEY_MAX && CONFIG_KEY_SHAPE.test(key);
}

/** The domain of one settable config key, or null when the key is unlisted. */
function configValueDomain(key: string): WireDomain | null {
  if (CONFIG_YTEXT_KEYS.has(key)) return isWireString;
  if (key === CONFIG_REPAIR_OFF_KEY) return isWireFalse;
  if (!CONFIG_PLAIN_KEYS.has(key)) return null;
  if (CONFIG_FLAG_KEYS.has(key)) return isWireBoolean;
  if (key === CONFIG_COUNT_KEY) return isWireInteger;
  return isWireString;
}

/**
 * The config arm split three ways.
 *
 * The `Y.Text` keys and the plain keys are separate lists because they are
 * separate writes — a character-merged replacement and a scalar set — and the
 * key's own list is what decides which, so neither loop needs to ask.
 */
export interface ConfigArmPartition {
  text: Array<{ key: string; value: string }>;
  plain: Array<{ key: string; value: string | boolean | number }>;
  /** Unlisted keys, safe to name back. */
  skipped: string[];
  /** Positions in the arm as it arrived. */
  refused: number[];
}

export function partitionConfigArm(
  raw: unknown,
  diagnostics: IngestDiagnostic[],
): ConfigArmPartition {
  const text: Array<{ key: string; value: string }> = [];
  const plain: Array<{ key: string; value: string | boolean | number }> = [];
  const skipped: string[] = [];
  const refused: number[] = [];
  const refuse = (position: number, field: string, found: unknown): void => {
    refused.push(position);
    diagnostics.push({ arm: CONFIG_ARM, position, field, found: typeNameOf(found) });
  };

  armEntries(raw, CONFIG_ARM, diagnostics).forEach((entry, position) => {
    if (!isWireEntry(entry)) return refuse(position, ENTRY_FIELD, entry);
    const key = (entry as { key?: unknown }).key;
    if (typeof key !== "string") return refuse(position, "key", key);
    const domain = configValueDomain(key);
    if (domain === null) {
      if (isReportableConfigKey(key)) skipped.push(key);
      else refuse(position, "key", key);
      return;
    }
    const value = (entry as { value?: unknown }).value;
    if (!domain(value)) return refuse(position, "value", value);
    if (CONFIG_YTEXT_KEYS.has(key)) text.push({ key, value: value as string });
    else plain.push({ key, value: value as string | boolean | number });
  });

  return { text, plain, skipped, refused };
}

// ---------------------------------------------------------------------------
// Top-level and defaulted fields
// ---------------------------------------------------------------------------

/**
 * `telarVersion` is advisory — it keeps the document's copy aligned with a heal
 * the caller performs on D1 directly — so a value out of domain refuses that
 * one field and leaves the rest of the payload to be applied.
 */
export function checkTelarVersion(value: unknown, diagnostics: IngestDiagnostic[]): void {
  if (value === undefined || isWireString(value)) return;
  diagnostics.push({
    arm: TOP_LEVEL_ARM, position: null, field: "telarVersion", found: typeNameOf(value),
  });
}

/**
 * The text an insert stores where the payload states none. Empty is what the
 * column takes for a field nobody has written.
 */
export function statedText(value: string | undefined): string {
  return value ?? "";
}

/**
 * The flag an insert stores where the payload states none: `false`, each
 * column's own default. The two flags do not read the same way at that
 * default — `false` is public for `isPrivate` and is hidden sections for
 * `showSections` — but both take it, so the Y.Map's value stays a boolean
 * rather than `undefined`.
 */
export function statedFlag(value: boolean | undefined): boolean {
  return value ?? false;
}
