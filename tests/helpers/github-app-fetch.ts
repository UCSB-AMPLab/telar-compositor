/**
 * Support for route-level tests that must exercise the REAL
 * `resolveProjectToken` / `getInstallationToken` from
 * `~/lib/github-app.server` rather than a hand-copied mock of their
 * fallback logic (a regression in that fallback — e.g. removing the
 * convenor restriction — must be able to fail these tests).
 *
 * `getInstallationToken` calls `signJwt` and `fetch` directly from within
 * the same module as bare identifiers, not through the module's exported
 * namespace — so `vi.mock("~/lib/github-app.server", ...)` cannot
 * intercept that internal call no matter which export the mock factory
 * overrides; the override is only visible to OTHER modules that import the
 * mocked specifier, never to code inside the real module's own compiled
 * closure. The only interceptable boundary below `resolveProjectToken` is
 * the actual network call, so these tests run the real JWT signing against
 * a throwaway RSA key and stub only `fetch`.
 */

import { generateKeyPairSync } from "node:crypto";
import { vi } from "vitest";

let cachedPrivateKeyPem: string | undefined;

/** A throwaway RSA private key (PKCS#8 PEM), generated once per test process. */
export function testGithubAppPrivateKey(): string {
  if (!cachedPrivateKeyPem) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    cachedPrivateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  }
  return cachedPrivateKeyPem;
}

interface GithubAppFetchStubOptions {
  /** The token the mint endpoint returns. Pass `null` to make the mint fail
   *  (a non-ok response), so a real `resolveProjectToken` call under test
   *  takes its convenor-only fallback branch for real rather than by mock. */
  mintToken?: string | null;
  /** workflows:write value reported by getInstallationInfo's stub. */
  workflowsWrite?: boolean;
}

/**
 * Stubs global `fetch` for exactly the two GitHub App endpoints
 * `getInstallationToken` and `getInstallationInfo` call — the mint
 * endpoint and the installation-info endpoint. Every other GitHub read in
 * these route-level tests is already mocked at the module level
 * (`~/lib/github.server`, `~/lib/commit.server`, `~/lib/upgrade.server`),
 * so a real `fetch` reaching any other URL here means something is running
 * unmocked; that case throws rather than silently returning a plausible
 * response.
 */
export function installGithubAppFetchStub(options: GithubAppFetchStubOptions = {}) {
  const mintToken = options.mintToken === undefined ? "install-token" : options.mintToken;
  const fetchMock = vi.fn(async (url: unknown) => {
    const href = String(url);
    if (href.endsWith("/access_tokens")) {
      if (mintToken === null) {
        return {
          ok: false,
          status: 500,
          text: async () => "installation token mint failed",
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: mintToken }),
      } as unknown as Response;
    }
    if (/\/app\/installations\/\d+$/.test(href)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          permissions: { workflows: options.workflowsWrite === false ? "read" : "write" },
          target_type: "User",
        }),
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch reached installGithubAppFetchStub: ${href}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
