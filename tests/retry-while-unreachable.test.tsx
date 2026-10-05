// @vitest-environment jsdom
/**
 * A read that came back unreachable is asked again: the Pages scan
 * on an empty list and the objects page's pre-commit check are made once, on
 * mount, so an unreachable answer would otherwise stand for the visit. The
 * objects route's client action answers those reads unreachable, and passes
 * its writes through.
 *
 * @version v1.5.0-beta
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { UNSAFE_ErrorResponseImpl } from "react-router";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("~/lib/db.server", () => ({ getDb: () => ({}) }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: () => ({ getSession: async () => ({ get: () => undefined }) }),
}));

import { clientAction as objectsClientAction } from "~/routes/_app.objects";
import { RETRY_UNREACHABLE_MS, useRetryWhileUnreachable } from "~/lib/use-retry-unreachable";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Retrier({ answer, retry, wanted }: { answer: unknown; retry: () => void; wanted?: boolean }) {
  useRetryWhileUnreachable(answer, retry, wanted);
  return null;
}

const UNREACHABLE = () => ({ ok: false, reason: "unreachable", intent: "scan-repo-pages" });

describe("useRetryWhileUnreachable", () => {
  it("asks again after the delay, and again after each unreachable answer", () => {
    const retry = vi.fn();
    const view = render(<Retrier answer={UNREACHABLE()} retry={retry} />);
    vi.advanceTimersByTime(RETRY_UNREACHABLE_MS - 1);
    expect(retry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(retry).toHaveBeenCalledTimes(1);
    view.rerender(<Retrier answer={UNREACHABLE()} retry={retry} />);
    vi.advanceTimersByTime(RETRY_UNREACHABLE_MS);
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it("does not ask again once an answer has arrived, before an answer, or when the read is no longer wanted", () => {
    const retry = vi.fn();
    const view = render(<Retrier answer={undefined} retry={retry} />);
    vi.advanceTimersByTime(RETRY_UNREACHABLE_MS * 2);
    view.rerender(<Retrier answer={{ ok: true, pages: [] }} retry={retry} />);
    vi.advanceTimersByTime(RETRY_UNREACHABLE_MS * 2);
    view.rerender(<Retrier answer={UNREACHABLE()} retry={retry} wanted={false} />);
    vi.advanceTimersByTime(RETRY_UNREACHABLE_MS * 2);
    expect(retry).not.toHaveBeenCalled();
  });

  it("cancels a pending retry when an answer arrives first", () => {
    const retry = vi.fn();
    const view = render(<Retrier answer={UNREACHABLE()} retry={retry} />);
    vi.advanceTimersByTime(RETRY_UNREACHABLE_MS - 1);
    view.rerender(<Retrier answer={{ ok: true }} retry={retry} />);
    vi.advanceTimersByTime(RETRY_UNREACHABLE_MS);
    expect(retry).not.toHaveBeenCalled();
  });
});

describe("the Objects route's clientAction", () => {
  const postedIntent = (intent: string) =>
    new Request("http://stage.test/objects", { method: "POST", body: new URLSearchParams({ intent }) });

  it.each(["poll-build", "pre-commit-check", "compute-sync-diff", "fetch-iiif-preview", "probe-tiles", "enrich-external"])(
    "answers %s failing in transit as unreachable, with its intent and status 503",
    async (intent) => {
      for (const failure of [new TypeError("Failed to fetch"), new UNSAFE_ErrorResponseImpl(503, "Service Unavailable", "")]) {
        const answer = await objectsClientAction({ request: postedIntent(intent), serverAction: () => Promise.reject(failure) } as never);
        expect(answer).toMatchObject({ data: { ok: false, reason: "unreachable", intent }, init: { status: 503 } });
      }
    },
  );

  it.each(["commit-objects", "upload-image", "sync-apply", "insert-pending-objects", "toggle-featured"])(
    "passes %s through: a failure is thrown unchanged",
    async (intent) => {
      const failure = new TypeError("Failed to fetch");
      await expect(objectsClientAction({ request: postedIntent(intent), serverAction: () => Promise.reject(failure) } as never)).rejects.toBe(failure);
    },
  );
});

describe("the pages that make a read once (text check)", () => {
  // The pages are too heavy to mount here; this pins only that each hands its
  // fetcher's answer to the retry, for the read it makes on mount.
  const pageSourceOf = (file: string) => readFileSync(join(__dirname, "../app/routes", file), "utf8");

  it("retries the Pages scan while the list is empty", () => {
    expect(pageSourceOf("_app.pages.tsx")).toMatch(/useRetryWhileUnreachable\(\s*repoScanFetcher\.data,[\s\S]{0,160}?"scan-repo-pages"[\s\S]{0,80}?displayPages\.length === 0,\s*\);/);
  });

  it("retries the objects pre-commit check", () => {
    expect(pageSourceOf("_app.objects.tsx")).toMatch(/useRetryWhileUnreachable\(sheetsFetcher\.data,[\s\S]{0,80}?"pre-commit-check"/);
  });
});

describe("the objects page's pre-commit check gates the commit dialog (text check)", () => {
  it("passes the dialog a pending check until one has answered for the site", () => {
    const page = readFileSync(join(__dirname, "../app/routes/_app.objects.tsx"), "utf8");
    expect(page).toContain("checkPending={commitCheckPending(checkedSite, project.id, sheetsFetcher.state)}");
    expect(page).toMatch(/setSheetsEnabled\(preCommitData\.sheetsEnabled\);\s*setObjectsFile\(preCommitData\.objectsFile\);\s*setCheckedSite\(project\.id\);/);
  });
});

describe("the Config route's clientAction", () => {
  const configPostOf = (intent: string) => new Request("http://stage.test/config", { method: "POST", body: new URLSearchParams({ intent }) });

  it("answers a refresh-themes that fails in transit as unreachable, and passes the saves through", async () => {
    const { clientAction } = await import("~/routes/_app.config");
    const failure = new TypeError("Failed to fetch");
    const answer = await clientAction({ request: configPostOf("refresh-themes"), serverAction: () => Promise.reject(failure) } as never);
    expect(answer).toMatchObject({ data: { ok: false, reason: "unreachable", intent: "refresh-themes" }, init: { status: 503 } });
    for (const write of ["save-config", "join-course", "leave-course"]) {
      await expect(clientAction({ request: configPostOf(write), serverAction: () => Promise.reject(failure) } as never)).rejects.toBe(failure);
    }
  });
});

describe("the Dashboard route's clientAction", () => {
  it.each(["search-users", "compute-full-sync-diff"])("answers %s failing in transit as unreachable, and passes the writes through", async (intent) => {
    const { clientAction } = await import("~/routes/_app.dashboard");
    const dashboardPostOf = (i: string) => new Request("http://stage.test/dashboard", { method: "POST", body: new URLSearchParams({ intent: i }) });
    const failure = new TypeError("Failed to fetch");
    const answer = await clientAction({ request: dashboardPostOf(intent), serverAction: () => Promise.reject(failure) } as never);
    expect(answer).toMatchObject({ data: { ok: false, reason: "unreachable", intent }, init: { status: 503 } });
    for (const write of ["switch-project", "generate-invite", "apply-full-sync", "cancel-invite"]) {
      await expect(clientAction({ request: dashboardPostOf(write), serverAction: () => Promise.reject(failure) } as never)).rejects.toBe(failure);
    }
  });
});
