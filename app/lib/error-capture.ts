/**
 * This file holds the small in-memory buffer the bug-report panel reads
 * when it needs to show the user what recent runtime errors the app saw.
 *
 * Listeners attach once at startup from `app/entry.client.tsx`, and the
 * buffer keeps the five most recent errors — newest first — so the user
 * can see them, opt out of any of them, and submit the rest with the
 * report. Storage is in-module memory only, never localStorage; multiple
 * users on the same device should not see each other's captured errors.
 *
 * The ring buffer is intentionally tiny because the bug-report flow is
 * for the immediate "something just broke" case, not for long-term error
 * archival — anything more durable belongs in a separate observability
 * layer.
 *
 * Browser-only — do not rename to `.server.ts`. The SSR import boundary
 * check would block this file from loading on the client, which is where
 * it actually does its work.
 *
 * @version v1.2.0-beta
 */

import { redact } from "~/components/features/bug-report/redact";

export type CapturedError = {
  type: "error" | "unhandledrejection" | "boundary";
  message: string; // already redacted
  stack?: string; // already redacted, ≤30 lines
  timestamp: string; // ISO 8601
  route?: string;
};

const CAPACITY = 5;
const STACK_MAX_LINES = 30;

let buffer: CapturedError[] = [];
let attached = false;

function toMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e == null) return "(no message)";
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function toStack(e: unknown): string | undefined {
  if (e instanceof Error && typeof e.stack === "string") {
    return e.stack.split("\n").slice(0, STACK_MAX_LINES).join("\n");
  }
  return undefined;
}

function currentRoute(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.location.pathname + window.location.search;
}

export function recordError(e: unknown, type: CapturedError["type"]): void {
  const message = redact(toMessage(e));
  const rawStack = toStack(e);
  const stack = rawStack ? redact(rawStack) : undefined;
  const entry: CapturedError = {
    type,
    message,
    stack,
    timestamp: new Date().toISOString(),
    route: currentRoute(),
  };
  buffer.unshift(entry);
  if (buffer.length > CAPACITY) buffer.length = CAPACITY;
}

export function getRecentErrors(): readonly CapturedError[] {
  return buffer;
}

export function clearErrors(): void {
  buffer = [];
}

export function attachListeners(): void {
  if (attached) return;
  if (typeof window === "undefined") return;
  attached = true;
  window.addEventListener("error", (ev) => {
    recordError(ev.error ?? ev.message, "error");
  });
  window.addEventListener("unhandledrejection", (ev) => {
    recordError(ev.reason, "unhandledrejection");
  });
}

/** Test-only: reset module state. Do NOT call from production code. */
export function __resetForTests(): void {
  buffer = [];
  attached = false;
}
