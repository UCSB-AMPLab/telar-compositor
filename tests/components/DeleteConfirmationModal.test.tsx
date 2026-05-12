// @vitest-environment jsdom

/**
 * This file pins the `DeleteConfirmationModal` `confirmText` and
 * `destructiveColor` extension — the type-to-confirm workflow added
 * for high-stakes deletes like account removal.
 *
 * Back-compat is verified: existing structural callers (no
 * `confirmText`, no `destructiveColor`) still get the original
 * red button + Cancel-on-open focus.
 *
 * @version v1.2.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { DeleteConfirmationModal } from "~/components/ui/DeleteConfirmationModal";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: any) => {
      if (key === "delete_confirm_title") return `Delete ${opts?.label}?`;
      if (key === "btn_cancel") return "Cancel";
      if (key === "btn_delete") return "Delete";
      if (key === "btn_undo_confirm") return "Undo";
      if (key === "delete_confirm_undo_title") return "Undo add?";
      if (key === "delete_confirm_undo_body") return "This will undo the add.";
      if (key === "type_to_confirm_label") return `Type ${opts?.value} to confirm.`;
      if (key === "type_to_confirm_aria") return `Type ${opts?.value} to confirm`;
      if (key === "content_summary") return opts?.summary;
      if (key === "contributor_warning") return `Contains edits by ${opts?.names}`;
      return key;
    },
  }),
}));

afterEach(() => {
  cleanup();
});

describe("DeleteConfirmationModal — back-compat (no extension props)", () => {
  it("renders with default red destructive button (bg-red-600) and focuses Cancel on open", async () => {
    const { getByText } = render(
      <DeleteConfirmationModal
        open
        onClose={() => {}}
        onConfirm={() => {}}
        entityType="story"
        entityLabel="My Story"
      />,
    );

    const deleteBtn = getByText("Delete");
    expect(deleteBtn.className).toContain("bg-red-600");
    expect(deleteBtn.className).not.toContain("bg-terracotta");
    expect((deleteBtn as HTMLButtonElement).disabled).toBe(false);

    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const cancelBtn = getByText("Cancel");
    expect(document.activeElement).toBe(cancelBtn);
  });
});

describe("DeleteConfirmationModal — confirmText type-to-confirm", () => {
  it("Confirm is disabled until input value strictly equals confirmText (case-sensitive)", () => {
    const { getByText, container } = render(
      <DeleteConfirmationModal
        open
        onClose={() => {}}
        onConfirm={() => {}}
        entityType="project"
        entityLabel="my-project"
        confirmText="my-project"
      />,
    );
    const deleteBtn = getByText("Delete") as HTMLButtonElement;
    expect(deleteBtn.disabled).toBe(true);

    const input = container.querySelector("input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "My-Project" } });
    expect(deleteBtn.disabled).toBe(true); // case mismatch

    fireEvent.change(input, { target: { value: "my-project" } });
    expect(deleteBtn.disabled).toBe(false);
  });

  it("focus moves to the input on open (not Cancel) when confirmText is set", async () => {
    const { container } = render(
      <DeleteConfirmationModal
        open
        onClose={() => {}}
        onConfirm={() => {}}
        entityType="project"
        entityLabel="thing"
        confirmText="thing"
      />,
    );
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const input = container.querySelector("input");
    expect(document.activeElement).toBe(input);
  });

  it("typed state resets between open transitions", () => {
    const { container, rerender, getByText } = render(
      <DeleteConfirmationModal
        open
        onClose={() => {}}
        onConfirm={() => {}}
        entityType="project"
        entityLabel="thing"
        confirmText="thing"
      />,
    );
    const input = container.querySelector("input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "thing" } });
    expect((getByText("Delete") as HTMLButtonElement).disabled).toBe(false);

    // Close
    rerender(
      <DeleteConfirmationModal
        open={false}
        onClose={() => {}}
        onConfirm={() => {}}
        entityType="project"
        entityLabel="thing"
        confirmText="thing"
      />,
    );
    // Re-open
    rerender(
      <DeleteConfirmationModal
        open
        onClose={() => {}}
        onConfirm={() => {}}
        entityType="project"
        entityLabel="thing"
        confirmText="thing"
      />,
    );
    const input2 = container.querySelector("input") as HTMLInputElement;
    expect(input2.value).toBe("");
    expect((getByText("Delete") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("DeleteConfirmationModal — destructiveColor", () => {
  it("destructiveColor='terracotta' renders bg-terracotta (not bg-red-600)", () => {
    const { getByText } = render(
      <DeleteConfirmationModal
        open
        onClose={() => {}}
        onConfirm={() => {}}
        entityType="project"
        entityLabel="My Project"
        destructiveColor="terracotta"
      />,
    );
    const deleteBtn = getByText("Delete");
    expect(deleteBtn.className).toContain("bg-terracotta");
    expect(deleteBtn.className).not.toContain("bg-red-600");
  });

  it("destructiveColor='red' (or unset) preserves bg-red-600 (back-compat)", () => {
    const { getByText } = render(
      <DeleteConfirmationModal
        open
        onClose={() => {}}
        onConfirm={() => {}}
        entityType="story"
        entityLabel="X"
        destructiveColor="red"
      />,
    );
    const deleteBtn = getByText("Delete");
    expect(deleteBtn.className).toContain("bg-red-600");
    expect(deleteBtn.className).not.toContain("bg-terracotta");
  });
});
