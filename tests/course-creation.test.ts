/**
 * This file pins the creation half of course projects: that the wizard's
 * `kind` choice reaches the `projects` row, and that a course's two config
 * defaults land in D1 at creation.
 *
 * Ruling 23 puts `collection_mode` and `skip_stories` in `project_config`
 * only — they reach `_config.yml` at the next publish — so the assertions
 * are on the D1 insert and on the absence of any repo write. The defaults
 * are written over whatever the repo's `_config.yml` said, because the
 * template a course is created from is an ordinary site template and its
 * config is not the course's answer.
 *
 * `importRepo` is driven with a URL-keyed fetch mock rather than a
 * sequential one: the import issues a different number of GitHub calls
 * depending on what the repo holds, and a sequential mock silently binds
 * the test to that count.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { projects, project_config } from "~/db/schema";

const fixturesDir = resolve(__dirname, "fixtures");

/** Records every table insert so the test can read back what was written. */
function makeDbMock() {
  const inserts: Array<{ table: unknown; values: unknown }> = [];
  const db = {
    inserts,
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        // Awaited whole, as the read of the pages the import inserted is.
        where: vi.fn(() => Object.assign(Promise.resolve([] as unknown[]), {
          limit: vi.fn(async () => [] as unknown[]),
          get: vi.fn(async () => undefined),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        inserts.push({ table, values });
        return {
          returning: vi.fn(async () => [{ id: 77 }]),
          then: (res: (v: unknown) => unknown) => Promise.resolve(undefined).then(res),
        };
      }),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
    delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    batch: vi.fn(async () => []),
  };
  return db;
}

let currentDb: ReturnType<typeof makeDbMock>;

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn(() => currentDb) }));

import { importRepo } from "~/lib/import.server";

const ORIGINAL_FETCH = globalThis.fetch;

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return btoa(Array.from(bytes).map((b) => String.fromCharCode(b)).join(""));
}

/**
 * Answers the GitHub calls the import makes on a repo that holds only a
 * `_config.yml`: the head, the config itself, an empty tree, no spreadsheets
 * directory for the orphan scan, and 404 for every other content path.
 */
function mockGitHub(configYaml: string) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/contents/_config.yml")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: base64(configYaml),
          encoding: "base64",
          size: new TextEncoder().encode(configYaml).length,
        }),
      } as unknown as Response;
    }
    if (url.includes("/git/trees")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ tree: [], truncated: false }),
      } as unknown as Response;
    }
    // The orphan scan's listing: the head resolves and has no spreadsheets directory.
    if (url.endsWith("/graphql") && String(init?.body ?? "").includes("SubtreeOids")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { repository: { c0: { __typename: "Commit" }, c0p0: null } } }),
      } as unknown as Response;
    }
    // The default branch, main, and the head every read is pinned to.
    if (url.endsWith("/graphql")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { repository: { defaultBranchRef: { name: "main", target: { oid: "head-sha" } } } } }),
      } as unknown as Response;
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ message: "Not Found" }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const ENV = { DB: {} as D1Database, ENCRYPTION_KEY: "a".repeat(64) } as unknown as Env;

function insertedValues(table: unknown): Record<string, unknown> | undefined {
  const hit = currentDb.inserts.find((i) => i.table === table);
  return hit?.values as Record<string, unknown> | undefined;
}

/** Every GitHub call the import made that would have written to the repo. */
function writeCalls(): string[] {
  const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
  return calls
    .filter((call: unknown[]) => {
      const init = call[1] as RequestInit | undefined;
      const method = (init?.method ?? "GET").toUpperCase();
      // A GraphQL query is sent as a POST and reads; only a mutation writes.
      if (String(call[0]).endsWith("/graphql")) return /\bmutation\b/.test(String(init?.body ?? ""));
      return method !== "GET";
    })
    .map((call: unknown[]) => String(call[0]));
}

beforeEach(() => {
  vi.clearAllMocks();
  currentDb = makeDbMock();
  mockGitHub(readFileSync(resolve(fixturesDir, "config.yml"), "utf-8"));
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("importRepo — course kind", () => {
  it("writes kind 'course' on the project row and both config defaults", async () => {
    const result = await importRepo({
      token: "t",
      installationId: 1,
      repoFullName: "teacher/hist-101",
      userId: 5,
      env: ENV,
      origin: "created",
      kind: "course",
    });

    expect(result.valid).toBe(true);
    expect(insertedValues(projects)).toMatchObject({ kind: "course" });
    expect(insertedValues(project_config)).toMatchObject({
      collection_mode: true,
      skip_stories: true,
    });
  });

  it("leaves the repo alone — the defaults are a D1 write, not a commit", async () => {
    await importRepo({
      token: "t",
      installationId: 1,
      repoFullName: "teacher/hist-101",
      userId: 5,
      env: ENV,
      origin: "created",
      kind: "course",
    });

    expect(writeCalls()).toEqual([]);
  });

  it("overrides the repo's own collection_mode rather than deferring to it", async () => {
    // The template a course is created from is an ordinary site template, so
    // its config says collection_mode: false. The course's answer wins.
    const yaml = readFileSync(resolve(fixturesDir, "config.yml"), "utf-8");
    mockGitHub(yaml.replace("browse_and_search: true", "browse_and_search: true\n  collection_mode: false"));

    await importRepo({
      token: "t",
      installationId: 1,
      repoFullName: "teacher/hist-101",
      userId: 5,
      env: ENV,
      kind: "course",
    });

    expect(insertedValues(project_config)).toMatchObject({
      collection_mode: true,
      skip_stories: true,
    });
  });
});

describe("importRepo — site kind is unaffected", () => {
  it("defaults to kind 'site' and writes no course config defaults", async () => {
    const result = await importRepo({
      token: "t",
      installationId: 1,
      repoFullName: "student/my-site",
      userId: 5,
      env: ENV,
    });

    expect(result.valid).toBe(true);
    expect(insertedValues(projects)).toMatchObject({ kind: "site" });
    const config = insertedValues(project_config) as Record<string, unknown>;
    expect(config.collection_mode).not.toBe(true);
    expect(config.skip_stories).toBeUndefined();
  });

  it("writes kind 'site' when the caller says so explicitly", async () => {
    await importRepo({
      token: "t",
      installationId: 1,
      repoFullName: "student/my-site",
      userId: 5,
      env: ENV,
      kind: "site",
    });

    expect(insertedValues(projects)).toMatchObject({ kind: "site" });
  });
});
