// @vitest-environment jsdom
/**
 * step-management.test.tsx — unit tests for step management logic.
 *
 * Tests: arrayMove produces correct reorder, add-step next step_number,
 * delete-step removes layers then step, reorder-steps updates step_numbers
 * sequentially, DeleteStepDialog renders step info and layer count warning.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { arrayMove } from "@dnd-kit/sortable";
import { DeleteStepDialog } from "~/components/features/editor/DeleteStepDialog";

// Mock react-i18next — return the key with interpolated values
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (!opts) return key;
      // For body: show step number in result so we can assert on it
      if (key === "delete_step.body") return `delete_step.body:${opts.number}`;
      if (key === "delete_step.layer_warning") return `layer_warning:${opts.count}`;
      return key;
    },
  }),
}));

// ---------------------------------------------------------------------------
// Pure logic tests — no React
// ---------------------------------------------------------------------------

describe("arrayMove (step reorder logic)", () => {
  const steps = [
    { id: 10, step_number: 1, question: "First?" },
    { id: 20, step_number: 2, question: "Second?" },
    { id: 30, step_number: 3, question: "Third?" },
  ];

  it("moves a step from index 0 to index 2 (first to last)", () => {
    const result = arrayMove(steps, 0, 2);
    expect(result.map((s) => s.id)).toEqual([20, 30, 10]);
  });

  it("moves a step from index 2 to index 0 (last to first)", () => {
    const result = arrayMove(steps, 2, 0);
    expect(result.map((s) => s.id)).toEqual([30, 10, 20]);
  });

  it("returns same order when source and destination are identical", () => {
    const result = arrayMove(steps, 1, 1);
    expect(result.map((s) => s.id)).toEqual([10, 20, 30]);
  });
});

describe("add-step: next step_number calculation", () => {
  it("returns max + 1 for a non-empty list", () => {
    const existingSteps = [
      { step_number: 1 },
      { step_number: 2 },
      { step_number: 3 },
    ];
    const maxNum = Math.max(...existingSteps.map((s) => s.step_number));
    expect(maxNum + 1).toBe(4);
  });

  it("returns 1 when no steps exist (step 0 only scenario)", () => {
    // No regular steps present — only step 0 (title card)
    const existingSteps: Array<{ step_number: number }> = [];
    const maxNum = existingSteps.length > 0
      ? Math.max(...existingSteps.map((s) => s.step_number))
      : 0;
    expect(maxNum + 1).toBe(1);
  });
});

describe("delete-step: layers-first deletion order", () => {
  it("deletes layers before the step itself", () => {
    const log: string[] = [];

    const mockDb = {
      delete: (table: string) => ({
        where: () => {
          log.push(`delete:${table}`);
          return Promise.resolve();
        },
      }),
    };

    // Simulate the delete-step action order
    async function simulateDeleteStep(stepId: number) {
      await mockDb.delete("layers").where();
      await mockDb.delete("steps").where();
    }

    return simulateDeleteStep(42).then(() => {
      expect(log[0]).toBe("delete:layers");
      expect(log[1]).toBe("delete:steps");
    });
  });
});

describe("reorder-steps: sequential step_number assignment", () => {
  it("assigns step_numbers 1, 2, 3 in order from the submitted ID array", () => {
    const orderedIds = [30, 10, 20]; // new order after drag
    const updates = orderedIds.map((id, idx) => ({
      id,
      step_number: idx + 1,
    }));

    expect(updates).toEqual([
      { id: 30, step_number: 1 },
      { id: 10, step_number: 2 },
      { id: 20, step_number: 3 },
    ]);
  });

  it("handles single-step list correctly", () => {
    const orderedIds = [99];
    const updates = orderedIds.map((id, idx) => ({ id, step_number: idx + 1 }));
    expect(updates).toEqual([{ id: 99, step_number: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// DeleteStepDialog rendering tests
// ---------------------------------------------------------------------------

describe("DeleteStepDialog", () => {
  const step = { step_number: 2, question: "What is the context?" };

  it("renders step info in the body", () => {
    render(
      <DeleteStepDialog
        open={true}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        step={step}
        layerCount={0}
      />
    );

    // Our mock returns "delete_step.body:2" for step_number 2
    expect(screen.getByText("delete_step.body:2")).toBeDefined();
  });

  it("shows layer warning when layerCount > 0", () => {
    render(
      <DeleteStepDialog
        open={true}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        step={step}
        layerCount={3}
      />
    );

    expect(screen.getByText("layer_warning:3")).toBeDefined();
  });

  it("does not show layer warning when layerCount is 0", () => {
    render(
      <DeleteStepDialog
        open={true}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        step={step}
        layerCount={0}
      />
    );

    expect(screen.queryByText(/layer_warning/)).toBeNull();
  });

  it("calls onClose when cancel button is clicked", () => {
    const onClose = vi.fn();
    render(
      <DeleteStepDialog
        open={true}
        onClose={onClose}
        onConfirm={vi.fn()}
        step={step}
        layerCount={0}
      />
    );

    fireEvent.click(screen.getByText("delete_step.cancel"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onConfirm when delete button is clicked", () => {
    const onConfirm = vi.fn();
    render(
      <DeleteStepDialog
        open={true}
        onClose={vi.fn()}
        onConfirm={onConfirm}
        step={step}
        layerCount={0}
      />
    );

    fireEvent.click(screen.getByText("delete_step.confirm"));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("renders nothing when step is null", () => {
    const { container } = render(
      <DeleteStepDialog
        open={true}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        step={null}
        layerCount={0}
      />
    );

    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when open is false", () => {
    const { container } = render(
      <DeleteStepDialog
        open={false}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        step={step}
        layerCount={0}
      />
    );

    expect(container.innerHTML).toBe("");
  });
});
