// @vitest-environment jsdom
/**
 * The Start tab's two small lists: a tile in "Your other projects" has to open
 * that project, and an activity row whose actor has a login but no name keeps
 * the initials of the name it shows.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import React from "react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("react-router", () => ({
  Form: ({ children, ...rest }: React.FormHTMLAttributes<HTMLFormElement> & { method?: string }) => (
    <form {...rest}>{children}</form>
  ),
  Link: ({ children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...rest}>{children}</a>,
}));

import { OtherProjectsRibbon } from "~/components/features/start/OtherProjectsRibbon";
import { ActivityFeed } from "~/components/features/start/ActivityFeed";

const project = (id: number, name: string) => ({
  id,
  github_repo_full_name: name,
  head_sha: null,
  published_sha: null,
  last_published_at: null,
  last_edited_at: null,
});

describe("OtherProjectsRibbon — a tile opens its project", () => {
  it("posts switch-project for each other project and links nowhere", () => {
    const { container } = render(
      <OtherProjectsRibbon
        projects={[project(1, "me/active"), project(2, "me/second"), project(3, "me/third")]}
        activeProjectId={1}
      />,
    );

    const forms = Array.from(container.querySelectorAll("form"));
    expect(forms.map((f) => f.getAttribute("action"))).toEqual(["/dashboard", "/dashboard"]);
    expect(
      forms.map((f) => [
        (f.querySelector('input[name="intent"]') as HTMLInputElement).value,
        (f.querySelector('input[name="projectId"]') as HTMLInputElement).value,
      ]),
    ).toEqual([
      ["switch-project", "2"],
      ["switch-project", "3"],
    ]);
    expect(container.querySelector("a")).toBeNull();
  });
});

describe("ActivityFeed — initials follow the name shown", () => {
  const row = (over: Record<string, unknown>) => ({
    id: 1,
    verb: "published",
    entity_type: "site",
    entity_id: null,
    entity_label: null,
    created_at: null,
    actor_user_id: 1,
    actor_github_id: 9,
    actor_github_login: null,
    actor_github_name: null,
    ...over,
  });
  const initials = (container: HTMLElement) =>
    container.querySelector('span[aria-hidden="true"]')?.textContent;

  it("falls back to the login's initials when the actor has no name", () => {
    const { container } = render(<ActivityFeed rows={[row({ actor_github_login: "mariag" }) as never]} />);
    expect(initials(container)).toBe("MA");
  });

  it("still uses the name's initials when there is one", () => {
    const { container } = render(
      <ActivityFeed rows={[row({ actor_github_name: "Ana Rivera", actor_github_login: "mariag" }) as never]} />,
    );
    expect(initials(container)).toBe("AR");
  });
});
