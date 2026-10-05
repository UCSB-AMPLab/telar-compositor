/**
 * The line under an object row that reports what the IIIF manifest check found.
 * One line for each of the three states the check broadcasts through the
 * document — pending, valid, error — so a manifest that validates cleanly says
 * so instead of leaving the row as it was before the check ran. Renders nothing
 * for a row that has not been checked.
 *
 * @version v1.5.0-beta
 */

import { useTranslation } from "react-i18next";

export type ManifestValidationState = "pending" | "valid" | "error" | null;

export function ManifestValidationNote({ state }: { state: ManifestValidationState }) {
  const { t } = useTranslation("structural");
  if (state === "pending") {
    return (
      <p className="font-body text-xs text-gray-500 px-4 pb-2 -mt-1">
        <span className="inline-block w-2 h-2 rounded-full bg-gray-300 animate-pulse mr-2" />
        {t("validation_pending")}
      </p>
    );
  }
  if (state === "valid") {
    return (
      <p className="font-body text-xs text-chilca-deep px-4 pb-2 -mt-1" role="status">
        {t("validation_valid")}
      </p>
    );
  }
  if (state === "error") {
    return (
      <p className="font-body text-xs text-red-600 px-4 pb-2 -mt-1">
        {t("validation_error")}
      </p>
    );
  }
  return null;
}
