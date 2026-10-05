/**
 * Asks the project's collaboration server to fill its external IIIF objects
 * from their manifests (`/enrich-objects`). The server is the one writer of
 * that metadata: it chooses the objects from its own document and writes into
 * it, so nothing the page sends names an object or a URL.
 *
 * @version v1.5.0-beta
 */

import { postToCollaborationDO } from "~/lib/internal-marker.server";

/**
 * Whether the server answered for the page's project; no project, or a server
 * that could not be reached, answers false, and a later visit asks again.
 */
export async function requestObjectEnrichment(
  env: Pick<Env, "COLLABORATION" | "SESSION_SECRET">,
  page: { project: { id: number } } | null,
): Promise<boolean> {
  if (!page) return false;
  try {
    const response = await postToCollaborationDO(env, page.project.id, "enrich-objects", "/enrich-objects");
    await response.text();
    return response.ok;
  } catch {
    return false;
  }
}
