// @vitest-environment jsdom
/**
 * The page-specific background reads that fail in transit leave the page open
 *: Upgrade's build poll and its explicit reload, and the Pages
 * scan.
 *
 * Each route's real `clientAction` (and Upgrade's `clientLoader`) is driven
 * directly, and then in a memory router next to a route without one, where the
 * same failure reaches the error card.
 *
 * @version v1.5.0-beta
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
import { cleanup, render, screen, waitFor, act } from "@testing-library/react";
import { createMemoryRouter, Outlet, redirect, RouterProvider, useFetcher, useLoaderData, useRevalidator, UNSAFE_ErrorResponseImpl } from "react-router";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("~/lib/db.server", () => ({ getDb: () => ({}) }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: () => ({ getSession: async () => ({ get: () => undefined }) }),
}));

import { clientAction as upgradeClientAction, clientLoader as upgradeClientLoader } from "~/routes/_app.upgrade";
import { clientAction as pagesClientAction } from "~/routes/_app.pages";
import { keptLoaderData, readOrKept, useKeepLoaderData, useReloadableLoaderData } from "~/lib/kept-loader-data";

afterEach(cleanup);

function upgradeFormSubmission(fields: Record<string, string>) {
  return new Request("http://stage.test/x", { method: "POST", body: new URLSearchParams(fields) });
}

const TRANSIT_FAILURES = () => [new TypeError("Failed to fetch"), new UNSAFE_ErrorResponseImpl(503, "Service Unavailable", "")];

describe.each([
  ["Upgrade", upgradeClientAction, "poll-build", ["upgrade-prepare", "rebuild", "upgrade-commit"]],
  ["Pages", pagesClientAction, "scan-repo-pages", ["import-pages", "autosave-page-body"]],
] as const)("the %s route's clientAction", (_name, clientAction, readIntent, writeIntents) => {
  it("answers its read failing in transit as unreachable, with its intent and status 503", async () => {
    for (const failure of TRANSIT_FAILURES()) {
      const answer = await clientAction({
        request: upgradeFormSubmission({ intent: readIntent }),
        serverAction: () => Promise.reject(failure),
      } as never);
      expect(answer).toMatchObject({ data: { ok: false, reason: "unreachable", intent: readIntent }, init: { status: 503 } });
    }
  });

  it("returns the read's own answer and throws its redirect on", async () => {
    const found = { ok: true, intent: readIntent };
    await expect(
      clientAction({ request: upgradeFormSubmission({ intent: readIntent }), serverAction: async () => found } as never),
    ).resolves.toBe(found);
    const signIn = redirect("/signin");
    await expect(
      clientAction({ request: upgradeFormSubmission({ intent: readIntent }), serverAction: () => Promise.reject(signIn) } as never),
    ).rejects.toBe(signIn);
  });

  it("passes every other intent through: a failure is thrown unchanged", async () => {
    const failure = new TypeError("Failed to fetch");
    for (const intent of writeIntents) {
      await expect(
        clientAction({ request: upgradeFormSubmission({ intent }), serverAction: () => Promise.reject(failure) } as never),
      ).rejects.toBe(failure);
    }
  });
});

describe("Upgrade's clientLoader", () => {
  function Keeper({ data }: { data: unknown }) {
    useKeepLoaderData("upgrade", data);
    return null;
  }

  it("answers the page's data where the read fails in transit while the page is mounted", async () => {
    const onScreen = { needsUpgrade: true };
    const view = render(<Keeper data={onScreen} />);
    for (const failure of TRANSIT_FAILURES()) {
      await expect(upgradeClientLoader({ serverLoader: () => Promise.reject(failure) } as never)).resolves.toBe(onScreen);
    }
    const fresh = { needsUpgrade: false };
    await expect(upgradeClientLoader({ serverLoader: async () => fresh } as never)).resolves.toBe(fresh);
    view.unmount();
    expect(keptLoaderData("upgrade")).toBeUndefined();
  });

  it("throws the failure on when nothing is kept, for a redirect and for a refusal", async () => {
    const failure = new TypeError("Failed to fetch");
    await expect(upgradeClientLoader({ serverLoader: () => Promise.reject(failure) } as never)).rejects.toBe(failure);

    render(<Keeper data={{ needsUpgrade: true }} />);
    const signIn = redirect("/signin");
    await expect(upgradeClientLoader({ serverLoader: () => Promise.reject(signIn) } as never)).rejects.toBe(signIn);
    const refused = new UNSAFE_ErrorResponseImpl(403, "Forbidden", "");
    await expect(upgradeClientLoader({ serverLoader: () => Promise.reject(refused) } as never)).rejects.toBe(refused);
  });
});

describe("Upgrade's page", () => {
  // A text check, labelled as one: the page is too heavy to mount here, so this
  // pins only that it hands its loader data to the key its clientLoader reads.
  it("keeps its loader data under the key the clientLoader reads (text check)", () => {
    const source = readFileSync(join(__dirname, "../app/routes/_app.upgrade.tsx"), "utf8");
    expect(source).toContain("useReloadableLoaderData(UPGRADE_LOADER_KEY, routedData, \"/upgrade\")");
    expect(source).toContain("readOrKept(UPGRADE_LOADER_KEY, serverLoader)");
  });
});

describe("a read that fails in transit, in a router", () => {
  function Poller() {
    const fetcher = useFetcher<{ reason?: string }>();
    return (
      <div>
        <button type="button" onClick={() => fetcher.submit({ intent: "poll-build" }, { method: "post", action: "/page" })}>
          poll
        </button>
        <p data-testid="answer">{fetcher.data?.reason ?? "none"}</p>
      </div>
    );
  }

  function mountFailingPoll(withClientAction: boolean) {
    const inTransit = () => Promise.reject(new TypeError("Failed to fetch"));
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <Poller />,
          errorElement: <p data-testid="error-card">error card</p>,
        },
        {
          path: "/page",
          element: null,
          errorElement: <p data-testid="error-card">error card</p>,
          action: withClientAction
            ? ({ request }) => upgradeClientAction({ request, serverAction: inTransit } as never)
            : inTransit,
        },
      ],
      { initialEntries: ["/"] },
    );
    render(<RouterProvider router={router} />);
    return router;
  }

  it("takes a page without the client action to its error card", async () => {
    mountFailingPoll(false);
    await act(async () => {
      screen.getByText("poll").click();
    });
    await waitFor(() => expect(screen.getByTestId("error-card")).toBeTruthy());
  });

  it("leaves the page open, with the answer where the poll was made, when the route has it", async () => {
    mountFailingPoll(true);
    await act(async () => {
      screen.getByText("poll").click();
    });
    await waitFor(() => expect(screen.getByTestId("answer").textContent).toBe("unreachable"));
    expect(screen.queryByTestId("error-card")).toBeNull();
  });
});

describe("an explicit reload while the app shell's own read fails", () => {
  // The shell's loader and the page's both fail from the second read on. The
  // page's `clientLoader` answers with the data on screen; the shell's has no
  // such answer, so a reload that reads the shell too replaces the page.
  function mountReloadingPage(reloadWith: "revalidate" | "own-loader") {
    let shellReads = 0;
    let pageReads = 0;
    function ReloadingPage() {
      const routed = useLoaderData() as { release: string };
      const { data, reload } = useReloadableLoaderData("reload-test", routed, "/page");
      const revalidator = useRevalidator();
      return (
        <div>
          <p data-testid="release">{data.release}</p>
          <button type="button" onClick={reloadWith === "own-loader" ? reload : () => revalidator.revalidate()}>
            reload
          </button>
        </div>
      );
    }
    const router = createMemoryRouter(
      [
        {
          path: "/",
          id: "shell",
          loader: () => {
            shellReads += 1;
            if (shellReads > 1) throw new TypeError("Failed to fetch");
            return null;
          },
          element: <Outlet />,
          errorElement: <p data-testid="error-card">error card</p>,
          children: [
            {
              path: "page",
              loader: () =>
                readOrKept("reload-test", async () => {
                  pageReads += 1;
                  if (pageReads === 2) throw new TypeError("Failed to fetch");
                  return { release: pageReads === 1 ? "1.0" : "2.0" };
                }),
              element: <ReloadingPage />,
            },
          ],
        },
      ],
      { initialEntries: ["/page"] },
    );
    render(<RouterProvider router={router} />);
  }

  it("takes the page to the shell's error card when it revalidates every loader", async () => {
    mountReloadingPage("revalidate");
    await waitFor(() => expect(screen.getByTestId("release")).toBeTruthy());
    await act(async () => {
      screen.getByText("reload").click();
    });
    await waitFor(() => expect(screen.getByTestId("error-card")).toBeTruthy());
  });

  it("keeps the page, showing the data it had, when it reads only its own loader", async () => {
    mountReloadingPage("own-loader");
    await waitFor(() => expect(screen.getByTestId("release").textContent).toBe("1.0"));
    await act(async () => {
      screen.getByText("reload").click();
    });
    await waitFor(() => expect(screen.getByTestId("release").textContent).toBe("1.0"));
    expect(screen.queryByTestId("error-card")).toBeNull();
    await act(async () => {
      screen.getByText("reload").click();
    });
    await waitFor(() => expect(screen.getByTestId("release").textContent).toBe("2.0"));
  });
});

describe("useReloadableLoaderData", () => {
  it("shows a reload's answer until the router gives newer data, then the router's", async () => {
    let setRouted: (v: { v: string }) => void = () => {};
    function ReloadHarness() {
      const [routed, set] = useState({ v: "routed-1" });
      setRouted = set;
      const { data, reload } = useReloadableLoaderData("harness", routed, "/fetched");
      return (
        <div>
          <p data-testid="value">{data.v}</p>
          <button type="button" onClick={reload}>
            reload
          </button>
        </div>
      );
    }
    const router = createMemoryRouter(
      [
        { path: "/", element: <ReloadHarness /> },
        { path: "/fetched", loader: () => ({ v: "fetched" }), element: null },
      ],
      { initialEntries: ["/"] },
    );
    render(<RouterProvider router={router} />);
    await act(async () => {
      screen.getByText("reload").click();
    });
    await waitFor(() => expect(screen.getByTestId("value").textContent).toBe("fetched"));
    act(() => setRouted({ v: "routed-2" }));
    expect(screen.getByTestId("value").textContent).toBe("routed-2");
  });
});
