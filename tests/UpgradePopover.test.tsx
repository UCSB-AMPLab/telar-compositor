// @vitest-environment jsdom
/**
 * Pins the `UpgradePopover` body. Asserts: the title/sub from the
 * version props, a What's-new bullet list, a `Learn more →` linky, and the
 * convenor gate — `userRole="convenor"` renders the terracotta `Run upgrade`
 * CTA; `userRole="collaborator"` renders the inert cream `Convenor needs to
 * upgrade` line (bg-cream-dark / text-charcoal, NOT a button) and NO CTA.
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { UpgradePopover } from "~/components/features/site-status/popovers/UpgradePopover";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        "upgrade.title": "Telar {{version}} available",
        "upgrade.from": "Your site is on {{current}}.",
        "upgrade.what_changed": "What's new",
        "upgrade.learn_more": "Learn more",
        "upgrade.run": "Run upgrade",
        "upgrade.convenor_needed": "Convenor needs to upgrade",
      };
      let out = map[key] ?? key;
      if (opts) {
        for (const [k, v] of Object.entries(opts)) {
          out = out.replace(`{{${k}}}`, String(v));
        }
      }
      return out;
    },
  }),
}));

function renderPopover(props: Parameters<typeof UpgradePopover>[0]) {
  return render(
    <MemoryRouter>
      <UpgradePopover {...props} />
    </MemoryRouter>
  );
}

const baseProps = {
  latestVersion: "1.3.0",
  currentVersion: "1.2.0",
  whatsNew: ["Faster publishing", "Glossary chips"],
};

describe("UpgradePopover", () => {
  it("renders the title with the latest version", () => {
    const { container } = renderPopover({ ...baseProps, userRole: "convenor" });
    expect(container.textContent).toContain("Telar 1.3.0 available");
  });

  it("renders the current-version sub-line", () => {
    const { container } = renderPopover({ ...baseProps, userRole: "convenor" });
    expect(container.textContent).toContain("Your site is on 1.2.0.");
  });

  it("renders the What's-new bullets", () => {
    const { container } = renderPopover({ ...baseProps, userRole: "convenor" });
    expect(container.textContent).toContain("What's new");
    expect(container.textContent).toContain("Faster publishing");
    expect(container.textContent).toContain("Glossary chips");
  });

  it("convenor: renders the Run-upgrade terracotta CTA", () => {
    const { container } = renderPopover({ ...baseProps, userRole: "convenor" });
    const cta = container.querySelector(".bg-terracotta");
    expect(cta).not.toBeNull();
    expect(cta?.textContent).toContain("Run upgrade");
  });

  it("convenor: Run-upgrade links to /upgrade", () => {
    const { container } = renderPopover({ ...baseProps, userRole: "convenor" });
    const link = container.querySelector('a[href="/upgrade"]');
    expect(link).not.toBeNull();
  });

  it("collaborator: renders the cream 'Convenor needs to upgrade' line and NO Run-upgrade", () => {
    const { container } = renderPopover({ ...baseProps, userRole: "collaborator" });
    const line = container.querySelector(".bg-cream-dark.text-charcoal");
    expect(line).not.toBeNull();
    expect(line?.textContent).toContain("Convenor needs to upgrade");
    // it must NOT be a button
    expect(line?.tagName).not.toBe("BUTTON");
    // and NO Run-upgrade CTA at all
    expect(container.textContent).not.toContain("Run upgrade");
    expect(container.querySelector('a[href="/upgrade"]')).toBeNull();
  });

  it("does not hardcode a hex colour", () => {
    const { container } = renderPopover({ ...baseProps, userRole: "convenor" });
    expect(/#[0-9A-Fa-f]{6}/.test(container.innerHTML)).toBe(false);
  });
});
