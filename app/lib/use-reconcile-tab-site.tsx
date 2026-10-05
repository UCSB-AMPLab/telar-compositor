/**
 * A reloaded tab returns to its own site.
 *
 * A document load carries only the session cookie, which names whichever site
 * another tab switched to last. The layout compares the site this tab
 * remembered (`readRememberedSite`) with the one the server rendered; where
 * they differ it switches the session back through the `switch-project`
 * action, reads the layout again, and shows nothing until the layout names
 * the remembered site. A tab that remembers nothing takes the session's site
 * (one whose render came from a closed tab's hand-off loads the page again
 * without it),
 * and one whose switch is refused (a membership it no longer has) or does not
 * take effect shows the site the server rendered.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useRevalidator } from "react-router";
import { clearTabSiteCookie, holdRemembering, readRememberedSite, reloadDocument, sessionStorageWorks, switchSessionTo } from "~/lib/tab-site";

const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

type Phase = { site: number; step: "switching" | "reading" | "leaving" } | null;

/** Whether the tab is returning to its remembered site, so the page waits. */
export function useReconcileTabSite(activeProjectId: number | null, siteFromHandoff = false): boolean {
  const revalidator = useRevalidator();
  const [phase, setPhase] = useState<Phase>(null);
  const readStarted = useRef(false);

  // Before the reconcile below, so that it can hold the memory again on mount.
  useBeforePaint(() => {
    if (phase === null) holdRemembering(false);
  }, [phase]);
  // A layout left while it reconciles holds nothing for the pages that follow.
  useEffect(() => () => holdRemembering(false), []);

  useBeforePaint(() => {
    const remembered = readRememberedSite();
    if (remembered === null && siteFromHandoff && activeProjectId !== null && sessionStorageWorks()) {
      // A tab that remembers nothing did not write the hand-off: it is a fresh
      // tab that arrived while a closed tab's cookie was still alive. Load the
      // page again without it, so the server resolves the session's site.
      holdRemembering(true);
      setPhase({ site: activeProjectId, step: "leaving" });
      clearTabSiteCookie();
      reloadDocument();
      return;
    }
    if (remembered === null || activeProjectId === null || remembered === activeProjectId) return;
    holdRemembering(true);
    setPhase({ site: remembered, step: "switching" });
    void switchSessionTo(remembered).then((taken) => {
      if (!taken) return setPhase(null);
      setPhase({ site: remembered, step: "reading" });
      revalidator.revalidate();
    });
    // Once, on the document load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (phase?.step !== "reading") return;
    if (revalidator.state !== "idle") readStarted.current = true;
    else if (activeProjectId === phase.site || readStarted.current) setPhase(null);
  }, [phase, activeProjectId, revalidator.state]);

  return phase !== null;
}

/** Shows nothing while the tab returns to its own site, then its children. */
export function TabSiteGate({
  activeProjectId,
  siteFromHandoff,
  children,
}: {
  activeProjectId: number | null;
  siteFromHandoff?: boolean;
  children: ReactNode;
}) {
  return useReconcileTabSite(activeProjectId, siteFromHandoff) ? null : children;
}
