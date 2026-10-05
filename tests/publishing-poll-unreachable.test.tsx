// @vitest-environment jsdom
/**
 * A build poll that fails in transit leaves the publishing popover showing its
 * last poll.
 *
 * The Publish route's real `clientAction` answers a `poll-build` whose
 * `serverAction()` throws in transit as unreachable, with its intent, and
 * passes every other intent through. The popover then runs in a memory router
 * against that `clientAction`, with the shell's `phases={null}`: a successful
 * poll followed by unreachable ones keeps its phases, its Actions link and the
 * `runId` the next poll sends; a later success replaces them; a new commit
 * drops them.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { createContext, useContext } from "react";
import { createMemoryRouter, redirect, RouterProvider, UNSAFE_ErrorResponseImpl } from "react-router";
import type { BuildPhaseStatus } from "~/lib/commit.server";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("~/lib/db.server", () => ({ getDb: () => ({}) }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: () => ({ getSession: async () => ({ get: () => undefined }) }),
}));
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({ isPublishing: true, isBuilding: false }),
}));

import { clientAction } from "~/routes/_app.publish";
import { PageSiteProvider } from "~/lib/page-site";
import { PublishingPopover } from "~/components/features/site-status/popovers/PublishingPopover";

function submission(fields: Record<string, string>) {
  return new Request("http://stage.test/publish", { method: "POST", body: new URLSearchParams(fields) });
}

describe("the Publish route's clientAction", () => {
  it("answers a poll-build that fails in transit as unreachable, with its intent and status 503", async () => {
    for (const failure of [new TypeError("Failed to fetch"), new UNSAFE_ErrorResponseImpl(503, "Service Unavailable", "")]) {
      const answer = await clientAction({
        request: submission({ intent: "poll-build", sha: "abc" }),
        serverAction: () => Promise.reject(failure),
      } as never);
      expect(answer).toMatchObject({ data: { ok: false, reason: "unreachable", intent: "poll-build" }, init: { status: 503 } });
    }
  });

  it("answers a run-validation that fails in transit as unreachable, with its intent and status 503", async () => {
    for (const failure of [new TypeError("Failed to fetch"), new UNSAFE_ErrorResponseImpl(503, "Service Unavailable", "")]) {
      const answer = await clientAction({
        request: submission({ intent: "run-validation", removeStoryId: "s1", removeColumn: "c" }),
        serverAction: () => Promise.reject(failure),
      } as never);
      expect(answer).toMatchObject({ data: { ok: false, reason: "unreachable", intent: "run-validation" }, init: { status: 503 } });
    }
  });

  it("throws a poll-build's redirect on unchanged", async () => {
    const signIn = redirect("/signin");
    await expect(
      clientAction({ request: submission({ intent: "poll-build", sha: "abc" }), serverAction: () => Promise.reject(signIn) } as never),
    ).rejects.toBe(signIn);
  });

  it("passes every other intent through: its failure is thrown unchanged, and its answer returned", async () => {
    const failure = new TypeError("Failed to fetch");
    for (const intent of ["publish", "repair-build-workflow"]) {
      await expect(
        clientAction({ request: submission({ intent }), serverAction: () => Promise.reject(failure) } as never),
      ).rejects.toBe(failure);
    }
    const published = { ok: true, intent: "publish", newHeadSha: "def" };
    await expect(
      clientAction({ request: submission({ intent: "publish" }), serverAction: async () => published } as never),
    ).resolves.toBe(published);
  });
});

const BUILDING: BuildPhaseStatus[] = [
  { id: "setup", label: "Setup", status: "completed", conclusion: "success" },
  { id: "build-js", label: "Build JS", status: "completed", conclusion: "success" },
  { id: "process-data", label: "Process data", status: "completed", conclusion: "success" },
  { id: "build-site", label: "Build site", status: "in_progress", conclusion: null },
  { id: "iiif", label: "IIIF tiles", status: "queued", conclusion: null },
  { id: "deploy", label: "Deploy", status: "queued", conclusion: null },
];

const DEPLOYING: BuildPhaseStatus[] = BUILDING.map((p) =>
  p.id === "deploy" ? { ...p, status: "in_progress" } : { ...p, status: "completed", conclusion: "success" },
);

function built(sha: string, runId: number, phases: BuildPhaseStatus[]) {
  return {
    ok: true,
    intent: "poll-build",
    sha,
    buildStatus: "in_progress",
    buildConclusion: null,
    buildUrl: `https://github.com/o/r/actions/runs/${runId}`,
    runId,
    phases,
    repoPrivate: null,
  };
}

const Build = createContext<{ sha: string; projectId: number }>({ sha: "", projectId: 1 });

function Shell() {
  const { sha, projectId } = useContext(Build);
  return (
    <PageSiteProvider activeProjectId={projectId}>
      <PublishingPopover phases={null} sha={sha} />
    </PageSiteProvider>
  );
}

describe("the publishing popover during an outage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setInterval", "clearInterval"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function mount(server: () => Promise<unknown>) {
    const sent: Array<Record<string, string>> = [];
    const router = createMemoryRouter([
      { path: "/", Component: Shell },
      {
        path: "/publish",
        action: async (args) => {
          sent.push(Object.fromEntries((await args.request.clone().formData()) as never));
          return clientAction({ ...args, serverAction: server } as never);
        },
      },
    ]);
    const tree = (build: { sha: string; projectId: number }) => (
      <Build.Provider value={build}>
        <RouterProvider router={router} />
      </Build.Provider>
    );
    const view = render(tree({ sha: "aaa", projectId: 1 }));
    return { sent, set: (build: { sha: string; projectId: number }) => view.rerender(tree(build)) };
  }

  const step = () => screen.getByText(/^\d\/7$/).textContent;
  const actionsLink = () => screen.getByText("publishing.watch_github").closest("a")!.getAttribute("href");
  const beat = () =>
    act(async () => {
      vi.advanceTimersByTime(5000);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

  it("keeps the last poll through unreachable answers, replaces it on success, and drops it for a new commit", async () => {
    let answer: () => Promise<unknown> = async () => built("aaa", 9, BUILDING);
    const { sent, set } = mount(() => answer());
    await waitFor(() => expect(step()).toBe("5/7"));
    expect(actionsLink()).toBe("https://github.com/o/r/actions/runs/9");

    answer = () => Promise.reject(new TypeError("Failed to fetch"));
    await beat();
    await beat();
    expect(sent).toHaveLength(3);
    expect(step()).toBe("5/7");
    expect(actionsLink()).toBe("https://github.com/o/r/actions/runs/9");
    expect(sent[2].runId).toBe("9");

    answer = async () => built("aaa", 10, DEPLOYING);
    await beat();
    await waitFor(() => expect(actionsLink()).toBe("https://github.com/o/r/actions/runs/10"));
    expect(step()).toBe("7/7");

    answer = () => Promise.reject(new TypeError("Failed to fetch"));
    set({ sha: "bbb", projectId: 1 });
    await waitFor(() => expect(sent.at(-1)?.sha).toBe("bbb"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(sent.at(-1)?.runId).toBeUndefined();
    expect(actionsLink()).toBe("#");
    expect(step()).not.toBe("7/7");
  });

  it("does not keep one project's poll for another project building the same commit", async () => {
    let answer: () => Promise<unknown> = async () => built("aaa", 9, BUILDING);
    const { sent, set } = mount(() => answer());
    await waitFor(() => expect(step()).toBe("5/7"));

    // Project 2 becomes live while the fetcher still holds project 1's poll.
    set({ sha: "aaa", projectId: 2 });
    answer = () => Promise.reject(new TypeError("Failed to fetch"));
    await beat();
    await beat();
    expect(step()).not.toBe("5/7");
    expect(actionsLink()).not.toBe("https://github.com/o/r/actions/runs/9");
    expect(sent.at(-1)?.runId).toBeUndefined();
  });
});

