/**
 * Reads the site's preview configuration for the story editor's loader: the
 * KaTeX settings in `_data/katex.yml`, the colours and fonts of the site's
 * theme, and the site's Telar version in `_config.yml`, at the commit the
 * project was imported from, so the preview
 * matches the files the editor edits. The caller has already resolved the
 * signed-in member and the active project; nothing here takes a repository
 * or address from the request.
 *
 * A commit's files never change, so a configuration read in full at a
 * commit is kept for later loads of the same project, commit and theme. A
 * new import or a theme change is a new key and is read afresh. A failed
 * read is never kept, and never throws: the editor is told the preview is
 * unavailable and leaves formulas as source.
 *
 * The version is read as the import reads it (`mapConfigToProjectConfig`)
 * and compared as the upgrade flow compares versions (`compareVersions`),
 * where a prerelease is older than its release: a site on 1.8.0-rc.1 counts
 * as older than 1.8.0. A version that is missing or malformed makes no
 * claim either way.
 *
 * @version v1.5.0-beta
 */
import { eq } from "drizzle-orm";
import { decrypt } from "~/lib/crypto.server";
import { getFileAtRef } from "~/lib/github.server";
import { getDb } from "~/lib/db.server";
import { project_config } from "~/db/schema";
import { parseYaml } from "~/lib/yaml.server";
import { mapConfigToProjectConfig } from "~/lib/import.server";
import { compareVersions, parseTelarVersion } from "~/lib/telar-version";
import {
  parsePanelPreviewConfig,
  unavailablePanelPreview,
  type PanelPreviewConfig,
} from "~/lib/panel-preview-config";

interface PreviewProject {
  id: number;
  github_repo_full_name: string;
  head_sha: string | null;
}

/** The framework release whose output the preview shows. */
export const PREVIEW_FRAMEWORK_VERSION = "1.8.0";

/**
 * A whole version string: an optional `v`, three numbers and an optional
 * prerelease of non-empty identifiers separated by dots. `parseTelarVersion`
 * reads the numbers with `parseInt`, which accepts `1.7.2garbage`, so the
 * string is checked in full first.
 */
const TELAR_VERSION = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Whether `version` is a well-formed Telar version older than the preview's. */
export function olderThanPreviewFramework(version: string | null): boolean {
  if (!version || !TELAR_VERSION.test(version) || !parseTelarVersion(version)) return false;
  return compareVersions(version, PREVIEW_FRAMEWORK_VERSION) < 0;
}

/** The site's Telar version in `_config.yml`, or null when there is none to read. */
function siteVersionIn(configYaml: string | null): string | null {
  if (!configYaml) return null;
  try {
    const version = mapConfigToProjectConfig(parseYaml(configYaml)).telar_version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

const CACHE_LIMIT = 64;
const cache = new Map<string, PanelPreviewConfig>();

function remember(key: string, config: PanelPreviewConfig): void {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, config);
}

async function themeOf(env: Env, projectId: number): Promise<string> {
  const rows = await getDb(env.DB)
    .select({ theme: project_config.theme })
    .from(project_config)
    .where(eq(project_config.project_id, projectId))
    .limit(1);
  return rows[0]?.theme ?? "trama";
}

async function readAtCommit(
  env: Env,
  encryptedToken: string,
  owner: string,
  repo: string,
  ref: string,
  theme: string,
): Promise<{ config: PanelPreviewConfig; complete: boolean }> {
  const token = await decrypt(encryptedToken, env.ENCRYPTION_KEY);
  const [mathFile, themeFile, siteFile] = await Promise.all([
    getFileAtRef(token, owner, repo, "_data/katex.yml", ref, { strict: true }),
    getFileAtRef(token, owner, repo, `_data/themes/${theme}.yml`, ref, { strict: true }),
    getFileAtRef(token, owner, repo, "_config.yml", ref, { strict: true }),
  ]);
  const content = (file: typeof mathFile) => (file.status === "ok" ? file.content : null);
  const config = parsePanelPreviewConfig(content(mathFile), content(themeFile));
  if (mathFile.status === "error" || themeFile.status === "error") config.available = false;
  config.themeId = theme;
  config.siteVersion = siteVersionIn(content(siteFile));
  config.olderFramework = olderThanPreviewFramework(config.siteVersion);
  const complete = [mathFile, themeFile, siteFile].every((file) => file.status !== "error");
  return { config, complete };
}

export async function readPanelPreviewConfig(
  env: Env,
  encryptedToken: string,
  project: PreviewProject,
): Promise<PanelPreviewConfig> {
  try {
    const [owner, repo] = project.github_repo_full_name.split("/");
    const theme = await themeOf(env, project.id);
    if (!owner || !repo || !/^[\w-]+$/.test(theme)) return unavailablePanelPreview();
    const ref = project.head_sha ?? "HEAD";
    const key = `${project.id}:${project.github_repo_full_name}@${ref}:${theme}`;
    const kept = project.head_sha ? cache.get(key) : undefined;
    if (kept) return kept;
    const { config, complete } = await readAtCommit(env, encryptedToken, owner, repo, ref, theme);
    if (complete && project.head_sha) remember(key, config);
    return config;
  } catch {
    return unavailablePanelPreview();
  }
}

/** Forget every kept configuration. For tests. */
export function clearPanelPreviewCache(): void {
  cache.clear();
}
