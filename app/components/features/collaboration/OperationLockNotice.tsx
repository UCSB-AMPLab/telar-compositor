/**
 * The line beside a Publish or Upgrade button that is waiting on another
 * member's publish, upgrade or objects commit, naming them.
 *
 * @version v1.5.0-beta
 */

import { useTranslation } from "react-i18next";
import type { OperationLock } from "~/hooks/use-operation-lock";

const KEYS = {
  publish: {
    publish: "lock_publish_while_publishing",
    upgrade: "lock_publish_while_upgrading",
    objects: "lock_publish_while_adding_objects",
  },
  upgrade: {
    publish: "lock_upgrade_while_publishing",
    upgrade: "lock_upgrade_while_upgrading",
    objects: "lock_upgrade_while_adding_objects",
  },
} as const;

export function OperationLockNotice({
  lock,
  waiting,
  className = "",
}: {
  lock: OperationLock;
  /** The operation whose button is waiting. */
  waiting: "publish" | "upgrade";
  className?: string;
}) {
  const { t } = useTranslation("collaboration");
  // A GitHub username, written as the team pages write one.
  const name = lock.holderName ? `@${lock.holderName}` : t("lock_holder_unknown");
  return (
    <p role="status" className={`font-body text-sm ${className}`}>
      {t(KEYS[waiting][lock.kind], { name })}
    </p>
  );
}
