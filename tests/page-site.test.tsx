// @vitest-environment jsdom
/**
 * The client half of the page-site binding: the field every
 * site-level submit carries, the latch that decides its value, and the notice
 * that speaks for a refused write.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, data, Form, Outlet, redirect, RouterProvider, useLoaderData } from "react-router";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

import { addSiteToTarget, PageSiteProvider, usePageSite, useSiteFetcher } from "~/lib/page-site";
import { SiteChangedWatcher } from "~/components/features/site-status/SiteChangedNotice";

describe("addSiteToTarget", () => {
  it("adds siteId to a copy of a FormData, leaving the original as it was", () => {
    const fd = new FormData();
    fd.set("intent", "publish");
    const out = addSiteToTarget(fd, 11) as FormData;
    expect(out).not.toBe(fd);
    expect(out.get("intent")).toBe("publish");
    expect(out.get("siteId")).toBe("11");
    expect(fd.get("siteId")).toBeNull();
  });

  it("adds siteId to a copy of URLSearchParams", () => {
    const params = new URLSearchParams({ intent: "publish" });
    const out = addSiteToTarget(params, 11) as URLSearchParams;
    expect(out).not.toBe(params);
    expect(out.get("siteId")).toBe("11");
    expect(params.get("siteId")).toBeNull();
  });

  it("adds siteId to a plain object", () => {
    expect(addSiteToTarget({ intent: "publish" }, 11)).toEqual({ intent: "publish", siteId: "11" });
  });

  it("leaves the target alone outside a site", () => {
    const target = { intent: "publish" };
    expect(addSiteToTarget(target, null)).toBe(target);
  });
});

function Probe() {
  const { latched, live } = usePageSite();
  return <span data-testid="site">{`${latched}/${live}`}</span>;
}

/** A layout whose loader id the test changes without a navigation. */
function renderLayout(children: React.ReactNode = <Probe />) {
  let setId: (id: number) => void = () => {};
  function Layout() {
    const [id, set] = useState(1);
    setId = set;
    return (
      <PageSiteProvider activeProjectId={id}>
        {children}
        <Outlet />
      </PageSiteProvider>
    );
  }
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <Layout />,
        children: [
          { path: "a", element: null },
          { path: "b", element: null },
        ],
      },
    ],
    { initialEntries: ["/a"] },
  );
  render(<RouterProvider router={router} />);
  return { router, setId: (id: number) => setId(id) };
}

describe("PageSiteProvider", () => {
  it("keeps the site the page arrived with across a reload of the layout for another site", async () => {
    const { setId } = renderLayout();
    expect(screen.getByTestId("site").textContent).toBe("1/1");
    act(() => setId(2));
    expect(screen.getByTestId("site").textContent).toBe("1/2");
  });

  // The layout reads the session's site from its loader, as `_app` does.
  function sessionRouter() {
    const session = { site: 1, refuseSwitch: false };
    function Layout() {
      const { site } = useLoaderData() as { site: number };
      return (
        <PageSiteProvider activeProjectId={site}>
          <Probe />
          <SiteChangedWatcher />
          <Form method="post" action="/save">
            <button type="submit">save</button>
          </Form>
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
          loader: () => ({ site: session.site }),
          element: <Layout />,
          children: [
            { index: true, element: <p>a</p> },
            { path: "b", element: <p>b</p> },
            {
              path: "save",
              action: () =>
                data({ ok: false, error: "site_changed", currentSiteName: "owner/two" }, { status: 409 }),
            },
            {
              path: "switch",
              action: () => {
                if (session.refuseSwitch) return data({ ok: false }, { status: 404 });
                session.site = 3;
                return redirect("/b");
              },
            },
          ],
        },
      ],
      { initialEntries: ["/"] },
    );
    render(<RouterProvider router={router} />);
    return { router, session };
  }

  function Probe() {
    const { latched, live } = usePageSite();
    return <span data-testid="site">{`${latched}/${live}`}</span>;
  }

  it("keeps the site through navigations and a refused form after another tab switched", async () => {
    const { router, session } = sessionRouter();
    await waitFor(() => expect(screen.getByTestId("site").textContent).toBe("1/1"));
    session.site = 2;
    await act(async () => {
      await router.revalidate();
    });
    expect(screen.getByTestId("site").textContent).toBe("1/2");
    await act(async () => {
      await router.navigate("/b");
    });
    expect(screen.getByTestId("site").textContent).toBe("1/2");
    fireEvent.click(screen.getByText("save"));
    await waitFor(() => expect(router.state.navigation.state).toBe("idle"));
    expect(screen.getByTestId("site").textContent.startsWith("1/")).toBe(true);
  });

  it("keeps the site when a switch made in this tab does not land", async () => {
    const { router, session } = sessionRouter();
    await waitFor(() => expect(screen.getByTestId("site").textContent).toBe("1/1"));
    session.site = 2;
    session.refuseSwitch = true;
    await act(async () => {
      await router.revalidate();
    });
    fireEvent.click(screen.getByText("switch"));
    await waitFor(() => expect(router.state.navigation.state).toBe("idle"));
    await act(async () => {
      await router.revalidate();
    });
    expect(screen.getByTestId("site").textContent).toBe("1/2");
  });

  it("takes the new site after a switch made in this tab", async () => {
    const { router } = sessionRouter();
    await waitFor(() => expect(screen.getByTestId("site").textContent).toBe("1/1"));
    fireEvent.click(screen.getByText("switch"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/b"));
    await waitFor(() => expect(screen.getByTestId("site").textContent).toBe("3/3"));
  });
});

describe("SiteChangedWatcher", () => {
  it("shows the stopped notice for a site fetcher whose action refused a changed site, and posts the latched site", async () => {
    const posted: Array<FormDataEntryValue | null> = [];
    function Submitter() {
      const fetcher = useSiteFetcher();
      return (
        <button type="button" onClick={() => fetcher.submit({ intent: "publish" }, { method: "post", action: "/act" })}>
          go
        </button>
      );
    }
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: (
            <PageSiteProvider activeProjectId={1}>
              <SiteChangedWatcher />
              <Submitter />
            </PageSiteProvider>
          ),
        },
        {
          path: "/act",
          action: async ({ request }) => {
            posted.push((await request.formData()).get("siteId"));
            return data(
              { ok: false, intent: "publish", error: "site_changed", currentSiteName: "owner/other" },
              { status: 409 },
            );
          },
        },
      ],
      { initialEntries: ["/"] },
    );
    render(<RouterProvider router={router} />);
    expect(screen.queryByText("site_changed.body_stopped")).toBeNull();
    fireEvent.click(screen.getByText("go"));
    await waitFor(() => expect(screen.queryByText("site_changed.body_stopped")).not.toBeNull());
    expect(posted).toEqual(["1"]);
    fireEvent.click(screen.getByText("close"));
    await waitFor(() => expect(screen.queryByText("site_changed.body_stopped")).toBeNull());
  });

  it("does not reopen a dismissed refusal when another holder of the same fetcher mounts", async () => {
    function Submitter() {
      const fetcher = useSiteFetcher({ key: "shared" });
      return (
        <button type="button" onClick={() => fetcher.submit({ intent: "publish" }, { method: "post", action: "/act" })}>
          go
        </button>
      );
    }
    function LateHolder() {
      useSiteFetcher({ key: "shared" });
      return <p>late</p>;
    }
    function Page() {
      const [late, setLate] = useState(false);
      return (
        <>
          <Submitter />
          <button type="button" onClick={() => setLate(true)}>mount</button>
          {late && <LateHolder />}
        </>
      );
    }
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: (
            <PageSiteProvider activeProjectId={1}>
              <SiteChangedWatcher />
              <Page />
            </PageSiteProvider>
          ),
        },
        {
          path: "/act",
          action: () =>
            data({ ok: false, intent: "publish", error: "site_changed", currentSiteName: "owner/other" }, { status: 409 }),
        },
      ],
      { initialEntries: ["/"] },
    );
    render(<RouterProvider router={router} />);
    fireEvent.click(screen.getByText("go"));
    await waitFor(() => expect(screen.queryByText("site_changed.body_stopped")).not.toBeNull());
    fireEvent.click(screen.getByText("close"));
    await waitFor(() => expect(screen.queryByText("site_changed.body_stopped")).toBeNull());
    fireEvent.click(screen.getByText("mount"));
    await waitFor(() => expect(screen.queryByText("late")).not.toBeNull());
    expect(screen.queryByText("site_changed.body_stopped")).toBeNull();
  });

  it("shows the stale notice when the layout's site moves under the page", () => {
    const { setId } = renderLayout(<SiteChangedWatcher />);
    expect(screen.queryByText("site_changed.body_stale")).toBeNull();
    act(() => setId(2));
    expect(screen.queryByText("site_changed.body_stale")).not.toBeNull();
  });
});
