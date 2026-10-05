/**
 * How a list of names reads in the interface language.
 *
 * @version v1.5.0-beta
 */

/** The items joined the way `uiLanguage` joins a list ("a, b, and c" / "a, b y c"). */
export function listOf(items: readonly string[], uiLanguage: string): string {
  try {
    return new Intl.ListFormat(uiLanguage, { type: "conjunction" }).format(items);
  } catch {
    return items.join(", ");
  }
}
