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
 * publish.server.ts's `telar:` version heal now delegates here too (a
 * separable pre-pass, verified byte-identical), and its `updateConfigBlocks`
 * takes block boundaries and child indent from `findYamlBlockRegions` below
 * while keeping its policy (replace/insert/append, flow-style refusal, EOL
 * normalisation) at the call site. Two deliberate stay-locals: the
 * `protected:` story_key tracking in `updateConfigFields` (the single-pass
 * ordering against a top-level `story_key:` line is load-bearing — a
 * top-level key seen first suppresses the protected write — which
 * independent block passes cannot reproduce), and
 * `stripManagedStringScalars` (its sweep state is unterminated-quoted-scalar
 * line classification, not block traversal).
 *
 * Alongside the block walkers this module also owns `configLineRegex` /
 * `readConfigScalar`, the single top-level `key: value` line matcher that
 * create-site (`buildBornCleanConfig`, `rewriteConfigUrl`), commit
 * (`verifySiteUrl`), and onboarding (`fix-site-config`) share so a rewrite
 * and a read of the same line never disagree about its shape.
 *
 * @version v1.4.2-beta
 */

/**
 * True when `line` is the non-indented, non-comment, non-blank line that
 * ends a block's child-line region. Identical exit test across all four
 * original implementations.
 */
function endsBlock(line: string): boolean {
  return /^[^\s#]/.test(line) && line.trim() !== "";
}

/** One occurrence of a top-level `blockKey:` block within a lines array. */
export interface YamlBlockRegion {
  /** Index of the `blockKey:` header line. */
  headerIdx: number;
  /**
   * Index of the first line AFTER the child region (exclusive) — the first
   * endsBlock line following the header, or lines.length when the block runs
   * to EOF. Blank and comment lines inside the region are part of it.
   */
  regionEnd: number;
  /**
   * Indent of the region's first non-comment child line; "  " when the
   * region has none (matching updateConfigBlocks' insertion default).
   */
  childIndent: string;
}

/**
 * Locates every occurrence of a top-level `blockKey:` block in `lines`,
 * in order. This is the boundary rule the two walkers below and
 * publish.server's `updateConfigBlocks` all share (and which was
 * independently reimplemented before this primitive existed): a block starts
 * at a non-indented `blockKey:` line and its child region runs until the
 * next non-indented, non-comment, non-blank line. A same-key header line is
 * itself such a line, so back-to-back duplicate blocks yield adjacent
 * regions (region N's regionEnd === region N+1's headerIdx).
 *
 * `blockKey` is treated as a literal key, not a regex (all callers pass
 * fixed identifiers such as "telar" or "story_interface").
 */
export function findYamlBlockRegions(lines: string[], blockKey: string): YamlBlockRegion[] {
  const headerRe = new RegExp(`^${blockKey}:`);
  const regions: YamlBlockRegion[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!headerRe.test(lines[i])) {
      i++;
      continue;
    }
    const headerIdx = i;
    let regionEnd = headerIdx + 1;
    while (regionEnd < lines.length && !endsBlock(lines[regionEnd])) {
      regionEnd++;
    }
    let childIndent = "  ";
    for (let j = headerIdx + 1; j < regionEnd; j++) {
      if (/^\s*#/.test(lines[j])) continue;
      const m = lines[j].match(/^(\s+)\S/);
      if (m) {
        childIndent = m[1];
        break;
      }
    }
    regions.push({ headerIdx, regionEnd, childIndent });
    // Resume AT regionEnd, not after it: that line may itself be the next
    // occurrence's header (adjacent duplicate blocks).
    i = Math.max(regionEnd, headerIdx + 1);
  }
  return regions;
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
  for (const region of findYamlBlockRegions(lines, blockKey)) {
    for (let i = region.headerIdx + 1; i < region.regionEnd; i++) {
      const replaced = mutateLine(lines[i]);
      if (replaced !== null) lines[i] = replaced;
    }
  }
  return lines.join("\n");
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
  const regions = findYamlBlockRegions(lines, blockKey);

  for (let r = 0; r < regions.length; r++) {
    const region = regions[r];
    for (let i = region.headerIdx + 1; i < region.regionEnd; i++) {
      const matched = matchLine(lines[i]);
      if (matched !== undefined) return matched;
    }
    if (options.haltAfterBlock) {
      // The original walker's halt fired on an endsBlock line; an ADJACENT
      // same-key header was consumed as a header before the halt could fire,
      // so scanning continued through it. Preserve that: only halt when the
      // next region (if any) is not flush against this one.
      const next = regions[r + 1];
      if (!next || next.headerIdx !== region.regionEnd) break;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Top-level scalar line matching
// ---------------------------------------------------------------------------

/**
 * Regex for a top-level `key: value` line in `_config.yml`, capturing the
 * prefix ($1 — `key:` plus the whitespace after it) and any trailing
 * whitespace plus inline comment ($2) so a rewrite can preserve the comment.
 * The value itself sits between the two captures and matches a double-quoted,
 * single-quoted, or bare scalar; a bare value stops at the first `#`, so an
 * inline comment is never swallowed into it.
 *
 * Shared by create-site (`buildBornCleanConfig`, `rewriteConfigUrl`), commit
 * (`verifySiteUrl`), and onboarding (`fix-site-config`) so those call sites
 * never disagree about line shape — a mismatch silently half-rewrites, or
 * mis-reads, a config. A `key: value  # comment` line rewrites to
 * `key: newvalue  # comment` (via `$1newvalue$2`), and reads back as `value`,
 * never `value  # comment`.
 */
export function configLineRegex(key: string): RegExp {
  return new RegExp(
    `^(${key}:\\s*)(?:"[^"\\n]*"|'[^'\\n]*'|[^\\n#]*?)?(\\s*(?:#.*)?)$`,
    "m",
  );
}

/**
 * Reads a top-level `key:` scalar from a `_config.yml` string via
 * `configLineRegex`, returning the value with any surrounding matched quotes
 * removed and surrounding whitespace trimmed, or `undefined` when the key's
 * line is absent. This is the read counterpart to create-site's rewrite path:
 * it understands the same double-quoted / single-quoted / bare shapes and
 * never folds an inline comment into the returned value (the exact failure
 * mode of the anchored `^url:\s*"?([^"\n]+)"?\s*$` regex this replaces).
 */
export function readConfigScalar(content: string, key: string): string | undefined {
  const m = content.match(configLineRegex(key));
  if (!m) return undefined;
  // The value is the full match minus the captured prefix ($1) and trailing
  // whitespace-plus-comment ($2). Strip a matching surrounding quote pair.
  const raw = m[0].slice(m[1].length, m[0].length - m[2].length).trim();
  if (
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'")))
  ) {
    return raw.slice(1, raw.length - 1);
  }
  return raw;
}
