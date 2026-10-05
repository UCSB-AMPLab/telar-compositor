/**
 * Which file the build reads as a site's project, objects or glossary sheet:
 * the English name, else the Spanish one where the English file is not there
 * (`find_csv_with_fallback` in scripts/telar/core.py). The import, the sync
 * and the publish read each sheet from that file. The publish writes the
 * English name and deletes the Spanish file in the same commit
 * (`spanishSheetCounterparts`), so no stale Spanish file is left beside it.
 *
 * A leaf module, with nothing imported at run time, so that a module the
 * import itself loads can use it.
 *
 * @version v1.5.0-beta
 */

import type { FileAtRef } from "~/lib/github.server";

/** The directory the build converts sheets from, relative to the site root. */
export const SPREADSHEETS_DIR = "telar-content/spreadsheets";

/**
 * The file names the build reads as something other than a story, as
 * `find_csv_with_fallback` looks for them: English first.
 */
export const PROJECT_SHEETS = ["project.csv", "proyecto.csv"] as const;
export const OBJECTS_SHEETS = ["objects.csv", "objetos.csv"] as const;
export const GLOSSARY_SHEETS = ["glossary.csv", "glosario.csv"] as const;

/** A role the build reads one sheet in, by name, rather than as a story. */
export type SiteSheetRole = "project" | "objects" | "glossary";

const SITE_SHEETS: Record<SiteSheetRole, readonly string[]> = {
  project: PROJECT_SHEETS,
  objects: OBJECTS_SHEETS,
  glossary: GLOSSARY_SHEETS,
};

/**
 * The sheet the build reads in `role` at one commit, by `read`, which gives a
 * file's content, null where the file is not there, and throws where it cannot
 * be read. Where neither name is there, `path` and `name` are the English
 * ones, which is where a sheet the site lacks is written.
 */
export async function readSiteSheet<T>(
  role: SiteSheetRole,
  read: (path: string) => Promise<T | null>,
): Promise<{ path: string; name: string; content: T | null }> {
  for (const name of SITE_SHEETS[role]) {
    const content = await read(`${SPREADSHEETS_DIR}/${name}`);
    if (content !== null) return { path: `${SPREADSHEETS_DIR}/${name}`, name, content };
  }
  const name = SITE_SHEETS[role][0];
  return { path: `${SPREADSHEETS_DIR}/${name}`, name, content: null };
}

/**
 * `readSiteSheet` over a reader that answers as `getFileAtRef` does: a failed
 * read of the English file is that answer, never taken for an absent one.
 */
export async function siteSheetFileAt(
  role: SiteSheetRole,
  read: (path: string) => Promise<FileAtRef>,
): Promise<{ path: string; name: string; file: FileAtRef }> {
  const found = await readSiteSheet(role, async (path) => {
    const file = await read(path);
    return file.status === "absent" ? null : file;
  });
  return { path: found.path, name: found.name, file: found.content ?? { status: "absent" } };
}

/** The file name the publish writes a sheet read from `fileName` to: a site sheet's English name, else `fileName` itself. */
export function writtenSheetName(fileName: string): string {
  const role = (Object.keys(SITE_SHEETS) as SiteSheetRole[]).find((r) => SITE_SHEETS[r].includes(fileName));
  return role ? SITE_SHEETS[role][0] : fileName;
}

/** The path the publish writes the sheet in `role` to: the English name, whichever file it was read from. */
export function writtenSheetPath(role: SiteSheetRole): string {
  return `${SPREADSHEETS_DIR}/${SITE_SHEETS[role][0]}`;
}

/**
 * The Spanish files that stand beside the English sheets a commit writes. The
 * build never reads `proyecto.csv` or `objetos.csv` as stories, so each is
 * named whenever its English sheet is written. `glosario.csv` is a story the
 * build converts when `glossary.csv` is there, so it is named only when the
 * publish read the glossary from it (`glossaryReadFrom`, the path the read
 * selected), which is the case only when `glossary.csv` was absent. The commit
 * deletes the ones present at the head it is built on.
 */
export function spanishSheetCounterparts(
  files: ReadonlyArray<{ path: string }>,
  glossaryReadFrom?: string,
): string[] {
  const written = new Set(files.map((f) => f.path));
  return (Object.keys(SITE_SHEETS) as SiteSheetRole[])
    .filter((role) => written.has(writtenSheetPath(role)))
    .map((role) => `${SPREADSHEETS_DIR}/${SITE_SHEETS[role][1]}`)
    .filter((path) => !path.endsWith("/glosario.csv") || glossaryReadFrom === path);
}

/** A sheet read's text without its byte-order mark, or null when the file is absent or unreadable (logged under `label`). */
export function sheetReadText(path: string, answer: FileAtRef, label: string): string | null {
  if (answer.status === "ok") return answer.content.replace(/^\uFEFF/, "");
  if (answer.status === "error") console.warn(`${label}: could not read ${path}`);
  return null;
}
