// @vitest-environment jsdom
/**
 * A tab keeps its own site: the layout latches the site, the tab's
 * requests name it, and another tab's switch of the session does not move
 * this tab on revalidation.
 *
 * The router's loaders stand in for the server: each resolves the site as
 * `resolveActiveProjectFromRequest` does, from the site the tab's request
 * names (`currentTabSite()` at the time of the read) before the session's.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, Form, Outlet, redirect, RouterProvider, useLoaderData } from "react-router";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

import { PageSiteProvider, usePageSite } from "~/lib/page-site";
import { currentTabSite, installTabSiteHeader, setTabSite, TAB_SITE_HEADER, writeTabSiteCookie } from "~/lib/tab-site";

afterEach(() => {
  cleanup();
  setTabSite(null);
});

function TabSiteProbe() {
  const { latched, live } = usePageSite();
  return <span data-testid="site">{`${latched}/${live}`}</span>;
}

function tabRouter() {
  const session = { site: 1 };
  const seen: Array<number | null> = [];
  function TabSiteLayout() {
    const { site } = useLoaderData() as { site: number };
    return (
      <PageSiteProvider activeProjectId={site}>
        <TabSiteProbe />
        <Form method="post" action="/switch">
          <input type="hidden" name="intent" value="switch-project" />
          <input type="hidden" name="projectId" value="3" />
          <button type="submit">switch</button>
        </Form>
        <Outlet />
      </PageSiteProvider>
    );
  }
  const router = createMemoryRouter(
    [
      {
        path: "/",
        loader: () => {
          const named = currentTabSite();
          seen.push(named);
          return { site: named ?? session.site };
        },
        element: <TabSiteLayout />,
        children: [
          { index: true, element: <p>a</p> },
          { path: "b", element: <p>b</p> },
          {
            path: "switch",
            action: () => {
              session.site = 3;
              return redirect("/b");
            },
          },
        ],
      },
    ],
    { initialEntries: ["/"] },
  );
  const view = render(<RouterProvider router={router} />);
  return { router, session, seen, view };
}

describe("a tab's site across another tab's switch", () => {
  it("reloads for the site the tab showed, not the one the session now names", async () => {
    const { router, session } = tabRouter();
    await waitFor(() => expect(screen.getByTestId("site").textContent).toBe("1/1"));
    expect(currentTabSite()).toBe(1);
    session.site = 2;
    await act(async () => {
      await router.revalidate();
    });
    expect(screen.getByTestId("site").textContent).toBe("1/1");
    await act(async () => {
      await router.navigate("/b");
    });
    expect(screen.getByTestId("site").textContent).toBe("1/1");
  });

  it("reads the site being switched to while a switch made in this tab is in flight, then names it", async () => {
    const { router, seen } = tabRouter();
    await waitFor(() => expect(screen.getByTestId("site").textContent).toBe("1/1"));
    seen.length = 0;
    fireEvent.click(screen.getByText("switch"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/b"));
    await waitFor(() => expect(screen.getByTestId("site").textContent).toBe("3/3"));
    expect(seen).toContain(null);
    expect(currentTabSite()).toBe(3);
  });

  it("names the site to a child's mount effect, which runs before the layout's own", async () => {
    let seenByChild: number | null | undefined;
    function TabSiteChild() {
      useEffect(() => {
        seenByChild = currentTabSite();
      }, []);
      return null;
    }
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: (
            <PageSiteProvider activeProjectId={7}>
              <TabSiteChild />
            </PageSiteProvider>
          ),
        },
      ],
      { initialEntries: ["/"] },
    );
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(seenByChild).toBe(7));
  });

  it("names no site once the layout unmounts", async () => {
    const { view } = tabRouter();
    await waitFor(() => expect(currentTabSite()).toBe(1));
    view.unmount();
    expect(currentTabSite()).toBeNull();
  });
});

describe("installTabSiteHeader", () => {
  it("adds the tab's site to a same-origin request, keeps a header the caller set, and leaves other origins alone", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    window.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response("{}");
    }) as unknown as typeof fetch;
    installTabSiteHeader();
    installTabSiteHeader();

    await window.fetch("/objects.data");
    expect(calls[0].headers.has(TAB_SITE_HEADER)).toBe(false);

    setTabSite(11);
    await window.fetch("/objects.data", { headers: { Accept: "text/x-script" } });
    expect(calls[1].headers.get(TAB_SITE_HEADER)).toBe("11");
    expect(calls[1].headers.get("Accept")).toBe("text/x-script");

    await window.fetch(`${window.location.origin}/api/site-status`, { headers: { [TAB_SITE_HEADER]: "5" } });
    expect(calls[2].headers.get(TAB_SITE_HEADER)).toBe("5");

    await window.fetch("https://api.github.com/user");
    expect(calls[3].headers.has(TAB_SITE_HEADER)).toBe(false);
    expect(calls).toHaveLength(4);
  });
});

describe("the hand-off cookie a tab writes as it unloads", () => {
  const cookieOf = () => document.cookie.split("; ").find((c) => c.startsWith("telar_tab_site="));

  function mountSite(id: number) {
    function Site() {
      return (
        <PageSiteProvider activeProjectId={id}>
          <p>site</p>
        </PageSiteProvider>
      );
    }
    const router = createMemoryRouter([{ path: "/", element: <Site /> }], { initialEntries: ["/"] });
    return render(<RouterProvider router={router} />);
  }

  const CLOSED_TAB = "telar_tab_site=5:%2Fobjects";

  beforeEach(() => window.history.pushState({}, "", "/objects"));
  afterEach(() => {
    document.cookie = "telar_tab_site=; Max-Age=0; Path=/objects";
    window.history.pushState({}, "", "/");
  });

  it("writes the latched site on pagehide and on beforeunload", async () => {
    mountSite(5);
    await waitFor(() => expect(currentTabSite()).toBe(5));
    expect(cookieOf()).toBeUndefined();
    window.dispatchEvent(new Event("pagehide"));
    expect(cookieOf()).toBe(CLOSED_TAB);
    document.cookie = "telar_tab_site=; Max-Age=0; Path=/objects";
    window.dispatchEvent(new Event("beforeunload"));
    expect(cookieOf()).toBe(CLOSED_TAB);
  });

  it("writes it short-lived, for the page it was written on, and Secure only over https", () => {
    const written: string[] = [];
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")!;
    Object.defineProperty(document, "cookie", { configurable: true, get: () => "", set: (v: string) => written.push(v) });
    try {
      writeTabSiteCookie(5);
      expect(written[0]).toBe("telar_tab_site=5:%2Fobjects; Max-Age=15; Path=/objects; SameSite=Lax");
      writeTabSiteCookie(null);
      expect(written).toHaveLength(1);
    } finally {
      delete (document as { cookie?: string }).cookie;
      Object.defineProperty(Document.prototype, "cookie", descriptor);
    }
  });

  it("is not sent to a fresh tab at another path, only to a load of the page it was written on", async () => {
    mountSite(5);
    window.dispatchEvent(new Event("pagehide"));
    expect(cookieOf()).toBe(CLOSED_TAB);
    window.history.pushState({}, "", "/publish");
    expect(cookieOf()).toBeUndefined();
    window.history.pushState({}, "", "/objects");
    expect(cookieOf()).toBe(CLOSED_TAB);
  });

  it("clears a hand-off left by the page this one replaced once the tab has latched", async () => {
    document.cookie = `${CLOSED_TAB}; Path=/objects`;
    expect(cookieOf()).toBe(CLOSED_TAB);
    mountSite(5);
    await waitFor(() => expect(cookieOf()).toBeUndefined());
  });

  it("clears it when the browser restores the page, and writes nothing once the layout unmounts", async () => {
    const view = mountSite(5);
    window.dispatchEvent(new Event("pagehide"));
    expect(cookieOf()).toBe(CLOSED_TAB);
    window.dispatchEvent(new Event("pageshow"));
    expect(cookieOf()).toBeUndefined();
    view.unmount();
    window.dispatchEvent(new Event("pagehide"));
    expect(cookieOf()).toBeUndefined();
  });
});
