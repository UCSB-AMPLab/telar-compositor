/**
 * The error every strict read of a repository file throws when GitHub answers
 * with something other than the file or a 404, shared by the syncs, the
 * orphan restore and the story-file check.
 *
 * Kept apart from the modules that throw it and the one that turns it into an
 * action's answer (`syncFailure`), so none of them imports another for it.
 *
 * @version v1.5.0-beta
 */

/**
 * A file a sync or a restore reads could not be read from GitHub. Refused
 * rather than read as a missing file, which offers everything the file holds
 * as removed. `path` is the file's path in the repository.
 */
export class SheetUnreadableError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`${path} could not be read`);
    this.name = "SheetUnreadableError";
    this.path = path;
  }
}
