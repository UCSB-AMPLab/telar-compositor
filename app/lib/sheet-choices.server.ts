/**
 * The column picker for the sync, the first import and the orphan restore,
 * where a sheet has two or more columns Telar reads as one field
 * and more than one of them holds values.
 *
 * Where the parse refuses such a sheet (`CollidingColumnsRefusal`), every
 * sheet the build converts is read and run through the upgrade's repair
 * (`repairSheet`), which offers each group in which more than one column holds
 * values, all of them in one round. Where the repair finds no such group the
 * parse groups differently, and the refusal stands as it was.
 *
 * The question travels under a signed challenge binding the repository, the
 * head and the SHA-256 of every sheet as read. The answer is replayed only
 * when all of those still match; otherwise the sheets are asked about again.
 * Columns are named by their position in the sheet as read.
 *
 * A repository's sheets are repaired at once in a commit of their own, so the
 * site's next build passes, and the operation then runs as it would have: the
 * sync offers the kept values as it offers any change made on GitHub. A first
 * import from Google Sheets writes nothing to a tab, since the import switches
 * Sheets off and the Compositor writes the CSVs from then on: the choices are
 * applied to the tabs the import reads (`withTabChoices`).
 *
 * @version v1.5.0-beta
 */

import { signInternalMarker } from "../../workers/auth";
import { commitFilesToRepo, StaleHeadError, type CommitFile } from "~/lib/commit.server";
import { decrypt } from "~/lib/crypto.server";
import { SPREADSHEETS_DIR } from "~/lib/framework-sheet.server";
import { getFileAtRef, getRepoHead, listDirectoryEntries } from "~/lib/github.server";
import { CollidingColumnsRefusal, TabsChangedError, refusedImportResult, type ImportResult } from "~/lib/import.server";
import { repairSheet, sheetsToCheck, siteSheetRoles, type SheetRole } from "~/lib/sheet-collision-repair.server";
import { discoverSheetTabs, fetchSheetCsv } from "~/lib/sheets.server";
import { sha256Hex } from "~/lib/story-canonical";
import type { StoryContentCheck } from "~/lib/story-content.server";
import { syncFailure, type SyncFailure } from "~/lib/sync-failure.server";
import { SheetUnreadableError } from "~/lib/unreadable-file.server";
import {
  checkRound,
  flagged,
  parsePostedChoices,
  pendingOf,
  type ChoiceNotice,
  type OfferedGroup,
  type PendingGroup,
  type SubmittedChoice,
} from "~/lib/upgrade-sheets.server";
import { signatureFailure, signedContentHash } from "~/lib/upgrade-signing.server";

export const SHEET_CHOICES_OP = "sheet-choices";
const LINK_MODE = "120000";

type Source = { kind: "repo"; token: string; owner: string; repo: string } | { kind: "tabs"; url: string };

/** The project and user a challenge is signed for; 0 for a first import, before the project exists. */
interface Signer {
  projectId: number;
  userId: number;
  secret: string;
}

interface ChoiceSheet {
  file: string;
  name: string;
  role: SheetRole;
  text: string;
}

interface ChallengeFrame {
  v: 1;
  repo: string;
  source: "repo" | "tabs";
  /** The published Google Sheet a `tabs` challenge read. */
  url: string;
  headOid: string;
  sheets: { file: string; sha256: string }[];
}

interface ChallengeContent extends ChallengeFrame {
  /** The choices of earlier rounds, replayed with the next. */
  chosen: SubmittedChoice[];
  pending: PendingGroup[];
}

export interface SheetChoicesQuestion {
  error: "needs_choices";
  /** Where the sheets were read: the choice is committed to a repository, or applied to the tabs an import reads. */
  source: "repo" | "tabs";
  /** The signed challenge, posted back as it came. */
  challenge: string;
  groups: OfferedGroup[];
  notice: ChoiceNotice | null;
}

type Settled =
  | { kind: "chosen"; writes: CommitFile[]; chosen: SubmittedChoice[]; headOid: string; source: Source; sheets: ChallengeFrame["sheets"] }
  | { kind: "question"; question: SheetChoicesQuestion }
  | { kind: "not_applied"; sheet: string };

/**
 * The role a tab is read in: the build writes each tab to a file of its name
 * and selects the project, objects and glossary sheets among the files
 * (`siteSheetRoles`), the English name first and the Spanish one where the
 * English tab is not there. `tabNames` is every tab of the sheet.
 */
function tabRole(name: string, tabNames: readonly string[]): SheetRole {
  const fileOf = (tab: string) => `${tab.toLowerCase()}.csv`;
  return siteSheetRoles(tabNames.map(fileOf)).get(fileOf(name)) ?? "story";
}

/** Every sheet the build converts, as the repository holds it at `head`; a link is not followed. */
async function repoSheets(source: Extract<Source, { kind: "repo" }>, head: string): Promise<ChoiceSheet[]> {
  const entries = await listDirectoryEntries(source.token, source.owner, source.repo, head, SPREADSHEETS_DIR);
  const files = entries.filter((e) => e.type === "blob" && e.mode !== LINK_MODE).map((e) => e.path);
  const sheets: ChoiceSheet[] = [];
  for (const sheet of sheetsToCheck(files)) {
    const read = await getFileAtRef(source.token, source.owner, source.repo, sheet.path, head, { strict: true });
    if (read.status !== "ok") throw new SheetUnreadableError(sheet.path);
    sheets.push({ file: sheet.path, name: sheet.name, role: sheet.role, text: read.content });
  }
  return sheets;
}

/** Every tab of a published Google Sheet the import reads. */
async function tabSheets(url: string): Promise<ChoiceSheet[]> {
  const publishedId = url.match(/\/d\/e\/([a-zA-Z0-9-_]+)/)?.[1] ?? "";
  const sheets: ChoiceSheet[] = [];
  const tabs = await discoverSheetTabs(url);
  const tabNames = tabs.map((tab) => tab.name);
  for (const tab of tabs) {
    sheets.push({ file: tab.name, name: tab.name, role: tabRole(tab.name, tabNames), text: await fetchSheetCsv(publishedId, tab.gid) });
  }
  return sheets;
}

async function readSource(source: Source): Promise<{ headOid: string; sheets: ChoiceSheet[] }> {
  if (source.kind === "tabs") return { headOid: "", sheets: await tabSheets(source.url) };
  const headOid = await getRepoHead(source.token, source.owner, source.repo, "main");
  return { headOid, sheets: await repoSheets(source, headOid) };
}

/** The groups still asking for a choice, and the sheets `chosen` repairs, or the first it cannot. */
function examine(sheets: readonly ChoiceSheet[], chosen: readonly SubmittedChoice[]) {
  const found = { groups: [] as OfferedGroup[], invalid: false, writes: [] as CommitFile[], notApplied: null as string | null };
  for (const sheet of sheets) {
    const choices = chosen.filter((c) => c.file === sheet.file).map(({ positions, keep }) => ({ positions, keep }));
    const result = repairSheet({ path: sheet.file, text: sheet.text, role: sheet.role, choices });
    if (result.kind === "needs_choices") {
      found.invalid ||= result.invalidChoices.length > 0;
      for (const g of result.groups) {
        const positions = g.columns.map((c) => c.position);
        found.groups.push({ file: sheet.file, sheet: sheet.name, claim: g.claim, positions, columns: g.columns, needsChoice: false });
      }
    } else if (result.kind === "repaired" && choices.length > 0) {
      found.writes.push({ path: sheet.file, content: result.text, verbatim: true });
    } else if (choices.length > 0 && result.kind !== "unchanged") {
      found.notApplied ??= sheet.name;
    }
  }
  return found;
}

async function frameOf(repo: string, source: Source, headOid: string, sheets: readonly ChoiceSheet[]): Promise<ChallengeFrame> {
  const hashed = await Promise.all(sheets.map(async (s) => ({ file: s.file, sha256: await sha256Hex(s.text) })));
  const url = source.kind === "tabs" ? source.url : "";
  return { v: 1, repo, source: source.kind, url, headOid, sheets: hashed };
}

async function question(content: ChallengeContent, groups: OfferedGroup[], notice: ChoiceNotice | null, signer: Signer): Promise<SheetChoicesQuestion> {
  const detail = await signedContentHash(content);
  const signature = await signInternalMarker(signer.projectId, signer.secret, SHEET_CHOICES_OP, signer.userId, detail);
  return { error: "needs_choices", source: content.source, challenge: JSON.stringify({ content, signature }), groups, notice };
}

/** The question the sheets at `source` ask now, or null where no group holds values in more than one column. */
async function askFresh(repo: string, source: Source, signer: Signer, notice: ChoiceNotice | null): Promise<SheetChoicesQuestion | null> {
  const { headOid, sheets } = await readSource(source);
  const found = examine(sheets, []);
  if (found.groups.length === 0) return null;
  const content = { ...(await frameOf(repo, source, headOid, sheets)), chosen: [], pending: pendingOf(found.groups) };
  return question(content, found.groups, notice, signer);
}

/** The challenge's content, once its signature is verified; null for anything else. */
async function verifiedChallenge(raw: string, signer: Signer): Promise<ChallengeContent | null> {
  try {
    const posted = JSON.parse(raw) as { content?: ChallengeContent; signature?: never };
    const failure = await signatureFailure(posted.signature, posted.content, SHEET_CHOICES_OP, signer.projectId, signer.userId, signer.secret);
    return failure === null && posted.content !== undefined ? posted.content : null;
  } catch {
    return null;
  }
}

/** Whether a challenge was signed for this repository's sheets as they stand. */
function sameFrame(content: ChallengeContent, frame: ChallengeFrame): boolean {
  const keys = ["v", "repo", "source", "url", "headOid"] as const;
  return keys.every((k) => content[k] === frame[k]) && JSON.stringify(content.sheets) === JSON.stringify(frame.sheets);
}

/** A `chosen` answer for sheets that need no change, after they changed while the author chose. */
function nothingToWrite(headOid: string, source: Source): Settled {
  return { kind: "chosen", writes: [], chosen: [], headOid, source, sheets: [] };
}

/** Every choice so far applied to the sheets as read: the repaired sheets, or what still needs a choice. */
async function replayChoices(frame: ChallengeFrame, sheets: readonly ChoiceSheet[], chosen: SubmittedChoice[], source: Source, signer: Signer): Promise<Settled> {
  const found = examine(sheets, chosen);
  if (found.groups.length > 0) {
    const next = { ...frame, chosen, pending: pendingOf(found.groups) };
    return { kind: "question", question: await question(next, found.groups, found.invalid ? "choice_needed" : "further_choices", signer) };
  }
  if (found.notApplied !== null) return { kind: "not_applied", sheet: found.notApplied };
  return { kind: "chosen", writes: found.writes, chosen, headOid: frame.headOid, source, sheets: frame.sheets };
}

/**
 * The posted answer replayed over the sheets as they stand. A challenge that
 * fails verification, or sheets that changed since it was signed, are asked
 * about again; a round missing a group's choice asks again, flagging it.
 */
async function settleChoices(raw: string, submitted: unknown, repo: string, repoSource: Source, signer: Signer): Promise<Settled> {
  const content = await verifiedChallenge(raw, signer);
  const source: Source = content?.source === "tabs" ? { kind: "tabs", url: content.url } : repoSource;
  const { headOid, sheets } = await readSource(source);
  const frame = await frameOf(repo, source, headOid, sheets);
  if (content === null || !sameFrame(content, frame)) {
    const fresh = await askFresh(repo, source, signer, content === null ? null : "sheets_changed");
    return fresh ? { kind: "question", question: fresh } : nothingToWrite(headOid, source);
  }
  const checked = checkRound(content.pending, submitted);
  if ("round" in checked) return replayChoices(frame, sheets, [...content.chosen, ...checked.round], source, signer);
  const again = examine(sheets, content.chosen);
  return { kind: "question", question: await question(content, flagged(again.groups, checked.unanswered), "choice_needed", signer) };
}

function commitMessage(writes: readonly CommitFile[]): string {
  const names = writes.map((w) => w.path.slice(w.path.lastIndexOf("/") + 1)).join(", ");
  return `Keep the chosen column where several are read as one field (${names})`;
}

/** Commits the repaired sheets at the head they were read at; false when the head moved first. */
async function commitChosen(settled: Extract<Settled, { kind: "chosen" }>): Promise<boolean> {
  if (settled.writes.length === 0 || settled.source.kind !== "repo") return true;
  const { token, owner, repo } = settled.source;
  try {
    await commitFilesToRepo(token, owner, repo, "main", settled.writes, commitMessage(settled.writes), undefined, undefined, false, settled.headOid);
    return true;
  } catch (err) {
    if (err instanceof StaleHeadError) return false;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The sync and the orphan restore (the /dashboard action)
// ---------------------------------------------------------------------------

export interface SiteChoiceContext {
  env: { ENCRYPTION_KEY: string; SESSION_SECRET: string };
  user: { id: number; encrypted_access_token: string };
  project: { id: number; github_repo_full_name: string };
}

async function siteSource(site: SiteChoiceContext): Promise<Source> {
  const [owner, repo] = site.project.github_repo_full_name.split("/");
  return { kind: "repo", token: await decrypt(site.user.encrypted_access_token, site.env.ENCRYPTION_KEY), owner, repo };
}

function siteSigner(site: SiteChoiceContext): Signer {
  return { projectId: site.project.id, userId: site.user.id, secret: site.env.SESSION_SECRET };
}

/**
 * A sync's or restore's failure, with the picker in place of a colliding-columns
 * refusal where the repair sees the group. A read that fails while asking
 * leaves the refusal as it was.
 */
export async function refusalOrChoices<I extends string>(
  intent: I,
  err: unknown,
  error: string,
  site: SiteChoiceContext,
): Promise<SyncFailure<I> | ({ ok: false; intent: I } & SheetChoicesQuestion)> {
  if (err instanceof CollidingColumnsRefusal) {
    const asked = await askFresh(site.project.github_repo_full_name, await siteSource(site), siteSigner(site), null).catch(() => null);
    if (asked) return { ok: false, intent, ...asked };
  }
  return syncFailure(intent, err, error);
}

/**
 * A full sync's check with the picker in its place, where it lists a story as
 * unreadable because the story's own sheet has columns read as one field each
 * holding values (`columns_collide`) and the repair sees the group; every
 * sheet's groups are offered together. Null otherwise, and the check stands.
 */
export async function collidedStoryChoices<I extends string>(
  intent: I,
  content: StoryContentCheck | undefined,
  site: SiteChoiceContext,
): Promise<({ ok: false; intent: I } & SheetChoicesQuestion) | null> {
  if (!content?.conclusive || !content.changes.some((c) => c.reason?.code === "columns_collide")) return null;
  const asked = await askFresh(site.project.github_repo_full_name, await siteSource(site), siteSigner(site), null).catch(() => null);
  return asked ? { ok: false, intent, ...asked } : null;
}

export type ChooseColumnsAnswer =
  | { ok: true; intent: "choose-columns" }
  | ({ ok: false; intent: "choose-columns" } & SheetChoicesQuestion)
  | { ok: false; intent: "choose-columns"; error: "choice_not_applied"; sheet: string };

/** `choose-columns`: the author's choices committed to the repository, for the page to run its sync or restore again. */
export async function chooseColumns(site: SiteChoiceContext, formData: FormData): Promise<ChooseColumnsAnswer> {
  const intent = "choose-columns" as const;
  const repo = site.project.github_repo_full_name;
  const source = await siteSource(site);
  const posted = parsePostedChoices(formData.get("sheet_choices") as string | null);
  const settled = await settleChoices(String(formData.get("sheet_challenge") ?? ""), posted, repo, source, siteSigner(site));
  if (settled.kind === "question") return { ok: false, intent, ...settled.question };
  if (settled.kind === "not_applied") return { ok: false, intent, error: "choice_not_applied", sheet: settled.sheet };
  if (await commitChosen(settled)) return { ok: true, intent };
  const again = await askFresh(repo, source, siteSigner(site), "sheets_changed");
  return again ? { ok: false, intent, ...again } : { ok: true, intent };
}

// ---------------------------------------------------------------------------
// The first import (the /onboarding action)
// ---------------------------------------------------------------------------

export interface ImportChoiceContext {
  token: string;
  repoFullName: string;
  userId: number;
  secret: string;
}

function importSigner(site: ImportChoiceContext): Signer {
  return { projectId: 0, userId: site.userId, secret: site.secret };
}

function importRepoSource(site: ImportChoiceContext): Source {
  const [owner, repo] = site.repoFullName.split("/");
  return { kind: "repo", token: site.token, owner, repo };
}

function choicesImportResult(question: SheetChoicesQuestion): ImportResult {
  return refusedImportResult({ validationError: "needs_choices", sheetChoices: question });
}

/**
 * The first import's answer to a refusal, or to a tab that changed after the
 * author chose (asked again, saying the sheets changed): the picker where the
 * repair sees a group, otherwise null.
 */
export async function importChoicesResult(err: CollidingColumnsRefusal | TabsChangedError, site: ImportChoiceContext): Promise<ImportResult | null> {
  const source: Source = err.publishedSheetsUrl !== undefined ? { kind: "tabs", url: err.publishedSheetsUrl } : importRepoSource(site);
  const notice = err instanceof TabsChangedError ? "sheets_changed" : null;
  const asked = await askFresh(site.repoFullName, source, importSigner(site), notice).catch(() => null);
  return asked ? choicesImportResult(asked) : null;
}

/**
 * Settles the choices posted with an import before it runs: a repository's
 * repaired sheets are committed, and a Google Sheets import gets the choices to
 * apply to the tabs it reads (`readTab`), each of which it still lists
 * (`checkTabs`). With nothing posted the import runs
 * as it is.
 */
export async function settleImportChoices(
  formData: FormData,
  site: ImportChoiceContext,
): Promise<
  | { proceed: true; readTab?: (name: string, text: string) => Promise<string>; checkTabs?: (names: string[]) => void }
  | { proceed: false; result: ImportResult }
> {
  const raw = formData.get("sheet_challenge");
  if (typeof raw !== "string" || raw === "") return { proceed: true };
  const posted = parsePostedChoices(formData.get("sheet_choices") as string | null);
  const settled = await settleChoices(raw, posted, site.repoFullName, importRepoSource(site), importSigner(site));
  if (settled.kind === "question") return { proceed: false, result: choicesImportResult(settled.question) };
  if (settled.kind === "not_applied") {
    return { proceed: false, result: refusedImportResult({ validationError: "choice_not_applied", unreadableSheet: settled.sheet }) };
  }
  const { chosen, sheets } = settled;
  if (settled.source.kind === "tabs") {
    const readTab = (name: string, text: string) => withTabChoices(name, text, chosen, sheets);
    return { proceed: true, readTab, checkTabs: (names: string[]) => checkChosenTabsListed(chosen, names) };
  }
  if (await commitChosen(settled)) return { proceed: true };
  const again = await askFresh(site.repoFullName, settled.source, importSigner(site), "sheets_changed");
  return again ? { proceed: false, result: choicesImportResult(again) } : { proceed: true };
}

/** Throws `TabsChangedError` for a tab with a choice that the published Sheet no longer lists. */
function checkChosenTabsListed(chosen: readonly SubmittedChoice[], names: readonly string[]): void {
  const gone = chosen.find((c) => !names.includes(c.file));
  if (gone) throw new TabsChangedError(gone.file);
}

/**
 * A Google Sheets tab's text with the author's choices applied, for the import
 * to read; the text as fetched where they repair nothing, so the parse refuses
 * it as before. The import fetches each tab again, so a choice is applied only
 * to the bytes it was made against (`bound`, as signed): a tab changed since
 * throws `TabsChangedError`, since a value added to a dropped column would
 * otherwise be lost with no one asked.
 */
export async function withTabChoices(
  name: string,
  text: string,
  choices: readonly SubmittedChoice[] | undefined,
  bound: ChallengeFrame["sheets"],
): Promise<string> {
  const mine = (choices ?? []).filter((c) => c.file === name).map(({ positions, keep }) => ({ positions, keep }));
  if (mine.length === 0) return text;
  if (bound.find((b) => b.file === name)?.sha256 !== (await sha256Hex(text))) throw new TabsChangedError(name);
  const result = repairSheet({ path: name, text, role: tabRole(name, bound.map((b) => b.file)), choices: mine });
  return result.kind === "repaired" ? result.text : text;
}
