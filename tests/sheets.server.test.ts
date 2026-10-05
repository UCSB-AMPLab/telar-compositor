import { describe, it, expect, vi } from "vitest";
import {
  extractPublishedId,
  discoverSheetTabs,
  fetchSheetCsv,
  PublishedSheetUnreadableError,
  readPublishedTabs,
  stripTrailingSheetRows,
  tabFileName,
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
  const csvAnswer = (body: string | Uint8Array<ArrayBuffer>, status = 200) => vi.fn().mockResolvedValue(new Response(body, { status }));

  it("constructs correct URL with publishedId and gid", async () => {
    globalThis.fetch = csvAnswer("id,title\npainting-001,The Garden");

    await fetchSheetCsv("2PACX-test123", "9876543210");

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe(
      "https://docs.google.com/spreadsheets/d/e/2PACX-test123/pub?gid=9876543210&single=true&output=csv"
    );
  });

  it("detects HTML response (<!DOCTYPE) as access error and throws", async () => {
    globalThis.fetch = csvAnswer("<!DOCTYPE html><html><head><title>Sign in</title>");

    await expect(fetchSheetCsv("TEST", "0")).rejects.toThrow();
  });

  it("detects <html response as access error and throws", async () => {
    globalThis.fetch = csvAnswer("<html><body>Not authorized</body></html>");

    await expect(fetchSheetCsv("TEST", "0")).rejects.toThrow();
  });

  it("returns CSV text when response is valid", async () => {
    const csvText = "id,title\npainting-001,The Garden\n";
    globalThis.fetch = csvAnswer(csvText);

    const result = await fetchSheetCsv("2PACX-test", "123");
    expect(result).toBe(csvText);
  });

  it("throws on an answer other than 2xx, whatever its body", async () => {
    globalThis.fetch = csvAnswer("id,title\n", 500);
    await expect(fetchSheetCsv("TEST", "0")).rejects.toThrow(/500/);
  });

  it("throws on bytes that are not UTF-8, as the build's strict decode does", async () => {
    globalThis.fetch = csvAnswer(new Uint8Array([0x69, 0x64, 0x0a, 0xff, 0xfe, 0x0a]));
    await expect(fetchSheetCsv("TEST", "0")).rejects.toThrow();
  });

  it("keeps a byte-order mark, as the build's decode keeps it", async () => {
    globalThis.fetch = csvAnswer(new Uint8Array([0xef, 0xbb, 0xbf, 0x69, 0x64, 0x0a]));
    expect(await fetchSheetCsv("TEST", "0")).toBe("﻿id\n");
  });

  it("reads text that only starts with HTML after whitespace as CSV, as the build's untrimmed check does", async () => {
    globalThis.fetch = csvAnswer(" <html>,x\n");
    expect(await fetchSheetCsv("TEST", "0")).toBe(" <html>,x\n");
  });
});

describe("stripTrailingSheetRows", () => {
  it("strips trailing empty rows and rows of unchecked checkboxes, as fetch_google_sheets.py does", () => {
    expect(stripTrailingSheetRows("step,done\n1,TRUE\n,FALSE\nFALSE, FALSE\n,\n")).toBe("step,done\n1,TRUE\n");
  });

  it("keeps a last row that ends in a quoted \"FALSE\", since the build splits on commas without reading quotes", () => {
    expect(stripTrailingSheetRows('step,done\n1,x\n,"FALSE"\n,\n')).toBe('step,done\n1,x\n,"FALSE"\n');
  });

  it("keeps CRLF on the rows it keeps and leaves the last with a bare LF, as the build's join does", () => {
    expect(stripTrailingSheetRows("step,done\r\n1,x\r\n,FALSE\r\n")).toBe("step,done\r\n1,x\r\n");
  });

  it("stops at the first row from the end that holds a value, keeping blank rows above it", () => {
    expect(stripTrailingSheetRows("a,b\n,\n1,2")).toBe("a,b\n,\n1,2\n");
  });

  it("answers a lone newline for a tab with nothing but blank rows", () => {
    expect(stripTrailingSheetRows(",\nFALSE\n")).toBe("\n");
  });
});

describe("tabFileName", () => {
  it("names a tab as the build names its file, Python's lowercase included", () => {
    expect(tabFileName("Objetos")).toBe("objetos.csv");
    expect(tabFileName("My-Story")).toBe("my-story.csv");
    expect(tabFileName("PROJECT")).toBe("project.csv");
  });

  it("answers null for the tabs the build does not fetch", () => {
    expect(tabFileName("#notes")).toBeNull();
    expect(tabFileName("README")).toBeNull();
    expect(tabFileName("instrucciones")).toBeNull();
  });
});

describe("readPublishedTabs", () => {
  const PUB_URL = "https://docs.google.com/spreadsheets/d/e/PUB/pubhtml";
  const tabsPage = (tabs: Array<[string, string]>) =>
    `<script>${tabs.map(([name, gid]) => `items.push({name: "${name}", gid: "${gid}"});`).join("")}</script>`;

  function servePublishedSheet(html: string | null, tabs: Record<string, Response | string>) {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url === PUB_URL) return html === null ? new Response("", { status: 500 }) : new Response(html);
      const gid = new URL(url).searchParams.get("gid") as string;
      const body = tabs[gid];
      return body instanceof Response ? body : new Response(body);
    }) as never;
  }

  it("reads every tab the build fetches, with its file and its text stripped of trailing rows", async () => {
    servePublishedSheet(tabsPage([["Project", "1"], ["#notes", "2"], ["my-story", "3"]]), { "1": "order,story_id\n1,my-story\n,\n", "3": "step,answer\n1,Here.\n" });
    expect(await readPublishedTabs(PUB_URL)).toEqual([
      { name: "Project", gid: "1", file: "project.csv", text: "order,story_id\n1,my-story\n" },
      { name: "my-story", gid: "3", file: "my-story.csv", text: "step,answer\n1,Here.\n" },
    ]);
  });

  it("fails naming the tab when one cannot be read", async () => {
    servePublishedSheet(tabsPage([["project", "1"], ["my-story", "3"]]), { "1": "a\n", "3": new Response("", { status: 500 }) });
    await expect(readPublishedTabs(PUB_URL)).rejects.toMatchObject({ name: "PublishedSheetUnreadableError", tab: "my-story" });
  });

  it("fails as the whole sheet, naming no tab, when it lists no tab the build fetches", async () => {
    servePublishedSheet(tabsPage([["#notes", "2"]]), {});
    await expect(readPublishedTabs(PUB_URL)).rejects.toMatchObject({ name: "PublishedSheetUnreadableError", tab: null });
    servePublishedSheet("<html></html>", {});
    await expect(readPublishedTabs(PUB_URL)).rejects.toMatchObject({ name: "PublishedSheetUnreadableError", tab: null });
  });

  it("fails as the whole sheet when its tabs cannot be listed, or its URL holds no published id", async () => {
    servePublishedSheet(null, {});
    await expect(readPublishedTabs(PUB_URL)).rejects.toMatchObject({ name: "PublishedSheetUnreadableError", tab: null });
    await expect(readPublishedTabs("https://docs.google.com/spreadsheets/d/abc/edit")).rejects.toBeInstanceOf(PublishedSheetUnreadableError);
  });
});
