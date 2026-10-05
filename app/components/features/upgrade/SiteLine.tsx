/**
 * The site the upgrade page acts on, named under its title.
 *
 * The upgrade writes commits to that repository, and a person with several
 * sites reaches the page from more than one place, so the page says which site
 * it is about rather than leaving it to the header's switcher.
 *
 * @version v1.5.0-beta
 */

import { Trans, useTranslation } from "react-i18next";

export function SiteLine({ repo }: { repo: string }) {
  const { t } = useTranslation("upgrade");
  return (
    <p className="font-body text-sm text-charcoal mb-2">
      <Trans
        t={t}
        i18nKey="siteLine"
        values={{ repo }}
        components={{ site: <span className="font-mono" /> }}
      />
    </p>
  );
}
