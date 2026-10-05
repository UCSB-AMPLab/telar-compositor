/**
 * useStageWriteFailure — which of the stage's three writes sent through the
 * story route's action (a capture, an object change, a page choice) came back
 * failed, for the step selected.
 *
 * A write's step is the one its submission targeted: the `stepId` of the
 * fetcher's form data, read while it is submitting. Each answer is taken
 * once, when it first arrives: a failed one (`{ ok: false }`: the action's
 * refusal, or a write that failed in transit) is held for that control on
 * that step, and the next answer to the same control on the same step
 * replaces it, so a success clears it. Every control failed on the step
 * selected is reported.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useRef, useState } from "react";
import { isRefusedSave } from "~/hooks/use-report-refused-save";
import { selectionKeyFor } from "~/lib/step-writes";

export type StageWrite = "capture" | "object" | "page";

/** What the hook reads of each write's fetcher. */
export type StageFetchers = Record<StageWrite, { data: unknown; formData?: FormData }>;

const WRITES = ["capture", "object", "page"] as const;

/** One failed write: the control and the selection key of the step it targeted. */
interface FailedWrite {
  write: StageWrite;
  step: string;
}

/** The failures once `write`'s answer for `step` is taken: the step's earlier one replaced. */
function withAnswer(failures: FailedWrite[], write: StageWrite, step: string, answer: unknown): FailedWrite[] {
  const others = failures.filter((f) => f.write !== write || f.step !== step);
  return isRefusedSave(answer) ? [...others, { write, step }] : others;
}

export function useStageWriteFailure(fetchers: StageFetchers, selectionKey: string): StageWrite[] {
  const [failures, setFailures] = useState<FailedWrite[]>([]);
  const targets = useRef<Record<StageWrite, string | null>>({ capture: null, object: null, page: null });
  const seen = useRef<Record<StageWrite, unknown>>({ capture: undefined, object: undefined, page: undefined });
  for (const write of WRITES) {
    const stepId = fetchers[write].formData?.get("stepId");
    if (typeof stepId === "string") targets.current[write] = selectionKeyFor({ id: Number(stepId) }, false);
  }
  useEffect(() => {
    for (const write of WRITES) {
      const answer = fetchers[write].data;
      const step = targets.current[write];
      if (answer === undefined || answer === seen.current[write] || step === null) continue;
      seen.current[write] = answer;
      setFailures((prev) => withAnswer(prev, write, step, answer));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchers.capture.data, fetchers.object.data, fetchers.page.data]);
  return WRITES.filter((write) => failures.some((f) => f.write === write && f.step === selectionKey));
}
