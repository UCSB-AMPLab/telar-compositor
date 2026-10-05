/**
 * Access to the sibling Telar framework checkout, for the tests that check
 * the two sides agree.
 *
 * The constraint this file exists to hold: parity against the framework is
 * checked on a machine that has a checkout of the Telar framework and names it
 * in TELAR_FRAMEWORK_DIR (the checkout root); CI proves the Compositor alone. A runner has no checkout and leaves the variable unset, so a test
 * that shells into the framework's Python cannot be a hard requirement there —
 * it died with `ModuleNotFoundError: No module named 'telar'` and took six
 * other assertions in the same file down with it.
 *
 * Skipping is therefore correct, but silence is not: `describeWithFramework`
 * puts the reason in the block title, so a run without the checkout says so in
 * its output rather than quietly reporting fewer tests. Anything that must
 * hold without the framework belongs in a plain `describe`.
 *
 * A gate that exists to prove parity is the exception: there a skip would
 * report green on a proof that never ran. `describeWithRequiredFramework` lets
 * a file opt in to failing instead when `TELAR_PARITY_REQUIRED=1` is set.
 *
 * TELAR_FRAMEWORK_DIR points at a checkout of the framework's development
 * tree, not at the published template. Its working tree is the next release
 * under development; the release sites run today is the
 * `PUBLISHED_FRAMEWORK_TAG` tag in the same checkout. Published output has
 * to build on both, so a test that measures the framework says which of the two
 * it is measuring.
 *
 * @version v1.5.0-beta
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";

/** The environment variable naming the root of the framework checkout. */
export const FRAMEWORK_DIR_ENV = "TELAR_FRAMEWORK_DIR";

/** The git checkout the tests measure against, for `git -C`; empty when the variable is unset. */
const FRAMEWORK_CHECKOUT_DIR = process.env[FRAMEWORK_DIR_ENV] ?? "";

/**
 * The framework's Python package root — `scripts/telar/` lives under this.
 * Empty when TELAR_FRAMEWORK_DIR is unset, which `frameworkCheckoutPresent`
 * reads as absent.
 */
export const FRAMEWORK_SCRIPTS_DIR = FRAMEWORK_CHECKOUT_DIR ? join(FRAMEWORK_CHECKOUT_DIR, "scripts") : "";

/**
 * The framework release the sites the Compositor publishes to are on, and which
 * a published file therefore has to build on whatever the test instance does.
 * Bump it when no site is left on this release.
 */
export const PUBLISHED_FRAMEWORK_TAG = "v1.7.0";

/**
 * Whether the framework checkout is usable from here. Probes a module the
 * package has always carried rather than the directory alone, so a stale or
 * partial checkout reads as absent instead of failing mid-test.
 */
export const frameworkCheckoutPresent =
  FRAMEWORK_SCRIPTS_DIR !== "" && existsSync(`${FRAMEWORK_SCRIPTS_DIR}/telar/csv_utils.py`);

/** Where the checkout is expected, for the skip and failure messages. */
const EXPECTED_AT = FRAMEWORK_SCRIPTS_DIR || `${FRAMEWORK_DIR_ENV} unset`;

/**
 * `describe` for a block that needs the framework checkout. Skips the whole
 * block when it is absent, naming the reason in the title.
 */
export function describeWithFramework(title: string, fn: () => void): void {
  const skipped = `${title} [skipped: no framework checkout (${EXPECTED_AT})]`;
  describe.skipIf(!frameworkCheckoutPresent)(frameworkCheckoutPresent ? title : skipped, fn);
}

/**
 * The environment variable a gate sets to make a missing checkout a failure
 * rather than a skip, for the files that opt in through
 * `describeWithRequiredFramework`. A phase gate that exists to prove parity
 * cannot let the proof skip and still report green.
 */
export const PARITY_REQUIRED_ENV = "TELAR_PARITY_REQUIRED";

/** Run the block, skip it visibly, or fail it because the gate requires the checkout. */
export function frameworkBlockMode(
  present: boolean,
  env: Record<string, string | undefined>,
): "run" | "skip" | "fail" {
  if (present) return "run";
  return env[PARITY_REQUIRED_ENV] === "1" ? "fail" : "skip";
}

/**
 * `describeWithFramework`, except that with `TELAR_PARITY_REQUIRED=1` a missing
 * checkout fails the block instead of skipping it. Opt-in per file; every other
 * guarded block keeps skipping.
 */
export function describeWithRequiredFramework(title: string, fn: () => void): void {
  if (frameworkBlockMode(frameworkCheckoutPresent, process.env) !== "fail") {
    describeWithFramework(title, fn);
    return;
  }
  describe(`${title} [${PARITY_REQUIRED_ENV}=1: the framework checkout is required]`, () => {
    it("finds the framework checkout", () => {
      throw new Error(`no framework checkout (${EXPECTED_AT}), and ${PARITY_REQUIRED_ENV}=1`);
    });
  });
}

/** Whether the checkout holds `tag`, so a block needing it can skip visibly. */
export function frameworkTagPresent(tag: string): boolean {
  if (!frameworkCheckoutPresent) return false;
  try {
    execFileSync("git", ["-C", FRAMEWORK_CHECKOUT_DIR, "rev-parse", "--verify", `${tag}^{commit}`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/** `frameworkBlockMode` for a block that needs the checkout at `tag`. */
export function frameworkTagBlockMode(
  tag: string,
  env: Record<string, string | undefined>,
  present = frameworkTagPresent(tag),
): "run" | "skip" | "fail" {
  return frameworkBlockMode(present, env);
}

/**
 * `describe` for a block that needs the checkout at a named tag as well as at
 * its working tree. Skips the whole block when either is absent, naming which;
 * with `TELAR_PARITY_REQUIRED=1` fails it instead.
 */
export function describeWithFrameworkTag(tag: string, title: string, fn: () => void): void {
  const mode = frameworkTagBlockMode(tag, process.env);
  const missing = frameworkCheckoutPresent
    ? `framework checkout has no ${tag}`
    : `no framework checkout (${EXPECTED_AT})`;
  if (mode === "fail") {
    describe(`${title} [${PARITY_REQUIRED_ENV}=1: the framework checkout at ${tag} is required]`, () => {
      it(`finds the framework checkout at ${tag}`, () => {
        throw new Error(`${missing}, and ${PARITY_REQUIRED_ENV}=1`);
      });
    });
    return;
  }
  describe.skipIf(mode === "skip")(mode === "run" ? title : `${title} [skipped: ${missing}]`, fn);
}

/** One extraction per tag per process — `git archive` is not free. */
const scriptsAtTag = new Map<string, string>();

/**
 * The framework's `scripts/` as of `tag`, extracted into a temporary directory
 * and returned as a path usable wherever `FRAMEWORK_SCRIPTS_DIR` is.
 *
 * The extraction is what makes a released framework measurable at all: the
 * checkout's working tree holds one revision, and a test that has to hold
 * against two cannot get the second by reading files.
 */
export function frameworkScriptsAtTag(tag: string): string {
  const memoised = scriptsAtTag.get(tag);
  if (memoised) return memoised;
  if (!frameworkTagPresent(tag)) {
    throw new Error(
      `the framework checkout at ${FRAMEWORK_CHECKOUT_DIR} has no ${tag}; ` +
        "guard the block with describeWithFrameworkTag",
    );
  }
  const dir = mkdtempSync(join(tmpdir(), `telar-framework-${tag}-`));
  const archive = execFileSync("git", ["-C", FRAMEWORK_CHECKOUT_DIR, "archive", tag, "scripts"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  execFileSync("tar", ["-x", "-C", dir], { input: archive });
  const scripts = join(dir, "scripts");
  scriptsAtTag.set(tag, scripts);
  return scripts;
}

/**
 * Every guarded test spawns `python3`, sometimes several times over. Under the
 * full suite's parallel load that comfortably exceeds the default 5s per-test
 * timeout, which shows up as an intermittent failure with nothing wrong in it.
 */
export const FRAMEWORK_TIMEOUT_MS = 60_000;

/** Whether python3 can be run at all, independently of any checkout. */
export const python3Present = (() => {
  try {
    execFileSync("python3", ["-c", "1"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/**
 * `describe` for a block that needs python3 but no framework checkout — a rule
 * this repo holds against CPython's own behaviour rather than against Telar's.
 */
export function describeWithPython(title: string, fn: () => void): void {
  const skipped = `${title} [skipped: no python3 on PATH]`;
  describe.skipIf(!python3Present)(python3Present ? title : skipped, fn);
}

/** Run a snippet with plain python3 and parse the JSON on its last line. */
export function runPython(body: string, input?: string): unknown {
  const out = execFileSync("python3", ["-c", "import json,sys\n" + body], {
    encoding: "utf-8",
    input,
  });
  return JSON.parse(out.trim().split("\n").at(-1) as string);
}

/** Run a snippet against the framework's own modules and parse its JSON. */
function runFramework(body: string, input?: string, scriptsDir = FRAMEWORK_SCRIPTS_DIR): unknown {
  return runPython(`sys.path.insert(0,${JSON.stringify(scriptsDir)})\n` + body, input);
}

/**
 * The framework's COLUMN_NAME_MAPPING, read by running python3 against its own
 * module — not by parsing the file, which would re-implement the thing under
 * test and could agree with a broken transcription.
 */
export function readFrameworkColumnMapping(scriptsDir = FRAMEWORK_SCRIPTS_DIR): Record<string, string> {
  return runFramework(
    "from telar.csv_utils import COLUMN_NAME_MAPPING as m\nprint(json.dumps(m))",
    undefined,
    scriptsDir,
  ) as Record<string, string>;
}

/**
 * The interpreter the test instance builds with. The shell's `python3` holds
 * other library versions, and a reading taken under it is pandas' answer on
 * that install rather than the build's.
 */
export const FRAMEWORK_PYTHON = join(FRAMEWORK_CHECKOUT_DIR, ".venv", "bin", "python3");

/** What `telar.core.csv_to_json` made of one sheet. */
export interface FrameworkSheetConversion {
  /** Whether the JSON was written: false on a refusal or any other error. */
  ok: boolean;
  /** The records written, the metadata record left out; a missing value is null. */
  rows: Record<string, unknown>[];
  /** Each record's values as `str()` of the pandas value, the text a number is published as: 1 and "1" alike are `1`, a float is `1.0`. */
  published: Record<string, string>[];
  /** What the conversion printed, which names a refusal. */
  log: string;
  /** The temporary directory the conversion wrote in, removed before this returns. */
  dir: string;
}

/**
 * Converts `csv` with `telar.core.csv_to_json` itself, as the build does, under
 * the scripts at `scriptsDir`, with no processing function, so the rows are the
 * sheet as read and normalised. An objects sheet is scoped to `OBJECT_FIELDS`
 * where the release has that name (the test instance) and unscoped where it
 * does not (the published tag, whose `csv_to_json` takes no such argument); a
 * story sheet is unscoped at both.
 *
 * Run under FRAMEWORK_PYTHON, which is the test instance's pandas at both
 * releases: a site on the published tag installs its own in CI.
 */
export function frameworkCsvToJson(
  csv: string,
  sheet: "objects" | "story" | "project" | "glossary",
  scriptsDir = FRAMEWORK_SCRIPTS_DIR,
): FrameworkSheetConversion {
  const script = [
    "import sys, io, os, json, math, shutil, tempfile, contextlib",
    `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
    "import telar.csv_utils as cu",
    "from telar.core import csv_to_json",
    "d = tempfile.mkdtemp()",
    "src, out = os.path.join(d, 'in.csv'), os.path.join(d, 'out.json')",
    "open(src, 'w', encoding='utf-8').write(sys.stdin.buffer.read().decode('utf-8'))",
    `scope = getattr(cu, 'OBJECT_FIELDS', None) if ${JSON.stringify(sheet)} == 'objects' else None`,
    "kwargs = {}",
    "if scope is not None: kwargs['canonical_fields'] = scope",
    `if ${JSON.stringify(sheet)} == 'project':`,
    "    from telar.processors.project import process_project_setup",
    "    kwargs['process_func'] = process_project_setup",
    `if ${JSON.stringify(sheet)} == 'glossary' and hasattr(cu, 'GLOSSARY_COLUMN_ALIASES'):`,
    "    kwargs['sheet_aliases'] = cu.GLOSSARY_COLUMN_ALIASES",
    "log = io.StringIO()",
    "with contextlib.redirect_stdout(log):",
    "    ok = csv_to_json(src, out, **kwargs)",
    "data = json.load(open(out, encoding='utf-8')) if ok else []",
    `if ${JSON.stringify(sheet)} == 'project':`,
    "    data = [s for r in data for s in r.get('stories', [])]",
    "rows = [r for r in data if not r.get('_metadata')]",
    "published = [{k: str(v) for k, v in r.items()} for r in rows]",
    "clean = lambda v: None if isinstance(v, float) and math.isnan(v) else v",
    "rows = [{k: clean(v) for k, v in r.items()} for r in rows]",
    "shutil.rmtree(d)",
    "print(json.dumps({'ok': bool(ok), 'rows': rows, 'published': published, 'log': log.getvalue(), 'dir': d}, default=str))",
  ].join("\n");
  const out = execFileSync(FRAMEWORK_PYTHON, ["-c", script], {
    input: csv,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(out.trim().split("\n").at(-1) as string) as FrameworkSheetConversion;
}

/** What a release's glossary readers make of one glossary.csv. */
export interface FrameworkGlossaryRead {
  /** The term ids in the link map, in order. */
  linkIds: string[];
  /** The titles of the link map's terms, by id. */
  linkTitles: Record<string, string>;
  /** The page files the generator wrote. */
  pages: string[];
  /** The refusal each reader raised, by reader, when it raised one. */
  refused: string[];
}

/**
 * Reads `csv` through the release's own glossary functions: the link map
 * (`load_glossary_from_csv` at the published tag, `site_glossary_pages` at the
 * head, where the link map is its pages' ids) and the page generator
 * (`_generate_glossary_from_csv`, which writes its files into a directory that
 * is removed before this returns). The sheet is written to a temporary file
 * and the functions run in a temporary working directory.
 */
export function frameworkGlossaryRead(csv: string, scriptsDir = FRAMEWORK_SCRIPTS_DIR): FrameworkGlossaryRead {
  const script = [
    "import sys, os, json, io, tempfile, shutil, contextlib",
    `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
    "d = tempfile.mkdtemp()",
    "os.chdir(d)",
    "os.makedirs('telar-content/spreadsheets')",
    "src = 'telar-content/spreadsheets/glossary.csv'",
    "open(src, 'w', encoding='utf-8').write(sys.stdin.buffer.read().decode('utf-8'))",
    "refused, ids, titles = [], [], {}",
    "log = io.StringIO()",
    "with contextlib.redirect_stdout(log):",
    "    try:",
    "        import telar.glossary as g",
    "        if hasattr(g, 'load_glossary_from_csv'):",
    "            terms = g.load_glossary_from_csv(src)",
    "        else:",
    "            terms = g.load_glossary_terms()",
    "        ids = list(terms.keys()); titles = {k: str(v) for k, v in terms.items()}",
    "    except Exception as e:",
    "        refused.append(type(e).__name__)",
    "    try:",
    "        try:",
    "            from telar.glossary_pages import _generate_glossary_from_csv as gen",
    "        except ImportError:",
    "            from generate_collections import _generate_glossary_from_csv as gen",
    "        os.makedirs('out')",
    "        from pathlib import Path",
    "        gen(src, Path('out'), dict(titles))",
    "    except Exception as e:",
    "        refused.append(type(e).__name__)",
    "pages = sorted(os.listdir('out')) if os.path.isdir('out') else []",
    "os.chdir('/')",
    "shutil.rmtree(d)",
    "print(json.dumps({'linkIds': ids, 'linkTitles': titles, 'pages': pages, 'refused': refused}))",
  ].join("\n");
  const out = execFileSync(FRAMEWORK_PYTHON, ["-c", script], {
    input: csv,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PYTHONPATH: scriptsDir },
  });
  return JSON.parse(out.trim().split("\n").at(-1) as string) as FrameworkGlossaryRead;
}

/**
 * The glossary's own header aliases (`GLOSSARY_COLUMN_ALIASES`) the release
 * defines, or null where it has none (the published tag).
 */
export function readFrameworkGlossaryAliases(scriptsDir = FRAMEWORK_SCRIPTS_DIR): Record<string, string> | null {
  return runFramework(
    "import telar.csv_utils as cu\nprint(json.dumps(getattr(cu, 'GLOSSARY_COLUMN_ALIASES', None)))",
    undefined,
    scriptsDir,
  ) as Record<string, string> | null;
}

/**
 * The framework's `is_header_row` verdict on one row of cells.
 *
 * `emptyAsNaN` models WHICH READER opened the file, and at the published tag it
 * decides the answer: `is_header_row` counts known tokens over non-NA cells
 * there, so an empty cell is excluded when it is NaN and counted when it is "".
 * The reader a release uses is the caller's to state, and the two releases
 * differ: no reader at the published tag passes `keep_default_na`, so every one
 * of them gets NaN, while the test instance's glossary readers pass
 * `keep_default_na=False` (telar/glossary.py:69, generate_collections.py:307)
 * and get "". telar/core.py, which reads objects.csv, uses the default at both.
 */
export function frameworkIsHeaderRow(
  cells: string[],
  emptyAsNaN: boolean,
  scriptsDir = FRAMEWORK_SCRIPTS_DIR,
): boolean {
  return runFramework(
    "import pandas as pd\n" +
      "from telar.csv_utils import is_header_row\n" +
      "cells = json.loads(sys.stdin.read())\n" +
      "vals = [(float('nan') if (c == '' and " +
      (emptyAsNaN ? "True" : "False") +
      ") else c) for c in cells]\n" +
      "print(json.dumps(bool(is_header_row(vals))))",
    JSON.stringify(cells),
    scriptsDir,
  ) as boolean;
}

/**
 * What the framework's glossary pipeline makes of a CSV: the column names it
 * ends up holding, any duplicates among them, and the error if it refuses.
 *
 * The read and the lines around `normalize_column_names` are quoted from
 * `generate_collections._generate_glossary_from_csv`, because the order of the
 * fold against the rename is the thing under test and calling the generator
 * itself would not expose the frame. The two generators differ on both, so
 * `foldFirst` states which one is being mirrored and carries the read with it:
 * true is the published tag — `pd.read_csv(csv_path)` at
 * `generate_collections.py:270`, then fold and normalise at `:273` and `:275`;
 * false is the test instance — `read_glossary_sheet`
 * (scripts/telar/glossary.py): `dtype=str, keep_default_na=False`, instruction
 * columns dropped, then normalise and fold. Nothing here detects which — a mirror
 * that guessed would agree with whichever revision the checkout happens to
 * hold. The read flags bear on cell values, not on the header names this
 * returns, so both reads answer alike for every case it measures.
 */
export function frameworkGlossaryColumns(
  csv: string,
  foldFirst: boolean,
  scriptsDir = FRAMEWORK_SCRIPTS_DIR,
): {
  columns?: string[];
  duplicates?: string[];
  error?: string;
} {
  const fold = "    df.columns = df.columns.str.lower().str.strip()\n";
  const normalise = "    df = normalize_column_names(df)\n";
  const drop = "    df = df[[c for c in df.columns if not c.startswith('#')]]\n";
  const read = foldFirst
    ? "    df = pd.read_csv(io.StringIO(csv))\n"
    : "    df = pd.read_csv(io.StringIO(csv), dtype=str, keep_default_na=False)\n";
  return runFramework(
    "import io, pandas as pd\n" +
      "from telar.csv_utils import normalize_column_names\n" +
      "csv = sys.stdin.read()\n" +
      "try:\n" +
      read +
      (foldFirst ? fold + normalise : drop + normalise + fold) +
      "    cols = [str(c) for c in df.columns]\n" +
      "    dupes = sorted({c for c in cols if cols.count(c) > 1})\n" +
      "    print(json.dumps({'columns': cols, 'duplicates': dupes}))\n" +
      "except Exception as e:\n" +
      "    print(json.dumps({'error': type(e).__name__}))",
    csv,
    scriptsDir,
  ) as { columns?: string[]; duplicates?: string[]; error?: string };
}

/**
 * What the framework's two glossary readers make of a CSV: the term ids the
 * page generator writes pages for, and the ids the link map holds.
 *
 * Both readers are mirrored rather than called: the generator writes Jekyll
 * files into a directory and the loader takes a path, so neither can be handed
 * a string, and the thing under test is which rows each one keeps.
 *
 * `foldFirst` states the release, carrying the read and the order with it, as
 * it does for `frameworkGlossaryColumns`. True is the published tag:
 * `pd.read_csv(csv_path)` in both readers (generate_collections.py:270,
 * telar/glossary.py:64), the generator folding at :273 before it normalises at
 * :275. False is the test instance: `dtype=str, keep_default_na=False`
 * (generate_collections.py:307, telar/glossary.py:69), the generator
 * dropping instruction columns, then normalising, then folding
 * (`read_glossary_sheet`); at the tag the drop follows the fold and the
 * rename, and the link map drops no column at all.
 *
 * The row rules are the generator's own: a term needs a `term_id` and a
 * `title`, and one whose `term_id` opens `#` is skipped
 * (generate_collections.py:348 on the test instance, :300 at the tag). The link
 * map asks only for both cells (telar/glossary.py:81 at both).
 */
export function frameworkGlossaryTerms(
  csv: string,
  foldFirst: boolean,
  scriptsDir = FRAMEWORK_SCRIPTS_DIR,
): { pages?: string[]; linkMap?: string[]; error?: string } {
  const read = foldFirst
    ? "pd.read_csv(io.StringIO(csv))"
    : "pd.read_csv(io.StringIO(csv), dtype=str, keep_default_na=False)";
  const fold = "df.columns = df.columns.str.lower().str.strip()\n";
  const normalise = "df = normalize_column_names(df)\n";
  const drop = "df = df[[c for c in df.columns if not c.startswith('#')]]\n";
  return runFramework(
    "import io, pandas as pd\n" +
      "from telar.csv_utils import normalize_column_names, is_header_row\n" +
      "csv = sys.stdin.read()\n" +
      "def cells(df):\n" +
      "    out = []\n" +
      "    for _, row in df.iterrows():\n" +
      "        out.append((str(row.get('term_id', '')).strip(), str(row.get('title', '')).strip()))\n" +
      "    return out\n" +
      "try:\n" +
      `    df = ${read}\n` +
      "    " +
      (foldFirst
        ? fold + "    " + normalise + "    " + drop
        : drop + "    " + normalise + "    " + fold) +
      "    if len(df) > 0 and is_header_row(df.iloc[0].values):\n" +
      "        df = df.iloc[1:].reset_index(drop=True)\n" +
      "    pages = [t for t, title in cells(df) if t and title and not t.startswith('#')]\n" +
      `    link = ${read}\n` +
      "    link = normalize_column_names(link)\n" +
      "    ids = [t for t, title in cells(link) if t and title]\n" +
      "    print(json.dumps({'pages': pages, 'linkMap': ids}))\n" +
      "except Exception as e:\n" +
      "    print(json.dumps({'error': type(e).__name__}))",
    csv,
    scriptsDir,
  ) as { pages?: string[]; linkMap?: string[]; error?: string };
}

/**
 * What the framework's objects pipeline makes of a CSV: the column names it
 * ends up holding, the first column's surviving cells, and the error if it
 * refuses.
 *
 * The steps are quoted from `telar.core.csv_to_json` rather than invented,
 * because the thing under test is what the CONSUMER does and the consumer runs
 * four filters before the rename: the read, the comment-row drop on the first
 * column, the instruction-column drop on the header text, and the duplicate
 * bilingual-header skip. `normalize_column_names` alone answers a different
 * question — a sheet it refuses can be one `csv_to_json` never hands it.
 *
 * `csv_to_json` itself takes two paths and writes JSON, so it cannot be called
 * on a frame; the lines are mirrored instead (scripts/telar/core.py:85-107 on
 * the test instance, :85-103 at the published tag, identical bar the scope).
 *
 * The scope is read from the release rather than assumed: the test instance
 * passes `OBJECT_FIELDS`, and the published tag has no such name and no second
 * parameter to pass it to.
 */
export function frameworkObjectsRead(
  csv: string,
  scriptsDir = FRAMEWORK_SCRIPTS_DIR,
): { columns?: string[]; ids?: string[]; error?: string } {
  return runFramework(
    "import io\n" +
      "import pandas as pd\n" +
      "import telar.csv_utils as cu\n" +
      "from telar.csv_utils import is_header_row\n" +
      "csv = sys.stdin.read()\n" +
      "scope = getattr(cu, 'OBJECT_FIELDS', None)\n" +
      "try:\n" +
      "    df = pd.read_csv(io.StringIO(csv), on_bad_lines='warn')\n" +
      "    first_col = df.columns[0]\n" +
      "    df = df[~df[first_col].astype(str).str.strip().str.startswith('#')]\n" +
      "    df = df[[col for col in df.columns if not col.startswith('#')]]\n" +
      "    if len(df) > 0 and is_header_row(df.iloc[0].values):\n" +
      "        df = df.iloc[1:].reset_index(drop=True)\n" +
      "    df = cu.normalize_column_names(df, scope) if scope else cu.normalize_column_names(df)\n" +
      "    ids = [str(v) for v in df.iloc[:, 0].tolist()] if len(df.columns) else []\n" +
      "    print(json.dumps({'columns': [str(c) for c in df.columns], 'ids': ids}))\n" +
      "except Exception as e:\n" +
      "    print(json.dumps({'error': type(e).__name__}))",
    csv,
    scriptsDir,
  ) as { columns?: string[]; ids?: string[]; error?: string };
}

/**
 * Drives the framework's own `_select_featured_objects` over a frame built
 * straight from `featuredCells` — a Python list of strings, never a CSV
 * read — and returns its `is_featured_sample` verdict for each row in order.
 *
 * This is what the accepted set has to be checked against: `_select_featured_
 * objects` builds its whitelist as a set literal local to the function body,
 * so there is no module-level name to read off, and no folded constant a
 * later revision is bound to keep folding. Driving the function is the only
 * way to ask it what it accepts that survives a revision changing how it
 * decides, rather than only what it decided last time this was written.
 *
 * `_select_featured_objects` reads `_config.yml` from the process's own
 * working directory, so this needs `show_sample_on_homepage: true` sitting in
 * a directory the subprocess is actually launched from — a `cwd` on the
 * spawn, not a path argument the framework has no parameter for. The
 * directory is removed in a `finally`, so a failing row still cleans up.
 *
 * `timeout` bounds the child directly: Vitest's own per-test timeout cannot
 * reach inside a blocked `execFileSync` call, so a stuck interpreter would
 * otherwise hang the run past what the test's own timeout promises.
 */
export function driveFrameworkSelector(
  featuredCells: string[],
  scriptsDir = FRAMEWORK_SCRIPTS_DIR,
  timeout = FRAMEWORK_TIMEOUT_MS,
): boolean[] {
  const dir = mkdtempSync(join(tmpdir(), "telar-featured-select-"));
  try {
    writeFileSync(
      join(dir, "_config.yml"),
      "collection_interface:\n  show_sample_on_homepage: true\n",
    );
    const script = [
      "import sys, json",
      `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
      "import pandas as pd",
      "from telar.processors.objects.featured import _select_featured_objects",
      "cells = json.loads(sys.stdin.read())",
      "df = pd.DataFrame({'featured': cells, 'object_warning': [''] * len(cells)})",
      "result = _select_featured_objects(df)",
      "print(json.dumps(result['is_featured_sample'].tolist()))",
    ].join("\n");
    const out = execFileSync("python3", ["-c", script], {
      cwd: dir,
      input: JSON.stringify(featuredCells),
      encoding: "utf-8",
      timeout,
    });
    // The function itself prints an [INFO]/[WARN] line ahead of the JSON —
    // the last line is always the answer, same convention as `runPython`.
    return JSON.parse(out.trim().split("\n").at(-1) as string) as boolean[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The canonical names the framework's objects reader scopes its rename table
 * to, read by running python3 against its own module. Absent at a release that
 * scopes nothing.
 */
export function readFrameworkObjectFields(scriptsDir = FRAMEWORK_SCRIPTS_DIR): string[] | null {
  return runFramework(
    "import telar.csv_utils as cu\n" +
      "f = getattr(cu, 'OBJECT_FIELDS', None)\n" +
      "print(json.dumps(sorted(f) if f is not None else None))",
    undefined,
    scriptsDir,
  ) as string[] | null;
}

/**
 * Whether python3 can import the `pandas` package. No framework checkout is
 * needed to ask what pandas itself infers from a CSV — that question is
 * pandas', not the framework's — but the package still has to be there to
 * ask it.
 */
export const pythonPandasPresent = (() => {
  try {
    execFileSync("python3", ["-c", "import pandas"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** `describe` for a block that needs python3 with the `pandas` package. */
export function describeWithPythonPandas(title: string, fn: () => void): void {
  const skipped = `${title} [skipped: python3 has no pandas package]`;
  describe.skipIf(!pythonPandasPresent)(pythonPandasPresent ? title : skipped, fn);
}

/**
 * Whether python3 can import the `markdown` package. A different dependency
 * from the checkout above and absent on a runner for the same reason: one
 * assertion renders a guarded body with the library the framework builds
 * pages with, to show what a reader would see.
 */
export const pythonMarkdownPresent = (() => {
  try {
    execFileSync("python3", ["-c", "import markdown"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** `describe` for a block that needs python3 with the `markdown` package. */
export function describeWithPythonMarkdown(title: string, fn: () => void): void {
  const skipped = `${title} [skipped: python3 has no markdown package]`;
  describe.skipIf(!pythonMarkdownPresent)(pythonMarkdownPresent ? title : skipped, fn);
}

/**
 * Whether ruby with its bundled YAML (Psych) can be run. Psych is the parser
 * Jekyll reads published front matter with, and the only one that shows
 * whether the escaping is doing anything — js-yaml accepts every code point
 * it guards against, raw.
 *
 * GitHub's ubuntu runner does ship ruby, so these blocks run in CI today.
 * The guard is here because the convention is that no subprocess is assumed:
 * a machine without it should skip visibly, not fail.
 */
export const rubyPresent = (() => {
  try {
    execFileSync("ruby", ["-ryaml", "-e", "1"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** `describe` for a block that shells ruby to parse YAML with Psych. */
export function describeWithRuby(title: string, fn: () => void): void {
  const skipped = `${title} [skipped: no ruby on PATH]`;
  describe.skipIf(!rubyPresent)(rubyPresent ? title : skipped, fn);
}

/**
 * Runs a markdown file through the framework's own `_split_frontmatter`, via a
 * python3 subprocess, so the assertion is against the parser that actually
 * reads these files rather than a JS reimplementation of it.
 *
 * Callers must be inside `describeWithFramework`; this throws if the checkout
 * is missing, because a helper that returned a placeholder would make a test
 * pass while proving nothing.
 */
export function splitFrontmatterViaFramework(fileContent: string): {
  title: string;
  body: string;
} {
  const script = [
    "import sys, json",
    `sys.path.insert(0, ${JSON.stringify(FRAMEWORK_SCRIPTS_DIR)})`,
    "from telar.markdown import _split_frontmatter",
    "data = sys.stdin.buffer.read().decode('utf-8')",
    "title, body = _split_frontmatter(data)",
    "print(json.dumps({'title': title, 'body': body}))",
  ].join("\n");
  const out = execFileSync("python3", ["-c", script], { input: fileContent, encoding: "utf-8" });
  return JSON.parse(out) as { title: string; body: string };
}

/**
 * The same reader over many files, in ONE python3 process.
 *
 * An interpreter start, a `sys.path` insert and a package import cost more
 * than the parse they set up, so a case-per-process run of a sixty-entry
 * corpus spends its whole time in startup and needs a timeout generous enough
 * to cover sixty of them under parallel load. One process reads them all and
 * answers in order; the caller keeps every assertion it had, in JavaScript,
 * where a failure names the entry.
 *
 * The files travel as one JSON array so a scalar carrying a newline, a control
 * character or a lone surrogate reaches Python as itself rather than as
 * something a stream framing had to guess the end of. The result is one entry
 * per file, in the order given, and the caller is expected to check that count.
 *
 * Callers must be inside `describeWithFramework`; this throws if the checkout
 * is missing, because a helper that returned placeholders would make a test
 * pass while proving nothing.
 */
export function splitFrontmatterViaFrameworkBatch(
  fileContents: string[],
): Array<{ title: string; body: string }> {
  const script = [
    "import sys, json",
    `sys.path.insert(0, ${JSON.stringify(FRAMEWORK_SCRIPTS_DIR)})`,
    "from telar.markdown import _split_frontmatter",
    "files = json.loads(sys.stdin.buffer.read().decode('utf-8'))",
    "out = []",
    "for data in files:",
    "    title, body = _split_frontmatter(data)",
    "    out.append({'title': title, 'body': body})",
    "print(json.dumps(out))",
  ].join("\n");
  const out = execFileSync("python3", ["-c", script], {
    input: JSON.stringify(fileContents),
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out) as Array<{ title: string; body: string }>;
}
