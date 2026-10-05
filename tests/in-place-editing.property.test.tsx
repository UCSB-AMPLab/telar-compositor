/**
 * @vitest-environment jsdom
 *
 * in-place-editing.property.test.tsx — random interleavings, from fixed
 * seeds, of three InPlaceText fields on two targets, so two share a target
 * from the start: typing, finishing, saves that succeed or fail in any
 * order, fields that unmount, remount and switch target, and Retry and
 * Discard pressed on a recovered draft. After every step and at the end it
 * asserts:
 *
 *   - a field that closes because it finished shows the value stored for
 *     its target at that moment (no field closes on text not yet stored);
 *     a blur finishes a field too, so moving to another field finishes the
 *     one left;
 *   - whenever no save is outstanding, a field that finished and is still
 *     open shows the error that kept it open;
 *   - finishing or leaving a field the author never edited (including a
 *     field opened and closed again by Escape, blur or unmount, a step of
 *     its own) makes no commit at all, counted through the `commit` wrapper;
 *   - once every open field has finished and every save has landed, each
 *     target's store holds the author's last intent for it: the last value
 *     a field the author typed into was finished on or left with (a field
 *     only looked at asks for nothing), recorded from this test's own
 *     actions. An intent left behind whose save the test failed is not in
 *     the store: it is recoverable instead, unless a field still
 *     waiting on the same text showed the failure. So is the intent of a
 *     field that finished and then went before its save failed;
 *   - a recoverable intent is in the next field that opens on its target,
 *     with the error beneath, unless the store already holds it or a later
 *     failure on the target may have replaced it; one not seen by the end
 *     is checked by mounting a field on the target and opening it;
 *   - Retry asks for the field's text as a finish does; Discard is refused
 *     while any save for the target is out, and otherwise closes on the
 *     stored value, which becomes the author's intent if the last intent was
 *     that field's. A Discard removes only the draft its field showed, so a
 *     recoverable intent recorded while it was open is still checked.
 *
 * The store is what the saves write, and the loader revalidates to it after
 * each save. A field waiting on its commit is not typed into until that
 * commit settles: the finish it would then make on its own is covered by
 * in-place-editing.test.tsx, where its moment is known.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, act, type RenderResult } from "@testing-library/react";

const { commits } = vi.hoisted(() => ({
  commits: [] as Array<{ key: unknown; value: string; state: "pending" | "resolved" | "rejected" }>,
}));

vi.mock("~/components/ui/target-saves", async (original) => {
  const real = await original<typeof import("~/components/ui/target-saves")>();
  return {
    ...real,
    commit: (key: unknown, value: string, save: (v: string) => unknown) => {
      const entry = { key, value, state: "pending" as "pending" | "resolved" | "rejected" };
      commits.push(entry);
      const promise = real.commit(key, value, save);
      promise.then(
        () => (entry.state = "resolved"),
        () => (entry.state = "rejected"),
      );
      return promise;
    },
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    ydoc: null,
    provider: null,
    isPublishing: false,
    undoManager: null,
    remoteCollaborators: [],
    lastEditorByField: new Map(),
  }),
}));

import { InPlaceText } from "~/components/ui/InPlaceText";
import { resetTargetSaves } from "~/components/ui/target-saves";

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  resetTargetSaves();
  window.sessionStorage.clear();
  commits.length = 0;
});

/** mulberry32: a small seeded generator, so a failing seed replays. */
function generator(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const TARGETS = ["alpha", "beta"] as const;
type Target = (typeof TARGETS)[number];
const LOADED: Record<Target, string> = { alpha: "alpha as loaded", beta: "beta as loaded" };
const WORDS = ["uno", "dos", "tres", "alpha as loaded", "beta as loaded"];

interface Instance {
  target: Target;
  view: RenderResult | null;
  /** Finished and not yet closed. */
  awaiting: boolean;
  /** Typed into since it opened: a field only looked at asks for nothing. */
  edited: boolean;
}

function runSeed(seed: number, steps: number) {
  const random = generator(seed);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const store: Record<Target, string> = { ...LOADED };
  // What the route's loader passes: it revalidates after each save.
  const loader: Record<Target, string> = { ...LOADED };
  const pending: Array<{ target: Target; value: string; succeed: () => void; fail: () => void }> = [];
  const saveFor = (target: Target) => (value: string) =>
    new Promise<void>((resolve, reject) =>
      pending.push({
        target,
        value,
        succeed: () => {
          store[target] = value;
          resolve();
        },
        fail: () => reject(new Error(`failed ${value}`)),
      }),
    );
  const saves: Record<Target, (v: string) => Promise<void>> = { alpha: saveFor("alpha"), beta: saveFor("beta") };
  const field = (target: Target) => (
    <InPlaceText
      target={target}
      recoveryKey={`property/${target}`}
      yText={null}
      initialValue={loader[target]}
      onSave={saves[target]}
    />
  );
  const instances: Instance[] = [0, 1, 2].map(() => ({ target: pick(TARGETS), view: null, awaiting: false, edited: false }));
  instances.forEach((instance) => (instance.view = render(field(instance.target))));

  const block = (i: Instance) => i.view?.container.querySelector<HTMLElement>("[data-in-place]") ?? null;
  /** The value a block shows, without the marker of a recovered draft waiting. */
  const valueOf = (element: HTMLElement) => {
    const copy = element.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("[data-in-place-marker]").forEach((marker) => marker.remove());
    return copy.textContent ?? "";
  };
  const input = (i: Instance) => i.view?.container.querySelector<HTMLInputElement>("input") ?? null;
  const isOpen = (i: Instance) => !!i.view && !!input(i);
  const showsError = (i: Instance) => !!i.view?.container.querySelector('[role="alert"]');
  const showsRecovered = (i: Instance) => !!i.view?.container.querySelector('[data-testid="in-place-recovered"]');
  const button = (i: Instance, key: string) =>
    Array.from(i.view!.container.querySelectorAll("button")).find((b) => b.textContent === key)!;
  // Retry and Discard pressed, and how many with another field open on the same target.
  const pressed = { retry: 0, discard: 0, refused: 0, shared: 0 };
  // Finishing or leaving a field asks for its text only if the author typed
  // into it since it opened, and anew only if that text is not already on
  // its way from an earlier finish with nothing typed since; a field showing
  // its error asks again.
  const asksAnew = (i: Instance) => i.edited && (!i.awaiting || showsError(i));
  // A field that goes while waiting on its commit leaves its intent with no
  // one to show a failure, like any draft left behind.
  const abandon = (i: Instance) => {
    const intent = intents[i.target];
    if (i.awaiting && intent?.owner === i) intent.left = true;
  };
  const log: string[] = [];
  // The author's intent, from this test's own actions and never from the
  // implementation's commits: the last value a field was finished on or
  // left with, per target. An intent left behind (by unmounting or
  // switching target) whose save the test then fails is not stored, and is
  // recoverable instead.
  const intents: Record<Target, { value: string; left: boolean; lost: boolean; owner: Instance } | null> = {
    alpha: null,
    beta: null,
  };
  // The recoverable draft the next field opening on each target must show.
  const recoverable: Record<Target, string | null> = { alpha: null, beta: null };
  let recoveries = 0;
  /** Checks a field just opened on `target` against the recoverable draft, if any. */
  function checkRecovery(instance: Instance) {
    const expected = recoverable[instance.target];
    if (expected === null) return;
    recoverable[instance.target] = null;
    // A draft the target already holds is not lost, and is not shown.
    if (store[instance.target] === expected) return;
    const what = `seed ${seed}: recoverable ${instance.target}=${expected} | ${log.join(" | ")}`;
    expect(input(instance)?.value, what).toBe(expected);
    expect(instance.view!.container.querySelector('[role="alert"]'), what).not.toBeNull();
    recoveries += 1;
  }
  const intend = (instance: Instance, left: boolean) => {
    intents[instance.target] = { value: input(instance)!.value, left, lost: false, owner: instance };
  };

  function checkClosings(before: boolean[], exempt: Instance | null) {
    instances.forEach((instance, n) => {
      if (!instance.view || instance === exempt) return;
      if (before[n] && !isOpen(instance)) {
        expect(valueOf(block(instance)!), `seed ${seed}: ${log.join(" | ")}`).toBe(store[instance.target]);
        instance.awaiting = false;
      }
      if (!isOpen(instance)) {
        instance.awaiting = false;
        instance.edited = false;
      }
    });
    if (pending.length === 0) {
      instances.forEach((instance) => {
        if (!instance.awaiting || !isOpen(instance)) return;
        const alert = instance.view!.container.querySelector('[role="alert"]');
        expect(alert, `seed ${seed}: an awaited failure went unshown | ${log.join(" | ")}`).not.toBeNull();
      });
    }
  }

  /** The loader revalidates after a save and every field gets its value. */
  async function revalidate() {
    await settle();
    Object.assign(loader, store);
    for (const instance of instances) instance.view?.rerender(field(instance.target));
  }

  async function open(instance: Instance) {
    if (isOpen(instance)) return;
    // Focus moving here blurs the field that had it, which finishes it.
    for (const other of instances) {
      const field = input(other);
      if (other !== instance && field && document.activeElement === field) {
        if (asksAnew(other)) intend(other, false);
        other.awaiting = true;
      }
    }
    const b = block(instance)!;
    act(() => b.focus());
    fireEvent.keyDown(b, { key: "Enter" });
    instance.edited = false;
    checkRecovery(instance);
  }

  // Somewhere outside every field to move focus to.
  const outside = document.createElement("button");
  outside.textContent = "outside";
  document.body.appendChild(outside);

  /**
   * Runs an action that finishes or leaves a field the author never edited,
   * and checks it commits nothing: looking at a field never writes to it.
   */
  async function asksNothing(instance: Instance, what: string, action: () => void | Promise<void>) {
    const before = commits.length;
    await action();
    await settle();
    const made = commits.slice(before).map((c) => `${String(c.key)}=${c.value}`);
    expect(made, `seed ${seed}: ${what} of unedited field ${instances.indexOf(instance)} committed | ${log.join(" | ")}`).toEqual([]);
  }
  const unedited = (i: Instance) => isOpen(i) && !i.edited;
  const countShared = (i: Instance) => {
    if (instances.some((o) => o !== i && o.target === i.target && isOpen(o))) pressed.shared += 1;
  };

  const actions = {
    /** Opens a field and closes it again without an edit, by Escape, blur or unmount. */
    async look(instance: Instance) {
      if (!instance.view || isOpen(instance)) return;
      await open(instance);
      await settle();
      const how = pick(["escape", "blur", "unmount"] as const);
      log.push(`look ${instances.indexOf(instance)} ${how}`);
      await asksNothing(instance, how, () => {
        if (how === "escape") fireEvent.keyDown(input(instance)!, { key: "Escape" });
        else if (how === "blur") act(() => outside.focus());
        else {
          instance.view!.unmount();
          instance.view = null;
        }
      });
    },
    async type(instance: Instance) {
      if (!instance.view) return;
      // A field still waiting on its commit finishes again with whatever is
      // typed into it, at a moment only the implementation knows, so the
      // author's intent could not be dated from here. That path has its own
      // cases in in-place-editing.test.tsx; here a field is typed into only
      // once its commit has settled, closed or showing its error.
      if (instance.awaiting) {
        if (!showsError(instance)) return;
        instance.awaiting = false;
      }
      await open(instance);
      // A field that opened on a recovered draft is often answered with its controls.
      if (showsRecovered(instance) && random() < 0.5) {
        if (random() < 0.5) await actions.retry(instance);
        else await actions.discard(instance);
        return;
      }
      const word = pick(WORDS);
      log.push(`type ${instances.indexOf(instance)} ${word}`);
      // A change event only fires, and an edit only counts, when the text changes.
      if (input(instance)!.value !== word) instance.edited = true;
      fireEvent.change(input(instance)!, { target: { value: word } });
    },
    /** Retry asks for the field's text, as finishing an edit does. */
    async retry(instance: Instance) {
      if (!isOpen(instance) || !showsRecovered(instance)) return;
      if (instance.awaiting && !showsError(instance)) return;
      log.push(`retry ${instances.indexOf(instance)}`);
      countShared(instance);
      pressed.retry += 1;
      intend(instance, false);
      instance.edited = true;
      instance.awaiting = true;
      fireEvent.click(button(instance, "in_place.recovered_retry"));
    },
    /**
     * Discard is refused while any save for the target is out; otherwise it
     * closes on the stored value, and the author's last request for the
     * target, if it was this field's, becomes what is stored.
     */
    async discard(instance: Instance) {
      if (!isOpen(instance) || !showsRecovered(instance)) return;
      log.push(`discard ${instances.indexOf(instance)}`);
      countShared(instance);
      pressed.discard += 1;
      const busy = pending.some((p) => p.target === instance.target);
      fireEvent.click(button(instance, "in_place.recovered_discard"));
      await settle();
      const what = `seed ${seed}: discard ${instances.indexOf(instance)} busy=${busy} | ${log.join(" | ")}`;
      if (busy) {
        pressed.refused += 1;
        expect(isOpen(instance), what).toBe(true);
        expect(showsRecovered(instance), what).toBe(true);
        return;
      }
      expect(isOpen(instance), what).toBe(false);
      const intent = intents[instance.target];
      if (intent?.owner === instance && !intent.left) {
        intents[instance.target] = { value: store[instance.target], left: false, lost: false, owner: instance };
      }
    },
    async finish(instance: Instance) {
      if (!isOpen(instance)) return;
      log.push(`finish ${instances.indexOf(instance)}`);
      const escape = () => {
        fireEvent.keyDown(input(instance)!, { key: "Escape" });
      };
      if (unedited(instance)) {
        await asksNothing(instance, "finish", escape);
        return;
      }
      if (asksAnew(instance)) intend(instance, false);
      instance.awaiting = true;
      escape();
    },
    async succeed() {
      if (!pending.length) return;
      const next = pending.splice(Math.floor(random() * pending.length), 1)[0];
      log.push(`ok ${next.target}=${next.value}`);
      await act(async () => next.succeed());
      await revalidate();
    },
    async fail() {
      if (!pending.length) return;
      const next = pending.splice(Math.floor(random() * pending.length), 1)[0];
      log.push(`fail ${next.target}=${next.value}`);
      const intent = intents[next.target];
      // A field still waiting on the same text shows the failure itself.
      const shown = instances.some((i) => i.target === next.target && i.awaiting && isOpen(i));
      if (intent?.left && intent.value === next.value) {
        intent.lost = true;
        recoverable[next.target] = shown ? null : next.value;
      } else {
        // Any failure on the target may have kept a draft over the one expected.
        recoverable[next.target] = null;
      }
      await act(async () => next.fail());
    },
    async unmount(instance: Instance) {
      if (!instance.view) return;
      log.push(`unmount ${instances.indexOf(instance)}`);
      const quiet = unedited(instance);
      if (isOpen(instance) && asksAnew(instance)) intend(instance, true);
      else abandon(instance);
      const leave = () => {
        instance.view!.unmount();
        instance.view = null;
      };
      if (quiet) await asksNothing(instance, "unmount", leave);
      else leave();
      instance.awaiting = false;
    },
    async remount(instance: Instance) {
      if (instance.view) return;
      instance.target = pick(TARGETS);
      log.push(`mount ${instances.indexOf(instance)} on ${instance.target}`);
      instance.view = render(field(instance.target));
      instance.edited = false;
    },
    async switchTarget(instance: Instance) {
      if (!instance.view) return;
      if (isOpen(instance) && asksAnew(instance)) intend(instance, true);
      else abandon(instance);
      const quiet = unedited(instance);
      instance.target = instance.target === "alpha" ? "beta" : "alpha";
      log.push(`switch ${instances.indexOf(instance)} to ${instance.target}`);
      const move = () => {
        instance.view!.rerender(field(instance.target));
      };
      if (quiet) await asksNothing(instance, "switch", move);
      else move();
      instance.awaiting = false;
      instance.edited = false;
    },
  };

  return async () => {
    for (let step = 0; step < steps; step += 1) {
      const before = instances.map(isOpen);
      const roll = random();
      const instance = pick(instances);
      let exempt: Instance | null = null;
      if (roll < 0.23) await actions.type(instance);
      else if (roll < 0.25) await (showsRecovered(instance) ? actions.retry(instance) : actions.type(instance));
      else if (roll < 0.27) await (showsRecovered(instance) ? actions.discard(instance) : actions.type(instance));
      else if (roll < 0.44) await actions.finish(instance);
      else if (roll < 0.5) await actions.look(instance);
      else if (roll < 0.68) await actions.succeed();
      else if (roll < 0.78) await actions.fail();
      else if (roll < 0.85) await actions.unmount(instance);
      else if (roll < 0.93) await actions.remount(instance);
      else {
        await actions.switchTarget(instance);
        exempt = instance;
      }
      await settle();
      checkClosings(before, exempt);
    }

    // Finish every open field and let every save land, until nothing moves.
    for (let round = 0; round < 50; round += 1) {
      let before = instances.map(isOpen);
      for (const instance of instances) if (isOpen(instance)) await actions.finish(instance);
      await settle();
      checkClosings(before, null);
      while (pending.length) {
        before = instances.map(isOpen);
        const next = pending.shift()!;
        log.push(`ok ${next.target}=${next.value}`);
        await act(async () => next.succeed());
        await settle();
        checkClosings(before, null);
        await revalidate();
      }
      if (!instances.some(isOpen) && !pending.length) break;
    }
    expect(instances.some(isOpen), `seed ${seed}: fields still open | ${log.join(" | ")}`).toBe(false);
    outside.remove();

    let checked = 0;
    for (const target of TARGETS) {
      const intent = intents[target];
      if (intent?.lost) continue;
      checked += 1;
      expect(store[target], `seed ${seed}: ${target} | ${log.join(" | ")}`).toBe(intent?.value ?? LOADED[target]);
    }
    // A recoverable draft no field opened on since is checked now.
    for (const target of TARGETS) {
      if (recoverable[target] === null) continue;
      const probe: Instance = { target, view: render(field(target)), awaiting: false, edited: false };
      await open(probe);
      probe.view!.unmount();
    }
    return { checked, recoveries, pressed };
  };
}

describe("in-place fields under random interleavings", () => {
  // A hundred seeds in a row: the ordering faults this suite has found turned
  // up in about one seed in twenty.
  const SEEDS = Array.from({ length: 100 }, (_, i) => 300 + i);
  let checked = 0;
  let recovered = 0;
  const pressed = { retry: 0, discard: 0, refused: 0, shared: 0 };
  it.each(SEEDS)("hold their invariants for seed %i", async (seed) => {
    const seen = await runSeed(seed, 80)();
    checked += seen.checked;
    recovered += seen.recoveries;
    for (const k of Object.keys(pressed) as Array<keyof typeof pressed>) pressed[k] += seen.pressed[k];
  });

  // A seed can end with every intent lost; across the seeds, most are not.
  it("checked the store against an intent on most targets", () => {
    expect(checked).toBeGreaterThan(SEEDS.length);
  });

  // The recovery oracle is not vacuous: seeds do lose drafts left behind.
  // Retry and Discard are exercised, Discard is refused while a save is out,
  // and both are pressed with another field open on the same target.
  it("pressed Retry and Discard, some refused and some beside another field", () => {
    expect(pressed.retry, JSON.stringify(pressed)).toBeGreaterThan(10);
    expect(pressed.discard, JSON.stringify(pressed)).toBeGreaterThan(10);
    expect(pressed.refused, JSON.stringify(pressed)).toBeGreaterThan(0);
    expect(pressed.shared, JSON.stringify(pressed)).toBeGreaterThan(0);
  });

  it("saw a recovered draft come back in many seeds", () => {
    expect(recovered).toBeGreaterThan(SEEDS.length / 4);
  });
});
