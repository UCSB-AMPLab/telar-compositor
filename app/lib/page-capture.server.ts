/**
 * Front matter captured when the Pages screen first sees a page.
 *
 * A page imported before its block was stored holds null. The Pages loader
 * reads each such page's file at the repository's head, strictly, the way the
 * publish's carry-forward reads it (`readCarryForwardContent`: the file it was
 * imported as, falling back to its current slug), and hands the blocks to the
 * collaboration object, which stores each one only on a page still holding
 * null.
 *
 * An absent file is captured as `""`, the value a new page gets. A read that
 * fails captures nothing for that page, which stays uncaptured and is read
 * again at the next load.
 *
 * @version v1.5.0-beta
 */

import { capturedFrontmatter } from "~/lib/page-frontmatter.server";
import { readCarryForwardContent, type CarryForwardSource } from "~/lib/publish.server";
import { getDefaultBranchHead } from "~/lib/github.server";
import { decrypt } from "~/lib/crypto.server";
import { resolveProjectToken } from "~/lib/github-app.server";
import { makeInternalMarkerHeaders } from "~/lib/internal-marker.server";
import { movePublishSnapshotPastCaptures } from "~/lib/page-capture-snapshot.server";
import type { IngestPageCapture } from "../../workers/page-capture";

/** A page row as the loader holds it. */
export interface CapturablePage {
  id: number;
  slug: string | null;
  title: string | null;
  frontmatter: string | null;
  frontmatter_source?: string | null;
}

/** How many page files the capture reads at once, as the carry-forward does. */
const CAPTURE_READS = 6;

/**
 * The block of each uncaptured page, read from its file at `source.ref`. A
 * page whose read failed is left out of `captures` and counted in `failed`.
 */
export async function readUncapturedBlocks(
  pages: readonly CapturablePage[],
  source: CarryForwardSource,
): Promise<{ captures: IngestPageCapture[]; failed: number }> {
  const uncaptured = pages.filter((p) => p.frontmatter === null);
  const results: Array<IngestPageCapture | null> = [];
  for (let i = 0; i < uncaptured.length; i += CAPTURE_READS) {
    const batch = uncaptured.slice(i, i + CAPTURE_READS);
    results.push(...(await Promise.all(batch.map((page) => readOne(page, source)))));
  }
  const captures = results.filter((c): c is IngestPageCapture => c !== null);
  return { captures, failed: results.length - captures.length };
}

async function readOne(page: CapturablePage, source: CarryForwardSource): Promise<IngestPageCapture | null> {
  const content = await readCarryForwardContent(source, { ...page, slug: page.slug ?? "", title: page.title ?? "" }, false);
  if (content === null) return null;
  return { pageId: page.id, frontmatter: capturedFrontmatter(content.replace(/^﻿/, "")) };
}

/** The collaboration object's answer, as far as the capture reads it. */
interface CaptureAnswer {
  ok: boolean;
  /** The row ids whose block the object stored; a capture it skipped is not one. */
  applied: number[];
}

/**
 * The row ids an ingest answer lists under `key`, `capturedPages` or
 * `storedPages`; anything but a list of numbers names none.
 */
export function pageIdsIn(body: unknown, key: "capturedPages" | "storedPages"): number[] {
  const ids = (body as Record<string, unknown> | null)?.[key];
  return Array.isArray(ids) ? ids.filter((id): id is number => typeof id === "number") : [];
}

/**
 * Post a `pages` payload to the project's collaboration object, and answer its
 * parsed reply, or null when it refused. A reply that is not JSON parses as null.
 */
export async function postPageIngest(
  env: Pick<Env, "COLLABORATION" | "SESSION_SECRET">,
  projectId: number,
  pages: Record<string, unknown>,
): Promise<{ body: unknown } | null> {
  const headers = await makeInternalMarkerHeaders(projectId, env.SESSION_SECRET, "ingest-sync");
  const stub = env.COLLABORATION.get(env.COLLABORATION.idFromName(String(projectId)));
  const response = await stub.fetch(
    new Request("https://internal/ingest-sync", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ pages }),
    }),
  );
  const text = await response.text();
  if (!response.ok) return null;
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { body: null };
  }
}

/** Hand the blocks to the collaboration object, which stores each on a page still holding null. */
export async function sendCaptures(
  env: Pick<Env, "COLLABORATION" | "SESSION_SECRET">,
  projectId: number,
  captures: readonly IngestPageCapture[],
): Promise<CaptureAnswer> {
  if (captures.length === 0) return { ok: true, applied: [] };
  const answer = await postPageIngest(env, projectId, { captureFrontmatter: captures });
  if (answer === null) return { ok: false, applied: [] };
  return { ok: true, applied: pageIdsIn(answer.body, "capturedPages") };
}

/**
 * Read and store the block of every uncaptured page, returning the pages with
 * the blocks the collaboration object accepted. Any failure — the head, a
 * file, the object — leaves the pages it touched as they were. Once the
 * object has stored the blocks, the last publish's snapshot is brought up to
 * them, so the capture alone never makes a page read as changed
 * (`movePublishSnapshotPastCaptures`).
 */
export async function captureUncapturedPages<P extends CapturablePage>(
  env: Pick<Env, "COLLABORATION" | "SESSION_SECRET" | "DB">,
  projectId: number,
  pages: P[],
  repo: { token: string; owner: string; repo: string },
): Promise<P[]> {
  if (!pages.some((p) => p.frontmatter === null)) return pages;
  const head = await getDefaultBranchHead(repo.token, repo.owner, repo.repo);
  // A repository with no default branch has no commits, so no page has a file.
  const { captures } = head === null
    ? { captures: pages.filter((p) => p.frontmatter === null).map((p) => ({ pageId: p.id, frontmatter: "" })) }
    : await readUncapturedBlocks(pages, { ...repo, ref: head.oid });
  const answer = await sendCaptures(env, projectId, captures);
  if (!answer.ok) return pages;
  await movePublishSnapshotPastCaptures(env.DB, projectId, answer.applied);
  const stored = new Set(answer.applied);
  const byId = new Map(captures.filter((c) => stored.has(c.pageId)).map((c) => [c.pageId, c.frontmatter]));
  return pages.map((p) => (byId.has(p.id) ? { ...p, frontmatter: byId.get(p.id)! } : p));
}

/**
 * The capture as a loader runs it for the member viewing the page, before it
 * reads anything that depends on the pages' front matter: the Pages screen
 * before it renders, the Publish page before it computes the change summary.
 * The repository token is resolved as the member's role allows. A failure of
 * any kind leaves the pages as they were: they stay uncaptured, are read again
 * at the next load, and the Pages screen keeps renaming and deleting off
 * meanwhile. A page is returned holding a block it did not hold only when
 * this call stored it, which is how a caller tells that the snapshot moved.
 */
export async function capturePagesOnLoad<P extends CapturablePage>(
  env: Env,
  user: { encrypted_access_token: string },
  project: { id: number; github_repo_full_name: string; installation_id: Parameters<typeof resolveProjectToken>[2] },
  userRole: Parameters<typeof resolveProjectToken>[4],
  pages: P[],
): Promise<P[]> {
  if (!pages.some((p) => p.frontmatter === null)) return pages;
  try {
    const userToken = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
    const [owner, repo] = project.github_repo_full_name.split("/");
    const token = await resolveProjectToken(
      env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY, project.installation_id, userToken, userRole,
    );
    return await captureUncapturedPages(env, project.id, pages, { token, owner, repo });
  } catch (err) {
    console.error("page front matter capture failed; pages stay uncaptured:", err);
    return pages;
  }
}
