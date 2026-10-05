/**
 * User-facing text sitting in JSX rather than in a catalogue.
 *
 * The i18n parity test (`i18n-parity.test.ts`) compares the English and
 * Spanish catalogues against each other, so it is blind to a string that was
 * never put in either — `ClipTimeline.tsx` rendering `✓ Clip saved` with no
 * `useTranslation` at all is exactly that shape of miss. This test
 * closes that direction: it walks every `.tsx` file under `app/components`
 * and `app/routes` with the TypeScript compiler API and fails on a `JsxText`
 * node that is prose a reader reads, rather than punctuation, a symbol, or a
 * name from the allowlist below.
 *
 * A regex was tried and discarded before this was written: `Promise<void>`
 * reads as a JSX text node of `Promise` to any pattern matching `>...<`, and
 * `{cond && (` inside JSX matches the same way. Parsing the source instead of
 * pattern-matching it is what tells those apart from real JSX text.
 *
 * This does not cover attribute strings (`aria-label`, `title`, `placeholder`,
 * `alt`) — a real gap, and a bigger one, left for its own change.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  isPunctuationOrSymbolOnly,
  listScannedFiles,
  scanRepoForJsxText,
  scanSourceForJsxText,
  type JsxTextHit,
} from "./helpers/jsx-text-scan";
import { INVARIANT_NOTATION, KNOWN_DEFECTS, PROPER_NOUNS } from "./helpers/jsx-text-allowlist";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** True when `hit` is excused by any of the three allowlist categories. */
function isAllowlisted(hit: JsxTextHit): boolean {
  if (PROPER_NOUNS.some((entry) => entry.text === hit.text)) return true;
  if (INVARIANT_NOTATION.some((entry) => entry.text === hit.text)) return true;
  return KNOWN_DEFECTS.some(
    (entry) => entry.file === hit.file && entry.line === hit.line && entry.text === hit.text,
  );
}

/** Every hit the scan finds, after the mechanical punctuation/symbol rule. */
function proseHits(hits: JsxTextHit[]): JsxTextHit[] {
  return hits.filter((hit) => !isPunctuationOrSymbolOnly(hit.text));
}

describe("JSX text scan — app/components and app/routes", () => {
  it("finds no un-allowlisted prose in a JsxText node", () => {
    const violations = proseHits(scanRepoForJsxText(repoRoot)).filter((hit) => !isAllowlisted(hit));
    expect(violations).toEqual([]);
  });

  it("every KNOWN_DEFECTS entry still matches a node the scan currently flags", () => {
    // Catches a stale entry: once the catalogue key lands, the text this
    // names should stop appearing here, and this test should then fail until
    // the entry is removed — not linger silently.
    const allHits = scanRepoForJsxText(repoRoot);
    const stale = KNOWN_DEFECTS.filter(
      (entry) =>
        !allHits.some(
          (hit) => hit.file === entry.file && hit.line === entry.line && hit.text === entry.text,
        ),
    );
    expect(stale).toEqual([]);
  });

  it("scans every .tsx file under app/components and app/routes, and nothing else", () => {
    const files = listScannedFiles(repoRoot);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.startsWith("app/components/") || file.startsWith("app/routes/")).toBe(true);
      expect(file.endsWith(".tsx")).toBe(true);
    }
  });
});

describe("JSX text scan — detector fixtures", () => {
  it("fails a fixture with a bare string", () => {
    const source = `
      export function Fixture() {
        return <p>Please confirm before you continue.</p>;
      }
    `;
    const hits = proseHits(scanSourceForJsxText("fixture.tsx", source));
    expect(hits).toEqual([
      { file: "fixture.tsx", line: 3, text: "Please confirm before you continue." },
    ]);
  });

  it("passes a fixture using {t(\"key\")}", () => {
    const source = `
      export function Fixture() {
        const { t } = useTranslation();
        return <p>{t("fixture.message")}</p>;
      }
    `;
    expect(proseHits(scanSourceForJsxText("fixture.tsx", source))).toEqual([]);
  });

  it("passes a fixture with Promise<void> in a type position", () => {
    // The exact case a regex matching `>...<` cannot tell from JSX text: a
    // generic type argument, never a child of a JSX element.
    const source = `
      export function Fixture(): JSX.Element {
        async function run(): Promise<void> {
          return;
        }
        return <button onClick={() => { void run(); }}>{"" /* no prose */}</button>;
      }
    `;
    expect(proseHits(scanSourceForJsxText("fixture.tsx", source))).toEqual([]);
  });

  it("passes a fixture with {cond && (...)} inside JSX", () => {
    // The other case a `>...<` regex confuses with text: a brace-delimited
    // expression container, not a JsxText node.
    const source = `
      export function Fixture({ cond }: { cond: boolean }) {
        return (
          <div>
            {cond && (
              <span>{"" /* no prose */}</span>
            )}
          </div>
        );
      }
    `;
    expect(proseHits(scanSourceForJsxText("fixture.tsx", source))).toEqual([]);
  });

  it("passes a fixture with an allowlisted proper noun", () => {
    const source = `
      export function Fixture() {
        return <a href="https://github.com">GitHub</a>;
      }
    `;
    const hits = proseHits(scanSourceForJsxText("fixture.tsx", source));
    expect(hits).toEqual([{ file: "fixture.tsx", line: 3, text: "GitHub" }]);
    expect(hits.every((hit) => PROPER_NOUNS.some((entry) => entry.text === hit.text))).toBe(true);
  });

  it("passes a fixture with an allowlisted notation sigil", () => {
    // `v` and `x` carry a letter, so the mechanical punctuation rule cannot
    // excuse them; they are sigils labelling an adjacent value, and the
    // allowlist is where that judgement is recorded.
    const source = `
      export function Fixture({ version, coords }: FixtureProps) {
        return (
          <footer>
            <span>v{version}</span>
            <span>x {coords.x.toFixed(3)}</span>
          </footer>
        );
      }
    `;
    const hits = proseHits(scanSourceForJsxText("fixture.tsx", source));
    expect(hits.map((hit) => hit.text)).toEqual(["v", "x"]);
    expect(hits.every((hit) => isAllowlisted(hit))).toBe(true);
  });

  it("gives every allowlist entry a reason", () => {
    // An entry with no reason is how a detector becomes decoration: the
    // exemption outlives the argument for it and nobody can tell which.
    const entries = [...PROPER_NOUNS, ...INVARIANT_NOTATION, ...KNOWN_DEFECTS];
    expect(entries.filter((entry) => entry.reason.trim() === "")).toEqual([]);
  });

  it("treats punctuation and symbols alone as never a violation", () => {
    for (const text of ["/", "@", "—", "✓", "%", ":", "…", "•", "42"]) {
      expect(isPunctuationOrSymbolOnly(text), text).toBe(true);
    }
    for (const text of ["v", "x", "GitHub", "clip"]) {
      expect(isPunctuationOrSymbolOnly(text), text).toBe(false);
    }
  });
});
