// @vitest-environment jsdom

/**
 * One harness for the three viewer-column suites.
 *
 * The column is exercised over the REAL `IiifViewer` and the lifecycle-capable
 * OpenSeadragon fake, because almost everything worth asserting here is about
 * the seam between them: which instance a framing request lands on, when
 * Capture becomes usable, and when a pick becomes a page chooser. A mocked
 * viewer would move all of that into the test's own assumptions.
 *
 * The manifests the objects resolve to are served from a map the test fills in,
 * and each object's URLs are derived exactly as the story route derives them,
 * so a change of object is a change of source key here as it is in the editor.
 *
 * @version v1.5.0-beta
 */

import { vi, expect } from "vitest";
import type { Mock } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { createOsdFake, withPoint } from "./osd-fake";
import { ViewerColumn } from "~/components/features/editor/ViewerColumn";
import type { PageChooserSession } from "~/components/features/editor/PageChooserDialog";
import type { ManifestPage } from "~/lib/iiif-pages";
import type { WriteBinding } from "~/lib/step-writes";
import { iiifUrlsFor, resolveStepObject } from "~/lib/object-id";

export const osd = withPoint(createOsdFake());

export const SITE_BASE = "https://example.org/site";

export interface HarnessObject {
  object_id: string;
  title: string | null;
  thumbnail: string | null;
  image_available: boolean | null;
  source_url: string | null;
  alt_text?: string | null;
}

export interface HarnessStep {
  id: number;
  _tempId?: string | null;
  step_number: number;
  object_id: string | null;
  x: number | null;
  y: number | null;
  zoom: number | null;
  page: string | null;
  alt_text?: string | null;
  // Seconds, as strings, exactly as the step row stores them.
  clip_start?: string | null;
  clip_end?: string | null;
}

/** A self-hosted image object; its manifest and info.json live under the site. */
export function selfHostedObject(objectId: string, title: string): HarnessObject {
  return {
    object_id: objectId,
    title,
    thumbnail: null,
    image_available: true,
    source_url: `${objectId}.jpg`,
  };
}

/** A video object, which the column renders without mounting the viewer at all. */
export function videoObject(objectId: string, title: string): HarnessObject {
  return {
    object_id: objectId,
    title,
    thumbnail: null,
    image_available: false,
    source_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  };
}

export function step(overrides: Partial<HarnessStep> = {}): HarnessStep {
  return {
    id: 1,
    _tempId: null,
    step_number: 1,
    object_id: null,
    x: null,
    y: null,
    zoom: null,
    page: null,
    ...overrides,
  };
}

/** The route's own URL derivation, so source keys match the editor's. */
export function iiifUrls(objectId: string | null, objects: HarnessObject[]) {
  return iiifUrlsFor(resolveStepObject(objects, objectId, null), SITE_BASE, null);
}

// ---------------------------------------------------------------------------
// Fetch control
// ---------------------------------------------------------------------------

const manifests = new Map<string, () => Promise<Response> | Response>();
const headStatuses = new Map<string, number>();

function manifestBody(pageCount: number, base: string) {
  return {
    items: Array.from({ length: pageCount }, (_, i) => ({
      label: { en: [`Folio ${i + 1}`] },
      items: [{ items: [{ body: { service: [{ id: `${base}/p${i + 1}` }] } }] }],
    })),
  };
}

/** Serve a manifest of `pageCount` pages for a self-hosted object. */
export function serveObject(objectId: string, pageCount: number) {
  manifests.set(`${SITE_BASE}/iiif/objects/${objectId}/manifest.json`, () =>
    new Response(
      JSON.stringify(manifestBody(pageCount, `${SITE_BASE}/iiif/${objectId}`))
    )
  );
}

/**
 * Make an object's tiles missing. For a self-hosted object this is what an
 * unavailable source looks like: the HEAD on its info.json fails, which is the
 * check that decides availability before any manifest is read.
 */
export function serveMissingTiles(objectId: string) {
  headStatuses.set(`${SITE_BASE}/iiif/objects/${objectId}/info.json`, 404);
}

/** Hold an object's manifest until the returned function releases it. */
export function deferObject(objectId: string, pageCount: number) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  manifests.set(`${SITE_BASE}/iiif/objects/${objectId}/manifest.json`, async () => {
    await gate;
    return new Response(
      JSON.stringify(manifestBody(pageCount, `${SITE_BASE}/iiif/${objectId}`))
    );
  });
  return async () => {
    await act(async () => { release(); await Promise.resolve(); });
  };
}

export function installFetch() {
  manifests.clear();
  headStatuses.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "HEAD") {
        return new Response(null, { status: headStatuses.get(url) ?? 200 });
      }
      const responder = manifests.get(url);
      if (!responder) return new Response("", { status: 404 });
      return responder();
    })
  );
}

/** Let queued microtasks and effects settle. */
export async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Fire `open` on the most recently constructed instance. */
export async function openLatest() {
  await act(async () => {
    osd.last().open();
  });
}

/** Wait until an instance exists for the given 0-based page and open it. */
export async function openInstanceForPage(page: number) {
  await waitFor(() => expect(osd.instances.length).toBeGreaterThan(0));
  await waitFor(() =>
    expect(String(osd.last().tileSource)).toContain(`/p${page + 1}/info.json`)
  );
  await openLatest();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface ColumnProps {
  step: HarnessStep | null;
  isStepZero: boolean;
  selectionKey: string;
  objects: HarnessObject[];
  pendingNewStep?: { tempId: string } | null;
}

export interface ColumnHandles {
  onCapturePosition: Mock<
    (
      position: { x: number; y: number; zoom: number; page: string },
      binding: WriteBinding
    ) => void
  >;
  onChangeObject: Mock<(objectId: string, targetKey?: string) => void>;
  onChoosePage: Mock<(page: number, session: PageChooserSession) => void>;
  onNewStepConsumed: Mock<(tempId: string) => void>;
  update: (next: Partial<ColumnProps>) => Promise<void>;
  props: ColumnProps;
  unmount: () => void;
  remount: () => Promise<void>;
}

type BuildHandles = Omit<ColumnHandles, "update" | "props" | "unmount" | "remount">;

/** The column with the props the story route gives it for one step. */
export function buildColumn(props: ColumnProps, handles: BuildHandles): ReactElement {
  const urls = iiifUrls(props.step?.object_id ?? null, props.objects);
  return (
    <ViewerColumn
      step={props.step}
      isStepZero={props.isStepZero}
      selectionKey={props.selectionKey}
      stepDisplayNumber={1}
      totalSteps={3}
      objects={props.objects}
      manifestUrl={urls.manifestUrl}
      infoJsonUrl={urls.infoJsonUrl}
      isSelfHosted={urls.isSelfHosted}
      siteBaseUrl={SITE_BASE}
      onCapturePosition={handles.onCapturePosition}
      onChangeObject={handles.onChangeObject}
      onChoosePage={handles.onChoosePage}
      pendingNewStep={props.pendingNewStep ?? null}
      onNewStepConsumed={handles.onNewStepConsumed}
    />
  );
}

/** Render the column and return handles for driving it as the route would. */
export async function renderColumn(
  build: (props: ColumnProps, handles: BuildHandles) => ReactElement,
  initial: ColumnProps
): Promise<ColumnHandles> {
  const handles = {
    onCapturePosition: vi.fn<
      (
        position: { x: number; y: number; zoom: number; page: string },
        binding: WriteBinding
      ) => void
    >(),
    onChangeObject: vi.fn<(objectId: string, targetKey?: string) => void>(),
    onChoosePage: vi.fn<(page: number, session: PageChooserSession) => void>(),
    onNewStepConsumed: vi.fn<(tempId: string) => void>(),
  };

  let current = { ...initial };
  const view = render(build(current, handles));

  const api: ColumnHandles = {
    ...handles,
    get props() { return current; },
    update: async (next) => {
      current = { ...current, ...next };
      await act(async () => {
        view.rerender(build(current, handles));
        await Promise.resolve();
      });
    },
    unmount: () => view.unmount(),
    remount: async () => {
      await act(async () => {
        view.rerender(build(current, handles));
        await Promise.resolve();
      });
    },
  };
  await settle();
  return api;
}

export type { ManifestPage };
