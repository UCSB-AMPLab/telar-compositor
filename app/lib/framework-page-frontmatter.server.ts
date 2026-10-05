/**
 * Frontmatter the framework owns on the three built-in pages, and the merge
 * that delivers it to an existing site.
 *
 * `index.md`, `pages/glossary.md` and `pages/objects.md` ship framework
 * frontmatter above a body the author is invited to rewrite, so an upgrade
 * cannot deliver the file whole, and `applyTransformA` re-emits a site's
 * block verbatim. This merge is therefore the only way a key the framework
 * adds to these files reaches an existing site — `title_key`, which makes the
 * browser-tab title follow the site's language, is the case in point: without
 * it a translated site shows an English tab title.
 *
 * The merge adds a framework-owned key only where the site's frontmatter
 * lacks it, with the value the target release ships. It never changes a key
 * that is present, never touches the body, and keeps every byte of the file
 * it does not add, line endings included. A block it cannot read as a YAML
 * mapping, or a result it cannot read back, leaves the file as it was.
 *
 * `title_key` has one condition of its own. The layout lets a resolved
 * `title_key` win over `title`, so adding it to a page whose author retitled
 * it would replace their title in the browser tab. It is added only while
 * `title` is absent or still the framework's own.
 *
 * @version v1.5.0-beta
 */

import { parseYamlFailsafe } from "~/lib/yaml.server";

interface BuiltInPage {
  /** Keys the framework ships and an author has no reason to write. */
  frameworkOwned: readonly string[];
  /** Keys the framework ships as a default the author may change. */
  authorOwned: readonly string[];
  /** The `title` every framework release has shipped on this page. */
  shippedTitle: string;
}

export const BUILT_IN_PAGES: Readonly<Record<string, BuiltInPage>> = {
  "index.md": {
    frameworkOwned: ["layout", "title_key"],
    authorOwned: ["title"],
    shippedTitle: "Home",
  },
  "pages/glossary.md": {
    frameworkOwned: ["layout", "title_key", "permalink"],
    authorOwned: ["title"],
    shippedTitle: "Glossary",
  },
  "pages/objects.md": {
    frameworkOwned: ["layout", "title_key", "permalink"],
    authorOwned: ["title"],
    shippedTitle: "Objects in the Stories",
  },
};

/** Where a file's frontmatter block sits, by offset, and the line ending it uses. */
interface FrontmatterBlock {
  eol: "\n" | "\r\n";
  /** Offset of the first character inside the block. */
  innerStart: number;
  /** Offset of the closing `---` line. */
  closingStart: number;
}

function locateFrontmatter(content: string): FrontmatterBlock | null {
  const eol = content.startsWith("---\r\n") ? "\r\n" : content.startsWith("---\n") ? "\n" : null;
  if (!eol) return null;
  const innerStart = 3 + eol.length;
  let lineStart = innerStart;
  while (lineStart <= content.length) {
    const lineEnd = content.indexOf(eol, lineStart);
    const line = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd);
    if (line === "---") return { eol, innerStart, closingStart: lineStart };
    if (lineEnd === -1) return null;
    lineStart = lineEnd + eol.length;
  }
  return null;
}

/** A block's top-level keys and values, or null when it is not a mapping. */
function readMapping(inner: string): Record<string, unknown> | null {
  try {
    const parsed = inner.trim() === "" ? {} : parseYamlFailsafe(inner);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A value this merge can write as a plain scalar without quoting. */
const PLAIN_SCALAR = /^[A-Za-z0-9_./-]+$/;

/**
 * The frontmatter lines `path` should gain from `target`, the release's own
 * copy of the file. Empty when there is nothing to add or nothing safe to
 * write.
 */
function missingOwnedLines(
  page: BuiltInPage,
  site: Record<string, unknown>,
  target: Record<string, unknown>,
): string[] {
  const title = site.title;
  const titleIsTheFrameworks = title === undefined || title === null || title === page.shippedTitle;
  return page.frameworkOwned
    .filter((key) => !Object.hasOwn(site, key))
    .filter((key) => key !== "title_key" || titleIsTheFrameworks)
    .filter((key) => typeof target[key] === "string" && PLAIN_SCALAR.test(target[key] as string))
    .map((key) => `${key}: ${target[key] as string}`);
}

/**
 * The site's file with the framework-owned keys it lacks, or null when it
 * gains nothing or cannot be merged safely.
 */
export function mergeFrameworkFrontmatter(
  path: string,
  siteContent: string,
  targetContent: string,
): string | null {
  const page = BUILT_IN_PAGES[path];
  const siteBlock = locateFrontmatter(siteContent);
  const targetBlock = locateFrontmatter(targetContent);
  if (!page || !siteBlock || !targetBlock) return null;

  const site = readMapping(siteContent.slice(siteBlock.innerStart, siteBlock.closingStart));
  const target = readMapping(targetContent.slice(targetBlock.innerStart, targetBlock.closingStart));
  if (!site || !target) return null;

  const lines = missingOwnedLines(page, site, target);
  if (lines.length === 0) return null;

  const added = lines.map((line) => line + siteBlock.eol).join("");
  const merged =
    siteContent.slice(0, siteBlock.closingStart) + added + siteContent.slice(siteBlock.closingStart);

  // Read the result back. A block that parsed as a mapping can still be one a
  // line appended to its end would break — a flow mapping on one line is —
  // and a file the next build cannot parse is worse than one missing a key.
  const mergedBlock = locateFrontmatter(merged);
  const reread = mergedBlock && readMapping(merged.slice(mergedBlock.innerStart, mergedBlock.closingStart));
  const keysLanded = lines.every((line) => reread && Object.hasOwn(reread, line.slice(0, line.indexOf(":"))));
  return keysLanded ? merged : null;
}

/** What a release copy of a built-in page came back as. */
export type TargetPage = { kind: "found"; content: string } | { kind: "absent" } | { kind: "failed" };

export interface BuiltInPageReport {
  /** Pages whose frontmatter gained a key. */
  merged: string[];
  /** Pages the release copy could not be read for; left as they were. */
  unread: string[];
}

/**
 * Run the merge over the built-in pages in an upgrade's file set.
 *
 * `files` is the upgrade's virtual filesystem and is updated in place, only
 * for a page whose content changed. A page the site does not have is left
 * absent; this delivers keys, not files. A release copy that could not be
 * read is reported in `unread` rather than guessed at, and the page is left
 * as it was; the upgrade's prepare stops on it. A throw from either reader
 * propagates.
 */
export async function applyBuiltInPageFrontmatter(
  files: Map<string, string>,
  read: {
    site: (path: string) => Promise<string | null>;
    target: (path: string) => Promise<TargetPage>;
  },
): Promise<BuiltInPageReport> {
  const report: BuiltInPageReport = { merged: [], unread: [] };
  for (const path of Object.keys(BUILT_IN_PAGES)) {
    const siteContent = files.get(path) ?? (await read.site(path));
    if (siteContent === null) continue;
    const target = await read.target(path);
    if (target.kind === "failed") report.unread.push(path);
    if (target.kind !== "found") continue;
    const merged = mergeFrameworkFrontmatter(path, siteContent, target.content);
    if (merged === null) continue;
    files.set(path, merged);
    report.merged.push(path);
  }
  return report;
}
