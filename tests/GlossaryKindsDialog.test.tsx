// @vitest-environment jsdom
/**
 * The dialog that edits the site's own glossary kinds: the list it saves, the
 * findings it shows before a save, the counts and notes that come from the
 * entries, and the entries it moves to a kind's new id once a save reports
 * the change.
 *
 * @version v1.5.1-beta
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import * as Y from "yjs";
import i18next from "i18next";
import enGlossary from "~/i18n/locales/en/glossary.json";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
  }),
}));

const fetcher: { state: string; data: unknown; submit: ReturnType<typeof vi.fn> } = {
  state: "idle",
  data: undefined,
  submit: vi.fn(),
};
vi.mock("~/lib/page-site", () => ({ useSiteFetcher: () => fetcher }));
let publisher = true;
vi.mock("~/hooks/use-role", () => ({ useIsPublisher: () => publisher }));
const showToast = vi.fn();
vi.mock("~/hooks/use-toast", () => ({ useToast: () => ({ showToast }) }));

import { EditKindsButton, GlossaryKindsDialog } from "~/components/features/glossary/GlossaryKindsDialog";
import { NO_GLOSSARY_KINDS, type GlossaryKinds } from "~/lib/glossary-kinds";

// A Spanish-language site: the standard kinds carry the labels its readers see.
const core = [
  { id: "term", label: "Palabra clave", aliases: ["term"] },
  { id: "source", label: "Fuente primaria", aliases: ["source", "fuente"] },
];
const creature = { id: "creature", label: "Creature", heading: "Creatures", values: ["Creatures", "bicho"], problems: {} };
const kinds: GlossaryKinds = {
  available: true,
  defaultId: "term",
  core,
  options: [...core, { id: "creature", label: "Creature", aliases: ["creature", "creatures", "bicho"] }],
  site: [creature],
};

function docWith(entryKinds: string[]): Y.Doc {
  const ydoc = new Y.Doc();
  const glossary = ydoc.getArray<Y.Map<unknown>>("glossary");
  glossary.push(
    entryKinds.map((kind) => {
      const m = new Y.Map<unknown>();
      m.set("kind", kind);
      return m;
    }),
  );
  return ydoc;
}
const entryKindsOf = (ydoc: Y.Doc) => ydoc.getArray<Y.Map<unknown>>("glossary").toArray().map((m) => m.get("kind"));

function open(over: { kinds?: GlossaryKinds; stored?: string | null; ydoc?: Y.Doc | null } = {}) {
  const onClose = vi.fn();
  const props = { kinds: { ...kinds, repoSite: '["seen"]' }, stored: "[]", ydoc: null, ...over };
  const view = render(<GlossaryKindsDialog open onClose={onClose} {...props} />);
  const rerender = () => view.rerender(<GlossaryKindsDialog open onClose={onClose} {...props} />);
  return { onClose, rerender };
}

const rows = () => screen.queryAllByTestId("site-kind");
const field = (row: HTMLElement, label: string) => within(row).getByLabelText(label) as HTMLInputElement;
const submitted = () => Object.fromEntries(Object.entries(fetcher.submit.mock.calls[0][0] as Record<string, string>));
const savedKinds = () => JSON.parse(submitted().kinds);

beforeEach(() => {
  fetcher.state = "idle";
  fetcher.data = undefined;
  fetcher.submit = vi.fn();
  publisher = true;
  showToast.mockReset();
});

describe("GlossaryKindsDialog", () => {
  it("shows the standard kinds without fields and the site's kinds with them", () => {
    open();
    expect(screen.getByText(/kind_name_term/).textContent).toBe("term · kind_name_term");
    expect(screen.queryByText(/Palabra clave/)).toBeNull();
    expect(rows()).toHaveLength(1);
    expect(field(rows()[0], "kind_field_values").value).toBe("Creatures, bicho");
    expect(screen.getAllByLabelText("kind_field_id")).toHaveLength(1);
  });

  it("adds a kind and saves the list with the stored text it replaces", () => {
    open({ stored: '[{"id":"creature"}]' });
    fireEvent.click(screen.getByText("kinds_add"));
    const added = rows()[1];
    fireEvent.change(field(added, "kind_field_id"), { target: { value: " plant " } });
    fireEvent.change(field(added, "kind_field_label"), { target: { value: "Plant" } });
    fireEvent.change(field(added, "kind_field_heading"), { target: { value: "Plants" } });
    fireEvent.change(field(added, "kind_field_values"), { target: { value: "flora, , herb " } });
    fireEvent.click(screen.getByText("kinds_save"));
    expect(submitted()).toMatchObject({ intent: "save-kinds", base: '[{"id":"creature"}]' });
    expect(submitted()).not.toHaveProperty("seenRepo");
    expect(savedKinds()).toEqual([
      { id: "creature", label: "Creature", heading: "Creatures", values: ["Creatures", "bicho"], from: "creature" },
      { id: "plant", label: "Plant", heading: "Plants", values: ["flora", "herb"] },
    ]);
  });

  it("edits a kind, and sends the repository's kinds the page showed in place of a base when it read none", () => {
    open({ stored: null, kinds: { ...kinds, repoSite: '[{"id":"creature"}]' } });
    fireEvent.change(field(rows()[0], "kind_field_label"), { target: { value: "Beast" } });
    fireEvent.click(screen.getByText("kinds_save"));
    expect(submitted()).not.toHaveProperty("base");
    expect(submitted().seenRepo).toBe('[{"id":"creature"}]');
    expect(savedKinds()[0]).toMatchObject({ id: "creature", label: "Beast" });
  });

  it("sends a value as read while its field is untouched, a comma in it included", () => {
    const odd = { ...creature, values: ["Smith, John", "True", '{"a":1,"b":2}'] };
    open({ kinds: { ...kinds, site: [odd] } });
    expect(field(rows()[0], "kind_field_values").value).toBe('Smith, John, True, {"a":1,"b":2}');
    fireEvent.click(screen.getByText("kinds_save"));
    expect(savedKinds()[0].values).toEqual(["Smith, John", "True", '{"a":1,"b":2}']);
  });

  it("splits the values on commas once the field is edited", () => {
    const odd = { ...creature, values: ["Smith, John"] };
    open({ kinds: { ...kinds, site: [odd] } });
    fireEvent.change(field(rows()[0], "kind_field_values"), { target: { value: "Smith, John, Doe" } });
    fireEvent.click(screen.getByText("kinds_save"));
    expect(savedKinds()[0].values).toEqual(["Smith", "John", "Doe"]);
  });

  it("removes a kind no entry uses after saying so", () => {
    open({ ydoc: docWith(["term"]) });
    fireEvent.click(within(rows()[0]).getByText("kinds_remove"));
    expect(screen.getByRole("alert").textContent).toContain("kind_remove_confirm_none");
    fireEvent.click(within(screen.getByRole("alert")).getByText("kinds_remove"));
    expect(rows()).toHaveLength(0);
    expect(screen.getByText("kinds_none")).toBeTruthy();
    fireEvent.click(screen.getByText("kinds_save"));
    expect(savedKinds()).toEqual([]);
  });

  it("says how many entries a removed kind leaves, and what the site reads them as", () => {
    open({ ydoc: docWith(["creature", "Bicho", "term", ""]) });
    fireEvent.click(within(rows()[0]).getByText("kinds_remove"));
    const confirm = screen.getByRole("alert").textContent ?? "";
    expect(confirm).toContain("kind_remove_confirm ");
    expect(confirm).toContain('"count":2');
    // What the site lists the entries as, so the site's label.
    expect(confirm).toContain('"default":"Palabra clave"');
    fireEvent.click(within(screen.getByRole("alert")).getByText("common:cancel"));
    expect(rows()).toHaveLength(1);
  });

  it("words the removal of a kind with one entry in the singular", async () => {
    open({ ydoc: docWith(["bicho", "term"]) });
    fireEvent.click(within(rows()[0]).getByText("kinds_remove"));
    expect(screen.getByRole("alert").textContent).toContain('"count":1');
    const i18n = i18next.createInstance();
    await i18n.init({ lng: "en", resources: { en: { glossary: enGlossary } } });
    const confirm = (count: number) => i18n.t("glossary:kind_remove_confirm", { label: "Creature", count, default: "Key term" });
    expect(confirm(1)).toBe(
      "Remove Creature? Its one term keeps its kind as written, and the site lists it as Key term until you choose another kind for it.",
    );
    expect(confirm(2)).toBe(
      "Remove Creature? Its 2 terms keep their kind as written, and the site lists them as Key term until you choose another kind for each.",
    );
  });

  it("shows a field's finding once it is left, and every finding on save, without saving", () => {
    open();
    fireEvent.click(screen.getByText("kinds_add"));
    const added = rows()[1];
    expect(within(added).queryByText(/^kind_error_id_required/)).toBeNull();
    fireEvent.blur(field(added, "kind_field_id"));
    expect(within(added).getByText(/^kind_error_id_required/)).toBeTruthy();
    expect(within(added).queryByText(/^kind_error_label_required/)).toBeNull();
    fireEvent.change(field(added, "kind_field_id"), { target: { value: "Fuente" } });
    // Named as the standard kinds list above names it, in the interface language.
    expect(within(added).getByText(/kind_error_id_taken/).textContent).toContain('"kind":"kind_name_source"');
    fireEvent.click(screen.getByText("kinds_save"));
    expect(within(added).getByText(/^kind_error_label_required/)).toBeTruthy();
    expect(within(added).getByText(/^kind_error_heading_required/)).toBeTruthy();
    expect(fetcher.submit).not.toHaveBeenCalled();
  });

  it("counts a kind's entries and notes that a changed id moves them", () => {
    open({ ydoc: docWith(["creature", "CREATURES", "source", "bicho"]) });
    expect(within(rows()[0]).getByText(/kind_entries_using/).textContent).toContain('"count":3');
    expect(within(rows()[0]).queryByText("kind_id_change_note")).toBeNull();
    fireEvent.change(field(rows()[0], "kind_field_id"), { target: { value: "animal" } });
    expect(within(rows()[0]).getByText("kind_id_change_note")).toBeTruthy();
  });

  it("says why a kind the repository writes is left out", () => {
    const rejected = {
      id: "source",
      label: "Fuente",
      heading: "Fuentes",
      values: [],
      problems: { id: { key: "kind_error_id_taken" as const, value: "source", kind: "Primary source" } },
    };
    open({ kinds: { ...kinds, site: [creature, rejected] } });
    const note = within(rows()[1]).getByText(/kind_unusable_in_repo/).textContent ?? "";
    expect(note).toContain("kind_error_id_taken");
    expect(within(rows()[0]).queryByText(/kind_unusable_in_repo/)).toBeNull();
  });

  it("counts the entries a left-out kind names, and none that a standard kind owns", () => {
    const taken = { ...creature, id: "source", values: [], problems: { id: { key: "kind_error_id_taken" as const } } };
    const plant = { id: "plant", label: "Plant", heading: "", values: ["flora"], problems: { heading: { key: "kind_error_heading_required" as const } } };
    open({ kinds: { ...kinds, site: [taken, plant] }, ydoc: docWith(["source", "Fuente", "plant", "Flora"]) });
    expect(within(rows()[0]).queryByText(/kind_entries_using/)).toBeNull();
    expect(within(rows()[1]).getByText(/kind_entries_using/).textContent).toContain('"count":2');
  });

  it("moves every entry of a renamed kind to its new id once the save reports it", () => {
    const ydoc = docWith(["creature", "Bicho", "term", "fuente"]);
    const { onClose, rerender } = open({ ydoc });
    fireEvent.change(field(rows()[0], "kind_field_id"), { target: { value: "animal" } });
    fireEvent.click(screen.getByText("kinds_save"));
    expect(savedKinds()[0]).toMatchObject({ id: "animal", from: "creature" });
    let transactions = 0;
    ydoc.on("afterTransaction", () => transactions++);
    fetcher.data = { intent: "save-kinds", ok: true, stored: "[]", renamed: { creature: "animal" } };
    rerender();
    expect(entryKindsOf(ydoc)).toEqual(["animal", "animal", "term", "fuente"]);
    expect(transactions).toBe(1);
    expect(showToast).toHaveBeenCalledWith({ type: "info", message: "kinds_saved" });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows a refused save and moves nothing", () => {
    const ydoc = docWith(["creature"]);
    const { onClose, rerender } = open({ ydoc });
    fireEvent.change(field(rows()[0], "kind_field_id"), { target: { value: "animal" } });
    fireEvent.click(screen.getByText("kinds_save"));
    fetcher.data = { intent: "save-kinds", ok: false, reason: "conflict", message: "kinds_conflict" };
    rerender();
    expect(screen.getByRole("alert").textContent).toBe("kinds_conflict");
    expect(entryKindsOf(ydoc)).toEqual(["creature"]);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("EditKindsButton", () => {
  it("shows for a role that may save where the site has kinds", () => {
    render(<EditKindsButton kinds={kinds} onClick={() => {}} />);
    expect(screen.getByText("kinds_edit")).toBeTruthy();
  });

  it("is hidden where the site has no kinds", () => {
    const { container } = render(<EditKindsButton kinds={NO_GLOSSARY_KINDS} onClick={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("is hidden from a viewer", () => {
    publisher = false;
    const { container } = render(<EditKindsButton kinds={kinds} onClick={() => {}} />);
    expect(container.innerHTML).toBe("");
  });
});
