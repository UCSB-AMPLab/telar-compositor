/**
 * Saving a site's own glossary kinds: who may, the compare-and-swap against
 * the column the page read, the check against the core kinds read at save
 * time, and the first save over the kinds the config holds.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getDb } from "~/lib/db.server";
import { parseGlossaryKinds, type GlossaryKinds } from "~/lib/glossary-kinds";
import { saveGlossaryKinds, type SaveKindsRequest } from "~/lib/glossary-kinds-save.server";
import { asD1, createMemoryD1, type MemoryD1 } from "./helpers/d1-memory";

const CORE = `
- id: term
  default: true
  values: [term]
  panel_label: Key term
- id: place
  values: [place, lugar]
  panel_label: Place
`;

const CONFIG = `
glossary:
  kinds:
    - {id: species, label: Species, heading: Species, values: [taxon]}
    - {id: tribe, label: Tribe}
`;

const species = { id: "species", label: "Species", heading: "Species", values: ["taxon"] };
const repoKinds = (): GlossaryKinds => parseGlossaryKinds(CORE, CONFIG, null);

let memory: MemoryD1;

function stored(): string | null {
  const row = memory.raw.prepare("SELECT glossary_kinds_json AS k FROM project_config WHERE project_id = 1").get() as { k: string | null };
  return row.k;
}

function setStored(value: string | null): void {
  memory.raw.prepare("UPDATE project_config SET glossary_kinds_json = ? WHERE project_id = 1").run(value);
}

function save(overrides: Partial<SaveKindsRequest>) {
  return saveGlossaryKinds(getDb(asD1(memory)), {
    projectId: 1,
    role: "convenor",
    base: null,
    seenRepo: repoKinds().repoSite,
    headSha: "a",
    kinds: [species],
    readRepoKinds: async () => repoKinds(),
    ...overrides,
  });
}

beforeEach(() => {
  memory = createMemoryD1();
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      "VALUES (1, 1, 'u', 'e', 'e', '2099-01-01', '2099-01-01')",
  );
  memory.raw.exec("INSERT INTO projects (id, user_id, github_repo_full_name, installation_id, head_sha) VALUES (1, 1, 'o/a', 1, 'a')");
  memory.raw.exec("INSERT INTO project_config (project_id) VALUES (1)");
});

afterEach(() => memory.close());

describe("saveGlossaryKinds", () => {
  it("stores the canonical list over a column the page read as it is", async () => {
    setStored("[]");
    const result = await save({ base: "[]" });
    expect(result).toEqual({ ok: true, stored: JSON.stringify([species]), renamed: {} });
    expect(stored()).toBe(JSON.stringify([species]));
  });

  it("refuses a save over a column that changed since the page read it", async () => {
    setStored(JSON.stringify([species]));
    const result = await save({ base: "[]", kinds: [] });
    expect(result).toMatchObject({ ok: false, reason: "conflict", message: "kinds_conflict" });
    expect(stored()).toBe(JSON.stringify([species]));
  });

  it("refuses a save that read null once something is stored", async () => {
    setStored("[]");
    expect(await save({ base: null })).toMatchObject({ ok: false, reason: "conflict" });
    expect(stored()).toBe("[]");
  });

  it.each(["collaborator", "instructor"])("lets a %s save", async (role) => {
    expect(await save({ role })).toMatchObject({ ok: true });
  });

  it.each([["viewer"], [null]])("refuses %s and writes nothing", async (role) => {
    const readRepo = vi.fn(async () => repoKinds());
    expect(await save({ role, readRepoKinds: readRepo })).toMatchObject({ ok: false, reason: "forbidden" });
    expect(readRepo).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
  });

  it("stores an empty list, which replaces the config's kinds", async () => {
    expect(await save({ kinds: [] })).toEqual({ ok: true, stored: "[]", renamed: {} });
    expect(stored()).toBe("[]");
  });

  it("refuses a list holding a kind the framework would leave out, and writes none of it", async () => {
    const result = await save({ kinds: [species, { id: "tribe", label: "Tribe", heading: "" }] });
    expect(result).toEqual({
      ok: false,
      reason: "invalid",
      message: "kinds_save_failed",
      problems: [{}, { heading: { key: "kind_error_heading_required" } }],
    });
    expect(stored()).toBeNull();
  });

  it("checks a kind against the core kinds read at save time", async () => {
    const readRepo = vi.fn(async () => parseGlossaryKinds(`${CORE}- id: species\n  panel_label: Core species\n`, CONFIG, null));
    const result = await save({ readRepoKinds: readRepo });
    expect(readRepo).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: false,
      reason: "invalid",
      problems: [{ id: { key: "kind_error_id_taken", value: "species", kind: "Core species" } }],
    });
    expect(stored()).toBeNull();
  });

  it("refuses a site without core kinds, and a list that is not one", async () => {
    expect(await save({ readRepoKinds: async () => parseGlossaryKinds(null, CONFIG, null) })).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    expect(await save({ kinds: { id: "x" } })).toMatchObject({ ok: false, reason: "malformed" });
    expect(stored()).toBeNull();
  });
});

describe("the first save, over the config's kinds", () => {
  it("refuses when the config's kinds changed since the page showed them", async () => {
    const seenRepo = parseGlossaryKinds(CORE, "glossary:\n  kinds:\n    - {id: species, label: Species, heading: Species, values: [taxon]}\n", null).repoSite;
    expect(await save({ seenRepo })).toMatchObject({ ok: false, reason: "conflict", message: "kinds_conflict" });
    expect(await save({ seenRepo: undefined })).toMatchObject({ ok: false, reason: "conflict" });
    expect(stored()).toBeNull();
  });

  it("refuses a first save when a sync moves the project to another commit while it runs", async () => {
    const readRepoKinds = async () => {
      memory.raw.prepare("UPDATE projects SET head_sha = 'b' WHERE id = 1").run();
      return repoKinds();
    };
    expect(await save({ readRepoKinds })).toMatchObject({ ok: false, reason: "conflict" });
    expect(stored()).toBeNull();
  });

  it("writes a first save while the project is still at the commit it read, a null one included", async () => {
    memory.raw.prepare("UPDATE projects SET head_sha = NULL WHERE id = 1").run();
    expect(await save({ headSha: null })).toMatchObject({ ok: true });
    expect(stored()).toBe(JSON.stringify([species]));
  });

  it("does not ask what the page was shown of the config once a list is stored", async () => {
    setStored("[]");
    expect(await save({ base: "[]", seenRepo: "stale" })).toMatchObject({ ok: true });
  });

  it("offers the config's kinds with the rejected one marked, as the list the save replaces", () => {
    expect(repoKinds().site.map((k) => [k.id, k.problems])).toEqual([
      ["species", {}],
      ["tribe", { heading: { key: "kind_error_heading_required" } }],
    ]);
  });

  it("refuses the seeded list while the rejected kind is unfixed", async () => {
    const seeded = repoKinds().site.map(({ problems: _p, ...kind }) => ({ ...kind, from: kind.id }));
    expect(await save({ kinds: seeded })).toMatchObject({ ok: false, reason: "invalid" });
    expect(stored()).toBeNull();
  });

  it("stores the fixed kinds and reports each id the save changed, the rejected kind's included", async () => {
    const result = await save({
      kinds: [
        { ...species, id: "taxa", values: [], from: "species" },
        { id: "people", label: "Tribe", heading: "Tribes", values: [], from: "tribe" },
        { id: "new", label: "New", heading: "New", values: [], from: "not-a-kind" },
      ],
    });
    expect(result).toMatchObject({ ok: true, renamed: { species: "taxa", tribe: "people" } });
    expect(JSON.parse(stored() as string).map((k: { id: string }) => k.id)).toEqual(["taxa", "people", "new"]);
  });

  it("names renames against the stored list once there is one", async () => {
    setStored(JSON.stringify([{ id: "kept", label: "K", heading: "K", values: [] }]));
    const result = await save({
      base: stored(),
      kinds: [
        { id: "renamed", label: "K", heading: "K", values: [], from: "kept" },
        { id: "other", label: "S", heading: "S", values: [], from: "species" },
      ],
    });
    expect(result).toMatchObject({ ok: true, renamed: { kept: "renamed" } });
  });
});
