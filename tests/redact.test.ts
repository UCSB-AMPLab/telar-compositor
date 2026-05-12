/**
 * This file pins the redaction patterns the bug-report flow applies before
 * any user-typed text leaves the browser — email addresses, GitHub
 * personal-access tokens, JWTs, and Bearer auth headers are all replaced
 * with placeholder markers, while project IDs, story slugs, and IIIF URLs
 * (legitimate diagnostic content) are left untouched.
 *
 * @version v1.2.0-beta
 */

import { describe, it, expect } from "vitest";
import { redact } from "../app/components/features/bug-report/redact";

describe("redact", () => {
  it("redacts email addresses to <email>", () => {
    expect(redact("contact us at admin@example.com today")).toBe(
      "contact us at <email> today",
    );
    expect(redact("juan+test@neogranadina.org")).toBe("<email>");
    expect(redact("a.b-c@sub.domain.co")).toBe("<email>");
  });

  it("redacts GitHub personal-access tokens (gh[pousr]_...) to <github-token>", () => {
    const prefixes = ["ghp", "gho", "ghu", "ghs", "ghr"];
    for (const p of prefixes) {
      const input = `token: ${p}_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789`;
      const out = redact(input);
      expect(out).toContain("<github-token>");
      expect(out).not.toContain(`${p}_`);
    }
  });

  it("redacts JWT-shaped strings (eyJ.... .... ....) to <jwt>", () => {
    const input =
      "jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c rest";
    const out = redact(input);
    expect(out).toContain("<jwt>");
    expect(out).not.toContain("eyJ");
  });

  it("redacts Bearer auth headers to 'Bearer <token>'", () => {
    expect(redact("Authorization: Bearer abc.def-ghi_jkl=mn")).toBe(
      "Authorization: Bearer <token>",
    );
  });

  it("applies all four patterns in a single string", () => {
    const input =
      "user me@example.com sent ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 with jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c via Bearer xyz123";
    const out = redact(input);
    expect(out).toContain("<email>");
    expect(out).toContain("<github-token>");
    expect(out).toContain("<jwt>");
    expect(out).toContain("Bearer <token>");
    expect(out).not.toContain("me@example.com");
    expect(out).not.toContain("ghp_");
    expect(out).not.toMatch(/eyJ/);
  });

  it("redacts JWT inside a Bearer header (JWT replaced first, then Bearer)", () => {
    const input =
      "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const out = redact(input);
    expect(out).not.toMatch(/eyJ/);
    expect(out).toContain("Bearer <token>");
  });

  it("leaves project IDs, story slugs, and IIIF URLs untouched", () => {
    const input =
      "/projects/abc-123/stories/xyz-456/edit https://iiif.example.org/manifest.json";
    expect(redact(input)).toBe(input);
  });

  it("is idempotent — redact(redact(x)) === redact(x)", () => {
    const inputs = [
      "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      "contact admin@example.com or use ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
      "/projects/abc/stories/xyz",
    ];
    for (const x of inputs) {
      expect(redact(redact(x))).toBe(redact(x));
    }
  });
});
