/**
 * format-relative — shared, deterministic, localized relative-time formatter.
 *
 * PURE by contract: the output depends only on (isoString, now, locale) and
 * never on the ambient clock, locale, or timezone. The absolute-date branch is
 * pinned to UTC for the same reason. This is what makes it safe to compute the
 * same value on the server and the client.
 *
 * Relative time is nonetheless inherently client-time-and-locale-dependent, so
 * components that render during hydration must NOT call this directly with
 * `Date.now()` / the UI locale in their render body — that would diverge from
 * the server HTML and trip React #418 (which destabilizes the surrounding
 * collaborative editor). Go through `useRelativeTime` (client-only) instead; it
 * supplies `now` and the UI `locale` after mount and holds a stable placeholder
 * until then.
 *
 * Localization mirrors the account page's ConnectedSitesCard: Intl.Relative-
 * TimeFormat for ≤ 30 days, a short Intl.DateTimeFormat date beyond.
 */

export interface FormatRelativeOptions {
  /** Reference "now" in epoch ms. Defaults to Date.now() (client-only callers). */
  now?: number;
  /** BCP-47 locale tag, e.g. "en" / "es". Defaults to "en". */
  locale?: string;
  /** String returned when the timestamp is null/undefined/unparseable. */
  neverLabel?: string;
}

/**
 * Format an ISO timestamp as a localized relative-time string.
 *
 * - ≤ 30 days: localized relative phrase ("3 hours ago" / "hace 3 horas").
 * - > 30 days: localized short date, UTC-pinned ("Mar 1, 2026" / "1 mar 2026").
 * - null / undefined / unparseable: `neverLabel` (default "").
 */
export function formatRelative(
  isoString: string | null | undefined,
  options: FormatRelativeOptions = {},
): string {
  const { now = Date.now(), locale = "en", neverLabel = "" } = options;
  if (!isoString) return neverLabel;

  const then = new Date(isoString).getTime();
  if (Number.isNaN(then)) return neverLabel;

  const deltaMs = now - then;
  const deltaDays = Math.floor(deltaMs / (1000 * 60 * 60 * 24));

  // Beyond 30 days: absolute short date, UTC-pinned so it is identical on the
  // server (UTC) and any client timezone.
  if (deltaDays > 30) {
    return new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(new Date(then));
  }

  // Within 30 days: localized relative phrase. Negative deltas = past.
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const deltaSec = Math.round(-deltaMs / 1000);
  if (Math.abs(deltaSec) < 60) return rtf.format(deltaSec, "second");
  const deltaMin = Math.round(deltaSec / 60);
  if (Math.abs(deltaMin) < 60) return rtf.format(deltaMin, "minute");
  const deltaHr = Math.round(deltaMin / 60);
  if (Math.abs(deltaHr) < 24) return rtf.format(deltaHr, "hour");
  const deltaDayUnit = Math.round(deltaHr / 24);
  if (Math.abs(deltaDayUnit) < 7) return rtf.format(deltaDayUnit, "day");
  const deltaWeek = Math.round(deltaDayUnit / 7);
  return rtf.format(deltaWeek, "week");
}
