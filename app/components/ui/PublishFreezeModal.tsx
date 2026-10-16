/**
 * PublishFreezeModal — thin wrapper around FreezeModal with publish-flow
 * i18n keys.
 *
 * See FreezeModal.tsx for the underlying component. Upgrade flow uses
 * UpgradeFreezeModal with the same pattern. The body names the member who
 * holds the publish, as the lock notice beside the Publish button does, and
 * says the site: a publish carries everyone's edits, whatever role started it.
 *
 * @version v1.5.5-beta
 */

import { useTranslation } from "react-i18next";
import { FreezeModal } from "~/components/ui/FreezeModal";
import { useOperationLock } from "~/hooks/use-operation-lock";

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
  const lock = useOperationLock();
  // A GitHub username, written as the team pages write one.
  const name = lock?.kind === "publish" && lock.holderName ? `@${lock.holderName}` : t("lock_holder_unknown");
  return (
    <FreezeModal
      isActive={isPublishing}
      hasError={publishError}
      onDismiss={onDismiss}
      labelId="publish-freeze-heading"
      heading={t("publish_freeze_heading")}
      bodyCollaborator={t("publish_freeze_body_collaborator", { name })}
      errorHeading={t("publish_freeze_error_heading")}
      errorBody={t("publish_freeze_error_body")}
      dismissLabel={t("publish_freeze_dismiss")}
    />
  );
}
