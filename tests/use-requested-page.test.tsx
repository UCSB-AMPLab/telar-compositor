// @vitest-environment jsdom
/**
 * `/pages?page=<slug>` opens that page once its row is present, once for the
 * loader's rows and once again for the shared document's, and not after.
 *
 * @version v1.5.5-beta
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useRequestedPage } from "~/hooks/use-requested-page";

type Row = { slug: string };
afterEach(cleanup);

const render = (select: (p: Row) => void, initial: { pages: Row[]; source: string }) =>
  renderHook(({ pages, source }) => useRequestedPage("about", pages, source, select), { initialProps: initial });

describe("useRequestedPage", () => {
  it("selects the named page when its row arrives after the first render", () => {
    const select = vi.fn();
    const { rerender } = render(select, { pages: [], source: "loader" });
    expect(select).not.toHaveBeenCalled();
    rerender({ pages: [{ slug: "credits" }, { slug: "about" }], source: "loader" });
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith({ slug: "about" });
  });

  it("selects it again when the document's rows replace the loader's, after an empty document", () => {
    const select = vi.fn();
    const { rerender } = render(select, { pages: [{ slug: "about" }], source: "loader" });
    rerender({ pages: [], source: "document" });
    expect(select).toHaveBeenCalledTimes(1);
    rerender({ pages: [{ slug: "about" }, { slug: "credits" }], source: "document" });
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("does not select it again while the rows change within one source", () => {
    const select = vi.fn();
    const { rerender } = render(select, { pages: [{ slug: "about" }], source: "document" });
    rerender({ pages: [{ slug: "about" }, { slug: "new" }], source: "document" });
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("selects nothing without a slug, or for a slug no page has", () => {
    const select = vi.fn();
    renderHook(() => useRequestedPage(null, [{ slug: "about" }], "loader", select));
    renderHook(() => useRequestedPage("missing", [{ slug: "about" }], "loader", select));
    expect(select).not.toHaveBeenCalled();
  });
});
