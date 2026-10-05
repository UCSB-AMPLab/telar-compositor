// @vitest-environment jsdom
/**
 * A background read that fails keeps the last good answer.
 *
 * `useBackgroundRead` runs in a real memory router, with `fetch` stubbed: a
 * seeded answer survives every kind of failed read, the next beat reads again
 * and a later success replaces it; a change of URL or project drops the kept
 * answer, and an answer that arrives for a superseded scope is discarded;
 * unmounting aborts the read in flight; focus reads; and a completed
 * submission, fetcher or navigation, reads once, while a GET navigation does
 * not read.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createContext, useContext } from "react";
import { createMemoryRouter, Form, Link, Outlet, RouterProvider, useFetcher } from "react-router";
import { useBackgroundRead, type BackgroundReadOptions } from "~/hooks/use-background-read";

type Answer = Pick<Response, "ok" | "redirected" | "status" | "json">;

function answer(data: unknown, status = 200, redirected = false): Answer {
  return { ok: status >= 200 && status < 300, redirected, status, json: async () => data };
}

function notJson(status = 200): Answer {
  return { ok: true, redirected: false, status, json: async () => { throw new SyntaxError("Unexpected token <"); } };
}

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Answer>>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const Options = createContext<BackgroundReadOptions>({ url: null, enabled: false, scope: null });

function Reader() {
  const data = useBackgroundRead<unknown>(useContext(Options));
  return <output data-testid="data">{data === undefined ? "none" : JSON.stringify(data)}</output>;
}

function Submitter() {
  const fetcher = useFetcher();
  return (
    <>
      <button type="button" onClick={() => fetcher.submit({ intent: "x" }, { method: "post" })}>fetcher submit</button>
      <Form method="post">
        <button type="submit">form submit</button>
      </Form>
      <Link to="/other">go elsewhere</Link>
    </>
  );
}

function mount(options: BackgroundReadOptions, action: () => unknown = () => ({ ok: true })) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        Component: () => (
          <>
            <Reader />
            <Outlet />
          </>
        ),
        children: [
          { index: true, Component: Submitter, action },
          // A loader, so the GET navigation is seen loading before it lands.
          { path: "other", Component: () => <p>elsewhere</p>, loader: async () => ({}) },
        ],
      },
    ],
    { initialEntries: ["/"] },
  );
  const view = render(
    <Options.Provider value={options}>
      <RouterProvider router={router} />
    </Options.Provider>,
  );
  return {
    ...view,
    router,
    set: (next: BackgroundReadOptions) =>
      view.rerender(
        <Options.Provider value={next}>
          <RouterProvider router={router} />
        </Options.Provider>,
      ),
  };
}

const shown = () => screen.getByTestId("data").textContent;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

const STATUS: BackgroundReadOptions = { url: "/api/site-status?payload=gh-status", enabled: true, scope: 1 };

describe("a failed read keeps the last good answer", () => {
  const FAILURES: Array<[string, () => Promise<Answer>]> = [
    ["a rejected request", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["an answer that is not JSON", () => Promise.resolve(notJson())],
    ["a redirected answer", () => Promise.resolve(answer({ signedOut: true }, 200, true))],
    ["a 401", () => Promise.resolve(answer({ error: "unauthorized" }, 401))],
    ["a JSON 503", () => Promise.resolve(answer({ error: "unavailable" }, 503))],
    ["a 404", () => Promise.resolve(answer("Not Found", 404))],
  ];

  for (const [what, failure] of FAILURES) {
    it(`after ${what}, reads again on the next beat, and a later success replaces it`, async () => {
      fetchMock.mockResolvedValueOnce(answer({ n: 1 }));
      fetchMock.mockImplementation(failure);
      mount({ ...STATUS, intervalMs: 25 });
      await waitFor(() => expect(shown()).toBe('{"n":1}'));

      await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3));
      expect(shown()).toBe('{"n":1}');
      expect(console.warn).toHaveBeenCalledTimes(1);

      fetchMock.mockImplementation(() => Promise.resolve(answer({ n: 2 })));
      await waitFor(() => expect(shown()).toBe('{"n":2}'));
    });
  }
});

describe("the kept answer belongs to its scope", () => {
  it("drops it when the URL changes", async () => {
    fetchMock.mockResolvedValueOnce(answer({ payload: "in-sync" }));
    const { set } = mount({ ...STATUS, url: "/api/site-status?payload=in-sync" });
    await waitFor(() => expect(shown()).toBe('{"payload":"in-sync"}'));
    fetchMock.mockImplementation(() => new Promise(() => {}));
    set({ ...STATUS, url: "/api/site-status?payload=unpublished" });
    await settle();
    expect(shown()).toBe("none");
  });

  it("drops it when the project changes", async () => {
    fetchMock.mockResolvedValueOnce(answer({ project: 1 }));
    const { set } = mount(STATUS);
    await waitFor(() => expect(shown()).toBe('{"project":1}'));
    fetchMock.mockImplementation(() => new Promise(() => {}));
    set({ ...STATUS, scope: 2 });
    await settle();
    expect(shown()).toBe("none");
  });

  it("discards an answer that arrives for a superseded project", async () => {
    let answerOne: (a: Answer) => void = () => {};
    let answerTwo: (a: Answer) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => (answerOne = resolve)));
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => (answerTwo = resolve)));
    const { set } = mount(STATUS);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    set({ ...STATUS, scope: 2 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => answerOne(answer({ project: 1 })));
    await settle();
    expect(shown()).toBe("none");

    await act(async () => answerTwo(answer({ project: 2 })));
    await waitFor(() => expect(shown()).toBe('{"project":2}'));
  });

  it("aborts the read in flight on unmount", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const { unmount } = mount(STATUS);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const signal = fetchMock.mock.calls[0][1]?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });
});

describe("when it reads", () => {
  it("reads again when the window regains focus", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(answer({ ok: 1 })));
    mount({ ...STATUS, onFocus: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reads once after a fetcher submission completes, and not while it is in flight", async () => {
    let finish: () => void = () => {};
    const finished = new Promise<void>((resolve) => (finish = resolve));
    fetchMock.mockImplementation(() => Promise.resolve(answer({ ok: 1 })));
    mount({ ...STATUS, afterActions: true }, async () => {
      await finished;
      return { ok: true };
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "fetcher submit" }));
    });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => finish());
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reads once after a navigation submission completes", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(answer({ ok: 1 })));
    mount({ ...STATUS, afterActions: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "form submit" }));
    });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not read after a GET navigation", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(answer({ ok: 1 })));
    mount({ ...STATUS, afterActions: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      fireEvent.click(screen.getByRole("link", { name: "go elsewhere" }));
    });
    await screen.findByText("elsewhere");
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
