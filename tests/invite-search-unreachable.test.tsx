// @vitest-environment jsdom
/**
 * A user search that could not be made says so and asks again. An
 * empty `users` list is an answer (nobody matches); an unreachable answer is
 * not, and the form must not present it as one.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import React from "react";
import { RETRY_UNREACHABLE_MS } from "~/lib/use-retry-unreachable";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

let response: unknown = undefined;
const submit = vi.fn();

vi.mock("react-router", () => ({
  useFetcher: () => ({
    submit,
    load: vi.fn(),
    state: "idle",
    formData: undefined,
    get data() {
      return response;
    },
  }),
}));

import { InviteForm } from "~/components/features/dashboard/InviteForm";

function typeInviteSearchQuery(value: string) {
  render(<InviteForm projectId={1} isOwner={true} />);
  fireEvent.click(screen.getByRole("button", { name: /invite_button/ }));
  fireEvent.change(screen.getByPlaceholderText("search_placeholder"), { target: { value } });
}

beforeEach(() => {
  vi.useFakeTimers();
  submit.mockClear();
  response = undefined;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("InviteForm user search", () => {
  it("says the search could not be made when it came back unreachable", () => {
    response = { ok: false, reason: "unreachable", intent: "search-users" };
    typeInviteSearchQuery("ab");
    expect(screen.getByRole("status").textContent).toBe("search_could_not_search");
  });

  it("says nothing for a search that found no one", () => {
    response = { ok: true, intent: "search-users", users: [] };
    typeInviteSearchQuery("ab");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("asks again after the delay while the query stands", () => {
    response = { ok: false, reason: "unreachable", intent: "search-users" };
    typeInviteSearchQuery("ab");
    act(() => {
      vi.advanceTimersByTime(300);
    });
    submit.mockClear();
    act(() => {
      vi.advanceTimersByTime(RETRY_UNREACHABLE_MS);
    });
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
