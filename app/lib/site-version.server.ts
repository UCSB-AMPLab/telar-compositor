/**
 * Which framework version the Compositor matches object ids with.
 *
 * The id the site gives an object (`siteObjectId`) depends on the release the
 * site builds with, since the set of extensions the framework strips from an
 * id changes between releases. Two rules apply, and each call site takes the
 * one that fits what it reads:
 *
 *   - Code that reads the repository — its objects.csv, its tree, its files —
 *     and matches ids against it predicts what the site builds from that
 *     same commit, so it takes the repository's version at the ref it reads:
 *     `telar.version` in `_config.yml` there, and D1's only where the
 *     repository names none (`siteVersionAtRef`, `readRepositorySiteVersion`,
 *     `siteVersionFrom`). After an upgrade made on GitHub the two differ, and
 *     D1's would match the new files by the old rule. The import, the objects
 *     sync's check and apply, the full sync's check and apply, the objects
 *     page's file enrichment and the deletion from the repository read this
 *     way.
 *   - Code that renders the editor from D1 alone — image addresses, a step's
 *     object in the story editor, use counts, the objects page's warnings,
 *     story covers — reads no commit, so it takes D1's `telar_version`
 *     (`readSiteTelarVersion`), the version the Compositor holds for the site.
 *
 * The repository's version is read from `_config.yml` with the YAML parse the
 * import reads it with (`parseYaml`, `telarVersionOf`), so the import's
 * `not_telar` gate and id matching read one value however the file writes
 * it, a flow mapping (`telar: {version: 1.8.0}`) included. The syncs'
 * `telar_version` heal reads the repository's version the same way.
 *
 * A `_config.yml` that is not valid YAML names no version, as the import's
 * `mainBranchState` probe reads it: the site does not build from it, so D1's
 * version cannot disagree with anything published. A failed read of the file
 * throws `SheetUnreadableError`: a version guessed from D1 while the
 * repository's cannot be read is the mismatch this module exists to prevent.
 *
 * `extractTelarVersion` (line-based) stays for build-workflow.server.ts, which
 * reads the version the framework scripts are pinned to.
 *
 * @version v1.5.0-beta
 */

import { eq } from "drizzle-orm";
import { project_config } from "~/db/schema";
import type { getDb } from "~/lib/db.server";
import { findInYamlBlock } from "~/lib/config-yaml-block.server";
import { getFileAtRef } from "~/lib/github.server";
import { SheetUnreadableError } from "~/lib/unreadable-file.server";
import { parseYaml } from "~/lib/yaml.server";

const CONFIG_YML_PATH = "_config.yml";

/** D1's `telar_version` for the site (without the `v`), or null. */
export async function readSiteTelarVersion(db: ReturnType<typeof getDb>, projectId: number): Promise<string | null> {
  const rows = await db
    .select({ telar_version: project_config.telar_version })
    .from(project_config)
    .where(eq(project_config.project_id, projectId))
    .limit(1);
  return rows[0]?.telar_version ?? null;
}

/**
 * Extract the `version:` value from the `telar:` block of a site's
 * _config.yml. Returns null when absent or malformed. Delegates the
 * block-walk to the shared `findInYamlBlock` in config-yaml-block.server.ts
 * (the same idiom `updateTelarVersionInConfig` in upgrade.server.ts uses on
 * the write side) to avoid a full YAML parse — keeps comments/whitespace-
 * tolerance cheap and preserves behaviour on the same exotic inputs.
 *
 * `haltAfterBlock: true` preserves this function's original behaviour of
 * stopping the whole scan once the (first) telar: block ends, rather than
 * continuing to look for a later duplicate top-level `telar:` key.
 *
 * Re-exported from sync.server.ts, where tests/sync.server.test.ts and
 * build-workflow.server.ts import it.
 */
export function extractTelarVersion(yamlContent: string): string | null {
  return (
    findInYamlBlock(
      yamlContent,
      "telar",
      (line) => {
        const m = line.match(/^\s+version:\s*["']?([^\s"'#]+)/);
        return m ? m[1] : undefined;
      },
      { haltAfterBlock: true },
    ) ?? null
  );
}

/** A parsed `_config.yml`'s `telar.version`, the key that marks a Telar site. */
export function telarVersionOf(config: unknown): string | undefined {
  const telar = (config as Record<string, unknown> | null | undefined)?.telar as Record<string, unknown> | undefined;
  return telar?.version as string | undefined;
}

/**
 * The version a read of the repository matches ids with, given its parsed
 * `_config.yml`: the repository's, else D1's. A version YAML reads as a number
 * (`version: 1.8`) is taken as its text.
 */
export function siteVersionFromParsed(config: unknown, d1Version: string | null): string | null {
  const version: unknown = telarVersionOf(config);
  if (version === undefined || version === null || version === "") return d1Version;
  return String(version);
}

/**
 * The version a read of the repository matches ids with, given the
 * `_config.yml` read at that ref (null for none): the repository's, else D1's.
 * A file that is not valid YAML names none.
 */
export function siteVersionFrom(configYml: string | null, d1Version: string | null): string | null {
  if (configYml === null) return d1Version;
  let config: unknown;
  try {
    config = parseYaml(configYml);
  } catch {
    return d1Version;
  }
  return siteVersionFromParsed(config, d1Version);
}

/** The repository's version at `ref`, read from its `_config.yml`, else D1's. */
export async function readRepositorySiteVersion(
  token: string,
  owner: string,
  repo: string,
  ref: string,
  d1Version: string | null,
): Promise<string | null> {
  const read = await getFileAtRef(token, owner, repo, CONFIG_YML_PATH, ref, { strict: true });
  if (read.status === "error") throw new SheetUnreadableError(CONFIG_YML_PATH);
  return siteVersionFrom(read.status === "ok" ? read.content.replace(/^﻿/, "") : null, d1Version);
}

/**
 * How a function that reads the repository at a ref of its own learns the
 * version: `{ d1 }` to read `_config.yml` at that ref and fall back to D1's,
 * or `{ atRef }` from a caller that has already read it at the same ref.
 */
export type SiteVersionSource = { d1: string | null } | { atRef: string | null };

/** The version `source` gives for a read of the repository at `ref`. */
export async function siteVersionAtRef(
  source: SiteVersionSource,
  token: string,
  owner: string,
  repo: string,
  ref: string,
): Promise<string | null> {
  if ("atRef" in source) return source.atRef;
  return readRepositorySiteVersion(token, owner, repo, ref, source.d1);
}
