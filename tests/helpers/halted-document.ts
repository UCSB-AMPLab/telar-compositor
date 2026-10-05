/**
 * Put a Durable Object instance into the state a halt leaves it in, without
 * going through the failure that raises one.
 *
 * The halt is one resident state — the generation it belongs to and the marker
 * that names its reason — and every route, fence and snapshot guard reads that
 * one thing. A test that wants to observe what a halted instance refuses plants
 * it here rather than driving a guard failure it is not testing.
 *
 * @version v1.5.0-beta
 */

/** The reasons the codec's marker carries, as the instance holds them. */
type PlantedReason =
  | "enforcement_failed"
  | "fence_refused"
  | "apply_failed"
  | "log_corrupt"
  | "bad_halt";

export function plantHalt(
  instance: unknown,
  reason: PlantedReason = "enforcement_failed",
  generation = 0,
): void {
  Object.assign(instance as object, {
    persistenceHalted: { generation, marker: { v: 1, reason, at: Date.now() } },
  });
}

/** Whether the instance is halted right now, and for which generation. */
export function haltOf(
  instance: unknown,
): { generation: number; marker: { reason: string; at: number } } | null {
  return (instance as { persistenceHalted: { generation: number; marker: { reason: string; at: number } } | null })
    .persistenceHalted;
}
