// @vitest-environment jsdom
/**
 * The locked ID field the story settings and the glossary share: the ID rests
 * in a grey box with a Change ID button; the button opens an editor whose
 * typing passes through the filter; a problem blocks the confirm; the confirm
 * hands the value to the caller; Cancel and Escape discard.
 *
 * @version v1.5.5-beta
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

import { LockedIdField } from "~/components/ui/LockedIdField";

afterEach(cleanup);

function setUp(over: Partial<React.ComponentProps<typeof LockedIdField>> = {}) {
  const onConfirm = vi.fn();
  render(
    <LockedIdField
      label="Thing ID"
      inputId="thing-id"
      value="alpha"
      canChange
      addressNote="Part of the address: /alpha/"
      filterTyped={(raw) => raw.toLowerCase().replace(/[^a-z]/g, "")}
      problem={(candidate) => (candidate === "taken" ? "Taken." : null)}
      consequences={(candidate) => <p>{`Changes to ${candidate}.`}</p>}
      onConfirm={onConfirm}
      {...over}
    />,
  );
  return { onConfirm };
}

const change = () => screen.getByRole("button", { name: "change_id" });
const editor = () => screen.getByRole("textbox") as HTMLInputElement;

describe("LockedIdField", () => {
  it("rests as the ID, its address note and a Change ID button", () => {
    setUp();
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.getByText("Part of the address: /alpha/")).toBeTruthy();
    expect(change()).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("labels both buttons with changeLabel when one is given", () => {
    setUp({ changeLabel: "Change" });
    expect(screen.queryByRole("button", { name: "change_id" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.change(editor(), { target: { value: "beta" } });
    expect(screen.getAllByRole("button", { name: "Change" })).toHaveLength(1);
    expect(screen.getByRole("group").querySelector("button")!.textContent).toBe("Change");
  });

  it("has no button when the ID cannot be changed", () => {
    setUp({ canChange: false });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("alpha")).toBeTruthy();
  });

  it("opens a focused editor holding the current ID", () => {
    setUp();
    fireEvent.click(change());
    expect(editor().value).toBe("alpha");
    expect(document.activeElement).toBe(editor());
  });

  it("filters what is typed, so a disallowed character never appears", () => {
    setUp();
    fireEvent.click(change());
    fireEvent.change(editor(), { target: { value: "Be-ta 9" } });
    expect(editor().value).toBe("beta");
  });

  it("shows the consequences only for a changed, allowed ID", () => {
    setUp();
    fireEvent.click(change());
    expect(screen.queryByRole("group")).toBeNull();
    fireEvent.change(editor(), { target: { value: "beta" } });
    expect(screen.getByRole("group").textContent).toContain("Changes to beta.");
  });

  it("shows a problem, and offers no confirm while there is one", () => {
    const { onConfirm } = setUp();
    fireEvent.click(change());
    fireEvent.change(editor(), { target: { value: "taken" } });
    expect(screen.getByRole("alert").textContent).toBe("Taken.");
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.queryByRole("button", { name: "change_id" })).toBeNull();
    fireEvent.keyDown(editor(), { key: "Enter" });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("confirms with the value and closes the editor", () => {
    const { onConfirm } = setUp();
    fireEvent.click(change());
    fireEvent.change(editor(), { target: { value: "beta" } });
    fireEvent.click(screen.getByRole("button", { name: "change_id" }));
    expect(onConfirm).toHaveBeenCalledWith("beta");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("confirms on Enter when the ID is allowed", () => {
    const { onConfirm } = setUp();
    fireEvent.click(change());
    fireEvent.change(editor(), { target: { value: "beta" } });
    fireEvent.keyDown(editor(), { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledWith("beta");
  });

  it("discards on Cancel", () => {
    const { onConfirm } = setUp();
    fireEvent.click(change());
    fireEvent.change(editor(), { target: { value: "beta" } });
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(change());
    expect(editor().value).toBe("alpha");
  });

  it("discards on Escape", () => {
    const { onConfirm } = setUp();
    fireEvent.click(change());
    fireEvent.change(editor(), { target: { value: "beta" } });
    fireEvent.keyDown(editor(), { key: "Escape" });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("checks and confirms the settled ID, not the typed text", () => {
    const { onConfirm } = setUp({
      filterTyped: (raw) => raw,
      settle: (typed) => typed.replace(/^-+|-+$/g, ""),
    });
    fireEvent.click(change());
    fireEvent.change(editor(), { target: { value: "-beta-" } });
    expect(editor().value).toBe("-beta-");
    fireEvent.click(screen.getByRole("button", { name: "change_id" }));
    expect(onConfirm).toHaveBeenCalledWith("beta");
  });
});
