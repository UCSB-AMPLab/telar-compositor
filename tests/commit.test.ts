import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  commitFilesToRepo,
  disableGoogleSheetsInConfig,
  isGoogleSheetsEnabled,
  getJobSteps,
  mapStepsToBuildPhases,
  listWorkflowRunsBySha,
  verifySiteUrl,
  enableGitHubPages,
  StaleHeadError,
  BUILD_PHASES,
} from "~/lib/commit.server";
import { graphqlGitHub, githubHeaders } from "~/lib/github.server";

const TOKEN = "test-token-xyz";
const OWNER = "testuser";
const REPO = "my-telar-site";
const BRANCH = "main";

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

function makeRestFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

function makeGraphqlFetch(responses: unknown[]) {
  let call = 0;
  return vi.fn().mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => responses[call++],
  }));
}

// ---------------------------------------------------------------------------
// graphqlGitHub tests
// ---------------------------------------------------------------------------

describe("graphqlGitHub", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("Test 1: sends POST to https://api.github.com/graphql with Authorization header and body", async () => {
    globalThis.fetch = makeRestFetch({ data: { result: "ok" } });

    await graphqlGitHub(TOKEN, "query { viewer { login } }", { foo: "bar" });

    const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/graphql");
    expect(opts.method).toBe("POST");
    const headers = opts.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(opts.body as string);
    expect(body.query).toBe("query { viewer { login } }");
    expect(body.variables).toEqual({ foo: "bar" });
  });

  it("Test 2: throws on non-OK response with status code in error message", async () => {
    globalThis.fetch = makeRestFetch({}, 401);

    await expect(
      graphqlGitHub(TOKEN, "query { viewer { login } }", {})
    ).rejects.toThrow("401");
  });

  it("Test 3: throws on GraphQL errors array in response body", async () => {
    globalThis.fetch = makeRestFetch({
      data: null,
      errors: [{ message: "Field 'foo' doesn't exist on type 'Query'" }],
    });

    await expect(
      graphqlGitHub(TOKEN, "query { foo }", {})
    ).rejects.toThrow("Field 'foo' doesn't exist");
  });
});

// ---------------------------------------------------------------------------
// githubHeaders tests (exported now)
// ---------------------------------------------------------------------------

describe("githubHeaders", () => {
  it("returns headers with Authorization Bearer and X-GitHub-Api-Version", () => {
    const headers = githubHeaders(TOKEN);
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });
});

// ---------------------------------------------------------------------------
// commitFilesToRepo tests
// ---------------------------------------------------------------------------

const HEAD_OID_RESPONSE = {
  data: {
    repository: {
      ref: {
        target: { oid: "abc123deadbeef" },
      },
    },
  },
};

const COMMIT_RESPONSE = {
  data: {
    createCommitOnBranch: {
      commit: {
        oid: "def456newsha",
        url: "https://github.com/testuser/my-site/commit/def456",
      },
    },
  },
};

describe("commitFilesToRepo", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("Test 4: calls graphqlGitHub twice — first for HEAD OID, then for createCommitOnBranch", async () => {
    globalThis.fetch = makeGraphqlFetch([HEAD_OID_RESPONSE, COMMIT_RESPONSE]);

    await commitFilesToRepo(TOKEN, OWNER, REPO, BRANCH, [
      { path: "objects.csv", content: "object_id\nobj-001" },
    ], "chore: update objects");

    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    const firstBody = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    const secondBody = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body);
    expect(firstBody.query).toContain("GetHeadOid");
    expect(secondBody.query).toContain("CreateCommit");
  });

  it("Test 5: mutation input includes base64-encoded contents, file paths, and HEAD OID", async () => {
    globalThis.fetch = makeGraphqlFetch([HEAD_OID_RESPONSE, COMMIT_RESPONSE]);

    const content = "object_id\nobj-001";
    await commitFilesToRepo(TOKEN, OWNER, REPO, BRANCH, [
      { path: "telar-content/spreadsheets/objects.csv", content },
    ], "chore: update");

    const secondCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[1][1];
    const body = JSON.parse(secondCall.body);
    const input = body.variables.input;

    expect(input.expectedHeadOid).toBe("abc123deadbeef");
    expect(input.fileChanges.additions).toHaveLength(1);
    expect(input.fileChanges.additions[0].path).toBe("telar-content/spreadsheets/objects.csv");
    // Verify base64 encoding
    const decoded = atob(input.fileChanges.additions[0].contents);
    expect(decoded).toContain("object_id");
  });

  it("Test 6: returns { newHeadSha } from mutation response commit.oid", async () => {
    globalThis.fetch = makeGraphqlFetch([HEAD_OID_RESPONSE, COMMIT_RESPONSE]);

    const result = await commitFilesToRepo(TOKEN, OWNER, REPO, BRANCH, [
      { path: "objects.csv", content: "test" },
    ], "test commit");

    expect(result.newHeadSha).toBe("def456newsha");
  });

  it("Test 7: Spanish characters produce valid base64 (no btoa error)", async () => {
    globalThis.fetch = makeGraphqlFetch([HEAD_OID_RESPONSE, COMMIT_RESPONSE]);

    const spanishContent = "object_id,title\nobj-001,Ánfora de terracota con decoración en añil";

    await expect(
      commitFilesToRepo(TOKEN, OWNER, REPO, BRANCH, [
        { path: "objects.csv", content: spanishContent },
      ], "chore: add Spanish object")
    ).resolves.toBeDefined();

    // Verify the base64 round-trips correctly
    const secondCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[1][1];
    const body = JSON.parse(secondCall.body);
    const base64Contents = body.variables.input.fileChanges.additions[0].contents;
    // Decode using the same UTF-8 pattern
    const decoded = decodeURIComponent(escape(atob(base64Contents)));
    expect(decoded).toContain("Ánfora");
    expect(decoded).toContain("añil");
  });

  it("Test 8: propagates GraphQL error with 'Expected HEAD' message as StaleHeadError", async () => {
    const staleResponse = {
      data: null,
      errors: [{ message: "Expected HEAD of main to be abc123 but got xyz789" }],
    };

    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      const responses = [HEAD_OID_RESPONSE, staleResponse];
      return {
        ok: true,
        status: 200,
        json: async () => responses[call++],
      };
    });

    await expect(
      commitFilesToRepo(TOKEN, OWNER, REPO, BRANCH, [
        { path: "objects.csv", content: "test" },
      ], "stale commit")
    ).rejects.toBeInstanceOf(StaleHeadError);
  });

  it("Test 9a: mutation input includes fileChanges.deletions when deletions parameter is provided", async () => {
    globalThis.fetch = makeGraphqlFetch([HEAD_OID_RESPONSE, COMMIT_RESPONSE]);

    await commitFilesToRepo(
      TOKEN, OWNER, REPO, BRANCH,
      [{ path: "objects.csv", content: "object_id\nobj-001" }],
      "upgrade: remove deprecated layout",
      undefined,
      ["_layouts/deprecated.html", "_includes/old-nav.html"],
    );

    const secondBody = JSON.parse(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body
    );
    const fileChanges = secondBody.variables.input.fileChanges;
    expect(fileChanges.deletions).toBeDefined();
    expect(fileChanges.deletions).toHaveLength(2);
    expect(fileChanges.deletions[0]).toEqual({ path: "_layouts/deprecated.html" });
    expect(fileChanges.deletions[1]).toEqual({ path: "_includes/old-nav.html" });
  });

  it("Test 9b: mutation input omits fileChanges.deletions when deletions parameter is undefined", async () => {
    globalThis.fetch = makeGraphqlFetch([HEAD_OID_RESPONSE, COMMIT_RESPONSE]);

    await commitFilesToRepo(
      TOKEN, OWNER, REPO, BRANCH,
      [{ path: "objects.csv", content: "object_id\nobj-001" }],
      "chore: update objects",
    );

    const secondBody = JSON.parse(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body
    );
    const fileChanges = secondBody.variables.input.fileChanges;
    expect(fileChanges.deletions).toBeUndefined();
  });

  it("Test 9: supports multiple files in a single commit (2 files in additions array)", async () => {
    globalThis.fetch = makeGraphqlFetch([HEAD_OID_RESPONSE, COMMIT_RESPONSE]);

    await commitFilesToRepo(TOKEN, OWNER, REPO, BRANCH, [
      { path: "objects.csv", content: "object_id\nobj-001" },
      { path: "_config.yml", content: "google_sheets:\n  enabled: false" },
    ], "chore: update objects and config");

    const secondBody = JSON.parse(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body
    );
    const additions = secondBody.variables.input.fileChanges.additions;
    expect(additions).toHaveLength(2);
    expect(additions.map((a: { path: string }) => a.path)).toEqual([
      "objects.csv",
      "_config.yml",
    ]);
  });
});

// ---------------------------------------------------------------------------
// disableGoogleSheetsInConfig tests
// ---------------------------------------------------------------------------

const CONFIG_ENABLED = `
title: My Telar Site
google_sheets:
  enabled: true
  published_url: "https://docs.google.com/spreadsheets/d/abc123"
`.trim();

const CONFIG_DISABLED = `
title: My Telar Site
google_sheets:
  enabled: false
  published_url: "https://docs.google.com/spreadsheets/d/abc123"
`.trim();

describe("disableGoogleSheetsInConfig", () => {
  it("Test 10: changes 'enabled: true' to 'enabled: false' under google_sheets", () => {
    const result = disableGoogleSheetsInConfig(CONFIG_ENABLED);
    expect(result).toContain("enabled: false");
    expect(result).not.toContain("enabled: true");
  });

  it("Test 11: preserves all other _config.yml content (comments, other keys, published_url)", () => {
    const configWithComments = `
# Site config
title: My Telar Site
google_sheets:
  # Google Sheets integration
  enabled: true
  published_url: "https://docs.google.com/spreadsheets/d/abc123"
# End config
`.trim();

    const result = disableGoogleSheetsInConfig(configWithComments);
    expect(result).toContain("# Site config");
    expect(result).toContain("title: My Telar Site");
    expect(result).toContain("# Google Sheets integration");
    expect(result).toContain('published_url: "https://docs.google.com/spreadsheets/d/abc123"');
    expect(result).toContain("# End config");
    expect(result).toContain("enabled: false");
  });

  it("Test 12: is idempotent — running on already-disabled config returns unchanged content", () => {
    const result = disableGoogleSheetsInConfig(CONFIG_DISABLED);
    expect(result).toBe(CONFIG_DISABLED);
  });

  it("Test 13: isGoogleSheetsEnabled returns true when config has google_sheets with enabled: true", () => {
    expect(isGoogleSheetsEnabled(CONFIG_ENABLED)).toBe(true);
  });

  it("Test 14: isGoogleSheetsEnabled returns false when config has enabled: false or no google_sheets block", () => {
    expect(isGoogleSheetsEnabled(CONFIG_DISABLED)).toBe(false);
    expect(isGoogleSheetsEnabled("title: My Site\nbaseurl: /my-site")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listWorkflowRunsBySha tests
// ---------------------------------------------------------------------------

const WORKFLOW_RUNS_RESPONSE = {
  workflow_runs: [
    {
      id: 12345,
      status: "completed",
      conclusion: "success",
      html_url: "https://github.com/testuser/my-site/actions/runs/12345",
    },
    {
      id: 12344,
      status: "completed",
      conclusion: "success",
      html_url: "https://github.com/testuser/my-site/actions/runs/12344",
    },
  ],
};

describe("listWorkflowRunsBySha", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("Test 15: sends GET to correct URL with head_sha query param", async () => {
    const sha = "abc123def456";
    globalThis.fetch = makeRestFetch(WORKFLOW_RUNS_RESPONSE);

    await listWorkflowRunsBySha(TOKEN, OWNER, REPO, sha);

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe(
      `https://api.github.com/repos/${OWNER}/${REPO}/actions/runs?head_sha=${sha}`
    );
  });

  it("Test 16: returns mapped array of { id, status, conclusion, html_url }", async () => {
    globalThis.fetch = makeRestFetch(WORKFLOW_RUNS_RESPONSE);

    const result = await listWorkflowRunsBySha(TOKEN, OWNER, REPO, "abc123");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: 12345,
      status: "completed",
      conclusion: "success",
      html_url: "https://github.com/testuser/my-site/actions/runs/12345",
    });
  });

  it("Test 17: returns empty array for 0 workflow_runs", async () => {
    globalThis.fetch = makeRestFetch({ workflow_runs: [] });

    const result = await listWorkflowRunsBySha(TOKEN, OWNER, REPO, "abc123");
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getJobSteps tests
// ---------------------------------------------------------------------------

const JOB_STEPS = [
  { name: "Checkout repository", status: "completed", conclusion: "success" },
  { name: "Set up Ruby", status: "completed", conclusion: "success" },
  { name: "Build JavaScript bundle", status: "in_progress", conclusion: null },
];

describe("getJobSteps", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("Test 18: sends GET to correct jobs URL and returns steps array from jobs[0].steps", async () => {
    const runId = 99999;
    globalThis.fetch = makeRestFetch({
      jobs: [{ steps: JOB_STEPS }],
    });

    const result = await getJobSteps(TOKEN, OWNER, REPO, runId);

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe(
      `https://api.github.com/repos/${OWNER}/${REPO}/actions/runs/${runId}/jobs`
    );
    expect(result).toHaveLength(3);
    expect(result[0].name).toBe("Checkout repository");
  });
});

// ---------------------------------------------------------------------------
// mapStepsToBuildPhases tests
// ---------------------------------------------------------------------------

describe("mapStepsToBuildPhases", () => {
  it("Test 19: maps workflow step names to correct phases", () => {
    const steps = [
      { name: "Checkout repository", status: "completed", conclusion: "success" },
      { name: "Build JavaScript bundle", status: "completed", conclusion: "success" },
      { name: "Convert CSV to JSON", status: "in_progress", conclusion: null },
      { name: "Build Jekyll site", status: "queued", conclusion: null },
      { name: "Restore IIIF tiles from cache", status: "queued", conclusion: null },
      { name: "Deploy to GitHub Pages", status: "queued", conclusion: null },
    ];

    const phases = mapStepsToBuildPhases(steps);
    const phaseMap = Object.fromEntries(phases.map((p) => [p.id, p]));

    expect(phaseMap["setup"].status).toBe("completed");
    expect(phaseMap["build-js"].status).toBe("completed");
    expect(phaseMap["process-data"].status).toBe("in_progress");
    expect(phaseMap["build-site"].status).toBe("queued");
    expect(phaseMap["iiif"].status).toBe("queued");
    expect(phaseMap["deploy"].status).toBe("queued");
  });

  it("Test 20: skips the 'Fetch data from Google Sheets (if enabled)' step entirely", () => {
    const steps = [
      { name: "Checkout repository", status: "completed", conclusion: "success" },
      { name: "Fetch data from Google Sheets (if enabled)", status: "skipped", conclusion: "skipped" },
      { name: "Convert CSV to JSON", status: "completed", conclusion: "success" },
    ];

    const phases = mapStepsToBuildPhases(steps);
    // Google Sheets step should not affect any phase
    const phaseMap = Object.fromEntries(phases.map((p) => [p.id, p]));
    expect(phaseMap["process-data"].status).toBe("completed");
    expect(phaseMap["process-data"].conclusion).toBe("success");
  });

  it("Test 21: aggregates phase status: completed when all steps completed, in_progress when any step in_progress, queued otherwise", () => {
    const steps = [
      { name: "Set up Ruby", status: "completed", conclusion: "success" },
      { name: "Set up Python", status: "in_progress", conclusion: null },
      { name: "Set up Node.js", status: "queued", conclusion: null },
    ];

    const phases = mapStepsToBuildPhases(steps);
    const setup = phases.find((p) => p.id === "setup")!;
    // One step is in_progress → phase is in_progress
    expect(setup.status).toBe("in_progress");
  });

  it("Test 22: sets phase conclusion to 'failure' if any step in the phase failed", () => {
    const steps = [
      { name: "Checkout repository", status: "completed", conclusion: "success" },
      { name: "Set up Ruby", status: "completed", conclusion: "failure" },
    ];

    const phases = mapStepsToBuildPhases(steps);
    const setup = phases.find((p) => p.id === "setup")!;
    expect(setup.conclusion).toBe("failure");
  });

  it("Test 23: BUILD_PHASES array has exactly 6 entries: setup, build-js, process-data, build-site, iiif, deploy", () => {
    expect(BUILD_PHASES).toHaveLength(6);
    expect(BUILD_PHASES.map((p) => p.id)).toEqual([
      "setup",
      "build-js",
      "process-data",
      "build-site",
      "iiif",
      "deploy",
    ]);
  });
});

// ---------------------------------------------------------------------------
// verifySiteUrl tests
// ---------------------------------------------------------------------------

const CONFIG_WITH_URL = `
url: "https://testuser.github.io"
baseurl: "/my-telar-site"
title: My Site
`.trim();

const CONFIG_URL_ONLY = `
url: "https://testuser.github.io"
baseurl: ""
title: My Site
`.trim();

describe("verifySiteUrl", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns pagesEnabled: false and match: false when GitHub Pages API returns non-OK", async () => {
    globalThis.fetch = makeRestFetch({}, 404);

    const result = await verifySiteUrl(TOKEN, OWNER, REPO, CONFIG_WITH_URL);

    expect(result.pagesEnabled).toBe(false);
    expect(result.match).toBe(false);
    expect(result.pagesUrl).toBe("");
    expect(result.configUrl).toBe("https://testuser.github.io/my-telar-site");
  });

  it("returns match: true when config url+baseurl equals the GitHub Pages html_url", async () => {
    globalThis.fetch = makeRestFetch({
      html_url: "https://testuser.github.io/my-telar-site",
      https_enforced: true,
    });

    const result = await verifySiteUrl(TOKEN, OWNER, REPO, CONFIG_WITH_URL);

    expect(result.pagesEnabled).toBe(true);
    expect(result.match).toBe(true);
    expect(result.pagesUrl).toBe("https://testuser.github.io/my-telar-site");
  });

  it("returns match: false when config url+baseurl differs from GitHub Pages html_url", async () => {
    globalThis.fetch = makeRestFetch({
      html_url: "https://testuser.github.io/different-repo",
      https_enforced: true,
    });

    const result = await verifySiteUrl(TOKEN, OWNER, REPO, CONFIG_WITH_URL);

    expect(result.pagesEnabled).toBe(true);
    expect(result.match).toBe(false);
  });

  it("normalises http:// Pages URL to https:// before comparing", async () => {
    globalThis.fetch = makeRestFetch({
      html_url: "http://testuser.github.io/my-telar-site",
      https_enforced: true,
    });

    const result = await verifySiteUrl(TOKEN, OWNER, REPO, CONFIG_WITH_URL);

    expect(result.pagesUrl).toBe("https://testuser.github.io/my-telar-site");
    expect(result.match).toBe(true);
  });

  it("strips trailing slash from the full Pages URL before comparing", async () => {
    // The implementation strips a trailing slash from the end of the Pages URL
    // and configUrl (after concatenation) but does not normalise intermediate
    // slashes from url+baseurl concatenation. This test verifies the end-of-string
    // trailing slash is stripped correctly.
    const configNoTrailingInBaseurl = `
url: "https://testuser.github.io"
baseurl: "/my-telar-site"
title: My Site
`.trim();

    globalThis.fetch = makeRestFetch({
      // Pages API returns URL with trailing slash
      html_url: "https://testuser.github.io/my-telar-site/",
      https_enforced: true,
    });

    const result = await verifySiteUrl(TOKEN, OWNER, REPO, configNoTrailingInBaseurl);

    // Pages URL trailing slash is stripped — should match the config value
    expect(result.pagesEnabled).toBe(true);
    expect(result.pagesUrl).toBe("https://testuser.github.io/my-telar-site");
    expect(result.match).toBe(true);
  });

  it("sends request to correct GitHub Pages API endpoint with auth headers", async () => {
    globalThis.fetch = makeRestFetch({
      html_url: "https://testuser.github.io/my-telar-site",
    });

    await verifySiteUrl(TOKEN, OWNER, REPO, CONFIG_WITH_URL);

    const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.github.com/repos/${OWNER}/${REPO}/pages`);
    const headers = opts.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
  });
});

// ---------------------------------------------------------------------------
// enableGitHubPages tests
// ---------------------------------------------------------------------------

describe("enableGitHubPages", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to /repos/{owner}/{repo}/pages with build_type: workflow", async () => {
    globalThis.fetch = makeRestFetch({
      html_url: "https://testuser.github.io/my-telar-site",
    }, 201);

    await enableGitHubPages(TOKEN, OWNER, REPO);

    const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.github.com/repos/${OWNER}/${REPO}/pages`);
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body as string);
    expect(body.build_type).toBe("workflow");
  });

  it("returns pagesUrl from the API response html_url, normalised to https", async () => {
    globalThis.fetch = makeRestFetch({
      html_url: "http://testuser.github.io/my-telar-site",
    }, 201);

    const result = await enableGitHubPages(TOKEN, OWNER, REPO);

    expect(result.pagesUrl).toBe("https://testuser.github.io/my-telar-site");
  });

  it("throws an error when the API responds with non-OK status", async () => {
    globalThis.fetch = makeRestFetch("Conflict: Pages already enabled", 409);
    // makeRestFetch uses json() but the error path uses text() — mock text too
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: async () => "Conflict: Pages already enabled",
    });

    await expect(enableGitHubPages(TOKEN, OWNER, REPO)).rejects.toThrow("409");
  });

  it("sends Authorization header with the provided token", async () => {
    globalThis.fetch = makeRestFetch({ html_url: "https://testuser.github.io/my-telar-site" }, 201);

    await enableGitHubPages(TOKEN, OWNER, REPO);

    const opts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    const headers = opts.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
  });
});
