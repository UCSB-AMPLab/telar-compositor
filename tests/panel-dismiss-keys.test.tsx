// @vitest-environment jsdom
/**
 * Escape and Left arrow close the topmost layer panel, one thing per press
 *
 * The panel's listener is on the document, in the bubbling phase, and does
 * nothing while an overlay or a menu is open (`useOverlayOpen`), while the
 * press was already used (`defaultPrevented`), or during a composition. Each
 * case mounts the real overlay with its own Escape handling next to a panel
 * that listens as the stage's panels do, presses once and checks that one
 * thing closed, then presses again and checks the panel closed.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { useRef, useState, type ReactNode } from "react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "en" } }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>,
}));

vi.mock("react-router", () => ({
  useFetcher: () => ({ state: "idle", data: undefined, submit: vi.fn(() => Promise.resolve()), load: vi.fn() }),
  useRevalidator: () => ({ revalidate: vi.fn(), state: "idle" }),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    ydoc: null,
    provider: null,
    isPublishing: false,
    isUpgrading: false,
    undoManager: null,
    remoteCollaborators: [],
    contributionsByUser: new Map(),
  }),
}));

import { usePanelDismissKeys } from "~/hooks/use-panel-dismiss-keys";
import { Dialog } from "~/components/ui/Dialog";
import { DeleteConfirmationModal } from "~/components/ui/DeleteConfirmationModal";
import { KebabMenu } from "~/components/ui/KebabMenu";
import { LinkPopover } from "~/components/ui/markdown-editor/LinkPopover";
import { elementAnchor } from "~/components/ui/markdown-editor/EditorPopover";
import { MarkdownEditor } from "~/components/ui/MarkdownEditor";
import { InlineTextField } from "~/components/ui/InlineTextField";
import { CollaborationSidebar } from "~/components/features/collaboration/CollaborationSidebar";
import { StepSidebar } from "~/components/features/editor/StepSidebar";
import { EditorView } from "@codemirror/view";
import { InPlaceMarkdown } from "~/components/ui/InPlaceMarkdown";
import { WhatsNewModal } from "~/components/features/release/WhatsNewModal";
import { WorkflowsPermissionModal } from "~/components/features/upgrade/WorkflowsPermissionModal";
import { AccountModal } from "~/components/features/onboarding/AccountModal";

// jsdom has no layout; CodeMirror's coordsAtPos measures a Range.
const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

afterEach(() => cleanup());

/** A panel that listens for its dismissal keys as the stage's panels do. */
function Panel({ children }: { children?: ReactNode }) {
  const [open, setOpen] = useState(true);
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  usePanelDismissKeys({
    enabled: open,
    topPanel: () => panelRef.current,
    topHeading: () => headingRef.current,
    onClose: () => setOpen(false),
  });
  if (!open) return null;
  return (
    <div data-testid="panel" ref={panelRef}>
      <h1 tabIndex={-1} ref={headingRef}>
        Heading
      </h1>
      {children}
    </div>
  );
}

const panelOpen = () => screen.queryByTestId("panel") !== null;

/** Escape as a browser delivers it to the element holding focus. */
function escape(target: Element = document.activeElement ?? document.body, init: KeyboardEventInit = {}) {
  fireEvent.keyDown(target, { key: "Escape", code: "Escape", ...init });
}

describe("with nothing else open", () => {
  it("Escape closes the panel", () => {
    render(<Panel />);
    escape(document.body);
    expect(panelOpen()).toBe(false);
  });

  it("Left arrow closes the panel", () => {
    render(<Panel />);
    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    expect(panelOpen()).toBe(false);
  });

  it("a press already used elsewhere closes nothing", () => {
    render(<Panel />);
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    event.preventDefault();
    act(() => {
      document.body.dispatchEvent(event);
    });
    expect(panelOpen()).toBe(true);
  });

  it("Escape during a composition closes nothing, whether reported as composing or as key 229", () => {
    render(<Panel />);
    escape(document.body, { isComposing: true });
    expect(panelOpen()).toBe(true);
    escape(document.body, { keyCode: 229 });
    expect(panelOpen()).toBe(true);
  });

  it("Left arrow in editable text closes nothing", () => {
    render(
      <Panel>
        <input data-testid="text" />
      </Panel>,
    );
    const input = screen.getByTestId("text");
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowLeft" });
    expect(panelOpen()).toBe(true);
  });

  it("Left arrow with a modifier closes nothing", () => {
    render(<Panel />);
    fireEvent.keyDown(document.body, { key: "ArrowLeft", altKey: true });
    expect(panelOpen()).toBe(true);
  });
});

describe("one thing per press", () => {
  it("a dialog closes first, then the panel", () => {
    function Case() {
      const [open, setOpen] = useState(false);
      return (
        <Panel>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <Dialog open={open} onClose={() => setOpen(false)}>
            <h2>Dialog</h2>
            <button type="button">Inside</button>
          </Dialog>
        </Panel>
      );
    }
    render(<Case />);
    fireEvent.click(screen.getByText("Open"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    escape();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(panelOpen()).toBe(true);
    escape(document.body);
    expect(panelOpen()).toBe(false);
  });

  it("Left arrow closes nothing while a dialog is open", () => {
    render(
      <Panel>
        <Dialog open onClose={() => {}}>
          <h2>Dialog</h2>
        </Dialog>
      </Panel>,
    );
    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    expect(panelOpen()).toBe(true);
  });

  // Each overlay is opened after the panel, as an author opens one, so its
  // own document listener is added after the panel's and runs after it.
  it("the delete confirmation closes first, then the panel", () => {
    function Case() {
      const [open, setOpen] = useState(false);
      return (
        <Panel>
          <button type="button" onClick={() => setOpen(true)}>
            Delete
          </button>
          <DeleteConfirmationModal open={open} onClose={() => setOpen(false)} onConfirm={() => {}} entityType="layer" entityLabel="Panel 1" />
        </Panel>
      );
    }
    render(<Case />);
    fireEvent.click(screen.getByText("Delete"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    escape();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(panelOpen()).toBe(true);
    escape(document.body);
    expect(panelOpen()).toBe(false);
  });

  it("a kebab menu closes first, then the panel", () => {
    render(
      <Panel>
        <KebabMenu items={[{ label: "Item", onClick: () => {} }]} ariaLabel="More" />
      </Panel>,
    );
    fireEvent.click(screen.getByLabelText("More"));
    expect(screen.getByRole("menu")).toBeTruthy();
    escape();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(panelOpen()).toBe(true);
    escape(document.body);
    expect(panelOpen()).toBe(false);
  });

  it("a link popover closes first, then the panel", () => {
    function Case() {
      const [open, setOpen] = useState(true);
      return (
        <Panel>
          {open && (
            <LinkPopover
              anchor={elementAnchor(document.body)}
              selectedText=""
              onInsert={() => {}}
              onCancel={() => setOpen(false)}
              onDetach={() => {}}
            />
          )}
        </Panel>
      );
    }
    render(<Case />);
    const input = screen.getByRole("textbox");
    escape(input);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(panelOpen()).toBe(true);
    escape(document.body);
    expect(panelOpen()).toBe(false);
  });

  it("the collaboration sidebar closes first, then the panel", () => {
    function Case() {
      const [open, setOpen] = useState(false);
      return (
        <Panel>
          <button type="button" onClick={() => setOpen(true)}>
            Team
          </button>
          <CollaborationSidebar open={open} onClose={() => setOpen(false)} isConvenor={false} members={[]} seats={{ used: 1, limit: 5 }} />
          <span data-testid="sidebar-state">{String(open)}</span>
        </Panel>
      );
    }
    render(<Case />);
    fireEvent.click(screen.getByText("Team"));
    expect(screen.getByTestId("sidebar-state").textContent).toBe("true");
    escape(document.body);
    expect(screen.getByTestId("sidebar-state").textContent).toBe("false");
    expect(panelOpen()).toBe(true);
    escape(document.body);
    expect(panelOpen()).toBe(false);
  });

  it("an open field closes first, then the panel", () => {
    function Case() {
      const [editing, setEditing] = useState(true);
      return (
        <Panel>
          {editing && <InlineTextField initialValue="Title" yText={null} autoFocus onDone={() => setEditing(false)} />}
        </Panel>
      );
    }
    render(<Case />);
    const input = screen.getByRole("textbox");
    expect(document.activeElement).toBe(input);
    escape(input);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(panelOpen()).toBe(true);
    escape(document.body);
    expect(panelOpen()).toBe(false);
  });

  it("focus in the content editor goes to the heading first, then the panel closes", () => {
    const { container } = render(
      <Panel>
        <MarkdownEditor initialValue="Some text" fieldName="content" projectId={1} alwaysShowToolbar />
      </Panel>,
    );
    const content = container.querySelector(".cm-content") as HTMLElement;
    content.focus();
    escape(content);
    expect(panelOpen()).toBe(true);
    expect(document.activeElement?.tagName).toBe("H1");
    escape();
    expect(panelOpen()).toBe(false);
  });

  it("the heading dropdown closes first, then the panel", () => {
    const { container } = render(
      <Panel>
        <MarkdownEditor initialValue="Some text" fieldName="content" projectId={1} alwaysShowToolbar />
      </Panel>,
    );
    const heading = screen.getByTitle("toolbar.heading");
    fireEvent.mouseDown(heading, { detail: 1 });
    fireEvent.click(heading, { detail: 1 });
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    const content = container.querySelector(".cm-content") as HTMLElement;
    escape(content);
    expect(heading.getAttribute("aria-expanded")).toBe("false");
    expect(panelOpen()).toBe(true);
  });

  it("Left arrow closes nothing while the widget menu is open", async () => {
    render(
      <Panel>
        <MarkdownEditor initialValue="Some text" fieldName="content" projectId={1} alwaysShowToolbar enablePanelAuthoring />
      </Panel>,
    );
    const widget = screen.getByTitle("panel.widget");
    fireEvent.mouseDown(widget, { detail: 1 });
    fireEvent.click(widget, { detail: 1 });
    expect(widget.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(widget, { key: "ArrowLeft" });
    expect(panelOpen()).toBe(true);
  });

  // These two listen on the window, which hears a key after the document.
  it.each([
    ["the release notes", (open: boolean, close: () => void) => <WhatsNewModal open={open} onDismiss={close} />],
    [
      "the workflows permission prompt",
      (open: boolean, close: () => void) => <WorkflowsPermissionModal open={open} onDismiss={close} approvalUrl="https://example.org" />,
    ],
  ])("%s close first, then the panel", (_name, modal) => {
    function Case() {
      const [open, setOpen] = useState(false);
      return (
        <Panel>
          <button type="button" onClick={() => setOpen(true)}>
            Show
          </button>
          {modal(open, () => setOpen(false))}
          <span data-testid="modal-state">{String(open)}</span>
        </Panel>
      );
    }
    render(<Case />);
    fireEvent.click(screen.getByText("Show"));
    escape(document.body);
    expect(screen.getByTestId("modal-state").textContent).toBe("false");
    expect(panelOpen()).toBe(true);
    escape(document.body);
    expect(panelOpen()).toBe(false);
  });

  it("the account picker closes first, then the panel", () => {
    function Case() {
      const [open, setOpen] = useState(false);
      return (
        <Panel>
          <button type="button" onClick={() => setOpen(true)}>
            Accounts
          </button>
          {open && (
            <AccountModal options={[]} activeInstallationId={1} githubAppSlug="app" onSelect={() => {}} onClose={() => setOpen(false)} />
          )}
          <span data-testid="modal-state">{String(open)}</span>
        </Panel>
      );
    }
    render(<Case />);
    fireEvent.click(screen.getByText("Accounts"));
    escape();
    expect(screen.getByTestId("modal-state").textContent).toBe("false");
    expect(panelOpen()).toBe(true);
    escape(document.body);
    expect(panelOpen()).toBe(false);
  });

  it("Left arrow closes nothing while the footnote popover is open", () => {
    render(
      <Panel>
        <MarkdownEditor initialValue="Alpha beta." fieldName="content" projectId={1} alwaysShowToolbar enableFootnotes />
      </Panel>,
    );
    const footnote = screen.getByTitle("footnote.button");
    fireEvent.mouseDown(footnote);
    fireEvent.click(footnote, { detail: 1 });
    const popover = screen.getByRole("dialog", { name: "footnote.button" });
    // Focus on one of the popover's buttons, not in its text.
    const control = popover.querySelector("button") as HTMLButtonElement;
    control.focus();
    expect(document.activeElement).toBe(control);
    fireEvent.keyDown(control, { key: "ArrowLeft" });
    expect(panelOpen()).toBe(true);
  });

  // A toolbar menu opened with the pointer leaves focus in the editor
  // (toolbar-press.ts): the menu takes Escape before CodeMirror does, with a
  // selection to narrow or without, and the press goes no further.
  describe.each([
    ["the heading menu", "toolbar.heading"],
    ["the widget menu", "panel.widget"],
  ])("%s, opened with the pointer, focus left in the editor", (_menu, title) => {
    function mountMenu() {
      const { container } = render(
        <Panel>
          <MarkdownEditor initialValue="Alpha beta gamma" fieldName="content" projectId={1} alwaysShowToolbar enablePanelAuthoring />
        </Panel>,
      );
      const content = container.querySelector(".cm-content") as HTMLElement;
      const view = EditorView.findFromDOM(content)!;
      act(() => content.focus());
      const button = screen.getByTitle(title);
      fireEvent.mouseDown(button, { detail: 1 });
      fireEvent.click(button, { detail: 1 });
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(content);
      return { content, view, button };
    }

    it.each([
      ["with a selection", { anchor: 0, head: 5 }],
      ["without a selection", { anchor: 3 }],
    ])("closes on the first Escape, %s, and nothing else", (_how, selection) => {
      const { content, view, button } = mountMenu();
      act(() => view.dispatch({ selection }));
      const before = view.state.selection.main;
      escape(content);
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(panelOpen()).toBe(true);
      expect(document.activeElement).toBe(content);
      expect(view.state.selection.main.eq(before)).toBe(true);
      // The next presses follow the panel's order: CodeMirror narrows a
      // selection first, then focus leaves the editor for the heading.
      if (!before.empty) {
        escape(content);
        expect(view.state.selection.main.empty).toBe(true);
        expect(document.activeElement).toBe(content);
      }
      escape(content);
      expect(document.activeElement?.tagName).toBe("H1");
      expect(panelOpen()).toBe(true);
    });

    it("closes the menu and not the in-place field the editor is open in", () => {
      render(
        <Panel>
          <InPlaceMarkdown
            yText={null}
            initialValue="Alpha"
            label="content"
            onSave={() => Promise.resolve()}
            editorProps={{ alwaysShowToolbar: true, enablePanelAuthoring: true }}
          />
        </Panel>,
      );
      fireEvent.click(screen.getByRole("button", { name: "content" }));
      const content = document.querySelector(".cm-content") as HTMLElement;
      act(() => content.focus());
      const button = screen.getByTitle(title);
      fireEvent.mouseDown(button, { detail: 1 });
      fireEvent.click(button, { detail: 1 });
      escape(content);
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(document.querySelector(".cm-content")).toBe(content);
    });

    it.each([
      ["the image dialog", "toolbar.image", () => screen.queryByRole("dialog")],
      ["the link popover", "toolbar.link", () => screen.queryByPlaceholderText("link_popover.url_placeholder")],
    ])("leaves Escape to %s opened above it, and closes on the next press", (_what, opener, above) => {
      const { button } = mountMenu();
      // Opened from the keyboard, so no press outside closes the menu first.
      fireEvent.click(screen.getByTitle(opener), { detail: 0 });
      expect(above()).not.toBeNull();
      escape();
      expect(above()).toBeNull();
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(panelOpen()).toBe(true);
      escape();
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(panelOpen()).toBe(true);
    });

    it("leaves a key that is part of a composition to the editor", () => {
      const { content, button } = mountMenu();
      escape(content, { isComposing: true });
      expect(button.getAttribute("aria-expanded")).toBe("true");
    });
  });

  it("a step-line drag is cancelled first, then the panel closes", async () => {
    const onReorder = vi.fn();
    render(
      <Panel>
        <StepSidebar
          steps={[
            { id: 1, step_number: 1, question: "One", object_id: null, kind: "media" } as never,
            { id: 2, step_number: 2, question: "Two", object_id: null, kind: "media" } as never,
          ]}
          storyTitle="Story"
          activeStepIndex={1}
          onStepSelect={() => {}}
          onReorderSteps={onReorder}
          onAddStep={() => {}}
          onAddSectionCard={() => {}}
          onDeleteStep={() => {}}
        />
      </Panel>,
    );
    const handle = document.querySelector(".cursor-grab") as HTMLElement;
    fireEvent.keyDown(handle, { key: " ", code: "Space" });
    // dnd-kit listens for the drag's keys from the next task.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelector('[aria-pressed="true"]')).not.toBeNull();
    escape(document.body);
    expect(document.querySelector('[aria-pressed="true"]')).toBeNull();
    expect(panelOpen()).toBe(true);
    expect(onReorder).not.toHaveBeenCalled();
    escape(document.body);
    expect(panelOpen()).toBe(false);
  });
});
