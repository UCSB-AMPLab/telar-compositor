/**
 * ReloadOnUpgradeComplete — collaborators reload when the upgrade finishes
 * successfully. Owner stays on the "upgrade complete" screen.
 *
 * Reload only fires on true -> false transition (prevRef.current=true while
 * isUpgrading just became false), with no upgradeError and provider already
 * connected. Owner identified via isOwner prop.
 *
 * Extracted from _app.tsx so edge-transition behaviour can be covered by
 * upgrade-reload.test.tsx without rendering the full layout route.
 */

import { useEffect, useRef } from "react";
import { useCollaborationContext } from "~/hooks/use-collaboration";

export function ReloadOnUpgradeComplete({ isOwner }: { isOwner: boolean }) {
  const { isUpgrading, upgradeError, provider } = useCollaborationContext();
  const prevRef = useRef(false);
  useEffect(() => {
    // Only collaborators reload. Owner stays on the
    // "upgrade complete" screen to see success + manual steps.
    if (!isOwner && provider && prevRef.current && !isUpgrading && !upgradeError) {
      window.location.reload();
    }
    prevRef.current = isUpgrading;
  }, [isUpgrading, upgradeError, isOwner, provider]);
  return null;
}
