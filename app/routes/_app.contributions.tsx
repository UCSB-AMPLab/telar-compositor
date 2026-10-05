/**
 * This file is the /contributions route — the standalone contribution record.
 *
 * One path and no project id, like /course and for the same reason: the project
 * is the session's active one, so a caller cannot name somebody else's. Reading
 * the record still goes through `requireProjectMember`, because the session
 * resolving a project is not the same act as this person being allowed to see
 * who wrote what in it.
 *
 * Standalone rather than only a panel because people will want to screenshot,
 * print or file it. The print form is the same component with the app chrome
 * dropped by `print:hidden` at the shell, and each kind block carries
 * `break-inside: avoid` so a heading is never stranded from its table.
 *
 * The two clocks are asked of the live Durable Object rather than read from
 * `member_editing_time`, which is behind by whatever the instance has booked
 * since its last snapshot. The instance answers with both halves at once
 * because they are the same seconds either side of a settle; when it cannot
 * answer, the table is read instead and the record is a window out of date.
 *
 * The record is visible to everyone with access to the project, students first.
 * There is no instructor view and no instructor mode: an instructor is a
 * contributor on the same terms as anybody else, and sees exactly this.
 *
 * @version v1.5.0-beta
 */

import { useTranslation } from "react-i18next";
import { eq } from "drizzle-orm";

import type { Route } from "./+types/_app.contributions";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { project_config } from "~/db/schema";
import { requireProjectMember } from "~/lib/membership.server";
import { resolveActiveProjectFromRequest } from "~/lib/active-project.server";
import { getContributionRecord } from "~/lib/contributions.server";
import { getFromCollaborationDO } from "~/lib/internal-marker.server";
import type { MemberEditingTime } from "../../workers/contribution-metrics";
import { toContributionCsv } from "~/lib/contributions-csv";
import { ContributionRecord } from "~/components/features/contributions/ContributionRecord";

export const handle = { i18n: ["common", "contributions"] };

/**
 * The project's editing and writing seconds as the Durable Object has them:
 * the stored figure plus what the live instance has booked and not yet
 * written. `undefined` when it cannot be had.
 *
 * The number a person watches must be the number being stored, which is why
 * this is asked of the instance rather than computed anywhere else — but not
 * at the price of the page. Every failure ends here: an instance that refuses,
 * one that cannot be reached, an answer that is not the shape it claims. The
 * caller then reads the table, which is behind by at most one snapshot window,
 * and the record renders.
 */
async function fetchLedgerEditingTime(
  env: Env,
  projectId: number,
): Promise<MemberEditingTime[] | undefined> {
  try {
    const res = await getFromCollaborationDO(env, projectId, "editing-time", "/editing-time");
    if (!res.ok) {
      console.error(`[contributions] project ${projectId}: live time refused (${res.status})`);
      return undefined;
    }
    const data = (await res.json()) as { times?: unknown };
    if (!Array.isArray(data.times)) {
      console.error(`[contributions] project ${projectId}: live time malformed`);
      return undefined;
    }
    return data.times as MemberEditingTime[];
  } catch (err) {
    console.error(`[contributions] project ${projectId}: live time unreachable`, err);
    return undefined;
  }
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const active = await resolveActiveProjectFromRequest(request, env, user.id);
  if (!active) throw new Response("Not Found", { status: 404 });

  const db = getDb(env.DB);
  await requireProjectMember(db, active.project.id, user.id);

  const [config] = await db
    .select({ title: project_config.title })
    .from(project_config)
    .where(eq(project_config.project_id, active.project.id));

  const times = await fetchLedgerEditingTime(env, active.project.id);
  const record = await getContributionRecord(db, active.project.id, times);
  const projectTitle = config?.title ?? active.project.github_repo_full_name;

  // The CSV is the same read, served from the same loader under `?format=csv`,
  // so an export can never disagree with the page it was taken from.
  if (new URL(request.url).searchParams.get("format") === "csv") {
    return new Response(toContributionCsv(projectTitle, record.members), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="contributions.csv"`,
      },
    });
  }

  // `currentUserId` travels with the record so the sidebar, which loads this
  // same route, can tell which row is the reader's own without the app shell
  // having to carry an internal user id it has no other use for.
  // `projectId` names the project the record was read for, so the sidebar,
  // which keeps its last record through a failed read, keeps it for that
  // project whichever read (its own or the router's) brought it.
  return { projectTitle, currentUserId: user.id, projectId: active.project.id, ...record };
}

/**
 * The loader, answered in the browser. The collaboration panel reads the record
 * in the background as `?panel=record`; a read of it that fails (the request
 * never completes, an upstream 5xx, an undecodable answer, a refusal) is
 * answered as `{ unreachable: true }`, so the panel keeps the record it last
 * showed and the page it sits on stays open. It is plain data rather than an
 * error status, which would not stop the router reading it again after an
 * action. A redirect is thrown on, to the sign-in page as usual. Without the
 * parameter the page's own read is returned as it is, with its own success
 * and error paths.
 */
export async function clientLoader({ request, serverLoader }: Route.ClientLoaderArgs) {
  if (new URL(request.url).searchParams.get("panel") !== "record") return serverLoader();
  try {
    return await serverLoader();
  } catch (error) {
    if (error instanceof Response && error.status >= 300 && error.status < 400) throw error;
    return { unreachable: true as const };
  }
}

export default function ContributionsRoute({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("contributions");
  // Only the panel's read answers unreachable. The page opened at the panel's
  // address takes the error card, as the page's own failed read does.
  if ("unreachable" in loaderData) throw new Error("contribution record unreachable");
  const { projectTitle, members, hasWordsAndTime } = loaderData;

  return (
    <div className="bg-surface">
      <ContributionRecord
        projectTitle={projectTitle}
        members={members}
        hasWordsAndTime={hasWordsAndTime}
      />
      <div className="mx-auto max-w-[1000px] px-12 pb-10 print:hidden">
        <a
          href="/contributions?format=csv"
          className="font-heading text-[13px] text-terracotta hover:text-terracotta-deep"
          download
        >
          {t("export.csv")}
        </a>
      </div>
    </div>
  );
}
