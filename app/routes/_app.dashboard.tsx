/**
 * This file is the Dashboard route — the project management hub
 * where convenors and collaborators land after sign-in. Lists owned
 * + shared projects, surfaces the orphan-stories banner, exposes
 * team management for the active project, and serves as the launch
 * point for switching between projects.
 *
 * Loader fetches the user's full project set (via `getUserProjects`),
 * the active project's team members, pending invites, project
 * config, and any orphan story IDs that drive the orphan-stories
 * banner. Action handles switch-project, reorder, autosave-config,
 * sync, and team-management intents (generate-invite, search-users,
 * send-invite, remove-member). The page renders the project status
 * bar, workflow steps, team panel, and orphan-stories banner.
 *
 * Preview sections (Site Description, Welcome Message, Stories /
 * Objects showcase) live on the Homepage tab in
 * `_app.homepage.tsx` — they were relocated and this route keeps
 * the project-management shell only.
 *
 * @version v1.3.0-beta
 */

import { asc, count, desc, eq, and, gt, inArray, isNull, sql } from "drizzle-orm";
import { Trans, useTranslation } from "react-i18next";
import { Link, redirect, useFetcher, useLoaderData, useNavigate, useSearchParams } from "react-router";
import React, { useState, useEffect } from "react";
import type { Route } from "./+types/_app.dashboard";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { projects, stories, steps, layers, project_config, project_members, project_invites, users } from "~/db/schema";
import { createSessionStorage } from "~/lib/session.server";
import { decrypt } from "~/lib/crypto.server";
import { getFileContent, getRepoHead } from "~/lib/github.server";
import { getUserProjects, requireOwner, requireProjectMember } from "~/lib/membership.server";
import { makeInternalMarkerHeaders } from "~/lib/internal-marker.server";
import { recordActivity } from "~/lib/activity.server";
import { computeFullSyncDiff, applyFullSyncChanges } from "~/lib/sync.server";
import type { FullSyncChanges } from "~/lib/sync.server";
import { bumpProjectHead } from "~/lib/github-status.server";
import {
  scanRepoOrphanStoryIds,
  parseCompositorIgnored,
  parseTelarCsv,
  mapStoryCsv,
} from "~/lib/import.server";
import { commitFilesToRepo } from "~/lib/commit.server";
import { ProjectStatusBar } from "~/components/features/dashboard/ProjectStatusBar";
import {
  SyncConfirmModal,
  SYNC_DIFF_FETCHER_KEY,
} from "~/components/features/dashboard/SyncConfirmModal";
import { RoleBadge } from "~/components/features/dashboard/RoleBadge";
import OrphanStoryBanner from "~/components/features/dashboard/OrphanStoryBanner";
import { useVersionChangeToast } from "~/hooks/use-version-change-toast";
import { EmptyState } from "~/components/features/dashboard/EmptyState";
import { Settings, Image, BookOpen, Sparkles, Upload } from "lucide-react";

export const handle = { i18n: ["common", "dashboard", "team", "upgrade", "sync"] };

export async function loader() {
  // The dashboard is retired AS A DESTINATION. A stray nav to /dashboard
  // (stale bookmark, old link) lands on /objects, the daily home. The `action`
  // export below stays fully intact — /dashboard remains the shared global
  // endpoint for invites, member management, autosave-config, switch-project,
  // reorder, and the sync intents. Only the page is gone.
  throw redirect("/objects");
}

export async function action({ request, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });
  // Rebind narrowed user.id as a primitive const so inner async closures
  // (getActiveProject) can capture it without losing the null-guard narrowing.
  const userId = user.id;

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // Helper to get active project from session
  async function getActiveProject() {
    const sessionStorage = createSessionStorage(env.SESSION_SECRET);
    const session = await sessionStorage.getSession(request.headers.get("Cookie"));
    const sessionActiveId = session.get("activeProjectId") as number | undefined;
    const allProjects = await getUserProjects(db, userId);
    if (allProjects.length === 0) return null;
    return allProjects.find((p) => p.id === Number(sessionActiveId)) ?? allProjects[0];
  }

  switch (intent) {
    case "reorder": {
      const orderJson = formData.get("order") as string;
      const projectId = Number(formData.get("projectId"));
      const order: number[] = JSON.parse(orderJson);

      await requireProjectMember(db, projectId, user.id);

      // Security: verify all story IDs belong to an accessible project
      const projectStories = await db
        .select({ id: stories.id })
        .from(stories)
        .where(
          and(
            eq(stories.project_id, projectId),
            inArray(stories.id, order)
          )
        );

      const ownedIds = new Set(projectStories.map((s) => s.id));
      const now = new Date().toISOString();

      await Promise.all(
        order
          .filter((id) => ownedIds.has(id))
          .map((id, idx) =>
            db
              .update(stories)
              .set({ order: idx, updated_at: now })
              .where(eq(stories.id, id))
          )
      );

      return { ok: true, intent: "reorder" };
    }

    case "switch-project": {
      const projectId = Number(formData.get("projectId"));

      // Verify the user has access to this project
      const allProjects = await getUserProjects(db, user.id);
      const accessible = allProjects.find((p) => p.id === projectId);
      if (!accessible) {
        throw new Response("Not found", { status: 404 });
      }

      const sessionStorage = createSessionStorage(env.SESSION_SECRET);
      const session = await sessionStorage.getSession(request.headers.get("Cookie"));
      session.set("activeProjectId", projectId);
      const cookie = await sessionStorage.commitSession(session);

      // Dashboard is no longer a destination — land the switched-into
      // project on /objects, the daily home.
      return redirect("/objects", {
        headers: { "Set-Cookie": cookie },
      });
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

    case "generate-invite": {
      const activeProject = await getActiveProject();
      if (!activeProject) return { ok: false, intent: "generate-invite", error: "no_project" };

      await requireOwner(db, activeProject.id, user.id);

      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      await db.insert(project_invites).values({
        project_id: activeProject.id,
        token,
        created_by: user.id,
        expires_at: expiresAt,
      });

      const origin = new URL(request.url).origin;
      const inviteUrl = `${origin}/invite/${token}`;
      return { ok: true, intent: "generate-invite", inviteUrl };
    }

    case "search-users": {
      const query = (formData.get("query") as string) ?? "";
      if (!query || query.length < 2) {
        return { ok: true, intent: "search-users", users: [] };
      }

      const activeProject = await getActiveProject();
      if (!activeProject) return { ok: false, intent: "search-users", error: "no_project" };

      try {
        const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
        const { searchGitHubUsers } = await import("~/lib/github.server");
        const results = await searchGitHubUsers(token, query);
        return { ok: true, intent: "search-users", users: results };
      } catch {
        return { ok: true, intent: "search-users", users: [] };
      }
    }

    case "send-invite": {
      const username = formData.get("username") as string;
      if (!username) return { ok: false, intent: "send-invite", error: "missing_username" };

      const activeProject = await getActiveProject();
      if (!activeProject) return { ok: false, intent: "send-invite", error: "no_project" };

      await requireOwner(db, activeProject.id, user.id);

      // Look up user by github_login
      const targetUserRows = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.github_login, username))
        .limit(1);

      if (targetUserRows.length > 0) {
        const targetUserId = targetUserRows[0].id;
        // Add as member directly (onConflictDoNothing handles already-a-member)
        await db
          .insert(project_members)
          .values({
            project_id: activeProject.id,
            user_id: targetUserId,
            role: "collaborator",
            joined_at: new Date().toISOString(),
          })
          .onConflictDoNothing();
        return { ok: true, intent: "send-invite", added: true };
      } else {
        // Create token-based invite
        const token = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
        await db.insert(project_invites).values({
          project_id: activeProject.id,
          token,
          created_by: user.id,
          expires_at: expiresAt,
        });
        const origin = new URL(request.url).origin;
        const inviteUrl = `${origin}/invite/${token}`;
        return { ok: true, intent: "send-invite", added: false, inviteUrl };
      }
    }

    case "cancel-invite": {
      const inviteId = Number(formData.get("inviteId"));
      if (!inviteId) return { ok: false, intent: "cancel-invite", error: "missing_invite_id" };

      const activeProject = await getActiveProject();
      if (!activeProject) return { ok: false, intent: "cancel-invite", error: "no_project" };

      await requireOwner(db, activeProject.id, user.id);

      // Verify invite belongs to this project
      await db
        .delete(project_invites)
        .where(
          and(
            eq(project_invites.id, inviteId),
            eq(project_invites.project_id, activeProject.id),
          )
        );

      return { ok: true, intent: "cancel-invite" };
    }

    case "remove-member": {
      const targetUserId = Number(formData.get("userId"));
      if (!targetUserId) return { ok: false, intent: "remove-member", error: "missing_user_id" };

      const activeProject = await getActiveProject();
      if (!activeProject) return { ok: false, intent: "remove-member", error: "no_project" };

      await requireOwner(db, activeProject.id, user.id);

      // Cannot remove the owner
      const targetRole = await db
        .select({ role: project_members.role })
        .from(project_members)
        .where(
          and(
            eq(project_members.project_id, activeProject.id),
            eq(project_members.user_id, targetUserId)
          )
        )
        .limit(1);

      if (targetRole[0]?.role === "convenor") {
        return { ok: false, intent: "remove-member", error: "cannot_remove_owner" };
      }

      await db
        .delete(project_members)
        .where(
          and(
            eq(project_members.project_id, activeProject.id),
            eq(project_members.user_id, targetUserId)
          )
        );

      // Best-effort DO eviction — close the removed collaborator's live
      // WebSocket. D1 removal already succeeded; DO outage must not flip
      // the user-visible outcome.
      try {
        const headers = await makeInternalMarkerHeaders(
          activeProject.id,
          env.SESSION_SECRET,
          "notify-deleted",
          targetUserId,
        );
        const stub = env.COLLABORATION.get(
          env.COLLABORATION.idFromName(String(activeProject.id)),
        );
        await stub.fetch(
          new Request(
            `https://internal/notify-deleted?userId=${targetUserId}`,
            { method: "POST", headers },
          ),
        );
      } catch {
        // DO outage does not flip the user-visible outcome — D1 removal already succeeded.
      }

      return { ok: true, intent: "remove-member" };
    }

    case "compute-full-sync-diff": {
      const activeProject = await getActiveProject();
      if (!activeProject) {
        return { ok: false, intent: "compute-full-sync-diff", error: "no_project" };
      }

      // Guard: only owners may sync
      await requireOwner(db, activeProject.id, user.id);

      try {
        const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
        const [owner, repo] = activeProject.github_repo_full_name.split("/");
        const diff = await computeFullSyncDiff(
          activeProject.id,
          token,
          owner,
          repo,
          db,
          null,
        );

        const hasChanges =
          (diff.objects?.newObjects?.length ?? 0) > 0 ||
          (diff.objects?.changedObjects?.length ?? 0) > 0 ||
          (diff.objects?.missingObjects?.length ?? 0) > 0 ||
          (diff.stories?.newStories?.length ?? 0) > 0 ||
          (diff.stories?.changedStories?.length ?? 0) > 0 ||
          (diff.stories?.missingStories?.length ?? 0) > 0 ||
          (diff.config?.changedFields?.length ?? 0) > 0;

        if (!hasChanges) {
          const currentHead = await getRepoHead(token, owner, repo);
          if (currentHead) {
            // Invalidates GitHub status cache so the next poll recomputes
            await bumpProjectHead(db, activeProject.id, currentHead);
          }
        }

        return { ok: true, intent: "compute-full-sync-diff", diff };
      } catch (err) {
        return {
          ok: false,
          intent: "compute-full-sync-diff",
          error: "sync_failed",
          message: err instanceof Error ? err.message : "Unknown error",
        };
      }
    }

    case "apply-full-sync": {
      const activeProject = await getActiveProject();
      if (!activeProject) {
        return { ok: false, intent: "apply-full-sync", error: "no_project" };
      }

      // Guard: only owners may apply sync
      await requireOwner(db, activeProject.id, user.id);

      const changesJson = formData.get("changes") as string;
      if (!changesJson) {
        return { ok: false, intent: "apply-full-sync", error: "missing_changes" };
      }

      let changes: FullSyncChanges;
      try {
        changes = JSON.parse(changesJson) as FullSyncChanges;
      } catch {
        return { ok: false, intent: "apply-full-sync", error: "invalid_changes" };
      }

      try {
        const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
        const [owner, repo] = activeProject.github_repo_full_name.split("/");
        const result = await applyFullSyncChanges(
          activeProject.id,
          changes,
          token,
          owner,
          repo,
          db,
        );

        // Activity feed: one site-level row per sync.
        // requireOwner already gated this case; actor is the server-resolved
        // user.id. Fails open — never breaks the sync it rides alongside.
        await recordActivity(db, {
          projectId: activeProject.id,
          actorUserId: user.id,
          verb: "synced",
          entityType: "site",
        });

        return { ok: true, intent: "apply-full-sync", newHeadSha: result.newHeadSha };
      } catch (err) {
        return {
          ok: false,
          intent: "apply-full-sync",
          error: err instanceof Error ? err.message : "Unknown error",
        };
      }
    }

    case "accept-divergence": {
      // Bump head_sha to current GitHub HEAD without
      // re-importing. Single UPDATE; no entity changes. Uses freshly-fetched
      // HEAD (NOT the cached banner-check value).
      const activeProject = await getActiveProject();
      if (!activeProject) {
        return { ok: false, intent: "accept-divergence", error: "no_project" };
      }
      await requireOwner(db, activeProject.id, user.id);
      try {
        const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
        const [owner, repo] = activeProject.github_repo_full_name.split("/");
        const currentHead = await getRepoHead(token, owner, repo);
        const now = new Date().toISOString();
        await db
          .update(projects)
          .set({
            head_sha: currentHead,
            last_synced_at: now,
            updated_at: now,
            gh_checked_at: null,
          })
          .where(eq(projects.id, activeProject.id));
        return { ok: true, intent: "accept-divergence" };
      } catch (err) {
        return {
          ok: false,
          intent: "accept-divergence",
          error: "accept_divergence_failed",
          message: err instanceof Error ? err.message : "Unknown error",
        };
      }
    }

    case "restore-orphan-drafts": {
      // Bulk-restore orphan
      // {story_id}.csv files as drafts. The set of orphan IDs is
      // RECOMPUTED server-side via scanRepoOrphanStoryIds — the form
      // payload carries no IDs, so a client-crafted form cannot point
      // this action at arbitrary {id}.csv files outside the orphan set.
      //
      // Staging-UAT hotfix: the original
      // design wrote directly to D1, but workers/collaboration.ts:1289's
      // snapshotToD1 reconciles D1 against the Y.doc and DELETEs any
      // D1 row not in the Y.doc — so the new D1 rows lived only until
      // the next 30s alarm. Fix: route the restored data through the
      // Y.doc via the DO's new POST /restore-orphans endpoint. The
      // existing snapshotToD1 INSERT path then handles D1 writeback
      // normally.
      const activeProject = await getActiveProject();
      if (!activeProject) {
        return { ok: false, intent: "restore-orphan-drafts", error: "no_project" };
      }
      await requireOwner(db, activeProject.id, user.id);

      try {
        const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
        const [owner, repo] = activeProject.github_repo_full_name.split("/");

        // Recompute authoritative orphan set (tampering mitigation).
        const existingStoryRows = await db
          .select({ story_id: stories.story_id })
          .from(stories)
          .where(eq(stories.project_id, activeProject.id));
        const projectStoryIds = new Set(existingStoryRows.map((r) => r.story_id));
        const orphanIds = await scanRepoOrphanStoryIds(
          token,
          owner,
          repo,
          projectStoryIds,
        );

        if (orphanIds.length === 0) {
          return { ok: true, intent: "restore-orphan-drafts", restored: 0 };
        }

        // Fetch + parse each orphan CSV, build the DO payload. Skip
        // files that vanished between the scan and the fetch (rare
        // race; the next dashboard load would simply pick them up again).
        const doStories: Array<{
          storyId: string;
          steps: Array<Record<string, unknown>>;
          layers: Array<Record<string, unknown>>;
        }> = [];
        for (const storyId of orphanIds) {
          const csvText = await getFileContent(
            token,
            owner,
            repo,
            `telar-content/spreadsheets/${storyId}.csv`,
          );
          if (!csvText) continue;

          const parsedRows = parseTelarCsv(csvText);
          // mapStoryCsv expects a numeric storyDbId for the step.story_id
          // foreign key; for the DO payload we throw it away (the DO
          // re-derives _id via snapshotToD1's INSERT path). Negative
          // placeholder on layer.step_id is converted to a positive
          // step_index here so the DO can thread layers without
          // re-implementing the placeholder convention.
          const { steps: stepRows, layers: layerRows } = mapStoryCsv(parsedRows, 0);
          // mapStoryCsv emits rows in the same order as the input nonBlankRows
          // and stamps step.story_id = 0 (the dbId we passed). We only need
          // the per-step fields the DO writes onto each Y.Map.
          const doSteps = stepRows.map((s) => ({
            step_number: s.step_number,
            kind: s.kind,
            object_id: s.object_id ?? "",
            x: s.x ?? null,
            y: s.y ?? null,
            zoom: s.zoom ?? null,
            page: s.page ?? "",
            question: s.question ?? "",
            answer: s.answer ?? "",
            clip_start: s.clip_start ?? "",
            clip_end: s.clip_end ?? "",
            loop: s.loop ?? "",
          }));
          // layer.step_id from mapStoryCsv is the negative placeholder
          // `-(rowIndex + 1)`; convert to a 0-based step_index for the DO.
          const doLayers = layerRows.map((l) => ({
            step_index: Math.abs(l.step_id as number) - 1,
            layer_number: l.layer_number,
            title: (l.title ?? "") as string,
            button_label: (l.button_label ?? "") as string,
            content: (l.content ?? "") as string,
          }));
          doStories.push({ storyId, steps: doSteps, layers: doLayers });
        }

        if (doStories.length === 0) {
          return { ok: true, intent: "restore-orphan-drafts", restored: 0 };
        }

        // Call the DO's /restore-orphans endpoint. The DO mutates its
        // Y.doc, runs snapshotToD1 to persist, and broadcasts the new
        // state to connected /stories editors. We send the parsed data
        // (not the raw CSV) so the DO doesn't need to import the CSV
        // parser — the action owns parsing as the canonical site.
        const doId = env.COLLABORATION.idFromName(String(activeProject.id));
        const doStub = env.COLLABORATION.get(doId);
        const internalHeaders = await makeInternalMarkerHeaders(
          activeProject.id,
          env.SESSION_SECRET,
          "restore-orphans",
        );
        const restoreRes = await doStub.fetch(
          new Request("https://internal/restore-orphans", {
            method: "POST",
            headers: {
              ...internalHeaders,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ stories: doStories }),
          }),
        );
        if (!restoreRes.ok) {
          return {
            ok: false,
            intent: "restore-orphan-drafts",
            error: "restore_failed",
            message: `DO returned ${restoreRes.status}`,
          };
        }
        const restoreJson = (await restoreRes.json()) as { restored: number };
        return {
          ok: true,
          intent: "restore-orphan-drafts",
          restored: restoreJson.restored ?? 0,
        };
      } catch (err) {
        return {
          ok: false,
          intent: "restore-orphan-drafts",
          error: "restore_failed",
          message: err instanceof Error ? err.message : "Unknown error",
        };
      }
    }

    case "ignore-orphans": {
      // Append the authoritative
      // orphan set to .compositor-ignored on GitHub. Same server-side
      // recomputation as restore-orphan-drafts — form payload carries
      // no IDs.
      const activeProject = await getActiveProject();
      if (!activeProject) {
        return { ok: false, intent: "ignore-orphans", error: "no_project" };
      }
      await requireOwner(db, activeProject.id, user.id);

      try {
        const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
        const [owner, repo] = activeProject.github_repo_full_name.split("/");

        // Recompute authoritative orphan set (tampering mitigation).
        const existingStoryRows = await db
          .select({ story_id: stories.story_id })
          .from(stories)
          .where(eq(stories.project_id, activeProject.id));
        const projectStoryIds = new Set(existingStoryRows.map((r) => r.story_id));
        const orphanIds = await scanRepoOrphanStoryIds(
          token,
          owner,
          repo,
          projectStoryIds,
        );

        if (orphanIds.length === 0) {
          return { ok: true, intent: "ignore-orphans", ignored: 0 };
        }

        // Read existing .compositor-ignored (404 → null → empty list)
        // and dedupe-append the new IDs. Reuse parseCompositorIgnored
        // so the read-modify-write cycle preserves comments and
        // existing ordering rules.
        const existingRaw = await getFileContent(
          token,
          owner,
          repo,
          ".compositor-ignored",
        );
        const existingIds = new Set(parseCompositorIgnored(existingRaw));
        const newIds = orphanIds.filter((id) => !existingIds.has(id));

        if (newIds.length === 0) {
          return { ok: true, intent: "ignore-orphans", ignored: 0 };
        }

        // Build the new file body: preserve the existing raw content
        // verbatim (including comments and trailing newline state) and
        // append the new IDs each on their own line. If the file did
        // not exist, start with a brief header comment so a human
        // browsing the repo can interpret it.
        let newBody: string;
        if (existingRaw === null) {
          newBody =
            "# .compositor-ignored — story IDs the compositor will not\n" +
            "# resurface as orphans on import. Managed by the compositor\n" +
            "# Compositor ignored-story IDs; safe to hand-edit (one ID per line; `#` comments).\n" +
            newIds.join("\n") +
            "\n";
        } else {
          const trimmed = existingRaw.endsWith("\n")
            ? existingRaw
            : existingRaw + "\n";
          newBody = trimmed + newIds.join("\n") + "\n";
        }

        await commitFilesToRepo(
          token,
          owner,
          repo,
          "main",
          [{ path: ".compositor-ignored", content: newBody }],
          `chore: append ${newIds.length} orphan id(s) to .compositor-ignored`,
          undefined,
          undefined,
          true, // skipCi — ignore-list is compositor metadata, not site content
        );

        return { ok: true, intent: "ignore-orphans", ignored: newIds.length };
      } catch (err) {
        return {
          ok: false,
          intent: "ignore-orphans",
          error: "ignore_failed",
          message: err instanceof Error ? err.message : "Unknown error",
        };
      }
    }

    default:
      throw new Response("Bad request", { status: 400 });
  }
}

/**
 * DashboardPage — UNREACHABLE component.
 *
 * The loader above unconditionally redirects /dashboard → /objects, so this
 * component never renders. It is retained as the route's default export (a
 * React Router route module must export a component) but its former
 * project-management JSX was removed when the dashboard was retired as a
 * destination. The `action` export remains the live shared endpoint.
 */
export default function DashboardPage() {
  return null;
}
