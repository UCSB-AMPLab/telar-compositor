/**
 * The sheet stage of an upgrade's prepare: the site's sheets left in
 * a state the 1.8.0 build converts, with the author choosing where the
 * framework's own repair cannot.
 *
 * Every sheet the build converts is read at the head the upgrade lists, and
 * repaired as the framework's migration repairs it (`repairSheet`, a port of
 * `repair_colliding_columns` in scripts/migrations/v180_sheets.py). A repaired
 * sheet is written as that migration writes it (`Sheet.write`), the edited
 * text and nothing else, so it goes into the commit verbatim rather than
 * through the commit's text cleaning. What a repair reads is what the build
 * would read if the upgrade left the sheet alone: the blob at the head, or,
 * for a sheet the manifest chain edits, the text the commit writes for it.
 *
 * A group in which more than one column holds values goes to the author.
 * Prepare then answers with a challenge instead of a prepared upgrade: every
 * sheet it read, by the SHA-256 of its bytes as first read, the head and the
 * release it read them for, every decision so far, and the groups it asks
 * about. The next prepare re-reads everything and replays the decisions only
 * when all of those still match; the bytes are then the first-read bytes, and
 * a column is named throughout by its position in them.
 *
 * On a site that reads Google Sheets, each tab the build fetches stands in for
 * the repository's copy of its file, as the build writes it over that copy.
 * While the tabs stay live, a tab is checked on its text as fetched and is
 * never repaired or written, and the repository's CSVs no tab replaces are
 * repaired as any site's are. A clean Sheets site goes ahead with
 * `tabsChecked`, since its tabs were checked only as they stood at prepare.
 * Where a tab would be refused, the author is asked whether the site stops
 * reading Google Sheets (`needs_sheets_decision`); declining stops the upgrade,
 * naming the tabs. Accepting, `decisions.sheets` is "off": the tabs read at
 * prepare are written as the site's CSVs (`switchedTabs`), `_config.yml` is
 * switched off, and the sheets are repaired as the build will then read them.
 * The challenge binds the tabs read and each tab's text, so a changed tab
 * voids the decision.
 *
 * A symbolic link among the sheets is followed as the build follows it; the
 * repair writes the file it points to, as the framework's write through the
 * link does. A link that leaves the site, or leads nowhere, is reported as a
 * sheet the framework could not open (`v180_sheet_unreadable`), and the
 * upgrade goes on, as the framework's does. The build's fetch writes a tab
 * through a link too, so the tab's text lands in the file the link leads to
 * and is checked under that file's role (`landedTabs`).
 *
 * @version v1.5.0-beta
 */

import { cleanCommitContent, disableGoogleSheetsInConfig, SheetsNotDisableableError, type CommitFile } from "~/lib/commit.server";
import { GLOSSARY_SHEETS, OBJECTS_SHEETS, PROJECT_SHEETS, SPREADSHEETS_DIR } from "~/lib/framework-sheet.server";
import { sha256Hex } from "~/lib/story-canonical";
import type { TreeEntry } from "~/lib/github.server";
import {
  repairSheet,
  sheetsToCheck,
  type ChoiceGroup,
  type ColumnChoice,
  type RepairReportEntry,
  type RepairSheetResult,
  type SheetRole,
} from "~/lib/sheet-collision-repair.server";
import type { PublishedTab } from "~/lib/sheets.server";
import { UpgradeFileUnreadableError } from "~/lib/upgrade-reads.server";
import { readSiteTabs, type SiteTabs } from "~/lib/upgrade-tabs.server";
import { compareVersions, frameworkVersionForTag } from "~/lib/telar-version";
import { InvalidUpgradeChallengeError } from "~/lib/upgrade-signing.server";

const BOM = "﻿";
const LINK_MODE = "120000";
const FILE_MODES: ReadonlySet<string> = new Set(["100644", "100755", LINK_MODE]);
/** Links followed before a chain is read as a loop. */
const MAX_LINKS = 8;

export interface SpreadsheetEntry {
  path: string;
  mode: string;
  sha: string;
}

/** One column the author keeps in one group, by first-read positions. */
export interface SubmittedChoice {
  file: string;
  positions: number[];
  keep: number;
}

export interface UpgradeDecisions {
  /** "off" once the author chose to stop reading Google Sheets; null where nobody was asked. */
  sheets: "off" | null;
  rounds: { choices: SubmittedChoice[] }[];
}

export interface PendingGroup {
  file: string;
  claim: string;
  positions: number[];
}

export interface BoundSheet {
  file: string;
  /** The repository, or the published tab the build writes over it. */
  source: "repo" | { tab: string; gid: string };
  /** The file a link resolves to, when the sheet is a link that resolves. */
  target?: string;
  sha256: string;
}

export interface UpgradeChallengeContent {
  v: 1;
  targetTag: string;
  headOid: string;
  sheets: BoundSheet[];
  /** The published Google Sheets tabs the build fetches, or null for a site that reads none. */
  tabs: { name: string; gid: string }[] | null;
  decisions: UpgradeDecisions;
  pending: PendingGroup[];
}

/** A sheet the build converts, as the commit leaves it, by its name in the spreadsheets directory. */
export interface FinalSheet {
  name: string;
  role: SheetRole;
  text: string;
}

/** One line of the repair's report, with the sheet's path. */
export type SheetReportLine = RepairReportEntry & { file: string };

export interface OfferedGroup extends PendingGroup {
  sheet: string;
  columns: ChoiceGroup["columns"];
  /** The author's last answer named no valid column for this group. */
  needsChoice: boolean;
}

export type ChoiceNotice = "sheets_changed" | "choice_needed" | "further_choices";

/** One group of columns a published tab holds that the 1.8.0 build reads as the same field. */
export interface TabCollision {
  tab: string;
  columns: string[];
}

/** A stop's sheet is a published tab, fixed in Google Sheets rather than in the repository. */
type FromTab = { tab?: true };

export type SheetStageFailure =
  | { kind: "failed"; error: "sheet_unreadable_for_repair"; detail: { sheet: string; columns: string } & FromTab }
  | { kind: "failed"; error: "sheet_reserved_column"; detail: { sheet: string; column: string } & FromTab }
  | {
      kind: "failed";
      error: "sheet_rows_changed";
      detail: { sheet: string; columns: string; reason: "header_row" | "rows_changed" | "unsafe" } & FromTab;
    }
  | { kind: "failed"; error: "sheets_columns_refused"; detail: TabsRefused }
  | { kind: "failed"; error: "sheets_switch_unreadable"; detail?: undefined };

/** The tabs the 1.8.0 build would refuse, and the colliding columns in each. */
export interface TabsRefused {
  tabs: string;
  count: number;
  collisions: TabCollision[];
}

/** What stopping reading Google Sheets does: `_config.yml` switched off, and the CSVs written and deleted. */
export interface SheetsSwitch {
  /** The chain's `_config.yml` with Google Sheets off, marks taken off. */
  config: string;
  written: string[];
  deleted: string[];
}

export type SheetStageResult =
  | {
      kind: "ready";
      writes: CommitFile[];
      report: SheetReportLine[];
      clean: boolean;
      decisions: UpgradeDecisions;
      advancesHead: boolean;
      /** Every sheet the build converts and can open, in the order it repairs them. */
      finalSheets: FinalSheet[];
      /** The site reads Google Sheets, and its tabs were checked as they stood. */
      tabsChecked: boolean;
      /** The site stops reading Google Sheets in this upgrade, or null. */
      sheetsOff: SheetsSwitch | null;
    }
  | { kind: "needs_choices"; challenge: UpgradeChallengeContent; groups: OfferedGroup[]; notice: ChoiceNotice | null }
  | { kind: "needs_sheets_decision"; challenge: UpgradeChallengeContent; detail: TabsRefused; notice: "sheets_changed" | null }
  | SheetStageFailure;

export interface SheetStageInput {
  /** The spreadsheets directory's entries at the head; called only for a target that refuses colliding columns. */
  listEntries: () => Promise<SpreadsheetEntry[]>;
  /** A site file at the head, its byte-order mark kept; null when absent. */
  readRaw: (path: string) => Promise<string | null>;
  /** Whether a path a link leads to outside the spreadsheets directory is a file at the head. */
  targetExists: (path: string) => Promise<boolean>;
  /** The path a link's blob holds. */
  readLinkTarget: (entry: SpreadsheetEntry) => Promise<string>;
  /** The manifest chain's output, marks taken off. */
  chainFiles: ReadonlyMap<string, string>;
  targetTag: string;
  headOid: string;
  /** Every tab the build fetches from the sheet published at a URL; throws when the build's fetch would not give the site a tab. */
  readTabs: (publishedUrl: string) => Promise<PublishedTab[]>;
  /** A verified challenge the page posted back, or null on a first prepare. */
  challenge: UpgradeChallengeContent | null;
  /** The choices posted with it; untrusted, so checked here. */
  submitted: unknown;
  /** The author's answer to the offer to stop reading Google Sheets, as posted; untrusted. */
  sheetsAnswer?: unknown;
}

// ---------------------------------------------------------------------------
// Listing and reading
// ---------------------------------------------------------------------------

function isDirectSheetEntry(entry: TreeEntry): boolean {
  const prefix = `${SPREADSHEETS_DIR}/`;
  if (entry.type !== "blob" || !FILE_MODES.has(entry.mode) || !entry.path.startsWith(prefix)) return false;
  const name = entry.path.slice(prefix.length);
  return name !== "" && !name.includes("/");
}

/**
 * The files and links directly in the spreadsheets directory at the head: from
 * the tree, or, when the tree was answered truncated, from a listing of the
 * directory on its own. A listing that fails stops prepare, naming the
 * directory.
 */
export async function listSpreadsheetEntries(
  tree: TreeEntry[],
  truncated: boolean,
  listDirectory: (dir: string) => Promise<TreeEntry[]>,
): Promise<SpreadsheetEntry[]> {
  let source = tree;
  if (truncated) {
    try {
      source = await listDirectory(SPREADSHEETS_DIR);
    } catch {
      throw new UpgradeFileUnreadableError(SPREADSHEETS_DIR);
    }
  }
  return source.filter(isDirectSheetEntry).map(({ path, mode, sha }) => ({ path, mode, sha }));
}

/** `target` resolved against `dir`, or null when it is absolute or leaves the site. */
function resolveWithinSite(dir: string, target: string): string | null {
  if (target.startsWith("/")) return null;
  const parts: string[] = [];
  for (const part of [...dir.split("/"), ...target.split("/")]) {
    if (part === "" || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (parts.pop() === undefined) return null;
  }
  return parts.join("/");
}

/** One sheet as read at the head. `raw` is null for a link the build cannot follow. */
interface ReadSheet {
  file: string;
  name: string;
  role: SheetRole;
  readPath: string;
  raw: string | null;
  bound: BoundSheet;
  /** The published tab the build writes over this file, by name. */
  tab?: string;
}

/** Where a link ends within the site, and whether a file is there to open. */
interface LinkEnd {
  path: string;
  exists: boolean;
}

/**
 * The path a link leads to within the site, as far as the chain resolves, or
 * null where it leads out of the site or round a loop. Nothing is read but the
 * links themselves: whether the build would open the sheet is decided before
 * any sheet is read.
 */
async function followLink(
  entry: SpreadsheetEntry,
  byPath: ReadonlyMap<string, SpreadsheetEntry>,
  input: SheetStageInput,
): Promise<LinkEnd | null> {
  let current = entry;
  for (let hop = 0; hop < MAX_LINKS; hop += 1) {
    const dir = current.path.slice(0, current.path.lastIndexOf("/"));
    const target = resolveWithinSite(dir, await input.readLinkTarget(current));
    if (target === null) return null;
    const next = byPath.get(target);
    if (next === undefined) return { path: target, exists: await input.targetExists(target) };
    if (next.mode !== LINK_MODE) return { path: target, exists: true };
    current = next;
  }
  return null;
}

/**
 * A file's text at the head, when the listing or a link says it is there, so
 * a read that answers absent is a read that failed, and stops prepare by its
 * path.
 */
async function readListedFile(path: string, input: SheetStageInput): Promise<string> {
  const raw = await input.readRaw(path);
  if (raw === null) throw new UpgradeFileUnreadableError(path);
  return raw;
}

async function boundOf(entry: SpreadsheetEntry, target: string | null, raw: string | null, input: SheetStageInput): Promise<BoundSheet> {
  if (raw === null) {
    return { file: entry.path, source: "repo", sha256: await sha256Hex(`link:${await input.readLinkTarget(entry)}`) };
  }
  const linked = entry.mode === LINK_MODE ? { target: target as string } : {};
  return { file: entry.path, source: "repo", ...linked, sha256: await sha256Hex(raw) };
}

/** Where each link among the sheets leads. */
async function linkTargets(
  entries: readonly SpreadsheetEntry[],
  byPath: ReadonlyMap<string, SpreadsheetEntry>,
  input: SheetStageInput,
): Promise<Map<string, LinkEnd | null>> {
  const leadsTo = new Map<string, LinkEnd | null>();
  for (const entry of entries) {
    if (entry.mode === LINK_MODE && entry.path.endsWith(".csv")) {
      leadsTo.set(entry.path, await followLink(entry, byPath, input));
    }
  }
  return leadsTo;
}

async function tabSheet(sheet: { path: string; name: string; role: SheetRole }, readPath: string, tab: PublishedTab): Promise<ReadSheet> {
  const linked = readPath === sheet.path ? {} : { target: readPath };
  const bound: BoundSheet = { file: sheet.path, source: { tab: tab.name, gid: tab.gid }, ...linked, sha256: await sha256Hex(tab.text) };
  return { file: sheet.path, name: sheet.name, role: sheet.role, readPath, raw: tab.text, bound, tab: tab.name };
}

/**
 * Each fetched tab by the path its text lands at. The fetch opens a tab's file
 * for writing, which follows a link and creates a target that is not there, so
 * a tab written to a link lands at the path the link resolves to, as far as
 * the chain resolves, and is read there under that file's role as well as
 * through the link. A link that leaves the site or loops has no file in the
 * site for the tab to land in; the build reads the tab back through the link
 * wherever the runner let the write through, so the tab is placed at the link
 * itself. A later tab landing at the same path replaces an earlier one, as the
 * build's loop overwrites.
 */
function landedTabs(tabs: SiteTabs | null, landing: (path: string) => string): Map<string, PublishedTab> {
  const landed = new Map<string, PublishedTab>();
  for (const { path, tab } of tabs?.written ?? []) landed.set(landing(path), tab);
  return landed;
}

/**
 * Every sheet the build converts, read: the repository's, with each tab the
 * build fetches in place of the file its text lands in. Which of a pair of project or
 * objects sheets the build reads turns on whether the preferred one is a file
 * once links are followed, so every link is resolved first; then only the
 * sheets chosen are read, and a language variant the build never opens is not.
 */
async function readSheets(input: SheetStageInput, tabs: SiteTabs | null): Promise<SheetsRead> {
  const entries = await input.listEntries();
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const leadsTo = await linkTargets(entries, byPath, input);
  const end = (path: string) => (leadsTo.has(path) ? (leadsTo.get(path) ?? null) : { path, exists: true });
  const landing = (path: string) => end(path)?.path ?? path;
  const landed = landedTabs(tabs, landing);
  const readAt = (path: string) => {
    const at = end(path);
    return at?.exists ? at.path : landed.has(landing(path)) ? landing(path) : null;
  };
  const read: ReadSheet[] = [];
  for (const sheet of sheetsToCheck([...byPath.keys(), ...landed.keys()], (path) => readAt(path) !== null)) {
    const readPath = readAt(sheet.path);
    const tab = readPath === null ? undefined : landed.get(readPath);
    if (tab !== undefined) {
      read.push(await tabSheet(sheet, readPath as string, tab));
      continue;
    }
    const raw = readPath === null ? null : await readListedFile(readPath, input);
    const bound = await boundOf(byPath.get(sheet.path) as SpreadsheetEntry, readPath, raw, input);
    read.push({ file: sheet.path, name: sheet.name, role: sheet.role, readPath: readPath ?? sheet.path, raw, bound });
  }
  const isPresent = (path: string) => (byPath.has(path) || landed.has(path)) && readAt(path) !== null;
  return { read, landed, landing, isPresent, inRepo: (path) => byPath.has(path) };
}

/** The sheets read, and how the tabs met the repository's files. */
interface SheetsRead {
  read: ReadSheet[];
  /** Each tab by the path its text lands at. */
  landed: Map<string, PublishedTab>;
  landing: (path: string) => string;
  /** Whether the build finds a file at a path, from the repository or a tab. */
  isPresent: (path: string) => boolean;
  /** Whether the repository lists a file or link at a path. */
  inRepo: (path: string) => boolean;
}

/**
 * Whether a path a link leads to is a file at the head, as `os.path.isfile`
 * answers after following links: from the tree when it was listed whole and
 * holds the path as a regular file or not at all, and otherwise by reading
 * it, which answers for a path behind another link or a truncated listing.
 */
export function fileAtHead(
  tree: readonly TreeEntry[],
  truncated: boolean,
  readRaw: (path: string) => Promise<string | null>,
): (path: string) => Promise<boolean> {
  const byPath = new Map(tree.map((entry) => [entry.path, entry]));
  return async (path) => {
    const entry = byPath.get(path);
    if (entry?.type === "tree") return false;
    if (entry !== undefined && entry.mode !== LINK_MODE) return true;
    if (entry === undefined && !truncated) return false;
    return (await readRaw(path)) !== null;
  };
}

/**
 * The text the build would read from `sheet` if the upgrade did not write it:
 * the file at the head, or the manifest chain's edit of it as the commit
 * writes it, cleaned and with the mark the file had.
 */
function repairInput(sheet: ReadSheet, raw: string, chainFiles: ReadonlyMap<string, string>): string {
  if (sheet.tab !== undefined) return raw;
  const chained = chainFiles.get(sheet.readPath);
  if (chained === undefined) return raw;
  return cleanCommitContent(sheet.readPath, (raw.startsWith(BOM) ? BOM : "") + chained);
}

// ---------------------------------------------------------------------------
// Choices
// ---------------------------------------------------------------------------

function samePositions(a: readonly number[], b: readonly number[]): boolean {
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  return x.length === y.length && x.every((p, i) => p === y[i]);
}

function isSubmittedChoice(value: unknown): value is SubmittedChoice {
  if (value === null || typeof value !== "object") return false;
  const { file, positions, keep } = value as Record<string, unknown>;
  return (
    typeof file === "string" &&
    Array.isArray(positions) &&
    positions.every((p) => Number.isInteger(p)) &&
    Number.isInteger(keep) &&
    (positions as number[]).includes(keep as number)
  );
}

/** The one valid choice `submitted` makes for `group`, or null for none or several. */
function choiceFor(group: PendingGroup, submitted: readonly unknown[]): SubmittedChoice | null {
  const naming = submitted.filter(
    (c) => isSubmittedChoice(c) && c.file === group.file && samePositions(c.positions, group.positions),
  ) as SubmittedChoice[];
  return naming.length === 1 ? naming[0] : null;
}

/**
 * The round `submitted` makes when it chooses exactly once in every group
 * asked about and nothing else; otherwise the groups it left without a valid
 * choice, which may be none when the fault is a choice naming no group.
 */
export function checkRound(
  pending: readonly PendingGroup[],
  submitted: unknown,
): { round: SubmittedChoice[] } | { unanswered: PendingGroup[] } {
  const list = Array.isArray(submitted) ? submitted : [];
  const chosen = pending.map((group) => choiceFor(group, list));
  const unanswered = pending.filter((_, i) => chosen[i] === null);
  if (!Array.isArray(submitted) || unanswered.length > 0 || list.length !== pending.length) return { unanswered };
  return { round: chosen as SubmittedChoice[] };
}

function challengeMatches(
  challenge: UpgradeChallengeContent,
  input: SheetStageInput,
  bound: BoundSheet[],
  tabs: UpgradeChallengeContent["tabs"],
): boolean {
  return (
    challenge.v === 1 &&
    challenge.targetTag === input.targetTag &&
    challenge.headOid === input.headOid &&
    JSON.stringify(challenge.sheets) === JSON.stringify(bound) &&
    JSON.stringify(challenge.tabs) === JSON.stringify(tabs)
  );
}

// ---------------------------------------------------------------------------
// The repair over every sheet
// ---------------------------------------------------------------------------

interface SiteRepair {
  writes: CommitFile[];
  finals: FinalSheet[];
  report: SheetReportLine[];
  groups: OfferedGroup[];
  invalid: boolean;
  failure: SheetStageFailure | null;
}

function withSheetPath(file: string, entries: readonly RepairReportEntry[]): SheetReportLine[] {
  return entries.map((entry) => ({ ...entry, file }));
}

/** The columns a sheet the repair cannot split names, to keep one of each. */
function namedColumns(report: readonly RepairReportEntry[]): string {
  const names = report.flatMap((entry) => {
    if (entry.kind === "hold_values") return entry.columns.map((c) => c.header);
    if (entry.kind === "not_removed") return [entry.column];
    return [];
  });
  return [...new Set(names)].join(", ");
}

/**
 * The stop a sheet's result is, or null.
 *
 * Temporary: each of these stops sends the author to GitHub to change the
 * sheet by hand, and the remedy belongs in the Compositor — renaming or
 * removing a `_metadata` column, deleting a column whose removal
 * changes the rows, and repairing a sheet the splitter cannot read back, each
 * need a control of their own. The messages (upgrade.json) name the sheet and
 * the change until then. A published tab's stop is marked `tab`, and its
 * message names the change to make in Google Sheets instead.
 */
function stopFor(name: string, result: RepairSheetResult, fromTab = false): SheetStageFailure | null {
  const tab: FromTab = fromTab ? { tab: true } : {};
  switch (result.kind) {
    case "sheet_unreadable_for_repair":
      if (result.reason === "unreadable") return null;
      return { kind: "failed", error: "sheet_unreadable_for_repair", detail: { sheet: name, columns: namedColumns(result.report), ...tab } };
    case "sheet_reserved_column":
      return { kind: "failed", error: "sheet_reserved_column", detail: { sheet: name, column: result.columns.join(", "), ...tab } };
    case "sheet_rows_changed":
      return {
        kind: "failed",
        error: "sheet_rows_changed",
        detail: { sheet: name, columns: result.refused.map((r) => r.header).join(", "), reason: result.refused[0].reason, ...tab },
      };
    default:
      return null;
  }
}

function offeredGroups(sheet: ReadSheet, groups: readonly ChoiceGroup[]): OfferedGroup[] {
  return groups.map((group) => ({
    file: sheet.file,
    sheet: sheet.name,
    claim: group.claim,
    positions: group.columns.map((c) => c.position),
    columns: group.columns,
    needsChoice: false,
  }));
}

function choicesFor(file: string, rounds: UpgradeDecisions["rounds"]): ColumnChoice[] {
  return rounds.flatMap((r) => r.choices).filter((c) => c.file === file).map(({ positions, keep }) => ({ positions, keep }));
}

/** Folds one sheet's result into the site's. */
function addResult(site: SiteRepair, sheet: ReadSheet, result: RepairSheetResult): void {
  site.failure ??= stopFor(sheet.name, result);
  if (result.kind === "sheet_unreadable_for_repair" && result.reason === "unreadable") {
    site.report.push(...withSheetPath(sheet.file, result.report));
  } else if (result.kind === "needs_choices") {
    site.groups.push(...offeredGroups(sheet, result.groups));
    site.invalid ||= result.invalidChoices.length > 0;
  } else if (result.kind === "repaired") {
    site.writes.push({ path: sheet.readPath, content: result.text, verbatim: true });
    site.report.push(...withSheetPath(sheet.file, result.report));
  }
}

function unreadableLink(sheet: ReadSheet): SheetReportLine {
  return { kind: "unreadable", sheet: sheet.name, error: "the link does not lead to a file in the site", file: sheet.file };
}

/**
 * Every sheet repaired in the order the framework repairs them, with the
 * choices of `rounds`. A sheet two links lead to is read, the second time, as
 * the first repair left it, as the framework reads the file it just wrote.
 */
function repairEverySheet(sheets: readonly ReadSheet[], rounds: UpgradeDecisions["rounds"], chainFiles: ReadonlyMap<string, string>): SiteRepair {
  const site: SiteRepair = { writes: [], finals: [], report: [], groups: [], invalid: false, failure: null };
  const written = new Map<string, string>();
  for (const sheet of sheets) {
    if (sheet.raw === null) {
      site.report.push(unreadableLink(sheet));
      continue;
    }
    if (sheet.tab !== undefined) continue;
    const text = written.get(sheet.readPath) ?? repairInput(sheet, sheet.raw, chainFiles);
    const result = repairSheet({ path: sheet.file, text, role: sheet.role, choices: choicesFor(sheet.file, rounds) });
    addResult(site, sheet, result);
    if (result.kind === "repaired") written.set(sheet.readPath, result.text);
  }
  site.writes = [...new Map(site.writes.map((w) => [w.path, w])).values()];
  for (const sheet of sheets) {
    if (sheet.raw === null) continue;
    const text = written.get(sheet.readPath) ?? repairInput(sheet, sheet.raw, chainFiles);
    site.finals.push({ name: sheet.name, role: sheet.role, text });
  }
  return site;
}

type Column = { header: string; position: number };

/**
 * The headers of each group of columns a check found the build reads as one
 * field, in the tab's order: the groups the author would choose in, and the
 * groups the repair would settle by deleting empty columns.
 */
function collidingGroups(result: RepairSheetResult): string[][] {
  const groups: Column[][] = result.kind === "needs_choices" ? result.groups.map((g) => g.columns) : [];
  const byKeeper = new Map<number, Column[]>();
  for (const entry of result.report) {
    if (entry.kind !== "dropped") continue;
    const group = byKeeper.get(entry.keeperPosition) ?? [{ header: entry.keeper, position: entry.keeperPosition }];
    group.push({ header: entry.column, position: entry.position });
    byKeeper.set(entry.keeperPosition, group);
  }
  return [...groups, ...byKeeper.values()].map((g) => [...g].sort((a, b) => a.position - b.position).map((c) => c.header));
}

/**
 * The stop for the live tabs the 1.8.0 build would refuse, or null. A tab
 * whose repair would stop the upgrade anyway stops it at once, under that
 * tab's name; any other tab that would need a repair is named among the tabs
 * to fix in Google Sheets, with its colliding columns. A live tab is checked
 * on its text as fetched, uncleaned, which is what the build reads while the
 * site reads Google Sheets. A tab read under two roles, once where it lands
 * and once through a link to it, is named once.
 */
function liveTabsStop(sheets: readonly ReadSheet[]): SheetStageFailure | null {
  const refused = new Set<string>();
  const collisions = new Map<string, TabCollision>();
  for (const sheet of sheets) {
    if (sheet.tab === undefined || sheet.raw === null) continue;
    const result = repairSheet({ path: sheet.file, text: sheet.raw, role: sheet.role });
    const stop = stopFor(sheet.tab, result, true);
    if (stop !== null) return stop;
    if (result.kind !== "repaired" && result.kind !== "needs_choices") continue;
    refused.add(sheet.tab);
    for (const columns of collidingGroups(result)) collisions.set(JSON.stringify([sheet.tab, columns]), { tab: sheet.tab, columns });
  }
  if (refused.size === 0) return null;
  return {
    kind: "failed",
    error: "sheets_columns_refused",
    detail: { tabs: [...refused].join(", "), count: refused.size, collisions: [...collisions.values()] },
  };
}

/**
 * The sheets the build reads and the tabs it fetches them from, with the tabs
 * the build would refuse, or the stop a tab whose repair would stop the
 * upgrade anyway is.
 */
async function readEffectiveSheets(
  input: SheetStageInput,
): Promise<{ sheets: ReadSheet[]; tabs: UpgradeChallengeContent["tabs"]; read: SheetsRead; refused: TabsRefused | null } | SheetStageFailure> {
  const tabs = await readSiteTabs(input.chainFiles.get("_config.yml"), input.readTabs);
  const read = await readSheets(input, tabs);
  const stop = liveTabsStop(read.read);
  if (stop !== null && stop.error !== "sheets_columns_refused") return stop;
  return { sheets: read.read, tabs: tabs?.listed ?? null, read, refused: stop?.detail ?? null };
}

/** Whether nothing written changes a value the editor holds: no column the author chose between went. */
function advancesHead(report: readonly SheetReportLine[]): boolean {
  return !report.some((line) => (line.kind === "dropped" || line.kind === "marked") && line.chosen);
}

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

/** The author's choices between columns as the picker posts them, or null for none or for text that is not JSON. */
export function parsePostedChoices(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** `additions` with each repaired sheet in place of any other copy of its path. */
export function withRepairedSheets(additions: CommitFile[], writes: readonly CommitFile[]): CommitFile[] {
  const byPath = new Map(additions.map((a) => [a.path, a]));
  for (const write of writes) byPath.set(write.path, write);
  return [...byPath.values()];
}


export function pendingOf(groups: readonly OfferedGroup[]): PendingGroup[] {
  return groups.map(({ file, claim, positions }) => ({ file, claim, positions }));
}

export function flagged(groups: OfferedGroup[], unanswered: readonly PendingGroup[]): OfferedGroup[] {
  return groups.map((group) => ({
    ...group,
    needsChoice: unanswered.some((u) => u.file === group.file && samePositions(u.positions, group.positions)),
  }));
}

function noticeFor(voided: boolean, site: SiteRepair, rounds: UpgradeDecisions["rounds"]): ChoiceNotice | null {
  if (voided) return "sheets_changed";
  if (site.invalid) return "choice_needed";
  return rounds.length > 0 ? "further_choices" : null;
}

type ChallengeFrame = Omit<UpgradeChallengeContent, "decisions" | "pending">;

function answerFor(
  site: SiteRepair,
  frame: ChallengeFrame,
  rounds: UpgradeDecisions["rounds"],
  voided: boolean,
  off: SwitchedTabs | null,
): SheetStageResult {
  if (site.failure) return site.failure;
  const decisions: UpgradeDecisions = { sheets: off ? "off" : null, rounds };
  if (site.groups.length > 0) {
    const challenge = { ...frame, decisions, pending: pendingOf(site.groups) };
    return { kind: "needs_choices", challenge, groups: site.groups, notice: noticeFor(voided, site, rounds) };
  }
  return {
    kind: "ready",
    writes: off ? withRepairedSheets(off.writes, site.writes) : site.writes,
    report: site.report,
    // The framework's `v180_sheets_clean`: it writes no record for the site's
    // sheets as first read, which is when nothing here is reported, since
    // every change the author chose stands for its `v180_columns_hold_values`.
    clean: site.report.length === 0,
    decisions,
    // Tabs written over the repository's copies change values the editor holds.
    advancesHead: off === null && advancesHead(site.report),
    finalSheets: site.finals,
    tabsChecked: frame.tabs !== null && off === null,
    sheetsOff: off && { config: off.config, written: off.writes.map((w) => w.path), deleted: off.deleted },
  };
}

/** The first release whose build refuses colliding columns and a `_metadata` column. */
const FIRST_REFUSING_RELEASE = "v1.8.0";

/**
 * Whether the release a tag installs refuses the sheets this stage repairs.
 * Compared as the upgrade compares versions, on the version the tag installs,
 * so a 1.8.0 release candidate counts as 1.8.0.
 */
function refusesCollidingColumns(targetTag: string): boolean {
  return compareVersions(`v${frameworkVersionForTag(targetTag)}`, FIRST_REFUSING_RELEASE) >= 0;
}

/** The stage's answer for a release that reads colliding columns as it always has: nothing read, nothing changed. */
const UNTOUCHED: SheetStageResult = {
  kind: "ready",
  writes: [],
  report: [],
  clean: true,
  decisions: { sheets: null, rounds: [] },
  advancesHead: true,
  finalSheets: [],
  tabsChecked: false,
  sheetsOff: null,
};

/**
 * Every sheet repaired with the decisions so far: from scratch where no
 * matching challenge asked about columns, and otherwise replaying its rounds
 * and the round posted with it.
 */
function settleSheets(
  sheets: readonly ReadSheet[],
  chainFiles: ReadonlyMap<string, string>,
  frame: ChallengeFrame,
  matched: UpgradeChallengeContent | null,
  voided: boolean,
  submitted: unknown,
  off: SwitchedTabs | null,
): SheetStageResult {
  if (matched === null || matched.pending.length === 0) {
    return answerFor(repairEverySheet(sheets, [], chainFiles), frame, [], voided, off);
  }
  const prior = matched.decisions.rounds;
  const checked = checkRound(matched.pending, submitted);
  if ("unanswered" in checked) {
    const again = repairEverySheet(sheets, prior, chainFiles);
    return { kind: "needs_choices", challenge: matched, groups: flagged(again.groups, checked.unanswered), notice: "choice_needed" };
  }
  const rounds = [...prior, { choices: checked.round }];
  return answerFor(repairEverySheet(sheets, rounds, chainFiles), frame, rounds, false, off);
}

/** The tabs written as the site's CSVs once it stops reading Google Sheets. */
interface SwitchedTabs {
  config: string;
  writes: CommitFile[];
  deleted: string[];
}

/** The language pairs the build reads one file of, English first (`_first_present`). */
const PAIRED_SHEETS: readonly (readonly [string, string])[] = [PROJECT_SHEETS, OBJECTS_SHEETS, GLOSSARY_SHEETS];
const PAIRED_NAMES: ReadonlySet<string> = new Set(PAIRED_SHEETS.flat());

/**
 * The CSVs the commit writes in place of the tabs, cleaned as the commit
 * cleans them, and the repository copies it deletes. A story tab is written
 * where the build wrote it. Of a project, objects or glossary pair, only the
 * file the build reads is written: the one `_first_present` picks over the
 * repository and the tabs together, English first. Where that is the
 * repository's own file it stays as it is, and the other language's tab is not
 * written, since the build never read it. Where the picked file came from a
 * tab, it is written under the English name, which the Compositor's import and
 * sync read and the build prefers, and the Spanish-named repository copy it
 * stood in for is deleted.
 */
function switchedTabs(read: SheetsRead, config: string): SwitchedTabs {
  const dir = `${SPREADSHEETS_DIR}/`;
  const writes = new Map<string, string>();
  for (const [path, tab] of read.landed) {
    if (!PAIRED_NAMES.has(path.slice(dir.length))) writes.set(path, tab.text);
  }
  const deleted: string[] = [];
  for (const [english, spanish] of PAIRED_SHEETS.map(([en, es]) => [dir + en, dir + es])) {
    const picked = [english, spanish].find(read.isPresent);
    const tab = picked === undefined ? undefined : read.landed.get(read.landing(picked));
    if (tab === undefined) continue;
    writes.set(picked === english ? read.landing(english) : english, tab.text);
    if (picked === spanish && read.inRepo(spanish)) deleted.push(spanish);
  }
  const files = [...writes].map(([path, text]) => ({ path, content: cleanCommitContent(path, text), verbatim: true as const }));
  return { config, writes: files, deleted };
}

/** The stage's input as the build reads the site once the switched tabs are committed and Sheets is off. */
function afterSwitch(input: SheetStageInput, off: SwitchedTabs): SheetStageInput {
  const written = new Map(off.writes.map((w) => [w.path, w.content]));
  const gone = (path: string) => written.has(path) || off.deleted.includes(path);
  const chainFiles = new Map([...input.chainFiles].filter(([path]) => !gone(path)));
  return {
    ...input,
    chainFiles,
    listEntries: async () => [
      ...(await input.listEntries()).filter((entry) => !gone(entry.path)),
      ...[...written.keys()].map((path) => ({ path, mode: "100644", sha: "" })),
    ],
    readRaw: async (path) => written.get(path) ?? (gone(path) ? null : input.readRaw(path)),
    targetExists: async (path) => written.has(path) || (!gone(path) && (await input.targetExists(path))),
  };
}

/**
 * `_config.yml` with Google Sheets switched off, or null where no edit
 * turns it off: `disableGoogleSheetsInConfig` rewrites `enabled` in place and
 * refuses unless the build's test then reads it off and every other key
 * loads as before.
 */
export function sheetsOffConfig(config: string | undefined): string | null {
  try {
    return disableGoogleSheetsInConfig(config ?? "");
  } catch (err) {
    if (err instanceof SheetsNotDisableableError) return null;
    throw err;
  }
}

/** The author's posted answer to the Google Sheets offer, or null for none. */
function sheetsAnswerOf(posted: unknown): "off" | "keep" | null {
  return posted === "off" || posted === "keep" ? posted : null;
}

/**
 * Reads, checks and repairs every sheet, replaying a matching challenge's
 * decisions and the round posted with it, for a target release that refuses
 * colliding columns; for an earlier one, changes nothing. Where a tab would be
 * refused, the author's answer to the Google Sheets offer is asked for, and
 * replayed from a matching challenge; a challenge that no longer matches asks
 * again. Reads that fail throw as `input`'s readers throw.
 */
export async function runSheetStage(input: SheetStageInput): Promise<SheetStageResult> {
  if (!refusesCollidingColumns(input.targetTag)) return UNTOUCHED;
  const { challenge } = input;
  const read = await readEffectiveSheets(input);
  if ("kind" in read) return read;
  const { sheets, tabs } = read;
  const frame = { v: 1 as const, targetTag: input.targetTag, headOid: input.headOid, sheets: sheets.map((s) => s.bound), tabs };
  const matched = challenge !== null && challengeMatches(challenge, input, frame.sheets, frame.tabs) ? challenge : null;
  const voided = challenge !== null && matched === null;
  if (read.refused === null) return settleSheets(sheets, input.chainFiles, frame, matched, voided, input.submitted, null);

  // The offer is the question asked when no decision has been made; its
  // challenge asks about no columns.
  const offered = matched !== null && matched.decisions.sheets === null && matched.pending.length === 0;
  const decision = matched?.decisions.sheets ?? (offered ? sheetsAnswerOf(input.sheetsAnswer) : null);
  if (decision === "keep") return { kind: "failed", error: "sheets_columns_refused", detail: read.refused };
  if (decision === null) {
    const asking = { ...frame, decisions: { sheets: null, rounds: [] }, pending: [] };
    return { kind: "needs_sheets_decision", challenge: asking, detail: read.refused, notice: challenge !== null ? "sheets_changed" : null };
  }
  const config = sheetsOffConfig(input.chainFiles.get("_config.yml"));
  if (config === null) return { kind: "failed", error: "sheets_switch_unreadable" };
  const off = switchedTabs(read.read, config);
  const after = afterSwitch(input, off);
  const { read: switched } = await readSheets(after, null);
  return settleSheets(switched, after.chainFiles, frame, matched, false, input.submitted, off);
}
