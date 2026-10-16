/**
 * AddressErrors — the line beside the save button naming which site address
 * the save refused, one sentence per refused field.
 *
 * @version v1.5.5-beta
 */

import { useTranslation } from "react-i18next";

export function AddressErrors({ answer }: { answer: unknown }) {
  const { t } = useTranslation("config");
  const codes = (answer as { invalidAddresses?: string[] } | null | undefined)?.invalidAddresses;
  if (!codes) return null;
  return (
    <p role="alert" className="font-body text-xs text-terracotta">
      {codes
        .map((code) => t(`sections.hosting.${code === "url_empty" ? "url_empty" : `${code}_invalid`}`))
        .join(" ")}
    </p>
  );
}
