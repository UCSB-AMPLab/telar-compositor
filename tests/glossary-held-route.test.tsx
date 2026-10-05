// @vitest-environment jsdom
/**
 * The glossary page with a term in the document whose id publishes none: a term from before the import held such rows aside. The page
 * neither lists it nor opens it in the editor, so the author cannot edit a
 * term the site never shows. "Ghost" sorts before "Telar", so a page that
 * listed it would select it first.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import React from "react";
import * as Y from "yjs";

const ydoc = new Y.Doc();
let current = ydoc;

function term(id: number, termId: string, title: string, definition: string): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("_id", id);
  m.set("term_id", termId);
  m.set("title", new Y.Text(title));
  m.set("definition", new Y.Text(definition));
  m.set("kind", "");
  return m;
}

ydoc.getArray<Y.Map<unknown>>("glossary").push([
  term(1, "#ghost", "Ghost", "held definition"),
  term(2, "", "Anonymous", "nameless definition"),
  term(3, "telar", "Telar", "A loom"),
]);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>,
}));

vi.mock("react-router", () => ({
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  useOutletContext: () => ({}),
  redirect: (url: string) => ({ url }),
}));

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({ ydoc: current, isPublishing: false }),
}));
vi.mock("~/hooks/use-structural-ops", () => ({ useStructuralOps: () => null }));
vi.mock("~/hooks/use-role", () => ({ useIsConvenor: () => true }));
vi.mock("~/hooks/use-toast", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

vi.mock("~/components/features/glossary/GlossaryKindSelect", () => ({
  useGlossaryKinds: () => [],
  KindCaption: () => null,
  GlossaryKindSelect: () => null,
}));
vi.mock("~/components/ui/MarkdownEditor", () => ({
  MarkdownEditor: ({ initialValue }: { initialValue: string }) => (
    <div data-testid="definition-editor" data-initial={initialValue} />
  ),
}));
vi.mock("~/components/ui/InlineTextField", () => ({
  InlineTextField: ({ initialValue }: { initialValue: string }) => (
    <div data-testid="title-editor" data-initial={initialValue} />
  ),
}));
vi.mock("~/components/features/glossary/GlossaryPreviewPane", () => ({ GlossaryPreviewPane: () => null }));
vi.mock("~/components/features/glossary/UsedInPanel", () => ({ UsedInPanel: () => null }));
vi.mock("~/components/features/glossary/RenameImpactPanel", () => ({ RenameImpactPanel: () => null }));

vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/db.server", () => ({ getDb: () => ({}) }));
vi.mock("~/lib/active-project.server", () => ({ resolveActiveProjectFromRequest: vi.fn() }));
vi.mock("~/lib/glossary-kinds.server", () => ({ readGlossaryKinds: vi.fn() }));

const loaderData = {
  project: { id: 1 },
  currentUserId: 1,
  userRole: "convenor",
  memberIds: [1],
  theme: null,
  glossaryKinds: [],
};

afterEach(() => cleanup());

describe("glossary page with a term whose id publishes none", () => {
  it("does not list it or open it in the editor", async () => {
    const { default: GlossaryPage } = (await import("~/routes/_app.glossary")) as unknown as {
      default: React.ComponentType<{ loaderData: unknown }>;
    };
    render(<GlossaryPage loaderData={loaderData} />);

    const listed = within(screen.getByRole("list"))
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(listed).toEqual(["Telar"]);
    expect(screen.getByTestId("title-editor").getAttribute("data-initial")).toBe("Telar");
    expect(screen.getByTestId("definition-editor").getAttribute("data-initial")).toBe("A loom");
  });

  it("shows the empty state when every term is held", async () => {
    const heldOnly = new Y.Doc();
    heldOnly.getArray<Y.Map<unknown>>("glossary").push([term(1, "#ghost", "Ghost", "d"), term(2, "", "Anonymous", "d2")]);
    current = heldOnly;
    try {
      const { default: GlossaryPage } = (await import("~/routes/_app.glossary")) as unknown as {
        default: React.ComponentType<{ loaderData: unknown }>;
      };
      render(<GlossaryPage loaderData={loaderData} />);
      expect(screen.queryByRole("list")).toBeNull();
      expect(screen.queryByText("Ghost")).toBeNull();
    } finally {
      current = ydoc;
    }
  });
});
