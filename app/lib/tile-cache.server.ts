/**
 * The repository's tile cache entries in GitHub Actions: listed, and deleted
 * so the next build retiles.
 *
 * The build restores `iiif-tiles-*` before it decides whether to retile, and
 * an Actions cache entry cannot be replaced under its key; on sites whose key
 * does not follow file paths, an entry saved before an object's files were
 * renamed keeps serving tiles under the old id. Deleting every such entry
 * leaves the build nothing to restore, so it retiles and saves an entry built
 * under the new id. This works on every framework version.
 *
 * The listing is made before the rename commits, with the token that will
 * dispatch the build, so a token that cannot reach the caches refuses with
 * nothing committed (`listTileCacheEntries`). After the commit the entries
 * are listed again, since a build may have saved one in between, and each is
 * deleted (`clearTileCacheEntries`): a 404 counts as deleted, a failed
 * deletion is retried three times, and one that still fails is logged and
 * left, since the build is dispatched anyway and retiles whatever the cache
 * holds.
 *
 * @version v1.5.0-beta
 */

import { GITHUB_API, githubHeaders, parseNextLink } from "~/lib/github.server";

/** The key prefix the framework's build saves tiles under. */
export const TILE_CACHE_KEY_PREFIX = "iiif-tiles-";

/** How many times a failed deletion is tried again. */
const DELETE_RETRIES = 3;

/** The most pages of entries one listing follows. */
const MAX_LIST_PAGES = 20;

/**
 * A listing's answer: the entries' ids, or the status of the request that
 * failed. A listing still linking to a next page after `MAX_LIST_PAGES` is not
 * complete and answers not ok with `truncated` set and the ids it read, which
 * the clearing after the commit deletes and the check before it refuses.
 */
export type TileCacheListing =
  | { ok: true; ids: number[] }
  | { ok: false; status: number; truncated?: false }
  | { ok: false; status: number; truncated: true; ids: number[] };

/** One page of `GET /repos/{owner}/{repo}/actions/caches`. */
interface CachePage {
  actions_caches?: { id: number; key: string }[];
}

/**
 * The ids of every Actions cache entry whose key opens with the tile prefix,
 * following the listing's pages. The listing filters by key prefix, and each
 * entry's key is checked again here. A request that fails answers its status
 * (0 when no response arrived).
 */
export async function listTileCacheEntries(token: string, owner: string, repo: string): Promise<TileCacheListing> {
  const ids: number[] = [];
  let url: string | null =
    `${GITHUB_API}/repos/${owner}/${repo}/actions/caches?key=${encodeURIComponent(TILE_CACHE_KEY_PREFIX)}&per_page=100`;
  for (let page = 0; url !== null && page < MAX_LIST_PAGES; page++) {
    let response: Response;
    try {
      response = await fetch(url, { headers: githubHeaders(token) });
    } catch {
      return { ok: false, status: 0 };
    }
    if (!response.ok) return { ok: false, status: response.status };
    const body = (await response.json()) as CachePage;
    for (const entry of body.actions_caches ?? []) {
      if (entry.key.startsWith(TILE_CACHE_KEY_PREFIX)) ids.push(entry.id);
    }
    url = parseNextLink(response.headers.get("link"));
  }
  if (url !== null) return { ok: false, status: 200, truncated: true, ids };
  return { ok: true, ids };
}

/** True once the entry is gone: deleted now, or already absent (404). */
async function deleteOnce(token: string, owner: string, repo: string, id: number): Promise<boolean> {
  try {
    const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/actions/caches/${id}`, {
      method: "DELETE",
      headers: githubHeaders(token),
    });
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

/** What clearing the tile cache did: the entries deleted, those that could not be, and whether the listing answered. */
export interface TileCacheClearing {
  listed: boolean;
  deleted: number[];
  failed: number[];
}

/** Deletes each id, retrying a failed deletion three times; answers those gone and those not. */
async function deleteEntries(token: string, owner: string, repo: string, ids: readonly number[]): Promise<{ deleted: number[]; failed: number[] }> {
  const deleted: number[] = [];
  const failed: number[] = [];
  for (const id of ids) {
    let gone = false;
    for (let attempt = 0; attempt <= DELETE_RETRIES && !gone; attempt++) gone = await deleteOnce(token, owner, repo, id);
    (gone ? deleted : failed).push(id);
  }
  return { deleted, failed };
}

/** Listings a clear makes at most: each after a truncated one reads the entries past the page cap. */
const MAX_CLEAR_ROUNDS = 5;

/**
 * Lists the tile cache entries again and deletes each, retrying a failed
 * deletion three times. A listing past its page cap is cleared as far as it
 * read and listed again, since the deletions bring the next entries onto its
 * pages; this stops when a listing is complete or a round deletes nothing.
 * Never throws: a listing that fails and a deletion that keeps failing are
 * logged, and the caller dispatches the build anyway.
 */
export async function clearTileCacheEntries(token: string, owner: string, repo: string): Promise<TileCacheClearing> {
  const deleted: number[] = [];
  const failed: number[] = [];
  let listed = false;
  for (let round = 0; round < MAX_CLEAR_ROUNDS; round++) {
    const listing = await listTileCacheEntries(token, owner, repo);
    if (!listing.ok && !listing.truncated) {
      console.error(`clearTileCacheEntries: listing ${owner}/${repo}'s tile caches failed with ${listing.status}`);
      break;
    }
    listed = true;
    const done = await deleteEntries(token, owner, repo, listing.ids.filter((id) => !failed.includes(id)));
    deleted.push(...done.deleted);
    failed.push(...done.failed);
    if (listing.ok || done.deleted.length === 0) {
      if (!listing.ok) console.error(`clearTileCacheEntries: listing ${owner}/${repo}'s tile caches ran past ${MAX_LIST_PAGES} pages`);
      break;
    }
  }
  if (failed.length > 0) {
    console.error(`clearTileCacheEntries: ${owner}/${repo}'s tile caches ${failed.join(", ")} could not be deleted`);
  }
  return { listed, deleted, failed };
}
