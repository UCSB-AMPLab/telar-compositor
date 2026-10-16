/**
 * A glossary term's ID, in the term editor. The convenor may change it: the
 * editor takes only the characters a term ID is made of (`[a-z0-9-]`, an
 * accented letter as its plain form, a space typed as a hyphen); when the ID
 * is settled, hyphens at either end are stripped and a run of hyphens becomes
 * one; and an empty ID or one another term uses is refused. An accepted ID
 * first shows what changing it does to the term's address and to the links to
 * it, with the change made only on confirm. The route writes the ID to the
 * document and rewrites the links.
 *
 * @version v1.5.5-beta
 */

import { useTranslation } from "react-i18next";

import { LockedIdField } from "~/components/ui/LockedIdField";
import { glossaryTermSlug } from "~/lib/glossary-links";
import { filterTermId } from "~/lib/glossary-slug";
import { normaliseSlug } from "~/lib/slug";

interface TermIdFieldProps {
  termId: string;
  /** The IDs of every other term. */
  otherTermIds: readonly string[];
  /** How many links in the site point to this term's current ID; counted only while the editor is open. */
  countLinks: () => number;
  canChange: boolean;
  onChange: (newId: string) => void;
}

export function TermIdField({ termId, otherTermIds, countLinks, canChange, onChange }: TermIdFieldProps) {
  const { t } = useTranslation("glossary");

  function termIdMessage(candidate: string): string | null {
    if (candidate === "") return t("term_id_empty");
    if (candidate !== termId && otherTermIds.includes(candidate)) return t("term_id_taken", { id: candidate });
    return null;
  }

  return (
    <LockedIdField
      label={t("term_id_section_label")}
      inputId="glossary-term-id"
      value={termId}
      canChange={canChange}
      addressNote={t("term_id_address", { slug: glossaryTermSlug(termId) })}
      filterTyped={filterTermId}
      settle={normaliseSlug}
      problem={termIdMessage}
      consequences={(candidate) => {
        const linkCount = countLinks();
        return (
          <>
            <p>{t("term_id_warning", { old: glossaryTermSlug(termId), new: glossaryTermSlug(candidate) })}</p>
            {linkCount > 0 && <p>{t("term_id_links", { count: linkCount })}</p>}
          </>
        );
      }}
      onConfirm={onChange}
    />
  );
}
