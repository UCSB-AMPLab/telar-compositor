/**
 * The reads an upgrade's prepare makes, and the failures that stop it.
 *
 * Prepare reads two repositories: the site's, at the head commit it listed
 * the tree at, and the framework's, at the release it upgrades to. Each read
 * either answers or stops prepare with a failure naming what could not be
 * read. Only a 404 reads as absent: an outage read as "no such file" would
 * commit an upgrade built on a file set that is not the site's or the
 * release's.
 *
 * @version v1.5.0-beta
 */

import type { FileAtRef } from "~/lib/github.server";

/** A file of the site's repository prepare could not read at its head. */
export class UpgradeFileUnreadableError extends Error {
  constructor(readonly path: string) {
    super(`could not read ${path} from the site's repository`);
    this.name = "UpgradeFileUnreadableError";
  }
}

/**
 * A file of the site's repository whose bytes are not valid UTF-8. Reading it
 * again answers the same bytes, so it is told apart from a read that failed.
 */
export class UpgradeFileNotTextError extends Error {
  constructor(readonly path: string) {
    super(`${path} in the site's repository is not valid UTF-8 text`);
    this.name = "UpgradeFileNotTextError";
  }
}

/**
 * A file of the framework release prepare could not read. `path` is the
 * release file, `version` the framework version of the release it was read
 * from, which for a migration.json is the release of that hop of the chain.
 */
export class ReleaseFileUnreadableError extends Error {
  constructor(
    readonly path: string,
    readonly version: string,
    options?: { cause?: unknown },
  ) {
    super(`could not read ${path} from framework release ${version}`, options);
    this.name = "ReleaseFileUnreadableError";
  }
}

/** A framework release whose tree could not be read, or was answered truncated. */
export class ReleaseTreeUnreadableError extends Error {
  constructor(
    readonly version: string,
    options?: { cause?: unknown },
  ) {
    super(`could not read the whole tree of framework release ${version}`, options);
    this.name = "ReleaseTreeUnreadableError";
  }
}

/** A framework release whose migration.json does not validate. */
export class ReleaseManifestInvalidError extends Error {
  constructor(
    readonly version: string,
    options?: { cause?: unknown },
  ) {
    super(`the migration.json of framework release ${version} does not validate`, options);
    this.name = "ReleaseManifestInvalidError";
  }
}

/** The framework's release listing could not be read. */
export class ReleaseListUnreadableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("could not read the framework's release listing", options);
    this.name = "ReleaseListUnreadableError";
  }
}

const BOM = "\uFEFF";

/**
 * Reads of the site's files for one prepare, and the byte-order marks they
 * carried.
 *
 * `read` answers a file's text without a leading byte-order mark, since every
 * caller in prepare parses what it reads and a mark before the first line
 * hides that line from a `^key:` match and a `---` front-matter fence. It
 * answers null for a 404, throws UpgradeFileUnreadableError for any other
 * failure, and throws UpgradeFileNotTextError for bytes that are not valid
 * UTF-8, which cannot be written back as they were read.
 *
 * `readKeepingMark` answers the same file with its mark, for a caller that
 * writes back what it edits byte for byte, as the sheet repair does. Each path
 * is fetched once per prepare, so both answers come from the same bytes.
 *
 * `restoreMarks` puts the mark back on each file that had one and is still in
 * `files`, so a file the upgrade writes keeps the bytes the author's file
 * started with.
 */
export interface SiteFileReads {
  read(path: string): Promise<string | null>;
  readKeepingMark(path: string): Promise<string | null>;
  restoreMarks(files: Map<string, string>): void;
}

/** Site reads through `readAtHead`, a strict read of one path at the listed head. */
export function siteFileReads(readAtHead: (path: string) => Promise<FileAtRef>): SiteFileReads {
  const marked = new Set<string>();
  const reads = new Map<string, Promise<FileAtRef>>();
  async function readOncePerPrepare(path: string): Promise<string | null> {
    let pending = reads.get(path);
    if (pending === undefined) {
      pending = readAtHead(path);
      reads.set(path, pending);
    }
    const file = await pending;
    if (file.status === "absent") return null;
    if (file.status === "error") throw new UpgradeFileUnreadableError(path);
    if (file.lossy) throw new UpgradeFileNotTextError(path);
    return file.content;
  }
  return {
    async read(path) {
      const content = await readOncePerPrepare(path);
      if (content === null || !content.startsWith(BOM)) return content;
      marked.add(path);
      return content.slice(BOM.length);
    },
    readKeepingMark: readOncePerPrepare,
    restoreMarks(files) {
      for (const path of marked) {
        const content = files.get(path);
        if (content !== undefined && !content.startsWith(BOM)) files.set(path, BOM + content);
      }
    },
  };
}
