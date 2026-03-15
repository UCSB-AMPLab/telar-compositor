import { describe, it, expect, vi } from "vitest";
import {
  extractPublishedId,
  discoverSheetTabs,
  fetchSheetCsv,
} from "~/lib/sheets.server";

describe("extractPublishedId", () => {
  it("extracts ID from /d/e/{id}/pubhtml URL", () => {
    const url =
      "https://docs.google.com/spreadsheets/d/e/2PACX-1vAbCdEfGhIjKlMnOpQrStUvWxYz/pubhtml";
    expect(extractPublishedId(url)).toBe("2PACX-1vAbCdEfGhIjKlMnOpQrStUvWxYz");
  });

  it("returns null for non-published URLs (shared links without /d/e/ prefix)", () => {
    const sharedUrl =
      "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms/edit";
    expect(extractPublishedId(sharedUrl)).toBeNull();
  });

  it("handles IDs with hyphens and underscores", () => {
    const url =
      "https://docs.google.com/spreadsheets/d/e/2PACX-abc_def-123/pubhtml";
    expect(extractPublishedId(url)).toBe("2PACX-abc_def-123");
  });
});

describe("discoverSheetTabs", () => {
  it("parses items.push({name: ..., gid: ...}) from HTML", async () => {
    const html = `
      <html>
      <script>
      items.push({name: "objects", gid: "1234567890"});
      items.push({name: "project", gid: "9876543210"});
      items.push({name: "glossary", gid: "1122334455"});
      </script>
      </html>
    `;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => html,
    });

    const tabs = await discoverSheetTabs("https://docs.google.com/spreadsheets/d/e/TEST/pubhtml");
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toEqual({ name: "objects", gid: "1234567890" });
    expect(tabs[1]).toEqual({ name: "project", gid: "9876543210" });
  });

  it("skips instruction tabs (instructions, instrucciones, readme, help, info)", async () => {
    const html = `
      <html>
      <script>
      items.push({name: "Instructions", gid: "0"});
      items.push({name: "instrucciones", gid: "1"});
      items.push({name: "README", gid: "2"});
      items.push({name: "help", gid: "3"});
      items.push({name: "info", gid: "4"});
      items.push({name: "objects", gid: "5555"});
      </script>
      </html>
    `;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => html,
    });

    const tabs = await discoverSheetTabs("https://docs.google.com/spreadsheets/d/e/TEST/pubhtml");
    expect(tabs).toHaveLength(1);
    expect(tabs[0].name).toBe("objects");
  });
});

describe("fetchSheetCsv", () => {
  it("constructs correct URL with publishedId and gid", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "id,title\npainting-001,The Garden",
    });

    await fetchSheetCsv("2PACX-test123", "9876543210");

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe(
      "https://docs.google.com/spreadsheets/d/e/2PACX-test123/pub?gid=9876543210&single=true&output=csv"
    );
  });

  it("detects HTML response (<!DOCTYPE) as access error and throws", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "<!DOCTYPE html><html><head><title>Sign in</title>",
    });

    await expect(fetchSheetCsv("TEST", "0")).rejects.toThrow();
  });

  it("detects <html response as access error and throws", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "<html><body>Not authorized</body></html>",
    });

    await expect(fetchSheetCsv("TEST", "0")).rejects.toThrow();
  });

  it("returns CSV text when response is valid", async () => {
    const csvText = "id,title\npainting-001,The Garden\n";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => csvText,
    });

    const result = await fetchSheetCsv("2PACX-test", "123");
    expect(result).toBe(csvText);
  });
});
