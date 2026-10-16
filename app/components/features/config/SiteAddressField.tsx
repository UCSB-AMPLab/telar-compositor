/**
 * The site's Site URL or Base URL, in the hosting section of Site settings.
 * Both are locked until the convenor asks to change one, because either moves
 * every address on the site. The Site URL is an http(s) origin with nothing
 * after the domain; the Base URL is empty or a path that starts with a slash.
 * A trailing slash is dropped when the address is settled, the way the build
 * reads `url` and `baseurl`, and whitespace is never accepted.
 *
 * The page's form carries the value: a hidden input holds it for Save, and
 * `onChange` writes it to the shared document once the author confirms.
 *
 * @version v1.5.5-beta
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { LockedIdField } from "~/components/ui/LockedIdField";
import { filterSiteAddress, isBaseUrl, isSiteUrl, settleSiteAddress } from "~/lib/site-address";

export type SiteAddressKind = "url" | "baseurl";

interface SiteAddressFieldProps {
  kind: SiteAddressKind;
  value: string;
  canChange: boolean;
  onChange: (name: SiteAddressKind, value: string) => void;
}

export function SiteAddressField({ kind, value, canChange, onChange }: SiteAddressFieldProps) {
  const { t } = useTranslation("config");
  const [current, setCurrent] = useState(value);
  useEffect(() => setCurrent(value), [value]);

  function problem(candidate: string): string | null {
    if (kind === "url") {
      if (candidate === "") return t("sections.hosting.url_empty");
      return isSiteUrl(candidate) ? null : t("sections.hosting.url_invalid");
    }
    return isBaseUrl(candidate) ? null : t("sections.hosting.baseurl_invalid");
  }

  return (
    <div className="mb-4">
      <input type="hidden" name={kind} value={current} />
      <LockedIdField
        label={t(kind === "url" ? "sections.hosting.field_url" : "sections.hosting.field_baseurl")}
        inputId={`site-${kind}`}
        value={current}
        canChange={canChange}
        addressNote={t(kind === "url" ? "sections.hosting.field_url_help" : "sections.hosting.field_baseurl_help")}
        changeLabel={t("sections.hosting.change_address")}
        filterTyped={filterSiteAddress}
        settle={settleSiteAddress}
        problem={problem}
        consequences={() => <p>{t("sections.hosting.address_change_warning")}</p>}
        onConfirm={(candidate) => {
          setCurrent(candidate);
          onChange(kind, candidate);
        }}
      />
    </div>
  );
}
