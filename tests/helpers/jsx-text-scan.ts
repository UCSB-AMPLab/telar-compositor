/**
 * Walks a `.tsx` source with the TypeScript compiler API and returns every
 * `JsxText` node whose content is not pure whitespace.
 *
 * A regex cannot do this job: `Promise<void>` reads as a JSX text node of
 * `Promise` to any pattern matching `>...<`, and `{cond && (` inside JSX
 * matches the same way. Both are syntactically impossible to confuse with
 * `JsxText` once the source is actually parsed — a generic type argument and a
 * brace-delimited expression container are never text children of a JSX
 * element — which is why this walks the AST instead of pattern-matching the
 * source text.
 *
 * @version v1.5.0-beta
 */

import ts from "typescript";
import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { join, relative, sep } from "node:path";

/** One `JsxText` node whose trimmed content is not empty. */
export interface JsxTextHit {
  /** Path to the file, relative to the repo root, with forward slashes. */
  file: string;
  /** 1-based source line of the node's first character. */
  line: number;
  /** The node's text, trimmed of leading/trailing whitespace. */
  text: string;
}

/**
 * True when `text` contains no Unicode letter — the mechanical half of "what
 * counts as a violation": punctuation and symbols alone (`/`, `@`, `—`, `✓`,
 * `%`, digits included) are never prose a reader reads, so they never need an
 * allowlist entry. This is a rule, not a judgement call, which is why it lives
 * in the detector rather than in the enumerated allowlist.
 */
export function isPunctuationOrSymbolOnly(text: string): boolean {
  return !/\p{L}/u.test(text);
}

/**
 * Collect non-whitespace `JsxText` nodes from one already-read source string.
 * `fileLabel` is used only to build `JsxTextHit.file` and never read from
 * disk, so this works equally on a real file's contents or an inline fixture.
 */
export function scanSourceForJsxText(fileLabel: string, sourceText: string): JsxTextHit[] {
  const sourceFile = ts.createSourceFile(
    fileLabel,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );

  const hits: JsxTextHit[] = [];

  function visit(node: ts.Node): void {
    if (ts.isJsxText(node)) {
      const trimmed = node.text.trim();
      if (trimmed !== "") {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        hits.push({ file: fileLabel, line: line + 1, text: trimmed });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return hits;
}

/** Read one `.tsx` file and scan it, reporting `file` relative to `repoRoot`. */
export function scanFileForJsxText(repoRoot: string, absolutePath: string): JsxTextHit[] {
  const sourceText = readFileSync(absolutePath, "utf-8");
  const label = relative(repoRoot, absolutePath).split(sep).join("/");
  return scanSourceForJsxText(label, sourceText);
}

/** Every `.tsx` file under `repoRoot`/`dirRel`, recursively, as absolute paths. */
function listTsxFilesUnder(repoRoot: string, dirRel: string): string[] {
  const dir = join(repoRoot, dirRel);
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true }) as Dirent[];
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/**
 * Every `.tsx` file under `app/components/**` and `app/routes/**`, relative to
 * `repoRoot` with forward slashes — the same shape `JsxTextHit.file` uses.
 */
export function listScannedFiles(repoRoot: string): string[] {
  const absolutePaths = [
    ...listTsxFilesUnder(repoRoot, "app/components"),
    ...listTsxFilesUnder(repoRoot, "app/routes"),
  ];
  return absolutePaths.map((absolutePath) => relative(repoRoot, absolutePath).split(sep).join("/")).sort();
}

/** Scan every file `listScannedFiles` names, in one flat list of hits. */
export function scanRepoForJsxText(repoRoot: string): JsxTextHit[] {
  return listScannedFiles(repoRoot).flatMap((relativePath) =>
    scanFileForJsxText(repoRoot, join(repoRoot, relativePath)),
  );
}
