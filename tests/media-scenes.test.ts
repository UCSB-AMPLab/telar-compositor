/**
 * sceneRun: the steps the published page arranges together are the run of
 * consecutive steps sharing one object, as `_buildSceneMaps` groups them; a
 * step with no object is a scene of its own and ends the run.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { sceneRun } from "~/lib/media-scenes";

type Step = {
  i: number;
  object_id: string | null;
  kind?: "media" | "section";
  question: string | null;
  answer: string | null;
  extra_columns: string | null;
  layers: Array<{ title: string | null; content: string | null }>;
};

/** A step publish writes: one with a question, whatever its object. */
const written = (s: Pick<Step, "i" | "object_id" | "kind">): Step => ({
  question: "q",
  answer: null,
  extra_columns: null,
  layers: [],
  ...s,
});

const steps = ["film", "film", null, "film", "song", "song", "film"].map((object_id, i) => written({ i, object_id }));
const indices = (index: number) => sceneRun(steps, index).map((s) => s.i);

describe("sceneRun", () => {
  it("is the consecutive run sharing the step's object, whichever step of it is shown", () => {
    expect(indices(0)).toEqual([0, 1]);
    expect(indices(1)).toEqual([0, 1]);
    expect(indices(4)).toEqual([4, 5]);
    expect(indices(5)).toEqual([4, 5]);
  });

  it("does not join runs of the same object that another step separates", () => {
    expect(indices(3)).toEqual([3]);
    expect(indices(6)).toEqual([6]);
  });

  it("keeps a step with no object on its own, and is empty outside the list", () => {
    expect(indices(2)).toEqual([2]);
    expect(indices(-1)).toEqual([]);
    expect(indices(7)).toEqual([]);
  });
});

// The framework groups the story's steps after its reference pass has
// rewritten each step's object to the object it resolved to (or, for one it
// has no object for, to the value with its image extension stripped), so the
// run is of steps the site shows the same object for.
describe("sceneRun, by the object the site shows for each step", () => {
  const objects = [{ object_id: "film.jpg" }, { object_id: "song" }];
  const named = ["film", "film.jpg", "FILM", "song.png", "song", null].map((object_id, i) => written({ i, object_id }));
  const run = (list: typeof named, index: number, withObjects = objects) =>
    sceneRun(list, index, withObjects, "1.7.0").map((s) => s.i);

  it("joins steps naming one object in different forms", () => {
    expect(run(named, 0)).toEqual([0, 1, 2]);
    expect(run(named, 2)).toEqual([0, 1, 2]);
    expect(run(named, 3)).toEqual([3, 4]);
  });

  it("joins steps naming an object the site does not have by their stripped value", () => {
    const ghosts = ["ghost.jpg", "ghost", "GHOST"].map((object_id, i) => written({ i, object_id }));
    expect(run(ghosts, 0, [])).toEqual([0, 1]);
    expect(run(ghosts, 2, [])).toEqual([2]);
  });

  it("leaves the step's value as written", () => {
    run(named, 0);
    expect(named.map((s) => s.object_id)).toEqual(["film", "film.jpg", "FILM", "song.png", "song", null]);
  });
});

// The key is the cell the reference pass leaves in the story JSON, compared
// exactly: the pass does not write back a trimmed value, so ` map` and `map`
// are two scenes on the site.
describe("sceneRun, by the cell the framework groups", () => {
  const steps = (values: Array<string | null>, kinds: Array<"media" | "section"> = []): Step[] =>
    values.map((object_id, i) => written({ i, object_id, kind: kinds[i] ?? "media" }));
  const run = (list: Step[], index: number, objects = [{ object_id: "map" }]) =>
    sceneRun(list, index, objects, "1.7.0").map((s) => s.i);

  it("keeps a cell with surrounding whitespace apart from the trimmed one", () => {
    const list = steps([" map", "map"]);
    expect(run(list, 0)).toEqual([0]);
    expect(run(list, 1)).toEqual([1]);
  });

  it("joins cells the pass writes to one id", () => {
    expect(run(steps(["map", "map.jpg", "MAP"]), 0)).toEqual([0, 1, 2]);
  });

  it("does not join cells that differ only in case once written", () => {
    const list = steps(["ghost", "GHOST"]);
    expect(run(list, 0, [])).toEqual([0]);
  });

  it("keys a section step as the empty cell publish writes, whatever object it stores", () => {
    const list = steps(["map", "map", "map"], ["media", "section", "media"]);
    expect(run(list, 0)).toEqual([0]);
    expect(run(list, 1)).toEqual([1]);
    expect(run(list, 2)).toEqual([2]);
  });

  // `_buildSceneMaps` gives the Nth empty cell of the story `__title_N__` and
  // compares it with the ids of its neighbours.
  it("gives each empty cell the framework's title sentinel, which joins a neighbour naming it", () => {
    const sentinel = [{ object_id: "__title_0__" }, { object_id: "__title_1__" }];
    const list = steps(["", "__title_0__", null, "__title_1__", "__title_1__"]);
    expect(run(list, 0, sentinel)).toEqual([0, 1]);
    expect(run(list, 1, sentinel)).toEqual([0, 1]);
    expect(run(list, 2, sentinel)).toEqual([2, 3, 4]);
    expect(run(list, 4, sentinel)).toEqual([2, 3, 4]);
  });
});

// Publish leaves out a step with no content of its own (`isFullyEmptyStep`),
// so the site groups, and numbers its empty cells, without it.
describe("sceneRun, over the steps publish writes", () => {
  const objects = [{ object_id: "map" }, { object_id: "__title_0__" }];
  const empty = (i: number): Step => ({ ...written({ i, object_id: null }), question: null });
  const run = (list: Step[], index: number) =>
    sceneRun(list, index, objects, "1.7.0").map((s) => s.i);

  it("joins the steps either side of a step publish leaves out", () => {
    const list = [written({ i: 0, object_id: "map" }), empty(1), written({ i: 2, object_id: "map" })];
    expect(run(list, 0)).toEqual([0, 2]);
    expect(run(list, 2)).toEqual([0, 2]);
  });

  it("does not number a step publish leaves out among the empty cells", () => {
    const list = [empty(0), written({ i: 1, object_id: null }), written({ i: 2, object_id: "__title_0__" })];
    expect(run(list, 1)).toEqual([1, 2]);
  });

  it("keeps a step publish leaves out on its own", () => {
    const list = [written({ i: 0, object_id: "map" }), empty(1), written({ i: 2, object_id: "map" })];
    expect(run(list, 1)).toEqual([1]);
  });
});

// Publish cleans the file of the characters a Telar build rejects
// (`cleanCommitContent`), so the site groups the cleaned cell.
describe("sceneRun, by the cell as publish cleans it", () => {
  it("joins a value holding a rejected character with the value without it", () => {
    const list = [written({ i: 0, object_id: "map\u007f" }), written({ i: 1, object_id: "map" })];
    expect(sceneRun(list, 0, [{ object_id: "map" }], "1.7.0").map((s) => s.i)).toEqual([0, 1]);
  });

  it("joins two cases of a value holding a rejected character, by the object's cleaned id", () => {
    const list = [written({ i: 0, object_id: "map\u007f" }), written({ i: 1, object_id: "MAP\u007f" })];
    for (const version of ["1.8.0", "1.7.0"]) {
      expect(sceneRun(list, 0, [{ object_id: "map\u007f" }], version).map((s) => s.i)).toEqual([0, 1]);
    }
  });
});

// Before 1.8.0 the framework reads pandas' missing-value tokens as empty, so
// a step whose cell is one of them is a title card there.
describe("sceneRun, by the missing-value tokens a release reads as empty", () => {
  const objects = [{ object_id: "__title_0__" }, { object_id: "NA" }];
  const list = [written({ i: 0, object_id: "NA" }), written({ i: 1, object_id: "__title_0__" })];
  const run = (version: string | null) => sceneRun(list, 0, objects, version).map((s) => s.i);

  it("keys the cell as an empty one on 1.7.0 and on a site with no version", () => {
    expect(run("1.7.0")).toEqual([0, 1]);
    expect(run(null)).toEqual([0, 1]);
  });

  it("keys the cell as written on 1.8.0", () => {
    expect(run("1.8.0")).toEqual([0]);
  });
});
