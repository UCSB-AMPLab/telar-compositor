/**
 * Manifest schema — types and validator for the migration manifest DSL.
 *
 * The DSL (see docs/compositor/migration-manifest-schema.md) describes
 * user-content transforms applied during a Telar framework upgrade. This file
 * defines the TypeScript shape of a manifest and a runtime validator that
 * rejects malformed manifests before any operation is applied.
 *
 * Design notes:
 *   - Pure validation: no I/O, no side effects. Throws ManifestValidationError
 *     on invalid input with a JSON-pointer-style path.
 *   - Allowlist-based: the 9 operation types are exhaustively matched;
 *     unknown types fail validation.
 *   - Bilingual fields ({ en, es }) resolved via resolveBilingual helper.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Language = "en" | "es";
export type Bilingual<T> = { en: T; es: T };
export type LocalizedString = string | Bilingual<string>;

/**
 * Audience for a manual upgrade step. Filters which users see the step in
 * post-upgrade guidance:
 *   "all"            — everyone sees it (default when unset; feature highlights)
 *   "compositor"     — compositor users only (e.g. UI-specific instructions)
 *   "local"          — users running scripts/upgrade.py locally (CLI / build tooling)
 *   "google-sheets"  — users with Google Sheets integration enabled
 *
 * The compositor shows steps whose audience is "all", "compositor", or
 * "google-sheets" when the site has GS enabled. Local-only steps are hidden.
 */
export type StepAudience = "all" | "compositor" | "local" | "google-sheets";

export interface ManualStep {
  description: string;
  doc_url?: string;
  audience?: StepAudience;
}

export interface Manifest {
  schema_version: 1;
  from_version: string;
  to_version: string;
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

export interface CreateDirectoryOp {
  type: "create_directory";
  path: string;
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

const VALID_AUDIENCES: StepAudience[] = ["all", "compositor", "local", "google-sheets"];

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
    if (typeof obj.audience !== "string" || !VALID_AUDIENCES.includes(obj.audience as StepAudience)) {
      throw new ManifestValidationError(
        `Invalid audience "${String(obj.audience)}". Expected one of: ${VALID_AUDIENCES.join(", ")}`,
        `${path}/audience`,
      );
    }
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
  switch (op.type) {
    case "config_add_field":
      return validateConfigAddField(op, path);
    case "config_update_value":
      return validateConfigUpdateValue(op, path);
    case "config_rename_field":
      return validateConfigRenameField(op, path);
    case "csv_add_column":
      return validateCsvAddColumn(op, path);
    case "csv_rename_column":
      return validateCsvRenameColumn(op, path);
    case "file_delete":
      return validateFileDelete(op, path);
    case "gitignore_add":
      return validateGitignoreAdd(op, path);
    case "regex_replace":
      return validateRegexReplace(op, path);
    case "create_directory":
      return validateCreateDirectory(op, path);
    default:
      throw new ManifestValidationError(
        `Unknown operation type "${op.type}"`,
        `${path}/type`,
      );
  }
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

function validateCreateDirectory(
  op: Record<string, unknown>,
  path: string,
): CreateDirectoryOp {
  requireString(requireField(op, "path", path), `${path}/path`);
  return op as unknown as CreateDirectoryOp;
}

// ---------------------------------------------------------------------------
// Top-level validator
// ---------------------------------------------------------------------------

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
