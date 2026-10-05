/**
 * Which repository paths belong to the Telar framework rather than to the
 * author: the path lists and the predicate over them.
 *
 * The upgrade diffs and the publish-time heal deliver these paths from the
 * framework release, and the commit primitives write them byte for byte, since
 * the upgrade compares each one to the release by blob hash. Kept apart from
 * `upgrade.server.ts` so `commit.server.ts` can ask the question without
 * loading the upgrade flow and its bundled manifests; `upgrade.server.ts`
 * re-exports all three names.
 *
 * @version v1.5.0-beta
 */

/** Path prefixes that belong to the Telar framework (not user content). */
export const FRAMEWORK_PREFIXES = [
  "_layouts/",
  "_includes/",
  "_sass/",
  "assets/",
  "scripts/",
  ".github/workflows/",
  "_data/languages/",
  "_data/themes/",
] as const;

/** Individual files that belong to the Telar framework.
 *
 * Dependency manifests (package.json, package-lock.json, Gemfile, Gemfile.lock,
 * requirements.txt) must travel with upgrades: the framework's JS/Ruby/Python
 * build steps break when source files (e.g. scroll-engine.js) import libraries
 * that haven't been added to the user's manifest. Before they were listed here,
 * upgrades shipped new framework code without bumping the deps and CI failed with
 * unresolved-module errors.
 *
 * package-lock.json specifically: the framework now builds user sites with
 * `npm install` (no lockfile required), so it is NOT delivered universally. The
 * publish-time heal scopes lockfile delivery to legacy sites whose
 * .github/workflows/build.yml still runs `npm ci` — those break at the build
 * step without a committed lockfile. See healMissingFrameworkFiles /
 * buildYmlUsesNpmCi. It stays listed here so findMissingFrameworkFiles still
 * detects its absence; the heal then decides whether to actually deliver it.
 */
export const FRAMEWORK_FILES = [
  "_data/navigation.yml",
  // Framework-owned KaTeX config and the glossary's core entry kinds. Their
  // consumers (_includes/katex.html, the layouts, assets/js/katex-loader.js,
  // the build's glossary_kinds.py) are prefix-delivered, but _data/ is only
  // covered via languages/ and themes/, so each file must be listed here
  // explicitly.
  "_data/katex.yml",
  "_data/glossary_kinds.yml",
  "CHANGELOG.md",
  // README.md is the only v1.3.0 framework file not covered by FRAMEWORK_PREFIXES.
  "README.md",
  // Dependency manifests — source files assume these deps, CI fails otherwise.
  // package-lock.json is listed for detection only; the heal delivers it just to
  // legacy `npm ci` sites (see the package-lock.json note above).
  "package.json",
  "package-lock.json",
  "Gemfile",
  "Gemfile.lock",
  "requirements.txt",
  // Framework-owned root files users don't customise.
  "LICENSE",
  "NOTICE",
  "pytest.ini",
  "vitest.config.js",
  // Root dotfiles. Every prefix above names a directory, so a file at the root
  // whose name begins with a dot is covered by nothing unless it is listed
  // here. .ruby-version pins the interpreter a local build needs, and v1.7.0's
  // upgrade instructions tell the reader it arrived; .gitattributes marks the
  // generated JS bundles so diffs collapse them and language statistics count
  // only source. A site upgraded without .ruby-version gets it back through the
  // publish-time heal, which restores a listed file that is absent; a stale
  // .gitattributes is present, so only a later upgrade refreshes it.
  ".ruby-version",
  ".gitattributes",
] as const;

/**
 * Framework files that a site owns once it has one. An upgrade delivers each
 * only where the site has none, and never replaces or deletes the site's copy.
 *
 * `_data/navigation.yml` is the site's menu. Publish writes it from the
 * navigation edited in the Compositor, and an author working locally edits it
 * by hand, as the template's own header comment tells them to. A copy that
 * differs from the release's is therefore the site's menu, not a stale
 * framework file, and replacing it would publish the template's menu until
 * the next publish. The framework's own migrations have not replaced it since
 * v0.9.0; a change of its shape would come as a manifest operation, as
 * `_config.yml` changes do.
 */
export const DELIVERED_WHEN_ABSENT: readonly string[] = ["_data/navigation.yml"];

/**
 * Returns true if the given path belongs to the Telar framework and should be
 * updated during an upgrade.
 *
 * Note: _config.yml always returns false — it is handled separately via
 * updateTelarVersionInConfig to avoid overwriting user values.
 */
export function isFrameworkPath(path: string): boolean {
  if (path === "_config.yml") return false;
  if ((FRAMEWORK_FILES as readonly string[]).includes(path)) return true;
  return (FRAMEWORK_PREFIXES as readonly string[]).some((prefix) =>
    path.startsWith(prefix),
  );
}
