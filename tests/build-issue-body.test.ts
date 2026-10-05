/**
 * This file pins the `buildIssueBody` helper — the bug-report stage that
 * formats the user's form input plus diagnostic payload into the markdown
 * body that the issue-creation URL carries to GitHub.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect } from "vitest";
import {
  buildIssueBody,
  type Payload,
  type FormInput,
} from "../app/components/features/bug-report/build-issue-body";
import { buildIssueUrl } from "../app/components/features/bug-report/build-issue-url";
import { buildAttachmentItems } from "../app/components/features/bug-report/attachment-items";

const REPOSITORY_LINE =
  "**Repository:** [olympia-m/my-site](https://github.com/olympia-m/my-site)";

const payload: Payload = {
  url: "/projects/abc/stories/xyz/edit",
  buildSha: "1a2b3c4",
  environment: "production",
  browser: "Chrome 142 on macOS 26",
  viewport: "1440 × 900",
  locale: "es",
  timestamp: "2026-05-10T14:32:00.000Z",
  errors: [
    {
      type: "error",
      message:
        "TypeError: Cannot read properties of undefined (reading 'id')",
      stack:
        "  at handleSubmit (story-editor.tsx:142)\n  at onClick (button.tsx:18)",
      timestamp: "2026-05-10T14:31:55.000Z",
      route: "/projects/abc/stories/xyz/edit",
    },
  ],
};

const form: FormInput = {
  whatHappened: "I clicked publish and it crashed.",
  expected: "The story to publish without errors.",
  steps: "1. Open story\n2. Click Publish",
};

describe("buildIssueBody", () => {
  it("renders all three '### What…' headings and 'Environment' table for a default-mode payload", () => {
    const out = buildIssueBody(form, payload, new Set(), "default");
    expect(out).toMatch(/^### What happened\?\n/m);
    expect(out).toContain("### What did you expect?");
    expect(out).toContain("### Steps to reproduce");
    expect(out).toContain("### Environment");
    expect(out).toContain("| URL | `/projects/abc/stories/xyz/edit` |");
    expect(out).toContain("| App version | `1a2b3c4` (production) |");
    expect(out).toContain("### Recent errors");
    expect(out).toMatch(/```[\s\S]*TypeError: Cannot read[\s\S]*```/);
    expect(out).toContain("<sub>Submitted via the in-app bug reporter");
  });

  it("switches the first heading to '### What were you doing when this happened?' when mode === 'post-crash'", () => {
    const out = buildIssueBody(form, payload, new Set(), "post-crash");
    expect(out).toMatch(/^### What were you doing when this happened\?\n/m);
    expect(out).not.toMatch(/^### What happened\?$/m);
  });

  it("omits 'What did you expect?' section entirely when form.expected is empty (no empty header)", () => {
    const out = buildIssueBody(
      { ...form, expected: "" },
      payload,
      new Set(),
      "default",
    );
    expect(out).not.toContain("### What did you expect");
    expect(out).toContain("### Steps to reproduce");
  });

  it("omits 'Steps to reproduce' section entirely when form.steps is empty", () => {
    const out = buildIssueBody(
      { ...form, steps: "" },
      payload,
      new Set(),
      "default",
    );
    expect(out).not.toContain("### Steps to reproduce");
  });

  it("renders fenced code block for stack traces", () => {
    const out = buildIssueBody(form, payload, new Set(), "default");
    expect(out).toMatch(/```[\s\S]*at handleSubmit \(story-editor\.tsx:142\)[\s\S]*```/);
  });

  it("skips environment rows whose key appears in `removed` Set", () => {
    const out = buildIssueBody(form, payload, new Set(["url"]), "default");
    expect(out).not.toContain("/projects/abc/stories/xyz/edit");
    expect(out).toContain("| App version |");
  });

  it("does NOT mutate the payload object: JSON.stringify(payload) is byte-equal before and after the call", () => {
    const before = JSON.stringify(payload);
    buildIssueBody(form, payload, new Set(["url", "errors"]), "default");
    expect(JSON.stringify(payload)).toBe(before);
  });

  it("does NOT include 'Recent errors' header when 'errors' is in `removed` or the array is empty", () => {
    const removed = buildIssueBody(form, payload, new Set(["errors"]), "default");
    expect(removed).not.toContain("### Recent errors");
    expect(removed).not.toContain("TypeError");

    const empty = buildIssueBody(
      form,
      { ...payload, errors: [] },
      new Set(),
      "default",
    );
    expect(empty).not.toContain("### Recent errors");
  });

  it("leaves out each recent error the reporter removed in the panel, keyed as the panel keys them", () => {
    const twoErrors: Payload = {
      ...payload,
      errors: [
        payload.errors[0],
        { ...payload.errors[0], message: "RangeError: private detail", stack: undefined },
      ],
    };
    const panelKeys = buildAttachmentItems(twoErrors, null, (key) => key).map((item) => item.key);
    const secondKey = panelKeys.filter((key) => key.startsWith("error-"))[1];

    const out = buildIssueBody(form, twoErrors, new Set([secondKey]), "default");

    expect(out).toContain("TypeError");
    expect(out).not.toContain("RangeError: private detail");

    const none = buildIssueBody(form, twoErrors, new Set(panelKeys.filter((k) => k.startsWith("error-"))), "default");
    expect(none).not.toContain("### Recent errors");
  });

  it("mentions the maintainer so they are notified, in both modes", () => {
    const dflt = buildIssueBody(form, payload, new Set(), "default");
    const crash = buildIssueBody(form, payload, new Set(), "post-crash");
    expect(dflt).toContain("@juancobo");
    expect(crash).toContain("@juancobo");
  });

  it("opens with the repository, linked, when repoFullName is present", () => {
    const repoPayload = { ...payload, repoFullName: "olympia-m/my-site" };
    const out = buildIssueBody(form, repoPayload, new Set(), "default");
    expect(out.startsWith(REPOSITORY_LINE)).toBe(true);
  });

  it("omits the repository when repoFullName is absent", () => {
    const out = buildIssueBody(form, payload, new Set(), "default");
    expect(out).not.toContain("Repository");
  });

  it("keeps the repository when 'repository' is in `removed`", () => {
    const repoPayload = { ...payload, repoFullName: "olympia-m/my-site" };
    const out = buildIssueBody(form, repoPayload, new Set(["repository"]), "default");
    expect(out).toContain(REPOSITORY_LINE);
    expect(out).toContain("| App version |");
  });

  it("keeps the repository when a long description makes the URL truncate the body", () => {
    const repoPayload = { ...payload, repoFullName: "olympia-m/my-site" };
    const body = buildIssueBody(
      { ...form, whatHappened: "x".repeat(9000) },
      repoPayload,
      new Set(),
      "default",
    );
    const sent = new URL(buildIssueUrl(body)).searchParams.get("body") ?? "";
    expect(sent.endsWith("<!-- body truncated -->")).toBe(true);
    expect(sent).toContain(REPOSITORY_LINE);
  });

  it("ends with the literal '<sub>Submitted via the in-app bug reporter…</sub>' footer in both modes", () => {
    const dflt = buildIssueBody(form, payload, new Set(), "default");
    const crash = buildIssueBody(form, payload, new Set(), "post-crash");
    expect(dflt).toContain("<sub>Submitted via the in-app bug reporter");
    expect(crash).toContain("<sub>Submitted via the in-app bug reporter");
  });
});

describe("buildIssueBody — diagnostics", () => {
  const withRepo: Payload = { ...payload, repoFullName: "olympia-m/my-site" };

  it("writes the current repository name when the payload carries one, and not when removed", () => {
    const renamed = { ...withRepo, githubFullName: "olympia-m/new-site" };
    const out = buildIssueBody(form, renamed, new Set(), "default");
    expect(out).toContain(
      "| Current repository name | [olympia-m/new-site](https://github.com/olympia-m/new-site) |",
    );
    const removed = buildIssueBody(form, renamed, new Set(["githubName"]), "default");
    expect(removed).not.toContain("Current repository name");
    expect(buildIssueBody(form, withRepo, new Set(), "default")).not.toContain(
      "Current repository name",
    );
  });

  it("writes the site's Telar version when present, and not when removed or absent", () => {
    const versioned = { ...withRepo, telarVersion: "1.7.0" };
    expect(buildIssueBody(form, versioned, new Set(), "default")).toContain(
      "| Site's Telar version | `1.7.0` |",
    );
    expect(
      buildIssueBody(form, versioned, new Set(["telarVersion"]), "default"),
    ).not.toContain("Site's Telar version");
    expect(buildIssueBody(form, withRepo, new Set(), "default")).not.toContain(
      "Site's Telar version",
    );
  });

  it("writes the outside-changes row only when the head diverged, and not when removed", () => {
    const diverged = { ...withRepo, headDiverged: true as const };
    expect(buildIssueBody(form, diverged, new Set(), "default")).toContain(
      "| Changes outside the Compositor | The repository has commits the Compositor didn't make |",
    );
    expect(
      buildIssueBody(form, diverged, new Set(["headDiverged"]), "default"),
    ).not.toContain("Changes outside the Compositor");
    expect(buildIssueBody(form, withRepo, new Set(), "default")).not.toContain(
      "Changes outside the Compositor",
    );
  });

  it("writes the last publish error's code and time, and not when removed or absent", () => {
    const failed = {
      ...withRepo,
      lastPublishFailure: { error: "publish_failed", at: "2026-09-26T10:00:00.000Z" },
    };
    const out = buildIssueBody(form, failed, new Set(), "default");
    expect(out).toContain(
      "| Last publish error | `publish_failed` at 2026-09-26T10:00:00.000Z |",
    );
    expect(
      buildIssueBody(form, failed, new Set(["lastPublishError"]), "default"),
    ).not.toContain("Last publish error");
    expect(buildIssueBody(form, withRepo, new Set(), "default")).not.toContain(
      "Last publish error",
    );
  });
});

describe("buildIssueBody — recent changes", () => {
  it("lists the chosen answers in the shown order, in English", () => {
    const out = buildIssueBody(
      { ...form, recentChanges: ["upgraded", "renamed"] },
      payload,
      new Set(),
      "default",
    );
    expect(out).toContain(
      "### Did any of these happen recently?\n- I renamed my repository on GitHub or moved it to another account\n- I upgraded Telar",
    );
  });

  it("omits the section when nothing is chosen", () => {
    expect(
      buildIssueBody({ ...form, recentChanges: [] }, payload, new Set(), "default"),
    ).not.toContain("Did any of these happen recently?");
    expect(buildIssueBody(form, payload, new Set(), "default")).not.toContain(
      "Did any of these happen recently?",
    );
  });
});
