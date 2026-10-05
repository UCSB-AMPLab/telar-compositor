/**
 * Classifies the manual steps of framework releases published before their
 * manifests could say what each step asks of its reader.
 *
 * The post-upgrade screen groups steps by `kind`: things to do, things that
 * may be done, and what changed. No published manifest carries a kind, and
 * most carry no `audience`, so without this table every step arrives as
 * something the screen cannot place. A published release asset cannot be
 * edited, so the classification lives here.
 *
 * A manifest's own `audience` and `kind` win over the table. Each entry is
 * keyed by the release a manifest installs and the step's position, and
 * guarded by a hash of the step's English and Spanish text: a step whose text
 * differs from the one classified is left as the manifest has it, which the
 * screen shows as unclassified rather than as a note. The audiences come from
 * the framework's own tagging of these steps (framework 1.8.0); the
 * kinds were ruled on 24 September 2026.
 *
 * The bundled manifests in `migrations/` carry their fields directly and are
 * not listed here.
 *
 * @version v1.5.0-beta
 */

import type { Language, ManualStep, Manifest, StepAudience, KnownStepKind } from "~/lib/manifest-schema.server";

interface Classified {
  audience: StepAudience;
  kind: KnownStepKind;
  /** `stepTextHash` of the English and Spanish descriptions. */
  en: string;
  es: string;
}

/**
 * A 53-bit hash of a step's text (cyrb53), as 14 hex digits. It guards
 * against a table entry applying to text it was not written for, so it only
 * needs to tell texts apart, and it has to run synchronously in the runner.
 */
export function stepTextHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** Keyed by the version a manifest installs (`to_version`); one entry per step, in order. */
export const PUBLISHED_STEP_CLASSIFICATION: Record<string, Classified[]> = {
  "1.2.1": [
    { audience: "all", kind: "note", en: "0c62e53d285501", es: "122558597b3588" },
  ],
  "1.3.0": [
    { audience: "all", kind: "note", en: "17a72674fa8dba", es: "13e1c204db13c6" },
  ],
  "1.4.0": [
    { audience: "all", kind: "action", en: "126948571f30e1", es: "010fb03d46f029" }, // re-apply customised language packs, in its last paragraph
  ],
  "1.5.0": [
    { audience: "local", kind: "action", en: "19a01e7e094db8", es: "1202a44d6fe411" },
    { audience: "all", kind: "action", en: "104daa541ad30b", es: "0fa72d8bd2fc22" }, // re-apply customised language packs
  ],
  "1.5.1": [
    { audience: "all", kind: "note", en: "008dc852c92b3f", es: "1d9ea380a49517" },
  ],
  "1.5.2": [
    { audience: "all", kind: "note", en: "1483bfe32e1a17", es: "1a9068c8acc143" },
  ],
  "1.5.3": [
    { audience: "all", kind: "note", en: "172aba4171c274", es: "1e0bd68b6c5326" },
    { audience: "all", kind: "note", en: "00119b77968704", es: "072ae2e45d63cf" }, // title_key; the Compositor's upgrade and publish write it
  ],
  "1.5.4": [
    { audience: "all", kind: "note", en: "17bc52d066f0b6", es: "0d05cce0cba2c9" },
    { audience: "local", kind: "action", en: "12b994e62e2f87", es: "121b29f23ae7ef" },
  ],
  "1.6.0": [
    { audience: "local", kind: "action", en: "162e89fab37b03", es: "13631a209c0ef5" },
    { audience: "all", kind: "action", en: "15d35c9eb27b84", es: "1658bfeb913378" }, // re-apply customised language packs
  ],
  "1.6.1": [
    { audience: "all", kind: "note", en: "1021da63fda1d4", es: "1ccb07fb8b9d95" },
  ],
  "1.6.2": [
    { audience: "local", kind: "action", en: "1dde8cdefad8fd", es: "0f098c1ad61663" },
    { audience: "local", kind: "action", en: "1c3f0a1c144cb3", es: "0ba5389700eb97" },
    { audience: "all", kind: "note", en: "11a7e8e567cf17", es: "005d744feabe36" },
  ],
  "1.7.0": [
    { audience: "local", kind: "action", en: "1ca5ab7f7b5a1b", es: "04b44361150788" },
    { audience: "local", kind: "action", en: "144bab687cb468", es: "1bc7017e932e63" },
    { audience: "local", kind: "optional", en: "0053f8ed9a1073", es: "01a48a2b264723" },
    { audience: "local", kind: "action", en: "16719da409a0dd", es: "17b474542e7794" },
    { audience: "all", kind: "note", en: "07c9e6f2d3e34c", es: "16093be002e5c6" },
  ],
};

/**
 * The manifest's steps in both languages, with `audience` and `kind` filled
 * from the table wherever the manifest leaves them unset and the step's text
 * is the text that was classified.
 */
export function classifyManualSteps(manifest: Manifest): Record<Language, ManualStep[]> {
  const entries = PUBLISHED_STEP_CLASSIFICATION[manifest.to_version] ?? [];
  const { en, es } = manifest.manual_steps;
  const matches = (i: number): boolean => {
    const entry = entries[i];
    return (
      entry !== undefined &&
      en[i] !== undefined &&
      es[i] !== undefined &&
      stepTextHash(en[i].description) === entry.en &&
      stepTextHash(es[i].description) === entry.es
    );
  };
  const fill = (steps: ManualStep[]): ManualStep[] =>
    steps.map((step, i) => {
      if (!matches(i)) return step;
      const { audience, kind } = entries[i];
      return { ...step, audience: step.audience ?? audience, kind: step.kind ?? kind };
    });
  return { en: fill(en), es: fill(es) };
}
