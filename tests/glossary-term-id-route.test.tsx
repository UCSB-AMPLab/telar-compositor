// @vitest-environment jsdom
/**
 * The glossary route's term IDs: a term's ID follows its title only while it
 * is the term this author just created with "New term", and only until another
 * term is selected; no other title edit changes an ID. A confirmed ID change
 * writes the ID and rewrites the links to it together.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import React from "react";
import * as Y from "yjs";

let current = new Y.Doc();

function term(id: number | null, termId: string, title: string, definition: string): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("_id", id);
  if (id === null) m.set("_temp_id", `temp-${termId}`);
  m.set("term_id", termId);
  m.set("title", new Y.Text(title));
  m.set("definition", new Y.Text(definition));
  m.set("kind", "");
  return m;
}

const ops = {
  addGlossaryTerm: (title: string) => {
    current.getArray<Y.Map<unknown>>("glossary").push([term(null, "untitled-term", title, "")]);
  },
};

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
vi.mock("~/hooks/use-structural-ops", () => ({ useStructuralOps: () => ops }));
vi.mock("~/hooks/use-role", () => ({ useIsConvenor: () => true }));
vi.mock("~/hooks/use-toast", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("~/components/features/glossary/GlossaryKindSelect", () => ({
  useGlossaryKinds: () => [],
  KindCaption: () => null,
  GlossaryKindSelect: () => null,
}));
vi.mock("~/components/ui/MarkdownEditor", () => ({ MarkdownEditor: () => null }));
vi.mock("~/components/ui/InlineTextField", () => ({
  InlineTextField: ({ yText, fieldKey }: { yText: Y.Text; fieldKey: string }) => (
    <React.Fragment key={fieldKey}>
      <input
        data-testid="title-editor"
        defaultValue={yText.toString()}
        onChange={(e) => {
          yText.delete(0, yText.length);
          yText.insert(0, e.target.value);
        }}
      />
    </React.Fragment>
  ),
}));
vi.mock("~/components/features/glossary/GlossaryPreviewPane", () => ({ GlossaryPreviewPane: () => null }));
vi.mock("~/components/features/glossary/UsedInPanel", () => ({ UsedInPanel: () => null }));
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

function termIds(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of current.getArray<Y.Map<unknown>>("glossary").toArray()) {
    out[(m.get("title") as Y.Text).toString()] = m.get("term_id") as string;
  }
  return out;
}

async function mount() {
  const { default: GlossaryPage } = (await import("~/routes/_app.glossary")) as unknown as {
    default: React.ComponentType<{ loaderData: unknown }>;
  };
  render(<GlossaryPage loaderData={loaderData} />);
}

const listButton = (title: string) => screen.getByRole("button", { name: title });
const editTitle = (value: string) => fireEvent.change(screen.getByTestId("title-editor"), { target: { value } });

beforeEach(() => {
  current = new Y.Doc();
  current.getArray<Y.Map<unknown>>("glossary").push([
    term(1, "mita", "Mita", "See [[telar]]."),
    term(2, "telar", "Telar", "A loom"),
  ]);
});
afterEach(() => cleanup());

describe("a term's ID and its title", () => {
  it("follows the title while the term is the one just created, and stops once another term is selected", async () => {
    await mount();
    // The route selects the new term in an animation frame, and the observer
    // that moves the ID with the title is attached in an effect after that
    // render; editing before the effect runs goes unobserved.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "new_term_button" }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    await waitFor(() => expect((screen.getByTestId("title-editor") as HTMLInputElement).value).toBe("untitled_term"));

    editTitle("Nueva palabra");
    await waitFor(() => expect(termIds()["Nueva palabra"]).toBe("nueva-palabra"), { timeout: 3000 });

    fireEvent.click(listButton("Mita"));
    fireEvent.click(listButton("Nueva palabra"));
    editTitle("Otra palabra");
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(termIds()["Otra palabra"]).toBe("nueva-palabra");
  });

  it("leaves the ID of any other term alone when its title changes", async () => {
    await mount();
    editTitle("Mitayo");
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(termIds()).toEqual({ Mitayo: "mita", Telar: "telar" });
  });
});

describe("changing a term's ID", () => {
  it("writes the ID and rewrites the links to it, in one transaction", async () => {
    await mount();
    fireEvent.click(listButton("Telar"));
    const transactions: Y.Transaction[] = [];
    current.on("afterTransaction", (tr) => {
      if (tr.changed.size > 0) transactions.push(tr);
    });

    fireEvent.click(screen.getByRole("button", { name: "change_id" }));
    fireEvent.change(screen.getByRole("textbox", { name: "term_id_section_label" }), { target: { value: "telar-viejo" } });
    fireEvent.click(screen.getByRole("button", { name: "change_id" }));

    expect(termIds()).toEqual({ Mita: "mita", Telar: "telar-viejo" });
    const mita = current.getArray<Y.Map<unknown>>("glossary").get(0);
    expect((mita.get("definition") as Y.Text).toString()).toBe("See [[telar-viejo]].");
    expect(transactions).toHaveLength(1);
  });
});
