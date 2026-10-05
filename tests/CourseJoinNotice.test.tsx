// @vitest-environment jsdom
/**
 * CourseJoinNotice.test.tsx — that every outcome a creation-time join can
 * reach has a sentence of its own.
 *
 * The point of the assertions below is exhaustiveness and distinctness: a
 * state with no case would render nothing, and two states sharing a key
 * would put a student on the wrong next move. Both are silent failures, so
 * they are pinned rather than trusted to the type checker.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

// Stand in for i18next's plural resolution: the real `t` picks _one/_other
// from `count`, so the stub appends the same suffix and the assertions read
// the key that would actually be looked up.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      if (!values) return key;
      const count = values.count;
      const resolved = typeof count === "number" ? `${key}_${count === 1 ? "one" : "other"}` : key;
      return `${resolved}:${Object.values(values).join(",")}`;
    },
  }),
}));

import {
  CourseJoinNotice,
  courseJoinMessage,
} from "~/components/features/onboarding/CourseJoinNotice";
import type { CourseJoinOutcome } from "~/lib/import.server";

const OK: CourseJoinOutcome = {
  state: "ok",
  courseProjectId: 9,
  courseName: "History 101",
  alreadyAttached: false,
  preloaded: 12,
  skippedConflict: 0,
  skippedRepoBound: 0,
};

const REFUSALS: CourseJoinOutcome[] = [
  { state: "not_found" },
  { state: "expired" },
  { state: "revoked" },
  { state: "consumed" },
  { state: "wrong_kind" },
  { state: "rate_limited" },
  { state: "already_enrolled" },
  { state: "not_a_site" },
  { state: "failed" },
];

describe("courseJoinMessage", () => {
  it("names the course on a successful join", () => {
    expect(courseJoinMessage(OK)).toMatchObject({
      tone: "success",
      key: "onboarding:course_join.joined",
      values: { course: "History 101" },
    });
  });

  it("reports only the collection outcomes that happened", () => {
    expect(courseJoinMessage(OK).details).toEqual([
      { key: "onboarding:course_join.preloaded", count: 12 },
    ]);
  });

  it("reports each kind of skip when there was one", () => {
    const message = courseJoinMessage({
      ...OK,
      preloaded: 3,
      skippedConflict: 1,
      skippedRepoBound: 2,
    } as CourseJoinOutcome);
    expect(message.details).toEqual([
      { key: "onboarding:course_join.preloaded", count: 3 },
      { key: "onboarding:course_join.skipped_conflict", count: 1 },
      { key: "onboarding:course_join.skipped_repo", count: 2 },
    ]);
  });

  it("says nothing about a collection that moved nothing", () => {
    const message = courseJoinMessage({
      ...OK,
      preloaded: 0,
      skippedConflict: 0,
      skippedRepoBound: 0,
    } as CourseJoinOutcome);
    expect(message.details).toEqual([]);
  });

  it("uses only detail keys the shipped English locale pluralises", async () => {
    const onboarding = (await import("~/i18n/locales/en/onboarding.json"))
      .default as unknown as { course_join: Record<string, string> };
    const details = courseJoinMessage({
      ...OK,
      preloaded: 1,
      skippedConflict: 1,
      skippedRepoBound: 1,
    } as CourseJoinOutcome).details;
    for (const detail of details ?? []) {
      const leaf = detail.key.split(".")[1];
      expect(onboarding.course_join[`${leaf}_one`], `missing ${leaf}_one`).toBeTruthy();
      expect(onboarding.course_join[`${leaf}_other`], `missing ${leaf}_other`).toBeTruthy();
    }
  });

  it("gives every refusal its own key", () => {
    const keys = REFUSALS.map((o) => courseJoinMessage(o).key);
    expect(new Set(keys).size).toBe(REFUSALS.length);
  });

  it("warns rather than congratulates on every refusal", () => {
    for (const outcome of REFUSALS) {
      expect(courseJoinMessage(outcome).tone).toBe("warning");
    }
  });

  it("uses only keys that exist in the shipped English locale", async () => {
    const onboarding = (await import("~/i18n/locales/en/onboarding.json"))
      .default as unknown as Record<string, unknown>;
    const team = (await import("~/i18n/locales/en/team.json"))
      .default as unknown as Record<string, unknown>;

    for (const outcome of [OK, ...REFUSALS]) {
      const { key } = courseJoinMessage(outcome);
      const [ns, path] = key.split(":");
      const resolved =
        ns === "team"
          ? team[path]
          : path.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], onboarding);
      expect(resolved, `missing English string for ${key}`).toBeTruthy();
    }
  });
});

describe("CourseJoinNotice", () => {
  it("renders nothing when no code was entered", () => {
    const { container } = render(<CourseJoinNotice outcome={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the course name on success", () => {
    render(<CourseJoinNotice outcome={OK} />);
    expect(screen.getByText(/course_join\.joined:History 101/)).toBeDefined();
  });

  it("renders what the collection brought across", () => {
    render(<CourseJoinNotice outcome={OK} />);
    expect(screen.getByText("onboarding:course_join.preloaded_other:12")).toBeDefined();
  });

  it("renders no collection line when nothing moved", () => {
    render(
      <CourseJoinNotice
        outcome={{ ...OK, preloaded: 0, skippedConflict: 0, skippedRepoBound: 0 } as CourseJoinOutcome}
      />,
    );
    expect(screen.queryByText(/preloaded/)).toBeNull();
  });

  it("renders a refusal without claiming the site failed to be created", () => {
    render(<CourseJoinNotice outcome={{ state: "revoked" }} />);
    expect(screen.getByText("team:code_error_revoked")).toBeDefined();
  });

  it("names the course on a site that left the course mid-sequence", () => {
    render(
      <CourseJoinNotice
        outcome={{ state: "not_enrolled", courseProjectId: 9, courseName: "History 101" }}
      />,
    );
    expect(screen.getByText(/course_join\.not_enrolled:History 101/)).toBeDefined();
  });
});
