/**
 * This file renders the Homepage tab — the editable site preview for
 * the active project. The user lands here when they want to see what
 * their site looks like to a visitor and to edit the heading copy
 * and showcase items inline.
 *
 * Relocated from `_app.dashboard.tsx`: all four
 * `DashboardPreviewSection` blocks (Site Description, Welcome
 * Message, Stories showcase, Objects showcase). Adds a "View live
 * site" link at the top using the project's `github_pages_url`.
 *
 * Loader fetches `project_config`, `project_landing`, `stories`,
 * `objects`, and the resolved site base URL. Action handles
 * `autosave-landing`, `autosave-config`, and `reorder` intents.
 *
 * NOTE: The preview sections remain on `_app.dashboard.tsx` until a
 * future dashboard cleanup. This route duplicates them for now.
 *
 * This module serves the landing editor at BOTH `/homepage`
 * (legacy bookmarks) and `/pages/index` (the new canonical path). The
 * loader bounces `/homepage` → `/pages/index` while rendering normally at
 * `/pages/index`. The module is registered to both paths in routes.ts so
 * its `autosave-landing` action travels with the editor — a known pitfall
 * is that /dashboard's action does NOT handle autosave-landing.
 *
 * @version v1.3.0-beta
 */

import { and, eq, inArray } from "drizzle-orm";
import { redirect } from "react-router";
import type { Route } from "./+types/_app.homepage";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { stories, project_config, project_landing } from "~/db/schema";
import { requireProjectMember } from "~/lib/membership.server";
import { resolveActiveProjectFromRequest } from "~/lib/active-project.server";
import { loadHomepageEditorData } from "~/lib/homepage-editor-data.server";
import { HomepageEditor } from "~/components/features/pages/HomepageEditor";

export const handle = { i18n: ["common", "homepage", "dashboard", "editor"] };

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  // This module serves both /homepage and /pages/index. Legacy
  // /homepage bookmarks bounce forward to the canonical /pages/index; the
  // editor itself renders when reached at /pages/index. Short-circuit before
  // any DB work so the redirect is cheap.
  if (new URL(request.url).pathname === "/homepage") {
    throw redirect("/pages/index");
  }

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);

  const resolved = await resolveActiveProjectFromRequest(request, env, user.id);
  if (!resolved) {
    throw redirect("/onboarding");
  }
  const { project: activeProject } = resolved;

  return await loadHomepageEditorData(db, activeProject);
}

export async function action({ request, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  switch (intent) {
    case "autosave-landing": {
      const field = formData.get("field") as string;
      const value = formData.get("value") as string;
      const projectId = Number(formData.get("entityId") ?? formData.get("projectId"));
      const allowedFields = ["stories_heading", "stories_intro", "objects_heading", "objects_intro", "welcome_body"];
      if (!allowedFields.includes(field)) throw new Response("Bad request", { status: 400 });

      if (!Number.isFinite(projectId) || projectId <= 0) {
        throw new Response("Bad request", { status: 400 });
      }
      await requireProjectMember(db, projectId, user.id);

      const existing = await db
        .select({ id: project_landing.id })
        .from(project_landing)
        .where(eq(project_landing.project_id, projectId))
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(project_landing)
          .set({ [field]: value, updated_at: new Date().toISOString() })
          .where(eq(project_landing.project_id, projectId));
      } else {
        await db
          .insert(project_landing)
          .values({ project_id: projectId, [field]: value });
      }

      return { ok: true, intent: "autosave-landing" };
    }

    case "autosave-config": {
      const field = formData.get("field") as string;
      const value = formData.get("value") as string;
      const projectId = Number(formData.get("entityId") ?? formData.get("projectId"));
      const allowedFields = ["title", "description"];
      if (!allowedFields.includes(field)) throw new Response("Bad request", { status: 400 });

      if (!Number.isFinite(projectId) || projectId <= 0) {
        throw new Response("Bad request", { status: 400 });
      }
      await requireProjectMember(db, projectId, user.id);

      await db
        .update(project_config)
        .set({ [field]: value, updated_at: new Date().toISOString() })
        .where(eq(project_config.project_id, projectId));

      return { ok: true, intent: "autosave-config" };
    }

    case "reorder": {
      const orderJson = formData.get("order") as string;
      const projectId = Number(formData.get("projectId"));
      if (!Number.isFinite(projectId) || projectId <= 0) {
        throw new Response("Bad request", { status: 400 });
      }
      // Authorization gate: the reorder action mutates story
      // ordering for `projectId`, which is attacker-supplied via the form
      // body. Without this check any authenticated user could reorder an
      // arbitrary project's stories. Mirrors the autosave-landing /
      // autosave-config intents above.
      await requireProjectMember(db, projectId, user.id);

      // Guard the JSON.parse: a malformed `order`
      // payload must return a clean 400, not throw a raw SyntaxError. Also
      // assert the parsed value is an integer array before use so a non-array
      // (e.g. "true") can't slip through to .filter/.map below.
      let order: number[];
      try {
        order = JSON.parse(orderJson);
        if (!Array.isArray(order) || !order.every((n) => Number.isInteger(n))) {
          throw new Error("bad order");
        }
      } catch {
        throw new Response("Bad request", { status: 400 });
      }

      const projectStories = await db
        .select({ id: stories.id })
        .from(stories)
        .where(and(eq(stories.project_id, projectId), inArray(stories.id, order)));

      const ownedIds = new Set(projectStories.map((s) => s.id));
      const now = new Date().toISOString();

      await Promise.all(
        order
          .filter((id) => ownedIds.has(id))
          .map((id, idx) =>
            db.update(stories)
              .set({ order: idx, updated_at: now })
              .where(eq(stories.id, id))
          )
      );

      return { ok: true, intent: "reorder" };
    }

    default:
      throw new Response("Bad request", { status: 400 });
  }
}

// ---------------------------------------------------------------------------
// Route component — thin wrapper
// ---------------------------------------------------------------------------
//
// The landing-editor render body lives in the shared `HomepageEditor`
// component (app/components/features/pages/HomepageEditor.tsx) so the Pages
// two-column shell can mount it for the pinned Home row.
// This route keeps its loader/action (incl. the autosave-landing
// requireProjectMember gate) and renders the same editor for /homepage and
// /pages/index.

export default function HomepagePage({ loaderData }: Route.ComponentProps) {
  return <HomepageEditor data={loaderData} />;
}
