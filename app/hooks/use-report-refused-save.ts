/**
 * useReportRefusedSave — reports a field save the route's action refused.
 *
 * A save that is refused (the entity it writes is gone, or the author is not
 * a member of its project) is answered with `{ ok: false }` and an error
 * status, not thrown, so the editor stays open. The answer is still a failed
 * save, never a success: the fetcher's data carries it, and this hook sends it
 * down the same path as a save whose request failed, with the same message.
 *
 * @version v1.5.0-beta
 */

import { useEffect } from "react";

/** An action's answer to a save it refused. */
export interface RefusedSave {
  ok: false;
  reason?: string;
}

/** Whether a fetcher's data is a refused save. */
export function isRefusedSave(result: unknown): result is RefusedSave {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { ok?: unknown }).ok === false
  );
}

/**
 * Logs `message` with the refusal's reason each time `result` becomes a new
 * refused save. `result` is a fetcher's `data`, which is a new object per
 * answer, so two refusals in a row are reported twice.
 */
export function useReportRefusedSave(result: unknown, message: string): void {
  useEffect(() => {
    if (isRefusedSave(result)) console.error(message, result.reason ?? "refused");
  }, [result, message]);
}
