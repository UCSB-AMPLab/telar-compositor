// @vitest-environment jsdom

/**
 * The dialog chain: when picking an object becomes a page chooser, when it does
 * not, and what ends the chain.
 *
 * A pick does not reach the viewer directly — it goes to the Y.Doc or an action
 * and comes back through the route — so the column holds the pick as an
 * awaiting record and only turns it into a chooser once the rendered step
 * carries that object and its source has resolved. That interval is where an
 * unrelated object can still be on screen, which is what most of these cases
 * are about.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";

vi.mock("openseadragon", async () => {
  const { osd } = await import("./helpers/viewer-column-harness");
  return { default: osd.ctor };
});
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values
        ? `${key}|${Object.entries(values).map(([k, v]) => `${k}=${String(v)}`).join(",")}`
        : key,
    i18n: { language: "en" },
  }),
}));

import {
  buildColumn,
  deferObject,
  installFetch,
  openInstanceForPage,
  osd,
  renderColumn,
  selfHostedObject,
  serveMissingTiles,
  serveObject,
  settle,
  step,
  videoObject,
  type ColumnHandles,
} from "./helpers/viewer-column-harness";

const CODEX = selfHostedObject("codex", "Codex");
const ATLAS = selfHostedObject("atlas", "Atlas");
const LEAF = selfHostedObject("leaf", "Single leaf");
const BROKEN = selfHostedObject("broken", "Broken");
const FILM = videoObject("film", "Film");
const OBJECTS = [CODEX, ATLAS, LEAF, BROKEN, FILM];

beforeEach(() => {
  cleanup();
  osd.reset();
  installFetch();
  serveObject("codex", 3);
  serveObject("atlas", 4);
  serveObject("leaf", 1);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const chooser = () => screen.queryByText("page_chooser.title");
const picker = () => screen.queryByText("object_picker.title");
const keepDialog = () => screen.queryByText("step.new_step_dialog.title");

/**
 * Open the object picker from the top bar and pick an object by its title. The
 * title also names the current object in the bar above, so the card in the
 * picker is the later of the two matches.
 */
async function pickObject(title: string) {
  await act(async () => {
    fireEvent.click(screen.getByLabelText("viewer.change_object"));
  });
  await act(async () => {
    fireEvent.click(screen.getAllByText(title).at(-1)!);
  });
}

async function startOnCodex(overrides: Partial<Parameters<typeof step>[0]> = {}) {
  const start = step({ id: 1, object_id: "codex", ...overrides });
  const column = await renderColumn(buildColumn, {
    step: start,
    isStepZero: false,
    selectionKey: "id:1",
    objects: OBJECTS,
  });
  await openInstanceForPage(start.page ? Number(start.page) - 1 : 0);
  return column;
}

/** Reflect a pick the way the route does, a render later. */
async function reflect(column: ColumnHandles, objectId: string) {
  await column.update({
    step: step({ ...column.props.step!, object_id: objectId, page: null, x: null, y: null, zoom: null }),
  });
}

describe("ViewerColumn — a pick becomes a chooser", () => {
  it("opens the chooser once the route reflects a multi-page object", async () => {
    const column = await startOnCodex();
    await pickObject("Atlas");
    expect(column.onChangeObject).toHaveBeenCalledWith("atlas", undefined);
    // The pick has not reached the viewer yet.
    expect(chooser()).toBeNull();

    await reflect(column, "atlas");
    await waitFor(() => expect(chooser()).not.toBeNull());
    expect(screen.getByText(/page_chooser\.count\|title=Atlas,count=4/)).not.toBeNull();
  });

  it("does not open the chooser for a single-page object", async () => {
    const column = await startOnCodex();
    await pickObject("Single leaf");
    await reflect(column, "leaf");
    await settle();
    expect(chooser()).toBeNull();
  });

  it("does not open the chooser when the picked object's source is unavailable", async () => {
    serveMissingTiles("broken");
    const column = await startOnCodex();
    await pickObject("Broken");
    await reflect(column, "broken");
    await settle();
    expect(chooser()).toBeNull();
  });

  it("does not open the chooser for a video", async () => {
    const column = await startOnCodex();
    await pickObject("Film");
    await reflect(column, "film");
    await settle();
    expect(chooser()).toBeNull();
  });

  it("opens the chooser from held state when the already-selected object is picked", async () => {
    await startOnCodex();
    await pickObject("Codex");
    // The object and the source are unchanged, so the record is served from
    // what the column already holds, without waiting for a new callback.
    await waitFor(() => expect(chooser()).not.toBeNull());
  });

  it("keeps the record while the source is still resolving", async () => {
    const release = deferObject("atlas", 4);
    const column = await startOnCodex();
    await pickObject("Atlas");
    await reflect(column, "atlas");
    await settle();
    expect(chooser()).toBeNull();

    await release();
    await waitFor(() => expect(chooser()).not.toBeNull());
  });

  it("keeps the record while a video is still on screen and opens it when the image renders", async () => {
    const column = await renderColumn(buildColumn, {
      step: step({ id: 1, object_id: "film" }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await settle();
    await pickObject("Atlas");
    await settle();
    expect(chooser()).toBeNull();

    await reflect(column, "atlas");
    await waitFor(() => expect(chooser()).not.toBeNull());
  });

  it("cancels the record when the step switches before the source is ready", async () => {
    const release = deferObject("atlas", 4);
    const column = await startOnCodex();
    await pickObject("Atlas");
    await column.update({
      step: step({ id: 2, step_number: 2, object_id: "codex" }),
      selectionKey: "id:2",
    });
    await release();
    await settle();
    expect(chooser()).toBeNull();
  });

  it("ends the chain when the picker is dismissed without a pick", async () => {
    await startOnCodex();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("viewer.change_object"));
    });
    expect(picker()).not.toBeNull();
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    await settle();
    expect(picker()).toBeNull();
    expect(chooser()).toBeNull();
    // Focus lands on a control that outlives the dialog.
    expect(document.activeElement).toBe(screen.getByText("viewer.change_page").closest("button"));
  });

  it("lands focus on Change object when the page cluster is absent", async () => {
    const column = await renderColumn(buildColumn, {
      step: step({ id: 1, object_id: "leaf" }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await settle();
    expect(screen.queryByText("viewer.change_page")).toBeNull();

    await pickObject("Single leaf");
    await settle();
    expect(chooser()).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText("viewer.change_object"));
    expect(column.onChangeObject).toHaveBeenCalledWith("leaf", undefined);
  });

  it("moves focus forward along keep-or-choose, picker, page chooser", async () => {
    const column = await renderColumn(buildColumn, {
      step: step({ id: 0, _tempId: "new-1", step_number: 2, object_id: "codex", page: "1" }),
      isStepZero: false,
      selectionKey: "tmp:new-1",
      objects: OBJECTS,
      pendingNewStep: { tempId: "new-1" },
    });
    await waitFor(() => expect(keepDialog()).not.toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByText("step.new_step_dialog.keep").closest("button")
      )
    );

    await act(async () => {
      fireEvent.click(screen.getByText("step.new_step_dialog.choose"));
    });
    expect(picker()).not.toBeNull();

    await act(async () => { fireEvent.click(screen.getAllByText("Atlas").at(-1)!); });
    await column.update({
      step: step({ id: 0, _tempId: "new-1", step_number: 2, object_id: "atlas", page: null }),
    });
    await waitFor(() => expect(chooser()).not.toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByLabelText("page_chooser.go_to_label")
      )
    );

    await act(async () => { fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" }); });
    await settle();
    expect(chooser()).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByText("viewer.change_page").closest("button")
    );
  });
});

describe("ViewerColumn — the Change button", () => {
  it("opens the chooser on demand", async () => {
    await startOnCodex();
    await act(async () => { fireEvent.click(screen.getByText("viewer.change_page")); });
    expect(chooser()).not.toBeNull();
  });

  it("reports a choice with its session and navigates to the chosen page", async () => {
    const column = await startOnCodex({ page: "1" });
    await act(async () => { fireEvent.click(screen.getByText("viewer.change_page")); });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("page_chooser.go_to_label"), {
        target: { value: "3" },
      });
      fireEvent.click(screen.getByText("page_chooser.go"));
    });

    expect(column.onChoosePage).toHaveBeenCalledTimes(1);
    const [page, session] = column.onChoosePage.mock.calls[0];
    expect(page).toBe(3);
    expect(session).toMatchObject({
      selectionKey: "id:1",
      targetKey: "id:1",
      objectId: "codex",
    });

    await openInstanceForPage(2);
    expect(
      screen.getByText(/^viewer\.page_indicator\|/).textContent
    ).toBe("viewer.page_indicator|page=3,count=3");
  });

  it("returns to the already-saved page after browsing, going home there", async () => {
    const column = await startOnCodex({ page: "2" });
    await openInstanceForPage(1);
    await act(async () => { fireEvent.click(screen.getByLabelText("viewer.next_page_aria")); });
    await openInstanceForPage(2);

    await act(async () => { fireEvent.click(screen.getByText("viewer.change_page")); });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("page_chooser.go_to_label"), {
        target: { value: "2" },
      });
      fireEvent.click(screen.getByText("page_chooser.go"));
    });
    expect(column.onChoosePage.mock.calls[0][0]).toBe(2);

    await openInstanceForPage(1);
    expect(osd.last().viewport.goHome).toHaveBeenCalled();
  });

  it("closes when the step switches, and a later choice writes nothing", async () => {
    const column = await startOnCodex();
    await act(async () => { fireEvent.click(screen.getByText("viewer.change_page")); });
    expect(chooser()).not.toBeNull();

    await column.update({
      step: step({ id: 2, step_number: 2, object_id: "codex" }),
      selectionKey: "id:2",
    });
    await settle();
    expect(chooser()).toBeNull();
    expect(column.onChoosePage).not.toHaveBeenCalled();
  });

  it("closes when a peer replaces the object under it", async () => {
    const column = await startOnCodex();
    await act(async () => { fireEvent.click(screen.getByText("viewer.change_page")); });
    expect(chooser()).not.toBeNull();

    await column.update({ step: step({ id: 1, object_id: "atlas" }) });
    await settle();
    expect(chooser()).toBeNull();
    expect(column.onChoosePage).not.toHaveBeenCalled();
  });
});

describe("ViewerColumn — the seeded new step", () => {
  const seeded = {
    step: step({ id: 0, _tempId: "new-1", step_number: 2, object_id: "codex", page: "2" }),
    isStepZero: false,
    selectionKey: "tmp:new-1",
    objects: OBJECTS,
    pendingNewStep: { tempId: "new-1" },
  };

  it("opens the keep-or-choose dialog once the column is mounted on that step", async () => {
    const column = await renderColumn(buildColumn, seeded);
    await waitFor(() => expect(keepDialog()).not.toBeNull());
    expect(screen.getByText("step.new_step_dialog.body|title=Codex")).not.toBeNull();
    expect(column.onNewStepConsumed).toHaveBeenCalledWith("new-1");
  });

  it("does not open for a step that is not the request's", async () => {
    await renderColumn(buildColumn, {
      ...seeded,
      step: step({ id: 0, _tempId: "other", step_number: 2, object_id: "codex" }),
      selectionKey: "tmp:other",
    });
    await settle();
    expect(keepDialog()).toBeNull();
  });

  it("keeps the seed and does not reopen after a remount", async () => {
    const column = await renderColumn(buildColumn, seeded);
    await waitFor(() => expect(keepDialog()).not.toBeNull());
    await act(async () => {
      fireEvent.click(screen.getByText("step.new_step_dialog.keep"));
    });
    expect(keepDialog()).toBeNull();
    expect(column.onChangeObject).not.toHaveBeenCalled();

    // The route cleared the request on acknowledgement, so a remount is quiet.
    await column.update({ pendingNewStep: null });
    await column.remount();
    await settle();
    expect(keepDialog()).toBeNull();
  });

  it("keeps the seed when its own close control is used", async () => {
    const column = await renderColumn(buildColumn, seeded);
    await waitFor(() => expect(keepDialog()).not.toBeNull());
    await act(async () => { fireEvent.click(screen.getByLabelText("close")); });
    expect(keepDialog()).toBeNull();
    expect(column.onChangeObject).not.toHaveBeenCalled();
  });

  it("opens the picker bound to the new step when another object is chosen", async () => {
    const column = await renderColumn(buildColumn, seeded);
    await waitFor(() => expect(keepDialog()).not.toBeNull());
    await act(async () => {
      fireEvent.click(screen.getByText("step.new_step_dialog.choose"));
    });
    expect(picker()).not.toBeNull();

    await act(async () => { fireEvent.click(screen.getByText("Atlas")); });
    expect(column.onChangeObject).toHaveBeenCalledWith("atlas", "tmp:new-1");
  });

  it("keeps the seed when the picker is closed without a pick", async () => {
    const column = await renderColumn(buildColumn, seeded);
    await waitFor(() => expect(keepDialog()).not.toBeNull());
    await act(async () => {
      fireEvent.click(screen.getByText("step.new_step_dialog.choose"));
    });
    await act(async () => { fireEvent.keyDown(document, { key: "Escape" }); });
    await settle();
    expect(picker()).toBeNull();
    expect(column.onChangeObject).not.toHaveBeenCalled();
  });

  it("cancels the session when the active selection stops being that step", async () => {
    const column = await renderColumn(buildColumn, seeded);
    await waitFor(() => expect(keepDialog()).not.toBeNull());
    await column.update({
      step: step({ id: 3, step_number: 3, object_id: "codex" }),
      selectionKey: "id:3",
    });
    await settle();
    expect(keepDialog()).toBeNull();
    expect(picker()).toBeNull();
  });
});
