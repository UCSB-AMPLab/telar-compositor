/**
 * PublishFreezeModal — thin wrapper around FreezeModal with publish-flow
 * i18n keys.
 *
 * See FreezeModal.tsx for the underlying component. Upgrade flow uses
 * UpgradeFreezeModal with the same pattern.
 */

import { useTranslation } from "react-i18next";
import { FreezeModal } from "~/components/ui/FreezeModal";

interface PublishFreezeModalProps {
  isPublishing: boolean;
  publishError: boolean;
  onDismiss: () => void;
}

export function PublishFreezeModal({
  isPublishing,
  publishError,
  onDismiss,
}: PublishFreezeModalProps) {
  const { t } = useTranslation("collaboration");
  return (
    <FreezeModal
      isActive={isPublishing}
      hasError={publishError}
      onDismiss={onDismiss}
      labelId="publish-freeze-heading"
      heading={t("publish_freeze_heading")}
      bodyCollaborator={t("publish_freeze_body_collaborator")}
      errorHeading={t("publish_freeze_error_heading")}
      errorBody={t("publish_freeze_error_body")}
      dismissLabel={t("publish_freeze_dismiss")}
    />
  );
}
