// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Switch } from "~/components/ui/Switch";

describe("Switch", () => {
  it("renders with role='switch' and aria-checked=false when unchecked", () => {
    render(<Switch checked={false} onChange={() => {}} label="Toggle" />);
    const toggle = screen.getByRole("switch");
    expect(toggle).toBeDefined();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("renders with aria-checked=true when checked", () => {
    render(<Switch checked={true} onChange={() => {}} label="Toggle" />);
    const toggle = screen.getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("calls onChange with toggled value on click", () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} label="Toggle" />);
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("calls onChange with false when checked and clicked", () => {
    const onChange = vi.fn();
    render(<Switch checked={true} onChange={onChange} label="Toggle" />);
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("does not call onChange when disabled", () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} label="Toggle" disabled />);
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("sets aria-label from label prop", () => {
    render(<Switch checked={false} onChange={() => {}} label="Draft mode" />);
    expect(screen.getByRole("switch").getAttribute("aria-label")).toBe("Draft mode");
  });
});
