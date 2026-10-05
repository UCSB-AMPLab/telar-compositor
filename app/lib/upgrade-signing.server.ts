/**
 * The signatures an upgrade's prepared state and its column-choice challenge
 * travel under.
 *
 * Both round-trip through the browser, between one request and the next, and
 * are untrusted input when they come back: both convenor and collaborator can
 * reach the upgrade's action, and a collaborator's browser can hold a value the
 * server never produced. The prepared state reaches a commit made under the
 * installation token, a credential far stronger than the user's own; the
 * challenge carries the decisions a later prepare replays. Neither is acted on
 * unverified.
 *
 * Each is signed with `signInternalMarker` (the HMAC marker publish's Durable
 * Object snapshot call uses), under its own op so one can never pass as the
 * other, with a SHA-256 over the canonical JSON of its content as the marker's
 * `detail`. The project id and the acting user's id are bound by the marker
 * itself; the verifying side supplies both from the request it resolved,
 * never from the payload. Editing any field after signing recomputes to a
 * different hash and fails verification. The installation id is never part of
 * either payload: the server derives it from the resolved project.
 *
 * @version v1.5.0-beta
 */

import type { CommitFile } from "~/lib/commit.server";
import type { Language, ManualStep } from "~/lib/manifest-schema.server";
import { sha256Hex } from "~/lib/story-canonical";
import type { UpgradeAnswer } from "~/lib/upgrade-answers.server";
import type { SheetReportLine, UpgradeChallengeContent, UpgradeDecisions } from "~/lib/upgrade-sheets.server";
import { signInternalMarker, verifyInternalMarker, type SignedInternalMarker } from "../../workers/auth";

export const PREPARED_UPGRADE_OP = "upgrade-commit";
export const UPGRADE_CHALLENGE_OP = "upgrade-challenge";

// A user reviews the diff and manual steps, or chooses columns, before going
// on — generous enough for that, matching the 10-minute App JWT lifetime
// elsewhere (github-app.server.ts's signJwt); short enough that a captured
// signature is no standing credential.
export const PREPARED_UPGRADE_MAX_AGE_SECONDS = 600;

export interface PreparedUpgradeContent {
  additions: CommitFile[];
  deletions: string[];
  expectedHeadOid: string;
  commitMessage: string;
  commitBody: string;
  newVersion: string;
  toVersion: string;
  manualSteps: Record<Language, ManualStep[]>;
  /** What the upgrade does to the site's sheets, for the confirmation and the done screen. */
  sheetReport: SheetReportLine[];
  /** No sheet needed a change: the framework's `v180_sheets_clean`. */
  sheetsClean: boolean;
  /** Every decision the author made on the way to this state. */
  decisions: UpgradeDecisions;
  /** Whether the commit may record itself as synced (see `advancesHead` in upgrade-sheets.server.ts). */
  advancesHead: boolean;
  /** The site reads Google Sheets and its tabs were checked as they stood, which the confirmation says. */
  tabsChecked: boolean;
  /** The CSVs written from Google Sheets and the copies deleted, where the site stops reading it in this upgrade. */
  sheetsOff: { written: string[]; deleted: string[] } | null;
  /**
   * The `_config.yml` at the head with only Google Sheets switched off, where
   * the site stops reading it: what the content commit carries when the
   * version-bumped file waits for the workflow commit, so the tabs it writes
   * never land while the build still fetches over them.
   */
  sheetsOffHeadConfig: string | null;
  /** Whether the site reads Google Sheets once `_config.yml` lands, for the post-upgrade steps. */
  readsGoogleSheetsAfter: boolean;
  /** The steps whose answers the upgraded site publishes differently, for the confirmation and the done screen. */
  answers: UpgradeAnswer[];
  /**
   * The freeze lease this upgrade holds, when it holds one. Signed with the
   * rest, so the commit renews and ends the lease its own prepare started.
   * Absent from the hash when absent from the object.
   */
  operationId?: string;
}

export interface PreparedUpgrade extends PreparedUpgradeContent {
  signature: SignedInternalMarker;
}

export interface SignedUpgradeChallenge {
  content: UpgradeChallengeContent;
  signature: SignedInternalMarker;
}

/**
 * Thrown on any verification failure — tampering, a cross-project or
 * cross-user replay, or a signature older than the review window. No GitHub
 * call throws either class, so a caller's catch cannot mistake one for a
 * GitHub error.
 */
export class InvalidPreparedStateError extends Error {}

export class InvalidUpgradeChallengeError extends Error {}

function canonicaliseForSignature(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicaliseForSignature);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicaliseForSignature(source[key]);
    return out;
  }
  return value;
}

/** SHA-256, as hex, of `value`'s canonical JSON. */
export async function signedContentHash(value: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(canonicaliseForSignature(value)));
}

/**
 * Whether `signature` is this project's and user's, under `op`, over `content`
 * and inside the review window; the reason it is not, otherwise.
 */
export async function signatureFailure(
  signature: Partial<SignedInternalMarker> | undefined,
  content: unknown,
  op: string,
  projectId: number,
  userId: number,
  sessionSecret: string,
): Promise<string | null> {
  const contentHash = await signedContentHash(content);
  const verifyRequest = new Request(`https://internal/${op}`, {
    headers: {
      "X-Internal-Auth": signature?.sigHex ?? "",
      "X-Internal-Timestamp": String(signature?.timestamp ?? ""),
      "X-Internal-Project": String(projectId),
    },
  });
  const failure = await verifyInternalMarker(
    verifyRequest,
    sessionSecret,
    op,
    userId,
    PREPARED_UPGRADE_MAX_AGE_SECONDS,
    contentHash,
  );
  if (!failure) return null;
  return await failure.text().catch(() => "unreadable reason");
}

/** Signs a prepared upgrade over every field it carries. */
export async function signPreparedUpgrade(
  content: PreparedUpgradeContent,
  projectId: number,
  userId: number,
  sessionSecret: string,
): Promise<PreparedUpgrade> {
  const signature = await signInternalMarker(projectId, sessionSecret, PREPARED_UPGRADE_OP, userId, await signedContentHash(content));
  return { ...content, signature };
}

/**
 * Verifies a prepared state against the caller's own resolved project and
 * user id. Resolves silently when valid; throws InvalidPreparedStateError
 * otherwise, so no caller can reach a commit without either a verified
 * signature or an exception. The hash covers every field but the signature,
 * so a field added to the payload is signed without a list to keep in step,
 * and a field a client adds makes the state fail.
 *
 * A refusal here is a bug report, not a user error, and is logged with the
 * reason `verifyInternalMarker` gives (stale or invalid).
 */
export async function assertPreparedUpgradeSignature(
  prepared: PreparedUpgrade,
  projectId: number,
  userId: number,
  sessionSecret: string,
): Promise<void> {
  const { signature, ...content } = prepared;
  const reason = await signatureFailure(signature, content, PREPARED_UPGRADE_OP, projectId, userId, sessionSecret);
  if (reason === null) return;
  console.error(`[runUpgradeCommit] preparedState verification failed — project ${projectId}, user ${userId}: ${reason}`);
  throw new InvalidPreparedStateError(reason);
}

/** Signs a column-choice challenge for the project and user it was asked of. */
export async function signUpgradeChallenge(
  content: UpgradeChallengeContent,
  projectId: number,
  userId: number,
  sessionSecret: string,
): Promise<SignedUpgradeChallenge> {
  const signature = await signInternalMarker(projectId, sessionSecret, UPGRADE_CHALLENGE_OP, userId, await signedContentHash(content));
  return { content, signature };
}

/**
 * The content of a challenge the page posted back, once its signature is
 * verified against the caller's own project and user; throws
 * InvalidUpgradeChallengeError for anything else, including JSON that is not a
 * signed challenge at all.
 */
export async function verifyUpgradeChallenge(
  raw: string,
  projectId: number,
  userId: number,
  sessionSecret: string,
): Promise<UpgradeChallengeContent> {
  let posted: Partial<SignedUpgradeChallenge> | null;
  try {
    posted = JSON.parse(raw) as Partial<SignedUpgradeChallenge> | null;
  } catch {
    throw new InvalidUpgradeChallengeError("the challenge is not JSON");
  }
  if (posted === null || typeof posted !== "object" || posted.content === undefined) {
    throw new InvalidUpgradeChallengeError("the challenge has no content");
  }
  const reason = await signatureFailure(posted.signature, posted.content, UPGRADE_CHALLENGE_OP, projectId, userId, sessionSecret);
  if (reason !== null) {
    console.error(`[runUpgradePrepare] challenge verification failed — project ${projectId}, user ${userId}: ${reason}`);
    throw new InvalidUpgradeChallengeError(reason);
  }
  return posted.content;
}

/**
 * The verified content of a challenge the picker posted back, null for none,
 * or "invalid" for one that does not verify.
 */
export async function readPostedChallenge(
  raw: string | null,
  projectId: number,
  userId: number,
  sessionSecret: string,
): Promise<UpgradeChallengeContent | null | "invalid"> {
  if (raw === null) return null;
  try {
    return await verifyUpgradeChallenge(raw, projectId, userId, sessionSecret);
  } catch (err) {
    if (err instanceof InvalidUpgradeChallengeError) return "invalid";
    throw err;
  }
}
