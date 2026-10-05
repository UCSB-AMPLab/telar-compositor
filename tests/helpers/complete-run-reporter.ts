/**
 * Vitest reporter that fails a run when a test file that should have run
 * reported no result, or when a file matching the include globs was never
 * scheduled.
 *
 * Under heavy machine load a full run has finished with every reported file
 * passing while one file was absent from the results, so the summary line
 * ("493 passed (493)") could not show that a file never ran. Three lists are
 * kept apart:
 *   - planned: the specifications handed to `onTestRunStart`, before any
 *     `--shard` is applied (TestRun.start, vitest/dist/chunks/cli-api.*.js);
 *   - scheduled: what the pool will execute. `--shard` is applied inside the
 *     pool, after that hook, by the configured sequencer's `shard()`
 *     (createPool.executeTests, same file); the reporter runs the same call
 *     on the planned list, which the pool receives whole from
 *     `Vitest.runFiles`. Without a shard, scheduled is planned;
 *   - listed: a glob of each project's `include`/`exclude` made here with
 *     `node:fs`, dot-entries included as Vitest's `dot: true` does, not
 *     `globTestSpecifications`, which returns the project's cached
 *     `testFilesList` and so repeats whatever discovery missed. The run's
 *     filename filters are applied as `filterFiles` applies them.
 * A scheduled file without a finished result, or a listed file that was not
 * planned, is printed and sets a non-zero exit code. Watch mode and runs
 * narrowed by `--changed`, `--related` or `--project` skip the listed
 * comparison; an interrupted run is not checked.
 *
 * @version v1.5.0-beta
 */

import { readdirSync } from "node:fs";
import { isAbsolute, join, matchesGlob, relative, resolve } from "node:path";
import type { Reporter, TestSpecification, Vitest } from "vitest/node";

const FINISHED = new Set(["passed", "failed", "skipped"]);

function runModuleKey(project: string, moduleId: string): string {
  return `${project} :: ${moduleId}`;
}

interface ProjectLike {
  name: string;
  config: { dir?: string; root: string; include: string[]; exclude: string[] };
}

// `path.matchesGlob` and `fs.globSync` both skip dot-entries, and Vitest globs
// with `dot: true`. Segments that begin with a dot are rewritten in the path
// and in the pattern alike, so a wildcard matches them and a literal `.suite`
// still matches itself.
const DOT = "\u0001";
const undot = (p: string) =>
  p.split("/").map((seg) => (seg.startsWith(".") ? DOT + seg.slice(1) : seg)).join("/");
const pathMatchesAny = (path: string, patterns: string[]) =>
  patterns.some((pattern) => matchesGlob(undot(path), undot(pattern)));

/**
 * The include/exclude glob of one project, read from the file system by a
 * directory walk that enters hidden directories. A directory is not entered
 * when a file under it would be excluded.
 */
function globProject(project: ProjectLike): string[] {
  const cwd = project.config.dir || project.config.root;
  const { include, exclude } = project.config;
  const found: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(cwd, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!pathMatchesAny(`${path}/x`, exclude)) walk(path);
      } else if (pathMatchesAny(path, include) && !pathMatchesAny(path, exclude)) {
        found.push(resolve(cwd, path).replace(/\\/g, "/"));
      }
    }
  };
  walk("");
  return found;
}

/** Vitest's `filterFiles`: a substring of the lower-cased relative path. */
function passesFilters(file: string, dir: string, filters: string[]): boolean {
  if (filters.length === 0) return true;
  const rel = relative(dir, file).toLowerCase();
  return filters.some((raw) => {
    const f = raw.replace(/:\d+$/, "");
    if (isAbsolute(f) && file.startsWith(f)) return true;
    const relFilter = f.endsWith("/") ? join(relative(dir, f), "/") : relative(dir, f);
    return rel.includes(f.toLowerCase()) || rel.includes(relFilter.toLowerCase());
  });
}

export default class CompleteRunReporter implements Reporter {
  private ctx!: Vitest;
  private planned: TestSpecification[] = [];
  private scheduled: string[] = [];

  onInit(ctx: Vitest): void {
    this.ctx = ctx;
  }

  async onTestRunStart(
    specifications: ReadonlyArray<TestSpecification>,
  ): Promise<void> {
    this.planned = [...specifications];
    let scheduled: ReadonlyArray<TestSpecification> = this.planned;
    const config = this.ctx.config as {
      shard?: unknown;
      sequence: { sequencer: new (ctx: Vitest) => { shard(f: unknown[]): PromiseLike<TestSpecification[]> } };
    };
    if (config.shard) {
      const sequencer = new config.sequence.sequencer(this.ctx);
      scheduled = await sequencer.shard(this.planned);
    }
    this.scheduled = scheduled.map((s) => runModuleKey(s.project.name, s.moduleId));
  }

  async onTestRunEnd(
    testModules: ReadonlyArray<{
      moduleId: string;
      project: { name: string };
      state(): string;
    }>,
    _errors: unknown,
    reason: string,
  ): Promise<void> {
    if (reason === "interrupted") return;

    const finished = new Set(
      testModules
        .filter((m) => FINISHED.has(m.state()))
        .map((m) => runModuleKey(m.project.name, m.moduleId)),
    );
    const notRun = this.scheduled.filter((k) => !finished.has(k));

    const config = this.ctx.config as {
      watch?: boolean;
      changed?: unknown;
      related?: unknown;
      project?: unknown;
    };
    const narrowed =
      config.changed || config.related ||
      (Array.isArray(config.project) && config.project.length > 0);
    const notScheduled: string[] = [];
    if (!config.watch && !narrowed) {
      const filters =
        (this.ctx as { filenamePattern?: string[] }).filenamePattern ?? [];
      const planned = new Set(
        this.planned.map((s) => runModuleKey(s.project.name, s.moduleId)),
      );
      for (const project of this.ctx.projects as unknown as ProjectLike[]) {
        const dir = project.config.dir || project.config.root;
        for (const file of globProject(project)) {
          if (!passesFilters(file, dir, filters)) continue;
          const k = runModuleKey(project.name, file);
          if (!planned.has(k)) notScheduled.push(k);
        }
      }
    }

    if (notRun.length === 0 && notScheduled.length === 0) return;

    process.exitCode = 1;
    const list = (title: string, keys: string[]) =>
      keys.length ? `${title}:\n${keys.sort().map((m) => `  ${m}`).join("\n")}\n` : "";
    console.error(
      `\nIncomplete run: ${finished.size} of ${this.scheduled.length} scheduled test files reported a result.\n` +
        list("Scheduled but no result", notRun) +
        list("Match the include globs but were never scheduled", notScheduled),
    );
  }
}
