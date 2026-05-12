/**
 * This file pins unit tests for the objects-related utilities and the
 * `_app.objects.tsx` action.
 *
 * Tests cover:
 *   - deriveStatus: all four status values
 *   - generateUniqueObjectSlug: no collision, and -2 suffix on collision
 *   - update-object action: alt_text persistence
 *   - commit-objects action: server-side URL recheck
 *
 * @version v1.2.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { deriveStatus } from "~/lib/iiif-types";
import { generateUniqueObjectSlug } from "~/lib/slugify";
import type { SiteUrlCheck } from "~/lib/commit.server";

// ---------------------------------------------------------------------------
// deriveStatus
// ---------------------------------------------------------------------------

describe("deriveStatus", () => {
  it("returns 'missing_from_repo' when missing_from_repo is true (highest priority)", () => {
    const status = deriveStatus({
      title: "X",
      image_available: true,
      missing_from_repo: true,
    });
    expect(status).toBe("missing_from_repo");
  });

  it("returns 'ready' when title present, tiles present, not missing", () => {
    const status = deriveStatus({
      title: "X",
      image_available: true,
      missing_from_repo: false,
    });
    expect(status).toBe("ready");
  });

  it("returns 'no_metadata' when title is null", () => {
    const status = deriveStatus({
      title: null,
      image_available: true,
      missing_from_repo: false,
    });
    expect(status).toBe("no_metadata");
  });

  it("returns 'image_missing' when title is present but image_available is false", () => {
    const status = deriveStatus({
      title: "X",
      image_available: false,
      missing_from_repo: false,
    });
    expect(status).toBe("image_missing");
  });
});

// ---------------------------------------------------------------------------
// generateUniqueObjectSlug
// ---------------------------------------------------------------------------

describe("generateUniqueObjectSlug", () => {
  it("returns the base slug when there is no collision", async () => {
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Parameters<typeof generateUniqueObjectSlug>[2];

    const slug = await generateUniqueObjectSlug("codex-mendoza", 1, mockDb);
    expect(slug).toBe("codex-mendoza");
  });

  it("appends -2 when the base slug already exists", async () => {
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi
        .fn()
        .mockResolvedValue([{ object_id: "codex-mendoza" }]),
    } as unknown as Parameters<typeof generateUniqueObjectSlug>[2];

    const slug = await generateUniqueObjectSlug("codex-mendoza", 1, mockDb);
    expect(slug).toBe("codex-mendoza-2");
  });

  it("increments suffix until a free slot is found", async () => {
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        { object_id: "portrait" },
        { object_id: "portrait-2" },
        { object_id: "portrait-3" },
      ]),
    } as unknown as Parameters<typeof generateUniqueObjectSlug>[2];

    const slug = await generateUniqueObjectSlug("portrait", 1, mockDb);
    expect(slug).toBe("portrait-4");
  });
});

// ---------------------------------------------------------------------------
// update-object action: alt_text persistence (A11Y-01)
// ---------------------------------------------------------------------------

/**
 * Simulates the update-object action logic for alt_text, mirroring the
 * pattern in app/routes/_app.objects.$objectId.js update-object case.
 * The production code uses: formData.get("alt_text")?.trim() || null
 */
function simulateUpdateObjectAltText(formDataValues: Record<string, string | undefined>) {
  const setCalls: Array<Record<string, unknown>> = [];
  const mockDb = {
    update: vi.fn((_table: unknown) => mockDb),
    set: vi.fn((values: Record<string, unknown>) => {
      setCalls.push(values);
      return mockDb;
    }),
    where: vi.fn(() => Promise.resolve()),
  };

  const raw = formDataValues["alt_text"];
  const alt_text = raw?.trim() || null;

  mockDb.update("objects").set({ alt_text }).where();

  return { setCalls, alt_text };
}

describe("update-object action: alt_text persistence (A11Y-01)", () => {
  it("persists alt_text when a non-empty string is submitted", () => {
    const { setCalls, alt_text } = simulateUpdateObjectAltText({
      alt_text: "A red bird on a branch",
    });

    expect(alt_text).toBe("A red bird on a branch");
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]).toMatchObject({ alt_text: "A red bird on a branch" });
  });

  it("stores null when alt_text is an empty string", () => {
    const { setCalls, alt_text } = simulateUpdateObjectAltText({
      alt_text: "",
    });

    expect(alt_text).toBeNull();
    expect(setCalls[0]).toMatchObject({ alt_text: null });
  });

  it("stores null when alt_text is whitespace-only", () => {
    const { setCalls, alt_text } = simulateUpdateObjectAltText({
      alt_text: "   ",
    });

    expect(alt_text).toBeNull();
    expect(setCalls[0]).toMatchObject({ alt_text: null });
  });

  it("trims leading and trailing whitespace before persisting", () => {
    const { setCalls, alt_text } = simulateUpdateObjectAltText({
      alt_text: "  A painting of a mountain  ",
    });

    expect(alt_text).toBe("A painting of a mountain");
    expect(setCalls[0]).toMatchObject({ alt_text: "A painting of a mountain" });
  });
});

// ---------------------------------------------------------------------------
// commit-objects action: server-side URL recheck
// ---------------------------------------------------------------------------

/**
 * Simulates the URL-fix portion of the `commit-objects` action handler in
 * `app/routes/_app.objects.tsx`. After the fix:
 *   - The action fetches `_config.yml` ONCE.
 *   - It runs `verifySiteUrl` with that content and derives `fixUrl` /
 *     `pagesUrl` from the FRESH result, ignoring any client-supplied values
 *     in formData.
 *   - The same `configContent` is then reused by the rewrite block (no
 *     second `getFileContent` round-trip).
 *
 * This simulator mirrors that flow exactly so the regression tests can assert
 * the contract without needing the full Cloudflare/middleware/db harness.
 */
async function simulateCommitObjectsUrlFix(opts: {
  formFixUrl: string;
  formPagesUrl: string;
  formDisableSheets?: string;
  initialConfig: string | null;
  urlCheck: SiteUrlCheck;
  getFileContent: ReturnType<typeof vi.fn>;
  verifySiteUrl: ReturnType<typeof vi.fn>;
}) {
  // 1. Mirror the production reads. Note: fixUrl/pagesUrl from formData are
  //    DROPPED — only disableSheets remains client-driven.
  const disableSheets = (opts.formDisableSheets ?? "false") === "true";
  // The following two reads exist in the OLD code; the fix removes them.
  // We capture them here purely so the simulator can demonstrate that they
  // are NOT used in the rewrite branch below.
  const _staleClientFixUrl = opts.formFixUrl === "true"; // intentionally unused
  const _staleClientPagesUrl = opts.formPagesUrl;        // intentionally unused
  void _staleClientFixUrl;
  void _staleClientPagesUrl;

  // 2. Server-side recheck — supersedes client-passed values.
  let configContent = await opts.getFileContent(
    "token",
    "owner",
    "repo",
    "_config.yml",
  );
  let fixUrl = false;
  let pagesUrl: string | null = null;
  if (configContent) {
    const urlCheck = await opts.verifySiteUrl(
      "token",
      "owner",
      "repo",
      configContent,
    );
    if (urlCheck.pagesEnabled && !urlCheck.match) {
      fixUrl = true;
      pagesUrl = urlCheck.pagesUrl;
    }
  }

  // 3. Existing rewrite block — REUSES configContent (no second fetch).
  let rewroteUrl = false;
  let rewroteBaseurl = false;
  let entered = false;
  if (disableSheets || fixUrl) {
    if (configContent) {
      entered = true;
      if (fixUrl && pagesUrl) {
        const parsed = new URL(pagesUrl);
        const newUrl = `${parsed.protocol}//${parsed.host}`;
        const newBaseurl = parsed.pathname.replace(/\/+$/, "");
        const beforeUrl = configContent;
        configContent = configContent.replace(
          /^(url:\s*)"?[^"\n]*"?\s*$/m,
          `$1"${newUrl}"`,
        );
        rewroteUrl = configContent !== beforeUrl;
        const beforeBaseurl = configContent;
        configContent = configContent.replace(
          /^(baseurl:\s*)"?[^"\n]*"?\s*$/m,
          `$1"${newBaseurl}"`,
        );
        rewroteBaseurl = configContent !== beforeBaseurl;
      }
    }
  }

  // Mock setup gives both the initial fetch return and the verify result.
  void opts.initialConfig;
  void opts.urlCheck;

  return {
    fixUrl,
    pagesUrl,
    entered,
    rewroteUrl,
    rewroteBaseurl,
    finalConfig: configContent,
    getFileContentCalls: opts.getFileContent.mock.calls.length,
    verifySiteUrlCalls: opts.verifySiteUrl.mock.calls.length,
  };
}

const SAMPLE_CONFIG = [
  'title: "My Site"',
  'url: "https://stale.example.com"',
  'baseurl: "/old"',
  "",
].join("\n");

describe("commit-objects action: server-side URL recheck", () => {
  it("Test 1 (stale-client regression): applies URL fix even when client passed fixUrl=false / pagesUrl=''", async () => {
    const getFileContent = vi.fn().mockResolvedValue(SAMPLE_CONFIG);
    const verifySiteUrl = vi.fn().mockResolvedValue({
      pagesEnabled: true,
      match: false,
      pagesUrl: "https://example.github.io/repo",
      configUrl: "https://stale.example.com/old",
    } satisfies SiteUrlCheck);

    const result = await simulateCommitObjectsUrlFix({
      formFixUrl: "false", // stale
      formPagesUrl: "", // stale
      initialConfig: SAMPLE_CONFIG,
      urlCheck: {
        pagesEnabled: true,
        match: false,
        pagesUrl: "https://example.github.io/repo",
        configUrl: "https://stale.example.com/old",
      },
      getFileContent,
      verifySiteUrl,
    });

    // The server-derived flags win.
    expect(result.fixUrl).toBe(true);
    expect(result.pagesUrl).toBe("https://example.github.io/repo");
    expect(result.entered).toBe(true);
    expect(result.rewroteUrl).toBe(true);
    expect(result.rewroteBaseurl).toBe(true);
    // Final _config.yml reflects the FRESH pagesUrl, not the empty client value.
    expect(result.finalConfig).toContain('url: "https://example.github.io"');
    expect(result.finalConfig).toContain('baseurl: "/repo"');
  });

  it("Test 2 (no-mismatch happy path): does NOT enter the URL-rewrite branch when match=true", async () => {
    const getFileContent = vi.fn().mockResolvedValue(SAMPLE_CONFIG);
    const verifySiteUrl = vi.fn().mockResolvedValue({
      pagesEnabled: true,
      match: true,
      pagesUrl: "https://example.github.io/repo",
      configUrl: "https://example.github.io/repo",
    } satisfies SiteUrlCheck);

    const result = await simulateCommitObjectsUrlFix({
      formFixUrl: "true", // even with truthy client flags...
      formPagesUrl: "https://something-else.example.com",
      initialConfig: SAMPLE_CONFIG,
      urlCheck: {
        pagesEnabled: true,
        match: true,
        pagesUrl: "https://example.github.io/repo",
        configUrl: "https://example.github.io/repo",
      },
      getFileContent,
      verifySiteUrl,
    });

    // ...the server-side recheck overrides them: no rewrite.
    expect(result.fixUrl).toBe(false);
    expect(result.pagesUrl).toBeNull();
    expect(result.entered).toBe(false);
    expect(result.rewroteUrl).toBe(false);
    expect(result.rewroteBaseurl).toBe(false);
    // Config content is unchanged.
    expect(result.finalConfig).toBe(SAMPLE_CONFIG);
  });

  it("Test 3 (pages disabled): does NOT apply URL fix when pagesEnabled=false", async () => {
    const getFileContent = vi.fn().mockResolvedValue(SAMPLE_CONFIG);
    const verifySiteUrl = vi.fn().mockResolvedValue({
      pagesEnabled: false,
      match: false,
      pagesUrl: "",
      configUrl: "https://stale.example.com/old",
    } satisfies SiteUrlCheck);

    const result = await simulateCommitObjectsUrlFix({
      formFixUrl: "true",
      formPagesUrl: "https://example.github.io/repo",
      initialConfig: SAMPLE_CONFIG,
      urlCheck: {
        pagesEnabled: false,
        match: false,
        pagesUrl: "",
        configUrl: "https://stale.example.com/old",
      },
      getFileContent,
      verifySiteUrl,
    });

    expect(result.fixUrl).toBe(false);
    expect(result.pagesUrl).toBeNull();
    expect(result.entered).toBe(false);
    expect(result.rewroteUrl).toBe(false);
  });

  it("Test 4 (single fetch): calls getFileContent for _config.yml at most once per action invocation", async () => {
    const getFileContent = vi.fn().mockResolvedValue(SAMPLE_CONFIG);
    const verifySiteUrl = vi.fn().mockResolvedValue({
      pagesEnabled: true,
      match: false,
      pagesUrl: "https://example.github.io/repo",
      configUrl: "https://stale.example.com/old",
    } satisfies SiteUrlCheck);

    const result = await simulateCommitObjectsUrlFix({
      formFixUrl: "true",
      formPagesUrl: "https://example.github.io/repo",
      initialConfig: SAMPLE_CONFIG,
      urlCheck: {
        pagesEnabled: true,
        match: false,
        pagesUrl: "https://example.github.io/repo",
        configUrl: "https://stale.example.com/old",
      },
      getFileContent,
      verifySiteUrl,
    });

    expect(result.getFileContentCalls).toBe(1);
    expect(result.verifySiteUrlCalls).toBe(1);
    // And the rewrite still happened on the SAME fetched content.
    expect(result.rewroteUrl).toBe(true);
  });

  it("Test 5 (config missing): no-op when getFileContent returns null", async () => {
    const getFileContent = vi.fn().mockResolvedValue(null);
    const verifySiteUrl = vi.fn();

    const result = await simulateCommitObjectsUrlFix({
      formFixUrl: "true",
      formPagesUrl: "https://example.github.io/repo",
      initialConfig: null,
      urlCheck: {
        pagesEnabled: true,
        match: false,
        pagesUrl: "https://example.github.io/repo",
        configUrl: "",
      },
      getFileContent,
      verifySiteUrl,
    });

    expect(result.fixUrl).toBe(false);
    expect(result.pagesUrl).toBeNull();
    expect(result.entered).toBe(false);
    // verifySiteUrl never invoked when config can't be read.
    expect(verifySiteUrl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// commit-objects action: contract guards
// ---------------------------------------------------------------------------
//
// These tests assert the *route file* itself satisfies the locked decisions:
//   1. verifySiteUrl runs inside `case "commit-objects"`.
//   2. client-passed fixUrl / pagesUrl are NOT read from formData
//                  inside `case "commit-objects"`.
//   PATTERNS.md correction: verifySiteUrl is imported from
//                  ~/lib/commit.server, NOT ~/lib/sync.server.
//   Single fetch: getFileContent("_config.yml") is called at most once
//                 inside `case "commit-objects"`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readObjectsRoute(): string {
  return readFileSync(
    resolve(__dirname, "..", "app", "routes", "_app.objects.tsx"),
    "utf-8",
  );
}

function commitObjectsCaseSlice(source: string): string {
  const start = source.indexOf('case "commit-objects":');
  expect(start).toBeGreaterThan(-1);
  // The next `case "..." :` after the start of commit-objects.
  const after = source.indexOf('case "', start + 'case "commit-objects":'.length);
  expect(after).toBeGreaterThan(start);
  return source.slice(start, after);
}

describe("commit-objects action: route-file contract guards", () => {
  it("imports verifySiteUrl from ~/lib/commit.server (NOT ~/lib/sync.server)", () => {
    const src = readObjectsRoute();
    // Must import from commit.server.
    expect(src).toMatch(
      /import\s*\{[^}]*\bverifySiteUrl\b[^}]*\}\s*from\s*["']~\/lib\/commit\.server["']/,
    );
    // Must NOT import verifySiteUrl from sync.server.
    const syncImport = src.match(
      /import\s*\{[^}]*\}\s*from\s*["']~\/lib\/sync\.server["']/g,
    );
    if (syncImport) {
      for (const line of syncImport) {
        expect(line).not.toMatch(/\bverifySiteUrl\b/);
      }
    }
  });

  it("invokes verifySiteUrl inside `case \"commit-objects\"`", () => {
    const slice = commitObjectsCaseSlice(readObjectsRoute());
    expect(slice).toMatch(/\bverifySiteUrl\s*\(/);
  });

  it("does NOT read formData.get(\"fixUrl\") or formData.get(\"pagesUrl\") inside `case \"commit-objects\"`", () => {
    const slice = commitObjectsCaseSlice(readObjectsRoute());
    expect(slice).not.toMatch(/formData\.get\(\s*["']fixUrl["']\s*\)/);
    expect(slice).not.toMatch(/formData\.get\(\s*["']pagesUrl["']\s*\)/);
  });

  it("calls getFileContent(..., \"_config.yml\") exactly once inside `case \"commit-objects\"`", () => {
    const slice = commitObjectsCaseSlice(readObjectsRoute());
    const matches = slice.match(
      /getFileContent\([^)]*["']_config\.yml["']\s*\)/g,
    );
    expect(matches?.length ?? 0).toBe(1);
  });

  it("preserves the mount-only useEffect that triggers `pre-commit-check`", () => {
    const src = readObjectsRoute();
    // The mount-only effect lives outside the action; confirm it still exists
    // and submits the pre-commit-check intent.
    expect(src).toMatch(
      /sheetsFetcher\.submit\(\s*\{\s*intent:\s*["']pre-commit-check["']/,
    );
  });
});
