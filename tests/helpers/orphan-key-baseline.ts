/**
 * Catalogue keys no component reaches, as they stand today.
 *
 * This is a ratchet, not a permission. Every key below is unreached: no call
 * site names it, and no declared family in `catalogue-key-families.ts`
 * reaches it. The list exists so the scan can be green on what is already
 * here while going red the moment a new unreached key joins it — and so the
 * count is a number rather than an impression.
 *
 * It is enforced in three directions, and the second and third are what stop it
 * becoming a place to put things:
 *
 *   - a dead key absent from this list fails, so the debt cannot grow;
 *   - an entry naming a key the catalogue no longer holds fails, so the list
 *     shrinks as keys are removed and cannot outlive them;
 *   - an entry whose key has become live again fails, so a revived key leaves
 *     rather than sitting here unnoticed.
 *
 * `issue` points at where a group's removal happens. It is a pointer, never a justification: what makes a key
 * dead is in `reason`, and an entry with an issue and no reason would say only
 * that someone intends to look.
 *
 * Deletion is not this file's job. Removing a key is a change to both locales
 * with its own review; a group leaves this list in the same commit that
 * removes its keys, because the second assertion fails on either half alone.
 *
 * WHAT IS LEFT HERE IS NOT WAITING TO BE DELETED. The list began as 256 keys
 * read as rot; 212 of them were, and went. Every entry that remains is copy
 * for something that was designed and never wired — a control with no close,
 * a branch no render names — or a deferral somebody decided on and wrote
 * down. Each group's `reason` says which, and its `issue` is where the
 * wiring is tracked, not where the deletion is.
 *
 * That distinction is the finding this file exists to carry. A key no
 * component references has two readings — nobody renders this any more, and
 * nobody renders this yet — and the scan cannot tell them apart, because from
 * inside the scan they are the same observation. Six keys here were read as
 * rot until somebody opened the code and found the screen they belonged to
 * had never been built. So a future pass over this list reads each cluster
 * against the code before deleting any of it.
 *
 * @version v1.5.0-beta
 */

/** One namespace's dead keys, sharing the reason they are dead. */
export interface OrphanGroup {
  /** Namespace the keys belong to. */
  ns: string;
  /** What makes every key in this group unreachable. */
  reason: string;
  /** Where removal is tracked, or null when nothing tracks it yet. */
  issue: string | null;
  /** Leaf key paths within `ns`. */
  keys: readonly string[];
}

/** One dead key, flattened out of its group. */
export interface OrphanEntry {
  ns: string;
  key: string;
  reason: string;
  issue: string | null;
}

export const ORPHAN_BASELINE: readonly OrphanGroup[] = [
  {
    ns: "dashboard",
    issue: null,
    reason:
      "The two `soft_limit` warnings are unresolved rather than superseded. Nothing computes a story or project limit anywhere in `app/` or `workers/`, so there is no dormant capability behind them and no design doc names a replacement surface; whether the warning was dropped deliberately in the dashboard's retirement is not decidable from the code.",
    keys: [
      "soft_limit.stories",
      "soft_limit.projects",
    ],
  },
  {
    ns: "common",
    issue: null,
    reason:
      "Two held for two different reasons. `app_name` is a title that never renders — `root.tsx:65` hardcodes the English string, so the Spanish catalogue's `Compositor de Telar` cannot reach a browser tab. `course_label` is unresolved: it duplicates the live `nav.course` and has never had a call site, and nothing says whether it was meant for a second context.",
    keys: [
      "app_name",
      "course_label",
    ],
  },

  {
    ns: "collaboration",
    issue: null,
    reason:
      "`presence_tooltip_other_tab` is unresolved: the sidebar does list a user's own other tabs but renders them as a bare name, and whether that was an accepted simplification or an incomplete port is not decidable from the code.",
    keys: [
      "presence_tooltip_other_tab",
    ],
  },
  {
    ns: "popover",
    issue: null,
    reason:
      "The popover's terminal states, deferred deliberately. The redesign plan records the decision: the reachable state is running-only, the published and failed footers are out of scope, and these keys were added for parity with the spec rather than to be rendered. The 1.3.0 changelog carries them as open items.",
    keys: [
      "publishing.committed",
      "publishing.published",
      "publishing.failed",
      "publishing.view_commit",
      "publishing.open_site",
      "publishing.view_logs",
      "publishing.try_again",
    ],
  },
  {
    ns: "glossary",
    issue: null,
    reason:
      "`see_also` labels the related-terms cross-reference the published framework renders on `glossary.html`. The data is preserved end to end — import, D1, publish, sync — and the field registry says why the string has no caller: the compositor does not edit `related_terms`. A documented limitation, so the copy is held with it.",
    keys: [
      "see_also",
    ],
  },
];

/** Every baselined key on its own, carrying its group's reason and pointer. */
export function orphanEntries(): OrphanEntry[] {
  return ORPHAN_BASELINE.flatMap((group) =>
    group.keys.map((key) => ({
      ns: group.ns,
      key,
      reason: group.reason,
      issue: group.issue,
    })),
  );
}
