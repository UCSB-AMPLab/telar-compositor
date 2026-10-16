/**
 * The manifest's `csv_language_match`, carried past the repository: to a
 * Google Sheets tab the upgrade writes as the site's CSV, and to the
 * Compositor's own copy of the glossary.
 *
 * The glossary is held in the collaboration document, and a publish writes
 * the document's definitions over glossary.csv. A definition the upgrade
 * changed only in the repository is therefore written back at the next
 * publish. So the same rule is applied to the document: for the term whose
 * ID is the operation's key, a definition that still holds one of the
 * texts a case names, once CRLF is read as LF, takes that case's text in the
 * site's language. A definition the author edited in the Compositor is left
 * alone, as an edited cell in the file is.
 *
 * The document is read from D1 after a forced snapshot, and written through
 * `/ingest-sync`'s glossary update arm, which snapshots it to D1 and sends it
 * to every connected editor. The update carries the definition as read
 * (`seen`), and the collaboration object writes it only where the document
 * still holds that text, inside the gate every write to the document passes,
 * so an edit made between the read and the write is kept and reported.
 *
 * Best-effort, after the commit carrying the glossary has landed: it never
 * throws, and what it could not confirm is reported for the author to check.
 *
 * @version v1.5.5-beta
 */

import { and, eq, inArray } from "drizzle-orm";
import { glossary_terms } from "~/db/schema";
import type { getDb } from "~/lib/db.server";
import { makeInternalMarkerHeaders } from "~/lib/internal-marker.server";
import { applyCsvLanguageMatch, columnIdentity } from "~/lib/csv-language-match.server";
import type { LanguageMatchRun } from "~/lib/manifest-runner.server";
import { GLOSSARY_SHEETS, SPREADSHEETS_DIR } from "~/lib/site-sheets.server";
import type { SheetReportLine } from "~/lib/upgrade-sheets.server";

/** One glossary term's definition to match in the document, with the text each released definition becomes. */
export interface GlossaryDefinitionMatch {
  /** The sheet the operation names, for the report. */
  file: string;
  termId: string;
  cases: Array<{ equals: string; value: string }>;
}

/**
 * What the document did with one match. `applied`: the definition held a
 * released text and now holds the site's language. `kept`: it held something
 * else, or the term is not in the document, so nothing was written.
 * `edited`: it held a released text when read, and the author changed it
 * before the write, so the author's text was kept.
 * `unconfirmed`: the document could not be read or did not confirm the write.
 */
export type GlossaryMatchOutcome = "applied" | "kept" | "edited" | "unconfirmed";

export interface GlossaryMatchResult {
  match: GlossaryDefinitionMatch;
  outcome: GlossaryMatchOutcome;
}

export interface GlossaryMatchEnv {
  SESSION_SECRET: string;
  COLLABORATION: {
    idFromName: (name: string) => unknown;
    get: (id: unknown) => { fetch: (request: Request) => Promise<Response> };
  };
}

const GLOSSARY_FILES: ReadonlySet<string> = new Set(GLOSSARY_SHEETS.map((name) => `${SPREADSHEETS_DIR}/${name}`));

/** Whether a run's cell is a glossary term's definition, found by its ID, which the document holds. */
function namesGlossaryDefinition(run: LanguageMatchRun): boolean {
  return (
    GLOSSARY_FILES.has(run.op.file) &&
    columnIdentity(run.op.key_column) === "term_id" &&
    columnIdentity(run.op.column) === "definition"
  );
}

/** The document matches the chain's runs call for: each glossary definition run, with the cases that have text in its language. */
export function glossaryDefinitionMatches(runs: readonly LanguageMatchRun[]): GlossaryDefinitionMatch[] {
  return runs.filter(namesGlossaryDefinition).flatMap((run) => {
    const cases = run.op.cases.flatMap((c) => {
      const value = c.values[run.lang];
      return value === undefined ? [] : [{ equals: c.equals.replace(/\r\n/g, "\n"), value }];
    });
    return cases.length === 0 ? [] : [{ file: run.op.file, termId: run.op.key, cases }];
  });
}

/**
 * `text` with every run that names `path` applied to it, as the chain applied
 * it to the repository's copy, and whether any changed it.
 */
export function applyLanguageMatchesToText(
  path: string,
  text: string,
  runs: readonly LanguageMatchRun[],
): { text: string; changed: boolean } {
  const files = new Map([[path, text]]);
  let changed = false;
  for (const run of runs) {
    if (run.op.file === path && applyCsvLanguageMatch(files, run.op, run.lang)) changed = true;
  }
  return { text: files.get(path) as string, changed };
}

/** Asks the project's collaboration object to write its document to D1; whether it did. */
async function snapshotDocument(env: GlossaryMatchEnv, projectId: number): Promise<boolean> {
  try {
    const headers = await makeInternalMarkerHeaders(projectId, env.SESSION_SECRET, "snapshot");
    const stub = env.COLLABORATION.get(env.COLLABORATION.idFromName(String(projectId)));
    const res = await stub.fetch(new Request("https://internal/snapshot", { method: "POST", headers }));
    return res.ok;
  } catch {
    return false;
  }
}

/** The definition `match` writes over `held`, or null when `held` is no released text. */
function replacementFor(match: GlossaryDefinitionMatch, held: string | null): string | null {
  if (held === null) return null;
  const found = match.cases.find((c) => c.equals === held.replace(/\r\n/g, "\n"));
  if (found === undefined) return null;
  const newline = held.includes("\r\n") ? "\r\n" : "\n";
  const value = found.value.replace(/\r\n/g, "\n").replace(/\n/g, newline);
  return value === held ? null : value;
}

interface IngestAnswer {
  applied?: { glossaryUpdate?: unknown };
  skipped?: { glossaryUpdate?: unknown };
  refused?: { glossaryUpdate?: unknown };
  changedSinceReview?: { glossaryUpdate?: unknown };
  diagnostics?: unknown;
}

/** One definition to write, with the text it replaces as read. */
interface DefinitionUpdate {
  termId: string;
  definition: string;
  seen: { definition: string };
}

/** Posts the updates and reads, per term, whether the document took it. */
async function ingestDefinitions(
  env: GlossaryMatchEnv,
  projectId: number,
  updates: DefinitionUpdate[],
): Promise<Map<string, GlossaryMatchOutcome>> {
  const unconfirmed = new Map(updates.map((u) => [u.termId, "unconfirmed" as GlossaryMatchOutcome]));
  let answer: IngestAnswer;
  try {
    const headers = await makeInternalMarkerHeaders(projectId, env.SESSION_SECRET, "ingest-sync");
    const stub = env.COLLABORATION.get(env.COLLABORATION.idFromName(String(projectId)));
    const res = await stub.fetch(
      new Request("https://internal/ingest-sync", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ glossary: { update: updates } }),
      }),
    );
    if (!res.ok) return unconfirmed;
    answer = (await res.json()) as IngestAnswer;
  } catch {
    return unconfirmed;
  }
  return outcomesFromAnswer(answer, updates) ?? unconfirmed;
}

/** The glossary update list a group of the answer holds, and null when it holds none. */
function updateListOf(group: { glossaryUpdate?: unknown } | undefined): unknown[] | null {
  const list = group?.glossaryUpdate;
  return Array.isArray(list) ? list : null;
}

/**
 * Each term's outcome as the document's answer reports it, or null when the
 * answer is malformed, refused an update, carried a diagnostic, or does not
 * account for every update sent.
 */
function outcomesFromAnswer(answer: IngestAnswer, updates: DefinitionUpdate[]): Map<string, GlossaryMatchOutcome> | null {
  const skipped = updateListOf(answer.skipped);
  const refused = updateListOf(answer.refused);
  const edited = updateListOf(answer.changedSinceReview);
  const diagnostics = Array.isArray(answer.diagnostics) ? answer.diagnostics : null;
  const applied = answer.applied?.glossaryUpdate;
  if (skipped === null || refused === null || edited === null || diagnostics === null || typeof applied !== "number") {
    return null;
  }
  if (refused.length > 0 || diagnostics.length > 0 || applied !== updates.length - skipped.length) return null;
  // A skipped update names a term absent from the document; an edited one, a
  // definition the author changed after it was read.
  const outcome = (termId: string): GlossaryMatchOutcome =>
    skipped.includes(termId) ? "kept" : edited.includes(termId) ? "edited" : "applied";
  return new Map(updates.map((u) => [u.termId, outcome(u.termId)]));
}

/**
 * Applies `matches` to the project's document. Returns each match's outcome,
 * in order. Never throws.
 */
export async function matchGlossaryDefinitionsInDocument(
  db: ReturnType<typeof getDb>,
  env: GlossaryMatchEnv,
  projectId: number,
  matches: readonly GlossaryDefinitionMatch[],
): Promise<GlossaryMatchResult[]> {
  if (matches.length === 0) return [];
  const all = (outcome: GlossaryMatchOutcome) => matches.map((match) => ({ match, outcome }));
  if (!(await snapshotDocument(env, projectId))) return all("unconfirmed");

  let rows: Array<{ term_id: string; definition: string | null }>;
  try {
    rows = await db
      .select({ term_id: glossary_terms.term_id, definition: glossary_terms.definition })
      .from(glossary_terms)
      .where(and(eq(glossary_terms.project_id, projectId), inArray(glossary_terms.term_id, matches.map((m) => m.termId))));
  } catch (err) {
    console.error(`[glossary-language-match] project ${projectId}: the glossary read failed`, err);
    return all("unconfirmed");
  }

  // A term two rows hold is left alone, as the file's operation leaves a key
  // two rows hold.
  const updates = new Map<string, DefinitionUpdate>();
  for (const match of matches) {
    const held = rows.filter((r) => r.term_id === match.termId);
    const value = held.length === 1 ? replacementFor(match, held[0].definition) : null;
    if (value !== null && !updates.has(match.termId)) {
      updates.set(match.termId, { termId: match.termId, definition: value, seen: { definition: held[0].definition as string } });
    }
  }
  if (updates.size === 0) return all("kept");

  const taken = await ingestDefinitions(env, projectId, [...updates.values()]);
  return matches.map((match) => ({ match, outcome: taken.get(match.termId) ?? "kept" }));
}

const REPORT_KINDS = {
  applied: "glossary_language_matched",
  edited: "glossary_language_edited",
  unconfirmed: "glossary_language_unconfirmed",
} as const;

/**
 * The done screen's lines for `results`: one for each definition the document
 * took, one for each the author edited before the write, and one for each it
 * could not confirm. A definition the document kept has no line, since the
 * editor's own text is what the site publishes.
 */
export function glossaryMatchReportLines(results: readonly GlossaryMatchResult[]): SheetReportLine[] {
  return results.flatMap(({ match, outcome }): SheetReportLine[] => {
    if (outcome === "kept") return [];
    const kind = REPORT_KINDS[outcome];
    return [{ kind, sheet: match.file.slice(SPREADSHEETS_DIR.length + 1), term: match.termId, file: match.file }];
  });
}

/** Whether every result is settled in the document: none is `unconfirmed`. */
export function glossaryMatchesSettled(results: readonly GlossaryMatchResult[]): boolean {
  return results.every((r) => r.outcome !== "unconfirmed");
}
