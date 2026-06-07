/**
 * Single source of truth for the shared project UndoManager's options, with
 * the cross-user undo invariant made explicit.
 *
 * trackedOrigins = { null } records LOCAL structural ops (they transact with no
 * origin). yCollab additionally registers each editor's YSyncConfig at mount
 * (addTrackedOrigin), so local text edits are tracked too. Yjs also inserts the
 * UndoManager instance itself into this Set inside the constructor, so undo/redo
 * transactions are captured too. REMOTE edits arrive
 * via y-websocket with `origin = provider` — neither null nor a YSyncConfig — so
 * they never enter the stack and a collaborator's edit can't be undone locally.
 *
 * @version v1.3.0-beta
 */
import * as Y from "yjs";

/** captureTimeout (ms) for grouping rapid edits into one undo step. */
export const UNDO_CAPTURE_TIMEOUT = 500;

export function createUndoManager(
  // Matches Yjs's own UndoManager typeScope signature (Array<AbstractType<any>>).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  types: Array<Y.AbstractType<any>>
): Y.UndoManager {
  return new Y.UndoManager(types, {
    captureTimeout: UNDO_CAPTURE_TIMEOUT,
    trackedOrigins: new Set([null]),
  });
}
