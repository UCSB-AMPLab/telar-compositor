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
 *     the column name. Every read pins the comma, because the framework's
 *     `pd.read_csv` splits on nothing else and `Papa.unparse` writes nothing
 *     else: a guessed delimiter reads a file the site is not built from and
 *     rewrites it under a dialect it never had.
 *   - Bilingual fields ({ en, es }) resolve via resolveBilingual using the
 *     site's `telar_language` — passed in as `lang` on applyManifestChain.
 *   - Unknown operation type throws — exhaustive switch is enforced at compile
 *     time via the Operation union, and fail-closed at runtime.
 *   - regex_replace enforces a scope allowlist to prevent arbitrary file
 *     corruption via a malicious glob. Paths containing `..`, starting with
 *     `/`, or under `.git/` are rejected with a hard error. The allowlist
 *     lives in manifest-schema.server.ts, which holds `yaml_list_add`'s file
 *     to it at validation.
 *   - yaml_list_add edits a YAML list in place (yaml-list-add.server.ts) and
 *     throws YamlListAddError when it cannot, which the upgrade names.
 *
 * @version v1.5.0-beta
 */

import Papa from "papaparse";
import { classifyManualSteps } from "~/lib/manual-step-kinds.server";
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
  isPathInScope,
  resolveBilingual,
} from "~/lib/manifest-schema.server";
import { applyYamlListAdd } from "~/lib/yaml-list-add.server";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface ManifestApplyResult {
  /** Transformed files, keyed by repo-relative path. */
  files: Map<string, string>;
  /** Paths to delete (from file_delete ops), deduplicated. */
  deletions: string[];
  /**
   * Manual steps in both languages, concatenated across the chain. They are
   * shown in the Compositor's interface language, which is not the site's.
   */
  manualSteps: Record<Language, ManualStep[]>;
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
 * Inserts one cell at `insertIdx` in every row. pd.read_csv fills the missing
 * trailing cells of a short row, so the row is padded to the insertion point
 * or the value lands under an earlier column.
 */
function insertColumnCells(
  rows: string[][],
  insertIdx: number,
  cellFor: (row: number) => string,
): void {
  for (let r = 0; r < rows.length; r++) {
    while (rows[r].length < insertIdx) rows[r].push("");
    rows[r].splice(insertIdx, 0, cellFor(r));
  }
}

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
    const { rows, blank, endsWithNewline, headerRow, secondRow } = parseSheet(content);
    if (headerRow < 0) continue;
    const header = rows[headerRow];
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
    if (secondRow >= 0 && anchorIdx >= 0 && row0IsEn !== null) {
      const row1 = rows[secondRow];
      const expectedRow1Anchor = row0IsEn ? anchorEs : anchorEn;
      if (row1.length === header.length && row1[anchorIdx] === expectedRow1Anchor) {
        row1Value = row0IsEn ? newEs : newEn;
      }
    }
    const row0Value = row1Value !== null
      ? (row0IsEn ? newEn : newEs)
      : newCol;

    insertColumnCells(rows, insertIdx, (r) => {
      if (r === headerRow) return row0Value;
      if (r === secondRow && row1Value !== null) return row1Value;
      return op.default;
    });
    files.set(path, unparseRows(rows, blank, endsWithNewline));
  }
}

/**
 * A sheet read with the comma pinned, with the facts papaparse's rows alone
 * do not carry. papaparse gives a blank line, a quoted empty record (`""`) and
 * the end of the text after a final line terminator the same `[""]`; only the
 * quoted empty record is a row to the framework's `pd.read_csv`, so each
 * record's raw source, sliced by the parser's cursor, decides.
 *   - rows: every record except the one after a final line terminator.
 *   - blank: the text, without its line terminator, of each record that
 *     `pd.read_csv` skips as a blank line, by index: a line holding nothing
 *     or only spaces and tabs. A line of commas, or a quoted cell of spaces,
 *     is a row.
 *   - endsWithNewline: whether the text ends in a line terminator.
 *   - headerRow, secondRow: indices of the first and second non-blank
 *     records, or -1. `pd.read_csv` skips blank lines and takes the first
 *     non-blank one as the header; a bilingual sheet's second header row is
 *     the next non-blank record.
 */
interface ParsedSheet {
  rows: string[][];
  blank: Map<number, string>;
  endsWithNewline: boolean;
  headerRow: number;
  secondRow: number;
}

function parseSheet(content: string): ParsedSheet {
  const rows: string[][] = [];
  const blank = new Map<number, string>();
  let start = 0;
  Papa.parse<string[]>(content, {
    skipEmptyLines: false,
    delimiter: ",",
    step: (result) => {
      const end = result.meta.cursor;
      const raw = content.slice(start, end);
      start = end;
      if (raw === "" && end === content.length && rows.length > 0) return;
      const line = raw.replace(/\r?\n$|\r$/, "");
      if (/^[ \t]*$/.test(line)) blank.set(rows.length, line);
      rows.push(result.data);
    },
  });
  const nonBlank = rows.map((_, r) => r).filter((r) => !blank.has(r));
  return {
    rows,
    blank,
    endsWithNewline: /[\r\n]$/.test(content),
    headerRow: nonBlank[0] ?? -1,
    secondRow: nonBlank[1] ?? -1,
  };
}

/**
 * Writes rows with LF line endings. A blank line is written back as it was. A
 * row holding one empty cell is written as `""`, because papaparse writes it
 * as an empty line, which the framework's `pd.read_csv` skips.
 */
function unparseRows(
  rows: string[][],
  blank: Map<number, string>,
  endsWithNewline: boolean,
): string {
  const body = rows
    .map((row, r) => {
      const blankLine = blank.get(r);
      if (blankLine !== undefined) return blankLine;
      if (row.length === 1 && row[0] === "") return '""';
      return Papa.unparse([row], { newline: "\n" });
    })
    .join("\n");
  return body + (endsWithNewline ? "\n" : "");
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
    const { rows, blank, endsWithNewline, headerRow, secondRow } = parseSheet(content);
    if (headerRow < 0) continue;
    const header = rows[headerRow];

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
    const expectedRow1 = row0IsEn ? oldEs : oldEn;
    const isBilingualHeader =
      secondRow >= 0 &&
      rows[secondRow].length === header.length &&
      rows[secondRow][idx] === expectedRow1;

    if (isBilingualHeader) {
      header[idx] = row0IsEn ? newEn : newEs;
      rows[secondRow][idx] = row0IsEn ? newEs : newEn;
    } else {
      header[idx] = newName;
    }
    files.set(path, unparseRows(rows, blank, endsWithNewline));
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
 * The paths the chain's `file_delete` operations name, deduplicated, in the
 * order `applyManifestChain` reports them. A deletion is named by the
 * operation alone, so no file contents are needed to know it.
 */
export function manifestChainDeletions(manifests: Manifest[]): string[] {
  const paths = manifests
    .flatMap((m) => m.operations)
    .flatMap((op) => (op.type === "file_delete" ? op.paths : []));
  return Array.from(new Set(paths));
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
 * allowlist cause a hard throw (defence-in-depth against arbitrary writes).
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

/** What an operation's implementation is handed. */
type OperationRunner<K extends Operation["type"]> = (
  files: Map<string, string>,
  op: Extract<Operation, { type: K }>,
  lang: Language,
  deletions: string[],
) => void;

/**
 * The implementation of each operation type. The mapped type makes the table
 * exhaustive at compile time: a type added to the Operation union and missing
 * here does not compile.
 */
const OPERATION_RUNNERS: { readonly [K in Operation["type"]]: OperationRunner<K> } = {
  config_add_field: (files, op) => opConfigAddField(files, op),
  config_update_value: (files, op) => opConfigUpdateValue(files, op),
  config_rename_field: (files, op) => opConfigRenameField(files, op),
  csv_add_column: (files, op, lang) => opCsvAddColumn(files, op, lang),
  csv_rename_column: (files, op, lang) => opCsvRenameColumn(files, op, lang),
  file_delete: (files, op, _lang, deletions) => opFileDelete(files, op, deletions),
  gitignore_add: (files, op) => opGitignoreAdd(files, op),
  regex_replace: (files, op) => opRegexReplace(files, op),
  yaml_list_add: (files, op) => applyYamlListAdd(files, op),
  create_directory: (files, op) => opCreateDirectory(files, op),
};

/**
 * Dispatches a single operation to its implementation. Throws for unknown
 * operation types (fail-closed).
 */
export function applyOperation(
  files: Map<string, string>,
  op: Operation,
  lang: Language,
  deletions: string[],
): void {
  if (!Object.hasOwn(OPERATION_RUNNERS, op.type)) {
    throw new Error(`Unknown operation type: ${JSON.stringify(op)}`);
  }
  (OPERATION_RUNNERS[op.type] as OperationRunner<Operation["type"]>)(files, op, lang, deletions);
}

/**
 * Applies a chain of manifests to a virtual filesystem in order, concatenating
 * manual steps in both languages (`lang` only selects the language of file
 * operations). Each manifest's steps are
 * classified first, while both languages and the release version are in
 * hand. Returns a new Map so callers can
 * mutate the result without affecting the input.
 *
 * The validator guarantees each manifest is well-formed before it reaches
 * this function; the runner does not re-validate.
 */
export function applyManifestChain(
  manifests: Manifest[],
  files: Map<string, string>,
  lang: Language,
): ManifestApplyResult {
  const current = new Map(files);
  const deletions: string[] = [];
  const manualSteps: Record<Language, ManualStep[]> = { en: [], es: [] };
  for (const m of manifests) {
    for (const op of m.operations) {
      applyOperation(current, op, lang, deletions);
    }
    const classified = classifyManualSteps(m);
    manualSteps.en.push(...classified.en);
    manualSteps.es.push(...classified.es);
  }
  return { files: current, deletions, manualSteps };
}
