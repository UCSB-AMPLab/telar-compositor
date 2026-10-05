// @vitest-environment jsdom
/**
 * The glossary page's notice beside a term's ID: which of two ids sharing an
 * address the site keeps, said on each of the two terms.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => `${key}|${JSON.stringify(options ?? {})}`,
    i18n: { language: "en" },
  }),
}));

import { GlossaryAddressNotice, addressNoticeText, sharedAddressOf } from "~/components/features/glossary/GlossaryAddressNotice";
import { sharedGlossaryAddresses } from "~/lib/glossary-addresses";

const shares = sharedGlossaryAddresses([
  { term_id: "IIIF", title: "A" },
  { term_id: "iiif", title: "B" },
  { term_id: "loom", title: "C" },
  { term_id: "colonial-period", title: "D" },
  { term_id: "Colonial Period", title: "E" },
]);

describe("GlossaryAddressNotice", () => {
  const render1 = (termId: string) =>
    render(<GlossaryAddressNotice shared={sharedAddressOf(shares, termId)} termId={termId} />);

  it("tells a term whose id differs only in case that links to it open the kept term", () => {
    render1("iiif");
    expect(screen.getByRole("status").textContent).toContain('address_shared_dropped_case|{"kept":"IIIF"}');
  });

  it("tells a term whose id differs in punctuation that links to it show as missing", () => {
    render1("Colonial Period");
    expect(screen.getByRole("status").textContent).toContain('address_shared_dropped|{"kept":"colonial-period"}');
  });

  it("tells the kept term which ids the site does not publish, by what their links do", () => {
    render1("IIIF");
    expect(screen.getByRole("status").textContent).toContain('address_shared_kept_one_case|{"others":"iiif"}');
  });

  it("uses the missing-link text for the kept term whose other id differs in punctuation", () => {
    render1("colonial-period");
    expect(screen.getByRole("status").textContent).toContain('address_shared_kept_one|{"others":"Colonial Period"}');
  });

  it("gives a kept term with both kinds one sentence for each", () => {
    const mixed = sharedGlossaryAddresses([
      { term_id: "a-b", title: "A" },
      { term_id: "A-B", title: "B" },
      { term_id: "a b", title: "C" },
    ]);
    const text = addressNoticeText((k, o) => `${k}|${JSON.stringify(o)}`, "en", mixed[0], "a-b");
    expect(text).toBe('address_shared_kept_one|{"others":"a b"} address_shared_kept_one_case|{"others":"A-B"}');
  });

  it("renders nothing for a term whose address is its own", () => {
    const { container } = render1("loom");
    expect(container.textContent).toBe("");
  });
});

describe("the notice's rendered text, in both languages", () => {
  const texts = async (language: "en" | "es") => {
    const { createInstance } = await import("i18next");
    const en = (await import("~/i18n/locales/en/glossary.json")).default;
    const es = (await import("~/i18n/locales/es/glossary.json")).default;
    const instance = createInstance();
    await instance.init({
      lng: language,
      ns: ["glossary"],
      defaultNS: "glossary",
      resources: { en: { glossary: en }, es: { glossary: es } },
      interpolation: { escapeValue: false },
    });
    const t = instance.getFixedT(language, "glossary") as never;
    const kept = (dropped: string[]) =>
      addressNoticeText(t, language, { kept: "colonial-period", dropped }, "colonial-period");
    return {
      one: kept(["Colonial Period"]),
      two: kept(["Colonial Period", "colonial_period"]),
      three: kept(["a b", "c d", "e f"]),
    };
  };

  it("quotes each id and joins two and three in English", async () => {
    const { one, two, three } = await texts("en");
    expect(one).toMatch(/^"Colonial Period" has the same address/);
    expect(two).toMatch(/^"Colonial Period" and "colonial_period" have the same address/);
    expect(three).toMatch(/^"a b", "c d", and "e f" have the same address/);
  });

  it("quotes each id and joins two and three in Spanish", async () => {
    const { one, two, three } = await texts("es");
    expect(one).toMatch(/^"Colonial Period" tiene la misma dirección/);
    expect(two).toMatch(/^Los términos "Colonial Period" y "colonial_period" tienen la misma dirección/);
    expect(three).toMatch(/^Los términos "a b", "c d" y "e f" tienen la misma dirección/);
  });

  it("says in English that links to an id differing only in case open the kept term", async () => {
    const { createInstance } = await import("i18next");
    const en = (await import("~/i18n/locales/en/glossary.json")).default;
    const instance = createInstance();
    await instance.init({ lng: "en", ns: ["glossary"], defaultNS: "glossary", resources: { en: { glossary: en } }, interpolation: { escapeValue: false } });
    const t = instance.getFixedT("en", "glossary") as never;
    expect(addressNoticeText(t, "en", { kept: "IIIF", dropped: ["iiif"] }, "iiif")).toContain('Links to this term\'s ID open "IIIF"');
    expect(addressNoticeText(t, "en", { kept: "IIIF", dropped: ["iiif", "IiIf"] }, "IIIF")).toMatch(
      /^"iiif" and "IiIf" have the same address as this term, so the site does not publish them\. Links to them open this term/,
    );
  });
});
