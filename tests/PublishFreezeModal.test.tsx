// @vitest-environment jsdom
/**
 * The modal another member's publish puts over the editor: it names whoever
 * holds the publish, and the site rather than a story.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

let lock: { kind: "publish" | "upgrade" | "objects"; holderName: string | null } | null = null;

vi.mock("~/hooks/use-operation-lock", () => ({ useOperationLock: () => lock }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { name?: string }) => (opts?.name ? `${key}:${opts.name}` : key),
  }),
}));

import { PublishFreezeModal } from "~/components/ui/PublishFreezeModal";

const show = () => render(<PublishFreezeModal isPublishing publishError={false} onDismiss={() => {}} />);

beforeEach(() => {
  lock = null;
});

describe("PublishFreezeModal", () => {
  it("names the member who is publishing, written as a GitHub username", () => {
    lock = { kind: "publish", holderName: "ana-r" };
    show();
    expect(screen.getByText("publish_freeze_body_collaborator:@ana-r")).toBeTruthy();
  });

  it("names the holder generically when the member list does not have them", () => {
    lock = { kind: "publish", holderName: null };
    show();
    expect(screen.getByText("publish_freeze_body_collaborator:lock_holder_unknown")).toBeTruthy();
  });

  it("does not put an upgrade holder's name on a publish", () => {
    lock = { kind: "upgrade", holderName: "ana-r" };
    show();
    expect(screen.getByText("publish_freeze_body_collaborator:lock_holder_unknown")).toBeTruthy();
  });
});
