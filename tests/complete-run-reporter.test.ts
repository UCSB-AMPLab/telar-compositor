/**
 * The reporter that fails a run when a scheduled test file reports no result
 * or a file matching the include globs is never scheduled.
 *
 * The reporter is driven directly with fake specifications and modules over a
 * temporary directory of real files: a real dropped file cannot be produced
 * on demand by load, and the check's subject is "a missing file fails the
 * run", so the missing-file cases are the ones that matter and the complete
 * case is the control. The two Vitest behaviours it depends on, the shard
 * being applied after the plan is reported and the include glob being
 * re-read from disk, were exercised against a real Vitest run with
 * `--shard=1/2` and with a discovery step that hides a file.
 *
 * @version v1.5.0-beta
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import CompleteRunReporter from "./helpers/complete-run-reporter";

let dir: string;
let a: string;
let b: string;
let c: string;
let hidden: string;
let inHiddenDir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "complete-run-"));
  for (const n of ["a", "b", "c"]) writeFileSync(join(dir, `${n}.test.ts`), "");
  writeFileSync(join(dir, "skip.test.ts"), "");
  mkdirSync(join(dir, ".suite"));
  writeFileSync(join(dir, ".hidden.test.ts"), "");
  writeFileSync(join(dir, ".suite", "d.test.ts"), "");
  [a, b, c] = ["a", "b", "c"].map((n) => join(dir, `${n}.test.ts`));
  hidden = join(dir, ".hidden.test.ts");
  inHiddenDir = join(dir, ".suite", "d.test.ts");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const spec = (id: string, project = "unit") =>
  ({ moduleId: id, project: { name: project } }) as never;
const mod = (id: string, state = "passed", project = "unit") =>
  ({ moduleId: id, project: { name: project }, state: () => state }) as never;

class FakeSequencer {
  // Keeps the first half, standing in for --shard=1/2.
  async shard(files: unknown[]) {
    return files.slice(0, Math.ceil(files.length / 2));
  }
}

function reporter(
  state: {
    filenamePattern?: string[];
    changed?: boolean;
    watch?: boolean;
    shard?: boolean;
  } = {},
) {
  const r = new CompleteRunReporter();
  const { filenamePattern, ...config } = state;
  r.onInit({
    config: { ...config, sequence: { sequencer: FakeSequencer } },
    filenamePattern,
    projects: [
      {
        name: "unit",
        config: {
          dir,
          root: dir,
          include: ["*.test.ts", "**/*.test.ts"],
          exclude: ["skip.test.ts"],
        },
      },
    ],
  } as never);
  return r;
}

const saved = process.exitCode;
afterEach(() => {
  process.exitCode = saved;
  vi.restoreAllMocks();
});

const silent = () => vi.spyOn(console, "error").mockImplementation(() => {});

describe("CompleteRunReporter", () => {
  it("leaves the exit code alone when every listed file was scheduled and reported", async () => {
    process.exitCode = 0;
    const r = reporter();
    await r.onTestRunStart([spec(a), spec(b), spec(c), spec(hidden), spec(inHiddenDir)]);
    await r.onTestRunEnd([mod(a), mod(b, "failed"), mod(c), mod(hidden), mod(inHiddenDir)], [], "failed");
    expect(process.exitCode).toBe(0);
  });

  it("fails the run when a scheduled file has no result", async () => {
    process.exitCode = 0;
    const err = silent();
    const r = reporter();
    await r.onTestRunStart([spec(a), spec(b), spec(c), spec(hidden), spec(inHiddenDir)]);
    await r.onTestRunEnd([mod(a), mod(c), mod(hidden), mod(inHiddenDir)], [], "passed");
    expect(process.exitCode).toBe(1);
    expect(err.mock.calls[0][0]).toContain("b.test.ts");
  });

  it("fails the run when the file is only pending", async () => {
    process.exitCode = 0;
    const err = silent();
    const r = reporter();
    await r.onTestRunStart([spec(a), spec(b), spec(c), spec(hidden), spec(inHiddenDir)]);
    await r.onTestRunEnd([mod(a), mod(b, "pending"), mod(c), mod(hidden), mod(inHiddenDir)], [], "passed");
    expect(process.exitCode).toBe(1);
    expect(err.mock.calls[0][0]).toContain("b.test.ts");
  });

  it("fails the run when a file matching the include globs was never planned", async () => {
    process.exitCode = 0;
    const err = silent();
    const r = reporter();
    await r.onTestRunStart([spec(a), spec(b)]);
    await r.onTestRunEnd([mod(a), mod(b)], [], "passed");
    expect(process.exitCode).toBe(1);
    expect(err.mock.calls[0][0]).toContain("c.test.ts");
  });

  it("fails the run when a hidden file was never planned", async () => {
    process.exitCode = 0;
    const err = silent();
    const r = reporter();
    await r.onTestRunStart([spec(a), spec(b), spec(c), spec(inHiddenDir)]);
    await r.onTestRunEnd([mod(a), mod(b), mod(c), mod(inHiddenDir)], [], "passed");
    expect(process.exitCode).toBe(1);
    expect(err.mock.calls[0][0]).toContain(".hidden.test.ts");
  });

  it("fails the run when a file under a hidden directory was never planned", async () => {
    process.exitCode = 0;
    const err = silent();
    const r = reporter();
    await r.onTestRunStart([spec(a), spec(b), spec(c), spec(hidden)]);
    await r.onTestRunEnd([mod(a), mod(b), mod(c), mod(hidden)], [], "passed");
    expect(process.exitCode).toBe(1);
    expect(err.mock.calls[0][0]).toContain(".suite/d.test.ts");
  });

  it("ignores files the project excludes", async () => {
    process.exitCode = 0;
    const r = reporter();
    await r.onTestRunStart([spec(a), spec(b), spec(c), spec(hidden), spec(inHiddenDir)]);
    await r.onTestRunEnd([mod(a), mod(b), mod(c), mod(hidden), mod(inHiddenDir)], [], "passed");
    expect(process.exitCode).toBe(0);
  });

  it("does not count files outside a shard as missing", async () => {
    process.exitCode = 0;
    const r = reporter({ shard: true });
    await r.onTestRunStart([spec(a), spec(b), spec(c), spec(hidden), spec(inHiddenDir)]);
    // The pool runs the first three; the hidden files have no test module.
    await r.onTestRunEnd([mod(a), mod(b), mod(c)], [], "passed");
    expect(process.exitCode).toBe(0);
  });

  it("fails a sharded run when a file in the shard has no result", async () => {
    process.exitCode = 0;
    silent();
    const r = reporter({ shard: true });
    await r.onTestRunStart([spec(a), spec(b), spec(c), spec(hidden), spec(inHiddenDir)]);
    await r.onTestRunEnd([mod(a)], [], "passed");
    expect(process.exitCode).toBe(1);
  });

  it("fails a sharded run when discovery missed a listed file", async () => {
    process.exitCode = 0;
    silent();
    const r = reporter({ shard: true });
    await r.onTestRunStart([spec(a), spec(b)]);
    await r.onTestRunEnd([mod(a)], [], "passed");
    expect(process.exitCode).toBe(1);
  });

  it("compares a filtered run with the filtered glob, not the full one", async () => {
    process.exitCode = 0;
    const r = reporter({ filenamePattern: ["a.test"] });
    await r.onTestRunStart([spec(a)]);
    await r.onTestRunEnd([mod(a)], [], "passed");
    expect(process.exitCode).toBe(0);
  });

  it("fails a filtered run when a file matching the filter is missing from the plan", async () => {
    process.exitCode = 0;
    silent();
    const r = reporter({ filenamePattern: [".test.ts"] });
    await r.onTestRunStart([spec(a)]);
    await r.onTestRunEnd([mod(a)], [], "passed");
    expect(process.exitCode).toBe(1);
  });

  it("compares only the plan when the run is narrowed by --changed", async () => {
    process.exitCode = 0;
    const r = reporter({ changed: true });
    await r.onTestRunStart([spec(a)]);
    await r.onTestRunEnd([mod(a)], [], "passed");
    expect(process.exitCode).toBe(0);
  });

  it("does not check an interrupted run", async () => {
    process.exitCode = 0;
    const r = reporter();
    await r.onTestRunStart([spec(a), spec(b), spec(c), spec(hidden), spec(inHiddenDir)]);
    await r.onTestRunEnd([mod(a)], [], "interrupted");
    expect(process.exitCode).toBe(0);
  });
});
