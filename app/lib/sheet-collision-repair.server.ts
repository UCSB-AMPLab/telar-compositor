/**
 * The framework's 1.8.0 repair of colliding columns (`repair_colliding_columns`
 * in scripts/migrations/v180_sheets.py), ported so the Compositor's upgrade can
 * leave a site's sheets in a state the 1.8.0 build converts.
 *
 * From 1.8.0 the build refuses a sheet in which two columns claim one name.
 * Where the collision is benign it is repaired as the framework repairs it:
 * in each group, where one column holds values the others are deleted, and
 * where none does all but the one spelled as the claimed name (else the first)
 * are. A deletion may not change the rows the build reads as data, compared
 * over the columns that survive it; an empty first column whose deletion would
 * is kept and marked with `#` instead, and any other such deletion is not made.
 * The passes repeat until one deletes nothing, because a deletion relabels the
 * columns after it and a relabelled column can collide anew.
 *
 * The one place the Compositor goes further is a group in which more than one
 * column holds values. The framework leaves it for the author; here the author
 * can choose which column to keep, by the positions the columns had in the
 * sheet as first read, and a chosen group is then repaired like any other, with
 * the same refusals. With no choices, the report and the text are the
 * framework's own, which `sheet-collision-repair-parity.test.ts` holds.
 *
 * Nothing here reads or writes the repository: a caller passes each sheet's
 * decoded text and writes back what is returned.
 *
 * @version v1.5.0-beta
 */

import { COLUMN_NAME_MAPPING, pythonStrip } from "~/lib/column-mapping";
import { RESERVED_COLUMN_NAMES } from "~/lib/extra-columns.server";
import {
  FRAMEWORK_GLOSSARY_COLUMN_ALIASES,
  FrameworkSheetUnreadableError,
  GLOSSARY_SHEETS,
  OBJECTS_SHEETS,
  PROJECT_SHEETS,
  SPREADSHEETS_DIR,
  claimedNames,
  pythonFold,
  dataRows,
  editedText,
  headerRowRecord,
  holdsValues,
  readFrameworkSheet,
  skipsHeaderRow,
  type FrameworkSheet,
  type SheetScope,
} from "~/lib/framework-sheet.server";
import { FRAMEWORK_OBJECT_FIELDS } from "~/lib/import.server";

/** How the build reads a sheet: which alias map, scoped how. */
export type SheetRole = "project" | "objects" | "glossary" | "story";

export interface SheetToCheck {
  /** The path as given, relative to the site root. */
  path: string;
  /** The file name, which the report names the sheet by. */
  name: string;
  role: SheetRole;
}

/** The author's choice in one group: every column's first-read position, and the one to keep. */
export interface ColumnChoice {
  positions: readonly number[];
  keep: number;
}

export interface RepairSheetInput {
  path: string;
  /** The sheet decoded from UTF-8, a byte-order mark included. */
  text: string;
  role: SheetRole;
  choices?: readonly ColumnChoice[];
}

/**
 * One line of the repair's report. `column` is the header cell as read in the
 * pass that made the change; every `position` is the column's position in the
 * sheet as first read. `chosen` marks a change the author's choice made, which
 * the framework would not have made.
 */
export type RepairReportEntry =
  | { kind: "dropped"; sheet: string; column: string; position: number; keeper: string; keeperPosition: number; bothEmpty: boolean; chosen: boolean }
  | { kind: "marked"; sheet: string; column: string; position: number; markedAs: string; chosen: boolean; heldValues: boolean }
  | { kind: "not_removed"; sheet: string; column: string; position: number; reason: "unsafe" | "rows_changed" }
  | { kind: "kept_for_header_row"; sheet: string; column: string; position: number }
  | { kind: "header_row_deleted"; sheet: string }
  | { kind: "hold_values"; sheet: string; columns: { header: string; position: number }[] }
  | { kind: "reserved_column"; sheet: string; column: string }
  | { kind: "unreadable"; sheet: string; error: string };

/**
 * A group the author has to choose in: its columns by first-read position and
 * first-read header, each with up to three of its non-empty cells from the rows
 * the build reads.
 */
export interface ChoiceGroup {
  claim: string;
  columns: { position: number; header: string; values: string[] }[];
}

export type InvalidChoice = { choice: ColumnChoice; reason: "unknown_group" | "duplicate" | "keep_not_in_group" };

export type RepairSheetResult =
  | { kind: "unchanged"; path: string; report: RepairReportEntry[] }
  | { kind: "repaired"; path: string; text: string; report: RepairReportEntry[] }
  | { kind: "needs_choices"; path: string; groups: ChoiceGroup[]; invalidChoices: InvalidChoice[]; partialText: string; report: RepairReportEntry[] }
  | { kind: "sheet_reserved_column"; path: string; columns: string[]; partialText: string; report: RepairReportEntry[] }
  | {
      kind: "sheet_rows_changed";
      path: string;
      refused: { position: number; header: string; reason: "header_row" | "rows_changed" | "unsafe" }[];
      partialText: string;
      report: RepairReportEntry[];
    }
  | { kind: "sheet_unreadable_for_repair"; path: string; reason: "unreadable" | "unsplittable"; detail?: string; report: RepairReportEntry[] };

/**
 * What a chosen group does when its choice drops a first column that holds
 * values and deleting it would change the rows the build reads: keep it with a
 * `#` before its header, which the build drops before it publishes a value, or
 * refuse the sheet as it refuses any other such deletion.
 */
export type ChosenFirstColumnPolicy = "mark" | "refuse";

export interface RepairOptions {
  chosenFirstColumnWithValues?: ChosenFirstColumnPolicy;
}

// ---------------------------------------------------------------------------
// Which sheets, read how
// ---------------------------------------------------------------------------

/** Python's ordering of strings: by code point, not by UTF-16 unit. */
function compareCodePoints(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const d = (x[i].codePointAt(0) as number) - (y[i].codePointAt(0) as number);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/**
 * `sheets_to_check` over a tree's file paths: every CSV directly in the
 * spreadsheets directory that the build converts, in the order the framework
 * repairs them. One project sheet and one objects sheet, the English name
 * preferred, and the other-language one neither converted nor checked; the
 * glossary sheet the glossary reader picks read with its aliases; every other
 * CSV a story, the other glossary name included.
 *
 * A preferred name is taken only when `isFile` says it is a file once its
 * links are followed (`_first_present`'s `os.path.isfile`); a name that is
 * not, such as a link that leads nowhere, is passed over for the other
 * language's, and is itself neither converted nor checked. Every path given
 * is a file unless `isFile` says otherwise.
 */
export function sheetsToCheck(paths: Iterable<string>, isFile: (path: string) => boolean = () => true): SheetToCheck[] {
  const prefix = `${SPREADSHEETS_DIR}/`;
  const byName = new Map<string, string>();
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const name = path.slice(prefix.length);
    if (name !== "" && !name.includes("/")) byName.set(name, path);
  }
  const firstPresent = (names: readonly string[]) =>
    names.find((name) => byName.has(name) && isFile(byName.get(name) as string));
  const special = new Map<string | undefined, SheetRole>([
    [firstPresent(PROJECT_SHEETS), "project"],
    [firstPresent(OBJECTS_SHEETS), "objects"],
    [firstPresent(GLOSSARY_SHEETS), "glossary"],
  ]);
  const skipped = new Set<string>([...PROJECT_SHEETS, ...OBJECTS_SHEETS]);
  const found: SheetToCheck[] = [];
  for (const name of [...byName.keys()].sort(compareCodePoints)) {
    if (!name.endsWith(".csv")) continue;
    const role = special.get(name);
    if (role !== undefined) found.push({ path: byName.get(name) as string, name, role });
    else if (!skipped.has(name)) found.push({ path: byName.get(name) as string, name, role: "story" });
  }
  return found;
}

/**
 * The role `sheetsToCheck` gives each file name in `names` (file names directly
 * in the spreadsheets directory) that it reads other than as a story.
 */
export function siteSheetRoles(names: Iterable<string>): Map<string, Exclude<SheetRole, "story">> {
  const roles = new Map<string, Exclude<SheetRole, "story">>();
  for (const sheet of sheetsToCheck([...names].map((name) => `${SPREADSHEETS_DIR}/${name}`))) {
    if (sheet.role !== "story") roles.set(sheet.name, sheet.role);
  }
  return roles;
}

/** The alias scope the build reads a sheet of `role` under. */
export function scopeOf(role: SheetRole): SheetScope {
  if (role === "objects") return { canonicalFields: FRAMEWORK_OBJECT_FIELDS };
  if (role === "glossary") return { sheetAliases: FRAMEWORK_GLOSSARY_COLUMN_ALIASES };
  return {};
}

// ---------------------------------------------------------------------------
// One pass
// ---------------------------------------------------------------------------

/** One colliding group in one pass, by position in that pass. */
interface Group {
  claim: string;
  members: number[];
  kept: number[];
  /** Empty when more than one column holds values and no choice settles it. */
  dropped: number[];
  chosen: boolean;
}

type Refusal = "unsafe" | "header_row" | "rows_changed";

interface Pass {
  sheet: FrameworkSheet;
  scope: SheetScope;
  /** The first-read position of each column in this pass. */
  origin: number[];
  rows: string[][];
}

function sortedKey(positions: readonly number[]): string {
  return [...positions].sort((a, b) => a - b).join(",");
}

/**
 * `_resolve`, except that a group in which more than one column holds values is
 * settled by a choice naming exactly its columns.
 */
function resolveGroup(pass: Pass, claim: string, members: number[], choices: Map<string, ColumnChoice>, matched: Set<ColumnChoice>): Group {
  const holding = members.filter((i) => holdsValues(pass.rows, i));
  if (holding.length > 1) {
    const choice = choices.get(sortedKey(members.map((i) => pass.origin[i])));
    if (choice === undefined) return { claim, members, kept: holding, dropped: [], chosen: false };
    matched.add(choice);
    const keep = members.find((i) => pass.origin[i] === choice.keep) as number;
    return { claim, members, kept: [keep], dropped: members.filter((i) => i !== keep), chosen: true };
  }
  let keep: number;
  if (holding.length === 1) keep = holding[0];
  else keep = members.find((i) => pythonFold(pass.sheet.header[i]) === claim) ?? members[0];
  return { claim, members, kept: [keep], dropped: members.filter((i) => i !== keep), chosen: false };
}

/** The cells of `columns` in each row the build treats as data. */
function seen(sheet: FrameworkSheet, aliases: SheetScope["sheetAliases"], columns: number[]): string[][] {
  return dataRows(sheet, aliases).map((row) => columns.map((i) => row[i] ?? ""));
}

function sameRows(a: string[][], b: string[][]): boolean {
  return a.length === b.length && a.every((row, i) => row.length === b[i].length && row.every((c, j) => c === b[i][j]));
}

/**
 * The sheet edited, with its text read back, or null when the text is not the
 * sheet with those columns gone (and the first marked, if it was).
 */
function readEdit(
  sheet: FrameworkSheet,
  removed: ReadonlySet<number>,
  mark: boolean,
  dropRecord: number | null,
): { text: string; after: FrameworkSheet } | null {
  const text = editedText(sheet, removed, mark, dropRecord);
  if (text === null) return null;
  let after: FrameworkSheet;
  try {
    after = readFrameworkSheet(text);
  } catch (error) {
    if (error instanceof FrameworkSheetUnreadableError) return null;
    throw error;
  }
  if (after.headerAt !== sheet.headerAt) return null;
  if (mark && !(after.header.length > 0 && after.header[0] === `#${sheet.header[0]}`)) return null;
  return { text, after };
}

/** Whether the build reads the same data rows from `after` as from the sheet, over the columns that survive. */
function readsSameRows(pass: Pass, after: FrameworkSheet, removed: ReadonlySet<number>, mark: boolean): boolean {
  const { sheet } = pass;
  const aliases = pass.scope.sheetAliases;
  const kept = sheet.header.map((_, i) => i).filter((i) => !removed.has(i));
  const positions = kept.map((_, p) => p).filter((p) => !(mark && p === 0));
  return sameRows(seen(sheet, aliases, positions.map((p) => kept[p])), seen(after, aliases, positions));
}

/**
 * `_try_edit`: the edited text when the build would read the same data rows
 * from it, over the columns that survive, as from the sheet; otherwise why not.
 * `dropRecord` is a record deleted with the columns.
 */
function tryEdit(pass: Pass, removed: ReadonlySet<number>, mark: boolean, dropRecord: number | null = null): TryEdit {
  const { sheet } = pass;
  const edit = readEdit(sheet, removed, mark, dropRecord);
  if (edit === null) return { reason: "unsafe" };
  if (readsSameRows(pass, edit.after, removed, mark)) return { text: edit.text, headerRowDeleted: dropRecord !== null };
  if (dropRecord === null && losesHeaderRow(sheet, edit.after, pass.scope.sheetAliases)) return withoutHeaderRow(pass, removed, mark);
  return { reason: "rows_changed" };
}

/**
 * Where the edit would leave the build reading the sheet's bilingual header row
 * as data, the framework stops. Here the row, which the build drops anyway, is
 * deleted with the columns, provided the build then reads every surviving cell
 * as it did (`headerRowTypesHold`); otherwise the stop stands.
 */
function withoutHeaderRow(pass: Pass, removed: ReadonlySet<number>, mark: boolean): TryEdit {
  const { sheet } = pass;
  const at = headerRowRecord(sheet, pass.scope.sheetAliases);
  if (at === null || !headerRowTypesHold(sheet, at, removed, mark)) return { reason: "header_row" };
  const edit = tryEdit(pass, removed, mark, at);
  return "text" in edit ? edit : { reason: "header_row" };
}

/** `TEXT_COLUMNS` in telar/csv_utils.py: the columns the framework reads as the author typed them. */
const TEXT_COLUMNS: readonly string[] = ["featured", "year", "object_id", "object"];

/**
 * `text_column_dtypes()`: those columns' headers and every header that renames
 * onto one, spelled exactly as the framework keys its dtype map, since it reads
 * before it folds or renames anything.
 */
export const PINNED_TEXT_HEADERS: ReadonlySet<string> = new Set([
  ...TEXT_COLUMNS,
  ...Object.keys(COLUMN_NAME_MAPPING).filter((header) => TEXT_COLUMNS.includes(COLUMN_NAME_MAPPING[header])),
]);

type ColumnKind = "empty" | "text" | "int" | "float" | "unsure";

const NUMBER_CELL = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;
const PLAIN_INTEGER = /^(0|-?[1-9]\d{0,17})$/;
const BOOLEAN_OR_INFINITY = /^[+-]?(true|false|inf|infinity|nan)$/i;

/**
 * How pandas reads a column of these cells, as the build reads a sheet: only an
 * empty cell is missing, so a column of numbers with one in it is floats, and
 * any cell that is not a number, a boolean or an infinity makes it text.
 */
function columnKind(cells: readonly string[]): ColumnKind {
  const filled = cells.filter((cell) => cell !== "");
  if (filled.length === 0) return "empty";
  if (filled.some((cell) => !NUMBER_CELL.test(cell) && !BOOLEAN_OR_INFINITY.test(cell))) return "text";
  if (filled.some((cell) => !NUMBER_CELL.test(cell))) return "unsure";
  if (filled.length < cells.length || filled.some((cell) => !PLAIN_INTEGER.test(cell))) return "float";
  return "int";
}

/** Whether a cell of a column read as `kind` is published as it is written: text and integers are, a float is where it has no trailing zero and a fraction. */
function publishedAsWritten(kind: ColumnKind, cell: string): boolean {
  return kind === "text" || kind === "int" || (kind === "float" && /^-?(0|[1-9]\d*)\.\d*[1-9]$/.test(cell));
}

/**
 * Whether the build publishes every surviving cell as it did once the second
 * header row at record `at` is gone. pandas types a column from every cell it
 * reads, the row's words included: they keep a column of numbers text, and
 * without them the column is numbers, which publish as written only when each
 * is a plain integer ("001" would publish as 1, "1" beside "1.5" as 1.0). A
 * column the framework pins to text publishes as written either way.
 */
function headerRowTypesHold(sheet: FrameworkSheet, at: number, removed: ReadonlySet<number>, mark: boolean): boolean {
  const rest = sheet.rows.filter((_, r) => r > sheet.headerAt && r !== at && !sheet.skipped[r]);
  return sheet.header.every((_, i) => {
    if (removed.has(i) || (mark && i === 0) || sheet.labels[i].startsWith("#")) return true;
    if (PINNED_TEXT_HEADERS.has(sheet.header[i]) && sheet.labels[i] === sheet.header[i]) return true;
    const cells = rest.map((row) => row[i] ?? "");
    const before = columnKind([sheet.rows[at][i] ?? "", ...cells]);
    const after = columnKind(cells);
    if (before === after || after === "empty") return true;
    if (after === "unsure" || before === "unsure") return false;
    return cells.every((cell) => cell === "" || (publishedAsWritten(before, cell) && publishedAsWritten(after, cell)));
  });
}

/** Whether the build drops a second header row from the sheet and would not from `after`. */
function losesHeaderRow(sheet: FrameworkSheet, after: FrameworkSheet, aliases: SheetScope["sheetAliases"]): boolean {
  return skipsHeaderRow(sheet, aliases) && !skipsHeaderRow(after, aliases);
}

type TryEdit = { text: string; headerRowDeleted: boolean } | { reason: Refusal };

interface Plan {
  removed: Set<number>;
  mark: boolean;
  headerRowDeleted: boolean;
  accepted: Group[];
  refused: Map<Group, Refusal>;
}

/**
 * `_plan_pass`: each group's deletion tried on top of those already accepted
 * in the pass, and where it would change the rows and takes the first column,
 * the first column kept and marked instead. A chosen group that would drop a
 * first column holding values is offered the mark only under the "mark" policy.
 */
function planPass(pass: Pass, groups: Group[], policy: ChosenFirstColumnPolicy): Plan {
  let removed = new Set<number>();
  let mark = false;
  let headerRowDeleted = false;
  const accepted: Group[] = [];
  const refused = new Map<Group, Refusal>();
  for (const group of groups) {
    if (group.dropped.length === 0) continue;
    const options: [Set<number>, boolean][] = [[new Set([...removed, ...group.dropped]), mark]];
    const firstHeldValues = group.chosen && holdsValues(pass.rows, 0);
    if (group.dropped.includes(0) && !(firstHeldValues && policy === "refuse")) {
      options.push([new Set([...removed, ...group.dropped].filter((i) => i !== 0)), true]);
    }
    let reason: Refusal = "unsafe";
    let choice: [Set<number>, boolean] | undefined;
    let deleted = false;
    for (const option of options) {
      const outcome = tryEdit(pass, ...option);
      if ("text" in outcome) {
        choice = option;
        deleted = outcome.headerRowDeleted;
        break;
      }
      reason = outcome.reason;
    }
    if (choice === undefined) refused.set(group, reason);
    else {
      [removed, mark] = choice;
      headerRowDeleted = deleted;
      accepted.push(group);
    }
  }
  return { removed, mark, headerRowDeleted, accepted, refused };
}

// ---------------------------------------------------------------------------
// The repair
// ---------------------------------------------------------------------------

/** One column removed or marked, as the pass that did it saw it. */
interface Change {
  column: string;
  position: number;
  removed: boolean;
  keeper: number;
  rows: string[][];
  passOrigin: number[];
  chosen: boolean;
  heldValues: boolean;
}

/** The text a pass's plan writes, and the report line for the second header row it deletes, if it does. */
function writePlan(sheet: FrameworkSheet, plan: Plan, name: string, scope: SheetScope): { text: string; deletions: RepairReportEntry[] } {
  const dropRecord = plan.headerRowDeleted ? headerRowRecord(sheet, scope.sheetAliases) : null;
  const text = editedText(sheet, plan.removed, plan.mark, dropRecord) as string;
  return { text, deletions: dropRecord === null ? [] : [{ kind: "header_row_deleted", sheet: name }] };
}

function validate(choices: readonly ColumnChoice[]): { valid: Map<string, ColumnChoice>; invalid: InvalidChoice[] } {
  const invalid: InvalidChoice[] = [];
  const byKey = new Map<string, ColumnChoice[]>();
  for (const choice of choices) {
    if (!choice.positions.includes(choice.keep)) {
      invalid.push({ choice, reason: "keep_not_in_group" });
      continue;
    }
    const key = sortedKey(choice.positions);
    byKey.set(key, [...(byKey.get(key) ?? []), choice]);
  }
  const valid = new Map<string, ColumnChoice>();
  for (const [key, same] of byKey) {
    if (same.length === 1) valid.set(key, same[0]);
    else invalid.push(...same.map((choice) => ({ choice, reason: "duplicate" as const })));
  }
  return { valid, invalid };
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Repairs one sheet, and says what the upgrade does with it. The whole
 * framework loop always runs, so the report and the partial text are what the
 * framework's repair would write; the outcome, first match wins, is:
 * unreadable, or unsplittable with anything to repair; a reserved column; a
 * deletion the last pass refused; a group still holding values in more than
 * one column, or a choice that is invalid or matched no group; repaired;
 * unchanged.
 */
export function repairSheet(input: RepairSheetInput, options: RepairOptions = {}): RepairSheetResult {
  const policy = options.chosenFirstColumnWithValues ?? "mark";
  const name = nameOf(input.path);
  const scope = scopeOf(input.role);
  let sheet: FrameworkSheet;
  try {
    sheet = readFrameworkSheet(input.text);
  } catch (error) {
    if (!(error instanceof FrameworkSheetUnreadableError)) throw error;
    return {
      kind: "sheet_unreadable_for_repair",
      path: input.path,
      reason: "unreadable",
      detail: error.message,
      report: [{ kind: "unreadable", sheet: name, error: error.message }],
    };
  }
  const firstHeader = sheet.header;
  const reserved = firstHeader.filter((column) => RESERVED_COLUMN_NAMES.has(pythonFold(column)));
  const report: RepairReportEntry[] = reserved.map((column) => ({ kind: "reserved_column", sheet: name, column }));
  const { valid, invalid } = validate(input.choices ?? []);
  const matched = new Set<ColumnChoice>();

  let origin = firstHeader.map((_, i) => i);
  const changes: Change[] = [];
  const successor = new Map<number, number>();
  let repaired: string | null = null;
  const deletions: RepairReportEntry[] = [];
  let pass: Pass;
  let groups: Group[];
  let plan: Plan;
  for (;;) {
    pass = { sheet, scope, origin, rows: dataRows(sheet, scope.sheetAliases) };
    const current = pass;
    groups = [...claimedNames(sheet.labels, scope)]
      .filter(([, members]) => members.length > 1)
      .map(([claim, members]) => resolveGroup(current, claim, members, valid, matched));
    plan = planPass(pass, groups, policy);
    if (plan.accepted.length === 0) break;
    for (const group of plan.accepted) {
      for (const index of group.dropped) {
        successor.set(origin[index], origin[group.kept[0]]);
        changes.push({
          column: sheet.header[index],
          position: origin[index],
          removed: plan.removed.has(index),
          keeper: origin[group.kept[0]],
          rows: pass.rows,
          passOrigin: origin,
          chosen: group.chosen,
          heldValues: holdsValues(pass.rows, index),
        });
      }
    }
    const written = writePlan(sheet, plan, name, scope);
    repaired = written.text;
    deletions.push(...written.deletions);
    sheet = readFrameworkSheet(repaired);
    const removed = plan.removed;
    origin = origin.filter((_, i) => !removed.has(i));
  }

  for (const change of changes) report.push(changeEntry(name, change, successor, sheet.header, origin));
  report.push(...deletions);
  const unresolved = groups.filter((group) => group.dropped.length === 0);
  for (const group of groups) {
    if (group.dropped.length === 0) {
      report.push({
        kind: "hold_values",
        sheet: name,
        columns: group.kept.map((i) => ({ header: sheet.header[i], position: origin[i] })),
      });
      continue;
    }
    const reason = plan.refused.get(group) as Refusal;
    for (const index of group.dropped) {
      const column = sheet.header[index];
      const position = origin[index];
      report.push(
        reason === "header_row"
          ? { kind: "kept_for_header_row", sheet: name, column, position }
          : { kind: "not_removed", sheet: name, column, position, reason },
      );
    }
  }

  const partialText = repaired ?? input.text;
  const path = input.path;
  if (sheet.records === null && groups.length > 0) {
    return { kind: "sheet_unreadable_for_repair", path, reason: "unsplittable", report };
  }
  if (reserved.length > 0) return { kind: "sheet_reserved_column", path, columns: reserved, partialText, report };
  if (plan.refused.size > 0) {
    const refused = [...plan.refused].flatMap(([group, reason]) =>
      group.dropped.map((i) => ({ position: origin[i], header: sheet.header[i], reason })),
    );
    return { kind: "sheet_rows_changed", path, refused, partialText, report };
  }
  const invalidChoices = [
    ...invalid,
    ...[...valid.values()].filter((choice) => !matched.has(choice)).map((choice) => ({ choice, reason: "unknown_group" as const })),
  ];
  if (unresolved.length > 0 || invalidChoices.length > 0) {
    const rows = pass.rows;
    const choiceGroups = unresolved.map((group) => ({
      claim: group.claim,
      columns: group.members.map((i) => ({
        position: origin[i],
        header: firstHeader[origin[i]],
        values: rows.map((row) => row[i] ?? "").filter((cell) => pythonStrip(cell) !== "").slice(0, 3),
      })),
    }));
    return { kind: "needs_choices", path, groups: choiceGroups, invalidChoices, partialText, report };
  }
  if (repaired !== null) return { kind: "repaired", path, text: repaired, report };
  return { kind: "unchanged", path, report };
}

/**
 * `_change_records`: a removal names the column the written file keeps in its
 * place, following a keeper a later pass removed to the column kept for it,
 * and says the columns were all empty when the keeper held no values in the
 * rows of the pass that made the change.
 */
function changeEntry(sheet: string, change: Change, successor: Map<number, number>, header: string[], origin: number[]): RepairReportEntry {
  const { column, position, chosen } = change;
  if (!change.removed) {
    return { kind: "marked", sheet, column, position, markedAs: `#${column}`, chosen, heldValues: change.heldValues };
  }
  let keeper = change.keeper;
  while (successor.has(keeper)) keeper = successor.get(keeper) as number;
  const label = header[origin.indexOf(keeper)];
  const bothEmpty = !holdsValues(change.rows, change.passOrigin.indexOf(keeper));
  return { kind: "dropped", sheet, column, position, keeper: label, keeperPosition: keeper, bothEmpty, chosen };
}

/**
 * The record the framework's repair writes for `entry`, as its message key,
 * the arguments the message takes and its status; null for a change the
 * author's choice made, or the deletion of a second header row, which the
 * framework never makes.
 */
export function frameworkRecordOf(entry: RepairReportEntry): { key: string; args: string[]; status: "applied" | "failed" } | null {
  switch (entry.kind) {
    case "dropped":
      if (entry.chosen) return null;
      return entry.bothEmpty
        ? { key: "v180_column_dropped_all_empty", args: [entry.column, entry.sheet, entry.keeper, entry.keeper], status: "applied" }
        : { key: "v180_column_dropped", args: [entry.column, entry.sheet, entry.keeper], status: "applied" };
    case "marked":
      if (entry.chosen) return null;
      return { key: "v180_column_marked_note", args: [entry.column, entry.sheet, entry.markedAs], status: "applied" };
    case "not_removed":
      return { key: "v180_column_not_removed", args: [entry.column, entry.sheet], status: "failed" };
    case "kept_for_header_row":
      return { key: "v180_column_kept_for_header_row", args: [entry.column, entry.sheet], status: "failed" };
    case "header_row_deleted":
      return null;
    case "hold_values":
      return {
        key: "v180_columns_hold_values",
        args: [entry.sheet, entry.columns.map((c) => `\`${c.header}\``).join(", ")],
        status: "failed",
      };
    case "reserved_column":
      return { key: "v180_reserved_column", args: [entry.sheet, entry.column], status: "failed" };
    case "unreadable":
      return { key: "v180_sheet_unreadable", args: [entry.sheet, entry.error], status: "failed" };
  }
}
