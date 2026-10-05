// @vitest-environment jsdom
/**
 * A tab reloaded after another tab switched the session returns to its own
 * site before it shows the page: the site is remembered in
 * `sessionStorage`, compared with the one the server rendered, and the session
 * switched back through the dashboard's `switch-project` action.
 *
 * The router's layout loader stands in for the server, reading the site the
 * session names; the switch is answered by a stubbed `fetch`.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, Outlet, redirect, RouterProvider, useLoaderData } from "react-router";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

import { PageSiteProvider } from "~/lib/page-site";
import { forgetSite, holdRemembering, readRememberedSite, rememberSite, setTabSite } from "~/lib/tab-site";

// A reload remounts the page: the test decides what that does.
let reloadImpl: () => void = () => {};
let mounted: { unmount: () => void };
let loads = 0;
vi.mock("~/lib/tab-site", async (original) => ({
  ...(await original<typeof import("~/lib/tab-site")>()),
  reloadDocument: () => reloadImpl(),
}));
import { TabSiteGate } from "~/lib/use-reconcile-tab-site";
import InviteAcceptPage from "~/routes/_auth.invite.$token";

type Switch = { projectId: string };

let session: { site: number; handoff: number | null };
let switches: Switch[];
let answerSwitch: () => Promise<{ type: string; status: number }>;

beforeEach(() => {
  session = { site: 2, handoff: null };
  reloadImpl = () => {};
  switches = [];
  answerSwitch = async () => ({ type: "opaqueredirect", status: 0 });
  window.sessionStorage.clear();
  document.cookie = "telar_tab_site=; Max-Age=0; Path=/";
  window.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = init?.body as URLSearchParams;
    switches.push({ projectId: body.get("projectId")! });
    const answer = await answerSwitch();
    if (answer.type === "opaqueredirect") session.site = Number(body.get("projectId"));
    return answer;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  setTabSite(null);
  vi.restoreAllMocks();
});

function Shown() {
  const { site } = useLoaderData() as { site: number };
  return <p data-testid="shown">{`site ${site}`}</p>;
}

function ReloadedTab() {
  const { site, fromHandoff } = useLoaderData() as { site: number; fromHandoff: boolean };
  return (
    <TabSiteGate activeProjectId={site} siteFromHandoff={fromHandoff}>
      <PageSiteProvider activeProjectId={site}>
        <Shown />
        <Outlet />
      </PageSiteProvider>
    </TabSiteGate>
  );
}

function openTab() {
  loads = 0;
  const router = createMemoryRouter(
    [
      {
        path: "/",
        // The first read is the document request, which carries the hand-off
        // cookie; later reads are fetches, which name no site and read the session's.
        loader: () => {
          const fromDocument = loads++ === 0 && session.handoff !== null;
          return { site: fromDocument ? session.handoff : session.site, fromHandoff: fromDocument };
        },
        element: <ReloadedTab />,
        children: [{ index: true, element: null }],
      },
    ],
    { initialEntries: ["/"] },
  );
  mounted = render(<RouterProvider router={router} />);
  return mounted;
}

describe("a tab that remembers its site", () => {
  it("switches the session back after another tab switched it, and shows its own site", async () => {
    window.sessionStorage.setItem("telar.tab-site", "1");
    openTab();
    await waitFor(() => expect(screen.getByTestId("shown").textContent).toBe("site 1"));
    expect(switches).toEqual([{ projectId: "1" }]);
    expect(window.sessionStorage.getItem("telar.tab-site")).toBe("1");
  });

  it("shows nothing of the other site while the switch is in flight", async () => {
    window.sessionStorage.setItem("telar.tab-site", "1");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    answerSwitch = async () => {
      await gate;
      return { type: "opaqueredirect", status: 0 };
    };
    openTab();
    await waitFor(() => expect(switches).toHaveLength(1));
    expect(screen.queryByTestId("shown")).toBeNull();
    await act(async () => release());
    await waitFor(() => expect(screen.getByTestId("shown").textContent).toBe("site 1"));
  });

  it("shows the site the server rendered when the switch is refused", async () => {
    window.sessionStorage.setItem("telar.tab-site", "1");
    answerSwitch = async () => ({ type: "basic", status: 404 });
    openTab();
    await waitFor(() => expect(screen.getByTestId("shown").textContent).toBe("site 2"));
    await waitFor(() => expect(window.sessionStorage.getItem("telar.tab-site")).toBe("2"));
  });

  it("does not switch when the remembered site is the one rendered", async () => {
    window.sessionStorage.setItem("telar.tab-site", "2");
    openTab();
    await waitFor(() => expect(screen.getByTestId("shown").textContent).toBe("site 2"));
    expect(switches).toEqual([]);
  });
});

describe("a tab that remembers nothing", () => {
  it("takes the session's site and remembers it", async () => {
    openTab();
    await waitFor(() => expect(screen.getByTestId("shown").textContent).toBe("site 2"));
    expect(switches).toEqual([]);
    expect(readRememberedSite()).toBe(2);
  });
});

describe("a tab without sessionStorage", () => {
  it("behaves as before: the session's site, no switch, no error", async () => {
    const broken = () => {
      throw new DOMException("denied", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(broken);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(broken);
    expect(readRememberedSite()).toBeNull();
    expect(() => rememberSite(3)).not.toThrow();
    openTab();
    await waitFor(() => expect(screen.getByTestId("shown").textContent).toBe("site 2"));
    expect(switches).toEqual([]);
  });
});

describe("a fresh tab opened while a closed tab's hand-off is alive", () => {
  const cookieHandedOver = () => {
    // The closed tab (site 7) wrote the cookie; the session names site 2.
    session.handoff = 7;
    document.cookie = "telar_tab_site=7:%2F; Path=/";
  };
  const handoffCookieAlive = () => document.cookie.includes("telar_tab_site=");
  it("does not take the closed tab's site: it loads the page again and ends on the session's site", async () => {
    cookieHandedOver();
    const reloads = vi.fn();
    // A reload sends no cookie once the tab has cleared it, and remounts the page.
    reloadImpl = () => {
      reloads();
      queueMicrotask(() => {
        // The reload's document request carries the cookie if it is still there.
        session.handoff = handoffCookieAlive() ? 7 : null;
        mounted.unmount();
        openTab();
      });
    };
    openTab();
    await waitFor(() => expect(screen.getByTestId("shown").textContent).toBe("site 2"));
    expect(reloads).toHaveBeenCalledTimes(1);
    expect(handoffCookieAlive()).toBe(false);
    expect(readRememberedSite()).toBe(2);
    expect(switches).toEqual([]);
  });

  it("keeps the hand-off's site for a reload, which remembers it", async () => {
    cookieHandedOver();
    window.sessionStorage.setItem("telar.tab-site", "7");
    const reloads = vi.fn();
    reloadImpl = reloads;
    openTab();
    await waitFor(() => expect(screen.getByTestId("shown").textContent).toBe("site 7"));
    expect(reloads).not.toHaveBeenCalled();
    expect(switches).toEqual([]);
  });

  it("goes to the remembered site when that differs from both the hand-off's and the session's", async () => {
    cookieHandedOver();
    window.sessionStorage.setItem("telar.tab-site", "1");
    const reloads = vi.fn();
    reloadImpl = reloads;
    openTab();
    await waitFor(() => expect(screen.getByTestId("shown").textContent).toBe("site 1"));
    expect(switches).toEqual([{ projectId: "1" }]);
    expect(reloads).not.toHaveBeenCalled();
  });

  it("trusts the hand-off where sessionStorage is unavailable, as it cannot tell a fresh tab from a reload", async () => {
    cookieHandedOver();
    const storageDenied = () => {
      throw new DOMException("denied", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(storageDenied);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(storageDenied);
    const reloads = vi.fn();
    reloadImpl = reloads;
    openTab();
    await waitFor(() => expect(screen.getByTestId("shown").textContent).toBe("site 7"));
    expect(reloads).not.toHaveBeenCalled();
  });
});

describe("a tab whose own page outside the layout switched the session", () => {
  it("takes the site the session names once onboarding or an invitation forgot the old one", async () => {
    window.sessionStorage.setItem("telar.tab-site", "1");
    forgetSite();
    openTab();
    await waitFor(() => expect(screen.getByTestId("shown").textContent).toBe("site 2"));
    expect(switches).toEqual([]);
    expect(readRememberedSite()).toBe(2);
  });

  it("ends on the session's site when a hand-off naming the old site is still alive", async () => {
    window.sessionStorage.setItem("telar.tab-site", "1");
    forgetSite();
    session.handoff = 1;
    document.cookie = "telar_tab_site=1:%2F; Path=/";
    reloadImpl = () =>
      queueMicrotask(() => {
        session.handoff = document.cookie.includes("telar_tab_site=") ? 1 : null;
        mounted.unmount();
        openTab();
      });
    openTab();
    await waitFor(() => expect(screen.getByTestId("shown").textContent).toBe("site 2"));
    expect(switches).toEqual([]);
    expect(readRememberedSite()).toBe(2);
  });

  it("lands on the invited site after joining, not the one the tab showed before", async () => {
    session.site = 1;
    window.sessionStorage.setItem("telar.tab-site", "1");
    const router = createMemoryRouter(
      [
        {
          path: "/invite/:token",
          loader: () => ({ state: "ready", projectName: "site2", ownerLogin: "owner", token: "t" }),
          action: () => {
            session.site = 2;
            return redirect("/");
          },
          element: <InviteAcceptPage />,
        },
        {
          path: "/",
          loader: () => ({ site: session.site, fromHandoff: false }),
          element: <ReloadedTab />,
          children: [{ index: true, element: null }],
        },
      ],
      { initialEntries: ["/invite/t"] },
    );
    render(<RouterProvider router={router} />);
    fireEvent.click(await screen.findByRole("button", { name: "accept_join" }));
    await waitFor(() => expect(screen.getByTestId("shown").textContent).toBe("site 2"));
    expect(switches).toEqual([]);
    expect(readRememberedSite()).toBe(2);
  });

  it("keeps the site it showed when the join is refused, and switches the session back to it", async () => {
    // Another tab switched the session to 2; the invitation was spent by someone else.
    window.sessionStorage.setItem("telar.tab-site", "1");
    const router = createMemoryRouter(
      [
        {
          path: "/invite/:token",
          loader: () => ({ state: "ready", projectName: "site3", ownerLogin: "owner", token: "t" }),
          action: () => ({ error: "consumed" }),
          element: <InviteAcceptPage />,
        },
        {
          path: "/",
          loader: () => ({ site: session.site, fromHandoff: false }),
          element: <ReloadedTab />,
          children: [{ index: true, element: null }],
        },
      ],
      { initialEntries: ["/invite/t"] },
    );
    render(<RouterProvider router={router} />);
    fireEvent.click(await screen.findByRole("button", { name: "accept_join" }));
    await waitFor(() => expect(Object.values(router.state.actionData ?? {})).toEqual([{ error: "consumed" }]));
    await waitFor(() => expect(readRememberedSite()).toBe(1));
    await act(async () => router.navigate("/"));
    await waitFor(() => expect(screen.getByTestId("shown").textContent).toBe("site 1"));
    expect(switches).toEqual([{ projectId: "1" }]);
  });
});

describe("a hold left by a reconcile the author walked away from", () => {
  const pendingReconcile = () => {
    window.sessionStorage.setItem("telar.tab-site", "1");
    answerSwitch = () => new Promise(() => {});
    openTab();
  };

  it("is released when the layout unmounts", async () => {
    pendingReconcile();
    await waitFor(() => expect(switches).toHaveLength(1));
    mounted.unmount();
    rememberSite(5);
    expect(readRememberedSite()).toBe(5);
  });

  it("does not stop a page outside the layout from forgetting the site", () => {
    window.sessionStorage.setItem("telar.tab-site", "1");
    holdRemembering(true);
    expect(forgetSite()).toBe(1);
    expect(readRememberedSite()).toBeNull();
    rememberSite(2);
    expect(readRememberedSite()).toBe(2);
  });

  it("does not switch the session back after the author left for an invitation and joined", async () => {
    pendingReconcile();
    await waitFor(() => expect(switches).toHaveLength(1));
    mounted.unmount();
    forgetSite();
    session.site = 3;
    answerSwitch = async () => ({ type: "opaqueredirect", status: 0 });
    openTab();
    await waitFor(() => expect(screen.getByTestId("shown").textContent).toBe("site 3"));
    expect(switches).toEqual([{ projectId: "1" }]);
    expect(readRememberedSite()).toBe(3);
  });
});
