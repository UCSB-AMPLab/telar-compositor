/**
 * Invite accept page — the lifecycle of a legacy single-use invite link.
 *
 * The token is read through `resolveCode` with `expectedKind:
 * "legacy_invite"`, which is what keeps this route honest now that
 * `project_invites` also holds reusable course join codes: a class code
 * pasted into an invite URL resolves to `wrong_kind` rather than admitting
 * its holder to a project.
 *
 * loader states:
 *   not_found       — token does not exist in the database
 *   expired         — past its expiry; rendered identically to not_found,
 *                     so a probe cannot tell a real token from a guess
 *   used            — already redeemed
 *   revoked         — cancelled by the convenor
 *   wrong_kind      — a course join code opened as an invitation link
 *   not_signed_in   — valid token but user is not authenticated
 *   already_member  — valid token but user is already a project member
 *   ready           — valid token, user is signed in and not yet a member
 *
 * action: membership is checked before the redemption is recorded — a
 * single-use invite must not be spent on someone who already holds a seat.
 * The consumed flag is `used_at`, never `used_by`: the latter is
 * `ON DELETE SET NULL`, so an invite keyed on it would reopen when its
 * redeemer deletes their account.
 *
 * No `userId` is passed to `resolveCode` here. The per-user redemption
 * limiter defends ten-character codes against guessing; a 122-bit UUID
 * needs no such defence, and consulting the limiter would let a mistyped
 * class code elsewhere lock a legitimate invitation link.
 *
 * Component: centred card on cream background (provided by _auth layout).
 *
 * @version v1.5.0-beta
 */

import { liveAccount } from "~/lib/account-tombstone.server";
import { INVITE_REFUSAL_KEYS } from "~/lib/invite-refusal";
import { forgetSite, rememberSite } from "~/lib/tab-site";
import { useEffect, useRef } from "react";
import { redirect, Form, useActionData, useLoaderData } from "react-router";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { Route } from "./+types/_auth.invite.$token";
import { createSessionStorage } from "~/lib/session.server";
import { getDb } from "~/lib/db.server";
import { resolveCode } from "~/lib/join-codes.server";
import {
  project_invites,
  project_members,
  projects,
  users,
} from "~/db/schema";
import { eq, and, isNull, gt, or } from "drizzle-orm";

export const handle = { i18n: ["common", "team"] };

type RefusalState = keyof typeof INVITE_REFUSAL_KEYS;

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);
  const token = params.token;

  const resolved = await resolveCode(db, token, { expectedKind: "legacy_invite" });

  switch (resolved.state) {
    case "not_found":
    // `rate_limited` cannot arise: no userId is passed (see the module note
    // above). Collapsed with not_found rather than left to fall through.
    case "rate_limited":
      return { state: "not_found" as const };
    case "expired":
      return { state: "expired" as const };
    case "revoked":
      return { state: "revoked" as const };
    case "consumed":
      return { state: "used" as const };
    case "wrong_kind":
      return { state: "wrong_kind" as const };
    case "ok":
      break;
  }

  const invite = resolved.invite;

  // Fetch the project and owner for display
  const projectRows = await db
    .select({
      id: projects.id,
      github_repo_full_name: projects.github_repo_full_name,
      user_id: projects.user_id,
    })
    .from(projects)
    .where(eq(projects.id, invite.project_id))
    .limit(1);

  if (projectRows.length === 0) {
    return { state: "not_found" as const };
  }

  const project = projectRows[0];

  // Derive project name from repo path (last segment)
  const repoSegments = project.github_repo_full_name.split("/");
  const projectName = repoSegments[repoSegments.length - 1] ?? project.github_repo_full_name;

  // Fetch owner login
  const ownerRows = await db
    .select({ github_login: users.github_login })
    .from(users)
    .where(eq(users.id, project.user_id))
    .limit(1);

  const ownerLogin = ownerRows[0]?.github_login ?? "";

  // Check whether the current user is signed in
  const sessionStorage = createSessionStorage(env.SESSION_SECRET);
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));
  const userId = session.get("userId") as number | undefined;

  if (!userId) {
    return {
      state: "not_signed_in" as const,
      projectName,
      ownerLogin,
      token,
    };
  }

  // Check whether the user is already a member of this project
  const memberRows = await db
    .select({ id: project_members.id })
    .from(project_members)
    .where(
      and(
        eq(project_members.project_id, invite.project_id),
        eq(project_members.user_id, userId),
      ),
    )
    .limit(1);

  if (memberRows.length > 0) {
    return {
      state: "already_member" as const,
      projectName,
      ownerLogin,
    };
  }

  return {
    state: "ready" as const,
    projectName,
    ownerLogin,
    token,
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ request, params, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);
  const token = params.token;

  const sessionStorage = createSessionStorage(env.SESSION_SECRET);
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));
  const userId = session.get("userId") as number | undefined;

  if (!userId) {
    const returnTo = `/invite/${token}`;
    throw redirect(`/signin?returnTo=${encodeURIComponent(returnTo)}`);
  }

  // This route sits outside the authenticated layout, so the session's user is
  // read here: a cookie left open after its account was deleted names a
  // tombstone, which signs in again rather than joining anything. Migration
  // 0057 refuses the membership regardless.
  const live = await db.select({ id: users.id }).from(users).where(liveAccount(userId));
  if (live.length === 0) {
    throw redirect(`/signin?returnTo=${encodeURIComponent(`/invite/${token}`)}`, {
      headers: { "Set-Cookie": await sessionStorage.destroySession(session) },
    });
  }

  const resolved = await resolveCode(db, token, { expectedKind: "legacy_invite" });
  if (resolved.state !== "ok") {
    return { error: resolved.state };
  }

  const invite = resolved.invite;
  const projectId = invite.project_id;

  // Check before recording: a seat spent on someone who already holds
  // membership is a seat lost for nothing.
  const memberRows = await db
    .select({ id: project_members.id })
    .from(project_members)
    .where(
      and(
        eq(project_members.project_id, projectId),
        eq(project_members.user_id, userId),
      ),
    )
    .limit(1);

  if (memberRows.length > 0) {
    return { error: "already_member" as const };
  }

  // Atomic consumption on `used_at` — only the first request wins, and the
  // flag survives the redeemer's account deletion.
  const result = await db
    .update(project_invites)
    .set({
      used_by: userId,
      used_at: new Date().toISOString(),
    })
    .where(
      and(
        eq(project_invites.token, token),
        isNull(project_invites.used_at),
        // `expires_at` is nullable now — null means never expires — and a
        // bare `>` on NULL is NULL, which would read as expired.
        or(
          isNull(project_invites.expires_at),
          gt(project_invites.expires_at, new Date().toISOString()),
        ),
      ),
    );

  if (result.meta.changes === 0) {
    // Another request consumed this token between the resolve and here.
    return { error: "consumed" as const };
  }

  // Insert membership row — onConflictDoNothing guards against any duplicate.
  // `joined_via_invite_id` is the admission record cap accounting reads.
  //
  // The role is fixed at collaborator rather than read from
  // `conferred_role`. The account page's join-as-staff field is the one
  // surface that admits staff, and an invite link that could confer
  // `instructor` would be a second, unsanctioned way to mint one.
  try {
    await db
      .insert(project_members)
      .values({
        project_id: projectId,
        user_id: userId,
        role: "collaborator",
        joined_at: new Date().toISOString(),
        joined_via_invite_id: invite.id,
      })
      .onConflictDoNothing();
  } catch (error) {
    // Migration 0057 refuses the membership when the account was deleted
    // after the check above. The link was consumed for nobody, so it is
    // released for the person's next account.
    await db
      .update(project_invites)
      .set({ used_by: null, used_at: null })
      .where(and(eq(project_invites.id, invite.id), eq(project_invites.used_by, userId)));
    const stillLive = await db.select({ id: users.id }).from(users).where(liveAccount(userId));
    if (stillLive.length > 0) throw error;
    throw redirect(`/signin?returnTo=${encodeURIComponent(`/invite/${token}`)}`, {
      headers: { "Set-Cookie": await sessionStorage.destroySession(session) },
    });
  }

  // Set the active project in the session so the user lands on the right project
  session.set("activeProjectId", projectId);
  const headers = new Headers();
  headers.append("Set-Cookie", await sessionStorage.commitSession(session));

  throw redirect("/dashboard", { headers });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type LoaderData = Awaited<ReturnType<typeof loader>>;

export default function InviteAcceptPage() {
  const { t } = useTranslation("team");
  const data = useLoaderData<LoaderData>();
  // A refused join leaves the session where it was, and the tab remembers the
  // site it showed. The page stays mounted to read the refusal.
  const refusal = useActionData<typeof action>();
  const forgottenSite = useRef<number | null>(null);
  useEffect(() => {
    if (refusal?.error) rememberSite(forgottenSite.current);
  }, [refusal]);

  return (
    <div className="flex min-h-screen items-start justify-center bg-cream pt-16 px-4">
      <div className="w-full max-w-sm rounded-xl bg-white p-8 shadow-lg">
        {data.state in INVITE_REFUSAL_KEYS ? (
          <>
            <p className="font-heading font-semibold text-charcoal mb-2">
              {t(INVITE_REFUSAL_KEYS[data.state as RefusalState])}
            </p>
          </>
        ) : data.state === "already_member" ? (
          <>
            <p className="font-heading font-semibold text-charcoal mb-2">
              {t("accept_already_member")}
            </p>
            <p className="font-body text-sm text-gray-500 mb-6">
              {t("accept_subheading", {
                project: data.projectName,
                owner: data.ownerLogin,
              })}
            </p>
            <Link
              to="/dashboard"
              className="inline-block bg-anil text-charcoal font-heading font-semibold rounded-full px-6 py-3 hover:opacity-90 transition-opacity"
            >
              {t("accept_go_to_project")}
            </Link>
          </>
        ) : (
          <>
            <h1 className="font-heading font-bold text-2xl text-charcoal mb-2">
              {t("accept_heading")}
            </h1>
            <p className="font-body text-sm text-gray-500 mb-8">
              {t("accept_subheading", {
                project: data.projectName,
                owner: data.ownerLogin,
              })}
            </p>

            {data.state === "not_signed_in" ? (
              <a
                href={`/signin?returnTo=${encodeURIComponent(`/invite/${data.token}`)}`}
                className="inline-block bg-anil text-charcoal font-heading font-semibold rounded-full px-6 py-3 hover:opacity-90 transition-opacity"
              >
                {t("accept_signin")}
              </a>
            ) : (
              // The join makes the invited site the session's; a tab still
              // remembering another would switch the session back in the layout.
              <Form method="post" onSubmit={() => { forgottenSite.current = forgetSite(); }}>
                <button
                  type="submit"
                  className="bg-anil text-charcoal font-heading font-semibold rounded-full px-6 py-3 hover:opacity-90 transition-opacity"
                >
                  {t("accept_join")}
                </button>
              </Form>
            )}
          </>
        )}
      </div>
    </div>
  );
}
