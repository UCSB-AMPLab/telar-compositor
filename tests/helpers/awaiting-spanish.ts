/**
 * The English keys whose Colombian Spanish is drafted and reviewed separately
 * from the build that adds the English, by namespace and dot-joined key path.
 *
 * Both parity guards read this one list, so an exception cannot be granted in
 * one and forgotten in the other. Every entry has to be present in `en` and
 * absent from `es`: a key that has gained its Spanish fails the guards until it
 * is taken off the list, which is what keeps the list from outliving the review
 * it stands in for. An empty map is the resting state.
 *
 * @version v1.5.0-beta
 */

export const AWAITING_SPANISH: Record<string, string[]> = {};

/** The pending keys for a namespace, named either `popover` or `popover.json`. */
export function awaitingSpanish(namespaceOrFile: string): string[] {
  return AWAITING_SPANISH[namespaceOrFile.replace(/\.json$/, "")] ?? [];
}
