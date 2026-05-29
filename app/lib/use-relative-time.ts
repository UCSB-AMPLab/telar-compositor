import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatRelative } from "~/lib/format-relative";

/**
 * Client-only localized relative-time string.
 *
 * Relative time depends on the browser's clock, locale, and timezone — values
 * the server cannot know at SSR. Rendering it during hydration therefore
 * mismatches the server HTML and trips React #418, which (on the homepage
 * editor) destabilizes the Yjs/CodeMirror tree and crashes it on the next edit.
 *
 * This hook renders a stable, locale/timezone-independent placeholder during
 * SSR and the first client paint (the `neverLabel` for an absent timestamp,
 * otherwise an empty string), then the localized relative phrase after mount,
 * computed with the real browser locale/timezone/clock. Server and first client
 * render stay byte-identical, so hydration is clean.
 */
export function useRelativeTime(
  isoString: string | null | undefined,
  neverLabel = "",
): string {
  const { i18n } = useTranslation();
  // `now` doubles as the mount flag: null until the post-hydration effect runs.
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
  }, []);

  if (!isoString) return neverLabel;
  if (now === null) return "";
  return formatRelative(isoString, { now, locale: i18n.language, neverLabel });
}
