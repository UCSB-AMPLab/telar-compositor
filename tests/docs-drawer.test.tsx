// @vitest-environment jsdom

/**
 * This file pins the in-product Docs experience:
 *   - DocsDrawer renders a vendored doc body ONLY through sanitiseHtml — a
 *     <script> in a doc body must never reach the DOM (XSS gate).
 *   - The close button carries a non-empty accessible name (localised aria).
 *   - The body renders in the compositor's chosen UI language (i18n.language) —
 *     there is no per-panel language picker.
 *   - FromTheDocs renders exactly four tiles from the role×state reading list
 *     and opens the drawer (calls onOpenDoc) WITHOUT navigating.
 *   - Wiring: a WorkflowTile docs footer and a WelcomeStrip orientation chip
 *     open the drawer without navigating.
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { DocsDrawer } from "~/components/features/start/DocsDrawer";
import { FromTheDocs } from "~/components/features/start/FromTheDocs";
import { WorkflowTile } from "~/components/features/start/WorkflowTile";
import { WelcomeStrip } from "~/components/features/start/WelcomeStrip";
import { Settings } from "lucide-react";
import type { DocId, DocSlice } from "~/lib/docs-content";

// i18n: identity-ish map covering the start-namespace drawer/from_docs keys.
const I18N_MAP: Record<string, string> = {
  "drawer.open_on_telar": "Open on telar.org",
  "drawer.see_also": "See also",
  "drawer.next": "Next: {{title}}",
  "drawer.close": "Close",
  "drawer.breadcrumb": "telar.org · Docs · {{chapter}}",
  "section.from_the_docs": "From the docs",
  "from_docs.hint": "about the key steps",
};
// Mutable so a test can drive the "compositor language" the drawer follows.
let mockLanguage = "en";
function interpolate(s: string, opts?: Record<string, unknown>): string {
  if (!opts) return s;
  let out = s;
  for (const [k, v] of Object.entries(opts)) out = out.replace(`{{${k}}}`, String(v));
  return out;
}
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      interpolate(I18N_MAP[key] ?? key, opts),
    i18n: { language: mockLanguage },
  }),
  // FromTheDocs renders its hint via <Trans> — the mock collapses it to the
  // mapped string (the embedded link component is irrelevant to these tests).
  Trans: ({ i18nKey }: { i18nKey?: string }) =>
    i18nKey ? (I18N_MAP[i18nKey] ?? i18nKey) : null,
}));

// A doc map whose body carries an injected <script> — the sanitiser MUST
// strip it. EN and ES bodies differ so the toggle is observable.
const MALICIOUS_DOCS: Partial<Record<DocId, DocSlice>> = {
  objects: {
    href: "/docs/the-compositor/objects/",
    titleEn: "Objects in the Compositor",
    titleEs: "Objetos en el Compositor",
    seeAlso: ["iiif"],
    bodyEn: `# Objects EN heading\n\nObjects body english marker.\n\n<script>window.__xss_objects = true;</script>`,
    bodyEs: `# Objetos ES encabezado\n\nCuerpo de objetos marcador español.`,
  },
  iiif: {
    href: "/docs/your-content/external-iiif/",
    titleEn: "What is IIIF?",
    titleEs: "¿Qué es IIIF?",
    bodyEn: `# IIIF EN\n\nIIIF english body.`,
    bodyEs: `# IIIF ES\n\nIIIF cuerpo español.`,
  },
};

describe("DocsDrawer — sanitised render + chrome", () => {
  it("renders the doc body ONLY through sanitiseHtml — a <script> is stripped", () => {
    const { container } = render(
      <MemoryRouter>
        <DocsDrawer open docId="objects" onClose={vi.fn()} docs={MALICIOUS_DOCS} />
      </MemoryRouter>,
    );
    // The prose body renders, but no <script> survives.
    expect(screen.getByText(/Objects body english marker/)).toBeTruthy();
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML).not.toContain("__xss_objects");
  });

  it("close button has a non-empty accessible name", () => {
    render(
      <MemoryRouter>
        <DocsDrawer open docId="objects" onClose={vi.fn()} docs={MALICIOUS_DOCS} />
      </MemoryRouter>,
    );
    const closeBtn = screen.getByRole("button", { name: "Close" });
    expect(closeBtn).toBeTruthy();
    expect(closeBtn.getAttribute("aria-label")).toBeTruthy();
  });

  it("calls onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <DocsDrawer open docId="objects" onClose={onClose} docs={MALICIOUS_DOCS} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders the body in the compositor language — EN by default", () => {
    mockLanguage = "en";
    render(
      <MemoryRouter>
        <DocsDrawer open docId="objects" onClose={vi.fn()} docs={MALICIOUS_DOCS} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Objects body english marker/)).toBeTruthy();
    expect(screen.queryByText(/marcador español/)).toBeNull();
  });

  it("renders the ES body when the compositor language is Spanish — no per-panel picker", () => {
    mockLanguage = "es";
    try {
      render(
        <MemoryRouter>
          <DocsDrawer open docId="objects" onClose={vi.fn()} docs={MALICIOUS_DOCS} />
        </MemoryRouter>,
      );
      expect(screen.getByText(/marcador español/)).toBeTruthy();
      expect(screen.queryByText(/Objects body english marker/)).toBeNull();
      // There is no language toggle control any more.
      expect(screen.queryByRole("button", { name: "ES" })).toBeNull();
      expect(screen.queryByRole("button", { name: "EN" })).toBeNull();
    } finally {
      mockLanguage = "en";
    }
  });

  it("Open-on-telar.org link points to https://telar.org{href} in a new tab with rel noopener", () => {
    const { container } = render(
      <MemoryRouter>
        <DocsDrawer open docId="objects" onClose={vi.fn()} docs={MALICIOUS_DOCS} />
      </MemoryRouter>,
    );
    const link = container.querySelector(
      'a[href="https://telar.org/docs/the-compositor/objects/"]',
    ) as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toContain("noopener");
  });

  it("renders nothing when open is false", () => {
    const { container } = render(
      <MemoryRouter>
        <DocsDrawer open={false} docId="objects" onClose={vi.fn()} docs={MALICIOUS_DOCS} />
      </MemoryRouter>,
    );
    expect(container.querySelector("[data-docs-drawer]")).toBeNull();
  });

  it("backdrop is flat — no backdrop-blur class", () => {
    const { container } = render(
      <MemoryRouter>
        <DocsDrawer open docId="objects" onClose={vi.fn()} docs={MALICIOUS_DOCS} />
      </MemoryRouter>,
    );
    expect(container.innerHTML).not.toContain("backdrop-blur");
  });
});

describe("FromTheDocs — role×state reading list", () => {
  it("renders exactly five tiles and opens the drawer on click (no navigation)", () => {
    const onOpenDoc = vi.fn();
    const { container } = render(
      <MemoryRouter>
        <FromTheDocs role="convenor" state="populated" onOpenDoc={onOpenDoc} />
      </MemoryRouter>,
    );
    const tiles = container.querySelectorAll("[data-doc-tile]");
    expect(tiles).toHaveLength(5);
    // populated · convenor → [stories, refine, publish, pages, sync]
    fireEvent.click(tiles[0]);
    expect(onOpenDoc).toHaveBeenCalledWith("stories");
    // The tiles are buttons, not links (the only link is the hint's docs URL,
    // which the i18n mock collapses to plain text).
    expect(container.querySelector("a[href]")).toBeNull();
  });

  it("empty · collaborator reading list = [intro, narrative, stories, markdown, glossary]", () => {
    const onOpenDoc = vi.fn();
    const { container } = render(
      <MemoryRouter>
        <FromTheDocs role="collaborator" state="empty" onOpenDoc={onOpenDoc} />
      </MemoryRouter>,
    );
    const tiles = container.querySelectorAll("[data-doc-tile]");
    expect(tiles).toHaveLength(5);
    expect((tiles[0] as HTMLElement).getAttribute("data-doc-tile")).toBe("intro");
    expect((tiles[4] as HTMLElement).getAttribute("data-doc-tile")).toBe("glossary");
  });
});

// ---------------------------------------------------------------------------
// Wiring — entry points open the drawer WITHOUT navigating
// ---------------------------------------------------------------------------

describe("WorkflowTile docs footer (wiring)", () => {
  it("docs footer opens the drawer (onOpenDoc) and stops propagation — no navigation", () => {
    const onOpenDoc = vi.fn();
    const onTileClick = vi.fn(); // stands in for the surface-link navigation
    const { container } = render(
      <MemoryRouter>
        {/* Wrap in a clickable surface to prove stopPropagation. */}
        <div onClick={onTileClick}>
          <WorkflowTile
            step={1}
            to="/config"
            icon={Settings}
            iconTint="text-fg-muted"
            title="Configure"
            pillLabel="Done"
            pillVariant="ok"
            tip="tip"
            docKey="configure"
            docLabel="From the docs"
            onOpenDoc={onOpenDoc}
          />
        </div>
      </MemoryRouter>,
    );
    const footer = container.querySelector('[data-doc-key="configure"]') as HTMLElement;
    expect(footer).not.toBeNull();
    fireEvent.click(footer);
    expect(onOpenDoc).toHaveBeenCalledWith("configure");
    // stopPropagation: the surrounding surface click handler must NOT fire.
    expect(onTileClick).not.toHaveBeenCalled();
  });
});

describe("WelcomeStrip orientation chips (wiring)", () => {
  it("the two orientation chips open the drawer at intro / iiif", () => {
    const onOpenDoc = vi.fn();
    render(
      <MemoryRouter>
        <WelcomeStrip
          projectName="Telar de prueba"
          summary="A summary."
          role="convenor"
          convenorName="Alice"
          collaboratorCount={2}
          createdYear={2024}
          state="populated"
          onOpenDoc={onOpenDoc}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText("orientation.what_is_compositor"));
    expect(onOpenDoc).toHaveBeenLastCalledWith("intro");
    fireEvent.click(screen.getByText("orientation.plan_narrative"));
    expect(onOpenDoc).toHaveBeenLastCalledWith("narrative");
  });
});
