/**
 * UpgradeFreezeModal — thin wrapper around FreezeModal with upgrade-flow
 * i18n keys.
 *
 * Mirrors PublishFreezeModal. Driven by isUpgrading / upgradeError awareness
 * fields exposed by use-collaboration.tsx. The upgrade route sets these via
 * awareness.setLocalStateField; this modal renders on all connected clients.
 */

import { useTranslation } from "react-i18next";
import { FreezeModal } from "~/components/ui/FreezeModal";

interface UpgradeFreezeModalProps {
  isUpgrading: boolean;
  upgradeError: boolean;
  onDismiss: () => void;
}

export function UpgradeFreezeModal({
  isUpgrading,
  upgradeError,
  onDismiss,
}: UpgradeFreezeModalProps) {
  const { t } = useTranslation("collaboration");
  return (
    <FreezeModal
      isActive={isUpgrading}
      hasError={upgradeError}
      onDismiss={onDismiss}
      labelId="upgrade-freeze-heading"
      heading={t("upgrade_freeze_heading")}
      bodyCollaborator={t("upgrade_freeze_body_collaborator")}
      errorHeading={t("upgrade_freeze_error_heading")}
      errorBody={t("upgrade_freeze_error_body")}
      dismissLabel={t("upgrade_freeze_dismiss")}
    />
  );
}
