/**
 * This file answers one question in the runtime that decides it: does the
 * Workers runtime have `Intl.ListFormat`, and does it join a list the way each
 * locale does?
 *
 * The publish page's formatting warning names the kinds of markup an answer
 * uses and joins them through i18next's `list` formatter, which is
 * `Intl.ListFormat`. Node has it; the pages this project serves are rendered
 * by workerd, and a runtime without the formatter would either throw or join
 * the English way in Spanish. Reading a compatibility note would leave that a
 * claim about a document; running it here makes it a fact about the runtime
 * the site actually uses.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";

describe("Intl.ListFormat in the Workers runtime", () => {
  it("exists", () => {
    expect(typeof Intl.ListFormat).toBe("function");
  });

  it("joins three items with English's own conjunction", () => {
    const formatter = new Intl.ListFormat("en");
    expect(formatter.format(["lists", "headings", "block quotes"])).toBe(
      "lists, headings, and block quotes",
    );
  });

  it("joins three items with Spanish's own conjunction", () => {
    const formatter = new Intl.ListFormat("es");
    expect(formatter.format(["listas", "encabezados", "citas"])).toBe(
      "listas, encabezados y citas",
    );
  });

  it("joins two items without a comma, in both languages", () => {
    expect(new Intl.ListFormat("en").format(["lists", "headings"])).toBe("lists and headings");
    expect(new Intl.ListFormat("es").format(["listas", "encabezados"])).toBe(
      "listas y encabezados",
    );
  });
});
