/**
 * The site a page shows, for the forms it submits.
 *
 * The session names one active site for the whole browser, and another tab can
 * change it. Every write that acts on "the site" posts `siteId`, the site this
 * tab was showing when the author arrived on the page, so the action can refuse
 * a write meant for a site other than the one the session names
 * (`resolvePageProject`).
 *
 * The id is latched when the layout mounts, not read live from its loader. A
 * revalidation or a navigation reloads the layout for the session's site, and
 * after another tab switched sites that is a different one, while drafts held
 * in this tab's state still belong to the site the author was looking at. The
 * latch moves only with a switch made in this tab: a `switch-project`
 * navigation submission (a `<Form>`, never a fetcher, which the navigation
 * state does not show), once its redirect lands with that site in the layout. Every
 * other way into a different site (an invitation, onboarding, a reload) mounts
 * the layout afresh.
 *
 * @version v1.5.0-beta
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { clearTabSiteCookie, rememberSite, setTabSite, writeTabSiteCookie } from "~/lib/tab-site";
import { useFetcher, useNavigation, type FetcherWithComponents, type SubmitOptions } from "react-router";

/** The error an action answers when the page's site is not the session's. */
export const SITE_CHANGED = "site_changed";

interface PageSite {
  /** The site this page was showing when the author arrived on it. */
  latched: number | null;
  /** The site the layout loader names now. */
  live: number | null;
  /**
   * The site the session names, from the last write an action refused, or
   * null. A fetcher's answer reaches only the component that holds it: a
   * finished fetcher is gone from `useFetchers()` before a render can read
   * its data, so each `useSiteFetcher` reports its own refusal here.
   */
  stopped: string | null;
  /**
   * Reports a refusal once for the answer object, however many hooks hold
   * the fetcher it came from.
   */
  reportStopped: (answer: object, currentSiteName: string) => void;
  clearStopped: () => void;
}

const PageSiteContext = createContext<PageSite>({
  latched: null,
  live: null,
  stopped: null,
  reportStopped: () => {},
  clearStopped: () => {},
});

/** Latches the layout's site id for this tab. Mounted once in the layout. */
export function PageSiteProvider({
  activeProjectId,
  children,
}: {
  activeProjectId: number | null;
  children: ReactNode;
}) {
  const navigation = useNavigation();
  const latch = useRef<number | null | undefined>(undefined);
  const switchingTo = useRef<number | null>(null);
  if (latch.current === undefined) latch.current = activeProjectId;
  if (navigation.formData?.get("intent") === "switch-project") {
    switchingTo.current = Number(navigation.formData.get("projectId"));
  } else if (switchingTo.current !== null && navigation.state === "idle") {
    // Only a switch that landed moves the latch; one interrupted or refused
    // leaves the layout on another site and the latch where it was.
    if (activeProjectId === switchingTo.current) latch.current = activeProjectId;
    switchingTo.current = null;
  }
  const [stopped, setStopped] = useState<string | null>(null);
  const reported = useRef(new WeakSet<object>());
  const reportStopped = useCallback((answer: object, name: string) => {
    if (reported.current.has(answer)) return;
    reported.current.add(answer);
    setStopped(name);
  }, []);
  const clearStopped = useCallback(() => setStopped(null), []);
  const latched = latch.current;
  // The tab's requests name the latched site (`~/lib/tab-site`), except while
  // a switch made in this tab is in flight: its redirect has to read the site
  // being switched to, which only the session names yet.
  const tabSite = switchingTo.current !== null ? null : latched;
  setTabSite(tabSite);
  useEffect(() => {
    setTabSite(tabSite);
    return () => setTabSite(null);
  }, [tabSite]);
  useEffect(() => rememberSite(latched), [latched]);
  // A reload's document request names no site of its own, so the tab hands its
  // site over as it unloads (`writeTabSiteCookie`), and clears the hand-off
  // once it has latched, and again if the browser restores this page instead.
  useEffect(() => {
    clearTabSiteCookie();
    const handOff = () => writeTabSiteCookie(latched);
    window.addEventListener("pagehide", handOff);
    window.addEventListener("beforeunload", handOff);
    window.addEventListener("pageshow", clearTabSiteCookie);
    return () => {
      window.removeEventListener("pagehide", handOff);
      window.removeEventListener("beforeunload", handOff);
      window.removeEventListener("pageshow", clearTabSiteCookie);
    };
  }, [latched]);
  const value = useMemo(
    () => ({ latched, live: activeProjectId, stopped, reportStopped, clearStopped }),
    [latched, activeProjectId, stopped, reportStopped, clearStopped],
  );
  return <PageSiteContext.Provider value={value}>{children}</PageSiteContext.Provider>;
}

/** Both ids, for the notice that compares them. */
export function usePageSite(): PageSite {
  return useContext(PageSiteContext);
}

/** The id of the site this page shows, or null outside a site. */
export function usePageSiteId(): number | null {
  return useContext(PageSiteContext).latched;
}

/** `fields` with the page's site added. */
export function withSite<T extends Record<string, string>>(
  fields: T,
  siteId: number | null,
): T & { siteId?: string } {
  return siteId === null ? fields : { ...fields, siteId: String(siteId) };
}

type SubmitTarget = Parameters<FetcherWithComponents<unknown>["submit"]>[0];

/** `target` with `siteId` added, for each shape `fetcher.submit` accepts. */
export function addSiteToTarget(target: SubmitTarget, siteId: number | null): SubmitTarget {
  if (siteId === null) return target;
  const id = String(siteId);
  if (target instanceof FormData) {
    const copy = new FormData();
    for (const [k, v] of target.entries()) copy.append(k, v);
    copy.set("siteId", id);
    return copy;
  }
  if (target instanceof URLSearchParams) {
    const copy = new URLSearchParams(target);
    copy.set("siteId", id);
    return copy;
  }
  if (target !== null && typeof target === "object" && !(typeof HTMLElement !== "undefined" && target instanceof HTMLElement)) {
    return { ...(target as Record<string, unknown>), siteId: id } as SubmitTarget;
  }
  return target;
}

/**
 * `useFetcher`, whose `submit` carries the page's site. A form element
 * submitted through it carries the site only if it renders `<SiteField />`.
 */
export function useSiteFetcher<T = any>(
  opts?: Parameters<typeof useFetcher>[0],
): ReturnType<typeof useFetcher<T>> {
  const fetcher = useFetcher<T>(opts);
  const { latched: siteId, reportStopped } = useContext(PageSiteContext);

  const answer: unknown = fetcher.data;
  useEffect(() => {
    if (typeof answer !== "object" || answer === null) return;
    const refusal = answer as { error?: unknown; currentSiteName?: unknown };
    if (refusal.error !== SITE_CHANGED) return;
    reportStopped(answer, typeof refusal.currentSiteName === "string" ? refusal.currentSiteName : "");
  }, [answer, reportStopped]);

  const baseSubmit = fetcher.submit;
  const submit = useCallback(
    (target: SubmitTarget, options?: SubmitOptions) =>
      baseSubmit(addSiteToTarget(target, siteId), options),
    [baseSubmit, siteId],
  );
  return useMemo(() => ({ ...fetcher, submit }) as typeof fetcher, [fetcher, submit]);
}

/** The hidden input carrying the page's site, for a `<Form>`. */
export function SiteField() {
  const siteId = usePageSiteId();
  if (siteId === null) return null;
  return <input type="hidden" name="siteId" value={siteId} />;
}
