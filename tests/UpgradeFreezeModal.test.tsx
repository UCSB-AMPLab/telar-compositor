// @vitest-environment jsdom
/**
 * UpgradeFreezeModal.test.tsx — wrapper around FreezeModal for the upgrade flow.
 *
 * Tests the wrapper reads upgrade_freeze_* keys from the collaboration
 * namespace and passes them through to FreezeModal with labelId='upgrade-freeze-heading'.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { UpgradeFreezeModal } from "~/components/ui/UpgradeFreezeModal";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: () => Promise.resolve() },
  }),
}));

describe("UpgradeFreezeModal", () => {
  it("renders nothing when inactive", () => {
    const { container } = render(
      <UpgradeFreezeModal
        isUpgrading={false}
        upgradeError={false}
        isOwner={false}
        onDismiss={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders upgrade_freeze_heading when isUpgrading=true", () => {
    render(
      <UpgradeFreezeModal
        isUpgrading={true}
        upgradeError={false}
        isOwner={false}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText("upgrade_freeze_heading")).toBeTruthy();
    expect(screen.getByText("upgrade_freeze_body_collaborator")).toBeTruthy();
  });

  it("renders upgrade_freeze_body_owner when isOwner=true", () => {
    render(
      <UpgradeFreezeModal
        isUpgrading={true}
        upgradeError={false}
        isOwner={true}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText("upgrade_freeze_body_owner")).toBeTruthy();
    expect(screen.queryByText("upgrade_freeze_body_collaborator")).toBeNull();
  });

  it("renders error state when upgradeError=true", () => {
    render(
      <UpgradeFreezeModal
        isUpgrading={false}
        upgradeError={true}
        isOwner={false}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText("upgrade_freeze_error_heading")).toBeTruthy();
    expect(screen.getByText("upgrade_freeze_error_body")).toBeTruthy();
    expect(screen.getByRole("button", { name: "upgrade_freeze_dismiss" })).toBeTruthy();
  });

  it("fires onDismiss when dismiss clicked", () => {
    const onDismiss = vi.fn();
    render(
      <UpgradeFreezeModal
        isUpgrading={false}
        upgradeError={true}
        isOwner={false}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "upgrade_freeze_dismiss" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("uses labelId='upgrade-freeze-heading' on the dialog", () => {
    render(
      <UpgradeFreezeModal
        isUpgrading={true}
        upgradeError={false}
        isOwner={false}
        onDismiss={() => {}}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-labelledby")).toBe("upgrade-freeze-heading");
  });
});
