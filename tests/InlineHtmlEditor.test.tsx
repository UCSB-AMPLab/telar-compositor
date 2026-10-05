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

  /**
   * `editable={false}` is a permission surface, not a cosmetic one. The editor
   * binds the shared config.description Y.Text through yCollab, and the
   * Durable Object snapshots that document straight back into project_config —
   * so a caller the config action would refuse must not be able to open the
   * editor at all. Opening it is the only way this component reaches the
   * Y.Text, so refusing to mount is the whole gate.
   */
  describe("editable={false}", () => {
    it("still renders the value, so the field stays readable", async () => {
      const { container } = render(
        <InlineHtmlEditor initialValue="" yText={yText} editable={false} />,
      );
      const preview = container.querySelector("[data-description-preview]")!;
      expect(preview.innerHTML).toContain("<a href=");
      expect(preview.textContent).toContain("Hello");
    });

    it("does not open the editor on click, so no Y.Text binding is created", async () => {
      const { container } = render(
        <InlineHtmlEditor initialValue="" yText={yText} editable={false} />,
      );
      fireEvent.click(container.querySelector("[data-description-preview]")!);

      expect(container.querySelector(".cm-content")).toBeNull();
      expect(container.querySelector("[data-description-preview]")).toBeTruthy();
    });

    it("does not open the editor on the keyboard path either", async () => {
      const { container } = render(
        <InlineHtmlEditor initialValue="" yText={yText} editable={false} />,
      );
      const preview = container.querySelector("[data-description-preview]")!;
      fireEvent.keyDown(preview, { key: "Enter" });
      fireEvent.keyDown(preview, { key: " " });

      expect(container.querySelector(".cm-content")).toBeNull();
    });

    it("leaves the shared Y.Text untouched across an edit attempt", async () => {
      const before = yText.toString();
      const { container } = render(
        <InlineHtmlEditor initialValue="" yText={yText} editable={false} />,
      );
      fireEvent.click(container.querySelector("[data-description-preview]")!);

      expect(yText.toString()).toBe(before);
    });

    it("defaults to editable when the prop is omitted", async () => {
      const { container } = render(<InlineHtmlEditor initialValue="" yText={yText} />);
      fireEvent.click(container.querySelector("[data-description-preview]")!);

      expect(container.querySelector(".cm-content")).toBeTruthy();
    });
  });

  it("shows the placeholder when empty", async () => {
    const empty = new Y.Doc().getText("d");
    const { container } = render(
      <InlineHtmlEditor initialValue="" yText={empty} placeholder="A brief description" />,
    );
    expect(container.querySelector("[data-description-preview]")?.textContent).toContain("A brief description");
  });
});
