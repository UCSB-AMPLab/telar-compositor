/**
 * Unit tests for the manifest loader.
 *
 * Covers:
 *   - chainManifests: exact string equality, single/multi-step, broken chain,
 *     loop detection, identity case.
 *   - fetchReleaseManifest: 404 handling, missing-asset handling, validation
 *     enforcement, Accept: application/octet-stream on asset fetch,
 *     per-tag in-memory cache.
 *   - loadManifestChain: bundled-only success, release-asset fallback,
 *     fail-closed when asset missing.
 *
 * BUNDLED_MANIFESTS is mocked via vi.hoisted + vi.mock so tests control which
 * manifests are "bundled" independently of the eventual contents.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";
import type { Manifest, ManualStep } from "~/lib/manifest-schema.server";

// ---------------------------------------------------------------------------
// Mock BUNDLED_MANIFESTS — hoisted so it's defined before the module is imported
// ---------------------------------------------------------------------------

const bundledHolder = vi.hoisted(() => ({
  manifests: [] as Manifest[],
}));

vi.mock("~/../migrations", () => ({
  get BUNDLED_MANIFESTS() {
    return bundledHolder.manifests;
  },
}));

// Import AFTER the mock is registered so upgrade.server.ts picks up the mock.
import {
  chainManifests,
  fetchReleaseManifest,
  loadManifestChain,
  __clearManifestCacheForTests,
} from "~/lib/upgrade.server";
import { ManifestValidationError } from "~/lib/manifest-schema.server";
import {
  ReleaseFileUnreadableError,
  ReleaseListUnreadableError,
  ReleaseManifestInvalidError,
} from "~/lib/upgrade-reads.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function m(from: string, to: string): Manifest {
  return {
    schema_version: 1,
    from_version: from,
    to_version: to,
    description: `${from} → ${to}`,
    operations: [
      {
        type: "config_add_field",
        key: "k",
        value: "v",
        after_key: "baseurl",
      },
    ],
    manual_steps: {
      en: [] as ManualStep[],
      es: [] as ManualStep[],
    },
  };
}

/** Minimal raw JSON payload shaped like a valid manifest (what GitHub would return). */
function rawManifest(from: string, to: string): Record<string, unknown> {
  return {
    schema_version: 1,
    from_version: from,
    to_version: to,
    description: `${from} → ${to}`,
    operations: [],
    manual_steps: { en: [], es: [] },
  };
}

/**
 * Build a fake fetch Response-like object returned by vi.fn().mockResolvedValue.
 */
function okResponse(body: unknown): {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
} {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
  };
}

function errorResponse(status: number): {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
} {
  return {
    ok: false,
    status,
    statusText: `HTTP ${status}`,
    json: async () => ({}),
  };
}

const TOKEN = "test-token-abc";

// ---------------------------------------------------------------------------
// chainManifests
// ---------------------------------------------------------------------------

describe("chainManifests", () => {
  it("returns [] when fromVersion === toVersion", () => {
    expect(chainManifests("1.0.0", "1.0.0", [])).toEqual([]);
  });

  it("builds a single-step chain", () => {
    const a = m("0.9.0-beta", "0.9.1");
    const result = chainManifests("0.9.0-beta", "0.9.1", [a]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(a);
  });

  it("builds a 3-step chain in correct order", () => {
    const a = m("0.9.0-beta", "0.9.1");
    const b = m("0.9.1", "1.0.0");
    const c = m("1.0.0", "1.1.0");
    const result = chainManifests("0.9.0-beta", "1.1.0", [a, b, c]);
    expect(result).toEqual([a, b, c]);
  });

  it("uses exact string equality — prerelease suffix not normalised", () => {
    // from "1.0.0-beta" must match to "1.0.0-beta", not "1.0.0"
    const a = m("1.0.0-beta", "1.0.0");
    const result = chainManifests("1.0.0-beta", "1.0.0", [a]);
    expect(result).toEqual([a]);

    // With a manifest starting at "1.0.0" instead, the chain from "1.0.0-beta" breaks.
    const b = m("1.0.0", "1.1.0");
    expect(() => chainManifests("1.0.0-beta", "1.1.0", [b])).toThrow(
      /Unsupported upgrade path/,
    );
  });

  it("throws 'Unsupported upgrade path' when chain is broken", () => {
    const a = m("1.0.0", "1.1.0");
    // Missing 1.1.0 → 1.2.0
    expect(() => chainManifests("1.0.0", "1.2.0", [a])).toThrow(
      /Unsupported upgrade path: no manifest from 1\.1\.0/,
    );
  });

  it("throws 'chain loop detected' when manifests form a loop", () => {
    // a→b and b→a with target c (unreachable) — visited set catches the loop.
    const ab = m("a", "b");
    const ba = m("b", "a");
    expect(() => chainManifests("a", "c", [ab, ba])).toThrow(
      /loop detected/,
    );
  });

  it("ignores manifests whose from_version isn't on the chain path", () => {
    const a = m("1.0.0", "1.1.0");
    const extra = m("9.9.9", "10.0.0"); // not on path
    const result = chainManifests("1.0.0", "1.1.0", [extra, a]);
    expect(result).toEqual([a]);
  });
});

// ---------------------------------------------------------------------------
// fetchReleaseManifest
// ---------------------------------------------------------------------------

describe("fetchReleaseManifest", () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    __clearManifestCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null when release tag 404s", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(404));
    const result = await fetchReleaseManifest(TOKEN, "v9.9.9");
    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when release has no migration.json asset", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ assets: [{ name: "other.zip", url: "https://x/y" }] }),
    );
    const result = await fetchReleaseManifest(TOKEN, "v1.2.0");
    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when release has no assets field at all", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({}));
    const result = await fetchReleaseManifest(TOKEN, "v1.2.0");
    expect(result).toBeNull();
  });

  it("returns a validated Manifest on happy path", async () => {
    const raw = rawManifest("1.1.0", "1.2.0");
    fetchMock
      .mockResolvedValueOnce(
        okResponse({
          assets: [{ name: "migration.json", url: "https://api/asset/1" }],
        }),
      )
      .mockResolvedValueOnce(okResponse(raw));

    const result = await fetchReleaseManifest(TOKEN, "v1.2.0");
    expect(result).not.toBeNull();
    expect(result!.from_version).toBe("1.1.0");
    expect(result!.to_version).toBe("1.2.0");
  });

  it("sends Accept: application/octet-stream on asset fetch", async () => {
    const raw = rawManifest("1.1.0", "1.2.0");
    fetchMock
      .mockResolvedValueOnce(
        okResponse({
          assets: [{ name: "migration.json", url: "https://api/asset/1" }],
        }),
      )
      .mockResolvedValueOnce(okResponse(raw));

    await fetchReleaseManifest(TOKEN, "v1.2.0");

    // Second call is the asset fetch; inspect its headers.
    const assetCall = fetchMock.mock.calls[1];
    expect(assetCall[0]).toBe("https://api/asset/1");
    const headers = assetCall[1].headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/octet-stream");
    // Authorization should still be forwarded from githubHeaders.
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("throws ManifestValidationError when asset returns invalid manifest JSON", async () => {
    fetchMock
      .mockResolvedValueOnce(
        okResponse({
          assets: [{ name: "migration.json", url: "https://api/asset/1" }],
        }),
      )
      .mockResolvedValueOnce(okResponse({ schema_version: 99 }));

    await expect(fetchReleaseManifest(TOKEN, "v1.2.0")).rejects.toBeInstanceOf(
      ManifestValidationError,
    );
  });

  it("throws ManifestValidationError when the asset is not JSON", async () => {
    fetchMock
      .mockResolvedValueOnce(
        okResponse({
          assets: [{ name: "migration.json", url: "https://api/asset/1" }],
        }),
      )
      .mockResolvedValueOnce(new Response("{ not json", { status: 200 }));

    await expect(fetchReleaseManifest(TOKEN, "v1.2.0")).rejects.toBeInstanceOf(
      ManifestValidationError,
    );
  });

  it("throws on non-404 release-fetch errors (e.g. 500)", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(500));
    await expect(fetchReleaseManifest(TOKEN, "v1.2.0")).rejects.toThrow(
      /GitHub API error fetching release v1\.2\.0: 500/,
    );
  });

  it("throws on asset-fetch errors", async () => {
    fetchMock
      .mockResolvedValueOnce(
        okResponse({
          assets: [{ name: "migration.json", url: "https://api/asset/1" }],
        }),
      )
      .mockResolvedValueOnce(errorResponse(503));

    await expect(fetchReleaseManifest(TOKEN, "v1.2.0")).rejects.toThrow(
      /GitHub API error fetching migration asset/,
    );
  });

  it("caches by tag — second call hits zero network calls", async () => {
    const raw = rawManifest("1.1.0", "1.2.0");
    fetchMock
      .mockResolvedValueOnce(
        okResponse({
          assets: [{ name: "migration.json", url: "https://api/asset/1" }],
        }),
      )
      .mockResolvedValueOnce(okResponse(raw));

    const first = await fetchReleaseManifest(TOKEN, "v1.2.0");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const second = await fetchReleaseManifest(TOKEN, "v1.2.0");
    // Cache hit — no additional fetches.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Same reference (cache stores the validated object).
    expect(second).toBe(first);
  });

  it("URL-encodes the tag name in the release endpoint", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(404));
    await fetchReleaseManifest(TOKEN, "v1.2.0+build.1");
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain(encodeURIComponent("v1.2.0+build.1"));
  });
});

// ---------------------------------------------------------------------------
// loadManifestChain
// ---------------------------------------------------------------------------

describe("loadManifestChain", () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    __clearManifestCacheForTests();
    // Reset the bundled-manifests holder between tests.
    bundledHolder.manifests = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns [] when fromVersion === toVersion (no fetches)", async () => {
    const result = await loadManifestChain(TOKEN, "1.0.0", "1.0.0");
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("builds chain entirely from bundled manifests without network calls", async () => {
    bundledHolder.manifests = [m("0.9.0-beta", "1.0.0"), m("1.0.0", "1.1.0")];
    const result = await loadManifestChain(TOKEN, "0.9.0-beta", "1.1.0");
    expect(result).toHaveLength(2);
    expect(result[0].from_version).toBe("0.9.0-beta");
    expect(result[1].to_version).toBe("1.1.0");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches release asset when bundled coverage stops before toVersion", async () => {
    bundledHolder.manifests = [m("1.0.0", "1.1.0")]; // stops at 1.1.0
    // Target 1.2.0 — need to fetch v1.2.0 release asset.
    const raw = rawManifest("1.1.0", "1.2.0");
    fetchMock
      .mockResolvedValueOnce(
        okResponse({
          assets: [{ name: "migration.json", url: "https://api/asset/1" }],
        }),
      )
      .mockResolvedValueOnce(okResponse(raw));

    const result = await loadManifestChain(TOKEN, "1.0.0", "1.2.0");
    expect(result).toHaveLength(2);
    expect(result[0].from_version).toBe("1.0.0");
    expect(result[1].from_version).toBe("1.1.0");
    expect(result[1].to_version).toBe("1.2.0");
  });

  it("takes the manifest from a pinned release tag the release listing hides", async () => {
    bundledHolder.manifests = [m("1.0.0", "1.1.0")];
    // A pinned release candidate: the listing endpoint drops prereleases, so
    // only asking for the tag by name finds its manifest.
    const raw = rawManifest("1.1.0", "1.2.0");
    fetchMock
      .mockResolvedValueOnce(
        okResponse({
          assets: [{ name: "migration.json", url: "https://api/asset/rc" }],
        }),
      )
      .mockResolvedValueOnce(okResponse(raw));

    const result = await loadManifestChain(
      TOKEN,
      "1.0.0",
      "1.2.0",
      "v1.2.0-rc.1",
    );
    expect(result).toHaveLength(2);
    expect(result[1].from_version).toBe("1.1.0");
    expect(result[1].to_version).toBe("1.2.0");
    // The pinned tag is asked for first, before any version-derived candidate.
    expect(fetchMock.mock.calls[0][0]).toContain("releases/tags/v1.2.0-rc.1");
  });

  it("falls through to the usual search when a pinned tag carries no manifest", async () => {
    bundledHolder.manifests = [m("1.0.0", "1.1.0")];
    const raw = rawManifest("1.1.0", "1.2.0");
    fetchMock
      // pinned tag: release exists, no migration.json asset
      .mockResolvedValueOnce(okResponse({ assets: [] }))
      // v1.2.0: the real manifest
      .mockResolvedValueOnce(
        okResponse({
          assets: [{ name: "migration.json", url: "https://api/asset/1" }],
        }),
      )
      .mockResolvedValueOnce(okResponse(raw));

    const result = await loadManifestChain(
      TOKEN,
      "1.0.0",
      "1.2.0",
      "v1.2.0-rc.1",
    );
    expect(result).toHaveLength(2);
    expect(result[1].to_version).toBe("1.2.0");
  });

  it("fails closed with 'Missing migration manifest' when the release asset 404s", async () => {
    bundledHolder.manifests = [m("1.0.0", "1.1.0")];
    // Every candidate-tag release fetch returns 404; the listing names none.
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/releases?per_page=100") ? okResponse([]) : errorResponse(404),
    );

    await expect(loadManifestChain(TOKEN, "1.0.0", "1.2.0")).rejects.toThrow(
      /Missing migration manifest for upgrade path 1\.1\.0/,
    );
  });

  it("fails closed when a release exists but has no migration.json asset", async () => {
    bundledHolder.manifests = [m("1.0.0", "1.1.0")];
    // Every candidate tag: release exists, but no migration.json asset; the
    // listing names none.
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/releases?per_page=100")
        ? okResponse([])
        : okResponse({ assets: [{ name: "source-code.zip", url: "https://x/y" }] }),
    );

    await expect(loadManifestChain(TOKEN, "1.0.0", "1.2.0")).rejects.toThrow(
      /Missing migration manifest/,
    );
  });

  it("surfaces unsupported-path error when the chain gap is entirely absent from bundled + releases", async () => {
    // No bundled coverage at all; release tags for the target return 404, and
    // the listing names none.
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/releases?per_page=100") ? okResponse([]) : errorResponse(404),
    );
    await expect(loadManifestChain(TOKEN, "0.1.0", "0.2.0")).rejects.toThrow(
      /Missing migration manifest/,
    );
  });

  it("walks skip-version chains by listing releases (e.g. 1.2.0 → 1.2.1 → 1.3.0)", async () => {
    // Production regression: bundled ends at 1.2.0, target is 1.3.0, but
    // v1.3.0's manifest starts at 1.2.1 (skip-version). The discovery has
    // to find v1.2.1 as the intermediate hop via the release listing.
    bundledHolder.manifests = [m("1.1.0", "1.2.0")];

    fetchMock.mockImplementation((url: string) => {
      // 1. Direct fast-path probe: v1.3.0 release + its asset.
      if (url.endsWith("/releases/tags/v1.3.0")) {
        return Promise.resolve(
          okResponse({
            assets: [{ name: "migration.json", url: "https://api/asset/v1.3.0" }],
          }),
        );
      }
      if (url === "https://api/asset/v1.3.0") {
        return Promise.resolve(okResponse(rawManifest("1.2.1", "1.3.0")));
      }
      // 2. Release listing.
      if (url.endsWith("/releases?per_page=100")) {
        return Promise.resolve(
          okResponse([{ tag_name: "v1.3.0" }, { tag_name: "v1.2.1" }]),
        );
      }
      // 3. v1.2.1 release + its asset (the intermediate hop).
      if (url.endsWith("/releases/tags/v1.2.1")) {
        return Promise.resolve(
          okResponse({
            assets: [{ name: "migration.json", url: "https://api/asset/v1.2.1" }],
          }),
        );
      }
      if (url === "https://api/asset/v1.2.1") {
        return Promise.resolve(okResponse(rawManifest("1.2.0", "1.2.1")));
      }
      return Promise.resolve(errorResponse(404));
    });

    const result = await loadManifestChain(TOKEN, "1.1.0", "1.3.0");
    expect(result).toHaveLength(3);
    expect(result[0].from_version).toBe("1.1.0");
    expect(result[0].to_version).toBe("1.2.0");
    expect(result[1].from_version).toBe("1.2.0");
    expect(result[1].to_version).toBe("1.2.1");
    expect(result[2].from_version).toBe("1.2.1");
    expect(result[2].to_version).toBe("1.3.0");
  });
});

// ---------------------------------------------------------------------------
// loadManifestChain: release reads that cannot be completed
// ---------------------------------------------------------------------------

describe("loadManifestChain: a release read that fails stops the chain", () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    __clearManifestCacheForTests();
    bundledHolder.manifests = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const LISTING = "/releases?per_page=100";

  /**
   * GitHub for a set of releases: each tag's release carries a migration.json
   * asset answering `manifests[tag]`, a response for the asset, or nothing
   * (404 on the tag) when the tag is not listed. `listing` answers the
   * release listing.
   */
  function github(
    manifests: Record<string, () => unknown>,
    listing: () => unknown = () => okResponse(Object.keys(manifests).map((tag) => ({ tag_name: tag }))),
  ) {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith(LISTING)) return listing();
      const tag = url.match(/\/releases\/tags\/([^/]+)$/)?.[1];
      if (tag !== undefined) {
        const decoded = decodeURIComponent(tag);
        return manifests[decoded]
          ? okResponse({ assets: [{ name: "migration.json", url: `https://api/asset/${decoded}` }] })
          : errorResponse(404);
      }
      const asset = url.match(/^https:\/\/api\/asset\/(.+)$/)?.[1];
      if (asset !== undefined && manifests[asset]) return manifests[asset]();
      return errorResponse(404);
    });
  }

  async function failure(run: Promise<unknown>): Promise<unknown> {
    try {
      await run;
    } catch (err) {
      return err;
    }
    throw new Error("expected the chain to fail");
  }

  it("fails on a release listing that cannot be read, rather than trying the legacy tags", async () => {
    bundledHolder.manifests = [m("1.0.0", "1.1.0")];
    github({}, () => errorResponse(500));
    const err = await failure(loadManifestChain(TOKEN, "1.0.0", "1.2.0"));
    expect(err).toBeInstanceOf(ReleaseListUnreadableError);
    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((u) => u.endsWith("/releases/tags/v1.1.0"))).toBe(false);
  });

  /** The failure names migration.json of the release `version`. */
  function expectUnreadableManifest(err: unknown, version: string) {
    expect(err).toBeInstanceOf(ReleaseFileUnreadableError);
    expect((err as ReleaseFileUnreadableError).path).toBe("migration.json");
    expect((err as ReleaseFileUnreadableError).version).toBe(version);
  }

  it("fails on the target's migration.json answering 500, naming it and its release", async () => {
    bundledHolder.manifests = [m("1.0.0", "1.1.0")];
    github({ "v1.2.0": () => errorResponse(500) });
    expectUnreadableManifest(await failure(loadManifestChain(TOKEN, "1.0.0", "1.2.0")), "1.2.0");
  });

  it("fails on the target's migration.json that does not validate, naming its release", async () => {
    bundledHolder.manifests = [m("1.0.0", "1.1.0")];
    github({ "v1.2.0": () => okResponse({ schema_version: 1, from_version: "1.1.0" }) });
    const err = await failure(loadManifestChain(TOKEN, "1.0.0", "1.2.0"));
    expect(err).toBeInstanceOf(ReleaseManifestInvalidError);
    expect((err as ReleaseManifestInvalidError).version).toBe("1.2.0");
    expect((err as Error).cause).toBeInstanceOf(ManifestValidationError);
  });

  it("fails on an intermediate hop's migration.json that does not validate, naming that hop's release", async () => {
    bundledHolder.manifests = [m("1.1.0", "1.2.0")];
    github({
      "v1.3.0": () => okResponse(rawManifest("1.2.1", "1.3.0")),
      "v1.2.1": () => okResponse({ schema_version: 1, from_version: "1.2.0" }),
    });
    const err = await failure(loadManifestChain(TOKEN, "1.1.0", "1.3.0"));
    expect(err).toBeInstanceOf(ReleaseManifestInvalidError);
    expect((err as ReleaseManifestInvalidError).version).toBe("1.2.1");
  });

  it("fails on the target's release answering 500, naming its migration.json", async () => {
    bundledHolder.manifests = [m("1.0.0", "1.1.0")];
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/releases/tags/v1.2.0") ? errorResponse(500) : errorResponse(404),
    );
    expectUnreadableManifest(await failure(loadManifestChain(TOKEN, "1.0.0", "1.2.0")), "1.2.0");
  });

  it("fails on an intermediate hop's migration.json answering 500 (1.2.0 reaching 1.3.0 through 1.2.1)", async () => {
    bundledHolder.manifests = [m("1.1.0", "1.2.0")];
    github({
      "v1.3.0": () => okResponse(rawManifest("1.2.1", "1.3.0")),
      "v1.2.1": () => errorResponse(500),
    });
    expectUnreadableManifest(await failure(loadManifestChain(TOKEN, "1.1.0", "1.3.0")), "1.2.1");
  });

  describe("on the chain's second discovered hop", () => {
    // 1.2.0 reaches 1.4.0 through 1.3.0 and 1.3.1: v1.4.0's manifest starts at
    // 1.3.1, so the first hop (1.2.0 -> 1.3.0) and the second (1.3.0 -> 1.3.1)
    // are each found through the listing.
    const HOPS = {
      "v1.4.0": () => okResponse(rawManifest("1.3.1", "1.4.0")),
      "v1.3.0": () => okResponse(rawManifest("1.2.0", "1.3.0")),
    };

    it("chains every hop when each reads", async () => {
      bundledHolder.manifests = [m("1.1.0", "1.2.0")];
      github({ ...HOPS, "v1.3.1": () => okResponse(rawManifest("1.3.0", "1.3.1")) });
      const chain = await loadManifestChain(TOKEN, "1.1.0", "1.4.0");
      expect(chain.map((x) => x.to_version)).toEqual(["1.2.0", "1.3.0", "1.3.1", "1.4.0"]);
    });

    it("fails on its migration.json answering 500, naming it", async () => {
      bundledHolder.manifests = [m("1.1.0", "1.2.0")];
      github({ ...HOPS, "v1.3.1": () => errorResponse(500) });
      expectUnreadableManifest(await failure(loadManifestChain(TOKEN, "1.1.0", "1.4.0")), "1.3.1");
    });

    it("fails on its release listing that cannot be read", async () => {
      bundledHolder.manifests = [m("1.1.0", "1.2.0")];
      let listings = 0;
      const tags = [...Object.keys(HOPS), "v1.3.1"].map((tag) => ({ tag_name: tag }));
      github({ ...HOPS, "v1.3.1": () => okResponse(rawManifest("1.3.0", "1.3.1")) }, () =>
        ++listings === 1 ? okResponse(tags) : errorResponse(500),
      );
      const err = await failure(loadManifestChain(TOKEN, "1.1.0", "1.4.0"));
      expect(err).toBeInstanceOf(ReleaseListUnreadableError);
      expect(listings).toBe(2);
    });
  });
});
