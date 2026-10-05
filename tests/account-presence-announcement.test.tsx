// @vitest-environment jsdom

/**
 * Choosing a presence colour on the account page is announced in a polite
 * live region, so a reader who cannot see the swatch ring move is told which
 * colour was set.
 *
 * The real route component is mounted on React Router's routes stub with an
 * in-memory loader and an action that answers as the presence-colour intent
 * does.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key),
    i18n: { language: "en" },
  }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));
vi.mock("~/hooks/use-toast", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("~/components/features/account/ConnectedSitesCard", () => ({ ConnectedSitesCard: () => null }));
vi.mock("~/components/features/account/GitHubAccessCard", () => ({ GitHubAccessCard: () => null }));
vi.mock("~/components/features/account/DangerZoneCard", () => ({ DangerZoneCard: () => null }));
vi.mock("~/components/features/account/JoinCourseCard", () => ({ JoinCourseCard: () => null }));

import AccountPage from "../app/routes/_app.account";

afterEach(cleanup);

const PALETTE = ["#E47A6F", "#6FA8DC"];

function snapshot() {
  return {
    user: { github_id: 1, github_login: "tester", github_name: "Tester", github_email: null },
    memberSince: null,
    currentLocale: "en",
    currentPresenceColor: null,
    palette: PALETTE,
    projects: [],
    convenedProjects: [],
    soloConvenedCount: 0,
    collaboratorCount: 0,
    installations: [],
    installAppUrl: "https://github.com/apps/x/installations/new",
    uiLocale: "en",
    nowMs: 0,
    removeProjectId: null,
  };
}

function mount(answer: (color: string) => Record<string, unknown> = (color) => ({ ok: true, intent: "update-presence-color", color })) {
  const Stub = createRoutesStub([
    {
      path: "/account",
      Component: AccountPage as never,
      loader: (() => snapshot()) as never,
      action: (async ({ request }: { request: Request }) => {
        const color = String((await request.formData()).get("color"));
        return answer(color);
      }) as never,
    },
  ]);
  render(<Stub initialEntries={["/account"]} />);
}

describe("the account page's presence colour", () => {
  it("has a polite status region, empty until a colour is saved", async () => {
    mount();
    const region = await screen.findByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");
  });

  it("announces the colour that was set", async () => {
    mount();
    const swatches = await screen.findAllByRole("radio");
    fireEvent.click(swatches[1]);
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        'preferences.presence_color_saved:{"color":"preferences.presence_color_blue"}',
      ),
    );
  });

  it("announces that a colour was not saved when the route refuses it", async () => {
    mount(() => ({ ok: false, intent: "update-presence-color", error: "invalid_color" }));
    const swatches = await screen.findAllByRole("radio");
    fireEvent.click(swatches[1]);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("preferences.presence_color_invalid"));
  });
});
