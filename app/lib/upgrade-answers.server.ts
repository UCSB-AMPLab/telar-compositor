/**
 * The step answers an upgrade from below 1.8.0 to 1.8.0 or later publishes
 * differently. A build from 1.8.0 on cuts an answer over the card's
 * budget, removes images, embeds, footnotes, tables, code and widgets, and
 * flattens lists, headings, quotes and rules; an earlier build publishes the
 * answer whole. The upgrade's commit is the site's first 1.8.0 build, made with
 * no publish check, so the author is shown here what that build will do.
 *
 * Each sheet is read as the framework's migration reads it for its own answer
 * report (`_story_answer_records` in scripts/migrations/v180_sheets.py): every
 * sheet the build converts except the project and objects sheets, the
 * glossary sheet included, the answer and step columns being the first to
 * claim `answer` and `step`, over the build's data rows. The answers are
 * checked with publish's own check (`answerChecks`), with the glossary terms
 * the build links them to. A sheet that cannot be read is left out: the sheet
 * stage reports it. A row wider than its header loses the cells past it, as
 * `telar.csv_utils.read_sheet` drops them.
 *
 * @version v1.5.0-beta
 */

import { pythonStrip } from "~/lib/column-mapping";
import { answerChecks, type AnswerStep } from "~/lib/answer-checks.server";
import { collectExtraColumns } from "~/lib/extra-columns.server";
import { KNOWN_STORY_KEYS, isStoryStepRow } from "~/lib/story-step-rows";
import type { GlossaryContext } from "~/lib/answer-preview";
import {
  FrameworkSheetUnreadableError,
  claimedNames,
  dataRows,
  readFrameworkSheet,
  type FrameworkSheet,
  type SheetScope,
} from "~/lib/framework-sheet.server";
import { keptGlossaryTerms } from "~/lib/glossary-links";
import { markdownGlossaryTerms, type GlossaryFile } from "~/lib/upgrade-glossary-files.server";
import { scopeOf } from "~/lib/sheet-collision-repair.server";
import type { ValidationItem } from "~/lib/publish.server";
import { compareVersions, frameworkVersionForTag } from "~/lib/telar-version";
import type { FinalSheet } from "~/lib/upgrade-sheets.server";

/** One step whose answer the upgraded site publishes differently, or whose row loses cells, with what the checks say about it. */
export interface UpgradeAnswer {
  /** The story's id: its sheet's file name without `.csv`. */
  story: string;
  /** The step as its sheet's `step` cell holds it. */
  step: string;
  /** The step's place in the story as the editor lists it, counted from one; null where the project holds no such story or the step cannot be identified in the editor's order. */
  position: number | null;
  /** Whether the project holds the story, so a step with no position can still be linked to its story. */
  storyHeld: boolean;
  /** Whether the row has non-empty cells past its header, which the build drops. */
  cellsDropped: boolean;
  checks: ValidationItem[];
}

/** What the answer checks do not see of a step: where the sheet's numbering puts it, and whether its row is wider than the header. */
interface StepFacts {
  story: string;
  answer: string;
  position: number;
  cellsDropped: boolean;
}

/**
 * Each story the project holds, with the answers of the steps the editor
 * lists for it (`step_number > 0`), in the editor's order: `order_key`, which
 * an unpublished reorder rewrites while the sheet keeps its numbers.
 */
export type ProjectStoryAnswers = ReadonlyMap<string, readonly (string | null)[]>;

/** The sheet's own step order, answers by place: what the editor shows when nothing has been reordered since. */
type SheetOrder = { story: string; answers: string[] };

/** The first release whose build cuts and strips answers. */
const FIRST_CUTTING_RELEASE = "v1.8.0";

/** Whether an upgrade from `siteVersion` to the release `targetTag` installs is the one that starts cutting answers. */
export function upgradeStartsCuttingAnswers(siteVersion: string, targetTag: string): boolean {
  const versionOf = (tag: string) => `v${frameworkVersionForTag(tag)}`;
  return compareVersions(versionOf(siteVersion), FIRST_CUTTING_RELEASE) < 0 && compareVersions(versionOf(targetTag), FIRST_CUTTING_RELEASE) >= 0;
}

function readOrSkip(sheet: FinalSheet): FrameworkSheet | null {
  try {
    return readFrameworkSheet(sheet.text);
  } catch (err) {
    if (err instanceof FrameworkSheetUnreadableError) return null;
    throw err;
  }
}

/** The first column claiming each name, as `_column_for` finds it. */
function columnsFor(sheet: FrameworkSheet, scope: SheetScope, names: readonly string[]): (number | undefined)[] {
  const claims = claimedNames(sheet.labels, scope);
  return names.map((name) => claims.get(name)?.[0]);
}

/**
 * The terms the build links answers to: the glossary sheet's, when it has the
 * columns the glossary pages need (`_csv_page_rows`); none otherwise. A site
 * with no glossary sheet has its terms from the Markdown glossary files.
 */
function glossaryOf(sheets: readonly FinalSheet[], files: readonly GlossaryFile[]): GlossaryContext {
  const none: GlossaryContext = { terms: new Map(), baseUrl: "" };
  const sheet = sheets.find((s) => s.role === "glossary");
  if (!sheet) return { terms: markdownGlossaryTerms(files), baseUrl: "" };
  const read = readOrSkip(sheet);
  if (!read) return none;
  const scope = scopeOf(sheet.role);
  const [id, title, definition] = columnsFor(read, scope, ["term_id", "title", "definition"]);
  if (id === undefined || title === undefined || definition === undefined) return none;
  const rows = dataRows(read, scope.sheetAliases).map((row) => ({ term_id: row[id] ?? "", title: row[title] ?? "" }));
  return { terms: keptGlossaryTerms(rows), baseUrl: "" };
}

/**
 * Each column's key as the import names it: the field it claims, the first
 * column claiming a field taking it, and otherwise its own header.
 */
function keysByColumn(labels: readonly string[], claims: Map<string, number[]>): string[] {
  const keys = [...labels];
  for (const [name, at] of claims) keys[at[0]] = name;
  return keys;
}

/**
 * A story sheet's steps as the import makes them: a row is a step when the
 * import keeps it (`isStoryStepRow`), it is numbered by
 * its `step` cell or else its place, and the editor lists steps by that number,
 * the sheet's order breaking a tie (`mapStoryCsv`, the story loader).
 */
function answerStepsOf(sheet: FinalSheet): { steps: AnswerStep[]; facts: Map<string, StepFacts>; order: SheetOrder } {
  const story = sheet.name.replace(/\.csv$/, "");
  const read = readOrSkip(sheet);
  const none = { steps: [], facts: new Map<string, StepFacts>(), order: { story, answers: [] } };
  if (!read) return none;
  const scope = scopeOf(sheet.role);
  const [answerAt, stepAt] = columnsFor(read, scope, ["answer", "step"]);
  const keys = keysByColumn(read.labels, claimedNames(read.labels, scope));
  const rows = dataRows(read, scope.sheetAliases);
  const kept = rows.filter((row) => {
    const named = Object.fromEntries(keys.map((key, at) => [key, row[at] ?? ""]));
    return isStoryStepRow(named, collectExtraColumns(named, KNOWN_STORY_KEYS).extras);
  });
  const numbers = kept.map((row, place) => (stepAt === undefined ? 0 : parseInt(row[stepAt] ?? "", 10)) || place + 1);
  const listed = (place: number) => numbers[place] > 0;
  const facts = new Map<string, StepFacts>();
  const listedAnswers: string[] = [];
  const steps = rows.map((row, index): AnswerStep => {
    const id = `${sheet.name}:${index}`;
    const place = kept.indexOf(row);
    const position =
      place < 0 || !listed(place)
        ? 0
        : 1 + numbers.filter((n, other) => n > 0 && (n < numbers[place] || (n === numbers[place] && other < place))).length;
    const answer = answerAt === undefined ? "" : (row[answerAt] ?? "");
    facts.set(id, { story, answer, position, cellsDropped: row.slice(read.labels.length).some((cell) => pythonStrip(cell) !== "") });
    if (position > 0) listedAnswers[position - 1] = answer;
    const step = stepAt === undefined ? "unknown" : pythonStrip(row[stepAt] ?? "");
    return { id, step_number: step, answer, story_id: story };
  });
  return { steps, facts, order: { story, answers: listedAnswers } };
}

/**
 * Where the editor puts a step whose sheet place is `position`. The editor
 * selects by place in `order_key` order, which an unpublished reorder changes
 * without touching the sheet, so the sheet's place is used only when the
 * editor's answers run in the sheet's order. Otherwise the step is found by
 * its answer, when exactly one step on each side holds it; a step that cannot
 * be told apart has no place.
 */
function editorPosition(facts: StepFacts, sheetOrder: readonly string[], editorOrder: readonly (string | null)[] | undefined): number | null {
  if (!editorOrder || facts.position <= 0) return null;
  const same = (a: string | null, b: string | null) => pythonStrip(a ?? "") === pythonStrip(b ?? "");
  if (editorOrder.length === sheetOrder.length && editorOrder.every((answer, at) => same(answer, sheetOrder[at]))) return facts.position;
  const mine = pythonStrip(facts.answer);
  if (mine === "" || sheetOrder.filter((answer) => same(answer, mine)).length !== 1) return null;
  const at = editorOrder.flatMap((answer, place) => (same(answer, mine) ? [place] : []));
  return at.length === 1 ? at[0] + 1 : null;
}

/**
 * Every step, in sheet and row order, whose answer the first 1.8.0 build
 * publishes differently or whose row loses cells past the header. Only a step
 * of a story in `projectStories` gets a position, found in the editor's order.
 * `glossaryFiles` are the site's Markdown glossary files, read only when the
 * site has no glossary sheet.
 */
export function answersPublishedDifferently(sheets: readonly FinalSheet[], projectStories: ProjectStoryAnswers = new Map(),
  glossaryFiles: readonly GlossaryFile[] = [],
): UpgradeAnswer[] {
  const glossary = glossaryOf(sheets, glossaryFiles);
  const read = sheets.filter((s) => s.role === "story" || s.role === "glossary").map(answerStepsOf);
  const steps = read.flatMap((r) => r.steps);
  const facts = new Map(read.flatMap((r) => [...r.facts]));
  const sheetOrders = new Map(read.map((r) => [r.order.story, r.order.answers]));
  const { blockers, warnings } = answerChecks(steps, glossary);
  const checks = [...blockers, ...warnings];
  return steps.flatMap((step) => {
    const own = checks.filter((check) => check.entityId === step.id);
    const known = facts.get(String(step.id)) as StepFacts;
    if (own.length === 0 && !known.cellsDropped) return [];
    const story = step.story_id as string;
    const position = editorPosition(known, sheetOrders.get(story) ?? [], projectStories.get(story));
    return [{ story, step: String(step.step_number), position, storyHeld: projectStories.has(story), cellsDropped: known.cellsDropped, checks: own }];
  });
}
