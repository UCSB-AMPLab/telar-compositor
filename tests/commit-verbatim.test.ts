/**
 * A file marked `verbatim` is committed as it is, without the text cleaning
 * every other text file gets: the upgrade writes a repaired sheet as the
 * framework's 1.8.0 migration writes it, the edited text and nothing else.
 *
 * @version v1.5.0-beta
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { commitFilesToRepo } from "~/lib/commit.server";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const TEXT = "﻿step,answer\r\n1,\"a\u000bb\u0001\"\r\n";

async function verbatimCommitted(file: { path: string; content: string; verbatim?: true }): Promise<string> {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { createCommitOnBranch: { commit: { oid: "new", url: "u" } } } }),
  }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  await commitFilesToRepo("t", "o", "r", "main", [file], "m", undefined, [], undefined, "head");
  const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as {
    variables: { input: { fileChanges: { additions: { contents: string }[] } } };
  };
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(
    Buffer.from(body.variables.input.fileChanges.additions[0].contents, "base64"),
  );
}

describe("commitFilesToRepo", () => {
  it("commits a verbatim file's text byte for byte", async () => {
    expect(await verbatimCommitted({ path: "telar-content/spreadsheets/s.csv", content: TEXT, verbatim: true })).toBe(TEXT);
  });

  it("still cleans the same text when it is not marked verbatim", async () => {
    expect(await verbatimCommitted({ path: "telar-content/spreadsheets/s.csv", content: TEXT })).toBe(
      "﻿step,answer\r\n1,\"a b\"\r\n",
    );
  });
});
