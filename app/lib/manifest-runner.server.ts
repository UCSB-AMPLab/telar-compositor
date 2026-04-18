/**
 * Manifest runner for Telar site upgrades.
 *
 * Pure functions that apply a chain of migration manifests (JSON DSL, see
 * manifest-schema.server.ts) to a virtual filesystem of repo-relative path →
 * content, returning transformed files, a deletion list, and concatenated
 * manual steps.
 *
 * Design notes:
 *   - Pure: no network, no DB, no git. All I/O sits in the upgrade route
 *     action. The runner takes and returns a `Map<string, string>`.
 *   - `_config.yml` mutations use line-based editing (mirror
 *     updateTelarVersionInConfig in upgrade.server.ts) to preserve comments
 *     and whitespace exactly. Never yaml.load/yaml.dump for mutation.
 *   - CSV mutations use papaparse (same stack as parseTelarCsv in
 *     import.server.ts). Idempotency checks honour both language variants of
 *     the column name (Pitfall 3).
 *   - Bilingual fields ({ en, es }) resolve via resolveBilingual using the
 *     site's `telar_language` — passed in as `lang` on applyManifestChain.
 *   - Unknown operation type throws — exhaustive switch is enforced at compile
 *     time via the Operation union, and fail-closed at runtime.
 *   - regex_replace enforces a scope allowlist to prevent (arbitrary
 *     file corruption via a malicious glob). Paths containing `..`, starting
 *     with `/`, or under `.git/` are rejected with a hard error.
 */

import Papa from "papaparse";
import {
  type Manifest,
  type Operation,
  type Language,
  type ManualStep,
  type ConfigAddFieldOp,
  type ConfigUpdateValueOp,
  type ConfigRenameFieldOp,
  type CsvAddColumnOp,
  type CsvRenameColumnOp,
  type FileDeleteOp,
  type GitignoreAddOp,
  type RegexReplaceOp,
  type CreateDirectoryOp,
  resolveBilingual,
} from "~/lib/manifest-schema.server";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface ManifestApplyResult {
  /** Transformed files, keyed by repo-relative path. */
  files: Map<string, string>;
  /** Paths to delete (from file_delete ops), deduplicated. */
  deletions: string[];
  /** Manual steps in the site's language, concatenated across the chain. */
  manualSteps: ManualStep[];
}

// ---------------------------------------------------------------------------
// Scope allowlist for regex_replace
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

function isPathInScope(path: string): boolean {
  if (path.startsWith("/") || path.includes("..") || path.startsWith(".git/")) {
    return false;
  }
  return REGEX_REPLACE_SCOPE_ALLOWLIST.some((r) => r.test(path));
}

// ---------------------------------------------------------------------------
// Glob matcher helpers
// ---------------------------------------------------------------------------

/**
 * Escapes regex metacharacters in a string so it can be embedded verbatim in
 * a RegExp.
 */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Minimal glob matcher — supports `**`, `*`, exact chars, and `{a,b}` brace
 * expansion. Used by csv_add_column, csv_rename_column, regex_replace.
 *
 * Examples that match:
 *   - `**\/*.csv` matches `_data/project.csv`, `_data/nested/a.csv`
 *   - `**\/{project,proyecto}.csv` matches both language variants
 *   - `_data/project.csv` matches the exact path only
 */
export function matchGlob(glob: string, path: string): boolean {
  // Brace expansion: **/{a,b}.csv -> match any of the variants
  const braceMatch = glob.match(/^([^{]*)\{([^}]+)\}(.*)$/);
  if (braceMatch) {
    const [, pre, alts, post] = braceMatch;
    return alts
      .split(",")
      .some((alt) => matchGlob(`${pre}${alt}${post}`, path));
  }
  // Convert glob to regex:
  //   - `**/` -> `(?:.*/)?` so it matches zero-or-more path segments (a bare
  //     file name at the repo root still matches `**/x.csv`)
  //   - `**`  -> `.*`
  //   - `*`   -> `[^/]*`
  //   - other regex metachars escaped
  const pattern = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "§SLASH§")
    .replace(/\*\*/g, "§§")
    .replace(/\*/g, "[^/]*")
    .replace(/§§/g, ".*")
    .replace(/§SLASH§/g, "(?:.*/)?");
  return new RegExp(`^${pattern}$`).test(path);
}

function filesMatchingGlob(
  files: Map<string, string>,
  glob: string,
): string[] {
  return Array.from(files.keys()).filter((p) => matchGlob(glob, p));
}

// ---------------------------------------------------------------------------
// Line-based YAML mutation ops
// ---------------------------------------------------------------------------

/**
 * Inserts `key: value` after the `after_key` line in `_config.yml`. Respects
 * `skip_if_exists` (default true). Appends `  # ${comment}` when comment is
 * present. No-op if `_config.yml` is absent or the anchor key is missing.
 */
function opConfigAddField(
  files: Map<string, string>,
  op: ConfigAddFieldOp,
): void {
  const content = files.get("_config.yml");
  if (content === undefined) return;
  const skipIfExists = op.skip_if_exists ?? true;
  if (
    skipIfExists &&
    new RegExp(`^${escapeRegex(op.key)}:`, "m").test(content)
  ) {
    return;
  }
  const lines = content.split("\n");
  const afterIdx = lines.findIndex((l) =>
    new RegExp(`^${escapeRegex(op.after_key)}:`).test(l),
  );
  if (afterIdx < 0) return;
  const newLine = op.comment
    ? `${op.key}: ${op.value}  # ${op.comment}`
    : `${op.key}: ${op.value}`;
  lines.splice(afterIdx + 1, 0, newLine);
  files.set("_config.yml", lines.join("\n"));
}

/**
 * Replaces `key: old_value` → `key: new_value` preserving indent. Tolerates a
 * trailing comment on the original line. No-op when old_value doesn't match.
 */
function opConfigUpdateValue(
  files: Map<string, string>,
  op: ConfigUpdateValueOp,
): void {
  const content = files.get("_config.yml");
  if (content === undefined) return;
  const lines = content.split("\n");
  const re = new RegExp(
    `^(\\s*)${escapeRegex(op.key)}:\\s*${escapeRegex(op.old_value)}\\s*(?:#.*)?$`,
  );
  let changed = false;
  const out = lines.map((line) => {
    const m = line.match(re);
    if (!m) return line;
    changed = true;
    return `${m[1]}${op.key}: ${op.new_value}`;
  });
  if (changed) files.set("_config.yml", out.join("\n"));
}

/**
 * Renames `old_key: X` → `new_key: X` preserving indent, value, and any
 * trailing comment. No-op when old_key is missing.
 */
function opConfigRenameField(
  files: Map<string, string>,
  op: ConfigRenameFieldOp,
): void {
  const content = files.get("_config.yml");
  if (content === undefined) return;
  const re = new RegExp(`^(\\s*)${escapeRegex(op.old_key)}:(.*)$`);
  let changed = false;
  const out = content.split("\n").map((line) => {
    const m = line.match(re);
    if (!m) return line;
    changed = true;
    return `${m[1]}${op.new_key}:${m[2]}`;
  });
  if (changed) files.set("_config.yml", out.join("\n"));
}

// ---------------------------------------------------------------------------
// CSV mutation ops
// ---------------------------------------------------------------------------

/**
 * Adds a column (bilingually resolved) to every CSV matching `file_glob`.
 *
 * Idempotency: skips the file if EITHER language variant of the column name
 * already appears in the header (Pitfall 3 — user may have started authoring
 * in the other language before the upgrade).
 *
 * Position: inserts right after the anchor column (`after`, bilingual). If
 * neither language variant of the anchor is found, appends to the end.
 *
 * Bilingual two-row header pattern: Telar CSVs conventionally have row 0 as
 * English column names and row 1 as Spanish column names (e.g. `order,title` /
 * `orden,titulo`), with data starting at row 2 or 3. When this pattern is
 * detected via the anchor column's language variants, the new column is
 * inserted bilingually — the `en` variant in whichever header row holds
 * English, and the `es` variant in the other — so both header rows remain
 * aligned and semantically correct. Data rows are filled with `op.default`.
 *
 * Data rows: filled with `op.default` (may be an empty string).
 */
function opCsvAddColumn(
  files: Map<string, string>,
  op: CsvAddColumnOp,
  lang: Language,
): void {
  const newEn = resolveBilingual(op.column, "en");
  const newEs = resolveBilingual(op.column, "es");
  const newCol = lang === "es" ? newEs : newEn;
  const anchorEn = resolveBilingual(op.after, "en");
  const anchorEs = resolveBilingual(op.after, "es");

  for (const path of filesMatchingGlob(files, op.file_glob)) {
    const content = files.get(path)!;
    const parsed = Papa.parse<string[]>(content, { skipEmptyLines: false });
    const rows = parsed.data;
    if (rows.length === 0) continue;
    const header = rows[0];
    // Skip if column already present in either language in the header
    if (header.includes(newEn) || header.includes(newEs)) continue;

    // Find anchor in row 0 using either language variant
    let row0IsEn: boolean | null = null;
    let anchorIdx = header.indexOf(anchorEn);
    if (anchorIdx >= 0) {
      row0IsEn = true;
    } else {
      anchorIdx = header.indexOf(anchorEs);
      if (anchorIdx >= 0) row0IsEn = false;
    }
    const insertIdx = anchorIdx >= 0 ? anchorIdx + 1 : header.length;

    // Detect bilingual two-row header: row 1 has the same column count as
    // row 0 AND its cell at the anchor index matches the OTHER-language
    // anchor variant (rows 0 and 1 are sibling headers in different
    // languages). Requires the anchor to be present in both rows.
    let row1Value: string | null = null;
    if (rows.length >= 2 && anchorIdx >= 0 && row0IsEn !== null) {
      const row1 = rows[1];
      const expectedRow1Anchor = row0IsEn ? anchorEs : anchorEn;
      if (row1.length === header.length && row1[anchorIdx] === expectedRow1Anchor) {
        row1Value = row0IsEn ? newEs : newEn;
      }
    }
    const row0Value = row1Value !== null
      ? (row0IsEn ? newEn : newEs)
      : newCol;

    for (let r = 0; r < rows.length; r++) {
      let value: string;
      if (r === 0) value = row0Value;
      else if (r === 1 && row1Value !== null) value = row1Value;
      else value = op.default;
      rows[r].splice(insertIdx, 0, value);
    }
    files.set(path, Papa.unparse(rows, { newline: "\n" }));
  }
}

/**
 * Renames a CSV column. Matches old name in EITHER language, writes the new
 * name in the site's language.
 *
 * Bilingual two-row header pattern: when row 1 holds the sibling-language
 * header of row 0 (old-name's OTHER-language variant sits at the same index
 * as the matched old-name in row 0), the rename is applied to both rows
 * using the corresponding language variants of `new_name`. This preserves
 * the en/es header alignment that Telar bilingual CSVs depend on.
 */
function opCsvRenameColumn(
  files: Map<string, string>,
  op: CsvRenameColumnOp,
  lang: Language,
): void {
  const newEn = resolveBilingual(op.new_name, "en");
  const newEs = resolveBilingual(op.new_name, "es");
  const newName = lang === "es" ? newEs : newEn;
  const oldEn = resolveBilingual(op.old_name, "en");
  const oldEs = resolveBilingual(op.old_name, "es");

  for (const path of filesMatchingGlob(files, op.file_glob)) {
    const content = files.get(path)!;
    const parsed = Papa.parse<string[]>(content, { skipEmptyLines: false });
    if (parsed.data.length === 0) continue;
    const header = parsed.data[0];

    let idx = header.indexOf(oldEn);
    let row0IsEn: boolean | null = null;
    if (idx >= 0) {
      row0IsEn = true;
    } else {
      idx = header.indexOf(oldEs);
      if (idx >= 0) row0IsEn = false;
    }
    if (idx < 0 || row0IsEn === null) continue;

    // Detect bilingual second header row: same column count AND carries the
    // other-language variant of the old name at the same index.
    const rows = parsed.data;
    const expectedRow1 = row0IsEn ? oldEs : oldEn;
    const isBilingualHeader =
      rows.length >= 2 &&
      rows[1].length === header.length &&
      rows[1][idx] === expectedRow1;

    if (isBilingualHeader) {
      header[idx] = row0IsEn ? newEn : newEs;
      rows[1][idx] = row0IsEn ? newEs : newEn;
    } else {
      header[idx] = newName;
    }
    files.set(path, Papa.unparse(rows, { newline: "\n" }));
  }
}

// ---------------------------------------------------------------------------
// Filesystem ops
// ---------------------------------------------------------------------------

/**
 * Adds each path in `op.paths` to the deletions list (deduplicated) and
 * removes it from the files Map.
 */
function opFileDelete(
  files: Map<string, string>,
  op: FileDeleteOp,
  deletions: string[],
): void {
  for (const path of op.paths) {
    if (!deletions.includes(path)) deletions.push(path);
    files.delete(path);
  }
}

/**
 * Appends each pattern to `.gitignore` if not already present (idempotent).
 * Creates `.gitignore` if absent. If `section_comment` is provided and at
 * least one pattern is new, a blank line plus `# ${section_comment}` is
 * inserted before the new patterns.
 */
function opGitignoreAdd(
  files: Map<string, string>,
  op: GitignoreAddOp,
): void {
  const existing = files.get(".gitignore") ?? "";
  const existingLines = existing.split("\n").map((l) => l.trim());
  const newPatterns = op.patterns.filter(
    (p) => !existingLines.includes(p.trim()),
  );
  if (newPatterns.length === 0) return;

  const needsLeadingNewline =
    existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  const sectionHeader =
    op.section_comment && existing.length > 0
      ? `\n# ${op.section_comment}\n`
      : op.section_comment
        ? `# ${op.section_comment}\n`
        : "";
  const body = newPatterns.map((p) => `${p}\n`).join("");
  files.set(
    ".gitignore",
    `${existing}${needsLeadingNewline}${sectionHeader}${body}`,
  );
}

/**
 * For each file matching `file_glob` AND passing the scope allowlist, applies
 * `content.replace(new RegExp(search, "g"), replace)`. Paths outside the
 * allowlist cause a hard throw (defense-in-depth).
 */
function opRegexReplace(
  files: Map<string, string>,
  op: RegexReplaceOp,
): void {
  const re = new RegExp(op.search, "g");
  for (const path of filesMatchingGlob(files, op.file_glob)) {
    if (!isPathInScope(path)) {
      throw new Error(
        `regex_replace rejected path outside scope allowlist: ${path}`,
      );
    }
    const content = files.get(path)!;
    files.set(path, content.replace(re, op.replace));
  }
}

/**
 * Creates `${path}/.gitkeep` with empty content so the directory is committed.
 * Normalises a trailing slash on `path`. No-op if the .gitkeep already exists.
 */
function opCreateDirectory(
  files: Map<string, string>,
  op: CreateDirectoryOp,
): void {
  const path = op.path.replace(/\/$/, "") + "/.gitkeep";
  if (!files.has(path)) files.set(path, "");
}

// ---------------------------------------------------------------------------
// Top-level dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatches a single operation to its implementation. Throws for unknown
 * operation types (fail-closed). The exhaustive switch is also
 * enforced at compile time via the `never` check in the default branch.
 */
export function applyOperation(
  files: Map<string, string>,
  op: Operation,
  lang: Language,
  deletions: string[],
): void {
  switch (op.type) {
    case "config_add_field":
      return opConfigAddField(files, op);
    case "config_update_value":
      return opConfigUpdateValue(files, op);
    case "config_rename_field":
      return opConfigRenameField(files, op);
    case "csv_add_column":
      return opCsvAddColumn(files, op, lang);
    case "csv_rename_column":
      return opCsvRenameColumn(files, op, lang);
    case "file_delete":
      return opFileDelete(files, op, deletions);
    case "gitignore_add":
      return opGitignoreAdd(files, op);
    case "regex_replace":
      return opRegexReplace(files, op);
    case "create_directory":
      return opCreateDirectory(files, op);
    default: {
      const _exhaustive: never = op;
      throw new Error(
        `Unknown operation type: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

/**
 * Applies a chain of manifests to a virtual filesystem in order, concatenating
 * manual steps in the requested language. Returns a new Map so callers can
 * mutate the result without affecting the input.
 *
 * The validator guarantees each manifest is well-formed before it
 * reaches this function; the runner does not re-validate.
 */
export function applyManifestChain(
  manifests: Manifest[],
  files: Map<string, string>,
  lang: Language,
): ManifestApplyResult {
  const current = new Map(files);
  const deletions: string[] = [];
  const manualSteps: ManualStep[] = [];
  for (const m of manifests) {
    for (const op of m.operations) {
      applyOperation(current, op, lang, deletions);
    }
    manualSteps.push(...m.manual_steps[lang]);
  }
  return { files: current, deletions, manualSteps };
}
