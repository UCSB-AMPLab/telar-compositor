// @vitest-environment jsdom

/**
 * Which page the viewer column shows, and what counts as a change of selection.
 *
 * The subtle case is identity. Two freshly-added steps share a D1 id of 0 until
 * a snapshot backfills them, and the same backfill later flips a step's stable
 * key; a page browsed by the author must survive the second and be reset by the
 * first.
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
  installFetch,
  openInstanceForPage,
  osd,
  renderColumn,
  selfHostedObject,
  serveObject,
  settle,
  step,
} from "./helpers/viewer-column-harness";

const CODEX = selfHostedObject("codex", "Codex");
const LEAF = selfHostedObject("leaf", "Single leaf");
const OBJECTS = [CODEX, LEAF];

beforeEach(() => {
  cleanup();
  osd.reset();
  installFetch();
  serveObject("codex", 3);
  serveObject("leaf", 1);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function indicator() {
  return screen.queryByText(/^viewer\.page_indicator\|/);
}

describe("ViewerColumn — the page cluster", () => {
  it("shows the indicator and Change for a multi-page object", async () => {
    await renderColumn(buildColumn, {
      step: step({ object_id: "codex" }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await waitFor(() => expect(indicator()).not.toBeNull());
    expect(indicator()!.textContent).toBe("viewer.page_indicator|page=1,count=3");
    expect(screen.getByText("viewer.change_page")).not.toBeNull();
  });

  it("lets the cluster wrap within itself rather than intrude on Capture", async () => {
    await renderColumn(buildColumn, {
      step: step({ object_id: "codex" }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await waitFor(() => expect(indicator()).not.toBeNull());
    // `Página 1.240/1.240` beside three buttons exceeds the coordinates region
    // at a narrow column width; without wrapping, the overflow lands on Capture.
    const cluster = indicator()!.parentElement!;
    expect(cluster.className).toContain("flex-wrap");
    expect(cluster.className).toContain("min-w-0");
  });

  it("shows no cluster for a single-page object", async () => {
    await renderColumn(buildColumn, {
      step: step({ object_id: "leaf" }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await settle();
    expect(indicator()).toBeNull();
    expect(screen.queryByText("viewer.change_page")).toBeNull();
  });

  it("opens a step's saved page and shows it", async () => {
    await renderColumn(buildColumn, {
      step: step({ object_id: "codex", page: "3" }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await waitFor(() =>
      expect(indicator()!.textContent).toBe("viewer.page_indicator|page=3,count=3")
    );
    expect(String(osd.last().tileSource)).toContain("/p3/info.json");
  });

  it("returns to page 1 on a step that stores no page", async () => {
    const column = await renderColumn(buildColumn, {
      step: step({ id: 1, object_id: "codex", page: "3" }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await waitFor(() =>
      expect(indicator()!.textContent).toBe("viewer.page_indicator|page=3,count=3")
    );

    await column.update({
      step: step({ id: 2, step_number: 2, object_id: "codex", page: null }),
      selectionKey: "id:2",
    });
    await waitFor(() =>
      expect(indicator()!.textContent).toBe("viewer.page_indicator|page=1,count=3")
    );
    expect(String(osd.last().tileSource)).toContain("/p1/info.json");
  });
});

describe("ViewerColumn — browsing", () => {
  it("moves the page with next and previous and disables them at the ends", async () => {
    await renderColumn(buildColumn, {
      step: step({ object_id: "codex" }),
      isStepZero: false,
      selectionKey: "id:1",
      objects: OBJECTS,
    });
    await waitFor(() => expect(indicator()).not.toBeNull());
    expect(screen.getByLabelText("viewer.prev_page_aria").hasAttribute("disabled")).toBe(true);

    await act(async () => { fireEvent.click(screen.getByLabelText("viewer.next_page_aria")); });
    await waitFor(() =>
      expect(indicator()!.textContent).toBe("viewer.page_indicator|page=2,count=3")
    );
    expect(String(osd.last().tileSource)).toContain("/p2/info.json");
    expect(screen.getByLabelText("viewer.prev_page_aria").hasAttribute("disabled")).toBe(false);

    await act(async () => { fireEvent.click(screen.getByLabelText("viewer.next_page_aria")); });
    await waitFor(() =>
      expect(indicator()!.textContent).toBe("viewer.page_indicator|page=3,count=3")
    );
    expect(screen.getByLabelText("viewer.next_page_aria").hasAttribute("disabled")).toBe(true);

    await act(async () => { fireEvent.click(screen.getByLabelText("viewer.prev_page_aria")); });
    await waitFor(() =>
      expect(indicator()!.textContent).toBe("viewer.page_indicator|page=2,count=3")
    );
  });

  it("resets a browsed page when the selection changes between two unsaved steps", async () => {
    const column = await renderColumn(buildColumn, {
      step: step({ id: 0, _tempId: "a", object_id: "codex", page: "2" }),
      isStepZero: false,
      selectionKey: "tmp:a",
      objects: OBJECTS,
    });
    await waitFor(() =>
      expect(indicator()!.textContent).toBe("viewer.page_indicator|page=2,count=3")
    );
    await act(async () => { fireEvent.click(screen.getByLabelText("viewer.next_page_aria")); });
    await waitFor(() =>
      expect(indicator()!.textContent).toBe("viewer.page_indicator|page=3,count=3")
    );

    // A different unsaved step: the same D1 id of 0, the same saved page.
    await column.update({
      step: step({ id: 0, _tempId: "b", step_number: 2, object_id: "codex", page: "2" }),
      selectionKey: "tmp:b",
    });
    await waitFor(() =>
      expect(indicator()!.textContent).toBe("viewer.page_indicator|page=2,count=3")
    );
  });

  it("keeps a browsed page through the D1 id backfill under the same temp id", async () => {
    const column = await renderColumn(buildColumn, {
      step: step({ id: 0, _tempId: "a", object_id: "codex", page: "1" }),
      isStepZero: false,
      selectionKey: "tmp:a",
      objects: OBJECTS,
    });
    await waitFor(() => expect(indicator()).not.toBeNull());
    await act(async () => { fireEvent.click(screen.getByLabelText("viewer.next_page_aria")); });
    await waitFor(() =>
      expect(indicator()!.textContent).toBe("viewer.page_indicator|page=2,count=3")
    );

    // The snapshot backfills the real id; the temp id, and so the key, stands.
    await column.update({
      step: step({ id: 41, _tempId: "a", object_id: "codex", page: "1" }),
      selectionKey: "tmp:a",
    });
    await settle();
    expect(indicator()!.textContent).toBe("viewer.page_indicator|page=2,count=3");
  });
});

describe("ViewerColumn — step 0", () => {
  it("shows the first step's page under step 0 and under step 1 alike", async () => {
    const first = step({ id: 1, object_id: "codex", page: "2" });
    const column = await renderColumn(buildColumn, {
      step: first,
      isStepZero: true,
      selectionKey: "step0",
      objects: OBJECTS,
    });
    await openInstanceForPage(1);
    // Step 0 keeps a coordinates-only bar: no cluster, no capture.
    expect(indicator()).toBeNull();
    expect(screen.queryByText("viewer.capture_position")).toBeNull();
    expect(String(osd.last().tileSource)).toContain("/p2/info.json");

    await column.update({ isStepZero: false, selectionKey: "id:1" });
    await waitFor(() =>
      expect(indicator()!.textContent).toBe("viewer.page_indicator|page=2,count=3")
    );
    expect(String(osd.last().tileSource)).toContain("/p2/info.json");
  });
});
