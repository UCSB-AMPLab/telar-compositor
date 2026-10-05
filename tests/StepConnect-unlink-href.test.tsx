// @vitest-environment jsdom
/**
 * Pins the "Unlink" control's link target on the onboarding Connect step.
 * The control must carry the row's project id so /account can open that
 * row's own removal confirmation (delete-project for a convenor,
 * leave-project for a collaborator) instead of landing on the top of the
 * account page with no visible next step.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import React from "react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>,
}));

vi.mock("react-router", () => ({
  useFetcher: () => ({ state: "idle", data: undefined, submit: vi.fn() }),
  Form: (props: React.FormHTMLAttributes<HTMLFormElement>) => <form {...props} />,
  Link: ({
    to,
    children,
    ...rest
  }: { to: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={String(to)} {...rest}>
      {children}
    </a>
  ),
}));

import { StepConnect } from "~/components/features/onboarding/StepConnect";
import type { RepoWithInstallation } from "~/routes/onboarding";
import type { Installation } from "~/lib/github.server";

const baseProps = {
  repos: [] as RepoWithInstallation[],
  installations: [] as Installation[],
  userLogin: "octocat",
  onSelect: vi.fn(),
  hasInstallations: true,
  githubAppSlug: "test-app",
  courseGateOpen: false,
};

describe("StepConnect — Unlink control", () => {
  it("carries the row's project id in the /account link", () => {
    const { container } = render(
      <StepConnect
        {...baseProps}
        connectedProjects={[
          { id: 42, github_repo_full_name: "octocat/site", onboarding_completed: true },
        ]}
      />,
    );

    const unlinkLink = Array.from(container.querySelectorAll("a")).find((a) =>
      (a.getAttribute("href") ?? "").startsWith("/account"),
    );
    expect(unlinkLink).not.toBeUndefined();
    expect(unlinkLink?.getAttribute("href")).toBe("/account?remove=42");
  });
});
