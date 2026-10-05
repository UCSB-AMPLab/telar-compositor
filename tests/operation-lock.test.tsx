// @vitest-environment jsdom
/**
 * The line on a waiting Publish or Upgrade button.
 *
 * While another member's publish or upgrade holds the lock the server refuses
 * to begin a second one, so the button says whose operation it is waiting on.
 * The holder is named from the layout's member list, as the team pages name a
 * GitHub user; one missing from the list is named generically rather than
 * shown as a number.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const ctx = {
  publishHeldBy: null as number | null,
  upgradeHeldBy: null as number | null,
  objectsHeldBy: null as number | null,
};
let members: Array<{ userId: number; username: string }> = [];

vi.mock("~/hooks/use-collaboration", () => ({ useCollaborationContext: () => ctx }));
vi.mock("react-router", () => ({ useRouteLoaderData: () => ({ sidebarMembers: members }) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { name?: string }) => (opts?.name ? `${key}:${opts.name}` : key),
  }),
}));

import { useOperationLock } from "~/hooks/use-operation-lock";
import { OperationLockNotice } from "~/components/features/collaboration/OperationLockNotice";

function Probe({ waiting }: { waiting: "publish" | "upgrade" }) {
  const lock = useOperationLock();
  return lock ? <OperationLockNotice lock={lock} waiting={waiting} /> : <p>free</p>;
}

beforeEach(() => {
  ctx.publishHeldBy = null;
  ctx.upgradeHeldBy = null;
  ctx.objectsHeldBy = null;
  members = [{ userId: 8, username: "ana" }];
});

describe("the waiting button's line", () => {
  it("says nothing while no other member holds the lock", () => {
    render(<Probe waiting="publish" />);
    expect(screen.getByText("free")).toBeTruthy();
  });

  it("names the member publishing, as a GitHub user", () => {
    ctx.publishHeldBy = 8;
    render(<Probe waiting="upgrade" />);
    expect(screen.getByRole("status").textContent).toBe("lock_upgrade_while_publishing:@ana");
  });

  it("names an upgrade ahead of a publish", () => {
    ctx.publishHeldBy = 8;
    ctx.upgradeHeldBy = 8;
    render(<Probe waiting="publish" />);
    expect(screen.getByRole("status").textContent).toBe("lock_publish_while_upgrading:@ana");
  });

  it("names the member adding objects, on either button", () => {
    ctx.objectsHeldBy = 8;
    const { unmount } = render(<Probe waiting="publish" />);
    expect(screen.getByRole("status").textContent).toBe("lock_publish_while_adding_objects:@ana");
    unmount();
    render(<Probe waiting="upgrade" />);
    expect(screen.getByRole("status").textContent).toBe("lock_upgrade_while_adding_objects:@ana");
  });

  it("names a publish ahead of an objects commit", () => {
    ctx.objectsHeldBy = 8;
    ctx.publishHeldBy = 8;
    render(<Probe waiting="upgrade" />);
    expect(screen.getByRole("status").textContent).toBe("lock_upgrade_while_publishing:@ana");
  });

  it("names a holder missing from the member list generically", () => {
    ctx.upgradeHeldBy = 99;
    render(<Probe waiting="upgrade" />);
    expect(screen.getByRole("status").textContent).toBe("lock_upgrade_while_upgrading:lock_holder_unknown");
  });
});
