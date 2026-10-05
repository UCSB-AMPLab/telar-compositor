/**
 * GitHub App JWT signing and installation access token generation.
 *
 * Uses Web Crypto API (available in Cloudflare Workers) to sign JWTs
 * with the App's RSA private key. Installation tokens carry the App's
 * permissions (e.g. pages:write) which user OAuth tokens do not.
 *
 * The private key is accepted in either PKCS#1 (`BEGIN RSA PRIVATE KEY`,
 * GitHub's default download format) or PKCS#8 (`BEGIN PRIVATE KEY`) PEM.
 * Web Crypto importKey only accepts PKCS#8, so PKCS#1 keys are wrapped into
 * a PKCS#8 PrivateKeyInfo at runtime before import.
 *
 * @version v1.5.0-beta
 */

import {
  githubHeaders,
  GitHubPermissionError,
  GitHubTransientError,
  isRateLimitRefusal,
} from "~/lib/github.server";
import { isPublishingRole } from "~/lib/publishing-roles";

// ---------------------------------------------------------------------------
// JWT generation
// ---------------------------------------------------------------------------

function base64url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemBodyToBytes(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN (RSA )?PRIVATE KEY-----/, "")
    .replace(/-----END (RSA )?PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  let binary: string;
  try {
    binary = atob(b64);
  } catch {
    throw new Error(
      "GITHUB_PRIVATE_KEY could not be decoded; expected an RSA private key " +
        "in PKCS#1 or PKCS#8 PEM format (check the secret is the real PEM, " +
        "not escaped \\n sequences).",
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// PKCS#1 -> PKCS#8 wrapping
//
// GitHub Apps download private keys in PKCS#1 form (`BEGIN RSA PRIVATE KEY`)
// by default. Web Crypto's importKey only accepts PKCS#8 ("pkcs8"); handing it
// a PKCS#1 DER throws a cryptic `DataError: Invalid keyData`. To accept both,
// we wrap a PKCS#1 RSAPrivateKey in a PKCS#8 PrivateKeyInfo at runtime:
//
//   SEQUENCE {
//     INTEGER 0                              -- version
//     SEQUENCE { OID rsaEncryption, NULL }   -- AlgorithmIdentifier
//     OCTET STRING { <PKCS#1 DER> }          -- privateKey
//   }
// ---------------------------------------------------------------------------

// Fixed rsaEncryption AlgorithmIdentifier: SEQUENCE { OID 1.2.840.113549.1.1.1, NULL }
const RSA_ALGORITHM_IDENTIFIER = new Uint8Array([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  0x05, 0x00,
]);

// DER length octets: short form (<128) or long form with leading 0x80|count.
function derLength(len: number): number[] {
  if (len < 0x80) return [len];
  const out: number[] = [];
  let n = len;
  while (n > 0) {
    out.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | out.length, ...out];
}

// Build a DER TLV (tag + length + content).
function derTLV(tag: number, content: Uint8Array): Uint8Array {
  const len = derLength(content.length);
  const out = new Uint8Array(1 + len.length + content.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(content, 1 + len.length);
  return out;
}

function wrapPkcs1AsPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = new Uint8Array([0x02, 0x01, 0x00]); // INTEGER 0
  const privateKeyOctet = derTLV(0x04, pkcs1); // OCTET STRING { pkcs1 }
  const inner = new Uint8Array(
    version.length + RSA_ALGORITHM_IDENTIFIER.length + privateKeyOctet.length,
  );
  inner.set(version, 0);
  inner.set(RSA_ALGORITHM_IDENTIFIER, version.length);
  inner.set(privateKeyOctet, version.length + RSA_ALGORITHM_IDENTIFIER.length);
  return derTLV(0x30, inner); // SEQUENCE { ... }
}

/**
 * Imports an RSA private key for RS256 signing from a PEM string, accepting
 * BOTH PKCS#1 (`BEGIN RSA PRIVATE KEY`) and PKCS#8 (`BEGIN PRIVATE KEY`).
 * PKCS#1 keys are wrapped into PKCS#8 before import. Throws a clear, actionable
 * error if the key cannot be imported.
 */
async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  const isPkcs1 = /-----BEGIN RSA PRIVATE KEY-----/.test(pem);
  const body = pemBodyToBytes(pem);
  const pkcs8 = isPkcs1 ? wrapPkcs1AsPkcs8(body) : body;

  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      pkcs8.buffer.slice(
        pkcs8.byteOffset,
        pkcs8.byteOffset + pkcs8.byteLength,
      ) as ArrayBuffer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch (err) {
    throw new Error(
      "GITHUB_PRIVATE_KEY could not be imported; expected an RSA private key " +
        "in PKCS#1 or PKCS#8 PEM format. " +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

async function signJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60, // 60s clock skew allowance
    exp: now + 600, // 10 minute max
    iss: appId,
  };

  const enc = new TextEncoder();
  const headerB64 = base64url(enc.encode(JSON.stringify(header)));
  const payloadB64 = base64url(enc.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await importRsaPrivateKey(privateKeyPem);

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    enc.encode(signingInput),
  );

  return `${signingInput}.${base64url(signature)}`;
}

// ---------------------------------------------------------------------------
// Installation access token
// ---------------------------------------------------------------------------

/**
 * Generates an installation access token for the given installation ID.
 * This token carries the App's permissions (pages:write, contents:write, etc.).
 */
export async function getInstallationToken(
  appId: string,
  privateKeyPem: string,
  installationId: number,
): Promise<string> {
  const jwt = await signJwt(appId, privateKeyPem);

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "telar-compositor",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!res.ok) {
    const body = await res.text();
    const message = `Failed to get installation token: ${res.status} ${body}`;
    if (res.status === 403 && isRateLimitRefusal(res.headers, body)) {
      throw new GitHubTransientError(message, res.status);
    }
    // The installation is gone or no longer lets the App in: the author is
    // told that, not to try again. A 401 is the App's own credentials being
    // refused, which no author can fix, so it stays an ordinary failure.
    if (res.status === 403 || res.status === 404) {
      throw new GitHubPermissionError(message, res.status);
    }
    throw new Error(message);
  }

  const data = (await res.json()) as { token: string };
  return data.token;
}

/**
 * The token a project-repo commit or read runs under. The installation
 * token is the publishing roles' authority, and no role outside that set
 * has its reach widened by it: for a role the set does not name, and for a
 * null role, this returns the acting user's own token — a non-member gets
 * no more access to the repository than their own GitHub account already
 * has.
 *
 * For a publishing role, the installation token is minted wherever
 * possible; the acting user's own token is a fallback ONLY for the
 * convenor. No other role's OAuth token has write access to the convenor's
 * repository and, on a private repo, it may have no read access either
 * (GitHub's OAuth scopes grant nothing beyond what the authorizing user
 * already has — see docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps),
 * so a mint failure for any role but the convenor must surface as a failure
 * rather than trade it for a confusing GitHub 403. The convenor fallback
 * also keeps local development working when the App's credentials are not
 * configured.
 */
export async function resolveProjectToken(
  appId: string,
  privateKeyPem: string,
  installationId: number,
  userToken: string,
  role: string | null,
): Promise<string> {
  if (!isPublishingRole(role)) return userToken;
  try {
    return await getInstallationToken(appId, privateKeyPem, installationId);
  } catch (err) {
    if (role === "convenor") return userToken;
    throw err;
  }
}

export interface InstallationInfo {
  /** True when this installation has granted the App's `workflows: write`
   *  permission. GitHub does not auto-propagate newly-declared permissions to
   *  existing installs — each owner must approve — so this can be false even
   *  when the App declares workflows:write. */
  workflowsWrite: boolean;
  /** Account type the App is installed on; null when GitHub returns an
   *  unexpected value. Drives the org-scoped vs user reauth URL. */
  targetType: "User" | "Organization" | null;
}

interface InstallationRecord {
  permissions?: Record<string, string>;
  target_type?: string;
  account?: { login?: string } | null;
}

/** GET /app/installations/{id} via the App JWT. Throws on a non-ok response. */
async function readInstallation(
  appId: string,
  privateKeyPem: string,
  installationId: number,
): Promise<InstallationRecord> {
  const jwt = await signJwt(appId, privateKeyPem);

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}`,
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "telar-compositor",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Failed to get installation ${installationId}: ${res.status} ${body}`,
    );
  }

  return (await res.json()) as InstallationRecord;
}

/**
 * The login of the account an installation is on, or null when GitHub names
 * none. Throws on a non-ok response.
 */
export async function getInstallationAccount(
  appId: string,
  privateKeyPem: string,
  installationId: number,
): Promise<string | null> {
  const data = await readInstallation(appId, privateKeyPem, installationId);
  return data.account?.login ?? null;
}

/**
 * Reads an installation's GRANTED permissions + account type via the App JWT
 * (GET /app/installations/{id}). The permissions reflect what the installation
 * has actually accepted — not merely what the App requests — so it reveals the
 * workflows-write accept-gap. Throws on a non-ok response; callers fail open.
 */
export async function getInstallationInfo(
  appId: string,
  privateKeyPem: string,
  installationId: number,
): Promise<InstallationInfo> {
  const data = await readInstallation(appId, privateKeyPem, installationId);

  return {
    workflowsWrite: data.permissions?.workflows === "write",
    targetType:
      data.target_type === "Organization"
        ? "Organization"
        : data.target_type === "User"
          ? "User"
          : null,
  };
}
