/**
 * This file is the /team route — where each member of the active project
 * stands on the way to its repository. One path and no project id, like
 * /contributions: the project is the session's active one.
 *
 * The loader reads the database alone; GitHub is asked only by the status
 * poll and by the actions, and the page reads again each time that poll
 * completes. Every member can open it. A convenor adds, reissues and
 * withdraws on other rows; a member accepts their own invitation.
 *
 * @version v1.5.0-beta
 */
import { useEffect } from "react";
import { useFetcher, useRevalidator } from "react-router";
import { useTranslation } from "react-i18next";

import type { Route } from "./+types/_app.team";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { getUserRole, requireOwner } from "~/lib/membership.server";
import { resolveActiveProjectFromRequest } from "~/lib/active-project.server";
import { loadTeamRoster } from "~/lib/team-roster.server";
import { acceptOwnTeamInvitation, runConvenorTeamAction } from "~/lib/team-actions.server";
import type { ConvenorIntent } from "~/lib/team-actions.server";
import { teamRowActions } from "~/lib/repo-access";
import type { TeamActionResult, TeamRowAction } from "~/lib/repo-access";
import { TeamInvitedRow, TeamMemberRow } from "~/components/features/team/TeamMemberRow";
import { useSharedGithubStatus } from "~/components/features/site-status/SiteStatusProvider";
import { useRelativeTime } from "~/lib/use-relative-time";

export const handle = { i18n: ["common", "team"] };

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const active = await resolveActiveProjectFromRequest(request, env, user.id);
  if (!active) throw new Response("Not Found", { status: 404 });

  const db = getDb(env.DB);
  const role = await getUserRole(db, active.project.id, user.id);
  if (role === null) throw new Response("Forbidden", { status: 403 });
  const roster = await loadTeamRoster(db, active.project.id);
  return { ...roster, viewer: { userId: user.id, convenor: role === "convenor" } };
}

const CONVENOR_INTENTS: readonly string[] = ["add", "reissue", "revoke"] satisfies ConvenorIntent[];

export async function action({ request, context }: Route.ActionArgs): Promise<TeamActionResult> {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });
  const env = context.cloudflare.env as Env;
  const active = await resolveActiveProjectFromRequest(request, env, user.id);
  if (!active) throw new Response("Not Found", { status: 404 });
  const db = getDb(env.DB);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  if (intent === "accept") {
    if ((await getUserRole(db, active.project.id, user.id)) === null) throw new Response("Forbidden", { status: 403 });
    return acceptOwnTeamInvitation(env, db, active.project, user);
  }
  if (!CONVENOR_INTENTS.includes(intent)) throw new Response("Bad Request", { status: 400 });
  await requireOwner(db, active.project.id, user.id);
  return runConvenorTeamAction(env, db, active.project, intent as ConvenorIntent, Number(form.get("userId")));
}

export default function TeamRoute({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("team");
  const { rows, invited, checkedAt, viewer } = loaderData;
  const fetcher = useFetcher<TeamActionResult>();
  const busyUser = fetcher.state === "idle" ? null : Number(fetcher.formData?.get("userId"));
  const act = (userId: number, intent: TeamRowAction) => fetcher.submit({ intent, userId }, { method: "post" });
  const polled = useSharedGithubStatus();
  const revalidator = useRevalidator();
  useEffect(() => {
    if (polled) revalidator.revalidate();
    // The revalidator object changes with every navigation state; only a new answer should read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polled]);
  const checked = useRelativeTime(checkedAt, t("team_page_never_checked"));

  return (
    <div className="bg-surface">
      <div className="mx-auto max-w-2xl px-4 py-6">
        <h1 className="font-heading text-xl font-semibold text-charcoal">{t("team_page_title")}</h1>
        <p className="font-body text-sm text-gray-500 mt-1">{t("team_page_intro")}</p>
        <ul className="mt-4 rounded-lg overflow-hidden border border-gray-100">
          {rows.map((r) => (
            <TeamMemberRow
              key={r.userId}
              githubId={r.githubId}
              username={r.username}
              role={r.role}
              state={r.state}
              error={r.error}
              behind={r.behind ? { checkedAt: r.checkedAt } : null}
              actions={teamRowActions(r, { convenor: viewer.convenor, self: r.userId === viewer.userId })}
              self={r.userId === viewer.userId}
              busy={busyUser === r.userId}
              result={fetcher.state === "idle" && fetcher.data?.userId === r.userId ? fetcher.data : null}
              onAction={(intent) => act(r.userId, intent)}
            />
          ))}
          {invited.map((_, i) => (
            <TeamInvitedRow key={`invited-${i}`} />
          ))}
        </ul>
        <p className="font-body text-xs text-gray-400 mt-2">
          {checkedAt && checked ? t("team_page_checked", { when: checked }) : checkedAt ? null : checked}
        </p>
      </div>
    </div>
  );
}
