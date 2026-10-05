// @vitest-environment jsdom
/**
 * The collaboration panel's read of the contribution record never reaches the
 * error card.
 *
 * The Contributions route's real `clientLoader`, driven directly and in a
 * memory router (with the route's `clientLoader` as the loader and
 * `serverLoader` supplied, since `createRoutesStub` does not wire
 * `clientLoader`): read as the panel's (`?panel=record`), a failed read
 * answers `{ unreachable: true }` and a redirect is thrown on; read as the
 * page, the failure reaches the route's error boundary as before; and after a
 * later successful action the panel's record is read again.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, redirect, RouterProvider, UNSAFE_ErrorResponseImpl, useFetcher } from "react-router";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("~/lib/db.server", () => ({ getDb: () => ({}) }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));

import { clientLoader } from "~/routes/_app.contributions";

const PANEL = "http://stage.test/contributions?panel=record";
const PAGE = "http://stage.test/contributions";

function load(url: string, serverLoader: () => Promise<unknown>) {
  return clientLoader({ request: new Request(url), serverLoader } as never);
}

const FAILURES: Array<[string, unknown]> = [
  ["a request that never completes", new TypeError("Failed to fetch")],
  ["a bare 503", new UNSAFE_ErrorResponseImpl(503, "Service Unavailable", "upstream")],
  ["an undecodable answer", new Error("Unable to decode turbo-stream response")],
  ["a refusal", new UNSAFE_ErrorResponseImpl(403, "Forbidden", "Forbidden")],
];

describe("the Contributions route's clientLoader, driven directly", () => {
  for (const [what, failure] of FAILURES) {
    it(`answers the panel's read after ${what} as unreachable`, async () => {
      await expect(load(PANEL, () => Promise.reject(failure))).resolves.toEqual({ unreachable: true });
    });

    it(`throws the page's read after ${what} on unchanged`, async () => {
      await expect(load(PAGE, () => Promise.reject(failure))).rejects.toBe(failure);
    });
  }

  it("throws a redirect on, for the panel's read too", async () => {
    const signIn = redirect("/signin");
    await expect(load(PANEL, () => Promise.reject(signIn))).rejects.toBe(signIn);
  });

  it("returns a successful read as it is", async () => {
    const record = { members: [], currentUserId: 1 };
    await expect(load(PANEL, async () => record)).resolves.toBe(record);
    await expect(load(PAGE, async () => record)).resolves.toBe(record);
  });
});

describe("the Contributions route's clientLoader, in a memory router", () => {
  function Panel() {
    const record = useFetcher();
    const write = useFetcher();
    if (record.state === "idle" && record.data === undefined) record.load("/contributions?panel=record");
    return (
      <>
        <p>the page</p>
        <output data-testid="record">{record.data === undefined ? "" : JSON.stringify(record.data)}</output>
        <button type="button" onClick={() => write.submit({ intent: "save" }, { method: "post", action: "/write" })}>
          write
        </button>
      </>
    );
  }

  function mount(serverLoader: () => Promise<unknown>, initial = "/") {
    const reads = { count: 0 };
    const router = createMemoryRouter(
      [
        {
          path: "/",
          Component: Panel,
          ErrorBoundary: () => <p>the error card</p>,
        },
        {
          path: "/contributions",
          loader: (args) => {
            reads.count += 1;
            return clientLoader({ ...args, serverLoader } as never);
          },
          Component: () => <p>the record page</p>,
          ErrorBoundary: () => <p>the error card</p>,
        },
        { path: "/write", action: () => ({ ok: true }) },
      ],
      { initialEntries: [initial] },
    );
    render(<RouterProvider router={router} />);
    return reads;
  }

  it("keeps the page open when the panel's read fails, and reads the record again after a successful action", async () => {
    let outage = true;
    const reads = mount(async () => {
      if (outage) throw new TypeError("Failed to fetch");
      return { members: [], currentUserId: 7 };
    });
    await waitFor(() => expect(screen.getByTestId("record").textContent).toBe('{"unreachable":true}'));
    expect(screen.getByText("the page")).toBeTruthy();
    expect(screen.queryByText("the error card")).toBeNull();
    const before = reads.count;

    outage = false;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "write" }));
    });
    await waitFor(() => expect(screen.getByTestId("record").textContent).toContain('"currentUserId":7'));
    expect(reads.count).toBe(before + 1);
  });

  it("sends the page's own failed read to its error boundary", async () => {
    mount(() => Promise.reject(new TypeError("Failed to fetch")), "/contributions");
    await screen.findByText("the error card");
    expect(screen.queryByText("the record page")).toBeNull();
  });
});
