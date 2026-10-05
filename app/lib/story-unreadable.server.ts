/**
 * Why a story's files could not be read, as the code the sync dialog writes a
 * sentence from. An error with no code of its own gets the general one, so the
 * dialog never shows an error's text.
 *
 * @version v1.5.0-beta
 */

import { CollidingColumnsRefusal } from "~/lib/import.server";
import type { UnreadableReason } from "~/lib/story-canonical";

/** A layer reference the check cannot resolve with certainty. */
export class LayerReferenceUnreadable extends Error {
  constructor(readonly reason: UnreadableReason) {
    super(JSON.stringify(reason));
    this.name = "LayerReferenceUnreadable";
  }
}

export function reasonOf(err: unknown): UnreadableReason {
  if (err instanceof LayerReferenceUnreadable) return err.reason;
  if (err instanceof CollidingColumnsRefusal) return { code: "columns_collide", column: err.canonicalName, headers: err.headers };
  return { code: "files_unreadable" };
}
