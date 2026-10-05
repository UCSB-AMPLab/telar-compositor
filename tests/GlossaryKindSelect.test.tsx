// @vitest-environment jsdom
/**
 * The kind choice beside a glossary entry's title: the site's kinds in order,
 * a stored value that names none kept and shown as written, nothing at all for
 * a site without kinds.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      key === "kind_unknown" ? `${options?.value} (not a known kind, so the site shows it as ${options?.kind})` : key,
  }),
}));

import { GlossaryKindSelect } from "~/components/features/glossary/GlossaryKindSelect";
import { NO_GLOSSARY_KINDS, type GlossaryKinds } from "~/lib/glossary-kinds";

const kinds: GlossaryKinds = {
  available: true,
  defaultId: "term",
  options: [
    { id: "term", label: "Key term", aliases: ["term"] },
    { id: "source", label: "Primary source", aliases: ["source", "fuente"] },
    { id: "species", label: "Especie", aliases: ["species"] },
  ],
  core: [],
  site: [],
};

describe("GlossaryKindSelect", () => {
  it("lists the kinds in order under their labels", () => {
    render(<GlossaryKindSelect kinds={kinds} value="" onChange={() => {}} />);
    const labels = screen.getAllByRole("option").map((o) => o.textContent);
    expect(labels).toEqual(["Key term", "Primary source", "Especie"]);
    expect(((screen.getByRole("combobox") as unknown as HTMLSelectElement)).value).toBe("term");
  });

  it("selects the kind a spelling of it names, without rewriting the stored value", () => {
    const onChange = vi.fn();
    render(<GlossaryKindSelect kinds={kinds} value="Fuente" onChange={onChange} />);
    expect(((screen.getByRole("combobox") as unknown as HTMLSelectElement)).value).toBe("source");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps a value that names no kind as an option of its own, saying how the site shows it", () => {
    render(<GlossaryKindSelect kinds={kinds} value="Fuente??" onChange={() => {}} />);
    const select = (screen.getByRole("combobox") as unknown as HTMLSelectElement);
    expect(select.value).toBe("Fuente??");
    expect(screen.getAllByRole("option")[0].textContent).toBe(
      "Fuente?? (not a known kind, so the site shows it as Key term)",
    );
  });

  it("reports the id of the kind picked", () => {
    const onChange = vi.fn();
    render(<GlossaryKindSelect kinds={kinds} value="" onChange={onChange} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "species" } });
    expect(onChange).toHaveBeenCalledWith("species");
  });

  it("shows nothing for a site without kinds", () => {
    const { container } = render(<GlossaryKindSelect kinds={NO_GLOSSARY_KINDS} value="source" onChange={() => {}} />);
    expect(container.innerHTML).toBe("");
  });
});
