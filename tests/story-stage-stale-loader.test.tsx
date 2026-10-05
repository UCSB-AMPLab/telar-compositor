// @vitest-environment jsdom

/**
 * A loader read begun before a field's save never delivers its older text to
 * the field.
 *
 * Without a Y.Doc, a field edited in place on the stage saves through the
 * story route's action on a fetcher. The router then drops what any read
 * begun before the save returns: it aborts a navigation still loading, and a
 * revalidation some earlier fetcher started, and reads the loader again after
 * the action. So the answer the author saved stays in the field.
 *
 * This mounts the real story route component on React Router's routes stub,
 * with an in-memory loader and action standing in for D1. Each case changes
 * the stored answer behind the field's back ("Middle", as a write from
 * elsewhere would), starts a read that captures it, holds the read, saves a
 * new answer through the field, and only then lets the held read finish. The
 * held text differs from anything the field was given, so if it were
 * delivered the field would take it. The field must still show the saved
 * answer, and the held read must have been dropped rather than overtaken.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRoutesStub, Outlet, useFetcher, useNavigate } from "react-router";
import { createOsdFake, withPoint } from "./helpers/osd-fake";
import { unavailablePanelPreview } from "~/lib/panel-preview-config";
import { resetTargetSaves } from "~/components/ui/target-saves";

const osd = withPoint(createOsdFake());
vi.mock("openseadragon", () => ({ default: osd.ctor }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en", changeLanguage: vi.fn() } }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
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
  useSetAwarenessLocation: () => () => {},
  FALLBACK_HIGHLIGHT_COLOR: "#000000",
}));
vi.mock("~/hooks/use-structural-ops", () => ({ useStructuralOps: () => null }));
vi.mock("~/hooks/use-toast", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import StoryEditorPage, { clientAction, clientLoader } from "../app/routes/_app.stories.$storyId";

// ---------------------------------------------------------------------------
// The server: one story, one step, and a loader whose reads can be held.
// ---------------------------------------------------------------------------

const server = { answer: "Before" };
/** Reads the test holds: each resolves with the answer as it stood when the read began. */
let holdNextRead = false;
const heldReads: Array<{ release: () => void; aborted: () => boolean }> = [];
const loaderCalls: string[] = [];

function snapshot(answer: string) {
  return {
    story: {
      id: 1,
      project_id: 3,
      story_id: "s1",
      title: "Story",
      subtitle: null,
      byline: null,
      order: 1,
      show_sections: false,
    },
    steps: [
      {
        id: 11,
        story_id: 1,
        step_number: 1,
        kind: "media",
        question: "Question",
        answer,
        alt_text: null,
        object_id: null,
        x: null,
        y: null,
        zoom: null,
        page: null,
        clip_start: null,
        clip_end: null,
        loop: null,
      },
    ],
    layers: [],
    objects: [],
    siteBaseUrl: null,
    repoFullName: "owner/site",
    members: [],
    currentUserId: 7,
    userRole: "convenor",
    panelPreview: Promise.resolve(unavailablePanelPreview()),
  };
}

async function loader({ request }: { request: Request }) {
  const answer = server.answer;
  loaderCalls.push(answer);
  if (!holdNextRead) return snapshot(answer);
  holdNextRead = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  heldReads.push({ release, aborted: () => request.signal.aborted });
  await gate;
  return snapshot(answer);
}

const saves: Array<Record<string, string>> = [];
/** A question save the test holds, and whether answer saves are refused. */
let questionGate: Promise<void> | null = null;
let refuseAnswers = false;
/** Another writer stores this answer right after the save, before the save's own read. */
let anotherWriter: string | null = null;
async function action({ request }: { request: Request }) {
  const form = Object.fromEntries((await request.formData()).entries()) as Record<string, string>;
  saves.push(form);
  if (form.field === "question" && questionGate) await questionGate;
  if (form.field === "answer" && refuseAnswers) return { ok: false, intent: form.intent, nonce: form.nonce };
  if (form.intent === "save-step-field" && form.field === "answer") {
    server.answer = form.value;
    if (anotherWriter) server.answer = anotherWriter;
  }
  return { ok: true, intent: form.intent, nonce: form.nonce };
}

/** The parent: starts the reads the test holds, a navigation and another fetcher's revalidation. */
function Shell() {
  const navigate = useNavigate();
  const other = useFetcher();
  return (
    <>
      <button type="button" onClick={() => navigate("/stories/s1?step=1&probe=1")}>
        navigate
      </button>
      <button
        type="button"
        onClick={() => other.submit({ intent: "unrelated" }, { method: "post", action: "/stories/s1" })}
      >
        other save
      </button>
      <Outlet />
    </>
  );
}

// ---------------------------------------------------------------------------
// The editor's size: the stage needs a content area and a window.
// ---------------------------------------------------------------------------

let restoreSize: () => void = () => {};
beforeEach(() => {
  server.answer = "Before";
  holdNextRead = false;
  heldReads.length = 0;
  loaderCalls.length = 0;
  saves.length = 0;
  questionGate = null;
  refuseAnswers = false;
  anotherWriter = null;
  osd.reset();
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const saved = {
    w: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth"),
    h: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight"),
  };
  Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => 1240 });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 768 });
  vi.stubGlobal("innerWidth", 1440);
  vi.stubGlobal("innerHeight", 900);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  // A request of the page's own to the route would reach the same action.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.includes("/stories/s1")) {
        return Response.json(await action({ request: new Request(new URL(url, "http://localhost"), init) }));
      }
      return new Response("", { status: 404 });
    }),
  );
  restoreSize = () => {
    if (saved.w) Object.defineProperty(proto, "clientWidth", saved.w);
    if (saved.h) Object.defineProperty(proto, "clientHeight", saved.h);
  };
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  resetTargetSaves();
  restoreSize();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

/**
 * The answer's block exists only after the loader's data has rendered the
 * editor, the deep link has selected step 1 and the stage has measured its
 * geometry: three renders of the whole editor, with no timer between them.
 * A file's first mount also runs the editor's code for the first time, and
 * on a loaded machine that work alone outlasts Testing Library's one-second
 * default.
 */
const MOUNTED = { timeout: 5000 };
vi.setConfig({ testTimeout: 15000 });

async function mountEditor() {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: Shell,
      children: [
        {
          path: "stories/:storyId",
          Component: StoryEditorPage as never,
          // The route's client loader around the in-memory server loader, as
          // the editor reads it in the browser.
          loader: ((args: { request: Request }) =>
            clientLoader({ ...args, serverLoader: () => loader(args) } as never)) as never,
          // The route's client action around the in-memory server action.
          action: ((args: { request: Request }) =>
            clientAction({ ...args, serverAction: () => action(args) } as never)) as never,
        },
      ],
    },
  ]);
  render(<Stub initialEntries={["/stories/s1?step=1"]} />);
  const block = await screen.findByRole("button", { name: "step.answer_placeholder" }, MOUNTED);
  expect(block.textContent).toContain("Before");
  return block;
}

/** Open the answer, type `text` and leave the field, as an author finishing it does. */
async function saveAnswer(block: HTMLElement, text: string) {
  fireEvent.click(block);
  const field = await screen.findByRole("textbox", { name: /step\.answer_placeholder/ }).catch(
    () => document.querySelector("textarea") as HTMLTextAreaElement,
  );
  fireEvent.change(field, { target: { value: text } });
  fireEvent.blur(field);
}

function answerShown(): string {
  return screen.getByRole("button", { name: "step.answer_placeholder" }).textContent ?? "";
}

describe("the story route: a read begun before a save never reaches the field", () => {
  for (const [label, start] of [
    ["a navigation still loading", "navigate"],
    ["another fetcher's revalidation", "other save"],
  ] as const) {
    it(`drops ${label}`, async () => {
      const block = await mountEditor();

      server.answer = "Middle";
      holdNextRead = true;
      fireEvent.click(screen.getByRole("button", { name: start }));
      await waitFor(() => expect(heldReads).toHaveLength(1));
      await flush();

      await saveAnswer(block, "After");
      await waitFor(() => expect(saves.some((s) => s.intent === "save-step-field")).toBe(true));
      await waitFor(() => expect(answerShown()).toContain("After"));
      expect(server.answer).toBe("After");

      // The held read captured the answer before the save; let it finish now.
      expect(loaderCalls).toContain("Middle");
      await act(async () => {
        heldReads[0].release();
        await Promise.resolve();
      });
      await flush();

      expect(answerShown()).toContain("After");
      expect(answerShown()).not.toContain("Middle");
      expect(heldReads[0].aborted()).toBe(true);
    });
  }

  it("saves through the route's action, not a request of its own", async () => {
    const block = await mountEditor();
    await saveAnswer(block, "After");
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]).toMatchObject({ intent: "save-step-field", stepId: "11", field: "answer", value: "After" });
    expect(saves[0].nonce).toBeTruthy();
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("/stories/"), expect.anything());
  });
});

describe("the story route: a save the author finished is sent after the step's fields have gone", () => {
  function holdQuestionSaves() {
    let release: () => void = () => {};
    questionGate = new Promise<void>((resolve) => { release = resolve; });
    return async () => {
      await act(async () => {
        release();
        await Promise.resolve();
      });
      await flush();
    };
  }

  async function finishQuestion(text: string) {
    fireEvent.click(screen.getByRole("button", { name: "step.question_placeholder" }));
    const input = await waitFor(() => {
      const el = screen.getByTestId("step-card").querySelector("input");
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.change(input, { target: { value: text } });
    fireEvent.blur(input);
  }

  const selectTitleCard = () => fireEvent.click(screen.getAllByText("step.title_card_label")[0]);

  it("sends an answer finished behind a held save, once the author has selected the title card", async () => {
    const block = await mountEditor();
    const release = holdQuestionSaves();
    await finishQuestion("A new question");
    await waitFor(() => expect(saves.map((s) => s.field)).toEqual(["question"]));
    await saveAnswer(block, "After");
    await flush();
    selectTitleCard();
    await waitFor(() => expect(screen.queryByTestId("step-card")).toBeNull());
    screen.getByTestId("story-intro");

    await release();
    await waitFor(() => expect(saves.map((s) => s.field)).toEqual(["question", "answer"]));
    expect(saves[1]).toMatchObject({ intent: "save-step-field", field: "answer", value: "After" });
    await waitFor(() => expect(server.answer).toBe("After"));
  });

  it("keeps a draft left open and then refused for the field, through the left-behind path", async () => {
    const block = await mountEditor();
    const release = holdQuestionSaves();
    await finishQuestion("A new question");
    await waitFor(() => expect(saves).toHaveLength(1));
    // The answer is edited and left open: selecting the title card leaves the draft behind.
    fireEvent.click(block);
    const field = await waitFor(() => {
      const el = document.querySelector("textarea");
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.change(field, { target: { value: "Left open" } });
    refuseAnswers = true;
    selectTitleCard();
    await waitFor(() => expect(screen.queryByTestId("step-card")).toBeNull());
    screen.getByTestId("story-intro");

    await release();
    await waitFor(() => expect(saves.map((s) => s.value)).toContain("Left open"));
    // The refusal reaches the field's commit, which keeps the draft for its target.
    await waitFor(() => expect(JSON.stringify({ ...sessionStorage })).toContain("Left open"));
    fireEvent.click(screen.getAllByText(/^Question$|A new question/)[0]);
    const answer = await screen.findByRole("button", { name: "step.answer_placeholder" });
    expect(answer.querySelector("[data-in-place-marker]")).not.toBeNull();
  });
});

describe("the story route: an older read released after the save, before the read the save started", () => {
  it("never shows the older read's text", async () => {
    const block = await mountEditor();
    server.answer = "Middle";
    holdNextRead = true;
    fireEvent.click(screen.getByRole("button", { name: "navigate" }));
    await waitFor(() => expect(heldReads).toHaveLength(1));
    await flush();

    // The read the save starts is held too.
    holdNextRead = true;
    await saveAnswer(block, "After");
    await waitFor(() => expect(heldReads).toHaveLength(2));
    await waitFor(() => expect(answerShown()).toContain("After"));

    // The older read finishes first.
    await act(async () => {
      heldReads[0].release();
      await Promise.resolve();
    });
    await flush();
    expect(answerShown()).toContain("After");
    expect(answerShown()).not.toContain("Middle");

    await act(async () => {
      heldReads[1].release();
      await Promise.resolve();
    });
    await flush();
    expect(answerShown()).toContain("After");
    expect(answerShown()).not.toContain("Middle");
  });
});

describe("the story route: the answer's word count follows a revalidated answer", () => {
  it("counts the answer a later read delivers", async () => {
    await mountEditor();
    const counter = () => screen.getByTestId("stage-line-counter");
    expect(counter().querySelector('[data-testid="answer-over-hard-limit"]')).toBeNull();
    server.answer = Array.from({ length: 201 }, (_, i) => `word${i}`).join(" ");
    fireEvent.click(screen.getByRole("button", { name: "navigate" }));
    await waitFor(() => expect(loaderCalls.length).toBeGreaterThan(1));
    await waitFor(() => expect(counter().querySelector('[data-testid="answer-over-hard-limit"]')).not.toBeNull());
  });
});

describe("the story route: the read a save starts is newer than the save", () => {
  it("shows another writer's text that the save's own read delivers", async () => {
    const block = await mountEditor();
    anotherWriter = "Newer";
    await saveAnswer(block, "After");
    await waitFor(() => expect(saves.some((s) => s.intent === "save-step-field")).toBe(true));
    await waitFor(() => expect(loaderCalls).toContain("Newer"));
    await flush();
    await waitFor(() => expect(answerShown()).toContain("Newer"));
  });
});
