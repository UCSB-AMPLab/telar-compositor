/**
 * This file turns a refused field save into the answer the route gives it.
 *
 * The story editor's saves gate on the entity they write and on the author's
 * membership of its project, and those gates throw a Response. Thrown from an
 * action, a Response becomes a route error and the editor gives way to its
 * error card. A save answers its refusal as data instead, with the status the
 * gate chose and a reason the caller can read, so one field reports one
 * failed save and the editor stays open. Nothing is written in either case.
 *
 * Anything thrown that is not a Response is a failure of the save itself; it
 * is answered as a 500 and logged here, because an answer does not reach the
 * error boundary that reports what an action throws.
 *
 * @version v1.5.0-beta
 */

/** Why a save was refused, as the caller reads it. */
export type SaveRefusalReason = "bad-request" | "forbidden" | "not-found" | "failed";

export interface SaveRefusal {
  status: number;
  reason: SaveRefusalReason;
}

const REASONS: Record<number, SaveRefusalReason> = {
  400: "bad-request",
  403: "forbidden",
  404: "not-found",
};

/** The status and reason a save refused by `error` answers with. */
export function saveRefusalOf(error: unknown): SaveRefusal {
  if (error instanceof Response) {
    return { status: error.status, reason: REASONS[error.status] ?? "failed" };
  }
  console.error("save failed", error);
  return { status: 500, reason: "failed" };
}
