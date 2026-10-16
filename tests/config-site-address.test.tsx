// @vitest-environment jsdom
/**
 * The Site URL and Base URL fields: locked at rest, a Change button only for
 * someone who may change them, the address refused with its message until it
 * is one the build can use, the consequence line before the confirm, and the
 * value written (and carried by the form) only on confirm. The Google Sheets
 * notice states what the build does.
 *
 * @version v1.5.5-beta
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

import { SiteAddressField, type SiteAddressKind } from "~/components/features/config/SiteAddressField";
import { isBaseUrl, isSiteUrl, settleSiteAddress } from "~/lib/site-address";

afterEach(cleanup);

function setUp(kind: SiteAddressKind, value: string, canChange = true) {
  const onChange = vi.fn();
  const { container } = render(
    <SiteAddressField kind={kind} value={value} canChange={canChange} onChange={onChange} />,
  );
  return { onChange, container };
}

const open = () => fireEvent.click(screen.getByRole("button", { name: "sections.hosting.change_address" }));
const editor = () => screen.getByRole("textbox") as HTMLInputElement;
const type = (value: string) => fireEvent.change(editor(), { target: { value } });
const confirm = () => fireEvent.click(screen.getByRole("group").querySelector("button")!);

describe("the address rules", () => {
  it.each(["https://username.github.io", "http://localhost:4001", "https://a.org"])("takes %s as a Site URL", (v) => {
    expect(isSiteUrl(v)).toBe(true);
  });

  it.each(["", "username.github.io", "ftp://a.org", "https://a.org/site", "https://a.org?x=1", "https://", "https://u@a.org", "https://example.org\\site", "https://a.org\\"])(
    "refuses %j as a Site URL",
    (v) => {
      expect(isSiteUrl(v)).toBe(false);
    },
  );

  it.each(["", "/my-telar-site", "/a/b"])("takes %j as a Base URL", (v) => {
    expect(isBaseUrl(v)).toBe(true);
  });

  it.each(["my-telar-site", "//x", "/a//b", "/a?x", "/a#x"])("refuses %j as a Base URL", (v) => {
    expect(isBaseUrl(v)).toBe(false);
  });

  it("settles a trailing slash and whitespace away, and the root path to empty", () => {
    expect(settleSiteAddress(" https://a.org/ ")).toBe("https://a.org");
    expect(settleSiteAddress("/")).toBe("");
    expect(settleSiteAddress("/site/")).toBe("/site");
  });
});

describe("SiteAddressField", () => {
  it("shows the address locked, and carries it for the form", () => {
    const { container } = setUp("url", "https://example.org");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect((container.querySelector('input[name="url"]') as HTMLInputElement).value).toBe("https://example.org");
  });

  it("offers no Change button to someone who may not change it", () => {
    setUp("url", "https://example.org", false);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("refuses a Site URL with a path, with its message, and offers no confirm", () => {
    const { onChange } = setUp("url", "https://example.org");
    open();
    type("https://example.org/site");
    expect(screen.getByRole("alert").textContent).toBe("sections.hosting.url_invalid");
    expect(screen.queryByRole("group")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("refuses a Base URL without a leading slash", () => {
    const { onChange } = setUp("baseurl", "/site");
    open();
    type("site");
    expect(screen.getByRole("alert").textContent).toBe("sections.hosting.baseurl_invalid");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("states that every address changes before the confirm, and writes nothing until it", () => {
    const { onChange } = setUp("baseurl", "/site");
    open();
    type("/other");
    expect(screen.getByRole("group").textContent).toContain("sections.hosting.address_change_warning");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("confirms the settled address, writes it, and the form then carries it", () => {
    const { onChange, container } = setUp("baseurl", "/site");
    open();
    type("/other/");
    confirm();
    expect(onChange).toHaveBeenCalledWith("baseurl", "/other");
    expect((container.querySelector('input[name="baseurl"]') as HTMLInputElement).value).toBe("/other");
  });

  it("lets the Base URL be emptied, which puts the site at the root", () => {
    const { onChange } = setUp("baseurl", "/site");
    open();
    type("");
    confirm();
    expect(onChange).toHaveBeenCalledWith("baseurl", "");
  });
});

describe("the Google Sheets notice", () => {
  const notice = JSON.parse(
    readFileSync(resolve(process.cwd(), "app/i18n/locales/en/config.json"), "utf8"),
  ).sections.google_sheets.enabled_notice as string;

  it("names the build and the Objects page, and promises no sync", () => {
    expect(notice).toMatch(/builds/);
    expect(notice).toMatch(/Objects page/);
    expect(notice.toLowerCase()).not.toContain("sync");
  });
});

describe("the address change warning", () => {
  const warning = JSON.parse(
    readFileSync(resolve(process.cwd(), "app/i18n/locales/en/config.json"), "utf8"),
  ).sections.hosting.address_change_warning as string;

  it("says confirming saves the address, and promises no separate Save step", () => {
    expect(warning).toMatch(/saved when you confirm/);
    expect(warning).not.toMatch(/save and publish/);
  });
});
