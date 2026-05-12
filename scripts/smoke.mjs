#!/usr/bin/env node
// Deploy smoke harness for the Telar Compositor.
//
// Boots `wrangler dev` against a wrangler config (defaults to the build output
// at build/server/wrangler.json so we exercise the same bundle that deploy
// would ship), waits for the listener, hits GET / with a short timeout, and
// asserts the response is non-5xx. Exits non-zero on failure.
//
// Why this exists: v1.0.1-beta deployed with `isomorphic-dompurify` hoisting
// `jsdom` into the worker bundle, throwing `ReferenceError: MessagePort is
// not defined` lazily on the first request that imported the upgrade route
// module. typecheck and vitest passed; only a real wrangler boot against the
// BUILT bundle would have caught it. This harness is that boot, run pre-deploy.
//
// @version v1.2.0-beta

import { spawn } from "node:child_process";
import { argv, exit } from "node:process";

const args = parseArgs(argv.slice(2));
const CONFIG = args.config ?? "build/server/wrangler.json";
const PORT = Number(args.port ?? 8787);
const HOST = "127.0.0.1";
const READY_TIMEOUT_MS = Number(args.readyTimeoutMs ?? 30_000);
const REQUEST_TIMEOUT_MS = Number(args.requestTimeoutMs ?? 10_000);
const URL_PATH = args.path ?? "/";

const log = (level, msg, extra) => {
  const stamp = new Date().toISOString();
  const tag = level.toUpperCase();
  const tail = extra ? " " + JSON.stringify(extra) : "";
  console.error(`[smoke ${stamp}] ${tag} ${msg}${tail}`);
};

let child = null;
let exited = false;
let exitCode = null;

function spawnWrangler() {
  log("info", "spawning wrangler dev", { config: CONFIG, port: PORT });
  const c = spawn(
    "npx",
    ["wrangler", "dev", "--config", CONFIG, "--port", String(PORT), "--ip", HOST],
    { stdio: ["ignore", "pipe", "pipe"], env: process.env },
  );
  c.stdout.on("data", (b) => process.stderr.write("[wrangler:out] " + b));
  c.stderr.on("data", (b) => process.stderr.write("[wrangler:err] " + b));
  c.on("exit", (code, signal) => {
    exited = true;
    exitCode = code;
    log("info", "wrangler exited", { code, signal });
  });
  return c;
}

async function waitReady(deadline) {
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(`wrangler exited before listening (code=${exitCode})`);
    }
    try {
      const r = await fetchWithTimeout(`http://${HOST}:${PORT}${URL_PATH}`, 500);
      log("info", "first response received", { status: r.status });
      return r;
    } catch {
      await sleep(250);
    }
  }
  throw new Error("wrangler did not become ready before timeout");
}

async function fetchWithTimeout(url, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { redirect: "manual", signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = list[i + 1] && !list[i + 1].startsWith("--") ? list[++i] : "true";
      out[k] = v;
    }
  }
  return out;
}

async function shutdown() {
  if (!child || exited) return;
  log("info", "killing wrangler");
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((r) => child.once("exit", r)),
    sleep(5000),
  ]);
  if (!exited) {
    log("warn", "wrangler did not exit on SIGTERM, sending SIGKILL");
    child.kill("SIGKILL");
  }
}

async function main() {
  const startedAt = Date.now();
  child = spawnWrangler();

  let res;
  try {
    res = await waitReady(Date.now() + READY_TIMEOUT_MS);
  } catch (err) {
    log("fail", String(err.message ?? err));
    await shutdown();
    return 2;
  }

  // Re-fetch with the real timeout so we record the steady-state response
  // rather than the first-poll one (which may have raced cold start).
  try {
    res = await fetchWithTimeout(`http://${HOST}:${PORT}${URL_PATH}`, REQUEST_TIMEOUT_MS);
  } catch (err) {
    log("fail", "steady-state fetch failed", { error: String(err.message ?? err) });
    await shutdown();
    return 3;
  }

  const elapsedMs = Date.now() - startedAt;
  log("info", "smoke result", { status: res.status, elapsedMs });

  await shutdown();

  if (res.status >= 500) {
    log("fail", `expected non-5xx, got ${res.status}`);
    return 1;
  }
  log("ok", `worker booted and served ${URL_PATH} with ${res.status} in ${elapsedMs}ms`);
  return 0;
}

main()
  .then((code) => exit(code))
  .catch(async (err) => {
    log("fail", "unexpected error", { error: String(err.stack ?? err) });
    await shutdown();
    exit(99);
  });
