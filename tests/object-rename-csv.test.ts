/**
 * A rename edits objects.csv, the story CSVs and glossary.csv in place: each
 * file differs from its input only in the cells the rename rewrites, and the
 * BOM, CRLF terminators, comment rows, the bilingual label row and quoted
 * multiline cells all survive byte for byte. The assertions build the
 * expected text by hand from the input, never by re-serialising it.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import {
  renameObjectRecords,
  rewriteGlossaryCsv,
  rewriteStoryCsv,
  storyObjectValues,
} from "~/lib/csv-record-scan.server";

const BOM = "﻿";

/** objects.csv with a BOM, CRLF, the label row, a comment, a quoted multiline cell and a repeated id. */
const OBJECTS =
  BOM +
  "object_id,title,description,source_url,thumbnail\r\n" +
  "id_objeto,titulo,descripcion,url_fuente,miniatura\r\n" +
  "# mapa is the map of Santafé\r\n" +
  'mapa,"Mapa de Santafé, 1791","Dice ""la muy noble"",\r\ny sigue.",,telar-content/objects/mapa.jpg\r\n' +
  "plano,Plano,,,\r\n" +
  "mapa,Mapa (again),,,/telar-content/objects/mapa.jpg\r\n";

describe("renameObjectRecords", () => {
  it("rewrites every row of the id, repeats included, and nothing else", () => {
    const result = renameObjectRecords(OBJECTS, "mapa", "mapa-nueva");
    expect(result.status).toBe("renamed");
    if (result.status !== "renamed") return;
    expect(result.rows).toBe(2);
    expect(result.text).toBe(
      BOM +
        "object_id,title,description,source_url,thumbnail\r\n" +
        "id_objeto,titulo,descripcion,url_fuente,miniatura\r\n" +
        "# mapa is the map of Santafé\r\n" +
        'mapa-nueva,"Mapa de Santafé, 1791","Dice ""la muy noble"",\r\ny sigue.",,telar-content/objects/mapa.jpg\r\n' +
        "plano,Plano,,,\r\n" +
        "mapa-nueva,Mapa (again),,,/telar-content/objects/mapa.jpg\r\n",
    );
  });

  it("rewrites the thumbnail and source cells the caller answers for, in each renamed row", () => {
    const rewriteThumbnailCell = (column: string, value: string) =>
      column === "thumbnail" ? value.replace("mapa.jpg", "mapa-nueva.jpg") : null;
    const result = renameObjectRecords(OBJECTS, "mapa", "mapa-nueva", rewriteThumbnailCell);
    expect(result.status).toBe("renamed");
    if (result.status !== "renamed") return;
    expect(result.text).toContain(",,telar-content/objects/mapa-nueva.jpg\r\n");
    expect(result.text).toContain("mapa-nueva,Mapa (again),,,/telar-content/objects/mapa-nueva.jpg\r\n");
    expect(result.text).toContain("plano,Plano,,,\r\n");
  });

  it("rewrites an audio object's source cell", () => {
    const csv = "object_id,title,source_url\nvoz,Voz,voz.mp3\notra,Otra,voz.mp3\n";
    const result = renameObjectRecords(csv, "voz", "voces", (column, value) =>
      column === "source_url" && value === "voz.mp3" ? "voces.mp3" : null,
    );
    expect(result).toEqual({
      status: "renamed",
      rows: 1,
      text: "object_id,title,source_url\nvoces,Voz,voces.mp3\notra,Otra,voz.mp3\n",
    });
  });

  it("matches a row whose id is the old id once stripped", () => {
    const csv = "object_id,title\n mapa ,Mapa\nplano,Plano\n";
    expect(renameObjectRecords(csv, "mapa", "nueva")).toEqual({
      status: "renamed",
      rows: 1,
      text: "object_id,title\nnueva,Mapa\nplano,Plano\n",
    });
  });

  it("keeps a quoted id cell quoted", () => {
    const csv = 'object_id,title\n"mapa",Mapa\n';
    expect(renameObjectRecords(csv, "mapa", "nueva")).toEqual({
      status: "renamed",
      rows: 1,
      text: 'object_id,title\n"nueva",Mapa\n',
    });
  });

  it("quotes a rewritten cell that holds a comma or a quote", () => {
    const csv = "object_id,thumbnail\nmapa,old.jpg\n";
    const result = renameObjectRecords(csv, "mapa", "nueva", () => 'a,"b"');
    expect(result).toEqual({ status: "renamed", rows: 1, text: 'object_id,thumbnail\nnueva,"a,""b"""\n' });
  });

  it("leaves the label row and a comment naming the id alone", () => {
    const csv = "object_id,title\n# mapa\nmapa,Mapa\n";
    const result = renameObjectRecords(csv, "mapa", "nueva");
    expect(result).toEqual({ status: "renamed", rows: 1, text: "object_id,title\n# mapa\nnueva,Mapa\n" });
  });

  it("answers absent for an id no row carries, and unusable for a file that does not read clean", () => {
    expect(renameObjectRecords(OBJECTS, "nada", "nueva")).toEqual({ status: "absent" });
    expect(renameObjectRecords('object_id,title\nmapa,"unterminated\n', "mapa", "nueva")).toEqual({ status: "unusable" });
    expect(renameObjectRecords("title\nMapa\n", "mapa", "nueva")).toEqual({ status: "unusable" });
  });
});

/** A story with a BOM, CRLF, the label row, a comment row, inline text and a layer file. */
const STORY =
  BOM +
  "step,objeto,question,answer,layer1_button,layer1_content\r\n" +
  "paso,objeto,pregunta,respuesta,boton_capa1,contenido_capa1\r\n" +
  "# mapa appears here in a comment,mapa\r\n" +
  '1,mapa,"Where, exactly?","Here.\r\nAnd ""here"".",More,"See ![mapa](mapa.jpg) now"\r\n' +
  "2,mapa.jpg,Q,A,More,layer-two.md\r\n" +
  "3,plano,Q,mapa,,\r\n";

const keepText = (text: string) => text;

describe("rewriteStoryCsv", () => {
  it("changes only the object cells whose raw value is a step value", () => {
    const result = rewriteStoryCsv(STORY, { stepValues: new Set(["mapa", "mapa.jpg"]), newId: "nueva", rewriteText: keepText });
    expect(result).toEqual({
      status: "rewritten",
      cells: 2,
      text:
        BOM +
        "step,objeto,question,answer,layer1_button,layer1_content\r\n" +
        "paso,objeto,pregunta,respuesta,boton_capa1,contenido_capa1\r\n" +
        "# mapa appears here in a comment,mapa\r\n" +
        '1,nueva,"Where, exactly?","Here.\r\nAnd ""here"".",More,"See ![mapa](mapa.jpg) now"\r\n' +
        "2,nueva,Q,A,More,layer-two.md\r\n" +
        "3,plano,Q,mapa,,\r\n",
    });
  });

  it("rewrites both columns that resolve to object", () => {
    const csv = "step,object,objeto\n1,mapa,mapa\n2,plano,mapa\n";
    const result = rewriteStoryCsv(csv, { stepValues: new Set(["mapa"]), newId: "nueva", rewriteText: keepText });
    expect(result).toEqual({ status: "rewritten", cells: 3, text: "step,object,objeto\n1,nueva,nueva\n2,plano,nueva\n" });
  });

  it("rewrites inline layer text and leaves a cell naming a .md file", () => {
    const rewriteText = (text: string) => text.replace("(mapa.jpg)", "(nueva.jpg)");
    const csv = "step,object,layer1_content,layer2_file\n1,x,See ![m](mapa.jpg),notes ![m](mapa.jpg).md\n";
    const result = rewriteStoryCsv(csv, { stepValues: new Set(), newId: "nueva", rewriteText });
    expect(result).toEqual({
      status: "rewritten",
      cells: 1,
      text: "step,object,layer1_content,layer2_file\n1,x,See ![m](nueva.jpg),notes ![m](mapa.jpg).md\n",
    });
  });

  it("answers unchanged when nothing names the object, and unusable for a broken file", () => {
    expect(rewriteStoryCsv(STORY, { stepValues: new Set(["nada"]), newId: "n", rewriteText: keepText })).toEqual({
      status: "unchanged",
    });
    expect(rewriteStoryCsv('step,object\n1,"open\n', { stepValues: new Set(["open"]), newId: "n", rewriteText: keepText })).toEqual({
      status: "unusable",
    });
  });
});

describe("storyObjectValues", () => {
  it("reads the raw object cells of the kept rows only", () => {
    expect(storyObjectValues(STORY)).toEqual(["mapa", "mapa.jpg", "plano"]);
  });
});

describe("rewriteGlossaryCsv", () => {
  it("rewrites definition cells and nothing else", () => {
    const csv = "term_id,title,definition\r\nmapa,Mapa,\"A map: ![m](mapa.jpg)\"\r\n";
    const result = rewriteGlossaryCsv(csv, (text) => text.replace("mapa.jpg", "nueva.jpg"));
    expect(result).toEqual({
      status: "rewritten",
      cells: 1,
      text: "term_id,title,definition\r\nmapa,Mapa,\"A map: ![m](nueva.jpg)\"\r\n",
    });
  });
});
