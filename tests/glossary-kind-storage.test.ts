/**
 * Where a glossary entry's kind lives: the migration that moves it out of the
 * custom columns, the import that keeps it out of them, and the server read of
 * the site's kinds.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GLOSSARY_CANONICAL_SCOPE, mapGlossaryCsv, parseTelarCsv } from "~/lib/import.server";

vi.mock("~/lib/crypto.server", () => ({ decrypt: async () => "token" }));
const getFileAtRef = vi.fn();
vi.mock("~/lib/github.server", () => ({ getFileAtRef: (...a: unknown[]) => getFileAtRef(...a) }));

import { clearGlossaryKindsCache, readGlossaryKinds } from "~/lib/glossary-kinds.server";
import { saveGlossaryKinds } from "~/lib/glossary-kinds-save.server";
import { getDb } from "~/lib/db.server";
import { asD1, createMemoryD1 } from "./helpers/d1-memory";

const MIGRATIONS = join(__dirname, "..", "app", "db", "migrations");
const kindMigrationSql = (name: string) => readFileSync(join(MIGRATIONS, name), "utf-8");

describe("0066_glossary_kind", () => {
  it("moves a kind out of the custom columns and leaves every other row as it was", () => {
    const db = new DatabaseSync(":memory:");
    const before = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f < "0066").sort();
    for (const file of before) db.exec(kindMigrationSql(file));
    db.exec("PRAGMA foreign_keys = OFF");
    const rows: Array<[string, string | null]> = [
      ["moved", JSON.stringify({ kind: "source", note: "x" })],
      ["only-kind", JSON.stringify({ kind: "Fuente_Primaria" })],
      ["no-kind", JSON.stringify({ note: "x" })],
      ["not-json", "{broken"],
      ["none", null],
    ];
    for (const [term, extras] of rows) {
      db.prepare("INSERT INTO glossary_terms (project_id, term_id, extra_columns) VALUES (1, ?, ?)").run(term, extras);
    }
    db.exec(kindMigrationSql("0066_glossary_kind.sql"));
    const out = db.prepare("SELECT term_id, kind, extra_columns FROM glossary_terms ORDER BY id").all();
    expect(out.map((r) => ({ ...r }))).toEqual([
      { term_id: "moved", kind: "source", extra_columns: JSON.stringify({ note: "x" }) },
      { term_id: "only-kind", kind: "Fuente_Primaria", extra_columns: "{}" },
      { term_id: "no-kind", kind: null, extra_columns: JSON.stringify({ note: "x" }) },
      { term_id: "not-json", kind: null, extra_columns: "{broken" },
      { term_id: "none", kind: null, extra_columns: null },
    ]);
  });
});

describe("importing a glossary sheet's kind", () => {
  const kindsImported = (csv: string) => mapGlossaryCsv(parseTelarCsv(csv, undefined, false, GLOSSARY_CANONICAL_SCOPE));

  it.each([
    ["kind", "place"],
    ["tipo", "place"],
    ["Kind", "place"],
    ["kind", "Fuente?"],
  ])("takes a %s column holding %s into the kind and out of the custom columns", (header, value) => {
    const [term] = kindsImported(`term_id,title,definition,${header},note\ncarta,Carta,Una carta,${value},mine\n`);
    expect(term.kind).toBe(value);
    expect(JSON.parse(term.extra_columns as string)).toEqual({ note: "mine" });
  });

  it("holds no kind for a blank cell or a sheet without the column", () => {
    expect(kindsImported("term_id,title,definition,kind\ncarta,Carta,Una carta,\n")[0].kind).toBeUndefined();
    expect(kindsImported("term_id,title,definition\ncarta,Carta,Una carta\n")[0].kind).toBeUndefined();
  });
});

describe("readGlossaryKinds", () => {
  const project = { id: 1, github_repo_full_name: "o/r", head_sha: "abc" };
  const kindsFileOk = (content: string) => ({ status: "ok", content });
  beforeEach(() => {
    getFileAtRef.mockReset();
    clearGlossaryKindsCache();
  });

  it("offers no kinds for a site that has no glossary_kinds.yml", async () => {
    getFileAtRef.mockImplementation(async (_t, _o, _r, path: string) =>
      path === "_config.yml" ? kindsFileOk("title: x") : { status: "absent" },
    );
    const kinds = await readGlossaryKinds({ ENCRYPTION_KEY: "k" } as Env, "enc", project);
    expect(kinds.available).toBe(false);
  });

  it("reads the three files at the project's commit and keeps a complete read", async () => {
    getFileAtRef.mockImplementation(async (_t, _o, _r, path: string) => {
      if (path === "_data/glossary_kinds.yml") return kindsFileOk("- id: term\n  default: true\n  panel_label: panels.k\n");
      if (path === "_data/languages/es.yml") return kindsFileOk("panels:\n  k: Término clave\n");
      return kindsFileOk("telar_language: es\nglossary:\n  kinds:\n    - {id: species, label: Especie, heading: Especies}\n");
    });
    const env = { ENCRYPTION_KEY: "k" } as Env;
    const kinds = await readGlossaryKinds(env, "enc", project);
    expect(kinds.options.map((o) => [o.id, o.label])).toEqual([["term", "Término clave"], ["species", "Especie"]]);
    expect(getFileAtRef.mock.calls.every((c) => c[4] === "abc")).toBe(true);
    await readGlossaryKinds(env, "enc", project);
    expect(getFileAtRef).toHaveBeenCalledTimes(3);
  });

  it("falls back to the English labels when the site has no file for its language", async () => {
    getFileAtRef.mockImplementation(async (_t, _o, _r, path: string) => {
      if (path === "_data/glossary_kinds.yml") return kindsFileOk("- id: term\n  default: true\n  panel_label: panels.k\n");
      if (path === "_data/languages/en.yml") return kindsFileOk("panels:\n  k: Key term\n");
      if (path === "_config.yml") return kindsFileOk("telar_language: pt-BR\n");
      return { status: "absent" };
    });
    const kinds = await readGlossaryKinds({ ENCRYPTION_KEY: "k" } as Env, "enc", project);
    expect(kinds.options.map((o) => o.label)).toEqual(["Key term"]);
    expect(getFileAtRef.mock.calls.map((c) => c[3])).toContain("_data/languages/pt-BR.yml");
  });

  it("reads no file outside _data/languages for a language name that could leave it", async () => {
    getFileAtRef.mockImplementation(async (_t, _o, _r, path: string) =>
      path === "_config.yml" ? kindsFileOk('telar_language: "../../secret"\n') : { status: "absent" },
    );
    await readGlossaryKinds({ ENCRYPTION_KEY: "k" } as Env, "enc", project);
    expect(getFileAtRef.mock.calls.map((c) => c[3]).filter((p) => p.includes("secret"))).toEqual([]);
  });

  describe("with the site's kinds stored in D1", () => {
    const env = { ENCRYPTION_KEY: "k" } as Env;
    const storedKinds = JSON.stringify([{ id: "tribe", label: "Tribe", heading: "Tribes", values: [] }]);
    const ids = (kinds: { options: Array<{ id: string }> }) => kinds.options.map((o) => o.id);
    beforeEach(() => {
      getFileAtRef.mockImplementation(async (_t, _o, _r, path: string) => {
        if (path === "_data/glossary_kinds.yml") return kindsFileOk("- id: term\n  default: true\n  panel_label: Key term\n");
        if (path === "_config.yml") return kindsFileOk("glossary:\n  kinds:\n    - {id: species, label: Especie, heading: Especies}\n");
        return { status: "absent" };
      });
    });

    it("offers the stored kinds in place of the config's", async () => {
      const kinds = await readGlossaryKinds(env, "enc", project, storedKinds);
      expect(ids(kinds)).toEqual(["term", "tribe"]);
      expect(kinds.site.map((k) => k.id)).toEqual(["tribe"]);
      expect(ids(await readGlossaryKinds(env, "enc", project, "[]"))).toEqual(["term"]);
    });

    it("offers the config's kinds while nothing is stored", async () => {
      const kinds = await readGlossaryKinds(env, "enc", project, null);
      expect(ids(kinds)).toEqual(["term", "species"]);
      expect(kinds.site.map((k) => k.id)).toEqual(["species"]);
    });

    it("keeps the commit's read alone, whatever is stored", async () => {
      await readGlossaryKinds(env, "enc", project, storedKinds);
      expect(ids(await readGlossaryKinds(env, "enc", project))).toEqual(["term", "species"]);
      expect(getFileAtRef).toHaveBeenCalledTimes(3);
    });
  });

  it("refuses a first save while _config.yml could not be fetched, and writes nothing", async () => {
    getFileAtRef.mockImplementation(async (_t, _o, _r, path: string) => {
      if (path === "_data/glossary_kinds.yml") return kindsFileOk("- id: term\n  default: true\n  panel_label: Key term\n");
      return path === "_config.yml" ? { status: "error" } : { status: "absent" };
    });
    const env = { ENCRYPTION_KEY: "k" } as Env;
    const readRepoKinds = () => readGlossaryKinds(env, "enc", project);
    const repo = await readRepoKinds();
    expect(repo.configInconclusive).toBe(true);
    const memory = createMemoryD1();
    memory.raw.exec(
      "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
        "VALUES (1, 1, 'u', 'e', 'e', '2099-01-01', '2099-01-01')",
    );
    memory.raw.exec("INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (1, 1, 'o/r', 1)");
    memory.raw.exec("INSERT INTO project_config (project_id) VALUES (1)");
    const kinds = [{ id: "tribe", label: "Tribe", heading: "Tribes", values: [] }];
    const result = await saveGlossaryKinds(getDb(asD1(memory)), {
      projectId: 1, role: "convenor", base: null, seenRepo: repo.repoSite, headSha: project.head_sha, kinds, readRepoKinds,
    });
    expect(result).toMatchObject({ ok: false, reason: "unavailable", message: "kinds_save_failed" });
    expect(memory.raw.prepare("SELECT glossary_kinds_json AS k FROM project_config").get()).toEqual({ k: null });
    memory.close();
  });

  it("does not keep a read in which a file could not be fetched", async () => {
    getFileAtRef.mockResolvedValue({ status: "error" });
    await readGlossaryKinds({ ENCRYPTION_KEY: "k" } as Env, "enc", project);
    await readGlossaryKinds({ ENCRYPTION_KEY: "k" } as Env, "enc", project);
    expect(getFileAtRef).toHaveBeenCalledTimes(6);
  });
});
