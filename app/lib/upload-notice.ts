/**
 * What the Upload tab shows in place of the upload flow, if anything.
 *
 * Uploading commits to the repository and dispatches the site's build, so it
 * needs a current framework and a latest release that can be read. On a site
 * behind the latest release, or when the load that drew the page could not
 * read the release, the tab says so rather than offering the flow and
 * refusing after the fact. The action refuses too (readUploadRefusal),
 * because this reading comes from whatever load drew the page.
 *
 * A collaborator whose upgrade only the convenor can complete is told whom to
 * ask and given no link, because /upgrade is a remedy they cannot perform.
 * Everyone else is given the way there.
 *
 * @version v1.5.0-beta
 */

export interface UploadNotice {
  reasonKey: string;
  action: { href: string; labelKey: string } | null;
}

/** The remedy for a site behind the latest release that the reader can run. */
const UPGRADE_ACTION = { href: "/upgrade?from=/objects", labelKey: "upload_upgrade_link" };

export function uploadNotice(state: {
  needsUpgrade?: boolean;
  upgradeAwaitsConvenor?: boolean;
  releaseUnknown?: boolean;
} | undefined): UploadNotice | null {
  if (state?.upgradeAwaitsConvenor) {
    return { reasonKey: "upload_disabled_upgrade_awaits_convenor", action: null };
  }
  if (state?.needsUpgrade) {
    return { reasonKey: "upload_disabled_upgrade_required", action: UPGRADE_ACTION };
  }
  if (state?.releaseUnknown) {
    return { reasonKey: "repo_write_release_unknown", action: null };
  }
  return null;
}

/** The notice as the dialog's props take it: translated, or both null. */
export function describeUploadNotice(
  notice: UploadNotice | null,
  t: (key: string) => string,
): { reason: string | null; action: { href: string; label: string } | null } {
  if (!notice) return { reason: null, action: null };
  return {
    reason: t(notice.reasonKey),
    action: notice.action && { href: notice.action.href, label: t(notice.action.labelKey) },
  };
}

/**
 * The remedy link for the upload action's own refusal, translated, or null.
 * It follows from the refusal code alone, because the notice above is only as
 * current as the load that drew the page: a site that fell behind after that
 * load is refused by the action with no notice showing. Only an upgrade the
 * reader can run has a link; the convenor's upgrade and an unreadable
 * release have none.
 */
export function describeUploadRefusalAction(
  code: string | null,
  t: (key: string) => string,
): { href: string; label: string } | null {
  if (code !== "upgrade_required") return null;
  return { href: UPGRADE_ACTION.href, label: t(UPGRADE_ACTION.labelKey) };
}
