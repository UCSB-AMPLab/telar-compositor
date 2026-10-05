/**
 * Reads the kinds a site offers a glossary entry (see `glossary-kinds.ts`) at
 * the commit the project was imported from. A commit's files never change, so
 * a complete read is kept for later loads of the same project and commit.
 * A failed read is never kept and never throws: the editor then
 * offers no kind to choose. The site's own kinds stored in D1
 * (`project_config.glossary_kinds_json`) replace the config's after the
 * kept read, so what is kept is only ever the commit's.
 *
 * @version v1.5.0-beta
 */
import { decrypt } from "~/lib/crypto.server";
import { getFileAtRef } from "~/lib/github.server";
import {
  NO_GLOSSARY_KINDS,
  parseGlossaryKinds,
  siteLanguage,
  storedSiteKinds,
  withSiteKinds,
  type GlossaryKinds,
} from "~/lib/glossary-kinds";

interface KindsProject {
  id: number;
  github_repo_full_name: string;
  head_sha: string | null;
}

const CACHE_LIMIT = 64;
const cache = new Map<string, GlossaryKinds>();

type KindsFile = Awaited<ReturnType<typeof getFileAtRef>>;
const contentOf = (file: KindsFile): string | null => (file.status === "ok" ? file.content : null);

function keepKinds(key: string, kinds: GlossaryKinds): void {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, kinds);
}

/**
 * The site's three files at `ref`: the core kinds, the config, and the
 * language file the config names, English when the site has none for it.
 */
async function kindFiles(token: string, owner: string, repo: string, ref: string): Promise<KindsFile[]> {
  const get = (path: string) => getFileAtRef(token, owner, repo, path, ref, { strict: true });
  const [core, config] = await Promise.all([get("_data/glossary_kinds.yml"), get("_config.yml")]);
  const language = siteLanguage(contentOf(config));
  let lang = await get(`_data/languages/${language}.yml`);
  if (lang.status === "absent" && language !== "en") lang = await get("_data/languages/en.yml");
  return [core, config, lang];
}

/**
 * The site's kinds: the commit's core kinds, with the site kinds `stored`
 * holds when it holds a list, else the commit's config's.
 */
export async function readGlossaryKinds(
  env: Env,
  encryptedToken: string,
  project: KindsProject,
  stored: string | null = null,
): Promise<GlossaryKinds> {
  const kinds = await readRepoKinds(env, encryptedToken, project);
  const site = storedSiteKinds(stored);
  return site ? withSiteKinds(kinds, site) : kinds;
}

async function readRepoKinds(env: Env, encryptedToken: string, project: KindsProject): Promise<GlossaryKinds> {
  try {
    const [owner, repo] = project.github_repo_full_name.split("/");
    if (!owner || !repo) return NO_GLOSSARY_KINDS;
    const key = `${project.id}:${project.github_repo_full_name}@${project.head_sha}`;
    const kept = project.head_sha ? cache.get(key) : undefined;
    if (kept) return kept;
    const token = await decrypt(encryptedToken, env.ENCRYPTION_KEY);
    const files = await kindFiles(token, owner, repo, project.head_sha ?? "HEAD");
    const parsed = parseGlossaryKinds(...(files.map(contentOf) as [string | null, string | null, string | null]));
    const kinds: GlossaryKinds = files[1].status === "error" ? { ...parsed, configInconclusive: true } : parsed;
    if (project.head_sha && files.every((file) => file.status !== "error")) keepKinds(key, kinds);
    return kinds;
  } catch {
    return NO_GLOSSARY_KINDS;
  }
}

/** Forget every kept read. For tests. */
export function clearGlossaryKindsCache(): void {
  cache.clear();
}
