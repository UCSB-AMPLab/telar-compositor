/**
 * ReloadOnUpgradeComplete — reload the page when another user's upgrade has
 * succeeded, so this editor picks up the framework it rewrote.
 *
 * Driven only by `upgradeSucceeded`, which the collaboration context sets when
 * the server reports that an upgrade this page saw running ended well and was
 * held by someone else (`~/lib/freeze-view`). A lease that expires, an upgrade
 * that fails, and a socket that drops all lift the freeze without it, so none
 * of them reads as a finished upgrade. Whoever ran the upgrade stays on its
 * completion screen.
 *
 * @version v1.5.0-beta
 */

import { useEffect } from "react";
import { useCollaborationContext } from "~/hooks/use-collaboration";

export function ReloadOnUpgradeComplete() {
  const { upgradeSucceeded } = useCollaborationContext();
  useEffect(() => {
    if (upgradeSucceeded) window.location.reload();
  }, [upgradeSucceeded]);
  return null;
}
