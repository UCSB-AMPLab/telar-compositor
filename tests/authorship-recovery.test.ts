/**
 * Recovering authorship out of the Yjs document.
 *
 * `created_by` is written once at creation and never on edit, so roughly
 * three-quarters of the steps in the database name nobody. The CRDT kept what
 * the snapshot discarded — every item carries the session that inserted it — and
 * sessions pair to accounts through the `created_by` key, which has both a value
 * and an owning client.
 *
 * Every document here is built by real docs exchanging updates, never by
 * constructing Yjs internals by hand. A fixture that assembles the interior can
 * encode a shape Yjs would never produce, and this file reads that interior:
 * `_map` for key items and `_start`/`right` for text runs. Built this way the
 * tests also fail if a Yjs upgrade changes what those hold, which is the point —
 * there is no public API for per-item ownership.
 *
 * What these hold to:
 *
 *   - An attribution never loses its basis. Two of the three routes are
 *     inference, and a guess presented as a record is the failure that matters
 *     here: this is somebody's coursework.
 *   - Unanimity or nothing. An entity whose keys were written by two people's
 *     sessions has no single maker, and naming one is the misattribution the
 *     whole exercise exists to avoid.
 *   - A session writing two different user ids is a REORDER, not a shared login,
 *     and resolves to neither person.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";

import {
  clientsTouching,
  planAuthorshipRecovery,
  renderRecoverySql,
  keyOwner,
  mapSessionsToUsers,
  recoverEntityAuthor,
  recoverEntityContributors,
  resolveSecondarySessions,
  textRuns,
} from "../app/lib/authorship-recovery";

/**
 * A stand-in for one editing session. Real Y.Docs exchanging updates, because
 * the client id on every item is what the whole method reads.
 */
class Session {
  doc: Y.Doc;
  constructor(public clientID: number) {
    this.doc = new Y.Doc();
    this.doc.clientID = clientID;
  }
  sync(from: Session): void {
    Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(from.doc));
  }
  stories(): Y.Array<Y.Map<unknown>> {
    return this.doc.getArray<Y.Map<unknown>>("stories");
  }
}

/** Everything a fresh reader sees, which is what the backfill decodes. */
function readerOf(...sessions: Session[]): Y.Doc {
  const reader = new Y.Doc();
  for (const s of sessions) Y.applyUpdate(reader, Y.encodeStateAsUpdate(s.doc));
  return reader;
}

function storyMaps(doc: Y.Doc): Y.Map<unknown>[] {
  const out: Y.Map<unknown>[] = [];
  const arr = doc.getArray<unknown>("stories");
  for (let i = 0; i < arr.length; i++) {
    const m = arr.get(i);
    if (m instanceof Y.Map) out.push(m);
  }
  return out;
}

/** One session creates a story stating its author, and writes some prose. */
function createStory(s: Session, opts: { createdBy: number | null; title: string }): void {
  s.doc.transact(() => {
    const m = new Y.Map<unknown>();
    if (opts.createdBy !== null) m.set("created_by", opts.createdBy);
    m.set("title", new Y.Text(opts.title));
    s.stories().push([m]);
  });
}

describe("reading the document's per-item ownership", () => {
  it("names the session that wrote a map key", () => {
    const ana = new Session(1001);
    createStory(ana, { createdBy: 7, title: "Ana's story" });
    const doc = readerOf(ana);

    expect(keyOwner(storyMaps(doc)[0], "created_by")).toBe(1001);
    expect(keyOwner(storyMaps(doc)[0], "nonexistent")).toBe(null);
  });

  it("decomposes text into the runs its sessions inserted", () => {
    const ana = new Session(1001);
    const beto = new Session(2002);
    createStory(ana, { createdBy: 7, title: "Hello " });
    beto.sync(ana);
    beto.doc.transact(() => {
      (storyMaps(beto.doc)[0].get("title") as Y.Text).insert(6, "world");
    });
    const doc = readerOf(ana, beto);

    expect(textRuns(storyMaps(doc)[0].get("title") as Y.Text)).toEqual([
      { client: 1001, text: "Hello " },
      { client: 2002, text: "world" },
    ]);
  });

  it("counts everyone who touched an entity, not only its maker", () => {
    const ana = new Session(1001);
    const beto = new Session(2002);
    createStory(ana, { createdBy: 7, title: "Draft" });
    beto.sync(ana);
    beto.doc.transact(() => {
      (storyMaps(beto.doc)[0].get("title") as Y.Text).insert(5, " revised");
    });
    const doc = readerOf(ana, beto);

    expect([...clientsTouching(storyMaps(doc)[0])].sort()).toEqual([1001, 2002]);
  });
});

describe("pairing sessions with accounts", () => {
  it("pairs a session through the created_by it wrote", () => {
    const ana = new Session(1001);
    createStory(ana, { createdBy: 7, title: "A" });
    const doc = readerOf(ana);

    const sessions = mapSessionsToUsers(storyMaps(doc));
    expect(sessions.users.get(1001)).toEqual({ userId: 7, basis: "stated" });
    expect(sessions.conflicted.size).toBe(0);
  });

  it("refuses a session that stated two different users, and calls it neither", () => {
    // A reorder, not a shared login. reorderInPlace clones the moved map and
    // copies created_by intact, so one session can end up owning the created_by
    // of entities several people made. Resolving it to either would attribute
    // one person's writing to another.
    const mixed = new Session(1001);
    createStory(mixed, { createdBy: 7, title: "A" });
    createStory(mixed, { createdBy: 8, title: "B" });
    const doc = readerOf(mixed);

    const sessions = mapSessionsToUsers(storyMaps(doc));
    expect(sessions.conflicted.has(1001)).toBe(true);
    expect(sessions.users.has(1001)).toBe(false);
  });

  it("ignores a created_by that is not a user id", () => {
    const ana = new Session(1001);
    ana.doc.transact(() => {
      const m = new Y.Map<unknown>();
      m.set("created_by", "not-a-user");
      m.set("title", new Y.Text("A"));
      ana.stories().push([m]);
    });
    const doc = readerOf(ana);

    expect(mapSessionsToUsers(storyMaps(doc)).users.size).toBe(0);
  });
});

describe("resolving a session that never stated an author", () => {
  it("infers the person when every entity it touched is theirs, and says it inferred", () => {
    // A second device or a reloaded tab. Reconnection ran to several hundred per
    // student in the cohort, so these sessions are numerous and dropping them
    // would discard real work.
    const ana = new Session(1001);
    const anaPhone = new Session(1002);
    createStory(ana, { createdBy: 7, title: "Draft" });
    anaPhone.sync(ana);
    anaPhone.doc.transact(() => {
      (storyMaps(anaPhone.doc)[0].get("title") as Y.Text).insert(5, " more");
    });
    const doc = readerOf(ana, anaPhone);
    const maps = storyMaps(doc);

    const resolved = resolveSecondarySessions(maps, mapSessionsToUsers(maps));
    expect(resolved.users.get(1002)).toEqual({ userId: 7, basis: "sole_editor" });
    // The pairing the document states is untouched and still reads as stated.
    expect(resolved.users.get(1001)).toEqual({ userId: 7, basis: "stated" });
  });

  it("leaves a session unresolved when it touched two people's entities", () => {
    // Ambiguous, and a tie broken by frequency is a coin toss wearing a number.
    const ana = new Session(1001);
    const beto = new Session(2002);
    const unknown = new Session(3003);
    createStory(ana, { createdBy: 7, title: "Ana" });
    beto.sync(ana);
    createStory(beto, { createdBy: 8, title: "Beto" });
    unknown.sync(beto);
    unknown.doc.transact(() => {
      for (const m of storyMaps(unknown.doc)) {
        (m.get("title") as Y.Text).insert(0, "x");
      }
    });
    const doc = readerOf(ana, beto, unknown);
    const maps = storyMaps(doc);

    const resolved = resolveSecondarySessions(maps, mapSessionsToUsers(maps));
    expect(resolved.users.has(3003)).toBe(false);
  });
});

describe("recovering who made an entity", () => {
  it("takes the document's own created_by when D1 holds null", () => {
    // How two objects in the cohort were recovered: the snapshot stores null and
    // the document holds a user id.
    const ana = new Session(1001);
    createStory(ana, { createdBy: 7, title: "A" });
    const doc = readerOf(ana);
    const maps = storyMaps(doc);

    expect(recoverEntityAuthor(maps[0], mapSessionsToUsers(maps))).toEqual({
      userId: 7,
      basis: "stated",
    });
  });

  it("attributes an entity that states nobody to the session that wrote it", () => {
    // The template-seeded steps: created with no user, then filled by a student.
    const ana = new Session(1001);
    createStory(ana, { createdBy: 7, title: "Ana's own" });
    ana.doc.transact(() => {
      const m = new Y.Map<unknown>();
      m.set("title", new Y.Text("Seeded, then written into"));
      ana.stories().push([m]);
    });
    const doc = readerOf(ana);
    const maps = storyMaps(doc);
    const sessions = mapSessionsToUsers(maps);

    const seeded = maps.find((m) => m.get("created_by") === undefined)!;
    expect(recoverEntityAuthor(seeded, sessions)).toEqual({ userId: 7, basis: "stated" });
  });

  it("refuses an entity whose keys two people's sessions wrote", () => {
    const ana = new Session(1001);
    const beto = new Session(2002);
    createStory(ana, { createdBy: 7, title: "Ana" });
    beto.sync(ana);
    createStory(beto, { createdBy: 8, title: "Beto" });
    // A third, authorless entity that both sessions wrote keys on.
    ana.sync(beto);
    ana.doc.transact(() => {
      const m = new Y.Map<unknown>();
      m.set("title", new Y.Text("Shared"));
      ana.stories().push([m]);
    });
    beto.sync(ana);
    beto.doc.transact(() => {
      storyMaps(beto.doc)[2].set("subtitle", new Y.Text("Beto's key"));
    });
    const doc = readerOf(ana, beto);
    const maps = storyMaps(doc);

    const shared = maps[2];
    expect(recoverEntityAuthor(shared, mapSessionsToUsers(maps))).toBe(null);
  });

  it("carries the weaker basis when the resolving session was itself inferred", () => {
    const ana = new Session(1001);
    const anaPhone = new Session(1002);
    createStory(ana, { createdBy: 7, title: "Ana" });
    anaPhone.sync(ana);
    // The phone writes into Ana's story, which is what pins it to her, and then
    // creates one that states no author.
    anaPhone.doc.transact(() => {
      (storyMaps(anaPhone.doc)[0].get("title") as Y.Text).insert(3, " again");
      const m = new Y.Map<unknown>();
      m.set("title", new Y.Text("From the phone"));
      anaPhone.stories().push([m]);
    });
    const doc = readerOf(ana, anaPhone);
    const maps = storyMaps(doc);
    const sessions = resolveSecondarySessions(maps, mapSessionsToUsers(maps));

    const fromPhone = maps.find((m) => m.get("created_by") === undefined)!;
    expect(recoverEntityAuthor(fromPhone, sessions)).toEqual({
      userId: 7,
      basis: "sole_editor",
    });
  });

  it("refuses a session whose only work is entities that state nobody", () => {
    // Found by a fixture that was wrong before the code was: a session which
    // never touches a resolvable entity has nothing to be paired against, so its
    // work stays unattributed. Correct and deliberately conservative — the
    // alternative is attributing an orphan to whoever happens to be nearby.
    const ana = new Session(1001);
    const stranger = new Session(4004);
    createStory(ana, { createdBy: 7, title: "Ana" });
    stranger.sync(ana);
    stranger.doc.transact(() => {
      const m = new Y.Map<unknown>();
      m.set("title", new Y.Text("Nothing pins this to anyone"));
      stranger.stories().push([m]);
    });
    const doc = readerOf(ana, stranger);
    const maps = storyMaps(doc);
    const sessions = resolveSecondarySessions(maps, mapSessionsToUsers(maps));

    expect(sessions.users.has(4004)).toBe(false);
    const orphan = maps.find((m) => m.get("created_by") === undefined)!;
    expect(recoverEntityAuthor(orphan, sessions)).toBe(null);
  });
});

describe("recovering who wrote in an entity", () => {
  it("names everyone who touched it, with the basis each rests on", () => {
    // The participation measure, for content predating entity_contributors.
    // Without it a contributions view knows only about editing done after it
    // shipped, and every existing project reads as though nobody worked on it.
    const ana = new Session(1001);
    const beto = new Session(2002);
    createStory(ana, { createdBy: 7, title: "Draft " });
    beto.sync(ana);
    createStory(beto, { createdBy: 8, title: "Beto's own" });
    beto.doc.transact(() => {
      (storyMaps(beto.doc)[0].get("title") as Y.Text).insert(6, "extended by Beto");
    });
    const doc = readerOf(ana, beto);
    const maps = storyMaps(doc);

    const contributors = recoverEntityContributors(maps[0], mapSessionsToUsers(maps));
    expect([...contributors.entries()].sort()).toEqual([
      [7, "stated"],
      [8, "stated"],
    ]);
  });

  it("prefers a stated basis when one of a person's sessions is pinned by the document", () => {
    const ana = new Session(1001);
    const anaPhone = new Session(1002);
    createStory(ana, { createdBy: 7, title: "Draft" });
    anaPhone.sync(ana);
    anaPhone.doc.transact(() => {
      (storyMaps(anaPhone.doc)[0].get("title") as Y.Text).insert(5, " more");
    });
    const doc = readerOf(ana, anaPhone);
    const maps = storyMaps(doc);
    const sessions = resolveSecondarySessions(maps, mapSessionsToUsers(maps));

    // Both sessions are Ana's; one is stated, so her presence is recorded.
    expect(recoverEntityContributors(maps[0], sessions).get(7)).toBe("stated");
  });

  it("names nobody when no session resolves", () => {
    // Most pre-migration content: the column did not exist, so no session in the
    // document ever wrote one, and there is nothing to pair against.
    const orphan = new Session(9009);
    orphan.doc.transact(() => {
      const m = new Y.Map<unknown>();
      m.set("title", new Y.Text("Nobody knows"));
      orphan.stories().push([m]);
    });
    const doc = readerOf(orphan);
    const maps = storyMaps(doc);

    expect(recoverEntityContributors(maps[0], mapSessionsToUsers(maps)).size).toBe(0);
    expect(recoverEntityAuthor(maps[0], mapSessionsToUsers(maps))).toBe(null);
  });
});

describe("planning what a recovery would write", () => {
  const AT = "2026-09-01T12:00:00.000Z";

  /** A document as the backfill decodes one: sessions merged, roots claimed. */
  function planned(build: (a: Session, b: Session) => void) {
    const ana = new Session(1001);
    const beto = new Session(2002);
    build(ana, beto);
    const doc = readerOf(ana, beto);
    // Roots must be claimed or every traversal silently returns nothing.
    doc.getArray("stories");
    doc.getArray("objects");
    doc.getArray("glossary");
    doc.getArray("pages");
    return planAuthorshipRecovery(doc, 42, AT);
  }

  function story(s: Session, fields: Record<string, unknown>): void {
    s.doc.transact(() => {
      const m = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(fields)) m.set(k, v);
      m.set("steps", new Y.Array<Y.Map<unknown>>());
      s.stories().push([m]);
    });
  }

  it("plans nothing at all for a document it cannot attribute", () => {
    // Most pre-migration content. The only statement is the done-marker, so the
    // project is not visited again — there is genuinely nothing to find.
    const { outcome, statements } = planned((ana) => {
      story(ana, { _id: 11, title: new Y.Text("Nobody knows") });
    });

    expect(outcome.authorsRecovered).toBe(0);
    expect(outcome.contributorsStated).toBe(0);
    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain("UPDATE projects SET authorship_recovered_at");
  });

  it("guards every created_by UPDATE with AND created_by IS NULL", () => {
    // The rule that makes "never overwrite a real author" a property of the SQL
    // rather than of whoever runs it.
    const { statements } = planned((ana) => {
      story(ana, { _id: 11, created_by: 7, title: new Y.Text("Ana") });
    });

    const updates = statements.filter((s) => s.sql.startsWith("UPDATE stories SET created_by"));
    expect(updates).not.toHaveLength(0);
    for (const u of updates) {
      expect(u.sql).toContain("WHERE id = ? AND created_by IS NULL");
    }
  });

  it("never writes created_by from an inference", () => {
    // A second device creates an entity stating nobody. Its author resolves only
    // by sole-editor inference, which is allowed to make it a CONTRIBUTOR and
    // never a maker.
    const ana = new Session(1001);
    const phone = new Session(1002);
    ana.doc.transact(() => {
      const m = new Y.Map<unknown>();
      m.set("_id", 11);
      m.set("created_by", 7);
      m.set("title", new Y.Text("Ana"));
      m.set("steps", new Y.Array<Y.Map<unknown>>());
      ana.stories().push([m]);
    });
    phone.sync(ana);
    phone.doc.transact(() => {
      (phone.stories().get(0).get("title") as Y.Text).insert(3, " again");
      const m = new Y.Map<unknown>();
      m.set("_id", 12);
      m.set("title", new Y.Text("From the phone"));
      m.set("steps", new Y.Array<Y.Map<unknown>>());
      phone.stories().push([m]);
    });
    const doc = readerOf(ana, phone);
    doc.getArray("stories");

    const { statements } = planAuthorshipRecovery(doc, 42, AT);

    const authored = statements
      .filter((s) => s.sql.startsWith("UPDATE stories SET created_by"))
      .map((s) => s.binds[1]);
    expect(authored).toContain(11);
    // Entity 12's author is only inferable, so it gets no created_by...
    expect(authored).not.toContain(12);
    // ...but the person is still recorded as having written in it.
    const contributor = statements.find(
      (s) => s.sql.startsWith("INSERT INTO entity_contributors") && s.binds[2] === 12,
    );
    expect(contributor!.binds[6]).toBe("recovered_inferred");
  });

  it("records every person who wrote in an entity, not just its maker", () => {
    const ana = new Session(1001);
    const beto = new Session(2002);
    ana.doc.transact(() => {
      const m = new Y.Map<unknown>();
      m.set("_id", 11);
      m.set("created_by", 7);
      m.set("title", new Y.Text("Ana "));
      m.set("steps", new Y.Array<Y.Map<unknown>>());
      ana.stories().push([m]);
    });
    beto.sync(ana);
    beto.doc.transact(() => {
      const own = new Y.Map<unknown>();
      own.set("_id", 12);
      own.set("created_by", 8);
      own.set("title", new Y.Text("Beto"));
      own.set("steps", new Y.Array<Y.Map<unknown>>());
      beto.stories().push([own]);
      (beto.stories().get(0).get("title") as Y.Text).insert(4, "and Beto");
    });
    const doc = readerOf(ana, beto);
    doc.getArray("stories");

    const { statements } = planAuthorshipRecovery(doc, 42, AT);
    const onStory11 = statements
      .filter((s) => s.sql.startsWith("INSERT INTO entity_contributors") && s.binds[2] === 11)
      .map((s) => ({ userId: s.binds[3], basis: s.binds[6] }));

    expect(onStory11).toContainEqual({ userId: 7, basis: "recovered_stated" });
    expect(onStory11).toContainEqual({ userId: 8, basis: "recovered_stated" });
  });

  it("never downgrades a live observation to a recovery", () => {
    // A row the Durable Object wrote as it happened carries no basis, and this
    // must leave it that way: it saw the edit arrive on an authenticated socket,
    // and a recovery is reading a document after the fact.
    const { statements } = planned((ana) => {
      story(ana, { _id: 11, created_by: 7, title: new Y.Text("Ana") });
    });

    const ins = statements.find((s) => s.sql.startsWith("INSERT INTO entity_contributors"))!;
    expect(ins.sql).toContain(
      "basis = CASE WHEN entity_contributors.basis IS NULL THEN NULL ELSE excluded.basis END",
    );
  });

  it("skips an entity D1 has no row for", () => {
    // It exists only in the document, so there is nothing to write authorship
    // onto. The next snapshot inserts it and a later run picks it up.
    const { outcome, statements } = planned((ana) => {
      story(ana, {
        _id: null,
        _temp_id: "3f2a91c4-8e1d-4b7a-9c3e-2d5f7a1b4c8e",
        created_by: 7,
        title: new Y.Text("Not in D1 yet"),
      });
    });

    expect(outcome.authorsRecovered).toBe(0);
    expect(outcome.contributorsStated).toBe(0);
    expect(statements).toHaveLength(1); // the done-marker alone
  });

  it("marks the project done last, so an interrupted file leaves it unmarked", () => {
    const { statements } = planned((ana) => {
      story(ana, { _id: 11, created_by: 7, title: new Y.Text("Ana") });
    });

    expect(statements[statements.length - 1].sql).toContain(
      "UPDATE projects SET authorship_recovered_at",
    );
  });

  it("binds NULL for both times", () => {
    const { statements } = planned((ana) => {
      story(ana, { _id: 11, created_by: 7, title: new Y.Text("Ana") });
    });

    const ins = statements.find((s) => s.sql.startsWith("INSERT INTO entity_contributors"))!;
    expect(ins.binds[4]).toBe(null);
    expect(ins.binds[5]).toBe(null);
  });

  it("covers steps and layers nested inside a story", () => {
    const ana = new Session(1001);
    ana.doc.transact(() => {
      const story = new Y.Map<unknown>();
      story.set("_id", 11);
      story.set("created_by", 7);
      story.set("title", new Y.Text("S"));
      const steps = new Y.Array<Y.Map<unknown>>();
      story.set("steps", steps);
      ana.stories().push([story]);
      const step = new Y.Map<unknown>();
      step.set("_id", 21);
      step.set("answer", new Y.Text("A"));
      const layers = new Y.Array<Y.Map<unknown>>();
      step.set("layers", layers);
      steps.push([step]);
      const layer = new Y.Map<unknown>();
      layer.set("_id", 31);
      layer.set("content", new Y.Text("L"));
      layers.push([layer]);
    });
    const doc = readerOf(ana);
    doc.getArray("stories");

    const { statements } = planAuthorshipRecovery(doc, 42, AT);
    const kinds = statements
      .filter((s) => s.sql.startsWith("INSERT INTO entity_contributors"))
      .map((s) => s.binds[1]);
    expect(new Set(kinds)).toEqual(new Set(["story", "step", "layer"]));
  });
});

describe("rendering a plan as SQL", () => {
  // The one genuinely risky thing here: `wrangler --file` takes SQL, not
  // parameters, so bindings are inlined. Everything a plan produces is a row id,
  // a NULL, or a fixed vocabulary word — and anything else must THROW rather
  // than be escaped and let through, because a value of an unexpected shape
  // means the planner changed and not that the escaping needs to be cleverer.

  it("inlines ids, nulls and vocabulary words", () => {
    const sql = renderRecoverySql([
      { sql: "UPDATE stories SET created_by = ? WHERE id = ?", binds: [7, 11] },
      {
        sql: "INSERT INTO entity_contributors (a, b, c) VALUES (?, ?, ?)",
        binds: ["step", null, "recovered_inferred"],
      },
    ]);

    expect(sql).toBe(
      "UPDATE stories SET created_by = 7 WHERE id = 11;\n" +
        "INSERT INTO entity_contributors (a, b, c) VALUES ('step', NULL, 'recovered_inferred');",
    );
  });

  it("accepts an ISO instant, which the done-marker carries", () => {
    expect(renderRecoverySql([{ sql: "SELECT ?", binds: ["2026-09-01T12:00:00.000Z"] }]))
      .toBe("SELECT '2026-09-01T12:00:00.000Z';");
    // Only that exact shape. A date-ish string is not one.
    expect(() => renderRecoverySql([{ sql: "SELECT ?", binds: ["2026-09-01"] }])).toThrow();
    expect(() =>
      renderRecoverySql([{ sql: "SELECT ?", binds: ["2026-09-01T12:00:00.000Z' OR '1"] }]),
    ).toThrow();
  });

  it("refuses a string that is not a vocabulary word", () => {
    // A title or a slug must never reach here. If one did, quoting it would turn
    // a planner bug into SQL written against somebody's database.
    expect(() =>
      renderRecoverySql([{ sql: "SELECT ?", binds: ["Robert'); DROP TABLE steps;--"] }]),
    ).toThrow(/refusing to inline/);
    expect(() => renderRecoverySql([{ sql: "SELECT ?", binds: ["a title"] }])).toThrow();
    expect(() => renderRecoverySql([{ sql: "SELECT ?", binds: ["Mixed_Case"] }])).toThrow();
  });

  it("refuses a number that is not an integer row id", () => {
    expect(() => renderRecoverySql([{ sql: "SELECT ?", binds: [1.5] }])).toThrow();
    expect(() => renderRecoverySql([{ sql: "SELECT ?", binds: [NaN] }])).toThrow();
    expect(() => renderRecoverySql([{ sql: "SELECT ?", binds: [Infinity] }])).toThrow();
  });

  it("refuses anything that is not a number, string or null", () => {
    expect(() => renderRecoverySql([{ sql: "SELECT ?", binds: [{}] }])).toThrow();
    expect(() => renderRecoverySql([{ sql: "SELECT ?", binds: [[1]] }])).toThrow();
  });

  it("refuses a mismatch between placeholders and bindings", () => {
    // A silent mismatch would shift every value one column to the left.
    expect(() => renderRecoverySql([{ sql: "SELECT ?, ?", binds: [1] }])).toThrow();
    expect(() => renderRecoverySql([{ sql: "SELECT ?", binds: [1, 2] }])).toThrow(
      /does not match/,
    );
  });

  it("renders a real plan without refusing any of it", () => {
    // The end-to-end check that the two halves agree: everything the planner
    // produces must be something the renderer accepts.
    const ana = new Session(1001);
    ana.doc.transact(() => {
      const m = new Y.Map<unknown>();
      m.set("_id", 11);
      m.set("created_by", 7);
      m.set("title", new Y.Text("A story with 'quotes' and ; semicolons"));
      m.set("steps", new Y.Array<Y.Map<unknown>>());
      ana.stories().push([m]);
    });
    const doc = readerOf(ana);
    doc.getArray("stories");

    const { statements } = planAuthorshipRecovery(doc, 42, "2026-09-01T12:00:00.000Z");
    const sql = renderRecoverySql(statements);

    // The story title carries quotes and a semicolon and must appear NOWHERE:
    // titles are not part of a plan, and the day one shows up here is the day
    // this renderer is writing somebody's prose into SQL.
    expect(sql).not.toContain("quotes");
    expect(sql).toContain("'2026-09-01T12:00:00.000Z'");
  });
});
