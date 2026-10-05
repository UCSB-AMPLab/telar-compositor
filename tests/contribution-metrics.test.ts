/**
 * The accounting behind the two new measures, held to what the copy promises.
 *
 * The record tells the user that the clock starts on a change and stops after a
 * minute unless a new change is detected, and that words measure length rather
 * than quality. Those are claims about arithmetic, so the tests that matter here
 * are the ones that would catch the arithmetic drifting from the sentence: an
 * isolated change worth a minute, a run of changes worth its span, a restart that
 * does not buy a free minute, and a word count that cannot be inflated by
 * deleting or by editing somebody else's paragraph.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";

import {
  EDITING_WINDOW_MS,
  creditChange,
  creditWords,
  peekTimeCredits,
  proseFieldOf,
  seedTimeLedger,
  settleTimeCredits,
  settleWords,
} from "../workers/contribution-metrics";
import type { TimeLedger, WordBaseline, WordsByRow } from "../workers/contribution-metrics";
import { countWords } from "~/lib/contributions";

/** Read the ledger and settle it, as a snapshot whose batch succeeded does. */
function drain(ledger: TimeLedger) {
  const credits = peekTimeCredits(ledger);
  settleTimeCredits(ledger, credits);
  return credits;
}

/** ISO stamps `seconds` apart, from a fixed instant. */
const T0 = Date.parse("2026-09-02T10:00:00.000Z");
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();

/** A real `_temp_id` — the UUID-shaped id the editor mints. */
const TEMP = "3f2a91c4-8e1d-4b7a-9c3e-2d5f7a1b4c8e";

describe("counting words", () => {
  it("counts runs of non-whitespace", () => {
    expect(countWords("Un retrato de la Virgen")).toBe(5);
  });

  it("is zero for nothing and for whitespace", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n\t ")).toBe(0);
  });

  it("counts markdown as written, which is the promised crudeness", () => {
    expect(countWords("**Muy** importante")).toBe(2);
  });
});

describe("recognising a prose field", () => {
  it("reads a step's answer", () => {
    expect(proseFieldOf("stories:7:steps:11:answer")).toEqual({
      segment: "steps", rowId: "11", field: "answer",
    });
  });

  it("credits a panel's words to the panel, not to the step holding it", () => {
    // The contributor set deliberately matches every ancestor of a path; words
    // must not, or the same 200 words are reported three times.
    expect(proseFieldOf("stories:7:steps:11:layers:91:content")).toEqual({
      segment: "layers", rowId: "91", field: "content",
    });
  });

  it("declines a change that is not typing", () => {
    expect(proseFieldOf("stories:7:steps:11:zoom")).toBeNull();
    expect(proseFieldOf("stories:7:steps:11:order_key")).toBeNull();
  });

  it("declines a path too short to name a row", () => {
    expect(proseFieldOf("stories")).toBeNull();
  });

  it("declines a row id no contributor row could be keyed by", () => {
    // Words and contributor rows are read out of the same parse, so a segment
    // the field-path resolver could not render an id for has to be refused
    // here too: credited words that no contributor row ever settles are owed to
    // a row nothing will write.
    expect(proseFieldOf("stories:7:steps:tmp_a1:answer")).toBeNull();
    expect(proseFieldOf("stories:7:steps:0:answer")).toBeNull();
    expect(proseFieldOf("stories:7:steps::answer")).toBeNull();
  });

  it("accepts a D1 id and a client temp id", () => {
    expect(proseFieldOf("stories:7:steps:11:answer")!.rowId).toBe("11");
    expect(proseFieldOf(`stories:7:steps:${TEMP}:answer`)!.rowId).toBe(TEMP);
  });
});

describe("the editing clock", () => {
  it("gives an isolated change a whole minute", () => {
    const ledger: TimeLedger = new Map();
    creditChange(ledger, 4, at(0), false);

    expect(drain(ledger)).toEqual([
      { userId: 4, editingSeconds: 60, writingSeconds: 0, lastChangeAt: at(0), lastWriteAt: null },
    ]);
  });

  it("gives a run of changes its span, not a minute each", () => {
    const ledger: TimeLedger = new Map();
    for (const s of [0, 20, 40, 70, 100]) creditChange(ledger, 4, at(s), false);

    // 60 for the first, then 20 + 20 + 30 + 30 as each change extends the clock.
    expect(drain(ledger)[0].editingSeconds).toBe(160);
  });

  it("starts a new stretch when the gap exceeds the window", () => {
    const ledger: TimeLedger = new Map();
    creditChange(ledger, 4, at(0), false);
    creditChange(ledger, 4, at(600), false);

    expect(drain(ledger)[0].editingSeconds).toBe(120);
  });

  it("pays nothing for a stamp older than the one it holds", () => {
    // Two instances can stamp out of order; the earlier stretch is already paid.
    const ledger: TimeLedger = new Map();
    creditChange(ledger, 4, at(300), false);
    creditChange(ledger, 4, at(120), false);

    const [credit] = drain(ledger);
    expect(credit.editingSeconds).toBe(60);
    expect(credit.lastChangeAt).toBe(at(300));
  });

  it("counts writing inside editing, on its own stamp", () => {
    const ledger: TimeLedger = new Map();
    creditChange(ledger, 4, at(0), true);      // types
    creditChange(ledger, 4, at(30), false);    // frames an image
    creditChange(ledger, 4, at(300), true);    // types again

    const [credit] = drain(ledger);
    // Editing: 60 + 30 + 60. Writing: two separate minutes, five minutes apart.
    expect(credit.editingSeconds).toBe(150);
    expect(credit.writingSeconds).toBe(120);
    expect(credit.writingSeconds).toBeLessThan(credit.editingSeconds);
  });

  it("does not buy a free minute when the Durable Object restarts", () => {
    // The whole reason the stamps are stored: an eviction after ten seconds of
    // quiet must not turn the next keystroke into a minute of recorded work.
    const restarted: TimeLedger = new Map();
    seedTimeLedger(restarted, 4, at(0), null);
    creditChange(restarted, 4, at(20), false);

    expect(drain(restarted)[0].editingSeconds).toBe(20);
  });

  it("keeps the stored stamp when it is fresher than the seed", () => {
    const ledger: TimeLedger = new Map();
    creditChange(ledger, 4, at(500), false);
    seedTimeLedger(ledger, 4, at(100), null);

    expect(drain(ledger)[0].lastChangeAt).toBe(at(500));
  });
});

describe("draining the ledger", () => {
  it("carries the sub-second remainder rather than rounding it away", () => {
    const ledger: TimeLedger = new Map();
    const half = new Date(T0 + 1500).toISOString();
    creditChange(ledger, 4, at(0), false);
    creditChange(ledger, 4, half, false);       // 60000 + 1500 ms

    expect(drain(ledger)[0].editingSeconds).toBe(61);
    // The stray 500 ms is still owed, and the next window pays it.
    creditChange(ledger, 4, new Date(T0 + 2000).toISOString(), false);
    expect(drain(ledger)[0].editingSeconds).toBe(1);
  });

  it("reports a person whose only pending time is a fraction, for the stamp", () => {
    const ledger: TimeLedger = new Map();
    seedTimeLedger(ledger, 4, at(0), null);
    creditChange(ledger, 4, new Date(T0 + 400).toISOString(), false);

    expect(drain(ledger)).toEqual([
      {
        userId: 4,
        editingSeconds: 0,
        writingSeconds: 0,
        lastChangeAt: new Date(T0 + 400).toISOString(),
        lastWriteAt: null,
      },
    ]);
  });

  it("leaves nothing behind for a second drain", () => {
    const ledger: TimeLedger = new Map();
    creditChange(ledger, 4, at(0), false);
    drain(ledger);

    expect(drain(ledger)[0].editingSeconds).toBe(0);
  });

  it("still owes the time when the snapshot's batch was refused", () => {
    // Reading and settling are separate acts precisely for this: the work
    // happened and the ledger is the only record of it.
    const ledger: TimeLedger = new Map();
    creditChange(ledger, 4, at(0), false);
    peekTimeCredits(ledger);                       // built the statements
    // ...and the batch threw, so nothing is settled.

    expect(drain(ledger)[0].editingSeconds).toBe(60);
  });

  it("keeps time that arrived while the snapshot was in flight", () => {
    const ledger: TimeLedger = new Map();
    creditChange(ledger, 4, at(0), false);
    const written = peekTimeCredits(ledger);
    creditChange(ledger, 4, at(30), false);        // typed on, mid-batch
    settleTimeCredits(ledger, written);

    expect(drain(ledger)[0].editingSeconds).toBe(30);
  });
});

describe("settling words", () => {
  it("keeps words that arrived while the snapshot was in flight", () => {
    const words: WordsByRow = new Map();
    const baseline: WordBaseline = new Map();
    const path = "stories:7:steps:11:answer";
    baseline.set(path, 0);
    creditWords(words, baseline, path, 4, "one two three");
    const written = [{ segment: "steps", rowId: "11", userId: 4, words: 3 }];
    creditWords(words, baseline, path, 4, "one two three four five");
    settleWords(words, written);

    expect(words.get("steps")?.get("11")?.get(4)).toBe(2);
  });

  it("drops the person once everything they wrote is settled", () => {
    const words: WordsByRow = new Map();
    const baseline: WordBaseline = new Map();
    const path = "stories:7:steps:11:answer";
    baseline.set(path, 0);
    creditWords(words, baseline, path, 4, "one two three");
    settleWords(words, [{ segment: "steps", rowId: "11", userId: 4, words: 3 }]);

    expect(words.get("steps")?.get("11")?.get(4)).toBeUndefined();
  });
});

describe("counting words written", () => {
  const fresh = (): [WordsByRow, WordBaseline] => [new Map(), new Map()];
  const path = "stories:7:steps:11:answer";

  it("credits the rise, not the whole field", () => {
    const [words, baseline] = fresh();
    baseline.set(path, 400);
    creditWords(words, baseline, path, 4, "one two three ".repeat(140).trim());

    expect(words.get("steps")?.get("11")?.get(4)).toBe(20);
  });

  it("credits nothing the first time it sees a field, and remembers it", () => {
    const [words, baseline] = fresh();
    creditWords(words, baseline, path, 4, "Un retrato de la Virgen");
    creditWords(words, baseline, path, 4, "Un retrato de la Virgen de Chiquinquira");

    expect(words.get("steps")?.get("11")?.get(4)).toBe(2);
  });

  it("records a counted nought for a prose edit that adds nothing", () => {
    // The difference the record renders as a grey zero against an em dash: a
    // person who fixed a typo has been counted, one who only reframed an image
    // has not.
    const [words, baseline] = fresh();
    baseline.set(path, 5);
    creditWords(words, baseline, path, 4, "Un retrato de la Virgen");

    expect(words.get("steps")?.get("11")?.get(4)).toBe(0);
  });

  it("does not pay twice for a row that has just been given its D1 id", () => {
    // A step carries a client _temp_id until the snapshot puts it in D1, and
    // every path under it is rewritten then. Reading the absent baseline as
    // zero would credit the whole answer a second time under the new path.
    const [words, baseline] = fresh();
    const temp = `stories:7:steps:${TEMP}:answer`;
    const real = "stories:7:steps:11:answer";
    creditWords(words, baseline, temp, 4, "");                       // created empty
    creditWords(words, baseline, temp, 4, "one two three four five");
    creditWords(words, baseline, real, 4, "one two three four five");

    expect(words.get("steps")?.get(TEMP)?.get(4)).toBe(5);
    expect(words.get("steps")?.get("11")?.get(4)).toBe(0);
  });

  it("credits nothing to a row id no contributor row could be keyed by", () => {
    // A malformed id reaches here only from a path the resolver collapsed. The
    // words would otherwise sit in the ledger owed to a row the snapshot never
    // writes, and never settle.
    const [words, baseline] = fresh();
    const malformed = "stories:7:steps:tmp_a1:answer";
    baseline.set(malformed, 0);
    const credited = creditWords(words, baseline, malformed, 4, "one two three");

    expect(credited).toBe(0);
    expect(words.get("steps")).toBeUndefined();
  });

  it("loses nothing when a field is created empty and then typed into", () => {
    const [words, baseline] = fresh();
    creditWords(words, baseline, path, 4, "");
    creditWords(words, baseline, path, 4, "Un retrato de la Virgen");

    expect(words.get("steps")?.get("11")?.get(4)).toBe(5);
  });

  it("never goes negative when somebody cuts text", () => {
    const [words, baseline] = fresh();
    baseline.set(path, 400);
    const credited = creditWords(words, baseline, path, 4, "three words left");

    expect(credited).toBe(0);
    expect(words.get("steps")?.get("11")?.get(4)).toBe(0);
  });

  it("moves the baseline down after a cut, so the retype is not free", () => {
    const [words, baseline] = fresh();
    baseline.set(path, 10);
    creditWords(words, baseline, path, 4, "one two");          // cut to 2
    creditWords(words, baseline, path, 4, "one two three");    // add 1 back

    expect(words.get("steps")?.get("11")?.get(4)).toBe(1);
  });

  it("keeps two people's words apart in the same field", () => {
    const [words, baseline] = fresh();
    baseline.set(path, 0);
    creditWords(words, baseline, path, 4, "one two");
    creditWords(words, baseline, path, 9, "one two three four");

    expect(words.get("steps")?.get("11")?.get(4)).toBe(2);
    expect(words.get("steps")?.get("11")?.get(9)).toBe(2);
  });

  it("counts nothing for a change that is not typing", () => {
    const [words, baseline] = fresh();
    creditWords(words, baseline, "stories:7:steps:11:zoom", 4, "2.5");

    expect(words.size).toBe(0);
  });
});

describe("the window the copy names", () => {
  it("is one minute", () => {
    // "The clock starts on a change and stops after a minute, unless a new
    // change is detected." The sentence is shown to users; this is the number
    // it describes.
    expect(EDITING_WINDOW_MS).toBe(60_000);
  });
});
