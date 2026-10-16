// @vitest-environment jsdom
/**
 * Skipping the settings fixes inside a real data router. The loader of
 * /onboarding sends an author with no unfinished project to /start, and it runs
 * again after every submission, so completing onboarding at the skip would take
 * the author off the screen that lists what was left. The mocked-fetcher tests
 * cannot show that redirect.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { createMemoryRouter, RouterProvider, redirect, useLoaderData } from "react-router";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>,
}));

import { WizardShell } from "~/components/features/onboarding/WizardShell";

const user = { github_id: 1, github_login: "tester", github_name: "Tester", github_email: "t@example.com" };

let completed = false;
let intents: string[] = [];
let checkAnswer: Record<string, unknown>;

function Onboarding() {
  const projects = useLoaderData() as Array<{ id: number; github_repo_full_name: string; onboarding_completed: boolean }>;
  return (
    <WizardShell
      repos={[]}
      installations={[]}
      connectedProjects={projects}
      user={user}
      hasInstallations
      githubAppSlug="telar-compositor"
      courseGateOpen
    />
  );
}

function mount(url: string) {
  const router = createMemoryRouter(
    [
      {
        path: "/onboarding",
        element: <Onboarding />,
        loader: ({ request }) => {
          const force = new URL(request.url).searchParams.get("force") === "1";
          if (!force && completed) throw redirect("/start");
          return [{ id: 99, github_repo_full_name: "tester/old-repo", onboarding_completed: completed }];
        },
        action: async ({ request }) => {
          const form = await request.formData();
          const intent = String(form.get("intent"));
          intents.push(intent);
          if (intent === "complete-onboarding") {
            completed = true;
            return { ok: true, intent };
          }
          if (intent === "fix-site-config") return { ok: false, intent, error: "pages_failed" };
          return checkAnswer;
        },
      },
      { path: "/start", element: <div data-testid="start-page">start</div> },
    ],
    { initialEntries: [url] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

// The skip control appears once a fix has failed.
async function skipAfterFailedFix() {
  fireEvent.click(await screen.findByText("site_config.confirm"));
  fireEvent.click(await screen.findByText("site_config.skip"));
}

const pagesOff = { ok: true, intent: "check-site-config", sheetsEnabled: false, pagesNotEnabled: true, urlMismatch: null };

beforeEach(() => {
  completed = false;
  intents = [];
  checkAnswer = pagesOff;
});

describe("skipping the settings fixes in a real router", () => {
  for (const url of ["/onboarding?resume=99", "/onboarding?force=1&resume=99"]) {
    it(`${url}: the list stays, nothing is completed, until the author continues`, async () => {
      const router = mount(url);
      await skipAfterFailedFix();

      expect(await screen.findByTestId("unfixed-settings")).toBeDefined();
      // Give any completion and revalidation time to land.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(intents).not.toContain("complete-onboarding");
      expect(screen.getByTestId("unfixed-settings")).toBeDefined();
      expect(router.state.location.pathname).toBe("/onboarding");

      fireEvent.click(screen.getByText("step_done.go_to_start"));
      await waitFor(() => expect(router.state.location.pathname).toBe("/start"));
      expect(intents).toContain("complete-onboarding");
    });
  }

  it("Check settings again asks the server and shows the new answer", async () => {
    mount("/onboarding?resume=99");
    await skipAfterFailedFix();
    await screen.findByTestId("unfixed-settings");
    const checks = intents.filter((i) => i === "check-site-config").length;

    checkAnswer = { ...pagesOff, pagesNotEnabled: false, sheetsEnabled: true };
    fireEvent.click(screen.getByText("step_done.recheck"));

    await waitFor(() => expect(intents.filter((i) => i === "check-site-config").length).toBe(checks + 1));
    // The answer flags Sheets now, so the checklist is rebuilt from it.
    expect(await screen.findByText("site_config.sheets_failed")).toBeDefined();
    expect(screen.queryByText("site_config.pages_failed")).toBeNull();
  });
});
