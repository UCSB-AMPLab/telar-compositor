/**
 * The header row of the site's objects sheet, for the object page to order its
 * custom fields by.
 *
 * Nothing in D1 records the sheet's column order, and an object's
 * `extra_columns` blob holds only the cells its row filled, so the order the
 * blobs imply can misplace a column. The file at the recorded head has the
 * order. One strict read of it; any failure gives null and the page falls back
 * to the order the blobs imply.
 *
 * @version v1.5.0-beta
 */

import { pythonStrip } from "~/lib/column-mapping";
import { OBJECTS_SHEETS, SPREADSHEETS_DIR, readFrameworkSheet } from "~/lib/framework-sheet.server";
import { nextUniqueName } from "~/lib/import.server";
import { getFileAtRef, type FileAtRef } from "~/lib/github.server";
import { getInstallationToken, resolveProjectToken } from "~/lib/github-app.server";

/** The columns named as the import names them. */
function importNames(cells: readonly string[]): string[] {
  const declared = new Set(cells);
  const seen = new Map<string, number>();
  const used = new Set<string>();
  return cells.map((cell) => nextUniqueName(cell, seen, used, declared));
}

/**
 * The header cells of the objects sheet as `read` returns it, stripped as the
 * import strips them and named as the import names them: a repeated heading
 * is `notes`, then `notes_1` (`nextUniqueName`). Null when no sheet could be
 * read.
 */
export async function readObjectsSheetHeader(
  read: (path: string) => Promise<FileAtRef>,
): Promise<string[] | null> {
  try {
    for (const name of OBJECTS_SHEETS) {
      const file = await read(`${SPREADSHEETS_DIR}/${name}`);
      if (file.status === "error") return null;
      if (file.status === "ok") return importNames(readFrameworkSheet(file.content).header.map(pythonStrip));
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The header of the project's objects sheet at its recorded head. It is read
 * with the token every repository read of this caller uses
 * (`resolveProjectToken`), and, where that cannot read the file, with the
 * installation's token whatever the role: the file is the project's own and the
 * header is only used to order what the page shows. A member who is not a
 * GitHub collaborator on a private repository cannot read it with their own
 * token. Null when the project has no recorded head or no read succeeds.
 */
export async function readProjectObjectsHeader(
  env: { GITHUB_APP_ID: string; GITHUB_PRIVATE_KEY: string },
  project: { github_repo_full_name: string; installation_id: number; head_sha: string | null },
  userToken: string,
  role: string | null,
): Promise<string[] | null> {
  if (!project.head_sha) return null;
  const [owner, repo] = project.github_repo_full_name.split("/");
  const readWith = (token: string) =>
    readObjectsSheetHeader((path) => getFileAtRef(token, owner, repo, path, project.head_sha as string, { strict: true }));
  const resolved = await attempt(() =>
    resolveProjectToken(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY, project.installation_id, userToken, role),
  );
  const first = resolved === null ? null : await readWith(resolved);
  if (first !== null) return first;
  const installation = await attempt(() =>
    getInstallationToken(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY, project.installation_id),
  );
  return installation === null || installation === resolved ? null : readWith(installation);
}

/** The thunk's value, or null where it throws. */
async function attempt<T>(thunk: () => Promise<T>): Promise<T | null> {
  try {
    return await thunk();
  } catch {
    return null;
  }
}
