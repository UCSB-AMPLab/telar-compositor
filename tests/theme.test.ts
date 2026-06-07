import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const CSS_PATH = resolve(__dirname, "../app/styles/app.css");

describe("app.css Tailwind theme tokens", () => {
  let css: string;

  // Read the file once
  try {
    css = readFileSync(CSS_PATH, "utf-8");
  } catch {
    css = "";
  }

  it("file exists and is non-empty", () => {
    expect(css.length).toBeGreaterThan(0);
  });

  it("contains @theme block", () => {
    expect(css).toContain("@theme");
  });

  it("contains --color-terracotta: #883C36", () => {
    expect(css).toMatch(/--color-terracotta:\s+#883C36/);
  });

  it("contains --color-anil: #C6D0F8 (renamed from --color-lavender, same hex)", () => {
    expect(css).toMatch(/--color-anil:\s+#C6D0F8/);
  });

  it("contains --color-cream: #FFF6EF", () => {
    expect(css).toMatch(/--color-cream:\s+#FFF6EF/);
  });

  it('contains --font-heading: "Space Grotesk"', () => {
    expect(css).toContain('"Space Grotesk"');
  });

  it('contains --font-body: "Roboto Condensed"', () => {
    expect(css).toContain('"Roboto Condensed"');
  });

  it("contains @layer base with font-family for body", () => {
    expect(css).toContain("@layer base");
    expect(css).toContain("font-family");
  });
});
