/**
 * This file renders what became of a class code entered while a site was
 * being created.
 *
 * The join is settled server-side before the wizard sees it, so there is
 * nothing to submit here — only a line to read, plus what the course's
 * collection did or could not do on arrival. It is a separate component
 * because the outcome outlives the step that produced it: the code is
 * redeemed during the import, and the user should still be told about it on
 * review and on done.
 *
 * Each refusal gets its own sentence. A student whose code was deactivated,
 * one who mistyped it, and one whose site already belongs to another course
 * need three different next moves, and a shared "that didn't work" would
 * leave all three guessing. The strings for the refusals live in the `team`
 * namespace, where the same states are reported on the other two redemption
 * surfaces; only the two outcomes peculiar to creation are onboarding's own.
 *
 * @version v1.5.0-beta
 */

import { CheckCircle, AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CourseJoinOutcome } from "~/lib/import.server";

export interface CourseJoinMessage {
  tone: "success" | "warning";
  /** Namespace-qualified, so the caller needs no namespace of its own. */
  key: string;
  values?: Record<string, string | number>;
  /**
   * What the collection transfer did, on a successful join. Counts of zero
   * are omitted: a site that hit no id collisions should read nothing about
   * collisions.
   */
  details?: Array<{ key: string; count: number }>;
}

/**
 * Name the sentence an outcome deserves.
 *
 * `consumed` is a legacy single-use invite that has already been spent. A
 * site redemption cannot normally reach it — a UUID token is reported
 * `wrong_kind` before its spent flag is ever read — but the state is part of
 * the contract, and a state with no sentence would render as nothing at all.
 */
export function courseJoinMessage(outcome: CourseJoinOutcome): CourseJoinMessage {
  switch (outcome.state) {
    case "ok":
      return {
        tone: "success",
        key: "onboarding:course_join.joined",
        values: { course: outcome.courseName },
        details: [
          { key: "onboarding:course_join.preloaded", count: outcome.preloaded },
          { key: "onboarding:course_join.skipped_conflict", count: outcome.skippedConflict },
          { key: "onboarding:course_join.skipped_repo", count: outcome.skippedRepoBound },
        ].filter((detail) => detail.count > 0),
      };
    case "failed":
      return { tone: "warning", key: "onboarding:course_join.failed" };
    case "not_enrolled":
      return {
        tone: "warning",
        key: "onboarding:course_join.not_enrolled",
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
      return { tone: "warning", key: "team:code_error_wrong_kind_site" };
    case "rate_limited":
      return { tone: "warning", key: "team:code_error_rate_limited" };
    case "already_enrolled":
      return { tone: "warning", key: "team:code_error_already_enrolled" };
    case "not_a_site":
      return { tone: "warning", key: "team:code_error_not_a_site" };
  }
}

/**
 * What this page's course form can come to.
 *
 * Every redemption state is `CourseJoinOutcome`'s, so the two join surfaces
 * report one vocabulary — except `failed`, whose sentence names the site's
 * creation and belongs to the wizard alone. The four added here are this
 * surface's own: `forbidden` for a caller who does not convene the site,
 * `left` for a completed departure, `error` for a sequence that threw, and
 * `not_enrolled` for the outcome §5's concurrency admits — the side effects
 * finishing on a site that has left the course, which is neither a success
 * nor a failure.
 */
export type CourseSettingsOutcome =
  | Exclude<CourseJoinOutcome, { state: "failed" }>
  | { state: "not_enrolled" }
  | { state: "left" }
  | { state: "forbidden" }
  // The intent is carried because the sentence differs by it and nothing else
  // can tell them apart: both sequences fail the same way and are repaired the
  // same way, but one leaves the site out of the course and the other leaves
  // it in, and a reader needs to know which.
  | { state: "error"; intent: "join" | "leave" };

/**
 * Name the sentence an outcome deserves, or none.
 *
 * The redemption states delegate to `courseJoinMessage` rather than restating
 * its switch: a state whose sentence differed between the two join surfaces
 * would be a state a student is told two things about.
 *
 * `left` returns nothing on purpose. The section re-renders from the loader
 * with the site out of the course, which is the confirmation; a sentence
 * saying so would need copy this design does not carry.
 */
export function courseSettingsMessage(
  outcome: CourseSettingsOutcome,
): CourseJoinMessage | null {
  switch (outcome.state) {
    case "left":
      return { tone: "success", key: "config:course.left" };
    case "forbidden":
      return { tone: "warning", key: "config:course.convenor_only" };
    // Two ways for a join not to land, and one sentence, because the repair is
    // the same for both: enter the code again, and every step of the sequence
    // is a no-op where it already ran. Neither may read as a success — in
    // `not_enrolled` the collection did not transfer and the site is not in
    // the course.
    case "not_enrolled":
      return { tone: "warning", key: "config:course.join_failed" };
    case "error":
      return outcome.intent === "join"
        ? { tone: "warning", key: "config:course.join_failed" }
        : { tone: "warning", key: "config:course.leave_failed" };
    default:
      return courseJoinMessage(outcome);
  }
}

export function CourseJoinNotice({
  outcome,
  className = "",
}: {
  outcome: CourseJoinOutcome | undefined;
  className?: string;
}) {
  const { t } = useTranslation(["onboarding", "team"]);
  if (!outcome) return null;

  const message = courseJoinMessage(outcome);
  const success = message.tone === "success";

  return (
    <div
      role="status"
      className={`flex items-start gap-3 rounded-lg border p-3 ${
        success ? "border-green-200 bg-green-50" : "border-amber-300 bg-amber-50"
      } ${className}`}
    >
      {success ? (
        <CheckCircle className="w-4 h-4 text-green-600 mt-0.5 flex-shrink-0" aria-hidden="true" />
      ) : (
        <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" aria-hidden="true" />
      )}
      <div className={`font-body text-sm ${success ? "text-green-900" : "text-amber-900"}`}>
        <p>{t(message.key, message.values)}</p>
        {message.details?.map((detail) => (
          <p key={detail.key} className="mt-1">
            {t(detail.key, { count: detail.count })}
          </p>
        ))}
      </div>
    </div>
  );
}
