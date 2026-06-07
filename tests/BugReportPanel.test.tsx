// @vitest-environment jsdom
/**
 * This file pins the `BugReportPanel` UI contract — the in-app modal that
 * lets users file a GitHub issue without leaving the compositor. Covers
 * submit-disabled gating, inline-error first-render state, the
 * window.open call with the right URL and a toast on success, Escape
 * closes the panel, initial focus lands on the first textarea, removing
 * an attached recent-error hides it, and post-crash mode swaps the intro
 * + first-field label.
 *
 * @version v1.2.0-beta
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { BugReportPanel } from "../app/components/features/bug-report/BugReportPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts === "object") {
        return Object.entries(opts).reduce(
          (acc, [k, v]) => acc.replace(`{{${k}}}`, String(v)),
          key,
        );
      }
      return key;
    },
    i18n: { language: "en" },
  }),
}));

const showToast = vi.fn();
vi.mock("~/hooks/use-toast", () => ({
  useToast: () => ({ showToast, dismissToast: vi.fn() }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

beforeEach(() => {
  showToast.mockClear();
});

describe("BugReportPanel", () => {
  it("renders panel intro + three field labels + Continue button when open", () => {
    render(
      <BugReportPanel
        open={true}
        onClose={vi.fn()}
        mode="default"
        userLogin="testuser"
      />,
    );
    expect(screen.queryByText("panel_title")).not.toBeNull();
    expect(screen.queryByText("field_what_happened_label")).not.toBeNull();
    expect(screen.queryByText("field_expected_label")).not.toBeNull();
    expect(screen.queryByText("field_steps_label")).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: /submit_button/ }),
    ).not.toBeNull();
  });

  it("submit is disabled until 'What happened?' has ≥10 trimmed chars", () => {
    render(
      <BugReportPanel
        open={true}
        onClose={vi.fn()}
        mode="default"
        userLogin="testuser"
      />,
    );
    const submit = screen.getByRole("button", {
      name: /submit_button/,
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    const textarea = screen.getByLabelText("field_what_happened_label");
    fireEvent.change(textarea, { target: { value: "short" } });
    expect(submit.disabled).toBe(true);

    fireEvent.change(textarea, {
      target: { value: "this is at least ten chars" },
    });
    expect(submit.disabled).toBe(false);
  });

  it("renders no inline error on first render", () => {
    render(
      <BugReportPanel
        open={true}
        onClose={vi.fn()}
        mode="default"
        userLogin="testuser"
      />,
    );
    expect(screen.queryByText(/error|required|invalid/i)).toBeNull();
  });

  it("submit calls window.open with the right URL and shows a toast", () => {
    const openSpy = vi
      .spyOn(window, "open")
      .mockImplementation(() => null as Window | null);
    const onClose = vi.fn();
    render(
      <BugReportPanel
        open={true}
        onClose={onClose}
        mode="default"
        userLogin="testuser"
      />,
    );
    fireEvent.change(screen.getByLabelText("field_what_happened_label"), {
      target: { value: "ten characters at least here" },
    });
    fireEvent.click(screen.getByRole("button", { name: /submit_button/ }));
    expect(openSpy).toHaveBeenCalledTimes(1);
    const [url, target, features] = openSpy.mock.calls[0];
    expect(url).toContain("github.com/UCSB-AMPLab/telar-compositor/issues/new");
    expect(target).toBe("_blank");
    expect(features).toBe("noopener,noreferrer");
    // labels=bug query param
    expect(new URL(url as string).searchParams.get("labels")).toBe("bug");
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "info", message: "submit_toast" }),
    );
    expect(onClose).toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it("includes the repository in the submitted issue body when repoFullName is provided", () => {
    const openSpy = vi
      .spyOn(window, "open")
      .mockImplementation(() => null as Window | null);
    render(
      <BugReportPanel
        open={true}
        onClose={vi.fn()}
        mode="default"
        userLogin="testuser"
        repoFullName="olympia-m/my-site"
      />,
    );
    fireEvent.change(screen.getByLabelText("field_what_happened_label"), {
      target: { value: "ten characters at least here" },
    });
    fireEvent.click(screen.getByRole("button", { name: /submit_button/ }));
    const [url] = openSpy.mock.calls[0];
    const body = new URL(url as string).searchParams.get("body") ?? "";
    expect(body).toContain(
      "[olympia-m/my-site](https://github.com/olympia-m/my-site)",
    );
    openSpy.mockRestore();
  });

  it("Escape key closes the panel", () => {
    const onClose = vi.fn();
    render(
      <BugReportPanel
        open={true}
        onClose={onClose}
        mode="default"
        userLogin="testuser"
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("initial focus is on the 'What happened?' textarea after open", async () => {
    render(
      <BugReportPanel
        open={true}
        onClose={vi.fn()}
        mode="default"
        userLogin="testuser"
      />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const textarea = screen.getByLabelText("field_what_happened_label");
    expect(document.activeElement).toBe(textarea);
  });

  it("removing an item via × hides it from the disclosure list", () => {
    const { container } = render(
      <BugReportPanel
        open={true}
        onClose={vi.fn()}
        mode="default"
        userLogin="testuser"
      />,
    );
    // jsdom doesn't toggle <details> on summary click; open it manually so
    // the per-item × buttons are reachable in the DOM tree.
    const details = container.querySelector("details");
    if (details) details.open = true;
    // The i18n mock returns the key verbatim (without interpolating {{item}}),
    // so every attachment × button shares the same aria-label. Snapshot the
    // count, click one, expect the count to drop by 1.
    const before = container.querySelectorAll(
      'button[aria-label="attach_remove_aria"]',
    ).length;
    expect(before).toBeGreaterThan(0);
    fireEvent.click(
      container.querySelector(
        'button[aria-label="attach_remove_aria"]',
      ) as HTMLButtonElement,
    );
    const after = container.querySelectorAll(
      'button[aria-label="attach_remove_aria"]',
    ).length;
    expect(after).toBe(before - 1);
  });

  it("post-crash mode swaps the intro and first-field label", () => {
    render(
      <BugReportPanel
        open={true}
        onClose={vi.fn()}
        mode="post-crash"
        userLogin=""
      />,
    );
    expect(screen.queryByText("crash_panel_intro")).not.toBeNull();
    expect(screen.queryByText("crash_field_what_label")).not.toBeNull();
  });

  it("renders nothing when open=false", () => {
    const { container } = render(
      <BugReportPanel
        open={false}
        onClose={vi.fn()}
        mode="default"
        userLogin="testuser"
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
