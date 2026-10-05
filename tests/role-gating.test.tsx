// @vitest-environment jsdom

/**
 * role-gating — don't-render contract coverage.
 *
 * First block: source-level assertions that the three former
 * RestrictionBanner call sites (publish, upgrade, dashboard) no longer import
 * or render RestrictionBanner, and that publish/upgrade read role via the
 * typed useIsPublisher() hook (the shared publishing-role set)
 * rather than the ad-hoc useRouteLoaderData cast. The component file itself
 * is deleted, so a runtime import test is not possible; the conversion is
 * asserted against the route source.
 *
 * Later blocks cover the popover's Publish affordance, the denied-toast,
 * the /objects empty-state hint, and the server-gate integrity assertions
 * proving don't-render never replaced the server boundary.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
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
const objectDetailSrc = readFileSync(
  join(APP_DIR, "routes", "_app.objects.$objectId.tsx"),
  "utf-8",
);

// --- mocks for the component-level UnpublishedPopover assertions ------------

// Controllable role: tests set `mockRole` before rendering.
//
// useIsPublisher delegates to the real isPublishingRole rather than
// restating the membership set: a mock that restates it answers from its
// own copy, so the footer would keep rendering against the old set after
// the real one changed.
let mockRole: "convenor" | "collaborator" | "instructor" | null = "convenor";
vi.mock("~/hooks/use-role", async () => {
  const { isPublishingRole } = await import("~/lib/publishing-roles");
  return {
    useIsConvenor: () => mockRole === "convenor",
    useIsPublisher: () => isPublishingRole(mockRole),
    useRole: () => mockRole,
  };
});

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
};
vi.mock("react-i18next", () => ({
  Trans: ({ i18nKey, values }: { i18nKey: string; values?: Record<string, unknown> }) =>
    `${i18nKey} ${JSON.stringify(values ?? {})}`,
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
  objectOrder: { changed: false },
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

  it("reads role via useIsPublisher() on publish and upgrade (not the ad-hoc cast)", () => {
    for (const src of [publishSrc, upgradeSrc]) {
      expect(src).toContain("useIsPublisher");
      expect(src).toContain('from "~/hooks/use-role"');
      // The ad-hoc role cast is gone.
      expect(src).not.toContain('useRouteLoaderData("routes/_app") as { userRole?: string }');
    }
  });
});

// --- the popover's Publish affordance -----------------------------

describe("UnpublishedPopover role gating", () => {
  beforeEach(() => {
    mockRole = "convenor";
  });

  it("shows the Publish action (navigation to /publish) for a convenor", () => {
    mockRole = "convenor";
    const { container } = renderPopover();
    const publishCta = Array.from(
      container.querySelectorAll('a[href="/publish"]'),
    ).find((a) => a.className.includes("bg-terracotta"));
    expect(publishCta).toBeTruthy();
  });

  it("shows the Publish action for a collaborator too", () => {
    mockRole = "collaborator";
    const { container } = renderPopover();
    const publishCta = Array.from(
      container.querySelectorAll('a[href="/publish"]'),
    ).find((a) => a.className.includes("bg-terracotta"));
    expect(publishCta).toBeTruthy();
  });

  it("shows the Publish action for an instructor too", () => {
    mockRole = "instructor";
    const { container } = renderPopover();
    const publishCta = Array.from(
      container.querySelectorAll('a[href="/publish"]'),
    ).find((a) => a.className.includes("bg-terracotta"));
    expect(publishCta).toBeTruthy();
  });

  it("exposes no /publish navigation to a caller with no membership", () => {
    mockRole = null;
    const { container } = renderPopover();
    expect(container.querySelector('a[href="/publish"]')).toBeNull();
  });
});

// --- denied-toast + empty-state hint (source-level) ----------
//
// The objects route's toast effect and empty-state hint are exercised in the
// browser; here we pin the wiring at the source level (the route is a large
// SSR module with heavy DB/Yjs deps that make full render impractical).

describe("the refusal copy names no role an instructor-gate no longer refuses", () => {
  const common = JSON.parse(
    readFileSync(join(APP_DIR, "i18n", "locales", "en", "common.json"), "utf-8"),
  ) as { role: Record<string, string> };

  it.each(["denied_publish", "denied_upgrade"])("%s does not say an instructor cannot", (key) => {
    expect(common.role[key]).not.toMatch(/instructor/i);
  });
});

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
    const emptyStateSrc = readFileSync(join(APP_DIR, "components", "features", "objects", "ObjectsEmptyState.tsx"), "utf-8");
    expect(objectsSrc).toContain("<ObjectsEmptyState");
    expect(emptyStateSrc).toContain('objects.empty_body');
    expect(emptyStateSrc).toContain('to="/config"');
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
const appSrc = readFileSync(join(APP_DIR, "routes", "_app.tsx"), "utf-8");

describe("server gates remain intact (security)", () => {
  it("keeps every requireOwner guard on the gated /dashboard intents", () => {
    const guards = dashboardSrc.match(/requireOwner\(db, activeProject\.id, user\.id\)/g) ?? [];
    // The 8 per-intent guards on the session's site (generate-invite,
    // send-invite, remove-member, compute-full-sync-diff, apply-full-sync,
    // accept-divergence, restore-orphan-drafts, ignore-orphans) are all
    // present. autosave-config and reorder are retired (v1.4.0-beta) and
    // never contributed to this count — they were requireProjectMember
    // guards, not requireOwner.
    expect(guards.length).toBe(8);
    // cancel-invite is gated on the invite row's own site.
    expect(dashboardSrc).toContain("await requireOwner(db, invite.project_id, userId);");
    // The gate helpers come from membership.server and nowhere else. The
    // course-aware code gate sits alongside requireOwner rather than
    // replacing it: the nine intents above are single-project operations
    // that stay convenor-only.
    expect(dashboardSrc).toMatch(
      /import \{[^}]*\brequireOwner\b[^}]*\} from "~\/lib\/membership\.server"/s,
    );
  });

  it("keeps the convenor gate on the repository delete", () => {
    // The delete lives on the object's own detail route, so the gate is
    // asserted where the operation is: `fromRepo` is the repository cleanup
    // and admits the convenor alone, while the compositor-only half also
    // admits the object's creator.
    expect(objectDetailSrc).toContain('const isConvenor = resolved.userRole === "convenor";');
    expect(objectDetailSrc).toContain(
      "if (fromRepo ? !isConvenor : !(isConvenor || createdByCaller))",
    );
    // The list route handles no delete-object intent, so there is no second
    // gate to keep in step with this one.
    expect(objectsSrc).not.toContain('case "delete-object"');
  });

  it("keeps the use-structural-ops canDelete role gate (convenor or owner)", () => {
    expect(structuralOpsSrc).toContain('if (role === "convenor") return true;');
    expect(structuralOpsSrc).toContain('return yMap.get("created_by") === currentUserId;');
  });

  it("gates the sidebar pending-invite loader query to convenors", () => {
    // Pending-invite rows are a convenor-only affordance; they must not ride
    // down in a non-convenor's loader payload. The fetch + assignment sit
    // inside a userRole === "convenor" check (default stays the empty array).
    const gated =
      /if \(userRole === "convenor"\) \{[\s\S]*?sidebarPendingInvites = inviteRows;[\s\S]*?\}/.test(
        appSrc,
      );
    expect(gated).toBe(true);
  });
});
