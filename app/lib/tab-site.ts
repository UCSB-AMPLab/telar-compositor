/**
 * The site a browser tab is working on, carried on the tab's own requests.
 *
 * The session cookie names one active site for the whole browser, so a tab that
 * showed site A was reloaded for site B on its next revalidation once another
 * tab had switched to B. Every request a tab makes to this origin carries the
 * site its layout latched (`X-Telar-Site`), and the server resolves the tab's
 * site from that before it reads the cookie (`resolveActiveProjectFromRequest`).
 * Membership is checked on whatever id arrives, as for the cookie's.
 *
 * React Router builds each single-fetch request itself and gives client
 * middleware no way to add a header, so the header is added by wrapping
 * `window.fetch` once, in the client entry.
 *
 * The tab also remembers its site in `sessionStorage`, which belongs to the tab
 * and survives a reload. A document load names no header, so a tab reloaded
 * after another tab switched the session would open the other tab's site; the
 * layout compares the remembered site with the one the server rendered and
 * switches the session back before it shows the page (`useReconcileTabSite`).
 * Without storage the tab behaves as it did before: the session's site.
 *
 * The reconcile runs after the server has answered, and the server's own
 * answer (a role redirect, the other site's page) cannot be undone by it. So a
 * tab also hands its site to the document request that follows it: on
 * `pagehide` it writes a cookie that lives seconds, the server reads it for a
 * document request before the session's site, and the tab clears it once it
 * has latched. The sessionStorage check stays for a tab whose cookie was lost.
 *
 * @version v1.5.0-beta
 */

export const TAB_SITE_HEADER = "X-Telar-Site";

export const TAB_SITE_COOKIE = "telar_tab_site";

const SITE_ID = /^[1-9][0-9]{0,14}$/;

/** Whether the request is a browser navigation to a page, not a `fetch`. */
function isDocumentRequest(headers: Headers): boolean {
  const dest = headers.get("Sec-Fetch-Dest");
  if (dest !== null) return dest === "document";
  return (headers.get("Accept") ?? "").includes("text/html");
}

type RequestLike = { headers: Headers; url: string };

/**
 * The site the request's tab names: its header, or, for a document request,
 * the short-lived cookie the tab wrote as it unloaded. A document load carries
 * no header, and the session cookie names whichever site another tab switched
 * to last; the tab's own cookie is how a reload keeps its site.
 *
 * The cookie's value is `<site>:<encoded path>` and is honoured only for a
 * request to that same path. A browser cannot say at `pagehide` whether the
 * page is being reloaded or closed, so a closed tab's cookie lives its 15
 * seconds; scoped to the page it was written on, it steers only a load of that
 * page, which is what a reload is.
 */
export function readTabSite(request: RequestLike): number | undefined {
  const raw = request.headers.get(TAB_SITE_HEADER);
  if (raw !== null) return SITE_ID.test(raw) ? Number(raw) : undefined;
  return readHandoffSite(request);
}

/** The site a document request's hand-off cookie names for this path, or undefined. */
export function readHandoffSite(request: RequestLike): number | undefined {
  const headers = request.headers;
  if (headers.get(TAB_SITE_HEADER) !== null || !isDocumentRequest(headers)) return undefined;
  const match = (headers.get("Cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${TAB_SITE_COOKIE}=([1-9][0-9]{0,14}):([^;]*)`));
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[2]) === new URL(request.url).pathname ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

let tabSite: number | null = null;

/** Sets the site this tab's requests name, or none (null). */
export function setTabSite(siteId: number | null): void {
  tabSite = siteId;
}

let installed = false;

function isSameOrigin(input: RequestInfo | URL): boolean {
  const target =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(target, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * Wraps `window.fetch` so a same-origin request carries the tab's site. A
 * header the caller set is kept. Safe to call more than once.
 */
export function installTabSiteHeader(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (tabSite === null || !isSameOrigin(input)) return original(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has(TAB_SITE_HEADER)) headers.set(TAB_SITE_HEADER, String(tabSite));
    return original(input, { ...init, headers });
  };
}

/** The site this tab's requests name now, or null. */
export function currentTabSite(): number | null {
  return tabSite;
}

const MEMORY_KEY = "telar.tab-site";

/** The site this tab last showed, from `sessionStorage`, or null. */
export function readRememberedSite(): number | null {
  try {
    const raw = window.sessionStorage.getItem(MEMORY_KEY);
    return raw !== null && /^[1-9][0-9]{0,14}$/.test(raw) ? Number(raw) : null;
  } catch {
    return null;
  }
}

let rememberingHeld = false;

/**
 * Holds off `rememberSite` while the layout decides whether this tab is to
 * return to another site. The first commit's effects run before it can say,
 * and a site the server rendered in error must not overwrite the memory the
 * decision reads.
 */
export function holdRemembering(held: boolean): void {
  rememberingHeld = held;
}

/** Remembers the site this tab shows. A tab without storage remembers nothing. */
export function rememberSite(siteId: number | null): void {
  if (siteId === null || rememberingHeld) return;
  try {
    window.sessionStorage.setItem(MEMORY_KEY, String(siteId));
  } catch {
    // Storage is unavailable or full: the tab follows the session, as before.
  }
}

/**
 * Forgets the site this tab showed, for a page outside the layout that points
 * the session at another site (onboarding, an invitation), and answers the
 * site it forgot, for the page to remember again if the switch is refused. The
 * layout that follows would otherwise read the old site and switch the session
 * back; a tab that remembers nothing takes the session's site and remembers
 * that. No reconcile runs outside the layout, so a hold left by one the author
 * walked away from is released here.
 */
export function forgetSite(): number | null {
  rememberingHeld = false;
  const forgotten = readRememberedSite();
  try {
    window.sessionStorage.removeItem(MEMORY_KEY);
  } catch {
    // As in `rememberSite`.
  }
  return forgotten;
}

/**
 * Points the session at `siteId` through the dashboard's `switch-project`
 * action, which checks membership. True when the action accepted it.
 */
export async function switchSessionTo(siteId: number): Promise<boolean> {
  try {
    const response = await window.fetch("/dashboard", {
      method: "POST",
      body: new URLSearchParams({ intent: "switch-project", projectId: String(siteId) }),
      redirect: "manual",
      credentials: "same-origin",
    });
    return response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400);
  } catch {
    return false;
  }
}

const HANDOFF_SECONDS = 15;

/**
 * The cookie is set for the page's own path: a browser sends a cookie only to
 * a request whose path matches its `Path` (the same path, or one below it), and
 * the server compares the path in the value as well, since it sees no attributes.
 */
function tabSiteCookie(value: string, maxAge: number): string {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  return `${TAB_SITE_COOKIE}=${value}; Max-Age=${maxAge}; Path=${window.location.pathname}; SameSite=Lax${secure}`;
}

/** Hands the tab's site to the document request that follows this page. */
export function writeTabSiteCookie(siteId: number | null): void {
  if (siteId === null) return;
  try {
    document.cookie = tabSiteCookie(`${siteId}:${encodeURIComponent(window.location.pathname)}`, HANDOFF_SECONDS);
  } catch {
    // Cookies are unavailable: the sessionStorage gate is the fallback.
  }
}

/** Removes the hand-off once the tab has latched its site. */
export function clearTabSiteCookie(): void {
  try {
    document.cookie = tabSiteCookie("", 0);
  } catch {
    // As above.
  }
}

/** Whether `sessionStorage` can be read and written, so an empty memory means a fresh tab. */
export function sessionStorageWorks(): boolean {
  try {
    const probe = "telar.tab-site.probe";
    window.sessionStorage.setItem(probe, "1");
    window.sessionStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/** Loads the current page again, as the browser's reload does. */
export function reloadDocument(): void {
  window.location.reload();
}
