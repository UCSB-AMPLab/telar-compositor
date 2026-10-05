/**
 * Asks the deployed site whether self-hosted objects' tiles are there: an
 * object is ready when its `info.json` answers under `iiif/objects/<site id>`,
 * where the framework's build writes it, with the site id the repository's
 * version gives.
 *
 * The site base comes from the repository's own `_config.yml`, so it passes
 * the import probe's guard (`isSafeSiteBase`) before anything is fetched, and
 * only ids the tiler accepts are put in a URL. One read asks about at most
 * `TILE_PROBE_LIMIT` objects, and every request shares one deadline. An object
 * whose request failed, timed out or answered other than 2xx or 404 is left
 * out of the answer. An object that answered 404 is reported `notFound`; the
 * page decides what a 404 proves, since a site that answers 404 for every
 * object may be down or not yet built.
 *
 * A site whose config gives no base the guard accepts has no address to ask,
 * and a probe could never mark its objects. For such a site only, an object is
 * taken as ready when the tiler would find its file in the repository at HEAD
 * (`readyFromRepository`), the rule the page used before the probe.
 *
 * @version v1.5.0-beta
 */

import { eq } from "drizzle-orm";
import { project_config } from "~/db/schema";
import type { getDb } from "~/lib/db.server";
import { decrypt } from "~/lib/crypto.server";
import { resolveProjectToken } from "~/lib/github-app.server";
import { getRepoTree } from "~/lib/github.server";
import { isSafeSiteBase } from "~/lib/import.server";
import {
  configFrameworkVersion, configSiteBase, isTilerObjectId, siteIiifObjectBase, siteObjectId, tileableStems, tiledFromFiles,
} from "~/lib/object-id";
import { readRepositorySiteVersion } from "~/lib/site-version.server";
import { TILE_PROBE_LIMIT } from "~/lib/tile-readiness";

/** How long one probe waits for all its answers. */
export const TILE_PROBE_DEADLINE_MS = 5000;

/** What one probe learned: the site it asked (none when it asked no site), the ids whose `info.json` answered 2xx there, and those that answered 404. */
export interface TileProbeAnswer {
  site: string | null;
  ready: string[];
  notFound: string[];
}

const NO_TILES_ANSWERED: TileProbeAnswer = { site: null, ready: [], notFound: [] };

/** The ids among `objectIds` whose `info.json` answered on the site at `siteBaseUrl`, and those that answered 404. */
export async function probeTileStates(
  siteBaseUrl: string | null,
  objectIds: readonly string[],
  frameworkVersion: string | null,
): Promise<TileProbeAnswer> {
  if (!siteBaseUrl || !isSafeSiteBase(siteBaseUrl)) return NO_TILES_ANSWERED;
  const asked = [...new Set(objectIds)]
    .filter((id) => isTilerObjectId(siteObjectId(id, frameworkVersion)))
    .slice(0, TILE_PROBE_LIMIT);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), TILE_PROBE_DEADLINE_MS);
  try {
    const answers = await Promise.all(
      asked.map(async (objectId) => {
        try {
          const url = `${siteIiifObjectBase(siteBaseUrl, objectId, frameworkVersion)}/info.json`;
          const res = await fetch(url, { method: "HEAD", signal: deadline.signal });
          return { objectId, status: res.ok ? ("ready" as const) : res.status === 404 ? ("notFound" as const) : null };
        } catch {
          return { objectId, status: null };
        }
      }),
    );
    const ready = answers.filter((a) => a.status === "ready").map((a) => a.objectId);
    const notFound = answers.filter((a) => a.status === "notFound").map((a) => a.objectId);
    return { site: siteBaseUrl, ready, notFound };
  } finally {
    clearTimeout(timer);
  }
}

/** The page whose site a probe reads, as the page-site gate answers it. */
interface ProbedPage {
  project: { id: number; installation_id: number; github_repo_full_name: string };
  userRole: string | null;
}

/** How the probe reads the page's repository: its token and full name. */
interface RepositoryRead {
  token: string;
  owner: string;
  repo: string;
}

/** The repository read with the token the page's role reads with. */
async function repositoryReadFor(
  env: Env,
  user: { encrypted_access_token: string },
  page: ProbedPage,
): Promise<RepositoryRead> {
  const userToken = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
  const token = await resolveProjectToken(
    env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY, page.project.installation_id, userToken, page.userRole,
  );
  const [owner, repo] = page.project.github_repo_full_name.split("/");
  return { token, owner, repo };
}

/** The ids among `objectIds` whose file the tiler would find in the repository at HEAD, on `siteVersion`. */
async function readyFromRepository(
  read: RepositoryRead,
  objectIds: readonly string[],
  siteVersion: string | null,
): Promise<string[]> {
  const { tree } = await getRepoTree(read.token, read.owner, read.repo);
  const stems = tileableStems(tree, siteVersion);
  return objectIds.filter((id) => tiledFromFiles(stems, id, siteVersion));
}

/**
 * The objects page's `probe-tiles` read: the ids in `rawIds` (a JSON list the
 * page posts) whose tiles answer on the page's site, or, on a site with no
 * base the probe may ask, whose file the tiler would find. Either way the id
 * the site gives an object is the repository's version's at HEAD, the one the
 * deployed site was built with (D1's where it names none or cannot be read),
 * read once per call.
 * No site, a list that cannot be read, or a read that fails answers none ready
 * and none not found; a site with no base the probe may ask never answers not found.
 */
export async function readyTilesForProject(
  db: ReturnType<typeof getDb>,
  env: Env,
  user: { encrypted_access_token: string },
  page: ProbedPage | null,
  rawIds: unknown,
): Promise<TileProbeAnswer> {
  if (!page) return NO_TILES_ANSWERED;
  let ids: unknown;
  try {
    ids = JSON.parse(String(rawIds ?? ""));
  } catch {
    return NO_TILES_ANSWERED;
  }
  if (!Array.isArray(ids)) return NO_TILES_ANSWERED;
  try {
    const [config] = await db.select().from(project_config).where(eq(project_config.project_id, page.project.id)).limit(1);
    const strings = ids.filter((id): id is string => typeof id === "string");
    const read = await repositoryReadFor(env, user, page);
    const d1Version = configFrameworkVersion(config);
    const siteVersion = await readRepositorySiteVersion(read.token, read.owner, read.repo, "HEAD", d1Version)
      .catch(() => d1Version);
    const base = configSiteBase(config);
    if (base && isSafeSiteBase(base)) return await probeTileStates(base, strings, siteVersion);
    return { site: null, ready: await readyFromRepository(read, strings, siteVersion), notFound: [] };
  } catch {
    return NO_TILES_ANSWERED;
  }
}
