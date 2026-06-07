/**
 * This file controls the Account page — where a signed-in user manages
 * themselves rather than a project.
 *
 * The layout walks from identity down to consequences. Profile shows
 * your name, avatar, and the month you joined. Preferences is the
 * language the editor speaks back at you and the colour your presence
 * cursor shows in collaborative editing. Connected sites lists every
 * project you belong to with quick links and per-row delete-or-leave.
 * GitHub access is the GitHub App installations you've granted, with
 * deep links to manage them. The Danger zone is account deletion.
 *
 * Auth is enforced one layer up by the app shell — if you reach this
 * loader, you're signed in. The loader formats your "User since
 * {month}" text on the server so the page paints with the correct
 * localised month, no client-side flash.
 *
 * The action handles the destructive end of every section — changing
 * your presence colour, deleting a project (convenor-only, with a live
 * collaborator-count warning), leaving a project (collaborator-only),
 * and deleting your whole account. Each action that touches a project
 * notifies the project's Durable Object so anyone editing in real time
 * gets dropped cleanly rather than finding out by silent failure.
 *
 * @version v1.3.0-beta
 */

import { useEffect, useState } from "react";
import { Form, redirect, useFetcher } from "react-router";
import { Trans, useTranslation } from "react-i18next";
import { and, eq, or, sql } from "drizzle-orm";
import type { Route } from "./+types/_app.account";
import { userContext } from "~/middleware/auth.server";
import { getLocale } from "~/i18n/i18next.server";
import { getDb } from "~/lib/db.server";
import { decrypt } from "~/lib/crypto.server";
import { createSessionStorage } from "~/lib/session.server";
import {
  PRESENCE_PALETTE,
  setUserPresenceColor,
  getUserProjectsWithStats,
  requireOwner,
  requireProjectMember,
} from "~/lib/membership.server";
import { deleteProjectCascade } from "~/lib/import.server";
import {
  listUserInstallations,
  type Installation,
} from "~/lib/github.server";
import {
  project_members,
  project_invites,
  projects,
  users,
  activity_log,
} from "~/db/schema";
import {
  ConnectedSitesCard,
  type ConnectedSitesProject,
} from "~/components/features/account/ConnectedSitesCard";
import { GitHubAccessCard } from "~/components/features/account/GitHubAccessCard";
import { DangerZoneCard } from "~/components/features/account/DangerZoneCard";
import { DeleteConfirmationModal } from "~/components/ui/DeleteConfirmationModal";
import { useToast } from "~/hooks/use-toast";
import { makeInternalMarkerHeaders } from "~/lib/internal-marker.server";

export const handle = { i18n: ["common", "account"] };

/** Map PRESENCE_PALETTE indices to the i18n key suffixes for colour names. */
const PRESENCE_COLOR_NAMES = [
  "coral",
  "blue",
  "green",
  "amber",
  "purple",
  "pink",
] as const;

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);

  const uiLocale = await getLocale(request);

  const memberSince = user.created_at
    ? new Intl.DateTimeFormat(uiLocale, { year: "numeric", month: "long" })
        .format(new Date(user.created_at))
    : null;

  // Resolve the user's current presence colour from any of their
  // project_members rows. setUserPresenceColor writes through to all rows
  // so the value is consistent — `limit(1)` is sufficient.
  const presenceRows = await db
    .select({ presence_color: project_members.presence_color })
    .from(project_members)
    .where(eq(project_members.user_id, user.id))
    .limit(1);
  const currentPresenceColor = presenceRows[0]?.presence_color ?? null;

  // Connected sites — read-only summary list for the account page.
  //
  // The schema's `projects` table has no `title` column — site titles
  // live in `project_config.title` and require a per-project join. For
  // this read-only surface we render `github_repo_full_name` as the
  // row label; that string is always present and recognisable to
  // convenors. A later iteration can upgrade to `project_config.title`
  // with a fallback to the repo name.
  const projectRows = await getUserProjectsWithStats(db, user.id);
  const projects: ConnectedSitesProject[] = projectRows.map((p) => ({
    id: p.id,
    title: p.github_repo_full_name,
    userRole: p.userRole,
    last_edited_at: p.last_edited_at,
    collaborator_count: p.collaborator_count,
  }));

  // Derive the danger-zone gate inputs in-memory from the existing
  // projectRows. No new DB call — convenor membership, collaborator
  // count, and the per-project collaborator_count are all already
  // attached by getUserProjectsWithStats.
  //
  // The gate exists to prevent collaborators from being orphaned by an
  // account deletion, so it only triggers for convener projects that
  // ACTUALLY have collaborators. Solo convener projects (no
  // collaborators) have no orphaning hazard and auto-cascade during
  // delete-account.
  //
  // `convenedProjects`: gating list — convener AND has at least one
  // collaborator. Narrow to {id, title} so the loader payload stays small.
  // `soloConvenedCount`: count of convener-with-zero-collaborators projects;
  // drives the conditional category-warning bullet in the delete modal.
  const convenedProjects = projectRows
    .filter((p) => p.userRole === "convenor" && p.collaborator_count > 0)
    .map((p) => ({ id: p.id, title: p.github_repo_full_name }));
  const soloConvenedCount = projectRows.filter(
    (p) => p.userRole === "convenor" && p.collaborator_count === 0,
  ).length;
  const collaboratorCount = projectRows.filter(
    (p) => p.userRole === "collaborator",
  ).length;

  // GitHub access — read-only summary. GitHub API failure is a soft
  // error: render empty installations array so the reinstall CTA in
  // the empty state stays reachable (graceful degradation).
  let installations: Installation[] = [];
  try {
    const token = await decrypt(
      user.encrypted_access_token,
      env.ENCRYPTION_KEY,
    );
    const result = await listUserInstallations(token);
    // /user/installations returns every installation the token can reach,
    // including personal-account installations owned by OTHER users when
    // they've shared a repo with the current user. The GitHub access card
    // is meant to show what THIS user can manage, so drop other users'
    // personal installations. Organization installations stay (they're
    // shared by nature; we can't tell admin-vs-member without extra
    // /user/memberships/orgs/{org} calls, and a non-admin "Manage" link
    // still points to a useful GitHub UI).
    installations = result.installations.filter(
      (inst) =>
        inst.target_type === "Organization" ||
        inst.account.login === user.github_login,
    );
  } catch {
    // Swallow — never log token. Empty list keeps the page functional.
  }

  // installAppUrl: reuse the env-derived pattern already in use by
  // the onboarding flow (StepConnect.tsx:279 / 448 + onboarding.tsx
  // loader). Never hardcode.
  const installAppUrl = `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`;

  return {
    user: {
      github_id: user.github_id,
      github_login: user.github_login,
      github_name: user.github_name,
      github_email: user.github_email,
    },
    memberSince,
    currentLocale: uiLocale === "es" ? "es" : "en",
    currentPresenceColor,
    palette: PRESENCE_PALETTE,
    projects,
    convenedProjects,
    soloConvenedCount,
    collaboratorCount,
    installations,
    installAppUrl,
    uiLocale,
    // Server-determined "now" for ConnectedSitesCard's relative-time
    // formatter. Without this, SSR and client hydration call
    // Date.now() at different moments and trip React's hydration
    // mismatch guard for just-edited projects.
    nowMs: Date.now(),
  };
}

/**
 * /account action.
 *
 * Three intents:
 *   - `delete-project`       — convenor-only; D1 cascade then DO
 *                              /notify-deleted broadcast.
 *   - `leave-project`        — any member; deletes own project_members
 *                              row + single-socket DO RPC for the
 *                              leaver's other open tabs.
 *   - `get-active-ws-count`  — convenor-only pre-flight; live socket
 *                              count for the modal warning paragraph.
 *
 * Order constraint: D1 mutation runs BEFORE DO RPC so any collaborator
 * that reconnects mid-flight fails the membership check cleanly. DO
 * RPC failures are swallowed — best-effort by design (the
 * collaborator's next message lazy-fails with project-not-found).
 *
 * Input validation: `projectId` is `Number()`-cast and
 * `Number.isFinite`-checked before any DB / DO call.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // update-presence-color does NOT carry a projectId — the
  // colour write affects every project_members row by user_id. Handle it
  // before the projectId validation below.
  if (intent === "update-presence-color") {
    const color = String(formData.get("color") ?? "");
    // XSS defence: allow-list against PRESENCE_PALETTE BEFORE
    // any D1 touch.
    if (!PRESENCE_PALETTE.includes(color)) {
      return {
        ok: false as const,
        intent: "update-presence-color" as const,
        error: "invalid_color" as const,
      };
    }
    await setUserPresenceColor(db, user.id, color);
    return {
      ok: true as const,
      intent: "update-presence-color" as const,
      color,
    };
  }

  // delete-account does not carry a projectId — handle it before the
  // projectId validation below.
  if (intent === "delete-account") {
    // Race-guard: re-check that the user does NOT
    // convene any project that still has other collaborators. The gate's
    // purpose is to prevent orphaning collaborators; solo convener
    // projects (zero other collaborators) have no orphaning hazard and
    // are auto-cascaded below. We filter `projects WHERE user_id = me`
    // to rows where a non-self project_members row exists.
    //
    // Microsecond window between this SELECT and the cascade is
    // acceptable per the threat model. On the error path, no project
    // ids/titles cross the action boundary.
    const collabConvened = await db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.user_id, user.id),
          sql`EXISTS (SELECT 1 FROM ${project_members} WHERE ${project_members.project_id} = ${projects.id} AND ${project_members.user_id} != ${user.id})`,
        ),
      );
    if (collabConvened.length > 0) {
      return {
        ok: false as const,
        intent: "delete-account" as const,
        error: "convened_projects_exist" as const,
      };
    }

    // Solo-cascade: any remaining `projects WHERE user_id = me`
    // rows are guaranteed by the race-guard above to be solo (no
    // collaborators). Cascade each via the shared deleteProjectCascade
    // helper BEFORE the user-row batch — if any cascade rejects, the
    // exception propagates and the user batch never runs (no partial
    // wipe of the user account if a project cascade fails).
    const soloProjects = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.user_id, user.id));
    for (const p of soloProjects) {
      await deleteProjectCascade(db, p.id);
    }

    // Atomic D1 batch — FK-dependent rows first.
    // project_invites.created_by is NOT NULL → users.id, so leaving these
    // rows would FK-violate when the users row is deleted. project_members
    // references users.id too. activity_log.actor_user_id → users.id must
    // also be cleared; these rows can reference other people's projects so
    // they are not covered by deleteProjectCascade above.
    // Order: invites → members → activity_log (actor) → users.
    // db.batch is transactional in D1 — any op failure rolls back the
    // whole batch (atomic-mutation pattern).
    await db.batch([
      db
        .delete(project_invites)
        .where(
          or(
            eq(project_invites.created_by, user.id),
            eq(project_invites.used_by, user.id),
          ),
        ),
      db.delete(project_members).where(eq(project_members.user_id, user.id)),
      db.delete(activity_log).where(eq(activity_log.actor_user_id, user.id)),
      db.delete(users).where(eq(users.id, user.id)),
    ]);

    // Destroy session + redirect to /signin with reason banner.
    // Mirrors app/routes/signout.tsx verbatim with the extra ?reason
    // query param consumed by _auth.signin.tsx's existing banner.
    const sessionStorage = createSessionStorage(env.SESSION_SECRET);
    const session = await sessionStorage.getSession(
      request.headers.get("Cookie"),
    );
    return redirect("/signin?reason=account_deleted", {
      headers: {
        "Set-Cookie": await sessionStorage.destroySession(session),
      },
    });
  }

  const projectId = Number(formData.get("projectId"));
  if (!Number.isFinite(projectId) || projectId <= 0) {
    return { ok: false, intent, error: "invalid_project_id" };
  }

  switch (intent) {
    case "delete-project": {
      // Convenor-only — throws 403 if not.
      await requireOwner(db, projectId, user.id);

      // D1 cascade BEFORE DO RPC: if cascade fails, the DO RPC is
      // never sent and the project still exists. If DO RPC fails after a
      // successful cascade, the row is gone from /account already and
      // collaborators fail-out lazily on next WS message — acceptable
      // degradation (acceptable per the design).
      await deleteProjectCascade(db, projectId);

      // Best-effort DO broadcast — wrapped in try/catch so DO outage
      // does not flip the user-visible outcome (delete already
      // succeeded in D1).
      try {
        const headers = await makeInternalMarkerHeaders(
          projectId,
          env.SESSION_SECRET,
          "notify-deleted",
        );
        const stub = env.COLLABORATION.get(
          env.COLLABORATION.idFromName(String(projectId)),
        );
        await stub.fetch(
          new Request("https://internal/notify-deleted", {
            method: "POST",
            headers,
          }),
        );
      } catch {
        // DO offline / network blip — collaborators fail-out lazily on
        // next message. End state is OK; this degradation is explicit by design.
      }

      return { ok: true, intent: "delete-project" as const };
    }

    case "leave-project": {
      // Any member can leave. requireProjectMember throws 403 for
      // non-members.
      await requireProjectMember(db, projectId, user.id);

      // Delete the user's single project_members row. Drizzle returns
      // 0-row deletes silently; callers do not need to verify a row
      // existed (the requireProjectMember check above already proved
      // it).
      await db
        .delete(project_members)
        .where(
          and(
            eq(project_members.project_id, projectId),
            eq(project_members.user_id, user.id),
          ),
        );

      // Single-socket DO RPC — only the leaver's own sockets are
      // notified. Best-effort try/catch — DO outage does not flip the
      // user-visible outcome (leave already succeeded in D1).
      try {
        const headers = await makeInternalMarkerHeaders(
          projectId,
          env.SESSION_SECRET,
          "notify-deleted",
          user.id,
        );
        const stub = env.COLLABORATION.get(
          env.COLLABORATION.idFromName(String(projectId)),
        );
        await stub.fetch(
          new Request(
            `https://internal/notify-deleted?userId=${user.id}`,
            { method: "POST", headers },
          ),
        );
      } catch {
        // Same acceptable degradation as delete-project.
      }

      return { ok: true, intent: "leave-project" as const };
    }

    case "get-active-ws-count": {
      // Pre-flight informational fetch for the convenor's delete modal
      // The count is informational, NOT a gate — convenor can
      // confirm regardless of count or fetch failure.
      await requireOwner(db, projectId, user.id);

      try {
        const headers = await makeInternalMarkerHeaders(
          projectId,
          env.SESSION_SECRET,
          "active-ws-count",
          user.id,
        );
        const stub = env.COLLABORATION.get(
          env.COLLABORATION.idFromName(String(projectId)),
        );
        // Exclude the requesting user's own sockets from the count —
        // the warning is about OTHER collaborators who'll be disconnected,
        // not the convenor themselves.
        const res = await stub.fetch(
          new Request(
            `https://internal/active-ws-count?exceptUserId=${user.id}`,
            { method: "GET", headers },
          ),
        );
        const data = (await res.json()) as { count: number };
        return {
          ok: true,
          intent: "get-active-ws-count" as const,
          count: data.count,
        };
      } catch {
        // Modal omits the warning paragraph when count is null.
        return {
          ok: true,
          intent: "get-active-ws-count" as const,
          count: null,
        };
      }
    }

    default:
      return { ok: false, intent, error: "unknown_intent" };
  }
}

export default function AccountPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("account");
  const {
    user,
    memberSince,
    currentLocale,
    currentPresenceColor,
    palette,
    projects,
    convenedProjects,
    soloConvenedCount,
    collaboratorCount,
    installations,
    installAppUrl,
    uiLocale,
    nowMs,
  } = loaderData;

  // Lift the delete-project modal open-state up to the
  // route so the Connected Sites kebab AND the Danger zone inline links
  // share ONE modal instance (no stacking-context / focus-trap
  // duplication). Plain useState
  // suffices — the lift surface is well under the ~30-line threshold
  // CONTEXT recommends for promotion to a context provider.
  const [deleteProjectId, setDeleteProjectId] = useState<number | null>(null);
  const openDeleteProject = (id: number) => setDeleteProjectId(id);
  const closeDeleteProject = () => setDeleteProjectId(null);
  const projectBeingDeleted =
    deleteProjectId !== null
      ? projects.find((p) => p.id === deleteProjectId) ?? null
      : null;

  // When github_name is null, promote github_login (without @) to the
  // primary slot and omit the secondary muted handle row entirely so the
  // login is not rendered twice.
  const hasName = !!user.github_name;
  const primaryName = hasName ? (user.github_name as string) : user.github_login;

  // Initials fallback covers both multi-word display names ("Test User" → "TU")
  // and single-word logins ("juancobo" → "JU"). Used by the avatar onError
  // reveal pattern mirrored from Header.tsx.
  const initials =
    primaryName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part: string) => part[0]?.toUpperCase() ?? "")
      .join("") || primaryName.slice(0, 2).toUpperCase();

  return (
    <div className="max-w-3xl mx-auto px-6 pt-8 pb-12">
      <h1 className="text-2xl font-heading font-semibold text-charcoal mb-6">
        {t("page_title")}
      </h1>

      <section className="bg-white rounded-lg border border-gray-200 shadow-sm p-6">
        <h2 className="text-xl font-heading font-semibold text-charcoal">
          {t("profile_heading")}
        </h2>

        <div className="mt-4 flex gap-4 items-start">
          {/* Avatar slot — relative wrapper so the initials <span> can sit
              absolutely over the same 80x80 footprint when the GitHub image
              fails to load, avoiding sibling layout shift in the flex row. */}
          <div className="relative w-20 h-20 shrink-0">
            <img
              src={`https://avatars.githubusercontent.com/u/${user.github_id}?s=160`}
              alt={t("field_avatar_alt", { name: primaryName })}
              className="w-20 h-20 rounded-full object-cover bg-anil"
              onError={(e) => {
                const target = e.currentTarget;
                target.style.display = "none";
                const sibling = target.nextElementSibling as HTMLElement | null;
                if (sibling) sibling.style.display = "flex";
              }}
            />
            <span
              className="absolute top-0 left-0 w-20 h-20 rounded-full bg-anil text-charcoal font-heading font-semibold text-xl items-center justify-center hidden"
              aria-hidden="true"
            >
              {initials}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <span className="sr-only">{t("field_name_label")}</span>
            <p className="text-2xl font-heading font-semibold text-charcoal">
              {primaryName}
            </p>

            {hasName && (
              <>
                <span className="sr-only">{t("field_handle_label")}</span>
                <p className="text-sm font-body font-medium text-gray-500">
                  @{user.github_login}
                </p>
              </>
            )}

            {user.github_email && (
              <>
                <span className="sr-only">{t("field_email_label")}</span>
                <p className="text-base font-body text-charcoal mt-3">
                  {user.github_email}
                </p>
              </>
            )}

            {memberSince && (
              <p className="text-base font-body text-charcoal mt-1">
                {t("member_since", { date: memberSince })}
              </p>
            )}
          </div>
        </div>
      </section>

      {/* Preferences section. Inserted immediately after Profile,
          stays above Connected sites. */}
      <section className="bg-white rounded-lg border border-gray-200 shadow-sm p-6 mt-6">
        <h2
          id="preferences-section-heading"
          className="text-xl font-heading font-semibold text-charcoal"
        >
          {t("preferences.section_heading")}
        </h2>

        {/* Language pill — two-state segmented control. Active state ships
            in anil. Labels "EN"/"ES" hardcoded per the design system
            §i18n (mirrors LanguageToggle.tsx:24-26). Submits to /api/locale
            (the /api/locale endpoint). */}
        <div className="mt-4">
          <p
            id="preferences-language-label"
            className="text-sm font-body font-medium text-charcoal mb-2"
          >
            {t("preferences.language_label")}
          </p>
          <div
            role="group"
            aria-labelledby="preferences-language-label"
            className="flex gap-1"
          >
            {(["en", "es"] as const).map((code) => {
              const label = code === "en" ? "EN" : "ES";
              const isActive = currentLocale === code;
              if (isActive) {
                return (
                  <span
                    key={code}
                    aria-current="true"
                    className="px-3.5 py-1.5 rounded-full bg-anil text-charcoal font-body text-sm font-medium"
                  >
                    {label}
                  </span>
                );
              }
              const langName =
                code === "en"
                  ? t("preferences.language_lang_en")
                  : t("preferences.language_lang_es");
              return (
                // Plain <form> (not React Router <Form>) so the locale switch
                // does a full browser navigation. SPA submission re-fetches
                // loaders but never calls i18n.changeLanguage() on the client
                // instance, leaving the UI in the old locale until the next
                // hard reload. See LanguageToggle.tsx for the same pattern.
                <form key={code} method="post" action="/api/locale">
                  <input type="hidden" name="locale" value={code} />
                  <button
                    type="submit"
                    aria-label={t("preferences.language_pill_switch_aria", {
                      lang: langName,
                    })}
                    className="px-3.5 py-1.5 rounded-full border border-charcoal/20 text-charcoal/60 hover:text-charcoal hover:border-charcoal/40 font-body text-sm font-medium transition-all duration-200 cursor-pointer"
                  >
                    {label}
                  </button>
                </form>
              );
            })}
          </div>
        </div>

        {/* Presence-colour swatch row — six 32x32 circles, current colour
            ringed in terracotta. Each swatch is a submit button so native
            keyboard semantics (Enter/Space) trigger the form. Action
            allow-lists against PRESENCE_PALETTE before any D1 touch
            (XSS defence). */}
        <div className="mt-6">
          <p
            id="preferences-presence-label"
            className="text-sm font-body font-medium text-charcoal mb-2"
          >
            {t("preferences.presence_color_label")}
          </p>
          <Form method="post">
            <input type="hidden" name="intent" value="update-presence-color" />
            <div
              role="radiogroup"
              aria-labelledby="preferences-presence-label"
              className="flex flex-wrap gap-2"
            >
              {palette.map((color, i) => {
                const isCurrent = color === currentPresenceColor;
                const colorName = PRESENCE_COLOR_NAMES[i];
                const colorDisplay = t(
                  `preferences.presence_color_${colorName}`,
                );
                return (
                  <button
                    key={color}
                    type="submit"
                    name="color"
                    value={color}
                    role="radio"
                    aria-checked={isCurrent}
                    aria-label={t("preferences.presence_color_swatch_aria", {
                      color: colorDisplay,
                    })}
                    // Deliberate exception: this circular swatch keeps its own
                    // focus-visible ring rather than the global anil-deep outline, to match the
                    // terracotta selected-state ring it already uses on the same round element.
                    className={`w-8 h-8 rounded-full transition-transform duration-150 hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-charcoal/50 cursor-pointer ${
                      isCurrent
                        ? "ring-2 ring-offset-2 ring-terracotta"
                        : ""
                    }`}
                    style={{ backgroundColor: color }}
                  />
                );
              })}
            </div>
          </Form>
          <p className="mt-2 text-sm text-charcoal/60 font-body">
            {t("preferences.presence_color_help")}
          </p>
        </div>
      </section>

      <ConnectedSitesCard
        projects={projects}
        uiLocale={uiLocale}
        nowMs={nowMs}
        onOpenDeleteProject={openDeleteProject}
      />

      <GitHubAccessCard
        installations={installations}
        installAppUrl={installAppUrl}
      />

      <DangerZoneCard
        user={{ github_login: user.github_login }}
        convenedProjects={convenedProjects}
        soloConvenedCount={soloConvenedCount}
        collaboratorCount={collaboratorCount}
        onOpenDeleteProject={openDeleteProject}
      />

      {/* Single shared delete-project modal instance
          driven by the lifted state above. Both the Connected Sites
          kebab and the Danger zone inline-link trigger feed this one
          mount; React Router auto-revalidates on success so the Danger
          zone re-renders with one fewer convened project, and the
          delete-account button auto-enables when the list empties. */}
      {projectBeingDeleted && (
        <SharedDeleteProjectModal
          project={projectBeingDeleted}
          onClose={closeDeleteProject}
        />
      )}
    </div>
  );
}

/**
 * Shared delete-project modal — single instance owned by the
 * route, mounted only while a project id is selected. Mirrors the props
 * the row-local modal in ConnectedSitesCard sets, so the user-facing
 * copy and behaviour are unchanged from the kebab flow.
 *
 * Lives in this file (not extracted to a sibling) because it's tightly
 * coupled to the route-level lifted state and has no second consumer.
 * Promote to its own module if a third trigger appears.
 */
function SharedDeleteProjectModal({
  project,
  onClose,
}: {
  project: ConnectedSitesProject;
  onClose: () => void;
}) {
  const { t } = useTranslation("account");
  const { showToast } = useToast();

  const deleteFetcher = useFetcher<{ ok: boolean; intent: string }>();
  const wsCountFetcher = useFetcher<{
    ok: boolean;
    intent: string;
    count: number | null;
  }>();
  const wsCount = wsCountFetcher.data?.count ?? null;

  // Pre-flight live-WS count on mount (the modal is mounted only when
  // open, so a single submit per open-cycle is correct).
  useEffect(() => {
    wsCountFetcher.submit(
      { intent: "get-active-ws-count", projectId: String(project.id) },
      { method: "POST" },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  // Toast + close on response. Loader revalidation auto-removes the
  // project from `convenedProjects`, which re-enables the Danger zone
  // button when the last one goes — no imperative refetch needed.
  useEffect(() => {
    if (deleteFetcher.state === "idle" && deleteFetcher.data) {
      if (deleteFetcher.data.ok) {
        onClose();
        showToast({
          message: t("delete_project_toast_success"),
          type: "info",
        });
      } else {
        showToast({
          message: t("delete_project_toast_failure"),
          type: "destructive",
        });
      }
    }
  }, [deleteFetcher.state, deleteFetcher.data, showToast, t, onClose]);

  const activeWarning =
    wsCount === null || wsCount <= 0
      ? undefined
      : wsCount === 1
        ? t("delete_project_active_warning_one", { count: wsCount })
        : t("delete_project_active_warning_other", { count: wsCount });

  const [owner, repo] = (project.title || "/").split("/");

  return (
    <DeleteConfirmationModal
      open={true}
      onClose={onClose}
      entityType="project"
      entityLabel={project.title}
      confirmText={project.title}
      destructiveColor="terracotta"
      titleOverride={t("delete_project_title", { title: project.title })}
      bodyText={t("delete_project_body", { owner, repo })}
      typeInstructionOverride={
        <Trans
          ns="account"
          i18nKey="delete_project_type_instruction"
          values={{ title: project.title }}
          components={[<strong key="t" className="font-semibold" />]}
        />
      }
      contentSummary={activeWarning}
      confirmLabel={t("delete_project_confirm_button")}
      onConfirm={() => {
        deleteFetcher.submit(
          { intent: "delete-project", projectId: String(project.id) },
          { method: "POST" },
        );
      }}
    />
  );
}
