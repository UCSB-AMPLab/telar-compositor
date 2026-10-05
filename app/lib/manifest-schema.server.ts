/**
 * Manifest schema — types and validator for the migration manifest DSL.
 *
 * The DSL describes
 * user-content transforms applied during a Telar framework upgrade. This file
 * defines the TypeScript shape of a manifest and a runtime validator that
 * rejects malformed manifests before any operation is applied.
 *
 * Design notes:
 *   - Pure validation: no I/O, no side effects. Throws ManifestValidationError
 *     on invalid input with a JSON-pointer-style path.
 *   - Allowlist-based: the 10 operation types are exhaustively matched;
 *     unknown types fail validation.
 *   - The paths an operation may write by name — a `regex_replace` match, a
 *     `yaml_list_add` file — are held to one scope allowlist, defined here so
 *     the validator and the runner apply the same one.
 *   - Bilingual fields ({ en, es }) resolved via resolveBilingual helper.
 *   - A manual step's `audience` is the one field that is *not*
 *     allowlist-based: any string is accepted (see StepAudience below). A
 *     malformed manifest (from an untrusted or future framework release)
 *     must not be able to reject itself out of the only route that would
 *     fix it.
 *
 * @version v1.5.0-beta
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Language = "en" | "es";
export type Bilingual<T> = { en: T; es: T };
export type LocalizedString = string | Bilingual<string>;

/**
 * The audience values this build knows the meaning of, and filters on:
 *   "all"            — everyone sees it (default when unset; feature highlights)
 *   "compositor"     — compositor users only (e.g. UI-specific instructions)
 *   "local"          — users running scripts/upgrade.py locally (CLI / build tooling)
 *   "google-sheets"  — users with Google Sheets integration enabled
 *
 * The compositor shows steps whose audience is "all", "compositor", or
 * "google-sheets" (when the site has GS enabled). "local" steps are hidden.
 * See `isStepVisible` in app/components/features/upgrade/PostUpgradeSteps.tsx.
 */
const VALID_AUDIENCES = ["all", "compositor", "local", "google-sheets"] as const;
export type KnownAudience = (typeof VALID_AUDIENCES)[number];

/**
 * Audience for a manual upgrade step. Not restricted to KnownAudience: a
 * manifest from a framework release newer than this compositor build may
 * name an audience this build doesn't recognise yet, and that is a valid
 * manifest, not a malformed one — the schema only rejects a non-string
 * value here. An unrecognised string must still resolve to a visible step:
 * the framework's own contract (scripts/telar/telar_upgrade.py,
 * `_visible_manual_steps`) errs an unknown audience towards showing, since a
 * step nobody can see is the failure the field exists to prevent.
 */
export type StepAudience = KnownAudience | (string & {});

/**
 * What a manual step asks of its reader. An `action` is something
 * the upgrade left undone that the reader may need to do; `optional` is an
 * action that need not be done; a `note` is what changed, including how to
 * use it. Not restricted to these: a value from a newer framework is valid,
 * and a step with an unrecognised or absent kind is shown as unclassified,
 * never as a note, since a note can be passed over.
 */
export const VALID_STEP_KINDS = ["action", "optional", "note"] as const;
export type KnownStepKind = (typeof VALID_STEP_KINDS)[number];
export type StepKind = KnownStepKind | (string & {});

export interface ManualStep {
  description: string;
  doc_url?: string;
  audience?: StepAudience;
  kind?: StepKind;
}

export interface Manifest {
  schema_version: 1;
  from_version: string;
  to_version: string;
  /**
   * The date of the release this manifest installs, `YYYY-MM-DD`, as the
   * framework declares it for its own engine to stamp. Optional: manifests
   * before v1.8.0 do not carry one.
   */
  release_date?: string;
  description: string;
  operations: Operation[];
  manual_steps: { en: ManualStep[]; es: ManualStep[] };
}

export type Operation =
  | ConfigAddFieldOp
  | ConfigUpdateValueOp
  | ConfigRenameFieldOp
  | CsvAddColumnOp
  | CsvRenameColumnOp
  | FileDeleteOp
  | GitignoreAddOp
  | RegexReplaceOp
  | YamlListAddOp
  | CreateDirectoryOp;

export interface ConfigAddFieldOp {
  type: "config_add_field";
  key: string;
  value: string;
  after_key: string;
  comment?: string;
  skip_if_exists?: boolean;
}

export interface ConfigUpdateValueOp {
  type: "config_update_value";
  key: string;
  old_value: string;
  new_value: string;
}

export interface ConfigRenameFieldOp {
  type: "config_rename_field";
  old_key: string;
  new_key: string;
}

export interface CsvAddColumnOp {
  type: "csv_add_column";
  file_glob: string;
  column: LocalizedString;
  default: string;
  after: LocalizedString;
}

export interface CsvRenameColumnOp {
  type: "csv_rename_column";
  file_glob: string;
  old_name: LocalizedString;
  new_name: LocalizedString;
}

export interface FileDeleteOp {
  type: "file_delete";
  paths: string[];
}

export interface GitignoreAddOp {
  type: "gitignore_add";
  patterns: string[];
  section_comment?: string;
}

export interface RegexReplaceOp {
  type: "regex_replace";
  file_glob: string;
  search: string;
  replace: string;
}

/**
 * Values added to a top-level list in a YAML file, the text edited in place
 * (see yaml-list-add.server.ts).
 */
export interface YamlListAddOp {
  type: "yaml_list_add";
  file: string;
  key: string;
  values: string[];
}

export interface CreateDirectoryOp {
  type: "create_directory";
  path: string;
}

// ---------------------------------------------------------------------------
// Scope allowlist
// ---------------------------------------------------------------------------

const REGEX_REPLACE_SCOPE_ALLOWLIST: RegExp[] = [
  /^[^/].*\.csv$/,
  /^[^/].*\.yml$/,
  /^[^/].*\.yaml$/,
  /^[^/].*\.md$/,
  /^[^/].*\.markdown$/,
  /^[^/].*\.html$/,
  /^_config\.yml$/,
  /^\.gitignore$/,
];

/**
 * Whether an operation may write `path`: a text file of the kinds a site
 * owns, never an absolute path, one that climbs out with `..`, or one under
 * `.git/`.
 */
export function isPathInScope(path: string): boolean {
  if (path.startsWith("/") || path.includes("..") || path.startsWith(".git/")) {
    return false;
  }
  return REGEX_REPLACE_SCOPE_ALLOWLIST.some((r) => r.test(path));
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Thrown by validateManifest when a manifest is malformed. The `path` field is
 * a JSON-pointer-style path to the offending node (e.g. "/operations/0/type")
 * so callers can surface precise error messages to manifest authors.
 */
export class ManifestValidationError extends Error {
  constructor(
    message: string,
    public readonly path: string,
  ) {
    super(`${message} (at ${path})`);
    this.name = "ManifestValidationError";
  }
}

// ---------------------------------------------------------------------------
// Bilingual helper
// ---------------------------------------------------------------------------

/**
 * Resolve a bilingual value ({ en, es }) to the requested language, or return
 * the value unchanged if it is not a bilingual object (scalar passthrough).
 */
export function resolveBilingual<T>(
  value: Bilingual<T> | T,
  lang: Language,
): T {
  if (
    value !== null &&
    typeof value === "object" &&
    "en" in (value as object) &&
    "es" in (value as object)
  ) {
    return (value as Bilingual<T>)[lang];
  }
  return value as T;
}

// ---------------------------------------------------------------------------
// Validator helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new ManifestValidationError("Expected object", path);
  }
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new ManifestValidationError("Expected string", path);
  }
  return value;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ManifestValidationError("Expected array", path);
  }
  return value;
}

function requireStringArray(value: unknown, path: string): string[] {
  const arr = requireArray(value, path);
  arr.forEach((item, i) => {
    if (typeof item !== "string") {
      throw new ManifestValidationError("Expected string", `${path}/${i}`);
    }
  });
  return arr as string[];
}

/**
 * Validate a localised string field: either a plain string, or an object with
 * both `en` and `es` string fields.
 */
function requireLocalizedString(value: unknown, path: string): void {
  if (typeof value === "string") return;
  if (!isPlainObject(value)) {
    throw new ManifestValidationError(
      "Expected string or bilingual object",
      path,
    );
  }
  if (!("en" in value)) {
    throw new ManifestValidationError("Missing `en`", `${path}/en`);
  }
  if (typeof value.en !== "string") {
    throw new ManifestValidationError("Expected string", `${path}/en`);
  }
  if (!("es" in value)) {
    throw new ManifestValidationError("Missing `es`", `${path}/es`);
  }
  if (typeof value.es !== "string") {
    throw new ManifestValidationError("Expected string", `${path}/es`);
  }
}

function requireManualStep(value: unknown, path: string): void {
  const obj = requireObject(value, path);
  if (!("description" in obj)) {
    throw new ManifestValidationError(
      "Missing `description`",
      `${path}/description`,
    );
  }
  requireString(obj.description, `${path}/description`);
  if ("doc_url" in obj && obj.doc_url !== undefined) {
    requireString(obj.doc_url, `${path}/doc_url`);
  }
  if ("audience" in obj && obj.audience !== undefined) {
    // A non-string audience (a number, an object, ...) is a schema
    // violation: the field is malformed, not merely unrecognised.
    //
    // A string audience outside VALID_AUDIENCES is accepted, even though
    // it isn't one of the values this build knows how to filter on: a
    // manifest naming an audience from a framework release newer than this
    // compositor build is a valid manifest, and rejecting it here would
    // fail the very upgrade that would bring the recognised value. See
    // KnownAudience / StepAudience above, and isStepVisible in
    // app/components/features/upgrade/PostUpgradeSteps.tsx, which must show such a step rather than
    // silently drop it.
    if (typeof obj.audience !== "string") {
      throw new ManifestValidationError(
        `Invalid audience "${String(obj.audience)}": expected a string`,
        `${path}/audience`,
      );
    }
  }
  // Same terms as audience: a kind this build does not know is valid, and
  // is shown as unclassified.
  if ("kind" in obj && obj.kind !== undefined && typeof obj.kind !== "string") {
    throw new ManifestValidationError(`Invalid kind "${String(obj.kind)}": expected a string`, `${path}/kind`);
  }
}

function requireManualSteps(
  value: unknown,
  path: string,
): { en: ManualStep[]; es: ManualStep[] } {
  const obj = requireObject(value, path);
  if (!("en" in obj)) {
    throw new ManifestValidationError("Missing `en`", `${path}/en`);
  }
  const en = requireArray(obj.en, `${path}/en`);
  en.forEach((step, i) => requireManualStep(step, `${path}/en/${i}`));
  if (!("es" in obj)) {
    throw new ManifestValidationError("Missing `es`", `${path}/es`);
  }
  const es = requireArray(obj.es, `${path}/es`);
  es.forEach((step, i) => requireManualStep(step, `${path}/es/${i}`));
  return {
    en: en as ManualStep[],
    es: es as ManualStep[],
  };
}

// ---------------------------------------------------------------------------
// Operation validators
// ---------------------------------------------------------------------------

function validateOperation(value: unknown, path: string): Operation {
  const op = requireObject(value, path);
  if (!("type" in op)) {
    throw new ManifestValidationError("Missing `type`", `${path}/type`);
  }
  if (typeof op.type !== "string") {
    throw new ManifestValidationError("Expected string", `${path}/type`);
  }
  if (!Object.hasOwn(OPERATION_VALIDATORS, op.type)) {
    throw new ManifestValidationError(
      `Unknown operation type "${op.type}"`,
      `${path}/type`,
    );
  }
  return OPERATION_VALIDATORS[op.type as Operation["type"]](op, path);
}

function requireField(
  op: Record<string, unknown>,
  key: string,
  path: string,
): unknown {
  if (!(key in op)) {
    throw new ManifestValidationError(
      `Missing \`${key}\``,
      `${path}/${key}`,
    );
  }
  return op[key];
}

function validateConfigAddField(
  op: Record<string, unknown>,
  path: string,
): ConfigAddFieldOp {
  requireString(requireField(op, "key", path), `${path}/key`);
  requireString(requireField(op, "value", path), `${path}/value`);
  requireString(requireField(op, "after_key", path), `${path}/after_key`);
  if ("comment" in op && op.comment !== undefined) {
    requireString(op.comment, `${path}/comment`);
  }
  if ("skip_if_exists" in op && op.skip_if_exists !== undefined) {
    if (typeof op.skip_if_exists !== "boolean") {
      throw new ManifestValidationError(
        "Expected boolean",
        `${path}/skip_if_exists`,
      );
    }
  }
  return op as unknown as ConfigAddFieldOp;
}

function validateConfigUpdateValue(
  op: Record<string, unknown>,
  path: string,
): ConfigUpdateValueOp {
  requireString(requireField(op, "key", path), `${path}/key`);
  requireString(requireField(op, "old_value", path), `${path}/old_value`);
  requireString(requireField(op, "new_value", path), `${path}/new_value`);
  return op as unknown as ConfigUpdateValueOp;
}

function validateConfigRenameField(
  op: Record<string, unknown>,
  path: string,
): ConfigRenameFieldOp {
  requireString(requireField(op, "old_key", path), `${path}/old_key`);
  requireString(requireField(op, "new_key", path), `${path}/new_key`);
  return op as unknown as ConfigRenameFieldOp;
}

function validateCsvAddColumn(
  op: Record<string, unknown>,
  path: string,
): CsvAddColumnOp {
  requireString(requireField(op, "file_glob", path), `${path}/file_glob`);
  requireLocalizedString(requireField(op, "column", path), `${path}/column`);
  requireString(requireField(op, "default", path), `${path}/default`);
  requireLocalizedString(requireField(op, "after", path), `${path}/after`);
  return op as unknown as CsvAddColumnOp;
}

function validateCsvRenameColumn(
  op: Record<string, unknown>,
  path: string,
): CsvRenameColumnOp {
  requireString(requireField(op, "file_glob", path), `${path}/file_glob`);
  requireLocalizedString(
    requireField(op, "old_name", path),
    `${path}/old_name`,
  );
  requireLocalizedString(
    requireField(op, "new_name", path),
    `${path}/new_name`,
  );
  return op as unknown as CsvRenameColumnOp;
}

function validateFileDelete(
  op: Record<string, unknown>,
  path: string,
): FileDeleteOp {
  requireStringArray(requireField(op, "paths", path), `${path}/paths`);
  return op as unknown as FileDeleteOp;
}

function validateGitignoreAdd(
  op: Record<string, unknown>,
  path: string,
): GitignoreAddOp {
  requireStringArray(requireField(op, "patterns", path), `${path}/patterns`);
  if ("section_comment" in op && op.section_comment !== undefined) {
    requireString(op.section_comment, `${path}/section_comment`);
  }
  return op as unknown as GitignoreAddOp;
}

function validateRegexReplace(
  op: Record<string, unknown>,
  path: string,
): RegexReplaceOp {
  requireString(requireField(op, "file_glob", path), `${path}/file_glob`);
  requireString(requireField(op, "search", path), `${path}/search`);
  requireString(requireField(op, "replace", path), `${path}/replace`);
  return op as unknown as RegexReplaceOp;
}

function validateYamlListAdd(
  op: Record<string, unknown>,
  path: string,
): YamlListAddOp {
  const file = requireString(requireField(op, "file", path), `${path}/file`);
  if (!isPathInScope(file)) {
    throw new ManifestValidationError(`File outside the scope allowlist: ${file}`, `${path}/file`);
  }
  requireString(requireField(op, "key", path), `${path}/key`);
  requireStringArray(requireField(op, "values", path), `${path}/values`);
  return op as unknown as YamlListAddOp;
}

function validateCreateDirectory(
  op: Record<string, unknown>,
  path: string,
): CreateDirectoryOp {
  requireString(requireField(op, "path", path), `${path}/path`);
  return op as unknown as CreateDirectoryOp;
}

/** The validator for each operation type; a type not listed here is unknown. */
const OPERATION_VALIDATORS: Readonly<
  Record<Operation["type"], (op: Record<string, unknown>, path: string) => Operation>
> = {
  config_add_field: validateConfigAddField,
  config_update_value: validateConfigUpdateValue,
  config_rename_field: validateConfigRenameField,
  csv_add_column: validateCsvAddColumn,
  csv_rename_column: validateCsvRenameColumn,
  file_delete: validateFileDelete,
  gitignore_add: validateGitignoreAdd,
  regex_replace: validateRegexReplace,
  yaml_list_add: validateYamlListAdd,
  create_directory: validateCreateDirectory,
};

// ---------------------------------------------------------------------------
// Top-level validator
// ---------------------------------------------------------------------------

/** A date written YYYY-MM-DD that exists on the calendar: 2026-02-30 does not. */
function isCalendarDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

/**
 * Validate a parsed JSON object against the migration manifest DSL. Returns
 * the input cast to `Manifest` on success; throws `ManifestValidationError`
 * with a JSON-pointer-style path on the first failure.
 *
 * Framework-only releases that ship with `operations: []` are valid — the
 * manual_steps block is still useful to communicate changes to users.
 */
export function validateManifest(input: unknown): Manifest {
  const root = requireObject(input, "");

  // schema_version must be integer 1 (NOT string "1")
  if (!("schema_version" in root)) {
    throw new ManifestValidationError(
      "Missing `schema_version`",
      "/schema_version",
    );
  }
  if (root.schema_version !== 1) {
    throw new ManifestValidationError(
      "Expected integer 1",
      "/schema_version",
    );
  }

  if (!("from_version" in root)) {
    throw new ManifestValidationError(
      "Missing `from_version`",
      "/from_version",
    );
  }
  requireString(root.from_version, "/from_version");

  if (!("to_version" in root)) {
    throw new ManifestValidationError("Missing `to_version`", "/to_version");
  }
  requireString(root.to_version, "/to_version");

  if (!("description" in root)) {
    throw new ManifestValidationError(
      "Missing `description`",
      "/description",
    );
  }
  requireString(root.description, "/description");

  if ("release_date" in root) {
    const date = requireString(root.release_date, "/release_date");
    if (!isCalendarDate(date)) {
      throw new ManifestValidationError("Expected a date written YYYY-MM-DD", "/release_date");
    }
  }

  if (!("operations" in root)) {
    throw new ManifestValidationError("Missing `operations`", "/operations");
  }
  const operations = requireArray(root.operations, "/operations");
  operations.forEach((op, i) => {
    validateOperation(op, `/operations/${i}`);
  });

  if (!("manual_steps" in root)) {
    throw new ManifestValidationError(
      "Missing `manual_steps`",
      "/manual_steps",
    );
  }
  requireManualSteps(root.manual_steps, "/manual_steps");

  return root as unknown as Manifest;
}
