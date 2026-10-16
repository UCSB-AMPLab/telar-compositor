/**
 * The rules for a site's Site URL and Base URL, shared by the field that edits
 * them, the save that stores them (`config-address.server.ts`) and the
 * collaboration object's check of a write to them in the shared document
 * (`extractConfigAddressMutations`). The Site URL is an http(s) origin with
 * nothing after the domain; the Base URL is empty or a path that starts with a
 * slash. A trailing slash is dropped when an address is settled, the way the
 * build reads `url` and `baseurl`, and whitespace is never accepted.
 *
 * @version v1.5.5-beta
 */

/** An address as typed, less whitespace, which neither address can hold. */
export function filterSiteAddress(raw: string): string {
  return raw.replace(/\s+/g, "");
}

/** An address as it is stored: no trailing slash, so `/` alone is the root, "". */
export function settleSiteAddress(typed: string): string {
  return filterSiteAddress(typed).replace(/\/+$/, "");
}

/** An http(s) origin: a scheme, a host, an optional port, and nothing after. */
const SITE_URL = /^https?:\/\/[^\s/?#@]+$/i;

/** A path of one or more segments, each starting with a slash. */
const BASE_URL = /^(?:\/[^\s/?#]+)+$/;

/** Whether `candidate`, already settled, can be the Site URL. */
export function isSiteUrl(candidate: string): boolean {
  if (!SITE_URL.test(candidate) || candidate.includes("\\")) return false;
  try {
    const url = new URL(candidate);
    return (
      url.hostname !== "" &&
      url.pathname === "/" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

/** Whether `candidate`, already settled, can be the Base URL: empty, or a path. */
export function isBaseUrl(candidate: string): boolean {
  return candidate === "" || BASE_URL.test(candidate);
}
