import { describe, it, expect, vi, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { GitHubPermissionError, GitHubTransientError } from "~/lib/github.server";
import { getInstallationToken, getInstallationInfo, getInstallationAccount, resolveProjectToken } from "~/lib/github-app.server";

// These tests exercise the GitHub App JWT signing path end-to-end through the
// only public surface (getInstallationToken). We generate a throwaway RSA key,
// feed the App both PKCS#1 and PKCS#8 PEM forms, capture the Bearer JWT that
// getInstallationToken sends, and verify its RS256 signature against the
// matching public key using pure Web Crypto. Nothing touches real secrets.

const APP_ID = "123456";
const INSTALLATION_ID = 42;

function genKey() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  return {
    pkcs1: privateKey.export({ type: "pkcs1", format: "pem" }) as string,
    pkcs8: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    spki: publicKey.export({ type: "spki", format: "pem" }) as string,
  };
}

function spkiPemToBytes(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const binary = atob(b64 + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Mocks fetch, captures the JWT from the Authorization header, returns it. */
function installFetchCapture() {
  const captured: { jwt?: string } = {};
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string>)?.Authorization ?? "";
    captured.jwt = auth.replace(/^Bearer /, "");
    return {
      ok: true,
      status: 200,
      json: async () => ({ token: "ghs_installtoken" }),
      text: async () => "",
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return captured;
}

/** Verifies an RS256 JWT signature against an SPKI public key via Web Crypto. */
async function jwtSignatureValid(jwt: string, spkiPem: string): Promise<boolean> {
  const [headerB64, payloadB64, sigB64] = jwt.split(".");
  const pub = await crypto.subtle.importKey(
    "spki",
    spkiPemToBytes(spkiPem)
      .buffer.slice(0) as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    pub,
    b64urlToBytes(sigB64).buffer.slice(0) as ArrayBuffer,
    data,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getInstallationToken — key format handling", () => {
  it("signs a verifiable JWT from a PKCS#8 PEM (BEGIN PRIVATE KEY)", async () => {
    const key = genKey();
    const captured = installFetchCapture();

    const token = await getInstallationToken(APP_ID, key.pkcs8, INSTALLATION_ID);
    expect(token).toBe("ghs_installtoken");
    expect(captured.jwt).toBeTruthy();
    expect(await jwtSignatureValid(captured.jwt!, key.spki)).toBe(true);
  });

  it("signs a verifiable JWT from a PKCS#1 PEM (BEGIN RSA PRIVATE KEY)", async () => {
    const key = genKey();
    const captured = installFetchCapture();

    const token = await getInstallationToken(APP_ID, key.pkcs1, INSTALLATION_ID);
    expect(token).toBe("ghs_installtoken");
    expect(captured.jwt).toBeTruthy();
    // The PKCS#1 key, wrapped to PKCS#8 at runtime, must produce a signature
    // that verifies against the SAME key pair's public key — proving it is not
    // silently mis-signing (the staging 401 failure mode).
    expect(await jwtSignatureValid(captured.jwt!, key.spki)).toBe(true);
  });

  it("embeds the app id as issuer and RS256 alg in the JWT", async () => {
    const key = genKey();
    const captured = installFetchCapture();

    await getInstallationToken(APP_ID, key.pkcs1, INSTALLATION_ID);
    const [headerB64, payloadB64] = captured.jwt!.split(".");
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(headerB64)));
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64)));
    expect(header.alg).toBe("RS256");
    expect(payload.iss).toBe(APP_ID);
  });

  it("throws a clear, actionable error for a bogus PEM", async () => {
    installFetchCapture();
    const bogus =
      "-----BEGIN PRIVATE KEY-----\nnot-real-base64-key-material\n-----END PRIVATE KEY-----";
    await expect(
      getInstallationToken(APP_ID, bogus, INSTALLATION_ID),
    ).rejects.toThrow(/GITHUB_PRIVATE_KEY could not be/);
  });

  it("throws a clear error for a structurally-valid-base64 but non-key PEM", async () => {
    installFetchCapture();
    // Valid base64 that decodes but is not a valid PKCS#8 key.
    const fakeBody = btoa("this is not a der-encoded key at all, padding here");
    const bogus = `-----BEGIN PRIVATE KEY-----\n${fakeBody}\n-----END PRIVATE KEY-----`;
    await expect(
      getInstallationToken(APP_ID, bogus, INSTALLATION_ID),
    ).rejects.toThrow(/GITHUB_PRIVATE_KEY could not be imported/);
  });
});

describe("getInstallationInfo", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports workflowsWrite=true and the target_type when the install holds workflows:write", async () => {
    const { pkcs8 } = genKey();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          permissions: { workflows: "write", contents: "write", pages: "write" },
          target_type: "User",
        }),
        text: async () => "",
      } as unknown as Response)),
    );
    const info = await getInstallationInfo(APP_ID, pkcs8, INSTALLATION_ID);
    expect(info.workflowsWrite).toBe(true);
    expect(info.targetType).toBe("User");
  });

  it("reports workflowsWrite=false when the workflows permission is absent (the accept-gap)", async () => {
    const { pkcs8 } = genKey();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          permissions: { contents: "write", pages: "write", administration: "write" },
          target_type: "Organization",
        }),
        text: async () => "",
      } as unknown as Response)),
    );
    const info = await getInstallationInfo(APP_ID, pkcs8, INSTALLATION_ID);
    expect(info.workflowsWrite).toBe(false);
    expect(info.targetType).toBe("Organization");
  });

  it("throws on a non-ok response so the caller can fail open", async () => {
    const { pkcs8 } = genKey();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => "Not Found",
      } as unknown as Response)),
    );
    await expect(
      getInstallationInfo(APP_ID, pkcs8, INSTALLATION_ID),
    ).rejects.toThrow();
  });
});

// The installation token is the publishing roles'
// authority, and no role outside that set has its reach widened by it — a
// null (non-member) role and an unrecognised role each get their own token
// and never even attempt a mint. Within the set, the acting user's own
// token is a fallback for the convenor alone: no other role's token can
// write to the convenor's repository, so a failed mint has to surface as a
// failure rather than as a confusing GitHub 403 later.
describe("resolveProjectToken — the installation token belongs to publishing roles only", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("convenor: mint succeeds, installation token used", async () => {
    const { pkcs8 } = genKey();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ token: "install-token" }),
        text: async () => "",
      } as unknown as Response)),
    );
    const token = await resolveProjectToken(APP_ID, pkcs8, INSTALLATION_ID, "user-token", "convenor");
    expect(token).toBe("install-token");
  });

  it("convenor: mint fails, falls back to the convenor's own token", async () => {
    const { pkcs8 } = genKey();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => "mint failed",
      } as unknown as Response)),
    );
    const token = await resolveProjectToken(APP_ID, pkcs8, INSTALLATION_ID, "user-token", "convenor");
    expect(token).toBe("user-token");
  });

  it("collaborator: mint succeeds, installation token used", async () => {
    const { pkcs8 } = genKey();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ token: "install-token" }),
        text: async () => "",
      } as unknown as Response)),
    );
    const token = await resolveProjectToken(APP_ID, pkcs8, INSTALLATION_ID, "user-token", "collaborator");
    expect(token).toBe("install-token");
  });

  it("collaborator: mint fails, throws rather than falling back to their own token", async () => {
    const { pkcs8 } = genKey();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => "mint failed",
      } as unknown as Response)),
    );
    await expect(
      resolveProjectToken(APP_ID, pkcs8, INSTALLATION_ID, "user-token", "collaborator"),
    ).rejects.toThrow();
  });

  it("instructor: mint succeeds, installation token used", async () => {
    const { pkcs8 } = genKey();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ token: "install-token" }),
        text: async () => "",
      } as unknown as Response)),
    );
    const token = await resolveProjectToken(APP_ID, pkcs8, INSTALLATION_ID, "user-token", "instructor");
    expect(token).toBe("install-token");
  });

  it("instructor: mint fails, throws rather than falling back to their own token", async () => {
    const { pkcs8 } = genKey();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => "mint failed",
      } as unknown as Response)),
    );
    await expect(
      resolveProjectToken(APP_ID, pkcs8, INSTALLATION_ID, "user-token", "instructor"),
    ).rejects.toThrow();
  });

  it("null role (non-member): never attempts a mint — returns their own token directly", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const token = await resolveProjectToken(APP_ID, "not-a-real-key", INSTALLATION_ID, "user-token", null);
    expect(token).toBe("user-token");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an unrecognised future role string: treated as non-publishing — own token, no mint attempt", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const token = await resolveProjectToken(APP_ID, "not-a-real-key", INSTALLATION_ID, "user-token", "editor");
    expect(token).toBe("user-token");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("getInstallationAccount", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the login of the account the installation is on, from GET /app/installations/{id}", async () => {
    const { pkcs8 } = genKey();
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ account: { login: "Some-Org" }, target_type: "Organization" }),
      text: async () => "",
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchSpy);

    expect(await getInstallationAccount(APP_ID, pkcs8, INSTALLATION_ID)).toBe("Some-Org");
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect(url).toBe(`https://api.github.com/app/installations/${INSTALLATION_ID}`);
    expect(init?.method ?? "GET").toBe("GET");
  });

  it("answers null when GitHub names no account", async () => {
    const { pkcs8 } = genKey();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" } as unknown as Response)),
    );

    expect(await getInstallationAccount(APP_ID, pkcs8, INSTALLATION_ID)).toBeNull();
  });

  it("throws on a non-ok response", async () => {
    const { pkcs8 } = genKey();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "Not Found" } as unknown as Response)),
    );

    await expect(getInstallationAccount(APP_ID, pkcs8, INSTALLATION_ID)).rejects.toThrow();
  });
});

// The token step is where a collaborator or instructor learns the App was
// removed from the repository's installation: GitHub answers 403 or 404 to
// the mint, and publish must name that as a permission loss. A 401 refuses the
// App's own signed token, which is Telar's configuration, not the author's.
describe("the installation token mint — what GitHub's refusal is", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubMint(status: number, text: string, headers: Record<string, string> = {}) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status,
        headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
        text: async () => text,
      } as unknown as Response)),
    );
  }

  it.each([403, 404])("getInstallationToken throws GitHubPermissionError for a %i", async (status) => {
    const { pkcs8 } = genKey();
    stubMint(status, "Not Found");

    const err = await getInstallationToken(APP_ID, pkcs8, INSTALLATION_ID).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GitHubPermissionError);
    expect((err as GitHubPermissionError).status).toBe(status);
    expect((err as Error).message).toBe(`Failed to get installation token: ${status} Not Found`);
  });

  it("getInstallationToken leaves a 401, the App's own credentials refused, a plain Error", async () => {
    const { pkcs8 } = genKey();
    stubMint(401, "Bad credentials");

    const err = await getInstallationToken(APP_ID, pkcs8, INSTALLATION_ID).catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(GitHubPermissionError);
    expect((err as Error).message).toBe("Failed to get installation token: 401 Bad credentials");
  });

  it("getInstallationToken leaves a 5xx a plain Error", async () => {
    const { pkcs8 } = genKey();
    stubMint(500, "boom");

    const err = await getInstallationToken(APP_ID, pkcs8, INSTALLATION_ID).catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(GitHubPermissionError);
    expect(err).not.toBeInstanceOf(GitHubTransientError);
  });

  it("getInstallationToken throws GitHubTransientError for a rate-limited 403", async () => {
    const { pkcs8 } = genKey();
    stubMint(403, "secondary rate limit", { "retry-after": "30" });

    const err = await getInstallationToken(APP_ID, pkcs8, INSTALLATION_ID).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GitHubTransientError);
  });

  it.each(["collaborator", "instructor"])("resolveProjectToken surfaces the permission error for a %s", async (role) => {
    const { pkcs8 } = genKey();
    stubMint(404, "Not Found");

    await expect(
      resolveProjectToken(APP_ID, pkcs8, INSTALLATION_ID, "user-token", role),
    ).rejects.toBeInstanceOf(GitHubPermissionError);
  });
});
