/**
 * Selecting a step in the story editor.
 *
 * Selecting is four writes that must happen together: the index the editor
 * renders from, both layer panels closed, and the URL mirrored so the position
 * is restorable and shareable. A caller that performs three of them leaves the
 * editor showing one step with another step's layer panel open, or a URL that
 * points somewhere else, so they live here as one sequence rather than as a
 * line repeated at each site that selects.
 *
 * The sinks are passed in because the state and the search params belong to the
 * route; what belongs here is the order and the completeness.
 *
 * @version v1.5.0-beta
 */

/** The writes a selection performs, as the route supplies them. */
export interface StepSelectionSinks {
  setActiveStepIndex: (index: number) => void;
  /** Closes both layer panels. */
  closePanels: () => void;
  setSearchParams: (
    update: (prev: URLSearchParams) => URLSearchParams,
    options: { replace: boolean }
  ) => void;
}

/**
 * The search params a step selection mirrors: `?step=N` for a step, neither
 * parameter for the title card at index 0, and no `?layer` either way, since
 * selecting a step closes any open layer.
 */
export function stepParamsFor(prev: URLSearchParams, index: number): URLSearchParams {
  const next = new URLSearchParams(prev);
  if (index > 0) next.set("step", String(index));
  else next.delete("step");
  next.delete("layer");
  return next;
}

/** Select the step at a one-based index; index 0 is the title card. */
export function selectStepIn(sinks: StepSelectionSinks, index: number): void {
  sinks.setActiveStepIndex(index);
  sinks.closePanels();
  sinks.setSearchParams((prev) => stepParamsFor(prev, index), { replace: true });
}
