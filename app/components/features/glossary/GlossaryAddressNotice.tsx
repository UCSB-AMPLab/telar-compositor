/**
 * GlossaryAddressNotice — says, beside a term's ID, that the term shares its
 * published address with another (ids differing only in case or punctuation)
 * and which of the two the site keeps. Renders nothing for a term whose
 * address is its own.
 *
 * @version v1.5.0-beta
 */

import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { opensKeptTerm, type SharedAddress } from "~/lib/glossary-addresses";
import { listOf } from "~/lib/page-language-names";

/** The shared address `termId` is a party to, or undefined. */
export function sharedAddressOf(shares: readonly SharedAddress[], termId: string): SharedAddress | undefined {
  return shares.find((s) => s.kept === termId || s.dropped.includes(termId));
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * The text for the ids the site does not publish, for the kept term. Where the
 * site does not publish several ids, each is in straight double quotes and
 * they are joined as `language` joins a list, so the placeholder in
 * `address_shared_kept_other` carries its own quotes. `variant` picks the case
 * variant, whose ids open this term where the others open nothing.
 */
const KEPT_KEYS = {
  regular: { one: "address_shared_kept_one", other: "address_shared_kept_other" },
  case: { one: "address_shared_kept_one_case", other: "address_shared_kept_other_case" },
} as const;

function keptText(t: Translate, language: string, dropped: string[], variant: keyof typeof KEPT_KEYS): string {
  // One id is quoted by the `_one` text itself; several carry their own quotes.
  if (dropped.length === 1) return t(KEPT_KEYS[variant].one, { others: dropped[0] });
  const quoted = dropped.map((id) => `"${id}"`);
  return t(KEPT_KEYS[variant].other, { others: listOf(quoted, language) });
}

/**
 * The notice's text. Ids that differ from the kept one only in case still open
 * its page, so they are told apart from those that differ in punctuation,
 * whose links show as missing; a term with both gets one sentence for each.
 */
export function addressNoticeText(t: Translate, language: string, shared: SharedAddress, termId: string): string {
  if (shared.kept !== termId) {
    const key = opensKeptTerm(shared.kept, termId) ? "address_shared_dropped_case" : "address_shared_dropped";
    return t(key, { kept: shared.kept });
  }
  const caseOnly = shared.dropped.filter((id) => opensKeptTerm(shared.kept, id));
  const others = shared.dropped.filter((id) => !opensKeptTerm(shared.kept, id));
  return [
    others.length > 0 ? keptText(t, language, others, "regular") : "",
    caseOnly.length > 0 ? keptText(t, language, caseOnly, "case") : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function GlossaryAddressNotice({
  shared,
  termId,
  className = "",
}: {
  shared: SharedAddress | undefined;
  termId: string;
  className?: string;
}) {
  const { t, i18n } = useTranslation("glossary");
  if (!shared) return null;
  const text = addressNoticeText(t, i18n.language, shared, termId);
  return (
    <p
      role="status"
      className={`flex items-start gap-2 font-body text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-md p-2 ${className}`}
    >
      <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" aria-hidden="true" />
      <span>{text}</span>
    </p>
  );
}
