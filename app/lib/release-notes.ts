/**
 * Single source of truth for the in-app release announcement ("What's new"
 * login modal). `id` is compared against `users.last_seen_release`; `i18nKey`
 * selects the prose block in the `release-notes` namespace; `contributors` are
 * real, curated GitHub handles (seeded from merged PRs, extended by the
 * maintainer — never invented). Client-safe: no server imports, so both the
 * `_app` loader and the modal component import it.
 *
 * @version v1.3.2-beta
 */
export const CURRENT_RELEASE = {
  id: "1.3.2-beta",
  i18nKey: "v1_3_2_beta",
  contributors: [
    "meganleverett",
    "sophiaamaral05",
    "olympia-m",
    "kftruitt-sudo",
  ] as string[],
};

/**
 * Whether to show the release modal: only when this user hasn't seen the
 * current release AND no added-to-project welcome modal is pending (welcome
 * wins this load; the release note shows next login). Pure — unit tested.
 */
export function shouldShowReleaseNote(
  lastSeenRelease: string | null | undefined,
  needsWelcome: boolean,
): boolean {
  if (needsWelcome) return false;
  return lastSeenRelease !== CURRENT_RELEASE.id;
}

/**
 * Whether to show the workflows-permission login modal. It defers to the two
 * higher-priority login modals (the added-to-project welcome and the
 * once-per-release "what's new" note) so only one login modal ever shows at a
 * time. The ordering across logins is welcome → release note → workflows; the
 * workflows modal reappears each session until the permission is approved, so
 * deferring it by a login costs nothing.
 */
export function shouldShowWorkflowsModal(
  needsWorkflowsApproval: boolean,
  needsWelcome: boolean,
  needsReleaseNote: boolean,
): boolean {
  return needsWorkflowsApproval && !needsWelcome && !needsReleaseNote;
}
