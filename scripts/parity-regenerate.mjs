#!/usr/bin/env node
// Regenerates the rendering fixtures from the framework checkout, or checks
// the committed ones against it.
//
//   npm run parity:regenerate              re-record every fixture
//   npm run parity:regenerate -- --check   compare, and exit 1 on a difference
//
// The fixtures are what the preview is tested against in the ordinary
// suite: tests/fixtures/footnote-numbering.json, panel-rendering.json and
// answer-preview.json, each written by the generator beside it through the
// framework's own pipeline, and sheet-collision-repair.json, what the
// framework's 1.8.0 upgrade does to a site's sheets before its first build. They are a copy of the framework's behaviour at
// one commit, and a copy drifts when the framework moves. This command is the
// gate against that: run it with --check before merging anything that
// touches rendering, and whenever the framework moves.
//
// A rendering difference means the site now publishes something the
// committed fixtures do not describe. The preview follows the site: change
// the preview until the tests pass against the regenerated fixtures, then
// commit both together. A difference in the recorded commit or versions
// alone means the outputs held; the check passes and says so, and re-running
// without --check records which commit they were proven against.
//
// The generators need the framework checkout (its root, named in
// TELAR_FRAMEWORK_DIR, which has no default) with its Python environment in
// .venv. None of this runs in the vitest suite.
//
// @version v1.5.0-beta

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process, { argv, env } from "node:process";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(repo, "tests", "fixtures");
if (!env.TELAR_FRAMEWORK_DIR) {
  console.error("TELAR_FRAMEWORK_DIR is not set: point it at the root of a Telar framework checkout.");
  process.exit(1);
}
const framework = resolve(env.TELAR_FRAMEWORK_DIR);
const check = argv.includes("--check");

const GENERATORS = [
  { script: "footnote-numbering.py", output: "footnote-numbering.json" },
  { script: "panel-rendering.py", output: "panel-rendering.json" },
  { script: "answer-preview.py", output: "answer-preview.json" },
  { script: "sheet-collision-repair.py", output: "sheet-collision-repair.json" },
];

/** Keys a generator records about the run rather than about the rendering. */
const METADATA = new Set(["framework_commit", "markdown_version", "pandas_version", "python_version"]);

class GeneratorFailure extends Error {}

function git(...args) {
  return execFileSync("git", ["-C", framework, ...args], { encoding: "utf-8" }).trim();
}

function describeFramework() {
  const python = join(framework, ".venv", "bin", "python3");
  if (!existsSync(join(framework, "scripts", "telar"))) throw new GeneratorFailure(`no framework checkout at ${framework}`);
  if (!existsSync(python)) throw new GeneratorFailure(`no Python environment at ${python}`);
  const dirty = git("status", "--porcelain", "--untracked-files=no") !== "";
  console.log(`framework  ${framework}`);
  console.log(`commit     ${git("rev-parse", "HEAD")}${dirty ? " (with uncommitted changes)" : ""}`);
  return python;
}

/** Each generator's output, written into `out`. */
function generate(python, out) {
  for (const { script } of GENERATORS) {
    try {
      execFileSync(python, [join(fixtures, script), "--out", out], { cwd: framework, stdio: "pipe" });
    } catch (error) {
      throw new GeneratorFailure(`${script} failed:\n${error.stderr?.toString() ?? error.message}`);
    }
  }
}

/** The versions a fixture records, for the log. */
function versions(fixture) {
  return [...METADATA].filter((key) => key in fixture && key !== "framework_commit").map((key) => `${key} ${fixture[key]}`);
}

/**
 * Cases that differ, were added or were removed, in one list of cases. A case
 * is known by its name; a list whose entries carry none is known by
 * position, so that every entry is compared, not one.
 */
function caseChanges(list, before = [], after = []) {
  const key = (c, i) => c.name ?? `#${i}`;
  const old = new Map(before.map((c, i) => [key(c, i), JSON.stringify(c)]));
  const now = new Map(after.map((c, i) => [key(c, i), JSON.stringify(c)]));
  const changed = [...now].filter(([name, value]) => old.has(name) && old.get(name) !== value).map(([name]) => `${list}: ${name}`);
  const added = [...now.keys()].filter((name) => !old.has(name)).map((name) => `${list}: ${name} (new)`);
  const removed = [...old.keys()].filter((name) => !now.has(name)).map((name) => `${list}: ${name} (gone)`);
  return [...changed, ...added, ...removed];
}

/** How a regenerated fixture differs from the committed one. */
function compare(committed, fresh) {
  const keys = new Set([...Object.keys(committed), ...Object.keys(fresh)]);
  const rendering = [];
  const metadata = [];
  for (const key of keys) {
    const same = JSON.stringify(committed[key]) === JSON.stringify(fresh[key]);
    if (same) continue;
    if (METADATA.has(key)) metadata.push(`${key}: ${committed[key]} -> ${fresh[key]}`);
    else if (Array.isArray(fresh[key])) rendering.push(...caseChanges(key, committed[key], fresh[key]));
    else rendering.push(`${key} changed`);
  }
  return { rendering, metadata };
}

/** Reports one regenerated fixture against the committed one; true when the rendering differs. */
function reportFixture(output, out) {
  const fresh = JSON.parse(readFileSync(join(out, output), "utf-8"));
  const path = join(fixtures, output);
  const committed = existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : {};
  const { rendering, metadata } = compare(committed, fresh);
  const panels = fresh.panels ? `, ${fresh.panels.length} panels` : "";
  console.log(`\n${output}  (${versions(fresh).join(", ")})`);
  for (const line of rendering) console.log(`  differs  ${line}`);
  for (const line of metadata) console.log(`  recorded ${line}`);
  if (!rendering.length) console.log(`  ${fresh.cases?.length ?? 0} cases${panels}: rendering unchanged`);
  if (!check) copyFileSync(join(out, output), path);
  return rendering.length > 0;
}

/** Regenerates into a temporary directory; true when any rendering differs. */
function regenerate(python, out) {
  generate(python, out);
  return GENERATORS.map(({ output }) => reportFixture(output, out)).some(Boolean);
}

function main() {
  const out = mkdtempSync(join(tmpdir(), "telar-parity-"));
  try {
    const drift = regenerate(describeFramework(), out);
    if (check && drift) {
      console.log("\nThe framework now renders differently from the committed fixtures. Follow it in the preview, then re-record.");
      process.exitCode = 1;
      return;
    }
    console.log(check ? "\nNo rendering difference." : "\nFixtures re-recorded.");
  } catch (error) {
    if (!(error instanceof GeneratorFailure)) throw error;
    console.error(`parity:regenerate: ${error.message}`);
    process.exitCode = 2;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

main();
