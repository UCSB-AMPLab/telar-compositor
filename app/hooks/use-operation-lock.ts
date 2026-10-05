/**
 * The publish, upgrade or objects commit another member is running, if any,
 * and their name.
 *
 * While one runs, the server refuses to begin another (`workers/freeze-lease.ts`),
 * so the Publish and Upgrade buttons wait on it and say whose it is. An
 * upgrade is named ahead of a publish, and a publish ahead of an objects
 * commit, when more than one somehow stands: the longest first. The name comes from the layout's member list; a
 * holder missing from it, such as one who has just left, is named generically
 * by the caller.
 *
 * @version v1.5.0-beta
 */

import { useRouteLoaderData } from "react-router";
import { useCollaborationContext } from "~/hooks/use-collaboration";

export interface OperationLock {
  kind: "publish" | "upgrade" | "objects";
  holderName: string | null;
}

interface LayoutMembers {
  sidebarMembers?: Array<{ userId: number; username: string }>;
}

export function useOperationLock(): OperationLock | null {
  const { publishHeldBy, upgradeHeldBy, objectsHeldBy } = useCollaborationContext();
  const layout = useRouteLoaderData("routes/_app") as LayoutMembers | undefined;
  // Normalised: a context that predates a field reads as nobody holding it.
  const held = (
    [["upgrade", upgradeHeldBy], ["publish", publishHeldBy], ["objects", objectsHeldBy]] as const
  ).find(([, holder]) => holder != null);
  if (!held) return null;
  const [kind, holder] = held;
  const holderName = layout?.sidebarMembers?.find((member) => member.userId === holder)?.username ?? null;
  return { kind, holderName };
}
