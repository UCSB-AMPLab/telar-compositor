// @vitest-environment jsdom
/**
 * Both of an object row's links to the object's page escape the ID, so an ID
 * holding a character a URL must escape reaches its own page and the route
 * reads the same ID back.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RouterProvider, createMemoryRouter, useParams } from "react-router";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { ObjectRow } from "~/components/features/objects/ObjectRow";

afterEach(cleanup);

function objectNamed(object_id: string, image_available: boolean) {
  return {
    id: 9, object_id, title: "T", featured: false, source_url: null,
    thumbnail: null, image_available, missing_from_repo: false,
  };
}

function Landing() {
  return <p data-testid="landed">{useParams().objectId}</p>;
}

function mount(object_id: string, image_available: boolean) {
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <ObjectRow
          object={objectNamed(object_id, image_available)}
          onToggleFeatured={() => {}}
          siteBaseUrl={null}
          frameworkVersion="1.8.0"
        />
      ),
    },
    { path: "/objects/:objectId", element: <Landing /> },
  ]);
  render(<RouterProvider router={router} />);
  return router;
}

describe.each(["a b", "a#b", "a/b", "a?b", "ñ"])("an object ID %j", (id) => {
  it("is reached from the open arrow, and the route reads it back", async () => {
    const router = mount(id, true);
    fireEvent.click(screen.getByLabelText("edit_button"));
    await waitFor(() => expect(screen.getByTestId("landed").textContent).toBe(id));
    expect(router.state.location.hash).toBe("");
    expect(router.state.location.search).toBe("");
  });

  it("is reached from the status badge, and the route reads it back", async () => {
    const router = mount(id, false);
    const badge = document.querySelector("a[href^='/objects/']:not([aria-label])") as HTMLElement;
    expect(badge).not.toBeNull();
    fireEvent.click(badge);
    await waitFor(() => expect(screen.getByTestId("landed").textContent).toBe(id));
    expect(router.state.location.hash).toBe("");
    expect(router.state.location.search).toBe("");
  });
});
