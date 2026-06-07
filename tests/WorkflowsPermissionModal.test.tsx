// @vitest-environment jsdom
/**
 * Pins the WorkflowsPermissionModal contract: it renders only when open, the
 * primary CTA links to the (org-aware) approval URL passed by the loader, and
 * both the "Maybe later" button and Escape dismiss it.
 *
 * @version v1.3.0-beta
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkflowsPermissionModal } from "../app/components/features/upgrade/WorkflowsPermissionModal";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
  // Render the key so the component mounts without a real i18n instance.
  Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>,
}));

const APPROVAL_URL = "https://github.com/settings/installations/124561975";

describe("WorkflowsPermissionModal", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <WorkflowsPermissionModal open={false} onDismiss={vi.fn()} approvalUrl={APPROVAL_URL} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the title and a CTA linking to the approval URL when open", () => {
    render(
      <WorkflowsPermissionModal open={true} onDismiss={vi.fn()} approvalUrl={APPROVAL_URL} />,
    );
    expect(screen.queryByText("workflowsModalTitle")).not.toBeNull();
    const cta = screen.getByRole("link", { name: "workflowsModalCta" });
    expect(cta.getAttribute("href")).toBe(APPROVAL_URL);
    expect(cta.getAttribute("target")).toBe("_blank");
  });

  it("dismisses via the 'Maybe later' button", () => {
    const onDismiss = vi.fn();
    render(
      <WorkflowsPermissionModal open={true} onDismiss={onDismiss} approvalUrl={APPROVAL_URL} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "workflowsModalDismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("dismisses on Escape", () => {
    const onDismiss = vi.fn();
    render(
      <WorkflowsPermissionModal open={true} onDismiss={onDismiss} approvalUrl={APPROVAL_URL} />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
