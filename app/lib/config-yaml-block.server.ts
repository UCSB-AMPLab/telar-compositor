/**
 * Shared line-based walker for a single top-level block in a `_config.yml`
 * string (e.g. `google_sheets:`, `telar:`).
 *
 * The idiom below — split on `\n`, track a boolean "inside this block" flag,
 * enter on a bare `^blockKey:` line, exit on the next non-indented,
 * non-comment, non-empty line — was independently reimplemented in
 * commit.server.ts (`disableGoogleSheetsInConfig`, `isGoogleSheetsEnabled`),
 * upgrade.server.ts (`updateTelarVersionInConfig`), and sync.server.ts
 * (`extractTelarVersion`), each citing the others as its pattern ancestor.
 * This module is the single shared implementation those four now delegate
 * to; behaviour is unchanged, verified line-by-line against each original
 * before conversion.
 *
 * NOT converted: publish.server.ts's `protected:`/`telar:` block tracking
 * inside `updateConfigFields`. It shares the same enter/exit idiom but is
 * entangled, in the same loop, with multi-line quoted-scalar corruption
 * healing (`sweepingContinuation`) that must persist across block
 * boundaries — restructuring that publish-critical function was out of
 * scope for this batch.
 *
 * @version v1.4.0-beta
 */

/**
 * True when `line` is the non-indented, non-comment, non-blank line that
 * ends a block's child-line region. Identical exit test across all four
 * original implementations.
 */
function endsBlock(line: string): boolean {
  return /^[^\s#]/.test(line) && line.trim() !== "";
}

/**
 * Walks a `_config.yml` string's top-level `blockKey:` block line by line,
 * calling `mutateLine` for every line inside the block (the header line
 * itself is not passed). Returning a string replaces that line; returning
 * `null` keeps it unchanged. Lines outside the block are passed through
 * verbatim. No-op (returns `content` unchanged) if the block is absent.
 *
 * Scanning continues to the end of the file after the block closes (it does
 * not stop early) — matching `disableGoogleSheetsInConfig` and
 * `updateTelarVersionInConfig`, neither of which halted after the first
 * block occurrence.
 */
export function mutateYamlBlock(
  content: string,
  blockKey: string,
  mutateLine: (line: string) => string | null,
): string {
  const lines = content.split("\n");
  const headerRe = new RegExp(`^${blockKey}:`);
  let inBlock = false;
  const result: string[] = [];

  for (const line of lines) {
    if (headerRe.test(line)) {
      inBlock = true;
      result.push(line);
      continue;
    }

    if (inBlock) {
      if (endsBlock(line)) {
        inBlock = false;
      } else {
        const replaced = mutateLine(line);
        if (replaced !== null) {
          result.push(replaced);
          continue;
        }
      }
    }

    result.push(line);
  }

  return result.join("\n");
}

/**
 * Walks a `_config.yml` string's top-level `blockKey:` block line by line,
 * calling `matchLine` for every line inside the block and returning the
 * first defined result (short-circuits the walk). Returns `undefined` if
 * the block is absent or no child line matches.
 *
 * `haltAfterBlock` (default `false`, matching `isGoogleSheetsEnabled`'s
 * continue-scanning behaviour): when `true`, the walk stops entirely once
 * the block closes without a match, rather than continuing to scan for a
 * later occurrence of the same block key. `extractTelarVersion` relied on
 * this (it used `break`, not `continue`, at block end) — preserved via this
 * flag rather than silently changed.
 */
export function findInYamlBlock<T>(
  content: string,
  blockKey: string,
  matchLine: (line: string) => T | undefined,
  options: { haltAfterBlock?: boolean } = {},
): T | undefined {
  const lines = content.split("\n");
  const headerRe = new RegExp(`^${blockKey}:`);
  let inBlock = false;

  for (const line of lines) {
    if (headerRe.test(line)) {
      inBlock = true;
      continue;
    }

    if (inBlock) {
      if (endsBlock(line)) {
        inBlock = false;
        if (options.haltAfterBlock) break;
        continue;
      }
      const matched = matchLine(line);
      if (matched !== undefined) return matched;
    }
  }

  return undefined;
}
