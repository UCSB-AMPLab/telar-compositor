// @vitest-environment jsdom

/**
 * useRouteFieldSave's answers: a save resolves only on the action's own `ok`
 * answer, rejects on a refusal, on an answer that is not the action's, and
 * on a thrown action, and every save still waiting when its owner goes
 * rejects rather than hanging, so the field that asked keeps or reports its
 * draft.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { createRoutesStub, Link, Outlet } from "react-router";
import { fieldSaveConfirmationsHeld, stampFieldSaveAnswer, useRouteFieldSave, WithdrawnSave } from "~/hooks/use-route-field-save";
import { nextStamp } from "~/components/ui/target-saves";

type Outcome = "pending" | "resolved" | "rejected";

let answer: (form: Record<string, string>) => unknown = (form) => ({ ok: true, nonce: form.nonce });
let gate: Promise<void> | null = null;
const outcomes: Outcome[] = [];

afterEach(() => {
  cleanup();
  answer = (form) => ({ ok: true, nonce: form.nonce });
  gate = null;
  outcomes.length = 0;
});

function Owner() {
  const save = useRouteFieldSave();
  return (
    <button
      type="button"
      onClick={() => {
        const at = outcomes.push("pending") - 1;
        save({ intent: "x", value: "v" }).then(
          () => { outcomes[at] = "resolved"; },
          () => { outcomes[at] = "rejected"; },
        );
      }}
    >
      save
    </button>
  );
}

const posted: Array<Record<string, string>> = [];
const submitted: string[] = [];

/** Two saves at once, the second withdrawn while the first is out. */
function Withdrawing() {
  const save = useRouteFieldSave();
  return (
    <button
      type="button"
      onClick={() => {
        let withdrawn = false;
        const first = outcomes.push("pending") - 1;
        save({ intent: "x", value: "first" }, { onSubmit: () => submitted.push("first") }).then(
          () => { outcomes[first] = "resolved"; withdrawn = true; },
          () => { outcomes[first] = "rejected"; },
        );
        const second = outcomes.push("pending") - 1;
        save({ intent: "x", value: "second" }, { withdrawn: () => withdrawn, onSubmit: () => submitted.push("second") }).then(
          () => { outcomes[second] = "resolved"; },
          (error) => { outcomes[second] = error instanceof WithdrawnSave ? "rejected" : "pending"; },
        );
      }}
    >
      save both
    </button>
  );
}

function mount(strict = false) {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <>
          <Link to="/elsewhere">leave</Link>
          <Outlet />
        </>
      ),
      children: [
        {
          index: true,
          Component: Owner,
          action: async ({ request }: { request: Request }) => {
            const form = Object.fromEntries((await request.formData()).entries()) as Record<string, string>;
            if (gate) await gate;
            return answer(form);
          },
          ErrorBoundary: () => <p>route error</p>,
        },
        { path: "elsewhere", Component: () => <p>elsewhere</p> },
      ],
    },
  ]);
  render(strict ? <StrictMode><Stub initialEntries={["/"]} /></StrictMode> : <Stub initialEntries={["/"]} />);
}

describe("useRouteFieldSave: withdrawing a save not yet sent", () => {
  it("does not submit a save withdrawn before it reaches the front of the queue, and rejects it with WithdrawnSave", async () => {
    posted.length = 0;
    submitted.length = 0;
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: Withdrawing,
        action: async ({ request }: { request: Request }) => {
          const form = Object.fromEntries((await request.formData()).entries()) as Record<string, string>;
          posted.push(form);
          return { ok: true, nonce: form.nonce };
        },
      },
    ]);
    render(<Stub initialEntries={["/"]} />);
    fireEvent.click(screen.getByRole("button", { name: "save both" }));
    await waitFor(() => expect(outcomes).toEqual(["resolved", "rejected"]));
    expect(posted.map((form) => form.value)).toEqual(["first"]);
    // Only a save actually submitted says so.
    expect(submitted).toEqual(["first"]);
  });
});

describe("useRouteFieldSave", () => {
  it("saves under Strict Mode, whose effects run, clean up and run again on mount", async () => {
    mount(true);
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(outcomes).toEqual(["resolved"]));
  });

  it("resolves on the action's ok answer", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(outcomes).toEqual(["resolved"]));
  });

  it("rejects a refusal answered as data", async () => {
    answer = (form) => ({ ok: false, nonce: form.nonce });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(outcomes).toEqual(["rejected"]));
  });

  it("rejects an answer that is not the action's, such as an unknown intent", async () => {
    answer = () => ({ error: "Unknown intent" });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(outcomes).toEqual(["rejected"]));
  });

  it("rejects a save whose action throws, which the route answers with its error boundary", async () => {
    answer = () => {
      throw new Error("refused");
    };
    mount();
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await screen.findByText("route error");
    await waitFor(() => expect(outcomes).toEqual(["rejected"]));
  });

  it("rejects every save still waiting when its owner unmounts", async () => {
    let release: () => void = () => {};
    gate = new Promise<void>((resolve) => { release = resolve; });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("link", { name: "leave" }));
    await screen.findByText("elsewhere");
    await waitFor(() => expect(outcomes).toEqual(["rejected", "rejected"]));
    release();
  });
});

describe("the stamp a save's answer is received at", () => {
  it("is taken before the read the save starts, and the save resolves with it", async () => {
    let readAt = 0;
    let resolvedWith: number | undefined;
    function Saver() {
      const save = useRouteFieldSave();
      return (
        <button type="button" onClick={() => save({ intent: "x" }).then((at) => { resolvedWith = at; })}>
          save
        </button>
      );
    }
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: Saver,
        // The route's client loader stamps each read as it begins.
        loader: () => {
          readAt = nextStamp();
          return null;
        },
        action: async ({ request }: { request: Request }) => {
          const form = Object.fromEntries((await request.formData()).entries()) as Record<string, string>;
          const answer = { ok: true, nonce: form.nonce };
          stampFieldSaveAnswer(answer);
          return answer;
        },
      },
    ]);
    render(<Stub initialEntries={["/"]} />);
    const before = readAt;
    fireEvent.click(await screen.findByRole("button", { name: "save" }));
    await waitFor(() => expect(resolvedWith).toBeDefined());
    await waitFor(() => expect(readAt).toBeGreaterThan(before));
    expect(resolvedWith!).toBeLessThan(readAt);
  });
});

describe("answers nothing is waiting for", () => {
  it("keeps no confirmation for a save whose owner has gone, nor for a second answer", async () => {
    let release: (() => void) | null = null;
    let nonce = "";
    let settled: "resolved" | "rejected" | null = null;
    function Saver() {
      const save = useRouteFieldSave();
      return (
        <button
          type="button"
          onClick={() => save({ intent: "x" }).then(() => { settled = "resolved"; }, () => { settled = "rejected"; })}
        >
          save
        </button>
      );
    }
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: Saver,
        action: async ({ request }: { request: Request }) => {
          nonce = (await request.formData()).get("nonce") as string;
          await new Promise<void>((resolve) => { release = resolve; });
          return { ok: true, nonce };
        },
      },
    ]);
    const view = render(<Stub initialEntries={["/"]} />);
    fireEvent.click(await screen.findByRole("button", { name: "save" }));
    await waitFor(() => expect(release).not.toBeNull());
    view.unmount();
    await waitFor(() => expect(settled).toBe("rejected"));
    stampFieldSaveAnswer({ ok: true, nonce });
    stampFieldSaveAnswer({ ok: true, nonce });
    release!();
    expect(fieldSaveConfirmationsHeld()).toBe(0);
  });
});
