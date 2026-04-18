/**
 * Invite accept page — handles the full lifecycle of an invite link.
 *
 * loader: resolves the token to one of 5 states:
 *   not_found       — token does not exist in the database
 *   expired         — token has expired or has already been used
 *   not_signed_in   — valid token but user is not authenticated
 *   already_member  — valid token but user is already a project member
 *   ready           — valid token, user is signed in and not yet a member
 *
 * action: atomically consumes the token and inserts a project_members row.
 *
 * Component: centred card on cream background (provided by _auth layout).
 */

import { redirect, Form, useLoaderData } from "react-router";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { Route } from "./+types/_auth.invite.$token";
import { createSessionStorage } from "~/lib/session.server";
import { getDb } from "~/lib/db.server";
import {
  project_invites,
  project_members,
  projects,
  users,
} from "~/db/schema";
import { eq, and, isNull, gt } from "drizzle-orm";

export const handle = { i18n: ["common", "team"] };

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);
  const token = params.token;

  // Look up the invite token
  const inviteRows = await db
    .select()
    .from(project_invites)
    .where(eq(project_invites.token, token))
    .limit(1);

  if (inviteRows.length === 0) {
    return { state: "not_found" as const };
  }

  const invite = inviteRows[0];

  // Treat used tokens the same as expired — don't reveal whether it was ever valid
  if (invite.used_by !== null) {
    return { state: "expired" as const };
  }

  if (new Date(invite.expires_at) < new Date()) {
    return { state: "expired" as const };
  }

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

  // Look up the invite to get the project_id
  const inviteRows = await db
    .select({ project_id: project_invites.project_id })
    .from(project_invites)
    .where(eq(project_invites.token, token))
    .limit(1);

  if (inviteRows.length === 0) {
    return { error: "token_not_found" as const };
  }

  const projectId = inviteRows[0].project_id;

  // Atomic token consumption — only the first request wins
  const result = await db
    .update(project_invites)
    .set({
      used_by: userId,
      used_at: new Date().toISOString(),
    })
    .where(
      and(
        eq(project_invites.token, token),
        isNull(project_invites.used_by),
        gt(project_invites.expires_at, new Date().toISOString()),
      ),
    );

  if (result.meta.changes === 0) {
    // Race condition: another request consumed this token first, or it expired
    return { error: "token_expired_or_used" as const };
  }

  // Insert membership row — onConflictDoNothing guards against any duplicate
  await db
    .insert(project_members)
    .values({
      project_id: projectId,
      user_id: userId,
      role: "collaborator",
      joined_at: new Date().toISOString(),
    })
    .onConflictDoNothing();

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

  return (
    <div className="flex min-h-screen items-start justify-center bg-cream pt-16 px-4">
      <div className="w-full max-w-sm rounded-xl bg-white p-8 shadow-lg">
        {data.state === "not_found" || data.state === "expired" ? (
          <>
            <p className="font-heading font-semibold text-charcoal mb-2">
              {t("accept_expired")}
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
              className="inline-block bg-lavender text-charcoal font-heading font-semibold rounded-full px-6 py-3 hover:opacity-90 transition-opacity"
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
                className="inline-block bg-lavender text-charcoal font-heading font-semibold rounded-full px-6 py-3 hover:opacity-90 transition-opacity"
              >
                {t("accept_signin")}
              </a>
            ) : (
              <Form method="post">
                <button
                  type="submit"
                  className="bg-lavender text-charcoal font-heading font-semibold rounded-full px-6 py-3 hover:opacity-90 transition-opacity"
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
