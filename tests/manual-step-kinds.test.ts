/**
 * The classification of published manual steps, and the grouping the
 * post-upgrade screen makes of them.
 *
 * The fixtures in `fixtures/release-manifests/` are the `migration.json`
 * assets of framework releases 1.2.1 to 1.7.0 as published.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { PUBLISHED_STEP_CLASSIFICATION, classifyManualSteps, stepTextHash } from "~/lib/manual-step-kinds.server";
import { validateManifest, type Manifest, type ManualStep } from "~/lib/manifest-schema.server";
import { applyManifestChain } from "~/lib/manifest-runner.server";
import { BUNDLED_MANIFESTS } from "../migrations";
import { groupManualSteps } from "~/components/features/upgrade/PostUpgradeSteps";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "release-manifests");
const PUBLISHED = ["1.2.1", "1.3.0", "1.4.0", "1.5.0", "1.5.1", "1.5.2", "1.5.3", "1.5.4", "1.6.0", "1.6.1", "1.6.2", "1.7.0"];
const published = (version: string): Manifest =>
  validateManifest(JSON.parse(readFileSync(join(fixtures, `v${version}.json`), "utf-8")));

/** The chain a site on `from` walks to 1.7.0: bundled first, then published. */
function chainFrom(from: string): Manifest[] {
  const all = [...BUNDLED_MANIFESTS, ...PUBLISHED.map(published)];
  const start = all.findIndex((m) => m.from_version === from);
  return all.slice(start);
}

const leads = (steps: ManualStep[]) => steps.map((s) => s.description.split("\n")[0].slice(0, 40));

describe("the published-step table", () => {
  it("covers every step of every published release, in both languages", () => {
    for (const version of PUBLISHED) {
      const m = published(version);
      const entries = PUBLISHED_STEP_CLASSIFICATION[m.to_version];
      expect(entries, version).toHaveLength(m.manual_steps.en.length);
      expect(m.manual_steps.es).toHaveLength(m.manual_steps.en.length);
      m.manual_steps.en.forEach((step, i) => {
        expect(stepTextHash(step.description), `${version} #${i + 1} en`).toBe(entries[i].en);
        expect(stepTextHash(m.manual_steps.es[i].description), `${version} #${i + 1} es`).toBe(entries[i].es);
      });
    }
  });

  it("fills audience and kind in both languages", () => {
    const { en, es } = classifyManualSteps(published("1.6.0"));
    expect(en.map((s) => [s.audience, s.kind])).toEqual([
      ["local", "action"],
      ["all", "action"],
    ]);
    expect(es.map((s) => [s.audience, s.kind])).toEqual(en.map((s) => [s.audience, s.kind]));
  });

  it("leaves a step as the manifest has it when either language's text differs from the one classified", () => {
    const m = published("1.5.1");
    for (const lang of ["en", "es"] as const) {
      const edited = { ...m, manual_steps: { ...m.manual_steps, [lang]: [{ description: "Other text." }] } };
      const { en, es } = classifyManualSteps(edited);
      expect([en[0].kind, es[0].kind], lang).toEqual([undefined, undefined]);
    }
  });

  it("holds the approved classification, step by step", () => {
    const approved: Record<string, string[]> = {
      "0.9.3-beta": ["local note", "local action"],
      "0.9.4-beta": ["local note", "local action"],
      "1.0.0-beta": ["local action", "local action"],
      "1.1.0": ["all note"],
      "1.2.0": ["all note"],
      "1.2.1": ["all note"],
      "1.3.0": ["all note"],
      "1.4.0": ["all action"],
      "1.5.0": ["local action", "all action"],
      "1.5.1": ["all note"],
      "1.5.2": ["all note"],
      "1.5.3": ["all note", "all note"],
      "1.5.4": ["all note", "local action"],
      "1.6.0": ["local action", "all action"],
      "1.6.1": ["all note"],
      "1.6.2": ["local action", "local action", "all note"],
      "1.7.0": ["local action", "local action", "local optional", "local action", "all note"],
    };
    const actual: Record<string, string[]> = {};
    for (const m of chainFrom("0.9.2-beta")) {
      const { en, es } = classifyManualSteps(m);
      expect(es.map((s) => `${s.audience} ${s.kind}`), m.to_version).toEqual(en.map((s) => `${s.audience} ${s.kind}`));
      actual[m.to_version] = en.map((s) => `${s.audience} ${s.kind}`);
    }
    expect(actual).toEqual(approved);
  });

  it("lets a manifest's own audience and kind win", () => {
    const m = published("1.7.0");
    expect(m.manual_steps.en[0].audience).toBe("local");
    const own = {
      ...m,
      manual_steps: {
        en: m.manual_steps.en.map((s, i) => (i === 4 ? { ...s, kind: "optional", audience: "google-sheets" } : s)),
        es: m.manual_steps.es,
      },
    };
    const step = classifyManualSteps(own).en[4];
    expect([step.audience, step.kind]).toEqual(["google-sheets", "optional"]);
  });

  it("classifies nothing for a release it does not list", () => {
    const m = { ...published("1.7.0"), from_version: "1.7.0", to_version: "1.8.0" };
    expect(classifyManualSteps(m).en.every((s) => s.kind === undefined)).toBe(true);
  });
});

describe("what a Compositor user is shown after an upgrade", () => {
  it("from 1.6.2 to 1.7.0: nothing to do, and one note", () => {
    const manualSteps = applyManifestChain(chainFrom("1.6.2"), new Map(), "en").manualSteps.en;
    const grouped = groupManualSteps(manualSteps, false);
    expect([grouped.actions, grouped.optional, grouped.unclassified]).toEqual([[], [], []]);
    expect(leads(grouped.notes)).toEqual(["**What changed for your content.** Carou"]);
  });

  it("from 1.2.0 to 1.7.0: the language-pack step three times, and everything else as news", () => {
    const manualSteps = applyManifestChain(chainFrom("1.2.0"), new Map(), "es").manualSteps.es;
    const grouped = groupManualSteps(manualSteps, false);
    expect(grouped.actions).toHaveLength(3);
    expect(grouped.actions.every((s) => s.audience === "all")).toBe(true);
    expect([grouped.optional, grouped.unclassified]).toEqual([[], []]);
    expect(grouped.notes).toHaveLength(10);
  });

  it("from 0.9.2-beta: every bundled step is placed", () => {
    const manualSteps = applyManifestChain(chainFrom("0.9.2-beta"), new Map(), "en").manualSteps.en;
    expect(manualSteps.every((s) => s.kind !== undefined)).toBe(true);
  });
});

describe("groupManualSteps", () => {
  const step = (kind: string | undefined, audience?: string): ManualStep => ({ description: `${kind}/${audience}`, kind, audience });

  it("filters by audience before it groups", () => {
    const grouped = groupManualSteps([step("action", "local"), step("action", "google-sheets"), step("action")], false);
    expect(grouped.actions.map((s) => s.description)).toEqual(["action/undefined"]);
    expect(groupManualSteps([step("action", "google-sheets")], true).actions).toHaveLength(1);
  });

  it("keeps a step with no kind, or one it does not know, out of the notes", () => {
    const grouped = groupManualSteps([step(undefined), step("checklist"), step("note"), step("optional")], false);
    expect(grouped.unclassified.map((s) => s.kind)).toEqual([undefined, "checklist"]);
    expect(grouped.notes).toHaveLength(1);
    expect(grouped.optional).toHaveLength(1);
  });

  it("shows a step whose audience it does not know", () => {
    expect(groupManualSteps([step("note", "teachers")], false).notes).toHaveLength(1);
  });
});
