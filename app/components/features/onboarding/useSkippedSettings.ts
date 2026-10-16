/**
 * useSkippedSettings — what the wizard holds once the author skips fixing the
 * settings the site-configuration check flagged, and the submission that
 * completes onboarding, which every path to the done screen uses. The
 * completion makes the new site the session's, so the submission first
 * forgets the site the tab remembered, and a refused completion restores it.
 * `doneScreenSite` gives what the done screen says about the site: whether it
 * was created here, whether its first build was started, and its address.
 *
 * After a skip, onboarding is completed only when the author leaves the done
 * screen, because completing it earlier makes the loader send the author to
 * Start, away from the list of unfixed settings and the recheck.
 *
 * @version v1.5.5-beta
 */

import { useEffect, useRef, useState } from "react";
import type { useFetcher } from "react-router";
import { forgetSite, rememberSite } from "~/lib/tab-site";
import { deriveSiteUrl } from "~/lib/site-identity";
import type { RepoWithInstallation } from "~/routes/onboarding";
import type { UnfixedSetting } from "./StepDone";

interface SettingFlags {
  sheetsEnabled: boolean;
  pagesNotEnabled: boolean;
  urlMismatch: unknown;
}

/** What the done screen says about the site: whether it was created here, its first build, and its address. */
export function doneScreenSite(repo: RepoWithInstallation | null) {
  const created = repo?.createdThisRun ?? false;
  return {
    created,
    buildStarted: Boolean(created && repo?.bornClean),
    siteUrl: created && repo ? deriveSiteUrl(repo.owner.login, repo.name) : undefined,
  };
}

export function useSkippedSettings(
  completeFetcher: ReturnType<typeof useFetcher>,
  projectId: number | null,
) {
  // The settings the author skipped fixing, listed on the done screen.
  const [unfixed, setUnfixed] = useState<UnfixedSetting[]>([]);

  // A refused completion leaves the session where it was, and the tab
  // remembers the site it showed.
  const forgottenSite = useRef<number | null>(null);
  const completeAnswer = completeFetcher.data as { ok?: boolean } | undefined;
  useEffect(() => {
    if (completeAnswer?.ok === false) rememberSite(forgottenSite.current);
  }, [completeAnswer]);

  const submitCompletion = () => {
    if (projectId == null) return;
    // `complete-onboarding` makes the new site the session's; a tab still
    // remembering the old one would switch the session back in the layout.
    forgottenSite.current = forgetSite();
    completeFetcher.submit(
      { intent: "complete-onboarding", project_id: String(projectId) },
      { method: "post", action: "/onboarding" },
    );
  };

  const skipSettings = ({ sheetsEnabled, pagesNotEnabled, urlMismatch }: SettingFlags) => {
    const left: UnfixedSetting[] = [];
    if (sheetsEnabled) left.push("sheets");
    if (pagesNotEnabled) left.push("pages");
    if (urlMismatch) left.push("url");
    setUnfixed(left);
  };

  const clearUnfixed = () => setUnfixed([]);

  const completion = {
    continuing: completeFetcher.state !== "idle",
    completed: completeAnswer?.ok === true,
    continueFailed: completeAnswer?.ok === false,
  };

  return { unfixed, completion, submitCompletion, skipSettings, clearUnfixed };
}
