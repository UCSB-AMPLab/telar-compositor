// @vitest-environment jsdom
/**
 * A glossary term's ID field: an empty ID and one another term uses are
 * refused with their messages; the sentence about links appears only when
 * links point at the term; a confirm passes the ID with leading and trailing
 * hyphens stripped.
 *
 * @version v1.5.5-beta
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => `${key}|${JSON.stringify(options ?? {})}`,
    i18n: { language: "en" },
  }),
}));

import { TermIdField } from "~/components/features/glossary/TermIdField";

afterEach(cleanup);

function setUp(linkCount = 0, canChange = true) {
  const onChange = vi.fn();
  render(
    <TermIdField termId="mita" otherTermIds={["encomienda"]} countLinks={() => linkCount} canChange={canChange} onChange={onChange} />,
  );
  fireEvent.click(screen.getByRole("button", { name: /^change_id/ }));
  return { onChange };
}

const editor = () => screen.getByRole("textbox") as HTMLInputElement;
const type = (value: string) => fireEvent.change(editor(), { target: { value } });

describe("TermIdField", () => {
  it("shows the term's address under the ID", () => {
    render(<TermIdField termId="mita" otherTermIds={[]} countLinks={() => 0} canChange onChange={vi.fn()} />);
    expect(screen.getByText('term_id_address|{"slug":"mita"}')).toBeTruthy();
  });

  it("offers no Change ID button to someone who may not change it", () => {
    render(<TermIdField termId="mita" otherTermIds={[]} countLinks={() => 0} canChange={false} onChange={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("refuses an empty ID", () => {
    const { onChange } = setUp();
    type("");
    expect(screen.getByRole("alert").textContent).toContain("term_id_empty");
    expect(screen.queryByRole("button", { name: /^change_id/ })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("refuses an ID another term uses, with no suffix added", () => {
    const { onChange } = setUp();
    type("encomienda");
    expect(screen.getByRole("alert").textContent).toContain('term_id_taken|{"id":"encomienda"}');
    expect(screen.queryByRole("group")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("filters typed text to the characters of a term ID", () => {
    setUp();
    type("Nueva Mita_1!");
    expect(editor().value).toBe("nueva-mita1");
  });

  it("types an accented letter as its plain form", () => {
    setUp();
    type("Nuevo Término Ñ");
    expect(editor().value).toBe("nuevo-termino-n");
  });

  it("states the address change, and the link sentence only when links exist", () => {
    setUp(0);
    type("mitayo");
    const text = screen.getByRole("group").textContent ?? "";
    expect(text).toContain('term_id_warning|{"old":"mita","new":"mitayo"}');
    expect(text).not.toContain("term_id_links");
    cleanup();
    setUp(3);
    type("mitayo");
    expect(screen.getByRole("group").textContent).toContain('term_id_links|{"count":3}');
  });

  it("confirms the ID with a leading or trailing hyphen stripped", () => {
    const { onChange } = setUp();
    type("-mitayo-");
    fireEvent.click(screen.getByRole("button", { name: /^change_id/ }));
    expect(onChange).toHaveBeenCalledWith("mitayo");
  });

  it("says nothing when the typed ID settles to the current one", () => {
    const { onChange } = setUp();
    type("mita-");
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
