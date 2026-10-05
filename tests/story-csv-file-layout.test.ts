/**
 * A story CSV published in the file's own column layout.
 *
 * The step CSV on GitHub is the author's file: its column order, its header
 * text (`página` as well as `page`), its instruction rows and the columns it
 * added and has not filled yet. D1 holds the steps' values; the file holds the
 * layout they are written into. A comment row annotates the columns by
 * position, so it stays correct only while every column keeps its place, and a
 * column the publish leaves out takes its cell out of each comment row with it.
 *
 * The template text below is quoted verbatim from the framework's template
 * story CSVs, `telar-content/spreadsheets/blank_template.csv` and
 * `plantilla_en_blanco.csv` in the framework (branch
 * fix/tel-454-contain-short-axis, 82196d99), header, instruction row and first
 * placeholder row.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import Papa from "papaparse";
import { renderStoryFiles, serializeStory } from "~/lib/publish.server";
import type { StepWithLayers, StoryStepRow } from "~/lib/publish.server";
import { STORY_CANONICAL_SCOPE, mapStoryCsv, parseTelarCsv } from "~/lib/import.server";
import {
  canonicalForCompareFromD1,
  canonicalForCompareFromFiles,
  parseStoryFiles,
  rawCanonicalFromD1,
} from "~/lib/story-content.server";
import { canonicalRaw } from "~/lib/story-canonical";
import {
  FRAMEWORK_SCRIPTS_DIR,
  FRAMEWORK_TIMEOUT_MS,
  PUBLISHED_FRAMEWORK_TAG,
  describeWithFrameworkTag,
  frameworkCsvToJson,
  frameworkScriptsAtTag,
} from "./helpers/framework-checkout";

const TEMPLATE_HEADER =
  "step,object,page,x,y,zoom,clip_start,clip_end,loop,alt_text,question,answer,layer1_button,layer1_content,layer2_button,layer2_content,azimuth,elevation,distance,target_x,target_y,target_z";
const TEMPLATE_INSTRUCTION =
  "#,object_id from the objects tab,for multi-page items,horizontal position 0-1 (0.5 = center),vertical position 0-1 (0.5 = center),(1.0 = full image),\"Start time for video/audio clips, e.g. \"\"1:30\"\" (m:ss) or \"\"90\"\" (seconds)\",End time for video/audio clips,yes to loop the clip,\"Describe what is visible in this zoomed view for screen readers. If empty, the object's image description is used.\",Heading for this step,Brief 1-2 sentence text,\"Optional button text (default: \"\"Learn more\"\")\",\"Panel content: write text here, paste markdown, or enter path to .md file (e.g. your-story/file.md)\",\"Optional second button text (default: \"\"Go deeper\"\")\",\"Second panel: write text here, paste markdown, or enter path to .md file\",\"3D objects only: angle around the model in degrees (0 = front, 90 = right, -90 = left, 180 = back)\",\"3D objects only: elevation angle in degrees (0 = top-down, 90 = eye level)\",\"3D objects only: camera distance from the look-at point, in metres (smaller = closer)\",\"3D objects only: the point the camera looks at, X in metres (empty = model centre)\",\"3D objects only: the point the camera looks at, Y in metres\",\"3D objects only: the point the camera looks at, Z in metres\"";
const TEMPLATE_PLACEHOLDER = "1,telar-placeholder,,,,,,,,,question,answer,,,,,,,,,,";
const PLANTILLA_HEADER =
  "paso,objeto,página,x,y,zoom,inicio_clip,fin_clip,bucle,texto_alt,pregunta,respuesta,boton_capa1,contenido_capa1,boton_capa2,contenido_capa2,acimut,elevación,distancia,objetivo_x,objetivo_y,objetivo_z";
const PLANTILLA_INSTRUCTION =
  "#,id_objeto de la pestaña objetos / objects,para objetos con múltiples páginas,Posición horizontal 0-1 (0.5 = centro),Posición vertical 0-1 (0.5 = centro),1.0 = imagen completa,\"Tiempo de inicio para clips de video/audio, ej. \"\"1:30\"\" (m:ss) o \"\"90\"\" (segundos)\",Tiempo de fin para clips de video/audio,sí para repetir el clip (loop),\"Describe lo que se ve en esta vista ampliada para lectores de pantalla. Si se deja vacío, se usa la descripción de imagen del objeto.\",Encabezado para este paso,Texto breve de 1-2 oraciones,\"Texto opcional del botón (predeterminado: \"\"Saber más\"\")\",\"Contenido del panel: escribe texto aquí, pega markdown, o indica ruta a archivo .md (ej. tu-historia/archivo.md)\",\"Texto opcional del segundo botón (predeterminado: \"\"Profundizar más\"\")\",\"Segundo panel: escribe texto aquí, pega markdown, o indica ruta a archivo .md\",\"Solo para objetos 3D: ángulo alrededor del modelo en grados (0 = de frente, 90 = derecha, -90 = izquierda, 180 = atrás)\",\"Solo para objetos 3D: ángulo de elevación en grados (0 = desde arriba, 90 = a la altura de los ojos)\",\"Solo para objetos 3D: distancia de la cámara al punto de enfoque, en metros (menor = más cerca)\",\"Solo para objetos 3D: punto que mira la cámara, eje X en metros (vacío = centro del modelo)\",\"Solo para objetos 3D: punto que mira la cámara, eje Y en metros\",\"Solo para objetos 3D: punto que mira la cámara, eje Z en metros\"";
const PLANTILLA_PLACEHOLDER = "1,telar-placeholder,,,,,,,,,pregunta,respuesta,,,,,,,,,,";

const TEMPLATE_FILE = [TEMPLATE_HEADER, TEMPLATE_INSTRUCTION, TEMPLATE_PLACEHOLDER].join("\n") + "\n";
const PLANTILLA_FILE = [PLANTILLA_HEADER, PLANTILLA_INSTRUCTION, PLANTILLA_PLACEHOLDER].join("\n") + "\n";

function readCsv(csv: string): string[][] {
  return Papa.parse<string[]>(csv, { header: false, skipEmptyLines: true }).data;
}

function stepOf(over: Partial<StepWithLayers> = {}): StepWithLayers {
  return {
    step_number: 1,
    kind: "media",
    object_id: "a",
    x: null,
    y: null,
    zoom: null,
    page: null,
    question: "Q",
    answer: "A",
    alt_text: null,
    clip_start: null,
    clip_end: null,
    loop: null,
    extra_columns: null,
    layers: [],
    ...over,
  };
}

/** The file `main` writes for these steps: no existing file, no comment rows. */
function plainRender(steps: StepWithLayers[], slug = "historia"): string {
  return serializeStory(steps, slug).csv;
}

const PLAIN_FIXED_AFTER_QA = [
  "x", "y", "zoom", "page", "alt_text", "layer1_button", "layer1_content",
  "layer2_button", "layer2_content", "clip_start", "clip_end", "loop",
];

describe("a story CSV in the template's layout", () => {
  const steps = [stepOf({ object_id: "telar-placeholder", question: "question", answer: "answer", page: "3", alt_text: "alt" })];

  it("publishes in the template's column order, header text unchanged", () => {
    const csv = serializeStory(steps, "blank_template", TEMPLATE_FILE).csv;
    expect(csv.split("\n")[0]).toBe(TEMPLATE_HEADER);
  });

  it("carries the instruction row byte for byte, below the bilingual row", () => {
    const lines = serializeStory(steps, "blank_template", TEMPLATE_FILE).csv.split("\n");
    expect(lines[2]).toBe(TEMPLATE_INSTRUCTION);
  });

  it("keeps the instruction for page under page, and every instruction under its own header", () => {
    const [header, , instruction, data] = readCsv(serializeStory(steps, "blank_template", TEMPLATE_FILE).csv);
    const page = header.indexOf("page");
    expect(instruction[page]).toBe("for multi-page items");
    expect(data[page]).toBe("3");
    const [templateHeader] = readCsv(TEMPLATE_HEADER);
    const [templateInstruction] = readCsv(TEMPLATE_INSTRUCTION);
    header.forEach((h, i) => expect(instruction[i]).toBe(templateInstruction[templateHeader.indexOf(h)]));
  });

  it("writes each step's values under the file's columns, the empty 3D columns empty", () => {
    const [, bilingual, , data] = readCsv(serializeStory(steps, "blank_template", TEMPLATE_FILE).csv);
    expect(data).toEqual(["1", "telar-placeholder", "3", "0.5", "0.5", "1", "", "", "", "alt", "question", "answer", "", "", "", "", "", "", "", "", "", ""]);
    expect(bilingual).toEqual([
      "paso", "objeto", "pagina", "x", "y", "zoom", "inicio_clip", "fin_clip", "bucle", "texto_alt",
      "pregunta", "respuesta", "boton1", "contenido1", "boton2", "contenido2", "", "", "", "", "", "",
    ]);
  });
});

describe("a story CSV with alias headers", () => {
  it("keeps página, with its comment cell and its value under it", () => {
    const csv = serializeStory([stepOf({ page: "2" })], "plantilla_en_blanco", PLANTILLA_FILE).csv;
    const lines = csv.split("\n");
    expect(lines[0]).toBe(PLANTILLA_HEADER);
    expect(lines[2]).toBe(PLANTILLA_INSTRUCTION);
    const [header, bilingual, instruction, data] = readCsv(csv);
    const page = header.indexOf("página");
    expect(page).toBe(2);
    expect(instruction[page]).toBe("para objetos con múltiples páginas");
    expect(data[page]).toBe("2");
    expect(bilingual[page]).toBe("pagina");
    expect(data[header.indexOf("pregunta")]).toBe("Q");
  });
});

describe("custom columns the file has and D1 does not record", () => {
  it("keeps a custom column empty in every data row, with empty cells", () => {
    const file = "step,object,question,answer,notas\n1,a,Q,A,\n";
    const [header, bilingual, data] = readCsv(serializeStory([stepOf()], "historia", file).csv);
    expect(header).toEqual(["step", "object", "question", "answer", "notas", ...PLAIN_FIXED_AFTER_QA]);
    expect(bilingual[4]).toBe("");
    expect(data[4]).toBe("");
  });

  it("counts a value in a comment row or the bilingual row as no value", () => {
    const file = "step,object,question,answer,notas\npaso,objeto,pregunta,respuesta,\n#,,,,a note on notas\n1,a,Q,A,\n";
    const [header] = readCsv(serializeStory([stepOf()], "historia", file).csv);
    expect(header).toContain("notas");
  });

  it("leaves out an empty column with a reserved name", () => {
    const file = "step,object,question,answer,_metadata\n1,a,Q,A,\n";
    const [header] = readCsv(serializeStory([stepOf()], "historia", file).csv);
    expect(header).not.toContain("_metadata");
  });

  it("leaves out an empty column the framework reads as one with a written column", () => {
    const file = "step,object,question,answer,nota,Nota\n1,a,Q,A,valor,\n";
    const step = stepOf({ extra_columns: JSON.stringify({ nota: "valor" }) });
    const [header, , data] = readCsv(serializeStory([step], "historia", file).csv);
    expect(header).toContain("nota");
    expect(header).not.toContain("Nota");
    expect(data[header.indexOf("nota")]).toBe("valor");
  });

  it("leaves out a column with values that D1 does not record", () => {
    const file = "step,object,question,answer,borrada\n1,a,Q,A,valor\n";
    const [header, , data] = readCsv(serializeStory([stepOf()], "historia", file).csv);
    expect(header).toEqual(["step", "object", "question", "answer", ...PLAIN_FIXED_AFTER_QA]);
    expect(data).not.toContain("valor");
  });
});

describe("comment rows", () => {
  it("lose the cell of a column left out, the later cells staying under their headers", () => {
    const file = "step,object,borrada,question,answer\n#,the object,a removed column,the heading,the text\n1,a,valor,Q,A\n";
    const lines = serializeStory([stepOf()], "historia", file).csv.split("\n");
    expect(lines[0]).toBe(["step", "object", "question", "answer", ...PLAIN_FIXED_AFTER_QA].join(","));
    expect(lines[2]).toBe("#,the object,the heading,the text");
  });

  it("lose the cell of an empty reserved column left out", () => {
    const file = "step,object,_metadata,question,answer\n#,the object,reserved,the heading,the text\n1,a,,Q,A\n";
    const lines = serializeStory([stepOf()], "historia", file).csv.split("\n");
    expect(lines[2]).toBe("#,the object,the heading,the text");
  });

  it("are carried byte for byte when no column is left out", () => {
    const comment = '#,"quoted, with a comma",  spaced  ,""';
    const file = `step,object,question,answer\n${comment}\n1,a,Q,A\n`;
    expect(serializeStory([stepOf()], "historia", file).csv.split("\n")[2]).toBe(comment);
  });
});

describe("the columns the file does not have", () => {
  it("are appended: fixed columns in their order, then D1's kept keys", () => {
    const file = "step,object,question,answer\n1,a,Q,A\n";
    const step = stepOf({ extra_columns: JSON.stringify({ "Nota del autor": "n" }) });
    const [header, , data] = readCsv(serializeStory([step], "historia", file).csv);
    expect(header).toEqual(["step", "object", "question", "answer", ...PLAIN_FIXED_AFTER_QA, "Nota del autor"]);
    expect(data.at(-1)).toBe("n");
  });

  it("leave a kept key the file has in the file's place", () => {
    const file = "step,Nota del autor,object,question,answer\n1,n,a,Q,A\n";
    const step = stepOf({ extra_columns: JSON.stringify({ "Nota del autor": "editada" }) });
    const [header, , data] = readCsv(serializeStory([step], "historia", file).csv);
    expect(header.slice(0, 5)).toEqual(["step", "Nota del autor", "object", "question", "answer"]);
    expect(data[1]).toBe("editada");
  });
});

describe("a file that cannot be laid out publishes the plain render", () => {
  const steps = [stepOf()];
  it("a header that does not parse", () => {
    const file = 'step,"object"x",question,answer\n#,o,q,a\n1,a,Q,A\n';
    expect(serializeStory(steps, "historia", file).csv).toBe(plainRender(steps));
  });
});

/**
 * One fixture per numbered case below: a file, and the steps D1 holds for it.
 * The coordinates are set so that the published file parses back to exactly
 * these rows; the plain render would write 0.5, 0.5 and 1 in their place.
 */
interface LayoutFixture {
  file: string;
  steps: StepWithLayers[];
}

const at = (over: Partial<StepWithLayers> = {}) => stepOf({ x: 0.25, y: 0.75, zoom: 2, ...over });
const kept = (cells: Record<string, string>) => ({ extra_columns: JSON.stringify(cells) });

const FIXTURES: Record<number, LayoutFixture> = {
  1: {
    file: "step,object,question,answer,nota,nota\n#,o,q,a,n1,n2\n1,a,Q,A,x,y\n",
    steps: [at(kept({ nota: "x", nota_1: "y" }))],
  },
  2: {
    file: "step,object,question,answer,nota, nota \n#,o,q,a,n1,n2\n1,a,Q,A,x,y\n",
    steps: [at(kept({ nota: "x", nota_1: "y" }))],
  },
  3: { file: "step,object,page,pagina,question,answer\n#,o,p1,p2,q,a\n1,a,,,Q,A\n", steps: [at()] },
  4: { file: "step,object,,question,answer\n#,o,e,q,a\n1,a,,Q,A\n", steps: [at()] },
  5: { file: "borrada,step,object,question,answer\n#,b,s,o,q\nv,1,a,Q,A\n", steps: [at()] },
  6: { file: 'step,object,borrada,question,answer\n#,o,"b"x",q,a\n1,a,v,Q,A\n', steps: [at()] },
  7: { file: ",step,object,question,answer\n# guide,s,o,q,a\n,1,a,Q,A\n", steps: [at()] },
  8: {
    file: "step,object,,x,,y,question,answer\n#,o,b1,x,b2,y,q,a\n1,a,,0.25,,0.75,Q,A\n",
    steps: [at(kept({ "Nota del autor": "n" }))],
  },
  9: { file: "step,object,,unnamed: 2,question,answer\n#,o,b,u,q,a\n1,a,,,Q,A\n", steps: [at()] },
  10: { file: "Step,Object,Question,Answer\n1,a,Q,A\n", steps: [at()] },
  11: {
    file: "página,step,object,page,answer,question,nota\n#,s,o,p,a,q,n\n,1,a,2,A,Q,x\n",
    steps: [at({ page: "2", ...kept({ nota: "x" }) })],
  },
  12: { file: "question,step,object,answer\nQ,1,a,A\n", steps: [at({ question: "# Why" })] },
};

const published = (n: number, file = FIXTURES[n]?.file) =>
  serializeStory(FIXTURES[n]?.steps ?? [at()], "historia", file).csv;
const lineOf = (n: number, i: number) => published(n).split("\n")[i];
const headerOf = (n: number) => readCsv(published(n))[0];

describe("a file the import names by position publishes in its own layout", () => {
  it("1: a repeated header is written under the name the import gives it, in place", () => {
    const [header, , comment, data] = readCsv(published(1));
    expect(header).toEqual(["step", "object", "question", "answer", "nota", "nota_1", ...PLAIN_FIXED_AFTER_QA]);
    expect(lineOf(1, 2)).toBe("#,o,q,a,n1,n2");
    expect(comment).toEqual(["#", "o", "q", "a", "n1", "n2"]);
    expect(data.slice(4, 6)).toEqual(["x", "y"]);
  });

  it("2: a header repeated with spaces round it is the same", () => {
    expect(headerOf(2).slice(4, 6)).toEqual(["nota", "nota_1"]);
    expect(lineOf(2, 2)).toBe("#,o,q,a,n1,n2");
  });

  it("3: of two headers for one fixed column the one the import keeps stays, the other goes with its comment cell", () => {
    expect(headerOf(3)).toEqual(["step", "object", "page", "question", "answer", "x", "y", "zoom", "alt_text",
      "layer1_button", "layer1_content", "layer2_button", "layer2_content", "clip_start", "clip_end", "loop"]);
    expect(lineOf(3, 2)).toBe("#,o,p1,q,a");
  });

  it("4: an empty header cell stays in place, empty, and the comment row is carried byte for byte", () => {
    expect(lineOf(4, 0).startsWith("step,object,,question,answer,")).toBe(true);
    expect(lineOf(4, 2)).toBe("#,o,e,q,a");
  });

  it("5: a first column with values D1 does not record is kept empty in place", () => {
    const [header, , , data] = readCsv(published(5));
    expect(header.slice(0, 5)).toEqual(["borrada", "step", "object", "question", "answer"]);
    expect(lineOf(5, 2)).toBe("#,b,s,o,q");
    expect(data[0]).toBe("");
    expect(data.slice(1, 5)).toEqual(["1", "a", "Q", "A"]);
  });

  it("6: a column left out takes its cell out of a comment record Papa refused, read again from its repair", () => {
    expect(headerOf(6).slice(0, 4)).toEqual(["step", "object", "question", "answer"]);
    expect(headerOf(6)).not.toContain("borrada");
    expect(lineOf(6, 2)).toBe("#,o,q,a");
  });

  it("7: an empty first header cell stays in place, the comment marker in column 1", () => {
    expect(lineOf(7, 0).startsWith(",step,object,question,answer,")).toBe(true);
    expect(lineOf(7, 2)).toBe("# guide,s,o,q,a");
  });

  it("8: two empty header cells both stay", () => {
    expect(lineOf(8, 0).startsWith("step,object,,x,,y,question,answer,")).toBe(true);
    expect(lineOf(8, 2)).toBe("#,o,b1,x,b2,y,q,a");
  });

  it("9: an empty header cell beside a header pandas' name for it folds to is left out, with its comment cell", () => {
    expect(headerOf(9).slice(0, 5)).toEqual(["step", "object", "unnamed: 2", "question", "answer"]);
    expect(lineOf(9, 2)).toBe("#,o,u,q,a");
  });

  it("10: a fixed column's header the framework reads as another column is written in English", () => {
    expect(headerOf(10).slice(0, 4)).toEqual(["step", "object", "question", "answer"]);
  });

  it("11: a collision loser in the first column goes, with the comment rows that stop being comments", () => {
    const rows = readCsv(published(11));
    expect(rows[0]).toEqual(["step", "object", "page", "answer", "question", "nota", "x", "y", "zoom", "alt_text",
      "layer1_button", "layer1_content", "layer2_button", "layer2_content", "clip_start", "clip_end", "loop"]);
    expect(rows).toHaveLength(3);
    expect(rows[2].slice(0, 6)).toEqual(["1", "a", "2", "A", "Q", "x"]);
  });

  it("12: a D1 value in the first column that would read as a comment takes the plain render", () => {
    expect(published(12)).toBe(plainRender(FIXTURES[12].steps));
  });
});

describe("a header whose first cell opens with the comment marker", () => {
  it("is written once as the header, and republishing reaches a fixed point after the first publish", () => {
    const file = "#,step,object,question,answer\n#,s,o,q,a\n,1,a,Q,A\n";
    const outputs = [published(0, file)];
    while (outputs.length < 4) outputs.push(published(0, outputs[outputs.length - 1]));
    expect(outputs[0].split("\n").filter((line) => line.startsWith("#,step"))).toHaveLength(1);
    for (const later of outputs.slice(1)) expect(later).toBe(outputs[0]);
  });
});

/** D1 rows as the import stores them from `csv`, ids in row order. */
function importedRows(csv: string): StoryStepRow[] {
  const rows = parseTelarCsv(csv, undefined, false, STORY_CANONICAL_SCOPE);
  return mapStoryCsv(rows, 1).steps.map((s, i) => ({
    id: 100 + i,
    step_number: s.step_number,
    kind: s.kind ?? "media",
    object_id: s.object_id ?? null,
    x: s.x ?? null,
    y: s.y ?? null,
    zoom: s.zoom ?? null,
    page: s.page ?? null,
    question: s.question ?? null,
    answer: s.answer ?? null,
    alt_text: s.alt_text ?? null,
    clip_start: s.clip_start ?? null,
    clip_end: s.clip_end ?? null,
    loop: s.loop ?? null,
    extra_columns: s.extra_columns ?? null,
  }));
}

async function csvOf(slug: string, rows: StoryStepRow[], existing?: string): Promise<string> {
  const files = await renderStoryFiles(slug, rows, [], "en", existing);
  return files.find((f) => f.path === `telar-content/spreadsheets/${slug}.csv`)!.content;
}

describe("the change check on a story published in the template's layout", () => {
  it("reads it as unchanged: the published file's compare form is D1's", async () => {
    const rows = importedRows(TEMPLATE_FILE);
    const published = await csvOf("blank_template", rows, TEMPLATE_FILE);
    expect(published.split("\n")[2]).toBe(TEMPLATE_INSTRUCTION);
    expect(await canonicalForCompareFromFiles("blank_template", published, {})).toEqual(
      await canonicalForCompareFromD1("blank_template", rows, []),
    );
  });

  it("parses the published file to the D1 rows it was written from", async () => {
    const rows: StoryStepRow[] = [
      { ...importedRows(TEMPLATE_FILE)[0], x: 0.25, y: 0.75, zoom: 2, page: "3", alt_text: "alt" },
    ];
    const published = await csvOf("blank_template", rows, TEMPLATE_FILE);
    const parsed = await canonicalRaw(await parseStoryFiles("blank_template", published, {}));
    expect(parsed).toEqual(await rawCanonicalFromD1(rows, []));
  });
});

/** D1's rows for `steps`, as `renderStoryFiles` reads them. */
function rowsOf(steps: StepWithLayers[]): StoryStepRow[] {
  return steps.map(({ layers: _layers, ...step }, i) => ({ id: 200 + i, ...step, extra_columns: step.extra_columns ?? null }));
}

describe("13: every file-layout fixture parses back to the D1 rows it was written from", () => {
  it.each(Object.keys(FIXTURES).map(Number))("fixture %i", async (n) => {
    const rows = rowsOf(FIXTURES[n].steps);
    const written = await csvOf("historia", rows, FIXTURES[n].file);
    const parsed = await canonicalRaw(await parseStoryFiles("historia", written, {}));
    expect(parsed).toEqual(await rawCanonicalFromD1(rows, []));
  });
});

/** The text cells D1 holds for a step, by the name the framework reads them under. */
function textCellsOf(step: StepWithLayers): Record<string, string> {
  const cells: Record<string, string> = { object: step.object_id ?? "", question: step.question ?? "", answer: step.answer ?? "" };
  return { ...cells, ...(step.extra_columns ? (JSON.parse(step.extra_columns) as Record<string, string>) : {}) };
}

describeWithFrameworkTag(PUBLISHED_FRAMEWORK_TAG, "30: the published story files, read by both framework releases", () => {
  const releases = () => [
    ["the test instance", FRAMEWORK_SCRIPTS_DIR],
    [PUBLISHED_FRAMEWORK_TAG, frameworkScriptsAtTag(PUBLISHED_FRAMEWORK_TAG)],
  ] as const;

  it.each(Object.keys(FIXTURES).map(Number))("fixture %i builds with each value under its field", (n) => {
    for (const [release, scripts] of releases()) {
      const read = frameworkCsvToJson(published(n), "story", scripts);
      expect(read.ok, `${release}: ${read.log}`).toBe(true);
      expect(read.rows, release).toHaveLength(1);
      for (const [field, value] of Object.entries(textCellsOf(FIXTURES[n].steps[0]))) {
        expect(read.rows[0][field], `${release}: ${field}`).toBe(value);
      }
    }
  }, FRAMEWORK_TIMEOUT_MS);

  it("carries step and question in fixture 10, which the file heads Step and Question", () => {
    for (const [release, scripts] of releases()) {
      const row = frameworkCsvToJson(published(10), "story", scripts).rows[0];
      expect(Object.keys(row), release).toEqual(expect.arrayContaining(["step", "question"]));
    }
  }, FRAMEWORK_TIMEOUT_MS);
});
