/**
 * This file is the /course route — a course's management screen, and the
 * only place a course is run from (ruling 16). Rights over a course are
 * not folded into surfaces built for sites: they live here.
 *
 * It carries what ruling 16 names. The sites enrolled in the course, read
 * from `parent_project_id` — the column that IS the enrolment record —
 * each with its members, since a class roster is the union of
 * `project_members` across the children and a query rather than a stored
 * list (design §2). Removal of a site. The course's join codes. And, for
 * the convenor alone, the staff list.
 *
 * It is also a navigation surface, which is why it is not optional. A
 * child site is suppressed from the header switcher, the start page and
 * the account card for anyone holding only an `instructor` row on it
 * (rulings 18 and 25), so for a co-instructor this screen is where the
 * children are reachable at all. The site name is the click-through: it
 * posts `switch-project`, which admits a child by id and takes no course
 * password — ruling 22 makes the suppression a listing concern and nothing
 * more, and a password on that door would shut the convenience it calls a
 * convenience.
 *
 * The course is the session's active project, never a form field. That is
 * the opposite of the child, which arrives from the form and is verified
 * against `parent_project_id` inside `detachChildFromCourse`: removing a
 * site is a cross-project write, and its target cannot be the session's.
 *
 * `create-code` and `revoke-code` post to /dashboard rather than to this
 * route. They are the app's existing course-code intents, gated there by
 * the course password and `requireCourseCodeManager`; a second
 * implementation here would be a second gate to keep in step with the
 * first.
 *
 * @version v1.5.0-beta
 */

import { useState } from "react";
import { eq, inArray } from "drizzle-orm";
import { Form, useFetcher } from "react-router";
import { useSiteFetcher } from "~/lib/page-site";
import { useTranslation } from "react-i18next";
import type { Route } from "./+types/_app.course";
import { userContext } from "~/middleware/auth.server";
import type { AuthenticatedUser } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import {
  projects,
  project_config,
  project_members,
  project_invites,
  users,
} from "~/db/schema";
import { requireCourseAccess } from "~/lib/course-gate.server";
import { requireCourseCodeManager } from "~/lib/membership.server";
import { resolveActiveProjectFromRequest, resolvePageProject, siteChangedAnswer } from "~/lib/active-project.server";
import {
  listCourseChildren,
  listCourseStaff,
  detachChildFromCourse,
} from "~/lib/course-membership.server";
import type { CourseMembershipEnv } from "~/lib/course-membership.server";
import { RoleBadge } from "~/components/features/dashboard/RoleBadge";
import { Button } from "~/components/ui/Button";
import { DeleteConfirmationModal } from "~/components/ui/DeleteConfirmationModal";

export const handle = { i18n: ["common", "course", "team", "structural"] };

type MemberRole = "convenor" | "collaborator" | "instructor";

/** One row of the roster — a member of one of the course's children. */
interface RosterMember {
  userId: number;
  name: string;
  role: MemberRole;
}

/** One enrolled site, with the slice of the roster that belongs to it. */
interface CourseChild {
  id: number;
  title: string;
  repo: string;
  members: RosterMember[];
}

/** A join code as the screen shows it. */
interface CourseCode {
  id: number;
  token: string;
  label: string | null;
  /** The role the code confers, which decides who may revoke it. */
  role: "collaborator" | "instructor";
  expiresAt: string | null;
  revokedAt: string | null;
}

// ---------------------------------------------------------------------------
// Standing
// ---------------------------------------------------------------------------

/**
 * The caller's standing on the course they are running.
 *
 * The gate is answered before standing is looked up, so a caller without
 * the password learns nothing about the project the session names. Then
 * `requireCourseCodeManager` settles the three refusals this screen owes
 * in one call: no active project, an active project that is not a course,
 * and a caller who is neither the convenor nor an instructor member. All
 * three are the same 403 — a screen that distinguished them would report
 * whether a course exists to someone with no standing on it.
 *
 * `"collaborator"` names the code role being asked about, not the
 * caller's: it is class-code management, the right ruling 9 gives every
 * member of a course's staff. The convenor-only rights are decided from
 * the `role` this returns.
 */
async function requireCourseStaffOnActiveProject(
  request: Request,
  env: Env,
  user: AuthenticatedUser,
) {
  requireCourseAccess(user);

  const resolved = await resolveActiveProjectFromRequest(request, env, user.id);
  if (!resolved) throw new Response("Forbidden", { status: 403 });
  return requireCourseStaffFrom(getDb(env.DB), resolved.project, user.id);
}

/**
 * The course `project` belongs to, and the caller's standing on it: the
 * project itself when it is a course, else its parent.
 */
async function requireCourseStaffFrom(
  db: ReturnType<typeof getDb>,
  project: { id: number; kind: string; parent_project_id: number | null },
  userId: number,
) {
  // Clicking a site through from this screen posts `switch-project`, which
  // makes the CHILD the active project — so coming back would ask to run a
  // course on a project that is not one, and 403. The course is one hop up
  // `parent_project_id`, the column that is the enrolment record, so the
  // screen resolves it rather than being given a course id: an id in the
  // request would be a second way to name a course, and every caller could
  // name any of them.
  //
  // Walking up grants nothing. `requireCourseCodeManager` still settles both
  // questions against whatever this resolves to — that it is a course, and
  // that the caller is its convenor or one of its instructors — so a member
  // of a child with no standing on the course gets the same 403 as before.
  const courseId =
    project.kind === "course"
      ? project.id
      : (project.parent_project_id ?? project.id);

  const { project: course, role } = await requireCourseCodeManager(
    db,
    courseId,
    userId,
    "collaborator",
  );
  return { db, course, role };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const { db, course, role } = await requireCourseStaffOnActiveProject(
    request,
    env,
    user,
  );
  const isConvenor = role === "convenor";

  // The children come from the shared helper rather than from a query
  // written here, so the screen and the redemption side effects can never
  // disagree about what "the children of this course" means.
  const childIds = await listCourseChildren(db, course.id);

  const children: CourseChild[] = [];
  if (childIds.length > 0) {
    const [childRows, configRows, memberRows] = await Promise.all([
      db
        .select({ id: projects.id, repo: projects.github_repo_full_name })
        .from(projects)
        .where(inArray(projects.id, childIds)),
      db
        .select({
          project_id: project_config.project_id,
          title: project_config.title,
        })
        .from(project_config)
        .where(inArray(project_config.project_id, childIds)),
      db
        .select({
          project_id: project_members.project_id,
          user_id: project_members.user_id,
          role: project_members.role,
          github_name: users.github_name,
          github_login: users.github_login,
        })
        .from(project_members)
        .innerJoin(users, eq(project_members.user_id, users.id))
        .where(inArray(project_members.project_id, childIds)),
    ]);

    const titleByProject = new Map(configRows.map((c) => [c.project_id, c.title]));
    for (const child of childRows) {
      children.push({
        id: child.id,
        title: titleByProject.get(child.id) || child.repo,
        repo: child.repo,
        members: memberRows
          .filter((m) => m.project_id === child.id)
          .map((m) => ({
            userId: m.user_id,
            name: m.github_name || m.github_login,
            role: m.role as MemberRole,
          })),
      });
    }
  }

  // Every invite row on a course project is a code: `generate-invite` and
  // `send-invite` are refused on `kind = "course"`, so no legacy link can
  // have been minted here.
  const codeRows = await db
    .select({
      id: project_invites.id,
      token: project_invites.token,
      label: project_invites.label,
      conferred_role: project_invites.conferred_role,
      expires_at: project_invites.expires_at,
      revoked_at: project_invites.revoked_at,
    })
    .from(project_invites)
    .where(eq(project_invites.project_id, course.id));

  // An instructor-role code is the staff list by another door (ruling 9),
  // so an instructor is not sent one. Withholding the affordance would not
  // be enough: the token IS the power to admit staff, and a token in the
  // page source is a token a TA can hand on.
  const codes: CourseCode[] = codeRows
    .filter((r) => isConvenor || r.conferred_role !== "instructor")
    .map((r) => ({
      id: r.id,
      token: r.token,
      label: r.label,
      role: r.conferred_role === "instructor" ? "instructor" : "collaborator",
      expiresAt: r.expires_at,
      revokedAt: r.revoked_at,
    }));

  // The staff list is the convenor's alone (ruling 16). Read through the
  // shared helper so this screen and the copy-down agree on who staff are;
  // the helper answers with ids, and the names are joined here.
  let staff: RosterMember[] | null = null;
  if (isConvenor) {
    const staffIds = await listCourseStaff(db, course.id);
    const staffRows =
      staffIds.length === 0
        ? []
        : await db
            .select({
              user_id: project_members.user_id,
              role: project_members.role,
              github_name: users.github_name,
              github_login: users.github_login,
            })
            .from(project_members)
            .innerJoin(users, eq(project_members.user_id, users.id))
            .where(eq(project_members.project_id, course.id));
    staff = staffRows
      .filter((r) => staffIds.includes(r.user_id))
      .map((r) => ({
        userId: r.user_id,
        name: r.github_name || r.github_login,
        role: r.role as MemberRole,
      }));
  }

  const courseTitleRows = await db
    .select({ title: project_config.title })
    .from(project_config)
    .where(eq(project_config.project_id, course.id))
    .limit(1);

  return {
    course: {
      id: course.id,
      title: courseTitleRows[0]?.title || course.github_repo_full_name,
    },
    role,
    children,
    codes,
    staff,
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ request, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const formData = await request.formData();

  if (formData.get("intent") !== "remove-site") {
    return { ok: false, intent: "unknown", error: "unknown_intent" };
  }

  // Removing a site is course management, so it takes the password and
  // staff standing on the course — the same gate the screen itself takes,
  // answered again because an action is reachable without the loader.
  // The page's site is compared with the session's active project before
  // the walk up to the course, since the page can show a child of it.
  requireCourseAccess(user);
  const page = await resolvePageProject(request, env, user.id, formData);
  if (page.kind === "site_changed") {
    return siteChangedAnswer("remove-site", page.currentSiteName);
  }
  if (page.kind === "no_project") throw new Response("Forbidden", { status: 403 });
  const { db, course } = await requireCourseStaffFrom(getDb(env.DB), page.project, user.id);

  // `FormData` entries are `string | File`, and a hostile client can post
  // either. The value is narrowed by type test and judged as a number:
  // rendering a client-supplied value to decide something is the operation
  // behind every security defect found in this release.
  const raw = formData.get("projectId");
  if (typeof raw !== "string") {
    return { ok: false, intent: "remove-site", error: "missing_project_id" };
  }
  const childProjectId = Number(raw);
  if (!Number.isSafeInteger(childProjectId) || childProjectId <= 0) {
    return { ok: false, intent: "remove-site", error: "missing_project_id" };
  }

  // The child is verified against `parent_project_id` inside the leave
  // sequence, which leaves a site belonging to another course untouched
  // and reports `detached: false`. Reading the link here first would only
  // establish a fact about the past.
  const result = await detachChildFromCourse(
    db,
    env as unknown as CourseMembershipEnv,
    { courseProjectId: course.id, childProjectId },
  );

  return { ok: true, intent: "remove-site", detached: result.detached };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function formatExpiry(value: string | null): string | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toLocaleDateString();
}

function CodeRow({
  code,
  courseId,
  isConvenor,
}: {
  code: CourseCode;
  courseId: number;
  isConvenor: boolean;
}) {
  const { t } = useTranslation(["course", "common"]);
  const fetcher = useSiteFetcher();
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);

  const expiry = formatExpiry(code.expiresAt);
  const revoked = code.revokedAt !== null;
  // Ruling 9: class codes are every staff member's to revoke, staff codes
  // the convenor's alone. Restated here rather than left to the loader's
  // filter, so the rule holds where the affordance is drawn.
  const mayRevoke = code.role === "collaborator" || isConvenor;

  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-gray-200 py-3 last:border-b-0">
      <code className="font-heading text-base tracking-widest text-charcoal">
        {code.token}
      </code>
      {code.label && (
        <span className="font-body text-sm text-charcoal/70">{code.label}</span>
      )}
      <span className="font-body text-xs text-charcoal/60">
        {code.role === "instructor"
          ? t("course:code_role_instructor")
          : t("course:code_role_collaborator")}
      </span>
      {expiry !== null && (
        <span className="font-body text-xs text-charcoal/60">
          {t("course:code_expires_label")}: {expiry}
        </span>
      )}
      {revoked && (
        <span className="rounded-full bg-gray-100 px-2 py-0.5 font-heading text-xs uppercase tracking-wider text-gray-500">
          {t("course:code_revoked_badge")}
        </span>
      )}
      <span className="ml-auto flex items-center gap-2">
        <Button
          variant="control"
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(code.token);
            setCopied(true);
          }}
        >
          {copied ? t("course:code_copied") : t("course:copy_code")}
        </Button>
        {mayRevoke && !revoked && (
          <Button
            variant="control"
            type="button"
            onClick={() => setConfirming(true)}
          >
            {t("course:revoke_code")}
          </Button>
        )}
      </span>

      {/* `entityType` is required by the shared modal and ignored by it;
          its union has no member for a join code. */}
      <DeleteConfirmationModal
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          fetcher.submit(
            {
              intent: "revoke-code",
              projectId: String(courseId),
              inviteId: String(code.id),
            },
            { method: "post", action: "/dashboard" },
          );
        }}
        entityType="project"
        entityLabel={code.token}
        titleOverride={t("course:revoke_code_title")}
        bodyText={t("course:revoke_code_body")}
        confirmLabel={t("course:revoke_code_confirm")}
      />
    </li>
  );
}

function CreateCodeForm({
  courseId,
  isConvenor,
}: {
  courseId: number;
  isConvenor: boolean;
}) {
  const { t } = useTranslation(["course", "common"]);
  const fetcher = useFetcher<{ ok?: boolean; code?: string }>();
  const created = fetcher.data?.ok === true ? fetcher.data.code : undefined;

  return (
    <fetcher.Form
      method="post"
      action="/dashboard"
      className="mt-4 flex flex-wrap items-end gap-3"
    >
      <input type="hidden" name="intent" value="create-code" />
      <input type="hidden" name="projectId" value={courseId} />

      <label className="flex flex-col gap-1">
        <span className="font-body text-sm text-charcoal">
          {t("course:code_label_label")}
        </span>
        <input
          type="text"
          name="label"
          className="rounded border border-gray-300 px-3 py-2 font-body text-sm text-charcoal"
        />
        <span className="font-body text-xs text-charcoal/60">
          {t("course:code_label_hint")}
        </span>
      </label>

      <label className="flex flex-col gap-1">
        <span className="font-body text-sm text-charcoal">
          {t("course:code_expires_label")}
        </span>
        <input
          type="date"
          name="expiresAt"
          className="rounded border border-gray-300 px-3 py-2 font-body text-sm text-charcoal"
        />
      </label>

      {isConvenor ? (
        <label className="flex flex-col gap-1">
          <span className="font-body text-sm text-charcoal">
            {t("course:code_role_label")}
          </span>
          <select
            name="role"
            className="rounded border border-gray-300 px-3 py-2 font-body text-sm text-charcoal"
          >
            <option value="collaborator">
              {t("course:code_role_collaborator")}
            </option>
            <option value="instructor">
              {t("course:code_role_instructor")}
            </option>
          </select>
        </label>
      ) : (
        // Ruling 9: minting an instructor-role code is staff-list
        // management, the convenor's alone. The role is posted explicitly
        // rather than omitted, so the request says what it is asking for.
        <input type="hidden" name="role" value="collaborator" />
      )}

      <Button type="submit" loading={fetcher.state === "submitting"}>
        {t("course:create_code")}
      </Button>

      {created !== undefined && (
        <p className="w-full font-body text-sm text-charcoal">
          {t("course:code_created")} <code>{created}</code>
        </p>
      )}
    </fetcher.Form>
  );
}

function ChildRow({ child }: { child: CourseChild }) {
  const { t } = useTranslation(["course", "common"]);
  const fetcher = useSiteFetcher();
  const [confirming, setConfirming] = useState(false);

  return (
    <li className="border-b border-gray-200 py-4 last:border-b-0">
      <div className="flex flex-wrap items-center gap-3">
        {/* The site name is the click-through (ruling 22). It posts
            `switch-project`, which admits a child by id — the only door a
            suppressed child has, and deliberately not password-gated. */}
        <Form method="post" action="/dashboard">
          <input type="hidden" name="intent" value="switch-project" />
          <input type="hidden" name="projectId" value={child.id} />
          <button
            type="submit"
            className="font-heading text-base text-charcoal underline underline-offset-4 hover:text-terracotta"
          >
            {child.title}
          </button>
        </Form>
        <span className="font-body text-xs text-charcoal/60">{child.repo}</span>
        <Button
          variant="control"
          type="button"
          className="ml-auto"
          onClick={() => setConfirming(true)}
        >
          {t("course:remove_site")}
        </Button>
      </div>

      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {child.members.map((m) => (
          <li key={m.userId} className="flex items-center gap-2">
            <span className="font-body text-sm text-charcoal">{m.name}</span>
            <RoleBadge role={m.role} />
          </li>
        ))}
      </ul>

      <DeleteConfirmationModal
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          // Posts to this route. The course is the session's active
          // project; only the child travels in the form.
          fetcher.submit(
            { intent: "remove-site", projectId: String(child.id) },
            { method: "post" },
          );
        }}
        entityType="project"
        entityLabel={child.title}
        titleOverride={t("course:remove_site_title", { site: child.title })}
        bodyText={t("course:remove_site_body")}
        confirmLabel={t("course:remove_site_confirm")}
      />
    </li>
  );
}

export default function CoursePage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation(["course", "common"]);
  const { course, role, children, codes, staff } = loaderData;
  const isConvenor = role === "convenor";

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="font-heading text-2xl text-charcoal">
        {t("course:manage_title")}
      </h1>
      <p className="font-body text-sm text-charcoal/70">{course.title}</p>

      {/* The staff list, for the convenor alone (ruling 16). It sits under
          the course's own name because that is whose staff it is. */}
      {staff !== null && (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {staff.map((person) => (
            <li key={person.userId} className="flex items-center gap-2">
              <span className="font-body text-sm text-charcoal">
                {person.name}
              </span>
              <RoleBadge role={person.role} />
            </li>
          ))}
        </ul>
      )}

      <section className="mt-8">
        <h2 className="font-heading text-lg text-charcoal">
          {t("course:sites_heading")}
        </h2>
        <p className="font-body text-sm text-charcoal/60">
          {t("course:site_count", { count: children.length })}
        </p>
        {children.length === 0 ? (
          <p className="mt-3 font-body text-sm text-charcoal/70">
            {t("course:sites_empty")}
          </p>
        ) : (
          <ul className="mt-3">
            {children.map((child) => (
              <ChildRow key={child.id} child={child} />
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10">
        <h2 className="font-heading text-lg text-charcoal">
          {t("course:codes_heading")}
        </h2>
        {/*
          Stated wherever codes are, and not only while one is being made: what
          a code does not do is true of the course for as long as it has one,
          and an instructor who made their codes last term reads this screen
          without opening that dialog again.
        */}
        <p className="mt-3 max-w-prose font-body text-sm text-charcoal/70">
          {t("course:codes_access_note")}
        </p>
        {codes.length === 0 ? (
          <p className="mt-3 font-body text-sm text-charcoal/70">
            {t("course:codes_empty")}
          </p>
        ) : (
          <ul className="mt-3">
            {codes.map((code) => (
              <CodeRow
                key={code.id}
                code={code}
                courseId={course.id}
                isConvenor={isConvenor}
              />
            ))}
          </ul>
        )}
        <CreateCodeForm courseId={course.id} isConvenor={isConvenor} />
      </section>
    </div>
  );
}
