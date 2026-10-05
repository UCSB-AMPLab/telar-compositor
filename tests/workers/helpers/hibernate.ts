/**
 * Evicting a `ProjectCollaborationDO`, for the workers project.
 *
 * workerd refuses to evict a Durable Object that still holds active
 * references, and a pending timer is one of them: `evictDurableObject` then
 * times out after 30 seconds with "it still has active references". The class
 * holds no timer of its own, so the eviction is the platform's alone and
 * nothing is cleared by hand here. A timer that came back would show up as
 * every caller of this helper timing out.
 *
 * Shared by every workers-project file that needs an eviction, so the
 * eviction is spelled one way.
 *
 * @version v1.5.0-beta
 */

import { evictDurableObject } from "cloudflare:test";

/** Evict `stub`, hibernating whatever sockets it holds. */
export async function hibernate(stub: DurableObjectStub): Promise<void> {
  await evictDurableObject(stub);
}
