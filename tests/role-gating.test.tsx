// @vitest-environment jsdom

/**
 * role-gating — don't-render contract coverage.
 *
 * First block: source-level assertions that the three former
 * RestrictionBanner call sites (publish, upgrade, dashboard) no longer import
 * or render RestrictionBanner, and that publish/upgrade read role via the
 * typed useIsConvenor() hook rather than the ad-hoc useRouteLoaderData cast.
 * The component file itself is deleted, so a runtime import test is not
 * possible; the conversion is asserted against the route source.
 *
 * Later blocks cover the ask-convenor affordance, the
 * denied-toast, the /objects empty-state hint, and the server-gate integrity
 * assertions proving don't-render never replaced the server boundary.
 *
 * @version v1.3.0-beta
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { UnpublishedPopover } from "~/components/features/site-status/popovers/UnpublishedPopover";
import type { ChangeSummary } from "~/lib/publish.server";

const APP_DIR = join(__dirname, "..", "app");
const publishSrc = readFileSync(join(APP_DIR, "routes", "_app.publish.tsx"), "utf-8");
const upgradeSrc = readFileSync(join(APP_DIR, "routes", "_app.upgrade.tsx"), "utf-8");
const dashboardSrc = readFileSync(join(APP_DIR, "routes", "_app.dashboard.tsx"), "utf-8");
const objectsSrc = readFileSync(join(APP_DIR, "routes", "_app.objects.tsx"), "utf-8");

// --- mocks for the component-level UnpublishedPopover assertions ------------

// Controllable role: tests flip `mockIsConvenor` before rendering.
let mockIsConvenor = true;
vi.mock("~/hooks/use-role", () => ({
  useIsConvenor: () => mockIsConvenor,
  useRole: () => (mockIsConvenor ? "convenor" : "collaborator"),
}));

// i18n: identity-ish map covering both the popover keys and the common:role.*
// affordance key.
const I18N_MAP: Record<string, string> = {
  "unpublished.title_one": "1 unpublished change",
  "unpublished.title_other": "{{n}} unpublished changes",
  "unpublished.since": "Since last published, {{time}}",
  "unpublished.section.stories": "Stories",
  "unpublished.section.objects": "Objects",
  "unpublished.section.glossary": "Glossary",
  "unpublished.section.pages": "Pages",
  "unpublished.section.settings": "Site settings",
  "unpublished.modified": "modified",
  "unpublished.added": "added",
  "unpublished.review": "Review all changes",
  "unpublished.publish": "Publish",
  "common:role.ask_convenor_publish": "Ask convenor to publish",
};
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      let out = I18N_MAP[key] ?? key;
      if (opts) {
        for (const [k, v] of Object.entries(opts)) {
          out = out.replace(`{{${k}}}`, String(v));
        }
      }
      return out;
    },
    i18n: { language: "en" },
  }),
}));

function emptyBucket() {
  return { new: [], modified: [], deleted: [] };
}

const summary: ChangeSummary = {
  isUpToDate: false,
  backCompatBootstrap: false,
  stories: { new: [{ story_id: "s1", title: "The First Story" }], modified: [], deleted: [] },
  objects: emptyBucket(),
  pages: emptyBucket(),
  glossary: emptyBucket(),
  settings: { changed: [] },
  landing: { changed: false },
  navigation: { changed: false },
  fileChanges: { addedStoryFiles: [], removedStoryFiles: [] },
};

function renderPopover() {
  return render(
    <MemoryRouter>
      <UnpublishedPopover summary={summary} />
    </MemoryRouter>,
  );
}

// --- RestrictionBanner retirement (source-level) --------------------

describe("RestrictionBanner retirement", () => {
  it("deletes the RestrictionBanner component file", () => {
    expect(existsSync(join(APP_DIR, "components", "layout", "RestrictionBanner.tsx"))).toBe(false);
  });

  it("removes every RestrictionBanner reference from the three former call sites", () => {
    for (const src of [publishSrc, upgradeSrc, dashboardSrc]) {
      expect(src).not.toContain("RestrictionBanner");
    }
  });

  it("reads role via useIsConvenor() on publish and upgrade (not the ad-hoc cast)", () => {
    for (const src of [publishSrc, upgradeSrc]) {
      expect(src).toContain("useIsConvenor");
      expect(src).toContain('from "~/hooks/use-role"');
      // The ad-hoc role cast is gone.
      expect(src).not.toContain('useRouteLoaderData("routes/_app") as { userRole?: string }');
    }
  });
});

// --- ask-convenor affordance -----------------------------

describe("UnpublishedPopover role gating", () => {
  beforeEach(() => {
    mockIsConvenor = true;
  });

  it("shows the Publish action (navigation to /publish) for a convenor", () => {
    mockIsConvenor = true;
    const { container } = renderPopover();
    const publishCta = Array.from(
      container.querySelectorAll('a[href="/publish"]'),
    ).find((a) => a.className.includes("bg-terracotta"));
    expect(publishCta).toBeTruthy();
    expect(container.textContent).not.toContain("Ask convenor to publish");
  });

  it("shows 'Ask convenor to publish' (no /publish link) for a collaborator", () => {
    mockIsConvenor = false;
    const { container } = renderPopover();
    expect(screen.getByText("Ask convenor to publish")).toBeTruthy();
    // The collaborator footer exposes no /publish navigation at all.
    expect(container.querySelector('a[href="/publish"]')).toBeNull();
  });
});

// --- denied-toast + empty-state hint (source-level) ----------
//
// The objects route's toast effect and empty-state hint are exercised in the
// browser; here we pin the wiring at the source level (the route is a large
// SSR module with heavy DB/Yjs deps that make full render impractical).

describe("/objects denied-toast + empty-state hint", () => {
  it("reads the ?denied= param and fires a one-time info toast", () => {
    expect(objectsSrc).toContain('searchParams.get("denied")');
    expect(objectsSrc).toContain("role.denied_upgrade");
    expect(objectsSrc).toContain("role.denied_publish");
    expect(objectsSrc).toContain('type: "info"');
    // strips the param so the toast fires once (replace nav, no re-fire)
    expect(objectsSrc).toContain('next.delete("denied")');
  });

  it("renders the empty-state hint with a link to /config", () => {
    expect(objectsSrc).toContain('objects.empty_body');
    expect(objectsSrc).toContain('to="/config"');
  });
});

// --- server-gate integrity (don't-render is additive) ---------------
//
// Hiding affordances by role must NOT have weakened
// server-side enforcement. The gated actions carry heavy D1/session deps that
// make direct unit invocation impractical, so we assert at the source level
// that every server gate is present and unmodified. Don't-render and the
// route guard are additive UX layers only — a crafted collaborator POST is
// still rejected by these guards.

const structuralOpsSrc = readFileSync(join(APP_DIR, "hooks", "use-structural-ops.ts"), "utf-8");

describe("server gates remain intact (security)", () => {
  it("keeps every requireOwner guard on the gated /dashboard intents", () => {
    const guards = dashboardSrc.match(/requireOwner\(db, activeProject\.id, user\.id\)/g) ?? [];
    // The 9 per-intent guards (autosave-config, generate-invite, search-users,
    // send-invite, cancel-invite, remove-member, restore-orphan-drafts,
    // ignore-orphans, + 1 structural intent) are all present.
    expect(guards.length).toBe(9);
    expect(dashboardSrc).toContain(
      'import { getUserProjects, requireOwner, requireProjectMember } from "~/lib/membership.server"',
    );
  });

  it("keeps the _app.objects server gate (userRole !== convenor)", () => {
    expect(objectsSrc).toContain('resolvedDel.userRole !== "convenor"');
  });

  it("keeps the use-structural-ops canDelete role gate (convenor or owner)", () => {
    expect(structuralOpsSrc).toContain('if (role === "convenor") return true;');
    expect(structuralOpsSrc).toContain('return yMap.get("created_by") === currentUserId;');
  });
});
