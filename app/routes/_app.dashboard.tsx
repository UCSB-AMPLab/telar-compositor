/**
 * This file is the /dashboard route — no longer a page, but the app's
 * shared global action endpoint. The dashboard was retired as a
 * destination: its panels were dispersed to the Homepage tab, the
 * collaboration sidebar, the header's project switcher, and the /start
 * recovery card, and the loader now redirects any stray GET (a stale
 * bookmark, an old link) to /objects, the daily home.
 *
 * The `action` export is what keeps this route alive. It is the one
 * endpoint for project-scoped intents that no single page owns, and
 * components across the app POST here with an explicit
 * `action: "/dashboard"`:
 *
 * - switch-project — the header's project switcher and the onboarding
 *   project list
 * - generate-invite, search-users, send-invite, cancel-invite,
 *   remove-member — team management in the collaboration sidebar
 * - create-code, revoke-code — a course's join codes. Unlike every other
 *   intent here these name their target project in the form rather than
 *   taking the session's active one: a course's staff manage its codes
 *   from wherever they are, and the id is verified against D1 by the gate.
 *   Both are course management and take the course password on top of
 *   staff standing; `switch-project` below does not, and must not — it is
 *   the door a suppressed child site is still reached through.
 * - compute-full-sync-diff, apply-full-sync, accept-divergence — the
 *   repo sync review flow and the out-of-sync popover
 * - restore-orphan-drafts, ignore-orphans — the orphan-story recovery
 *   card on /start
 *
 * The default export is an unreachable null stub: React Router requires
 * a component on any route module that client-side navigations target,
 * so it stays (see the note above it).
 *
 * @version v1.5.0-beta
 */

import { eq, and, isNull } from "drizzle-orm";
import { redirect } from "react-router";
import { answerReadsClientAction } from "~/lib/unreachable-write";
import type { Route } from "./+types/_app.dashboard";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { stories, project_config, project_members, project_invites, users } from "~/db/schema";
import { createSessionStorage } from "~/lib/session.server";
import { decrypt } from "~/lib/crypto.server";
import { getFileAtRef, getRepoHead } from "~/lib/github.server";
import { getUserProjects, requireOwner, requireCourseCodeManager, isMembershipExitRefused } from "~/lib/membership.server";
import { extrasOnWire } from "~/lib/extra-columns.server";
import { issuesFor } from "~/lib/sheet-warnings";
import type { SheetWarning } from "~/lib/sheet-warnings";
import { createCode } from "~/lib/join-codes.server";
import { endMembership } from "~/lib/course-membership.server";
import { gatePageSite } from "~/lib/page-site-gate.server";
import { makeInternalMarkerHeaders } from "~/lib/internal-marker.server";
import { recordActivity } from "~/lib/activity.server";
import {
  applyFullSyncChanges,
  applyGitHubObjectOrder,
  checkRepairingLegacyIds,
  computeFullSyncDiff,
  finishPendingBeforeCheck,
  SyncBaseStale,
} from "~/lib/sync.server";
import { contentRefusal } from "~/lib/sync-apply-refusal.server";
import { readSiteTelarVersion } from "~/lib/site-version.server";
import { syncFailure } from "~/lib/sync-failure.server";
import { SheetUnreadableError } from "~/lib/unreadable-file.server";
import { headConfigSheets, headHasGlossaryCsv, markSheetsEffects, pushUnreadable } from "~/lib/unreadable-characters.server";
import { recordStorySheetReads, storySheetPath } from "~/lib/story-source-path.server";
import { recordStoryFileReads, storyFileRead, type OwedStoryFile } from "~/lib/story-files-to-delete.server";
import type { FullSyncChanges } from "~/lib/sync.server";
import { bumpProjectHeadFrom } from "~/lib/github-status.server";
import { keptPageFilesRecordJson } from "~/lib/page-files-check.server";
import { pageFilesColumn } from "~/lib/page-files-record.server";
import { recordIfLeaseFree } from "~/lib/operation-lease.server";
import { syncedRowsFingerprint } from "~/lib/synced-rows-fingerprint.server";
import { legacyRecordRef, markLegacyIdsRepaired } from "~/lib/legacy-object-ids.server";
import { hasDiffChanges } from "~/components/features/dashboard/sync-changes";
import {
  scanRepoOrphanStoryIds,
  parseCompositorIgnored,
  parseTelarCsv,
  readOncePerName,
  resolveLayerFileReferences,
  mapStoryCsv,
  STORY_CANONICAL_SCOPE,
} from "~/lib/import.server";
import { commitFilesToRepo } from "~/lib/commit.server";
import { requireCourseAccess } from "~/lib/course-gate.server";

export const handle = { i18n: ["common", "dashboard", "team", "upgrade", "sync", "config"] };

export async function loader() {
  // The dashboard is retired AS A DESTINATION. A stray nav to /dashboard
  // (stale bookmark, old link) lands on /objects, the daily home. The `action`
  // export below stays fully intact — /dashboard remains the shared global
  // endpoint for invites, member management, switch-project, and the sync
  // intents. Only the page is gone.
  throw redirect("/objects");
}

/**
 * Cancels an invite on the invite row's own site, which is the one the page
 * showed it on, by that site's convenor, whichever site the session names.
 * Cancellation is a revocation, not a delete: `joined_via_invite_id`
 * references this row, and a cancelled invite stays standing as the admission
 * record of anyone it already let in.
 */
async function cancelInvite(db: ReturnType<typeof getDb>, userId: number, inviteId: number) {
  if (!inviteId) return { ok: false, intent: "cancel-invite", error: "missing_invite_id" };
  const [invite] = await db
    .select({ project_id: project_invites.project_id })
    .from(project_invites)
    .where(eq(project_invites.id, inviteId))
    .limit(1);
  if (!invite) return { ok: true, intent: "cancel-invite" };
  await requireOwner(db, invite.project_id, userId);
  await db
    .update(project_invites)
    .set({ revoked_at: new Date().toISOString() })
    .where(
      and(
        eq(project_invites.id, inviteId),
        eq(project_invites.project_id, invite.project_id),
        isNull(project_invites.revoked_at),
      ),
    );
  return { ok: true, intent: "cancel-invite" };
}

/**
 * "Use Compositor version", once the posted identity has been checked: GitHub's
 * object order applied at `shown`, then `shown` recorded compare-and-set from
 * `base`. The order goes first because it has no Compositor side to keep:
 * recording the head without it would read a reorder as done while D1 keeps
 * its own. A head recorded since the check (`base` moved) answers stale before
 * any order is written; a row the order names that was re-created since
 * answers stale too, and a failed read or ingest answers failed. None of them
 * records anything. A Keep that records `shown` counts as the project's first
 * sync check: its ingest gave any row an earlier import stored stripped
 * GitHub's spelling, so the ids are marked repaired (`markLegacyIdsRepaired`).
 */
async function keepCompositorVersion(
  db: ReturnType<typeof getDb>,
  env: Env,
  user: { id: number; encrypted_access_token: string },
  project: { id: number; github_repo_full_name: string },
  base: string | null,
  shown: string,
) {
  const stale = { ok: false, intent: "accept-divergence", error: "accept_divergence_stale" } as const;
  try {
    const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
    const [owner, repo] = project.github_repo_full_name.split("/");
    // The page files record at `shown` with nothing applied (R5), carried
    // unchanged when the check does not conclude.
    const recordJson = await keptPageFilesRecordJson(db, project.id, { token, owner, repo }, base, shown);
    // Recorded under the order's lease, before it is released.
    const recordShownHead = () => {
      const now = Date.now();
      return bumpProjectHeadFrom(db, project.id, base, shown, now, {
        last_synced_at: new Date(now).toISOString(), ...pageFilesColumn(recordJson),
      });
    };
    const ordered = await applyGitHubObjectOrder(project.id, { token, owner, repo }, shown, base, db, env, user.id, recordShownHead);
    if (ordered.superseded || !ordered.recorded) return stale;
    if (!ordered.legacyUnjudged) await markLegacyIdsRepaired(db, project.id);
    return { ok: true, intent: "accept-divergence" } as const;
  } catch (err) {
    if (err instanceof SyncBaseStale) return stale;
    return {
      ok: false,
      intent: "accept-divergence",
      error: "accept_divergence_failed",
      message: err instanceof Error ? err.message : "Unknown error",
    } as const;
  }
}

// The user search and the sync diff answer "unreachable" when they fail in transit.
export const clientAction = answerReadsClientAction(["search-users", "compute-full-sync-diff"]);

export async function action({ request, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // Intents that do not act on the session's site, skipped by the page-site
  // check below. `switch-project` changes the session's site; `create-code`
  // and `revoke-code` act on the course the form names, verified against D1;
  // `cancel-invite` acts on the invite row's own site.
  const PAGE_SITE_EXEMPT = ["switch-project", "create-code", "revoke-code", "cancel-invite"];

  // Every other intent acts on the session's site, and only when the page
  // that posted it showed that site. `null` is the no-project case, which each
  // intent answers in its own shape.
  const gate = await gatePageSite(request, env, user.id, formData, intent, PAGE_SITE_EXEMPT);
  if (gate.refused) return gate.refused;
  const page = gate.page;

  switch (intent) {
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

    case "generate-invite": {
      const resolved = page;
      if (!resolved) return { ok: false, intent: "generate-invite", error: "no_project" };
      const activeProject = resolved.project;

      await requireOwner(db, activeProject.id, user.id);

      // A course admits people through its codes and nothing else: a
      // collaborator row on the course project would confer a live editing
      // socket on the master collection, its config and its pages.
      if (activeProject.kind === "course") {
        return { ok: false, intent: "generate-invite", error: "invite_refused_course" };
      }

      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      await db.insert(project_invites).values({
        project_id: activeProject.id,
        token,
        created_by: user.id,
        expires_at: expiresAt,
        conferred_role: "collaborator",
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

      if (!page) return { ok: false, intent: "search-users", error: "no_project" };

      try {
        const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
        const { searchGitHubUsers } = await import("~/lib/github.server");
        const results = await searchGitHubUsers(token, query);
        return { ok: true, intent: "search-users", users: results };
      } catch {
        // A search that could not be made is not a search with no matches.
        return { ok: false as const, reason: "unreachable" as const, intent: "search-users" as const };
      }
    }

    case "send-invite": {
      const username = formData.get("username") as string;
      if (!username) return { ok: false, intent: "send-invite", error: "missing_username" };

      const resolved = page;
      if (!resolved) return { ok: false, intent: "send-invite", error: "no_project" };
      const activeProject = resolved.project;

      await requireOwner(db, activeProject.id, user.id);

      // Course membership is staff only (see generate-invite above), and
      // this intent can insert a collaborator row directly.
      if (activeProject.kind === "course") {
        return { ok: false, intent: "send-invite", error: "invite_refused_course" };
      }

      // Look up user by github_login
      const targetUserRows = await db
        .select({ id: users.id })
        .from(users)
        // Never a deleted account's tombstone, which can share the login with
        // the person's new account.
        .where(and(eq(users.github_login, username), isNull(users.deleted_at)))
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
        return { ok: true, intent: "send-invite", added: true, username };
      } else {
        // Nothing in the Compositor sends mail, so this link IS the
        // invitation and the person at the form is the one who delivers it.
        // The caller must show it: the pending row it creates offers no way
        // to retrieve it later.
        const token = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
        await db.insert(project_invites).values({
          project_id: activeProject.id,
          token,
          created_by: user.id,
          expires_at: expiresAt,
          conferred_role: "collaborator",
          });
        const origin = new URL(request.url).origin;
        const inviteUrl = `${origin}/invite/${token}`;
        return { ok: true, intent: "send-invite", added: false, inviteUrl, username };
      }
    }

    case "cancel-invite":
      return cancelInvite(db, user.id, Number(formData.get("inviteId")));

    case "create-code": {
      // Issuing a code is running a course, which takes the course password
      // (ruling 20). Answered before the caller's standing is looked up, so
      // a gate-less caller learns nothing about the project it names.
      requireCourseAccess(user);

      // The target is a course, which is not necessarily the session's
      // active project — an instructor issues codes for the course they
      // name. It arrives from the form and is verified against D1 by the
      // gate, never taken from the session.
      const projectId = Number(formData.get("projectId"));
      if (!projectId) {
        return { ok: false, intent: "create-code", error: "missing_project_id" };
      }
      const role =
        formData.get("role") === "instructor" ? "instructor" : "collaborator";

      await requireCourseCodeManager(db, projectId, user.id, role);

      // Codes carry the caller's expiry — a class code lives a term, or
      // never expires at all; the legacy 48-hour window belongs to invite
      // links alone. An empty field is the "never expires" answer, so it is
      // absence rather than a bad date and must not be rejected as one.
      const expiresAtRaw = String(formData.get("expiresAt") ?? "").trim();
      let expiresAt: string | null = null;
      if (expiresAtRaw !== "") {
        if (!Number.isFinite(Date.parse(expiresAtRaw))) {
          return { ok: false, intent: "create-code", error: "invalid_expiry" };
        }
        expiresAt = new Date(expiresAtRaw).toISOString();
      }

      const labelRaw = String(formData.get("label") ?? "").trim();

      const created = await createCode(db, {
        projectId,
        role,
        expiresAt,
        label: labelRaw === "" ? null : labelRaw,
        createdBy: user.id,
      });

      return { ok: true, intent: "create-code", code: created.token, codeId: created.id };
    }

    case "revoke-code": {
      // Revoking is course management like issuing, and takes the same
      // password.
      requireCourseAccess(user);

      const projectId = Number(formData.get("projectId"));
      const inviteId = Number(formData.get("inviteId"));
      if (!projectId || !inviteId) {
        return { ok: false, intent: "revoke-code", error: "missing_code_id" };
      }

      // Staff standing is established before the code is read, so a caller
      // with none cannot learn from the refusal whether a code id is real.
      const { role } = await requireCourseCodeManager(
        db,
        projectId,
        user.id,
        "collaborator",
      );

      const codeRows = await db
        .select({ conferred_role: project_invites.conferred_role })
        .from(project_invites)
        .where(
          and(
            eq(project_invites.id, inviteId),
            eq(project_invites.project_id, projectId),
          ),
        )
        .limit(1);

      if (codeRows.length === 0) {
        return { ok: false, intent: "revoke-code", error: "not_found" };
      }

      // Revoking a staff code is staff-list management, so it narrows to
      // the convenor even though the caller may run the course day to day.
      if (codeRows[0].conferred_role === "instructor" && role !== "convenor") {
        throw new Response("Forbidden", { status: 403 });
      }

      await db
        .update(project_invites)
        .set({ revoked_at: new Date().toISOString() })
        .where(
          and(
            eq(project_invites.id, inviteId),
            eq(project_invites.project_id, projectId),
            isNull(project_invites.revoked_at),
          ),
        );

      return { ok: true, intent: "revoke-code" };
    }

    case "remove-member": {
      const targetUserId = Number(formData.get("userId"));
      if (!targetUserId) return { ok: false, intent: "remove-member", error: "missing_user_id" };

      const resolved = page;
      if (!resolved) return { ok: false, intent: "remove-member", error: "no_project" };
      const activeProject = resolved.project;

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

      // Instructor membership on a child project is tied to the course in
      // both directions (design §5) — a convenor removing it here would
      // produce a state the design declares impossible. Only queried when
      // the target actually is an instructor; the shared check also gates
      // self-service `leave-project` in _app.account.tsx.
      if (
        targetRole[0]?.role === "instructor" &&
        (await isMembershipExitRefused(db, activeProject.id, "instructor"))
      ) {
        return { ok: false, intent: "remove-member", error: "instructor_on_child" };
      }

      // Ends the course's copies on its children too when this is someone's
      // standing on a course's staff (endMembership).
      await endMembership(db, env, { projectId: activeProject.id, userId: targetUserId });

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
      const resolved = page;
      if (!resolved) {
        return { ok: false, intent: "compute-full-sync-diff", error: "no_project" };
      }
      const activeProject = resolved.project;

      // Guard: only owners may sync
      await requireOwner(db, activeProject.id, user.id);

      try {
        const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
        const [owner, repo] = activeProject.github_repo_full_name.split("/");
        await finishPendingBeforeCheck(env, db, activeProject.id, user.id, { token, owner, repo });

        // Snapshot the DO to D1 first so the diff compares the repo against a
        // current D1 — D1 lags the live doc by up to the snapshot interval, so
        // without this an active editor's seconds-old change could misreport as
        // (un)changed. Best-effort: a DO outage degrades to today's behaviour.
        try {
          const snapshotHeaders = await makeInternalMarkerHeaders(
            activeProject.id,
            env.SESSION_SECRET,
            "snapshot",
          );
          const stub = env.COLLABORATION.get(
            env.COLLABORATION.idFromName(String(activeProject.id)),
          );
          await stub.fetch(
            new Request("https://internal/snapshot", { method: "POST", headers: snapshotHeaders }),
          );
        } catch {
          // DO unreachable — fall through to the diff against existing D1.
        }

        // Everything in D1 the check compares, taken before it reads any of
        // it, the site's version included: a write landing during the check's
        // reads, or after them, answers a different fingerprint at the record
        // below.
        const compared = await syncedRowsFingerprint(db, activeProject.id);
        const frameworkVersion = await readSiteTelarVersion(db, activeProject.id);
        // Three-way base: the repo state D1 was last reconciled with, so the diff
        // suppresses the user's own unpublished edits and surfaces genuine
        // repo↔editor conflicts. The author started this check, and the dialog
        // shows what the reads found wrong in the sheets. The first check on the
        // project gives rows an earlier import stored under a stripped id
        // GitHub's spelling, with nothing offered.
        const diff = await checkRepairingLegacyIds(env, activeProject.id, user.id, (legacyRef) => computeFullSyncDiff(
          activeProject.id, token, owner, repo, db, activeProject.head_sha ?? null,
          { collectWarnings: true, frameworkVersion, legacyRef },
        ), (checked) => checked.objects, {
          db, open: activeProject.legacy_ids_repaired_at == null, ref: legacyRecordRef(activeProject),
        });

        // Nothing for the dialog to offer, by the dialog's own predicate:
        // record the commit this check read as synced, and no other. A commit
        // that landed after it is not read, so it is not recorded. Compare-and-
        // set against the head loaded above (null for a first sync), so a
        // writer that moved the head meanwhile keeps it; and only under the
        // objects lease, while everything in D1 this check compared is as it
        // was before the check read it (`recordIfLeaseFree`, `compared`).
        // A story listed as unreadable for its colliding columns goes to the picker.
        const collided = await (await import("~/lib/sheet-choices.server")).collidedStoryChoices("compute-full-sync-diff", diff.stories.content, { env, user, project: activeProject });
        if (collided) return collided;
        const checkedHead = diff.headSha;
        if (!hasDiffChanges(diff) && diff.objects.respelled === undefined && checkedHead) {
          await recordIfLeaseFree(env, activeProject.id, user.id, "objects", async () =>
            (await syncedRowsFingerprint(db, activeProject.id)) === compared
            && bumpProjectHeadFrom(db, activeProject.id, activeProject.head_sha ?? null, checkedHead));
        }

        return { ok: true, intent: "compute-full-sync-diff", diff };
      } catch (err) {
        return await (await import("~/lib/sheet-choices.server")).refusalOrChoices("compute-full-sync-diff", err, "sync_failed", { env, user, project: activeProject });
      }
    }

    case "apply-full-sync": {
      const resolved = page;
      if (!resolved) {
        return { ok: false, intent: "apply-full-sync", error: "no_project" };
      }
      const activeProject = resolved.project;

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
          // Attribution for the objects this sync inserts. requireOwner above
          // gated the case, so this is the server-resolved owner — never a
          // client-supplied id.
          user.id,
          env,
        );

        // Activity feed: one site-level row per sync, labelled with the site
        // title (project_config.title — not on the projects row). requireOwner
        // already gated this case; actor is the server-resolved user.id. Fails
        // open — never breaks the sync it rides alongside.
        const [cfgTitle] = await db
          .select({ title: project_config.title })
          .from(project_config)
          .where(eq(project_config.project_id, activeProject.id))
          .limit(1);
        await recordActivity(db, {
          projectId: activeProject.id,
          actorUserId: user.id,
          verb: "synced",
          entityType: "site",
          entityLabel: cfgTitle?.title ?? null,
        });

        return {
          ok: true,
          intent: "apply-full-sync",
          newHeadSha: result.newHeadSha,
          storyFilesInconclusive: result.storyFilesInconclusive,
          pageFilesInconclusive: result.pageFilesInconclusive,
        };
      } catch (err) {
        const refused = contentRefusal(err);
        if (refused) return refused;
        // The check was computed against a base no longer recorded, or for
        // another project: nothing was written, and the dialog checks again.
        if (err instanceof SyncBaseStale) {
          return { ok: false as const, intent: "apply-full-sync" as const, error: "sync_base_stale" };
        }
        return syncFailure("apply-full-sync", err, "apply_failed");
      }
    }

    case "accept-divergence": {
      // Keep my version: record, without re-importing, the commit whose
      // differences the author was shown and chose to keep their version over.
      // The page posts the identity of the diff it showed: its project, the
      // base it was computed against ("" for none) and its HEAD. Never a head
      // read here, and never the head loaded with this request: the choice is
      // bound to the diff reviewed. It records compare-and-set from that base
      // to that HEAD, so a head recorded since the check is kept; and only on
      // the project the diff is of, since the session may have switched in
      // another tab. A missing or malformed field, another project, or a moved
      // head records nothing and answers accept_divergence_stale, and the page
      // checks again.
      // GitHub's object order is applied first (`keepCompositorVersion`).
      const resolved = page;
      if (!resolved) {
        return { ok: false, intent: "accept-divergence", error: "no_project" };
      }
      const activeProject = resolved.project;
      await requireOwner(db, activeProject.id, user.id);
      const stale = { ok: false, intent: "accept-divergence", error: "accept_divergence_stale" } as const;
      const isSha = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
      const shown = formData.get("headSha");
      const postedBase = formData.get("baseSha");
      if (!isSha(shown)) return stale;
      if (formData.get("projectId") !== String(activeProject.id)) return stale;
      if (postedBase !== "" && !isSha(postedBase)) return stale;
      const base = postedBase === "" ? null : postedBase;
      return keepCompositorVersion(db, env, user, activeProject, base, shown);
    }

    case "choose-columns": {
      // The picker's module is loaded when used: its repair reads import.server.ts's tables as it loads.
      if (!page) return { ok: false, intent: "choose-columns", error: "no_project" };
      await requireOwner(db, page.project.id, user.id);
      return (await import("~/lib/sheet-choices.server")).chooseColumns({ env, user, project: page.project }, formData);
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
      const resolved = page;
      if (!resolved) {
        return { ok: false, intent: "restore-orphan-drafts", error: "no_project" };
      }
      const activeProject = resolved.project;
      await requireOwner(db, activeProject.id, user.id);

      // What the story parses find wrong in the files read, named by each
      // file, for the Start page to show the author, a failure's answer
      // included: a file read before the one that failed still said it.
      const warnings: SheetWarning[] = [];
      try {
        const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
        const [owner, repo] = activeProject.github_repo_full_name.split("/");

        // Every read of the restore is at one head and strict: a file that is
        // absent is absent, and any other failure refuses the restore
        // (`SheetUnreadableError`), since read as absent it would restore a
        // story the author ignored, or a story with a layer's text missing.
        const head = await getRepoHead(token, owner, repo, "main");
        // A file whose bytes are not valid UTF-8 is read as the text a
        // non-fatal decode gives, and named in `warnings`.
        const readRestoreFile = async (path: string, onRaw?: (raw: string) => void): Promise<string | null> => {
          const read = await getFileAtRef(token, owner, repo, path, head, { strict: true });
          if (read.status === "error") throw new SheetUnreadableError(path);
          if (read.status === "absent") return null;
          if (read.lossy) pushUnreadable(warnings, path);
          onRaw?.(read.content);
          return read.content.replace(/^\uFEFF/, "");
        };
        // A layer file several orphans name is read once for the restore.
        const readLayer = readOncePerName((filename: string) => readRestoreFile(`telar-content/texts/stories/${filename}`));

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
          head,
        );

        if (orphanIds.length === 0) {
          return { ok: true, intent: "restore-orphan-drafts", restored: 0, warnings };
        }

        // Fetch + parse each orphan CSV, build the DO payload. Skip
        // files that vanished between the scan and the fetch (rare
        // race; the next dashboard load would simply pick them up again).
        const fileReads: OwedStoryFile[] = [];
        const doStories: Array<{
          storyId: string;
          steps: Array<Record<string, unknown>>;
          layers: Array<Record<string, unknown>>;
        }> = [];
        for (const storyId of orphanIds) {
          let csvRaw: string | null = null;
          const csvText = await readRestoreFile(storySheetPath(storyId), (raw) => { csvRaw = raw; });
          if (!csvText) continue;
          fileReads.push(...(await storyFileRead(storySheetPath(storyId), csvRaw)));

          // A story's steps CSV, parsed under the same scope import uses, so a
          // restored draft matches what an import of the same file would hold.
          // Like a sync, it refuses a sheet in which two or more colliding
          // columns each hold values, before anything reaches the document.
          const onWarning = issuesFor(`${storyId}.csv`, warnings);
          const parsedRows = parseTelarCsv(csvText, onWarning, false, STORY_CANONICAL_SCOPE, {
            severalHoldValues: "refuse",
            sheetName: `${storyId}.csv`,
          });
          // A published layerN_content cell holds the FILENAME of a
          // telar-content/texts/stories/*.md file, not inline prose. Resolve
          // those references to the file bodies before mapping so a restored
          // draft keeps its real layer content instead of literal filenames;
          // inline cells pass through untouched and a missing file degrades to
          // the literal cell.
          const resolvedRows = await resolveLayerFileReferences(parsedRows, readLayer);
          // mapStoryCsv expects a numeric storyDbId for the step.story_id
          // foreign key; for the DO payload we throw it away (the DO
          // re-derives _id via snapshotToD1's INSERT path). Negative
          // placeholder on layer.step_id is converted to a positive
          // step_index here so the DO can thread layers without
          // re-implementing the placeholder convention.
          const { steps: stepRows, layers: layerRows } = mapStoryCsv(resolvedRows, 0, onWarning);
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
            alt_text: s.alt_text ?? "",
            clip_start: s.clip_start ?? "",
            clip_end: s.clip_end ?? "",
            loop: s.loop ?? "",
            extra_columns: extrasOnWire(s.extra_columns),
          }));
          // The DO threads layers by position into the `doSteps` array built
          // just above, so `stepIndex` is the right parent key here rather than
          // `stepNumber`, which is what D1 pairs on.
          const doLayers = layerRows.map((l) => ({
            step_index: l.stepIndex,
            layer_number: l.layer_number,
            title: (l.title ?? "") as string,
            button_label: (l.button_label ?? "") as string,
            content: (l.content ?? "") as string,
          }));
          doStories.push({ storyId, steps: doSteps, layers: doLayers });
        }

        // Google Sheets as the build reads it: from _config.yml at this head.
        await markSheetsEffects(warnings, headConfigSheets(token, owner, repo, head), undefined, headHasGlossaryCsv(token, owner, repo, head));
        if (doStories.length === 0) {
          return { ok: true, intent: "restore-orphan-drafts", restored: 0, warnings };
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
            warnings,
          };
        }
        const restoreJson = (await restoreRes.json()) as { restored: number };
        await recordStorySheetReads(db, activeProject.id, doStories.map((s) => s.storyId));
        await recordStoryFileReads(db, activeProject.id, fileReads);
        return {
          ok: true,
          intent: "restore-orphan-drafts",
          restored: restoreJson.restored ?? 0,
          warnings,
        };
      } catch (err) {
        return { ...(await (await import("~/lib/sheet-choices.server")).refusalOrChoices("restore-orphan-drafts", err, "restore_failed", { env, user, project: activeProject })), warnings };
      }
    }

    case "ignore-orphans": {
      // Append the authoritative
      // orphan set to .compositor-ignored on GitHub. Same server-side
      // recomputation as restore-orphan-drafts — form payload carries
      // no IDs.
      const resolved = page;
      if (!resolved) {
        return { ok: false, intent: "ignore-orphans", error: "no_project" };
      }
      const activeProject = resolved.project;
      await requireOwner(db, activeProject.id, user.id);

      try {
        const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
        const [owner, repo] = activeProject.github_repo_full_name.split("/");
        // The scan and the list are read at one head, the list strictly: read
        // as empty, a failed read would commit a list holding only the new ids
        // and drop the author's entries.
        const head = await getRepoHead(token, owner, repo, "main");

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
          head,
        );

        if (orphanIds.length === 0) {
          return { ok: true, intent: "ignore-orphans", ignored: 0 };
        }

        // Read existing .compositor-ignored (404 → null → empty list)
        // and dedupe-append the new IDs. Reuse parseCompositorIgnored
        // so the read-modify-write cycle preserves comments and
        // existing ordering rules. The file's own bytes are kept,
        // a leading byte-order mark included.
        const existingRaw = await ignoreListBytesAt(token, owner, repo, head);
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
            "# Stories the Compositor will not bring back when it imports this site.\n" +
            "# One story ID per line. Safe to edit by hand; lines starting with # are notes.\n" +
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
          // Against the head the list was read at: a list another writer
          // committed since is refused (StaleHeadError), never overwritten.
          head,
        );

        return { ok: true, intent: "ignore-orphans", ignored: newIds.length };
      } catch (err) {
        return syncFailure("ignore-orphans", err, "ignore_failed");
      }
    }

    default:
      throw new Response("Bad request", { status: 400 });
  }
}

/**
 * `.compositor-ignored` at `head`, read strictly and kept byte for byte for
 * the rewrite; null where it is absent. A failed read throws
 * `SheetUnreadableError`.
 */
async function ignoreListBytesAt(token: string, owner: string, repo: string, head: string): Promise<string | null> {
  const read = await getFileAtRef(token, owner, repo, ".compositor-ignored", head, { strict: true });
  if (read.status === "error") throw new SheetUnreadableError(".compositor-ignored");
  return read.status === "ok" ? read.content : null;
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
