// @vitest-environment jsdom
/**
 * The config page's per-field standing, as rendered and as written to Yjs.
 *
 * Ruling 6 keeps six fields with the convenor and leaves the rest with any
 * member, so the page cannot be one disabled fieldset: a collaborator has to
 * see their own fields live and the six as read-only, with the reason stated.
 *
 * The Yjs half matters independently of the form. The Durable Object snapshots
 * the shared `config` map straight back into `project_config`, so a field
 * write that reaches the map reaches D1 without passing the route action —
 * which is why the callbacks are gated per field rather than per page, and why
 * the last test here re-enables the read-only fieldset in the DOM before
 * writing, the way a tampering client would.
 *
 * Mock strategy follows tests/_app.homepage.test.tsx: react-i18next returns
 * key passthrough, react-router fakes the router hooks, and the server modules
 * the route imports are stubbed. Yjs is real — the assertions are about what
 * lands in the document.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen, cleanup } from "@testing-library/react";
import React from "react";
import * as Y from "yjs";

let currentYDoc: Y.Doc = new Y.Doc();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>,
}));

const { blockerPredicate } = vi.hoisted(() => ({
  blockerPredicate: { current: null as null | (() => boolean) },
}));

vi.mock("react-router", () => ({
  Form: ({ children, ...rest }: React.FormHTMLAttributes<HTMLFormElement>) => (
    <form {...rest}>{children}</form>
  ),
  Link: ({ children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...rest}>{children}</a>
  ),
  useBlocker: (fn: () => boolean) => {
    blockerPredicate.current = fn;
    return { state: "unblocked" };
  },
  useFetcher: () => ({ state: "idle", data: undefined, submit: vi.fn() }),
  useNavigation: () => ({ state: "idle", formData: undefined }),
  useOutletContext: () => ({}),
}));

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({ isPublishing: false, ydoc: currentYDoc }),
}));

// CodeMirror-backed; the description binding is exercised in its own tests.
// Here it only has to report the `editable` decision it was handed.
vi.mock("~/components/ui/InlineHtmlEditor", () => ({
  InlineHtmlEditor: ({ editable }: { editable?: boolean }) => (
    <div data-testid="description-editor" data-editable={String(editable)} />
  ),
}));

vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/db.server", () => ({ getDb: vi.fn() }));
vi.mock("~/lib/active-project.server", () => ({
  resolveActiveProjectFromRequest: vi.fn(),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn() }));
vi.mock("~/lib/github.server", () => ({
  getRepoTree: vi.fn(),
  getFileContent: vi.fn(),
  githubHeaders: vi.fn(),
}));
vi.mock("~/lib/yaml.server", () => ({ parseYaml: vi.fn() }));
vi.mock("~/lib/sheets-reconcile.server", () => ({
  reconcileSheetsFlagFromRepo: vi.fn(),
}));

import ConfigPage from "~/routes/_app.config";
import { CONVENOR_ONLY_CONFIG_FIELDS } from "~/lib/config-fields";

type Role = "convenor" | "collaborator" | "instructor";

function makeLoaderData(userRole: Role) {
  return {
    hasProject: true as const,
    userRole,
    themes: [],
    config: {
      project_id: 1,
      title: "Site",
      description: "",
      author: "",
      email: "",
      lang: "en",
      theme: "",
      logo: "",
      include_demo_content: true,
      url: "https://example.org",
      baseurl: "/site",
      show_on_homepage: true,
      show_story_steps: true,
      show_object_credits: true,
      browse_and_search: true,
      show_link_on_homepage: true,
      show_sample_on_homepage: false,
      collection_mode: false,
      skip_stories: false,
      featured_count: 4,
      story_key: "",
      google_sheets_enabled: false,
    },
  };
}

function renderAs(userRole: Role) {
  currentYDoc = new Y.Doc();
  const props = { loaderData: makeLoaderData(userRole), actionData: undefined };
  const Page = ConfigPage as unknown as (p: typeof props) => React.ReactElement;
  return render(<Page {...props} />);
}

/** A control is read-only when it sits inside a fieldset marked disabled. */
function isReadOnly(el: Element | null): boolean {
  expect(el, "control not rendered at all").not.toBeNull();
  return el!.closest("fieldset[disabled]") !== null;
}

function field(container: HTMLElement, name: string): Element | null {
  return container.querySelector(`[name="${name}"]`);
}

const COLLABORATOR_CONTROLS = [
  "title",
  "author",
  "email",
  "lang",
  "logo",
  "show_on_homepage",
  "show_story_steps",
  "show_object_credits",
  "browse_and_search",
  "show_link_on_homepage",
  "show_sample_on_homepage",
  "collection_mode",
  "skip_stories",
  "featured_count",
];

/** The convenor-only fields the form actually renders a control for. */
const CONVENOR_ONLY_CONTROLS = ["url", "baseurl", "story_key", "include_demo_content"];

beforeEach(() => {
  cleanup();
});

describe("the config form for a collaborator", () => {
  it.each(COLLABORATOR_CONTROLS)("leaves %s editable", (name) => {
    const { container } = renderAs("collaborator");
    expect(isReadOnly(field(container, name))).toBe(false);
  });

  it.each(CONVENOR_ONLY_CONTROLS)("renders %s read-only", (name) => {
    const { container } = renderAs("collaborator");
    expect(isReadOnly(field(container, name))).toBe(true);
  });

  it("explains why the read-only fields are read-only", () => {
    renderAs("collaborator");
    expect(screen.getAllByText("read_only.title").length).toBeGreaterThan(0);
    expect(screen.getAllByText("read_only.body").length).toBeGreaterThan(0);
  });

  it("keeps the description editor live", () => {
    renderAs("collaborator");
    expect(screen.getByTestId("description-editor").dataset.editable).toBe("true");
  });

  it("keeps Save available and refresh-themes convenor-only", () => {
    const { container } = renderAs("collaborator");
    const save = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    const refresh = screen.getByText("sections.site_settings.refresh_themes")
      .closest("button") as HTMLButtonElement;
    expect(refresh.disabled).toBe(true);
  });
});

describe("the config form for an instructor", () => {
  it.each(COLLABORATOR_CONTROLS)("leaves %s editable", (name) => {
    const { container } = renderAs("instructor");
    expect(isReadOnly(field(container, name))).toBe(false);
  });

  it.each(CONVENOR_ONLY_CONTROLS)("renders %s read-only", (name) => {
    const { container } = renderAs("instructor");
    expect(isReadOnly(field(container, name))).toBe(true);
  });
});

describe("the config form for the convenor", () => {
  it.each([...COLLABORATOR_CONTROLS, ...CONVENOR_ONLY_CONTROLS])(
    "leaves %s editable",
    (name) => {
      const { container } = renderAs("convenor");
      expect(isReadOnly(field(container, name))).toBe(false);
    },
  );

  it("shows no read-only explanation", () => {
    renderAs("convenor");
    expect(screen.queryByText("read_only.title")).toBeNull();
    expect(screen.queryByText("read_only.body")).toBeNull();
  });

  it("can refresh themes", () => {
    renderAs("convenor");
    const refresh = screen.getByText("sections.site_settings.refresh_themes")
      .closest("button") as HTMLButtonElement;
    expect(refresh.disabled).toBe(false);
  });
});

describe("the Yjs writes are gated per field, not per page", () => {
  it("lets a collaborator's approved edit reach the shared document", () => {
    const { container } = renderAs("collaborator");
    const input = field(container, "title") as HTMLInputElement;
    fireEvent.blur(input, { target: { value: "Renamed by a collaborator" } });

    const yConfig = currentYDoc.getMap<unknown>("config");
    expect(String(yConfig.get("title"))).toBe("Renamed by a collaborator");
  });

  it("lets a collaborator toggle an approved boolean", () => {
    const { container } = renderAs("collaborator");
    const toggle = field(container, "collection_mode")!
      .closest("div")!
      .querySelector('button[role="switch"]') as HTMLButtonElement;
    fireEvent.click(toggle);

    expect(currentYDoc.getMap<unknown>("config").get("collection_mode")).toBe(true);
  });

  it.each(["url", "baseurl", "story_key"])(
    "refuses a collaborator's %s even when the DOM gate is removed",
    (name) => {
      const { container } = renderAs("collaborator");
      const input = field(container, name) as HTMLInputElement;
      input.closest("fieldset[disabled]")!.removeAttribute("disabled");
      fireEvent.blur(input, { target: { value: "tampered" } });

      expect(currentYDoc.getMap<unknown>("config").get(name)).toBeUndefined();
    },
  );

  it("refuses a collaborator's include_demo_content even when the DOM gate is removed", () => {
    const { container } = renderAs("collaborator");
    const holder = field(container, "include_demo_content")!.closest("div")!;
    holder.closest("fieldset[disabled]")!.removeAttribute("disabled");
    fireEvent.click(holder.querySelector('button[role="switch"]') as HTMLButtonElement);

    expect(
      currentYDoc.getMap<unknown>("config").get("include_demo_content"),
    ).toBeUndefined();
  });

  it("lets the convenor write the six", () => {
    const { container } = renderAs("convenor");
    for (const name of ["url", "baseurl", "story_key"]) {
      fireEvent.blur(field(container, name) as HTMLInputElement, {
        target: { value: `set-${name}` },
      });
    }
    const yConfig = currentYDoc.getMap<unknown>("config");
    for (const name of ["url", "baseurl", "story_key"]) {
      expect(yConfig.get(name)).toBe(`set-${name}`);
    }
  });

  it("names every convenor-only field the form renders", () => {
    // The two the form does not render — google_sheets_enabled and
    // google_sheets_published_url — have no control here; the Google Sheets
    // section is a notice. They are still on the list because the action and
    // the Durable Object both read the same one.
    for (const name of CONVENOR_ONLY_CONTROLS) {
      expect(CONVENOR_ONLY_CONFIG_FIELDS.has(name), name).toBe(true);
    }
  });
});

describe("the retired answer word limit field", () => {
  // The limit is a constant now — 100 is advice, 200 is where the build cuts —
  // so the Config tab offers nothing to set. A field here would ask an author
  // for a number nothing reads.
  it("renders no control at all", () => {
    const { container } = renderAs("convenor");
    expect(container.querySelector('[name="answer_word_limit"]')).toBeNull();
  });

  it("still mirrors featured_count, which the document does carry", () => {
    const { container } = renderAs("convenor");

    fireEvent.blur(field(container, "featured_count") as HTMLInputElement, {
      target: { value: "9" },
    });

    expect(currentYDoc.getMap<unknown>("config").get("featured_count")).toBe(9);
  });
});
