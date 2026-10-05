/**
 * This file is the resource route the objects page posts to when an external
 * object's stored thumbnail fails to load: it reads the object's manifest again
 * and stores the thumbnail the manifest advertises now, so a corrected
 * manifest heals the object without anyone editing D1. It answers the new URL
 * and writes nothing: the page writes it into the live document, which the next
 * snapshot writes to D1.
 *
 * Nested under the `_app` layout, so it inherits `authMiddleware` and the
 * authenticated user on context. The project is the one the request names; the
 * caller's membership in it is checked before anything is read, and the object
 * is looked up only within that project.
 *
 * @version v1.5.0-beta
 */

import type { Route } from "./+types/api.object-thumbnail";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { getUserRole } from "~/lib/membership.server";
import { fetchAndParseManifest } from "~/lib/iiif.server";
import { currentThumbnail } from "~/lib/thumbnail-refresh.server";

export async function action({ request, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const form = await request.formData();
  const projectId = Number(form.get("projectId"));
  const objectDbId = Number(form.get("objectDbId"));
  if (!Number.isSafeInteger(projectId) || !Number.isSafeInteger(objectDbId)) {
    throw new Response("Bad Request", { status: 400 });
  }

  const db = getDb((context.cloudflare.env as Env).DB);
  if ((await getUserRole(db, projectId, user.id)) === null) return Response.json({ changed: false });
  const thumbnail = await currentThumbnail(db, projectId, objectDbId, fetchAndParseManifest);
  return Response.json(thumbnail ? { changed: true, thumbnail } : { changed: false });
}
