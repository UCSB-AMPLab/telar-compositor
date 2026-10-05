// @vitest-environment jsdom
/**
 * What the /course screen posts, and to where.
 *
 * The screen owns no code intent of its own: `create-code`, `revoke-code`
 * and `switch-project` are existing endpoints on /dashboard, gated there.
 * So what this suite pins is the wiring — the intent name, the fields, and
 * the destination — because a form that posts the right fields to the wrong
 * route, or the right route with a missing `projectId`, fails in a way no
 * server test of /dashboard can see.
 *
 * Two of the assertions are about what is NOT rendered. An instructor gets
 * no instructor-role option in the create form (ruling 9: minting a staff
 * code is staff-list management), and no revoke button on an
 * instructor-role code. The loader withholds such codes from an instructor
 * altogether, so the second is defence in depth — asserted here because a
 * later loader change must not silently arm the affordance.
 *
 * `remove-site` posts to this route rather than to /dashboard: it is the
 * one course action the screen owns, and its target is another project's
 * rows, so it takes its child from the form and its course from the
 * session.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type React from "react";
import enCourse from "~/i18n/locales/en/course.json";
import esCourse from "~/i18n/locales/es/course.json";

const submitSpy = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>,
}));

vi.mock("react-router", () => {
  const FormLike = ({
    children,
    method,
    action,
    ...rest
  }: {
    children?: React.ReactNode;
    method?: string;
    action?: string;
  } & React.HTMLAttributes<HTMLFormElement>) => (
    <form method={method} action={action} {...rest}>
      {children}
    </form>
  );
  return {
    // The route module's server half pulls in `~/middleware/auth.server`,
    // which needs this at import time. The page under test never uses it.
    createContext: () => Symbol("context"),
    Form: FormLike,
    useFetcher: () => ({
      Form: FormLike,
      submit: submitSpy,
      state: "idle",
      data: undefined,
    }),
  };
});

import CoursePage from "~/routes/_app.course";

type LoaderData = Parameters<typeof CoursePage>[0]["loaderData"];

const CODE_CLASS = {
  id: 11,
  token: "ABCDEF2345",
  label: "Section B",
  role: "collaborator" as const,
  expiresAt: null,
  revokedAt: null,
};

const CODE_STAFF = {
  id: 12,
  token: "STAFF23456",
  label: null,
  role: "instructor" as const,
  expiresAt: null,
  revokedAt: null,
};

function data(overrides: Partial<LoaderData> = {}): LoaderData {
  return {
    course: { id: 9, title: "History 101" },
    role: "convenor",
    children: [
      {
        id: 41,
        title: "Group A",
        repo: "ana/group-a",
        members: [{ userId: 3, name: "ana", role: "convenor" as const }],
      },
    ],
    codes: [CODE_CLASS],
    staff: [{ userId: 1, name: "prof", role: "convenor" as const }],
    ...overrides,
  } as LoaderData;
}

function renderPage(overrides: Partial<LoaderData> = {}) {
  // The route's generated prop type carries `matches`, `params` and the
  // action data the page never reads; only `loaderData` is supplied.
  const props = { loaderData: data(overrides) } as unknown as Parameters<
    typeof CoursePage
  >[0];
  return render(<CoursePage {...props} />);
}

beforeEach(() => {
  submitSpy.mockClear();
});

// ---------------------------------------------------------------------------
// create-code
// ---------------------------------------------------------------------------

describe("the create-code form", () => {
  it("posts create-code and the course id to /dashboard", () => {
    const { container } = renderPage();
    const form = container.querySelector('form[action="/dashboard"]:has(input[value="create-code"])');
    expect(form).not.toBeNull();
    expect(form!.getAttribute("method")).toBe("post");
    expect(
      (form!.querySelector('input[name="projectId"]') as HTMLInputElement).value,
    ).toBe("9");
    expect(form!.querySelector('input[name="label"]')).not.toBeNull();
    expect(form!.querySelector('input[name="expiresAt"]')).not.toBeNull();
  });

  it("offers the convenor both code roles", () => {
    const { container } = renderPage({ role: "convenor" });
    const select = container.querySelector('select[name="role"]')!;
    expect(
      Array.from(select.querySelectorAll("option")).map((o) => o.value),
    ).toEqual(["collaborator", "instructor"]);
  });

  it("fixes an instructor's code role to collaborator and offers no choice", () => {
    const { container } = renderPage({ role: "instructor", staff: null });
    expect(container.querySelector('select[name="role"]')).toBeNull();
    const hidden = container.querySelector(
      'input[type="hidden"][name="role"]',
    ) as HTMLInputElement;
    expect(hidden.value).toBe("collaborator");
    expect(container.querySelector('option[value="instructor"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// revoke-code
// ---------------------------------------------------------------------------

describe("revoking a code", () => {
  it("posts revoke-code with the course and code ids to /dashboard", () => {
    renderPage();
    fireEvent.click(screen.getByText("course:revoke_code"));
    fireEvent.click(screen.getByText("course:revoke_code_confirm"));

    expect(submitSpy).toHaveBeenCalledWith(
      { intent: "revoke-code", projectId: "9", inviteId: "11" },
      { method: "post", action: "/dashboard" },
    );
  });

  it("posts nothing when the confirmation is dismissed", () => {
    renderPage();
    fireEvent.click(screen.getByText("course:revoke_code"));
    fireEvent.click(screen.getByText("btn_cancel"));
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("offers no revoke on an already-revoked code", () => {
    renderPage({
      codes: [{ ...CODE_CLASS, revokedAt: "2026-08-01T00:00:00.000Z" }],
    });
    expect(screen.queryByText("course:revoke_code")).toBeNull();
    expect(screen.getByText("course:code_revoked_badge")).toBeTruthy();
  });

  it("offers no revoke on a staff code to an instructor", () => {
    renderPage({ role: "instructor", staff: null, codes: [CODE_STAFF] });
    expect(screen.queryByText("course:revoke_code")).toBeNull();
  });

  it("offers revoke on a staff code to the convenor", () => {
    renderPage({ role: "convenor", codes: [CODE_STAFF] });
    fireEvent.click(screen.getByText("course:revoke_code"));
    fireEvent.click(screen.getByText("course:revoke_code_confirm"));
    expect(submitSpy).toHaveBeenCalledWith(
      { intent: "revoke-code", projectId: "9", inviteId: "12" },
      { method: "post", action: "/dashboard" },
    );
  });
});

// ---------------------------------------------------------------------------
// The click-through, and removal
// ---------------------------------------------------------------------------

describe("the child site row", () => {
  it("makes the site name a switch-project post to /dashboard", () => {
    const { container } = renderPage();
    const form = container.querySelector(
      'form[action="/dashboard"]:has(input[value="switch-project"])',
    );
    expect(form).not.toBeNull();
    expect(form!.getAttribute("method")).toBe("post");
    expect(
      (form!.querySelector('input[name="projectId"]') as HTMLInputElement).value,
    ).toBe("41");
    expect(form!.querySelector("button")!.textContent).toBe("Group A");
  });

  it("posts remove-site to this route, with the child id and no course id", () => {
    renderPage();
    fireEvent.click(screen.getByText("course:remove_site"));
    fireEvent.click(screen.getByText("course:remove_site_confirm"));

    expect(submitSpy).toHaveBeenCalledWith(
      { intent: "remove-site", projectId: "41" },
      { method: "post" },
    );
  });

  it("posts nothing when the removal is dismissed", () => {
    renderPage();
    fireEvent.click(screen.getByText("course:remove_site"));
    fireEvent.click(screen.getByText("btn_cancel"));
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("renders each member of the child with a role badge", () => {
    renderPage({
      children: [
        {
          id: 41,
          title: "Group A",
          repo: "ana/group-a",
          members: [
            { userId: 3, name: "ana", role: "convenor" as const },
            { userId: 4, name: "carlos", role: "collaborator" as const },
            { userId: 1, name: "prof", role: "instructor" as const },
          ],
        },
      ],
    });
    expect(screen.getByText("ana")).toBeTruthy();
    expect(screen.getByText("carlos")).toBeTruthy();
    expect(screen.getByText("instructor_label")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The staff list
// ---------------------------------------------------------------------------

describe("the staff list", () => {
  it("renders for the convenor", () => {
    renderPage({ role: "convenor" });
    expect(screen.getByText("prof")).toBeTruthy();
  });

  it("renders nothing when the loader withheld it", () => {
    renderPage({ role: "instructor", staff: null });
    expect(screen.queryByText("prof")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Empty states
// ---------------------------------------------------------------------------

describe("empty states", () => {
  it("names the empty course and its empty code list", () => {
    renderPage({ children: [], codes: [] });
    expect(screen.getByText("course:sites_empty")).toBeTruthy();
    expect(screen.getByText("course:codes_empty")).toBeTruthy();
  });
});

// A code admits a site to the course; it does not keep anyone from seeing the
// images, which are served by whatever holds their manifests. An instructor
// handing out a code is the person who has to know that, so the note is owed
// on this screen whether or not any code exists yet — including to the one who
// issued theirs last term and never opens the dialog again.
describe("what a join code does not do", () => {
  it("says so where the codes are, with codes", () => {
    renderPage();
    expect(screen.getByText("course:codes_access_note")).toBeTruthy();
  });

  it("says so where the codes are, with none", () => {
    renderPage({ children: [], codes: [] });
    expect(screen.getByText("course:codes_access_note")).toBeTruthy();
  });

  // The instructor who is not the convenor is the one this is most owed to:
  // a co-instructor hands out codes without having made the course, and this
  // screen is where the children are reachable for them at all.
  it("says so to an instructor, not only to the convenor", () => {
    renderPage({ role: "instructor" } as Partial<LoaderData>);
    expect(screen.getByText("course:codes_access_note")).toBeTruthy();
  });

  // A smoke check on the catalogues and nothing more: it establishes that both
  // locales carry a string rather than falling through to the raw key, which is
  // what a missing translation looks like on screen. It does NOT check that
  // either one makes the claim, and it cannot — the claim is prose, and a
  // placeholder of the right shape passes. What the note says is settled in
  // review, not here.
  it("carries a string in both catalogues rather than falling through to the key", () => {
    for (const [name, catalogue] of [
      ["en", enCourse],
      ["es", esCourse],
    ] as const) {
      const note = (catalogue as Record<string, string>).codes_access_note;
      expect(note, `${name} has no codes_access_note`).toBeTruthy();
      expect(note, `${name} note is the key, not a sentence`).not.toBe("codes_access_note");
    }
  });
});
