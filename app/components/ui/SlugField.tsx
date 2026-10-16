/**
 * SlugField — a page's address, shown locked with a Change address button
 * beside it for an author who may change it. The editor takes only the
 * characters a page address holds (lowercase letters, digits and hyphens; an
 * accented letter as its plain form, a space as a hyphen), and hyphens at
 * either end are trimmed when the address is settled. It refuses an empty
 * address, one the site reserves, and one another page already serves,
 * naming that page. Before the change is made on confirm it says that links
 * to the old address stop working, or, when the new slug serves the same
 * address, that the page and its links stay where they are.
 *
 * @version v1.5.5-beta
 */

import { useTranslation } from "react-i18next";
import { LockedIdField } from "~/components/ui/LockedIdField";
import { normaliseSlug } from "~/lib/slug";
import { siteAddressOfPage } from "~/lib/jekyll-slug";
import { isReservedPageAddress } from "~/lib/page-address";

interface SlugFieldProps {
  slug: string;
  /** Every other page: the selected page is not in the list. */
  otherPages: readonly { slug: string; title: string }[];
  canChange?: boolean;
  onSlugChange: (newSlug: string) => void;
}

/** What a page address may hold while it is typed; hyphens at the ends are trimmed when the address is settled. */
function filterPageAddress(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

export function SlugField({ slug, otherPages, canChange = true, onSlugChange }: SlugFieldProps) {
  const { t } = useTranslation("pages");

  function problem(candidate: string): string | null {
    if (candidate === "") return t("slug_invalid");
    const address = siteAddressOfPage(candidate);
    if (isReservedPageAddress(candidate)) return t("slug_reserved", { address });
    const holder = otherPages.find(
      (p) => p.slug === candidate || siteAddressOfPage(p.slug) === address,
    );
    if (holder) return t("slug_taken", { title: holder.title.trim() || t("untitled") });
    return null;
  }

  return (
    <LockedIdField
      label={t("slug_label")}
      inputId="page-slug"
      value={slug}
      canChange={canChange}
      changeLabel={t("slug_change_address")}
      addressNote={t("slug_address", { address: siteAddressOfPage(slug) })}
      filterTyped={filterPageAddress}
      settle={normaliseSlug}
      problem={problem}
      consequences={(candidate) => {
        const served = siteAddressOfPage(candidate);
        return siteAddressOfPage(slug) === served ? (
          <p>{t("slug_same_address", { address: served })}</p>
        ) : (
          <p>{t("slug_warning", { old: siteAddressOfPage(slug), new: served })}</p>
        );
      }}
      onConfirm={onSlugChange}
    />
  );
}
