/**
 * This file renders the join-as-staff field — the one place a co-instructor
 * or TA turns a course's instructor-role code into standing on that course.
 *
 * It sits on the account page and nowhere else because staff admission
 * attaches a PERSON, not a site (design §89). The other two redemption
 * surfaces — site creation and site settings — both act on a project, and a
 * code entered there attaches that project to a course; neither can express
 * "admit me", which is what this one is for.
 *
 * The field is visible to everyone who can see the page. Redeeming a code is
 * never behind the course-projects password gate (ruling 20): the gate is on
 * running a course, and a person entering a code has been handed one by
 * somebody who already passed it.
 *
 * Every refusal gets its own sentence, in the `team` namespace where the same
 * states are named on the other two surfaces. A code that does not exist, one
 * that has been deactivated, and one that attaches sites rather than people
 * need three different next moves, and a shared "that didn't work" would
 * leave all three guessing.
 *
 * @version v1.5.0-beta
 */

import { useTranslation } from "react-i18next";
import { useFetcher } from "react-router";
import { CheckCircle, AlertTriangle } from "lucide-react";
import { Button } from "~/components/ui/Button";

/** What the account action reports back for a staff redemption. */
export type StaffJoinOutcome =
  | { state: "ok"; courseName: string; alreadyStaff: boolean }
  | { state: "error" }
  | {
      state:
        | "not_found"
        | "expired"
        | "revoked"
        | "consumed"
        | "wrong_kind"
        | "rate_limited"
        | "already_enrolled"
        | "not_a_site";
    };

export interface StaffJoinMessage {
  tone: "success" | "warning";
  /** Namespace-qualified, so the caller needs no namespace of its own. */
  key: string;
  values?: Record<string, string | number>;
}

/**
 * Name the sentence an outcome deserves.
 *
 * `already_enrolled` and `not_a_site` are `redeemForSite`'s refusals and
 * cannot arrive here — staff admission attaches nobody's site. They are in the
 * result type all the same, because both redemptions share `RedeemState`, and
 * a state with no sentence would render as nothing at all. `consumed` is the
 * same shape: a legacy single-use invite resolves `wrong_kind` before its
 * spent flag is read.
 */
export function staffJoinMessage(outcome: StaffJoinOutcome): StaffJoinMessage {
  switch (outcome.state) {
    case "ok":
      return {
        tone: "success",
        key: outcome.alreadyStaff
          ? "account:join_course_already"
          : "account:join_course_success",
        values: { course: outcome.courseName },
      };
    case "not_found":
      return { tone: "warning", key: "team:code_error_not_found" };
    case "expired":
      return { tone: "warning", key: "team:code_error_expired" };
    case "revoked":
      return { tone: "warning", key: "team:code_error_revoked" };
    case "consumed":
      return { tone: "warning", key: "team:accept_used" };
    case "wrong_kind":
      return { tone: "warning", key: "team:code_error_wrong_kind_staff" };
    case "rate_limited":
      return { tone: "warning", key: "team:code_error_rate_limited" };
    case "already_enrolled":
      return { tone: "warning", key: "team:code_error_already_enrolled" };
    case "not_a_site":
      return { tone: "warning", key: "team:code_error_not_a_site" };
    case "error":
      return { tone: "warning", key: "account:join_course_failed" };
  }
}

export function JoinCourseCard() {
  const { t } = useTranslation(["account", "team"]);
  const fetcher = useFetcher<{ intent: string; outcome: StaffJoinOutcome }>();
  const outcome =
    fetcher.data?.intent === "join-course-staff" ? fetcher.data.outcome : undefined;
  const message = outcome ? staffJoinMessage(outcome) : undefined;
  const submitting = fetcher.state !== "idle";

  return (
    <section className="bg-white rounded-lg border border-gray-200 shadow-sm p-6 mt-6">
      <h2
        id="join-course-heading"
        className="text-xl font-heading font-semibold text-charcoal"
      >
        {t("account:join_course_heading")}
      </h2>
      <p className="mt-1 font-body text-sm text-gray-600">
        {t("account:join_course_hint")}
      </p>

      <fetcher.Form
        method="post"
        className="mt-4 flex flex-wrap items-start gap-3"
        aria-labelledby="join-course-heading"
      >
        <input type="hidden" name="intent" value="join-course-staff" />
        <input
          type="text"
          name="code"
          required
          autoComplete="off"
          // The alphabet is uppercase and unambiguous by construction, so a
          // code read off a slide can be typed in either case and pasted with
          // whatever spacing it was copied with. `normaliseToken` settles both
          // server-side; this only spares the person the correction.
          className="flex-1 min-w-[12rem] rounded-control border border-gray-300 px-3 py-2 font-body text-base uppercase tracking-wide"
          placeholder={t("account:join_course_placeholder")}
          aria-label={t("account:join_course_placeholder")}
        />
        <Button type="submit" disabled={submitting}>
          {t("account:join_course_button")}
        </Button>
      </fetcher.Form>

      {message && (
        <div
          role="status"
          className={`mt-4 flex items-start gap-3 rounded-lg border p-3 ${
            message.tone === "success"
              ? "border-green-200 bg-green-50"
              : "border-amber-300 bg-amber-50"
          }`}
        >
          {message.tone === "success" ? (
            <CheckCircle
              className="w-4 h-4 text-green-600 mt-0.5 flex-shrink-0"
              aria-hidden="true"
            />
          ) : (
            <AlertTriangle
              className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0"
              aria-hidden="true"
            />
          )}
          <p
            className={`font-body text-sm ${
              message.tone === "success" ? "text-green-900" : "text-amber-900"
            }`}
          >
            {t(message.key, message.values)}
          </p>
        </div>
      )}
    </section>
  );
}
