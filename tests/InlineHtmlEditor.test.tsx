/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import * as Y from "yjs";

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    ydoc: null,
    provider: null,
    isPublishing: false,
    undoManager: null,
  }),
}));

import { InlineHtmlEditor } from "~/components/ui/InlineHtmlEditor";

describe("InlineHtmlEditor", () => {
  let doc: Y.Doc;
  let yText: Y.Text;
  beforeEach(() => {
    doc = new Y.Doc();
    yText = doc.getText("description");
    yText.insert(0, "Hello <a href='https://x.org'>world</a>");
  });

  it("shows the sanitised RENDER (not raw tags) by default, no editor", async () => {
    yText.delete(0, yText.length);
    yText.insert(0, "Lead <a href='https://x.org'>link</a><script>bad()</script>");
    const { container } = render(<InlineHtmlEditor initialValue="" yText={yText} />);
    const preview = container.querySelector("[data-description-preview]");
    expect(preview).toBeTruthy();
    expect(preview!.innerHTML).toContain("<a href=");
    expect(preview!.innerHTML).not.toContain("script");
    // The CodeMirror editor is NOT mounted until the user clicks to edit.
    expect(container.querySelector(".cm-content")).toBeNull();
  });

  it("reveals the HTML source editor + toolbar on click", async () => {
    const { container } = render(<InlineHtmlEditor initialValue="" yText={yText} />);
    const preview = container.querySelector("[data-description-preview]")!;
    fireEvent.click(preview);
    // Editor now mounted with the raw HTML source.
    expect(container.querySelector(".cm-content")?.textContent ?? "").toContain("Hello");
    expect(screen.getByTitle(/bold/i)).toBeTruthy();
    expect(screen.getByTitle(/italic/i)).toBeTruthy();
    expect(screen.getByTitle(/link/i)).toBeTruthy();
    // The render preview is replaced by the editor while editing.
    expect(container.querySelector("[data-description-preview]")).toBeNull();
  });

  it("names the field via ariaLabel — on the box and the editor textbox", async () => {
    const { container } = render(
      <InlineHtmlEditor initialValue="" yText={yText} ariaLabel="Site description" />,
    );
    const preview = container.querySelector("[data-description-preview]")!;
    expect(preview.getAttribute("aria-label")).toBe("Site description");
    fireEvent.click(preview);
    expect(container.querySelector(".cm-content")?.getAttribute("aria-label")).toBe("Site description");
  });

  it("shows the placeholder when empty", async () => {
    const empty = new Y.Doc().getText("d");
    const { container } = render(
      <InlineHtmlEditor initialValue="" yText={empty} placeholder="A brief description" />,
    );
    expect(container.querySelector("[data-description-preview]")?.textContent).toContain("A brief description");
  });
});
