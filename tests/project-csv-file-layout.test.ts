/**
 * project.csv projectPublished in the file's own column layout.
 *
 * The file's columns keep their order and header text, its comment rows stay
 * under the columns they annotate, and what the file lacks is appended. Every
 * protection spelling (`private`, `privada`, `protected`) reads as `private`
 * on this sheet: the one the import decides from is written in place, any
 * other is left out.
 *
 * The template text is `telar-content/spreadsheets/project.csv` in the
 * production `telar/` checkout (5605d399), verbatim.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import {
  isHeaderRow,
  positionalRow,
  projectCsvStoryRows,
} from "~/lib/import.server";
import { PROJECT_CSV_COLUMNS, serializeProjectCsv } from "~/lib/publish.server";
import {
  FRAMEWORK_SCRIPTS_DIR,
  FRAMEWORK_TIMEOUT_MS,
  PUBLISHED_FRAMEWORK_TAG,
  describeWithFramework,
  describeWithFrameworkTag,
  frameworkCsvToJson,
  frameworkScriptsAtTag,
  frameworkTagPresent,
} from "./helpers/framework-checkout";

type StoryRow = Parameters<typeof serializeProjectCsv>[0][number];

const TEMPLATE = [
  "order,story_id,title,subtitle,byline,private",
  "orden,id_historia,titulo,subtitulo,firma,privada",
  '#,# Must match the tab name exactly. Use lowercase letters and hyphens (e.g. allegorical-woman),Story title,Optional subtitle,Optional attribution (supports markdown),"If ""yes"", then users will need the key you set in _config.yml to access this story."',
  '#,# Debe coincidir con el nombre de la pestaña exactamente. Usa letras minúsculas y guiones (p. ej. mujer-alegorica),Título de la historia,Subtítulo opcional,Atribución opcional (admite markdown),"Si ""sí"", los usuarios deberán utilizar la clave que fijes en _config.yml"',
  "1,blank_template,replace me with your title,,,FALSE",
  "2,plantilla_en_blanco,reemplázame con tu título,,,FALSE",
].join("\n") + "\n";

/** The stories D1 holds after the import reads `file`. */
function projectStoriesOf(file: string): StoryRow[] {
  return projectCsvStoryRows(file).map((s) => ({
    story_id: s.story_id as string,
    title: s.title ?? null,
    subtitle: s.subtitle ?? null,
    byline: s.byline ?? null,
    order: s.order ?? 0,
    private: s.private ?? false,
    draft: false,
    show_sections: s.show_sections ?? false,
  }));
}

const FIXTURES: Record<string, string> = {
  "13": "story_id,order,title,privada,notas\n# id note,# order note,# title note,# private note,# notas note\ns1,1,T1,sí,\n",
  "14": TEMPLATE,
  "15": "Order,Story_ID,Title,subtitle,byline,Private\n1,s1,T1,,,yes\n",
  "16": "orden,id_historia,título,subtítulo,firma,privado\n1,s1,T1,Sub,,sí\n",
  "17": "order,story_id,title,protected\n1,s1,T1,yes\n",
  "18": "order,story_id,title,private,protegida\n# o,# s,# t,# p,# pr\n1,s1,T1,yes,\n",
};

const projectPublished = (key: string) => serializeProjectCsv(projectStoriesOf(FIXTURES[key]), FIXTURES[key]);
const projectLines = (key: string) => projectPublished(key).split("\n");

describe("project.csv in the file's own layout", () => {
  it("13: columns keep their order and text, the comment row stays under its cells, what is lacking is appended", () => {
    const out = projectLines("13");
    expect(out[0]).toBe("story_id,order,title,privada,notas,subtitle,byline,show_sections");
    expect(out[2]).toBe("# id note,# order note,# title note,# private note,# notas note");
    expect(out[3]).toBe("s1,1,T1,yes,,,,");
  });

  it("14: the framework template keeps its header and both instruction rows byte for byte", () => {
    const out = projectLines("14");
    const template = TEMPLATE.split("\n");
    expect(out[0]).toBe(`${template[0]},show_sections`);
    expect(out.slice(2, 4)).toEqual(template.slice(2, 4));
    expect(out).toHaveLength(2 + 2 + 2);
  });

  it("15: a capitalised `Order` and `Story_ID` are written in English, `Private` keeps its text", () => {
    expect(projectLines("15")[0]).toBe("order,story_id,title,subtitle,byline,Private,show_sections");
  });

  it("16: `subtítulo` and `privado`, which the projectPublished tag does not read, are written in English", () => {
    expect(projectLines("16")[0]).toBe("orden,id_historia,título,subtitle,firma,private,show_sections");
  });

  it("17: `protected` is kept in place and holds D1's value", () => {
    const out = projectLines("17");
    expect(out[0]).toBe("order,story_id,title,protected,subtitle,byline,show_sections");
    expect(out[2]).toBe("1,s1,T1,yes,,,");
  });

  it("18: an empty protection column that is not the chosen one is left out with its comment cell", () => {
    const out = projectLines("18");
    expect(out[0]).toBe("order,story_id,title,private,subtitle,byline,show_sections");
    expect(out[2]).toBe("# o,# s,# t,# p");
  });

  it("18: at position 0 the column is left out, and a comment row is kept only while it still reads as a comment", () => {
    const file =
      "protegida,order,story_id,title,private\n#,# o,# s,# t,# p\n#,plain,plain,plain,plain\n,1,s1,T1,yes\n";
    const out = serializeProjectCsv(projectStoriesOf(file), file).split("\n");
    expect(out[0]).toBe("order,story_id,title,private,subtitle,byline,show_sections");
    expect(out[2]).toBe("# o,# s,# t,# p");
    expect(out[3]).toBe("1,s1,T1,yes,,,");
  });

  it("18: a protection header repeated beside the chosen one is left out", () => {
    const file = "order,story_id,title,private,private\n# o,# s,# t,# p,# again\n1,s1,T1,yes,no\n";
    const out = serializeProjectCsv(projectStoriesOf(file), file).split("\n");
    expect(out[0]).toBe("order,story_id,title,private,subtitle,byline,show_sections");
    expect(out[2]).toBe("# o,# s,# t,# p");
    expect(out[3]).toBe("1,s1,T1,yes,,,");
  });

  it("19: a D1 title in the first column that would read as a comment takes the plain layout", () => {
    const file = "title,order,story_id\n";
    const story: StoryRow = {
      story_id: "s1", title: "#1 story", subtitle: null, byline: null, order: 1, private: false, draft: false,
      show_sections: false,
    };
    expect(serializeProjectCsv([story], file).split("\n")[0]).toBe(PROJECT_CSV_COLUMNS.join(","));
  });

  it("20: a header Papa refused gets the canonical header and the file's comment rows", () => {
    const file = 'order,"story_id"x",title\n# guide,t,d\n1,s1,T1\n';
    const story: StoryRow = {
      story_id: "s1", title: "T1", subtitle: null, byline: null, order: 1, private: false, draft: false,
      show_sections: false,
    };
    const out = serializeProjectCsv([story], file).split("\n");
    expect(out[0]).toBe(PROJECT_CSV_COLUMNS.join(","));
    expect(out[2]).toBe("# guide,t,d");
  });

  it("21: an empty custom column's bilingual cell is empty, and the row is still read as a header", () => {
    const file = "order,story_id,title,a,b,c\n1,s1,T1,,,\n";
    const out = serializeProjectCsv(projectStoriesOf(file), file).split("\n");
    expect(out[0]).toBe("order,story_id,title,a,b,c,subtitle,byline,private,show_sections");
    expect(out[1]).toBe("orden,id_historia,titulo,,,,subtitulo,firma,privada,mostrar_secciones");
    expect(isHeaderRow(positionalRow(out[1].split(",")), true)).toBe(true);
  });

  it.each(["13", "14", "15", "16", "17", "18"])("22: fixture %s read back gives D1's stories", (key) => {
    const stories = projectStoriesOf(FIXTURES[key]);
    expect(stories.length).toBeGreaterThan(0);
    const projectPick = (rows: ReturnType<typeof projectCsvStoryRows>) =>
      rows.map((r) => [r.story_id, r.title, r.subtitle ?? null, r.private ?? false, r.show_sections ?? false, r.order]);
    expect(projectPick(projectCsvStoryRows(projectPublished(key)))).toEqual(projectPick(projectCsvStoryRows(FIXTURES[key])));
  });
});

function expectProjectStories(key: string, scriptsDir: string) {
  const sourceStories = projectStoriesOf(FIXTURES[key]);
  const read = frameworkCsvToJson(projectPublished(key), "project", scriptsDir);
  expect(read.ok).toBe(true);
  expect(read.rows.map((r) => r.story_id)).toEqual(sourceStories.map((s) => s.story_id));
  expect(read.rows.map((r) => r.title)).toEqual(sourceStories.map((s) => s.title));
  expect(read.rows.map((r) => r.protected === true)).toEqual(sourceStories.map((s) => s.private === true));
  expect(read.rows.map((r) => r.subtitle ?? null)).toEqual(sourceStories.map((s) => s.subtitle ?? null));
}

const PARITY_KEYS = ["13", "14", "15", "16", "17", "18"];

describeWithFramework("31: the projectPublished project.csv, read by the head", () => {
  it.each(PARITY_KEYS)("fixture %s gives every story, protected where D1 has it private", { timeout: FRAMEWORK_TIMEOUT_MS }, (key) => {
    expectProjectStories(key, FRAMEWORK_SCRIPTS_DIR);
  });
});

describeWithFrameworkTag(PUBLISHED_FRAMEWORK_TAG, "31: the projectPublished project.csv, read by the projectPublished tag", () => {
  const scripts = frameworkTagPresent(PUBLISHED_FRAMEWORK_TAG) ? frameworkScriptsAtTag(PUBLISHED_FRAMEWORK_TAG) : "";
  it.each(PARITY_KEYS)("fixture %s gives every story, protected where D1 has it private", { timeout: FRAMEWORK_TIMEOUT_MS }, (key) => {
    expectProjectStories(key, scripts);
  });

  it("15 and 16: the source files read badly at the tag", { timeout: FRAMEWORK_TIMEOUT_MS }, () => {
    expect(frameworkCsvToJson(FIXTURES["15"], "project", scripts).rows).toHaveLength(0);
    expect(frameworkCsvToJson(FIXTURES["16"], "project", scripts).rows[0]?.protected).not.toBe(true);
  });
});
