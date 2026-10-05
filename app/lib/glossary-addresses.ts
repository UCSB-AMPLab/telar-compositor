/**
 * The glossary ids that share a published address, and which of them the site
 * keeps. Jekyll writes one file for each address, and ids that slug to the
 * same segment share one (`glossaryTermSlug`): they differ only in case or
 * punctuation. Of such ids the build keeps the first in glossary.csv and does
 * not publish the rest (`first_at_each_address`, scripts/telar/glossary.py).
 * A row with no id or no title, or an id opening `#`, is not a term and holds
 * no address. Addresses are compared as written, so ids whose slugs differ
 * (`Straße` and `strasse`) each publish.
 *
 * @version v1.5.0-beta
 */

import { isHeldTermId } from "~/lib/csv-records";
import { glossaryTermUrl } from "~/lib/glossary-links";
import { pythonStrip } from "~/lib/python-whitespace";

/** One address held by several ids: the one the site keeps, then the ids it drops. */
export interface SharedAddress {
  kept: string;
  dropped: string[];
}

/**
 * Whether a reference to `dropped` opens the term `kept`. The build resolves a
 * reference to its term whatever the casing (`process_glossary_links`), so an
 * id that differs from the kept one only in case still opens the kept term's
 * page; one that differs in punctuation resolves to nothing.
 */
export function opensKeptTerm(kept: string, dropped: string): boolean {
  return kept.toLowerCase() === dropped.toLowerCase();
}

/** The addresses shared by `terms`, given in the glossary's order, in that order. */
export function sharedGlossaryAddresses(
  terms: ReadonlyArray<{ term_id: string | null; title?: string | null }>,
): SharedAddress[] {
  const holders = new Map<string, SharedAddress>();
  const shared: SharedAddress[] = [];
  for (const term of terms) {
    const termId = pythonStrip(term.term_id ?? "");
    if (isHeldTermId(termId) || !pythonStrip(term.title ?? "")) continue;
    const address = glossaryTermUrl(termId, "");
    const held = holders.get(address);
    if (held) {
      held.dropped.push(termId);
      continue;
    }
    const entry: SharedAddress = { kept: termId, dropped: [] };
    holders.set(address, entry);
    shared.push(entry);
  }
  return shared.filter((a) => a.dropped.length > 0);
}
