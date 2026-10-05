/**
 * A story CSV keeps the columns an author added: read into each step's
 * `extra_columns` at import, written back after the fixed columns at publish,
 * refused where the framework would refuse them, and hashed only where a step
 * has some.
 *
 * The round trip runs through the publish action with the real file set and
 * the real commit primitive; only the reads of the repository and the
 * database are stood in for. The document's part of the trip — an edit
 * reaching D1 through the snapshot — is `tests/workers/story-extra-columns`.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Papa from "papaparse";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: () => ({ getSession: async () => ({ get: () => 1 }) }),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "tok") }));
vi.mock("~/lib/github.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/github.server")>();
  return {
    ...actual,
    getRepoHead: vi.fn(async () => "sha"),
    getFileAtRef: vi.fn(async () => ({ status: "absent" })),
  };
});
vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: vi.fn(),
  requirePublishingRole: vi.fn(async () => {}),
}));
vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(async () => "install-token"),
  resolveProjectToken: vi.fn(async () => "install-token"),
}));
vi.mock("~/lib/activity.server", () => ({ recordActivity: vi.fn(async () => {}) }));
vi.mock("../workers/auth", () => ({
  signInternalMarker: vi.fn(async () => ({ sigHex: "sig", timestamp: 1 })),
}));
vi.mock("~/lib/upgrade.server", () => ({
  healMissingFrameworkFiles: vi.fn(async () => []),
  normalizeVersionTag: vi.fn((v: string) => v),
}));

// `resolvePageProject` and `siteChangedAnswer` are re-implemented here against
// the same mocked `resolveActiveProjectFromRequest`, matching the real
// module's own logic (app/lib/active-project.server.ts), because this file
// mocks the whole module rather than importing its original.
vi.mock("~/lib/active-project.server", () => {
  const resolveActiveProjectFromRequest = vi.fn(async () => ({
    project: {
      id: 7,
      head_sha: "sha",
      published_sha: null,
      last_published_at: null,
      publish_snapshot: null,
      github_repo_full_name: "owner/repo",
      github_pages_url: "https://owner.github.io/repo",
      installation_id: 1,
    },
    userRole: "convenor",
  }));
  return {
    resolveActiveProjectFromRequest,
    resolvePageProject: vi.fn(async (request: Request, env: unknown, userId: number, formData: FormData) => {
      const resolved = await resolveActiveProjectFromRequest();
      if (!resolved) return { kind: "no_project" };
      if (formData.get("siteId") !== String(resolved.project.id)) {
        return { kind: "site_changed", currentSiteName: resolved.project.github_repo_full_name };
      }
      return { kind: "ok", ...resolved };
    }),
    siteChangedAnswer: vi.fn((intent: string, currentSiteName: string) => ({
      ok: false,
      intent,
      error: "site_changed",
      currentSiteName,
    })),
  };
});

const { tableRows, updates, reads } = vi.hoisted(() => ({
  tableRows: { current: {} as Record<string, unknown[]> },
  updates: [] as Array<Record<string, unknown>>,
  reads: [] as string[],
}));

function tableName(table: unknown): string {
  if (table === null || typeof table !== "object") return "unknown";
  const sym = Object.getOwnPropertySymbols(table).find((s) => s.description === "drizzle:Name");
  return sym ? String((table as Record<symbol, unknown>)[sym]) : "unknown";
}

vi.mock("~/lib/db.server", () => ({
  getDb: () => ({
    select: () => {
      const chain: Record<string, unknown> = {};
      let rows: unknown[] = [];
      chain.from = (table: unknown) => {
        const name = tableName(table);
        reads.push(name);
        rows = tableRows.current[name] ?? [];
        return chain;
      };
      chain.innerJoin = () => chain;
      chain.where = () => Object.assign(Promise.resolve(rows), chain);
      chain.limit = () => Promise.resolve(rows);
      chain.orderBy = () => Promise.resolve(rows);
      return chain;
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return { where: async () => {} };
      },
    }),
  }),
}));

import { action } from "~/routes/_app.publish";
import { getDb } from "~/lib/db.server";
import {
  STORY_CANONICAL_SCOPE,
  mapStoryCsv,
  parseTelarCsv,
} from "~/lib/import.server";
import {
  STORY_CSV_COLUMNS,
  buildEntityHashes,
  runPrePublishValidation,
  serializeStory,
  storyColumnBlockersNeedLayers,
  type StepForValidation,
  type StepLayerForValidation,
  type StepWithLayers,
} from "~/lib/publish.server";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const doFetch = vi.fn(async (_request: Request) => new Response("OK", { status: 200 }));

function buildContext() {
  return {
    get: vi.fn(() => ({
      id: 1,
      encrypted_access_token: "x",
      github_login: "u",
      github_name: "U",
      github_email: "u@e.co",
    })),
    cloudflare: {
      env: {
        DB: {},
        SESSION_SECRET: "s",
        ENCRYPTION_KEY: "k",
        COLLABORATION: { idFromName: vi.fn(() => "do-id"), get: vi.fn(() => ({ fetch: doFetch })) },
      },
    },
  } as unknown as Record<string, unknown>;
}

async function runAction(fields: Record<string, string>) {
  const form = new FormData();
  // The mocked active project's id, string-compared by `resolvePageProject`.
  form.set("siteId", "7");
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return (await action({
    request: new Request("https://app/publish", { method: "POST", body: form, headers: { Cookie: "" } }),
    context: buildContext(),
    params: {},
  } as never)) as {
    ok?: boolean;
    error?: string;
    validation?: { blockers: Array<{ code: string; params?: Record<string, unknown> }> };
    removalFailed?: { column: string };
  };
}

const runPublish = () => runAction({ intent: "publish", commitMessage: "Update site" });

/** Every file each CreateCommit carried, decoded, in commit order. */
function commitsSent(fetchMock: ReturnType<typeof vi.fn>): Array<Record<string, string>> {
  const commits: Array<Record<string, string>> = [];
  for (const [, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
    const body = JSON.parse((init?.body as string) ?? "{}");
    if (!String(body.query).includes("CreateCommit")) continue;
    const files: Record<string, string> = {};
    for (const a of body.variables.input.fileChanges.additions as Array<{ path: string; contents: string }>) {
      files[a.path] = Buffer.from(a.contents, "base64").toString("utf-8");
    }
    commits.push(files);
  }
  return commits;
}

function graphqlFetch() {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? "{}");
    const query = String(body.query);
    const json = query.includes("GetHeadOid")
      ? { data: { repository: { ref: { target: { oid: "sha" } } } } }
      : query.includes("SubtreeOids")
        ? { data: { repository: { c0: { __typename: "Commit" }, c0p0: null } } }
        : query.includes("CheckPaths")
        ? { data: { repository: {} } }
        : { data: { createCommitOnBranch: { commit: { oid: "new-sha", url: "u" } } } };
    return { ok: true, status: 200, json: async () => json, text: async () => "" };
  });
}

function seed(stepRows: Array<Record<string, unknown>>) {
  tableRows.current = {
    stories: [{ id: 1, story_id: "historia", title: "Historia", draft: false, private: false, order: 1 }],
    objects: [{ object_id: "obj-1", title: "Mapa" }],
    project_pages: [],
    glossary_terms: [],
    project_config: [{ project_id: 7, title: "Site", navigation_json: null }],
    project_landing: [],
    // `story` is the row id `readCaptureStories` groups steps by.
    steps: stepRows.map((row) => ({ story: 1, story_id: "historia", story_title: "Historia", ...row })),
    layers: [],
    projects: [],
  };
}

/** A story CSV as the framework reads it: header, then every record. */
function readCsv(text: string): string[][] {
  return Papa.parse<string[]>(text, { skipEmptyLines: true }).data;
}

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  reads.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const importStory = (csv: string) =>
  mapStoryCsv(parseTelarCsv(csv, undefined, false, STORY_CANONICAL_SCOPE), 1);

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

describe("mapStoryCsv keeps the columns it does not map", () => {
  it("keeps an unknown column's cells per step, in file order", () => {
    const { steps } = importStory(
      "step,object,Nota del autor,question,layer3_button,answer,layer3_content\n" +
        "1,obj-1,una nota,Q1,Más,A1,tercera.md\n" +
        "2,obj-1,,Q2,Ver,A2,\n",
    );
    expect(Object.keys(JSON.parse(steps[0].extra_columns as string))).toEqual([
      "Nota del autor",
      "layer3_button",
      "layer3_content",
    ]);
    expect(JSON.parse(steps[0].extra_columns as string)).toEqual({
      "Nota del autor": "una nota",
      layer3_button: "Más",
      layer3_content: "tercera.md",
    });
    // Empty cells are not kept.
    expect(JSON.parse(steps[1].extra_columns as string)).toEqual({ layer3_button: "Ver" });
  });

  it("consumes a mapped column under any of its aliases", () => {
    const { steps } = importStory(
      "Paso,Objeto,Pregunta,Respuesta,Página,archivo_capa1,boton_capa1,texto_alt,inicio_clip,fin_clip,bucle\n" +
        "1,obj-1,Q,A,2,capa.md,Leer,Alt,0,5,no\n",
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].extra_columns).toBe("{}");
    expect(steps[0].question).toBe("Q");
    expect(steps[0].page).toBe("2");
  });

  it("never keeps step, paso or the bilingual row", () => {
    const { steps } = importStory(
      "step,object,question,answer,nota\n" +
        "paso,objeto,pregunta,respuesta,\n" +
        "1,obj-1,Q,A,n\n",
    );
    expect(steps).toHaveLength(1);
    expect(JSON.parse(steps[0].extra_columns as string)).toEqual({ nota: "n" });
  });

  it("records no kept cell as \"{}\" on a step with none, so the story reads as recorded", () => {
    const { steps } = importStory("step,object,question,answer,nota\n1,obj-1,Q,A,\n");
    expect(steps[0].extra_columns).toBe("{}");
  });

  it("does not read a row whose only kept cells are instruction or example columns as a step", () => {
    const { steps } = importStory(
      "step,object,question,answer,#nota,example\n" +
        "1,obj-1,Q,A,para mí,ejemplo\n" +
        ",,,,solo instrucciones,\n" +
        ",,,,,solo ejemplo\n",
    );
    expect(steps).toHaveLength(1);
    // Kept on a real step all the same: they are part of the author's file.
    expect(JSON.parse(steps[0].extra_columns as string)).toEqual({ "#nota": "para mí", example: "ejemplo" });
  });

  it("reads a row whose only content is in a kept column as a step", () => {
    const { steps } = importStory(
      "step,object,question,answer,layer3_content\n" +
        "1,obj-1,Q,A,\n" +
        "2,,,,solo.md\n",
    );
    expect(steps).toHaveLength(2);
    expect(JSON.parse(steps[1].extra_columns as string)).toEqual({ layer3_content: "solo.md" });
  });
});

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function stepOf(overrides: Partial<StepWithLayers>): StepWithLayers {
  return {
    step_number: 1,
    kind: "media",
    object_id: "obj-1",
    x: 0.4,
    y: 0.6,
    zoom: 2,
    page: null,
    question: "Q",
    answer: "A",
    alt_text: null,
    clip_start: null,
    clip_end: null,
    loop: null,
    layers: [],
    ...overrides,
  };
}

describe("serializeStory writes the kept columns back", () => {
  it("appends them after the fixed columns in first-seen order, each step filling its own cells", () => {
    const rows = readCsv(
      serializeStory(
        [
          stepOf({ step_number: 2, question: "Q2", extra_columns: JSON.stringify({ alfa: "a2", zeta: "z2" }) }),
          stepOf({ step_number: 1, question: "Q1", extra_columns: JSON.stringify({ zeta: "z1" }) }),
          stepOf({ step_number: 3, question: "Q3" }),
        ],
        "historia",
      ).csv,
    );
    const [header, bilingual, ...data] = rows;
    expect(header).toEqual([...STORY_CSV_COLUMNS, "zeta", "alfa"]);
    // The bilingual row leaves a kept column's cell empty.
    expect(bilingual.slice(STORY_CSV_COLUMNS.length)).toEqual(["", ""]);
    expect(data.map((r) => r.slice(STORY_CSV_COLUMNS.length))).toEqual([
      ["z1", ""],
      ["z2", "a2"],
      ["", ""],
    ]);
  });

  it("writes every mapped column exactly as it does without kept columns", () => {
    const plain = [stepOf({ step_number: 1 }), stepOf({ step_number: 2, question: "Q2" })];
    const kept = plain.map((s, i) => ({ ...s, extra_columns: JSON.stringify({ nota: `n${i}` }) }));
    const without = readCsv(serializeStory(plain, "historia").csv);
    const withKept = readCsv(serializeStory(kept, "historia").csv);
    expect(withKept.map((r) => r.slice(0, STORY_CSV_COLUMNS.length))).toEqual(without);
  });

  it("publishes a step whose only content is a kept cell", () => {
    const rows = readCsv(
      serializeStory(
        [stepOf({ object_id: null, question: null, answer: null, extra_columns: JSON.stringify({ layer3_content: "x.md" }) })],
        "historia",
      ).csv,
    );
    expect(rows).toHaveLength(3);
    expect(rows[2][rows[0].indexOf("layer3_content")]).toBe("x.md");
  });

  // A kept column can be named after anything on Object.prototype, which a
  // plain lookup in the Spanish table answers: `constructor` would emit the
  // Object constructor's source and `__proto__` "[object Object]", and enough
  // such cells take the row below the ratio that marks it as the bilingual row.
  it("leaves the bilingual cell empty for kept columns named after inherited members", () => {
    const blob = '{"constructor":"c","__proto__":"p","toString":"t"}';
    const rows = readCsv(serializeStory([stepOf({ extra_columns: blob })], "historia").csv);
    expect(rows[0].slice(STORY_CSV_COLUMNS.length)).toEqual(["constructor", "__proto__", "toString"]);
    expect(rows[1].slice(STORY_CSV_COLUMNS.length)).toEqual(["", "", ""]);
    expect(rows[2].slice(STORY_CSV_COLUMNS.length)).toEqual(["c", "p", "t"]);
  });

  it("does not publish a step whose only kept cells are in columns the framework drops", () => {
    const csv = serializeStory(
      [
        stepOf({}),
        stepOf({ step_number: 2, object_id: null, question: null, answer: null, extra_columns: JSON.stringify({ "#nota": "n", example: "e" }) }),
      ],
      "historia",
    ).csv;
    expect(readCsv(csv)).toHaveLength(3);
  });
});

// The file a story with no kept columns publishes, pinned byte for byte. Each
// expected string is what the serializer on main (10d99226) writes for the
// same input: LF line endings, the comment row carried above the data, a cell
// holding a newline quoted with its CRLF normalised, and no trailing newline
// after the data.
describe("serializeStory for a story with no kept columns", () => {
  const HEADER =
    "step,object,x,y,zoom,page,question,answer,alt_text,layer1_button,layer1_content,layer2_button,layer2_content,clip_start,clip_end,loop";
  const BILINGUAL =
    "paso,objeto,x,y,zoom,pagina,pregunta,respuesta,texto_alt,boton1,contenido1,boton2,contenido2,inicio_clip,fin_clip,bucle";
  const EXISTING = "step,object,x\npaso,objeto,x\n# An instruction row, kept above the data\n1,a,0.5\n";
  const steps: StepWithLayers[] = [
    stepOf({
      step_number: 2,
      x: 0.25,
      y: 0.75,
      zoom: 2,
      page: "3",
      question: "Line one\nline two, with a comma",
      answer: 'He said "yes"\r\nthen left',
      layers: [{ layer_number: 1, title: "Capa", button_label: "Leer", content: "Body" }],
    }),
    stepOf({ step_number: 1, kind: "section", object_id: null, x: null, y: null, zoom: null, question: "Capítulo", answer: null }),
    stepOf({ step_number: 3, object_id: null, x: null, y: null, zoom: null, question: null, answer: null }),
  ];

  it("writes the file main writes, comments, multi-line cells and all", () => {
    expect(serializeStory(steps, "historia", EXISTING).csv).toBe(
      `${HEADER}\n${BILINGUAL}\n# An instruction row, kept above the data\n` +
        "1,,,,,,Capítulo,,,,,,,,,\n" +
        '2,obj-1,0.25,0.75,2,3,"Line one\nline two, with a comma","He said ""yes""\nthen left",,Leer,historia-capa.md,,,,,',
    );
  });

  it("writes the file main writes for an empty story", () => {
    expect(serializeStory([], "historia").csv).toBe(`${HEADER}\n${BILINGUAL}\n`);
    expect(serializeStory([], "historia", EXISTING).csv).toBe(
      `${HEADER}\n${BILINGUAL}\n# An instruction row, kept above the data\n`,
    );
  });
});

// ---------------------------------------------------------------------------
// What the framework refuses
// ---------------------------------------------------------------------------

function validationStep(
  extras: Record<string, string> | null,
  n = 1,
  fields: Partial<StepForValidation> = {},
): StepForValidation {
  return {
    id: n,
    step_number: n,
    object_id: "obj-1",
    x: 0.5,
    y: 0.5,
    zoom: 1,
    question: "Q",
    answer: "A",
    story_id: "historia",
    story_title: "Historia",
    extra_columns: extras ? JSON.stringify(extras) : null,
    ...fields,
  };
}

/**
 * A media step with no object, question or answer: its layers and its kept
 * cells decide whether the story CSV writes it.
 */
function candidateStep(extras: Record<string, string> | null, n: number): StepForValidation {
  return validationStep(extras, n, { object_id: null, x: null, y: null, zoom: null, question: null, answer: null });
}

const STORY_COLUMN_CODES = new Set(["story_reserved_column", "story_colliding_columns"]);

function storyBlockers(steps: StepForValidation[], stepLayers?: StepLayerForValidation[]) {
  return runPrePublishValidation({
    headSha: "a",
    currentRepoHead: "a",
    stories: [{ story_id: "historia", title: "Historia", private: false, draft: false }],
    steps,
    objects: [],
    pages: [],
    glossary: [],
    stepLayers,
  }).blockers.filter((b) => STORY_COLUMN_CODES.has(b.code));
}

describe("story column blockers", () => {
  it("blocks a _metadata column, naming the story and the column", () => {
    const blockers = storyBlockers([validationStep({ _metadata: "x" })]);
    expect(blockers).toEqual([
      {
        code: "story_reserved_column",
        message: "story_reserved_column",
        entityId: "historia",
        params: { story: "Historia", column: "_metadata" },
        removable: { table: "steps", storyId: "historia", columns: ["_metadata"], rows: { _metadata: 1 } },
      },
    ]);
  });

  it("blocks two kept columns titulo and title, which the framework renames onto one", () => {
    const blockers = storyBlockers([validationStep({ titulo: "a" }, 1), validationStep({ title: "b" }, 2)]);
    expect(blockers).toEqual([
      expect.objectContaining({
        code: "story_colliding_columns",
        params: { story: "Historia", columns: '"title", "titulo"' },
        removable: { table: "steps", storyId: "historia", columns: ["title", "titulo"], rows: { title: 1, titulo: 1 } },
      }),
    ]);
  });

  it("blocks two kept columns differing only in case", () => {
    const blockers = storyBlockers([validationStep({ Note: "a", note: "b" })]);
    expect(blockers).toEqual([
      expect.objectContaining({
        code: "story_colliding_columns",
        params: { story: "Historia", columns: '"Note", "note"' },
      }),
    ]);
  });

  it("does not block instruction columns, which the story reader drops first", () => {
    expect(storyBlockers([validationStep({ "#Note": "a", "#note": "b" })])).toEqual([]);
  });

  it("does not block ordinary kept columns", () => {
    expect(storyBlockers([validationStep({ layer3_button: "Más", nota: "n" })])).toEqual([]);
  });

  it("names the story by its id when it has no title", () => {
    const step = { ...validationStep({ _metadata: "x" }), story_title: "" };
    expect(storyBlockers([step])[0].params).toEqual({ story: "historia", column: "_metadata" });
  });

  it("blocks a _metadata column on a step whose only content is that cell", () => {
    expect(storyBlockers([candidateStep({ _metadata: "x" }, 1)], [])).toEqual([
      expect.objectContaining({ code: "story_reserved_column", params: { story: "Historia", column: "_metadata" } }),
    ]);
  });
});

// The story CSV leaves out a step with no content of its own (`publishedSteps`),
// so a column only such a step carries is not in the file and cannot collide.
describe("story column blockers judge the steps the story CSV writes", () => {
  // Step 2 is left out, and with it the only `example` column.
  const droppedExampleSteps = () => [validationStep({ Example: "a" }, 1), candidateStep({ example: "b" }, 2)];
  const EXAMPLE_COLLISION = expect.objectContaining({
    code: "story_colliding_columns",
    params: { story: "Historia", columns: '"Example", "example"' },
  });

  it("does not block a column that only a step the file leaves out carries", () => {
    expect(storyBlockers(droppedExampleSteps(), [])).toEqual([]);
  });

  it("blocks it when that step has a panel, which writes the step", () => {
    expect(storyBlockers(droppedExampleSteps(), [{ step_id: 2, title: null, content: "Panel" }])).toEqual([EXAMPLE_COLLISION]);
  });

  it("blocks it when that step is a section, which is always written", () => {
    const steps = [validationStep({ Example: "a" }, 1), { ...candidateStep({ example: "b" }, 2), kind: "section" as const }];
    expect(storyBlockers(steps, [])).toEqual([EXAMPLE_COLLISION]);
  });

  describe("storyColumnBlockersNeedLayers", () => {
    it("is true when a blocking column comes only from a step whose layers decide it", () => {
      expect(storyColumnBlockersNeedLayers(droppedExampleSteps())).toBe(true);
    });

    it("is false when that step is a section", () => {
      const steps = [validationStep({ Example: "a" }, 1), { ...candidateStep({ example: "b" }, 2), kind: "section" as const }];
      expect(storyColumnBlockersNeedLayers(steps)).toBe(false);
    });

    it("is false when the steps written whatever their layers carry every column", () => {
      const steps = [validationStep({ Note: "a", note: "b" }, 1), candidateStep(null, 2)];
      expect(storyColumnBlockersNeedLayers(steps)).toBe(false);
    });

    it("is false when the columns of every step raise no blocker", () => {
      const steps = [validationStep({ nota: "a" }, 1), candidateStep({ example: "b" }, 2)];
      expect(storyColumnBlockersNeedLayers(steps)).toBe(false);
    });

    it("is false for a reserved column, which keeps its step", () => {
      expect(storyColumnBlockersNeedLayers([validationStep({ _metadata: "x" }, 1)])).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

describe("story entity hashes", () => {
  const stepRow = {
    id: 11,
    story_id: 1,
    step_number: 1,
    kind: "media",
    object_id: "obj-1",
    x: 0.5,
    y: 0.5,
    zoom: 1,
    page: null,
    question: "Q",
    answer: "A",
    alt_text: null,
    clip_start: null,
    clip_end: null,
    loop: null,
  };

  it("records the same hash for a story with no kept columns as without the field", async () => {
    seed([{ ...stepRow, extra_columns: null }]);
    const hashes = await buildEntityHashes(getDb({} as never), 7);
    // The hash of a story whose steps carry no extra_columns field, written out.
    expect(hashes.stories.historia).toBe(
      JSON.stringify({
        story_id: "historia",
        title: "Historia",
        subtitle: "",
        byline: "",
        order: 1,
        private: false,
        show_sections: false,
        steps: [
          {
            step_number: 1,
            kind: "media",
            object_id: "obj-1",
            x: 0.5,
            y: 0.5,
            zoom: 1,
            page: "",
            question: "Q",
            answer: "A",
            alt_text: "",
            clip_start: "",
            clip_end: "",
            loop: "",
            layers: [],
          },
        ],
      }),
    );
    seed([{ ...stepRow, extra_columns: "{}" }]);
    const empty = await buildEntityHashes(getDb({} as never), 7);
    expect(empty.stories.historia).toBe(hashes.stories.historia);
  });

  it("changes a story's hash when a kept cell changes, and not when only key order does", async () => {
    seed([{ ...stepRow, extra_columns: JSON.stringify({ a: "1", b: "2" }) }]);
    const first = (await buildEntityHashes(getDb({} as never), 7)).stories.historia;
    seed([{ ...stepRow, extra_columns: JSON.stringify({ b: "2", a: "1" }) }]);
    const reordered = (await buildEntityHashes(getDb({} as never), 7)).stories.historia;
    seed([{ ...stepRow, extra_columns: JSON.stringify({ a: "1", b: "3" }) }]);
    const changed = (await buildEntityHashes(getDb({} as never), 7)).stories.historia;
    seed([{ ...stepRow, extra_columns: null }]);
    const none = (await buildEntityHashes(getDb({} as never), 7)).stories.historia;

    expect(reordered).toBe(first);
    expect(changed).not.toBe(first);
    expect(none).not.toBe(first);
  });
});

// ---------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------

describe("import, edit, publish", () => {
  const AUTHOR_CSV =
    "step,object,x,y,zoom,question,Nota del autor,answer,layer3_button,layer3_content\n" +
    "paso,objeto,x,y,zoom,pregunta,,respuesta,,\n" +
    "1,obj-1,0.4,0.6,2,Primera,una nota,Respuesta uno,,\n" +
    "2,obj-1,0.1,0.2,3,Segunda,,Respuesta dos,Más,tercera.md\n";

  it("commits the kept columns in first-seen order, with empty bilingual cells and every mapped column unchanged", async () => {
    const { steps: imported } = importStory(AUTHOR_CSV);
    // The edit the document made and the snapshot wrote to D1.
    const d1 = imported.map((s, i) => ({ id: 11 + i, ...s, question: i === 0 ? "Primera, editada" : s.question }));
    seed(d1);
    const fetchMock = graphqlFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect((await runPublish()).ok).toBe(true);
    const [files] = commitsSent(fetchMock);
    const published = readCsv(files["telar-content/spreadsheets/historia.csv"]);
    const [header, bilingual, ...data] = published;

    expect(header).toEqual([...STORY_CSV_COLUMNS, "Nota del autor", "layer3_button", "layer3_content"]);
    expect(bilingual.slice(STORY_CSV_COLUMNS.length)).toEqual(["", "", ""]);
    expect(data.map((r) => r.slice(STORY_CSV_COLUMNS.length))).toEqual([
      ["una nota", "", ""],
      ["", "Más", "tercera.md"],
    ]);

    // The mapped columns are what the same rows publish without kept columns.
    const plain = readCsv(
      serializeStory(
        d1.map((s) => ({
          step_number: s.step_number,
          kind: s.kind as "media" | "section",
          object_id: (s.object_id as string | undefined) ?? null,
          x: (s.x as number | undefined) ?? null,
          y: (s.y as number | undefined) ?? null,
          zoom: (s.zoom as number | undefined) ?? null,
          page: (s.page as string | undefined) ?? null,
          question: (s.question as string | undefined) ?? null,
          answer: (s.answer as string | undefined) ?? null,
          alt_text: (s.alt_text as string | undefined) ?? null,
          clip_start: null,
          clip_end: null,
          loop: null,
          layers: [],
        })),
        "historia",
      ).csv,
    );
    expect(published.map((r) => r.slice(0, STORY_CSV_COLUMNS.length))).toEqual(plain);
    expect(data[0][STORY_CSV_COLUMNS.indexOf("question")]).toBe("Primera, editada");
  });

  it("refuses the publish when a story keeps a column the framework reserves", async () => {
    const { steps: imported } = importStory("step,object,question,answer,_metadata\n1,obj-1,Q,A,x\n");
    seed(imported.map((s, i) => ({ id: 11 + i, ...s })));
    const fetchMock = graphqlFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await runPublish()).toMatchObject({ error: "validation_blocked" });
    expect(commitsSent(fetchMock)).toHaveLength(0);
  });
});

describe("the page's check after a removal", () => {
  const stepWith = (extras: Record<string, string>) => ({
    id: 11, step_number: 1, object_id: "obj-1", question: "Q", answer: "A", extra_columns: JSON.stringify(extras),
  });

  it("has the collaboration object remove the column before D1 is read, and returns the cleared checks", async () => {
    seed([stepWith({ _metadata: "x", nota: "n" })]);
    // The object's part: remove the column from every step and snapshot, so
    // D1 holds the result by the time it answers.
    let readBeforeRemoval: string[] | null = null;
    let requested: URL | null = null;
    doFetch.mockImplementation(async (request: Request) => {
      requested = new URL(request.url);
      readBeforeRemoval = [...reads];
      seed([stepWith({ nota: "n" })]);
      return Response.json({ removed: 1 });
    });

    const result = await runAction({ intent: "run-validation", removeStoryId: "historia", removeColumn: "_metadata" });

    expect(result.ok).toBe(true);
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(requested!.pathname).toBe("/remove-story-column");
    expect(requested!.searchParams.get("story")).toBe("historia");
    expect(requested!.searchParams.get("column")).toBe("_metadata");
    expect(readBeforeRemoval).toEqual([]);
    expect(result.validation?.blockers.filter((b) => b.code.startsWith("story_"))).toEqual([]);
    expect(result.removalFailed).toBeUndefined();
  });

  it("asks for a whole-table removal of objects or glossary, signed for that table and column", async () => {
    seed([stepWith({ nota: "n" })]);
    const requested: URL[] = [];
    doFetch.mockImplementation(async (request: Request) => {
      requested.push(new URL(request.url));
      return Response.json({ removed: 3 });
    });

    for (const table of ["objects", "glossary"]) {
      const result = await runAction({ intent: "run-validation", removeTable: table, removeColumn: "_metadata" });
      expect(result.removalFailed).toBeUndefined();
    }
    expect(requested.map((u) => [u.pathname, u.searchParams.get("table"), u.searchParams.get("column")])).toEqual([
      ["/remove-table-column", "objects", "_metadata"],
      ["/remove-table-column", "glossary", "_metadata"],
    ]);
    // A table that is neither names no removal.
    await runAction({ intent: "run-validation", removeTable: "steps", removeColumn: "_metadata" });
    expect(requested).toHaveLength(2);
  });

  it("still returns the checks when the removal fails, with the blocker standing", async () => {
    seed([stepWith({ _metadata: "x" })]);
    doFetch.mockImplementation(async () => new Response("snapshot_blocked", { status: 503 }));

    const result = await runAction({ intent: "run-validation", removeStoryId: "historia", removeColumn: "_metadata" });

    expect(result.ok).toBe(true);
    expect(result.validation?.blockers.map((b) => b.code)).toContain("story_reserved_column");
    expect(result.removalFailed).toEqual({ column: "_metadata" });
  });

  it("names the column when the collaboration object cannot be reached", async () => {
    seed([stepWith({ _metadata: "x" })]);
    doFetch.mockImplementation(async () => { throw new Error("unreachable"); });

    const result = await runAction({ intent: "run-validation", removeStoryId: "historia", removeColumn: "_metadata" });

    expect(result.ok).toBe(true);
    expect(result.validation?.blockers.map((b) => b.code)).toContain("story_reserved_column");
    expect(result.removalFailed).toEqual({ column: "_metadata" });
  });

  it("removes nothing on the page's ordinary pass", async () => {
    seed([stepWith({ _metadata: "x" })]);
    const result = await runAction({ intent: "run-validation" });
    expect(doFetch).not.toHaveBeenCalled();
    expect(result.removalFailed).toBeUndefined();
    expect(result.validation?.blockers.map((b) => b.code)).toContain("story_reserved_column");
  });
});
