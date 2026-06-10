// @vitest-environment jsdom
/**
 * Regression: typing a glossary definition must reach the Y.Text in full
 * (telar-compositor#26).
 *
 * The glossary definition editor is yCollab-bound to a "definition" Y.Text that
 * lives INSIDE the same glossary Y.Array that the chip-resolution observer
 * watches. So every keystroke fires observeDeep synchronously inside yCollab's
 * sync (mid CodeMirror update). The original code dispatched the resolution map
 * straight from that observer; the re-entrant view.dispatch threw "Calls to
 * EditorView.update are not allowed while an update is in progress", crashed the
 * ySync plugin, and stopped copying the editor's text into the Y.Text — only the
 * first character survived (matching production data: able-bodied = "f").
 *
 * installGlossaryResolution has two independent defences: it DEDUPEs (a
 * definition edit doesn't change term_id/title, so no dispatch fires at all) and
 * it DEFERS any genuine change via queueMicrotask (so a dispatch never lands
 * inside an update cycle). These tests pin both, plus the destroyed-view race.
 */
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { yCollab } from "y-codemirror.next";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  setGlossaryMap,
  glossaryMapField,
  installGlossaryResolution,
} from "~/components/ui/markdown-editor/glossaryResolution";

function makeEditor() {
  const ydoc = new Y.Doc();
  const glossary = ydoc.getArray<Y.Map<unknown>>("glossary");
  const def = new Y.Text("");
  const title = new Y.Text("Able-bodied");
  ydoc.transact(() => {
    const term = new Y.Map<unknown>();
    term.set("term_id", "able-bodied");
    term.set("title", title);
    term.set("definition", def);
    glossary.push([term]);
  });

  let dispatchCount = 0;
  const countSetGlossaryMap = EditorView.updateListener.of((u) => {
    for (const tr of u.transactions) {
      for (const e of tr.effects) if (e.is(setGlossaryMap)) dispatchCount++;
    }
  });

  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc: def.toString(),
      extensions: [
        glossaryMapField,
        countSetGlossaryMap,
        yCollab(def, null, { undoManager: false }),
      ],
    }),
    parent,
  });
  const cleanup = () => {
    view.destroy();
    parent.remove();
  };
  return { ydoc, glossary, def, title, view, cleanup, mapDispatches: () => dispatchCount };
}

function type(view: EditorView, text: string) {
  for (const ch of text) {
    view.dispatch({ changes: { from: view.state.doc.length, insert: ch } });
  }
}

const flushMicrotasks = () => Promise.resolve().then(() => Promise.resolve());
const SENTENCE = "A person who does not have a disability.";

describe("glossary definition sync (#26)", () => {
  it("the full definition reaches the Y.Text", async () => {
    const { view, def, cleanup } = makeEditor();
    const detach = installGlossaryResolution(view, def.doc as Y.Doc);
    type(view, SENTENCE);
    await flushMicrotasks();
    expect(def.toString()).toBe(SENTENCE);
    expect(view.state.doc.toString()).toBe(SENTENCE);
    detach();
    cleanup();
  });

  it("DEDUPE: typing a definition fires no resolution dispatch (only the initial one)", async () => {
    const { view, def, cleanup, mapDispatches } = makeEditor();
    const detach = installGlossaryResolution(view, def.doc as Y.Doc);
    const afterInstall = mapDispatches(); // the one initial dispatch
    type(view, SENTENCE);
    await flushMicrotasks();
    // No term_id/title changed, so the resolver must not have dispatched again.
    expect(mapDispatches()).toBe(afterInstall);
    detach();
    cleanup();
  });

  it("a title rename DOES dispatch (the map genuinely changed)", async () => {
    const { view, def, title, cleanup, mapDispatches } = makeEditor();
    const detach = installGlossaryResolution(view, def.doc as Y.Doc);
    const before = mapDispatches();
    (def.doc as Y.Doc).transact(() => {
      title.delete(0, title.length);
      title.insert(0, "Able-bodied (revised)");
    });
    await flushMicrotasks();
    expect(mapDispatches()).toBe(before + 1);
    detach();
    cleanup();
  });

  it("destroyed-view race: cleanup before a pending flush is a no-op (no throw)", async () => {
    const { glossary, view, def, cleanup, mapDispatches } = makeEditor();
    const detach = installGlossaryResolution(view, def.doc as Y.Doc);
    const before = mapDispatches();
    // Cause a real map change so a flush is genuinely scheduled...
    (def.doc as Y.Doc).transact(() => {
      const t = new Y.Map<unknown>();
      t.set("term_id", "new-term");
      t.set("title", new Y.Text("New term"));
      t.set("definition", new Y.Text(""));
      glossary.push([t]);
    });
    // ...then tear down synchronously before the microtask drains.
    detach();
    cleanup();
    await expect(flushMicrotasks()).resolves.toBeUndefined();
    // The cancelled flush must not have dispatched.
    expect(mapDispatches()).toBe(before);
  });

  it("(harness check, sanity) the naive synchronous observer DOES truncate — proving the test reproduces the bug", () => {
    const { glossary, view, def, cleanup } = makeEditor();
    // Faithful copy of the ORIGINAL buggy code: dispatch straight from observeDeep.
    const pushMap = () => {
      const map = new Map<string, string>();
      for (let i = 0; i < glossary.length; i++) {
        const m = glossary.get(i);
        const termId = m.get("term_id");
        if (typeof termId === "string") map.set(termId, "");
      }
      view.dispatch({ effects: setGlossaryMap.of(map) });
    };
    glossary.observeDeep(pushMap);
    type(view, SENTENCE);
    expect(def.toString().length).toBeLessThan(SENTENCE.length);
    glossary.unobserveDeep(pushMap);
    cleanup();
  });
});
