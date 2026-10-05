/**
 * The framework's developer-only files: the paths the template carries for
 * the framework's own development, which a site does not.
 *
 * One reader of the release's list, shared by the three places that deliver
 * framework files to a site: site creation deletes the listed files from the
 * repository it generates, the upgrade neither adds nor deletes them through
 * its tree diff (a site's own copy is the manifest's to delete), and the
 * publish-time heal never restores one. A release before framework 1.8.0
 * carries no list, and has no developer-only paths.
 *
 * @version v1.5.0-beta
 */

import { getRepoTree } from "~/lib/github.server";
import { ReleaseFileUnreadableError } from "~/lib/upgrade-reads.server";

/**
 * The framework's list of files it needs for its own development and a site
 * does not: one repository-relative path per line, a directory ending in "/",
 * "#" lines notes, blank lines ignored. Templates before framework 1.8.0 do not
 * carry it.
 */
export const DEV_ONLY_FILES_PATH = "scripts/dev-only-files.txt";

/**
 * The FRAMEWORK_FILES entries the 1.8.0 release's list names: the developer-
 * only files the heal would otherwise restore, withheld when a release's list
 * cannot be read. A test holds this to the recorded 1.8.0 list, so the two do
 * not drift apart unseen.
 */
export const KNOWN_DEV_ONLY_FRAMEWORK_FILES: readonly string[] = ["vitest.config.js", "pytest.ini"];

/**
 * The list's entries in file order, a directory's trailing "/" kept, as the
 * framework's `read_dev_only_files()` returns them.
 */
export function parseDevOnlyFiles(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/**
 * Whether a list entry names `path`: a file entry names itself, a directory
 * entry every path under it. The list itself is never developer-only, since
 * it stays with the site.
 */
export function isDevOnlyPath(path: string, entries: readonly string[]): boolean {
  if (path === DEV_ONLY_FILES_PATH) return false;
  return entries.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry));
}

/**
 * The blobs the listed entries name in the generated repository: a file entry
 * that is in the tree, and every blob under a directory entry. Only paths in
 * the tree are returned, so an entry that is absolute or climbs out with ".."
 * matches nothing. A path the born-clean commit writes is left out, and so is
 * the list itself, which stays with the site.
 */
export function devOnlyDeletions(
  entries: string[],
  blobPaths: string[],
  written: ReadonlySet<string>,
): string[] {
  const blobs = new Set(blobPaths);
  const out = new Set<string>();
  for (const entry of entries) {
    if (entry.endsWith("/")) {
      for (const path of blobPaths) if (path.startsWith(entry)) out.add(path);
    } else if (blobs.has(entry)) {
      out.add(entry);
    }
  }
  return [...out].filter((path) => !written.has(path) && path !== DEV_ONLY_FILES_PATH);
}

/**
 * The developer-only files to delete from a freshly generated repository.
 * Read from its tree, which by now has replicated (every file read before this
 * one returned): a list missing from the tree is a template without one, not a
 * lag to wait out. A tree that cannot be read, or comes back truncated, leaves
 * the files in place rather than failing the site's creation. `readList` reads
 * the list from the new repository with the caller's retry.
 */
export async function devOnlyFilesToDelete(
  token: string,
  owner: string,
  name: string,
  written: ReadonlySet<string>,
  readList: (path: string) => Promise<string>,
): Promise<string[]> {
  let blobPaths: string[];
  try {
    const { tree, truncated } = await getRepoTree(token, owner, encodeURIComponent(name));
    if (truncated) {
      // eslint-disable-next-line no-console
      console.warn("[commitBornCleanSite] repository tree truncated; developer-only files left in place");
      return [];
    }
    blobPaths = tree.filter((e) => e.type === "blob").map((e) => e.path);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[commitBornCleanSite] repository tree unreadable; developer-only files left in place:", err);
    return [];
  }
  if (!blobPaths.includes(DEV_ONLY_FILES_PATH)) return [];
  const list = await readList(DEV_ONLY_FILES_PATH);
  return devOnlyDeletions(parseDevOnlyFiles(list), blobPaths, written);
}

/**
 * A release file as a framework read answers it: found, absent (404) or
 * failed. A found file with `encoding: "base64"` is binary, its content the
 * bytes in base64.
 */
export type ReleaseFileRead =
  | { kind: "found"; content: string; encoding?: "base64" }
  | { kind: "absent" }
  | { kind: "failed" };

/**
 * A framework release's developer-only entries. A release that does not ship
 * the list (404) has none; a read that fails or throws throws
 * ReleaseFileUnreadableError naming the list and `version`, the release's
 * framework version, since reading an outage as an empty list would deliver
 * the files the list keeps off a site.
 */
export async function releaseDevOnlyEntries(
  read: (path: string) => Promise<ReleaseFileRead>,
  version: string,
): Promise<string[]> {
  let file: ReleaseFileRead;
  try {
    file = await read(DEV_ONLY_FILES_PATH);
  } catch (err) {
    throw new ReleaseFileUnreadableError(DEV_ONLY_FILES_PATH, version, { cause: err });
  }
  if (file.kind === "absent") return [];
  if (file.kind === "failed") throw new ReleaseFileUnreadableError(DEV_ONLY_FILES_PATH, version);
  return parseDevOnlyFiles(file.content);
}
