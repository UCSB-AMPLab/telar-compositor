/**
 * This file is the read-only resource route the bug-report panel asks, when it
 * opens, for the name GitHub currently gives the displayed project's
 * repository.
 *
 * A repository renamed or moved on GitHub keeps its old name in D1 until the
 * Site Status poll heals it, so a report filed in that window can carry a name
 * GitHub does not give the repository. The panel compares the answer with the
 * name it holds and attaches the current one only when they differ.
 *
 * A resource route (loader only, no default export) nested under the `_app`
 * layout, so it inherits `authMiddleware` and the authenticated user on
 * context. The project is the one the request names in `?projectId=`, not the
 * session's active project: the session cookie is shared across tabs, so
 * another tab can have made a different project active while this panel shows
 * its own. The caller's membership in the named project is checked before
 * anything is read, and a caller who holds none gets a null name, as does a
 * project with no repository. The token is the one `resolveProjectToken` hands
 * the caller's role, so a collaborator on a private repository reads it
 * through the installation.
 *
 * The answer is `{ projectId, fullName }`, echoing the project asked about so
 * the panel can drop an answer for any other; `fullName` is null whenever
 * GitHub did not give one: an unavailable repository, a GitHub error, or a
 * failed token. It never writes; healing D1 stays the poll's.
 *
 * @version v1.5.0-beta
 */

import type { Route } from "./+types/api.repo-identity";
import { eq } from "drizzle-orm";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { decrypt } from "~/lib/crypto.server";
import { getUserRole } from "~/lib/membership.server";
import { resolveProjectToken } from "~/lib/github-app.server";
import { checkRepoAvailability } from "~/lib/github.server";
import { projects } from "~/db/schema";

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const raw = new URL(request.url).searchParams.get("projectId");
  if (raw === null || !/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Response("Bad Request: projectId", { status: 400 });
  }
  const projectId = Number(raw);
  const none = () => Response.json({ projectId, fullName: null });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);

  const role = await getUserRole(db, projectId, user.id);
  if (role === null) return none();

  const [project] = await db
    .select({
      installation_id: projects.installation_id,
      github_repo_full_name: projects.github_repo_full_name,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const [owner, repo] = (project?.github_repo_full_name ?? "").split("/");
  if (!project || !owner || !repo) return none();

  try {
    const userToken = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
    const token = await resolveProjectToken(
      env.GITHUB_APP_ID,
      env.GITHUB_PRIVATE_KEY,
      project.installation_id,
      userToken,
      role,
    );
    const result = await checkRepoAvailability(token, owner, repo);
    return Response.json({ projectId, fullName: result.canonicalFullName });
  } catch {
    return none();
  }
}
