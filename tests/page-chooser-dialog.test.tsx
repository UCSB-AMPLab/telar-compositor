// @vitest-environment jsdom

/**
 * The page chooser: what it renders, what it refuses, and how it behaves for an
 * author working with a manuscript far longer than one screen of tiles.
 *
 * The window rules are the delicate part. The window follows the page the
 * viewer is actually showing, which after browsing is not the page the step has
 * stored; the stored page is only outlined where it happens to be rendered, and
 * a stored page beyond the end of the manifest is neither shown nor rewritten.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, cleanup } from "@testing-library/react";
import type { ManifestPage } from "~/lib/iiif-pages";
import type { PageChooserSession } from "~/components/features/editor/PageChooserDialog";

let language = "en";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    // Echo the key with its interpolated values appended, so a test can assert
    // both which string was used and what was put into it.
    t: (key: string, values?: Record<string, unknown>) =>
      values
        ? `${key}|${Object.entries(values)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(",")}`
        : key,
    i18n: { language },
  }),
}));

import { PageChooserDialog } from "~/components/features/editor/PageChooserDialog";

const SESSION: PageChooserSession = {
  selectionKey: "tmp:a",
  targetKey: "tmp:a",
  objectId: "obj",
  sourceKey: "src",
};

function pages(count: number, decorate?: (i: number) => Partial<ManifestPage>): ManifestPage[] {
  return Array.from({ length: count }, (_, i) => ({
    tileSource: `https://example.org/iiif/3/p${i + 1}/info.json`,
    ...(decorate?.(i) ?? {}),
  }));
}

function renderChooser(props: Partial<Parameters<typeof PageChooserDialog>[0]> = {}) {
  const onChoose = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <PageChooserDialog
      open
      onClose={onClose}
      session={SESSION}
      pages={pages(3)}
      objectTitle="Codex"
      savedPage={null}
      effectivePage={0}
      onChoose={onChoose}
      {...props}
    />
  );
  return { view, onChoose, onClose };
}

const responders = new Map<string, () => Response>();

beforeEach(() => {
  cleanup();
  language = "en";
  responders.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const responder = responders.get(String(input));
      if (!responder) return new Response("", { status: 404 });
      return responder();
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function tiles() {
  return screen
    .getAllByRole("button")
    .filter((el) => el.textContent?.includes("page_chooser.page_label"));
}

describe("PageChooserDialog — tiles", () => {
  it("renders one tile per page with the manifest's thumbnails and labels", () => {
    renderChooser({
      pages: pages(3, (i) => ({
        thumbnail: `https://example.org/t${i + 1}.jpg`,
        label: `Folio ${i + 1}r`,
      })),
    });
    expect(tiles()).toHaveLength(3);
    const images = screen.getAllByRole("presentation", { hidden: true });
    expect(images.map((img) => img.getAttribute("src"))).toEqual([
      "https://example.org/t1.jpg",
      "https://example.org/t2.jpg",
      "https://example.org/t3.jpg",
    ]);
    expect(screen.getByText("Folio 2r")).not.toBeNull();
    expect(images[0].getAttribute("loading")).toBe("lazy");
  });

  it("resolves a thumbnail from the sizes the page's own info.json declares", async () => {
    responders.set("https://example.org/iiif/3/p1/info.json", () =>
      new Response(
        JSON.stringify({
          id: "https://example.org/iiif/3/p1",
          sizes: [{ width: 200, height: 250 }],
        })
      )
    );
    renderChooser({ pages: pages(1) });
    await waitFor(() =>
      expect(screen.getByRole("presentation", { hidden: true }).getAttribute("src")).toBe("https://example.org/iiif/3/p1/full/200,250/0/default.jpg")
    );
  });

  it("fetches an info.json only for a page the window renders", async () => {
    for (let i = 1; i <= 60; i++) {
      responders.set(`https://example.org/iiif/3/p${i}/info.json`, () =>
        new Response(JSON.stringify({ id: "https://example.org/x", sizes: [] }))
      );
    }
    renderChooser({ pages: pages(60), effectivePage: 0 });
    await act(async () => { await Promise.resolve(); });
    const fetched = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(fetched).toContain("https://example.org/iiif/3/p1/info.json");
    expect(fetched).not.toContain("https://example.org/iiif/3/p60/info.json");
  });

  it("shows the placeholder for a page with neither a thumbnail nor declared sizes", async () => {
    renderChooser({ pages: [{ tileSource: "https://example.org/plain.jpg" }] });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("page_chooser.no_preview")).not.toBeNull();
  });

  it("falls back to the placeholder when the thumbnail image fails to load", async () => {
    renderChooser({ pages: pages(1, () => ({ thumbnail: "https://example.org/t.jpg" })) });
    const img = screen.getByRole("presentation", { hidden: true });
    await act(async () => { fireEvent.error(img); });
    expect(screen.getByText("page_chooser.no_preview")).not.toBeNull();
  });

  it("chooses a page when its tile is clicked, then closes", () => {
    const { onChoose, onClose } = renderChooser();
    fireEvent.click(tiles()[1]);
    expect(onChoose).toHaveBeenCalledWith(2, SESSION);
    expect(onClose).toHaveBeenCalled();
  });
});

describe("PageChooserDialog — the number box", () => {
  it("chooses the page it names", () => {
    const { onChoose } = renderChooser();
    fireEvent.change(screen.getByLabelText("page_chooser.go_to_label"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByText("page_chooser.go"));
    expect(onChoose).toHaveBeenCalledWith(2, SESSION);
  });

  it("treats Enter in the box as Go", () => {
    const { onChoose } = renderChooser();
    const box = screen.getByLabelText("page_chooser.go_to_label");
    fireEvent.change(box, { target: { value: "3" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onChoose).toHaveBeenCalledWith(3, SESSION);
  });

  it.each(["0", "4", "2.5", "third"])(
    "shows the error tied to the box and chooses nothing for %s",
    (entry) => {
      const { onChoose } = renderChooser();
      const box = screen.getByLabelText("page_chooser.go_to_label");
      fireEvent.change(box, { target: { value: entry } });
      fireEvent.click(screen.getByText("page_chooser.go"));
      expect(onChoose).not.toHaveBeenCalled();
      const error = screen.getByRole("alert");
      expect(error.textContent).toContain("page_chooser.invalid_page");
      expect(box.getAttribute("aria-describedby")).toBe(error.id);
    }
  );
});

describe("PageChooserDialog — the window", () => {
  const long = () => pages(100);

  it("opens on the window holding the effective page and outlines the saved page there", () => {
    renderChooser({ pages: long(), savedPage: 90, effectivePage: 89 });
    expect(screen.getByText("page_chooser.page_label|page=49")).not.toBeNull();
    expect(screen.getByText("page_chooser.page_label|page=90")).not.toBeNull();
    const outlined = document.querySelectorAll('[aria-current="true"]');
    expect(outlined).toHaveLength(1);
    expect(outlined[0].textContent).toContain("page=90");
  });

  it("moves back a window and still reaches a later page through Go", () => {
    const { onChoose } = renderChooser({ pages: long(), savedPage: 90, effectivePage: 89 });
    fireEvent.click(screen.getByText("page_chooser.earlier"));
    expect(screen.getByText("page_chooser.page_label|page=1")).not.toBeNull();
    expect(screen.queryByText("page_chooser.page_label|page=60")).toBeNull();

    fireEvent.change(screen.getByLabelText("page_chooser.go_to_label"), {
      target: { value: "60" },
    });
    fireEvent.click(screen.getByText("page_chooser.go"));
    expect(onChoose).toHaveBeenCalledWith(60, SESSION);
  });

  it("resets to the effective page's window when it is reopened", () => {
    const props = {
      session: SESSION,
      pages: long(),
      objectTitle: "Codex",
      savedPage: 90,
      effectivePage: 89,
      onChoose: vi.fn(),
      onClose: vi.fn(),
    };
    const view = render(<PageChooserDialog open {...props} />);
    fireEvent.click(screen.getByText("page_chooser.earlier"));
    expect(screen.getByText("page_chooser.page_label|page=1")).not.toBeNull();

    view.rerender(<PageChooserDialog open={false} {...props} />);
    view.rerender(<PageChooserDialog open {...props} />);
    expect(screen.getByText("page_chooser.page_label|page=90")).not.toBeNull();
    expect(screen.queryByText("page_chooser.page_label|page=1")).toBeNull();
  });

  it("opens on the last window with nothing outlined for a stored page past the end", () => {
    renderChooser({ pages: long(), savedPage: 900, effectivePage: 99 });
    expect(screen.getByText("page_chooser.page_label|page=100")).not.toBeNull();
    expect(document.querySelectorAll('[aria-current="true"]')).toHaveLength(0);
  });

  it("opens on the effective page's window, not the saved page's", () => {
    renderChooser({ pages: long(), savedPage: 2, effectivePage: 89 });
    expect(screen.getByText("page_chooser.page_label|page=90")).not.toBeNull();
    expect(screen.queryByText("page_chooser.page_label|page=2")).toBeNull();
    expect(document.querySelectorAll('[aria-current="true"]')).toHaveLength(0);
  });

  /**
   * The window must be settled before any tile mounts. A tile requests its own
   * `info.json` as it renders, so a first render at the top of the manifest
   * costs a whole window of requests to pages the author never asked to see —
   * which is why the complete set of requested URLs is what is asserted here,
   * not merely that the right ones are among them.
   */
  it("requests the opening window's info.json files and no others", async () => {
    for (let i = 1; i <= 100; i++) {
      responders.set(`https://example.org/iiif/3/p${i}/info.json`, () =>
        new Response(JSON.stringify({ id: "https://example.org/x", sizes: [] }))
      );
    }
    renderChooser({ pages: long(), savedPage: 90, effectivePage: 89 });
    await act(async () => { await Promise.resolve(); });

    const requested = vi.mocked(fetch).mock.calls.map((c) => String(c[0])).sort();
    const second = Array.from({ length: 48 }, (_, i) =>
      `https://example.org/iiif/3/p${49 + i}/info.json`
    ).sort();
    expect(requested).toEqual(second);
  });

  it("requests nothing from the previous window when it is reopened", async () => {
    for (let i = 1; i <= 100; i++) {
      responders.set(`https://example.org/iiif/3/p${i}/info.json`, () =>
        new Response(JSON.stringify({ id: "https://example.org/x", sizes: [] }))
      );
    }
    const props = {
      session: SESSION,
      pages: long(),
      objectTitle: "Codex",
      savedPage: 90,
      effectivePage: 89,
      onChoose: vi.fn(),
      onClose: vi.fn(),
    };
    const view = render(<PageChooserDialog open {...props} />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByText("page_chooser.earlier"));
    await act(async () => { await Promise.resolve(); });

    vi.mocked(fetch).mockClear();
    view.rerender(<PageChooserDialog open={false} {...props} />);
    view.rerender(<PageChooserDialog open {...props} />);
    await act(async () => { await Promise.resolve(); });

    const requested = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(requested).not.toContain("https://example.org/iiif/3/p1/info.json");
    expect(requested).toContain("https://example.org/iiif/3/p90/info.json");
  });
});

describe("PageChooserDialog — accessibility", () => {
  it("is a named modal that takes initial focus on the number box", async () => {
    renderChooser();
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const heading = screen.getByText("page_chooser.title");
    expect(dialog.getAttribute("aria-labelledby")).toBe(heading.id);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("page_chooser.go_to_label"))
    );
  });

  it("contains Tab and Shift-Tab within itself", async () => {
    renderChooser();
    const dialog = screen.getByRole("dialog");
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled])"
      )
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("closes on Escape and from its own close button", () => {
    const { onClose } = renderChooser();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText("close"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("PageChooserDialog — copy", () => {
  it("names an object without a title by the untitled fallback", () => {
    renderChooser({ objectTitle: null });
    expect(screen.getByText(/page_chooser\.count\|title=untitled/)).not.toBeNull();
  });

  it("groups the page count for the reader's locale", () => {
    language = "es";
    renderChooser({ pages: pages(1240), savedPage: null, effectivePage: 0 });
    expect(screen.getByText("page_chooser.count|title=Codex,count=1.240")).not.toBeNull();

    cleanup();
    language = "en";
    renderChooser({ pages: pages(1240), savedPage: null, effectivePage: 0 });
    expect(screen.getByText("page_chooser.count|title=Codex,count=1,240")).not.toBeNull();
  });
});
