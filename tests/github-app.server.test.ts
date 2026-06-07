import { describe, it, expect, vi, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { getInstallationToken } from "~/lib/github-app.server";

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
