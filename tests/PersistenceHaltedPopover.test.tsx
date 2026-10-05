// @vitest-environment jsdom
/**
 * Pins `PersistenceHaltedPopover` — what an editor is told when a project's
 * saving has stopped, and what its convenor can do about it.
 *
 * The cases that matter are the ones where the popover has to say something
 * true about an uncertain state: a landed reset is not a healthy project, an
 * unreadable state is not a restored one, and a stale confirmation is not a
 * failure. Each renders its own line, and the retry stays available on the
 * generation the last successful read named.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// i18n echoes the key with its interpolations, so an assertion names the string
// the design specified rather than a rendered translation.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && Object.keys(opts).length > 0
        ? `${key}(${Object.entries(opts).map(([k, v]) => `${k}=${v}`).join(",")})`
        : key,
    i18n: { language: "en" },
  }),
}));

import { PersistenceHaltedPopover } from "~/components/features/site-status/popovers/PersistenceHaltedPopover";
import type { HaltSnapshot } from "~/hooks/use-persistence-halt";
import type { ResetOutcome } from "~/routes/api.persistence";

const HALT: HaltSnapshot = {
  projectId: 7,
  reason: "apply_failed",
  at: 1_700_000_000_000,
  generation: 4,
};

type Props = Parameters<typeof PersistenceHaltedPopover>[0];

function renderPopover(overrides: Partial<Props> = {}) {
  const onRestore = vi.fn();
  const onCheckAgain = vi.fn();
  const view = render(
    <PersistenceHaltedPopover
      halt={HALT}
      stateUnreadable={false}
      confirmedGeneration={4}
      lastReadHalted={true}
      haltedAgain={false}
      outcome={null}
      submitting={false}
      userRole="convenor"
      onCheckAgain={onCheckAgain}
      onRestore={onRestore}
      {...overrides}
    />,
  );
  return { ...view, onRestore, onCheckAgain };
}

describe("PersistenceHaltedPopover — what happened and why", () => {
  it.each([
    ["enforcement_failed"],
    ["fence_refused"],
    ["apply_failed"],
    ["log_corrupt"],
    ["bad_halt"],
  ])("renders the reason line for %s", (reason) => {
    renderPopover({ halt: { ...HALT, reason } });
    expect(screen.getByTestId("halted-reason").textContent).toBe(
      `site_status.halted.reason.${reason}`,
    );
  });

  it.each([["group_discarded"], ["something_new"], [null]])(
    "falls back to the generic reason for %s",
    (reason) => {
      renderPopover({ halt: { ...HALT, reason: reason as string | null } });
      expect(screen.getByTestId("halted-reason").textContent).toBe(
        "site_status.halted.reason.other",
      );
    },
  );

  it("renders the title and body for every member", () => {
    const { container } = renderPopover({ userRole: "collaborator" });
    expect(container.textContent).toContain("site_status.halted.title");
    expect(container.textContent).toContain("site_status.halted.body");
  });

  it("renders a since line when the marker carried a time", () => {
    renderPopover();
    expect(screen.getByTestId("halted-since").textContent).toContain(
      "site_status.halted.since",
    );
  });

  it("renders no since line when the marker carried none", () => {
    renderPopover({ halt: { ...HALT, at: null } });
    expect(screen.queryByTestId("halted-since")).toBeNull();
  });

  it("shows no save number anywhere", () => {
    const { container } = renderPopover();
    expect(container.textContent).not.toMatch(/\b(save|saves)\s*#?\d/i);
    expect(container.textContent).not.toContain("generation");
  });

  it("names the unreadable state when the last read failed", () => {
    renderPopover({ stateUnreadable: true, confirmedGeneration: null });
    expect(screen.getByTestId("halted-unreadable").textContent).toBe(
      "site_status.halted.unreadable_state",
    );
  });
});

describe("PersistenceHaltedPopover — who may restore", () => {
  it("offers no restore to a collaborator, and says whose job it is", () => {
    const { container } = renderPopover({ userRole: "collaborator" });
    expect(screen.queryByTestId("halted-restore")).toBeNull();
    expect(container.textContent).toContain("site_status.halted.ask_convenor");
  });

  it("offers no restore to an instructor", () => {
    renderPopover({ userRole: "instructor" });
    expect(screen.queryByTestId("halted-restore")).toBeNull();
  });

  it("offers the restore, with its cost stated, to a convenor", () => {
    const { container } = renderPopover();
    expect(screen.getByTestId("halted-restore")).toBeTruthy();
    expect(container.textContent).toContain("site_status.halted.restore_cost");
  });

  it("offers Check again to every member", () => {
    const { onCheckAgain } = renderPopover({ userRole: "collaborator" });
    fireEvent.click(screen.getByTestId("halted-check-again"));
    expect(onCheckAgain).toHaveBeenCalledTimes(1);
  });
});

describe("PersistenceHaltedPopover — the confirm carries what it is about", () => {
  it("carries the displayed project id and the confirmed generation", () => {
    const { onRestore } = renderPopover();
    fireEvent.click(screen.getByTestId("halted-restore"));
    const confirm = screen.getByTestId("halted-restore-confirm");
    expect(confirm.getAttribute("data-project-id")).toBe("7");
    expect(confirm.getAttribute("data-generation")).toBe("4");
    fireEvent.click(confirm);
    expect(onRestore).toHaveBeenCalledWith(4);
  });

  it("is disabled while no confirmed generation is held, and sends nothing", () => {
    const { onRestore } = renderPopover({
      confirmedGeneration: null,
      stateUnreadable: true,
    });
    fireEvent.click(screen.getByTestId("halted-restore"));
    const confirm = screen.getByTestId("halted-restore-confirm");
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(confirm);
    expect(onRestore).not.toHaveBeenCalled();
  });

  it("is enabled again once a read has confirmed a generation", () => {
    const { rerender, onRestore } = renderPopover({
      confirmedGeneration: null,
      stateUnreadable: true,
    });
    fireEvent.click(screen.getByTestId("halted-restore"));
    expect((screen.getByTestId("halted-restore-confirm") as HTMLButtonElement).disabled).toBe(true);

    rerender(
      <PersistenceHaltedPopover
        halt={HALT}
        stateUnreadable={false}
        confirmedGeneration={6}
        lastReadHalted={true}
        haltedAgain={false}
        outcome={null}
        submitting={false}
        userRole="convenor"
        onCheckAgain={vi.fn()}
        onRestore={onRestore}
      />,
    );
    const confirm = screen.getByTestId("halted-restore-confirm");
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    expect(confirm.getAttribute("data-generation")).toBe("6");
    fireEvent.click(confirm);
    expect(onRestore).toHaveBeenCalledWith(6);
  });

  it("disables the restore while the action is in flight", () => {
    renderPopover({ submitting: true });
    expect((screen.getByTestId("halted-restore") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("PersistenceHaltedPopover — each outcome renders its own line", () => {
  const cases: Array<[string, Partial<Props>, string]> = [
    [
      "a landed reset over a healthy project",
      { outcome: { kind: "landed" }, lastReadHalted: false },
      "site_status.halted.restored",
    ],
    [
      "a landed reset whose rebuild halted again",
      { outcome: { kind: "landed" }, lastReadHalted: true, haltedAgain: true },
      "site_status.halted.restored_halted_again(reason=site_status.halted.reason.apply_failed)",
    ],
    [
      "a stale confirmation",
      { outcome: { kind: "stale", generation: 9 }, lastReadHalted: false },
      "site_status.halted.stale",
    ],
    [
      "a refused reset",
      { outcome: { kind: "retry" }, lastReadHalted: false },
      "site_status.halted.retry",
    ],
    [
      "an uncertain reset",
      { outcome: { kind: "uncertain" }, lastReadHalted: false },
      "site_status.halted.uncertain",
    ],
    [
      "an unnamed failure",
      { outcome: { kind: "failed", status: 401, body: "Unauthorized" }, lastReadHalted: false },
      "site_status.halted.failed(status=401)",
    ],
  ];

  it.each(cases)("renders %s", (_label, props, expected) => {
    renderPopover(props);
    expect(screen.getByTestId("halted-outcome").textContent).toBe(expected);
  });

  it("says restored once, and names the unreadable state once, when the readback failed", () => {
    // The unreadable notice is the body's line, and "Reconnecting…" is a
    // promise a state nobody could read is not in a position to make.
    renderPopover({
      outcome: { kind: "landed" },
      lastReadHalted: null,
      stateUnreadable: true,
      confirmedGeneration: null,
    });
    expect(screen.getByTestId("halted-outcome").textContent).toBe(
      "site_status.halted.restored_short",
    );
    expect(screen.getAllByTestId("halted-unreadable")).toHaveLength(1);
    expect(screen.getByTestId("halted-check-again")).toBeTruthy();
  });

  it("takes a healthy read as restored even when the readback itself was dropped", () => {
    // Admission landed between the click and the response, discarding the
    // pre-reset state; nothing proves a new halt, so nothing may claim one.
    renderPopover({
      halt: null,
      outcome: { kind: "landed" },
      lastReadHalted: null,
      haltedAgain: false,
      stateUnreadable: false,
    });
    expect(screen.getByTestId("halted-outcome").textContent).toBe(
      "site_status.halted.restored",
    );
  });

  it.each([
    ["a stale confirmation", { kind: "stale", generation: 9 } as ResetOutcome],
    ["an uncertain reset", { kind: "uncertain" } as ResetOutcome],
  ])("shows the generation the state was last read at after %s", (_label, outcome) => {
    renderPopover({ outcome, lastReadHalted: true, confirmedGeneration: 9 });
    expect(screen.getByTestId("halted-observed").textContent).toBe(
      "site_status.halted.observed(generation=9)",
    );
  });

  it.each([
    ["a landed reset", { kind: "landed" } as ResetOutcome],
    ["a refused reset", { kind: "retry" } as ResetOutcome],
  ])("shows no observed generation after %s", (_label, outcome) => {
    renderPopover({ outcome, lastReadHalted: true, confirmedGeneration: 9 });
    expect(screen.queryByTestId("halted-observed")).toBeNull();
  });

  it("shows no observed generation while no read has confirmed one", () => {
    renderPopover({
      outcome: { kind: "uncertain" },
      confirmedGeneration: null,
      stateUnreadable: true,
      lastReadHalted: null,
    });
    expect(screen.queryByTestId("halted-observed")).toBeNull();
  });

  it("retires the reason and the time once a read has come back healthy", () => {
    // They describe a halt the object has stopped reporting; leaving them up
    // would make a refreshed reading look like the halt it replaced.
    renderPopover({ outcome: { kind: "stale", generation: 9 }, lastReadHalted: false });
    expect(screen.queryByTestId("halted-reason")).toBeNull();
    expect(screen.queryByTestId("halted-since")).toBeNull();
  });

  it("keeps the reason and the time while the read still reports the halt", () => {
    renderPopover({ outcome: { kind: "retry" }, lastReadHalted: true });
    expect(screen.getByTestId("halted-reason")).toBeTruthy();
    expect(screen.getByTestId("halted-since")).toBeTruthy();
  });

  it.each([
    ["stale", { kind: "stale", generation: 9 } as ResetOutcome],
    ["retry", { kind: "retry" } as ResetOutcome],
    ["uncertain", { kind: "uncertain" } as ResetOutcome],
    ["landed but halted again", { kind: "landed" } as ResetOutcome],
  ])("re-arms the restore on the newly read generation after %s", (_label, outcome) => {
    renderPopover({
      outcome,
      lastReadHalted: true,
      haltedAgain: true,
      confirmedGeneration: 9,
      submitting: false,
    });
    fireEvent.click(screen.getByTestId("halted-restore"));
    const confirm = screen.getByTestId("halted-restore-confirm");
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    expect(confirm.getAttribute("data-generation")).toBe("9");
    expect(screen.getByTestId("halted-check-again")).toBeTruthy();
  });

  it("keeps rendering the outcome after the halt itself has been cleared", () => {
    // Admission cleared the halt while the response was in flight. The pill's
    // state has moved on; what the convenor asked for still has an answer.
    renderPopover({ halt: null, outcome: { kind: "landed" }, lastReadHalted: false });
    expect(screen.getByTestId("persistence-halted-popover")).toBeTruthy();
    expect(screen.getByTestId("halted-outcome").textContent).toBe(
      "site_status.halted.restored",
    );
    expect(screen.queryByTestId("halted-reason")).toBeNull();
  });
});
