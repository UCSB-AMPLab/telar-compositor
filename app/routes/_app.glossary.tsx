/**
 * Glossary — term management placeholder.
 *
 * Full implementation in a future phase.
 */

import { useTranslation } from "react-i18next";
import { BookText } from "lucide-react";

export const handle = { i18n: ["common"] };

export default function GlossaryPage() {
  const { t } = useTranslation("common");

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="font-heading font-bold text-2xl text-charcoal mb-6">
        {t("nav.glossary")}
      </h1>
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="w-14 h-14 rounded-full bg-periwinkle flex items-center justify-center mb-4">
          <BookText className="w-6 h-6 text-charcoal" />
        </div>
        <p className="font-body text-sm text-gray-500">{t("coming_soon")}</p>
      </div>
    </div>
  );
}
