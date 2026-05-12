/**
 * This file pins the `buildIssueBody` helper — the bug-report stage that
 * formats the user's form input plus diagnostic payload into the markdown
 * body that the issue-creation URL carries to GitHub.
 *
 * @version v1.2.0-beta
 */
import { describe, it, expect } from "vitest";
import {
  buildIssueBody,
  type Payload,
  type FormInput,
} from "../app/components/features/bug-report/build-issue-body";

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

  it("ends with the literal '<sub>Submitted via the in-app bug reporter…</sub>' footer in both modes", () => {
    const dflt = buildIssueBody(form, payload, new Set(), "default");
    const crash = buildIssueBody(form, payload, new Set(), "post-crash");
    expect(dflt).toContain("<sub>Submitted via the in-app bug reporter");
    expect(crash).toContain("<sub>Submitted via the in-app bug reporter");
  });
});
