/**
 * The JSX-text scan's allowlist. Punctuation- and symbol-only nodes need no
 * entry here — `isPunctuationOrSymbolOnly` in `jsx-text-scan.ts` handles that
 * mechanically. Everything below is a judgement call on prose that carries at
 * least one letter, and every entry carries the reason for the call.
 *
 * Three shapes:
 *
 * `PROPER_NOUNS` matches by exact trimmed text, anywhere the scan finds it —
 * these are names that read the same in English and Spanish regardless of
 * which file or line they sit in, so the exemption is the string, not the
 * occurrence.
 *
 * `INVARIANT_NOTATION` matches the same way, for sigils rather than names: a
 * letter that labels a value in a formula-like readout and is not read as a
 * word in any language.
 *
 * `KNOWN_DEFECTS` matches by file, line AND text — these are real gaps a
 * catalogue key will close, tracked here only until the key lands. Keying on
 * the occurrence rather than the string means a future, unrelated appearance
 * of the same words is still caught: only the specific instance below is
 * excused, not the phrase.
 *
 * @version v1.5.0-beta
 */

/** An exact-text exemption that applies wherever the scan finds it. */
export interface ProperNounEntry {
  text: string;
  reason: string;
}

/** A sigil exemption that applies wherever the scan finds it. */
export interface InvariantNotationEntry {
  text: string;
  reason: string;
}

/** An exemption tied to one file and line, for a defect fixed elsewhere. */
export interface KnownDefectEntry {
  file: string;
  line: number;
  text: string;
  reason: string;
}

export const PROPER_NOUNS: ProperNounEntry[] = [
  { text: "GitHub", reason: "product name, unchanged in Spanish — named in the scan's brief" },
  {
    text: "GitHub Pages",
    reason: "product name, unchanged in Spanish — named in the scan's brief",
  },
  {
    text: "GitHub Pages:",
    reason:
      "the same product name as a diagnostic label (CommitAndBuildModal.tsx, SiteConfigConfirmation.tsx) — the colon is the label's own punctuation, not translatable content",
  },
  { text: "Compositor", reason: "product name, unchanged in Spanish — named in the scan's brief" },
  { text: "Staging", reason: "environment name, unchanged in Spanish — named in the scan's brief" },
  { text: "Telar", reason: "framework name, unchanged in Spanish — named in the scan's brief" },
  {
    text: "AMPL · Neogranadina",
    reason: "the lab and foundation's own names, joined by a separator — no prose between them",
  },
  {
    text: "English",
    reason: "a language's own name, in the language picker's <option> — shown untranslated by design",
  },
  {
    text: "Español",
    reason: "a language's own name, in the language picker's <option> — shown untranslated by design",
  },
  {
    text: "_config.yml:",
    reason:
      "a literal Jekyll filename as a diagnostic label (CommitAndBuildModal.tsx, SiteConfigConfirmation.tsx) — the name does not change between languages and the colon is the label's own punctuation",
  },
];

export const INVARIANT_NOTATION: InvariantNotationEntry[] = [
  {
    text: "v",
    reason:
      "the version sigil in `v{VERSION}` (Footer.tsx) — a number's prefix in a version string, not a word, and written the same in Spanish",
  },
  {
    text: "· v",
    reason: "the same sigil after a separator, in the release heading (WhatsNewModal.tsx)",
  },
  {
    text: "x",
    reason:
      "an axis label in the viewer's coordinate readout (ViewerBottomBar.tsx) — x, y and z name the axes of the image space and are not translated in any language",
  },
  { text: "y", reason: "the second axis label of the same readout" },
  { text: "z", reason: "the zoom axis label of the same readout" },
];

export const KNOWN_DEFECTS: KnownDefectEntry[] = [];
