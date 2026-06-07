/**
 * Single source of truth for the in-app release announcement ("What's new"
 * login modal). `id` is compared against `users.last_seen_release`; `i18nKey`
 * selects the prose block in the `release-notes` namespace; `contributors` are
 * real, curated GitHub handles (seeded from merged PRs, extended by the
 * maintainer — never invented). Client-safe: no server imports, so both the
 * `_app` loader and the modal component import it.
 *
 * @version v1.3.0-beta
 */
export const CURRENT_RELEASE = {
  id: "1.3.0-beta",
  i18nKey: "v1_3_0_beta",
  contributors: [
    "catabiesman",
    "nathanhandling-ucsb",
    "jordansuleman",
    "Percylikezalmendz",
    "angelinarivoli",
    "hafw1t",
    "briannaguatt-barrera",
    "kftruitt-sudo",
    "jesurosasd-alt",
    "sophiaamaral05",
    "olympia-m",
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
