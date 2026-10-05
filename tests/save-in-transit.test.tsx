// @vitest-environment jsdom
/**
 * A write that fails in transit leaves the story editor open.
 *
 * `answerOrUnreachable` answers a throw from `serverAction()` that is not the
 * action's own decision as `{ ok: false, reason: "unreachable" }`, with the
 * write's intent and nonce, and throws the action's decisions on. The story
 * route's real `clientAction` and `ErrorBoundary` then run in a routes stub
 * whose loaders, the page's and one a fetcher loaded, fail once the outage
 * starts: the write is answered as failed with status 503, nothing is read
 * again, and the error card never appears. Answered without that status,
 * the same outage reaches the error card through the reads that follow. A
 * write that fails while another page is opening still lets that page, and
 * the parents it reads, be read (`shouldRevalidate`), instead of landing on
 * its address with the data of the page it left.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRoutesStub, Outlet, redirect, useFetcher, useLoaderData, useLocation, useNavigate, useRouteLoaderData, UNSAFE_ErrorResponseImpl } from "react-router";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("~/lib/error-capture", () => ({ recordError: vi.fn() }));
vi.mock("~/lib/db.server", () => ({ getDb: () => ({}) }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: () => ({ getSession: async () => ({ get: () => undefined }) }),
}));
vi.mock("~/lib/membership.server", () => ({
  requireProjectMember: vi.fn(async () => undefined),
  requireOwner: vi.fn(async () => undefined),
  resolveActiveProject: vi.fn(async () => null),
}));

import { clientAction, ErrorBoundary, shouldRevalidate } from "~/routes/_app.stories.$storyId";
import { answerOrUnreachable, asUnreachableAnswer, isUnreachable, readAnotherPage } from "~/lib/unreachable-write";

afterEach(() => cleanup());

function saveRequest(fields: Record<string, string> = { intent: "save-step-field", nonce: "n-1", field: "question", value: "Q" }) {
  return new Request("http://stage.test/stories/1", { method: "POST", body: new URLSearchParams(fields) });
}

const IN_TRANSIT: Array<[string, unknown]> = [
  ["a request that never completes", new TypeError("Failed to fetch")],
  ["a bare 503", new UNSAFE_ErrorResponseImpl(503, "Service Unavailable", "upstream")],
  ["an undecodable answer", new Error("Unable to decode turbo-stream response")],
  ["an upstream timeout", new UNSAFE_ErrorResponseImpl(408, "Request Timeout", "")],
  ["an upstream rate limit", new UNSAFE_ErrorResponseImpl(429, "Too Many Requests", "")],
  ["an exception in the action", new Error("Unexpected Server Error")],
];

describe("answerOrUnreachable", () => {
  for (const [what, failure] of IN_TRANSIT) {
    it(`answers ${what} as an unreachable write, with its intent and nonce`, async () => {
      expect(isUnreachable(failure)).toBe(true);
      await expect(answerOrUnreachable(saveRequest(), () => Promise.reject(failure))).resolves.toEqual({
        ok: false,
        reason: "unreachable",
        intent: "save-step-field",
        nonce: "n-1",
      });
    });
  }

  for (const [what, decision] of [
    ["a redirect", redirect("/signin")],
    ["a refusal for a signed-out author", new UNSAFE_ErrorResponseImpl(401, "Unauthorized", "Unauthorized")],
    ["a refusal for a non-member", new UNSAFE_ErrorResponseImpl(403, "Forbidden", "Forbidden")],
    ["a conflict", new UNSAFE_ErrorResponseImpl(409, "Conflict", "Conflict")],
  ] as const) {
    it(`throws ${what} on unchanged`, async () => {
      expect(isUnreachable(decision)).toBe(false);
      await expect(answerOrUnreachable(saveRequest(), () => Promise.reject(decision))).rejects.toBe(decision);
    });
  }

  it("passes the action's own answer through, and leaves the request's body for the router", async () => {
    const request = saveRequest();
    const answer = { ok: true, nonce: "n-1" };
    let sent = "";
    await expect(
      answerOrUnreachable(request, async () => {
        sent = await request.text();
        return answer;
      }),
    ).resolves.toBe(answer);
    expect(sent).toContain("nonce=n-1");
  });
});

describe("asUnreachableAnswer", () => {
  it("gives an unreachable write status 503, and leaves any other answer as it is", () => {
    const unreachable = { ok: false, reason: "unreachable", nonce: "n" };
    expect(asUnreachableAnswer(unreachable)).toMatchObject({ data: unreachable, init: { status: 503 } });
    const refused = { ok: false, nonce: "n" };
    expect(asUnreachableAnswer(refused)).toBe(refused);
  });
});

describe("the story route during an outage", () => {
  function Page() {
    const save = useFetcher();
    const status = useFetcher();
    // As the header's GitHub status is loaded: a fetcher's own loaded data, read again after an action by default.
    if (status.state === "idle" && status.data === undefined) status.load("/status");
    return (
      <>
        <p>the editor</p>
        <button type="button" onClick={() => save.submit({ intent: "save-step-field", nonce: "n-2", field: "question", value: "Q" }, { method: "post" })}>
          save
        </button>
        <output data-testid="answer">{save.data ? JSON.stringify(save.data) : ""}</output>
      </>
    );
  }

  async function saveDuringOutage(failure: unknown, answer: typeof clientAction = clientAction) {
    let outage = false;
    const reads = { page: 0, status: 0 };
    const read = (which: keyof typeof reads) => () => {
      reads[which] += 1;
      if (outage) throw new TypeError("Failed to fetch");
      return { which };
    };
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: Page,
        loader: read("page"),
        action: (args) => answer({ ...args, serverAction: () => Promise.reject(failure) } as never),
        ErrorBoundary: ErrorBoundary as never,
      },
      { path: "/status", loader: read("status") },
    ]);
    render(<Stub initialEntries={["/"]} />);
    await screen.findByText("the editor");
    await waitFor(() => expect(reads.status).toBe(1));
    const before = { ...reads };
    outage = true;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "save" }));
    });
    return { readsSince: () => ({ page: reads.page - before.page, status: reads.status - before.status }) };
  }

  for (const [what, failure] of IN_TRANSIT.slice(0, 2)) {
    it(`keeps the editor, reads nothing again, and answers the save as failed after ${what}`, async () => {
      const { readsSince } = await saveDuringOutage(failure);
      await waitFor(() => expect(screen.getByTestId("answer").textContent).toContain('"reason":"unreachable"'));
      expect(JSON.parse(screen.getByTestId("answer").textContent!)).toMatchObject({ ok: false, nonce: "n-2", intent: "save-step-field" });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(screen.getByText("the editor")).toBeTruthy();
      expect(readsSince()).toEqual({ page: 0, status: 0 });
    });
  }

  it("reaches the error card through the reads that follow, when the answer carries no failing status", async () => {
    const plain: typeof clientAction = async ({ request, serverAction }) => answerOrUnreachable(request, serverAction) as never;
    const { readsSince } = await saveDuringOutage(IN_TRANSIT[0][1], plain);
    await waitFor(() => expect(screen.queryByText("the editor")).toBeNull());
    expect(readsSince().page + readsSince().status).toBeGreaterThan(0);
  });
});

describe("a write that fails while another story is opening", () => {
  function Story() {
    const { storyId } = useLoaderData() as { storyId: string };
    const location = useLocation();
    const navigate = useNavigate();
    const save = useFetcher();
    return (
      <>
        <p data-testid="shown">{`${location.pathname} shows story ${storyId}`}</p>
        <button type="button" onClick={() => navigate("/stories/2")}>open story 2</button>
        <button type="button" onClick={() => save.submit({ intent: "save-step-field", nonce: "n-3", field: "question", value: "Q" }, { method: "post" })}>
          save
        </button>
      </>
    );
  }

  async function overtake(withShouldRevalidate: boolean) {
    let releaseTwo: () => void = () => {};
    const two = new Promise<void>((resolve) => (releaseTwo = resolve));
    const Stub = createRoutesStub([
      {
        path: "/stories/:storyId",
        Component: Story,
        loader: async ({ params }) => {
          if (params.storyId === "2") await two;
          return { storyId: params.storyId };
        },
        action: (args) => clientAction({ ...args, serverAction: () => Promise.reject(new TypeError("Failed to fetch")) } as never),
        ...(withShouldRevalidate ? { shouldRevalidate } : {}),
      },
    ]);
    render(<Stub initialEntries={["/stories/1"]} />);
    await screen.findByText("/stories/1 shows story 1");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "open story 2" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "save" }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(async () => {
      releaseTwo();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    return screen.getByTestId("shown").textContent;
  }

  it("lands on the other story with its own data", async () => {
    expect(await overtake(true)).toBe("/stories/2 shows story 2");
  });

  it("lands on the other story's address with the first story's data, without shouldRevalidate", async () => {
    expect(await overtake(false)).toBe("/stories/2 shows story 1");
  });
});

describe("a write that fails while another page is opening", () => {
  // As _app: a parent whose data another page reads (the release state Publish reads).
  function Shell() {
    return <Outlet />;
  }
  function Story() {
    const navigate = useNavigate();
    const save = useFetcher();
    return (
      <>
        <p>the story</p>
        <button type="button" onClick={() => navigate("/publish")}>open publish</button>
        <button type="button" onClick={() => save.submit({ intent: "save-step-field", nonce: "n-4", field: "question", value: "Q" }, { method: "post" })}>
          save
        </button>
      </>
    );
  }
  function Publish() {
    const shell = useRouteLoaderData("shell") as { reads: number };
    return <p data-testid="publish">{`publish reads the shell's read ${shell.reads}`}</p>;
  }

  async function overtake(withShouldRevalidate: boolean) {
    let shellReads = 0;
    let releasePublish: () => void = () => {};
    const publishReady = new Promise<void>((resolve) => (releasePublish = resolve));
    const guard = withShouldRevalidate ? { shouldRevalidate } : {};
    const Stub = createRoutesStub([
      {
        id: "shell",
        path: "/",
        Component: Shell,
        loader: () => ({ reads: ++shellReads }),
        ...guard,
        children: [
          {
            path: "story",
            Component: Story,
            loader: () => ({}),
            action: (args) => clientAction({ ...args, serverAction: () => Promise.reject(new TypeError("Failed to fetch")) } as never),
            ...guard,
          },
          {
            path: "publish",
            Component: Publish,
            loader: async () => {
              await publishReady;
              return {};
            },
          },
        ],
      },
    ]);
    render(<Stub initialEntries={["/story"]} />);
    await screen.findByText("the story");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "open publish" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "save" }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(async () => {
      releasePublish();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    return screen.getByTestId("publish").textContent;
  }

  it("reads the parent again for the page it lands on", async () => {
    expect(await overtake(true)).toBe("publish reads the shell's read 2");
  });

  it("lands with the parent's old data, without shouldRevalidate", async () => {
    expect(await overtake(false)).toBe("publish reads the shell's read 1");
  });

  it("holds back the read only on the page the write was made on", () => {
    const at = (href: string) => new URL(href, "http://stage.test");
    expect(readAnotherPage({ currentUrl: at("/stories/1"), nextUrl: at("/stories/1"), defaultShouldRevalidate: false })).toBe(false);
    expect(readAnotherPage({ currentUrl: at("/stories/1"), nextUrl: at("/stories/1"), defaultShouldRevalidate: true })).toBe(true);
    expect(readAnotherPage({ currentUrl: at("/stories/1"), nextUrl: at("/stories/2"), defaultShouldRevalidate: false })).toBe(true);
    expect(readAnotherPage({ currentUrl: at("/stories/1?step=2"), nextUrl: at("/stories/1?step=3"), defaultShouldRevalidate: true })).toBe(false);
    expect(readAnotherPage({ currentUrl: at("/stories/1?step=2"), nextUrl: at("/stories/1?step=2&lng=es"), defaultShouldRevalidate: true })).toBe(true);
  });
});

