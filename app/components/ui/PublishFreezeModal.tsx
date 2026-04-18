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
  isOwner: boolean;
  onDismiss: () => void;
}

export function PublishFreezeModal({
  isPublishing,
  publishError,
  isOwner,
  onDismiss,
}: PublishFreezeModalProps) {
  const { t } = useTranslation("collaboration");
  return (
    <FreezeModal
      isActive={isPublishing}
      hasError={publishError}
      isOwner={isOwner}
      onDismiss={onDismiss}
      labelId="publish-freeze-heading"
      heading={t("publish_freeze_heading")}
      bodyOwner={t("publish_freeze_body_owner")}
      bodyCollaborator={t("publish_freeze_body_collaborator")}
      errorHeading={t("publish_freeze_error_heading")}
      errorBody={t("publish_freeze_error_body")}
      dismissLabel={t("publish_freeze_dismiss")}
    />
  );
}
