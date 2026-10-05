/**
 * This file orchestrates the full repo import — validating the Telar site,
 * parsing CSVs (or Google Sheets), scanning for IIIF tiles, and writing
 * everything to D1 in a single batched insert.
 *
 * The entry point is `importRepo`. Every helper used along the way is
 * exported for unit testing — CSV row classifiers, the Sheets-vs-repo
 * branch, the YAML config mapper, the per-table column mappers, the
 * orphan-story detector, and the rollback cascade. They are split out
 * because the import path is the single largest surface where a
 * malformed user repo or an unreachable Google Sheet can corrupt project
 * state, and exhaustive unit coverage was easier than reasoning about
 * the end-to-end flow.
 *
 * One blocking path is critical: when `google_sheets.enabled` is true
 * and the Sheet is inaccessible, the import is aborted and the wizard
 * surfaces an error — there is no fallback to repo CSVs. For sites
 * that use Google Sheets, the Sheet is the source of truth; silently
 * importing whatever stale rows happen to sit in the repo would
 * desynchronise the user's content without them noticing.
 *
 * A course project comes through here too. It is a real site with a repo
 * of its own, distinguished only by `projects.kind` and by two config
 * defaults, so it takes this path rather than one of its own — this is
 * the only code that inserts a project row, and it requires a repo. Those
 * defaults are written to D1 alone and reach `_config.yml` at the next
 * publish, so creating a course cannot fail on a GitHub error.
 *
 * @version v1.5.0-beta
 */

import { KNOWN_STORY_KEYS, isStoryStepRow } from "~/lib/story-step-rows";
export { KNOWN_STORY_KEYS } from "~/lib/story-step-rows";
import Papa from "papaparse";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "~/lib/db.server";
import {
  getFileAtRef, getRepoTree, getRepoHead, getDefaultBranchHead, getSubtreeOids, listSubtreeEntries,
  NoSuchBranchError,
} from "~/lib/github.server";
import { discoverSheetTabs, fetchSheetCsv } from "~/lib/sheets.server";
import { readsAsUntitledLayer1 } from "~/lib/panel-heading";
import { parseYaml, parseYamlFailsafe, safeLoadTitle } from "~/lib/yaml.server";
import { isGoogleSheetsOn } from "~/lib/pyyaml";
import { FRONTMATTER_BLOCK, capturedFrontmatter } from "~/lib/page-frontmatter.server";
import { splitWelcomeLiquidBlock } from "~/lib/v130-ingest.server";
import { AUTHOR_ACTORS } from "~/lib/authorship";
import type { AuthorActor } from "~/lib/authorship";
import {
  isTemplateStory,
  isTemplateStep,
  isTemplateObject,
  isTemplateTerm,
  isTemplatePage,
} from "~/lib/template-content.server";
import type { RedeemForSiteResult, RedeemState } from "~/lib/join-codes.server";
import {
  collectExtraColumns,
  extrasBlob,
  hasStoryRowContent,
  isInstructionColumnName,
  isReservedColumnName,
} from "~/lib/extra-columns.server";
// Re-exported below for the callers and tests that have always read them from
// here; the table itself lives in a dependency-free module so the Durable
// Object can import it without the rest of this one.
import {
  COLUMN_NAME_MAPPING,
  GLOSSARY_COLUMN_ALIASES,
  GLOSSARY_CSV_COLUMNS,
  KNOWN_OBJECT_KEYS,
  OBJECTS_CSV_COLUMNS,
  PROJECT_CSV_COLUMNS,
  STORY_CSV_COLUMNS,
  foldHeader,
  pythonStrip,
} from "~/lib/column-mapping";
import { readCsvSourceRows } from "~/lib/csv-record-scan.server";
import type { CsvSheet } from "~/lib/sheet-csv-layout.server";
import { PYTHON_WHITESPACE } from "~/lib/python-whitespace";
import { isCommentCell, isHeldTermId, publishedRowPerTermId } from "~/lib/csv-records";
import { AUDIO_EXTENSIONS } from "~/lib/file-types";
import { isTilerObjectId, repeatedIdIssues, sharedSiteIdIssues, siteObjectId, tileableExtensions } from "~/lib/object-id";
import { siteVersionFromParsed, telarVersionOf } from "~/lib/site-version.server";
import { FIELD_REGISTRY, isExcluded } from "~/lib/field-registry";
import { issuesFor } from "~/lib/sheet-warnings";
import { SheetUnreadableError } from "~/lib/unreadable-file.server";
import { GLOSSARY_SHEETS, OBJECTS_SHEETS, PROJECT_SHEETS, readSiteSheet } from "~/lib/site-sheets.server";
import type { SheetIssue, SheetIssueHandler, SheetRow, SheetWarning, UnreadableRepair } from "~/lib/sheet-warnings";
import { pushUnreadable } from "~/lib/unreadable-characters.server";
import { serialisePageFilesRecord } from "~/lib/page-files-record";
import { recordStoryFileReads, storyFileRead, type OwedStoryFile } from "~/lib/story-files-to-delete.server";
import { reduceScannedPages } from "~/lib/one-language-pages";
import { recordWithdrawals } from "~/lib/repo-access-withdrawals.server";
import { glossaryKindsJsonOf } from "~/lib/glossary-kinds-yaml.server";
import type { SheetChoicesQuestion } from "~/lib/sheet-choices.server";
export { COLUMN_NAME_MAPPING, KNOWN_OBJECT_KEYS };
import {
  projects,
  project_config,
  project_landing,
  project_themes,
  objects,
  stories,
  steps,
  layers,
  glossary_terms,
  project_members,
  project_invites,
  project_pages,
  pending_object_ops,
  activity_log,
  entity_contributors,
  member_editing_time,
} from "~/db/schema";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------


/**
 * Every COLUMN_NAME_MAPPING key that renames onto `private` other than
 * `private` itself — derived, not hand-listed, so a spelling added to the
 * mapping later is scoped automatically. `parseTelarCsv` renames a key in
 * this set only while parsing project.csv (or the project sheet tab); a
 * column of the same name in any other Telar CSV is a user's own, not the
 * pre-v0.9.0 protection column, and keeps its header untouched.
 */
const PROJECT_ONLY_ALIASES = new Set(
  Object.keys(COLUMN_NAME_MAPPING).filter((k) => COLUMN_NAME_MAPPING[k] === "private" && k !== "private"),
);

/**
 * The truthy spellings `private` accepts, wherever it is read: in
 * `parseTelarCsv` (to decide which of a row's protection COLUMNS is truthy,
 * tracked by position — see `parseTelarCsv`) and in `mapProjectCsv` (to
 * decide the same for the single resolved cell it is handed). Matches the
 * framework's processors/project.py — yes/true/sí/si, case-insensitive and
 * trimmed. "1" is intentionally NOT accepted: the framework would publish
 * such a story in cleartext, so accepting "1" here would make the
 * Compositor UI claim protection the published site does not provide.
 */
const PRIVATE_TRUTHY = new Set(["true", "yes", "sí", "si"]);

/**
 * The truthy spellings `featured` accepts, read by `mapObjectsCsv` off the
 * single `featured` cell. Matches the framework's `featured_values` in
 * `scripts/telar/processors/objects/featured.py` — yes/true/sí/si/1,
 * case-insensitive and trimmed.
 *
 * "1" IS accepted here, unlike `PRIVATE_TRUTHY` and `show_sections`'s
 * whitelist (`mapProjectCsv`): the framework's own two tables genuinely
 * differ — `processors/project.py:112,117` omits "1" from the spellings it
 * treats as truthy for `protected`/`show_sections`, while `featured.py`
 * includes it. That is the framework's divergence, not an oversight to tidy
 * away later; unifying the three sets would break parity with a framework
 * that does not itself agree with its own tables.
 *
 * The comparison is `pythonStrip(cell).toLowerCase()` against this set,
 * unnormalised: `sí` written as `s` + `i` + U+0301 (NFD) is not truthy in the
 * framework either, because `featured_values` compares the same unnormalised
 * string. Normalising here would make the Compositor feature an object the
 * built site does not.
 *
 * The whitelist itself matches. The one place the two sides can still
 * disagree is a numeric spelling, in both directions, and only where pandas
 * reads the cell as a number rather than as text. Where it does: a `1`
 * sharing a column with an empty cell is inferred as the float `1.0`, which
 * does not match the framework's explicit-feature mask, while the raw text
 * still passes this one. That is not the framework reading the row as not
 * featured — only as not an explicit feature request; when the mask matches
 * nothing at all the framework falls through to a sample of the rows whose
 * `object_warning` value strips to an empty string, so on a sheet carrying
 * that column a row the mask missed can still come out featured. The Compositor, with no such
 * fallback, reads it as featured outright. A `01` sharing a column with a
 * `0` is inferred as the int `1`, which matches the framework's mask while
 * "01" matches none of this whitelist's spellings, so the framework marks
 * the row featured and the Compositor does not.
 *
 * What keeps that rare is weaker than it looks. Dtype is settled at read
 * time, before the bilingual row is dropped, so one cell pandas takes as
 * text — most often that row's `destacado`, which the template ships — is
 * enough to keep an ordinary sheet's column textual, and both sides then
 * agree on `1` and on `01` alike. But a cell holding one of pandas' default
 * missing-value tokens (`NA`, `null` and the rest) is not text for this
 * purpose and leaves the column numeric; and a file with enough records to
 * fill pandas' parser buffer is inferred a chunk at a time, so a chunk
 * holding no text reads its own digits as numbers even where the column
 * overall is textual — as integers where that chunk is all integers, as
 * floats where a missing or decimal value joins them, and `1` and `1.0`
 * fall on opposite sides of the framework's whitelist. This whitelist is
 * not changed to model any of that — it would bind the Compositor to a
 * pandas version and its buffer size, for a divergence that belongs to the
 * framework.
 *
 * A project whose import predates sí/si's inclusion here reads `featured`
 * as false for those cells until it is re-imported: an ordinary three-way
 * sync reads the resulting difference as an unpublished editor edit and
 * leaves it alone, so nothing after the fact repairs it.
 */
export const FEATURED_TRUTHY = new Set(["true", "yes", "sí", "si", "1"]);

/**
 * Known bilingual column values used in the second row of Telar CSVs. A row
 * where 80%+ of its non-empty values match this set is treated as the
 * bilingual header row and skipped during import. Derived from
 * COLUMN_NAME_MAPPING so both the Spanish header words (the keys) and the
 * canonical English words (the values) are detected — covering CSVs whose
 * second row repeats either language.
 */
// Extra header tokens the framework's is_header_row recognises beyond the
// COLUMN_NAME_MAPPING key/value union — mirrored here so the Compositor's
// bilingual-row detection stays in lockstep with the framework. Source of
// truth: telar/scripts/telar/csv_utils.py (is_header_row valid_names).
// Appearing in this list says only that is_header_row treats the word as a
// header token; it does not say COLUMN_NAME_MAPPING renames a column by that
// name to one of the Compositor's own canonical columns. `protected` is such
// a rename (onto `private`, alongside every other PROJECT_ONLY_ALIASES
// spelling), and so are `medium` and `object_type` (both onto `medium_genre`);
// `location` is another (onto `source`).
//
// `protected` here is NOT gated the way COLUMN_NAME_MAPPING's own copy of it
// is (see KNOWN_BILINGUAL_VALUES_NON_PROJECT below): an objects/story/
// glossary row of three or more populated cells, all of which happen to
// match a known bilingual token, is misread as a header row and dropped by
// this list alone, outside project mode. isHeaderRow's three-cell floor
// (below) keeps a shorter row — a two-cell object_id="source",
// title="Protected", say — out of this set entirely; a longer all-token row
// is this list's own, unscoped exposure, tracked separately from this floor.
const FRAMEWORK_HEADER_TOKENS = [
  "x", "y", "zoom", "page", "order", "story_id", "title", "subtitle",
  "byline", "object_id", "description", "source_url", "creator", "period",
  "medium", "dimensions", "location", "source", "credit", "thumbnail",
  "year", "object_type", "subjects", "featured", "protected", "show_sections",
];

// Header words neither table renames, counted as header words all the same
// because author files carry them. A glossary.csv the Compositor published
// while it modelled the overlap acknowledgement is headed `quoted_in_stories`
// with `citado_en_historias` in the bilingual row beneath it, and the
// framework's template sheet shipped that same pair, so a site created from it
// before the exemption has the row in its repo. `citada_en_historias` is the
// alias an author may have headed the column with, which both sides recognised
// while the column existed. Neither carries any of the three now.
//
// A spelling either side ever published or accepted is a spelling some author's
// file holds, whatever either codebase makes of it afterwards, so this set can
// only grow: drop an entry and the row it belongs to falls back to the 80%
// threshold, where four cells of which three are known score 75% and the row
// imports as a term whose id is `id_término`.
//
// Deliberately NOT part of FRAMEWORK_HEADER_TOKENS, whose contract is to mirror
// is_header_row's valid_names: valid_names does not carry these words, and the
// framework reads such a row as a term. Skipping it here is what lets one
// re-import and republish clear it — the serializer gives a custom column an
// empty bilingual cell, so the file goes back out without the stale spelling.
export const ONCE_PUBLISHED_HEADER_TOKENS = [
  "quoted_in_stories", "citado_en_historias", "citada_en_historias",
];

export const KNOWN_BILINGUAL_VALUES = new Set<string>([
  ...Object.keys(COLUMN_NAME_MAPPING),
  ...Object.values(COLUMN_NAME_MAPPING),
  ...FRAMEWORK_HEADER_TOKENS,
  ...ONCE_PUBLISHED_HEADER_TOKENS,
]);

/**
 * The bilingual-row detector's set for any CSV other than project.csv (or
 * the project sheet tab): PROJECT_ONLY_ALIASES excluded from the
 * COLUMN_NAME_MAPPING-keys contribution, so a data row whose only cells
 * happen to read a protection spelling is ordinary content there, not a
 * header — mirroring the same scoping COLUMN_NAME_MAPPING's rename gets.
 * FRAMEWORK_HEADER_TOKENS is not filtered: its own `protected` entry is a
 * separate, pre-existing route into this set (see the note above) that this
 * scoping does not address. ONCE_PUBLISHED_HEADER_TOKENS is not filtered
 * either: this scoping mirrors a rename's own scope, and those spellings are a
 * rename onto nothing, on any sheet.
 */
const KNOWN_BILINGUAL_VALUES_NON_PROJECT = new Set<string>([
  ...Object.keys(COLUMN_NAME_MAPPING).filter((k) => !PROJECT_ONLY_ALIASES.has(k)),
  ...Object.values(COLUMN_NAME_MAPPING),
  ...FRAMEWORK_HEADER_TOKENS,
  ...ONCE_PUBLISHED_HEADER_TOKENS,
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * What a project is. A course is an ordinary project carrying this flag and
 * some default settings — there is no class entity and no second creation
 * path. Declared here because this module holds the only insert that writes
 * the column.
 */
export type ProjectKind = "site" | "course";

/** Narrow untrusted form input to a kind. Anything but "course" is a site. */
export function parseProjectKind(value: unknown): ProjectKind {
  return value === "course" ? "course" : "site";
}

/**
 * The config a course is provisioned with: a shared collection, and no
 * stories section on the published site. Ruling 23 keeps these in D1 at
 * creation rather than committing them, so course creation does not depend
 * on a GitHub round-trip and cannot fail on a repo error.
 */
export function courseConfigDefaults(
  kind: ProjectKind,
): { collection_mode: true; skip_stories: true } | Record<string, never> {
  return kind === "course" ? { collection_mode: true, skip_stories: true } : {};
}

/**
 * A repository's `main` branch, beside a default branch of another name:
 * absent, holding a Telar site by the import's own test, or holding none.
 */
export type MainBranch = "absent" | "site" | "not_site";

export interface ImportResult {
  valid: boolean;
  validationError?:
    | "not_telar"
    | "empty_repo"
    | "already_connected"
    | "colliding_columns"
    | "sheet_unreadable"
    | "file_unreadable"
    | "ignore_list_unreadable"
    | "no_main_branch"
    | "main_unreadable"
    | "rename_pending"
    | "branch_admin_required"
    | "scope_check_failed"
    | "needs_choices"
    | "choice_not_applied";
  /** Set with `validationError: "colliding_columns"`: the sheet refused, the
   * canonical name its columns claim, and the headers holding values. */
  collidingColumns?: { sheet: string; canonicalName: string; headers: string[] };
  /** Set with `validationError: "needs_choices"`: the groups the author chooses a column in. */
  sheetChoices?: SheetChoicesQuestion;
  /** Set with `validationError: "sheet_unreadable"` or `"choice_not_applied"`: the sheet's file name. */
  unreadableSheet?: string;
  /** Set with `validationError: "file_unreadable"`: the file's path in the repository. */
  unreadableFile?: string;
  /** Set with `validationError: "no_main_branch"` or `"main_unreadable"`: the repository's default branch. */
  defaultBranch?: string;
  /** Set with `validationError: "no_main_branch"`: what the repository's `main` branch is. */
  mainBranch?: MainBranch;
  /**
   * Set on an import after `fix_default_branch` when GitHub Pages still
   * publishes from a branch: the branch it publishes from, as GitHub reports it.
   */
  pagesWarning?: { branch: string };
  sheetsAccessError?: boolean;
  sheetsPublishedUrl?: string;
  telarVersion?: string;
  projectId?: number;
  project: { imported: boolean; storiesFound: number };
  objects: { imported: number; skipped: number; warnings: SheetWarning[] };
  stories: { imported: number; warnings: SheetWarning[] };
  glossary: { imported: number };
  pages: { imported: number };
  themes: {
    imported: number;
    list: Array<{ theme_id: string; name: string | null; swatch_color: string | null }>;
  };
  sheetsEnabled: boolean;
  sheetsDisabled: boolean;
  iiifObjectIds: string[];
  audioObjectIds: string[];
  videoObjectCount: number;
  configFields: Record<string, unknown>;
  /**
   * Story IDs that exist as {id}.csv in telar-content/spreadsheets/ on GitHub
   * but are absent from project.csv AND absent from .compositor-ignored.
   * Consumed by the dashboard loader to drive the orphan-stories banner.
   * Empty when google_sheets is enabled (Sheets-based sites have no per-story
   * CSV files to scan).
   */
  orphanStoryIds: string[];
  /**
   * The outcome of a join code entered alongside the import, absent when
   * none was. Set by the caller after this function returns — the join is a
   * post-creation step, because the project row it attaches only exists from
   * the moment the import writes it.
   */
  courseJoin?: CourseJoinOutcome;
}

/**
 * What a creation-time join can come to.
 *
 * Every refusal `redeemForSite` reports keeps its own name here — a code
 * that is expired, revoked or simply not a class code each tell the user a
 * different thing, and collapsing them into one error would leave a student
 * guessing. `failed` is not one of those states: it is the redemption never
 * reaching one, and it is reported separately because the site exists either
 * way and the code can be entered again from settings.
 *
 * The success carries the course's name rather than its id alone, because
 * the confirmation the user reads names the course they just joined.
 */
export type CourseJoinOutcome =
  | {
      state: "ok";
      courseProjectId: number;
      courseName: string;
      /** True when this site was already attached to this course. */
      alreadyAttached: boolean;
      /** Objects the course's collection put into the new site. */
      preloaded: number;
      /** Course objects the site's own objects already had the ids of. */
      skippedConflict: number;
      /** Course objects whose files live in the course's repository. */
      skippedRepoBound: number;
    }
  | Extract<RedeemForSiteResult, { state: Exclude<RedeemState, "ok"> }>
  | { state: "failed" }
  /**
   * The site left the course, or another course took it, in the gap between
   * the attachment and the collection transfer — a refusal, not a failure:
   * the site exists and the code can be entered again. Named so the notice
   * can tell the student which course they didn't join.
   */
  | { state: "not_enrolled"; courseProjectId: number; courseName: string };

interface ImportParams {
  token: string;
  installationId: number;
  repoFullName: string;
  userId: number;
  env: Env;
  /** Override the Google Sheets URL from _config.yml — used on retry when user corrects the URL */
  overrideGoogleSheetsUrl?: string;
  /** How the project entered the compositor; defaults to "imported". The create flow passes "created". */
  origin?: "imported" | "created";
  /**
   * What the project is; defaults to "site". Loose text validated in code
   * rather than a CHECK constraint, so a future kind costs no migration —
   * callers narrow the form value to this union before passing it.
   */
  kind?: ProjectKind;
  /**
   * Each Google Sheets tab's text as the import reads it, given its name and
   * the text fetched: the author's column choices applied (`withTabChoices`
   * in sheet-choices.server.ts, which this module cannot import, since the
   * repair it runs reads this module's tables as it loads). Throws
   * `TabsChangedError` for a tab whose bytes are not the ones the author chose
   * against.
   */
  readTab?: (name: string, text: string) => Promise<string>;
  /**
   * Given the tabs the published Sheet lists, throws `TabsChangedError` for a
   * tab the author chose columns in that is no longer among them: a choice
   * `readTab` never sees would otherwise go unchecked.
   */
  checkTabs?: (names: string[]) => void;
}

// ---------------------------------------------------------------------------
// index.md parser
// ---------------------------------------------------------------------------

export interface LandingData {
  stories_heading?: string;
  stories_intro?: string;
  objects_heading?: string;
  objects_intro?: string;
  welcome_body?: string;
}

/**
 * SSRF guard for the live-site probe: the probe base comes from the repo's own
 * _config.yml (untrusted on multi-author/imported repos). Require https and
 * reject private/loopback/link-local hosts so the server can't be coerced into
 * probing internal infrastructure.
 */
export function isSafeSiteBase(siteBase: string): boolean {
  let u: URL;
  try { u = new URL(siteBase); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return false;
  if (h === "::1" || h === "[::1]" || h === "0.0.0.0") return false;
  // IPv4 loopback / RFC1918 / link-local
  if (/^127\./.test(h)) return false;
  if (/^10\./.test(h)) return false;
  if (/^192\.168\./.test(h)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  if (/^169\.254\./.test(h)) return false;
  return true;
}

/**
 * objectId allowlist — IDENTICAL shape to the framework pipeline's object_id
 * guard (^[A-Za-z0-9_.-]+$). Used to reject path-traversal / injection before
 * interpolating objectId into a probe URL.
 */
export function isSafeObjectId(objectId: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(objectId);
}

/**
 * Parses the content of a Telar `index.md` file and returns the structured
 * landing page data.
 *
 * Extracts four optional frontmatter fields (`stories_heading`,
 * `stories_intro`, `objects_heading`, `objects_intro`) and the markdown body
 * (`welcome_body`). Returns an empty object if the content has no frontmatter
 * delimiters or is null/undefined.
 */
export function parseIndexMd(content: string | null | undefined): LandingData {
  if (!content) return {};
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return {};
  const frontmatter = (parseYaml(match[1]) as Record<string, unknown>) ?? {};
  // Recognise the canonical v1.3.0 welcome liquid block and store
  // welcome_body: undefined so the framework default keeps rendering on the
  // live site and the editor textarea stays empty (rather than showing the
  // liquid syntax as if it were user content).
  // Text the author wrote after the block is the welcome body; the block stays in the file.
  const rawBody = match[2].trim();
  const bodySplit = splitWelcomeLiquidBlock(rawBody);
  return {
    stories_heading: frontmatter.stories_heading as string | undefined,
    stories_intro: frontmatter.stories_intro as string | undefined,
    objects_heading: frontmatter.objects_heading as string | undefined,
    objects_intro: frontmatter.objects_intro as string | undefined,
    welcome_body: (bodySplit ? bodySplit.rest : rawBody) || undefined,
  };
}

// ---------------------------------------------------------------------------
// Frontmatter title reader
// ---------------------------------------------------------------------------

/** A `title:` key at the start of its line — YAML needs the space after the colon. */
const TITLE_KEY_LINE = /^title:(?=[ \t]|$)/;

/**
 * Reads `title` out of a YAML fragment under the failsafe schema.
 *
 * `parsed: false` means YAML refused the fragment. `title: null` means it
 * parsed but carries no title that is a single piece of text — the key is
 * absent, or its value is a sequence or a mapping, which have no one text to
 * return.
 */
function failsafeTitle(yamlText: string): { parsed: boolean; title: string | null } {
  let doc: unknown;
  try {
    doc = parseYamlFailsafe(yamlText);
  } catch {
    return { parsed: false, title: null };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { parsed: true, title: null };
  const record = doc as Record<string, unknown>;
  if (!Object.hasOwn(record, "title")) return { parsed: true, title: null };
  const value = record.title;
  return { parsed: true, title: typeof value === "string" ? value : null };
}

/**
 * The `title:` entry on its own: the key line plus every following line
 * indented under it, which is what a block scalar's content is.
 *
 * Used only when the whole block will not parse, so that one bad key
 * elsewhere does not cost the title its parse.
 */
function titleEntryOf(block: string): string | null {
  const lines = block.split(/\r?\n/);
  const start = lines.findIndex((line) => TITLE_KEY_LINE.test(line));
  if (start === -1) return null;
  const entry = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || /^[ \t]/.test(line)) entry.push(line);
    else break;
  }
  return entry.join("\n");
}

/**
 * Reads a markdown file's frontmatter title, and returns the body with it.
 *
 * Named apart from v130-ingest's `splitFrontmatter`, which hands back the
 * block text for a caller to parse; this one answers what the title is.
 *
 * The single reader for every file the Compositor imports, pages and layers
 * both. It existed twice, as two regexes that found the title line and then
 * stripped a pair of quotes off it, which returns the escape text and not the
 * value: a title written `"a \"q\" b"` came back carrying its backslashes,
 * and the next publish escaped those again, so the title grew a backslash on
 * every cycle. The framework had a third copy and has replaced it with a
 * parse.
 *
 * The read is in two stages, and the reason is that no single schema answers
 * both questions this function has to answer.
 *
 * Stage one parses the block with js-yaml's DEFAULT schema and `json: true`
 * (`parseYaml` in yaml.server.ts), which is how the rest of this codebase
 * reads YAML. That schema resolves everything YAML can resolve: an alias to
 * its anchor, a merge key into the mapping it merges, a standard tag like
 * `!!int` to its type. It answers whether the block HAS a title and what
 * that title IS. A string title is finished here, which is almost every
 * title, and a sequence or mapping title is finished here too — there is no
 * one piece of text to hand back, so the caller's fallback applies.
 *
 * Stage two runs only for a title the default schema resolved to a non-string
 * scalar: a number, a date, a boolean, null. For those the resolved value is
 * the wrong answer, because what has to be written back is the text the
 * author typed — `2024` and not the number, `~` and not null — and a resolved
 * value cannot be turned back into its source. So the block is read again
 * under the FAILSAFE schema, where the three node kinds are string, sequence
 * and mapping and there is nothing to resolve, while quoted scalars still
 * decode their escapes and block scalars still fold: YAML syntax survives a
 * schema change, YAML types do not.
 *
 * Failsafe cannot be stage one, because it resolves nothing: a merge key is an
 * ordinary key called `<<` there, so a title arriving through one is invisible
 * to it, and it cannot say whether a title IS a string. It can also still
 * refuse a block outright — a collection tag such as `!!omap`, or a key it
 * cannot parse. When it does, only the `title:` entry is read under failsafe,
 * which is enough to type its text.
 *
 * Reading the key by hunting its line with a regex answers neither question:
 * it disagreed with the parser about which of two duplicate keys won, and
 * could not see an alias or a merge at all.
 *
 * Outcomes, in order:
 *
 *   - the block parses and `title` is a string: that string.
 *   - it parses and `title` is a non-string scalar: its text, read again
 *     under failsafe — from the whole block, or from the title entry alone
 *     when something elsewhere defeats that read.
 *   - `title` is a sequence or a mapping, or is absent: null, and the
 *     caller's own fallback applies.
 *   - the block will not parse at all: the `title:` entry alone is parsed
 *     under failsafe, so one malformed key elsewhere does not cost the title
 *     its escape decoding or its block scalar. Only if that fragment will not
 *     parse either does the reader fall back to stripping a quote pair off
 *     the line.
 *   - there is no block at all: `hasBlock: false`, body unchanged.
 *
 * Only the title is read here; a page keeps its whole block through
 * `parsePageMarkdown`.
 */
export function readFrontmatterTitle(content: string): {
  hasBlock: boolean;
  title: string | null;
  body: string;
} {
  const match = content.match(FRONTMATTER_BLOCK);
  if (!match) return { hasBlock: false, title: null, body: content };
  const block = match[1];
  const body = match[2] ?? "";

  // Stage one: the resolving schema decides membership and value.
  let resolved: { present: boolean; value: unknown } | null = null;
  try {
    const doc = parseYaml(block);
    const isMapping = !!doc && typeof doc === "object" && !Array.isArray(doc);
    resolved = isMapping && Object.hasOwn(doc, "title")
      ? { present: true, value: (doc as Record<string, unknown>).title }
      : { present: false, value: undefined };
  } catch {
    resolved = null;
  }

  if (resolved) {
    if (!resolved.present) return { hasBlock: true, title: null, body };
    if (typeof resolved.value === "string") {
      return { hasBlock: true, title: resolved.value, body };
    }
    // A sequence or a mapping is not one piece of text. `null` is not one of
    // these: it is what `~` and an empty value resolve to, and both have text.
    if (resolved.value !== null && typeof resolved.value === "object") {
      return { hasBlock: true, title: null, body };
    }
    // Stage two: the typed text behind a resolved scalar.
    const typed = failsafeTitle(block);
    if (typed.parsed) return { hasBlock: true, title: typed.title, body };
    const taggedEntry = titleEntryOf(block);
    if (taggedEntry !== null) {
      const typedEntry = failsafeTitle(taggedEntry);
      if (typedEntry.parsed) return { hasBlock: true, title: typedEntry.title, body };
    }
    return { hasBlock: true, title: null, body };
  }

  const entry = titleEntryOf(block);
  if (entry === null) return { hasBlock: true, title: null, body };
  const fragment = failsafeTitle(entry);
  if (fragment.parsed) return { hasBlock: true, title: fragment.title, body };

  // Last resort: the entry itself is malformed, so there is nothing to parse.
  // Strip one surrounding quote pair, as every reader here once did, rather
  // than drop a title the author can see in their own file.
  const raw = entry.split(/\r?\n/)[0].replace(/^title:[ \t]*/, "").trim();
  return { hasBlock: true, title: raw.replace(/^["']|["']$/g, ""), body };
}

// ---------------------------------------------------------------------------
// Page markdown parser
// ---------------------------------------------------------------------------

/**
 * Parses the content of a page markdown file into its title, body and front
 * matter.
 *
 * Extracts the `title` frontmatter field and the markdown body. If no
 * frontmatter is present, the fallback slug is used as the title.
 * `frontmatter` is the whole block as the file has it, `""` when there is
 * none; the publish writes it back with only the title changed.
 *
 * The body loses only the blank lines above its first line of text and the
 * whitespace after its last: the first line's own indentation is content, as
 * a page opening with an indented code block has it, and a publish writes the
 * body back as stored.
 */
export function parsePageMarkdown(
  content: string,
  fallbackSlug: string,
): { title: string; body: string; frontmatter: string } {
  const { hasBlock, title, body } = readFrontmatterTitle(content);
  const frontmatter = capturedFrontmatter(content);
  const trimmed = pageBodyAsStored(body);
  if (!hasBlock) return { title: fallbackSlug, body: trimmed, frontmatter };
  return { title: title ?? fallbackSlug, body: trimmed, frontmatter };
}

/** A page file's body without the blank lines above its text or the whitespace after it. */
function pageBodyAsStored(body: string): string {
  return body.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd();
}

// ---------------------------------------------------------------------------
// Repo page scan
// ---------------------------------------------------------------------------

/** A page file as the scan reads it; `frontmatter` as `parsePageMarkdown` returns it. */
export interface ScannedPage {
  slug: string;
  title: string;
  body: string;
  frontmatter: string;
  order: number;
}

const PAGES_FOLDER = "telar-content/texts/pages/";

/**
 * Write the import's record of the page files it read: `commit` is the head
 * it read at, and `files` each page file the scan read (directly in the pages
 * folder, `scanRepoPages`), mapped to the id of the page inserted from it, and
 * each file the reduction to one file per page removed mapped to no page, so
 * the next publish deletes it.
 */
async function recordImportedPageFiles(
  db: ReturnType<typeof getDb>,
  projectId: number,
  head: string,
  pages: readonly ScannedPage[],
  removed: readonly string[],
): Promise<void> {
  const rows = await db
    .select({ id: project_pages.id, slug: project_pages.slug })
    .from(project_pages)
    .where(eq(project_pages.project_id, projectId));
  const ids = new Map(rows.map((row) => [row.slug, row.id]));
  const files: Record<string, number | null> = Object.fromEntries(removed.map((name) => [name, null]));
  for (const page of pages) {
    const id = ids.get(page.slug);
    if (id !== undefined) files[`${page.slug}.md`] = id;
  }
  await db
    .update(projects)
    .set({ page_files_json: serialisePageFilesRecord({ commit: head, files }) })
    .where(eq(projects.id, projectId));
}

/**
 * Scans a repository for `telar-content/texts/pages/*.md` files and returns
 * parsed page records. Only files directly in the folder are pages: the
 * framework builds `*.md` there and nothing below it (`generate_pages`). A
 * file in a subfolder taken under its bare name would be published at the
 * top level, as a page the site never had.
 *
 * Used by the initial repo import path AND by the Pages editor's empty-state
 * import variant, so projects connected
 * before the page-import path landed — or repos where pages were
 * added externally — can surface their existing pages for explicit import.
 *
 * The tree and every page are read at `head`, or at the head of `main`
 * resolved here when none is given, and each page strictly (`readAtHead`): a
 * page that cannot be read throws `SheetUnreadableError` rather than being
 * left out of what the caller imports. A page whose bytes are not valid
 * UTF-8 is named in `report.warnings` when a report is given.
 *
 * `order` matches the index in the filtered tree; an entry absent at the head
 * is skipped without re-indexing the rest, preserving the original order
 * semantics expected by the import path.
 */
export async function scanRepoPages(
  token: string,
  owner: string,
  repo: string,
  head?: string,
  report?: UnreadableReport,
): Promise<ScannedPage[]> {
  const at = head ?? (await getRepoHead(token, owner, repo, "main"));
  const { tree } = await getRepoTree(token, owner, repo, at);
  const pagesTree = tree.filter(
    (entry) =>
      entry.type === "blob" &&
      entry.path.startsWith(PAGES_FOLDER) &&
      !entry.path.slice(PAGES_FOLDER.length).includes("/") &&
      entry.path.endsWith(".md"),
  );
  const out: ScannedPage[] = [];
  for (let i = 0; i < pagesTree.length; i++) {
    const entry = pagesTree[i];
    const filename = entry.path.split("/").pop()!;
    const slug = filename.replace(/\.md$/, "");
    const content = await readAtHead(token, owner, repo, entry.path, at, report);
    if (content === null) continue;
    const { title, body, frontmatter } = parsePageMarkdown(content, slug);
    out.push({ slug, title, body, frontmatter, order: i });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Orphan story detection + .compositor-ignored
// ---------------------------------------------------------------------------

/**
 * Names of CSV files inside `telar-content/spreadsheets/` that are NOT
 * per-story files. The build skips both names of the project and objects
 * sheets whichever is read (`system_csvs` in scripts/telar/core.py). The
 * glossary is the one file the site reads as its glossary: `glossary.csv`,
 * else `glosario.csv`, so a `glosario.csv` beside a `glossary.csv` is a story
 * candidate. Anything else with a `.csv` extension is a story candidate.
 */
function registryFilenames(listing: readonly string[]): Set<string> {
  const glossary = listing.includes(GLOSSARY_SHEETS[0]) ? GLOSSARY_SHEETS[0] : GLOSSARY_SHEETS[1];
  return new Set<string>([...PROJECT_SHEETS, ...OBJECTS_SHEETS, glossary]);
}

/**
 * Parses the `.compositor-ignored` newline-delimited list of
 * story IDs that the user has explicitly told the compositor to suppress
 * (per the "Ignore" CTA in the orphan-stories banner).
 *
 * Rules:
 *  - Split on `\n` (CR-LF handled by stripping `\r` per-line via trim).
 *  - Trim each line; drop empty lines.
 *  - Drop lines starting with `#` (allows hand-edited notes in the file).
 *  - Dedupe (preserve first-seen order).
 *  - `contents === null` (missing file) → `[]` (graceful default, no throw).
 */
export function parseCompositorIgnored(contents: string | null): string[] {
  if (!contents) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (line.startsWith("#")) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

/**
 * Pure orphan-detection logic.
 *
 * Given:
 *  - the story IDs in `project.csv` (the published-stories registry),
 *  - a listing of file names inside `telar-content/spreadsheets/` on GitHub,
 *  - and the IDs the user has previously chosen to ignore,
 *
 * returns the candidate orphan story IDs — those for which a
 * `{story_id}.csv` file exists on GitHub but no corresponding row sits in
 * `project.csv` and no entry sits in `.compositor-ignored`.
 *
 * The function does NOT fetch orphan content; fetches are lazy
 * and happen only when the user clicks "Restore as drafts".
 */
export function detectOrphanStoryIds(opts: {
  projectCsvStoryIds: Set<string>;
  spreadsheetDirListing: string[];
  ignoredIds: Set<string>;
}): string[] {
  const { projectCsvStoryIds, spreadsheetDirListing, ignoredIds } = opts;
  const registry = registryFilenames(spreadsheetDirListing);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const filename of spreadsheetDirListing) {
    if (registry.has(filename)) continue;
    if (!filename.endsWith(".csv")) continue;
    const storyId = filename.slice(0, -".csv".length);
    if (storyId === "") continue;
    if (projectCsvStoryIds.has(storyId)) continue;
    if (ignoredIds.has(storyId)) continue;
    if (seen.has(storyId)) continue;
    seen.add(storyId);
    out.push(storyId);
  }
  return out;
}

/**
 * Combined I/O wrapper that fetches the repo tree,
 * filters to direct children of `telar-content/spreadsheets/`, reads
 * `.compositor-ignored` from the repo root (404 = empty list), and returns
 * the orphan story IDs. The published-stories set is supplied by the
 * caller (it knows the parsed `project.csv` row set).
 *
 * Exists as a single export so the importer call site stays a one-liner
 * and the integration is unit-testable against `vi.spyOn` of the two
 * `github.server.ts` helpers.
 *
 * NO content fetch of orphan files happens here — that is lazy until the
 * user clicks "Restore as drafts" in the orphan-stories banner.
 *
 * The listing and the ignore list are read at `head`, or at the head of
 * `main` resolved here when none is given (`pinnedSheetNames`, `readAtHead`),
 * and both strictly: a missing file is an empty list, and a failed read of it
 * throws `SheetUnreadableError`, since an empty list would let the restore
 * bring back a story the author chose to ignore.
 */
export async function scanRepoOrphanStoryIds(
  token: string,
  owner: string,
  repo: string,
  projectCsvStoryIds: Set<string>,
  head?: string,
): Promise<string[]> {
  const at = head ?? (await getRepoHead(token, owner, repo, "main"));
  const directChildren = await pinnedSheetNames(token, owner, repo, at);
  const ignoredIds = new Set(parseCompositorIgnored(await readAtHead(token, owner, repo, ".compositor-ignored", at)));
  return detectOrphanStoryIds({
    projectCsvStoryIds,
    spreadsheetDirListing: directChildren,
    ignoredIds,
  });
}

const SPREADSHEETS_DIR = "telar-content/spreadsheets";

/**
 * The files directly under telar-content/spreadsheets at `head`, from a
 * listing of that subtree alone, as the story check lists one: the whole
 * tree of an image-heavy repository can come back truncated, which would
 * read as stories missing. No directory there is no files. A listing that
 * cannot be trusted as complete throws, and the action answers as for any
 * other failure.
 */
async function pinnedSheetNames(token: string, owner: string, repo: string, head: string): Promise<string[]> {
  const oids = await getSubtreeOids(token, owner, repo, [head], [SPREADSHEETS_DIR]);
  if (!oids.ok) throw new Error(`${SPREADSHEETS_DIR} could not be listed: the head came back ${oids.reason}`);
  const at = oids.at(head, SPREADSHEETS_DIR);
  if (at.kind === "absent") return [];
  if (at.kind !== "tree") throw new Error(`${SPREADSHEETS_DIR} is not a directory at ${head}`);
  const listing = await listSubtreeEntries(token, owner, repo, at.oid);
  if (listing === null) throw new Error(`${SPREADSHEETS_DIR} could not be listed completely`);
  return [...listing.files.keys()].filter((path) => !path.includes("/"));
}

const OBJECTS_DIR = "telar-content/objects";

/**
 * The files directly under telar-content/objects at `head`, from a listing of
 * that subtree alone, as `pinnedSheetNames` lists the spreadsheets. No
 * directory there is no files. Null where the listing cannot be read or
 * trusted as complete, so that no object is settled on a partial answer.
 */
async function objectFilesAtHead(token: string, owner: string, repo: string, head: string): Promise<Set<string> | null> {
  try {
    const oids = await getSubtreeOids(token, owner, repo, [head], [OBJECTS_DIR]);
    if (!oids.ok) return null;
    const at = oids.at(head, OBJECTS_DIR);
    if (at.kind === "absent") return new Set();
    if (at.kind !== "tree") return null;
    const listing = await listSubtreeEntries(token, owner, repo, at.oid);
    if (listing === null) return null;
    return new Set([...listing.files.keys()].filter((path) => !path.includes("/")));
  } catch {
    return null;
  }
}

/**
 * Records a sheet warning for each group of rows the site reads as one
 * object: its object page and every step naming them show only the later;
 * and for each object_id written in more than one row.
 */
function reportSharedSiteIds(
  objectRows: ReadonlyArray<{ object_id?: string | null }>,
  telarVersion: string | null,
  report: SheetIssueHandler,
): void {
  const ids = objectRows.map((row) => ({ object_id: row.object_id ?? "" }));
  for (const issue of sharedSiteIdIssues(ids, telarVersion)) report(issue);
  for (const issue of repeatedIdIssues(ids, telarVersion)) report(issue);
}

/**
 * `objectRows` with each object_id's last row only, where that row stands. The
 * site uses the last row an id is written in and the sync (`githubSheet`)
 * keeps only that one, so an import storing the others would give D1 a second
 * object the next publish re-keys. Ids are compared as the mapper stores them,
 * as `repeatedIdIssues` compares them.
 */
function lastRowPerObjectId<T extends { object_id?: string | null }>(objectRows: readonly T[]): T[] {
  const lastAt = new Map(objectRows.map((row, i) => [row.object_id ?? "", i]));
  return objectRows.filter((row, i) => lastAt.get(row.object_id ?? "") === i);
}

/**
 * What a self-hosted object's file in telar-content/objects says the build
 * will make of it, by the framework's own rules, or null where no file there
 * is one the framework would find. Only a file directly in the folder whose
 * name is the object's site id (`siteObjectId`: the id with one image
 * extension stripped, as the build strips it before it looks) exactly,
 * followed by a known extension spelled all lowercase or all uppercase, is
 * found: the tiler (`find_image_for_object`) and the media detector
 * (`detect_media_type`) try each extension in those two spellings and nothing
 * else. An audio file is looked for first, in `AUDIO_EXTENSIONS` order,
 * lowercase before uppercase, since the framework classifies an object with
 * both files as audio; the filename is returned as the folder spells it. An
 * image counts only with an extension the site's tiler searches
 * (`tileableExtensions`) and a site id the tiler accepts.
 */
function mediaFromObjectFiles(
  objectId: string,
  files: ReadonlySet<string>,
  frameworkVersion: string | null,
): { type: "audio"; filename: string } | { type: "iiif" } | null {
  const siteId = siteObjectId(objectId, frameworkVersion);
  const audio = [...AUDIO_EXTENSIONS];
  for (const ext of [...audio, ...audio.map((e) => e.toUpperCase())]) {
    const filename = `${siteId}.${ext}`;
    if (files.has(filename)) return { type: "audio", filename };
  }
  if (!isTilerObjectId(siteId)) return null;
  for (const ext of tileableExtensions(frameworkVersion)) {
    if (files.has(`${siteId}${ext}`) || files.has(`${siteId}${ext.toUpperCase()}`)) return { type: "iiif" };
  }
  return null;
}

/**
 * The self-hosted objects the files in telar-content/objects settle, as tiled
 * or as audio (with the filename), and the ids they leave for the live-site
 * probe. The listing is not read when there is no such object. A listing that
 * cannot be read settles none, and the import goes on: every object is left to
 * the probe, as it would be with no listing at all.
 */
async function objectMediaFromRepo(
  token: string,
  owner: string,
  repo: string,
  head: string,
  objectIds: string[],
  frameworkVersion: string | null,
): Promise<{ iiif: string[]; audio: Map<string, string>; unsettled: string[] }> {
  const settled = { iiif: [] as string[], audio: new Map<string, string>(), unsettled: [] as string[] };
  if (objectIds.length === 0) return settled;
  const files = await objectFilesAtHead(token, owner, repo, head);
  if (files === null) {
    console.warn(`[import] ${OBJECTS_DIR} could not be listed completely: probing the live site for every object`);
    return { ...settled, unsettled: [...objectIds] };
  }
  for (const objectId of objectIds) {
    const media = mediaFromObjectFiles(objectId, files, frameworkVersion);
    if (media === null) settled.unsettled.push(objectId);
    else if (media.type === "audio") settled.audio.set(objectId, media.filename);
    else settled.iiif.push(objectId);
  }
  return settled;
}

/**
 * A file at `head`, read strictly, as the import and its scans read every
 * file: its text with any leading byte-order mark removed, or null where the
 * file is absent (a 404). Any other answer throws `SheetUnreadableError`
 * naming the file, so a read that failed is never taken for a missing file.
 *
 * A file whose bytes are not valid UTF-8 is read as the text a non-fatal
 * decode gives, and named in `report.warnings` when a report is given.
 * `onRaw` receives the text before the mark is removed.
 */
async function readAtHead(
  token: string,
  owner: string,
  repo: string,
  path: string,
  head: string,
  report?: UnreadableReport,
  onRaw?: (raw: string) => void,
): Promise<string | null> {
  const read = await getFileAtRef(token, owner, repo, path, head, { strict: true });
  if (read.status === "error") throw new SheetUnreadableError(path);
  if (read.status === "absent") return null;
  if (read.lossy) pushUnreadable(report?.warnings, path, report?.repair);
  onRaw?.(read.content);
  return read.content.replace(/^\uFEFF/, "");
}

/** The paths a story's steps CSV is looked for at, in the order the import reads them. */
function storyCsvPaths(storyId: string): string[] {
  return [`telar-content/spreadsheets/${storyId}.csv`, `_data/${storyId}.csv`, `${storyId}.csv`];
}

/**
 * A story's steps CSV at `head` (`readAtHead`), from the first of
 * `storyCsvPaths` that has one, with the path it was read from; both null
 * when none does. A file absent at one path is looked for at the next; a
 * failed read throws.
 */
async function readStoryCsvAtHead(
  token: string,
  owner: string,
  repo: string,
  storyId: string,
  head: string,
  report?: UnreadableReport,
): Promise<{ path: string | null; content: string | null; raw: string | null }> {
  for (const path of storyCsvPaths(storyId)) {
    let raw: string | null = null;
    const content = await readAtHead(token, owner, repo, path, head, report, (text) => { raw = text; });
    if (content !== null) return { path, content, raw };
  }
  return { path: null, content: null, raw: null };
}

/** Where a reader names a file read lossily, and the repair the warning names. */
export interface UnreadableReport {
  warnings: SheetWarning[];
  repair?: UnreadableRepair;
}

/**
 * The commit the first import reads at: the head of the repository's default
 * branch, which must be `main`, since every write the Compositor makes goes to
 * `main`. A repository with no default branch is an empty one; a default
 * branch of any other name is refused, naming it, whether or not a `main`
 * branch also exists, since a `main` the site is not built from is not the
 * site. The refusal says what `main` is (`mainBranchState`), so the author is
 * offered the change that fits. Either answer comes back as the import's
 * result, before any file of the default branch is read. A failure to resolve
 * the default branch throws.
 */
async function importHead(token: string, owner: string, repo: string): Promise<string | ImportResult> {
  const branch = await getDefaultBranchHead(token, owner, repo);
  if (branch === null) return refusedImportResult({ validationError: "empty_repo" });
  if (branch.name !== "main") return defaultBranchRefusal(branch.name, await mainBranchState(token, owner, repo));
  return branch.oid;
}

/**
 * What the repository's `main` branch is, asked for by its full name, since a
 * tag named `main` answers the short one. It holds a Telar site when a
 * `_config.yml` at its root, read strictly at its head, carries
 * `telar.version`: the test the import itself refuses `not_telar` by. A lookup
 * or read that fails is "unreadable", never a guess either way.
 */
export async function mainBranchState(
  token: string,
  owner: string,
  repo: string,
): Promise<MainBranch | "unreadable"> {
  let head: string;
  try {
    head = await getRepoHead(token, owner, repo, "refs/heads/main");
  } catch (err) {
    return err instanceof NoSuchBranchError ? "absent" : "unreadable";
  }
  const read = await getFileAtRef(token, owner, repo, "_config.yml", head, { strict: true });
  if (read.status === "error") return "unreadable";
  if (read.status === "absent") return "not_site";
  // A config that does not parse is no site the import could read.
  try {
    return telarVersionOf(parseYaml(read.content.replace(/^\uFEFF/, ""))) ? "site" : "not_site";
  } catch {
    return "not_site";
  }
}

/** The refusal for a default branch other than `main`, given what `main` is. */
export function defaultBranchRefusal(defaultBranch: string, main: MainBranch | "unreadable"): ImportResult {
  if (main === "unreadable") return refusedImportResult({ validationError: "main_unreadable", defaultBranch });
  return refusedImportResult({ validationError: "no_main_branch", defaultBranch, mainBranch: main });
}


// ---------------------------------------------------------------------------
// D1 batch insert helper
// ---------------------------------------------------------------------------

/**
 * D1 limits bound parameters to 100 per statement. This helper chunks
 * an array of rows into batches that fit within that limit, based on the
 * number of columns each row produces.
 *
 * @param colCount - number of columns in the insert (bound params per row)
 * @param rows - array of row values to insert
 * @returns array of row-arrays, each safe for a single D1 insert
 */
/**
 * What made an imported story, and by extension its steps and layers.
 *
 * No person here did. The importing user is known — they become the project's
 * convenor in the same step — and is deliberately not written as the author:
 * crediting them for a repo's CSVs, and for whatever anyone later writes into
 * those rows, carries an air of authority the import cannot support. So
 * `created_by` stays null throughout an import and this column says where the
 * content came from instead.
 *
 * The starter story the Telar template ships is separated from the repo's own
 * content because it genuinely has a different origin, and because it is where
 * a new user does their first work: 78 of the 79 unattributed seeded steps in
 * the database hold text somebody wrote.
 */
export function actorForImportedStory(row: { story_id?: unknown; title?: unknown }): AuthorActor {
  return isTemplateStory(row) ? AUTHOR_ACTORS.telarTemplate : AUTHOR_ACTORS.imported;
}

/** The same reading for an object: the template ships exactly one. */
export function actorForImportedObject(row: { object_id?: unknown; title?: unknown }): AuthorActor {
  return isTemplateObject(row) ? AUTHOR_ACTORS.telarTemplate : AUTHOR_ACTORS.imported;
}

/**
 * And for a step, which needs its parent story as well as its own cells: a
 * placeholder question sitting under a story somebody wrote is not the
 * template's, whatever it says.
 */
export function actorForImportedStep(
  row: { object_id?: unknown; question?: unknown; answer?: unknown },
  parentIsTemplate: boolean,
): AuthorActor {
  return parentIsTemplate && isTemplateStep(row)
    ? AUTHOR_ACTORS.telarTemplate
    : AUTHOR_ACTORS.imported;
}

/** The seeded glossary term, in any of the forms the template has shipped. */
export function actorForImportedTerm(row: { term_id?: unknown; definition?: unknown }): AuthorActor {
  return isTemplateTerm(row) ? AUTHOR_ACTORS.telarTemplate : AUTHOR_ACTORS.imported;
}

/** An about page, recognised by its body rather than its slug. */
export async function actorForImportedPage(
  row: { slug?: unknown; body?: unknown },
): Promise<AuthorActor> {
  return (await isTemplatePage(row)) ? AUTHOR_ACTORS.telarTemplate : AUTHOR_ACTORS.imported;
}

/**
 * One theme file in _data/themes, named `filename` without its extension, as
 * the project_themes insert shape. `project_id` is set once the project row
 * exists.
 */
export function mapThemeYaml(
  filename: string,
  parsed: Record<string, unknown>,
): typeof project_themes.$inferInsert {
  const colors = parsed.colors as Record<string, Record<string, string>> | undefined;
  return {
    project_id: 0,
    theme_id: filename,
    name: (parsed.name as string) || filename,
    description: (parsed.description as string) || undefined,
    creator: (parsed.creator as string) || undefined,
    creator_url: (parsed.creator_url as string) || undefined,
    swatch_color: colors?.text?.heading || undefined,
  };
}

/**
 * Bound parameters per row that each import insert is chunked by: the batch is
 * `Math.floor(100 / divisor)` rows, so a divisor at or above a table's real
 * per-row bind count keeps every statement inside D1's 100-parameter limit.
 * `tests/import-d1-bind-budget.test.ts` measures each table's mapped rows
 * against this table and fails when a divisor stops bounding one.
 */
export const D1_BIND_DIVISORS = {
  themes: 8,
  objects: 22,
  stories: 12,
  glossary: 9,
  pages: 10,
  steps: 18,
  layers: 8,
} as const;

function chunkForD1<T>(colCount: number, rows: T[]): T[][] {
  const maxRows = Math.floor(100 / colCount);
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += maxRows) {
    chunks.push(rows.slice(i, i + maxRows));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// CSV parsing helpers
// ---------------------------------------------------------------------------

/**
 * A row as a reader finds it in the spreadsheet: by its first non-empty cell
 * where it has one, by its position in the file otherwise.
 *
 * Shared by every warning this module raises about one row — a ragged row and
 * a dropped bilingual header row — so a reader sees the same naming convention
 * whichever warning they are reading.
 *
 * The bilingual header row is only ever the first record that is not a
 * comment (see `createCsvRecordSkipDetector`), so its warning can only be
 * about that row, never a data row further down that scores the same way.
 */
function sheetRow(row: Record<string, string>, index: number): SheetRow {
  // Cells arrive as written, so the name is trimmed here: a warning quoting a
  // cell's surrounding whitespace back at the reader names nothing they can
  // find in the spreadsheet.
  const first = Object.values(row)
    .map((v) => (typeof v === "string" ? v.trim() : v))
    .find((v) => typeof v === "string" && v !== "");
  return first ? { label: first } : { position: index + 1 };
}

/**
 * Returns true if 80%+ of the row's non-empty values match known bilingual
 * column names (Spanish translations of the English CSV headers).
 *
 * Mirrors the `is_header_row()` logic in Telar's csv_utils.py.
 *
 * `isProjectCsv` picks which known-value set applies: pass true only for
 * project.csv or the project sheet tab, so a PROJECT_ONLY_ALIASES spelling
 * (privada, privado, protegida, protegido, protected) counts as a header
 * token there but not when parsing any other Telar CSV — the same scoping
 * COLUMN_NAME_MAPPING's rename gets. `protected` also reaches this set
 * unconditionally through FRAMEWORK_HEADER_TOKENS, which this scoping does
 * not touch: a row of three or more cells where the rest also match known
 * tokens can still be misread as a header row outside project mode (see
 * the note on FRAMEWORK_HEADER_TOKENS). A row of fewer than three populated
 * cells cannot reach this set at all — see the floor below.
 *
 * `sheetAliases` are the names only this sheet reads (`GLOSSARY_COLUMN_ALIASES`
 * for the glossary), counted as header words here as the framework's
 * `is_header_row` counts its `sheet_aliases`.
 */
export function isHeaderRow(
  row: Record<string, string>,
  isProjectCsv = false,
  sheetAliases?: Readonly<Record<string, string>>,
): boolean {
  // A row may reach here carrying a value the parser did not produce as a
  // string, so anything that is not one counts as no value at all rather than
  // as a cell to compare.
  //
  // Populated and matching are decided under ONE strip, the fold every other
  // question about a header in this module is settled with. Counted with
  // JavaScript's `trim()` and matched with CPython's, a cell holding nothing
  // but U+001C-U+001F or U+0085 is a cell to the count and empty to the match:
  // a bilingual row of three names padded with one scores 3/4, falls under the
  // threshold, and is imported as a term whose id is `id_término`. The
  // framework's own `is_header_row` skips a cell that strips to nothing
  // (scripts/telar/csv_utils.py), so one fold puts the two in step.
  const values = Object.values(row).filter((v) => typeof v === "string" && foldHeader(v) !== "");
  // Matches the framework's is_header_row floor: a row needs at least three
  // populated cells before a match ratio means anything. Below three, a
  // two-cell row where both cells happen to be known words — an object_id of
  // "source" and a title of "Protected", say — would score 100% and be
  // read as a header, deleting the row it names. The floor's trade: a
  // genuine two-column bilingual row (e.g. object_id,title over
  // id_objeto,titulo) never reaches three populated cells either, so it is
  // read as data rather than as the header it is. The framework accepts the
  // same trade, so a sheet read on both sides is read the same way on both.
  if (values.length < 3) return false;
  const isKnown = knownHeaderWord(isProjectCsv, sheetAliases);
  const matches = values.filter((v) => isKnown(foldHeader(v)));
  return matches.length / values.length >= 0.8;
}

/** Whether a folded cell is a header word on a sheet read with these settings. */
function knownHeaderWord(
  isProjectCsv: boolean,
  sheetAliases?: Readonly<Record<string, string>>,
): (folded: string) => boolean {
  const knownValues = isProjectCsv ? KNOWN_BILINGUAL_VALUES : KNOWN_BILINGUAL_VALUES_NON_PROJECT;
  if (!sheetAliases) return (folded) => knownValues.has(folded);
  const aliasWords = new Set([...Object.keys(sheetAliases), ...Object.values(sheetAliases)]);
  return (folded) => knownValues.has(folded) || aliasWords.has(folded);
}

/**
 * True when every populated cell of `row` is a known bilingual token, under
 * the fold and the known-value set `isHeaderRow` uses: the second header row
 * the Compositor's publish and the framework's template write. A row
 * `isHeaderRow` skips that is not wholly tokens reached the 80% threshold with
 * a cell that may be content, and only that row is worth a warning.
 */
function isWhollyHeaderTokens(
  row: Record<string, string>,
  isProjectCsv: boolean,
  sheetAliases?: Readonly<Record<string, string>>,
): boolean {
  const isKnown = knownHeaderWord(isProjectCsv, sheetAliases);
  return Object.values(row)
    .filter((v) => typeof v === "string" && foldHeader(v) !== "")
    .every((v) => isKnown(foldHeader(v)));
}

/**
 * True for a row the framework drops as a comment: one whose FIRST cell,
 * CPython-stripped, opens with `#`.
 *
 * The first cell alone, because that is the cell `telar.core.csv_to_json`
 * tests — `df[~df[first_col].astype(str).str.strip().str.startswith('#')]`,
 * scripts/telar/core.py:94 on the test instance and :90 at the published tag.
 * A `#` in any later cell is ordinary content there: a title of
 * `#1 in the series` is data, and so is the row it sits in. Dropped here
 * instead, that object never appears in the Compositor while the serializer
 * writes its record back verbatim above the data on every publish, so the site
 * builds an object no author can reach.
 *
 * The row is keyed by POSITION (`positionalRow`), so the first value is the
 * record's first cell. Only a string can open with `#`; a value of any other
 * type is not a comment marker and must not be asked to strip itself.
 */
export function isCommentRow(row: Record<string, string>): boolean {
  const first = Object.values(row)[0];
  return typeof first === "string" && isCommentCell(first);
}

/**
 * Strips NUL bytes out of a header cell before anything treats it as a name.
 * A header cell can carry a NUL byte regardless of what an author's
 * spreadsheet software would ordinarily produce, and a raw NUL surviving
 * into a returned row's own key would be a landmine for every consumer
 * downstream: JSON-encoding `extra_columns`, a D1 insert, a warning message
 * naming the row. Removed here, unconditionally, before any header text is
 * compared, mapped, or kept.
 */
const NUL_CHARACTER = String.fromCharCode(0);

function sanitizeHeaderCell(raw: string): string {
  return raw.split(NUL_CHARACTER).join("");
}

/**
 * A row's cell values, keyed only by their own position ("0", "1", ...) —
 * never by a canonical or reserved name. `isHeaderRow`/`isCommentRow` read
 * values only, never key names, so this is enough to run the same
 * bilingual/comment-row detection every row gets, including a protection
 * column's own literal cell (the Spanish bilingual second row's
 * `protegido`, say) before that column is resolved into the single
 * `private` verdict `parseTelarCsv` returns.
 *
 * Cells come through as written. Classification is the one question in this
 * module that must be settled on the raw text, because the framework settles
 * it on the raw text: pandas hands `is_header_row` the cell pandas read, and
 * CPython's strip leaves U+FEFF where JavaScript's `trim()` removes it. A
 * bilingual row padded with a cell holding nothing but the mark is a populated
 * cell that matches nothing — 3 of 4, under the 0.8 threshold, and a term —
 * and trimmed first it is 3 of 3, a header row, and a sheet that imports
 * nothing at all. `buildRowByPosition` trims what it stores, which is a
 * separate question with a separate answer.
 *
 * Exported so a caller holding the cells of the same parse —
 * `extractCommentRows`, csv-export.server.ts, deciding which records a
 * republish carries through — asks `isCommentRow` the question in the shape
 * the importer asks it in.
 */
export function positionalRow(cells: string[]): Record<string, string> {
  const record: Record<string, string> = {};
  cells.forEach((cell, i) => { record[String(i)] = cell ?? ""; });
  return record;
}

/**
 * Builds the classifier `parseTelarCsv` and the record scanner
 * (`removeObjectRecord`, csv-record-scan.server.ts) share, one built per
 * parse of one file, and call once per record in file order.
 *
 * The two are one question — did this record become an object? — asked by
 * two callers, and two implementations of it can answer differently: on
 * three known names padded with a cell holding nothing but U+FEFF, a
 * classifier folding the cells with JavaScript's `trim()` scores 3 of 3 and
 * calls the record the label row, while one folding them another way scores
 * 3 of 4 and calls it data. A record one path imports and the other skips is
 * an object whose deletion reports its record absent and commits its images
 * away while the record stays. Sharing one implementation closes that gap;
 * this closes a second one the sharing alone did not: a positional rule only
 * one caller remembered to apply would be the same divergence in a new
 * shape.
 *
 * A comment record is skipped wherever it sits in the file, exactly as
 * `isCommentRow` always has it. The header test is applied to the FIRST
 * record that is not a comment, and to no other, whatever its answer — the
 * two steps `telar.core.csv_to_json` runs in sequence (comment rows filtered
 * first, then only `df.iloc[0]` tested; scripts/telar/core.py:92-108),
 * folded into one pass here because a streamed record scan has no second
 * pass to make. A glossary of cataloguing terms scores high against the same
 * token set a genuine bilingual row does (title, source, creator, year,
 * description, period, location, object, question, answer, step, page are
 * all ordinary vocabulary for a glossary about documents), so testing every
 * record reads a later DATA row built from enough of them as a second header
 * row and silently drops it. The one row still able to reach that verdict is
 * the position a bilingual row can actually occupy — first data row of the
 * file, or first after any leading comments — so testing only that position
 * keeps the true positive and loses the false one.
 *
 * Where the state lives is the fix: "has the one header test been spent yet"
 * is tracked inside this closure, not by either caller, so a caller cannot
 * forget to track it or apply it at the wrong position. `isHeaderRow` and
 * `isCommentRow` stay exported as the stateless primitives this classifier
 * is built from, for anything that needs to ask one of those two questions
 * on its own; nothing in this module classifies a whole file's records with
 * anything else.
 *
 * The verdict names WHY a record was dropped, `undefined` when it was not,
 * because a caller with a warning channel — `parseTelarCsv` — has to tell a
 * comment row from the one header row it may drop: the framework says
 * nothing about a comment it filters, only about the header row it skips
 * (`core.py`'s own `[WARN] Detected duplicate header row`), and a caller
 * without a channel — the record scanner — can still just test `.skip`.
 */
export type CsvRecordSkipReason = "comment" | "bilingual-header" | "blank";

/** One record's verdict from a detector `createCsvRecordSkipDetector` built. */
export interface CsvRecordSkipVerdict {
  skip: boolean;
  reason?: CsvRecordSkipReason;
}

/**
 * The two characters pandas' `read_csv` treats a DELIMITER-FREE line as
 * blank for, confirmed by reading `case1`-`case9` and the vtab/ff/mixed/cr
 * probes in the framework's own venv against `scripts/telar/core.py`: a
 * line with no comma in it — Papa's `cells.length === 1` — is dropped by
 * `skip_blank_lines` (the pandas default `csv_to_json` reads every CSV
 * under, core.py:93) before it becomes a DataFrame row at all when its one
 * field holds nothing but U+0020 and U+0009, empty string included. A lone
 * vertical tab or form feed does NOT qualify — pandas keeps those as a real
 * (mostly blank) row — so this is its own narrow set, not `str.isspace()`:
 * confusing the two would also drop a row the framework keeps.
 *
 * This is unrelated to `PYTHON_WHITESPACE`/`pythonStrip`, which answer what
 * CPython's `str.strip()` removes from a cell's TEXT once a row already
 * exists. This answers an earlier question — whether pandas ever turns the
 * line into a row — and the two sets disagree on purpose: U+00A0 and
 * U+0085 strip to nothing under `pythonStrip` but do not make pandas treat
 * a delimiter-free line as blank (probed directly: a lone NBSP or NEL line
 * survives as its own row and spends the header test like any other),
 * confirmed both ways so intuition never stood in for the framework's
 * answer.
 *
 * A line that DOES carry a delimiter is never blank to pandas, whatever
 * its cells hold — `,,` and `"   ","   ","   "` both survive as ordinary
 * (if empty-looking) rows and are left to `isHeaderRow`'s own populated-cell
 * floor, the same as the framework's `df.iloc[0]` does. Widening this past
 * one cell would silently drop rows the framework keeps.
 */
const PANDAS_BLANK_LINE_WHITESPACE: ReadonlySet<string> = new Set([" ", "	"]);

/**
 * True for a Papa record pandas' `read_csv` never turns into a DataFrame
 * row — see `PANDAS_BLANK_LINE_WHITESPACE`. `TELAR_CSV_PARSE_CONFIG`'s
 * `skipEmptyLines: true` already keeps this function from ever seeing a
 * truly empty line (one EMPTY field); what reaches here is the case Papa's
 * own option does not cover, a delimiter-free line that LOOKS empty but
 * carries space or tab characters.
 */
function isPandasBlankLine(cells: string[]): boolean {
  if (cells.length !== 1) return false;
  const cell = cells[0];
  if (typeof cell !== "string") return false;
  for (const ch of cell) {
    if (!PANDAS_BLANK_LINE_WHITESPACE.has(ch)) return false;
  }
  return true;
}

/**
 * The cells of a record the bilingual-header test weighs: those within the
 * header's width, less the cells under a column whose header, as written,
 * starts with `#`. The framework drops such columns before it asks whether
 * row 2 is the bilingual header (scripts/telar/core.py). pandas does not strip
 * a header, so ` #notes` is not one of them there and is not one here.
 */
function headerTestCells(cells: string[], headerWidth: number, instructionHeader: readonly string[]): string[] {
  return cells.slice(0, headerWidth).map((cell, index) => {
    const header = instructionHeader[index];
    return typeof header === "string" && header.startsWith("#") ? "" : cell;
  });
}

/**
 * The header whose `#` columns the bilingual-header test leaves out: the
 * table's own, unless its first record after the header is wider. pandas then
 * reads that record's leading fields as an index and shifts every column
 * against the header, before it filters comments, so its `#` column holds no
 * cell this could name. Such a file is weighed whole, as before.
 */
export function instructionHeaderOf(table: readonly string[][]): readonly string[] {
  const header = table[0] ?? [];
  const first = table.slice(1).find((cells) => !isPandasBlankLine(cells));
  return first !== undefined && first.length > header.length ? [] : header;
}

/**
 * `instructionHeader` is the header `instructionHeaderOf` gives, or none.
 * `sheetAliases` are the names only this sheet reads (see `isHeaderRow`).
 */
export function createCsvRecordSkipDetector(
  isProjectCsv = false,
  instructionHeader: readonly string[] = [],
  sheetAliases?: Readonly<Record<string, string>>,
) {
  let headerTestAvailable = true;
  /**
   * `cells` are one record's cells AS WRITTEN — see `positionalRow`. Cells
   * past `headerWidth` are dropped first: the header declares how wide a row
   * is, and a surplus cell belongs to no column for either test to weigh.
   *
   * `isPandasBlankLine` is checked against the FULL `cells`, ahead of that
   * slice and ahead of everything else: a line pandas never turns into a row
   * spends no test at all, comment or bilingual, and leaves the one header
   * test untouched for whichever record actually follows it.
   */
  return function isSkippedCsvRecord(cells: string[], headerWidth: number): CsvRecordSkipVerdict {
    if (isPandasBlankLine(cells)) return { skip: true, reason: "blank" };
    const detectionRow = positionalRow(cells.slice(0, headerWidth));
    if (isCommentRow(detectionRow)) return { skip: true, reason: "comment" };
    if (!headerTestAvailable) return { skip: false };
    headerTestAvailable = false;
    return isHeaderRow(positionalRow(headerTestCells(cells, headerWidth, instructionHeader)), isProjectCsv, sheetAliases)
      ? { skip: true, reason: "bilingual-header" }
      : { skip: false };
  };
}

/**
 * What one header row's positions mean, decided once per parse and then
 * carried by index into every data row.
 */
interface HeaderPositions {
  /** Every column index this parse's mapping resolves to `private`. */
  privateColumnIndexes: Set<number>;
  /** The one protection column whose value decides `private`, chosen from
   * `privateColumnIndexes` by `chooseProtectionColumn`; undefined when the
   * sheet has none. */
  protectionColumnIndex: number | undefined;
  /** Every column index dropped because another column keeps the canonical
   * name it claims — see `assignUniqueColumnNames`. */
  droppedColumnIndexes: Set<number>;
  /** Every column index dropped for carrying no heading at all — a subset of
   * `droppedColumnIndexes`, kept apart so the parse can say which rows lost a
   * value to one. */
  blankHeaderIndexes: Set<number>;
  /** Every OTHER column's final, unique key by the same index; undefined at
   * a protection index, which has no name of its own, and at a dropped one. */
  finalNames: (string | undefined)[];
  /** The name each position's header declares before names are made unique:
   * its canonical name where the scope folds one, else its own text. A
   * position whose final name differs from this one was renamed. */
  declaredNames: (string | undefined)[];
}

/**
 * The canonical names one kind of sheet models, derived from the field
 * registry's own import declarations rather than listed here.
 *
 * The framework scopes its rename table the same way (`canonical_fields` in
 * scripts/telar/csv_utils.py, passed as OBJECT_FIELDS for objects.csv): a
 * header that means something on one sheet is an author's own column on
 * another. `step` and `paso` on an objects sheet are two custom columns there,
 * and the framework leaves both; folding them together because the story
 * tables happen to share a name would lose one.
 */
function canonicalScopeFor(entities: readonly string[]): ReadonlySet<string> {
  const scope = new Set<string>();
  for (const decl of FIELD_REGISTRY) {
    if (!entities.includes(decl.entity)) continue;
    for (const field of decl.fields) {
      if (isExcluded(field.import)) continue;
      for (const header of field.import.headers) {
        const target = COLUMN_NAME_MAPPING[foldHeader(header)];
        if (target) scope.add(target);
      }
    }
  }
  return scope;
}

/**
 * objects.csv. Unioned with the keys the objects mapper actually consumes, so
 * a name it reads without the registry declaring a header for it — the
 * `iiif_manifest` fallback — is still one column, not two.
 */
export const OBJECTS_CANONICAL_SCOPE: ReadonlySet<string> = new Set([
  ...canonicalScopeFor(["objects"]),
  ...KNOWN_OBJECT_KEYS,
]);

/** project.csv — the stories table's own columns. */
export const PROJECT_CANONICAL_SCOPE: ReadonlySet<string> = canonicalScopeFor(["stories"]);

/** A story's steps CSV, whose rows carry both step and layer columns. */
export const STORY_CANONICAL_SCOPE: ReadonlySet<string> = canonicalScopeFor(["steps", "layers"]);

/**
 * glossary.csv, with the names its own aliases rename onto (`kind`), which the
 * Compositor keeps among the extra columns rather than as a field of its own.
 */
export const GLOSSARY_CANONICAL_SCOPE: ReadonlySet<string> = new Set([
  ...canonicalScopeFor(["glossary"]),
  ...Object.values(GLOSSARY_COLUMN_ALIASES),
]);

/**
 * The names only the sheet read under `canonicalScope` reads, on top of
 * COLUMN_NAME_MAPPING: the glossary's aliases for the glossary scope, none for
 * any other. Keyed by the scope because every reading of a glossary, the
 * import, the sync and the publish layout alike, parses it under that scope.
 */
function sheetAliasesFor(canonicalScope?: ReadonlySet<string>): Readonly<Record<string, string>> | undefined {
  return canonicalScope === GLOSSARY_CANONICAL_SCOPE ? GLOSSARY_COLUMN_ALIASES : undefined;
}

/**
 * A Google-Sheets tab name (lowercased) to the scope its sheet is read under.
 * A tab that is none of these is a candidate story tab, read under the story
 * scope in the second pass.
 */
const SHEET_TAB_CANONICAL_SCOPES: Record<string, ReadonlySet<string> | undefined> = {
  objects: OBJECTS_CANONICAL_SCOPE,
  project: PROJECT_CANONICAL_SCOPE,
  glossary: GLOSSARY_CANONICAL_SCOPE,
};
Object.setPrototypeOf(SHEET_TAB_CANONICAL_SCOPES, null);

/**
 * What a parse does when two or more columns claim one canonical name and each
 * holds values: refuse the sheet, or keep the last of them and warn.
 */
export type SeveralHoldValues = "refuse" | "keep-last";

export interface ParseTelarCsvOptions {
  /** Defaults to "keep-last". */
  severalHoldValues?: SeveralHoldValues;
  /**
   * Under "keep-last", which of several colliding columns that hold values
   * keeps the name, as its place among that name's claimants in file order;
   * a name with fewer claimants keeps its last. Defaults to the last.
   */
  keepClaimant?: number;
  /** The sheet as the author knows it (`objects.csv`, a Google Sheets tab),
   * for a refusal to name. */
  sheetName?: string;
  /**
   * The text is a Google Sheets tab, which the build fetches itself and no
   * publish writes: a misread heading is reported as one to change in the tab.
   */
  fromGoogleSheets?: boolean;
}

/**
 * A sheet refused because two or more of its columns claim one canonical name
 * and each holds values. Carries the sheet's name, the canonical name, and the
 * headers of the columns holding values as the author typed them.
 */
export class CollidingColumnsRefusal extends Error {
  /** The published Google Sheet the refused tab was read from; unset for a repository file. */
  publishedSheetsUrl?: string;

  constructor(
    readonly sheet: string,
    readonly canonicalName: string,
    readonly headers: string[],
  ) {
    super(
      `${sheet}: more than one column for "${canonicalName}" holds values: ` +
        headers.map((h) => `"${h}"`).join(", "),
    );
    this.name = "CollidingColumnsRefusal";
  }
}

/**
 * A Google Sheets tab the import fetched with bytes other than those the
 * author chose columns against: the choices are not applied, and the author
 * is asked again. Carries the published Sheet it was read from.
 */
export class TabsChangedError extends Error {
  publishedSheetsUrl?: string;

  constructor(readonly tab: string) {
    super(`the tab "${tab}" changed after its columns were chosen`);
    this.name = "TabsChangedError";
  }
}

/**
 * Assigns every non-protection column a key unique across the whole row,
 * by one of two rules depending on whose name is being shared.
 *
 * A name an author invented (two columns both headed `notes`) is kept under
 * a suffix: the first column to declare it keeps it unsuffixed, a later one
 * becomes `name_N`, incrementing N until the candidate matches neither a
 * name some column in the row already declares nor a name already assigned —
 * so a generated suffix can never land on a column that happens to use that
 * exact text itself, in either direction. No value is lost, because both
 * columns are the author's own data and nothing here can tell which they
 * meant.
 *
 * A name this sheet models cannot be claimed by two DIFFERENT headers: the
 * Compositor stores one value per field and must publish one column per
 * canonical name for the file to build, since the framework refuses a sheet
 * whose distinct headers resolve to one canonical name
 * (`_refuse_colliding_renames`, scripts/telar/csv_utils.py). One of them keeps
 * the name and the others are dropped — see `chooseCollisionColumn` for which.
 *
 * Two rules, not one, because the framework draws the same two lines:
 *
 *   - IDENTICAL header text as the file has it (`title,title`, or
 *     ` title , title `) is never folded. The framework's reader makes them
 *     `title` and `title.1` and keeps both values, and its collision check
 *     does not fire, so folding them here would destroy data the published
 *     file would have carried. Text that differs in the file but folds alike
 *     (`Title` beside `title`, or ` title ` beside `title`) IS a collision:
 *     pandas keeps the two as distinct columns, and the framework groups them
 *     by the stripped, folded header after renaming.
 *   - The name must be in THIS sheet's `canonicalScope`. The framework scopes
 *     its own table per sheet (`canonical_fields`), so `step` and `paso` on an
 *     objects sheet are two of the author's own columns and both survive.
 *     Without a scope nothing is folded at all.
 *
 * Where the two meet (`title,title,Title`), the framework reads the repeat as
 * `title.1`, a column of its own that renames onto nothing, and the collision
 * is between the first `title` and `Title`. So only the first position of each
 * distinct text is a candidate for the name; a repeat takes the suffix path
 * after whichever candidate keeps it.
 *
 * `headerTexts` is the text each cell is compared by (`HeaderTextReading`);
 * `headerCells`, the stripped cells, are what a warning or refusal names.
 *
 * `undefined` entries (protection columns) pass through unchanged; they
 * claim no name and so cannot collide with, or be collided with by,
 * anything here.
 */
function assignUniqueColumnNames(
  declaredNames: (string | undefined)[],
  headerCells: string[],
  headerTexts: readonly string[],
  holdsValues: readonly boolean[],
  droppedColumnIndexes: Set<number>,
  canonicalScope?: ReadonlySet<string>,
  onWarning?: SheetIssueHandler,
  options: ParseTelarCsvOptions = {},
): (string | undefined)[] {
  const declared = new Set(declaredNames.filter((n): n is string => n !== undefined));
  // A collision's chosen column claims the name before any position is
  // assigned, because it need not be the first position declaring it.
  const kept = new Map<string, number>();
  for (const [name, candidates] of collisionCandidates(declaredNames, headerTexts, canonicalScope)) {
    const choice = chooseCollisionColumn(name, candidates, headerCells, holdsValues, options);
    for (const i of candidates) if (i !== choice.kept) droppedColumnIndexes.add(i);
    if (choice.warning) onWarning?.(choice.warning);
    kept.set(name, choice.kept);
  }

  const used = new Set<string>(kept.keys());
  const seenCount = new Map<string, number>([...kept.keys()].map((name) => [name, 1]));
  return declaredNames.map((name, i) => {
    if (name === undefined || droppedColumnIndexes.has(i)) return undefined;
    if (kept.get(name) === i) return name;
    return nextUniqueName(name, seenCount, used, declared);
  });
}

/**
 * `name` itself the first time it is asked for, `name_N` after that, with N
 * the lowest free suffix at or above the times it has been seen that matches
 * neither a name any column declares nor one already assigned.
 */
export function nextUniqueName(
  name: string,
  seenCount: Map<string, number>,
  used: Set<string>,
  declared: ReadonlySet<string>,
): string {
  const timesSeenBefore = seenCount.get(name) ?? 0;
  seenCount.set(name, timesSeenBefore + 1);
  if (timesSeenBefore === 0) {
    used.add(name);
    return name;
  }
  let suffix = timesSeenBefore;
  let candidate = `${name}_${suffix}`;
  while (declared.has(candidate) || used.has(candidate)) {
    suffix++;
    candidate = `${name}_${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

/**
 * Each in-scope canonical name claimed by two or more distinct header texts,
 * mapped to the first position of each text in file order. The texts are
 * compared as `headerTexts` gives them, which as the import reads a file is
 * the cell as the file has it, so ` title ` beside `title` is two texts. A
 * name every claimant spells identically is absent: that is the author's
 * repeated column, not a collision.
 */
function collisionCandidates(
  declaredNames: (string | undefined)[],
  headerTexts: readonly string[],
  canonicalScope?: ReadonlySet<string>,
): Map<string, number[]> {
  const firstByText = new Map<string, Map<string, number>>();
  declaredNames.forEach((name, i) => {
    if (name === undefined || !canonicalScope?.has(name)) return;
    const texts = firstByText.get(name) ?? new Map<string, number>();
    firstByText.set(name, texts);
    const text = headerTexts[i] ?? "";
    if (!texts.has(text)) texts.set(text, i);
  });
  const candidates = new Map<string, number[]>();
  for (const [name, texts] of firstByText) {
    if (texts.size > 1) candidates.set(name, [...texts.values()]);
  }
  return candidates;
}

/** Which colliding column keeps a canonical name, and what to tell the author. */
interface CollisionChoice {
  kept: number;
  warning?: SheetIssue;
}

/**
 * The framework's rule for columns that claim one canonical name, applied to
 * `candidates` (positions in file order). `holdsValues` says, per position,
 * whether any data row has a non-empty cell there.
 *
 *   - Exactly one holds values: it keeps the name. The others are empty, so
 *     dropping them loses nothing, and the author is told which was kept.
 *   - None holds values: the one whose folded header IS the canonical name,
 *     otherwise the first. Nothing is lost, so nothing is said.
 *   - More than one: `choiceWhenSeveralHoldValues`.
 */
function chooseCollisionColumn(
  name: string,
  candidates: number[],
  headerCells: string[],
  holdsValues: readonly boolean[],
  options: ParseTelarCsvOptions,
): CollisionChoice {
  const filled = candidates.filter((i) => holdsValues[i]);
  if (filled.length === 1) {
    return {
      kept: filled[0],
      warning: collisionIssue(name, candidates, filled[0], headerCells, "only-filled"),
    };
  }
  if (filled.length === 0) {
    const canonicalSpelling = candidates.find((i) => foldHeader(headerCells[i] ?? "") === name);
    return { kept: canonicalSpelling ?? candidates[0] };
  }
  return choiceWhenSeveralHoldValues(name, candidates, filled, headerCells, options);
}

/**
 * Two or more colliding columns that each hold values (`filled`). The framework
 * refuses such a sheet and leaves the choice to the author, and so does this
 * parse when `options.severalHoldValues` is "refuse": it throws
 * `CollidingColumnsRefusal`, naming the columns that hold values. The first
 * import and every sync ask for that when they read the repo's sheets: keeping
 * one column would drop the others' values without telling the author, and the
 * next publish would remove them from the repository.
 *
 * Under "keep-last", the default, the last candidate keeps the name, the others
 * are dropped, and the warning names every column. A sync's read of the base
 * revision asks for that, so that a sheet already fixed in the repo is not
 * refused for what it held before, and so does object deletion, which compares
 * this parse with its own scan of the same rows.
 */
function choiceWhenSeveralHoldValues(
  name: string,
  candidates: number[],
  filled: number[],
  headerCells: string[],
  options: ParseTelarCsvOptions,
): CollisionChoice {
  if (options.severalHoldValues === "refuse") {
    throw new CollidingColumnsRefusal(
      options.sheetName ?? "",
      name,
      filled.map((i) => headerCells[i] ?? ""),
    );
  }
  const kept = candidates[Math.min(options.keepClaimant ?? candidates.length - 1, candidates.length - 1)];
  return { kept, warning: collisionIssue(name, candidates, kept, headerCells, "last") };
}

/**
 * The columns that claimed one canonical name and which was kept, in the
 * author's own spellings — the headers as typed, not the canonical name they
 * resolved to, because the sheet the author has to fix carries the former.
 * `keptBecause` is why that column: the only one with values, or the last of
 * several that have them.
 */
function collisionIssue(
  canonicalName: string,
  candidates: number[],
  kept: number,
  headerCells: string[],
  keptBecause: "only-filled" | "last",
): SheetIssue {
  const headers = candidates.map((i) => headerCells[i] ?? "");
  if (keptBecause === "only-filled") {
    return {
      code: "column_collision_only_filled",
      name: canonicalName,
      headers,
      kept: headerCells[kept] ?? "",
      column: kept + 1,
    };
  }
  return { code: "column_collision_last", name: canonicalName, headers, column: kept + 1 };
}

/**
 * Warns once for each heading-less column this row is the first to have a value
 * under, naming it by its position in the sheet so a reader can find it.
 *
 * Reported from the rows rather than from the header alone: a header row
 * ending in a comma declares a heading-less column on nearly every sheet there
 * is, and a warning about a column no row fills is noise over a loss nobody
 * took. `reported` carries the columns already named across the whole parse.
 *
 * The cell test is JavaScript's `trim()` rather than the CPython strip every
 * cell VALUE is weighed under, because what it decides is whether a message is
 * worth showing, not what the framework builds: a cell a reader sees as blank
 * earns no warning about a value they would look for and not find.
 */
function warnBlankHeaders(
  cells: string[],
  positions: HeaderPositions,
  reported: Set<number>,
  onWarning?: SheetIssueHandler,
): void {
  for (const i of positions.blankHeaderIndexes) {
    if (reported.has(i) || (cells[i] ?? "").trim() === "") continue;
    reported.add(i);
    onWarning?.({ code: "blank_header", column: i + 1 });
  }
}

/**
 * A header row's cells as every reader of one has to hold them: NUL bytes out,
 * CPython's strip applied. The text and the identity are two answers about one
 * header, and `analyzeHeaderPositions` is given the form both are taken from.
 */
function normalizeHeaderCells(rawCells: string[]): string[] {
  return rawCells.map((h) => pythonStrip(sanitizeHeaderCell(h ?? "")));
}

/**
 * The column position a parse of `table` under `canonicalScope` resolves `name`
 * to, or -1 when no column carries it. `table` is the file's records as
 * `TELAR_CSV_PARSE_CONFIG` reads them, header first.
 *
 * Exported so a caller that has to read one field out of a record it did not
 * parse — `removeObjectRecord`, csv-record-scan.server.ts, reading `object_id`
 * — reads it at the position the import puts it. The framework's rename table
 * can land a canonical name anywhere: `object_id` beside `id_objeto` resolves
 * to whichever of them the collision rule keeps, and the other carries no name
 * at all, so a cell picked by its own literal heading is a cell some other
 * object's id may sit in. The rule weighs which columns hold values, so it
 * needs the rows as well as the header.
 */
export function resolvedColumnPosition(
  table: string[][],
  name: string,
  canonicalScope?: ReadonlySet<string>,
  isProjectCsv = false,
): number {
  return importedColumnNames(table, canonicalScope, isProjectCsv).indexOf(name);
}

/**
 * The name the import gives each column of `table`, read as
 * `resolvedColumnPosition` reads it, with `undefined` for a column that
 * carries none. A repeated header is named `name_N` here, so a caller matching
 * blob keys to the file's columns has to match against these names rather
 * than the header's text.
 */
export function importedColumnNames(
  table: string[][],
  canonicalScope?: ReadonlySet<string>,
  isProjectCsv = false,
): (string | undefined)[] {
  if (table.length === 0) return [];
  return resolveTableHeader(table, isProjectCsv, canonicalScope).positions.finalNames;
}

/**
 * A non-empty table's header as the import reads it, position by position: the
 * cells (NUL bytes out, CPython's strip applied), the name each position
 * declares and the name it is finally stored under, the positions dropped and
 * which of those have no heading at all, and which positions hold a value in a
 * record the parse keeps. Read as `importedColumnNames` reads it, so a writer
 * laying the file out again names every position as the import does.
 */
export interface ImportedHeader {
  headerCells: string[];
  declaredNames: (string | undefined)[];
  finalNames: (string | undefined)[];
  droppedColumnIndexes: ReadonlySet<number>;
  blankHeaderIndexes: ReadonlySet<number>;
  holdsValues: readonly boolean[];
  /** Every position a protection spelling heads; empty unless read as project.csv. */
  privateColumnIndexes: ReadonlySet<number>;
  /** The one of those positions whose value decides `private`. */
  protectionColumnIndex: number | undefined;
}

/**
 * `table`'s header as the import reads it under `canonicalScope` (see
 * `ImportedHeader`), as project.csv's when `isProjectCsv`: every protection
 * spelling is then a protection position with no final name.
 */
export function importedHeader(
  table: string[][],
  canonicalScope?: ReadonlySet<string>,
  isProjectCsv = false,
): ImportedHeader {
  return importedHeaderOf(resolveTableHeader(table, isProjectCsv, canonicalScope));
}

/** A resolved header as `ImportedHeader` names it. */
function importedHeaderOf({ headerCells, positions, holdsValues }: ResolvedTableHeader): ImportedHeader {
  return {
    privateColumnIndexes: positions.privateColumnIndexes,
    protectionColumnIndex: positions.protectionColumnIndex,
    headerCells,
    declaredNames: positions.declaredNames,
    finalNames: positions.finalNames,
    droppedColumnIndexes: positions.droppedColumnIndexes,
    blankHeaderIndexes: positions.blankHeaderIndexes,
    holdsValues,
  };
}

/**
 * How two header cells claiming one canonical name are told apart.
 *
 *   - "as-written": the cells as the file has them, NUL bytes out and not
 *     stripped. pandas keeps ` title ` and `title` as two columns, so they are
 *     two texts and collide, while ` title , title ` is one text repeated.
 *     Every parse reads a header this way.
 *   - "stripped": the cells after CPython's strip, so ` title ` and `title`
 *     are one text repeated and the second is named `title_1`. Blob keys in
 *     D1 can have been stored under this reading, and a publish that writes
 *     such a key back reads the file this way as well to recognise it.
 */
export type HeaderTextReading = "as-written" | "stripped";

/** A column the import stores under a name its header does not give it. */
export interface RenamedColumn {
  /** The header cell as the import reads it (`normalizeHeaderCells`). */
  header: string;
  /** The name the import stores and a publish writes, `name_N`. */
  renamed: string;
  /** How many header cells in the file read as `header` once stripped,
   * counting a column the import drops. */
  total: number;
}

/**
 * Each position of `table` the import names differently from what its header
 * declares, in file order, with the header read as `reading` says. Under the
 * scopes the sheets are parsed with, that is only a later occurrence of a
 * repeated header text: two different texts claiming one name collide, and the
 * one not kept carries no name at all.
 */
export function renamedColumns(
  table: string[][],
  canonicalScope?: ReadonlySet<string>,
  reading: HeaderTextReading = "as-written",
): RenamedColumn[] {
  if (table.length === 0) return [];
  const { headerCells, positions } = resolveTableHeader(table, false, canonicalScope, undefined, {}, reading);
  return positions.finalNames.flatMap((name, i) =>
    name === undefined || name === positions.declaredNames[i]
      ? []
      : [{ header: headerCells[i], renamed: name, total: headerCells.filter((cell) => cell === headerCells[i]).length }],
  );
}

/** A table's header read once: its cells, their meaning, and every record's verdict. */
interface ResolvedTableHeader {
  headerCells: string[];
  positions: HeaderPositions;
  /** Per position, whether a record the parse keeps has a value there. */
  holdsValues: readonly boolean[];
  /** The skip verdict for `table[r]`, at index `r - 1`. */
  verdicts: CsvRecordSkipVerdict[];
}

/**
 * Reads a non-empty table's header the one way both `parseTelarCsv` and
 * `resolvedColumnPosition` must: every record classified by a single detector,
 * which columns hold values judged from the records it keeps, and the header's
 * positions decided with that knowledge.
 *
 * The verdicts are computed once and handed back, because the detector is
 * stateful — it spends its one bilingual-row test on the first record that is
 * not a comment — so the rows that count toward a column holding values and
 * the rows the parse keeps are the same rows only if one detector decides both.
 */
function resolveTableHeader(
  table: string[][],
  isProjectCsv: boolean,
  canonicalScope?: ReadonlySet<string>,
  onWarning?: SheetIssueHandler,
  options: ParseTelarCsvOptions = {},
  reading: HeaderTextReading = "as-written",
): ResolvedTableHeader {
  // The header cell's TEXT, which is what a custom column is kept and
  // republished under. Stripped as `foldHeader` strips, because the text and
  // the identity are two answers about one header and a column cannot have
  // both: under JavaScript's `trim()` a header ending in U+FEFF is kept as the
  // text its plain twin already has while folding to a name of its own, so two
  // columns the framework reads apart are stored as one name and a `_1` suffix
  // the sheet never had.
  //
  // A stored blob key edged with one of the five CPython strips and JavaScript
  // does not (U+001C-U+001F, U+0085) re-imports under the stripped spelling
  // once and matches from then on.
  const headerCells = normalizeHeaderCells(table[0]);
  const isSkippedCsvRecord = createCsvRecordSkipDetector(
    isProjectCsv,
    instructionHeaderOf(table),
    sheetAliasesFor(canonicalScope),
  );
  const verdicts = table.slice(1).map((cells) => isSkippedCsvRecord(cells, headerCells.length));
  const holdsValues = columnsHoldingValues(table, verdicts, headerCells.length);
  const positions = analyzeHeaderPositions(
    headerCells,
    holdsValues,
    isProjectCsv,
    canonicalScope,
    onWarning,
    options,
    headerTextsUnder(reading, table[0], headerCells),
  );
  return { headerCells, positions, holdsValues, verdicts };
}

/**
 * The text each header cell is compared by under `reading`: the raw cell with
 * NUL bytes removed, or the stripped cell `normalizeHeaderCells` gave.
 */
function headerTextsUnder(
  reading: HeaderTextReading,
  rawCells: string[],
  headerCells: string[],
): readonly string[] {
  if (reading === "stripped") return headerCells;
  return rawCells.map((cell) => sanitizeHeaderCell(cell ?? ""));
}

/**
 * Per column position, whether any record the parse keeps has a non-empty
 * cell there under CPython's strip, the strip a stored value is taken with.
 * Comment rows, the bilingual header row and blank lines are not data, so a
 * value in one of them does not count. Cells past `headerWidth` belong to no
 * column.
 */
function columnsHoldingValues(
  table: string[][],
  verdicts: CsvRecordSkipVerdict[],
  headerWidth: number,
): boolean[] {
  const holds = new Array<boolean>(headerWidth).fill(false);
  verdicts.forEach((verdict, k) => {
    if (verdict.skip) return;
    const cells = table[k + 1];
    for (let i = 0; i < headerWidth; i++) {
      if (pythonStrip(cells[i] ?? "") !== "") holds[i] = true;
    }
  });
  return holds;
}

/**
 * Decides what each header cell means, by position, exactly once per parse.
 */
function analyzeHeaderPositions(
  headerCells: string[],
  holdsValues: readonly boolean[],
  isProjectCsv: boolean,
  canonicalScope?: ReadonlySet<string>,
  onWarning?: SheetIssueHandler,
  options: ParseTelarCsvOptions = {},
  headerTexts: readonly string[] = headerCells,
): HeaderPositions {
  const privateColumnIndexes = new Set<number>();
  const droppedColumnIndexes = new Set<number>();
  const blankHeaderIndexes = new Set<number>();
  const sheetAliases = sheetAliasesFor(canonicalScope);
  const declaredNames: (string | undefined)[] = headerCells.map((cell, i) => {
    const key = foldHeader(cell);
    // A heading that folds to nothing names no column. pandas supplies a name
    // of its own for one, out of the column's POSITION in the file it is
    // reading — `Unnamed: <index>` — and a published file puts custom columns
    // after the fixed ones, so the name the framework reads back is not the one
    // the sheet had. Two such columns take two names there and one key here;
    // one beside an author's own `unnamed: <n>` takes that same name twice.
    // Neither is a shape the Compositor can store and republish, so the column
    // carries no key at all and its values stay in the author's spreadsheet.
    if (key === "") {
      blankHeaderIndexes.add(i);
      droppedColumnIndexes.add(i);
      return cell;
    }
    if (isProjectCsv && COLUMN_NAME_MAPPING[key] === "private") {
      privateColumnIndexes.add(i);
      return undefined;
    }
    if (!isProjectCsv && PROJECT_ONLY_ALIASES.has(key)) return cell;
    const target = renameTarget(key, sheetAliases);
    if (target === undefined) return cell;
    // A rename onto a name this sheet does not model is not a rename at all:
    // the framework scopes its table the same way (`canonical_fields`), so a
    // lone `paso` on an objects sheet stays `paso` there rather than becoming
    // a `step` the objects mapper will never read and the file will never
    // carry. Without a scope the whole table applies, as before.
    if (canonicalScope && !canonicalScope.has(target)) return cell;
    return target;
  });
  return {
    privateColumnIndexes,
    protectionColumnIndex: chooseProtectionColumn(
      privateColumnIndexes,
      headerCells,
      headerTexts,
      holdsValues,
      onWarning,
      options,
    ),
    droppedColumnIndexes,
    blankHeaderIndexes,
    declaredNames,
    finalNames: assignUniqueColumnNames(
      declaredNames,
      headerCells,
      headerTexts,
      holdsValues,
      droppedColumnIndexes,
      canonicalScope,
      onWarning,
      options,
    ),
  };
}

/** The name a folded header renames onto: the sheet's own aliases first, as the framework merges them over its map. */
function renameTarget(folded: string, sheetAliases?: Readonly<Record<string, string>>): string | undefined {
  return sheetAliases?.[folded] ?? COLUMN_NAME_MAPPING[folded];
}

/**
 * The protection column whose value decides whether a story is private.
 *
 * The framework renames every protection spelling (`private`, `privada`,
 * `protegido` and the rest) to `protected` and refuses a sheet in which two
 * different headers arrive at it (`_refuse_colliding_renames`,
 * scripts/telar/csv_utils.py), so these columns follow the same rule as any
 * other canonical name: with one holding values that one decides, and with
 * several an import or sync refuses the sheet. A header repeated with the same
 * text is read by the framework as `private.1`, a column of its own that
 * renames onto nothing, so only the first position of each distinct text is a
 * candidate. The text compared is the header as the file has it, unstripped
 * (`headerTexts`): pandas reads `private` and ` private ` as two columns, both
 * of which rename to `protected`, and a story marked `yes` in either is not
 * read as public.
 */
function chooseProtectionColumn(
  privateColumnIndexes: ReadonlySet<number>,
  headerCells: string[],
  headerTexts: readonly string[],
  holdsValues: readonly boolean[],
  onWarning: SheetIssueHandler | undefined,
  options: ParseTelarCsvOptions,
): number | undefined {
  const firstByText = new Map<string, number>();
  for (const i of privateColumnIndexes) {
    const text = headerTexts[i] ?? "";
    if (!firstByText.has(text)) firstByText.set(text, i);
  }
  const candidates = [...firstByText.values()];
  if (candidates.length <= 1) return candidates[0];
  const choice = chooseCollisionColumn("private", candidates, headerCells, holdsValues, options);
  if (choice.warning) onWarning?.(choice.warning);
  return choice.kept;
}

/**
 * Sets a key a file supplied (a header-derived column name, or a value read
 * from one) as a genuine own property, even when that key is `__proto__`.
 * Ordinary `obj[key] = value` does not: for that one key name, assignment
 * hits the inherited accessor on Object.prototype instead of creating a
 * property, and the value is silently lost. `Object.defineProperty` always
 * defines an own property regardless of what the key is; `Object.assign`
 * does not carry the same guarantee, since it assigns through the same
 * inherited accessor a plain assignment would.
 */
function setOwnProperty(obj: Record<string, string>, key: string, value: string): void {
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * Builds one data row from its raw cells, entirely by position: a cell at a
 * protection index contributes only to the shared truthy verdict (never its
 * own field); every other cell is kept under the unique key
 * `analyzeHeaderPositions` assigned its column.
 *
 * Cells are stored under CPython's strip, the strip every question about a
 * cell's identity is settled with. The text and the identity are two answers
 * about one cell and it can only have one: a first cell of U+FEFF then `#note`
 * is an OBJECT to the comment rule here and to the framework's, so a store
 * trimming JavaScript's way keeps the object under `#note` and publishes it
 * that way — a row both framework releases then drop as a comment, and an
 * object missing from the site and from every import after. U+0085 is the same
 * disagreement the other way: kept by `trim()`, it edges a stored value the
 * framework never sees with a character the framework strips.
 *
 * A column named in `asWritten` is the exception: its cell is the row's identity
 * as the framework holds it, which is the cell as written (see
 * `columnsKeptAsWritten`).
 */
function buildRowByPosition(
  cells: string[],
  headerCells: string[],
  positions: HeaderPositions,
  asWritten: ReadonlySet<string> = NO_COLUMNS,
): Record<string, string> {
  const { privateColumnIndexes, protectionColumnIndex, droppedColumnIndexes, finalNames } = positions;
  const row: Record<string, string> = {};
  let isPrivate = false;
  for (let i = 0; i < headerCells.length; i++) {
    const value = storedCell(cells[i] ?? "", finalNames[i], asWritten);
    if (privateColumnIndexes.has(i)) {
      if (i === protectionColumnIndex && PRIVATE_TRUTHY.has(value.toLowerCase())) isPrivate = true;
      continue;
    }
    // A column another one outranked for the same canonical name carries no
    // key of its own: the row must hold exactly one value per canonical name.
    if (droppedColumnIndexes.has(i)) continue;
    setOwnProperty(row, finalNames[i] as string, value);
  }
  if (privateColumnIndexes.size > 0) row.private = isPrivate ? "true" : "";
  return row;
}

const NO_COLUMNS: ReadonlySet<string> = new Set();

/** A cell as a row stores it under `name`: as written where `asWritten` names it, stripped otherwise. */
function storedCell(cell: string, name: string | undefined, asWritten: ReadonlySet<string>): string {
  return name !== undefined && asWritten.has(name) ? cell : pythonStrip(cell);
}

/** objects.csv's identity column, whose cell is stored as written. */
const OBJECT_ID_AS_WRITTEN: ReadonlySet<string> = new Set(["object_id"]);

/**
 * The columns of the sheet read under `canonicalScope` whose cells are stored
 * as written rather than stripped: objects.csv's `object_id`.
 *
 * The framework reads an object's id as pandas reads the cell and strips it
 * only to look for an image extension, writing the stripped stem back where it
 * removed one (`_clean_object_ids`, scripts/telar/processors/objects/frame.py).
 * So `map` and `map  ` are two objects on the site, each with its own page,
 * and one id to a reading that strips. Held as written, each can be deleted
 * without the other; `siteObjectId` gives the id the site uses.
 */
function columnsKeptAsWritten(canonicalScope?: ReadonlySet<string>): ReadonlySet<string> {
  return canonicalScope === OBJECTS_CANONICAL_SCOPE ? OBJECT_ID_AS_WRITTEN : NO_COLUMNS;
}

/**
 * The PapaParse configuration every reading of a Telar CSV runs under.
 *
 * Exported because a second reader of the same file — `removeObjectRecord` and
 * `extractCommentRows`, which need the ranges the rows occupy — has to be the
 * same reading, and two configurations written out twice are two readings a
 * character apart. Under a delimiter pinned on one side only, a file one
 * reader splits on a comma the other splits on whatever it guessed; under
 * `skipEmptyLines` written one side only, a row one side has is a row the
 * other does not, and the N-th row on one side is not the N-th on the other.
 *
 * `header: false` because identity is decided by POSITION here, never by a
 * name Papa read off a header cell. `skipEmptyLines` drops a row that is one
 * EMPTY field — a blank line, and a line holding `""` — and keeps a
 * space-only one as a Papa record, a populated cell to Papa's own option.
 * That record is not an object, though: `isPandasBlankLine`, inside
 * `createCsvRecordSkipDetector`, is the rule that answers what pandas itself
 * does with it (drops it before it is ever a row), because Papa's own notion
 * of "empty" is narrower than pandas' and the gap is exactly a delimiter-free
 * line of nothing but spaces or tabs — see that constant. No `comments`
 * character: a `#` row is a row this module classifies, not one the
 * tokeniser may swallow, and the serializer has to be able to write it back.
 *
 * `delimiter` is the comma because the framework's is: every CSV it opens goes
 * through `pd.read_csv` with no `sep` at either release, so pandas splits on a
 * comma and on nothing else. Left unset, Papa guesses one per file from the
 * characters in it (papaparse.js:1093-1103), and a one-column export whose
 * cells each hold two semicolons or two tabs guesses its way to a delimiter
 * pandas never uses: `a;x;y` is stored as the id `a` with the rest of the cell
 * discarded, against a site built from the whole cell. Pinning it also settles
 * the dialect a preserved comment is read and rewritten in, so a row is a
 * comment to both readers or to neither.
 */
export const TELAR_CSV_PARSE_CONFIG: Papa.ParseConfig<string[]> = {
  header: false,
  skipEmptyLines: true,
  delimiter: ",",
};

/**
 * Parses a Telar CSV string, skipping bilingual header rows and comment rows.
 *
 * Papa Parse runs in array mode (`header: false`) for tokenising only
 * (quoted commas, embedded newlines, escapes, encoding); every column's
 * identity is then decided here, by its POSITION in the header row, never
 * by a name — a header cell can carry anything a decoder passes through, so
 * no name it supplies is safe to key protection, or anything else whose
 * identity matters, by.
 *
 * Protection is one verdict, not a column: of the columns this parse's mapping
 * resolves to `private`, the one `chooseProtectionColumn` picks decides it,
 * and a truthy cell there (the PRIVATE_TRUTHY whitelist) makes the row
 * private, whichever position it sits at. Protection columns claim no name and
 * so never collide with, or are collided with by, anything else in the row.
 *
 * Every other column keeps its own value under a key unique to the whole
 * row: the first column to declare a given name keeps it; a later column
 * declaring the same name is suffixed `_N` against every name any column in
 * the row declares, not merely against names already assigned — see
 * `assignUniqueColumnNames`. No two columns share a key. Columns whose
 * differing headers claim one name this sheet models are a collision instead,
 * and one of them keeps the name by which columns hold values; the header is
 * resolved in `resolveTableHeader` before any row is built.
 *
 * The one column that keeps nothing is one whose heading folds to nothing: it
 * has no name for a row to hold its value under and none the framework would
 * read it back by (see `analyzeHeaderPositions`). `onWarning`, when given, is
 * told once per such column that a row had a value under, so the author can
 * give it a heading; a column no row fills is dropped in silence.
 *
 * A row with more fields than the header declares has its surplus values
 * dropped; `onWarning`, when given, is told which row lost values, so a
 * caller with somewhere to put a warning can say so rather than let the
 * loss pass in silence. A row with fewer fields than the header declares
 * treats each missing trailing cell as an empty string, not an absent key:
 * the header declares the column, so the column exists on every row.
 *
 * The bilingual header test — see `createCsvRecordSkipDetector` — is spent on
 * the first record that is not a comment, and never asked of any other, so a
 * later data row that happens to score like a header is imported rather than
 * silently dropped. `onWarning`, when given, is told when that one test
 * drops a row holding a cell that is not a header token, naming it the way a
 * ragged row is named, because that is the only row a wrong verdict here can
 * still cost an author. A row of nothing but header tokens is the bilingual
 * row every published sheet carries, and is dropped in silence.
 *
 * `isProjectCsv` gates PROJECT_ONLY_ALIASES, which columns are tracked as
 * protection at all, and the bilingual-row detector's mapping-derived
 * known-value set (see `isHeaderRow`): pass true only for project.csv or
 * the project sheet tab, so a PROJECT_ONLY_ALIASES column belonging to any
 * other Telar CSV keeps its own header — never tracked as protection
 * there. `protected` also reaches the detector through the separate,
 * unscoped FRAMEWORK_HEADER_TOKENS route, which this gate does not cover —
 * see the note on that constant.
 *
 * `options.severalHoldValues` says what to do when two or more columns claim
 * one canonical name and each holds values — see `choiceWhenSeveralHoldValues`.
 * `options.sheetName` is the name a refusal gives the sheet.
 */
export function parseTelarCsv(
  csvText: string,
  onWarning?: SheetIssueHandler,
  isProjectCsv = false,
  canonicalScope?: ReadonlySet<string>,
  options: ParseTelarCsvOptions = {},
): Record<string, string>[] {
  const parsed = Papa.parse<string[]>(csvText, TELAR_CSV_PARSE_CONFIG);
  const table = parsed.data;
  if (table.length === 0) return [];

  const resolved = resolveTableHeader(table, isProjectCsv, canonicalScope, onWarning, options);
  const { headerCells, positions, verdicts } = resolved;
  warnHeaderSpelling(table[0], resolved, canonicalScope, onWarning, options.fromGoogleSheets);

  const rows: Record<string, string>[] = [];
  const blankHeadersReported = new Set<number>();
  const asWritten = columnsKeptAsWritten(canonicalScope);
  for (let r = 1; r < table.length; r++) {
    const cells = table[r];

    // The build warns only when a dropped cell holds something, judged by
    // Python's strip: a lone U+FEFF is something there.
    if (cells.slice(headerCells.length).some((cell) => pythonStrip(String(cell)) !== "")) {
      onWarning?.({ code: "ragged_row", row: sheetRow(positionalRow(cells.slice(0, headerCells.length)), r - 1) });
    }
    const verdict = verdicts[r - 1];
    if (verdict.reason === "bilingual-header") {
      const skipped = positionalRow(cells.slice(0, headerCells.length));
      const weighed = positionalRow(headerTestCells(cells, headerCells.length, instructionHeaderOf(table)));
      if (!isWhollyHeaderTokens(weighed, isProjectCsv, sheetAliasesFor(canonicalScope))) {
        onWarning?.({ code: "bilingual_header_row", row: sheetRow(skipped, r - 1) });
      }
    }
    if (verdict.skip) continue;

    warnBlankHeaders(cells, positions, blankHeadersReported, onWarning);
    rows.push(buildRowByPosition(cells, headerCells, positions, asWritten));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Config mapping
// ---------------------------------------------------------------------------

/**
 * Maps parsed _config.yml fields to the project_config table insert shape.
 *
 * Boolean fields from YAML are passed through as-is (js-yaml coerces
 * `true`/`false` YAML values to JS booleans). The telar.version key is
 * read-only — it is stored for display but never written back to the repo.
 */
export function mapConfigToProjectConfig(
  config: Record<string, unknown>,
): Partial<typeof project_config.$inferInsert> {
  const storyInterface = (config.story_interface ?? {}) as Record<string, unknown>;
  const collectionInterface = (config.collection_interface ?? {}) as Record<string, unknown>;
  // `development-features:` is the framework's block name; the hyphen means it
  // can only be read by index, never as a property.
  const developmentFeatures = (config["development-features"] ?? {}) as Record<string, unknown>;

  const googleSheets = (config.google_sheets ?? {}) as Record<string, unknown>;
  const telarBlock = (config.telar ?? {}) as Record<string, unknown>;

  // story_key is the top-level scalar and nothing else: that is where the
  // framework has read it from since v0.8.0-beta, and where publish writes it.
  // A `protected:` block belongs to whoever put it there and holds no key this
  // import may claim.
  const storyKey = config.story_key as string | undefined;

  return {
    title: config.title as string | undefined,
    baseurl: config.baseurl as string | undefined,
    url: config.url as string | undefined,
    theme: config.telar_theme as string | undefined,
    lang: (config.telar_language as string | undefined) ?? "en",
    description: config.description as string | undefined,
    author: config.author as string | undefined,
    email: config.email as string | undefined,
    logo: config.logo as string | undefined,
    telar_version: telarBlock.version as string | undefined,
    // story_interface
    show_on_homepage: storyInterface.show_on_homepage as boolean | undefined,
    show_story_steps: storyInterface.show_story_steps as boolean | undefined,
    show_object_credits: storyInterface.show_object_credits as boolean | undefined,
    include_demo_content: storyInterface.include_demo_content as boolean | undefined,
    // collection_interface
    browse_and_search: collectionInterface.browse_and_search as boolean | undefined,
    show_link_on_homepage: collectionInterface.show_link_on_homepage as boolean | undefined,
    show_sample_on_homepage: collectionInterface.show_sample_on_homepage as boolean | undefined,
    featured_count: collectionInterface.featured_count as number | undefined,
    // development-features
    skip_stories: developmentFeatures.skip_stories as boolean | undefined,
    // story_key — protected.key with top-level fallback (see above)
    story_key: storyKey,
    // google_sheets
    google_sheets_enabled: googleSheets.enabled as boolean | undefined,
    google_sheets_published_url: googleSheets.published_url as string | undefined,
    // collection_mode — top-level YAML scalar
    collection_mode: config.collection_mode as boolean | undefined,
    // The top-level `glossary: kinds:` the framework reads, not `collections: glossary:`.
    glossary_kinds_json: glossaryKindsJsonOf(config.glossary) ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// CSV column mapping
// ---------------------------------------------------------------------------



/**
 * Maps parsed objects.csv rows to the objects table insert shape.
 * The `featured` column accepts the spellings in `FEATURED_TRUTHY` —
 * anything else is false.
 *
 * `onWarning`, when given, fires at most once for the whole sheet — not once
 * per row — naming every reserved column (see `RESERVED_COLUMN_NAMES`) found
 * anywhere in it. This is notice only: the column is still captured into
 * `extra_columns` exactly as any other custom column would be. The publish
 * blocker (`object_reserved_column` in `runPrePublishValidation`) is what
 * actually enforces the framework's refusal; this just tells the author
 * earlier, at import, rather than only at publish.
 */
export function mapObjectsCsv(
  rows: Record<string, string>[],
  projectId?: number,
  onWarning?: SheetIssueHandler,
): Array<typeof objects.$inferInsert> {
  const reservedFound = new Set<string>();
  const instructionFound = new Set<string>();
  // An id is empty when CPython's `str.strip()` leaves nothing, because that is
  // the strip the framework weighs the same cell under: a cell holding only
  // U+FEFF is an object on the built site, and dropping it here leaves the
  // Compositor with no row for an object the sheet and the site both have.
  const mapped = rows.filter((row) => pythonStrip(row.object_id ?? "") !== "").map((row) => {
    const featured = FEATURED_TRUTHY.has(pythonStrip(row.featured ?? "").toLowerCase());
    // Custom-column passthrough: capture every column the mapper doesn't
    // consume first-class into extra_columns, so custom scholarly metadata
    // survives import → D1. The same collector the glossary mapper uses, so the
    // two sheets cannot come to differ over which cells are custom, which are
    // empty, or which headings the framework reserves and instructs on.
    const { extras, reserved, instruction } = collectExtraColumns(row, KNOWN_OBJECT_KEYS);
    for (const key of reserved) reservedFound.add(key);
    for (const key of instruction) instructionFound.add(key);
    return {
      project_id: projectId ?? 0,
      object_id: row.object_id ?? "",
      title: row.title || undefined,
      featured,
      creator: row.creator || undefined,
      description: row.description || undefined,
      // The framework prefers whichever of the pair is non-empty rather than
      // letting one column win the name (`get_source_url`,
      // scripts/telar/csv_utils.py); reading it the same way here is what lets
      // the Compositor publish `source_url` alone and still carry a legacy
      // sheet's manifest. `iiif_manifest` is never written back out.
      source_url: row.source_url || row.iiif_manifest || undefined,
      period: row.period || undefined,
      year: row.year || undefined,
      // Every spelling of this field arrives as `medium_genre`: the header
      // mapping renames `medium`, `object_type` and the Spanish forms onto it
      // before the row reaches here, so there is no second name left to read.
      object_type: row.medium_genre || undefined,
      subjects: row.subjects || undefined,
      source: row.source || undefined,
      credit: row.credit || undefined,
      thumbnail: row.thumbnail || undefined,
      alt_text: row.alt_text || row.title || undefined,
      dimensions: row.dimensions || undefined,
      extra_columns: Object.keys(extras).length > 0 ? JSON.stringify(extras) : undefined,
      image_available: false,
    };
  });
  warnSheetColumns(rows, reservedFound, instructionFound, onWarning, FRAMEWORK_OBJECTS_READER);
  return mapped;
}

// project.csv keys mapped to first-class D1 columns; any other column is
// preserved verbatim in `extra_columns` (custom-column passthrough).
// `mostrar_secciones` is read by the mapper as the alias of `show_sections`.
export const KNOWN_PROJECT_KEYS: ReadonlySet<string> = new Set([
  "order", "story_id", "title", "subtitle", "byline", "private",
  "show_sections", "mostrar_secciones",
]);

/**
 * Maps parsed project.csv rows to the stories table insert shape.
 * `order` is parsed as integer; `private` as boolean. Every column the mapper
 * does not consume lands in `extra_columns`, as in `mapGlossaryCsv`.
 *
 * `private` is read here as a single already-resolved cell: `parseTelarCsv`
 * (when told this is a project CSV) decides, by header POSITION, whether the
 * row's deciding protection column is truthy and hands this mapper one
 * `private` cell already carrying that verdict — see `buildRowByPosition`.
 * This function does not itself choose between more than one protection
 * column; it applies PRIVATE_TRUTHY to whatever single cell it is handed,
 * whether that cell came from `parseTelarCsv` or was set directly (as
 * callers that build rows by hand do throughout this file's tests).
 */
export function mapProjectCsv(
  rows: Record<string, string>[],
  projectId?: number,
): Array<typeof stories.$inferInsert> {
  return rows.map((row) => {
    const isPrivate = PRIVATE_TRUTHY.has(pythonStrip(row.private ?? "").toLowerCase());

    // show_sections — canonical English column wins over the Spanish
    // mostrar_secciones alias when both are present. Truthy whitelist matches
    // the framework's processors/project.py: yes/true/sí/si (case-insensitive,
    // trimmed). "1" is intentionally NOT accepted — it would diverge from the
    // framework's publish behaviour.
    const showSectionsRaw = pythonStrip(
      row.show_sections ?? row.mostrar_secciones ?? "",
    ).toLowerCase();
    const showSections =
      showSectionsRaw === "true" ||
      showSectionsRaw === "yes" ||
      showSectionsRaw === "sí" ||
      showSectionsRaw === "si";

    const { extras } = collectExtraColumns(row, KNOWN_PROJECT_KEYS);

    return {
      project_id: projectId ?? 0,
      story_id: row.story_id ?? "",
      title: row.title || undefined,
      subtitle: row.subtitle || undefined,
      byline: row.byline || undefined,
      order: parseInt(row.order ?? "0", 10) || 0,
      private: isPrivate,
      show_sections: showSections,
      extra_columns: extrasBlob(extras),
    };
  });
}

/**
 * GitHub's project.csv, its leading byte-order mark already removed, as the
 * import reads it into stories: the project columns and their aliases, and a
 * refusal (`CollidingColumnsRefusal`) where two columns claiming one name both
 * hold values. The publish reads the story ids with this too, so the ids it
 * names older copies for are the ids the import read older copies for.
 */
export function projectCsvStoryRows(
  content: string,
  onWarning?: SheetIssueHandler,
): Array<typeof stories.$inferInsert> {
  return mapProjectCsv(
    parseTelarCsv(content, onWarning, true, PROJECT_CANONICAL_SCOPE, {
      severalHoldValues: "refuse",
      sheetName: "project.csv",
    }),
  );
}

/**
 * Maps parsed story CSV rows to steps and layers table insert shapes.
 * step/x/y/zoom are parsed as numbers. Layers are extracted when
 * layer1_button or layer1_content exist (same for layer2).
 *
 * Note: layers use a placeholder step_id of 0 — the caller must update
 * these after inserting steps and retrieving their assigned IDs.
 */

/**
 * Python's `\s` for a str pattern: every character `str.isspace()` accepts.
 * Built from the same set `pythonStrip` uses.
 */
const PY_SPACE = `[${[...PYTHON_WHITESPACE].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}]`;

/**
 * A line end as the framework sees one. It reads a layer file in text mode,
 * so Python's universal newlines turn `\r\n` and a lone `\r` into `\n`
 * before its pattern runs, and it normalises an inline cell the same way.
 * Matching all three here keeps the body's own bytes, which the publisher
 * writes back unchanged.
 */
const PY_NEWLINE = "(?:\\r\\n|\\r|\\n)";

/**
 * The framework's FRONTMATTER_PATTERN, `^---\s*\n(.*?)\n---\s*\n(.*)$` with
 * DOTALL (the framework's scripts/telar/markdown.py:56). The closing fence
 * must be followed by a line end: a file ending on `---` has no front matter.
 */
const LAYER_FRONTMATTER = new RegExp(
  `^---${PY_SPACE}*${PY_NEWLINE}([\\s\\S]*?)${PY_NEWLINE}---${PY_SPACE}*${PY_NEWLINE}([\\s\\S]*)$`,
);

/**
 * The framework's TITLE_PATTERN, `^title:\s*["\']?(.*?)["\']?\s*$` with
 * MULTILINE (the framework's scripts/telar/markdown.py:61), over a block whose
 * line ends are `\n`. Written out so it means what Python's does: a line start
 * is after `\n` only, a line end is before `\n` or at the end, `.` is anything
 * but `\n`, and `\s` is Python's. `\s*` crosses line ends, so an empty
 * `title:` captures the next line, as the framework's does.
 */
const LAYER_TITLE_PATTERN = new RegExp(
  `(?:^|(?<=\\n))title:${PY_SPACE}*["']?([^\\n]*?)["']?${PY_SPACE}*(?=\\n|$)`,
);

/**
 * The title `_split_frontmatter` gives a block, or null where it takes the
 * block as content (markdown.py:105-139):
 *
 * - no TITLE_PATTERN match: no front matter, null (markdown.py:105-113);
 * - the block loads as a mapping with a `title` whose PyYAML type is `str`:
 *   that string (markdown.py:126-129);
 * - with a `title` of any other type: the pattern's capture, stripped, the
 *   text as typed (markdown.py:135);
 * - otherwise, the block failing to load or not a mapping carrying `title`:
 *   the pattern's capture as it stands (markdown.py:139).
 *
 * Whether the block loads and whether its title is a string are decided by
 * `safeLoadTitle` (yaml.server.ts), a port of PyYAML's SafeLoader whose
 * comment lists the divergences it does not model.
 */
function layerBlockTitle(block: string): string | null {
  const text = block.replace(/\r\n?/g, "\n");
  const match = text.match(LAYER_TITLE_PATTERN);
  if (!match) return null;
  const captured = match[1];
  const loaded = safeLoadTitle(text);
  if (!loaded.loads || loaded.title === undefined) return captured;
  return loaded.title.isString ? loaded.title.text : pythonStrip(captured);
}

/**
 * A layer's title and body, split as the framework's `_split_frontmatter`
 * splits them (the framework's scripts/telar/markdown.py:64-139), for layer
 * files and inline layer cells alike (markdown.py:201, :238).
 *
 * - No leading block matching FRONTMATTER_PATTERN: no title, and the whole
 *   text stripped is the body (markdown.py:99-101).
 * - A block without a `title:` line: no title, and the whole text stripped,
 *   block included, is the body. The framework shows such a block as content
 *   (markdown.py:105-113).
 * - A block with one: its title as `layerBlockTitle` reads it, and the text
 *   after the block stripped (markdown.py:104, :126-139).
 *
 * Stripping is `str.strip()`, so `pythonStrip`. Pages do not come here: their
 * title is `readFrontmatterTitle`'s.
 *
 * An empty title is `undefined` rather than `""`: every Compositor-published
 * layer file carries a block, `title: ""` for an untitled layer, and such a
 * layer must import back with no title rather than with an empty one. An
 * empty body is `undefined` for the same reason.
 */
function extractFrontmatterTitle(
  content: string | undefined
): { title: string | undefined; body: string | undefined } {
  if (!content) return { title: undefined, body: undefined };
  const match = content.match(LAYER_FRONTMATTER);
  const title = match ? layerBlockTitle(match[1]) : null;
  if (!match || title === null) {
    return { title: undefined, body: pythonStrip(content) || undefined };
  }
  return {
    title: title !== "" ? title : undefined,
    body: pythonStrip(match[2]) || undefined,
  };
}

/**
 * The front matter block of a layer's text, as the import splits it (the
 * framework's FRONTMATTER_PATTERN and TITLE_PATTERN gate, both ported as
 * patterns above), or null where the import reads the whole text as content.
 * Only the split is decided here; nothing about what the block means.
 */
export function layerFrontmatterBlock(content: string | undefined): string | null {
  if (!content) return null;
  const match = content.match(LAYER_FRONTMATTER);
  if (!match) return null;
  return LAYER_TITLE_PATTERN.test(match[1].replace(/\r\n?/g, "\n")) ? match[1] : null;
}

// Layer-content columns whose cell MAY be a filename reference rather than
// inline prose. `layerN_file` is the legacy alias the framework still accepts.
const LAYER_FILE_REFERENCE_COLUMNS = [
  "layer1_content",
  "layer2_content",
  "layer1_file",
  "layer2_file",
];

/**
 * Decide whether a layer-content cell names an on-disk markdown file.
 *
 * Framework rule: Telar's story-CSV processor treats a `layerN_content` /
 * `layerN_file` cell as a FILENAME when its trimmed value ends in `.md`
 * (case-sensitive), and as inline markdown otherwise. A filename that tries to
 * escape the texts directory — containing `..`, starting with `/`, or holding a
 * backslash — is rejected and handled as inline content instead, so a crafted
 * cell can never read an arbitrary repo path. The detection is deliberately
 * conservative: only a `.md` suffix flips a cell to file mode, so hand-authored
 * inline prose is never misread as a filename.
 */
export function isLayerFileReference(cell: string | undefined): boolean {
  if (!cell) return false;
  const trimmed = pythonStrip(cell);
  if (!trimmed.endsWith(".md")) return false;
  if (trimmed.includes("..") || trimmed.startsWith("/") || trimmed.includes("\\")) {
    return false;
  }
  return true;
}

/**
 * `read`, asked for each name once however often it is given it: a layer file
 * named by several cells, or by several stories, is one request for the whole
 * import, restore, check or accept that holds the reader.
 */
export function readOncePerName<T>(read: (name: string) => Promise<T>): (name: string) => Promise<T> {
  const reads = new Map<string, Promise<T>>();
  return (name) => {
    const known = reads.get(name);
    if (known) return known;
    const pending = read(name);
    reads.set(name, pending);
    return pending;
  };
}

/**
 * Resolve filename-referencing layer-content cells to the referenced file's
 * contents, in place, before the rows reach {@link mapStoryCsv}.
 *
 * Compositor publish writes the layer markdown to
 * `telar-content/texts/stories/{filename}.md` and stores only the FILENAME in
 * the `layerN_content` CSV cell. Without this pass, `mapStoryCsv` would treat
 * that filename string as inline content and store the literal filename as the
 * panel body — corrupting any compositor-published or file-based hand-authored
 * site on re-import. Here we mirror the framework: for each cell that names a
 * file, fetch it and substitute its contents (frontmatter + body) so the
 * downstream frontmatter split sees the real panel markdown.
 *
 * Error posture: a missing referenced file degrades exactly as the framework
 * degrades — the cell is left untouched and handled as inline content (yielding
 * the filename string, same as before this fix) rather than aborting the
 * import. This matches the importer's other missing-file paths, which skip a
 * file and continue rather than throwing the whole import away.
 *
 * Returns a shallow-cloned row array; only file-reference cells are rewritten,
 * so inline cells pass through byte-for-byte.
 *
 * Fetches run sequentially, one cell at a time: a burst of parallel requests
 * on a large import risks GitHub's secondary rate limit, and a rate-limited
 * fetch is indistinguishable from a missing file (both surface as null) — so
 * parallelism could degrade VALID references to literal filenames, the exact
 * corruption this pass exists to prevent. `fetchStoryText` answers null for a
 * missing file only and throws on a failed read, so a rate-limited fetch
 * refuses the import rather than degrading a reference. The repo fetch is
 * exact-case while the framework resolves filenames case-insensitively, so a
 * casing-mismatched reference degrades here even though the framework would
 * still build it.
 */
export async function resolveLayerFileReferences(
  rows: Record<string, string>[],
  fetchStoryText: (filename: string) => Promise<string | null>,
): Promise<Record<string, string>[]> {
  const out: Record<string, string>[] = [];
  for (const row of rows) {
    let resolved: Record<string, string> | null = null;
    for (const col of LAYER_FILE_REFERENCE_COLUMNS) {
      const cell = row[col];
      if (!isLayerFileReference(cell)) continue;
      const fileContent = await fetchStoryText(pythonStrip(cell));
      // Missing file → leave the cell as-is, degrading to inline handling.
      if (fileContent === null) continue;
      if (resolved === null) resolved = { ...row };
      resolved[col] = fileContent;
    }
    out.push(resolved ?? row);
  }
  return out;
}

/**
 * A layer as story.csv states it, before D1 has numbered the step it belongs to.
 *
 * `step_id` is deliberately ABSENT rather than holding a placeholder. A
 * placeholder is exactly what went wrong: a layer used to carry its step's
 * index within its story, and `importRepo` resolved that against a map keyed by
 * story index — so a step index was read as a story index. Panels landed on
 * whichever story happened to sit at that position, and every panel past the
 * project's story count was dropped, which for a single-story site meant losing
 * every panel except those on its first step.
 *
 * Leaving the column out means the compiler refuses a layer whose step has not
 * been resolved. That is the guarantee the arithmetic could not give: the wrong
 * state is no longer representable rather than merely currently-avoided.
 *
 * The parent travels ON the layer rather than in a second array keyed
 * alongside it. Two structures that must stay in lockstep are the same defect
 * one step later.
 */
export type MappedLayer = Omit<typeof layers.$inferInsert, "step_id"> & {
  /**
   * The story key this layer's step belongs to — the same value the step's own
   * `story_id` carries, so a layer resolves through the identical key its step
   * does. That shared key is the invariant; anything else is arithmetic.
   */
  storyPlaceholder: number;
  /** The step's own `step_number`: what story.csv states and what D1 stores. */
  stepNumber: number;
  /**
   * The step's 0-based position among the story's rows.
   *
   * Not the same as `stepNumber - 1`: the number comes from the CSV's `step`
   * cell when it states one, so a sheet whose rows are not 1..N in order has a
   * number that differs from its position. Both are here because two consumers
   * want different ones — D1 pairs by the number it stores, and the Durable
   * Object's restore path threads layers by position into the step array it was
   * handed. Deriving either from the other is where the pairing goes wrong.
   */
  stepIndex: number;
};

/**
 * Pair each mapped layer with the D1 step that stated it.
 *
 * Extracted and exported so it can be tested against the real resolution rather
 * than against a reimplementation of it. Inline, the only way to reach this
 * logic was a full import with GitHub and a database behind it, so the
 * arithmetic that mis-paired every panel ran untested for as long as it existed.
 *
 * A layer resolves through the SAME key its step does — `storyPlaceholder`, the
 * value the caller passed to `mapStoryCsv` and which the step carries as
 * `story_id` — and then matches on the step's own `step_number`, the value D1
 * stores. Both halves used to be wrong: the key was the step's index read as a
 * story index, and the match was a position in a sorted list.
 *
 * A layer whose story or step cannot be found is DROPPED, not attached
 * elsewhere. That is the honest failure: a story that never inserted has no id
 * to pair against, and putting its panels on some other story is the defect this
 * replaces.
 *
 * Two steps of one story stating the same `step_number` is possible from a
 * malformed sheet; the first match wins, which is ambiguity in the source rather
 * than in the pairing.
 */
export function pairLayersWithSteps(
  mapped: MappedLayer[],
  storyDbIdByPlaceholder: Map<number, number>,
  insertedSteps: Array<{ id: number; story_id: number; step_number: number }>,
): Array<typeof layers.$inferInsert> {
  const paired: Array<typeof layers.$inferInsert> = [];
  for (const layer of mapped) {
    const storyId = storyDbIdByPlaceholder.get(layer.storyPlaceholder);
    if (storyId === undefined) continue;
    const step = insertedSteps.find(
      (s) => s.story_id === storyId && s.step_number === layer.stepNumber,
    );
    if (!step) continue;

    // Destructured out rather than whitelisted back in: these three are the only
    // non-column keys on a MappedLayer, so every present and future column flows
    // through and none of them can reach D1.
    const {
      storyPlaceholder: _story,
      stepNumber: _number,
      stepIndex: _index,
      ...columns
    } = layer;
    paired.push({
      ...columns,
      step_id: step.id,
      // Always the import's: the template's starter story ships its layer cells
      // empty, so a layer under it is content somebody added.
      created_by_actor: AUTHOR_ACTORS.imported,
    });
  }
  return paired;
}

// Matches an ASCII-digit integer cell ("3", "+3", "-1") — the shape the
// framework's `int(float(x))` truncates to itself, so its outcome is
// certain: unchanged if >= 1, cleared if < 1.
const PAGE_ASCII_INTEGER = /^[+-]?\d+$/;

// Matches an ASCII-digit decimal cell ("3.5", "-.5") — the shape the
// framework's `int(float(x))` truncates toward zero, so the resulting
// integer is certain even though the stored text is not changed to match.
const PAGE_ASCII_DECIMAL = /^[+-]?\d*\.\d+$/;

// Plain ASCII whitespace only — deliberately not `String.prototype.trim()`,
// which also strips U+FEFF (BOM) as whitespace. Python's `str.strip()`
// does not: `float(" 3 ")` succeeds but `float("﻿3﻿")` still
// raises. Using the native trim here would silently resolve a BOM-padded
// cell to a clean ASCII integer before the classification below ever
// saw the BOM — exactly the kind of invented parity this function
// exists to avoid.
const PAGE_ASCII_EDGE_WHITESPACE = /^[ \t\n\r]+|[ \t\n\r]+$/g;

/**
 * Predicts, but does not enforce, what the framework's build-time
 * `_validate_page_column` (stories.py) will do with a raw `page` cell —
 * and warns only where that prediction is certain.
 *
 * The value itself is never rewritten: the raw cell, with only plain
 * ASCII whitespace trimmed from its edges, is what gets stored. Python's
 * `float()` and JavaScript's `Number()` read numeric text on
 * incompatible grammars — `float()` accepts Unicode
 * decimal digits (`٣`) and underscore-grouped digits (`1_0`) that
 * `Number()` rejects, and refuses radix prefixes (`0x10`, `0b11`,
 * `0o10`) that `Number()` accepts — so no JavaScript rewrite of the cell
 * can claim to match what the framework's `int(float(x))` will do with
 * it. Predicting the outcome and warning about it is safe in a way that
 * rewriting the value is not: a wrong prediction costs a spurious or
 * missing warning, never corrupted data.
 *
 * A warning fires only for the two shapes where a plain reading of the
 * cell is unambiguous regardless of which language's grammar reads it:
 *
 * - An ASCII-digit integer below 1 (`0`, `-1`): the framework clears any
 *   page below 1, and there is no reading of an ASCII integer under which
 *   that is in doubt.
 * - An ASCII-digit decimal (`3.5`): whatever else is true of the cell,
 *   `int(float("3.5"))` is `3`, so the truncated integer is named even
 *   though the text stored is still "3.5" — this function predicts, it
 *   does not normalize.
 *
 * Every other non-empty shape — Unicode decimal digits (`٣`, `３`),
 * underscore separators (`1_0`), radix prefixes (`0x10`, `0b11`, `0o10`),
 * BOM-wrapped digits, or trailing garbage (`3abc`) — is stored as written
 * and left SILENT, on purpose. We cannot predict Python's `float()`
 * grammar from JavaScript's `Number()`/regex reading of the same cell:
 * `٣` is a valid Python page (3) that no ASCII-anchored check here can
 * confirm, and `0x10` is a JavaScript-parseable 16 that Python's `float()`
 * refuses outright — asserting a warning in either direction would be
 * exactly the fabricated-parity mistake this correction exists to undo.
 * The framework's own build already reports what it clears; silence here
 * is a decision, not an omission.
 *
 * An empty or whitespace-only cell stays silent, same as an absent column
 * (`raw === undefined` — every row gets every declared column, see
 * `parseTelarCsv`, so an absent key is a file-wide absence, not a blank
 * cell). Both mean the same thing: this step does not name a page, the
 * ordinary case for every object that is not multi-page.
 */
function normalizeImportedPage(
  raw: string | undefined,
  stepNumber: number,
  onWarning?: SheetIssueHandler,
): string | undefined {
  if (raw === undefined) return undefined;

  const trimmed = raw.replace(PAGE_ASCII_EDGE_WHITESPACE, "");
  if (trimmed === "") return undefined; // ordinary "no page named" case — silent

  if (PAGE_ASCII_INTEGER.test(trimmed)) {
    if (Number(trimmed) < 1) {
      onWarning?.({ code: "page_below_one", step: stepNumber, value: raw });
    }
    return trimmed;
  }

  if (PAGE_ASCII_DECIMAL.test(trimmed)) {
    const truncated = Math.trunc(Number(trimmed));
    onWarning?.({ code: "page_truncated", step: stepNumber, value: raw, readAs: truncated });
    return trimmed;
  }

  // Deliberately silent — see the function comment. Named examples: `٣`
  // (a valid Python page we have no way to confirm) and `0x10` (a value
  // JavaScript can parse but Python's float() refuses).
  return trimmed;
}

/**
 * Coerces a raw `x`/`y`/`zoom` cell to the number it represents, or drops
 * it when the cell cannot be read as one.
 *
 * Uses `parseFloat`, not `Number`: the framework's browser consumer reads
 * these cells with `parseFloat`, so matching it is what keeps rendering
 * unchanged (`parseFloat("0x10")` is `0`, which is what a site already
 * renders for that cell; `Number("0x10")` is `16`, which is not).
 *
 * Unlike `page`, the framework has no build-time validation to match
 * here: `_apply_coordinate_defaults` (stories.py) only fills empty or
 * `'nan'` cells with defaults (x=0.5, y=0.5, zoom=1) at BUILD time, and
 * applies no range check to whatever value is already there. So there is
 * no parity argument for this column beyond matching the browser
 * consumer above — the rule is the minimum needed so a non-numeric cell
 * does not bind `NaN`/`Infinity` into a D1 insert unguarded.
 *
 * - Empty, whitespace-only, or absent stays absent and SILENT — the
 *   ordinary "unset, defaults apply at build time" case, exactly like an
 *   empty page cell. The framework's 0.5/0.5/1 defaults are NOT
 *   materialized here: the framework fills those at build time, and
 *   writing them at import would put values into a published CSV the
 *   author never had.
 * - A non-empty cell that does not parse to a finite number (`NaN`,
 *   `Infinity`, `-Infinity`) is DROPPED and warned about, naming the
 *   step and the column.
 * - A finite value — however far outside any sensible range, e.g.
 *   `x: 5` or `zoom: -3` — is stored UNCHANGED. No clamping, no range
 *   check: the framework accepts these values and rendering must not
 *   change; inventing a bound here would be the same error as inventing
 *   a page upper bound.
 */
function normalizeImportedCoordinate(
  raw: string | undefined,
  stepNumber: number,
  column: "x" | "y" | "zoom",
  onWarning?: SheetIssueHandler,
): number | undefined {
  if (raw === undefined) return undefined;

  const trimmed = pythonStrip(raw);
  if (trimmed === "") return undefined;

  const parsed = parseFloat(trimmed);
  if (!Number.isFinite(parsed)) {
    onWarning?.({ code: "coordinate_invalid", step: stepNumber, column, value: raw });
    return undefined;
  }
  return parsed;
}

/**
 * A step's kept cells as the import records them: `"{}"` for a row with none,
 * since the row was read. So every story imported from a file is recorded
 * (`isUnrecorded`, kept-columns-capture.server.ts), and only a story imported
 * before steps kept their columns reads as never recorded.
 */
function stepKeptCells(extras: Record<string, string>): string {
  return extrasBlob(extras) ?? "{}";
}

/**
 * `firstStepIndex` is the place of `rows`' first step among the sheet's steps,
 * for a caller that maps a sheet a row at a time: a row with no step number
 * takes its place in the sheet, as it would mapped with the rest.
 *
 * A layer 1 with no text under a layer 2 that is a panel, titled as a
 * publish titles such a layer 1 when it has no title of its own
 * (`writtenLayers`, publish.server.ts), is read as having no title
 * (`readsAsUntitledLayer1`).
 */
export function mapStoryCsv(
  rows: Record<string, string>[],
  storyDbId: number,
  onWarning?: SheetIssueHandler,
  firstStepIndex = 0,
): { steps: Array<typeof steps.$inferInsert>; layers: MappedLayer[] } {
  const stepRows: Array<typeof steps.$inferInsert> = [];
  const layerRows: MappedLayer[] = [];

  // Filter out completely blank rows — rows where all meaningful fields are
  // empty and no kept column holds content. The framework keeps any row with a
  // non-empty cell (stories.py), so a row whose only content sits in a column
  // the Compositor does not map is still a step — unless that column is one
  // the framework drops first (see `hasStoryRowContent`).
  const nonBlankRows = rows
    .map((row) => ({ row, extras: collectExtraColumns(row, KNOWN_STORY_KEYS).extras }))
    .filter(({ row, extras }) => isStoryStepRow(row, extras));

  nonBlankRows.forEach(({ row, extras }, index) => {
    const place = firstStepIndex + index;
    const stepNumber = parseInt(row.step ?? String(place + 1), 10) || place + 1;
    // Derive kind from object column emptiness. Framework signal in
    // stories.csv is that an empty `object` column on a meaningful row marks
    // the step as a section card; any non-empty object means a media step.
    const objectTrimmed = pythonStrip(row.object ?? "");
    const stepKind: "media" | "section" = objectTrimmed === "" ? "section" : "media";
    const stepRow: typeof steps.$inferInsert = {
      story_id: storyDbId,
      step_number: stepNumber,
      kind: stepKind,
      object_id: row.object || undefined,
      x: normalizeImportedCoordinate(row.x, stepNumber, "x", onWarning),
      y: normalizeImportedCoordinate(row.y, stepNumber, "y", onWarning),
      zoom: normalizeImportedCoordinate(row.zoom, stepNumber, "zoom", onWarning),
      page: normalizeImportedPage(row.page, stepNumber, onWarning),
      question: row.question || undefined,
      answer: row.answer || undefined,
      alt_text: row.alt_text || undefined,
      clip_start: row.clip_start || undefined,
      clip_end: row.clip_end || undefined,
      loop: row.loop || undefined,
      extra_columns: stepKeptCells(extras),
    };
    stepRows.push(stepRow);

    // A layer names its parent by the story key its step carries and the step's
    // own step_number. Not by position: `stepNumber` comes from the CSV's `step`
    // cell when it states one, so a sheet whose rows are not 1..N in order has a
    // step_number that differs from its index, and matching on the index would
    // pair a panel with a different step.
    const parent = { storyPlaceholder: storyDbId, stepNumber, stepIndex: index };

    const layer1 = row.layer1_button || row.layer1_content ? extractFrontmatterTitle(row.layer1_content) : null;
    const layer2 = row.layer2_button || row.layer2_content ? extractFrontmatterTitle(row.layer2_content) : null;

    if (layer1) {
      layerRows.push({
        ...parent,
        layer_number: 1,
        title: readsAsUntitledLayer1(
          { title: layer1.title, content: layer1.body, button_label: row.layer1_button },
          layer2 && { title: layer2.title, content: layer2.body },
        )
          ? undefined
          : layer1.title,
        button_label: row.layer1_button || undefined,
        content: layer1.body,
      });
    }

    if (layer2) {
      layerRows.push({
        ...parent,
        layer_number: 2,
        title: layer2.title,
        button_label: row.layer2_button || undefined,
        content: layer2.body,
      });
    }
  });

  return { steps: stepRows, layers: layerRows };
}

// glossary.csv keys mapped to first-class D1 columns; any other column is
// preserved verbatim in `extra_columns` (custom-column passthrough).
export const KNOWN_GLOSSARY_KEYS = new Set([
  "term_id", "title", "definition", "related_terms", "kind",
]);

/**
 * Where this table's canonical name differs from the framework's for the same
 * group of spellings. Both tables rename the same headers together; they just
 * land on a different name, because the Compositor's own columns are named
 * differently (see COLUMN_NAME_MAPPING's header).
 *
 *   medium_genre -> medium      the framework never adopted the v1.0.0 rename
 *   private      -> protected   the Compositor renamed the protection column
 *
 * Stated as a translation rather than a second table so the two can only drift
 * in the targets named here, and the parity test below reads the framework's
 * file to prove even that much has not moved.
 */
const FRAMEWORK_TARGETS: Record<string, string> = {
  medium_genre: "medium",
  private: "protected",
};
Object.setPrototypeOf(FRAMEWORK_TARGETS, null);

/**
 * The one header the framework's table maps to itself. Identity entries are
 * dropped below because ours has 38 the framework does not, but the framework
 * has exactly this one, and it is not decorative: an entry present in the table
 * is a renameable spelling, so `Page` beside `página` collides there and would
 * not if this were missing. Kept as data, with the parity test proving the list
 * is complete.
 */
const FRAMEWORK_IDENTITY_HEADERS = ["page"];

/**
 * What the FRAMEWORK's `normalize_column_names` would rename each header to.
 *
 * Derived from this module's own table rather than transcribed: every entry has
 * its target translated through FRAMEWORK_TARGETS, and an entry whose target
 * then equals its key is dropped (bar FRAMEWORK_IDENTITY_HEADERS) — ours
 * carries 38 identity entries the framework does not, and an identity entry is
 * not neutral here. `Title` beside `título` collides only if `title` is a
 * renameable spelling; in the framework it is not, so the two stay distinct
 * columns and the build is fine. Predicting a rename the framework does not
 * make would refuse a file it accepts.
 *
 * Prediction only. Nothing imports through this map, so no header is renamed on
 * its account. `tests/import.server.test.ts` proves it equals the framework's
 * table entry for entry, reading the Python.
 */
export const FRAMEWORK_COLUMN_RENAMES: Record<string, string> = (() => {
  const map: Record<string, string> = Object.create(null);
  for (const [header, ownTarget] of Object.entries(COLUMN_NAME_MAPPING)) {
    const target = FRAMEWORK_TARGETS[ownTarget] ?? ownTarget;
    if (target === header) continue; // identity: the framework has no such entry
    map[header] = target;
  }
  for (const header of FRAMEWORK_IDENTITY_HEADERS) map[header] = header;
  return map;
})();

/**
 * What the framework's glossary readers rename each header to: the shared
 * table with the glossary's own aliases merged over it, as
 * `normalize_column_names(df, sheet_aliases=GLOSSARY_COLUMN_ALIASES)` merges
 * them (scripts/telar/glossary.py). `tipo` beside `kind` is one column there.
 * GLOSSARY_COLUMN_ALIASES' identity entry is left out, as the identity entries
 * of FRAMEWORK_COLUMN_RENAMES are: the framework's table has none for `kind`.
 */
export const FRAMEWORK_GLOSSARY_COLUMN_RENAMES: Readonly<Record<string, string>> = (() => {
  const map: Record<string, string> = Object.assign(Object.create(null), FRAMEWORK_COLUMN_RENAMES);
  for (const [header, target] of Object.entries(GLOSSARY_COLUMN_ALIASES)) {
    if (header !== target) map[header] = target;
  }
  return map;
})();

/**
 * The canonical names the framework's objects reader scopes its rename table
 * to — `OBJECT_FIELDS` in scripts/telar/csv_utils.py, passed from
 * `telar.core.csv_to_json` (scripts/telar/core.py:426, applied at :107).
 *
 * Stated in the framework's own namespace rather than derived from
 * `canonicalScopeFor`, because the two sets are not the same set: the
 * framework models `object_warning`, `media_type`, `is_featured_sample` and
 * five more the Compositor does not, so its list is a strict superset of the
 * sixteen names in OBJECTS_CANONICAL_SCOPE. A prediction made on the smaller
 * set would refuse a file the framework accepts. The parity test in
 * `tests/import.server.test.ts` reads the framework's own module to prove this
 * list has not moved.
 *
 * `medium_genre` and `private` are absent for the same reason FRAMEWORK_TARGETS
 * exists: the framework's names for those two fields are `medium` and
 * `protected`, and this list is read against FRAMEWORK_COLUMN_RENAMES' targets,
 * which are already translated.
 */
export const FRAMEWORK_OBJECT_FIELDS: ReadonlySet<string> = new Set([
  "object_id", "title", "creator", "period", "medium", "dimensions",
  "location", "credit", "thumbnail", "iiif_manifest", "source_url",
  "source", "object_warning", "object_warning_short", "year",
  "object_type", "subjects", "is_featured_sample", "_demo",
  "description", "featured", "alt_text",
  "media_type", "audio_duration", "audio_filesize", "audio_format",
]);

/**
 * What one framework reader does to a sheet's headers on the way to the
 * collision refusal. Two facts, held together because they belong to one
 * reader and a prediction needs both.
 *
 * `undefined` wherever this is taken stands for the reader that scopes nothing
 * and removes nothing.
 */
export interface FrameworkSheetReader {
  /**
   * The canonical names the reader scopes the rename table to — the
   * `canonical_fields` argument of `normalize_column_names`. A rename whose
   * target is outside it is skipped and the author's own header stands.
   * `null` is a reader that passes no scope, so every rename in the table
   * lands.
   */
  scope: ReadonlySet<string> | null;
  /**
   * Whether the reader drops instruction columns before it renames. The rule
   * is `col.startswith('#')` on the header as pandas holds it — quotes off,
   * no strip and no fold — so a leading space keeps a column in.
   */
  dropsInstructionColumns: boolean;
  /**
   * Whether the reader folds every column name to lower case and strips it
   * after the rename, so `Term_ID` is `term_id` (`read_glossary_sheet` at the
   * head; the published tag does not).
   */
  foldsCaseAfterRename?: boolean;
}

/**
 * The objects reader: scoped to OBJECT_FIELDS (scripts/telar/core.py:426,
 * applied at :107) and dropping instruction columns first (:97).
 */
export const FRAMEWORK_OBJECTS_READER: FrameworkSheetReader = {
  scope: FRAMEWORK_OBJECT_FIELDS,
  dropsInstructionColumns: true,
};

/**
 * The glossary reader (`read_glossary_sheet`, scripts/telar/glossary.py): no
 * scope, and instruction columns dropped before the rename. The published tag
 * keeps two such headers folding to one name as duplicates and drops both
 * afterwards, so neither release refuses them.
 */
export const FRAMEWORK_GLOSSARY_READER: FrameworkSheetReader = {
  scope: null,
  dropsInstructionColumns: true,
  foldsCaseAfterRename: true,
};

/**
 * The story reader: `telar.core.csv_to_json` again, called for a story sheet
 * with no `canonical_fields` (scripts/telar/core.py:506 on the test instance,
 * :103 at the published tag), so the whole rename table applies, and
 * instruction columns dropped before it (:112, :93).
 *
 * Not STORY_CANONICAL_SCOPE: that is how the Compositor parses the sheet, and
 * the framework renames more than it. Two kept columns `titulo` and `title`
 * are two columns here and one there.
 */
export const FRAMEWORK_STORIES_READER: FrameworkSheetReader = {
  scope: null,
  dropsInstructionColumns: true,
};

/**
 * The framework's `COLUMN_NAME_MAPPING` at the published tag
 * (PUBLISHED_FRAMEWORK_TAG, v1.7.0), entry for entry, in the framework's own
 * names (`medium`, `protected`).
 *
 * A literal table rather than one derived from COLUMN_NAME_MAPPING: it
 * describes a release that no longer changes, and the head has since added
 * spellings it lacks (`crédito`, `descripción`, `ubicación`, `subtítulo`,
 * `privado`, `protegido`, `tipo`). A site on the tag reads a column headed
 * `crédito` as a column of that name, not as `credit`. The parity test in
 * `tests/import.server.test.ts` reads the tag's module to prove this table
 * has not drifted from it; moving the tag fails that test until the table is
 * replaced.
 */
export const PUBLISHED_TAG_COLUMN_RENAMES: Readonly<Record<string, string>> = Object.assign(
  Object.create(null) as Record<string, string>,
  {
    paso: "step", objeto: "object", pregunta: "question", respuesta: "answer",
    boton_capa1: "layer1_button", boton1: "layer1_button", contenido_capa1: "layer1_content",
    contenido1: "layer1_content", archivo_capa1: "layer1_content", boton_capa2: "layer2_button",
    boton2: "layer2_button", contenido_capa2: "layer2_content", contenido2: "layer2_content",
    archivo_capa2: "layer2_content", inicio_clip: "clip_start", fin_clip: "clip_end", bucle: "loop",
    texto_alt: "alt_text", pagina: "page", "página": "page", page: "page",
    layer1_file: "layer1_content", layer2_file: "layer2_content", id_objeto: "object_id",
    titulo: "title", descripcion: "description", url_fuente: "source_url", creador: "creator",
    periodo: "period", medio: "medium", dimensiones: "dimensions", ubicacion: "source",
    credito: "credit", miniatura: "thumbnail", "año": "year", ano: "year", tipo_objeto: "medium",
    object_type: "medium", medium_genre: "medium", medio_genero: "medium", temas: "subjects",
    materias: "subjects", materia: "subjects", destacado: "featured", fuente: "source",
    location: "source", orden: "order", id_historia: "story_id", subtitulo: "subtitle",
    firma: "byline", private: "protected", privada: "protected", protegida: "protected",
    mostrar_secciones: "show_sections", id_termino: "term_id", "id_término": "term_id",
    "título": "title", "definición": "definition", definicion: "definition",
    "términos_relacionados": "related_terms", terminos_relacionados: "related_terms",
  },
);

/**
 * The published tag's reader for every sheet: `csv_to_json` there takes no
 * `canonical_fields`, so the whole table applies, and it drops instruction
 * columns before it renames (scripts/telar/core.py:93 at the tag).
 */
export const PUBLISHED_TAG_READER: FrameworkSheetReader = {
  scope: null,
  dropsInstructionColumns: true,
};

/** One framework release's reading of a sheet's headers: its rename table and its reader. */
export interface FrameworkRelease {
  renames: Readonly<Record<string, string>>;
  reader: FrameworkSheetReader;
}

/**
 * The releases a published objects.csv has to be read correctly by: the
 * published tag and the head. A header written for a fixed column has to name
 * that column in both.
 */
export const FRAMEWORK_OBJECTS_RELEASES: readonly FrameworkRelease[] = [
  { renames: PUBLISHED_TAG_COLUMN_RENAMES, reader: PUBLISHED_TAG_READER },
  { renames: FRAMEWORK_COLUMN_RENAMES, reader: FRAMEWORK_OBJECTS_READER },
];

/**
 * The project.csv reader: `csv_to_json` with no `canonical_fields`, then
 * `process_project_setup`, instruction columns dropped before the rename.
 */
export const FRAMEWORK_PROJECT_READER: FrameworkSheetReader = {
  scope: null,
  dropsInstructionColumns: true,
};

/** The releases a published glossary.csv has to be read correctly by (see FRAMEWORK_OBJECTS_RELEASES). */
export const FRAMEWORK_GLOSSARY_RELEASES: readonly FrameworkRelease[] = [
  { renames: PUBLISHED_TAG_COLUMN_RENAMES, reader: PUBLISHED_TAG_READER },
  { renames: FRAMEWORK_GLOSSARY_COLUMN_RENAMES, reader: FRAMEWORK_GLOSSARY_READER },
];

/** The releases a published project.csv has to be read correctly by (see FRAMEWORK_OBJECTS_RELEASES). */
export const FRAMEWORK_PROJECT_RELEASES: readonly FrameworkRelease[] = [
  { renames: PUBLISHED_TAG_COLUMN_RENAMES, reader: PUBLISHED_TAG_READER },
  { renames: FRAMEWORK_COLUMN_RENAMES, reader: FRAMEWORK_PROJECT_READER },
];

/** The releases a published story CSV has to be read correctly by (see FRAMEWORK_OBJECTS_RELEASES). */
export const FRAMEWORK_STORIES_RELEASES: readonly FrameworkRelease[] = [
  { renames: PUBLISHED_TAG_COLUMN_RENAMES, reader: PUBLISHED_TAG_READER },
  { renames: FRAMEWORK_COLUMN_RENAMES, reader: FRAMEWORK_STORIES_READER },
];

/**
 * The name `renames` gives a folded header under `reader`, or undefined when
 * the table has no entry for it or the reader's scope does not admit the
 * target. `reader` undefined is the reader that scopes nothing.
 */
export function frameworkRenameOf(
  folded: string,
  renames: Readonly<Record<string, string>>,
  reader?: FrameworkSheetReader,
): string | undefined {
  if (!Object.hasOwn(renames, folded)) return undefined;
  const target = renames[folded];
  return reader === undefined || reader.scope === null || reader.scope.has(target) ? target : undefined;
}

/**
 * The column name one framework release gives `header`: the rename target
 * when its table renames the folded header and the reader's scope admits it,
 * otherwise the header as pandas read it, NUL bytes out. Both releases look a
 * header up by `col.lower().strip()` and leave one they do not rename as it
 * was, so `Step` stays `Step` and is not the `step` column, except where the
 * reader folds every name after renaming (`foldsCaseAfterRename`).
 */
export function frameworkColumnName(
  header: string,
  renames: Readonly<Record<string, string>>,
  reader?: FrameworkSheetReader,
): string {
  const text = sanitizeHeaderCell(header);
  const named = frameworkRenameOf(foldHeader(text), renames, reader) ?? text;
  return reader?.foldsCaseAfterRename ? foldHeader(named) : named;
}

/**
 * Whether `release` reads the header text `text` as the column `name`: the
 * column it names `name`, under that release's renames and reader.
 */
export function readsAsColumn(release: FrameworkRelease, text: string, name: string): boolean {
  const { renames, reader } = release;
  return frameworkColumnName(text, renames, reader) === frameworkColumnName(name, renames, reader);
}

/** A sheet the publish writes in its file's own layout. */
export type CsvSheetKind = "objects" | "story" | "project" | "glossary";

/**
 * One kind of sheet as the publish layout reads it (sheet-csv-layout.server.ts):
 * its fixed columns, the import's scope for it, the framework releases that
 * read the published file, the names it never writes (objects'
 * `iiif_manifest`, which the import reads into `source_url`), and the kept
 * keys written under the file's own header (the glossary's `kind`).
 */
export function csvSheetFor(kind: CsvSheetKind): CsvSheet {
  const base = { neverWritten: new Set<string>(), projectSheet: false };
  switch (kind) {
    case "objects":
      return {
        ...base,
        fixedColumns: OBJECTS_CSV_COLUMNS,
        canonicalScope: OBJECTS_CANONICAL_SCOPE,
        releases: FRAMEWORK_OBJECTS_RELEASES,
        neverWritten: new Set(["iiif_manifest"]),
      };
    case "story":
      return { ...base, fixedColumns: STORY_CSV_COLUMNS, canonicalScope: STORY_CANONICAL_SCOPE, releases: FRAMEWORK_STORIES_RELEASES };
    case "project":
      return {
        ...base,
        fixedColumns: PROJECT_CSV_COLUMNS,
        canonicalScope: PROJECT_CANONICAL_SCOPE,
        releases: FRAMEWORK_PROJECT_RELEASES,
        projectSheet: true,
      };
    case "glossary":
      return {
        ...base,
        fixedColumns: GLOSSARY_CSV_COLUMNS,
        canonicalScope: GLOSSARY_CANONICAL_SCOPE,
        releases: FRAMEWORK_GLOSSARY_RELEASES,
        keepsFileHeader: new Set(["kind"]),
      };
  }
}

const SHEET_KIND_OF_SCOPE = new Map<ReadonlySet<string>, CsvSheetKind>([
  [OBJECTS_CANONICAL_SCOPE, "objects"],
  [STORY_CANONICAL_SCOPE, "story"],
  [PROJECT_CANONICAL_SCOPE, "project"],
  [GLOSSARY_CANONICAL_SCOPE, "glossary"],
]);

/** The sheet a parse under `canonicalScope` reads, or undefined for a scope no publish layout writes. */
export function csvSheetForScope(canonicalScope?: ReadonlySet<string>): CsvSheet | undefined {
  const kind = canonicalScope && SHEET_KIND_OF_SCOPE.get(canonicalScope);
  return kind ? csvSheetFor(kind) : undefined;
}

/**
 * The header a fixed column is written under: the file's own text, NUL bytes
 * out, when every release reads it as the column the English name is read as;
 * otherwise the English name. `Step` and `Object_ID` are read by both releases
 * as columns of those names, and `crédito` by the published tag as `crédito`.
 */
function writtenFixedHeader(releases: readonly FrameworkRelease[], cell: string, name: string): string {
  const text = cell.split("\u0000").join("");
  return releases.every((release) => readsAsColumn(release, text, name)) ? text : name;
}

/** A fixed column at a position of a sheet's file: its name, and the header written for it. */
export interface FixedColumnHeader {
  name: string;
  written: string;
}

/**
 * Per position of a sheet's header record `rawCells`, the fixed column the
 * publish layout writes there and the header it writes it under, or undefined
 * for a position that is no fixed column: a blank cell, a dropped column, a
 * custom or kept column. In project.csv the protection position is `private`.
 * `releases` are the readers the header has to name the column in.
 */
export function fixedColumnHeaders(
  sheet: CsvSheet,
  header: ImportedHeader,
  rawCells: readonly string[],
  releases: readonly FrameworkRelease[] = sheet.releases,
): (FixedColumnHeader | undefined)[] {
  return rawCells.map((cell, position) => {
    const name = fixedNameAt(sheet, header, position);
    return name === undefined ? undefined : { name, written: writtenFixedHeader(releases, cell ?? "", name) };
  });
}

/** The fixed column at `position`, in the layout's order of rules (sheet-csv-layout.server.ts). */
function fixedNameAt(sheet: CsvSheet, header: ImportedHeader, position: number): string | undefined {
  if (header.blankHeaderIndexes.has(position)) return undefined;
  if (position === header.protectionColumnIndex) return "private";
  const name = header.finalNames[position];
  if (name === undefined || header.droppedColumnIndexes.has(position)) return undefined;
  return sheet.fixedColumns.includes(name) ? name : undefined;
}

/**
 * The populated fixed columns of a sheet whose heading the framework's current
 * release reads as another column (`Step`, `Object_ID`, ` step `), in sheet
 * order: each heading as typed, NUL bytes out, and the name the publish writes
 * in its place. Taken from the layout's own walk (`fixedColumnHeaders`) under
 * the head release alone, so each is a heading the publish rewrites; one only
 * the published tag misreads (`crédito`) is rewritten too, and not named.
 */
export function misreadHeadings(
  sheet: CsvSheet,
  header: ImportedHeader,
  rawCells: readonly string[],
): { headers: string[]; names: string[] } {
  const headers: string[] = [];
  const names: string[] = [];
  fixedColumnHeaders(sheet, header, rawCells, sheet.releases.slice(-1)).forEach((fixed, i) => {
    const text = (rawCells[i] ?? "").split("\u0000").join("");
    if (fixed === undefined || !header.holdsValues[i] || fixed.written === text) return;
    headers.push(text);
    names.push(fixed.name);
  });
  return { headers, names };
}

/** A heading the publish rewrites, as typed, and the name it writes in its place. */
export interface HeaderRewrite {
  header: string;
  name: string;
}

/** The headings of `text`, a sheet's file, that the publish rewrites (`misreadHeadings`); none for a file with no readable header. */
export function misreadHeadingsIn(text: string, sheet: CsvSheet): HeaderRewrite[] {
  const rows = readCsvSourceRows(text)?.rows ?? [];
  const first = rows[0];
  if (first === undefined || first.rejected) return [];
  const header = importedHeader(rows.map((row) => row.cells), sheet.canonicalScope, sheet.projectSheet);
  const { headers, names } = misreadHeadings(sheet, header, first.cells);
  return headers.map((h, i) => ({ header: h, name: names[i] }));
}

/** Reports a sheet's misread headings once (`misreadHeadings`), for a sheet a publish layout writes. */
function warnHeaderSpelling(
  rawCells: string[],
  resolved: ResolvedTableHeader,
  canonicalScope: ReadonlySet<string> | undefined,
  onWarning: SheetIssueHandler | undefined,
  fromGoogleSheets: boolean | undefined,
): void {
  const sheet = csvSheetForScope(canonicalScope);
  if (!onWarning || !sheet) return;
  const { headers, names } = misreadHeadings(sheet, importedHeaderOf(resolved), rawCells);
  if (headers.length === 0) return;
  onWarning({ code: "header_spelling", headers, names, ...(fromGoogleSheets ? { fromGoogleSheets: true } : {}) });
}

/**
 * Groups of headers the framework would land on one column name. Each group is
 * returned with the author's own spellings, sorted, so a message can name
 * exactly what to reconcile.
 *
 * `reader` is the sheet's own consumer, and both of its facts move the answer.
 * The scope: `step` beside `paso` on an objects sheet, where `step` is no
 * object field, so the rename is skipped and both headers stand. The removal:
 * `#Note` beside `#note`, two columns the objects reader deletes before it
 * renames anything, so they never reach the refusal. A prediction made without
 * either warns at import and refuses at publish over a file that is fine.
 *
 * The prediction is of the framework HEAD's reader. The published tag scopes
 * nothing at all: it renames every alias on every sheet and is left holding two
 * columns of one name, so it builds the same file and `row.get("step")` returns
 * a Series rather than either value. The blocker's message speaks of the next
 * build failing, which is the head's behaviour; at the tag the same file loses
 * a value instead of stopping. `renames` is the table the prediction is made
 * with, HEAD's unless a caller asks after another release: the publish layout
 * asks after the published tag too, since a column it would write empty is
 * left out rather than lose the value of the one the tag reads it onto.
 *
 * The division of labour with the parse. `parseTelarCsv` gives every column a
 * declared name — the canonical target where this sheet's scope models it, the
 * header's own text otherwise — and resolves two columns that declare the SAME
 * name itself: it suffixes them where their header text is identical (`note`
 * beside `note` become `note`/`note_1`), or, where the name is canonical and
 * the texts differ (`title` beside `Title`, or beside `título`), keeps one
 * position by the collision rule in `chooseCollisionColumn` and drops the
 * others. Such a pair never reaches here, and does not need to: whichever
 * rule applied, the file it republishes carries one column per name and builds.
 *
 * What does reach here is columns whose DECLARED names differ and which the
 * framework nonetheless lands on one column. Both kinds are live:
 *
 *   - spellings this parse does not rename that FOLD together — `Note` beside
 *     `note`, which no table carries, so each keeps its own header and both
 *     sit in the extras blob as separate keys;
 *   - spellings that fold apart but which the FRAMEWORK's table maps together —
 *     `credit` beside `crédito` on a glossary sheet, where `credit` is no
 *     glossary field, so this parse leaves both alone while the framework's
 *     table, which is scoped to no sheet, renames one onto the other.
 *
 * Every header is folded — stripped as CPython strips and lowercased, because
 * the prediction is of what Python does to it — before the rename is applied,
 * renamed or not. `normalize_column_names` keeps an unrenamed header's
 * spelling, but nothing downstream does: `_generate_glossary_from_csv` runs
 * `df.columns.str.lower().str.strip()` over the whole frame before it, and
 * `_refuse_colliding_renames` folds unrenamed names too when it tests what a
 * canonical name is claimed by. The fold has to hold for the publish check's
 * input as well, which is the fixed column list plus every extras KEY a stored
 * blob carries — written by whatever import stored it, under no guarantee that
 * the fold covered its spelling then.
 *
 * What such a collision costs, measured on the framework 14 September with
 * `Note` beside `note` and with `credit` beside `crédito`: on the test instance
 * `normalize_column_names` calls `_refuse_colliding_renames`, which raises
 * `ColumnCollisionError`; it propagates uncaught out of
 * `generate_collections._generate_glossary_from_csv` and the build fails. (The
 * link-map reader `telar/glossary.py` catches the same error and silently loses
 * every term instead.) At the published tag the generator folds the whole frame
 * before the rename, so pandas is left holding two columns of one name: the
 * build succeeds and `row.get("note")` returns a Series rather than either
 * value.
 *
 * Both sheets that carry a passthrough blob are enforced on this, not the
 * glossary alone: `telar.core.csv_to_json` reaches the same
 * `_refuse_colliding_renames` for objects.csv, so `Nota` beside `nota` there
 * fails the test instance's build in the same way. `mapObjectsCsv` and
 * `mapGlossaryCsv` both warn at import, and `objects_colliding_columns` and
 * `glossary_colliding_columns` both refuse at publish. What differs is the
 * published tag: it folds the glossary frame and leaves objects.csv headers as
 * written, so an objects collision builds there and a glossary one does not.
 */
export function collidingHeaderGroups(
  headers: string[],
  reader?: FrameworkSheetReader,
  renames: Readonly<Record<string, string>> = FRAMEWORK_COLUMN_RENAMES,
): string[][] {
  // `headers` is a MULTISET — the caller passes the fixed columns and every
  // extras key, and an extras key spelled like a fixed column arrives twice.
  // Counting occurrences rather than distinct spellings is what catches that
  // case: two cells claim one column even though there is one spelling to name.
  const groups = new Map<string, { count: number; names: Set<string> }>();
  for (const header of headers) {
    if (reader?.dropsInstructionColumns && header.startsWith("#")) continue;
    const folded = foldHeader(header);
    const resulting = frameworkRenameOf(folded, renames, reader) ?? folded;
    const group = groups.get(resulting);
    if (group) {
      group.count += 1;
      group.names.add(header);
    } else {
      groups.set(resulting, { count: 1, names: new Set([header]) });
    }
  }
  return [...groups.values()]
    .filter((group) => group.count > 1)
    .map((group) => [...group.names].sort());
}

/**
 * Warns once for a sheet's populated instruction columns, naming each in the
 * author's own spelling.
 *
 * Notice only, on objects and glossary alike, and the column is kept: an author
 * may be heading a column `#` on purpose, to hold notes to themselves that the
 * site is not meant to show. What they cannot see without being told is that
 * the framework agrees with them — it deletes such a column before it reads a
 * single value (see `isInstructionColumnName`) — so a column filled in the
 * belief it would publish never reaches the site and nothing says why.
 */
function warnInstructionColumns(
  found: ReadonlySet<string>,
  onWarning?: SheetIssueHandler,
): void {
  if (!onWarning || found.size === 0) return;
  onWarning({ code: "instruction_column", columns: [...found].sort() });
}

/**
 * Warns once for a sheet whose columns the framework would read as one field,
 * naming each group in the author's own spellings.
 *
 * Notice only, and the same notice on objects and glossary alike: every column
 * is still captured, and the publish blockers (`objects_colliding_columns`,
 * `glossary_colliding_columns`) are what refuse. This just tells the author at
 * import rather than only at publish. A row's keys are every column the sheet
 * declares, so the first row names them all.
 *
 * `reader` is the sheet's own consumer: the objects reader scopes the rename
 * to `OBJECT_FIELDS` and drops instruction columns, and both glossary readers
 * do neither (scripts/generate_collections.py:321-325,
 * scripts/telar/glossary.py:76). `renames` is the table that consumer renames
 * with: the glossary's adds its own aliases (FRAMEWORK_GLOSSARY_COLUMN_RENAMES).
 */
function warnCollidingColumns(
  rows: Record<string, string>[],
  onWarning?: SheetIssueHandler,
  reader?: FrameworkSheetReader,
  renames: Readonly<Record<string, string>> = FRAMEWORK_COLUMN_RENAMES,
): void {
  if (!onWarning) return;
  const collisions = collidingHeaderGroups(rows.length > 0 ? Object.keys(rows[0]) : [], reader, renames);
  if (collisions.length === 0) return;
  onWarning({ code: "folded_columns", groups: collisions });
}

/**
 * The column warnings a mapper raises once for the whole sheet: the reserved
 * columns and the populated instruction columns its rows' extras held
 * (`collectExtraColumns`), and the columns `reader` folds together under
 * `renames`.
 */
function warnSheetColumns(
  rows: Record<string, string>[],
  reservedFound: ReadonlySet<string>,
  instructionFound: ReadonlySet<string>,
  onWarning?: SheetIssueHandler,
  reader?: FrameworkSheetReader,
  renames?: Readonly<Record<string, string>>,
): void {
  if (!onWarning) return;
  if (reservedFound.size > 0) onWarning({ code: "reserved_column", columns: [...reservedFound].sort() });
  warnInstructionColumns(instructionFound, onWarning);
  warnCollidingColumns(rows, onWarning, reader, renames);
}

/**
 * The column warnings `mapGlossaryCsv` raises for these rows, for a reader of
 * glossary.csv that builds its terms without mapping them (the sync's diff).
 */
export function checkGlossaryColumns(rows: Record<string, string>[], onWarning: SheetIssueHandler): void {
  const reservedFound = new Set<string>();
  const instructionFound = new Set<string>();
  for (const row of rows) {
    const { reserved, instruction } = collectExtraColumns(row, KNOWN_GLOSSARY_KEYS);
    for (const key of reserved) reservedFound.add(key);
    for (const key of instruction) instructionFound.add(key);
  }
  warnSheetColumns(rows, reservedFound, instructionFound, onWarning, FRAMEWORK_GLOSSARY_READER, FRAMEWORK_GLOSSARY_COLUMN_RENAMES);
}

/**
 * Maps parsed glossary.csv rows to the glossary_terms table insert shape.
 * `related_terms` is a framework column: a pipe-`|`-separated list of
 * related term_ids, stored verbatim as the cell string. Headers are normalised
 * upstream (Spanish `términos_relacionados`/`terminos_relacionados` →
 * `related_terms`), so the mapper reads `r.related_terms` directly.
 *
 * `onWarning`, when given, fires at most once for the whole sheet — not once
 * per row — naming every reserved column (see `RESERVED_COLUMN_NAMES`) found
 * anywhere in it. This is notice only: the column is still captured into
 * `extra_columns` exactly as any other custom column would be. The publish
 * blocker (`glossary_reserved_column` in `runPrePublishValidation`) is what
 * actually enforces the framework's refusal; this just tells the author
 * earlier, at import, rather than only at publish.
 *
 * A row the framework publishes no term from (`isHeldTermId`) maps to no term:
 * it stays in the file, and a publish writes it back where it was
 * (`heldGlossaryRows`, publish.server.ts). Its columns are still checked, since
 * the published file carries them.
 */
export function mapGlossaryCsv(
  rows: Record<string, string>[],
  onWarning?: SheetIssueHandler,
): Array<typeof glossary_terms.$inferInsert> {
  const reservedFound = new Set<string>();
  const instructionFound = new Set<string>();
  const mapped = rows.flatMap((r) => {
    // Custom-column passthrough: capture every column the mapper doesn't
    // consume first-class into extra_columns, so an author's own glossary
    // columns survive import → D1 and are written back out at publish.
    // `parseTelarCsv` has already trimmed every cell.
    const { extras, reserved, instruction } = collectExtraColumns(r, KNOWN_GLOSSARY_KEYS);
    for (const key of reserved) reservedFound.add(key);
    for (const key of instruction) instructionFound.add(key);
    if (isHeldTermId(r.term_id ?? "")) return [];
    return [{
      project_id: 0,
      term_id: r.term_id ?? "",
      title: r.title || undefined,
      definition: r.definition || undefined,
      related_terms: r.related_terms || undefined,
      kind: r.kind || undefined,
      extra_columns: Object.keys(extras).length > 0 ? JSON.stringify(extras) : undefined,
    }];
  });
  // The glossary reader renames with no scope, so every rename in its table
  // lands, the glossary's own aliases among them.
  warnSheetColumns(rows, reservedFound, instructionFound, onWarning, FRAMEWORK_GLOSSARY_READER, FRAMEWORK_GLOSSARY_COLUMN_RENAMES);
  return mapped;
}

// ---------------------------------------------------------------------------
// Main import orchestrator
// ---------------------------------------------------------------------------

/**
 * Imports a Telar repo into D1 content tables.
 *
 * Flow:
 * 1. Fetch _config.yml — validate it's a Telar site (check telar.version)
 * 2. Parse config fields, map to project_config
 * 3. Fetch the full recursive repo tree
 * 4. If google_sheets.enabled: import from Sheets (CRITICAL: if Sheets are
 *    inaccessible, return sheetsAccessError and abort — do NOT fall back to
 *    repo CSVs)
 * 5. Otherwise: import from repo CSVs (objects, project, story files)
 * 6. Scan tree for IIIF object directories
 * 7. Write everything to D1 via db.batch()
 * 8. Return structured ImportResult for the wizard to render
 */

/**
 * Cascade-delete every child row for a project, in dependency order, then
 * the project row itself. Issued as a single `db.batch([...])` for
 * atomicity (D1 documents batched statements as one transaction).
 *
 * Supersedes the prior 6-table enumeration with the
 * comprehensive 12-table cascade — adds
 * `project_pages` (FK to projects, populated by importRepo at line ~1046)
 * which the historical `rollbackProjectImport` body omitted. Without
 * this, deleting a project that had imported pages would leave orphan
 * rows in `project_pages`.
 *
 * Used by:
 *   - rollbackProjectImport (partial-import cleanup; legacy path)
 *   - The delete-project action
 *   - The reimportRepo wipe step
 */
export async function deleteProjectCascade(
  // biome-ignore lint/suspicious/noExplicitAny: drizzle DB type is route-scoped
  db: any,
  projectId: number,
): Promise<StaffCopy[]> {
  // Resolve dependent ids first so the cascade can run as a single atomic
  // batch — a worker evicted mid-cascade no longer leaves orphan rows.
  const storyIds = await db
    .select({ id: stories.id })
    .from(stories)
    .where(eq(stories.project_id, projectId));
  const ids = storyIds.map((s: { id: number }) => s.id);

  let stepIds: { id: number }[] = [];
  if (ids.length > 0) {
    stepIds = await db
      .select({ id: steps.id })
      .from(steps)
      .where(inArray(steps.story_id, ids));
  }

  // biome-ignore lint/suspicious/noExplicitAny: drizzle batch tuple typing
  const batchOps: any[] = orphanedStaffDelete(db, projectId);
  if (stepIds.length > 0) {
    batchOps.push(
      db
        .delete(layers)
        .where(inArray(layers.step_id, stepIds.map((s: { id: number }) => s.id))),
    );
  }
  if (ids.length > 0) {
    batchOps.push(db.delete(steps).where(inArray(steps.story_id, ids)));
  }
  batchOps.push(
    ...contributionDeletes(db, projectId),
    db.delete(glossary_terms).where(eq(glossary_terms.project_id, projectId)),
    db.delete(stories).where(eq(stories.project_id, projectId)),
    db.delete(objects).where(eq(objects.project_id, projectId)),
    db.delete(project_themes).where(eq(project_themes.project_id, projectId)),
    db.delete(project_landing).where(eq(project_landing.project_id, projectId)),
    db.delete(project_config).where(eq(project_config.project_id, projectId)),
    // project_pages — added to close an orphan-rows gap.
    // The legacy rollbackProjectImport body omitted this table; importRepo
    // populates it (line ~1046) so any rollback or delete that skipped it
    // left orphan rows.
    db.delete(project_pages).where(eq(project_pages.project_id, projectId)),
    db.delete(pending_object_ops).where(eq(pending_object_ops.project_id, projectId)),
    // The project's members keep their repository access: deleting or
    // unlinking a project records no withdrawal.
    db.delete(project_members).where(eq(project_members.project_id, projectId)),
    db.delete(project_invites).where(eq(project_invites.project_id, projectId)),
    db.delete(activity_log).where(eq(activity_log.project_id, projectId)),
    db.delete(projects).where(eq(projects.id, projectId)),
  );

  const [, orphaned] = await db.batch(batchOps);
  return orphaned as StaffCopy[];
}

/** An instructor row a course had copied onto one of its sites. */
export interface StaffCopy {
  projectId: number;
  userId: number;
}

/**
 * The statements a project delete runs first: the withdrawal of repository
 * access for the instructor rows on any site whose parent is the project being
 * deleted, then those rows' delete, which returns them so the caller can evict
 * those people from each site.
 *
 * A course's callers detach each site before deleting it
 * (`detachCourseChildren`); this catches a site that attached after that, in
 * the same transaction as the delete, so no site keeps staff standing from a
 * course that no longer exists. A site has no children, and the statement
 * matches nothing.
 */
// biome-ignore lint/suspicious/noExplicitAny: drizzle DB type is route-scoped
export function orphanedStaffDelete(db: any, projectId: number) {
  const orphaned = and(
    eq(project_members.role, "instructor"),
    inArray(
      project_members.project_id,
      db.select({ id: projects.id }).from(projects).where(eq(projects.parent_project_id, projectId)),
    ),
  );
  return [
    recordWithdrawals(db, orphaned),
    db.delete(project_members).where(orphaned).returning({ projectId: project_members.project_id, userId: project_members.user_id }),
  ];
}

/**
 * The contribution records a project holds. Both tables reference the project
 * with no delete action, so a project delete that left them would fail its own
 * foreign key and delete nothing.
 */
// biome-ignore lint/suspicious/noExplicitAny: drizzle DB type is route-scoped
export function contributionDeletes(db: any, projectId: number) {
  return [
    db.delete(entity_contributors).where(eq(entity_contributors.project_id, projectId)),
    db.delete(member_editing_time).where(eq(member_editing_time.project_id, projectId)),
  ];
}

/**
 * Rollback helper: cascade-delete every child row that may have been written
 * during a partial import, in dependency order, then delete the project row
 * itself. Exported so unit tests can record the delete-table sequence
 * directly. Mirrors the unlink cascade in app/routes/onboarding.tsx — keep
 * the two in sync.
 *
 * Now delegates to `deleteProjectCascade` (the shared helper).
 */
export async function rollbackProjectImport(
  // biome-ignore lint/suspicious/noExplicitAny: drizzle DB type is route-scoped
  db: any,
  projectId: number,
): Promise<void> {
  await deleteProjectCascade(db, projectId);
}

/**
 * Lets a sheet refusal, a tab changed since its columns were chosen, and a
 * repository file the branch could not read, out
 * of the Google Sheets branch's catch, which otherwise reads every failure as
 * a Sheet it could not reach.
 */
function rethrowImportRefusal(err: unknown, publishedSheetsUrl: string): void {
  if (err instanceof CollidingColumnsRefusal || err instanceof TabsChangedError) throw Object.assign(err, { publishedSheetsUrl });
  if (err instanceof SheetUnreadableError) throw err;
}

/**
 * The result the first import reports for a refused sheet. Nothing has been
 * written: the sheets are read before the project row is created.
 */
export function collidingColumnsImportResult(refusal: CollidingColumnsRefusal): ImportResult {
  return refusedImportResult({
    validationError: "colliding_columns",
    collidingColumns: {
      sheet: refusal.sheet,
      canonicalName: refusal.canonicalName,
      headers: refusal.headers,
    },
  });
}

/** What a refused first import reports: why, and nothing imported. */
export function refusedImportResult(
  refusal: Pick<
    ImportResult,
    "validationError" | "collidingColumns" | "sheetChoices" | "unreadableSheet" | "unreadableFile" | "defaultBranch" | "mainBranch"
  >,
): ImportResult {
  return {
    valid: false,
    ...refusal,
    project: { imported: false, storiesFound: 0 },
    objects: { imported: 0, skipped: 0, warnings: [] },
    stories: { imported: 0, warnings: [] },
    glossary: { imported: 0 },
    pages: { imported: 0 },
    themes: { imported: 0, list: [] },
    sheetsEnabled: false,
    sheetsDisabled: false,
    iiifObjectIds: [],
    audioObjectIds: [],
    videoObjectCount: 0,
    configFields: {},
    orphanStoryIds: [],
  };
}

/** The published Sheet's tabs, once `checkTabs` has found every tab the author chose columns in among them. */
function checkedTabs<T extends { name: string }>(tabs: T[], checkTabs: ImportParams["checkTabs"]): T[] {
  checkTabs?.(tabs.map((tab) => tab.name));
  return tabs;
}

/** The story ids project.csv registers, blank ones left out. */
function registeredStoryIds(storyRows: Array<typeof stories.$inferInsert>): Set<string> {
  return new Set(
    storyRows
      .map((r) => (r.story_id as string | undefined) ?? "")
      .filter((id) => pythonStrip(id) !== ""),
  );
}

/**
 * The commit whose objects.csv an import read, for `projects.objects_read_sha`:
 * the head it read at, from the repository branch only. An import from Google
 * Sheets builds its objects from the Sheet and never reads objects.csv, so it
 * records none.
 */
/** The stored flag is the build's reading of it: js-yaml reads `yes` and `on` as strings. */
function withBuildsSheetsFlag(configFields: Record<string, unknown>, enabled: boolean): void {
  if (configFields.google_sheets_enabled !== undefined) configFields.google_sheets_enabled = enabled;
}

function objectsReadAtImport(googleSheetsEnabled: boolean, head: string): string | null {
  return googleSheetsEnabled ? null : head;
}

/**
 * Reads a connected repo's site into a new project.
 *
 * Every sheet is read with `severalHoldValues: "refuse"`, so a sheet in which
 * two or more columns claim one canonical name and each holds values throws
 * `CollidingColumnsRefusal` before anything is written. The caller turns it
 * into a result with `collidingColumnsImportResult`.
 *
 * Every file, the tree, the pages scan and the orphan scan are read at one
 * commit, the head of the default branch resolved first (`importHead`), and
 * every file strictly (`readAtHead`). A missing file keeps its meaning at each
 * site: no `_config.yml`, or no default branch, is an empty repository; a
 * story file absent at one path is looked for at the next. A read that fails
 * throws `SheetUnreadableError` naming the file, and all reads come before the
 * first write, so a failed read seeds nothing: the seeded project is what the
 * next publish writes back, and a file taken as missing would be deleted there.
 */
export async function importRepo({
  token,
  installationId,
  repoFullName,
  userId,
  env,
  overrideGoogleSheetsUrl,
  origin = "imported",
  kind = "site",
  readTab = async (_name, text) => text,
  checkTabs,
}: ImportParams): Promise<ImportResult> {
  const [owner, repo] = repoFullName.split("/");
  const head = await importHead(token, owner, repo);
  if (typeof head !== "string") return head;

  // -------------------------------------------------------------------------
  // Step 1: Validate Telar site via _config.yml
  // -------------------------------------------------------------------------

  // `_config.yml` and `index.md` are read before the list the review step
  // shows is made, so what they report is held until then.
  const heldWarnings: SheetWarning[] = [];
  const configContent = await readAtHead(token, owner, repo, "_config.yml", head, { warnings: heldWarnings });

  if (configContent === null) {
    return {
      valid: false,
      validationError: "empty_repo",
      project: { imported: false, storiesFound: 0 },
      objects: { imported: 0, skipped: 0, warnings: [] },
      stories: { imported: 0, warnings: [] },
      glossary: { imported: 0 },
      pages: { imported: 0 },
      themes: { imported: 0, list: [] },
      sheetsEnabled: false,
      sheetsDisabled: false,
      iiifObjectIds: [],
      audioObjectIds: [],
      videoObjectCount: 0,
      configFields: {},
      orphanStoryIds: [],
    };
  }

  const config = parseYaml(configContent);
  const telarVersion = telarVersionOf(config);
  // The version ids are matched with, as every read of the repository takes
  // it (`siteVersionFromParsed`): the repository's own, and here no other.
  const siteVersion = siteVersionFromParsed(config, null);

  if (!telarVersion) {
    return {
      valid: false,
      validationError: "not_telar",
      project: { imported: false, storiesFound: 0 },
      objects: { imported: 0, skipped: 0, warnings: [] },
      stories: { imported: 0, warnings: [] },
      glossary: { imported: 0 },
      pages: { imported: 0 },
      themes: { imported: 0, list: [] },
      sheetsEnabled: false,
      sheetsDisabled: false,
      iiifObjectIds: [],
      audioObjectIds: [],
      videoObjectCount: 0,
      configFields: {},
      orphanStoryIds: [],
    };
  }

  // -------------------------------------------------------------------------
  // Step 2: Parse config fields
  // -------------------------------------------------------------------------

  const configFields = mapConfigToProjectConfig(config);
  const googleSheetsEnabled = isGoogleSheetsOn(configContent);
  withBuildsSheetsFlag(configFields, googleSheetsEnabled);
  const googleSheetsPublishedUrl =
    overrideGoogleSheetsUrl ||
    ((config.google_sheets as Record<string, unknown>)?.published_url as string) ||
    "";

  // -------------------------------------------------------------------------
  // Step 2b: Fetch and parse index.md for landing page data
  // -------------------------------------------------------------------------

  const indexContent = await readAtHead(token, owner, repo, "index.md", head, { warnings: heldWarnings });
  const landingData = parseIndexMd(indexContent);

  // -------------------------------------------------------------------------
  // Step 3: Fetch repo tree
  // -------------------------------------------------------------------------

  const { tree, truncated } = await getRepoTree(token, owner, repo, head);
  const treeWarnings: SheetWarning[] = [];
  if (truncated) {
    treeWarnings.push({ code: "tree_truncated" });
  }

  // -------------------------------------------------------------------------
  // Step 4: Discover IIIF objects
  // -------------------------------------------------------------------------

  // IIIF and audio detection happens after objectRows are populated (Step 4c below).
  const siteBase = configFields.url
    ? `${configFields.url}${configFields.baseurl ?? ""}`
    : null;
  let iiifObjectIds: string[] = [];
  // Probed in declaration order; the set is the one in `~/lib/file-types`, so a
  // site's audio object is recognised here on the same extensions the story
  // editor's media detection uses.
  const audioExtensions = [...AUDIO_EXTENSIONS];
  const audioObjectFiles = new Map<string, string>(); // objectId → filename

  // -------------------------------------------------------------------------
  // Step 4b: Discover themes from _data/themes/*.yml
  // -------------------------------------------------------------------------

  const themeFiles = tree.filter(
    (entry) =>
      entry.type === "blob" &&
      entry.path.startsWith("_data/themes/") &&
      entry.path.endsWith(".yml"),
  );

  const themeRows: Array<typeof project_themes.$inferInsert> = [];
  for (const entry of themeFiles) {
    const content = await readAtHead(token, owner, repo, entry.path, head);
    if (!content) continue;
    const parsed = parseYaml(content) as Record<string, unknown> | null;
    if (!parsed) continue;
    themeRows.push(mapThemeYaml(entry.path.split("/").pop()!.replace(/\.yml$/, ""), parsed));
  }

  // -------------------------------------------------------------------------
  // Step 5: Import content (Sheets or repo CSVs)
  // -------------------------------------------------------------------------

  let objectRows: Array<typeof objects.$inferInsert> = [];
  let storyRows: Array<typeof stories.$inferInsert> = [];
  const storyFileReads: OwedStoryFile[] = [];
  let stepRows: Array<typeof steps.$inferInsert> = [];
  let layerRows: MappedLayer[] = [];
  let glossaryRows: Array<typeof glossary_terms.$inferInsert> = [];
  let pageRows: ScannedPage[] = [];
  const objectWarnings: SheetWarning[] = [...heldWarnings, ...treeWarnings];
  const readReport: UnreadableReport = { warnings: objectWarnings };
  const readLayerFile = readOncePerName((filename: string) =>
    readAtHead(token, owner, repo, `telar-content/texts/stories/${filename}`, head, readReport),
  );
  /**
   * A malformed row is reported through `objects.warnings`, which is the
   * import's one channel a caller reads: `stories.warnings` is returned empty
   * whatever happens. Tree truncation already travels this way, so the channel
   * carries import-wide warnings, not only object ones — hence the sheet named
   * on every warning.
   */
  const warnRow = (source: string) => issuesFor(source, objectWarnings);
  let sheetsDisabled = false;
  let storiesFound = 0;

  if (googleSheetsEnabled) {
    // CRITICAL: if the Sheet is inaccessible, abort — do NOT fall back to CSVs
    try {
      const publishedId = googleSheetsPublishedUrl.match(/\/d\/e\/([a-zA-Z0-9-_]+)/)?.[1] ?? "";
      const tabs = checkedTabs(await discoverSheetTabs(googleSheetsPublishedUrl), checkTabs);
      // The framework's fetch writes each tab to its lowercased name, and the
      // build reads the project, objects and glossary sheets among those files.
      const { siteSheetRoles } = await import("~/lib/sheet-collision-repair.server");
      const roles = siteSheetRoles(tabs.map((tab) => `${tab.name.toLowerCase()}.csv`));

      // First pass: import objects, project, glossary tabs
      const storyTabs: Array<{ name: string; gid: string }> = [];
      for (const tab of tabs) {
        const role = roles.get(`${tab.name.toLowerCase()}.csv`);
        const csvText = await readTab(tab.name, await fetchSheetCsv(publishedId, tab.gid));
        // Each tab is read under its own sheet's scope, so a name that is
        // canonical on one is left as the author's own column on another.
        const rows = parseTelarCsv(
          csvText,
          warnRow(tab.name),
          role === "project",
          role === undefined ? undefined : SHEET_TAB_CANONICAL_SCOPES[role],
          { severalHoldValues: "refuse", sheetName: tab.name, fromGoogleSheets: true },
        );

        if (role === "objects") {
          objectRows = mapObjectsCsv(rows, undefined, warnRow(tab.name));
          reportSharedSiteIds(objectRows, siteVersion, warnRow(tab.name));
          objectRows = lastRowPerObjectId(objectRows);
        } else if (role === "project") {
          storyRows = mapProjectCsv(rows);
          storiesFound = storyRows.length;
        } else if (role === "glossary") {
          glossaryRows = publishedRowPerTermId(mapGlossaryCsv(rows, warnRow(tab.name)));
        } else {
          // Candidate story tab — collect for second pass
          storyTabs.push(tab);
        }
      }

      // Second pass: match remaining tabs to story_ids and import steps/layers
      const storyIds = new Set(storyRows.map((r) => (r.story_id as string).toLowerCase()));
      for (const tab of storyTabs) {
        if (storyIds.has(tab.name.toLowerCase())) {
          const csvText = await readTab(tab.name, await fetchSheetCsv(publishedId, tab.gid));
          const rows = parseTelarCsv(csvText, warnRow(tab.name), false, STORY_CANONICAL_SCOPE, {
            severalHoldValues: "refuse",
            sheetName: tab.name,
            fromGoogleSheets: true,
          });
          // Sheets cells are normally inline prose, but the framework's
          // filename rule is source-agnostic: a `.md`-suffixed cell references
          // a repo file. Resolve those against the repo too (missing files
          // degrade to inline), keeping both import branches framework-faithful.
          const resolvedRows = await resolveLayerFileReferences(
            rows,
            readLayerFile,
          );
          const storyIndex = storyRows.findIndex(
            (r) => (r.story_id as string).toLowerCase() === tab.name.toLowerCase(),
          );
          const { steps: mappedSteps, layers: mappedLayers } = mapStoryCsv(
            resolvedRows,
            -(storyIndex + 1), // placeholder — updated after D1 insert
            warnRow(tab.name),
          );
          stepRows.push(...mappedSteps);
          layerRows.push(...mappedLayers);
        }
      }

      sheetsDisabled = true; // Auto-disable after successful Sheets import
    } catch (err) {
      rethrowImportRefusal(err, googleSheetsPublishedUrl);
      // Sheet inaccessible — return error without falling back to repo CSVs
      return {
        valid: false,
        sheetsAccessError: true,
        sheetsPublishedUrl: googleSheetsPublishedUrl,
        project: { imported: false, storiesFound: 0 },
        objects: { imported: 0, skipped: 0, warnings: [] },
        stories: { imported: 0, warnings: [] },
        glossary: { imported: 0 },
        pages: { imported: 0 },
        themes: { imported: 0, list: [] },
        sheetsEnabled: true,
        sheetsDisabled: false,
        iiifObjectIds,
        audioObjectIds: [...audioObjectFiles.keys()],
        videoObjectCount: 0,
        configFields,
        orphanStoryIds: [],
      };
    }
  } else {
    // Import from repo CSVs, each sheet from the file the build reads. A site
    // with no objects sheet has no objects yet.
    const sheetAtHead = (path: string) => readAtHead(token, owner, repo, path, head, readReport);
    const objectsSheet = await readSiteSheet("objects", sheetAtHead);
    if (objectsSheet.content) {
      objectRows = mapObjectsCsv(
        parseTelarCsv(objectsSheet.content, warnRow(objectsSheet.name), false, OBJECTS_CANONICAL_SCOPE, {
          severalHoldValues: "refuse",
          sheetName: objectsSheet.name,
        }),
        undefined,
        warnRow(objectsSheet.name),
      );
      reportSharedSiteIds(objectRows, siteVersion, warnRow(objectsSheet.name));
      objectRows = lastRowPerObjectId(objectRows);
    }

    const projectSheet = await readSiteSheet("project", sheetAtHead);
    const projectContent = projectSheet.content;
    if (projectContent) {
      storyRows = projectCsvStoryRows(projectContent, warnRow(projectSheet.name));
      storiesFound = storyRows.length;

      // Find and import individual story CSV files from _data/ or root. Only a
      // file absent at one path is looked for at the next: a failed read throws.
      // The path read is recorded on the story (`source_path`): a publish
      // deletes an older copy only at the path the import read.
      for (const storyRow of storyRows) {
        const storyId = storyRow.story_id as string;
        const storyRead = await readStoryCsvAtHead(token, owner, repo, storyId, head, readReport);
        storyRow.source_path = storyRead.path;
        const storyContent = storyRead.content;
        storyFileReads.push(...(await storyFileRead(storyRead.path, storyRead.raw)));

        if (storyContent) {
          const storyStepRows = parseTelarCsv(storyContent, warnRow(`${storyId}.csv`), false, STORY_CANONICAL_SCOPE, {
            severalHoldValues: "refuse",
            sheetName: `${storyId}.csv`,
          });
          // Resolve any `layerN_content` cell that references a
          // texts/stories/*.md file to the file's contents before mapping,
          // so compositor-published (filename-in-cell) stories import their
          // real panel markdown rather than the literal filename string.
          const resolvedRows = await resolveLayerFileReferences(
            storyStepRows,
            readLayerFile,
          );
          const storyIndex = storyRows.indexOf(storyRow);
          const { steps: mappedSteps, layers: mappedLayers } = mapStoryCsv(
            resolvedRows,
            -(storyIndex + 1), // placeholder — updated after D1 insert
            warnRow(`${storyId}.csv`),
          );
          stepRows.push(...mappedSteps);
          layerRows.push(...mappedLayers);
        }
      }
    }

    const glossarySheet = await readSiteSheet("glossary", sheetAtHead);
    if (glossarySheet.content) {
      glossaryRows = publishedRowPerTermId(mapGlossaryCsv(
        parseTelarCsv(glossarySheet.content, warnRow(glossarySheet.name), false, GLOSSARY_CANONICAL_SCOPE, {
          severalHoldValues: "refuse",
          sheetName: glossarySheet.name,
        }),
        warnRow(glossarySheet.name),
      ));
    }

  }

  // ---- Pages import ----
  // Pages are `telar-content/texts/pages/*.md` in the repository, so they are
  // read whichever source the spreadsheets came from — a published Sheet
  // carries no pages and cannot stand in for the scan. Reuses scanRepoPages
  // (shared with the Pages editor's empty-state import variant), which
  // preserves the index-based order the navigation slot assignment relies on.
  const scannedPages = reduceScannedPages(await scanRepoPages(token, owner, repo, head, readReport), configFields.lang);
  for (const page of scannedPages.pages) {
    pageRows.push({
      title: page.title,
      slug: page.slug,
      body: page.body,
      frontmatter: page.frontmatter,
      order: page.order,
    });
  }

  // Detect {story_id}.csv files on GitHub not referenced by project.csv and
  // not user-ignored, for the orphan-stories banner. Read here, with every
  // other read, so a failed read of the ignore list seeds nothing. NO content
  // fetch here — lazy until user clicks "Restore as drafts". Skipped for
  // Google-Sheets-backed sites: those sites have no per-story CSV files in
  // telar-content/spreadsheets/ to scan.
  const orphanStoryIds = googleSheetsEnabled
    ? []
    : await scanRepoOrphanStoryIds(token, owner, repo, registeredStoryIds(storyRows), head);

  // -------------------------------------------------------------------------
  // Step 4c: Detect IIIF tiles and audio files, from the repository first
  // -------------------------------------------------------------------------
  // The build tiles the images in telar-content/objects and serves its audio
  // files as they are, so a file there settles its object without the site.
  // Tiles themselves are deployed by GitHub Actions to GitHub Pages and are
  // not in the repository: an object with no file there is probed on the live
  // site. A listing that cannot be read leaves every object to the probe.
  const selfHostedIds = objectRows
    .filter((o) => {
      const src = o.source_url as string | null;
      return !src || (!src.startsWith("http://") && !src.startsWith("https://"));
    })
    .map((o) => o.object_id as string);

  // The tiler builds nothing for a source beginning with "http" at all, so only
  // an object with no such source is settled by its file.
  const tiledFromFile = new Set(
    objectRows
      .filter((o) => !((o.source_url as string | null) ?? "").startsWith("http"))
      .map((o) => o.object_id as string),
  );
  const fromRepo = await objectMediaFromRepo(
    token, owner, repo, head, selfHostedIds.filter((id) => tiledFromFile.has(id)), siteVersion,
  );
  fromRepo.unsettled.push(...selfHostedIds.filter((id) => !tiledFromFile.has(id)));
  iiifObjectIds.push(...fromRepo.iiif);
  for (const [objectId, filename] of fromRepo.audio) audioObjectFiles.set(objectId, filename);

  if (siteBase && !isSafeSiteBase(siteBase)) {
    console.warn(
      `[import] skipping live-site probe: unsafe url/baseurl in _config.yml (${siteBase})`,
    );
  }
  if (siteBase && isSafeSiteBase(siteBase)) {
    const probeResults = await Promise.allSettled(
      fromRepo.unsettled.map(async (objectId) => {
        if (!isSafeObjectId(objectId)) {
          console.warn(`[import] skipping probe for unsafe object_id: ${objectId}`);
          return { objectId, type: "unknown" as const };
        }
        // The site publishes an object's tiles and serves its audio under the
        // id it gives the object.
        const siteId = siteObjectId(objectId, siteVersion);
        const safeId = encodeURIComponent(siteId);

        // Check IIIF tiles
        try {
          const tileRes = await fetch(`${siteBase}/iiif/objects/${safeId}/info.json`, { method: "HEAD" });
          if (tileRes.ok) return { objectId, type: "iiif" as const };
        } catch { /* site unreachable */ }

        // Check audio files
        for (const ext of audioExtensions) {
          try {
            const audioRes = await fetch(`${siteBase}/telar-content/objects/${safeId}.${ext}`, { method: "HEAD" });
            if (audioRes.ok) return { objectId, type: "audio" as const, filename: `${siteId}.${ext}` };
          } catch { /* site unreachable */ }
        }

        return { objectId, type: "unknown" as const };
      }),
    );

    for (const result of probeResults) {
      if (result.status !== "fulfilled") continue;
      const { objectId, type } = result.value;
      if (type === "iiif") iiifObjectIds.push(objectId);
      if (type === "audio") audioObjectFiles.set(objectId, (result.value as { filename: string }).filename);
    }
  }

  // Mark image availability and media type hints
  objectRows = objectRows.map((obj) => {
    const objectId = obj.object_id as string;
    const hasSelfHostedTiles = iiifObjectIds.includes(objectId);
    const hasExternalManifest = !!(obj.source_url && /manifest/.test(obj.source_url as string));
    const audioFilename = audioObjectFiles.get(objectId);
    return {
      ...obj,
      // For audio objects without a source_url, store the filename so
      // detectMediaType can identify the media type from the extension.
      // Use empty string fallback (not undefined) to ensure Drizzle writes it.
      source_url: (obj.source_url as string) || (audioFilename ?? null),
      image_available: hasSelfHostedTiles || hasExternalManifest || !!audioFilename,
    };
  });

  // -------------------------------------------------------------------------
  // Step 6: Write to D1
  // -------------------------------------------------------------------------

  const db = getDb(env.DB);

  // Check for duplicate — don't re-import a repo that's already connected
  const existingProject = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.user_id, userId),
        eq(projects.github_repo_full_name, repoFullName),
      ),
    )
    .limit(1);

  if (existingProject.length > 0) {
    return {
      valid: false,
      validationError: "already_connected",
      project: { imported: false, storiesFound: 0 },
      objects: { imported: 0, skipped: 0, warnings: [] },
      stories: { imported: 0, warnings: [] },
      glossary: { imported: 0 },
      pages: { imported: 0 },
      themes: { imported: 0, list: [] },
      sheetsEnabled: false,
      sheetsDisabled: false,
      iiifObjectIds: [],
      audioObjectIds: [],
      videoObjectCount: 0,
      configFields: {},
      orphanStoryIds: [],
    };
  }

  // Insert project record — initial import counts as a sync
  const [projectRecord] = await db
    .insert(projects)
    .values({
      user_id: userId,
      github_repo_full_name: repoFullName,
      installation_id: installationId,
      last_synced_at: new Date().toISOString(),
      objects_read_sha: objectsReadAtImport(googleSheetsEnabled, head),
      origin,
      kind,
    })
    .returning();

  const projectId = projectRecord.id;

  try {
  // Inside the rollback: migration 0057 refuses the membership when the
  // account was deleted while the import ran, and the project it owns must not
  // be left behind.
  await db.insert(project_members).values({
    project_id: projectId,
    user_id: userId,
    role: "convenor",
    joined_at: new Date().toISOString(),
  });

  // Update all rows with the real project ID
  const objectsWithProjectId = objectRows.map((r) => ({
    ...r,
    project_id: projectId,
    created_by_actor: actorForImportedObject(r),
  }));
  const storiesWithProjectId = storyRows
    .filter((r) => r.story_id && pythonStrip(String(r.story_id)) !== "")
    .map((r) => ({
      ...r,
      project_id: projectId,
      created_by_actor: actorForImportedStory(r),
    }));
  const glossaryWithProjectId = glossaryRows.map((r) => ({
    ...r,
    project_id: projectId,
    created_by_actor: actorForImportedTerm(r),
  }));

  // Insert project config. A course's two defaults are written last so they
  // win over the repo's own `_config.yml`: a course is created from the
  // ordinary site template, whose config is not the course's answer. They
  // land in D1 only and reach `_config.yml` at the next publish.
  await db
    .insert(project_config)
    .values({ ...configFields, project_id: projectId, ...courseConfigDefaults(kind) });

  // Insert landing page data (null-safe: all fields are optional)
  await db
    .insert(project_landing)
    .values({ project_id: projectId, ...landingData });

  // Insert themes
  if (themeRows.length > 0) {
    const themesWithProjectId = themeRows.map((r) => ({ ...r, project_id: projectId }));
    for (const chunk of chunkForD1(D1_BIND_DIVISORS.themes, themesWithProjectId)) {
      await db.insert(project_themes).values(chunk);
    }
  }

  // Insert content tables, chunked to stay within D1's 100-bound-parameter
  // limit (see D1_BIND_DIVISORS).
  for (const chunk of chunkForD1(D1_BIND_DIVISORS.objects, objectsWithProjectId)) {
    await db.insert(objects).values(chunk);
  }
  for (const chunk of chunkForD1(D1_BIND_DIVISORS.stories, storiesWithProjectId)) {
    await db.insert(stories).values(chunk);
  }
  for (const chunk of chunkForD1(D1_BIND_DIVISORS.glossary, glossaryWithProjectId)) {
    await db.insert(glossary_terms).values(chunk);
  }

  // Insert pages (INSERT OR REPLACE to handle re-imports)
  const now = new Date().toISOString();
  if (pageRows.length > 0) {
    const pagesWithProjectId = await Promise.all(pageRows.map(async (p) => ({
      project_id: projectId,
      title: p.title,
      slug: p.slug,
      body: p.body,
      frontmatter: p.frontmatter,
      order: p.order,
      created_by_actor: await actorForImportedPage(p),
      created_at: now,
      updated_at: now,
    })));
    for (const chunk of chunkForD1(D1_BIND_DIVISORS.pages, pagesWithProjectId)) {
      for (const page of chunk) {
        await db
          .insert(project_pages)
          .values(page)
          .onConflictDoUpdate({
            target: [project_pages.project_id, project_pages.slug],
            set: {
              title: page.title,
              body: page.body,
              frontmatter: page.frontmatter,
              order: page.order,
              updated_at: page.updated_at,
            },
          });
      }
    }
  }

  // The record of the page files read (R6): the commit read and each page
  // file, mapped to the page inserted from it. head_sha stays null, so the
  // record's commit is the pages base until a head is recorded.
  await recordImportedPageFiles(db, projectId, head, pageRows, scannedPages.removed);
  await recordStoryFileReads(db, projectId, storyFileReads);

  // Insert steps and layers — requires real story DB IDs
  if (stepRows.length > 0 && storiesWithProjectId.length > 0) {
    // Fetch inserted story IDs ordered by the original insert order
    const insertedStories = await db
      .select({ id: stories.id, story_id: stories.story_id })
      .from(stories)
      .where(eq(stories.project_id, projectId));

    // Build index from original story order to DB ID
    const storyDbIdByIndex = new Map<number, number>();
    // And the actor each inserted story carries, so its steps and layers say
    // the same thing about where they came from. Keyed by the resolved story id
    // rather than by the placeholder, so this agrees with whatever the
    // placeholder resolution below decides a row's parent is.
    const actorByStoryDbId = new Map<number, AuthorActor>();
    for (let i = 0; i < storiesWithProjectId.length; i++) {
      const row = storiesWithProjectId[i];
      const dbRow = insertedStories.find((s) => s.story_id === row.story_id);
      if (dbRow) {
        storyDbIdByIndex.set(-(i + 1), dbRow.id);
        actorByStoryDbId.set(dbRow.id, actorForImportedStory(row));
      }
    }

    // Update placeholder story_id refs in steps
    const stepsWithIds = stepRows.map((step) => {
      const resolvedStoryId = storyDbIdByIndex.get(step.story_id as number);
      return {
        ...step,
        story_id: resolvedStoryId ?? step.story_id,
        created_by_actor: actorForImportedStep(
          step,
          resolvedStoryId !== undefined
            && actorByStoryDbId.get(resolvedStoryId) === AUTHOR_ACTORS.telarTemplate,
        ),
      };
    });

    for (const chunk of chunkForD1(D1_BIND_DIVISORS.steps, stepsWithIds)) {
      await db.insert(steps).values(chunk);
    }

    // Insert layers — needs real step IDs
    if (layerRows.length > 0) {
      const insertedSteps = await db
        .select({ id: steps.id, story_id: steps.story_id, step_number: steps.step_number })
        .from(steps)
        .where(
          inArray(
            steps.story_id,
            [...storyDbIdByIndex.values()],
          ),
        );

      const layersWithIds = pairLayersWithSteps(
        layerRows,
        storyDbIdByIndex,
        insertedSteps,
      );

      for (const chunk of chunkForD1(D1_BIND_DIVISORS.layers, layersWithIds)) {
        await db.insert(layers).values(chunk);
      }
    }
  }

  } catch (importError) {
    // Clean up partial data — delete project and all child records
    await rollbackProjectImport(db, projectId);
    throw importError;
  }

  return {
    valid: true,
    telarVersion,
    projectId,
    project: { imported: true, storiesFound },
    objects: {
      imported: objectRows.length,
      skipped: 0,
      warnings: objectWarnings,
    },
    stories: { imported: storyRows.filter((r) => r.story_id && pythonStrip(String(r.story_id)) !== "").length, warnings: [] },
    glossary: { imported: glossaryRows.length },
    pages: { imported: pageRows.length },
    themes: {
      imported: themeRows.length,
      list: themeRows.map((r) => ({
        theme_id: r.theme_id,
        name: r.name ?? null,
        swatch_color: r.swatch_color ?? null,
      })),
    },
    sheetsEnabled: googleSheetsEnabled && !sheetsDisabled,
    sheetsDisabled,
    iiifObjectIds,
    audioObjectIds: [...audioObjectFiles.keys()],
    videoObjectCount: objectRows.filter((o) => {
      const src = o.source_url as string | null;
      return src && (/youtube|youtu\.be/.test(src) || /vimeo/.test(src) || /drive\.google/.test(src));
    }).length,
    configFields,
    orphanStoryIds,
  };
}

