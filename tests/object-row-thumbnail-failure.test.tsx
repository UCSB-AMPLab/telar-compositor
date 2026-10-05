// @vitest-environment jsdom
/**
 * An object row whose thumbnail image fails to load reports it, shows the
 * placeholder, and tries a replacement URL when one arrives.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { ObjectRow } from "~/components/features/objects/ObjectRow";

const OBJECT = {
  id: 9, object_id: "map", title: "Map", featured: false, source_url: "https://iiif.example/manifest",
  thumbnail: null, image_available: true, missing_from_repo: false,
};

const requests: string[] = [];
let setFallback: (url: string) => void = () => {};

function Host({ onThumbnailFailed, onThumbnailRefreshed }: Pick<React.ComponentProps<typeof ObjectRow>, "onThumbnailFailed" | "onThumbnailRefreshed">) {
  const [fallback, set] = useState("https://iiif.example/old.jpg");
  setFallback = set;
  return (
    <ObjectRow
      object={OBJECT}
      onToggleFeatured={() => {}}
      siteBaseUrl={null}
      frameworkVersion="1.8.0"
      fallbackThumbnail={fallback}
      onThumbnailFailed={onThumbnailFailed}
      onThumbnailRefreshed={onThumbnailRefreshed}
    />
  );
}

function row(props: React.ComponentProps<typeof Host>) {
  const router = createMemoryRouter([
    { path: "/", element: <Host {...props} /> },
    {
      path: "/api/object-thumbnail",
      action: async ({ request }) => {
        const form = await request.formData();
        requests.push(String(form.get("intent") ?? "ask"));
        return { thumbnail: "https://iiif.example/new.jpg" };
      },
    },
  ]);
  return <RouterProvider router={router} />;
}

afterEach(() => {
  cleanup();
  requests.length = 0;
});

describe("ObjectRow thumbnail failure", () => {
  it("reports the failed image and shows the placeholder", async () => {
    const failed = vi.fn();
    const { container } = render(row({ onThumbnailFailed: failed }));

    fireEvent.error(await findImage(container));

    expect(failed).toHaveBeenCalledWith(OBJECT);
    expect(container.querySelector("img")).toBeNull();
  });

  it("shows a replacement thumbnail when the stored one changes", async () => {
    const { container } = render(row({}));
    fireEvent.error(await findImage(container));

    act(() => setFallback("https://iiif.example/new.jpg"));

    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://iiif.example/new.jpg");
  });

  it("asks the server with the fields the route gives and reports the answer", async () => {
    const refreshed = vi.fn();
    const { container } = render(
      row({ onThumbnailFailed: () => ({ projectId: "42", objectDbId: "9" }), onThumbnailRefreshed: refreshed }),
    );

    fireEvent.error(await findImage(container));

    await waitFor(() => expect(refreshed).toHaveBeenCalledWith(OBJECT, "https://iiif.example/new.jpg"));
  });

  it("asks only once when the document did not take the thumbnail, and writes nothing else", async () => {
    const refreshed = vi.fn();
    const { container } = render(
      row({ onThumbnailFailed: () => ({ projectId: "42", objectDbId: "9" }), onThumbnailRefreshed: refreshed }),
    );

    fireEvent.error(await findImage(container));
    await waitFor(() => expect(refreshed).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(requests).toEqual(["ask"]);
  });

  it("asks nothing when the route gives no fields", async () => {
    const refreshed = vi.fn();
    const { container } = render(row({ onThumbnailFailed: () => null, onThumbnailRefreshed: refreshed }));

    fireEvent.error(await findImage(container));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(refreshed).not.toHaveBeenCalled();
  });
});

async function findImage(container: HTMLElement) {
  await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
  return container.querySelector("img")!;
}
