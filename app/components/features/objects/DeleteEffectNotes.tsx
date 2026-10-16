/**
 * DeleteEffectNotes — two lines of the object delete dialog: how many steps
 * use the object and are left without it, and what removing the object from
 * the Compositor leaves on the site and in the repository.
 *
 * @version v1.5.5-beta
 */

import { useTranslation } from "react-i18next";

/** How many steps use the object; nothing is shown when none does. */
export function DeleteUsedInNote({ count }: { count: number }) {
  const { t } = useTranslation("objects");
  if (count === 0) return null;
  return (
    <p className="font-body text-sm text-gray-600 mb-3">
      {t("delete_used_in", { count })}
    </p>
  );
}

/** What removing the object from the Compositor leaves behind. */
export function DeleteCompositorEffectNote({ isExternal }: { isExternal: boolean }) {
  const { t } = useTranslation("objects");
  return (
    <p className="font-body text-xs text-gray-500">
      {t(isExternal ? "delete_remove_compositor_effect_external" : "delete_remove_compositor_effect")}
    </p>
  );
}
